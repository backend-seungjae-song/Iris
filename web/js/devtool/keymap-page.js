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

import { featureEnableNote, featureNeedsRestart, featureOptIn, featureRestartNote, presetMembers } from "../core/features.js";
import {
  bindingFromEvent, findConflicts, formatBinding, resolvedKeymap, sameBinding, shortcutLabel,
} from "../core/keymap.js";
import { artifactsClick, artifactsModel, enterArtifacts, initArtifacts } from "./artifacts-page.js";
import { linkAddState, linkHintMarkup, optInConfirmMarkup, settingsMarkup, SETTINGS_SECTIONS } from "./settings-view.js";
import { createDropdown } from "../core/dropdown.js";
import { setHtml } from "../core/set-html.js";
import { parseLinkPattern } from "../browser/link-rules.js";
import { CAPABILITIES } from "../core/capabilities.js";
import { callHook } from "../core/hooks.js";
import { motionOn, setMotion } from "../core/motion.js";

let $ = null, wsSend = null, showToast = null, getSecurityToggles = null, setSecurityToggle = null, clearSiteRecords = null;
let getRailScreens = null, setRailScreen = null, enableCapability = null, refreshRail = null;
let getSwitcher = null, pickWindow = null, unpickWindow = null, moveWindow = null, groupWindow = null;
const swSelected = new Set();   // 창 전환 순서 목록에서 묶으려고 고른 창의 pickKey
let refreshWindows = null, reloadWindows = null, openPermissions = null, setGlobalPriority = null;
let getLinkRules = null, setLinkRules = null;
let recording = null;   // 지금 새 조합을 기다리는 항목 id
let query = "";
let section = SETTINGS_SECTIONS[0].id;   // 왼쪽에서 고른 분류
let presetView = "full";                 // 편의 기능 목록 보기(전부·최소·개발자). 설정은 안 바꿈
let seenListRevision = null;
let links = null;                         // 링크 열기 분류의 조회 결과. 분류에 들어올 때마다 다시 조회
// 링크별 계정 규칙 입력 상태. 규칙 자체는 브라우저 상태(서버)가 소유
let lkDraft = "";
let lkDraftAccount = null;   // null: 아직 안 고름(첫 비기본 계정)
let lkUndo = null;           // { rule, timer } 방금 지운 규칙
let drawnView = "";          // 마지막으로 그린 분류·검색어
let lkFreshTimer = null;
let lkFresh = null;          // 방금 추가·변경한 규칙 주소(줄 강조)
let lkSeen = "";             // 마지막으로 그린 규칙·계정 서명
const lkDropdowns = [];

// 창 전환 단추가 가리키는 창의 host 용 { id } 또는 { key }
// 단추에 data-ref-* 가 없으면 그 줄의 스위치 기준. 지금 목록에 없는 창이면 null
function switcherRef(button) {
  const model = (getSwitcher && getSwitcher()) || {};
  const windows = Array.isArray(model.windows) ? model.windows : [];
  const own = button.hasAttribute("data-ref-key") || button.hasAttribute("data-ref-id") ? button : null;
  const source = own || button.closest(".km-sw-row")?.querySelector("[data-sw-pick], [data-sw-key]");
  if (!source) return null;
  const hasKey = own ? own.hasAttribute("data-ref-key") : source.hasAttribute("data-sw-key");
  const value = own ? (hasKey ? own.dataset.refKey : own.dataset.refId) : (hasKey ? source.dataset.swKey : source.dataset.swPick);
  const win = windows.find((item) => hasKey ? String(item.pickKey) === value : String(item.id) === value);
  if (!win) return null;
  return hasKey ? { key: win.pickKey } : { id: win.id };
}

export function initKeymapPage(deps) {
  ({
    $, wsSend, showToast, getSecurityToggles, setSecurityToggle, clearSiteRecords, getRailScreens, setRailScreen,
    getSwitcher, pickWindow, unpickWindow, moveWindow, groupWindow, refreshWindows, reloadWindows, openPermissions,
    setGlobalPriority, enableCapability, refreshRail, getLinkRules, setLinkRules,
  } = deps);
  const root = $("#km-panel");
  if (!root) return;

  root.addEventListener("input", (e) => {
    if (e.target.matches("#lk-pattern")) { lkDraft = e.target.value; updateLinkHint(); return; }
    if (!e.target.matches("#km-search")) return;
    // 화면을 다시 그리면 입력칸 값이 query 로 바뀐다. 여기서 trim 하면 친 공백이 바로 지워진다
    query = String(e.target.value || "").toLowerCase();
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
      showToast && showToast("단축키를 전부 기본값으로 되돌렸습니다", { level: "info" });
      return;
    }
    const fs = e.target.closest("[data-fs-key]");
    if (fs) {
      const f = featureSections().find((x) => x.id === fs.dataset.fsSec);
      if (f && typeof f.set === "function") f.set(fs.dataset.fsKey, fs.dataset.fsValue);
      renderKeymapPage();
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
      if (next === "links") void refreshLinks();
      return;
    }
    if (e.target.closest("#lk-refresh")) { void refreshLinks(); return; }
    if (e.target.closest("#lk-add")) { addLinkRule(); return; }
    if (e.target.closest("#lk-undo")) { undoLinkRule(); return; }
    const whole = e.target.closest("[data-lk-whole]");
    if (whole) { lkDraft = whole.dataset.lkWhole; const inp = root.querySelector("#lk-pattern"); if (inp) { inp.value = lkDraft; inp.focus(); } updateLinkHint(); return; }
    const del = e.target.closest("[data-lk-del]");
    if (del) { deleteLinkRule(del.dataset.lkDel); return; }
    const linkTargetBtn = e.target.closest("[data-link-target]");
    if (linkTargetBtn) { void chooseLinkTarget(linkTargetBtn.dataset.linkTarget); return; }
    const linkApp = e.target.closest("[data-link-app]");
    if (linkApp) { void chooseLinkApp(linkApp.dataset.linkApp); return; }
    const windowMove = e.target.closest("[data-sw-move]");
    if (windowMove) {
      const dir = Number(windowMove.dataset.swMove);
      const ref = switcherRef(windowMove);
      if (!ref || (dir !== -1 && dir !== 1)) return;
      const unit = windowMove.dataset.swUnit === "stop" ? "stop" : undefined;
      const action = moveWindow && moveWindow(ref, dir, unit);
      Promise.resolve(action).then(() => renderKeymapPage());
      return;
    }
    const selectBox = e.target.closest("[data-sw-sel]");
    if (selectBox) {
      const key = selectBox.dataset.swSel;
      if (selectBox.checked) swSelected.add(key);
      else swSelected.delete(key);
      renderKeymapPage();
      // 다시 그리면 체크 칸이 새로 만들어져 키보드 포커스가 사라진다
      root.querySelector(`[data-sw-sel="${CSS.escape(key)}"]`)?.focus();
      return;
    }
    if (e.target.closest("[data-sw-sel-clear]")) {
      swSelected.clear();
      renderKeymapPage();
      return;
    }
    const selectionAction = e.target.closest("[data-sw-sel-group], [data-sw-sel-leave]");
    if (selectionAction) {
      const op = selectionAction.hasAttribute("data-sw-sel-group") ? "group" : "leave";
      const keys = [...swSelected];
      Promise.resolve(groupWindow && groupWindow(op, { keys })).then(() => {
        swSelected.clear();
        renderKeymapPage();
      });
      return;
    }
    const ungroupButton = e.target.closest("[data-sw-ungroup]");
    if (ungroupButton) {
      const ref = switcherRef(ungroupButton);
      if (!ref) return;
      Promise.resolve(groupWindow && groupWindow("ungroup", ref)).then(() => renderKeymapPage());
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
    const globalSw = e.target.closest("[data-sw-global]");
    if (globalSw) {
      const status = ((getSwitcher && getSwitcher()) || {}).status || {};
      Promise.resolve(setGlobalPriority && setGlobalPriority(!status.globalPriority)).then(() => renderKeymapPage());
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
      const optIn = wasOn ? null : featureOptIn(id);
      if (optIn && !await confirmOptIn(optIn)) return;
      try { if (!setRailScreen || !await setRailScreen(id, { confirmed: !!optIn })) return; }
      catch (error) { showToast && showToast("기능 설정을 바꾸지 못했습니다", { level: "err", detail: String(error.message) }); return; }
      renderKeymapPage();
      if (CAPABILITIES.some((c) => (c.rail || c.id) === id)) {
        // 켜는 쪽은 아직 로드되지 않은 모듈을 지금 로드할 수 있다. 끄는 쪽은 한 번 로드한 ESM 을 내릴 수 없다.
        if (wasOn) { showToast && showToast(featureRestartNote(id), { level: "info" }); return; }
        // 서버·네이티브 짝이 있는 것을 렌더러만 먼저 로드하면 절반만 적용되므로 재시작까지 미룬다.
        if (featureNeedsRestart(id)) { showToast && showToast(featureEnableNote(id), { level: "info" }); return; }
        const loadedNow = enableCapability ? await enableCapability(id) : false;
        showToast && showToast(loadedNow ? featureEnableNote(id) : shortcutLabel("⌘⇧R 로 다시 읽으면 켜집니다"), { level: "info" });
      }
      return;
    }
    const pre = e.target.closest("[data-set-preset]");
    if (pre) {
      presetView = pre.dataset.setPreset;
      renderKeymapPage();
      return;
    }
    const clr = e.target.closest("[data-set-clear]");
    if (clr) { clearSiteRecords && clearSiteRecords(clr.dataset.setClear); return; }
    const sw = e.target.closest("[data-set-toggle]");
    if (sw) {
      // 켜는 것은 사람이 정한다. 끄는 쪽으로는 묻지 않는다. 끄는 것이 안전한 방향이다.
      Promise.resolve(setSecurityToggle && setSecurityToggle(sw.dataset.setToggle))
        .then(() => renderKeymapPage());
      return;
    }
    const mo = e.target.closest("[data-set-motion]");
    if (mo) { setMotion(!motionOn()); renderKeymapPage(); return; }
  });

  // 녹음 중에는 이 화면이 먼저 받는다. document 캡처 핸들러(keynav·touch-drag)는 먼저 등록돼 있어
  // 같은 document 에 걸면 그쪽이 먼저 실행된다. window 캡처는 document 보다 앞이라 여기서 끊는다.
  window.addEventListener("keydown", (e) => {
    if (!recording) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.key === "Escape") { recording = null; renderKeymapPage(); return; }
    const b = bindingFromEvent(e);
    if (!b) { renderKeymapPage(); return; }   // 아직 수식키만 눌렸으므로 계속 기다린다
    const id = recording;
    recording = null;
    wsSend({ type: "keymap-set", id, binding: b });
    renderKeymapPage();
  }, true);
  // 주소 입력칸: Enter 추가, Esc 비우기
  root.addEventListener("keydown", (e) => {
    if (!e.target.matches("#lk-pattern") || e.isComposing) return;
    if (e.key === "Enter") { e.preventDefault(); addLinkRule(); return; }
    if (e.key === "Escape" && lkDraft) { e.preventDefault(); e.stopPropagation(); lkDraft = ""; e.target.value = ""; updateLinkHint(); }
  });
  // macOS 확인 창에서 고른 뒤 Iris 로 돌아오면 바뀐 기본값을 다시 조회
  window.addEventListener("focus", () => { if (section === "links") void refreshLinks(); });
}

// ── 링크별 계정 규칙 ──────────────────────────────────────────────
function lkServer() {
  const raw = (getLinkRules && getLinkRules()) || {};
  return { rules: Array.isArray(raw.rules) ? raw.rules : [], accounts: Array.isArray(raw.accounts) ? raw.accounts : [] };
}
// 보낸 규칙은 서버 방송이 올 때까지 이것으로 그림(bsMutate 는 보내기만 함)
function lkData() {
  const server = lkServer();
  return pendingRules ? { ...server, rules: pendingRules.rules } : server;
}
function lkAccount(accounts) {
  if (lkDraftAccount != null && accounts.some((a) => a.id === lkDraftAccount)) return lkDraftAccount;
  const first = accounts.find((a) => a.id !== "") || accounts[0];
  return first ? first.id : "";
}
function lkModel() {
  const { rules, accounts } = lkData();
  return { rules, accounts, draft: lkDraft, draftAccount: lkAccount(accounts), undo: lkUndo && lkUndo.rule, fresh: lkFresh };
}
function lkSignature() { const { rules, accounts } = lkData(); return JSON.stringify([rules, accounts.map((a) => [a.id, a.name])]); }

// 입력할 때는 다시 그리지 않고 안내 줄과 추가 버튼만 고침(입력칸 글자·커서 유지)
function updateLinkHint() {
  const body = $ && $("#km-body");
  if (!body) return;
  const m = lkModel();
  const hint = body.querySelector("#lk-hint");
  if (hint) hint.innerHTML = linkHintMarkup(m);
  const btn = body.querySelector("#lk-add");
  if (btn) { const st = linkAddState(m); btn.disabled = st.disabled; btn.textContent = st.label; }
}

function commitLinkRules(rules, fresh) {
  if (!setLinkRules) return;
  lkFresh = fresh || null;
  // 강조 애니메이션(900ms)이 끝날 때까지 유지: 도중에 다시 그려도 강조가 끊기지 않음
  clearTimeout(lkFreshTimer);
  if (lkFresh) lkFreshTimer = setTimeout(() => { lkFresh = null; }, 900);
  setLinkRules(rules);
  renderKeymapPage();   // 서버 방송 전에도 바로 보이게. 방송이 오면 같은 값으로 다시 그림
}

function addLinkRule() {
  const p = parseLinkPattern(lkDraft);
  const { rules, accounts } = lkData();
  if (!p.ok) { updateLinkHint(); return; }
  const profile = lkAccount(accounts);
  const next = rules.filter((r) => r.pattern !== p.pattern).concat([{ pattern: p.pattern, profile }]);
  lkDraft = "";
  pendingRules = { rules: next, at: Date.now() };
  commitLinkRules(next, p.pattern);
  const inp = $("#km-body") && $("#km-body").querySelector("#lk-pattern");
  if (inp) inp.focus();   // 이어서 다음 규칙 입력
}

function deleteLinkRule(pattern) {
  const { rules } = lkData();
  const rule = rules.find((r) => r.pattern === pattern);
  if (!rule) return;
  if (lkUndo) clearTimeout(lkUndo.timer);
  // 되돌리기 안내는 8초. 다른 규칙을 바꾸면 그대로 둠(그 규칙만 되돌림)
  lkUndo = { rule, timer: setTimeout(() => { lkUndo = null; renderKeymapPage(); }, 8000) };
  const next = rules.filter((r) => r.pattern !== pattern);
  pendingRules = { rules: next, at: Date.now() };
  commitLinkRules(next, null);
}

function undoLinkRule() {
  if (!lkUndo) return;
  clearTimeout(lkUndo.timer);
  const { rule } = lkUndo;
  lkUndo = null;
  const { rules } = lkData();
  const next = rules.filter((r) => r.pattern !== rule.pattern).concat([rule]);
  pendingRules = { rules: next, at: Date.now() };
  commitLinkRules(next, rule.pattern);
}

function changeLinkRuleAccount(pattern, profile) {
  const { rules } = lkData();
  const next = rules.map((r) => (r.pattern === pattern ? { pattern, profile } : r));
  pendingRules = { rules: next, at: Date.now() };
  commitLinkRules(next, pattern);
}

// 서버 방송 전의 규칙 { rules, at }. 방송이 같은 값을 주거나 2초가 지나면 버리고 서버 값으로(거절된 경우 포함)
let pendingRules = null;

function mountLinkDropdowns(body) {
  while (lkDropdowns.length) { try { lkDropdowns.pop().destroy(); } catch {} }
  const { rules, accounts } = lkData();
  const items = accounts.map((a) => ({ value: a.id, label: a.name }));
  for (const slot of body.querySelectorAll("[data-lk-acct]")) {
    const pattern = slot.dataset.lkAcct;
    const rule = pattern ? rules.find((r) => r.pattern === pattern) : null;
    const dd = createDropdown({
      items, value: rule ? rule.profile : lkAccount(accounts), className: "lk-dd",
      ariaLabel: slot.getAttribute("aria-label") || "열 계정",
      onChange: (value) => {
        if (!pattern) { lkDraftAccount = value; updateLinkHint(); return; }
        changeLinkRuleAccount(pattern, value);
      },
    });
    slot.appendChild(dd.el);
    lkDropdowns.push(dd);
  }
}

// 브라우저 상태가 바뀔 때 main 이 부름. 규칙·계정이 실제로 바뀌었을 때만 다시 그림(입력 중 화면 유지)
export function linkRulesChanged() {
  if (pendingRules && (JSON.stringify(lkServer().rules) === JSON.stringify(pendingRules.rules) || Date.now() - pendingRules.at > 2000)) pendingRules = null;
  if (section !== "links") return;
  const sig = lkSignature();
  if (sig === lkSeen) return;
  renderKeymapPage();
}

async function refreshLinks() {
  const host = window.acHost && window.acHost.defaultBrowser;
  if (!host) { links = { ok: false, error: "설치한 Iris 앱에서만 바꿀 수 있습니다." }; renderKeymapPage(); return; }
  const requested = !!(links && links.requested);
  if (!links || !links.ok) { links = { loading: true }; renderKeymapPage(); }
  let next;
  try { next = await host.status(); } catch (error) { next = { ok: false, error: String(error && error.message || error) }; }
  if (next && next.ok) next = { ...next, target: await readLinkTarget() };
  // 요청한 앱이 아직 기본값이 아니면 확인 창 안내 유지
  links = next && next.ok ? { ...next, requested: requested && next.current !== links.requestedId, requestedId: links.requestedId } : next;
  renderKeymapPage();
}

async function readLinkTarget(value) {
  try { return (await window.acHost.linkTarget(value)) || "shared"; } catch { return "shared"; }
}

async function chooseLinkTarget(value) {
  if (!window.acHost || !window.acHost.linkTarget || (value !== "shared" && value !== "session")) return;
  const saved = await readLinkTarget(value);
  if (links && links.ok) links = { ...links, target: saved };
  renderKeymapPage();
}

async function chooseLinkApp(id) {
  const host = window.acHost && window.acHost.defaultBrowser;
  if (!host) return;
  let r;
  try { r = await host.choose(id); } catch (error) { r = { ok: false, error: String(error && error.message || error) }; }
  if (!r || !r.ok) {
    showToast && showToast("기본 브라우저를 바꾸지 못했습니다", { level: "err", detail: (r && r.error) || "" });
    return;
  }
  if (r.requested && links && links.ok) links = { ...links, requested: true, requestedId: id };
  await refreshLinks();
}

// 확인하면 true. 바깥을 누르거나 Esc 를 누르면 취소다.
function confirmOptIn(optIn) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const wrap = document.createElement("div");
    wrap.className = "askwrap";
    wrap.innerHTML = `<div class="dim"></div><div class="modal">${optInConfirmMarkup(optIn)}</div>`;
    let done = false;
    const finish = (value) => { if (done) return; done = true; wrap.remove(); previous?.focus?.(); resolve(value); };
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap || e.target.classList?.contains("dim")) return finish(false);
      const b = e.target.closest("button");
      if (b) finish(b.dataset.a === "ok");
    });
    wrap.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); finish(false); }
      e.stopPropagation();
    });
    document.body.appendChild(wrap);
    wrap.querySelector('[data-a="ok"]')?.focus();
  });
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
  if (section === "links") void refreshLinks();
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
  // 기능이 가진 고정 단축키(창 레이아웃의 전역 단축키). 기능이 꺼져 있으면 훅이 없어 빈 목록
  const featureRows = callHook("desklayout.keymapRows");
  if (Array.isArray(featureRows)) items.push(...featureRows);
  // 화면은 settings-view 가 그린다. 앱을 켜지 않는 사본과 검사가 같은 함수를 부를 수 있어야
  // 배치를 두 벌로 적지 않는다.
  const lkFocus = !!(document.activeElement && document.activeElement.id === "lk-pattern");
  // 같은 내용이면 건드리지 않음(기능 분류의 iframe 이 다시 불려 비는 것 방지). 다시 그려도 안쪽 스크롤 위치 유지
  const sameView = drawnView === section + "\n" + query;   // 분류·검색어가 바뀌면 목록은 맨 위부터
  const drew = setHtml(body, settingsMarkup({
    section, query, items, recording,
    changed: all.filter((x) => x.changed).length,
    conflicts: findConflicts(all).filter((c) => c.overlaps),
    toggles: (getSecurityToggles && getSecurityToggles()) || [],
    screens: (getRailScreens && getRailScreens()) || [],
    presetView, presetMembers: presetMembers(presetView),
    motion: motionOn(),
    switcher: switcherWithSelection(switcher),
    artifacts: artifactsModel(),
    links,
    linkRules: section === "links" ? lkModel() : null,
    featureSections: featureSections(),
  }), { keep: sameView ? ".km-nav-list, .km-scroll" : ".km-nav-list" });
  drawnView = section + "\n" + query;
  if (section === "links") {
    lkSeen = lkSignature();
    if (drew) mountLinkDropdowns(body);
    if (lkFocus) { const lk = body.querySelector("#lk-pattern"); if (lk) { lk.focus({ preventScroll: true }); lk.setSelectionRange(lk.value.length, lk.value.length); } }
  }
  const inp = body.querySelector("#km-search");
  if (inp && query) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
}

// 켜진 기능이 설정 화면에 채우는 분류. 꺼진 기능은 훅이 없어 빠짐
function featureSections() {
  const agentchat = callHook("agentchat.settingsSection");
  return agentchat && typeof agentchat === "object" ? [agentchat] : [];
}

// 고른 창 목록에서 빠진 창은 선택에서도 지운다
function switcherWithSelection(switcher) {
  if (!switcher) return switcher;
  const keys = new Set((Array.isArray(switcher.picked) ? switcher.picked : []).map((item) => item && item.pickKey));
  for (const key of [...swSelected]) if (!keys.has(key)) swSelected.delete(key);
  return { ...switcher, selected: [...swSelected] };
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export { sameBinding };
