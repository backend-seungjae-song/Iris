// 중앙 스페이스 메모의 아래 도크·메모 페이지 Monaco 화면과 열기/닫기 상호작용을 맡는다.
//
// 소유 범위
//   markdown 보기 모드, 하나의 Monaco model, 두 슬롯별 editor·host, editor 준비·설정·boot 상태,
//   메모 높이·미리보기·새 창 버튼의 DOM listener.
//
// 제공 API
//   initMemo·bootMemo, 중앙 메모 렌더·미리보기·값 설정과 markdown 모드 질의.
//
// 의존 대상
//   panel/memo-store의 상태 질의·명령, center/text-editor의 공용 Monaco loader/theme,
//   core/markdown을 import한다. main 소유 $·blog·wsSend·toast·모드·스페이스 목록·request id·
//   Monaco 공용 키 배선·acHost는 init에서 받는다.
//
// 유지 조건
//   #memo-slot과 #mm-slot은 editor를 하나씩 가지되 같은 model 하나를 공유한다. Monaco는 화면이
//   보이고 main 평가가 끝난 뒤 공용 loader로만 띄우며, listener 등록과 boot timer의 main 위치를 지킨다.
//
// 영향 범위
//   main.js의 panel 접기·스페이스 전환·평가 완료 배선, panel/memo-store.js의 화면 callback,
//   panel/memo-admin.js의 #mm-slot 생성·값/미리보기 호출, center/text-editor.js의 Monaco loader/theme,
//   core/markdown.js와 #panel-memo/#memo-slot/#mm-slot DOM·메모 CSS.
//   현재 목록 확인: node bin/importers.mjs web/js/panel/memo.js

import { ensureMonacoLib, monacoTheme, ICON_WRAP } from "../center/text-editor.js";
import { mdToHtml } from "../core/markdown.js";
import { editorPref, toggleEditorPref, subscribeEditorPrefs, monacoPrefOpts } from "../core/editor-prefs.js";
import { registerEditorHost, updateEditorHost } from "../core/editor-hosts.js";
import { bindKeymapAction, shortcutLabel } from "../core/monaco-keys.js";
import { subscribeKeymap } from "../core/keymap.js";
import {
  advanceMemoRevision, getMemoShownSpace, hasMemoDraft, markDirty, memoSpace, memoTextOf,
  registerMemoStoreView, rememberMemoCreate, setMemoShownSpace, updateMemoText,
} from "./memo-store.js";

let $, blog, wsSend, showToast, memoReqId, orderedSpaces, bindAgentKeys, acHost;
let AUX_MODE = false;

// 원문은 파일 쪽과 같은 편집기(Monaco)를 markdown 모델로 띄운다. ##·**·목록에 색이 붙는다.
// 미리보기는 파일 쪽과 같은 처리기(mdToHtml)·같은 .md-body 스타일. 둘은 같은 글의 두 모습이다.
let memoMdMode = "raw";
// 메모가 나타날 수 있는 위치는 둘이다. 아래 도크(#memo-slot)와 메모 화면(#mm-slot)이며, 둘은 동시에
// 화면에 있을 수 있다(메모 화면을 중앙 탭으로 연 채 도크도 펼친 상태). 편집기 하나를 만들어
// 두 위치로 옮기면 선택 규칙이 화면 우선이라 도크가 빈 상태로 남는다.
// 지금은 모델 하나를 두 편집기가 함께 본다. Monaco가 지원하는 방식이고, 어느 쪽에서 입력해도
// 같은 모델이라 동기화할 것이 없다.
let memoModel = null, memoEdReady = null, memoSetting = false;
const memoEds = new Map();   // 슬롯 id → { host, editor }
const MEMO_SLOTS = ["memo-slot", "mm-slot"];

export function initMemo(deps) {
  ({ $, blog, wsSend, showToast, memoReqId, orderedSpaces, bindAgentKeys, acHost } = deps);
  AUX_MODE = !!deps.AUX_MODE;
  memoMdMode = localStorage.getItem("ac.memoMd") || "raw";
  registerMemoStoreView({ setMemoValue, applyMemoServerText, renderMemo, memoHasFocus, renderMemoDirty });
  wireMemo();
}

export function getMemoMdMode() { return memoMdMode; }
function memoAnyEditor() { for (const e of memoEds.values()) return e.editor; return null; }
function memoEachEditor(fn) { for (const e of memoEds.values()) { try { fn(e.editor); } catch {} } }
function memoOpts() {
  return { model: memoModel, theme: monacoTheme(), automaticLayout: true, fontSize: 12.5,
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono").trim(),
    ...monacoPrefOpts("memo"), lineNumbers: "off", folding: false,
    readOnly: !getMemoShownSpace(),
    // 한글을 조합하는 동안 커서 앞 글자가 겹쳐 보이는 문제를 막는다. 소프트 랩이
    // 걸린 줄에서 입력하면 접히기 전 텍스트가 앞에 생기고 띄어쓰면 사라진다. 원인은 Monaco가
    // 화면 뒤에 두는 입력 칸이다. 접근성 자동 감지 상태에서는 커서 앞 단어를 담고 줄 너비만큼
    // 넓어진 채(확인 결과: "씁니다"·369px) 화면에 올라와, 조합 중 그 칸이 그대로 보인다.
    // 끄면 그 칸이 빈 값·1px로 줄어 겹치지 않는다(확인). 줄바꿈 설정과 독립해 유지한다.
    accessibilitySupport: "off",
    // 메모에는 자동완성을 두지 않는다. 메모는 코드가
    // 아니라 글이라, 문서 안의 단어를 다시 제안하는 것이 방해가 된다. 한글을 조합하는
    // 중에도 팝업이 떠서 Enter·Tab 이 제안 확정으로 처리된다. 여섯 가지를 모두 막는다: 빠른 제안 ·
    // 트리거 문자 · 단어 기반 · Enter 확정 · Tab 확정 · 인자 힌트. 하나라도 남기면 그 경로로 다시 뜬다.
    quickSuggestions: false,
    suggestOnTriggerCharacters: false,
    wordBasedSuggestions: "off",
    acceptSuggestionOnEnter: "off",
    tabCompletion: "off",
    parameterHints: { enabled: false },
    // 글이 위아래 테두리에 붙지 않게 3px씩 준다. .memo-slot 에 CSS 패딩을 주는 방법은 통하지 않는다.
    // 편집기를 담은 판이 inset:0 절대배치라 containing block이 패딩 상자여서 패딩 위를 그대로 덮는다.
    // 편집기 옵션으로 줘야 글만 밀리고 스크롤바는 위아래 끝까지 남는다.
    // 위쪽은 떠 있는 손잡이 상자가 놓이는 영역이다. 없으면 첫 줄이 그 아래로 들어간다.
    padding: { top: 36, bottom: 3 },
    scrollBeyondLastLine: false, renderLineHighlight: "none", overviewRulerLanes: 0,
    scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, useShadows: false } };
}
function memoHostId(slotId) { return slotId === "memo-slot" ? "memo-dock" : "memo-page"; }
// 손잡이는 메모 머리글이 아니라 글 위에 뜬다. 파일 편집기와 같은 위치·같은 형태다.
// 머리글에는 이미 원문·미리보기와 창 만들기 버튼이 있어서, 거기에
// 더 넣으면 무엇이 상태이고 무엇이 손잡이인지 구분되지 않는다.
function memoFloat(slotId) {
  const slot = document.getElementById(slotId);
  if (!slot) return null;
  let float = slot.querySelector(".editor-float");
  if (!float) {
    float = document.createElement("span");
    float.className = "editor-float";
    float.innerHTML = '<span class="editor-controls" data-memo-tools></span>'
      + `<span class="editor-view-opts"><button type="button" class="etool" data-memo-wrap aria-label="줄바꿈">${ICON_WRAP}</button></span>`;
    slot.appendChild(float);
  }
  return float;
}
function syncMemoControls() {
  for (const id of MEMO_SLOTS) {
    const float = memoFloat(id);
    if (!float) continue;
    const controls = float.querySelector("[data-memo-wrap]");
    controls.classList.toggle("on", editorPref("memo", "wrap"));
    controls.setAttribute("aria-pressed", String(editorPref("memo", "wrap")));
    // 마우스를 올렸을 때 뜨는 안내: 이름과 현재 단축키.
    const shortcut = shortcutLabel("editor-wrap");
    controls.dataset.tip = `줄바꿈${shortcut ? "  " + shortcut : ""}`;
    updateEditorHost(memoHostId(id), { editable: memoMdMode !== "preview" && !!getMemoShownSpace(),
      barEl: float.querySelector("[data-memo-tools]") });
  }
}
// 지금 화면에 있는 슬롯마다 편집기를 두고, 사라진 슬롯의 것은 버린다.
function syncMemoEditors() {
  if (!memoModel) return;
  for (const id of MEMO_SLOTS) {
    const slot = document.getElementById(id);
    const live = slot && slot.isConnected && slot.style.display !== "none";
    const cur = memoEds.get(id);
    if (!live) { if (cur) { cur.unregister(); try { cur.editor.dispose(); } catch {} cur.host.remove(); memoEds.delete(id); } continue; }
    if (cur && cur.host.parentElement === slot) continue;
    if (cur) { cur.unregister(); try { cur.editor.dispose(); } catch {} cur.host.remove(); memoEds.delete(id); }
    const host = document.createElement("div");
    // 슬롯 안에만 넣는다. inset:0 절대배치라 body에 달면 화면 전체를 덮어 앱도
    //   브라우저 탭도 까맣게 가린다.
    host.className = "memo-editor-host";
    host.style.cssText = "position:absolute;inset:0;";
    slot.appendChild(host);
    const ed = monaco.editor.create(host, memoOpts());
    bindAgentKeys(ed);
    memoEds.set(id, { host, editor: ed });
    // 메모는 기본이 마크다운이다. 확장자가 없고 미리보기도 마크다운으로 그린다. 그래서
    // 서식 막대는 여기서 항상 표시한다(파일 쪽만 .md 를 구분한다).
    const unregister = registerEditorHost({ id: memoHostId(id), editor: ed, kind: "memo", markdown: true,
      editable: memoMdMode !== "preview" && !!getMemoShownSpace(),
      barEl: memoFloat(id)?.querySelector("[data-memo-tools]") || null });
    memoEds.get(id).unregister = unregister;
    bindKeymapAction(ed, "editor-wrap", () => toggleEditorPref("memo", "wrap"));
  }
}
function placeMemoEditor() {
  const has = MEMO_SLOTS.some((id) => document.getElementById(id));
  if (has) syncMemoEditors();
  return has;
}
// 스크립트 평가가 끝났는지 나타낸다. var로 둔다. let/const는 선언 전 접근이 예외(TDZ)라 이 검사 자체가 실패한다.
// 필요한 이유: 메모는 시작 시점에 그려지는데 Monaco 쪽 상태가 준비되기 전 ensureMonacoLib를 부르면
// 스크립트가 중단되고 창이 검게 뜬다(확인). 그래서 편집기 생성은 main 평가가 끝난 뒤로 미룬다.
var memoBootReady = false;
// 메모가 실제로 보이는지 판정한다. 이 조건 없이 만들면 시작하자마자 Monaco 로더가 주입되는데, 이 코드베이스는
// 그것을 피한다. AMD 로더가 define.amd를 만들면 그 뒤 로드되는 UMD 스크립트(xterm)가 전역 대신
// AMD로 등록된다(ensureMonaco 주석). 파일을 열 때처럼, 메모도 펼쳤을 때 처음 만든다.
function memoVisible() {
  if ($("#mm-slot")) return true;                       // 메모 화면이 열려 있다
  const p = $("#panel-memo");
  return !!(p && !p.classList.contains("collapsed"));
}
function ensureMemoEditor() {
  if (memoEdReady) return memoEdReady;
  if (!memoBootReady) return Promise.resolve(null);    // 평가가 끝나기 전에는 Monaco 쪽을 호출하지 않는다
  if (AUX_MODE) return Promise.resolve(null);          // 분리 브라우저/메모 창엔 중앙 도크 편집기가 없다
  if (!memoVisible()) return Promise.resolve(null);    // 펼치기 전에는 만들지 않는다
  if (!placeMemoEditor()) return Promise.resolve(null); // 붙일 슬롯이 생긴 뒤에 만든다
  memoEdReady = ensureMonacoLib().then(() => {
    // 모델은 하나다. 편집기가 몇 개든 이 모델을 함께 보므로 변경 감지도 여기 한 번만 건다.
    const shownSpace = getMemoShownSpace();
    memoModel = monaco.editor.createModel(shownSpace ? memoTextOf(shownSpace) : "", "markdown");
    memoModel.onDidChangeContent(() => { if (!memoSetting) onMemoInput(memoModel.getValue()); });
    syncMemoEditors();
    blog("memo editor ready");
    return memoAnyEditor();
  });
  return memoEdReady;
}
function memoHasFocus() { for (const e of memoEds.values()) { try { if (e.editor.hasTextFocus()) return true; } catch {} } return false; }
function memoValue() { const shownSpace = getMemoShownSpace(); return memoModel ? memoModel.getValue() : (shownSpace ? memoTextOf(shownSpace) : ""); }
export function setMemoValue(v) {
  if (!memoModel) { ensureMemoEditor(); return; }   // 뜨면서 현재 스페이스 값으로 채운다
  memoSetting = true;
  try { if (memoModel.getValue() !== v) memoModel.setValue(v); } finally { memoSetting = false; }
}
function applyMemoServerText(v) {
  if (memoModel && memoModel.getValue() !== v) setMemoValue(v);
}
// 편집 반영: 도크와 메모 화면 어느 쪽에서 입력해도 같은 경로로 간다.
function onMemoInput(text) {
  const sp = getMemoShownSpace(); if (!sp) return;
  advanceMemoRevision();
  // debounce보다 먼저 localStorage에 적는다. 앱이 이 줄 다음에 종료돼도 다음 연결에서 다시 보낸다.
  updateMemoText(sp, text);
}
export function renderMemoPreview() {
  const preview = memoMdMode === "preview";
  const text = memoValue();
  for (const [slotId, pvId] of [["#memo-slot", "#memo-preview"], ["#mm-slot", "#mm-preview"]]) {
    const slot = $(slotId), pv = $(pvId); if (!slot || !pv) continue;
    pv.hidden = !preview;
    slot.style.display = preview ? "none" : "block";
    if (preview) pv.innerHTML = mdToHtml(text || "");
  }
  if (!preview && memoVisible()) { ensureMemoEditor(); placeMemoEditor(); }
  syncMemoControls();
  for (const b of document.querySelectorAll("[data-memo-md]")) b.classList.toggle("on", b.dataset.memoMd === memoMdMode);
}
export function renderMemo() {
  const meta = $("#memo-meta");
  const sp = memoSpace();
  if (sp !== getMemoShownSpace()) {         // 스페이스가 바뀌면 그 스페이스의 메모로 교체한다
    setMemoShownSpace(sp);
    setMemoValue(sp ? memoTextOf(sp) : "");
    memoEachEditor((ed) => ed.updateOptions({ readOnly: !sp }));
    markDirty(hasMemoDraft(sp));
  }
  renderMemoPreview();
  if (meta) {
    const s = orderedSpaces().find((x) => x.id === sp);
    meta.textContent = sp ? (s ? s.label : sp) : "스페이스 선택";
  }
}
// 저장되지 않은 편집은 파일 탭과 같은 표시로 알린다. 자동 저장이라 잠깐 떴다 사라지는 것이 정상이고,
// 계속 떠 있으면 저장이 안 되고 있다는 뜻이다.
function renderMemoDirty(d) {
  const head = document.querySelector('#panel-memo .panel-head'); if (!head) return;
  head.classList.toggle("dirty", !!d);
  let dot = head.querySelector(".cdirty");
  if (d && !dot) { dot = document.createElement("span"); dot.className = "cdirty"; head.insertBefore(dot, head.querySelector("#memo-meta")); }
  else if (!d && dot) dot.remove();
}
function wireMemo() {
  subscribeEditorPrefs((scope) => {
    if (scope !== "memo") return;
    memoEachEditor((editor) => editor.updateOptions(monacoPrefOpts("memo")));
    syncMemoControls();
  });
  // 사용자가 키를 바꾸면 안내도 함께 바뀐다.
  subscribeKeymap(() => syncMemoControls());
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-memo-wrap]");
    if (!button) return;
    event.preventDefault(); event.stopPropagation();
    toggleEditorPref("memo", "wrap");
  }, true);
  // 높이 조절: 편집기에는 textarea의 resize:vertical 이 없으므로 손잡이를 직접 둔다.
  const applyMemoH = (px) => document.documentElement.style.setProperty("--memo-h", Math.round(px) + "px");
  // 현재 높이는 변수에서 읽는다. 슬롯을 측정하지 않는 이유는, 미리보기 모드에서 슬롯이
  // display:none 이라 측정값이 0이 되어 손잡이를 잡는 순간 높이가 최소값으로 바뀌기 때문이다.
  const memoH = () => {
    const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--memo-h"));
    return Number.isFinite(v) && v > 0 ? v : 220;
  };
  // 최대 높이는 화면 비율이 아니라 센터 본문이 내줄 수 있는 크기로 정한다. 메모가 커진
  // 만큼 .center-body(이 열에서 유일한 flex:1 1 auto)가 줄어들므로, 터미널이 완전히 눌리지 않을
  // 최소치만 남기고 나머지를 다 쓴다. innerHeight*0.7 은 CSS 상한(34vh)과 일치하지 않는다.
  const CENTER_MIN = 120;
  applyMemoH(Number(localStorage.getItem("ac.memoH")) || 220);
  const grip = $("#memo-resize");
  if (grip) grip.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const cb = $("#center-body");
    const room = cb ? Math.max(0, cb.getBoundingClientRect().height - CENTER_MIN) : innerHeight * 0.7;
    const y0 = e.clientY, h0 = memoH(), maxH = h0 + room;
    const mask = document.createElement("div");
    mask.style.cssText = "position:fixed;inset:0;z-index:9999;cursor:ns-resize";
    document.body.appendChild(mask);
    // 손잡이가 위에 있으므로 올리면 커진다. 드래그 방향과 커지는 방향이 같아야 한다.
    const move = (ev) => applyMemoH(Math.max(90, Math.min(maxH, h0 - (ev.clientY - y0))));
    const up = () => {
      mask.remove();
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("mouseup", up, true);
      localStorage.setItem("ac.memoH", String(Math.round(memoH())));
      memoEachEditor((ed) => ed.layout());
    };
    document.addEventListener("mousemove", move, true);
    document.addEventListener("mouseup", up, true);
  });
  // 상한이 없으므로 창이 작아지면 저장된 높이가 센터 본문을 모두 차지할 수 있다. 넘친 만큼만 줄인다.
  // 저장하지는 않는다. 창이 다시 커지면 사용자가 정한 높이로 돌아가야 한다.
  addEventListener("resize", () => {
    const p = $("#panel-memo"), cb = $("#center-body");
    if (!p || !cb || p.classList.contains("collapsed")) return;
    const short = CENTER_MIN - cb.getBoundingClientRect().height;
    if (short > 0) { applyMemoH(Math.max(90, memoH() - short)); memoEachEditor((ed) => ed.layout()); }
  });
  // 원문/미리보기. 패널 머리글에 있으므로 접기 토글로 전파되지 않게 여기서 멈춘다.
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-memo-md]"); if (!b) return;
    e.stopPropagation(); e.preventDefault();
    memoMdMode = b.dataset.memoMd;
    localStorage.setItem("ac.memoMd", memoMdMode);
    renderMemoPreview();
  }, true);
  const create = $("#memo-new-window"), shared = $("#memo-shared-window");
  if (create) create.addEventListener("click", (event) => {
    event.preventDefault(); event.stopPropagation();
    const space = memoSpace(); if (!space) { showToast("스페이스를 먼저 선택하세요."); return; }
    const requestId = memoReqId("memo-create");
    const current = orderedSpaces().find((item) => item.id === space);
    rememberMemoCreate(requestId, { space, label: current?.label || space });
    wsSend({ type: "memo.note.create", requestId, space });
  });
  if (shared) shared.addEventListener("click", async (event) => {
    event.preventDefault(); event.stopPropagation();
    try {
      const result = await acHost?.openSharedMemo?.();
      if (!result?.ok) showToast(result?.error || "공유 메모 창을 열지 못했습니다.");
    } catch { showToast("공유 메모 창을 열지 못했습니다."); }
  });
}

export function bootMemo() {
  memoBootReady = true;
  if (!AUX_MODE) setTimeout(() => { try { renderMemoPreview(); } catch {} }, 0);
}
