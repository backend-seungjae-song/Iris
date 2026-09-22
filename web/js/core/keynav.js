// Iris 전역 키보드 내비게이션과 브라우저·메모·herdr 단축키를 한 순서로 등록한다.
//
// 소유 범위
//   document keydown 리스너 다섯 개와 에이전트·Space·herdr/브라우저 탭 순환 명령.
//
// 제공 API
//   initKeynav와 Monaco·네이티브 shortcut relay가 재사용하는 세 순환 command.
//
// 의존 대상
//   herdr·browser·center·panel·devtool 동작은 각 도메인 모듈에서 import한다. main 소유 모드·전송,
//   선택 scalar 접근자, 선택/Space 전환·브라우저 탭 생성 callback과 순서 컨테이너는 init에서 받는다.
//
// 유지 조건
//   ⌥⇧ 화살표 capture가 다섯 listener 중 가장 먼저 등록되는 순서, ⌥Tab·⌥숫자 capture가 그 다음,
//   나머지 세 listener의 bubble phase,
//   각 조합의 preventDefault·stopPropagation·포커스·모드 판정 순서를 보존한다.
//
// 영향 범위
//   main.js의 init 위치·Monaco bindAgentKeys·ac-shortcut relay·선택/Space 상태와,
//   herdr/{state,agents}, browser/{state,webview}, center/{tabs,tab-close,tab-store,text-editor},
//   panel/{terminal,touch-drag}, devtool/rail의 command 계약.
//   현재 목록 확인: node bin/importers.mjs web/js/core/keynav.js

import { bmActiveId, bmTabs, boundSpace, bsMutate } from "../browser/state.js";
import { activeWv } from "../browser/webview.js";
import { reopenLastClosed } from "../center/closed-tabs.js";
import { closeActiveTab, closeTabs } from "../center/tab-close.js";
import { getActiveTabId, getCenterSpace } from "../center/tab-store.js";
import { curTabs } from "../center/tabs.js";
import { openFilePalette } from "../center/file-palette.js";
import { findNext, openFind, shouldTakeFindKey } from "../browser/find-in-page.js";
import { bindingOf, matchBinding } from "./keymap.js";
import { saveActiveFile } from "../center/text-editor.js";
import { cycleRail } from "../devtool/rail.js";
import {
  getSwitcherState as currentSwitcherState, gotoMainScreen, gotoSpaceBrowser, runSwitcherKey,
} from "./screen-switch.js";
import { isAgentRenaming, revealAgentRow, startInlineRename } from "../herdr/agents.js";
import { nextRootAgentPane } from "../herdr/agent-tree.js";
import { agentByPane, agentsOfSpace, getTabsForSpace } from "../herdr/state.js";
import { callHook } from "./hooks.js";
import { mayWriteSharedActive } from "../browser/active-tab.js";
import { getTerminal } from "../panel/terminal.js";
import { toggleDevTools } from "../panel/touch-drag.js";

let wsSend, BROWSER_MODE, MEMO_MODE, acHost;
let orderedSpaces, selectSession, focusSpace, newBrowserTab;
let getCurTarget, getSelectedSpaceId, getIsLocal;
let lastTabBySpace;
let getSwitcherState;

const urlInputEl = () => document.getElementById("url");

const IRIS_ARROWS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];

export function initKeynav(deps) {
  ({
    wsSend, BROWSER_MODE, MEMO_MODE, acHost,
    orderedSpaces, selectSession, focusSpace, newBrowserTab,
    getCurTarget, getSelectedSpaceId, getIsLocal,
    lastTabBySpace,
  } = deps);
  getSwitcherState = typeof deps.getSwitcherState === "function" ? deps.getSwitcherState : currentSwitcherState;

  // ⌥⇧+화살표는 캡처 단계에서 먼저 처리한다. 편집기(Monaco)가 같은 조합을 줄 복사·선택 확장에 쓰면서
  // 전파를 끊으면 편집기에 포커스가 있을 때 스페이스·탭 전환이 동작하지 않는다. 콘솔 전역 이동이라
  // 포커스 위치와 무관하게 먼저 받아야 하므로 버블이 아니라 캡처다.
  document.addEventListener("keydown", (e) => {
    if (MEMO_MODE) return;
    if (isAgentRenaming()) return;
    if (!e.altKey || !e.shiftKey || e.metaKey || e.ctrlKey) return;
    const a = String(e.key || "");
    if (IRIS_ARROWS.indexOf(a) < 0) return;
    // 어떤 조합이 걸려 있는지는 키맵 표가 정한다. 화면에 표시된 것과 실제 동작하는 것이 같아야
    // 하므로 여기서 조합을 다시 적지 않고 표를 조회한다.
    const hit = ["space-prev", "space-next", "tab-prev", "tab-next"].find((id) => matchBinding(e, bindingOf(id)));
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();   // 편집기에 전달되기 전에 끊는다
    if (hit === "space-prev") cycleSpace(-1);
    else if (hit === "space-next") cycleSpace(1);
    else cycleCenterTab(hit === "tab-next" ? 1 : -1);
  }, true);
  // ⌥Tab/⌥⇧Tab = 다음/이전 창, ⌥1 = 메인 화면, ⌥2 = 스페이스 브라우저.
  // 숫자는 e.key 로 판정할 수 없다. macOS 에서 ⌥1 은 "¡", ⌥2 는 "™" 라 키 위치(e.code)로만 알 수 있다.
  // 캡처인 이유는 위와 같다. 창 사이 전역 이동이라 편집기·터미널·시트가 먼저 처리하면 안 된다.
  // 이동할 곳이 없을 때(분리 상태의 메인 창에서 ⌥1)도 키는 소비한다. 그러지 않으면 입력칸에
  // "¡" 가 들어간다.
  document.addEventListener("keydown", (e) => {
    if (MEMO_MODE) return;
    if (isAgentRenaming()) return;
    if (!e.altKey || e.metaKey || e.ctrlKey) return;
    const hit = ["screen-main", "screen-browser", "screen-toggle", "screen-toggle-back"]
      .find((id) => matchBinding(e, bindingOf(id)));
    if (!hit) return;
    if (hit === "screen-main" || hit === "screen-browser") {
      e.preventDefault();
      e.stopPropagation();
      if (hit === "screen-main") gotoMainScreen();
      else gotoSpaceBrowser();
      return;
    }
    const dir = hit === "screen-toggle-back" ? -1 : 1;
    const plan = runSwitcherKey(dir, getSwitcherState());
    if (plan !== "legacy" && plan !== "step") return;
    e.preventDefault();
    e.stopPropagation();
  }, true);
  // F12 = 브라우저 탭 개발자 도구. 앱 UI에 포커스가 있을 때는 여기서, webview에 있을 때는
  // main이 가로채 ac-shortcut("devtools")로 넘긴다. 포커스 위치로 상호배타라 이중 처리되지 않는다.
  document.addEventListener("keydown", (e) => {
    if (MEMO_MODE) return;
    if (!matchBinding(e, bindingOf("devtools"))) return;
    e.preventDefault();
    toggleDevTools();
  });
  // ⌥ 단독·⌘⌥ 조합. ⌥⇧는 위 캡처가 이미 가져갔으므로 여기까지 오지 않는다.
  document.addEventListener("keydown", (e) => {
    if (MEMO_MODE) return;
    if (isAgentRenaming()) return;
    if (!e.altKey) return;
    // Cmd 와 Ctrl 을 맞바꾼 키보드 배치가 있어 표의 mod 가 둘을 한 필드로 다룬다.
    const hit = ["rail-prev", "rail-next", "agent-prev", "agent-next", "tab-prev", "tab-next"]
      .find((id) => matchBinding(e, bindingOf(id)));
    if (!hit) return;
    e.preventDefault();
    if (hit === "rail-prev") cycleRail(-1);
    else if (hit === "rail-next") cycleRail(1);
    else if (hit === "agent-prev") cycleAgent(-1);
    else if (hit === "agent-next") cycleAgent(1);
    else cycleCenterTab(hit === "tab-next" ? 1 : -1);
  });
  // herdr 탭 단축키: 생성 = ctrl+t / ⌥⇧t (new_tab), 이름변경 = ctrl+shift+r (rename_tab).
  // ctrl+shift+r는 브라우저 하드리로드라 preventDefault로 가로채 인라인 리네임으로 돌린다.
  document.addEventListener("keydown", (e) => {
    const k = (e.key || "").toLowerCase();
    if (MEMO_MODE) {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && k === "s") { e.preventDefault(); callHook("memo.archiveWindow"); }
      return;
    }
    // ⌘⇧P = 파일 검색 팔레트(호스트 포커스). webview 포커스 시엔 main이 ac-shortcut로 forwarding.
    if (matchBinding(e, bindingOf("file-search"))) { e.preventDefault(); openFilePalette(); return; }
    // ⌘F = 페이지에서 찾기. 브라우저 탭이 활성일 때만 가져간다. 파일·메모 편집기(Monaco)는 자체
    // 찾기가 있고 터미널의 ⌃F 는 커서 이동이라, 그곳에서 가로채면 기존 동작을 잃는다.
    {
      const t = curTabs().find((x) => x.id === getActiveTabId(getCenterSpace()));
      const take = shouldTakeFindKey({
        // 어느 조합인지는 키맵 표가, 지금 가져가도 되는 상황인지는 find-in-page 가 판정한다.
        bound: matchBinding(e, bindingOf("find-in-page")),
        inTerminal: !!(e.target && e.target.closest && e.target.closest("#terminal")),
        browserWindow: BROWSER_MODE, browserTabActive: !!(t && t.kind === "browser"),
      });
      if (take && openFind()) { e.preventDefault(); return; }
    }
    // 브라우저 탭이 활성일 때의 나머지 기본 단축키. 호스트(주소창·탭바)에 포커스가 있을 때
    // 여기서 받고, 페이지에 있을 때는 main 이 가로채 ac-shortcut 으로 같은 경로로 보낸다.
    // ⌘←→ 는 받지 않는다. 페이지·주소창 입력 중에는 줄 끝 이동이기 때문이다.
    if ((e.metaKey || e.ctrlKey) && !e.altKey) {
      const t2 = curTabs().find((x) => x.id === getActiveTabId(getCenterSpace()));
      const onBrowser = BROWSER_MODE || !!(t2 && t2.kind === "browser");
      const r = onBrowser ? activeWv() : null;
      if (onBrowser && matchBinding(e, bindingOf("find-next"))) { e.preventDefault(); findNext(true); return; }
      if (onBrowser && matchBinding(e, bindingOf("find-prev"))) { e.preventDefault(); findNext(false); return; }
      if (onBrowser && matchBinding(e, bindingOf("focus-url"))) { e.preventDefault(); try { urlInputEl().focus(); urlInputEl().select(); } catch {} return; }
      if (r && matchBinding(e, bindingOf("nav-back"))) { e.preventDefault(); try { if (r.el.canGoBack()) r.el.goBack(); } catch {} return; }
      if (r && matchBinding(e, bindingOf("nav-forward"))) { e.preventDefault(); try { if (r.el.canGoForward()) r.el.goForward(); } catch {} return; }
      if (r && matchBinding(e, bindingOf("print-page"))) { e.preventDefault(); try { r.el.print(); } catch {} return; }
    }
    // ⌘⇧S = 이 스페이스 메모를 오늘 자로 보관. Cmd 와 Ctrl 을 맞바꾼 키보드 배치가 있어 둘 다 받는다.
    if (matchBinding(e, bindingOf("memo-archive"))) { e.preventDefault(); callHook("memo.archive"); return; }
    // cmd +/-/0 = 브라우저(webview) 확대/축소/원복. 호스트 포커스 시 여기서, webview 포커스 시엔 메인이 처리.
    if ((e.metaKey || e.ctrlKey) && (e.key === "=" || e.key === "+" || e.key === "-" || e.key === "_" || e.key === "0")) {
      const t = curTabs().find((x) => x.id === getActiveTabId(getCenterSpace()));
      const r = typeof activeWv === "function" ? activeWv() : null;
      if (t && t.kind === "browser" && r) {
        e.preventDefault();
        try {
          const z = r.el.getZoomLevel ? r.el.getZoomLevel() : 0;
          if (e.key === "0") r.el.setZoomLevel(0);
          else if (e.key === "-" || e.key === "_") r.el.setZoomLevel(z - 0.5);
          else r.el.setZoomLevel(z + 0.5);
        } catch {}
        return;
      }
    }
    // cmd+w / ctrl+w = 현재 가운데 탭(파일/브라우저) 닫기
    // 탭 닫기: cmd+w=선택한 herdr pane 삭제(메인 창), ctrl+w=브라우저·센터 탭.
    if (e.metaKey && !e.ctrlKey && !e.altKey && k === "w" && !BROWSER_MODE) { e.preventDefault(); if (!e.repeat) closeCurrentHerdrPane(); return; }
    // ctrl+w=브라우저·센터 탭 닫기. 터미널 포커스 시엔 ctrl+w=셸 단어삭제라 양보.
    if (e.ctrlKey && !e.metaKey && k === "w" && !(getTerminal() && getTerminal().contains(document.activeElement))) { e.preventDefault(); const space = getCenterSpace(); const t = curTabs().find((tab) => tab.id === getActiveTabId(space)); if (BROWSER_MODE) closeActiveTab(); else if (t) closeTabs([{ space, tabId: t.id, tabRef: t }]); return; }
    // ⌘⇧E 요소선택과 ⌘⇧D 분리는 아래 capture 단계 핸들러가 전담하며, 포커스 위치와 무관하게 동작한다.
    // cmd+s / ctrl+s = 파일 저장 (편집 중인 파일)
    if ((e.metaKey || e.ctrlKey) && k === "s") { e.preventDefault(); saveActiveFile(); return; }
    // 브라우저 리로드: ⌘R 리로드 · ⌘⇧R 강제 리로드. 분리 브라우저 창(BROWSER_MODE), 또는 메인 창에서
    // 브라우저 탭이 활성(도킹)이고 키 포커스가 터미널에 있지 않을 때 적용. 터미널 포커스(에이전트 작업)
    // 시엔 아래 이름변경으로 양보한다. activeWv()는 활성 센터 탭만 보므로 실제 포커스로 다시 판정한다.
    const termFocused = !BROWSER_MODE && !!(getTerminal() && getTerminal().contains(document.activeElement));
    // 창 기준 분기: 브라우저 창은 ⌘R 리로드 / ⌘⇧R 강제 리로드.
    // 메인 창은 ⌘⇧R이 앱 강제 재로딩이므로 여기서 잡지 않고 아래로 흘린다. 메인 창의 ⌘R만
    // 도킹된 브라우저 탭이 활성이고 터미널 포커스가 아닐 때 페이지 리로드로 쓴다.
    const wantPageReload = BROWSER_MODE || (!e.shiftKey && !termFocused && activeWv());
    if (e.metaKey && !e.altKey && !e.ctrlKey && k === "r" && wantPageReload) {
      e.preventDefault(); const r = activeWv();
      try { if (r) { e.shiftKey ? r.el.reloadIgnoringCache() : r.el.reload(); } } catch {}
      return;
    }
    // 메인 창 ⌘⇧R = 앱 강제 재로딩. 브라우저 창·webview 활성일 땐 위에서 이미 페이지 강제 리로드로 처리됐다.
    // 이름변경보다 먼저 판정해야 한다. 아래 이름변경 조건이 shift를 배제하지 않으면 ⌘⇧R을 삼킨다.
    if (!BROWSER_MODE && e.metaKey && e.shiftKey && !e.altKey && !e.ctrlKey && k === "r") {
      e.preventDefault();
      try { window.acHost && acHost.appReload ? acHost.appReload() : location.reload(); } catch { location.reload(); }
      return;
    }
    if (isAgentRenaming()) return;
    // 이름변경(메인 창): ctrl+shift+r(herdr) 또는 cmd+r. ⌘⇧R(앱 재로딩)·cmd+⌥R·cmd+⌃R은 배제.
    if ((e.ctrlKey && e.shiftKey && k === "r" && !e.metaKey) || (e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && k === "r")) { e.preventDefault(); startInlineRename(); return; }
    // ⌘⇧T = 방금 닫은 탭 복원. 아래 탭 생성보다 먼저 판정한다. 생성 조건이 shift 를 배제하지만,
    // 순서로도 고정해 두어야 나중에 그 조건이 느슨해질 때 조용히 삼켜지지 않는다.
    if (matchBinding(e, bindingOf("reopen-tab"))) { e.preventDefault(); reopenLastClosed(); return; }
    // 탭 생성: cmd+t(맥 표준) · ctrl+t · ⌥⇧t 모두 새 herdr 터미널 탭을 만든다.
    const create = matchBinding(e, bindingOf("new-tab")) || matchBinding(e, bindingOf("new-tab-alt"));
    if (create) { e.preventDefault(); BROWSER_MODE ? newBrowserTab() : newHerdrTab(); } // 분리 브라우저 창에선 브라우저 탭 생성
  });
}

function flatAgents() { return orderedSpaces().flatMap((s) => agentsOfSpace(s.id)); }

export function cycleAgent(dir) {
  const target = nextRootAgentPane(flatAgents(), getCurTarget(), dir);
  if (!target) return;
  selectSession(target);
  revealAgentRow(target);
}

export function cycleSpace(dir) {
  const list = orderedSpaces(); if (!list.length) return;
  const selectedSpaceId = getSelectedSpaceId();
  let i = list.findIndex((s) => s.id === selectedSpaceId); i = ((i < 0 ? -dir : i) + dir) % list.length; if (i < 0) i += list.length;
  focusSpace(list[i].id);
}

// ⌥←/→ = 현재 스페이스의 herdr 터미널 탭 사이 단순 이동. 에이전트 전역 순환(⌥↑↓)과 달리 스페이스를
// 넘지 않고 같은 스페이스의 탭들만 좌우로 넘긴다. 분리 브라우저 창엔 herdr 탭이 없어 브라우저 탭을 넘긴다.
export function cycleCenterTab(dir) {
  if (BROWSER_MODE) { // 분리 브라우저 창: 서버 상태 브라우저 탭 순환
    // 한 탭에 묶인 창에는 이동할 탭이 없다. 여기서 이동하면 공유 활성 탭이 바뀌어 원래 창까지 전환된다.
    if (!mayWriteSharedActive(callHook("detach.boundTab"))) return;
    const arr = bmTabs(); if (arr.length < 2) return;
    let i = arr.findIndex((t) => t.id === bmActiveId()); if (i < 0) i = 0;
    i = (i + dir + arr.length) % arr.length;
    bsMutate({ op: "tab.switch", space: boundSpace(), id: arr[i].id });
    return;
  }
  const curTarget = getCurTarget(), selectedSpaceId = getSelectedSpaceId();
  const sp = (agentByPane(curTarget) && agentByPane(curTarget).workspaceId) || selectedSpaceId;
  if (!sp) return;
  // 서버가 push한 전체 탭 목록(세션 없는 탭 포함). agentsOfSpace(에이전트만)와 달리 빈 탭도 포함.
  // 순서는 herdr tab.list가 준 그대로 쓴다. 그것이 화면에 보이는 순서다. number로 다시 정렬하면
  // 안 된다. number는 탭이 만들어질 때 붙는 라벨이라 드래그로 옮겨도 따라오지 않고(순서 이동은
  // tabMove의 insertIndex로 이뤄진다), 그 결과 herdr 뷰·사이드바의 순서와 ⌥←→ 의 이동 순서가
  // 달라진다.
  const arr = getTabsForSpace(sp);
  if (arr.length < 2) return;
  // 현재 탭 = 서버 focused 플래그 우선(권위), 없으면 현재 에이전트의 tabId. 세션 없는 탭 포커스 후엔
  // curTarget이 옛 에이전트에 남아 있으므로 focused 플래그가 정확하다.
  const curTabId = (arr.find((t) => t.focused) || {}).tabId || (agentByPane(curTarget) && agentByPane(curTarget).tabId);
  let i = arr.findIndex((t) => t.tabId === curTabId); if (i < 0) i = 0;
  i = (i + dir + arr.length) % arr.length;
  lastTabBySpace[sp] = arr[i].tabId;
  wsSend({ type: "tab-focus", tabId: arr[i].tabId }); // 세션 유무 무관 tab_id로 herdr 탭 포커스 → attach 화면 전환, 그 탭에 입력 가능
}

// 새 herdr 터미널 탭을 현재 스페이스(없으면 선택된 에이전트의 스페이스)에 만든다. 원격에서는 만들 수 없다.
export function newHerdrTab() {
  if (!getIsLocal()) return;
  const curTarget = getCurTarget(), selectedSpaceId = getSelectedSpaceId();
  const wsid = selectedSpaceId || agentByPane(curTarget)?.workspaceId;
  if (wsid) wsSend({ type: "tab.create", workspaceId: wsid });
}

// Cmd+W는 선택한 세션 하나만 닫는다. 부모·자식이 같은 탭에 있어도 탭 전체를 닫지 않는다.
function closeCurrentHerdrPane() {
  if (!getIsLocal() || BROWSER_MODE) return;
  const target = getCurTarget();
  const selected = agentByPane(target);
  if (target && !selected) return; // 사라진 자식 선택을 부모 닫기로 바꾸지 않는다.
  const agent = selected || agentsOfSpace(getSelectedSpaceId()).find((a) => a.focused);
  if (agent) {
    if (agent.paneId && agent.terminalId) wsSend({ type: "pane-close", paneId: agent.paneId, terminalId: agent.terminalId });
    return;
  }
  // 에이전트가 없는 단일-pane 탭의 기존 닫기는 유지한다. 서버도 live pane 수를 다시 확인한다.
  const tab = getTabsForSpace(getSelectedSpaceId()).find((t) => t.focused);
  if (tab?.paneCount === 1) wsSend({ type: "tab-close", tabId: tab.tabId });
}
