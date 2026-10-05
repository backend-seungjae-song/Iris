import { request as winRequest } from "./win-native.cjs";
// 현재 스페이스의 Git 저장소에서 Worktree 목록·생성·삭제를 처리한다.
//
// 소유 범위
//   worktrees.* 요청의 저장소 경계, Git argv 호출, 중복 요청 영수증과 동시 쓰기 잠금.
// 제공 API
//   initWorktrees({ herdr, processes }), handleWorktrees(ws, msg), performWorktreeRequest(msg, local),
//   createWorktreeFromCommand(options), WorktreeError.
// 의존 대상
//   runtime-state의 스페이스·에이전트 snapshot, 로컬 Git 실행 파일, herdr pane 정보와 ps·lsof(실행 중 판정).
// 유지 조건
//   로컬 쓰기만 허용하고 기본 저장소·열린 세션·변경 파일을 삭제하지 않는다. 브랜치는 남긴다.
// 영향 범위
//   server/capabilities.js의 worktrees.* dispatch, web/js/worktrees/boot.js, bin/agent-context.mjs worktree.

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { stateHome } from "./state-home.cjs";
import { snapshot } from "./runtime-state.js";

const runFile = promisify(execFile);
const locks = new Set();
const receiptsByClient = new WeakMap();
const MAX_RECEIPTS = 200;
let getLivePanes = null;
let getShellPid = null;
let processes = null;
let lastScan = null;
export function initWorktrees({ herdr, processes: reader = null }) {
  getLivePanes = () => herdr.paneList();
  getShellPid = typeof herdr.call === "function"
    ? (paneId) => herdr.call("pane.process_info", { pane_id: paneId }).then((r) => r?.process_info?.shell_pid)
    : null;
  processes = reader || systemProcesses;
  lastScan = null;
}
const GIT_OPTIONS = { encoding: "utf8", timeout: 12000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } };
const PROCESS_OPTIONS = { encoding: "utf8", timeout: 5000, maxBuffer: 8 * 1024 * 1024 };
// 스페이스마다 목록을 따로 요청하므로 몇 초 안의 요청은 한 번의 프로세스 조사 결과를 함께 사용
const SCAN_REUSE_MS = 3000;
const CHANGE_REUSE_MS = 10000;
const changeCache = new Map();

export class WorktreeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function fail(code, message) { throw new WorktreeError(code, message); }
async function git(cwd, args) {
  try { return (await runFile("git", ["-C", cwd, ...args], GIT_OPTIONS)).stdout; }
  catch (error) {
    if (error.killed || error.code === "ETIMEDOUT") fail("TIMEOUT", "Git 응답 시간이 초과되었습니다");
    fail("GIT", String(error.stderr || error.message || "Git 명령이 실패했습니다").trim().slice(0, 1000));
  }
}
function within(root, target) { return target === root || target.startsWith(root + path.sep); }
function realExisting(candidate) { try { return fs.realpathSync(candidate); } catch { return ""; } }
function ownershipPath() { return path.join(stateHome(), "worktree-ownership.json"); }
function readOwnership() {
  let raw;
  try { raw = fs.readFileSync(ownershipPath(), "utf8"); }
  catch (error) { if (error.code === "ENOENT") return []; fail("STATE", "Iris가 만든 worktree 목록을 읽지 못했습니다"); }
  try {
    const value = JSON.parse(raw);
    if (value?.version !== 1 || !Array.isArray(value.entries) || value.entries.length > 5000
      || value.entries.some((e) => !e || typeof e.primary !== "string" || typeof e.path !== "string"
        || typeof e.dev !== "string" || typeof e.ino !== "string"
        || !["owned", "removing"].includes(e.status))) throw new Error("invalid ownership record");
    return value.entries;
  } catch { fail("STATE", "Iris가 만든 worktree 목록이 손상되었습니다"); }
}
function saveOwnership(entries) {
  const home = stateHome(), temp = path.join(home, `worktree-ownership.${randomUUID()}.tmp`);
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(temp, JSON.stringify({ version: 1, entries }) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, ownershipPath());
  } catch { try { fs.unlinkSync(temp); } catch {} fail("STATE", "Iris가 만든 worktree 목록을 저장하지 못했습니다"); }
}
function identity(target) {
  try { const stat = fs.statSync(target, { bigint: true }); return { dev: String(stat.dev), ino: String(stat.ino) }; }
  catch { return null; }
}
function labelFile(target) {
  return path.join(stateHome(), "worktree-labels", createHash("sha256").update(target).digest("hex") + ".json");
}
function taskGroupPath(target) {
  const parent = path.dirname(target);
  const task = path.basename(parent) === "worktrees" ? path.dirname(parent) : parent;
  return path.basename(path.dirname(task)) === ".working" ? task : null;
}
function readLabel(target) {
  let raw;
  try { raw = fs.readFileSync(labelFile(target), "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; fail("STATE", "워크트리 표시 이름을 읽지 못했습니다"); }
  let record;
  try {
    record = JSON.parse(raw);
    if (record?.version !== 1 || record.path !== target || typeof record.dev !== "string" || !/^\d+$/.test(record.dev)
      || typeof record.ino !== "string" || !/^\d+$/.test(record.ino) || typeof record.label !== "string"
      || !record.label || record.label !== record.label.trim() || record.label.length > 120) throw new Error("invalid label record");
  } catch { fail("STATE", "워크트리 표시 이름 기록이 손상되었습니다"); }
  const current = identity(target);
  return current && current.dev === record.dev && current.ino === record.ino ? record.label : null;
}
function saveLabel(target, label, marker) {
  const file = labelFile(target), dir = path.dirname(file), temp = path.join(dir, `.${randomUUID()}.tmp`);
  // 손상되거나 읽을 수 없는 기록을 새 이름으로 덮어쓰지 않는다.
  readLabel(target);
  try {
    if (!label) {
      try { fs.unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
      return;
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temp, JSON.stringify({ version: 1, path: target, ...marker, label }) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, file);
  } catch { try { fs.unlinkSync(temp); } catch {} fail("STATE", "워크트리 표시 이름을 저장하지 못했습니다"); }
}
function ownedRecord(ctx, entry) {
  if (!entry?.path) return null;
  const current = identity(entry.path);
  if (!current) return null;
  return readOwnership().find((record) => record.primary === ctx.primary && record.path === entry.path
    && record.status === "owned" && record.dev === current.dev && record.ino === current.ino
    && (path.dirname(entry.path) === ctx.managed || (typeof record.collection === "string"
      && taskGroupPath(entry.path) && path.dirname(path.dirname(taskGroupPath(entry.path))) === record.collection
      && path.basename(path.dirname(entry.path)) === "worktrees" && path.basename(entry.path) === path.basename(ctx.primary))))
    // 명령으로 만든 worktree 는 소유 기록 대신 만든 세션 기록이 근거. 폴더 식별값 대조는 readCreator 안
    || (path.dirname(entry.path) === ctx.managed && readCreator(entry.path)?.source === "command" ? { primary: ctx.primary, path: entry.path } : null);
}
function nameOf(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) || value === "." || value === "..") fail("NAME", "이름은 영문이나 숫자로 시작하고, 영문, 숫자, . _ - 만 쓸 수 있습니다");
  return value;
}
function parseWorktrees(output) {
  return output.split(/\0\0+/).filter(Boolean).map((block) => {
    const item = {};
    for (const line of block.split("\0")) {
      if (line.startsWith("worktree ")) item.path = line.slice(9);
      else if (line.startsWith("branch ")) item.branch = line.slice(7).replace(/^refs\/heads\//, "");
      else if (line === "bare") item.bare = true;
      else if (line.startsWith("locked")) item.locked = true;
      else if (line.startsWith("prunable")) item.prunable = true;
    }
    return item;
  });
}
async function context(msg, allowCollection = false) {
  const space = snapshot().workspaces.find((s) => s.id === msg.spaceId || s.workspaceId === msg.spaceId);
  if (!space?.folder) fail("SPACE", "현재 스페이스를 찾을 수 없습니다");
  // 폴더가 지워진 스페이스. 일반 스페이스처럼 그리지 않도록 코드를 따로 둠
  const folder = await fs.promises.realpath(space.folder).catch(() => fail("FOLDER", "스페이스 폴더가 없습니다"));
  const requested = typeof msg.repo === "string" && path.isAbsolute(msg.repo) ? msg.repo : "";
  if (!requested) fail("REPO", "저장소 경로가 없습니다");
  const repo = await fs.promises.realpath(requested).catch(() => fail("REPO", "저장소를 찾을 수 없습니다"));
  if (!within(folder, repo)) fail("REPO", "저장소가 스페이스 폴더 밖에 있습니다");
  try { return await repoContext(repo); }
  catch (error) {
    if (allowCollection && error.code === "GIT" && /not a git repository/.test(error.message)) return { collection: repo, folder };
    throw error;
  }
}
async function repoContext(repo) {
  const top = (await git(repo, ["rev-parse", "--show-toplevel"])).trim();
  if (top !== repo) fail("REPO", "Git 저장소의 최상위 폴더를 선택하세요");
  const entries = parseWorktrees(await git(repo, ["worktree", "list", "--porcelain", "-z"]));
  if (!entries.length || !entries[0].path) fail("REPO", "Git worktree 정보를 읽지 못했습니다");
  const primary = await fs.promises.realpath(entries[0].path).catch(() => fail("REPO", "기본 저장소 폴더가 없습니다"));
  const managed = path.join(path.dirname(primary), path.basename(primary) + "-worktrees");
  return { repo, primary, managed, entries };
}
async function collectionRepos(collection) {
  const folders = (await fs.promises.readdir(collection, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && fs.existsSync(path.join(collection, entry.name, ".git")))
    .map((entry) => path.join(collection, entry.name)).sort();
  const byPrimary = new Map();
  for (const folder of folders) {
    if (await fs.promises.realpath(folder) !== folder) fail("PATH", "저장소 폴더가 심볼릭 링크입니다");
    const repo = await repoContext(folder);
    if (!byPrimary.has(repo.primary) || repo.repo === repo.primary) byPrimary.set(repo.primary, repo);
  }
  if (byPrimary.size > 40) fail("REPO", "하위 저장소는 40개까지 처리할 수 있습니다");
  return [...byPrimary.values()];
}
// 만든 세션 기록. worktree 마다 파일 하나라서 명령과 서버가 서로의 기록을 덮어쓰지 않음.
// 폴더 식별값(dev·ino)이 맞을 때만 그 폴더의 기록으로 인정. 같은 경로에 다시 만든 폴더는 기록 없음
function creatorFile(target) {
  return path.join(stateHome(), "worktree-creators", createHash("sha256").update(target).digest("hex").slice(0, 40) + ".json");
}
const text = (value, max = 200) => typeof value === "string" && value.length <= max;
function readCreator(target) {
  let value;
  try { value = JSON.parse(fs.readFileSync(creatorFile(target), "utf8")); } catch { return null; }
  const session = value?.session;
  if (value?.version !== 1 || value.path !== target || !["command", "iris"].includes(value.source)
    || !text(value.dev, 40) || !text(value.ino, 40)) return null;
  if (session !== null && !(session && text(session.paneId, 80) && text(session.terminalId, 120) && text(session.workspaceId, 80))) return null;
  const current = identity(target);
  return current && current.dev === value.dev && current.ino === value.ino ? value : null;
}
function writeCreator(record) {
  const file = creatorFile(record.path), dir = path.dirname(file);
  const temp = path.join(dir, `.${randomUUID()}.tmp`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temp, JSON.stringify(record) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, file);
    return true;
  } catch { try { fs.unlinkSync(temp); } catch {} return false; }
}
function removeCreator(target) { try { fs.unlinkSync(creatorFile(target)); } catch {} }

// 세션이 마지막으로 프로세스를 실행한 worktree. pane → { sessionUuid, path }
// 에이전트 본 프로세스는 스페이스 폴더에서 돌아 대기 중에는 실행 중 판정이 사라짐. 같은 대화에만 적용
const LAST_SESSIONS_KEEP = 200;
let lastSessions = null;
function lastSessionsFile() { return path.join(stateHome(), "worktree-last-sessions.json"); }
function readLastSessions() {
  const file = lastSessionsFile();
  if (lastSessions?.file === file) return lastSessions.map;
  let map = new Map();
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value?.version === 1 && value.panes && typeof value.panes === "object") map = new Map(Object.entries(value.panes)
      .filter(([paneId, saved]) => text(paneId, 80) && text(saved?.sessionUuid, 80) && text(saved?.path, 4096)));
  } catch {}
  lastSessions = { file, map };
  return map;
}
function rememberLastSession(paneId, sessionUuid, real) {
  const map = readLastSessions();
  const saved = map.get(paneId);
  if (saved?.sessionUuid === sessionUuid && saved.path === real) return;
  map.delete(paneId);
  map.set(paneId, { sessionUuid, path: real });
  while (map.size > LAST_SESSIONS_KEEP) map.delete(map.keys().next().value);
  const file = lastSessionsFile(), temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(temp, JSON.stringify({ version: 1, panes: Object.fromEntries(map) }) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, file);
  } catch { try { fs.unlinkSync(temp); } catch {} }
}
function lastUsersOf(real, agents) {
  if (!real) return [];
  const map = readLastSessions();
  return agents.filter((agent) => {
    const saved = agent.paneId && agent.sessionUuid ? map.get(agent.paneId) : null;
    return saved?.path === real && saved.sessionUuid === agent.sessionUuid.toLowerCase();
  }).map((agent) => ({ kind: "agent", workspaceId: agent.workspaceId, paneId: agent.paneId, agent: agent.agent, status: agent.status,
    sessionUuid: agent.sessionUuid, label: agent.tabLabel || agent.agent }));
}

// 실행 중 판정의 재료: pane 셸의 자손 프로세스와 각 프로세스의 cwd. macOS 기본 ps·lsof 사용
const systemProcesses = {
  async list() {
    if (process.platform === "win32") {
      const result = await winRequest({ op: "processes" });
      if (!result.ok) throw new Error(result.error);
      return result.processes;
    }
    const { stdout } = await runFile("/bin/ps", ["-Ao", "pid=,ppid="], PROCESS_OPTIONS);
    return stdout.trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number))
      .filter(([pid, ppid]) => Number.isInteger(pid) && Number.isInteger(ppid)).map(([pid, ppid]) => ({ pid, ppid }));
  },
  async cwds(pids) {
    if (process.platform === "win32") {
      const result = await winRequest({ op: "processes", pids });
      if (!result.ok) throw new Error(result.error);
      const rows = result.processes.filter((row) => pids.includes(row.pid));
      if (rows.some((row) => !row.cwd)) throw new Error("프로세스 작업 폴더를 확인하지 못했습니다");
      return new Map(rows.map((row) => [row.pid, row.cwd]));
    }
    let stdout;
    // 조사 사이에 끝난 프로세스가 있으면 lsof 는 1 로 끝나고 나머지는 그대로 출력
    try { ({ stdout } = await runFile("/usr/sbin/lsof", ["-a", "-d", "cwd", "-w", "-Fpn", "-p", pids.join(",")], PROCESS_OPTIONS)); }
    catch (error) { if (error.code !== 1 || typeof error.stdout !== "string") throw error; stdout = error.stdout; }
    const cwds = new Map();
    let pid = 0;
    for (const line of stdout.split("\n")) {
      if (line[0] === "p") pid = Number(line.slice(1));
      else if (line[0] === "n" && pid) cwds.set(pid, line.slice(1));
    }
    return cwds;
  },
};
// pane 마다 셸 pid 에서 자손을 따라가 프로세스 → pane 을 잇는 표. 하나라도 못 읽으면 null(모름)
async function scanProcesses(panes) {
  if (!panes.length) return [];
  if (!getShellPid || !processes) return null;
  const shells = await Promise.all(panes.map((pane) => getShellPid(pane.pane_id).catch(() => null)));
  if (shells.some((pid) => !Number.isInteger(pid) || pid <= 1)) return null;
  const children = new Map();
  for (const { pid, ppid } of await processes.list()) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const paneOf = new Map();
  panes.forEach((pane, index) => {
    const stack = [shells[index]];
    while (stack.length) {
      const pid = stack.pop();
      if (paneOf.has(pid)) continue;
      paneOf.set(pid, pane);
      stack.push(...(children.get(pid) || []));
    }
  });
  const cwds = await processes.cwds([...paneOf.keys()]);
  return [...cwds].filter(([pid, cwd]) => paneOf.has(pid) && cwd).map(([pid, cwd]) => ({ pid, cwd, pane: paneOf.get(pid) }));
}
function processScan(panes, fresh = false) {
  if (!fresh && lastScan && Date.now() - lastScan.at < SCAN_REUSE_MS) return lastScan.promise;
  const promise = scanProcesses(panes).catch(() => null);
  lastScan = { at: Date.now(), promise };
  return promise;
}
// 이 폴더(하위 포함)를 cwd 로 둔 프로세스가 있는 pane. lsof 가 주는 cwd 는 이미 실제 경로
function runningPanes(scan, real) {
  if (!scan) return null;
  const byPane = new Map();
  for (const item of scan) if (within(real, item.cwd)) byPane.set(item.pane.pane_id, item.pane);
  return [...byPane.values()];
}

// 작업 폴더 아래의 등록 워크트리는 그 작업 기록의 현재 세션에 연결한다.
// 명령 본문이나 에이전트 이름으로 작업 위치를 추정하지 않는다.
function taskUsersOf(target, agents) {
  let task = path.dirname(target);
  while (task !== path.dirname(task) && path.basename(path.dirname(task)) !== ".working") task = path.dirname(task);
  if (path.basename(path.dirname(task)) !== ".working") return [];
  let text;
  try {
    const file = path.join(task, "Task.md");
    if (fs.statSync(file).size > 65536) return [];
    text = fs.readFileSync(file, "utf8");
  } catch { return []; }
  const field = (name) => {
    const block = text.split(/^##[ \t]+/m).find((part) => part.split(/\r?\n/, 1)[0].trim() === name);
    return block ? block.slice(block.indexOf("\n") + 1).trim() : "";
  };
  const owner = field("session_id").match(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/i)?.[0];
  if (!owner) return [];
  return agents.filter((agent) => agent.paneId && agent.sessionUuid?.toLowerCase() === owner.toLowerCase()
    && String(agent.agent).toLowerCase() === field("owner_runtime").toLowerCase())
    .map((agent) => ({ kind: "agent", workspaceId: agent.workspaceId, paneId: agent.paneId,
      agent: agent.agent, status: agent.status, sessionUuid: agent.sessionUuid, label: agent.tabLabel || agent.agent }));
}
// worktree 하나의 사용 정보: users(이 폴더에서 작업), running(실행 중), creator(만든 세션).
// users 는 삭제 거부와 같은 판정. pane 목록을 못 읽으면 users·running 은 null(모름).
// 비어 있음으로 적으면 쓰는 중인 worktree 가 빈 것처럼 보임
async function usersReader({ fresh = false } = {}) {
  const snap = snapshot();
  let panes = null;
  try { panes = getLivePanes ? await getLivePanes() : null; } catch { panes = null; }
  const known = Array.isArray(panes) && panes.every((pane) => pane && pane.cwd);
  const scan = known ? await processScan(panes, fresh) : null;
  const agentOf = new Map(snap.state.filter((agent) => agent.paneId).map((agent) => [agent.paneId, agent]));
  const sessionOf = (pane) => {
    const agent = agentOf.get(pane.pane_id);
    return agent ? { kind: "agent", workspaceId: agent.workspaceId || pane.workspace_id, paneId: pane.pane_id, agent: agent.agent, status: agent.status,
      label: agent.tabLabel || path.basename(agent.cwd || "") || agent.agent } : { kind: "pane", workspaceId: pane.workspace_id, paneId: pane.pane_id };
  };
  const creatorOf = (target) => {
    const record = readCreator(target);
    if (!record) return null;
    const saved = record.session;
    let session = null;
    if (saved) {
      let live = known ? panes.find((pane) => pane.pane_id === saved.paneId && pane.terminal_id === saved.terminalId) : null;
      // 보관 후 재개하면 pane·terminal ID가 바뀐다. 확인된 대화 UUID가 같은 현재 세션만 다시 연결한다.
      if (known && saved.agent && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(saved.sessionId || "")) {
        const resumed = snap.state.filter((agent) => agent.agent === saved.agent
          && agent.sessionUuid?.toLowerCase() === saved.sessionId.toLowerCase()).flatMap((agent) => panes.filter((pane) =>
          pane.pane_id === agent.paneId && pane.agent === saved.agent
          && (!pane.agent_session?.value || pane.agent_session.value.toLowerCase() === saved.sessionId.toLowerCase())));
        if (resumed.length === 1) live = resumed[0];
      }
      // 같은 터미널이라도 그 에이전트가 끝났거나 다른 대화로 바뀌었으면 만든 세션은 끝난 것
      const current = live && agentOf.get(live.pane_id);
      const alive = !known ? null : !!live && (!saved.agent || live.agent === saved.agent)
        && (!saved.sessionId || !live.agent_session?.value || live.agent_session.value === saved.sessionId)
        && (!saved.sessionId || !current?.sessionUuid || current.sessionUuid === saved.sessionId);
      const agent = alive ? agentOf.get(live.pane_id) : null;
      session = { paneId: alive ? live.pane_id : saved.paneId, workspaceId: alive ? live.workspace_id : saved.workspaceId, agent: saved.agent || null, alive,
        label: agent?.tabLabel || saved.label || null, ...(agent ? { status: agent.status } : {}) };
    }
    return { source: record.source, createdAt: record.createdAt || null, session };
  };
  const useOf = (target) => {
    const creator = creatorOf(target);
    const taskUsers = taskUsersOf(target, snap.state);
    const real = realExisting(target);
    if (!known) return { users: null, running: null, creator, taskUsers, lastUsers: lastUsersOf(real, snap.state) };
    if (!real) return { users: [], running: [], creator, taskUsers, lastUsers: [] };
    const running = runningPanes(scan, real);
    for (const pane of running || []) {
      const agent = agentOf.get(pane.pane_id);
      if (agent?.sessionUuid) rememberLastSession(pane.pane_id, agent.sessionUuid.toLowerCase(), real);
    }
    const under = (dir) => !!dir && within(real, realExisting(dir));
    const users = [];
    for (const space of snap.workspaces) if (under(space.folder)) users.push({ kind: "space", workspaceId: space.id, label: space.label || space.id });
    // 에이전트는 자기 cwd 나 자기 pane 의 cwd 중 하나라도 이 폴더 안이면 에이전트로 적는다.
    const agentByPane = new Map(snap.state.filter((agent) => agent.paneId).map((agent) => [agent.paneId, agent]));
    const insidePanes = new Set(panes.filter((pane) => under(pane.cwd)).map((pane) => pane.pane_id));
    const listed = new Set();
    for (const agent of snap.state) if (under(agent.cwd) || insidePanes.has(agent.paneId)) {
      listed.add(agent.paneId);
      users.push({ kind: "agent", workspaceId: agent.workspaceId, paneId: agent.paneId, agent: agent.agent, status: agent.status,
        label: agent.tabLabel || path.basename(agent.cwd || "") || agent.agent });
    }
    for (const pane of panes) if (insidePanes.has(pane.pane_id) && !listed.has(pane.pane_id) && !agentByPane.has(pane.pane_id)) {
      users.push({ kind: "pane", workspaceId: pane.workspace_id, paneId: pane.pane_id });
    }
    return { users, running: running && running.map(sessionOf), creator, taskUsers, lastUsers: lastUsersOf(real, snap.state) };
  };
  useOf.panes = known ? panes.map((pane) => ({ paneId: pane.pane_id, workspaceId: pane.workspace_id,
    tabId: pane.tab_id, cwd: pane.cwd, ...(typeof pane.label === "string" ? { label: pane.label } : {}) })) : null;
  return useOf;
}
function count(output) {
  const value = Number.parseInt(output.trim(), 10);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid Git count");
  return value;
}
function shortstat(output) {
  if (!output.trim()) return { added: 0, deleted: 0 };
  const added = output.match(/(\d+) insertion/), deleted = output.match(/(\d+) deletion/);
  return { added: added ? count(added[1]) : 0, deleted: deleted ? count(deleted[1]) : 0 };
}
async function readChange(target, base) {
  try {
    const mergeBase = (await git(target, ["merge-base", "HEAD", base])).trim();
    if (!mergeBase) return null;
    const [aheadText, diffText, statusText, lastCommitAt] = await Promise.all([
      git(target, ["rev-list", "--count", `${base}..HEAD`]),
      git(target, ["diff", "--shortstat", mergeBase]),
      git(target, ["status", "--porcelain"]),
      git(target, ["log", "-1", "--format=%cI", "HEAD"]),
    ]);
    const diff = shortstat(diffText);
    const status = statusText.trim();
    const commitAt = lastCommitAt.trim();
    if (!commitAt) return null;
    return { base, ahead: count(aheadText), ...diff, uncommitted: status ? status.split(/\r?\n/).length : 0, lastCommitAt: commitAt };
  } catch { return null; }
}
function changeOf(target, base) {
  if (!base) return Promise.resolve(null);
  const key = `${target}\0${base}`;
  const cached = changeCache.get(key);
  if (cached && Date.now() - cached.at < CHANGE_REUSE_MS) return cached.promise;
  const promise = readChange(target, base);
  changeCache.set(key, { at: Date.now(), promise });
  return promise;
}
function forgetChange(target) {
  for (const key of changeCache.keys()) if (key.startsWith(`${target}\0`)) changeCache.delete(key);
}
async function describe(ctx, useOf = null) {
  const base = ctx.entries[0]?.branch || null;
  const changes = await Promise.all(ctx.entries.map((entry, index) => index !== 0 && !entry.prunable ? changeOf(entry.path, base) : null));
  return ctx.entries.map((entry, index) => ({
    path: entry.path, label: readLabel(entry.path), branch: entry.branch || "(HEAD 분리됨)", primary: index === 0,
    groupLabel: taskGroupPath(entry.path) ? readLabel(taskGroupPath(entry.path)) : null,
    locked: !!entry.locked, prunable: !!entry.prunable,
    managed: index !== 0 && !!ownedRecord(ctx, entry),
    ...(index !== 0 && !entry.prunable ? { change: changes[index] } : {}),
    ...(index !== 0 && useOf ? useOf(entry.path) : {}),
  }));
}
async function branches(ctx) {
  const refs = (await git(ctx.repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"])).trim();
  return refs ? refs.split("\n").filter((s) => !s.endsWith("/HEAD")) : [];
}
async function creationBranch(msg, ctx, defaultBase = false) {
  const branch = typeof msg.branch === "string" ? msg.branch.trim() : "";
  let base = typeof msg.base === "string" ? msg.base.trim() : "";
  if (!branch || branch.startsWith("-") || base.startsWith("-")) fail("BRANCH", "브랜치 이름과 기준 브랜치를 확인하세요");
  await git(ctx.repo, ["check-ref-format", "--branch", branch]);
  const available = await branches(ctx);
  if (!base && defaultBase) base = available.includes("main") ? "main" : available[0] || "";
  if (!base) fail("BRANCH", "브랜치 이름과 기준 브랜치를 확인하세요");
  if (!available.includes(base)) fail("BASE", "기준 브랜치를 찾을 수 없습니다");
  if (available.includes(branch)) fail("BRANCH", "새 브랜치가 이미 있습니다");
  await git(ctx.repo, ["rev-parse", "--verify", `${base}^{commit}`]);
  return { branch, base };
}
async function plainDirectory(target, { optional = false } = {}) {
  let stat;
  try { stat = await fs.promises.lstat(target); }
  catch (error) { if (optional && error.code === "ENOENT") return; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.promises.realpath(target) !== target)
    fail("PATH", "worktree를 만들 위치가 심볼릭 링크이거나 폴더가 아닙니다");
}
async function absent(target) {
  try { await fs.promises.lstat(target); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  fail("EXISTS", "폴더가 이미 있습니다");
}
async function collectionDescription(ctx, repos = null) {
  const useOf = await usersReader();
  const repositories = await Promise.all((repos || await collectionRepos(ctx.collection)).map(async (repo) => ({
    repo: repo.repo, primary: repo.primary, entries: await describe(repo, useOf), branches: await branches(repo),
  })));
  return { repo: ctx.collection, label: readLabel(ctx.collection), repositories, entries: [], panes: useOf.panes };
}
async function createCollection(msg, ctx, repos) {
  if (ctx.collection !== ctx.folder) fail("REPO", "스페이스 폴더를 선택하세요");
  if (!repos.length) fail("REPO", "스페이스에 Git 저장소가 없습니다");
  const name = nameOf(msg.name), working = path.join(ctx.collection, ".working");
  const task = path.join(working, name), directory = path.join(task, "worktrees");
  await plainDirectory(ctx.collection);
  await plainDirectory(working, { optional: true });
  await absent(task);
  // 모든 저장소와 목적지를 확인한 뒤 첫 Git 쓰기를 한다. 런타임 실패 때는 만들어진 폴더를 보존한다.
  const plans = [];
  for (const repo of repos) {
    const target = path.join(directory, path.basename(repo.primary));
    if (plans.some((plan) => plan.target === target)) fail("REPO", "하위 저장소의 폴더 이름이 겹칩니다");
    plans.push({ ctx: repo, target, ...await creationBranch(msg, repo, true) });
  }
  readOwnership();
  const createdPaths = [];
  let attempted = null;
  let activePlan = null;
  try {
    await fs.promises.mkdir(working, { recursive: true });
    await plainDirectory(working);
    await fs.promises.mkdir(task);
    await plainDirectory(task);
    await fs.promises.mkdir(directory);
    for (const plan of plans) {
      activePlan = plan;
      attempted = null;
      await plainDirectory(directory);
      await absent(plan.target);
      attempted = plan;
      await git(plan.ctx.repo, ["worktree", "add", "-b", plan.branch, "--", plan.target, plan.base]);
      createdPaths.push(plan.target);
      forgetChange(plan.target);
      const marker = identity(plan.target);
      if (!marker) fail("STATE", "만든 worktree 폴더를 찾을 수 없습니다");
      saveOwnership([...readOwnership(), { primary: plan.ctx.primary, path: plan.target, branch: plan.branch,
        collection: ctx.collection, ...marker, status: "owned" }]);
      writeCreator({ version: 1, path: plan.target, primary: plan.ctx.primary, branch: plan.branch, ...marker,
        createdAt: new Date().toISOString(), source: "iris", session: null });
    }
    const fresh = await collectionRepos(ctx.collection);
    return { ...await collectionDescription(ctx, fresh), path: task, spaceCwd: task, branch: plans[0].branch, createdPaths };
  } catch (error) {
    if (attempted && !createdPaths.includes(attempted.target)) {
      const entries = await git(attempted.ctx.repo, ["worktree", "list", "--porcelain", "-z"]).then(parseWorktrees).catch(() => []);
      if (fs.existsSync(attempted.target) || entries.some((entry) => entry.path === attempted.target)) createdPaths.push(attempted.target);
    }
    if (createdPaths.length) error.message += `\n이미 만든 worktree ${createdPaths.length}개를 보존했습니다: ${createdPaths.join(", ")}`;
    else if (fs.existsSync(task)) error.message += `\n작업 폴더를 보존했습니다: ${task}`;
    throw Object.assign(error, { createdPaths, spaceCwd: fs.existsSync(task) ? task : undefined,
      branch: plans[0].branch, failedRepo: activePlan?.ctx.repo });
  }
}
// own: Iris 가 소유 기록에 적어 삭제할 수 있게 하는 생성(UI). 명령은 소유 기록을 쓰지 않음
async function create(msg, ctx, { own = true, source = "iris", session = null } = {}) {
  const name = nameOf(msg.name);
  const target = path.join(ctx.managed, name);
  try { await fs.promises.lstat(target); fail("EXISTS", "폴더가 이미 있습니다"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const managedParent = path.dirname(ctx.managed);
  if ((await fs.promises.realpath(managedParent)) !== path.dirname(ctx.primary)) fail("PATH", "worktree를 만들 위치를 확인할 수 없습니다");
  if (fs.existsSync(ctx.managed)) {
    const stat = await fs.promises.lstat(ctx.managed);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("PATH", "worktree를 만들 위치가 폴더가 아닙니다");
  }
  const { branch, base } = await creationBranch(msg, ctx);
  await fs.promises.mkdir(ctx.managed, { recursive: true });
  if ((await fs.promises.realpath(ctx.managed)) !== ctx.managed) fail("PATH", "worktree를 만들 위치가 심볼릭 링크입니다");
  await git(ctx.repo, ["worktree", "add", "-b", branch, "--", target, base]);
  forgetChange(target);
  const marker = identity(target);
  try {
    if (!marker) fail("STATE", "만든 worktree 폴더를 찾을 수 없습니다");
    if (own) saveOwnership([...readOwnership(), { primary: ctx.primary, path: target, branch, ...marker, status: "owned" }]);
  } catch (error) { throw Object.assign(error, { createdPath: target, branch }); }
  const recorded = writeCreator({ version: 1, path: target, primary: ctx.primary, branch, ...marker,
    createdAt: new Date().toISOString(), source, session });
  return { path: target, branch, spaceCwd: target, recorded };
}
// Iris 에이전트 안내의 생성 명령(bin/agent-context.mjs worktree). 스페이스 없이 저장소 폴더에서 바로 만들고
// 부른 pane 을 만든 세션으로 기록. 소유 기록은 서버만 쓰므로 여기서는 쓰지 않음
export async function createWorktreeFromCommand({ repo, name, branch, base, session = null }) {
  const requested = typeof repo === "string" && path.isAbsolute(repo) ? repo : "";
  if (!requested) fail("REPO", "저장소 경로가 없습니다");
  const top = (await git(requested, ["rev-parse", "--show-toplevel"])).trim();
  const ctx = await repoContext(await fs.promises.realpath(top));
  const made = await create({ name, branch, base }, ctx, { own: false, source: "command", session });
  return { path: made.path, branch: made.branch, base, primary: ctx.primary, recorded: made.recorded };
}
// Iris UI 로 만들고 바로 실행한 세션을 만든 세션으로 기록. 새 스페이스의 그 에이전트 pane 만 받음
async function bindLaunch(msg, ctx) {
  const entry = ctx.entries.find((item, index) => index > 0 && item.path === msg.path);
  const record = entry && readCreator(entry.path);
  if (!record || record.source !== "iris") fail("PATH", "Iris에서 만든 worktree가 아닙니다");
  if (record.session) return;
  writeCreator({ ...record, session: await launchSession(msg, entry.path) });
}
async function launchSession(msg, target) {
  let panes;
  try { panes = getLivePanes ? await getLivePanes() : null; } catch { panes = null; }
  const pane = Array.isArray(panes) ? panes.find((item) => item.pane_id === msg.paneId) : null;
  const real = realExisting(target);
  const space = pane && snapshot().workspaces.find((item) => item.id === pane.workspace_id);
  const inside = (dir) => !!dir && !!real && within(real, realExisting(dir));
  if (!pane?.terminal_id || !pane.agent || !(inside(pane.cwd) || inside(space?.folder))) fail("PANE", "실행한 세션을 확인할 수 없습니다");
  const agent = snapshot().state.find((item) => item.paneId === pane.pane_id && item.agent === pane.agent);
  return { paneId: pane.pane_id, terminalId: pane.terminal_id, workspaceId: pane.workspace_id,
    agent: pane.agent, sessionId: pane.agent_session?.value || agent?.sessionUuid || null };
}
async function bindCollectionLaunch(msg, ctx, repos) {
  if (ctx.collection !== ctx.folder || typeof msg.path !== "string" || !path.isAbsolute(msg.path))
    fail("PATH", "작업 폴더를 확인할 수 없습니다");
  const task = path.resolve(msg.path);
  if (path.dirname(task) !== path.join(ctx.collection, ".working")) fail("PATH", "이 스페이스의 작업 폴더가 아닙니다");
  await plainDirectory(task);
  const records = repos.flatMap((repo) => repo.entries.filter((entry, index) => index > 0 && taskGroupPath(entry.path) === task)
    .map((entry) => readCreator(entry.path)));
  if (!records.length || records.some((record) => !record || record.source !== "iris")) fail("PATH", "Iris에서 만든 worktree가 아닙니다");
  const session = await launchSession(msg, task);
  for (const record of records) if (!record.session) writeCreator({ ...record, session });
}
function rename(msg, ctx) {
  if (typeof msg.label !== "string" || msg.label.trim().length > 120) fail("LABEL", "표시 이름은 120자 이하로 입력하세요");
  if (typeof msg.path !== "string" || !path.isAbsolute(msg.path)) fail("PATH", "worktree 경로가 없습니다");
  const requested = path.resolve(msg.path);
  const entry = ctx.entries.find((item) => item.path === requested);
  let marker = entry && !entry.prunable && identity(requested);
  if (!marker) fail("PATH", "Git worktree 목록에서 폴더를 찾을 수 없습니다");
  let target = requested;
  if (msg.groupPath !== undefined) {
    if (typeof msg.groupPath !== "string" || !path.isAbsolute(msg.groupPath)) fail("PATH", "그룹 폴더 경로가 없습니다");
    target = path.resolve(msg.groupPath);
    const space = snapshot().workspaces.find((item) => item.id === msg.spaceId || item.workspaceId === msg.spaceId);
    const collection = requested === ctx.primary && target === realExisting(space?.folder)
      && target !== ctx.repo && within(target, ctx.repo);
    if (target !== taskGroupPath(requested) && !collection) fail("PATH", "이 worktree의 그룹 폴더가 아닙니다");
    let stat;
    try { stat = fs.statSync(target, { bigint: true }); }
    catch { fail("PATH", "그룹 폴더를 찾을 수 없습니다"); }
    if (!stat.isDirectory() || realExisting(target) !== target) fail("PATH", "그룹 폴더를 확인할 수 없습니다");
    marker = { dev: String(stat.dev), ino: String(stat.ino) };
  }
  const label = msg.label.trim();
  saveLabel(target, label, marker);
  return { path: requested, label: label || null, ...(msg.groupPath !== undefined ? { groupPath: target } : {}) };
}
async function remove(msg, ctx) {
  if (typeof msg.path !== "string" || !path.isAbsolute(msg.path)) fail("PATH", "worktree 경로가 없습니다");
  const requested = path.resolve(msg.path);
  const entry = ctx.entries.find((item, index) => index > 0 && item.path === requested);
  if (!entry || !ownedRecord(ctx, entry)) fail("PATH", "Iris에서 만든 worktree만 삭제할 수 있습니다");
  if (entry.locked || entry.prunable) fail("LOCKED", "잠겼거나 사라진 worktree는 삭제할 수 없습니다");
  const real = await fs.promises.realpath(requested).catch(() => fail("PATH", "worktree 폴더가 없습니다"));
  if (real !== requested) fail("PATH", "심볼릭 링크인 worktree는 삭제할 수 없습니다");
  const active = () => snapshot().workspaces.some((s) => s.folder && within(real, realExisting(s.folder)))
    || snapshot().state.some((agent) => agent.cwd && within(real, realExisting(agent.cwd)));
  if (active()) fail("ACTIVE", "이 worktree를 쓰는 스페이스나 세션을 닫은 뒤 삭제하세요");
  if (!getLivePanes) fail("SESSIONS", "실행 중인 터미널을 확인할 수 없습니다");
  let panes;
  try { panes = await getLivePanes(); } catch { fail("SESSIONS", "실행 중인 터미널을 확인할 수 없습니다"); }
  if (!Array.isArray(panes) || panes.some((pane) => !pane.cwd)) fail("SESSIONS", "터미널 위치를 확인할 수 없습니다");
  if (panes.some((pane) => within(real, realExisting(pane.cwd)))) fail("ACTIVE", "이 worktree를 쓰는 터미널을 닫은 뒤 삭제하세요");
  if ((await git(real, ["status", "--porcelain=v1", "-uall", "--ignored"])).trim()) fail("DIRTY", "커밋하지 않은 변경이 있어 삭제할 수 없습니다");
  if (active()) fail("ACTIVE", "이 worktree를 쓰는 스페이스나 세션을 닫은 뒤 삭제하세요");
  try { panes = await getLivePanes(); } catch { fail("SESSIONS", "실행 중인 터미널을 확인할 수 없습니다"); }
  if (!Array.isArray(panes) || panes.some((pane) => !pane.cwd)) fail("SESSIONS", "터미널 위치를 확인할 수 없습니다");
  if (panes.some((pane) => within(real, realExisting(pane.cwd)))) fail("ACTIVE", "이 worktree를 쓰는 터미널을 닫은 뒤 삭제하세요");
  // 실행 중: pane 의 cwd 는 밖이어도 그 안의 프로세스가 이 폴더에서 도는 경우. 목록과 같은 판정을 새로 조사
  const running = runningPanes(await processScan(panes, true), real);
  if (!running) fail("SESSIONS", "실행 중인 프로세스를 확인할 수 없습니다");
  if (running.length) fail("ACTIVE", "이 worktree에서 실행 중인 프로세스를 끝낸 뒤 삭제하세요");
  const records = readOwnership();
  const owned = ownedRecord(ctx, entry);
  saveOwnership(records.map((record) => record.primary === owned.primary && record.path === owned.path
    ? { ...record, status: "removing" } : record));
  try { await git(ctx.repo, ["worktree", "remove", "--", requested]); }
  catch (error) {
    try { saveOwnership(readOwnership().map((record) => record.primary === ctx.primary && record.path === requested
      && record.status === "removing" ? { ...record, status: "owned" } : record)); } catch {}
    throw error;
  }
  saveOwnership(readOwnership().filter((record) => !(record.primary === ctx.primary && record.path === requested)));
  forgetChange(requested);
  removeCreator(requested);
  return { path: requested, branch: entry.branch || "" };
}

export async function performWorktreeRequest(msg, local = true) {
  if (!local) fail("LOCAL_ONLY", "원격 연결에서는 쓸 수 없습니다");
  if (!["worktrees.list", "worktrees.create", "worktrees.remove", "worktrees.launched", "worktrees.rename"].includes(msg.type)) fail("OP", "알 수 없는 요청입니다");
  const ctx = await context(msg, ["worktrees.list", "worktrees.create", "worktrees.launched"].includes(msg.type));
  if (ctx.collection) {
    const repos = await collectionRepos(ctx.collection);
    if (msg.type === "worktrees.list") return collectionDescription(ctx, repos);
    const keys = [ctx.collection, ...repos.map((repo) => repo.primary)];
    if (keys.some((key) => locks.has(key))) fail("BUSY", "다른 worktree 작업이 진행 중입니다");
    keys.forEach((key) => locks.add(key));
    try {
      const fresh = await context(msg, true);
      if (fresh.collection !== ctx.collection) fail("REPO", "스페이스 저장소가 바뀌었습니다");
      const current = await collectionRepos(fresh.collection);
      if (current.length !== repos.length || current.some((repo) => !keys.includes(repo.primary))) fail("BUSY", "하위 저장소가 바뀌었습니다. 다시 시도하세요");
      if (msg.type === "worktrees.create") return await createCollection(msg, fresh, current);
      await bindCollectionLaunch(msg, fresh, current);
      return { path: msg.path, ...await collectionDescription(fresh, current) };
    } finally { keys.forEach((key) => locks.delete(key)); }
  }
  if (msg.type === "worktrees.list") {
    const useOf = await usersReader();
    return { repo: ctx.repo, primary: ctx.primary, entries: await describe(ctx, useOf), branches: await branches(ctx), panes: useOf.panes };
  }
  if (msg.type === "worktrees.launched") {
    await bindLaunch(msg, ctx);
    return { path: msg.path, repo: ctx.repo, primary: ctx.primary, entries: await describe(ctx, await usersReader()) };
  }
  if (locks.has(ctx.primary)) fail("BUSY", "다른 worktree 작업이 진행 중입니다");
  locks.add(ctx.primary);
  try {
    const fresh = await context(msg);
    const result = msg.type === "worktrees.create" ? await create(msg, fresh)
      : msg.type === "worktrees.rename" ? rename(msg, fresh) : await remove(msg, fresh);
    return { ...result, repo: fresh.repo, primary: fresh.primary, entries: await describe(await context(msg), await usersReader()) };
  } finally { locks.delete(ctx.primary); }
}

function safeSend(ws, payload) {
  if (ws.readyState !== undefined && ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(payload)); } catch {}
}

export function handleWorktrees(ws, msg) {
  if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("worktrees.")) return false;
  const requestId = typeof msg.requestId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(msg.requestId) ? msg.requestId : null;
  if (!requestId) { safeSend(ws, { type: "worktrees.result", ok: false, code: "REQUEST_ID", message: "잘못된 요청입니다" }); return true; }
  let receipts = receiptsByClient.get(ws);
  if (!receipts) { receipts = new Map(); receiptsByClient.set(ws, receipts); }
  const key = `${requestId}:${msg.type}`;
  const fingerprint = JSON.stringify([msg.type, msg.spaceId, msg.repo, msg.name, msg.branch, msg.base, msg.path, msg.paneId, msg.label, msg.groupPath, msg.launch]);
  if (receipts.has(key)) {
    const prior = receipts.get(key);
    if (prior.fingerprint !== fingerprint) safeSend(ws, { type: "worktrees.result", requestId, op: msg.type,
      ok: false, code: "REQUEST_CONFLICT", message: "요청이 중복되었습니다. 다시 시도하세요" });
    else if (prior.result) safeSend(ws, prior.result);
    return true;
  }
  const receipt = { fingerprint, result: null };
  receipts.set(key, receipt);
  void performWorktreeRequest(msg, !!ws._local).then((data) => {
    const result = { type: "worktrees.result", requestId, op: msg.type, ok: true, ...data };
    receipt.result = result; safeSend(ws, result);
  }).catch((error) => {
    const result = { type: "worktrees.result", requestId, op: msg.type, ok: false,
      code: error.code || "ERROR", message: String(error.message || error),
      ...(error.createdPath ? { createdPath: error.createdPath, branch: error.branch } : {}),
      ...(error.createdPaths ? { createdPaths: error.createdPaths, spaceCwd: error.spaceCwd,
        branch: error.branch, failedRepo: error.failedRepo } : {}) };
    receipt.result = result; safeSend(ws, result);
  }).finally(() => { while (receipts.size > MAX_RECEIPTS) receipts.delete(receipts.keys().next().value); });
  return true;
}
