// transcript 조인. herdr 세션 UUID를 Claude Code 서브에이전트 트리로 변환한다.
//
// 규칙:
//  - herdr agent_session.value = Claude Code 세션 UUID
//  - transcript: ~/.claude/projects/<slug>/<uuid>.jsonl + <uuid>/subagents/agent-<id>.jsonl(.meta.json)
//  - meta.json에 상태 필드 없음 → "실행 중" = 서브 jsonl이 최근 창 안에 쓰였는가(mtime, 파일 활동).
//    tool_use↔tool_result 대조는 쓰지 않는다(백그라운드는 실행 중에도 결과가 즉시 도착하고,
//    압축된 세션은 완료돼도 결과가 소실된다. 아래 RUNNING_MTIME_WINDOW_MS 주석 참조).
//  - 중첩 = meta.toolUseId ↔ 부모 jsonl의 tool_use.id (spawnDepth 비의존)
//  - 표시 범위 = 실행 중인 것만. 완료된 것은 트리에서 제외.
import fs from "node:fs";
import path from "node:path";
import { claudeHome } from "./agent-homes.js";
import { agentSessionPathFor, sessionIdsFromTranscriptTail, sessionPathRoots,
  validateAgentSessionPath, validateResolvedAgentSessionPath } from "./agent-session-path.js";

// 세션 UUID → { sessionFile, sessionDir } 역인덱스. slug를 모르는 채로 찾는다.
export function indexProjects(projectsRoot = claudeHome("projects")) {
  const scan = beginProjectScan(projectsRoot);
  if (!scan) return new Map();
  for (const p of scan.dirs) scanProjectDir(scan, p);
  return finishProjectScan(scan);
}

// 기록 파일이 수천 개라 파일마다 realpath·stat 을 부르면 색인 한 번이 수백 ms 동안 이벤트 루프를 막는다.
// 루트의 realpath 를 한 번 구하고, 심링크가 아닌 폴더·파일(dirent 가 보장)은 이름을 이어 붙여 경로를 확정한다.
function beginProjectScan(projectsRoot) {
  let dirs, rootReal;
  try {
    dirs = fs.readdirSync(projectsRoot, { withFileTypes: true });
    rootReal = fs.realpathSync(projectsRoot);
  } catch {
    return null;
  }
  return { projectsRoot, rootReal, dirs, idx: new Map(), aliases: new Map(), allowed: sessionPathRoots({ claudeRoot: projectsRoot }) };
}

function scanProjectDir(scan, p) {
  if (!p.isDirectory()) return;
  const { idx, aliases, allowed } = scan;
  const projPath = path.join(scan.projectsRoot, p.name);
  const projReal = path.join(scan.rootReal, p.name);
  let entries;
  try {
    entries = fs.readdirSync(projPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(projPath, e.name);
    if (e.isDirectory()) {
      const rec = idx.get(e.name) || {};
      rec.dir = full;
      idx.set(e.name, rec);
    } else if (e.name.endsWith(".jsonl")) {
      const verified = e.isFile()
        ? validateResolvedAgentSessionPath("claude", path.join(projReal, e.name), { roots: allowed })
        : validateAgentSessionPath("claude", full, { roots: allowed });
      if (!verified) continue;
      const uuid = e.name.slice(0, -6);
      const rec = idx.get(uuid) || {};
      rec.file = verified;
      idx.set(uuid, rec);
      for (const alias of sessionIdsFromTranscriptTail(verified)) {
        if (!aliases.has(alias)) aliases.set(alias, new Set());
        aliases.get(alias).add(rec);
      }
    }
  }
}

function finishProjectScan(scan) {
  for (const [alias, records] of scan.aliases) {
    if (!scan.idx.has(alias) && records.size === 1) scan.idx.set(alias, records.values().next().value);
  }
  return scan.idx;
}

// 관제 재계산이 쓰는 색인. 처음 필요할 때 한 번 동기로 만들고, 그 뒤로는 쓰인 직후 뒤에서 폴더 50개씩
// 끊어 다시 만들어 다음 재계산이 기다리지 않게 한다. 색인은 새 세션 파일이 생긴 뒤 한 갱신 주기 동안
// 그 파일을 모를 수 있다. 그동안 그 세션은 기록 없이 표시되고 다음 재계산에서 채워진다.
const PROJECT_INDEX_CHUNK = 50;
let projectIndexCache = null; // { root, idx }
let projectIndexRefresh = null;
let projectIndexDirty = false;

export function refreshProjectIndex(projectsRoot = claudeHome("projects")) {
  if (projectIndexRefresh) { projectIndexDirty = true; return projectIndexRefresh; }
  projectIndexRefresh = (async () => {
    try {
      await new Promise((resolve) => setImmediate(resolve)); // 부른 재계산이 끝난 뒤에 시작한다
      const scan = beginProjectScan(projectsRoot);
      if (!scan) { projectIndexCache = { root: projectsRoot, idx: new Map() }; return; }
      for (let i = 0; i < scan.dirs.length; i += PROJECT_INDEX_CHUNK) {
        for (const p of scan.dirs.slice(i, i + PROJECT_INDEX_CHUNK)) scanProjectDir(scan, p);
        await new Promise((resolve) => setImmediate(resolve));
      }
      projectIndexCache = { root: projectsRoot, idx: finishProjectScan(scan) };
    } finally {
      projectIndexRefresh = null;
      if (projectIndexDirty) { projectIndexDirty = false; refreshProjectIndex(projectsRoot); }
    }
  })();
  return projectIndexRefresh;
}

// 색인은 hook 이 보고하지 않았고 herdr 도 경로를 모르는 Claude 세션에만 쓰인다. 조회가 없으면 만들지 않고,
// 조회가 있으면 마지막으로 만든 색인을 돌려주고 뒤에서 새로 만들기 시작한다.
function lazyProjectIndex() {
  let built = null;
  const get = () => {
    if (built) return built;
    const root = claudeHome("projects");
    if (!projectIndexCache || projectIndexCache.root !== root) projectIndexCache = { root, idx: indexProjects(root) };
    built = projectIndexCache.idx;
    refreshProjectIndex(root).catch(() => {});
    return built;
  };
  return { get: (key) => get().get(key), has: (key) => get().has(key) };
}

// transcript(.jsonl) 한 파일의 tool_use id 집합(부모 식별용)
// 파일별로 읽은 위치까지의 결과를 저장하고 늘어난 줄만 읽음
// 관제 재계산(4초 주기)마다 파일 전체를 읽던 때 장수 세션(수십 MB)이 겹치면 120초에 GB 단위 할당, 서버 힙 1.5GB
const toolUseCache = new Map(); // 파일 → { size, offset, ids }
const TOOL_USE_CACHE_LIMIT = 2000;

function toolUseIds(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const { size } = fs.fstatSync(fd);
    let entry = toolUseCache.get(file);
    // 크기가 줄었으면 새로 쓰인 파일로 보고 처음부터
    if (!entry || size < entry.size) entry = { size: 0, offset: 0, ids: new Set() };
    if (size > entry.offset) {
      const chunk = Buffer.allocUnsafe(size - entry.offset);
      const read = fs.readSync(fd, chunk, 0, chunk.length, entry.offset);
      // 마지막 줄바꿈 뒤는 아직 쓰는 중인 줄. 다음 호출에서 읽음
      const end = chunk.lastIndexOf(0x0a, read - 1) + 1;
      if (end > 0) collectToolUseIds(chunk.toString("utf8", 0, end), entry.ids);
      entry.offset += end;
    }
    entry.size = size;
    toolUseCache.delete(file);
    toolUseCache.set(file, entry);
    if (toolUseCache.size > TOOL_USE_CACHE_LIMIT) toolUseCache.delete(toolUseCache.keys().next().value);
    return entry.ids;
  } catch {
    return new Set();
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

function collectToolUseIds(text, ids) {
  for (const line of text.split("\n")) {
    if (!line || line.indexOf("tool_use") < 0) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const content = rec?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c && typeof c === "object" && c.type === "tool_use" && c.id) ids.add(c.id);
    }
  }
}

// 한 세션 UUID에 대한 실행 중 서브에이전트 트리.
export function subagentTree(sessionUuid, idx, sessionRec = null) {
  const rec = sessionRec || idx.get(sessionUuid);
  if (!rec) return [];
  const sessionDir = rec.dir || (rec.file ? rec.file.replace(/\.jsonl$/, "") : null);
  if (!sessionDir) return [];
  const subDir = path.join(sessionDir, "subagents");

  let metaFiles;
  try {
    metaFiles = fs.readdirSync(subDir).filter((f) => f.endsWith(".meta.json"));
  } catch {
    return [];
  }

  // 각 서브에이전트 노드 로드.
  const nodes = new Map(); // agentId → node
  const jsonls = []; // 부모 스캔 대상: 세션 파일 + 각 서브에이전트 jsonl
  if (rec.file) jsonls.push(rec.file);
  for (const mf of metaFiles) {
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(subDir, mf), "utf8"));
    } catch {
      continue;
    }
    const agentId = mf.replace(/^agent-/, "").replace(/\.meta\.json$/, "");
    const jsonl = path.join(subDir, `agent-${agentId}.jsonl`);
    let mtime = 0;
    try {
      mtime = fs.statSync(jsonl).mtimeMs;
    } catch {
      // meta는 있는데 jsonl이 없으면 활동 흔적 없음 → mtime 0(제외 대상).
    }
    nodes.set(agentId, {
      agentId,
      agentType: meta.agentType || "?",
      description: meta.description || "",
      toolUseId: meta.toolUseId || null,
      mtime,
      parent: null,
      children: [],
    });
    if (mtime) jsonls.push(jsonl);
  }

  // mtime precheck: 최근 활동한 서브가 하나도 없으면 이 세션은 실행 중 서브가 없다.
  // 무거운 transcript 스캔(장수 세션은 수십 MB)을 건너뛴다. status 게이트를 대신하는 성능 최적화다.
  const now0 = Date.now();
  const hasRecent = [...nodes.values()].some(
    (n) => n.mtime > 0 && now0 - n.mtime <= RUNNING_MTIME_WINDOW_MS
  );
  if (!hasRecent) return [];

  // 관련 jsonl을 한 번씩 스캔해 tool_use 소유만 모은다(부모 중첩 판별용).
  // resulted(tool_result 도착)는 더는 liveness 신호가 아니라 수집하지 않는다.
  // 같은 id 가 여러 파일에 있으면 목록 뒤쪽 파일이 소유자
  const idsByFile = jsonls.map((j) => [j, toolUseIds(j)]).reverse();
  const ownerFileOf = (id) => idsByFile.find(([, ids]) => ids.has(id))?.[0];

  // 부모: toolUseId를 tool_use로 가진 jsonl의 소유자 = 부모(세션 or 다른 서브).
  const fileToAgent = new Map(); // jsonl 경로 → agentId (부모 역참조)
  for (const [agentId] of nodes) {
    fileToAgent.set(path.join(subDir, `agent-${agentId}.jsonl`), agentId);
  }

  // liveness = jsonl이 이 창 안에 쓰였는가(mtime). tool_result 유무는 보지 않는다.
  // 백그라운드 서브는 실행 중에도 result가 도착하고, 압축된 과거 서브는 완료됐는데도
  // result가 소실되어 둘 다 오판이 된다. 파일 활동만이 세 경우에 일관된 신호다.
  const now = Date.now();
  const running = [];
  for (const node of nodes.values()) {
    if (!node.toolUseId) continue;
    const recentlyActive = node.mtime > 0 && now - node.mtime <= RUNNING_MTIME_WINDOW_MS;
    if (!recentlyActive) continue; // 실행 중 = 최근 파일 활동
    // 부모 판별
    const ownerFile = ownerFileOf(node.toolUseId);
    if (ownerFile && fileToAgent.has(ownerFile)) {
      node.parent = fileToAgent.get(ownerFile);
    }
    running.push(node);
  }

  // 트리 조립: parent가 running 집합 안에 있으면 자식으로, 아니면 루트.
  const runningIds = new Set(running.map((n) => n.agentId));
  const roots = [];
  const byId = new Map(running.map((n) => [n.agentId, n]));
  for (const n of running) {
    n.children = [];
  }
  for (const n of running) {
    if (n.parent && runningIds.has(n.parent) && byId.has(n.parent)) {
      byId.get(n.parent).children.push(n);
    } else {
      roots.push(n);
    }
  }
  // 직렬화 가능한 형태로(순환 없는 트리).
  // agentId 는 창이 그 서브에이전트의 대화를 열 때 돌려보내는 열쇠다(경로는 서버가 만든다).
  const strip = (n) => ({
    agentId: n.agentId,
    agentType: n.agentType,
    description: n.description,
    running: true,
    children: n.children.map(strip),
  });
  return roots.map(strip);
}

// herdr 에이전트 목록 → 각 에이전트에 서브트리 + Cross 표식을 붙인 관제 상태.
//
// liveness = 서브에이전트 jsonl이 최근 이 창 안에 쓰였는가(파일 활동, mtime).
//
// transcript의 tool_use↔tool_result 대조는 liveness 신호가 아니다. 세 경우가 모두 다르다:
//  - 포그라운드(동기) 서브: 완료 시에만 tool_result. 실행 중엔 미도착.
//  - 백그라운드 서브: tool_use 직후 tool_result(실행 시작 확인)를 즉시 받음 → 실행 중에도 "도착".
//  - 압축된 장수 세션: tool_use/result 쌍이 소실 → 완료됐는데도 미도착으로 보임.
// 유일하게 일관된 신호는 "지금 이 서브의 jsonl이 쓰이고 있는가"다. 실행 중이면(어느 경우든)
// 파일이 활발히 쓰이고, 완료되면 멈춘다. mtime 최근 = 실행 중, 오래됨 = 완료·과거.
// 완료 후 이 창 동안은 실행 중으로 표시되다가 사라진다(관제 UX상 자연스러운 근사).
export const RUNNING_MTIME_WINDOW_MS = 90_000;

// agentType(설명줄 제외)에 codex 계열이 있는지 재귀 검사. 대소문자 무시.
function treeHasCodex(nodes) {
  for (const n of nodes || []) {
    if (/codex/i.test(n.agentType || "")) return true;
    if (treeHasCodex(n.children)) return true;
  }
  return false;
}

export function buildMonitorState(agents) {
  const idx = lazyProjectIndex();
  return agents.map((a) => {
    const isClaude = String(a.agent || "").toLowerCase() === "claude";
    const reported = isClaude ? agentSessionPathFor(a.pane_id, "claude") : null;
    const nativePath = isClaude && a.agent_session?.kind === "path"
      ? validateAgentSessionPath("claude", a.agent_session.value) : null;
    const nativeIds = nativePath ? sessionIdsFromTranscriptTail(nativePath) : new Set();
    const uuid = reported?.sessionId || (nativePath
      ? (nativeIds.size === 1 ? nativeIds.values().next().value : null) : a.agent_session?.value || null);
    const rec = reported ? { file: reported.file, dir: reported.file.replace(/\.jsonl$/, "") }
      : nativePath ? { file: nativePath, dir: nativePath.replace(/\.jsonl$/, "") }
        : isClaude && uuid ? idx.get(uuid) : null;
    // status 게이트를 두지 않는다. subagentTree 내부 mtime precheck가 idle 세션을 저렴하게 건너뛰고,
    // 백그라운드 서브(부모 idle이어도 실행 중)를 정확히 포함한다.
    const tree = isClaude && uuid ? subagentTree(uuid, idx, rec) : [];
    // Cross: 서브트리의 agentType(설명줄 아님)에 codex 계열이 있으면 Claude×Codex 교차.
    // 세션(owner)이 codex 검증자(verifier)를 실행한 구조다. description 오탐을 피해 agentType만 본다.
    const hasCodex = treeHasCodex(tree);
    return {
      agent: a.agent,
      status: a.agent_status,
      cwd: a.cwd,
      workspaceId: a.workspace_id,
      paneId: a.pane_id,
      terminalId: a.terminal_id || null,
      focused: !!a.focused, // herdr에서 현재 포커스된 pane → UI 선택을 역방향 동기화(loop-safe)
      sessionUuid: uuid,
      transcriptFile: rec?.file || null, // 질문 판정용 원본 기록
      cross: hasCodex ? { owner: "claude", verifier: "codex" } : null,
      subagents: tree,
    };
  });
}
