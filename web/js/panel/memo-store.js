// 중앙 스페이스 메모의 서버 snapshot·창 초안·저장 진행 상태를 맡는다.
//
// 소유 범위
//   스페이스별 본문·서버 version, 현재 표시 스페이스, 전송 timer·pending, 편집 revision·dirty,
//   localStorage 초안과 rail이 읽는 별도 메모 목록 snapshot·새 메모 생성 pending.
//
// 제공 API
//   initMemoStore와 화면 callback 등록, 본문·현재 스페이스·초안·별도 메모 질의,
//   편집·초안 이관·서버 snapshot/ACK/conflict 반영·연결 종료·새 메모 pending 명령.
//
// 의존 대상
//   center/tab-store의 현재 스페이스를 import한다. main이 소유하는 spk·spaces·selectedSpace,
//   localStorage 이관 helper, wsSend·연결 판정·request id·toast·IrisMemoSnapshotState는 init에서 받는다.
//
// 유지 조건
//   localStorage 초안은 debounce보다 먼저 기록한다. 서버 snapshot은 초안을 recoverDraft로 판정한
//   뒤에만 본문에 반영하고, ACK는 그 ACK 본문과 같은 초안만 지운다. 원시 저장 객체는 내주지 않는다.
//
// 영향 범위
//   main.js의 space-key 이관·WebSocket memo/memos/memo-saved/memo-conflict/memo.error 분기,
//   panel/memo.js의 공유 Monaco model·dirty 표시, panel/memo-admin.js의 현재 메모·별도 메모 목록,
//   web/memo-snapshot-state.js와 서버 memo.set/memo-saved/memo-conflict 계약.
//   현재 목록 확인: node bin/importers.mjs web/js/panel/memo-store.js

import { getCenterSpace } from "../center/tab-store.js";

let spk, getSpaces, getSelectedSpaceId, storedObjRemap;
let wsSend, wsIsOpen, memoReqId, showToast, snapshotState;
let setMemoValue = () => {};
let applyMemoServerText = () => {};
let renderMemo = () => {};
let memoHasFocus = () => false;
let renderMemoDirty = () => {};

let memoStore = {};       // spaceId → text
let memoVersionStore = {}; // spaceId → 서버 본문 hash version
let memoShownSpace = null; // 지금 화면에 표시 중인 스페이스
let memoSendTimer = null;
let memoSendSpace = null;
let memoRev = 0;          // 편집 회차 번호. 이전 저장 응답이 그 뒤 입력을 저장됨으로 만들지 않게 한다
let memoDirty = false;    // 서버가 전체 스냅샷을 보내도 저장 확인 전 초안을 덮지 않게 하는 상태
const MEMO_DRAFTS_KEY = "ac.memoDrafts.v1";
let memoDrafts = {};
const memoPending = new Map(); // requestId → { space, key, text, baseVersion }
let memoNotesLocalBySpace = {}, memoNotesLocalByKey = {};
const memoCreatePending = new Map();

export function initMemoStore(deps) {
  ({ spk, getSpaces, getSelectedSpaceId, storedObjRemap, wsSend, wsIsOpen, memoReqId,
    showToast, snapshotState } = deps);
  try {
    const raw = JSON.parse(localStorage.getItem(MEMO_DRAFTS_KEY) || "{}");
    if (raw && typeof raw === "object" && !Array.isArray(raw)) memoDrafts = raw;
  } catch {}
}

export function registerMemoStoreView(view) {
  ({ setMemoValue, applyMemoServerText, renderMemo, memoHasFocus, renderMemoDirty } = view);
}

function memoDraftKey(space) { return spk(space) || String(space || ""); }
function validMemoDraft(value) {
  return value && typeof value.text === "string" && typeof value.baseVersion === "string" ? value : null;
}
function memoDraftFor(space) { return validMemoDraft(memoDrafts[memoDraftKey(space)]); }
function persistMemoDrafts() {
  try { localStorage.setItem(MEMO_DRAFTS_KEY, JSON.stringify(memoDrafts)); return true; }
  catch { return false; }
}
function setMemoDraft(space, draft) {
  const key = memoDraftKey(space); if (!key) return false;
  if (draft) memoDrafts[key] = { text: String(draft.text ?? ""), baseVersion: String(draft.baseVersion || ""), updatedAt: draft.updatedAt || Date.now() };
  else delete memoDrafts[key];
  return persistMemoDrafts();
}
function mergeMemoDrafts(dest, source) {
  dest = validMemoDraft(dest); source = validMemoDraft(source);
  if (!dest) return source; if (!source) return dest;
  if (dest.text === source.text) return dest.updatedAt >= source.updatedAt ? dest : source;
  const newer = dest.updatedAt >= source.updatedAt ? dest : source;
  return { text: snapshotState.mergeConcurrentText(dest.text, source.text),
    baseVersion: newer.baseVersion, updatedAt: Math.max(dest.updatedAt || 0, source.updatedAt || 0) };
}
function memoProjectedGet(map, space, fallback = "") {
  if (space && Object.prototype.hasOwnProperty.call(map, space)) return map[space];
  const key = memoDraftKey(space);
  for (const [candidate, value] of Object.entries(map || {})) if (memoDraftKey(candidate) === key) return value;
  return fallback;
}
function memoProjectedSet(map, space, value) {
  const key = memoDraftKey(space), ids = new Set([space, memoShownSpace, ...Object.keys(map || {}), ...getSpaces().map((item) => item.id)].filter(Boolean));
  for (const id of ids) if (memoDraftKey(id) === key) map[id] = value;
}
function sendMemoDraft(space, draft) {
  draft = validMemoDraft(draft); if (!space || !draft || !draft.baseVersion || !wsIsOpen()) return false;
  const requestId = memoReqId("memo-dock-save");
  memoPending.set(requestId, { space, key: memoDraftKey(space), text: draft.text, baseVersion: draft.baseVersion });
  wsSend({ type: "memo.set", requestId, space, baseVersion: draft.baseVersion, text: draft.text });
  return true;
}
function scheduleMemoDraft(space, immediate = false) {
  const previous = memoSendSpace;
  if (memoSendTimer) {
    clearTimeout(memoSendTimer); memoSendTimer = null;
    if (previous && memoDraftKey(previous) !== memoDraftKey(space)) sendMemoDraft(previous, memoDraftFor(previous));
  }
  memoSendSpace = space;
  const run = () => { memoSendTimer = null; const target = memoSendSpace; memoSendSpace = null; sendMemoDraft(target, memoDraftFor(target)); };
  if (immediate) run(); else memoSendTimer = setTimeout(run, 350);
}

export function memoSpace() { return getCenterSpace() || getSelectedSpaceId() || null; }
export function memoTextOf(space) { return memoStore[space] || ""; }
export function getMemoShownSpace() { return memoShownSpace; }
export function setMemoShownSpace(value) { memoShownSpace = value; }
export function hasMemoDraft(space) { return !!memoDraftFor(space); }
export function memoNoteBucketOf(space, stableSpace) {
  return memoNotesLocalByKey[stableSpace] || memoNotesLocalBySpace[space] || { order: [], notes: {} };
}
export function setMemoNotes(message) {
  memoNotesLocalBySpace = message.localBySpace || {};
  memoNotesLocalByKey = message.localByKey || {};
}
export function rememberMemoCreate(requestId, value) { memoCreatePending.set(requestId, value); }
export function takeMemoCreate(requestId) {
  const pending = memoCreatePending.get(requestId); memoCreatePending.delete(requestId); return pending;
}
export function remapMemoDrafts(map) {
  storedObjRemap(MEMO_DRAFTS_KEY, map, mergeMemoDrafts);
  try { memoDrafts = JSON.parse(localStorage.getItem(MEMO_DRAFTS_KEY) || "{}"); } catch {}
}
export function disconnectMemoStore() {
  memoPending.clear(); // ACK가 사라져도 localStorage 초안이 다음 memos 스냅샷에서 다시 전송된다.
}
export function advanceMemoRevision() { memoRev = snapshotState.advanceEditRevision(memoRev); }
export function markDirty(d) {
  memoDirty = !!d;
  renderMemoDirty(d);
}
export function updateMemoText(space, text, { immediate = false, baseVersion } = {}) {
  if (!space) return;
  const previous = memoDraftFor(space);
  const draft = { text: String(text ?? ""),
    baseVersion: String(baseVersion || previous?.baseVersion || memoProjectedGet(memoVersionStore, space, "")), updatedAt: Date.now() };
  memoProjectedSet(memoStore, space, draft.text);
  if (!setMemoDraft(space, draft)) showToast("메모 초안을 이 창에 보존하지 못했습니다. 연결을 확인하세요.");
  if (memoDraftKey(space) === memoDraftKey(memoShownSpace)) markDirty(true);
  scheduleMemoDraft(space, immediate);
}
export function applyMemoServerDocument(space, serverDoc, { resend = true } = {}) {
  if (!space || !serverDoc || typeof serverDoc.version !== "string") return { action: "unavailable" };
  const doc = { text: String(serverDoc.text ?? ""), version: serverDoc.version };
  memoProjectedSet(memoVersionStore, space, doc.version);
  const recovered = snapshotState.recoverDraft(doc, memoDraftFor(space));
  if (recovered.draft) {
    if (!setMemoDraft(space, recovered.draft)) showToast("메모 초안을 이 창에 보존하지 못했습니다.");
    memoProjectedSet(memoStore, space, recovered.text);
    if (resend) sendMemoDraft(space, recovered.draft);
  } else {
    setMemoDraft(space, null);
    memoProjectedSet(memoStore, space, recovered.text);
  }
  if (memoDraftKey(space) === memoDraftKey(memoShownSpace)) {
    markDirty(!!memoDraftFor(space));
    applyMemoServerText(recovered.text);
  }
  return recovered;
}
export function applyMemoSnapshot(message) {
  if (message.unavailable) {
    memoStore = snapshotState.mergeSnapshot({}, { current: memoStore, unavailable: true });
    // 서버 파일이 손상됐어도 이 창에 남은 초안까지 숨기지 않는다. 서버 쓰기는 계속 막힌다.
    for (const space of getSpaces().map((item) => item.id)) {
      const draft = memoDraftFor(space); if (draft) memoProjectedSet(memoStore, space, draft.text);
    }
    if (memoShownSpace && memoDraftFor(memoShownSpace)) setMemoValue(memoDraftFor(memoShownSpace).text);
    markDirty(!!memoDraftFor(memoShownSpace));
    if (message.error) showToast(message.error);
    return;
  }
  const serverTexts = (message.memos && typeof message.memos === "object") ? message.memos : {};
  const serverVersions = (message.versions && typeof message.versions === "object") ? message.versions : {};
  memoStore = snapshotState.mergeSnapshot(serverTexts);
  memoVersionStore = { ...serverVersions };
  const retry = [], seen = new Set();
  const candidates = new Set([...Object.keys(serverTexts), ...Object.keys(serverVersions), ...getSpaces().map((item) => item.id)]);
  for (const space of candidates) {
    const key = memoDraftKey(space); if (!key || seen.has(key)) continue; seen.add(key);
    const version = memoProjectedGet(serverVersions, space, ""); if (!version) continue;
    const recovered = applyMemoServerDocument(space, {
      text: memoProjectedGet(serverTexts, space, ""), version,
    }, { resend: false });
    if (recovered.draft) retry.push({ space, draft: recovered.draft, merged: recovered.action === "merge" });
  }
  if (memoShownSpace && memoDraftFor(memoShownSpace)) memoProjectedSet(memoStore, memoShownSpace, memoDraftFor(memoShownSpace).text);
  markDirty(!!memoDraftFor(memoShownSpace));
  for (const item of retry) sendMemoDraft(item.space, item.draft);
  if (retry.some((item) => item.merged)) showToast("다른 창의 메모와 이 창의 초안을 모두 보존했습니다.");
}
export function applyMemoConflict(message) {
  const pending = memoPending.get(message.requestId); memoPending.delete(message.requestId);
  const space = pending?.space || message.space;
  const draft = memoDraftFor(space) || (pending ? { text: pending.text, baseVersion: pending.baseVersion, updatedAt: Date.now() } : null);
  if (draft && message.current?.version) {
    const recovered = snapshotState.recoverDraft(message.current, draft);
    memoProjectedSet(memoVersionStore, space, message.current.version);
    memoProjectedSet(memoStore, space, recovered.text);
    if (recovered.draft) { setMemoDraft(space, recovered.draft); sendMemoDraft(space, recovered.draft); }
    else setMemoDraft(space, null);
    markDirty(!!memoDraftFor(memoShownSpace)); renderMemo();
    return true;
  }
  return false;
}
export function applyMemoError(message) {
  const central = memoPending.get(message.requestId); memoPending.delete(message.requestId);
  if (central) {
    markDirty(!!memoDraftFor(memoShownSpace));
    return "central";
  }
  memoCreatePending.delete(message.requestId);
  return "create";
}
export function applyMemoSaved(message) {
  const pending = memoPending.get(message.requestId); memoPending.delete(message.requestId);
  const space = pending?.space || message.space;
  if (message.version) memoProjectedSet(memoVersionStore, space, message.version);
  const draft = memoDraftFor(space);
  if (snapshotState.isSavedDraft(draft, message.text)) {
    setMemoDraft(space, null);
    memoProjectedSet(memoStore, space, String(message.text ?? ""));
  } else if (draft && pending && draft.baseVersion === pending.baseVersion && message.version) {
    // ACK 뒤에 더 쓴 초안은 지우지 않는다. 먼저 저장된 본문을 새 base로 삼아 다음 요청만 갱신한다.
    setMemoDraft(space, { ...draft, baseVersion: message.version });
  }
  if (memoDraftKey(space) === memoDraftKey(memoShownSpace)) markDirty(!!memoDraftFor(space));
}
export function applyMemoDocumentMessage(message) {
  const recovered = applyMemoServerDocument(message.space, { text: message.text, version: message.version });
  if (recovered.action === "merge") showToast("다른 창의 메모와 이 창의 초안을 모두 보존했습니다.");
  // 초안이 없을 때만 다른 창의 최신본으로 화면을 갈아 끼운다. 초안은 위에서 합쳐 즉시 저장한다.
  if (spk(message.space) === spk(memoShownSpace) && !memoDraftFor(memoShownSpace) && !memoHasFocus()) { memoShownSpace = null; renderMemo(); }
}
