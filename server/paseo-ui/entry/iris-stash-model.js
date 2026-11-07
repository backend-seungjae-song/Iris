// 입력창 임시 저장 목록의 값 계산. 화면·저장은 iris-stash.tsx
// - 한 항목: 입력창 글(글 속 칩 글자 포함)·Paseo 첨부·Iris 칩. 글·첨부는 Paseo 초안 저장소에 따로 키를 두어 저장(첨부가 지워지지 않게)
import { contextTag, findTokens, tokenLabel } from "./iris-inline-tokens.js";

export const STASH_MAX = 30;
const PREVIEW_MAX = 120;

// 임시 저장 항목의 Paseo 초안 키. 대화 입력창 초안 키와 겹치지 않음
export const stashDraftKey = (id) => `iris-stash:${id}`;

// 비었는가: 글·첨부·칩 어느 것도 없음
export function isEmptyDraft(text, attachments, contexts) {
  return !String(text || "").trim() && !(attachments || []).length && !(contexts || []).length;
}

// 목록에 보일 한 줄: 글 속 칩은 [이름] 으로, 줄바꿈은 공백으로
export function stashPreview(text, contexts = []) {
  const raw = String(text || "");
  let out = "";
  let at = 0;
  for (const t of findTokens(raw, contexts)) {
    out += raw.slice(at, t.start) + `[${tokenLabel(raw.slice(t.start, t.end))}]`;
    at = t.end;
  }
  out = (out + raw.slice(at)).replace(/\s+/g, " ").trim();
  return out.length > PREVIEW_MAX ? `${out.slice(0, PREVIEW_MAX - 1)}…` : out;
}

// 불러올 때 칩 번호를 지금 입력창 칩 뒤 번호로 다시 매기고 글 속 칩 글자도 그 번호로 바꿈
// - 칩 번호는 대화 안에서 고정이라 저장할 때 번호가 지금 칩과 겹칠 수 있음
// - existing: 지금 입력창 칩. 반환 contexts 는 { content, kind?, no }
export function renumberForRestore(text, contexts = [], existing = []) {
  let next = Math.max(0, ...existing.map((c) => (Number.isInteger(c?.no) ? c.no : 0))) + 1;
  const byId = new Map();
  const out = contexts.map((c) => {
    const item = { content: c.content, ...(c.kind ? { kind: c.kind } : {}), no: next++ };
    byId.set(c.id, item);
    return item;
  });
  const raw = String(text || "");
  let body = "";
  let at = 0;
  for (const t of findTokens(raw, contexts)) {
    if (t.type !== "context" || !byId.has(t.id)) continue;
    body += raw.slice(at, t.start) + contextTag(byId.get(t.id));
    at = t.end;
  }
  return { text: body + raw.slice(at), contexts: out };
}

// 목록에 새 항목을 앞에. 한도를 넘으면 가장 오래된 것부터 뺀 id 를 같이 돌려줌(그 초안도 지워야 함)
export function pushStash(list, item) {
  const next = [item, ...(Array.isArray(list) ? list : [])];
  return { list: next.slice(0, STASH_MAX), dropped: next.slice(STASH_MAX).map((x) => x.id) };
}

// 저장해 둔 목록을 읽음. 모양이 다른 항목은 버림
export function parseStashList(raw) {
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v.filter((x) => x && typeof x.id === "string" && typeof x.at === "number" && Array.isArray(x.contexts)) : [];
  } catch {
    return [];
  }
}
