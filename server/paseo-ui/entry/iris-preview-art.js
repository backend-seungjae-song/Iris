// 질문 카드 미리보기(AskUserQuestion preview)의 화면 시안을 터미널처럼 칸에 맞춰 그림
// - Paseo 카드는 미리보기를 줄바꿈하는 고정폭 상자로 그림. 시안은 긴 줄이 꺾이고, 한글·선 문자는 고정폭 글꼴에 없어
//   다른 글꼴의 폭으로 그려져 상자 선이 줄마다 어긋남
// - 선 그리기 문자나 ASCII 상자가 있는 미리보기만: 줄바꿈 없이 가로 스크롤, 넓은 글자 2칸·그 밖의 비 ASCII 1칸
// - Paseo 가 그린 글 요소는 숨기고 바로 뒤에 칸 맞춘 사본을 둠. React 가 관리하는 글 노드는 건드리지 않음

const BOX = /[─-▟]/;
const ASCII_EDGE = /^\s*\+[-=+]{3,}\+?\s*$/m;
const ASCII_SIDE = /^\s*\|.*\|\s*$/m;

// 선 그리기 문자, 또는 +---+ 줄과 | … | 줄이 함께 있는 ASCII 상자
export function isTextArt(text) {
  const s = String(text || "");
  return BOX.test(s) || (ASCII_EDGE.test(s) && ASCII_SIDE.test(s));
}

// 터미널에서 두 칸을 쓰는 글자(한글·한중일 문자·전각·그림 문자)
function wide(cp) {
  return (cp >= 0x1100 && cp <= 0x115F) || (cp >= 0x2E80 && cp <= 0xA4CF) || (cp >= 0xAC00 && cp <= 0xD7A3)
    || (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0xFE30 && cp <= 0xFE4F) || (cp >= 0xFF00 && cp <= 0xFF60)
    || (cp >= 0xFFE0 && cp <= 0xFFE6) || (cp >= 0x1F300 && cp <= 0x1FAFF) || (cp >= 0x20000 && cp <= 0x3FFFD);
}

// 글을 칸 단위 조각으로. cells 0 = 고정폭 글꼴 그대로 그리는 ASCII 묶음, 1·2 = 그 칸 수의 폭으로 고정할 글자
export function artCells(line) {
  const out = [];
  let ascii = "";
  for (const ch of String(line || "")) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) { ascii += ch; continue; }
    if (ascii) { out.push({ text: ascii, cells: 0 }); ascii = ""; }
    out.push({ text: ch, cells: wide(cp) ? 2 : 1 });
  }
  if (ascii) out.push({ text: ascii, cells: 0 });
  return out;
}

const SRC = "data-iris-art-src";
const COPY = "iris-art";
const CSS = `[${SRC}] { display: none !important; }
.${COPY} { white-space: pre; overflow-x: auto; overflow-wrap: normal; }
.${COPY} > span[data-c] { display: inline-block; text-align: center; overflow: visible; }
.${COPY} > span[data-c="1"] { width: 1ch; }
.${COPY} > span[data-c="2"] { width: 2ch; }`;

function render(copy, text) {
  copy.textContent = "";
  text.split("\n").forEach((line, i) => {
    if (i) copy.append("\n");
    for (const seg of artCells(line)) {
      if (!seg.cells) { copy.append(seg.text); continue; }
      const span = document.createElement("span");
      span.dataset.c = String(seg.cells);
      span.textContent = seg.text;
      copy.append(span);
    }
  });
  copy.dataset.text = text;
}

const own = (el) => [...el.children].filter((c) => !c.classList.contains(COPY));
// 미리보기 상자 안의 글 묶음. Paseo 는 줄마다 요소를 따로 둠 → 자식이 하나뿐인 동안 내려가 줄들을 가진 요소
// - 한 줄이면 글이 든 요소 그 자체
function textBlockOf(preview) {
  let el = preview;
  while (own(el).length === 1) el = own(el)[0];
  return el === preview ? null : el;
}
const blockText = (el) => (own(el).length ? own(el).map((c) => c.textContent || "").join("\n") : el.textContent || "");

function scan() {
  for (const preview of document.querySelectorAll('[data-testid="question-form-option-preview"]')) {
    const src = preview.querySelector(`[${SRC}]`) || textBlockOf(preview);
    if (!src) continue;
    const text = blockText(src);
    let copy = src.nextElementSibling?.classList.contains(COPY) ? src.nextElementSibling : null;
    if (!isTextArt(text)) {
      src.removeAttribute(SRC);
      copy?.remove();
      continue;
    }
    if (!copy) {
      copy = document.createElement("div");
      copy.className = COPY;
      src.after(copy);
    }
    // 글꼴·색·줄 높이는 Paseo 가 준 것 그대로. 숨기기 전에 읽음
    if (!src.hasAttribute(SRC)) {
      const cs = getComputedStyle(own(src)[0] || src);
      copy.style.font = cs.font;
      copy.style.color = cs.color;
      copy.style.lineHeight = cs.lineHeight;
      src.setAttribute(SRC, "");
    }
    if (copy.dataset.text !== text) render(copy, text);
  }
}

export function installPreviewArt() {
  const style = document.createElement("style");
  style.id = "iris-preview-art";
  style.textContent = CSS;
  document.head.appendChild(style);
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; scan(); });
  };
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true });
  schedule();
}
