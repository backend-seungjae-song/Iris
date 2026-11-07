// 입력 글 속 칩(이미지·그 밖의 첨부·Iris 요소·긴 붙여넣기)
// - Paseo 입력창이 textarea 라 칩 자리는 글자로 확보: "⟦␣␣이름 · 요약␣␣⟧"(␣ = en space, 이름 안 공백은 줄바꿈 안 되는 공백)
//   iris-inline-chips.ts 가 이 글자 위에 칩(아이콘·이름·X)을 덮어 그림. 앞뒤 en space 는 아이콘·X 자리
// - 칩 글자의 글자 사이마다 U+FEFF(폭 없음, 줄 나눔 금지): 줄 끝에 걸린 칩이 두 줄로 나뉘지 않고 통째로 다음 줄로 감
//   찾을 때는 U+FEFF 를 뺀 글에서 찾고 위치만 원래 글로 되돌림(예전 초안의 U+FEFF 없는 칩도 읽음)
// - 요소 칩은 같은 이름·요약이 겹칠 수 있어 끝에 폭 없는 문자(U+2060)를 no 개 붙여 구별. 찾을 때도 이 개수로 요소를 정함
//   (한 줄보다 긴 칩은 이름을 줄이므로 이름으로는 찾지 않음)
// - 이미지 아닌 첨부(파일·GitHub 항목 등) 칩은 끝에 U+2063 을 n 개 붙여 n 번째 첨부를 가리킴
// - 이미지·첨부 번호 = 각 종류 안의 첨부 순서(빼면 뒤 번호를 당김), 요소·붙인 글 번호 = 부모(boot.js)가 정한 no(바뀌지 않음)
// - DOM 을 보지 않음. 영향 범위: iris-inline-chips.ts, iris-chat-entry.tsx(전송), iris-contexts.tsx, test/agent-chat.mjs
import { parseContext } from "./iris-contexts-model.js";

const PAD = "\u2002\u2002";
const NB = "\u00a0";
const JOIN = "\u2060";
const ATT = "\u2063";
const GLUE = "\ufeff";
// - 이름·요약 속 ⟦ ⟧ 는 지움. 남으면 칩 글자를 찾는 패턴이 끊겨 칩도 안 그려지고 보낼 때도 안 펼쳐짐(P73)
const wrap = (inner, mark = "") => [...`⟦${PAD}${inner.replace(/[⟦⟧]/g, "").replace(/ /g, NB)}${mark}${PAD}⟧`].join(GLUE);

// U+FEFF 를 뺀 글과, 뺀 글의 각 위치가 원래 글의 어디인지
function unglue(s) {
  let out = "";
  const at = [];
  for (let i = 0; i < s.length; i++) if (s[i] !== GLUE) { at.push(i); out += s[i]; }
  at.push(s.length);
  return { out, span: (start, end) => ({ start: at[start], end: at[end - 1] + 1 }) };
}

export const imageTag = (n) => wrap(`이미지 ${n}`);
// 예전 초안에 남은 [이미지 #N]·[Image #N] 도 같은 이미지로 읽음
const IMAGE_RE = new RegExp(`⟦${PAD}이미지${NB}(\\d+)${PAD}⟧|\\[(?:이미지|Image) #(\\d+)\\]`, "g");

// 이미지 아닌 첨부 n(1부터)의 칩 글자
// - 이름은 칩 폭 때문에 줄임(앞 15자 … 끝 7자, 확장자가 보이게). 칩 경계 문자는 이름에서 뺌
const NAME_MAX = 24;
function shortName(name) {
  const s = String(name || "").replace(/[⟦⟧\u2002\u2060-\u2063\n\r\t]/g, " ").replace(/\s+/g, " ").trim() || "첨부";
  return s.length > NAME_MAX ? `${s.slice(0, 15)}…${s.slice(-7)}` : s;
}
export const attachmentTag = (name, n) => wrap(shortName(name), ATT.repeat(n));
const ATT_RE = new RegExp(`⟦${PAD}([^⟦⟧]*?)(${ATT}+)${PAD}⟧`, "g");
const CTX_RE = new RegExp(`⟦${PAD}([^⟦⟧]*?)(${JOIN}+)${PAD}⟧`, "g");

// Paseo 입력창 첨부(draft attachments 의 이미지 아닌 항목) → 칩 이름·아이콘 종류·누르면 열 곳
export function describeAttachment(a) {
  const item = a?.item;
  if (a?.kind === "file") return { label: a.attachment?.fileName || "파일", icon: "file", path: a.attachment?.path || null };
  if (a?.kind === "workspace_file") {
    const sel = a.selection?.kind === "line_range" ? `:${a.selection.startLine}-${a.selection.endLine}` : "";
    return { label: `${String(a.path || "").split("/").pop() || a.path}${sel}`, icon: "file", path: a.path || null };
  }
  if (item && typeof item.url === "string") {
    return { label: `${Number.isInteger(item.number) ? `#${item.number} ` : ""}${item.title || ""}`, icon: "link", url: item.url };
  }
  if (a?.kind === "plugin_resource") return { label: item?.title || a.sourceTitle || "첨부", icon: "file" };
  if (a?.kind === "browser_element") return { label: "브라우저 요소", icon: "element" };
  const title = a?.title || a?.attachment?.title;
  return { label: title || "첨부", icon: "file", ...(typeof a?.url === "string" ? { url: a.url } : {}) };
}

// 보낼 첨부(Paseo AgentAttachment) → 글에 넣을 내용. 파일은 @경로, 링크 항목은 제목·주소, 글 첨부는 그 글
// - @경로: Claude Code·Codex 가 파일 멘션으로 읽음. 업로드 이름에는 공백이 없음(uploadName)
export function attachmentText(a) {
  if (!a || typeof a !== "object") return "";
  if (a.type === "uploaded_file") return a.path ? `@${a.path}` : "";
  if (a.type === "text") return String(a.text || "");
  if (typeof a.url === "string") return [a.title, a.url].filter(Boolean).join(" ");
  return JSON.stringify(a);
}

// 칩에 보이는 글(칩 자리 글자에서 ⟦·en space·구별 문자를 뺀 것)
export function tokenLabel(raw) {
  return String(raw || "").replace(/^⟦|⟧$/g, "").replace(/[\u2002\u2060\u2063\ufeff]/g, "").replace(/\u00a0/g, " ").replace(/^\[|\]$/g, "").trim();
}

// 이 글 길이·줄 수를 넘는 붙여넣기는 칩으로(터미널 Claude Code 의 긴 붙여넣기 접기와 같은 성격, 기준값은 내가 정함)
export const LONG_PASTE_CHARS = 800;
export const LONG_PASTE_LINES = 10;
export function isLongPaste(text) {
  const s = String(text || "");
  return s.length > LONG_PASTE_CHARS || s.split("\n").length > LONG_PASTE_LINES;
}

const lineCount = (s) => String(s || "").replace(/\n+$/, "").split("\n").length;

// 칩 묶음·팝업에 쓰는 종류·요약
export function describeContext(c) {
  if (c?.kind === "paste") {
    const first = String(c.content || "").split("\n").find((l) => l.trim()) || "";
    const one = first.replace(/\s+/g, " ").trim();
    return { kind: "paste", label: "붙인 글", summary: `${lineCount(c.content)}줄 · ${one.length > 40 ? `${one.slice(0, 39)}…` : one}` };
  }
  return parseContext(c?.content);
}

const SUMMARY_MAX = 20;
export function contextTag(c) {
  const info = describeContext(c);
  const sum = c?.kind === "paste" ? `${lineCount(c.content)}줄` : info.summary;
  const short = sum.length > SUMMARY_MAX ? `${sum.slice(0, SUMMARY_MAX - 1)}…` : sum;
  return wrap(short && short !== info.label ? `${info.label} · ${short}` : info.label, JOIN.repeat(Math.max(1, c?.no || 1)));
}

// 글 속 칩 위치(원래 글 기준). 요소 칩은 지금 붙어 있는 요소의 no 와 구별 문자 개수가 같을 때만 칩
export function findTokens(text, contexts = []) {
  const { out: s, span } = unglue(String(text || ""));
  const out = [];
  const at = (m) => span(m.index, m.index + m[0].length);
  for (const m of s.matchAll(IMAGE_RE)) out.push({ type: "image", n: Number(m[1] ?? m[2]), ...at(m) });
  for (const m of s.matchAll(ATT_RE)) out.push({ type: "attachment", n: m[2].length, ...at(m) });
  // 설치 전 형식(U+FEFF 없음) 칩이 번호로 안 찾아지면 이름이 같은 요소로. 새 형식은 번호로만
  const raw = String(text || "");
  const byName = (m) => {
    const r = span(m.index, m.index + m[0].length);
    if (raw.slice(r.start, r.end).includes(GLUE)) return null;
    return contexts.find((x) => Number.isInteger(x?.no) && tokenLabel(contextTag(x)) === tokenLabel(m[0]));
  };
  for (const m of s.matchAll(CTX_RE)) {
    const c = contexts.find((x) => Number.isInteger(x?.no) && Math.max(1, x.no) === m[2].length) || byName(m);
    if (c) out.push({ type: "context", id: c.id, ...at(m) });
  }
  return out.sort((a, b) => a.start - b.start);
}

// 줄 나눔 금지 문자(U+FEFF)가 없는 예전 칩 글자를 새 형식으로. 요소 칩은 찾은 요소의 지금 칩 글자로(번호도 맞춤)
// - 바꿀 것이 없으면 같은 글
export function reglue(text, contexts = []) {
  let s = String(text || "");
  for (const t of findTokens(s, contexts).reverse()) {
    const raw = s.slice(t.start, t.end);
    if (raw.includes(GLUE)) continue;
    const c = t.type === "context" ? contexts.find((x) => x.id === t.id) : null;
    s = s.slice(0, t.start) + (c ? contextTag(c) : [...raw].join(GLUE)) + s.slice(t.end);
  }
  return s;
}

// 한 줄보다 긴 칩: 이름을 ratio 만큼으로 줄인 칩 글자(확장자가 있으면 가운데를 …). 더 줄일 수 없으면 null
export function shrinkTag(raw, ratio) {
  const u = String(raw || "").split(GLUE).join("");
  const m = u.match(new RegExp(`^⟦${PAD}([\\s\\S]*?)([${JOIN}${ATT}]*)${PAD}⟧$`));
  if (!m) return null;
  const label = tokenLabel(u);
  if (/^이미지 \d+$/.test(label)) return null;
  const chars = [...label];
  const keep = Math.max(2, Math.floor(chars.length * ratio));
  if (keep >= chars.length) return null;
  const ext = label.match(/\.[A-Za-z0-9]{1,6}$/)?.[0] ?? "";
  const short = ext && keep > ext.length + 2
    ? `${chars.slice(0, keep - ext.length - 1).join("")}…${ext}`
    : `${chars.slice(0, keep - 1).join("")}…`;
  return wrap(short, m[2]);
}

// 칩 하나를 지운 글과 커서. 칩 뒤(없으면 앞)의 공백 하나를 같이 지움
export function cutToken(text, token) {
  const s = String(text || "");
  let { start, end } = token;
  if (s[end] === " ") end += 1;
  else if (start > 0 && s[start - 1] === " ") start -= 1;
  return { text: s.slice(0, start) + s.slice(end), caret: start };
}

// type 칩 n 을 뺀 뒤 글: n 의 칩을 지우고 n 보다 큰 번호의 칩을 retag 로 다시 씀
function dropNumbered(text, type, n, retag) {
  let s = String(text || "");
  for (const t of findTokens(s).filter((x) => x.type === type && x.n === n).reverse()) s = cutToken(s, t).text;
  for (const t of findTokens(s).filter((x) => x.type === type && x.n > n).reverse()) s = s.slice(0, t.start) + retag(t.n - 1, s.slice(t.start, t.end)) + s.slice(t.end);
  return s;
}

// 이미지 n 을 뺀 뒤 글: n 의 칩을 지우고 n 보다 큰 번호를 하나씩 당김
export function dropImage(text, n) {
  return dropNumbered(text, "image", n, (k) => imageTag(k));
}

// 이미지 아닌 첨부 n 을 뺀 뒤 글: n 의 칩을 지우고 n 보다 큰 번호를 하나씩 당김(이름은 그대로)
export function dropAttachment(text, n) {
  return dropNumbered(text, "attachment", n, (k, raw) => wrap(tokenLabel(raw), ATT.repeat(k)));
}

export function dropContext(text, c) {
  let s = String(text || "");
  for (const t of findTokens(s, [c]).reverse()) s = cutToken(s, t).text;
  return s;
}

// 사용자가 글을 고친 뒤 사라진 칩: 이미지·첨부 번호(큰 것부터)·요소 id
// - 같은 칩이 여러 개면 모두 사라졌을 때만
export function removedTokens(before, after, contexts = []) {
  const count = (toks) => { const m = new Map(); for (const t of toks) { const k = t.type === "image" ? `i${t.n}` : t.type === "attachment" ? `a${t.n}` : `c${t.id}`; m.set(k, (m.get(k) || 0) + 1); } return m; };
  const was = count(findTokens(before, contexts));
  const now = count(findTokens(after, contexts));
  const images = [];
  const attachments = [];
  const ids = [];
  for (const k of was.keys()) {
    if (now.has(k)) continue;
    if (k[0] === "i") images.push(Number(k.slice(1)));
    else if (k[0] === "a") attachments.push(Number(k.slice(1)));
    else ids.push(k.slice(1));
  }
  return { images: images.sort((a, b) => b - a), attachments: attachments.sort((a, b) => b - a), ids };
}

// Backspace(dir -1)·Delete(dir 1) 로 지울 칩. 선택이 칩에 걸치면 그 칩들 전체
export function tokensToDelete(tokens, selStart, selEnd, dir) {
  if (selStart !== selEnd) return tokens.filter((t) => t.start < selEnd && t.end > selStart);
  const hit = tokens.find((t) => (dir < 0 ? t.start < selStart && selStart <= t.end : t.start <= selStart && selStart < t.end));
  return hit ? [hit] : [];
}

// 보낼 글: 이미지 칩 → 경로, 첨부 칩 → attachmentText, 요소 칩 → 내용(앞뒤 줄바꿈)
// - 칩이 없는 요소는 글 앞, 칩이 없는 이미지·첨부는 글 끝
// - attachments 는 이미지 아닌 첨부의 글(입력창 첨부 순서와 같음)
export function expandText(text, { imagePaths = [], attachments = [], contexts = [] } = {}) {
  const s = String(text || "");
  const usedImages = new Set();
  const usedAtt = new Set();
  const usedIds = new Set();
  let out = "";
  let at = 0;
  for (const t of findTokens(s, contexts)) {
    if (t.start < at) continue;
    out += s.slice(at, t.start);
    if (t.type === "image") {
      const p = imagePaths[t.n - 1];
      if (p) { usedImages.add(t.n - 1); out += p; } else out += s.slice(t.start, t.end);
    } else if (t.type === "attachment") {
      const a = attachments[t.n - 1];
      if (a) { usedAtt.add(t.n - 1); out += a; } else out += s.slice(t.start, t.end);
    } else {
      const c = contexts.find((x) => x.id === t.id);
      usedIds.add(t.id);
      // 여러 줄 내용이라 칩 앞뒤를 줄바꿈으로. 칩 옆 공백 하나는 뺌
      out = out.replace(/ $/, "");
      const end = s[t.end] === " " ? t.end + 1 : t.end;
      out += `${out && !out.endsWith("\n") ? "\n" : ""}${c.content}${end < s.length && s[end] !== "\n" ? "\n" : ""}`;
      at = end;
      continue;
    }
    at = t.end;
  }
  out += s.slice(at);
  const lead = contexts.filter((c) => !usedIds.has(c.id)).map((c) => c.content);
  const tail = [...imagePaths.filter((_, i) => !usedImages.has(i)), ...attachments.filter((a, i) => a && !usedAtt.has(i))];
  const body = [out, ...tail].filter(Boolean).join(" ");
  return [...lead, body].filter(Boolean).join("\n\n");
}
