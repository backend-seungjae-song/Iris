// 대화 화면 코드 블록 오른쪽 아래 복사 단추
// - Paseo 0.15.3 마크다운 렌더러의 코드 블록(pre[aria-label^="Code block"])에는 복사 단추가 없음
// - 단추는 pre 바로 뒤 높이 0 줄에. pre 는 가로 스크롤 상자라 안에 넣으면 긴 줄을 넘길 때 단추도 밀림
// - 메시지 복사(Paseo assistant-selection-copy)에 섞이지 않게 data-paseo-markdown-ignore

const CODE_BLOCK = 'pre[aria-label^="Code block"]';
const ROW = "iris-code-copy";
const SIZE = 22;
const GAP = 4;
const COPIED_MS = 1500;
const LABEL = "코드 복사";

// 붙여 넣는 글. 끝 줄바꿈은 뺌(터미널에 붙이면 마지막 줄이 바로 실행됨, Paseo highlighted-code-block 과 같은 규칙)
export function codeForCopy(text) {
  return String(text || "").replace(/(?:\r?\n)+$/, "");
}

const ICON_COPY = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const ICON_CHECK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

const CSS = `
.${ROW} { display: flex; justify-content: flex-end; height: 0; overflow: visible; pointer-events: none; }
.${ROW} button { position: relative; display: grid; place-items: center; width: ${SIZE}px; height: ${SIZE}px; margin-right: ${GAP}px; padding: 0;
  border: 0; border-radius: 6px; background: transparent; color: var(--colors-foreground-muted, var(--ictx-muted)); cursor: pointer; pointer-events: auto; }
.${ROW} button:hover { color: var(--colors-foreground, var(--ictx-fg)); background: color-mix(in srgb, currentColor 12%, transparent); }
.${ROW} button:focus-visible { outline: 2px solid var(--ictx-ring, currentColor); outline-offset: -2px; }
`;

async function writeClipboard(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  // 권한이 없을 때(창에 포커스가 없는 등) 예전 방식
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch {}
  ta.remove();
  return ok;
}

function makeRow(pre) {
  const row = document.createElement("div");
  row.className = ROW;
  row.dataset.paseoMarkdownIgnore = "true";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.title = LABEL;
  btn.setAttribute("aria-label", LABEL);
  btn.innerHTML = ICON_COPY;
  // pre 의 아래 여백·부모 gap 만큼 더 올려 pre 안쪽 오른쪽 아래에 놓음
  const cs = getComputedStyle(pre);
  const parentGap = parseFloat(getComputedStyle(pre.parentElement).rowGap) || 0;
  btn.style.top = `-${SIZE + GAP + (parseFloat(cs.marginBottom) || 0) + parentGap}px`;
  let timer = 0;
  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const ok = await writeClipboard(codeForCopy(pre.textContent));
    btn.innerHTML = ok ? ICON_CHECK : ICON_COPY;
    btn.setAttribute("aria-label", ok ? "복사됨" : "복사하지 못했습니다");
    btn.title = btn.getAttribute("aria-label");
    clearTimeout(timer);
    timer = setTimeout(() => { btn.innerHTML = ICON_COPY; btn.setAttribute("aria-label", LABEL); btn.title = LABEL; }, COPIED_MS);
  });
  row.appendChild(btn);
  return row;
}

function scan() {
  for (const pre of document.querySelectorAll(CODE_BLOCK)) {
    if (pre.nextElementSibling?.classList.contains(ROW)) continue;
    pre.after(makeRow(pre));
  }
  // 코드 블록이 사라지거나 바뀐 뒤 남은 단추
  for (const row of document.querySelectorAll(`.${ROW}`)) if (!row.previousElementSibling?.matches(CODE_BLOCK)) row.remove();
}

// 대화가 그려지고 글이 흘러 들어올 때마다 프레임당 한 번 다시 봄
export function installCodeCopy() {
  if (document.getElementById(ROW)) return;
  const style = document.createElement("style");
  style.id = ROW;
  style.textContent = CSS;
  document.head.appendChild(style);
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; scan(); });
  };
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  schedule();
}
