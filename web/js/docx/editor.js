// 소유 범위: DOCX 편집기 chrome·명령·찾기·링크·dirty 해시·저장과 편집기 전용 docx 심볼 군.
// 제공 API: initDocxEditor, DOCX 렌더 보조·이벤트 액션·chrome 갱신·저장 함수.
// 의존 대상: sheet/actions와 center/text-editor·tab-close를 한 방향으로 import한다. window.__docxEditorCore와 window.__docxEditorCoreReady는 web/index.html classic script가 로드 순서와 전역 수명을 소유하므로 주입하지 않고 window에서 읽는다.
// 유지 조건: core 슬롯 순서·조건·값 형식, 선택 보존, 저장 revision·해시 판정, DOCX_SAVE_STALE·충돌 처리.
// 영향 범위: 주입받는 $·esc·askText·askConfirm·askInfo·showToast·filePathBarHtml·sendTabIo·cleanupDocxRender 및 centerSpace·renderedFileOwner 접근자에 사용한다. 앱 셸에 자기를 등록하는 것은 viewer/boot.js 가 훅 이름으로 한다.

import { GS_COLORS } from "../sheet/model.js";
import { gdWireMenuKeyboard, svList, svMenuAt } from "../sheet/actions.js";
import { isTabDirty } from "../center/tab-close.js";
import { markTabDirty } from "../center/text-editor.js";
import { getCenterSpace } from "../center/tab-store.js";

let $, esc, askText, askConfirm, askInfo, showToast, filePathBarHtml, sendTabIo;
let cleanupDocxRender, getRenderedFileOwner, docxview;

// 이 문서에 아직 저장하지 않은 편집이 있는지 판정한다. 판정은 상태를 만드는 쪽이 갖는다.
// 앱 셸(center/tab-close)이 docxEditor 와 docxHash* 를 직접 읽으면, 새 뷰어를 추가할 때마다
// 앱 셸의 dirty 판정까지 함께 고쳐야 하고, 상태를 만드는 곳과 읽는 곳이 갈라진다.
//
// revision 은 core 의 내부 변경 카운터라 실행취소로 원본과 완전히 같은 내용으로 되돌려도 절대 안
// 줄어든다. "변경이 일어난 적 있다"만 정확히 추적하고 "지금 저장된
// 내용과 같은가"는 못 알려준다. docxScheduleHashRecheck() 가 타이핑 멈춘 뒤 실제 내용을 저장된
// 바이트와 해시로 비교해 채워두는 t.docxHashMatchesSaved/t.docxHashCheckedRevision 을, 그 판정이
// "지금 이 revision"에 대한 것일 때만(그 사이 새 편집이 없었을 때만) dirty 를 끄는 데 쓴다. 오래된
// 판정으로 방금 한 편집을 감추면 안 되므로, 불확실하면 항상 dirty 로 판단한다.
export function docxTabDirty(t) {
  if (!t) return false;
  const fast = !!(t.docxMode && (t.docxDirty
    || (t.docxEditor && t.docxHandleRevision != null
      && t.docxEditor.getDocumentHandle().revision !== t.docxHandleRevision)));
  const hashFresh = t.docxMode && t.docxEditor && t.docxHashCheckedRevision != null
    && t.docxHashCheckedRevision === t.docxEditor.getDocumentHandle().revision;
  return fast && !(hashFresh && t.docxHashMatchesSaved);
}

export function initDocxEditor(deps) {
  ({ $, esc, askText, askConfirm, askInfo, showToast, filePathBarHtml, sendTabIo,
    cleanupDocxRender, getRenderedFileOwner } = deps);
  docxview = $("#docxview");
}

const DOCX_SCOPE_SLOTS = new Set([
  "text.bold", "alignment.center", "table.insert", "image.insert", "list.bullet", "text.link",
  "history.undo", "review.editingMode",
]);
// 댓글·추적변경·제안모드는 제외한다. core(Apache 2.0, non-Pro)의
// review 그룹은 comments를 editingMode와 함께 묶어 노출하므로, 렌더링 단계에서 이 슬롯만 걸러낸다.
// CHROME_GROUPS 전체를 필터 없이
// 렌더하면 댓글 버튼이 노출되고 동작한다(runToolbarCommand로 그대로 dispatch됨).
const DOCX_EXCLUDED_SLOTS = new Set(["review.comments"]);
// file.save는 core가 아니라 Iris(Block 7/8/9)가 저장을 소유하고, zoom.level은 core의 일반
// 문서-명령 체계 밖(Editor.setZoom/getZoom)이라 core가 "not wired to an editor command"로
// disabled를 보고한다. text.link도 같은 사유로 disabled를 보고한다(core의 실제 하이퍼링크
// 진입은 onRequestHyperlink 콜백/Ctrl+K 전용이라 toolbarCommandState
// 는 이 슬롯을 절대 wired로 보고하지 않음, docxRunSpecialChromeSlot이 이미 자체 처리하므로 core
// 판정과 무관하게 항상 클릭 가능해야 함). 셋 다 core의 enabled 판정을 그대로 쓰면 안 되고 Iris가
// 강제로 활성화한다.
const DOCX_IRIS_OWNED_ENABLED_SLOTS = new Set(["file.save", "zoom.level", "text.link"]);
const DOCX_MENU_LABELS = { file: "파일", format: "서식", insert: "삽입", help: "도움말" };
const DOCX_SLOT_LABELS = {
  "history.undo": "실행취소", "history.redo": "재실행", "zoom.level": "확대/축소",
  "styles.style": "단락 스타일", "font.family": "글꼴", "font.size": "글자 크기",
  "text.bold": "굵게", "text.italic": "기울임", "text.underline": "밑줄", "text.strike": "취소선",
  "text.color": "글자 색", "text.highlight": "강조 색", "text.link": "링크",
  "alignment.left": "왼쪽 맞춤", "alignment.center": "가운데 맞춤", "alignment.right": "오른쪽 맞춤",
  "alignment.justify": "양쪽 맞춤", "list.bullet": "글머리 기호", "list.numbered": "번호 목록",
  "list.outdent": "내어쓰기", "list.indent": "들여쓰기", "list.lineSpacing": "줄 간격",
  "format.clear": "서식 지우기", "review.editingMode": "편집 모드", "image.insert": "이미지 삽입",
  "table.insert": "표 삽입", "file.open": "열기", "file.save": "저장", "file.pageSetup": "페이지 설정",
  "insert.pageBreak": "페이지 나누기", "insert.toc": "목차",
  // 위 목록에 없는 core 슬롯은 label 폴백이
  // slotId를 그대로 영문으로 풀어써("Insert Footnote" 등) 나머지 한글 아이콘 버튼들 사이에서
  // 영문 텍스트로 렌더된다. 아이콘은 있고(core 확인) 라벨만 없어서 생기는 시각적
  // 결함. CHROME_GROUPS 전체를 순회해 빠짐없이 채운다.
  "script.super": "위 첨자", "script.sub": "아래 첨자",
  "contentControl.showAll": "서식 필드 모두 표시", "contentControl.formFill": "양식 채우기 탐색",
  "contentControl.inspector": "서식 필드 검사기", "contentControl.remove": "서식 필드 제거",
  "image.properties": "이미지 속성", "image.wrap": "이미지 배치", "image.altText": "대체 텍스트",
  "table.borderTarget": "테두리 적용 대상", "table.borderColor": "테두리 색",
  "table.borderStyle": "테두리 스타일", "table.borderWidth": "테두리 두께", "table.cellFill": "셀 배경색",
  "insert.footnote": "각주", "insert.endnote": "미주", "insert.pageNumber": "페이지 번호",
  "insert.totalPages": "전체 페이지 수", "insert.sectionPages": "구역 페이지 수",
  "insert.pageXofY": "페이지 X/Y", "insert.sectionBreakNextPage": "다음 페이지 구역 나누기",
  "insert.sectionBreakContinuous": "연속 구역 나누기",
};

function docxSlotLabel(slotId, fallback) {
  if (DOCX_SLOT_LABELS[slotId]) return DOCX_SLOT_LABELS[slotId];
  const raw = fallback || slotId.split(".").pop();
  return String(raw).replace(/^.*\./, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (s) => s.toUpperCase());
}
function docxChromeControl(slotId) {
  const core = window.__docxEditorCore;
  if (!core) return null;
  for (const group of core.CHROME_GROUPS) {
    const control = group.controls.find((candidate) => `${group.id}.${candidate.id}` === slotId);
    if (control) return control;
  }
  return null;
}
function docxControlIcon(control) {
  if (!control.paths || !control.paths.length) return "";
  // core가 주는 path 좌표는 구글 Material Symbols 원본 좌표계(y 0~-960, x 0~960)다. "0 0 24 24"
  // viewBox로는 좌표 범위가 전부 뷰포트 밖에 그려져 아이콘이 보이지 않는다(확인 결과:
  // 텍스트 옆의 빈 공간은 라벨이 아니라 한 번도 그려진 적
  // 없는 아이콘 영역이었다. 라벨 텍스트가 항상 함께 떠서 버튼이 비어 보이지 않았다).
  // 뷰포트를 실제 좌표계에 맞춘다.
  return `<svg class="docx-control-icon" viewBox="0 -960 960 960" aria-hidden="true">${control.paths.map((path) => `<path d="${esc(path)}"></path>`).join("")}</svg>`;
}
export function docxToolbarHtml() {
  const groups = window.__docxEditorCore.CHROME_GROUPS;
  return groups.map((group) => `<span class="docx-group" data-docx-group="${esc(group.id)}">${group.controls
    .filter((control) => !DOCX_EXCLUDED_SLOTS.has(`${group.id}.${control.id}`))
    .map((control) => {
    const slotId = `${group.id}.${control.id}`;
    const label = docxSlotLabel(slotId, control.labelKey);
    const valueText = control.valueText || label;
    const dropdown = control.shape === "dropdown" || control.shape === "stepper" || control.shape === "colorSplit";
    const icon = docxControlIcon(control);
    // 아이콘이 있는 컨트롤(굵게·정렬·목록·글자색 등)까지 label span에 명령 이름 폴백 텍스트가
    // 붙으면 모든 버튼이 "아이콘+텍스트"가 된다. 구글 독스 기준 아이콘이 있는 컨트롤은 아이콘(+스와치+
    // 드롭다운 화살표)만으로 명령을 나타내고 텍스트를 보이지 않는다. 아이콘이 없는 값 표시
    // 컨트롤(확대/축소 %·글꼴·글자 크기·단락 스타일 등)만 label span으로 값/자리표시 텍스트를
    // 보인다. 접근성 이름은 aria-label/title로 이미 별도 보장되므로 아이콘 버튼에서 label span을
    // 통째로 빼도 스크린리더 정보 손실은 없다.
    // 태그를 여는 `>` 뒤·닫는 `<`앞에 줄바꿈+들여쓰기가 있으면 그 공백이 그대로 버튼의 첫/마지막
    // 자식 텍스트 노드가 된다. 아이콘 없는 텍스트 전용 버튼(docxControlIcon이 빈 문자열)에서
    // 라벨 앞에 보이는 공백으로 남아 justify-content:center가 그 공백까지 포함해 중앙 정렬을
    // 어긋나게 한다. 한 줄로 이어 붙여 공백 텍스트 노드 자체를 없앤다.
    return `<button data-docx-slot="${esc(slotId)}"${DOCX_SCOPE_SLOTS.has(slotId) ? ' data-docx-scope="required"' : ""} class="${dropdown ? "docx-dropdown" : ""}" title="${esc(label)}" aria-label="${esc(label)}">${icon}${icon ? "" : `<span class="docx-control-label" data-docx-value-text>${esc(valueText)}</span>`}${control.swatch ? `<span class="docx-swatch" style="background:${esc(control.swatch)}"></span>` : ""}${dropdown ? " ▾" : ""}</button>`;
  }).join("")}</span>`).join("");
}
function docxMenuEntriesHtml(entries) {
  return entries.map((entry) => {
    if (entry.kind === "separator") return `<hr class="gd-menu-sep" role="separator">`;
    if (entry.kind === "submenu") {
      return `<details class="gs-submenu"><summary>${esc(docxSlotLabel(entry.labelKey, entry.labelKey))}<span>›</span></summary>
        <div class="gs-submenu-items">${docxMenuEntriesHtml(entry.items)}</div></details>`;
    }
    const label = docxSlotLabel(entry.slot, entry.labelKey);
    return `<button role="menuitem" data-pick="${esc(entry.slot)}" data-docx-menu-slot="${esc(entry.slot)}"><span>${esc(label)}</span></button>`;
  }).join("");
}
export function docxMenuBarHtml() {
  return window.__docxEditorCore.CHROME_MENUS.map((menu) =>
    `<button role="menuitem" data-gm="${esc(menu.id)}" aria-haspopup="menu" aria-expanded="false">${esc(DOCX_MENU_LABELS[menu.id] || menu.id)}</button>`
  ).join("");
}
export function docxRefreshChrome(t) {
  const editor = t && t.docxEditor;
  if (!editor || t !== getRenderedFileOwner()) return;
  docxview.querySelectorAll(".gd-tb [data-docx-slot]").forEach((el) => {
    const slotId = el.dataset.docxSlot;
    const state = window.__docxEditorCore.toolbarCommandState(editor, slotId);
    const enabled = DOCX_IRIS_OWNED_ENABLED_SLOTS.has(slotId) ? true : state.enabled;
    el.disabled = !enabled;
    el.setAttribute("aria-disabled", enabled ? "false" : "true");
    el.classList.toggle("on", !!state.active);
    el.setAttribute("aria-pressed", state.active ? "true" : "false");
    el.title = enabled ? docxSlotLabel(slotId) : (state.disabledReason || docxSlotLabel(slotId));
    const value = el.querySelector("[data-docx-value-text]");
    if (slotId === "zoom.level") {
      // zoom은 core의 일반 문서-명령 상태 체계 밖에 있어 toolbarCommandState가 값을 채우지
      // 않는다(state.kind가 "command"). editor.getZoom()에서 직접 읽어 표시한다.
      if (value) value.textContent = Math.round(editor.getZoom() * 100) + "%";
    } else if (value && state.value != null) {
      value.textContent = state.value;
    }
  });
  const mode = editor.getEditingMode();
  docxview.querySelectorAll("[data-docx-act='mode-edit']").forEach((el) => el.classList.toggle("on", mode === "editing"));
  docxview.querySelectorAll("[data-docx-act='mode-view']").forEach((el) => el.classList.toggle("on", mode === "viewing"));
}
// core가 받는 색 값 형식은 슬롯마다 다르다(확인 결과): text.color/table.borderColor/
// table.cellFill은 "#" 없는 6자리 hex나 "auto"만 받고("color requires a six-digit hex value like
// FF0000, or 'auto'"; "#ff0000"을 그대로 보내면 invalidArgs로 거부됨), text.highlight는 hex가
// 아니라 ST_HighlightColor 이름(yellow·cyan 등)만 받는다("highlight requires an ST_HighlightColor
// name"). 프롬프트 기본값이 "#000000"/"#ffff00"이면 사용자가 확인만 눌러도
// 거부되어 글자 색·강조 색 버튼이 동작하지 않는다.
async function docxChromeValue(t, slotId, anchorEl) {
  const editor = t.docxEditor;
  const control = docxChromeControl(slotId);
  if (!control || control.state.kind !== "value") return { cancelled: false, value: undefined };
  if (slotId === "review.editingMode") {
    return { cancelled: false, value: editor.getEditingMode() === "viewing" ? "editing" : "viewing" };
  }
  if (slotId === "text.color") {
    const pick = await docxPickFromMenu(anchorEl, docxColorMenuHtml());
    return pick == null ? { cancelled: true } : { cancelled: false, value: pick };
  }
  if (slotId === "text.highlight") {
    const pick = await docxPickFromMenu(anchorEl, docxHighlightMenuHtml());
    return pick == null ? { cancelled: true } : { cancelled: false, value: pick };
  }
  const value = await askText(docxSlotLabel(slotId), "");
  return value == null ? { cancelled: true } : { cancelled: false, value };
}
const DOCX_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/bmp", "image/webp"]);
function docxInsertImage(t) {
  const editor = t.docxEditor;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = [...DOCX_IMAGE_MIMES].join(",");
  input.hidden = true;
  document.body.appendChild(input);
  let finished = false;
  const finish = async () => {
    if (finished) return;
    finished = true;
    const file = input.files && input.files[0];
    input.remove();
    if (!file || t.docxEditor !== editor || t !== getRenderedFileOwner()) return;
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      const mime = file.type;
      if (!DOCX_IMAGE_MIMES.has(mime)) {
        showToast("지원하지 않는 이미지 형식입니다.");
        return;
      }
      const image = await window.createImageBitmap(file);
      let widthPoints;
      let heightPoints;
      try {
        widthPoints = image.width * 72 / 96;
        heightPoints = image.height * 72 / 96;
      } finally {
        image.close();
      }
      if (t.docxEditor !== editor || t !== getRenderedFileOwner()) return;
      const result = await window.__docxEditorCore.executeImageCommand(editor, {
        type: "insertImage",
        data: data,
        mime: mime,
        widthPoints: widthPoints,
        heightPoints: heightPoints,
      });
      if (result && result.ok === false && result.reason) showToast(result.reason);
      docxRefreshChrome(t);
    } catch (error) {
      showToast(error && error.message ? error.message : "이미지를 삽입하지 못했습니다.");
    }
  };
  input.addEventListener("change", finish, { once: true });
  window.addEventListener("focus", () => setTimeout(finish, 0), { once: true });
  input.click();
}
const DOCX_TABLE_SIZE_PRESETS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
async function docxInsertTable(t, anchorEl) {
  const editor = t.docxEditor;
  const savedSel = docxCaptureSelection(editor);
  const rowPick = await docxPickFromMenu(anchorEl, svList(DOCX_TABLE_SIZE_PRESETS.map((n) => [`${n}행`, String(n)])));
  if (rowPick == null) return;
  const colPick = await docxPickFromMenu(anchorEl, svList(DOCX_TABLE_SIZE_PRESETS.map((n) => [`${n}열`, String(n)])));
  if (colPick == null) return;
  const rows = Number(rowPick);
  const cols = Number(colPick);
  docxRestoreSelection(editor, savedSel);
  if (!editor.surface.canInsertTable(rows, cols) || !editor.surface.insertTable(rows, cols)) {
    showToast("현재 위치에 표를 삽입할 수 없습니다.");
    return;
  }
  docxRefreshChrome(t);
}
// core README/editor.d.ts 확인(L1): ZOOM_MIN=0.1(10%), ZOOM_MAX=5(500%). editor.setZoom()은
// 퍼센트가 아니라 배율(1.0 == 100%)을 받는다.
const DOCX_ZOOM_MIN_PERCENT = 10;
const DOCX_ZOOM_MAX_PERCENT = 500;
// table.border*(적용대상/색/스타일/두께) 4개 슬롯은 runToolbarCommand(일반 슬롯→명령 매핑)에
// 없다("not wired to an editor command", 확인 결과). core 내부에 별도로 존재하는
// runTableChromeCommand(draft 누적형 API, core.runTableChromeCommand.toString() 리버스엔지니어링
// 으로 발견)를 써야 한다. 그리고 그 API는 borderColor/borderStyle/borderWidth와 concrete
// borderTarget(전체 8종 중 'none' 제외) 전부 매번 완전한 spec(style+size+color)이 갖춰져야
// 받아준다. 부분 필드만 보내면 "concrete border scopes require a complete spec"로 거부된다
// (확인 결과: color만 보낸 draft.spec={} 호출은 실패, style+size+color를 전부 채운 호출만 성공).
// 그래서 4개 버튼 중 무엇을 눌러도 나머지 3개 값을 함께 물어 완전한 spec으로 보낸다. color는
// ColorValue 객체({kind:'hex',value} | {kind:'auto'})여야 한다. runToolbarCommand 계열이 받는
// 맨 hex 문자열과 다르다(TableBorderSpec.color: ColorValue, contracts/types.d.ts 확인).
const DOCX_TABLE_BORDER_TARGETS = ["all", "outside", "inside", "none", "top", "bottom", "left", "right"];
const DOCX_TABLE_BORDER_STYLES = ["single", "dashed", "dotted", "double", "triple", "thick"];
// askText/askConfirm 모달이 뜨는 동안 포커스가 contenteditable 밖으로 나가면 core가 라이브 DOM
// Selection을 다시 읽어 선택을 잃는다(확인 결과: font.family에서 모달 확인 후 아무 변화
// 없음). `editor.surface.retainSelection()`은 쓸 수 없다. 모달을 클릭하는 것
// 자체가 "중간 상호작용"이라 곧바로 `retainedSelection()`이 null로 풀린다(직접
// 확인). 안정적으로 동작하려면 모달을 열기 *전에* 현재 selection을 직접 읽어 저장해
// 뒀다가, 모달이 닫힌 직후 실제 명령을 부르기 바로 전에 `setSelection`으로 되돌린다.
function docxCaptureSelection(editor) {
  return editor.query({ type: "selection" });
}
function docxRestoreSelection(editor, saved) {
  if (saved) editor.exec({ type: "setSelection", range: saved });
}
// core가 이 슬롯들을 shape:"dropdown"으로 선언해 버튼에 ▾ 화살표까지 그려두는데(docxToolbarHtml의
// dropdown 판정), askText 모달로 값을 받으면 버튼 모양과 실제 동작이 어긋난다. 드롭다운
// 모양인데 모달이 뜬다. 시트 편집기가 이미 쓰는 svMenuAt(팝업 목록,
// docxOpenMenu의 File/Format/Insert 메뉴도 같은 함수를 씀)을 그대로 재사용해 진짜 드롭다운을
// 띄운다. Promise로 감싸 기존 async 흐름과 맞춘다. svMenuAt의 팝업 버튼 클릭은 mousedown에서
// preventDefault해 포커스를 뺏지 않지만, 이 팝업을 여는 원인이 된 툴바/메뉴 버튼 클릭 자체는
// 이미 포커스를 가져가 있으므로 docxCaptureSelection/docxRestoreSelection은 여전히 필요하다.
function docxPickFromMenu(anchorEl, itemsHtml) {
  return new Promise((resolve) => {
    let settled = false;
    const box = svMenuAt(anchorEl, itemsHtml, (v) => {
      settled = true;
      resolve(v);
    });
    const observer = new MutationObserver(() => {
      if (!settled && !box.isConnected) {
        settled = true;
        observer.disconnect();
        resolve(null);
      }
    });
    observer.observe(document.body, { childList: true });
  });
}
const DOCX_FONT_SIZE_PRESETS_PT = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72];
const DOCX_LINE_SPACING_PRESETS = [["단일", 1], ["1.15", 1.15], ["1.5줄", 1.5], ["2줄(이중)", 2]];
const DOCX_ZOOM_PRESETS_PERCENT = [50, 75, 90, 100, 125, 150, 200];
const DOCX_BORDER_TARGET_LABELS = { all: "모두", outside: "바깥쪽", inside: "안쪽", none: "없음",
  top: "위", bottom: "아래", left: "왼쪽", right: "오른쪽" };
const DOCX_BORDER_STYLE_LABELS = { single: "실선", dashed: "파선", dotted: "점선", double: "이중선",
  triple: "삼중선", thick: "굵은선" };
const DOCX_BORDER_WIDTH_PRESETS_PT = [0.5, 0.75, 1, 1.5, 2, 2.25, 3, 4.5, 6];
const DOCX_HIGHLIGHT_SWATCHES = [["yellow", "#FFFF00"], ["green", "#00FF00"], ["cyan", "#00FFFF"],
  ["magenta", "#FF00FF"], ["blue", "#0000FF"], ["red", "#FF0000"], ["darkBlue", "#000080"],
  ["darkCyan", "#008080"], ["darkGreen", "#008000"], ["darkMagenta", "#800080"],
  ["darkRed", "#800000"], ["darkYellow", "#808000"], ["darkGray", "#808080"],
  ["lightGray", "#C0C0C0"], ["black", "#000000"], ["white", "#FFFFFF"]];
const DOCX_CUSTOM_PICK = "__custom__";
function docxColorMenuHtml() {
  return `<div class="gs-sw">` + GS_COLORS.map((c) =>
    `<button data-pick="${esc(c.replace(/^#/, "").toUpperCase())}" style="background:${esc(c)}" title="${esc(c)}"></button>`
  ).join("") + `</div><button data-pick="auto" class="gs-none">자동</button>`;
}
function docxHighlightMenuHtml() {
  return `<div class="gs-sw">` + DOCX_HIGHLIGHT_SWATCHES.map(([name, hex]) =>
    `<button data-pick="${esc(name)}" style="background:${esc(hex)}" title="${esc(name)}"></button>`
  ).join("") + `</div><button data-pick="none" class="gs-none">없음</button>`;
}
function docxFontSizeMenuHtml() {
  return svList(DOCX_FONT_SIZE_PRESETS_PT.map((pt) => [`${pt}pt`, String(pt)]))
    + svList([["직접 입력…", DOCX_CUSTOM_PICK]]);
}
function docxColorValueFromInput(hexOrAuto) {
  return hexOrAuto === "auto" ? { kind: "auto" } : { kind: "hex", value: hexOrAuto };
}
// table.border*(적용대상/색/스타일/두께) 4개 버튼은 클릭한 슬롯이 대표하는 속성 하나만
// 드롭다운으로 받는다. 버튼 하나가 나머지 세 속성까지 매번 다시 묻지 않게 하기 위한 것이다.
// 나머지 세 값은
// t.docxLast* 캐시(또는 기본값)를 그대로 쓴다. runTableChromeCommand는 매번
// 완전한 spec(style+size+color)을 요구하므로(위 주석 참조) 캐시값으로 채워 보낸다.
async function docxRunTableBorderSlot(t, slotId, anchorEl) {
  const editor = t.docxEditor;
  const core = window.__docxEditorCore;
  const savedSel = docxCaptureSelection(editor);
  let target = t.docxLastBorderTarget || "all";
  let color = t.docxLastBorderColor || "000000";
  let style = t.docxLastBorderStyle || "single";
  let widthPt = t.docxLastBorderWidthPt || 1;
  if (slotId === "table.borderTarget") {
    const pick = await docxPickFromMenu(anchorEl, svList(DOCX_TABLE_BORDER_TARGETS.map((v) => [DOCX_BORDER_TARGET_LABELS[v], v])));
    if (pick == null) return;
    target = pick;
  } else if (slotId === "table.borderColor") {
    const pick = await docxPickFromMenu(anchorEl, docxColorMenuHtml());
    if (pick == null) return;
    color = pick;
  } else if (slotId === "table.borderStyle") {
    const pick = await docxPickFromMenu(anchorEl, svList(DOCX_TABLE_BORDER_STYLES.map((v) => [DOCX_BORDER_STYLE_LABELS[v], v])));
    if (pick == null) return;
    style = pick;
  } else {
    const pick = await docxPickFromMenu(anchorEl, svList(DOCX_BORDER_WIDTH_PRESETS_PT.map((w) => [`${w}pt`, String(w)])));
    if (pick == null) return;
    widthPt = Number(pick);
  }
  t.docxLastBorderTarget = target;
  t.docxLastBorderColor = color;
  t.docxLastBorderStyle = style;
  t.docxLastBorderWidthPt = widthPt;
  const size = Math.round(widthPt * 8);
  const colorValue = docxColorValueFromInput(color);
  const pick = slotId === "table.borderTarget" ? target
    : slotId === "table.borderColor" ? colorValue
    : slotId === "table.borderStyle" ? style
    : size;
  docxRestoreSelection(editor, savedSel);
  const outcome = core.runTableChromeCommand(editor, slotId, pick, {
    activeTarget: target,
    spec: { style, size, color: colorValue },
  });
  if (outcome && outcome.result && outcome.result.ok === false && outcome.result.reason) showToast(outcome.result.reason);
  docxRefreshChrome(t);
}
async function docxRunTableCellFillSlot(t, anchorEl) {
  const editor = t.docxEditor;
  const core = window.__docxEditorCore;
  const savedSel = docxCaptureSelection(editor);
  const pick = await docxPickFromMenu(anchorEl, docxColorMenuHtml());
  if (pick == null) return;
  t.docxLastCellFill = pick;
  docxRestoreSelection(editor, savedSel);
  const outcome = core.runTableChromeCommand(editor, "table.cellFill", docxColorValueFromInput(pick), { activeTarget: "all" });
  if (outcome && outcome.result && outcome.result.ok === false && outcome.result.reason) showToast(outcome.result.reason);
  docxRefreshChrome(t);
}
async function docxRunSpecialChromeSlot(t, slotId, anchorEl) {
  if (slotId === "text.link") {
    docxShowLinkEditor(t, true);
    return true;
  }
  if (slotId === "image.insert") {
    docxInsertImage(t);
    return true;
  }
  if (slotId === "table.insert") {
    await docxInsertTable(t, anchorEl);
    return true;
  }
  if (slotId === "file.save") {
    docxSaveTab(t, getCenterSpace());
    return true;
  }
  if (slotId === "zoom.level") {
    // zoom.level은 core의 일반 문서-편집 명령
    // 체계(runToolbarCommand)에 속하지 않는다(editor.setZoom()이 별도 Editor 메서드).
    // 그대로 두면 버튼만 있고 동작하지 않는다. 드롭다운으로 배율을 받아 editor.setZoom()을
    // 직접 호출한다.
    const editor = t.docxEditor;
    let pick = await docxPickFromMenu(anchorEl, svList(DOCX_ZOOM_PRESETS_PERCENT.map((p) => [`${p}%`, String(p)]))
      + svList([["직접 입력…", DOCX_CUSTOM_PICK]]));
    if (pick == null) return true;
    if (pick === DOCX_CUSTOM_PICK) {
      const current = Math.round(editor.getZoom() * 100);
      pick = await askText("확대/축소 배율", String(current), `${DOCX_ZOOM_MIN_PERCENT}~${DOCX_ZOOM_MAX_PERCENT}`);
      if (pick == null) return true;
    }
    const percent = Number(pick);
    if (!Number.isFinite(percent) || percent < DOCX_ZOOM_MIN_PERCENT || percent > DOCX_ZOOM_MAX_PERCENT) {
      showToast(`${DOCX_ZOOM_MIN_PERCENT}~${DOCX_ZOOM_MAX_PERCENT} 사이의 숫자를 입력하세요.`);
      return true;
    }
    const result = editor.setZoom(percent / 100);
    if (result && result.ok === false && result.reason) showToast(result.reason);
    docxRefreshChrome(t);
    return true;
  }
  if (slotId === "file.pageSetup") {
    // runToolbarCommand(editor, "file.pageSetup", ...)는 "not wired to an editor command"로
    // 즉시 거부된다(확인 결과). core의 슬롯→명령 매핑에 이 슬롯 자체가 없다.
    // setPageSetup은 실제 exec 명령으로 존재하므로(editor.d.ts 확인) 직접 부른다. 단위는 twips
    // (1pt=20twips, 1mm≈56.6929twips)라 사람이 읽기 편한 mm로 보여주고 왕복 변환한다.
    const editor = t.docxEditor;
    const setup = editor.getPageSetup();
    const TWIPS_PER_MM = 1440 / 25.4;
    const mm = (twips) => Math.round((twips / TWIPS_PER_MM) * 10) / 10;
    const toTwips = (v) => Math.round(v * TWIPS_PER_MM);
    const raw = await askText(
      "페이지 설정 (mm)",
      [mm(setup.pageWidthTwips), mm(setup.pageHeightTwips), mm(setup.marginsTwips.top),
        mm(setup.marginsTwips.bottom), mm(setup.marginsTwips.left), mm(setup.marginsTwips.right)].join(","),
      "쉼표로 구분: 너비,높이,위,아래,왼쪽,오른쪽");
    if (raw == null) return true;
    const parts = raw.split(",").map((s) => Number(s.trim()));
    if (parts.length !== 6 || parts.some((n) => !Number.isFinite(n) || n <= 0)) {
      showToast("6개의 양수(mm)를 쉼표로 구분해 입력하세요.");
      return true;
    }
    const [width, height, top, bottom, left, right] = parts;
    const landscape = await askConfirm("가로 방향으로 설정하시겠습니까?", "취소하면 세로로 설정됩니다.");
    const result = editor.exec({
      type: "setPageSetup",
      pageWidth: toTwips(width), pageHeight: toTwips(height),
      marginTop: toTwips(top), marginBottom: toTwips(bottom),
      marginLeft: toTwips(left), marginRight: toTwips(right),
      orientation: landscape ? "landscape" : "portrait",
    });
    if (result && result.ok === false && result.reason) showToast(result.reason);
    docxRefreshChrome(t);
    return true;
  }
  if (slotId === "image.properties") {
    // core CHROME_GROUPS에 있는 유일한 image.* command-kind 슬롯인데 runToolbarCommand가
    // "not wired to an editor command"로 거부한다(확인 결과). core의 슬롯→명령
    // 매핑에 없다. 대신 exec({type:'setImageProperties', ...})가 실제 명령으로 존재한다
    // (editor.d.ts 확인). 배치(image.wrap)·대체 텍스트(image.altText)는 이미 각자 버튼으로
    // runToolbarCommand를 통해 정상 동작하므로(확인 결과) 여기서 중복 입력받지 않고, "속성"
    // 버튼에만 있는 크기(가로·세로)만 다룬다. EMU(914400=1인치=25.4mm → 36000 EMU/mm) 단위라
    // mm로 물어 왕복 변환.
    const editor = t.docxEditor;
    const img = editor.getSelectedImage();
    if (!img) { showToast("이미지를 먼저 선택하세요."); return true; }
    if (!img.canResize) { showToast("이 이미지는 크기를 바꿀 수 없습니다."); return true; }
    const EMU_PER_MM = 36000;
    const mm = (emu) => Math.round((emu / EMU_PER_MM) * 10) / 10;
    const toEmu = (v) => Math.round(v * EMU_PER_MM);
    const dimsRaw = await askText("이미지 크기 (mm)", `${mm(img.widthEmu)},${mm(img.heightEmu)}`, "쉼표로 구분: 너비,높이");
    if (dimsRaw == null) return true;
    const dims = dimsRaw.split(",").map((s) => Number(s.trim()));
    if (dims.length !== 2 || dims.some((n) => !Number.isFinite(n) || n <= 0)) {
      showToast("너비,높이(mm) 2개의 양수를 쉼표로 구분해 입력하세요.");
      return true;
    }
    const result = editor.exec({
      type: "setImageProperties",
      drawingNodeId: img.id,
      expectedPackageRevision: editor.getDocumentHandle().revision,
      widthEmu: toEmu(dims[0]),
      heightEmu: toEmu(dims[1]),
    });
    if (result && result.ok === false && result.reason) showToast(result.reason);
    docxRefreshChrome(t);
    return true;
  }
  if (slotId === "table.borderTarget" || slotId === "table.borderColor" ||
      slotId === "table.borderStyle" || slotId === "table.borderWidth") {
    await docxRunTableBorderSlot(t, slotId, anchorEl);
    return true;
  }
  if (slotId === "table.cellFill") {
    await docxRunTableCellFillSlot(t, anchorEl);
    return true;
  }
  if (slotId === "font.family" || slotId === "font.size") {
    // 둘 다 core CHROME_GROUPS엔 있지만 runToolbarCommand·editor.exec({type:'applyFormatting'})
    // 둘 다 거부한다("not wired to an editor command" / "command 'applyFormatting' is not
    // supported by the tree editor", 확인 결과). 이 런타임 버전에는 글꼴 지정용
    // 공개 exec 명령이 아예 없다. 대신 bold/italic 등이 실제로 쓰는 저수준 내부 API
    // `editor.surface.setRunProperty(localName, attrs)`(OOXML 요소명 그대로, `w:` 접두사
    // 없음)가 직접 호출로 동작한다. `rFonts`엔 `{ascii,hAnsi}`, `sz`엔 half-point 문자열
    // `{val}`.
    const editor = t.docxEditor;
    const savedSel = docxCaptureSelection(editor);
    if (slotId === "font.family") {
      const fonts = editor.getAvailableFonts();
      let pick = await docxPickFromMenu(anchorEl, svList(fonts.map((f) => [f, f])) + svList([["직접 입력…", DOCX_CUSTOM_PICK]]));
      if (pick == null) return true;
      if (pick === DOCX_CUSTOM_PICK) {
        pick = await askText("글꼴", editor.getSelectionFormatting()?.fontFamily || "");
        if (pick == null) return true;
      }
      const family = pick.trim();
      if (!family) { showToast("글꼴 이름을 입력하세요."); return true; }
      docxRestoreSelection(editor, savedSel);
      editor.surface.setRunProperty("rFonts", { ascii: family, hAnsi: family });
    } else {
      let pick = await docxPickFromMenu(anchorEl, docxFontSizeMenuHtml());
      if (pick == null) return true;
      if (pick === DOCX_CUSTOM_PICK) {
        const currentPt = (editor.getSelectionFormatting()?.fontSizeHalfPoints || 22) / 2;
        pick = await askText("글자 크기 (pt)", String(currentPt));
        if (pick == null) return true;
      }
      const pt = Number(pick);
      if (!Number.isFinite(pt) || pt <= 0) { showToast("양수(pt)를 입력하세요."); return true; }
      docxRestoreSelection(editor, savedSel);
      editor.surface.setRunProperty("sz", { val: String(Math.round(pt * 2)) });
    }
    docxRefreshChrome(t);
    return true;
  }
  if (slotId === "styles.style") {
    // core 슬롯 매핑엔 없지만("not wired to an editor command") exec({type:'setParagraphStyle',
    // styleId})는 실제로 동작하는 명령으로 존재(editor 레벨에선 target 생략 시 현재 선택에
    // 적용, EditorCommandShape 확인).
    const editor = t.docxEditor;
    const savedSel = docxCaptureSelection(editor);
    const styles = editor.getDocumentStyles();
    const pick = await docxPickFromMenu(anchorEl, svList(styles.map((s) => [`${s.name} (${s.styleId})`, s.styleId])));
    if (pick == null) return true;
    const picked = styles.find((s) => s.styleId === pick);
    if (!picked) return true;
    docxRestoreSelection(editor, savedSel);
    const result = editor.exec({ type: "setParagraphStyle", styleId: picked.styleId });
    if (result && result.ok === false && result.reason) showToast(result.reason);
    docxRefreshChrome(t);
    return true;
  }
  if (slotId === "list.lineSpacing") {
    // core 슬롯 매핑엔 없지만("not wired to an editor command") exec({type:'setLineSpacing',
    // rule, value})는 실제로 동작하는 명령으로 존재. rule:'multiple'일 때 value는 줄 배수
    // (1, 1.15, 1.5, 2 등. Word 다이얼로그와 동일 단위).
    const editor = t.docxEditor;
    const savedSel = docxCaptureSelection(editor);
    const pick = await docxPickFromMenu(anchorEl, svList(DOCX_LINE_SPACING_PRESETS.map(([label, v]) => [label, String(v)])));
    if (pick == null) return true;
    const multiple = Number(pick);
    docxRestoreSelection(editor, savedSel);
    const result = editor.exec({ type: "setLineSpacing", rule: "multiple", value: multiple });
    if (result && result.ok === false && result.reason) showToast(result.reason);
    docxRefreshChrome(t);
    return true;
  }
  if (slotId === "insert.sectionBreakContinuous") {
    // "다음 페이지 구역 나누기"(insert.sectionBreakNextPage)는 core의 슬롯 매핑이 있어
    // runToolbarCommand로 바로 동작하지만, "연속 구역 나누기"는 매핑이 없어("not wired to an
    // editor command", 확인 결과) 버튼을 눌러도 동작하지 않는다. 두 구역 나누기 모두
    // DocEdits에는 kind:'section' 하나뿐이라(연속/다음 페이지를 가르는 별도 kind가 없음) 같은
    // insertBreak 호출로 처리한다.
    const editor = t.docxEditor;
    const result = editor.exec({ type: "insertBreak", kind: "section" });
    if (result && result.ok === false && result.reason) showToast(result.reason);
    docxRefreshChrome(t);
    return true;
  }
  return false;
}
export function docxWireToolbar(t, toolbar) {
  toolbar.querySelectorAll("[data-docx-slot]").forEach((control) => {
    control.addEventListener("click", async () => {
      const editor = t.docxEditor;
      const slotId = control.dataset.docxSlot;
      if (!editor || control.disabled || control.getAttribute("aria-disabled") === "true") return;
      if (await docxRunSpecialChromeSlot(t, slotId, control)) return;
      // 드롭다운 팝업이 뜨는 동안에도 포커스가 나가면 core가 라이브 DOM Selection을 다시 읽어
      // 선택을 잃는다(docxCaptureSelection/docxRestoreSelection 참조). text.color 등 이
      // 일반 경로를 쓰는 모든 value 슬롯도 같은 위험이 있어 여기서 한 번에 감싼다.
      const savedSel = docxCaptureSelection(editor);
      const pick = await docxChromeValue(t, slotId, control);
      if (pick.cancelled) return;
      docxRestoreSelection(editor, savedSel);
      const result = window.__docxEditorCore.runToolbarCommand(editor, slotId, pick.value);
      if (result && result.ok === false && result.reason) showToast(result.reason);
      docxRefreshChrome(t);
    });
  });
}
// core는 인쇄 컨트롤을 전혀 노출하지 않는다(CHROME_GROUPS/CHROME_MENUS에 print 계열 슬롯이
// 없음). sheet 뷰어의 기존 print 선례(svToolbar의
// case "print": window.print())를 그대로 따라 file 메뉴에 Iris 소유 항목을 추가한다. 실제
// core ChromeSlotId가 아니므로 toolbarCommandState에 절대 넘기지 않는다(아래 dispatch에서
// 가장 먼저 분리).
const DOCX_PRINT_SLOT = "iris.print";
// insert.pageNumber/totalPages/sectionPages/pageXofY(core.insertPageField 명령)는 core 자체가
// "머리글/바닥글 스코프가 열려 있어야만" 허용한다("insertPageField requires an open header or
// footer scope", 확인 결과). 그런데 core의 CHROME_GROUPS/CHROME_MENUS 어디에도 그 스코프에
// 들어가는 슬롯(editHeaderFooter 커맨드를 부르는 버튼)이 없다. 그래서 이 4개 버튼은 눌러도
// 실패한다. print와 같은 방식(core에 없는 Iris 소유 슬롯 추가)으로 삽입 메뉴에 진입/종료
// 토글을 추가한다. Word의 "머리글 편집 시작/닫기"와 같은 역할이다.
const DOCX_HEADER_FOOTER_TOGGLE_SLOT = "iris.headerFooterToggle";
// core.CHROME_MENUS의 "help" 메뉴는 entries가 빈 배열이다(직접 확인). core가
// 이 메뉴에 항목을 정의하지 않았는데 Iris는 메뉴바에 "도움말" 버튼을 그려서, 눌러도
// 빈 드롭다운만 뜬다(확인 결과: role="menu" 요소가 자식 없이 렌더). 항목이 없는 메뉴를
// 그대로 두지 않고, 엔진·버전 정보를 보여주는 최소한의 실제 항목을
// Iris가 채운다.
const DOCX_HELP_ABOUT_SLOT = "iris.helpAbout";
function docxMenuEntriesForMenu(menu, t) {
  if (menu.id === "file") {
    return [...menu.entries, { kind: "separator" }, { kind: "item", slot: DOCX_PRINT_SLOT, labelKey: "인쇄" }];
  }
  if (menu.id === "insert") {
    const editing = t && t.docxEditor && t.docxEditor.getHeaderFooterState
      ? t.docxEditor.getHeaderFooterState()?.editing : null;
    const label = editing ? "머리글/바닥글 편집 종료" : "머리글/바닥글 편집";
    return [...menu.entries, { kind: "separator" }, { kind: "item", slot: DOCX_HEADER_FOOTER_TOGGLE_SLOT, labelKey: label }];
  }
  if (menu.id === "help") {
    return [...menu.entries, { kind: "item", slot: DOCX_HELP_ABOUT_SLOT, labelKey: "정보" }];
  }
  return menu.entries;
}
export function docxOpenMenu(t, anchor) {
  const core = window.__docxEditorCore;
  const menu = core && core.CHROME_MENUS.find((candidate) => candidate.id === anchor.dataset.gm);
  if (!menu) return;
  const entries = docxMenuEntriesForMenu(menu, t);
  const box = svMenuAt(anchor, entries.map((entry) => docxMenuEntriesHtml([entry])).join(""), async (slotId) => {
    if (slotId === DOCX_PRINT_SLOT) { window.print(); return; }
    if (slotId === DOCX_HEADER_FOOTER_TOGGLE_SLOT) {
      const editor = t.docxEditor;
      if (!editor) return;
      const editing = editor.getHeaderFooterState()?.editing;
      const result = editing ? editor.exec({ type: "exitHeaderFooter" })
        : editor.exec({ type: "editHeaderFooter", position: "header" });
      if (result && result.ok === false && result.reason) showToast(result.reason);
      docxRefreshChrome(t);
      return;
    }
    if (slotId === DOCX_HELP_ABOUT_SLOT) {
      await askInfo("Iris Docx 편집기", "편집 엔진: @docx-editor.dev/core 2.4.1 (Apache-2.0)");
      return;
    }
    const editor = t.docxEditor;
    if (!editor) return;
    if (DOCX_EXCLUDED_SLOTS.has(slotId)) return;
    const state = core.toolbarCommandState(editor, slotId);
    const enabled = DOCX_IRIS_OWNED_ENABLED_SLOTS.has(slotId) ? true : state.enabled;
    if (!enabled) { if (state.disabledReason) showToast(state.disabledReason); return; }
    if (await docxRunSpecialChromeSlot(t, slotId, anchor)) return;
    const savedSel = docxCaptureSelection(editor);
    const pick = await docxChromeValue(t, slotId, anchor);
    if (pick.cancelled) return;
    docxRestoreSelection(editor, savedSel);
    const result = core.runToolbarCommand(editor, slotId, pick.value);
    if (result && result.ok === false && result.reason) showToast(result.reason);
    docxRefreshChrome(t);
  });
  box.querySelectorAll("[data-docx-menu-slot]").forEach((el) => {
    const menuSlotId = el.dataset.docxMenuSlot;
    if (menuSlotId === DOCX_PRINT_SLOT || menuSlotId === DOCX_HEADER_FOOTER_TOGGLE_SLOT || menuSlotId === DOCX_HELP_ABOUT_SLOT) return; // Iris 소유 항목: 항상 활성.
    const state = core.toolbarCommandState(t.docxEditor, menuSlotId);
    const enabled = DOCX_IRIS_OWNED_ENABLED_SLOTS.has(menuSlotId) ? true : state.enabled;
    el.disabled = !enabled;
    el.setAttribute("aria-disabled", enabled ? "false" : "true");
    if (!enabled && state.disabledReason) el.title = state.disabledReason;
  });
  gdWireMenuKeyboard(anchor, box);
}
function docxFindOptions() {
  return {
    matchCase: !!docxview.querySelector("#docx-match-case")?.checked,
    wholeWord: !!docxview.querySelector("#docx-whole-word")?.checked,
  };
}
function docxFind(t) {
  const editor = t.docxEditor;
  const query = docxview.querySelector("#docx-find-query")?.value || "";
  if (!editor) {
    const status = docxview.querySelector("#docx-find-status");
    if (status) status.textContent = "준비 중";
    return { editor: null, query, matches: [] };
  }
  t.docxMatches = query ? Array.from(editor.findMatches(query, docxFindOptions())) : [];
  t.docxMatchIndex = Math.min(t.docxMatchIndex || 0, Math.max(0, t.docxMatches.length - 1));
  const status = docxview.querySelector("#docx-find-status");
  if (status) status.textContent = t.docxMatches.length ? `${t.docxMatchIndex + 1} / ${t.docxMatches.length}` : "없음";
  return { editor, query, matches: t.docxMatches };
}
export function docxMoveMatch(t, delta) {
  const found = docxFind(t);
  if (!found.matches.length) return;
  t.docxMatchIndex = (t.docxMatchIndex + delta + found.matches.length) % found.matches.length;
  found.editor.selectMatch(found.matches[t.docxMatchIndex]);
  const status = docxview.querySelector("#docx-find-status");
  if (status) status.textContent = `${t.docxMatchIndex + 1} / ${found.matches.length}`;
}
// editor.exec()에 replaceMatch/
// replaceAllMatches 타입을 넘기는 방식은 core d.ts에 선언되어 있지만 설치된 core 2.2.0의
// "tree editor" 구현체가 이 두 커맨드 타입을 처리하지 않는다({ok:false, code:"unsupported",
// reason:"command '...' is not supported by the tree editor"}. 대체 에디터 구현을 고를
// config도 없어 엔진 자체의 한계다). 검색·강조는 정상 동작해 이 결함은 무동작으로만
// 드러난다(콘솔 오류 없음).
// editor.surface.type(text)는 활성 선택 영역을 실제로 치환한다는 것을 직접 확인(선택 후
// type("X")는 선택 영역을 X로 교체, type("")는 선택 영역을 삭제. 둘 다 실제 브라우저에서
// FINDME 개수 변화로 검증됨, 화면도 즉시 다시 그려짐). exec() 대신 이 경로로 교체.
export function docxReplaceMatch(t) {
  const found = docxFind(t);
  const match = found.matches[t.docxMatchIndex || 0];
  if (!match) return;
  found.editor.selectMatch(match);
  found.editor.surface.type(docxview.querySelector("#docx-replace-text")?.value || "");
  docxFind(t);
  docxRefreshChrome(t);
}
export function docxReplaceAllMatches(t) {
  const found = docxFind(t);
  if (!found.editor || !found.query) return;
  const replaceText = docxview.querySelector("#docx-replace-text")?.value || "";
  // 치환 결과에 검색어가 다시 포함되면(예: "a"를 "aa"로) 매 회차 재조회가 새 일치를 계속 만들어낼
  // 수 있다. 무한 성장을 막기 위해 이번 호출 시작 시점의 일치 개수만큼만 반복한다(그 이상의 새
  // 일치는 이번 "모두 바꾸기"의 대상이 아니며, 사용자가 다시 실행하면 그때 처리된다).
  const count = found.matches.length;
  for (let i = 0; i < count; i++) {
    const current = docxFind(t);
    if (!current.matches.length) break;
    current.editor.selectMatch(current.matches[0]);
    current.editor.surface.type(replaceText);
  }
  docxFind(t);
  docxRefreshChrome(t);
}
export function docxShowFind(t, show) {
  const bar = docxview.querySelector("#docx-find-bar");
  if (!bar) return;
  bar.hidden = !show;
  if (show) {
    const input = docxview.querySelector("#docx-find-query");
    if (input) { input.focus(); input.select(); }
    docxFind(t);
  }
}
export function docxShowLinkEditor(t, show) {
  const bar = docxview.querySelector("#docx-link-bar");
  if (!bar) return;
  bar.hidden = !show;
  if (!show) return;
  const links = t.docxEditor && t.docxEditor.surface && t.docxEditor.surface.hyperlinks;
  const current = links && links.linkAtCaret();
  const input = docxview.querySelector("#docx-link-url");
  if (input) { input.value = current ? current.authored : ""; input.focus(); input.select(); }
}
export function docxApplyHyperlink(t) {
  const links = t.docxEditor && t.docxEditor.surface && t.docxEditor.surface.hyperlinks;
  const input = docxview.querySelector("#docx-link-url");
  if (!links || !input) return;
  if (links.applyHyperlink({ url: input.value.trim() })) docxShowLinkEditor(t, false);
  else showToast("이 선택에는 링크를 적용할 수 없습니다.");
  docxRefreshChrome(t);
}
// 실행취소로 원본과 같은 내용이 됐는지 판정할 유일한 근거다. core는 내용 동일성을 직접
// 알려주지 않는다. 저장/로드 시점 바이트의 해시를 기준으로 남겨두고
// (docxHashBytes), 타이핑이 멈춘 뒤 현재 내용을 다시 export해 같은 해시로 비교한다
// (docxScheduleHashRecheck). 매 keystroke마다 하면 큰 문서에서 느려지므로 800ms 디바운스한다.
export async function docxHashBytes(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
const DOCX_AUTOFORMAT_BULLET_RE = /^-\x20$/;
const DOCX_AUTOFORMAT_ORDERED_RE = /^\d+\.\x20$/;
// "-"+스페이스 → 글머리 기호, "1."+스페이스 → 번호 목록으로 자동 전환(구글 독스 자동서식과
// 동일 트리거). change 콜백은 이미 queueMicrotask로 core 동기 호출 스택
// 밖에서 돌게 되어 있으므로(위 change 리스너 주석 참조) exec()도 그 안전한 자리에서만 건다.
// 문단 텍스트가 정확히 "마커+스페이스"뿐일 때만 걸어 문장 중간의 "3 - 5 " 같은 경우를 피한다.
// 지운 뒤 문단이 빈 문자열이 되므로 다음 change에서 같은 조건이 다시 안 걸려 재귀 걱정이 없다.
export function docxMaybeAutoformatList(editor) {
  const snap = editor.snapshot();
  const sel = snap.selection;
  if (!sel || !sel.from || !sel.to || JSON.stringify(sel.from) !== JSON.stringify(sel.to)) return;
  const paraId = sel.from.paraId;
  if (!paraId) return;
  const para = editor.query({ type: "paragraphs" }).find((p) => p.paraId === paraId);
  const text = para && para.text;
  if (!text) return;
  const isBullet = DOCX_AUTOFORMAT_BULLET_RE.test(text);
  const isOrdered = !isBullet && DOCX_AUTOFORMAT_ORDERED_RE.test(text);
  if (!isBullet && !isOrdered) return;
  // 같은 문단·같은 텍스트로 두 번 연속 시도하지 않는다. 아래 세 exec 중 하나라도 마커를
  // 지우지 못하면 문단이 "마커+스페이스"로 남아 toggleList가 매 change마다 켜고 끄기를 반복하며
  // 무한 루프로 이어진다(탭이 응답 불가 상태가 되어 새 탭으로 복구해야
  // 한다). 시도한 (paraId,text) 조합을 한 번만 허용해 최악의 경우에도 무한 루프 대신
  // 실패로 그친다.
  const key = paraId + "\0" + text;
  if (editor.__docxAutoformatLastKey === key) return;
  editor.__docxAutoformatLastKey = key;
  // core의 DocTarget search/offset 주소는 이 런타임(tree editor)에 구현돼 있지 않다. replaceText는
  // "not supported"로 즉시 거부되고, offset 기반 setSelection도 에러 없이 조용히 selection을
  // null로 만들 뿐 실제로는 안 걸린다(둘 다 직접 측정). 유일하게 확인된 경로:
  // {from:{paraId}, to:{paraId}} 범위가 실제 Home+Shift+End 키 조작과 동일하게 "문단 전체"를
  // 선택하고(selectedText 쿼리로 검증됨), deleteText는 target 없이 그 현재 선택만 지운다
  // ("deletion removes the selection" 확인 결과). 이 문단은 마커만 있는 상태이므로 "전체 선택 후
  // 삭제"가 곧 "마커만 삭제"와 같다.
  const selResult = editor.exec({ type: "setSelection", range: { from: { paraId }, to: { paraId } } });
  if (!selResult || selResult.ok !== true) return;
  const delResult = editor.exec({ type: "deleteText" });
  if (!delResult || delResult.ok !== true) return;
  editor.exec({ type: "toggleList", kind: isBullet ? "bullet" : "ordered" });
}
export function docxScheduleHashRecheck(t, editor) {
  clearTimeout(t.docxHashCheckTimer);
  t.docxHashCheckTimer = setTimeout(async () => {
    if (t.docxEditor !== editor || !t.docxSavedHash) return;
    const targetRevision = editor.getDocumentHandle().revision;
    let buf;
    try { buf = await editor.save(); } catch (e) { return; }
    if (t.docxEditor !== editor) return;
    const hash = await docxHashBytes(new Uint8Array(buf));
    if (t.docxEditor !== editor) return;
    t.docxHashCheckedRevision = targetRevision;
    t.docxHashMatchesSaved = hash === t.docxSavedHash;
    markTabDirty(t.id, isTabDirty(t));
  }, 800);
}
function docxEditorBarsHtml() {
  return `<div class="docx-inline-bar" id="docx-find-bar" hidden>
    <input id="docx-find-query" type="text" aria-label="찾을 내용" placeholder="찾기">
    <input id="docx-replace-text" type="text" aria-label="바꿀 내용" placeholder="바꾸기">
    <label><input id="docx-match-case" type="checkbox">대소문자</label>
    <label><input id="docx-whole-word" type="checkbox">단어</label>
    <span class="docx-find-status" id="docx-find-status">없음</span>
    <button data-docx-act="find-prev" title="이전">↑</button><button data-docx-act="find-next" title="다음">↓</button>
    <button data-docx-act="replace-one">바꾸기</button><button data-docx-act="replace-all">모두 바꾸기</button>
    <button data-docx-act="find-close" title="닫기">×</button></div>
    <div class="docx-inline-bar" id="docx-link-bar" hidden>
      <input id="docx-link-url" type="text" aria-label="링크 주소" placeholder="https://example.com">
      <button data-docx-act="link-apply">적용</button><button data-docx-act="link-close">취소</button></div>`;
}
export function docxEditorShellHtml(t) {
  const conflict = t.docxDiskRevision != null
    ? `<div class="fv-conflict">이 파일이 밖에서 바뀌었습니다. 내 편집이 남아 있어 자동으로 바꾸지 않았습니다.</div>`
    : "";
  return `<div class="docx-editor-shell"><div class="fv-bar"><span class="fv-name">${esc(t.label)}</span>${filePathBarHtml(t.path)}</div>
    <div class="gd-menu" role="menubar" aria-label="문서 메뉴"></div>
    <div class="gd-tb" role="toolbar" aria-label="문서 도구 모음"><span class="docx-control-label">편집기 준비 중…</span></div>
    <div class="docx-inline-bar"><button data-docx-act="find-open">찾기/바꾸기</button>
      <span class="docx-mode-switch" role="group" aria-label="편집 모드"><button data-docx-act="mode-edit">편집</button><button data-docx-act="mode-view">보기</button></span></div>
    ${docxEditorBarsHtml()}${conflict}<div class="docx-view-outer"><div class="docx-view-root docx-editor docx-paginated-surface"></div></div></div>`;
}
export function docxSaveTab(t, space) {
  if (t._saveInFlight) return t._saveInFlight;
  if (!t.docxEditor) return;
  const editor = t.docxEditor;
  const startHandleRevision = editor.getDocumentHandle().revision;
  const completion = (async () => {
    const buf = await editor.save();
    const bytes = new Uint8Array(buf);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    const data = btoa(binary);
    const hashPromise = docxHashBytes(bytes); // 저장 요청과 동시에 계산한다. 왕복 지연에 포함되어 추가 지연이 없다
    const pending = sendTabIo({ type: "docx.write", path: t.path, data,
      baselineRevision: t.docxRevision, space: space || getCenterSpace(), tabId: t.id, reason: "save" });
    const resp = await pending;
    const editorIsCurrent = t.docxEditor === editor;
    if (!editorIsCurrent) throw new Error("DOCX_SAVE_STALE");
    if (resp.error) {
      if (resp.conflict) showToast("외부에서 파일이 바뀌어 저장할 수 없습니다. 새로고침 후 다시 시도하세요");
      else showToast("저장 실패: " + resp.error);
      throw new Error(resp.error);
    }
    t.docxRevision = resp.revision;
    t.docxData = data;
    t.docxHandleRevision = startHandleRevision;
    t.docxDirty = false;
    t.docxSavedHash = await hashPromise; // 이 저장이 새 기준선이다. 다음 실행취소가 여기로 돌아오면 dirty가 꺼진다
    if (t.docxEditor === editor) { t.docxHashCheckedRevision = editor.getDocumentHandle().revision; t.docxHashMatchesSaved = true; }
    markTabDirty(t.id, isTabDirty(t)); // 이 호출 없이는
    // 저장이 성공(isTabDirty()=false)해도 탭의 dirty 점이 다음 탭 재렌더까지 남는다.
    return resp;
  })().catch((error) => { throw error; })
    .finally(() => { if (t._saveInFlight === completion) t._saveInFlight = null; });
  t._saveInFlight = completion;
  return completion;
}
