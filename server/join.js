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

const PROJECTS = claudeHome("projects");

// 세션 UUID → { sessionFile, sessionDir } 역인덱스. slug를 모르는 채로 찾는다.
export function indexProjects() {
  const idx = new Map();
  let projDirs;
  try {
    projDirs = fs.readdirSync(PROJECTS, { withFileTypes: true });
  } catch {
    return idx;
  }
  for (const p of projDirs) {
    if (!p.isDirectory()) continue;
    const projPath = path.join(PROJECTS, p.name);
    let entries;
    try {
      entries = fs.readdirSync(projPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(projPath, e.name);
      if (e.isDirectory()) {
        const rec = idx.get(e.name) || {};
        rec.dir = full;
        idx.set(e.name, rec);
      } else if (e.name.endsWith(".jsonl")) {
        const uuid = e.name.slice(0, -6);
        const rec = idx.get(uuid) || {};
        rec.file = full;
        idx.set(uuid, rec);
      }
    }
  }
  return idx;
}

// 부모 transcript(.jsonl)를 훑어: Agent tool_use id → 결과 도착 여부, 그리고 자식 tool_use 소유.
function scanTranscript(file) {
  const agentUse = new Map(); // tool_use.id → { desc }
  const resulted = new Set(); // tool_result가 도착한 tool_use.id
  const ownerOf = new Map(); // 모든 tool_use.id → 이 파일(부모 식별용)
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { agentUse, resulted, ownerOf };
  }
  for (const line of text.split("\n")) {
    if (!line) continue;
    if (line.indexOf("tool_use") < 0 && line.indexOf("tool_result") < 0) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const content = rec?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (!c || typeof c !== "object") continue;
      if (c.type === "tool_use" && c.id) {
        ownerOf.set(c.id, file);
        if (c.name === "Agent" || c.name === "Task") {
          agentUse.set(c.id, { desc: c.input?.description || "" });
        }
      } else if (c.type === "tool_result" && c.tool_use_id) {
        resulted.add(c.tool_use_id);
      }
    }
  }
  return { agentUse, resulted, ownerOf };
}

// 한 세션 UUID에 대한 실행 중 서브에이전트 트리.
export function subagentTree(sessionUuid, idx) {
  const rec = idx.get(sessionUuid);
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
  const ownerOf = new Map();
  for (const j of jsonls) {
    const s = scanTranscript(j);
    for (const [id, f] of s.ownerOf) ownerOf.set(id, f);
  }

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
    const ownerFile = ownerOf.get(node.toolUseId);
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
  const strip = (n) => ({
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
  const idx = indexProjects();
  return agents.map((a) => {
    const uuid = a.agent_session?.value || null;
    // status 게이트를 두지 않는다. subagentTree 내부 mtime precheck가 idle 세션을 저렴하게 건너뛰고,
    // 백그라운드 서브(부모 idle이어도 실행 중)를 정확히 포함한다.
    const tree = uuid ? subagentTree(uuid, idx) : [];
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
      cross: hasCodex ? { owner: "claude", verifier: "codex" } : null,
      subagents: tree,
    };
  });
}
