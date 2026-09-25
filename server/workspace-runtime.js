import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as archive from "./archive.js";
import { attachAgentLineage, watchAgentLineage } from "./agent-lineage.js";
import { attachQuestionState } from "./agent-question.js";
import { attachCodexSessions } from "./codex-session.js";
import { buildMonitorState } from "./join.js";
import * as spaceKey from "./space-key.js";

// Herdr에서 workspace 후보 snapshot을 만들고 재계산 이벤트를 모으는 runtime owner.
//
// 소유 범위
//   workspace/agent/tab build 과정과 Herdr event의 150ms recompute·300ms resubscribe timer.
//
// 제공 API
//   init/start/stop lifecycle, buildWorkspaceSnapshot과 recovery evidence 함수. 가변 timer는 내보내지 않는다.
//
// 의존 대상
//   Herdr 서비스와 recompute·broadcast·pane scroll port는 entry에서 주입받고,
//   build는 join/codex-session/space-key/archive owner에 기대며 handler를 import하지 않는다.
//
// 유지 조건
//   agent→codex session→workspace→tab 병합 순서, workspace folder identity 판정과 Herdr event 조건,
//   150ms debounce·300ms resubscribe 타이밍을 보존하고 build 중 runtime snapshot을 publish하지 않는다.
//
// 영향 범위
//   server/index.js의 build→migrate→publish composition과 Herdr start 배선,
//   server/browser-state-owner.js의 space-key migration 및 herdr-handlers의 pane scroll cache port,
//   bin/smoke.mjs의 space identity·recompute 소유 검사와 test/space-* migration 계약.

let herdr;
let requestRecompute;
let broadcast;
let debounceTimer = null;
let resubTimer = null;
let lineageWatcher = null;
let lineageDebounceTimer = null;

export function initWorkspaceRuntime(deps) {
  herdr = deps.herdr;
  requestRecompute = deps.requestRecompute;
  broadcast = deps.broadcast;
}

// pane 번호는 16진 꼬리표다(w18:p1, w18:pA). 문자열로 정렬하면 p10이 p2보다 앞선다.
function paneNo(paneId) {
  const m = String(paneId || "").match(/:p([0-9a-fA-F]+)$/);
  return m ? parseInt(m[1], 16) : Number.MAX_SAFE_INTEGER;
}

// herdr가 각 workspace를 어느 폴더의 것으로 보는지. 공개 API에는 없고 세션 파일에만 있으므로
// (herdr 0.7.3 확인) 있으면 사용하고 없으면 건너뛴다. 이 값이 없어도 동작하지 않는 경로는 없다.
function herdrIdentityCwds() { return herdrIdentityCwdsFrom(path.join(os.homedir(), ".config", "herdr", "session.json")); }
function herdrIdentityCwdsFrom(file) {
  const out = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const walk = (o) => {
      if (Array.isArray(o)) { for (const v of o) walk(v); return; }
      if (!o || typeof o !== "object") return;
      const id = o.workspace_id || o.id, cwd = o.identity_cwd;
      if (id && typeof cwd === "string" && cwd) out.set(String(id), cwd);
      for (const v of Object.values(o)) walk(v);
    };
    walk(raw);
  } catch {}
  return out;
}

export function buildSpaceRecoveryEvidence(workspaces = []) {
  const candidateDirs = [
    ...workspaces.map((workspace) => spaceKey.folderOf(workspace.id)).filter(Boolean),
    ...archive.list().flatMap((entry) => [entry.cwd, entry.spaceCwd]).filter(Boolean),
  ];
  const direct = Object.fromEntries(herdrIdentityCwds());
  try {
    const dir = path.join(os.homedir(), ".config", "herdr", "session-backups");
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      for (const [id, cwd] of herdrIdentityCwdsFrom(path.join(dir, file))) if (!direct[id]) direct[id] = cwd;
    }
  } catch {}
  return { candidateDirs, direct };
}

// Spaces(워크스페이스) 목록 + 각 Space의 대표 폴더(cwd). 좌상 사이드바용.
export async function buildWorkspaces(agents) {
  let list = [];
  try { list = await herdr.workspaceList(); } catch {}
  const folderByWs = new Map();
  for (const a of agents) {
    if (a.workspace_id && a.cwd && !folderByWs.has(a.workspace_id)) folderByWs.set(a.workspace_id, a.cwd);
  }
  // 상태 키는 cwd 문자열이 아니라 폴더 객체의 파일시스템 정체성이다. herdr identity_cwd가 다른
  // 폴더 객체로 바뀌면 workspace 바인딩도 그 객체로 바뀌고, 같은 객체가 rename/move돼 경로만
  // 바뀌면 키는 유지된다. pane cwd는 pane마다 달라질 수 있으므로 identity가 없을 때만 폴백한다.
  //
  // 생성 직후 identity_cwd가 잠시 홈을 가리킨 적이 있으므로 REQUESTED와 첫 identity가 다를 때는
  // 루트 pane cwd도 identity와 일치해야 받아들인다. 실제 cd 이동은 둘이 함께 바뀌므로 통과한다.
  const identity = herdrIdentityCwds();
  const seen = new Map();
  const migrations = [];
  for (const w of list) {
    const id = w.workspace_id;
    const confirmed = identity.get(id) || null;
    const current = spaceKey.folderOf(id);
    let cwd = confirmed;
    let source = confirmed ? spaceKey.CONFIRMED : spaceKey.WEAK;

    if (confirmed && current && spaceKey.srcOf(id) === spaceKey.REQUESTED
      && spaceKey.realDir(confirmed) !== spaceKey.realDir(current)) {
      let rootCwd = null;
      try {
        const panes = await herdr.paneList(id);
        const root = (panes || []).slice().sort((a, b) => paneNo(a.pane_id) - paneNo(b.pane_id))[0];
        rootCwd = root?.cwd || null;
      } catch {}
      if (!rootCwd || spaceKey.realDir(rootCwd) !== spaceKey.realDir(confirmed)) {
        cwd = current;
        source = spaceKey.REQUESTED;
      }
    }

    if (!cwd) {
      try {
        const panes = await herdr.paneList(id);
        const root = (panes || []).slice().sort((a, b) => paneNo(a.pane_id) - paneNo(b.pane_id))[0];
        cwd = root?.cwd || null;
      } catch {}
    }
    cwd = cwd || folderByWs.get(id) || current || null;
    const dir = cwd ? spaceKey.realDir(cwd) : null;
    if (!dir) continue;
    const firstBinding = !current;
    const learned = spaceKey.learnFolder(id, dir, source);
    if (firstBinding && learned.key && learned.key !== id) {
      migrations.push({ from: id, to: learned.key, why: `${id}: 폴더 객체 첫 배정(→ ${learned.key})` });
    }
    if (learned.dir) seen.set(id, learned.dir);
  }
  return {
    migrations,
    workspaces: list.map((w) => ({
      id: w.workspace_id, label: w.label || w.workspace_id,
      focused: !!w.focused, status: w.agent_status || "idle",
      folder: seen.get(w.workspace_id) || folderByWs.get(w.workspace_id) || null,
      key: spaceKey.keyOf(w.workspace_id),   // 창이 자기 저장분(파일 탭·기본 프로필·순서)에 쓸 키
    })),
  };
}

// 관제 상태 재계산의 build 단계. 파일 I/O가 있으므로 runtime-state의 재진입 guard가 이 함수를 부른다.
export async function buildWorkspaceSnapshot() {
  const agents = await herdr.agentList();
  // 원자적 재계산: 완전히 병합한 뒤에만 runtime snapshot에 대입한다. 대입을 먼저 하면
  // tab.list I/O를 기다리는 동안 새 연결이 tabLabel 미병합 상태를 캡처하는 레이스가 생긴다.
  const nextState = buildMonitorState(agents);
  // codex 세션 키는 herdr가 제공하지 않으므로 프로세스에서 찾아 채운다. 이 값을 채워야
  // 화면에서 codex도 접을 수 있는 세션으로 표시된다(codex-session.js 주석 참조).
  await attachCodexSessions(nextState, herdr);
  // codex 기록 파일까지 채운 뒤, 답을 끝낸 에이전트가 질문을 남겼는지 붙인다(status 는 그대로 둔다).
  attachQuestionState(nextState);
  // 부모 세션 UUID까지 검증할 수 있도록 codex 키를 채운 다음, launcher가 남긴 명시적
  // receipt를 현재 pane/terminal snapshot과 대조해 유효한 관계만 붙인다.
  attachAgentLineage(nextState, agents);
  const { workspaces, migrations } = await buildWorkspaces(agents);
  // 탭 목록(#8 라벨 + 탭이동): 워크스페이스별 tab.list → 라벨 맵 + 전체 탭 목록(세션 없는 탭 포함).
  // 에이전트 없는 워크스페이스도 포함해야 세션 미활성 탭까지 순환·포커스 가능.
  const allWsIds = [...new Set([...workspaces.map((w) => w.id), ...agents.map((a) => a.workspace_id)].filter(Boolean))];
  const tabLabel = new Map();
  const tabsByWorkspace = {};
  await Promise.all(allWsIds.map(async (w) => {
    try {
      const tabs = await herdr.tabList(w);
      tabsByWorkspace[w] = tabs.map((t) => ({ tabId: t.tab_id, number: t.number, label: t.label || "", focused: !!t.focused, agentStatus: t.agent_status || null, paneCount: t.pane_count || 0 }));
      for (const t of tabs) tabLabel.set(t.tab_id, t.label);
    } catch {}
  }));
  const infoByPane = new Map();
  for (const a of agents) if (a.pane_id) infoByPane.set(a.pane_id, { tabLabel: tabLabel.get(a.tab_id) || null, tabId: a.tab_id || null });
  for (const s of nextState) { const i = infoByPane.get(s.paneId); s.tabLabel = i?.tabLabel || null; s.tabId = i?.tabId || null; }
  // 탭 점도 같은 판정을 쓰도록 질문을 남긴 에이전트가 있는 탭에 question 을 붙인다.
  const questionTabs = new Set(nextState.filter((s) => s.question && s.tabId).map((s) => s.tabId));
  for (const list of Object.values(tabsByWorkspace)) for (const t of list) if (questionTabs.has(t.tabId)) t.question = true;
  return {
    agents,
    migrations,
    state: nextState,
    workspaces,
    tabs: tabsByWorkspace,
    allowedRoots: [...new Set([
      ...agents.map((a) => a.cwd),
      ...workspaces.map((w) => w.folder),
    ].filter(Boolean).map((cwd) => path.resolve(cwd)))],
  };
}

function handleHerdrEvent(ev) {
  // pane 집합이 바뀌는 이벤트면 구독도 갱신(새 pane의 status 변화를 받기 위해).
  const t = ev?.type || (typeof ev?.event === "string" ? ev.event : ev?.event?.type) || "";
  // 스크롤은 관제 상태를 바꾸지 않는다. 여기서 차단하지 않으면 스크롤하는 내내 아래 debounce가
  // 재계산을 실행하므로, 이 return 으로 막는다.
  if (t === "pane.scroll_changed") return;
  if (/pane\.(created|closed|exited)/.test(t)) {
    clearTimeout(resubTimer);
    resubTimer = setTimeout(() => herdr.refreshSubscription(), 300);
  }
  // 짧은 debounce로 연속된 이벤트를 한 번의 재계산으로 합친다.
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(requestRecompute, 150);
}

function handleHerdrConnect() {
  broadcast({ type: "herdr", connected: true });
  requestRecompute();
}

function handleHerdrClose() { broadcast({ type: "herdr", connected: false }); }
function handleHerdrError() {}

function handleLineageChange() {
  clearTimeout(lineageDebounceTimer);
  lineageDebounceTimer = setTimeout(requestRecompute, 50);
}

export function startWorkspaceRuntime() {
  herdr.on("event", handleHerdrEvent);
  herdr.on("connect", handleHerdrConnect);
  herdr.on("close", handleHerdrClose);
  herdr.on("error", handleHerdrError);
  // agent.start 응답 뒤 launcher가 receipt를 쓰므로 pane 이벤트의 150ms 재계산보다 늦을 수 있다.
  // 소켓별 lineage 디렉터리 metadata 변화를 보고 한 번 더 계산해 그 순서 경쟁을 닫는다.
  if (!lineageWatcher) lineageWatcher = watchAgentLineage(handleLineageChange);
  herdr.connect();
}
