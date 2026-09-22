// 설정 화면: 단축키를 바꾸고 rail 도구와 ⌥Tab 창을 고른다.
//
// 소유 범위
//   이 화면의 DOM 렌더와 키 녹음 상태(지금 어느 항목이 새 조합을 기다리는가), 검색어.
//
// 제공 API
//   initKeymapPage(deps) · enterKeymapPage() · renderKeymapPage().
//
// 의존 대상
//   core/keymap 이 표와 판정을 소유하므로 여기서 조합을 다시 적지 않는다. 서버로 보내는 wsSend 와
//   rail·보안·창 선택의 상태 및 변경 함수는 init 에서 받는다.
//
// 유지 조건
//   녹음 중에는 이 화면이 키를 통째로 가져간다(capture + stopPropagation). 안 그러면 사용자가
//   ⌘⇧D 를 새 조합으로 지정하려는 순간 그 ⌘⇧D 가 실제로 실행돼 창이 분리된다.
//   잠긴 항목은 녹음을 시작하지 않는다. 표에서 걸러도 화면에서 누를 수 있으면 사용자는 바뀐 것으로 오해한다.
//   저장은 서버에 요청만 한다. 사본을 여기서 고치면 다음 방송에 되돌아가 화면이 깜빡인다.
//
// 영향 범위
//   core/keymap 의 판정, devtool/rail 의 화면 표, main 의 keymap·보안·창 선택 연결,
//   settings-view 의 순수 마크업, web/css/20-keymap.css 의 이름.
//   현재 목록 확인: node bin/importers.mjs web/js/devtool/keymap-page.js

import { applyPreset, featureEnableNote, featureNeedsRestart, featureRestartNote } from "../core/features.js";
import {
  bindingFromEvent, findConflicts, formatBinding, resolvedKeymap, sameBinding,
} from "../core/keymap.js";
import { artifactsClick, artifactsModel, enterArtifacts, initArtifacts } from "./artifacts-page.js";
import { settingsMarkup, SETTINGS_SECTIONS } from "./settings-view.js";
import { CAPABILITIES } from "../core/capabilities.js";

let $ = null, wsSend = null, showToast = null, getSecurityToggles = null, setSecurityToggle = null;
let getRailScreens = null, setRailScreen = null, enableCapability = null, refreshRail = null;
let getSwitcher = null, pickWindow = null, unpickWindow = null, moveWindow = null;
let refreshWindows = null, reloadWindows = null, openPermissions = null;
let recording = null;   // 지금 새 조합을 기다리는 항목 id
let query = "";
let section = SETTINGS_SECTIONS[0].id;   // 왼쪽에서 고른 분류
let seenListRevision = null;

export function initKeymapPage(deps) {
  ({
    $, wsSend, showToast, getSecurityToggles, setSecurityToggle, getRailScreens, setRailScreen,
    getSwitcher, pickWindow, unpickWindow, moveWindow, refreshWindows, reloadWindows, openPermissions,
    enableCapability, refreshRail,
  } = deps);
  const root = $("#km-panel");
  if (!root) return;

  root.addEventListener("input", (e) => {
    if (!e.target.matches("#km-search")) return;
    query = String(e.target.value || "").trim().toLowerCase();
    renderKeymapPage();
  });

  // 부산물 분류는 자기 연결을 갖는다. 어떤 이벤트를 받을지도 그쪽이 정한다.
  initArtifacts({ wsSend, showToast, rerender: renderKeymapPage });

  root.addEventListener("click", async (e) => {
    if (artifactsClick(e)) return;
    const rec = e.target.closest("[data-km-rec]");
    if (rec) { startRecording(rec.dataset.kmRec); return; }
    const reset = e.target.closest("[data-km-reset]");
    if (reset) { wsSend({ type: "keymap-reset", id: reset.dataset.kmReset }); return; }
    if (e.target.closest("#km-reset-all")) {
      wsSend({ type: "keymap-reset" });
      showToast && showToast("단축키를 전부 기본값으로 되돌렸습니다");
      return;
    }
    const sec = e.target.closest("[data-km-sec]");
    if (sec) {
      const next = sec.dataset.kmSec;
      const enteringWindows = next === "windows" && section !== "windows";
      section = next;
      query = "";
      renderKeymapPage();
      if (enteringWindows) void requestFreshWindowList();
      if (next === "artifacts") enterArtifacts();
      return;
    }
    const windowMove = e.target.closest("[data-sw-move]");
    if (windowMove) {
      const dir = Number(windowMove.dataset.swMove);
      const ref = windowMove.closest(".km-sw-row")?.querySelector("[data-sw-pick], [data-sw-key]");
      const model = (getSwitcher && getSwitcher()) || {};
      const windows = Array.isArray(model.windows) ? model.windows : [];
      const hasKey = ref?.hasAttribute("data-sw-key") === true;
      const value = hasKey ? ref.dataset.swKey : ref?.dataset.swPick;
      const win = windows.find((item) => hasKey
        ? String(item.pickKey) === value
        : String(item.id) === value);
      if (!win || (dir !== -1 && dir !== 1)) return;
      const action = moveWindow && moveWindow(hasKey ? { key: win.pickKey } : { id: win.id }, dir);
      Promise.resolve(action).then(() => renderKeymapPage());
      return;
    }
    const windowPick = e.target.closest("[data-sw-pick], [data-sw-key]");
    if (windowPick) {
      const model = (getSwitcher && getSwitcher()) || {};
      const windows = Array.isArray(model.windows) ? model.windows : [];
      const hasKey = windowPick.hasAttribute("data-sw-key");
      const value = hasKey ? windowPick.dataset.swKey : windowPick.dataset.swPick;
      const win = windows.find((w) => hasKey
        ? String(w.pickKey) === value
        : String(w.id) === value);
      if (!win) return;
      const action = win.picked
        ? unpickWindow && unpickWindow(hasKey ? { pickKey: win.pickKey } : { id: win.id })
        : pickWindow && pickWindow(win.id);
      Promise.resolve(action).then(() => renderKeymapPage());
      return;
    }
    if (e.target.closest("#sw-refresh")) {
      void requestFreshWindowList();
      return;
    }
    if (e.target.closest("#sw-open-perm")) {
      Promise.resolve(openPermissions && openPermissions("screen")).then(() => renderKeymapPage());
      return;
    }
    if (e.target.closest("#sw-open-accessibility")) {
      Promise.resolve(openPermissions && openPermissions("accessibility")).then(() => renderKeymapPage());
      return;
    }
    const scr = e.target.closest("[data-set-screen]");
    if (scr) {
      const id = scr.dataset.setScreen;
      const wasOn = (getRailScreens ? getRailScreens() : []).some((t) => t.id === id && t.on);
      try { if (!setRailScreen || !await setRailScreen(id)) return; }
      catch (error) { showToast && showToast(error.message); return; }
      renderKeymapPage();
      if (CAPABILITIES.some((c) => (c.rail || c.id) === id)) {
        // 켜는 쪽은 아직 로드되지 않은 모듈을 지금 로드할 수 있다. 끄는 쪽은 한 번 로드한 ESM 을 내릴 수 없다.
        if (wasOn) { showToast && showToast(featureRestartNote(id)); return; }
        // 서버·네이티브 짝이 있는 것을 렌더러만 먼저 로드하면 절반만 적용되므로 재시작까지 미룬다.
        if (featureNeedsRestart(id)) { showToast && showToast(featureEnableNote(id)); return; }
        const loadedNow = enableCapability ? await enableCapability(id) : false;
        showToast && showToast(loadedNow ? featureEnableNote(id) : "⌘⇧R 로 다시 읽으면 켜집니다");
      }
      return;
    }
    const pre = e.target.closest("[data-set-preset]");
    if (pre) {
      // 저장된 구성과 실행 중인 서버 구성은 재시작 전까지 다를 수 있다.
      let plan;
      try { plan = await applyPreset(pre.dataset.setPreset); }
      catch (error) { showToast && showToast(error.message); return; }
      // 상태만 바꾸면 rail 과 패널은 그대로다. 켜짐을 화면에 반영하는 것은 rail 이 담당한다.
      refreshRail && refreshRail();
      renderKeymapPage();
      if (!plan) return;
      const now = plan.turningOn.filter((id) => !featureNeedsRestart(id));
      let failed = now;
      if (enableCapability) {
        const results = await Promise.allSettled(now.map((id) => enableCapability(id)));
        failed = now.filter((id, i) => results[i].status !== "fulfilled" || !results[i].value);
      }
      const parts = [!plan.turningOn.length && !plan.turningOff.length ? "이미 그 구성입니다"
        : "구성을 저장했습니다. 서버·네이티브에도 반영하려면 앱을 다시 시작해 주세요"];
      if (failed.length) parts.push(`지금 불러오지 못한 기능: ${failed.join(", ")}. ⌘⇧R 로 다시 읽어 주세요`);
      showToast && showToast(parts.join(" · "));
      return;
    }
    const sw = e.target.closest("[data-set-toggle]");
    if (sw) {
      // 켜는 것은 사람이 정한다. 끄는 쪽으로는 묻지 않는다. 끄는 것이 안전한 방향이다.
      Promise.resolve(setSecurityToggle && setSecurityToggle(sw.dataset.setToggle))
        .then(() => renderKeymapPage());
      return;
    }
  });

  // 녹음 중에는 이 화면이 먼저 받는다. 캡처 단계여야 keynav 의 캡처 핸들러보다 앞선다.
  document.addEventListener("keydown", (e) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") { recording = null; renderKeymapPage(); return; }
    const b = bindingFromEvent(e);
    if (!b) { renderKeymapPage(); return; }   // 아직 수식키만 눌렸으므로 계속 기다린다
    const id = recording;
    recording = null;
    wsSend({ type: "keymap-set", id, binding: b });
    renderKeymapPage();
  }, true);
}

function startRecording(id) {
  const item = resolvedKeymap().find((x) => x.id === id);
  if (!item || item.lock) return;   // 잠긴 항목은 녹음을 시작하지 않는다
  recording = id;
  renderKeymapPage();
}

export function enterKeymapPage() {
  renderKeymapPage();
  if (section === "windows") void requestFreshWindowList();
  if (section === "artifacts") enterArtifacts();
}

// 새로 열거: 화면 진입·분류 전환·「다시 읽기」에서만 AX를 다시 조회한다.
function requestFreshWindowList() {
  return Promise.resolve(refreshWindows && refreshWindows()).then(
    () => renderKeymapPage(),
    () => renderKeymapPage(),
  );
}

// host가 든 것만: revision 방송 뒤에는 AX 열거 없이 이미 바뀐 행만 다시 받는다.
function requestHostWindowList() {
  return Promise.resolve(reloadWindows && reloadWindows()).then(
    () => renderKeymapPage(),
    () => renderKeymapPage(),
  );
}

export function renderKeymapPage() {
  if (!$) return;
  const body = $("#km-body");
  if (!body) return;
  const all = resolvedKeymap();
  const switcher = getSwitcher && getSwitcher();
  const listRevision = switcher && switcher.status && switcher.status.listRevision;
  if (Number.isInteger(listRevision) && listRevision !== seenListRevision) {
    seenListRevision = listRevision;
    if (section === "windows" && listRevision > 0) void requestHostWindowList();
  }
  const items = all.map((x) => ({
    id: x.id, label: x.label, where: x.where, lock: x.lock, changed: x.changed,
    keys: formatBinding(x.binding), defKeys: formatBinding(x.def),
  }));
  // 화면은 settings-view 가 그린다. 앱을 켜지 않는 사본과 검사가 같은 함수를 부를 수 있어야
  // 배치를 두 벌로 적지 않는다.
  body.innerHTML = settingsMarkup({
    section, query, items, recording,
    changed: all.filter((x) => x.changed).length,
    conflicts: findConflicts(all).filter((c) => c.overlaps),
    toggles: (getSecurityToggles && getSecurityToggles()) || [],
    screens: (getRailScreens && getRailScreens()) || [],
    switcher,
    artifacts: artifactsModel(),
  });
  const inp = body.querySelector("#km-search");
  if (inp && query) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export { sameBinding };
