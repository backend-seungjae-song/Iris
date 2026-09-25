// AI가 이 창에서 여는 브라우저 탭의 소유·조정과 서버 상태 반영.
//
// 소유 범위
//   분리 창을 요청한 AI 탭 집합과, 이 창이 띄워야 할 AI 탭 판정·조정 순서.
//
// 제공 API
//   initAiTabs, 서버 browser-state 적용점 applyBrowserState, AI target 갱신 뒤의 reconcileAiTabs.
//
// 의존 대상
//   브라우저 상태·AI 상태·프로필·webview·센터 탭은 각 소유 모듈에서 import 한다.
//   창 모드와 아직 main 에 남은 webview 생성·화면 reconcile·렌더·WC 보고는 init 에서 받는다.
//
// 유지 조건
//   browser-state 교체는 browser/state.js 의 replaceBrowserState 로만 한다.
//   공유 창과 도킹 상태에 따른 webview 단일 소유 판정, 접힌 스페이스 제외, AI 탭당 한 번인
//   분리 창 요청, applyBrowserState 안의 렌더·reconcile·보고 순서를 바꾸지 않는다.
//
// 영향 범위
//   browser/{state,ai-state,profiles,webview,webview-store,bookmarks}와 center/tab-store의 계약,
//   main 의 browser-state·ai-targets 수신 연결과 콘솔/분리창 렌더 경로.
//   이 모듈의 export나 init 계약을 바꾸면 import 하는 main.js도 함께 바뀌어야 한다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs web/js/browser/ai-tabs.js

import { renderBookmarks, renderUrlDatalist, syncBookmarkStar } from "./bookmarks.js";
import {
  ensureProfileData, migrateTabProfileRefs, profileIdForStored, promoteLocalProfiles,
  spaceDefaultProfile, updateProfileBtn,
} from "./profiles.js";
import {
  ensureBrowserStateCollections, getBrowserState, replaceBrowserState,
} from "./state.js";
import { getDiscardedWebview, getWebview } from "./webview-store.js";
import {
  authoritativeAiProtection, isLiveSpaceKey, scheduleWebviewThrottling,
  sleepDeadSpaceWebviews, wakeWebview,
} from "./webview.js";
import { addTab, ensureTabSpace, getTabs, getTabSpaces } from "../center/tab-store.js";
import { callHook } from "../core/hooks.js";

let BROWSER_MODE = false;
let BOUND_SPACE = null;
let createWebview, renderTabs, reconcileBrowserMode, reconcileDocTabs, reconcileConsoleDock;
let reportActiveBrowserWc;

const aiTabAsked = new Set(); // 분리 창을 띄워 달라고 이미 요청한 에이전트 탭

export function initAiTabs(deps) {
  ({
    BROWSER_MODE, BOUND_SPACE, createWebview, renderTabs, reconcileBrowserMode,
    reconcileDocTabs, reconcileConsoleDock, reportActiveBrowserWc,
  } = deps);
}

function aiTabsOwnedHere() {
  const docked = !!getBrowserState().docked;
  // 공유 브라우저 창(?space=__shared__)은 스페이스 브라우저가 아니다. 여기서도 띄우면 같은 탭이 두 창에
  // 생겨 wc가 둘이 되고, 스페이스 탭이 공유 창 안에 포함된다(확인 결과: Example Domain 중복 등록).
  if (BOUND_SPACE) return [];
  if (BROWSER_MODE ? docked : !docked) return []; // 이 창이 브라우저 webview의 소유자가 아님
  const m = getBrowserState().tabsBySpace || {}, out = [];
  // 살려둘 대상 = 최근 5분 안에 AI 가 실제로 쓴 탭(그리고 그 그룹). 점유 여부(held)로 판정하지
  // 않는다. 고정은 세션이 살아 있는 내내 남아서, 다시 쓰지 않는 탭까지 계속 띄우기 때문이다.
  // 보고 있지 않은 스페이스라도 띄우는 이유는 같다. 그 세션이 지금
  // 그 탭을 쓰고 있어 접근할 수 있어야 한다. 최근에 쓰지 않은 탭은 재우고, 다시 쓰려 하면 깨운다.
  const protectedIds = authoritativeAiProtection();
  for (const sp of Object.keys(m)) {
    // __shared__ 탭은 공유 창(BOUND_SPACE=__shared__)이 전용으로 띄운다. 여기서(콘솔/일반 창) 만들면
    // 같은 탭에 webview가 둘 생겨 wc가 겹친다(위 주석·5232). 지목·held로 공유 탭이 들어와도 생성은
    // 공유 창에 맡기고 건너뛴다. 보호는 그 탭 webview를 실제 가진 공유 창의 held 판정이 담당한다.
    if (sp === "__shared__") continue;
    // 접은 스페이스의 탭은 AI 표시가 남아 있어도 다시 만들지 않는다. 그 표시는 한 번 붙으면
    // 지워지지 않으므로, 스페이스가 사라진 뒤에도 계속 webview를 복원하는 경로가 된다(확인 결과).
    if (!isLiveSpaceKey(sp)) continue;
    for (const t of (m[sp] || [])) {
      // t.ai 로는 복원하지 않는다. 그 표시는 에이전트가 한 번 조작했다는 영구 기록이라 지워지지
      // 않는다. 그것을 "지금 살아 있어야 하는가"의
      // 판정으로 쓰면 과거에 한 번 쓰인 탭이 앱을 켤 때마다 전부 복원된다. 확인 결과:
      // 저장된 탭 84개 중 24개가 이 표시만으로 부팅마다 크로미움 프로세스를 하나씩 생성했다.
      // 판정은 authoritativeAiProtection 한 곳에만 둔다. 여기에 조건을 하나 더 얹으면 띄우는
      // 기준과 안 재우는 기준이 갈라져서, 만들자마자 재워지거나 재웠는데 다시 만들어진다.
      if (t && protectedIds && protectedIds.has(t.id)) out.push({ sp, t });
    }
  }
  return out;
}

// 서버가 탭을 깨워 달라고 알렸을 때, 이 창이 그 탭의 소유자인가. 스페이스 탭의 규칙은
// aiTabsOwnedHere 와 같아야 한다. 자격을 넓히면 같은 탭에 webview 가 둘 생기고 wc 가 겹친다(위 주석 참조).
// 공유 탭은 공유 창만 띄우므로 도킹 상태와 무관하게 공유 창이 깨운다. 여기서도 빼면 지목받은 공유 탭은
// 아무 창도 깨우지 않아 명령이 시간 초과로 끝난다.
export function wakeOwnedHere({ boundSpace, browserMode, docked, sp, liveSpace }) {
  if (sp === "__shared__") return boundSpace === "__shared__";
  if (boundSpace) return false;                        // 공유 창은 스페이스 탭의 소유자가 아니다
  if (browserMode ? docked : !docked) return false;    // 지금 webview 를 가진 창이 아니다
  return !!liveSpace;                                  // 접은 스페이스는 복원하지 않는다
}

// 잠든 탭 하나를 지금 만든다. 보고 있지 않은 스페이스라도 만든다. AI 가 그 탭에 명령을 보냈다는
// 뜻이고, 안 만들면 서버의 기다림이 시간을 다 쓰고 명령이 실패한다.
export function wakeTabHere(tabId) {
  if (!tabId) return false;
  const m = getBrowserState().tabsBySpace || {};
  for (const sp of Object.keys(m)) {
    const t = (m[sp] || []).find((x) => x && x.id === tabId);
    if (!t) continue;
    if (!wakeOwnedHere({
      boundSpace: BOUND_SPACE, browserMode: BROWSER_MODE,
      docked: !!getBrowserState().docked, sp, liveSpace: isLiveSpaceKey(sp),
    })) return false;
    if (getWebview(tabId)) return true;   // 이미 떠 있다. 서버의 대기는 wc 보고로 풀린다
    if (getDiscardedWebview(tabId)) wakeWebview(tabId);
    else {
      const wantProfile = t.profile == null ? spaceDefaultProfile(sp) : profileIdForStored(t.profile);
      createWebview(tabId, wantProfile, t.url && t.url !== "about:blank" ? t.url : undefined);
    }
    if (!BROWSER_MODE) {
      ensureTabSpace(sp);
      if (!getTabs(sp).find((x) => x.id === tabId)) {
        addTab(sp, { id: tabId, kind: "browser", label: t.title || "브라우저", path: null });
      }
      renderTabs();
    }
    return true;
  }
  return false;
}

export function reconcileAiTabs() {
  const owned = aiTabsOwnedHere();
  for (const { sp, t } of owned) {
    if (getWebview(t.id)) continue;
    const wantProfile = t.profile == null ? spaceDefaultProfile(sp) : profileIdForStored(t.profile);
    if (getDiscardedWebview(t.id)) wakeWebview(t.id);
    else createWebview(t.id, wantProfile, t.url && t.url !== "about:blank" ? t.url : undefined);
    if (!BROWSER_MODE) { // 콘솔 도킹: 센터 탭 목록에도 넣어 사용자가 그 스페이스로 가면 보이게
      ensureTabSpace(sp);
      if (!getTabs(sp).find((x) => x.id === t.id)) addTab(sp, { id: t.id, kind: "browser", label: t.title || (t.ai ? "에이전트" : "브라우저"), path: null });
    }
  }
  sleepDeadSpaceWebviews();   // 접은 스페이스의 탭은 기록만 남기고 내려놓는다
  scheduleWebviewThrottling();
  if (owned.length && !BROWSER_MODE) renderTabs();
  // 분리 상태인데 분리 창이 없으면 아무도 이 탭을 띄우지 못하므로, 콘솔이 창을 띄운다.
  // 앞으로 내지는 않는다(background). AI 가 탭을 만드는 경로라, 앞으로 내면 사용자가
  // 입력하던 키가 그 창으로 넘어가고 보던 화면이 덮인다. 창은 뒤에 있어도 된다.
  // 탭을 띄우는 데 필요한 것은 창의 존재이지 포커스가 아니다.
  // 브로드캐스트마다 부르지 않도록 탭 하나당 한 번만 요청하는 것은 그대로 둔다.
  if (!BROWSER_MODE && getBrowserState().docked === false) {
    const m = getBrowserState().tabsBySpace || {};
    let fresh = false;
    for (const sp of Object.keys(m)) for (const x of (m[sp] || [])) if (x && x.ai && !aiTabAsked.has(x.id)) { aiTabAsked.add(x.id); fresh = true; }
    if (fresh) { try { window.acHost && acHost.openBrowser && acHost.openBrowser({ background: true }); } catch (e) {} }
  }
}

export function applyBrowserState(st) {
  if (st) replaceBrowserState(st);
  ensureBrowserStateCollections();
  ensureProfileData();                 // 서버 목록을 렌더 캐시에 반영
  // 서버가 아직 한 번도 이관하지 않았을 때만 이 기기의 옛 localStorage를 올린다.
  if (!getBrowserState().profilesImported) promoteLocalProfiles();
  migrateTabProfileRefs(getBrowserState());
  renderBookmarks(); renderUrlDatalist(); syncBookmarkStar();
  updateProfileBtn();                  // 계정 목록이 늦게 와도 버튼 라벨이 따라온다
  callHook("accounts.stateChanged");  // 계정 화면의 "쓰는 스페이스" 칩이 서버의 기본 계정을 따라온다
  reconcileBrowserMode();                                     // 분리창: 탭/webview를 서버 상태에 동기화
  reconcileDocTabs();                                         // 분리창: docx/sheet 탭을 자체 에디터로 동기화
  if (typeof reconcileConsoleDock === "function") reconcileConsoleDock(); // 콘솔: 도킹 상태 반영(슬라이스 4)
  reconcileAiTabs();                                          // 에이전트 탭은 보고 있지 않아도 살려 둔다
  syncDockedTabLabels();                                       // 콘솔 도킹 브라우저 탭 라벨을 서버 name/title에 맞춤
  // 지금 화면에 그려지는 탭이 무엇인지 서버에 다시 알린다. 재접속 직후 한 번만 보내면 그 시점엔
  // 아직 이 상태(sbState)가 오지 않아 활성 탭을 몰라 건너뛴다. 서버는 그 뒤로 "보이는 탭 없음"으로
  // 남고, 캡처가 붙잡기를 써야 할지 판단할 근거를 잃는다. 상태가 올 때마다 보내면 그 공백이 사라진다.
  reportActiveBrowserWc();
  scheduleWebviewThrottling();
}

// 도킹된 브라우저 탭의 센터 라벨을 서버 상태(커스텀 name 우선, 없으면 title)에 동기화한다.
// 탭 이름 변경·페이지 제목 변경이 센터 탭바에도 반영되게 한다.
function syncDockedTabLabels() {
  if (BROWSER_MODE || !getBrowserState().docked) return;
  let changed = false;
  for (const sp of getTabSpaces()) {
    const state = getBrowserState();
    const stabs = (state.tabsBySpace && state.tabsBySpace[sp]) || [];
    for (const t of getTabs(sp)) {
      if (t.kind !== "browser") continue;
      const st = stabs.find((x) => x.id === t.id); if (!st) continue;
      const want = st.name || st.title || "브라우저";
      if (t.label !== want) { t.label = want; changed = true; }
    }
  }
  if (changed) renderTabs();
}
