// herdr가 방송한 에이전트·스페이스·터미널 탭 snapshot을 한 곳에서 소유한다.
//
// 소유 범위
//   서버 state 방송으로 통째 교체되는 agent·workspace 배열과 workspace별 전체 탭 객체.
//
// 제공 API
//   snapshot 교체 command, 현재 agent·workspace·탭 query와 pane/space별 파생 query,
//   agent key·표시 이름 query. 원시 상태 바인딩은 내주지 않는다.
//
// 의존 대상
//   DOM이나 main에 기대지 않는다. 서버가 보낸 배열·객체 identity와 순서를 그대로 보존한다.
//
// 유지 조건
//   agents는 state마다 빈 배열로도 교체하고, workspaces·tabs는 필드가 있을 때만 교체한다.
//   Agents 순서는 tabs의 받은 순서를 우선하고, 같은 위치는 기존 tabId 비교로만 가른다.
//
// 영향 범위
//   main의 WebSocket state 수신·Space 순서·키보드 내비·rail 초기화, herdr/{agents,sync},
//   explorer/context-menu, center/{file-routing,file-palette,tabs}, panel/{memo-store,xterm-wiring},
//   browser/webview, devtool/source-control의 현재 herdr snapshot 조회 계약.
//   현재 목록 확인: node bin/importers.mjs web/js/herdr/state.js

let lastAgents = [];
let spaces = [];
let tabsByWorkspace = {};

export function replaceHerdrState(message) {
  lastAgents = message.agents || [];
  if (message.workspaces) spaces = message.workspaces;
  if (message.tabs) tabsByWorkspace = message.tabs;
}

export function getLastAgents() { return lastAgents; }
export function getSpaces() { return spaces; }
export function getTabsForSpace(id) { return tabsByWorkspace[id] || []; }
export function agentKey(a) { return a.paneId || a.agent; }
export function nameOf(a) { return a.tabLabel || (a.cwd ? a.cwd.split("/").pop() : a.agent); }
export function agentByPane(paneId) { return lastAgents.find((a) => a.paneId === paneId); }
export function agentsOfSpace(id) {
  // herdr가 들고 있는 실제 탭 순서를 따른다. tabId 문자열로 정렬하면 id는 탭을 옮겨도
  // 바뀌지 않아 순서를 바꿔도 화면이 원래 순서로 돌아온다(드래그 모션만 보이고 이동되지 않음).
  // status로는 재정렬하지 않는다. 작업 중이라고 목록 순서가 바뀌면 누르려던 항목이 이동한다.
  const order = new Map(getTabsForSpace(id).map((t, i) => [t.tabId, i]));
  const pos = (a) => (order.has(a.tabId) ? order.get(a.tabId) : Number.MAX_SAFE_INTEGER);
  return lastAgents.filter((a) => a.workspaceId === id && a.paneId)
    .sort((a, b) => pos(a) - pos(b) || (a.tabId || "").localeCompare(b.tabId || ""));
}
