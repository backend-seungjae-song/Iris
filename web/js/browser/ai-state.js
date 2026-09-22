// AI 세션이 어느 브라우저 탭을 점유하고 있는지, 서버가 내려주는 그 사실을 한 곳에서 소유한다.
//
// 소유 범위
//   세션별 target 목록과 그것을 한 번이라도 정상 수신했는가, 탭 정체성 → 서버가 매긴 핸들,
//   지금 조작 중인 탭 → 세션 라벨 목록.
//
// 제공 API
//   다섯 상태의 query 와 서버 메시지를 그대로 받는 command, 그리고 탭 하나에 대한 두 판정
//   (지금 조작 중인가, 어느 세션이 조작 중인가). 최근 AI 사용은 만료 시각으로 들고 있다가
//   물어보는 시점에 식혀서 집합으로 준다(aiRecentTabIds).
//
// 의존 대상
//   외부 모듈이나 DOM 에 기대지 않는다. 값은 전부 서버 메시지가 준 그대로 보관한다.
//
// 유지 조건
//   `known` 은 목록이 실제로 배열로 왔을 때만 참이다. 연결이 끊기면 목록을 비우지 말고
//   known 만 거짓으로 돌린다. LRU·스로틀이 그 값을 fail-safe 로 읽으므로, 비워 버리면
//   점유 중인 탭이 보호 대상에서 빠져 재워진다.
//   busy 판정은 탭 단위다. 창 전체로 판정하면 다른 스페이스에서 명령 하나만 흘러도
//   모든 탭이 함께 막힌다.
//
// 영향 범위
//   외부 상태도 DOM 도 건드리지 않는다.
//   대신 이 API 를 바꾸면 import 하는 파일도 함께 바꿔야 한다:
//   main.js · browser/{webview,pick,tabs,ai-tabs}.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs web/js/browser/ai-state.js

// 어느 세션이 지금 이 탭을 점유하는지. 서버가 세션마다 하나씩 보내준다(ai-targets).
let aiTargets = []; // [{pane, label, space, group, tabId, held}]
let aiTargetsKnown = false; // MCP authoritative 상태가 한 번이라도 정상 수신됐는가
// 서버가 매긴 (탭 정체성 → 핸들). 창이 이름을 지어내면 터미널에 부를 수 없는 이름이 남으므로,
// 요소 지목 같은 문구는 이 표에서 이름을 가져온다.
let tabHandles = {};
// 지금 조작 중인 탭. 서버가 탭별·세션별로 내려준다(control-active). 점유 중인 탭과 다르다:
// 고정은 오래 남지만 조작은 끝나므로, 고정 기준으로 강조하면 조작이 끝나도 꺼지지 않는다.
// 유효기간은 서버가 넉넉히 두어(20s) 생각하는 사이에 꺼져 반짝이지 않게 한다.
let aiBusyTabs = new Map(); // tabId → [세션 라벨…]

export function getAiTargets() { return aiTargets; }
export function getAiTargetsKnown() { return aiTargetsKnown; }

// 서버의 ai-targets 를 그대로 받는다. 배열이 아니면 모르는 것으로 친다.
export function setAiTargets(targets) {
  aiTargetsKnown = Array.isArray(targets);
  aiTargets = aiTargetsKnown ? targets : [];
}

// 연결이 끊겼을 때. 목록은 그대로 두고 known 만 내린다(위 계약 참조).
export function markAiTargetsUnknown() { aiTargetsKnown = false; }

export function getTabHandles() { return tabHandles; }
export function setTabHandles(map) {
  tabHandles = (map && typeof map === "object") ? map : {};
}

// 최근 5분 안에 AI 가 실제로 명령을 보낸 탭. 점유 중인 탭과 다르다. 고정은 세션이 살아 있는 내내
// 남지만 그 탭을 다시 안 쓸 수도 있고, 그걸 살아 있어야 하는가의 기준으로 쓰면 옛날에 쓴 탭이
// 계속 프로세스를 점유한다. 서버가 만료 시각을 실어 주므로 창이 스스로
// 만료를 판정한다. 만료 알림을 기다리면 알림 하나가 끊긴 창은 영영 만료되지 않는다.
let aiRecentUntil = new Map();  // tabId → 만료 시각
let aiRecentKnown = false;      // 한 번이라도 받았는가. 못 받았으면 재우기 판정을 미룬다.

export function setAiRecentUse(list) {
  aiRecentKnown = Array.isArray(list);
  aiRecentUntil = new Map(!aiRecentKnown ? [] : list
    .filter((x) => x && x.tabId != null)
    .map((x) => [String(x.tabId), Number(x.until) || 0]));
}
export function getAiRecentKnown() { return aiRecentKnown; }
export function markAiRecentUnknown() { aiRecentKnown = false; }
export function aiRecentTabIds(now) {
  const t = now || Date.now();
  const out = new Set();
  for (const [tabId, until] of aiRecentUntil) if (until > t) out.add(tabId);
  return out;
}

export function getAiBusyTabs() { return aiBusyTabs; }
export function setAiBusyTabs(map) { aiBusyTabs = map; }

export function aiHolds(tabId) { return !!tabId && aiBusyTabs.has(tabId); }
export function aiBusyLabels(tabId) { return aiBusyTabs.get(tabId) || []; }
