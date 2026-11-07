// 입력 글 속 칩 처리(계산은 iris-inline-tokens.js)
// - 칩 모양: textarea 위에 같은 글을 투명하게 그린 층을 두고, 칩 자리 글자 위에 칩 요소를 덮음
// - 칩 글자를 지우면 위 미리보기(Paseo 첨부·요소 칩)에서도 빠지고, 위에서 빼면 글 속 칩도 빠짐
// - 칩을 누르면 이미지는 Paseo 미리보기를 누른 것과 같게(확대), 파일은 Iris 에서 열기, 링크 항목은 브라우저,
//   요소·붙인 글은 내용 팝업. X 는 지우기
// - 긴 붙여넣기는 글 대신 칩. 내용은 부모(boot.js)의 요소 칩 목록에 kind "paste" 로 저장
import { useDraftStore } from "@/stores/draft-store";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { SHIM_SERVER_ID } from "./iris-shim";
import { attachmentTag, contextTag, cutToken, describeAttachment, describeContext, dropAttachment, dropContext, dropImage, findTokens, imageTag, isLongPaste, reglue, removedTokens, shrinkTag, tokenLabel, tokensToDelete } from "./iris-inline-tokens";

export interface InlineContext { id: string; content: string; no?: number; kind?: string }
interface Host { post: (msg: Record<string, unknown>) => void; openContext: (id: string) => void; mods: () => Record<string, boolean> }

let host: Host | null = null;
let key: string | null = null;
let contexts: InlineContext[] = [];
let knownIds = new Set<string>();
// 사용자가 고치기 직전 글(beforeinput). Paseo 가 글을 바꿀 때(보내고 비움·초안 불러옴)는 input 이 없어서 여기서 잡음
let beforeText = "";
let imageIds: string[] = [];
let attIds: string[] = [];
let imageKey: string | null = null;
let writing = false;

const textarea = (): HTMLTextAreaElement | null => document.querySelector('[data-testid="message-input-root"] textarea');
const draftKey = (k: string) => buildDraftStoreKey({ serverId: SHIM_SERVER_ID, agentId: k });
const imageIdOf = (a: any, i: number) => String(a?.metadata?.id ?? a?.id ?? a?.metadata?.uri ?? `#${i}`);
const attIdOf = (a: any, i: number) => String(a?.attachment?.id ?? a?.id ?? a?.item?.url ?? a?.path ?? `${a?.kind}#${i}`);
const draftAttachments = (k: string): any[] => useDraftStore.getState().getDraftInput(draftKey(k))?.attachments ?? [];
function draftImageIds(k: string): string[] {
  return draftAttachments(k).filter((a: any) => a?.kind === "image").map(imageIdOf);
}
// 이미지 아닌 첨부(파일·GitHub 항목 등). 칩 번호 n = 이 목록의 n 번째
const otherAttachments = (k: string): any[] => draftAttachments(k).filter((a: any) => a?.kind !== "image");
const draftAttIds = (k: string) => otherAttachments(k).map(attIdOf);

// Paseo 가 받는 방식(react-native-web onChange)으로 글을 바꿈
function setText(ta: HTMLTextAreaElement, next: string, caret: number) {
  if (ta.value === next) return;
  writing = true;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(ta, next);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  writing = false;
  const at = Math.max(0, Math.min(caret, next.length));
  if (document.activeElement === ta) ta.setSelectionRange(at, at);
}

// 커서 자리에 칩 글자. 앞뒤가 글자에 붙으면 공백 하나
// - 글에 이미 있는 칩 글자는 다시 넣지 않음(임시 저장 불러오기가 칩 글자까지 든 글을 먼저 씀)
function insertTags(all: string[]) {
  const ta = textarea();
  const tags = ta ? all.filter((t) => !ta.value.includes(t)) : [];
  if (!ta || !tags.length) return;
  const start = ta.selectionStart ?? ta.value.length;
  const before = ta.value.slice(0, start);
  const after = ta.value.slice(ta.selectionEnd ?? start);
  const head = before + (before && !/\s$/.test(before) ? " " : "") + tags.join(" ");
  setText(ta, `${head} ${after.replace(/^ /, "")}`, head.length + 1);
  ta.focus({ preventScroll: true });
  ta.setSelectionRange(head.length + 1, head.length + 1);
}

// 입력창 글 전체를 바꿈(임시 저장). 사용자가 칩 글자를 지운 것으로 보지 않음
export function writeComposer(next: string): boolean {
  const ta = textarea();
  if (!ta) return false;
  setText(ta, next, next.length);
  beforeText = next;
  return true;
}

// 이미지(image true) 또는 이미지 아닌 첨부의 n(1부터) 번째를 첨부에서 뺌. 글 속 번호 당김은 아래 초안 구독이 함
function removeAttachment(image: boolean, n: number) {
  if (!key) return;
  const store = useDraftStore.getState();
  const dk = draftKey(key);
  const d = store.getDraftInput(dk);
  if (!d) return;
  let seen = 0;
  const attachments = d.attachments.filter((a: any) => (a?.kind === "image") !== image || ++seen !== n);
  if (attachments.length === d.attachments.length) return;
  store.saveDraftInput({ draftKey: dk, draft: { text: textarea()?.value ?? d.text, attachments } });
}

// 부모가 보낸 요소 칩 목록. 새 칩은 커서 자리에 넣고, 빠진 칩은 글에서도 뺌
export function syncContexts(nextKey: string | null, list: InlineContext[]) {
  if (nextKey !== key) {
    key = nextKey;
    contexts = list;
    knownIds = new Set(list.map((c) => c.id));
    const hydrated = useDraftStore.persist.hasHydrated();
    imageKey = hydrated ? key : null;
    imageIds = hydrated && key ? draftImageIds(key) : [];
    attIds = hydrated && key ? draftAttIds(key) : [];
    return;
  }
  const added = list.filter((c) => !knownIds.has(c.id) && Number.isInteger(c.no));
  const removed = contexts.filter((c) => !list.some((x) => x.id === c.id));
  contexts = list;
  knownIds = new Set(list.map((c) => c.id));
  const ta = textarea();
  if (!ta) return;
  if (removed.length) {
    let text = ta.value;
    for (const c of removed) text = dropContext(text, c);
    setText(ta, text, Math.min(ta.selectionStart ?? text.length, text.length));
  }
  if (added.length) insertTags(added.map(contextTag));
}

// 한 종류(이미지 또는 그 밖의 첨부) 목록 변화를 글에 반영: 빠진 것의 칩을 빼고 번호를 당김, 늘어난 것의 칩 글자를 돌려줌
function applyListChange(prev: string[], ids: string[], drop: (text: string, n: number) => string, tag: (n: number) => string): string[] {
  if (prev.length === ids.length && prev.every((x, i) => x === ids[i])) return [];
  const ta = textarea();
  if (!ta) return [];
  const gone = prev.map((id, i) => (ids.includes(id) ? -1 : i)).filter((i) => i >= 0).reverse();
  if (gone.length) {
    let text = ta.value;
    for (const i of gone) text = drop(text, i + 1);
    setText(ta, text, Math.min(ta.selectionStart ?? text.length, text.length));
  }
  const kept = prev.length - gone.length;
  return Array.from({ length: Math.max(0, ids.length - kept) }, (_, i) => tag(kept + i + 1));
}

// 첨부가 늘면 커서 자리에 칩, 빠지면(위 미리보기 X) 글 속 칩도 빼고 번호를 당김
useDraftStore.subscribe(() => {
  if (!key || !useDraftStore.persist.hasHydrated()) return;
  const ids = draftImageIds(key);
  const others = draftAttIds(key);
  if (imageKey !== key) { imageKey = key; imageIds = ids; attIds = others; return; }
  const [prevImages, prevOthers] = [imageIds, attIds];
  imageIds = ids;
  attIds = others;
  const list = otherAttachments(key);
  const tags = [
    ...applyListChange(prevImages, ids, dropImage, imageTag),
    ...applyListChange(prevOthers, others, dropAttachment, (n) => attachmentTag(describeAttachment(list[n - 1]).label, n)),
  ];
  if (tags.length) insertTags(tags);
});

function onBeforeInput(e: Event) {
  if (e.target === textarea()) beforeText = (e.target as HTMLTextAreaElement).value;
}
// 사용자가 칩 글자를 지움 → 위 미리보기·첨부에서도 뺌
function onInput(e: Event) {
  const ta = textarea();
  if (writing || e.target !== ta || !ta) return;
  const gone = removedTokens(beforeText, ta.value, contexts);
  beforeText = ta.value;
  if (gone.ids.length && key) host?.post({ type: "iris-chat.context-remove", key, ids: gone.ids });
  for (const n of gone.images) removeAttachment(true, n);
  for (const n of gone.attachments) removeAttachment(false, n);
}
// Backspace·Delete 가 칩에 닿으면 칩 전체를 지움(선택을 칩 끝까지 넓히고 기본 동작에 맡김)
function onKeyDown(e: KeyboardEvent) {
  const ta = textarea();
  if (e.target !== ta || !ta || e.isComposing || (e.key !== "Backspace" && e.key !== "Delete")) return;
  const s = ta.selectionStart ?? 0;
  const t = ta.selectionEnd ?? s;
  const hit = tokensToDelete(findTokens(ta.value, contexts), s, t, e.key === "Backspace" ? -1 : 1);
  if (!hit.length) return;
  const from = Math.min(s, ...hit.map((x) => x.start));
  let to = Math.max(t, ...hit.map((x) => x.end));
  // 칩 앞뒤 공백이 둘 다 남지 않게 뒤 공백 하나도
  if (ta.value[to] === " " && (from === 0 || ta.value[from - 1] === " ")) to += 1;
  ta.setSelectionRange(from, to);
}
// 긴 붙여넣기 → 칩. 이미지·파일 붙여넣기는 Paseo 가 그대로
function onPaste(e: ClipboardEvent) {
  const ta = textarea();
  if (e.target !== ta || !ta || !key || !e.clipboardData) return;
  if ([...e.clipboardData.items].some((it) => it.kind === "file")) return;
  const text = e.clipboardData.getData("text/plain");
  if (!isLongPaste(text)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  host?.post({ type: "iris-chat.context-add", key, content: text, kind: "paste" });
}

// 칩 층: textarea 위에 같은 글을 투명하게 그리고, 칩 자리 글자(mark) 위에 칩 요소를 덮음
// - 층은 누름을 통과시키고 칩만 받음. 칩 본문 누름 = 내용 보기, X = 지우기
// - 자주 하는 입력이라 칩이 생길 때 애니메이션 없음, 누를 때만 짧게 줄어듦(Emil design engineering)
let layer: HTMLDivElement | null = null;
let painted = "";
const COPY = ["fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "lineHeight", "wordSpacing", "textIndent", "textAlign", "tabSize",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "boxSizing"] as const;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

// lucide 아이콘 path(iris-contexts.tsx 의 칩 묶음과 같은 그림)
const SVG = (d: string) => `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON: Record<string, string> = {
  image: SVG('<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>'),
  paste: SVG('<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>'),
  element: SVG('<path d="M14 4.1 12 6"/><path d="m5.1 8-2.9-.8"/><path d="m6 12-1.9 2"/><path d="M7.2 2.2 8 5.1"/><path d="M9.037 9.69a.498.498 0 0 1 .653-.653l11 4.5a.5.5 0 0 1-.074.949l-4.349 1.041a1 1 0 0 0-.74.739l-1.04 4.35a.5.5 0 0 1-.95.074z"/>'),
  app: SVG('<rect width="14" height="20" x="5" y="2" rx="2"/><path d="M12 18h.01"/>'),
  file: SVG('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>'),
  chat: SVG('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
  link: SVG('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  other: SVG('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/>'),
};
const X_ICON = SVG('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>');

function chipKind(t: { type: string; id?: string; n?: number }) {
  if (t.type === "image") return "image";
  if (t.type === "attachment") {
    const icon = key ? describeAttachment(otherAttachments(key)[(t.n ?? 0) - 1]).icon : "file";
    return ICON[icon] ? icon : "file";
  }
  const c = contexts.find((x) => x.id === t.id);
  const k = c ? describeContext(c).kind : "other";
  return ICON[k] ? k : k === "device" ? "app" : "other";
}

function paint() {
  const ta = textarea();
  // 설치 전 초안의 칩 글자: 새 형식으로 바꿔 줄 끝에서 나뉘지 않게(커서는 같은 글자 뒤)
  if (ta && ta.value.includes("⟦")) {
    const next = reglue(ta.value, contexts);
    if (next !== ta.value) {
      const caret = ta.selectionStart ?? ta.value.length;
      const before = reglue(ta.value.slice(0, caret), contexts);
      setText(ta, next, next.startsWith(before) ? before.length : next.length);
    }
  }
  const toks = ta ? findTokens(ta.value, contexts) : [];
  if (!ta || !toks.length) { if (layer) { layer.remove(); layer = null; painted = ""; } return; }
  const parent = ta.parentElement;
  if (!parent) return;
  if (!layer || layer.parentElement !== parent) {
    layer?.remove();
    layer = document.createElement("div");
    layer.className = "iris-tok-layer";
    layer.addEventListener("mousedown", (e) => { if ((e.target as Element).closest(".iris-tok")) e.preventDefault(); });
    layer.addEventListener("click", onChipClick);
    parent.insertBefore(layer, ta.nextSibling);
    if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
    painted = "";
  }
  const sig = `${ta.value}\u0000${ta.offsetLeft},${ta.offsetTop},${ta.offsetWidth},${ta.offsetHeight}\u0000${contexts.map((c) => c.id).join(",")}`;
  if (sig !== painted) {
    painted = sig;
    const cs = getComputedStyle(ta);
    for (const p of COPY) (layer.style as any)[p] = cs[p];
    Object.assign(layer.style, { left: `${ta.offsetLeft}px`, top: `${ta.offsetTop}px`, width: `${ta.offsetWidth}px`, height: `${ta.offsetHeight}px` });
    let html = "";
    let at = 0;
    toks.forEach((t, i) => {
      if (t.start < at) return;
      const raw = ta.value.slice(t.start, t.end);
      const label = tokenLabel(raw);
      html += esc(ta.value.slice(at, t.start))
        + `<mark>${esc(raw)}<span class="iris-tok" data-i="${i}" title="${esc(label)}">`
        + `<button type="button" class="iris-tok-open" tabindex="-1" aria-label="${esc(label)} 보기">${ICON[chipKind(t)]}<span>${esc(label)}</span></button>`
        + `<button type="button" class="iris-tok-x" tabindex="-1" aria-label="${esc(label)} 빼기">${X_ICON}</button></span></mark>`;
      at = t.end;
    });
    layer.innerHTML = `${html}${esc(ta.value.slice(at))}​`;
    fitLongChip(ta);
  }
  layer.scrollTop = ta.scrollTop;
}

// 입력창 한 줄보다 긴 칩(두 줄 이상에 걸침)은 이름을 줄여 한 줄에 맞춤. 한 번에 하나, 다음 프레임에 다시 확인
function fitLongChip(ta: HTMLTextAreaElement) {
  if (!layer) return;
  const cs = getComputedStyle(ta);
  const avail = ta.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const marks = [...layer.querySelectorAll("mark")];
  const toks = findTokens(ta.value, contexts);
  for (const [i, mark] of marks.entries()) {
    const rects = [...mark.getClientRects()];
    if (new Set(rects.map((r) => Math.round(r.top))).size < 2) continue;
    const t = toks[Number(mark.querySelector<HTMLElement>(".iris-tok")?.dataset.i ?? i)];
    if (!t) continue;
    const width = rects.reduce((sum, r) => sum + r.width, 0);
    const next = shrinkTag(ta.value.slice(t.start, t.end), (avail * 0.9) / width);
    if (!next) continue;
    const caret = ta.selectionStart ?? ta.value.length;
    const shift = next.length - (t.end - t.start);
    setText(ta, ta.value.slice(0, t.start) + next + ta.value.slice(t.end), caret >= t.end ? caret + shift : Math.min(caret, t.start));
    return;
  }
}

// 칩 하나를 글에서 지우고 위 미리보기·첨부에서도 뺌
function removeToken(t: { type: string; n?: number; id?: string; start: number; end: number }) {
  const ta = textarea();
  if (!ta) return;
  const cut = cutToken(ta.value, t);
  setText(ta, cut.text, cut.caret);
  ta.focus({ preventScroll: true });
  ta.setSelectionRange(cut.caret, cut.caret);
  if (t.type === "context" && t.id && key) host?.post({ type: "iris-chat.context-remove", key, ids: [t.id] });
  else if (t.type === "image" && t.n) removeAttachment(true, t.n);
  else if (t.type === "attachment" && t.n) removeAttachment(false, t.n);
}

function onChipClick(e: MouseEvent) {
  const chip = (e.target as Element).closest<HTMLElement>(".iris-tok");
  const ta = textarea();
  if (!chip || !ta) return;
  e.preventDefault();
  const t = findTokens(ta.value, contexts)[Number(chip.dataset.i)];
  if (!t) return;
  if ((e.target as Element).closest(".iris-tok-x")) { removeToken(t); return; }
  ta.focus({ preventScroll: true });
  ta.setSelectionRange(t.end, t.end);
  if (t.type === "context" && t.id) { host?.openContext(t.id); return; }
  if (t.type === "attachment") {
    const a = key ? describeAttachment(otherAttachments(key)[(t.n ?? 0) - 1]) : null;
    // 파일은 터미널 경로 링크와 같게 Iris 에서 엶(⌘⇧ 는 Finder), 링크 항목은 Iris 브라우저
    if (a?.path) host?.post({ type: "iris-chat.open-file", key, path: a.path, mods: host.mods() });
    else if (a?.url) host?.post({ type: "iris-chat.open-url", key, url: a.url });
    return;
  }
  // Paseo 위 미리보기의 같은 이미지를 누른 것과 같게(확대 보기)
  document.querySelectorAll<HTMLElement>('[data-testid="composer-image-attachment-pill"]')[(t.n ?? 0) - 1]?.click();
}

// 커서가 칩 글자 안에 들어가지 않게. 화살표는 칩을 한 번에 건너뜀
function onArrow(e: KeyboardEvent) {
  const ta = textarea();
  if (e.target !== ta || !ta || e.shiftKey || e.metaKey || e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
  const s = ta.selectionStart ?? 0;
  if (s !== ta.selectionEnd) return;
  const t = findTokens(ta.value, contexts).find((x) => (e.key === "ArrowLeft" ? x.end === s : x.start === s));
  if (!t) return;
  e.preventDefault();
  const at = e.key === "ArrowLeft" ? t.start : t.end;
  ta.setSelectionRange(at, at);
}
function onSelection() {
  const ta = textarea();
  if (!ta || document.activeElement !== ta) return;
  const s = ta.selectionStart ?? 0;
  if (s !== ta.selectionEnd) return;
  const t = findTokens(ta.value, contexts).find((x) => x.start < s && s < x.end);
  if (t) ta.setSelectionRange(s - t.start < t.end - s ? t.start : t.end, s - t.start < t.end - s ? t.start : t.end);
}

// 칩 모양 기준: 폰 앱 PastedContextChip·iris-contexts.tsx 칩 묶음(아이콘·종류 · 요약·X), 글 줄 높이에 맞춘 작은 크기
// - 이름 글자 padding-top 0.07em: 한글 글꼴은 글자 상자 안에서 글자가 위로 치우쳐 칩 가운데보다 뜸(2배 사진 위 8·아래 12 → 맞춤)
// - 글자 크기는 입력 글에 비례(0.96em). 칩 자리 글자 폭(⟦·en space 4개 = 아이콘·X 자리)을 이름이 채워 X 앞에 빈 칸이 안 남게
const STYLE = `
.iris-tok-layer { position: absolute; z-index: 2; margin: 0; overflow: hidden; pointer-events: none; color: transparent;
  white-space: pre-wrap; overflow-wrap: break-word; word-break: normal; border-style: solid; border-color: transparent; }
.iris-tok-layer mark { position: relative; color: transparent; background: none; }
.iris-tok { position: absolute; inset: -2px 0; display: flex; align-items: center; min-width: 0; pointer-events: auto;
  border-radius: 6px; background: var(--ictx-control, #1d2a36); border: 1px solid var(--ictx-border, #2c3b48);
  color: var(--ictx-fg, #e6edf3); font: 500 0.96em/1 system-ui, -apple-system, sans-serif; letter-spacing: 0; overflow: hidden;
  transition: transform 120ms cubic-bezier(0.23, 1, 0.32, 1), background-color 120ms ease; }
.iris-tok:hover { background: color-mix(in srgb, var(--ictx-control, #1d2a36) 82%, var(--ictx-fg, #e6edf3)); }
.iris-tok:has(.iris-tok-open:active) { transform: scale(0.97); }
.iris-tok-open { display: flex; align-items: center; gap: 4px; flex: 1; min-width: 0; height: 100%; padding: 0 0 0 4px;
  border: 0; background: none; color: inherit; font: inherit; cursor: pointer; }
.iris-tok-open svg { flex: none; color: var(--ictx-muted, #9aa7b2); }
.iris-tok-open span { min-width: 0; padding-top: 0.07em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.iris-tok-x { display: grid; place-items: center; flex: none; width: 16px; height: 100%; padding: 0; border: 0; background: none;
  color: var(--ictx-muted, #9aa7b2); cursor: pointer; }
.iris-tok-x:hover { color: var(--ictx-fg, #e6edf3); }
`;

export function installInlineChips(h: Host) {
  if (host) return;
  host = h;
  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.appendChild(style);
  document.addEventListener("beforeinput", onBeforeInput, true);
  document.addEventListener("input", onInput, true);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("keydown", onArrow, true);
  document.addEventListener("selectionchange", onSelection);
  document.addEventListener("paste", onPaste, true);
  // Paseo 가 글을 바꿔도(보내고 비움) input 이 없어 매 프레임 비교. 바뀐 게 없으면 그리지 않음
  const loop = () => { paint(); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
}
