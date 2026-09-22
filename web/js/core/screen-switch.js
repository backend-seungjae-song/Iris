// 메인 화면과 스페이스 브라우저 사이를 오가는 명령을 소유한다.
//
// 소유 범위
//   무엇을 할지의 판정(planScreen)과 그 실행. 도킹일 때 브라우저로 넘어가며 보던
//   비-브라우저 탭의 기록.
//
// 제공 API
//   initScreenSwitch(deps), 세 명령(gotoMainScreen·gotoSpaceBrowser·toggleMainBrowser),
//   창 순환 명령(runSwitcherKey), 그리고 순수 판정(planScreen·onSpaceBrowserIn·planSwitcherKey).
//   화면 전환 명령은 실제로 이동했는지를 boolean 으로 반환한다.
//
// 의존 대상
//   browser/state 의 서버 공유 상태, center/{file-routing,tab-store,tabs} 의 센터 탭 명령,
//   그리고 창 종류(BROWSER_MODE·BOUND_SPACE·MEMO_MODE)와 acHost 는 init 에서 받는다.
//
// 유지 조건
//   판정은 순수 함수 하나에 모아 두고 실행부에 조건을 다시 넣지 않는다. 검사가 확인할 수 있는
//   지점이 그곳뿐이라, 흩어지면 표에 적힌 열여덟 갈래가 검사 범위 밖으로 나간다.
//   분리창이 기본이라 브라우저로 가는 경로는 창 포커스이고, 도킹일 때만 센터 탭 전환이다.
//   도킹 전환은 탭바 클릭과 같은 순서를 쓴다(setActiveTab → renderTabs → showActiveTab →
//   persistFileTabs, 브라우저 탭이면 tab.switch).
//   공유 브라우저 창은 스페이스 브라우저가 아니다. 거기서 ⌥2 는 스페이스 브라우저 창을 연다.
//
// 영향 범위
//   공급자는 main.js 의 init(창 종류·acHost)이고, 양방향 소비자는 core/keynav 의 키 등록과
//   browser/dock 의 ac-shortcut 표다. webview 포커스에서 온 같은 키가 그 표로 들어온다.
//   현재 목록 확인: node bin/importers.mjs web/js/core/screen-switch.js

import { bmActiveId, bsMutate, getBrowserState } from "../browser/state.js";
import { consoleSpace, openBrowser } from "../center/file-routing.js";
import { getActiveTabId, getCenterSpace, getTabs, setActiveTab } from "../center/tab-store.js";
import { persistFileTabs, renderTabs, showActiveTab } from "../center/tabs.js";

const SHARED_SPACE = "__shared__";

let BROWSER_MODE, BOUND_SPACE, MEMO_MODE, acHost;
let switcherState = { pickedMode: false, registered: {} };

// 도킹일 때 브라우저로 넘어가며 보던 탭. 돌아올 위치가 없으면 전환이 한 방향으로만 동작한다.
const lastMainTab = new Map();

export function initScreenSwitch(deps) {
  ({ BROWSER_MODE, BOUND_SPACE, MEMO_MODE, acHost } = deps);
  try { acHost?.onSwitcherState?.(rememberSwitcherState); } catch {}
  try {
    Promise.resolve(acHost?.windowSwitcher?.({ op: "status" }))
      .then(rememberSwitcherState, () => {});
  } catch {}
}

// ── 판정 (순수) ───────────────────────────────────────────────────────────────
// ctx: { browserMode, sharedWindow, memoMode, docked, activeKind }

// 지금 스페이스 브라우저를 보고 있는가. 분리창이면 그 창 자체가 답이고, 도킹이면 센터가 답이다.
export function onSpaceBrowserIn(ctx) {
  const { browserMode = false, sharedWindow = false, docked = false, activeKind = null } = ctx || {};
  if (browserMode) return !sharedWindow;
  return docked && activeKind === "browser";
}

export function planScreen(target, ctx) {
  const c = ctx || {};
  if (c.memoMode) return "none";                       // 메모 창은 이 이동의 대상이 아니다
  if (target === "toggle") return planScreen(onSpaceBrowserIn(c) ? "main" : "browser", c);
  if (target === "browser") {
    // 이미 스페이스 브라우저 창이면 이동할 곳이 없다. 공유 브라우저 창은 별도 창이라 새로 연다.
    if (c.browserMode) return c.sharedWindow ? "openBrowser" : "none";
    return c.docked ? "centerBrowser" : "openBrowser";
  }
  if (target === "main") {
    if (c.browserMode) return "focusConsole";
    if (!c.docked) return "none";                      // 이 창이 이미 메인 화면이다
    return c.activeKind === "browser" ? "centerMain" : "none";
  }
  return "none";
}

export function planSwitcherKey({ pickedMode = false, registered = {}, dir = 1 } = {}) {
  if (!pickedMode) return dir === 1 ? "legacy" : "none";
  const direction = dir === -1 ? "prev" : "next";
  return registered && registered[direction] ? "global" : "step";
}

// ── 실행 ─────────────────────────────────────────────────────────────────────

const sharedWindow = () => BROWSER_MODE && BOUND_SPACE === SHARED_SPACE;

function activeCenterTab() {
  const sp = getCenterSpace();
  return (getTabs(sp) || []).find((t) => t.id === getActiveTabId(sp)) || null;
}

function ctxNow() {
  return {
    browserMode: !!BROWSER_MODE, sharedWindow: sharedWindow(), memoMode: !!MEMO_MODE,
    docked: !!getBrowserState().docked, activeKind: (activeCenterTab() || {}).kind || null,
  };
}

// 탭바 클릭과 같은 순서다. 브라우저 탭으로 갈 때만 서버에 알린다. 비-브라우저 탭 전환은
// 클릭 경로도 로컬로만 처리한다(center/tab-close.js 의 tabstrip click).
function activateCenter(sp, tab) {
  setActiveTab(sp, tab ? tab.id : null);
  renderTabs(); showActiveTab(); persistFileTabs();
  if (tab && tab.kind === "browser") bsMutate({ op: "tab.switch", space: sp, id: tab.id });
}

function centerToBrowser() {
  const sp = getCenterSpace() || consoleSpace();
  const tabs = getTabs(sp) || [];
  const want = tabs.find((t) => t.kind === "browser" && t.id === bmActiveId())
    || tabs.find((t) => t.kind === "browser");
  if (!want) { openBrowser(); return true; }           // 브라우저 탭이 없으면 🌐 와 같은 경로로 만든다
  const cur = activeCenterTab();
  if (cur && cur.kind !== "browser") lastMainTab.set(sp, cur.id);
  if (cur && cur.id === want.id) return true;
  activateCenter(sp, want);
  return true;
}

function centerToMain() {
  const sp = getCenterSpace() || consoleSpace();
  const tabs = getTabs(sp) || [];
  const remembered = lastMainTab.get(sp);
  // 기억한 자리가 닫혔으면 남은 비-브라우저 탭 중 가장 오른쪽, 그것도 없으면 빈 센터.
  const want = tabs.find((t) => t.kind !== "browser" && t.id === remembered)
    || [...tabs].reverse().find((t) => t.kind !== "browser")
    || null;
  activateCenter(sp, want);
  return true;
}

function runPlan(plan) {
  if (plan === "focusConsole") { try { acHost?.refocusConsole?.(); } catch {} return true; }
  if (plan === "openBrowser") {
    // 공유 브라우저 창에서는 활성 스페이스를 건드리지 않고 창만 부른다.
    if (BROWSER_MODE) { try { acHost?.openBrowser?.(); } catch {} return true; }
    openBrowser();
    return true;
  }
  if (plan === "centerBrowser") return centerToBrowser();
  if (plan === "centerMain") return centerToMain();
  return false;
}

function rememberSwitcherState(value) {
  const state = value && value.status ? value.status : value;
  if (!state || typeof state !== "object") return;
  switcherState = {
    pickedMode: !!state.pickedMode,
    registered: state.registered && typeof state.registered === "object" ? { ...state.registered } : {},
  };
}

export function getSwitcherState() {
  return { pickedMode: switcherState.pickedMode, registered: { ...switcherState.registered } };
}

export function runSwitcherKey(dir, state = getSwitcherState()) {
  const plan = planSwitcherKey({ ...(state || {}), dir });
  if (plan === "legacy") toggleMainBrowser();
  else if (plan === "step") {
    try { void acHost?.windowSwitcher?.({ op: "step", dir }); } catch {}
  }
  return plan;
}

export function gotoMainScreen() { return runPlan(planScreen("main", ctxNow())); }
export function gotoSpaceBrowser() { return runPlan(planScreen("browser", ctxNow())); }
export function toggleMainBrowser() { return runPlan(planScreen("toggle", ctxNow())); }
