// 별도 메모 창: 한 창의 문서 revision·초안·충돌·실시간 공유·Monaco UI를 맡는다.
//
// 소유 범위
//   MW_KIND/INSTANCE/SPACE/NOTE 정체성, Monaco model/editor, revision·dirty·pending·conflict,
//   localStorage 복구 초안, 실시간 수신/송신 상태, 창 전용 DOM listener.
//
// 제공 API
//   initMemoWindowModule(deps): main이 의존성과 query 값을 한 번 주입한다.
//   initMemoWindow(): main 끝의 기존 MEMO_MODE timer가 호출하는 DOM/Monaco 진입점.
//   handleMemoWindowMessage(message), archiveMemoWindow(), disconnectMemoWindow(),
//   syncMemoWindowState(value), showMemoWindowError(error).
//
// 의존 대상
//   $, memoMode/query 값, wsSend·wsIsOpen, memoReqId, mdToHtml, ensureMonacoLib,
//   getMonaco, monacoTheme, acHost를 init에서 주입받는다. main을 import하지 않는다.
//
// 유지 조건
//   MEMO_MODE가 아니면 창 전용 처리와 송신을 하지 않는다.
//   서버 revision과 로컬 초안이 겹치면 어느 쪽도 버리지 않고 conflict로 보존한다.
//   마지막 main의 MEMO_MODE 분기와 setTimeout 실행 시점은 옮기지 않는다.
//
// 영향 범위
//   main의 WebSocket message/onclose 분기, memo archive 단축키 두 곳, 메모 창 상태 IPC 구독,
//   core/markdown.js 미리보기, Monaco loader/theme, memo.doc.*·memo.note.* 서버 계약.

import { ICON_WRAP } from "../center/text-editor.js";
import { editorPref, toggleEditorPref, subscribeEditorPrefs, monacoPrefOpts } from "../core/editor-prefs.js";
import { registerEditorHost, updateEditorHost } from "../core/editor-hosts.js";
import { bindKeymapAction, shortcutLabel } from "../core/monaco-keys.js";
import { subscribeKeymap } from "../core/keymap.js";

let $ = null;
let MEMO_MODE = false;
let wsSend = null;
let wsIsOpen = null;
let memoReqId = null;
let mdToHtml = null;
let ensureMonacoLib = null;
let getMonaco = null;
let monacoTheme = null;
let host = null;

let MW_KIND = "local";
let MW_INSTANCE = "memo-window";
let MW_SPACE = "";
let MW_NOTE = "";
let MW_SPACE_LABEL = "";
let MW_DRAFT_KEY = "";
let mwModel = null, mwEditor = null, mwSetting = false, mwHydrated = false;
let mwDoc = null, mwRev = 0, mwBaseText = "", mwPending = null, mwSaveTimer = null;
let mwDirty = false, mwIncoming = null, mwConflict = null;
let mwLiveSeq = 0, mwLiveIncoming = null, mwLiveText = null, mwOwnsLive = false;
let mwView = "raw";
let mwAlwaysOnTop = false;

// 손잡이는 창 머리글이 아니라 글 위에 뜬다. 파일 편집기·메모 도크와 같은 위치다.
function mwFloat() {
  const body = $(".mw-body");
  if (!body) return null;
  let float = body.querySelector(".editor-float");
  if (!float) {
    float = document.createElement("span");
    float.className = "editor-float";
    float.innerHTML = '<span class="editor-controls" data-mw-tools></span>'
      + `<span class="editor-view-opts"><button type="button" class="etool" data-mw-wrap aria-label="줄바꿈">${ICON_WRAP}</button></span>`;
    body.appendChild(float);
    float.querySelector("[data-mw-wrap]").addEventListener("click", () => toggleEditorPref("memo", "wrap"));
  }
  return float;
}
function mwSyncControls() {
  const float = mwFloat();
  if (!float) return;
  const button = float.querySelector("[data-mw-wrap]");
  button.classList.toggle("on", editorPref("memo", "wrap"));
  button.setAttribute("aria-pressed", String(editorPref("memo", "wrap")));
  const shortcut = shortcutLabel("editor-wrap");
  button.dataset.tip = `줄바꿈${shortcut ? "  " + shortcut : ""}`;
  updateEditorHost("memo-window", { editable: mwView !== "preview",
    barEl: float.querySelector("[data-mw-tools]") });
}

export function initMemoWindowModule(deps) {
  $ = deps.$;
  MEMO_MODE = !!deps.memoMode;
  wsSend = deps.wsSend;
  wsIsOpen = deps.wsIsOpen;
  memoReqId = deps.memoReqId;
  mdToHtml = deps.mdToHtml;
  ensureMonacoLib = deps.ensureMonacoLib;
  getMonaco = deps.getMonaco;
  monacoTheme = deps.monacoTheme;
  host = deps.acHost;
  MW_KIND = deps.kind;
  MW_INSTANCE = deps.instance;
  MW_SPACE = deps.space;
  MW_NOTE = deps.note;
  MW_SPACE_LABEL = deps.spaceLabel;
  MW_DRAFT_KEY = "ac.memoWindowDraft." + MW_INSTANCE;
  mwView = deps.view === "preview" ? "preview" : "raw";
  mwAlwaysOnTop = !!deps.alwaysOnTop;
}

function mwReadDraft() { try { return JSON.parse(localStorage.getItem(MW_DRAFT_KEY) || "null"); } catch { return null; } }
function mwWriteDraft(text) {
  try { localStorage.setItem(MW_DRAFT_KEY, JSON.stringify({ text, rev: mwRev, at: Date.now() })); } catch {}
}
function mwClearDraft() { try { localStorage.removeItem(MW_DRAFT_KEY); } catch {} }
function mwSetDirty(value) {
  mwDirty = !!value;
  const dot = $("#mw-state"); if (dot) { dot.classList.toggle("dirty", mwDirty); dot.title = mwDirty ? "저장 중" : "저장됨"; }
}
function mwRenderAlwaysOnTop(value) {
  mwAlwaysOnTop = !!value;
  const button = $("#mw-always-on-top"); if (!button) return;
  button.classList.toggle("on", mwAlwaysOnTop);
  button.setAttribute("aria-pressed", String(mwAlwaysOnTop));
  button.title = mwAlwaysOnTop ? "항상 위 고정 해제" : "이 메모 창을 다른 창보다 항상 위에 표시";
}
function mwAlert(message, { conflict = false } = {}) {
  const bar = $("#mw-alert"), text = $("#mw-alert-text"); if (!bar || !text) return;
  bar.hidden = !message; text.textContent = message || "";
  $("#mw-keep-both").hidden = !conflict;
  $("#mw-use-server").hidden = !conflict;
}
function mwSetValue(value) {
  if (!mwModel) return;
  mwSetting = true;
  try { if (mwModel.getValue() !== value) mwModel.setValue(value); } finally { mwSetting = false; }
}
function mwLiveMatches(message) {
  if (!message || message.scope !== MW_KIND || String(message.source || "") === MW_INSTANCE) return false;
  if (MW_KIND === "shared") return true;
  const messageSpace = String(message.storageSpace || message.space || "");
  return String(message.noteId || "") === MW_NOTE && (!messageSpace || messageSpace === MW_SPACE);
}
function mwSendLive(text) {
  if (!MEMO_MODE || !mwHydrated || !wsIsOpen()) return;
  const seq = ++mwLiveSeq;
  wsSend({ type: "memo.doc.live", requestId: `memo-live:${MW_INSTANCE}:${seq}`, source: MW_INSTANCE, seq,
    scope: MW_KIND, ...(MW_KIND === "local" ? { space: MW_SPACE, noteId: MW_NOTE } : {}), baseRev: mwRev, text });
}
function mwReceiveLive(message) {
  if (!mwLiveMatches(message)) return;
  if (!mwHydrated || !mwModel) { mwLiveIncoming = message; return; }
  if (mwConflict) return;
  const text = String(message.text || "");
  clearTimeout(mwSaveTimer); mwSaveTimer = null;
  mwOwnsLive = false; mwLiveText = text;
  mwSetValue(text);
  if (text === mwBaseText) { mwLiveText = null; mwSetDirty(false); mwClearDraft(); }
  else { mwSetDirty(true); mwWriteDraft(text); }
  if (mwView === "preview") mwRenderView();
}
function mwRenderView() {
  if (!MEMO_MODE) return;
  const preview = mwView === "preview";
  $("#mw-editor").hidden = preview;
  $("#mw-preview").hidden = !preview;
  if (preview) $("#mw-preview").innerHTML = mdToHtml(mwModel ? mwModel.getValue() : (mwDoc?.text || ""));
  for (const button of document.querySelectorAll("[data-mw-view]")) button.classList.toggle("on", button.dataset.mwView === mwView);
  mwSyncControls();
  try { if (!preview) { mwEditor?.layout(); mwEditor?.focus(); } } catch {}
}
function mwUpdateIdentity(doc) {
  if (!MEMO_MODE || !doc) return;
  const name = MW_KIND === "shared" ? "공유 메모" : (doc.name || "메모");
  const input = $("#mw-name"); if (input && document.activeElement !== input) input.value = name;
  try { host?.setMemoWindowTitle?.(name); } catch {}
}
function mwApplyServer(doc, { initial = false } = {}) {
  if (!doc) return;
  mwDoc = doc; mwUpdateIdentity(doc);
  if (!mwModel) { mwIncoming = doc; return; }
  const serverText = String(doc.text || ""), draft = initial ? mwReadDraft() : null;
  mwRev = Number.isInteger(doc.rev) ? doc.rev : 0; mwBaseText = serverText;
  if (draft && typeof draft.text === "string" && draft.text !== serverText) {
    mwSetValue(draft.text); mwSetDirty(true);
    mwConflict = { server: doc, draft: draft.text };
    mwAlert("저장되지 않은 초안을 복구했습니다. 최신본과 함께 보존할 수 있습니다.", { conflict: true });
    return;
  }
  mwSetValue(serverText); mwSetDirty(false); mwClearDraft(); mwConflict = null;
  mwLiveText = null; mwOwnsLive = false; mwAlert("");
  mwRenderView();
}
function mwReceiveSnapshot(message) {
  if (!MEMO_MODE) return;
  let doc = null;
  if (MW_KIND === "shared") doc = message.shared || null;
  else {
    const bucket = (message.localByKey || {})[MW_SPACE] || (message.localBySpace || {})[MW_SPACE];
    doc = bucket && bucket.notes && bucket.notes[MW_NOTE];
  }
  if (!doc || doc.deletedAt != null) {
    mwAlert(doc ? "삭제된 메모입니다. 창을 닫습니다." : "메모를 찾지 못했습니다. 창을 닫습니다.");
    setTimeout(() => { try { host?.closeMemoWindow?.(); } catch {} }, 650);
    return;
  }
  mwUpdateIdentity(doc);
  if (!mwHydrated) { mwIncoming = doc; if (mwModel) { mwHydrated = true; mwApplyServer(doc, { initial: true }); $("#mw-empty").hidden = true; } return; }
  const serverRev = Number.isInteger(doc.rev) ? doc.rev : 0;
  if (serverRev < mwRev) return;
  if (serverRev === mwRev) {
    mwDoc = doc;
    if (mwDirty && mwOwnsLive) mwScheduleSave(20);
    if (!mwDirty && !mwConflict) mwAlert("");
    return;
  }
  const localText = mwModel ? mwModel.getValue() : "";
  if (localText === String(doc.text || "")) { mwPending = null; mwApplyServer(doc); return; }
  if (mwLiveText !== null && localText === mwLiveText) {
    mwDoc = doc; mwRev = serverRev; mwBaseText = String(doc.text || ""); mwPending = null;
    mwSetDirty(true); mwWriteDraft(localText);
    if (mwOwnsLive) mwScheduleSave(20);
    return;
  }
  if (mwDirty || mwPending) {
    mwDoc = doc; mwRev = serverRev; mwBaseText = String(doc.text || ""); mwPending = null;
    mwLiveText = null; mwOwnsLive = false;
    mwConflict = { server: doc, draft: localText }; mwWriteDraft(localText);
    mwAlert("다른 창의 편집과 겹쳤습니다. 현재 초안과 최신본을 모두 보존했습니다.", { conflict: true });
    return;
  }
  mwApplyServer(doc);
}
function mwScheduleSave(delay = 320) {
  clearTimeout(mwSaveTimer); mwSaveTimer = setTimeout(mwFlush, delay);
}
function mwFlush() {
  clearTimeout(mwSaveTimer); mwSaveTimer = null;
  if (!MEMO_MODE || !mwHydrated || !mwModel || mwPending || !wsIsOpen()) return;
  const text = mwModel.getValue();
  if (!mwOwnsLive && mwLiveText !== null && text === mwLiveText) return;
  if (text === mwBaseText) { mwLiveText = null; mwOwnsLive = false; mwSetDirty(false); mwClearDraft(); return; }
  const requestId = memoReqId("memo-doc");
  mwPending = { requestId, text, baseRev: mwRev };
  wsSend({ type: "memo.doc.set", requestId, scope: MW_KIND, ...(MW_KIND === "local" ? { space: MW_SPACE, noteId: MW_NOTE } : {}), baseRev: mwRev, text });
}
export function archiveMemoWindow() {
  if (!MEMO_MODE || !mwHydrated) return;
  mwFlush();
  wsSend({ type: "memo.note.archive", requestId: memoReqId("memo-archive"), scope: MW_KIND,
    ...(MW_KIND === "local" ? { space: MW_SPACE, noteId: MW_NOTE } : {}) });
}
export function handleMemoWindowMessage(message) {
  if (!MEMO_MODE) return false;
  if (message.type === "memo-notes") { mwReceiveSnapshot(message); if (message.error) mwAlert(message.error); return true; }
  if (message.type === "memo.doc.live") { mwReceiveLive(message); return true; }
  if (message.type === "memo.doc.saved") {
    if (mwPending && message.requestId === mwPending.requestId) {
      mwRev = Number.isInteger(message.rev) ? message.rev : mwRev + 1;
      mwBaseText = mwPending.text; mwPending = null;
      if (mwModel && mwModel.getValue() === mwBaseText) {
        mwLiveText = null; mwOwnsLive = false; mwSetDirty(false); mwClearDraft();
      } else {
        mwSetDirty(true); mwWriteDraft(mwModel?.getValue() || "");
        if (mwOwnsLive) mwScheduleSave(30);
      }
    }
    return true;
  }
  if (message.type === "memo.doc.conflict") {
    const current = message.current || {};
    const draft = (mwPending && mwPending.text) || mwModel?.getValue() || "";
    const currentText = String(mwModel?.getValue() || "");
    if (mwLiveText !== null && currentText === mwLiveText) {
      mwPending = null; mwDoc = current; mwRev = Number.isInteger(current.rev) ? current.rev : mwRev;
      mwBaseText = String(current.text || ""); mwSetDirty(true); mwWriteDraft(currentText);
      if (mwOwnsLive) mwScheduleSave(20);
      return true;
    }
    mwPending = null; mwDoc = current; mwRev = Number.isInteger(current.rev) ? current.rev : mwRev;
    mwLiveText = null; mwOwnsLive = false;
    mwBaseText = String(current.text || ""); mwConflict = { server: current, draft }; mwWriteDraft(draft); mwSetDirty(true);
    mwAlert("다른 창의 편집과 겹쳤습니다. 현재 초안과 최신본을 모두 보존했습니다.", { conflict: true });
    return true;
  }
  if (message.type === "memo.note.archived") {
    mwAlert(message.empty ? "빈 메모는 보관하지 않았습니다." : `${message.date} 보관함에 저장했습니다.`);
    setTimeout(() => { if (!mwConflict) mwAlert(""); }, 1800); return true;
  }
  if (message.type === "memo.error") {
    if (mwPending && message.requestId === mwPending.requestId) mwPending = null;
    mwSetDirty(true); mwAlert(message.message || "메모 작업에 실패했습니다."); return true;
  }
  return true;
}
export function initMemoWindow() {
  if (!MEMO_MODE) return;
  const shared = MW_KIND === "shared";
  $("#mw-name").readOnly = shared;
  $("#mw-name").value = shared ? "공유 메모" : "메모";
  $("#mw-titlebar-space").textContent = shared ? "" : (MW_SPACE_LABEL || "스페이스 메모");
  $("#mw-titlebar-space").hidden = shared; $("#mw-state").hidden = shared;
  $("#mw-delete").hidden = shared; $("#mw-duplicate").hidden = shared;
  mwRenderAlwaysOnTop(mwAlwaysOnTop);
  ensureMonacoLib().then(() => {
    const monaco = getMonaco();
    mwModel = monaco.editor.createModel("", "markdown");
    mwEditor = monaco.editor.create($("#mw-editor"), {
      model: mwModel, theme: monacoTheme(), automaticLayout: true, fontSize: 12.5,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono").trim(),
      ...monacoPrefOpts("memo"), lineNumbers: "on", lineNumbersMinChars: 4, folding: false, accessibilitySupport: "off",
      quickSuggestions: false,
      suggestOnTriggerCharacters: false,
      wordBasedSuggestions: "off",
      acceptSuggestionOnEnter: "off",
      tabCompletion: "off",
      parameterHints: { enabled: false },
      // 위쪽은 떠 있는 손잡이 상자가 놓이는 영역이다.
      padding: { top: 36, bottom: 10 }, scrollBeyondLastLine: false, renderLineHighlight: "none", overviewRulerLanes: 0,
      scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, useShadows: false },
    });
    // 메모는 기본이 마크다운이므로 이 창의 모델도 language 가 markdown 이다.
    registerEditorHost({ id: "memo-window", editor: mwEditor, kind: "memo", markdown: true,
      editable: mwView !== "preview", barEl: mwFloat()?.querySelector("[data-mw-tools]") || null });
    bindKeymapAction(mwEditor, "editor-wrap", () => toggleEditorPref("memo", "wrap"));
    const unsubscribePrefs = subscribeEditorPrefs((scope) => {
      if (scope !== "memo") return;
      mwEditor.updateOptions(monacoPrefOpts("memo")); mwSyncControls();
    });
    // 사용자가 키를 바꾸면 안내도 함께 바뀐다.
    const unsubscribeKeys = subscribeKeymap(() => mwSyncControls());
    mwEditor.onDidDispose(() => { unsubscribePrefs(); unsubscribeKeys(); });
    mwModel.onDidChangeContent(() => {
      if (mwSetting) return;
      const text = mwModel.getValue();
      mwOwnsLive = true; mwLiveText = text; mwSendLive(text);
      mwSetDirty(true); mwWriteDraft(text); if (mwView === "preview") mwRenderView(); mwScheduleSave();
    });
    if (mwIncoming) {
      mwHydrated = true; mwApplyServer(mwIncoming, { initial: true }); $("#mw-empty").hidden = true;
      if (mwLiveIncoming) { const incoming = mwLiveIncoming; mwLiveIncoming = null; mwReceiveLive(incoming); }
    }
    mwRenderView();
  }).catch(() => mwAlert("메모 편집기를 불러오지 못했습니다."));
  document.querySelectorAll("[data-mw-view]").forEach((button) => button.addEventListener("click", () => {
    mwView = button.dataset.mwView === "preview" ? "preview" : "raw";
    try { host?.setMemoViewMode?.(mwView); } catch {} mwRenderView();
  }));
  $("#mw-always-on-top").addEventListener("click", async (event) => {
    const button = event.currentTarget; button.disabled = true;
    try {
      const setAlwaysOnTop = host?.setMemoAlwaysOnTop;
      if (typeof setAlwaysOnTop !== "function") throw new Error("Iris 앱을 최신 빌드로 설치한 뒤 다시 열어 주세요.");
      const result = await setAlwaysOnTop(!mwAlwaysOnTop);
      if (!result?.ok) throw new Error(result?.error || "창 고정 상태를 바꾸지 못했습니다.");
      mwRenderAlwaysOnTop(result.alwaysOnTop);
    } catch (error) { mwAlert(error?.message || "창 고정 상태를 바꾸지 못했습니다."); }
    finally { button.disabled = false; }
  });
  $("#mw-name").addEventListener("keydown", (event) => {
    event.stopPropagation(); if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
    else if (event.key === "Escape") { event.preventDefault(); event.currentTarget.value = mwDoc?.name || "메모"; event.currentTarget.blur(); }
  });
  $("#mw-name").addEventListener("change", (event) => {
    if (shared || !mwDoc) return; const name = event.currentTarget.value.trim();
    if (!name) { event.currentTarget.value = mwDoc.name || "메모"; return; }
    wsSend({ type: "memo.note.rename", requestId: memoReqId("memo-rename"), space: MW_SPACE, noteId: MW_NOTE, name });
  });
  $("#mw-delete").addEventListener("click", () => {
    if (!shared && mwDoc && confirm(`“${mwDoc.name || "메모"}”를 삭제할까요? 관리 화면에서 복구할 수 있습니다.`))
      wsSend({ type: "memo.note.delete", requestId: memoReqId("memo-delete"), space: MW_SPACE, noteId: MW_NOTE });
  });
  $("#mw-duplicate").addEventListener("click", async () => {
    try {
      const result = await host?.openLocalMemo?.({ spaceKey: MW_SPACE, noteId: MW_NOTE, spaceLabel: MW_SPACE_LABEL });
      if (!result?.ok) mwAlert(result?.error || "메모 창을 열지 못했습니다.");
    } catch { mwAlert("메모 창을 열지 못했습니다."); }
  });
  $("#mw-keep-both").addEventListener("click", () => {
    if (!mwConflict || !mwModel) return;
    const serverText = String(mwConflict.server?.text || ""), draft = String(mwConflict.draft || "");
    mwRev = Number.isInteger(mwConflict.server?.rev) ? mwConflict.server.rev : mwRev; mwBaseText = serverText;
    const merged = serverText === draft ? serverText : serverText.replace(/\s+$/, "") + "\n\n---\n\n## 겹친 편집 초안\n\n" + draft;
    mwConflict = null; mwSetValue(merged); mwSetDirty(merged !== serverText); mwWriteDraft(merged); mwAlert(""); mwScheduleSave(20);
  });
  $("#mw-use-server").addEventListener("click", () => {
    if (!mwConflict) return;
    mwWriteDraft(mwConflict.draft); mwRev = Number.isInteger(mwConflict.server?.rev) ? mwConflict.server.rev : mwRev;
    mwBaseText = String(mwConflict.server?.text || ""); mwSetValue(mwBaseText); mwSetDirty(false);
    $("#mw-use-server").hidden = true; $("#mw-keep-both").textContent = "초안 합치기";
    mwAlert("최신본을 표시 중입니다. 겹친 초안도 이 창에 보관되어 있습니다.", { conflict: true });
    $("#mw-use-server").hidden = true;
  });
  addEventListener("blur", () => mwFlush());
  addEventListener("beforeunload", () => { mwFlush(); mwEditor?.dispose(); });
}

export function disconnectMemoWindow() {
  mwPending = null;
  mwSetDirty(!!mwModel && mwModel.getValue() !== mwBaseText);
  mwAlert("서버에 다시 연결하는 중…");
}

export function syncMemoWindowState(value) {
  const record = (value?.records || []).find((item) => item.instanceId === MW_INSTANCE);
  if (record) mwRenderAlwaysOnTop(record.alwaysOnTop);
}

export function showMemoWindowError(error) {
  mwAlert("메모 창을 열지 못했습니다: " + error.message);
}
