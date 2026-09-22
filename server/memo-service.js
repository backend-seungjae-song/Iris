import fs from "node:fs";
import path from "node:path";

import {
  keyOf as spKey,
  project as spProject,
  registerSpaceStateParticipant,
} from "./browser-state-owner.js";
import { MemoDockStore } from "./memo-dock-store.js";
import { appendMemoArchiveBlock } from "./memo-note-archive.js";
import { MemoNotesStore } from "./memo-notes.js";
import { snapshot } from "./runtime-state.js";
import * as spaceKey from "./space-key.js";
import { stateHome } from "./state-home.cjs";

// 중앙 memo dock·별도 memo notes·날짜별 archive와 그 write boundary의 단일 소유자.
//
// 소유 범위
//   MemoDockStore/MemoNotesStore 인스턴스, 통째 교체되는 memoArch, 지연 flush timer와 block id 순번,
//   memo.note.*·memo.doc.*·memo.* inbound mutation/ACK 순서.
//
// 제공 API
//   initMemoService, 세 memo wire snapshot, exact memo message handler와 archive flush port.
//   원시 store·object·timer는 노출하지 않고 space-key 이관은 등록 callback으로만 참여한다.
//
// 의존 대상
//   저장 경로는 state-home과 memo store들에, key/project는 browser-state-owner에 의존하며,
//   broadcast와 client 순회는 init에서 주입받아 handler·transport 모듈을 import하지 않는다.
//
// 유지 조건
//   live 초안은 인증된 다른 창에 저장보다 먼저 중계하고, 저장·충돌·ACK 순서와 requestId 멱등성을
//   보존한다. space-key remap은 dock/notes 원자 저장 뒤 browser state, archive 병합 순서를 따른다.
//
// 영향 범위
//   server/index.js의 lock 뒤 초기화·WS 초기 snapshot·memo dispatch·shutdown flush,
//   browser-state-owner의 migration callback과 memo-*-state/targets/ws integration 테스트.

const DATA_DIR = stateHome();
const MEMO_ARCH_PATH = path.join(DATA_DIR, "memo-archives.json");
const BLOCK_MARK = "<!-- ac:block ";

let broadcast;
let visitClients;
let memoDock;
let memoNotes;
let memoArch = {};
let memoArchTimer = null;
let blockSeq = 0;

export function initMemoService(deps) {
  broadcast = deps.broadcast;
  visitClients = deps.visitClients;

  memoDock = new MemoDockStore({ stateDir: DATA_DIR });
  memoNotes = new MemoNotesStore({ stateDir: DATA_DIR });
  try { memoArch = JSON.parse(fs.readFileSync(MEMO_ARCH_PATH, "utf8")) || {}; } catch { memoArch = {}; }

  registerSpaceStateParticipant("memo", {
    backupPaths: () => [memoDock.filePath, MEMO_ARCH_PATH, memoNotes.filePath],
    prepareRemap(map) {
      const memoMove = memoDock.remapSpaces(map);
      if (!memoMove.ok) throw new Error(memoMove.error?.message || "중앙 메모 상태 열쇠를 옮기지 못했습니다.");
      const noteMove = memoNotes.remapSpaces(map);
      if (!noteMove.ok) throw new Error(noteMove.error?.message || "메모 창 상태 열쇠를 옮기지 못했습니다.");
    },
    remap(_map, pairs) {
      for (const [from, to] of pairs) {
        if (!Object.prototype.hasOwnProperty.call(memoArch, from)) continue;
        const src = memoArch[from] || [], dst = memoArch[to] || [];
        const byDate = new Map(dst.map((entry) => [entry.date, ensureBlocks(entry)]));
        for (const entry of src.map(ensureBlocks)) {
          const current = byDate.get(entry.date);
          if (current) { current.blocks.push(...entry.blocks); current.rev = current.blocks.length; }
          else byDate.set(entry.date, entry);
        }
        memoArch[to] = [...byDate.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
        delete memoArch[from];
      }
      saveMemoArch();
    },
    hasSpace: (space) => memoDock.hasSpace(space)
      || Object.prototype.hasOwnProperty.call(memoArch, space)
      || Object.prototype.hasOwnProperty.call(memoNotes.snapshot().localBySpace || {}, space),
    contributeRecovery({ addLegacy }) {
      Object.keys(memoDock.snapshot().texts).forEach(addLegacy);
      Object.keys(memoArch).forEach(addLegacy);
      Object.keys(memoNotes.snapshot().localBySpace || {}).forEach(addLegacy);
    },
    broadcast: broadcastAll,
  });
}

function writeMemoArchState(value) {
  fs.mkdirSync(path.dirname(MEMO_ARCH_PATH), { recursive: true });
  fs.writeFileSync(MEMO_ARCH_PATH + ".tmp", JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(MEMO_ARCH_PATH + ".tmp", MEMO_ARCH_PATH);
}

function writeMemoArchNow() {
  memoArchTimer = null;
  try { writeMemoArchState(memoArch); } catch {}
}

function saveMemoArch() {
  clearTimeout(memoArchTimer);
  memoArchTimer = setTimeout(writeMemoArchNow, 400);
}

function flushMemoArchNow() {
  if (!memoArchTimer) return false;
  clearTimeout(memoArchTimer);
  writeMemoArchNow();
  return true;
}

function todayStamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function clockStamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function newBlockId() { return "b" + Date.now().toString(36) + (++blockSeq).toString(36); }

function blockHead(b) {
  return `${BLOCK_MARK}${b.id} ${new Date(b.at).toISOString()} -->${b.clock ? `\n## ${b.clock} 보관` : ""}${b.name ? `\n### ${b.name}` : ""}`;
}

function archiveText(entry) {
  return (entry.blocks || []).map((b) => `${blockHead(b)}\n${b.text}`).join("\n\n");
}

function ensureBlocks(entry) {
  if (Array.isArray(entry.blocks)) return entry;
  entry.blocks = [{ id: "legacy-" + entry.date, at: entry.at || Date.now(), clock: "", text: String(entry.text || "") }];
  return entry;
}

function entryOut(entry) {
  ensureBlocks(entry);
  return {
    date: entry.date,
    at: entry.at,
    rev: entry.rev || entry.blocks.length,
    blocks: entry.blocks.map((block) => ({
      id: block.id,
      at: block.at,
      clock: block.clock || "",
      text: block.text,
      ...(block.name ? { name: block.name } : {}),
    })),
    text: archiveText(entry),
  };
}

export function archivesOut() {
  const out = {};
  for (const sp of Object.keys(memoArch)) out[sp] = (memoArch[sp] || []).map(entryOut);
  return spProject(out);
}

export function memoNotesWire() {
  const state = memoNotes.snapshot();
  return {
    type: "memo-notes",
    localBySpace: spProject(state.localBySpace),
    localByKey: state.localBySpace,
    shared: state.shared,
    ...(memoNotes.loadError ? { error: "메모 창 상태 파일이 손상되어 쓰기를 막았습니다." } : {}),
  };
}

function broadcastMemoNotes() {
  broadcast(memoNotesWire());
}

export function memosWire() {
  if (memoDock.loadError) {
    return { type: "memos", unavailable: true, error: "중앙 메모 상태 파일이 손상되어 원본을 보존했습니다." };
  }
  const state = memoDock.snapshot();
  const memos = spProject(state.texts), versions = spProject(state.versions);
  for (const workspace of snapshot().workspaces || []) {
    if (!Object.prototype.hasOwnProperty.call(memos, workspace.id)) memos[workspace.id] = "";
    if (!Object.prototype.hasOwnProperty.call(versions, workspace.id)) {
      versions[workspace.id] = memoDock.document(spKey(workspace.id)).version;
    }
  }
  return { type: "memos", memos, versions };
}

function broadcastMemos() {
  broadcast(memosWire());
}

function broadcastArchives() {
  broadcast({ type: "memo-archives", archives: archivesOut() });
}

function broadcastAll() {
  broadcastMemos();
  broadcastMemoNotes();
  broadcastArchives();
}

function wsReply(ws, msg) {
  try { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); } catch {}
}

function broadcastMemoLive(source, msg) {
  const data = JSON.stringify(msg);
  visitClients((client) => {
    if (client !== source && client.readyState === 1 && client._local && client._ui) client.send(data);
  });
}

function memoNoteFailure(ws, requestId, result) {
  wsReply(ws, {
    type: "memo.error",
    requestId: requestId || null,
    code: result?.error?.code || "MEMO_ERROR",
    message: result?.error?.message || "메모 작업에 실패했습니다.",
    ...(result?.current ? { current: result.current } : {}),
  });
}

function handleMemoNoteMessage(ws, msg) {
  const known = new Set(["memo.note.create", "memo.note.rename", "memo.note.delete", "memo.note.restore",
    "memo.doc.live", "memo.doc.set", "memo.note.archive"]);
  if (!known.has(msg.type)) return false;
  if (!(ws._local && ws._ui)) {
    memoNoteFailure(ws, msg.requestId, { error: { code: "UI_AUTH_REQUIRED", message: "Iris 앱 창에서만 메모 창을 바꿀 수 있습니다." } });
    return true;
  }
  const requestId = String(msg.requestId || "");
  if (!requestId) {
    memoNoteFailure(ws, null, { error: { code: "REQUEST_ID_REQUIRED", message: "메모 요청 ID가 필요합니다." } });
    return true;
  }
  const runtimeSpace = String(msg.space || "");
  const storageSpace = runtimeSpace ? spKey(runtimeSpace) : "";
  let result;
  if (msg.type === "memo.doc.live") {
    const scope = msg.scope === "shared" ? "shared" : "local";
    const noteId = String(msg.noteId || "");
    const doc = memoNotes.document(scope === "shared" ? { scope } : { scope, space: storageSpace, noteId });
    if (!doc) { memoNoteFailure(ws, requestId, { error: { code: "NOTE_NOT_FOUND", message: "공유할 메모를 찾지 못했습니다." } }); return true; }
    if (typeof msg.text !== "string" || msg.text.length > 200_000) {
      memoNoteFailure(ws, requestId, { error: { code: "TEXT_TOO_LARGE", message: "메모 본문은 200,000자 이하여야 합니다." } }); return true;
    }
    const seq = Number(msg.seq);
    if (!Number.isInteger(seq) || seq < 1) {
      memoNoteFailure(ws, requestId, { error: { code: "INVALID_SEQUENCE", message: "실시간 메모 순번이 올바르지 않습니다." } }); return true;
    }
    broadcastMemoLive(ws, { type: "memo.doc.live", requestId, scope, space: runtimeSpace, storageSpace,
      noteId, source: String(msg.source || "").slice(0, 160), seq, baseRev: msg.baseRev, rev: doc.rev, text: msg.text });
    return true;
  }
  if (msg.type === "memo.note.create") {
    result = memoNotes.createLocal({ space: storageSpace, name: msg.name, requestId });
    if (!result.ok) { memoNoteFailure(ws, requestId, result); return true; }
    wsReply(ws, { type: "memo.note.created", requestId, space: runtimeSpace, storageSpace, note: result.note });
    broadcastMemoNotes(); return true;
  }
  if (msg.type === "memo.note.rename") {
    result = memoNotes.renameLocal({ space: storageSpace, noteId: String(msg.noteId || ""), name: msg.name, requestId });
    if (!result.ok) { memoNoteFailure(ws, requestId, result); return true; }
    wsReply(ws, { type: "memo.note.renamed", requestId, space: runtimeSpace, storageSpace, note: result.note });
    broadcastMemoNotes(); return true;
  }
  if (msg.type === "memo.note.delete") {
    result = memoNotes.deleteLocal({ space: storageSpace, noteId: String(msg.noteId || ""), requestId });
    if (!result.ok) { memoNoteFailure(ws, requestId, result); return true; }
    wsReply(ws, { type: "memo.note.deleted", requestId, space: runtimeSpace, storageSpace, note: result.note });
    broadcastMemoNotes(); return true;
  }
  if (msg.type === "memo.note.restore") {
    result = memoNotes.restoreLocal({ space: storageSpace, noteId: String(msg.noteId || ""), requestId });
    if (!result.ok) { memoNoteFailure(ws, requestId, result); return true; }
    wsReply(ws, { type: "memo.note.restored", requestId, space: runtimeSpace, storageSpace, note: result.note });
    broadcastMemoNotes(); return true;
  }
  if (msg.type === "memo.doc.set") {
    const scope = msg.scope === "shared" ? "shared" : "local";
    result = memoNotes.setDocument({ scope, space: storageSpace, noteId: String(msg.noteId || ""),
      baseRev: msg.baseRev, text: msg.text, requestId });
    if (!result.ok) {
      if (result.error?.code === "CONFLICT") {
        wsReply(ws, { type: "memo.doc.conflict", requestId, scope, space: runtimeSpace, storageSpace,
          noteId: String(msg.noteId || ""), current: result.current });
      } else memoNoteFailure(ws, requestId, result);
      return true;
    }
    wsReply(ws, { type: "memo.doc.saved", requestId, scope, space: runtimeSpace, storageSpace,
      noteId: String(msg.noteId || ""), rev: result.rev });
    broadcastMemoNotes(); return true;
  }
  if (msg.type === "memo.note.archive") {
    const scope = msg.scope === "shared" ? "shared" : "local";
    const doc = memoNotes.document(scope === "shared" ? { scope } : {
      scope, space: storageSpace, noteId: String(msg.noteId || ""),
    });
    if (!doc) { memoNoteFailure(ws, requestId, { error: { code: "NOTE_NOT_FOUND", message: "보관할 메모를 찾지 못했습니다." } }); return true; }
    if (!String(doc.text || "").trim()) {
      wsReply(ws, { type: "memo.note.archived", requestId, scope, empty: true }); return true;
    }
    const next = JSON.parse(JSON.stringify(memoArch));
    const date = todayStamp(), target = scope === "shared" ? spaceKey.SHARED : storageSpace;
    const appended = appendMemoArchiveBlock(next, { space: target, date, at: Date.now(), clock: clockStamp(),
      text: doc.text, name: scope === "local" ? doc.name : "", requestId, id: newBlockId() });
    if (appended.changed) {
      try { writeMemoArchState(next); } catch {
        memoNoteFailure(ws, requestId, { error: { code: "PERSIST_FAILED", message: "메모 보관본을 저장하지 못했습니다." } });
        return true;
      }
      memoArch = next;
      broadcastArchives();
    }
    wsReply(ws, { type: "memo.note.archived", requestId, scope, space: runtimeSpace, storageSpace: target,
      date, updated: !!appended.entry && appended.entry.blocks.length > 1, duplicate: !!appended.duplicate });
    return true;
  }
  return false;
}

export function handleMemoMessage(ws, msg) {
  if (handleMemoNoteMessage(ws, msg)) return true;

  if (msg.type === "memo.set") {
    const from = String(msg.space || ""); if (!from) return true;
    const sp = spKey(from);
    const result = memoDock.setDocument({
      space: sp, baseVersion: msg.baseVersion, text: msg.text, requestId: msg.requestId,
    });
    if (!result.ok) {
      const type = result.error?.code === "CONFLICT" ? "memo-conflict" : "memo-error";
      wsReply(ws, { type, requestId: msg.requestId || null, space: from,
        code: result.error?.code || "MEMO_SAVE_FAILED", message: result.error?.message || "중앙 메모를 저장하지 못했습니다.",
        ...(result.current ? { current: result.current } : {}) });
      return true;
    }
    const update = { type: "memo", space: from, text: result.doc.text, version: result.doc.version };
    if (!result.unchanged) {
      visitClients((client) => {
        if (client !== ws && client.readyState === 1) { try { client.send(JSON.stringify(update)); } catch {} }
      });
    }
    wsReply(ws, { type: "memo-saved", requestId: msg.requestId || null, space: from,
      text: result.doc.text, version: result.doc.version, unchanged: !!result.unchanged });
    return true;
  }

  if (msg.type === "memo.archive") {
    const sp = String(msg.space || ""); if (!sp) return true;
    const text = String(msg.text != null ? msg.text : memoDock.document(spKey(sp)).text);
    if (!text.trim()) { wsReply(ws, { type: "memo-archived", space: sp, empty: true }); return true; }
    const date = todayStamp();
    const k = spKey(sp);
    const list = memoArch[k] || (memoArch[k] = []);
    const cur = list.find((x) => x.date === date);
    const block = { id: newBlockId(), at: Date.now(), clock: clockStamp(), text };
    if (cur) { ensureBlocks(cur); cur.blocks.push(block); cur.at = block.at; cur.rev = cur.blocks.length; }
    else list.push({ date, blocks: [block], at: block.at, rev: 1 });
    list.sort((a, b) => (a.date < b.date ? 1 : -1));
    saveMemoArch();
    broadcastArchives();
    wsReply(ws, { type: "memo-archived", space: sp, date, updated: !!cur });
    return true;
  }

  if (msg.type === "memo.archive.delete") {
    const sp = spKey(String(msg.space || "")), d = String(msg.date || "");
    if (!sp || !d || !memoArch[sp]) return true;
    memoArch[sp] = memoArch[sp].filter((x) => x.date !== d);
    if (!memoArch[sp].length) delete memoArch[sp];
    saveMemoArch();
    broadcastArchives();
    return true;
  }

  if (msg.type === "memo.archive.block.delete") {
    const sp = spKey(String(msg.space || "")), d = String(msg.date || ""), id = String(msg.id || "");
    if (!sp || !d || !id || !memoArch[sp]) return true;
    const cur = memoArch[sp].find((x) => x.date === d); if (!cur) return true;
    ensureBlocks(cur);
    const before = cur.blocks.length;
    cur.blocks = cur.blocks.filter((b) => b.id !== id);
    if (cur.blocks.length === before) return true;
    if (!cur.blocks.length) memoArch[sp] = memoArch[sp].filter((x) => x.date !== d);
    else { cur.rev = cur.blocks.length; cur.at = cur.blocks[cur.blocks.length - 1].at; }
    if (!memoArch[sp].length) delete memoArch[sp];
    saveMemoArch();
    broadcastArchives();
    return true;
  }

  return false;
}

export { flushMemoArchNow as flushNow };
