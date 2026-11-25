// 터미널 에이전트에 아직 전달되지 않은 보낸 글(Paseo 가 "보내는 중"으로 둔 말풍선)
// - 터미널은 일하는 중에 받은 글을 대기열에 두고 흐리게 맨 아래에 보임. 되돌리면(↑·중단) 입력줄로 돌아감

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// 터미널 입력줄로 되돌아온 보낸 글의 id. 입력줄은 화면 줄바꿈이 섞여 공백을 하나로 맞춰 비교
// - sends: [{ id, text }]. 여러 글을 한 번에 되돌리면 입력줄에 이어 붙어 있음
export function poppedSends(draftText, sends) {
  const draft = norm(draftText);
  if (!draft) return [];
  return (sends || []).filter((s) => norm(s.text) && draft.includes(norm(s.text))).map((s) => s.id);
}

const isPendingRow = (item, ids) => item?.kind === "user_message" && ids.has(item.clientMessageId) && !item.messageId;

// 전달 전 말풍선을 대화 목록 맨 끝으로. 이미 끝이면 null
// - Paseo 목록은 확정 행(tail) 뒤에 쓰는 중인 행(head). head 가 있으면 head 끝이 화면 맨 끝
export function pinPendingLast(tail, head, pendingIds) {
  const ids = new Set(pendingIds);
  if (!ids.size) return null;
  const pending = [...tail, ...head].filter((it) => isPendingRow(it, ids));
  if (!pending.length) return null;
  const lane = head.length ? head : tail;
  const atEnd = lane.slice(lane.length - pending.length).every((it, k) => it === pending[k]);
  const elsewhere = (head.length ? tail : []).some((it) => isPendingRow(it, ids));
  if (atEnd && !elsewhere) return null;
  const nextTail = tail.filter((it) => !isPendingRow(it, ids));
  const nextHead = head.filter((it) => !isPendingRow(it, ids));
  return nextHead.length ? { tail: nextTail, head: [...nextHead, ...pending] } : { tail: [...nextTail, ...pending], head: nextHead };
}

// 전달 전 말풍선 흐리게(터미널의 흐린 대기 글과 같은 뜻)
export const PENDING_SEND_CSS = '[data-testid="user-message"][aria-busy="true"] { opacity: 0.55; }';

// 중단·되감기로 터미널이 입력줄에 되돌린 글과 그 뒤 버려진 줄을 뺌(터미널 화면과 같게)
// - Claude 기록: 되돌린 글도 남고, 다음에 보낸 글이 그 글과 같은 부모(parent)를 가리킴
// - 같은 부모의 뒤 글이 오면 앞 글부터 뒤 글 직전까지가 버려진 가지. 부모 없는 글(처음·압축 요약)은 비교 안 함
export function dropRewound(messages) {
  const list = messages || [];
  const lastByParent = new Map();
  list.forEach((m, n) => { if (m?.role === "user" && typeof m.parent === "string") lastByParent.set(m.parent, n); });
  let cut = null;
  list.forEach((m, n) => {
    if (m?.role !== "user" || typeof m.parent !== "string") return;
    const last = lastByParent.get(m.parent);
    if (last > n) (cut ||= []).push([n, last]);
  });
  if (!cut) return list;
  return list.filter((_, n) => !cut.some(([a, b]) => n >= a && n < b));
}

// 중단 직후: 마지막 사용자 글이 답 없이 터미널 입력줄로 돌아옴. 기록에는 그 순간 아무것도 안 남아 입력줄 글로 판정
// - 일하는 중이 아니고, 그 글 뒤에 줄이 없고, 입력줄 글에 그 글이 들어 있을 때 그 글 id
export function rewoundLastId(messages, draftText, running) {
  if (running) return null;
  const draft = norm(draftText);
  const list = messages || [];
  const last = list[list.length - 1];
  if (!draft || last?.role !== "user") return null;
  const text = norm((last.blocks || []).filter((b) => b?.type === "text").map((b) => b.text).join(" "));
  return text && draft.includes(text) ? last.id : null;
}

// 짝을 못 찾은 "보내는 중" 말풍선: 에이전트가 쉬고 있고 터미널 입력줄에도 그 글이 없으면 터미널에 기다리는 글이 아님
// - 기록 글이 보낸 글과 달라(대기 글 합침·첨부 경로 바뀜) 짝이 안 지어지면 그대로 두면 영원히 "보내는 중"
// - sends: [{ id, text, at }]. 보낸 지 minAge 가 지난 것만
export function staleSends(sends, { running, draftText, now, minAge }) {
  if (running) return [];
  const draft = norm(draftText);
  return (sends || []).filter((s) => now - (s.at ?? now) >= minAge && !(draft && norm(s.text) && draft.includes(norm(s.text)))).map((s) => s.id);
}

// 보낸 글과 기록 사용자 행 짝짓기 → Map(행 key → 보낸 글 id)
// - 기록 글은 보낸 글과 글자가 다를 수 있음: 이미지 경로가 [Image #n] 으로, 붙여넣기 감싸기·줄바꿈, 긴 글은 잘림(…)
//   글자 완전 일치만 보면 짝을 못 지어 기록 행과 흐린 "보내는 중" 말풍선이 함께 남음
// - 1차: 같은 글. 2차: 남은 보낸 글을 보낸 순서대로, 보낸 뒤 처음 생긴 사용자 행과
// - rows: [{ key, user, text, ts }] 기록 순서. sends: [{ id, agent, text, seen, lastKey, at }] 보낸 순서. known: 이미 짝지은 행
const IMAGE_REF = /\[Image #\d+\]|(?:~|\/)[^\s]*\.(?:png|jpe?g|gif|webp|heic|bmp|tiff?)\b/gi;
const sendForm = (s) => norm(String(s ?? "").replace(IMAGE_REF, "\u0001"));
function sameSend(sent, row) {
  const a = sendForm(sent);
  const b = sendForm(row);
  if (!a || !b) return false;
  if (a === b) return true;
  // 기록 쪽 글자 수 제한으로 잘린 행
  return b.endsWith("…") && b.length > 1 && a.startsWith(b.slice(0, -1).trimEnd());
}
// 다른 대화에서 보내 기준 행이 없는 글은 보낸 시각보다 이 이상 앞선 행과 순서로 짝짓지 않음(시계·기록 시각 차이)
const ORDER_SLACK_MS = 2000;
export function pairSends(rows, sends, agentId, known) {
  const pairs = new Map();
  const list = rows || [];
  const index = new Map(list.map((r, n) => [r.key, n]));
  const open = (sends || []).filter((s) => s.agent === agentId);
  const after = (s, r, n) => !s.seen.has(r.key) && (s.lastKey === null || n > (index.get(s.lastKey) ?? -1));
  const free = (r) => r.user && !known.has(r.key) && !pairs.has(r.key);
  list.forEach((r, n) => {
    if (!free(r)) return;
    const k = open.findIndex((s) => after(s, r, n) && sameSend(s.text, r.text));
    if (k < 0) return;
    pairs.set(r.key, open[k].id);
    open.splice(k, 1);
  });
  for (const s of open) {
    const n = list.findIndex((r, i) => free(r) && after(s, r, i) && (s.lastKey !== null || (r.ts ?? 0) >= s.at - ORDER_SLACK_MS));
    if (n >= 0) pairs.set(list[n].key, s.id);
  }
  return pairs;
}
