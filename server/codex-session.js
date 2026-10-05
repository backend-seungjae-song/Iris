import { request as winRequest } from "./win-native.cjs";
// 등록된 대화 ID를 우선한다. 공유 daemon의 열린 파일은 여러 pane의 대화를 포함하므로
// 등록이 없을 때만 해당 pane의 프로세스와 자손에서 기록 파일을 찾는다.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { codexHome } from "./agent-homes.js";
import { agentSessionPathFor, validateAgentSessionPath } from "./agent-session-path.js";

const SESSIONS = codexHome("sessions");
const UUID_RE = /rollout-.*?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 여러 pane을 한 회차에 조회하므로 lsof·ps는 회차마다 한 번만 실행한다. 회차 사이에도 짧게만
// 재사용한다. 키가 오래되면 다른 대화를 복원하게 되므로 캐시는 짧을수록 안전하다.
const SCAN_TTL_MS = 1500;

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 8 << 20, timeout: 4000 }, (err, stdout) => resolve(err && !stdout ? "" : String(stdout || "")));
  });
}

let scanCache = { at: 0, byPid: new Map(), children: new Map() };
let scanning = null;
let fileIndex = { root: null, at: 0, promise: null };

async function sessionFromId(id) {
  if (!ID_RE.test(id || "")) return null;
  const root = codexHome("sessions");
  if (fileIndex.root !== root || Date.now() - fileIndex.at >= SCAN_TTL_MS) {
    const promise = fs.promises.readdir(root, { recursive: true, withFileTypes: true }).then((entries) => {
      const index = new Map();
      for (const entry of entries) {
        const match = entry.isFile() && UUID_RE.exec(entry.name);
        if (!match) continue;
        const key = match[1].toLowerCase();
        const file = path.join(entry.parentPath || entry.path, entry.name);
        index.set(key, index.has(key) ? null : file);
      }
      return index;
    }).catch(() => new Map());
    fileIndex = { root, at: Date.now(), promise };
  }
  const file = (await fileIndex.promise).get(id.toLowerCase());
  return file ? codexSessionFromPath(file, id) : null;
}

// lsof 한 번으로 codex 프로세스들이 물고 있는 rollout 경로를 pid별로 모으고,
// ps 한 번으로 부모→자식 표를 만든다(전면 프로세스가 codex가 아닐 때 자손을 찾기 위해).
async function scan() {
  const now = Date.now();
  if (now - scanCache.at < SCAN_TTL_MS) return scanCache;
  if (scanning) return scanning;
  scanning = (async () => {
    if (process.platform === "win32") {
      const result = await winRequest({ op: "processes" });
      const children = new Map();
      if (result.ok) for (const row of result.processes) {
        if (!children.has(row.ppid)) children.set(row.ppid, []);
        children.get(row.ppid).push({ pid: row.pid, comm: String(row.name || "").replace(/\.exe$/i, "").toLowerCase() });
      }
      scanCache = { at: Date.now(), byPid: new Map(), children };
      scanning = null;
      return scanCache;
    }
    const [lsofOut, psOut] = await Promise.all([
      run("lsof", ["-c", "codex", "-Fpn"]),
      run("ps", ["-axo", "pid=,ppid=,comm="]),
    ]);
    const byPid = new Map();
    let pid = null;
    for (const line of lsofOut.split("\n")) {
      if (line[0] === "p") pid = Number(line.slice(1)) || null;
      else if (line[0] === "n" && pid) {
        const f = line.slice(1);
        if (f.startsWith(SESSIONS) && UUID_RE.test(f)) {
          if (!byPid.has(pid)) byPid.set(pid, []);
          byPid.get(pid).push(f);
        }
      }
    }
    const children = new Map();   // ppid → [{pid, comm}]
    for (const line of psOut.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!m) continue;
      const kid = { pid: Number(m[1]), comm: path.basename(m[3].trim()) };
      const parent = Number(m[2]);
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(kid);
    }
    scanCache = { at: Date.now(), byPid, children };
    scanning = null;
    return scanCache;
  })();
  return scanning;
}

// 그 pid가 열고 있는 rollout 중 현재 사용 중인 파일.
function liveRollout(byPid, pid) {
  let best = null;
  for (const f of byPid.get(pid) || []) {
    const m = UUID_RE.exec(f);
    if (!m) continue;
    let mtime = 0;
    try { mtime = fs.statSync(f).mtimeMs; } catch { continue; }
    if (!best || mtime > best.mtime) best = { uuid: m[1], file: f, mtime };
  }
  return best;
}

export function codexSessionFromPath(file, sessionId = null, options = {}) {
  const verified = validateAgentSessionPath("codex", file, options);
  const match = verified ? UUID_RE.exec(verified) : null;
  if (!match || (sessionId && match[1].toLowerCase() !== String(sessionId).toLowerCase())) return null;
  return { uuid: match[1], file: verified };
}

// CLI가 기록 파일을 직접 열지 않는 Codex 버전에서는 자식 앱 서버가 파일을 연다.
// 같은 CLI 아래의 과거 대화 파일도 잡히므로 자손 전체에서 최근 수정 파일을 고른다.
export function liveRolloutForTree(byPid, children, rootPid) {
  if (!rootPid) return null;
  const seen = new Set();
  const stack = [rootPid];
  let best = null;
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const hit = liveRollout(byPid, pid);
    if (hit && (!best || hit.mtime > best.mtime)) best = hit;
    for (const kid of children.get(pid) || []) stack.push(kid.pid);
  }
  return best;
}

// shell_pid 아래에서 codex 프로세스를 찾는다(전면 프로세스가 도구 실행 중인 자식일 때의 경로).
function findCodexDescendant(children, rootPid) {
  const seen = new Set();
  const stack = [rootPid];
  while (stack.length) {
    const p = stack.pop();
    if (seen.has(p)) continue;
    seen.add(p);
    for (const kid of children.get(p) || []) {
      if (kid.comm === "codex") return kid.pid;
      stack.push(kid.pid);
    }
  }
  return null;
}

// pane 하나의 codex 세션. 찾지 못하면 null 이고, 그때는 보관이 차단된다.
export async function resolveCodexSession(herdr, paneId) {
  if (!paneId) return null;
  try {
    const reported = agentSessionPathFor(paneId, "codex");
    if (typeof herdr.paneGet === "function") {
      const pane = await herdr.paneGet(paneId);
      if (pane?.agent !== "codex") return null;
      if (pane?.agent_session?.kind === "id") {
        const id = pane.agent_session.value;
        if (!ID_RE.test(id || "")) return null;
        const hit = reported && codexSessionFromPath(reported.file, id);
        return hit || await sessionFromId(id) || { uuid: id, file: null };
      }
      if (pane?.agent_session?.kind === "path") {
        return codexSessionFromPath(pane.agent_session.value);
      }
    }
    if (reported && typeof herdr.paneGet !== "function") return codexSessionFromPath(reported.file, reported.sessionId);
    const [{ byPid, children }, info] = await Promise.all([
      scan(),
      herdr.call("pane.process_info", { pane_id: paneId }),
    ]);
    const pi = info?.process_info || info || {};
    const fg = Array.isArray(pi.foreground_processes) ? pi.foreground_processes : [];
    const foreground = fg.find((p) => p.name === "codex" || p.argv0 === "codex" || (process.platform === "win32" && [p.name, p.argv0, p.argv?.[0]].some((name) => /^codex(?:\.exe|\.cmd)?$/i.test(path.win32.basename(name || "")))));
    let pid = foreground?.pid || null;
    if (!pid && pi.shell_pid) pid = findCodexDescendant(children, Number(pi.shell_pid));
    if (!pid) return null;
    const hit = liveRolloutForTree(byPid, children, pid);
    if (hit) return { uuid: hit.uuid, file: hit.file };
    // resume의 첫 입력 전에는 등록 훅이 아직 실행되지 않는다. 명시한 ID만 사용한다.
    const argv = foreground?.argv || [];
    const resume = argv.indexOf("resume");
    return resume > 0 ? await sessionFromId(argv[resume + 1]) : null;
  } catch {
    return null;
  }
}

// 관제 상태의 codex 항목에 세션 키를 채운다. herdr가 제공하는 항목(claude)은 변경하지 않는다.
export async function attachCodexSessions(state, herdr) {
  const need = (state || []).filter((s) => String(s.agent || "").toLowerCase() === "codex" && !s.sessionFile);
  if (!need.length) return state;
  await Promise.all(need.map(async (s) => {
    const hit = await resolveCodexSession(herdr, s.paneId);
    if (hit) { s.sessionUuid = hit.uuid; s.sessionFile = hit.file; }
  }));
  return state;
}
