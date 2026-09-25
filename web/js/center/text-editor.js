// 소유 범위: Monaco 일반 파일 편집기 상태·모델·뷰 상태, 일반 파일 렌더·dirty 표시·저장, fileview 클릭 이벤트.
// 제공 API: initTextEditor, 일반 파일 렌더·저장·dirty 함수와 Monaco 로드·상태 접근자.
// 의존 대상: core/markdown, sheet 편집·렌더·액션, center/file-routing과 tab-close를 같은 영역 import로 사용한다.
// 유지 조건: 파일별 undo·커서 보존, 외부 변경 충돌 선택, Cmd/Ctrl 저장, fs.write 경로와 기존 분기·순서.
// 영향 범위: 주입받는 $·esc·cssEsc·extOf·fileview·tabstrip·withFileViewTransition·bindAgentKeys·wsSend·isFileLikeKind·showToast와 tab-store·렌더 소유 상태 접근자.

import { fileKindOf } from "../core/file-kinds.js";
import { isMarkdownExtension, markdownWebLink } from "../core/markdown.js";
import { callHook } from "../core/hooks.js";
import { editorPref, toggleEditorPref, subscribeEditorPrefs, monacoPrefOpts } from "../core/editor-prefs.js";
import { registerEditorHost, updateEditorHost } from "../core/editor-hosts.js";
import { bindKeymapAction, shortcutLabel } from "../core/monaco-keys.js";
import { subscribeKeymap } from "../core/keymap.js";
import { bindTabCloseTextEditor } from "./tab-close.js";
import { getActiveTabId, getCenterSpace, getCurrentTabs } from "./tab-store.js";

let $, esc, cssEsc, extOf, fileview, tabstrip;
let withFileViewTransition, bindAgentKeys, wsSend, isFileLikeKind, showToast;
let getRenderedFileOwner, getRenderedFileToken, openWebLink;
let initialized = false;
let fileHostTab = null, fileHostToken = null;

// 막대 도구는 선 아이콘을 쓴다. rail 아이콘과 같은 형식이고 검사가 rail 쪽에서 이미 강제한다.
// 글자 라벨("미니맵"·"줄바꿈")을 늘어놓으면 모드 버튼과 굵기·길이가 섞여 무엇이 도구인지
// 구별되지 않는다. 이름은 title·aria-label 이 담당한다.
const svg = (body) => `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">${body}</svg>`;
// 미니맵: 왼쪽은 본문, 오른쪽 좁은 칸이 그 축소본.
const ICON_MINIMAP = svg('<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/>'
  + '<path d="M10.5 2.5v11"/><path d="M3.5 5.5h4M3.5 8h4M3.5 10.5h2.5"/>'
  + '<path d="M12 5.5h1.5M12 7.5h1.5M12 9.5h1"/>');
// 줄바꿈: 넘친 줄이 꺾여 다음 줄로 이어진다. 메모도 같은 아이콘을 쓴다. 같은 뜻의 버튼이
// 화면마다 다르게 생기면 매번 다시 익혀야 한다.
export const ICON_WRAP = svg('<path d="M2 3.5h12"/><path d="M2 8h9.5a2.5 2.5 0 0 1 0 5H8"/>'
  + '<path d="m9.5 11 -1.5 2 1.5 2"/><path d="M2 12.5h3"/>');

function fileHostEditable() {
  return !!(fileHostTab && fileHostTab === getRenderedFileOwner() && fileHostToken === getRenderedFileToken()
    && fileHostTab.id === getActiveTabId(getCenterSpace())
    && !callHook("mdpreview.presents", fileHostTab)
    && monacoEditor?.getModel() === monacoModels.get(fileHostTab.path));
}

// 서식 막대를 붙일지 정하는 조건은 현재 파일이 마크다운인지다.
// 확장자 판정은 앱 셸의 함수를 그대로 쓴다(md-preview 와 같은 함수). 여기서 다시 구현하면
// 점 없는 이름·숨김 파일에서 두 곳의 판정이 달라진다.
function fileHostMarkdown() {
  return !!(fileHostTab && isMarkdownExtension(extOf(String(fileHostTab.path || ""))));
}

function syncFileHost() {
  updateEditorHost("file", { editable: fileHostEditable(), markdown: fileHostMarkdown(),
    barEl: fileview.querySelector("[data-editor-tools]") });
}

// 마우스를 올렸을 때 뜨는 안내로, 이름과 현재 단축키를 보여준다. 아이콘만 있는 버튼은
// 이 글자 없이는 무엇인지 알 수 없다.
const PREF_KEY_ID = { minimap: "editor-minimap", wrap: "editor-wrap" };
const PREF_LABEL = { minimap: "미니맵", wrap: "줄바꿈" };
export function tipText(label, keyId) {
  const shortcut = keyId ? shortcutLabel(keyId) : "";
  return `${label}${shortcut ? "  " + shortcut : ""}`;
}
// 안내 문구는 켜짐 여부와 무관하고 단축키 표에만 의존하므로 prefs 동기화와 분리한다.
// 한 함수에 섞으면 그 함수를 따로 검사할 때 여기 이름들까지 알아야 한다.
function syncFileTips() {
  for (const button of fileview.querySelectorAll("[data-editor-pref]")) {
    const key = button.dataset.editorPref;
    button.dataset.tip = tipText(PREF_LABEL[key] || key, PREF_KEY_ID[key]);
  }
}
function syncFilePrefs() {
  monacoEditor?.updateOptions(monacoPrefOpts("file"));
  for (const button of fileview.querySelectorAll("[data-editor-pref]")) {
    const enabled = editorPref("file", button.dataset.editorPref);
    button.classList.toggle("on", enabled);
    button.setAttribute("aria-pressed", String(enabled));
  }
}

// 파일 뷰의 편집 엔진은 VSCode 의 Monaco 를 그대로 쓰고, 여기서는 연결만 한다.
// 파일마다 모델을 만들어 탭 전환 시 교체하고(실행취소·커서가 파일별로 보존된다), 변경을 draft에
// 반영하고, 저장을 기존 fs.write 경로로 넘긴다. 하이라이트·검색·다중커서·접기·IME는 엔진이 담당한다.
let monacoEditor = null, monacoReady = null, monacoLibReady = null, monacoHost = null, monacoLoadContext = null;
const monacoModels = new Map();   // 절대경로 → ITextModel
const monacoViewState = new Map(); // 절대경로 → 커서·스크롤 상태

// 모델에 들어가는 텍스트가 사용자 입력인지 구분한다. 코드가 넣는 동안은 아니다.
// draft 는 사용자가 고쳤다는 뜻만 가져야 한다. 외부 내용을 모델에 넣을 때 변경 알림이
// draft 를 채우면 고치지 않은 파일이 편집 중으로 보인다.
let writingExternal = false;
function withoutDraft(run) {
  writingExternal = true;
  try { return run(); } finally { writingExternal = false; }
}
// 외부에서 온 내용을 열려 있는 모델에 넣는다. 커서·되돌리기를 유지한 채 교체하며,
// setValue 로 전체를 바꾸면 보고 있던 위치가 이동한다.
export function applyExternalTextToModel(path, next) {
  const model = monacoModels.get(path);
  if (!model || model.isDisposed() || model.getValue() === next) return;
  withoutDraft(() => model.pushEditOperations([], [{ range: model.getFullModelRange(), text: next }], () => null));
}
// 「수정 사항 모두 취소」처럼 되돌리기 기록까지 버리고 전체를 되돌릴 때 쓴다. 사용자 입력이 아니다.
export function resetModelTextExternally(path, text) {
  const model = monacoModels.get(path);
  if (!model || model.isDisposed()) return;
  withoutDraft(() => model.setValue(text));
}

export function initTextEditor(deps) {
  ({ $, esc, cssEsc, extOf, fileview, tabstrip,
    withFileViewTransition, bindAgentKeys, wsSend, isFileLikeKind, showToast,
    getRenderedFileOwner, getRenderedFileToken, openWebLink } = deps);
  bindTabCloseTextEditor({
    isTextTabDirty, saveFileTab, renderFileView, monacoLangFor, disposeClosedFileModel,
    resetModelTextExternally,
    getMonacoModels, getMonacoViewState, getMonacoEditor, getMonacoRuntime,
  });
  if (initialized) return;
  initialized = true;
  fileview.addEventListener("click", fileviewClickHandler);
  subscribeEditorPrefs((scope) => { if (scope === "file") syncFilePrefs(); });
  // 사용자가 키를 바꾸면 안내도 함께 갱신한다.
  subscribeKeymap(() => syncFileTips());
}

function monacoHostEl() {
  if (!monacoHost) {
    monacoHost = document.createElement("div");
    monacoHost.id = "editor-host";
    monacoHost.style.cssText = "position:absolute;inset:0;";
    // body에 붙이지 않는다. inset:0 절대배치라 body에 있으면 창 전체를 덮는다. 파일을 열 때는
    // 곧바로 파일 뷰로 옮겨지지만, 다른 곳에서 편집기를 먼저 만들면 옮기는 코드가 없어 그대로
    // 남아 화면 전체를 가린다. 붙이는 것은 파일 뷰(#editor-wrap)가 한다.
  }
  return monacoHost;
}
export function getMonacoModels() { return monacoModels; }
export function getMonacoViewState() { return monacoViewState; }
export function getMonacoEditor() { return monacoEditor; }
export function getMonacoRuntime() { return window.monaco; }
export function monacoTheme() {
  const cs = getComputedStyle(document.documentElement);
  const pick = (n, d) => (cs.getPropertyValue(n) || "").trim() || d;
  const light = document.documentElement.getAttribute("data-theme") === "light";
  monaco.editor.defineTheme("ac", {
    base: light ? "vs" : "vs-dark", inherit: true, rules: [],
    colors: {
      "editor.background": pick("--surface", light ? "#ffffff" : "#0e1319"),
      // Monaco 기본 슬라이더는 거의 투명하므로 앱의 다른 스크롤바와 같은 농도로 맞춘다.
      "scrollbarSlider.background": light ? "#3F5E6C66" : "#B9DCF066",
      "scrollbarSlider.hoverBackground": light ? "#3F5E6C99" : "#B9DCF099",
      "scrollbarSlider.activeBackground": light ? "#3F5E6CCC" : "#B9DCF0CC",
      "editorOverviewRuler.border": "#00000000",
    },
  });
  return "ac";
}
// 확장자 → 언어. 엔진이 아는 목록을 그대로 쓴다(우리가 표를 다시 만들지 않는다).
export function monacoLangFor(filePath) {
  const ext = "." + extOf(filePath);
  const base = filePath.split("/").pop();
  for (const l of monaco.languages.getLanguages()) {
    if ((l.extensions || []).some((e) => e.toLowerCase() === ext)) return l.id;
    if ((l.filenames || []).some((f) => f === base)) return l.id;
  }
  return "plaintext";
}
// 라이브러리 로드와 "파일 편집기 만들기"는 다른 일이다. 메모처럼 Monaco만 필요한 쪽이 이걸 부르면
// 파일 편집기까지 딸려 만들어져 그 호스트가 화면을 덮는다(위 monacoHostEl 주석). 그래서 나눈다.
// 편집기 안 링크를 누르면 Monaco 는 window.open 으로 열고, 창의 열기 처리기는 그 주소를 외부 브라우저로
// 보낸다. 메모와 파일 편집기가 이 로더를 함께 쓰므로 여기서 한 번 등록해 웹 주소를 미리보기 링크와 같은
// 길(Iris 안)로 연다. 웹 주소가 아니면 Monaco 기본 동작에 맡긴다.
function registerWebLinkOpener() {
  window.monaco?.editor?.registerLinkOpener?.({
    open(uri) {
      const href = markdownWebLink(uri.toString(true));
      if (!href || !openWebLink) return false;
      openWebLink(href);
      return true;
    },
  });
}

export function ensureMonacoLib() {
  if (monacoLibReady) return monacoLibReady;
  monacoLibReady = new Promise((resolve) => {
    // 로더는 지연 주입한다. Monaco의 AMD 로더가 define.amd를 만들면, 그 뒤에 로드되는 UMD 스크립트는
    // 전역 대신 AMD로 등록된다. xterm.js가 그 판정을 한다(vendor 확인). 이미 전역 등록이
    // 끝난 시점(파일을 처음 열 때)에 넣어 그 충돌 자체를 없앤다.
    const boot = () => {
      require.config({ paths: { vs: "/vendor/monaco/vs" } });
    // 워커는 같은 origin이라 그대로 띄운다. 워커가 있어야 TS·JSON 언어 서비스가 동작한다.
    window.MonacoEnvironment = { getWorkerUrl: () => "/vendor/monaco/vs/base/worker/workerMain.js" };
      require(["vs/editor/editor.main"], () => { registerWebLinkOpener(); resolve(); });
    };
    if (window.require && window.require.config) { boot(); return; }
    const sc = document.createElement("script");
    sc.src = "/vendor/monaco/vs/loader.js";
    sc.onload = boot;
    const { owner, token } = monacoLoadContext || {};
    sc.onerror = () => {
      if (owner !== getRenderedFileOwner()) return;
      if (token !== getRenderedFileToken()) return;
      withFileViewTransition(owner, { expectedOwner: owner, expectedToken: token }, () => {
        fileview.innerHTML = '<div class="fv-loading">편집기(Monaco)를 불러오지 못했습니다(web/vendor/monaco 확인).</div>';
      });
    };
    document.head.appendChild(sc);
  });
  return monacoLibReady;
}
// 파일 편집기. 호출자는 부르기 전에 호스트를 파일 뷰에 붙여둔다(renderFileView의 #editor-wrap).
function ensureMonaco(owner, token) {
  if (monacoReady) return monacoReady;
  monacoLoadContext = { owner, token };
  monacoReady = ensureMonacoLib().then(() => {
    monacoEditor = monaco.editor.create(monacoHostEl(), {
      theme: monacoTheme(), automaticLayout: true, fontSize: 12.5,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono").trim(),
      ...monacoPrefOpts("file"), scrollBeyondLastLine: false, renderWhitespace: "selection",
      tabSize: 2, smoothScrolling: true,
      // 위쪽 여백은 떠 있는 도구 상자가 놓이는 영역이다. 없으면 첫 줄이 그 아래로 가려진다.
      padding: { top: 40, bottom: 8 },
      // Monaco는 스크롤바를 직접 그려 위 CSS가 적용되지 않으므로, 굵기·항상 표시를 같은 값으로 맞춘다.
      scrollbar: { verticalScrollbarSize: 12, horizontalScrollbarSize: 12, useShadows: false,
        vertical: "visible", horizontal: "visible" },
    });
    // Cmd 와 Ctrl 을 맞바꾼 키보드 배치가 있어, 어느 쪽으로 눌러도 저장되도록 둘 다 등록한다.
    monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveActiveFile());
    monacoEditor.addCommand(monaco.KeyMod.WinCtrl | monaco.KeyCode.KeyS, () => saveActiveFile());
    bindAgentKeys(monacoEditor);
    registerEditorHost({ id: "file", editor: monacoEditor, kind: "file", editable: false, markdown: false, barEl: null });
    monacoEditor.onDidChangeModel(syncFileHost);
    monacoEditor.onDidFocusEditorText(syncFileHost);
    bindKeymapAction(monacoEditor, "editor-minimap", () => { if (fileHostEditable()) toggleEditorPref("file", "minimap"); });
    bindKeymapAction(monacoEditor, "editor-wrap", () => { if (fileHostEditable()) toggleEditorPref("file", "wrap"); });
    monacoEditor.onDidChangeModelContent(() => {
      if (writingExternal || !fileHostEditable()) return;   // 코드가 넣은 텍스트이므로 사용자 편집으로 보지 않는다
      const centerSpace = getCenterSpace();
      const t2 = getCurrentTabs().find((x) => x.id === getActiveTabId(centerSpace));
      if (!t2 || t2.kind !== "file" || !monacoEditor.getModel()) return;
      t2.draft = monacoEditor.getModel().getValue();
      markFileDirty(t2);
    });
  });
  return monacoReady;
}
export function markFileDirty(t) {
  const d = t.draft != null && t.draft !== t.content;
  // 저장 버튼은 저장할 변경이 있을 때만 존재하므로, 상태를 바꾸는 대신 직접 넣고 뺀다.
  const bar = fileview.querySelector(".fv-bar");
  if (bar) {
    let sv = bar.querySelector('[data-act="save"]');
    if (d && !sv) {
      sv = document.createElement("button");
      sv.dataset.act = "save"; sv.className = "hot"; sv.textContent = "저장";
      const nm = bar.querySelector(".fv-name");
      bar.insertBefore(sv, nm || null);
    } else if (!d && sv) sv.remove();
  }
  const nm = fileview.querySelector(".fv-name"); if (nm) nm.textContent = t.label;
  markTabDirty(t.id, d);
}
// 편집 중인 파일은 탭 앞에 점으로 표시한다(VSCode 와 같다). 그러지 않으면 탭이 여럿일 때
// 어느 것이 저장되지 않았는지 본문을 열어야 알 수 있다.
export function markTabDirty(tabId, d) {
  const chip = tabstrip.querySelector(`.ctab[data-tab="${cssEsc(tabId)}"]`);
  if (!chip) return;
  chip.classList.toggle("dirty", !!d);
  let dot = chip.querySelector(".cdirty");
  if (d && !dot) { dot = document.createElement("span"); dot.className = "cdirty"; dot.title = "저장 안 됨"; chip.insertBefore(dot, chip.querySelector(".ckind")?.nextSibling || chip.firstChild); }
  else if (!d && dot) dot.remove();
}
function modelFor(t) {
  let m = monacoModels.get(t.path);
  if (!m || m.isDisposed()) {
    m = monaco.editor.createModel(t.draft != null ? t.draft : t.content, monacoLangFor(t.path), monaco.Uri.file(t.path));
    monacoModels.set(t.path, m);
  }
  return m;
}
function disposeFileModel(filePath) {
  const m = monacoModels.get(filePath);
  if (m && !m.isDisposed()) { try { m.dispose(); } catch (e) {} }
  monacoModels.delete(filePath); monacoViewState.delete(filePath);
}
export function disposeClosedFileModel(id) {
  disposeFileModel(String(id).slice(5));
}
export function isTextTabDirty(t) {
  const dirty = t.draft != null && t.draft !== t.content;
  return dirty;
}
export function renderFileView(t, options) {
  return withFileViewTransition(t, options || {}, (renderToken) => renderFileViewBody(t, renderToken));
}
export function renderFileViewBody(t, renderToken) {
  fileHostTab = null;
  syncFileHost();
  callHook("viewer.closePopups");
  // 이 탭을 뷰어가 그리면 여기서 끝난다. 앱 셸은 어느 뷰어인지도, 어떤 필드로 판정하는지도 모른다.
  if (callHook("viewer.renderBody", t)) return;
  if (t.content == null) { fileview.innerHTML = `<div class="fv-loading">불러오는 중…</div>`; return; }
  const dirty = t.draft != null && t.draft !== t.content;
  // 저장 버튼은 저장할 변경이 있을 때만 표시한다. 항상 떠 있는 비활성 버튼은 공간만 차지한다.
  const save = dirty ? `<button data-act="save" class="hot">저장</button>` : "";
  // 마크다운의 다른 표시 형태는 그 기능이 그린다. 끄면 버튼도 화면도 없다.
  const mdToggle = callHook("mdpreview.barHtml", t) || "";
  // 표시 옵션과 서식은 모드 전환(원문·미리보기)과 성격이 달라 막대 오른쪽 영역에 배치한다.
  // 한 줄에 섞으면 현재 보기 모드와 도구를 구별하기 어렵다.
  const prefsBar = '<span class="editor-view-opts">' + [
    ["minimap", "미니맵", ICON_MINIMAP, "editor-minimap"], ["wrap", "줄바꿈", ICON_WRAP, "editor-wrap"],
  ].map(([key, label, icon, keyId]) =>
    `<button type="button" class="etool ${editorPref("file", key) ? "on" : ""}" data-editor-pref="${key}"`
    + ` data-tip="${tipText(label, keyId)}" aria-label="${label}" aria-pressed="${editorPref("file", key)}">${icon}</button>`).join("") + "</span>";
  // csv·tsv는 텍스트 파일이라 표에서 원문으로 돌아오는 경로가 있어야 한다(원문에서는 편집·저장이 그대로 된다).
  const sheetToggle = (fileKindOf(t.path) || {}).textForm?.(t.path) ? `<button data-sv="text" class="on">원문</button><button data-sv="table">표</button>` : "";
  // 외부에서 바뀌어도 여기서 확인하지 않는다. 편집 중이 아니면 교체하고, 편집 중이면 그대로 둔다.
  // VSCode 도 변경 시점에는 알리지 않고 저장하려는 순간에만 막는다(saveActiveFile 의 conflict).
  const gone = t.gone ? `<div class="fv-conflict">이 파일이 디스크에서 사라졌습니다. 저장하면 다시 만들어집니다.</div>` : "";
  const barHtml = `<div class="fv-bar">`
    + `<span class="fv-modes">${mdToggle}${sheetToggle}</span>`
    + `<span class="fv-name">${esc(t.label)}${dirty ? " •" : ""}${t.gone ? " (삭제됨)" : ""}</span>`
    + `${save}</div>${gone}`;
  // 도구는 막대가 아니라 본문 위 오른쪽 위 모서리에 띄운다. 막대에 함께
  // 두면 현재 보기 모드와 도구가 한 줄에 섞인다.
  const floatTools = `<span class="editor-float"><span class="editor-controls" data-editor-tools></span>${prefsBar}</span>`;
  // 뼈대는 매번 새로 그리되 Monaco 호스트는 유지한 채 옮긴다. innerHTML 을 통째로 바꾸면 편집기가 사라진다.
  fileview.innerHTML = barHtml + (callHook("mdpreview.paneHtml", t) || "")
    + `<div class="editor-wrap" id="editor-wrap">${floatTools}</div>`;
  const wrap = $("#editor-wrap");
  wrap.appendChild(monacoHostEl());
  // 그 기능이 그렸으면 텍스트 편집기는 띄우지 않는다.
  if (callHook("mdpreview.render", t, wrap)) return;
  wrap.classList.remove("hidden");
  ensureMonaco(t, renderToken).then(() => {
    if (t !== getRenderedFileOwner() || renderToken !== getRenderedFileToken()
      || t.id !== getActiveTabId(getCenterSpace()) || callHook("mdpreview.presents", t)) return;
    fileHostTab = t; fileHostToken = renderToken;
    const prev = monacoEditor.getModel();
    if (prev && prev.uri && prev.uri.fsPath !== t.path) {
      monacoViewState.set(prev.uri.fsPath, monacoEditor.saveViewState());
    }
    const m = modelFor(t);
    if (prev !== m) {
      monacoEditor.setModel(m);
      const vs = monacoViewState.get(t.path); if (vs) monacoEditor.restoreViewState(vs);
    }
    // 디스크에서 다시 읽어온 내용이 모델과 다르면(외부 변경·저장 반영) 맞춘다. 편집 중이면 손대지 않는다.
    if (t.draft == null && m.getValue() !== t.content) withoutDraft(() => m.setValue(t.content));
    monaco.editor.setTheme(monacoTheme());
    const controls = fileview.querySelector("[data-editor-tools]");
    if (!controls.querySelector("[data-mdformat-bar]")) controls.insertAdjacentHTML("beforeend",
      callHook("mdformat.barHtml", { editable: fileHostEditable(), markdown: fileHostMarkdown() }) || "");
    syncFileHost();
    monacoEditor.focus();
  });
}
function fileviewClickHandler(e) {
  const centerSpace = getCenterSpace();
  const t = getCurrentTabs().find((x) => x.id === getActiveTabId(centerSpace)); if (!t) return;
  syncFileHost();
  if (callHook("mdformat.click", e.target, "file")) return;
  const pref = e.target.closest("[data-editor-pref]");
  if (pref) { toggleEditorPref("file", pref.dataset.editorPref); return; }
  if (callHook("mdpreview.click", e.target, t)) { renderFileView(t); return; }
  const act = e.target.closest("[data-act]"); if (!act) return;
  if (act.dataset.act === "save") saveActiveFile();
}
// 저장하려는 순간 디스크가 이미 달라진 경우다. 변경 시점이 아니라 여기서만 확인을 받는다.
// VSCode 의 "The content of the file is newer" 알림에 해당한다.
//
// 한 번에 하나만 띄운다. 「모두 닫기」는 저장을 한꺼번에 걸어서, 충돌이 둘 이상이면 대화상자가
// 겹쳐 뜨고 어느 파일에 답하는지 알 수 없다. 순서를 세워 파일 하나씩 확인한다.
let overwriteQueue = Promise.resolve();
function askOverwrite(name) {
  const next = overwriteQueue.then(() => askOverwriteNow(name));
  overwriteQueue = next.catch(() => {});
  return next;
}
function askOverwriteNow(name) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "askwrap";
    wrap.innerHTML = `<div class="askbox">
      <div class="asktitle">저장하지 못했습니다</div>
      <div class="asknote">${esc(name)}<br>이 파일이 밖에서 바뀌었습니다. 덮어쓰면 그 변경은 사라집니다.</div>
      <div class="askrow"><button data-act="cancel">취소</button><button class="primary" data-act="overwrite">덮어쓰기</button></div>
    </div>`;
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; wrap.remove(); resolve(v); };
    wrap.addEventListener("click", (event) => {
      if (event.target === wrap) { finish(false); return; }
      const button = event.target.closest("button[data-act]");
      if (button) finish(button.dataset.act === "overwrite");
    });
    document.body.appendChild(wrap);
  });
}
// 저장 한 번. 읽어 둔 기준(t.revision)을 함께 보내 그사이 디스크가 바뀌었으면 쓰지 않게 한다.
// 서버가 conflict 로 돌려주면 사용자에게 한 번 확인하고, 덮어쓰기를 고르면 기준 없이 다시 보낸다.
// baselineRevision 이 없으면 서버는 검사하지 않으며, 그것이 덮어쓰기 경로다.
function sendFileSave(t, space, snapshot, baselineRevision, overwrite) {
  const message = { type: "fs.write", path: t.path, content: snapshot, space, tabId: t.id, reason: "save" };
  if (typeof baselineRevision === "string") message.baselineRevision = baselineRevision;
  if (overwrite) message.overwrite = true;
  const pending = wsSend(message);
  const saving = { requestId: pending.requestId, snapshot, path: t.path, promise: null };
  t._saving = saving;
  const completion = (async () => {
    const response = await pending;
    if (response && response.conflict) {
      if (t._saving === saving) t._saving = null;
      if (!(await askOverwrite(t.label || t.path))) { showToast("저장하지 않았습니다. 밖에서 바뀐 내용을 그대로 뒀습니다"); return response; }
      // 기준은 그대로 들고 가고 덮어쓰기라고 밝힌다. 서버가 준 diskRevision 을 기준으로 삼으면
      // 그다음 평범한 저장이 남의 변경 위에 조용히 쓰게 된다.
      return await sendFileSave(t, space, snapshot, baselineRevision, true);
    }
    if (response.error) throw new Error(response.error);
    return response;
  })().catch((error) => {
    if (t._saving === saving) t._saving = null;
    showToast("저장 실패: " + error.message);
    throw error;
  }).finally(() => { if (t._saveInFlight === completion) t._saveInFlight = null; });
  saving.promise = completion;
  t._saveInFlight = completion;
  return completion;
}
export function saveFileTab(t, space) {
  if (t._saveInFlight) return t._saveInFlight;
  if (t.draft == null || t.draft === t.content) return; // 변경 없음(md 원문 편집·일반 편집 공통)
  return sendFileSave(t, space || getCenterSpace(), t.draft, t.revision);
}
// 활성 파일 저장 (⌘S/Ctrl+S 또는 저장 버튼).
export function saveActiveFile() {
  const centerSpace = getCenterSpace();
  const t = getCurrentTabs().find((x) => x.id === getActiveTabId(centerSpace));
  if (!t || !isFileLikeKind(t.kind)) return;
  // 이 탭이 뷰어의 것이면 뷰어가 저장한다. undefined 는 뷰어의 탭이 아니라는 답이라
  // 그때만 아래 텍스트 저장으로 내려간다.
  const mine = callHook("viewer.saveTab", t, centerSpace);
  if (mine !== undefined) return mine;
  // 전송은 saveFileTab 한 곳에서만 한다. 여기서 fs.write 를 따로 만들면 space·tabId·reason 이
  // 빠져 main 의 보정에 의존하게 된다.
  return saveFileTab(t, centerSpace);
}
