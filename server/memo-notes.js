import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stateHome } from "./state-home.cjs";

const MAX_TEXT = 200_000;
const MAX_NAME = 80;
const SHARED = "__shared__";

function emptyState() {
  return { version: 1, localBySpace: {}, shared: { text: "", rev: 0, updatedAt: 0 } };
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function finiteTime(value, fallback = 0) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function normalizeNote(raw, fallbackId) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || fallbackId || "").trim();
  if (!id) return null;
  return {
    id,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, MAX_NAME) : "메모",
    text: typeof raw.text === "string" ? raw.text : "",
    rev: Number.isInteger(raw.rev) && raw.rev >= 0 ? raw.rev : 0,
    createdAt: finiteTime(raw.createdAt),
    updatedAt: finiteTime(raw.updatedAt),
    deletedAt: raw.deletedAt == null ? null : finiteTime(raw.deletedAt),
  };
}

function normalizeBucket(raw) {
  const notes = {};
  for (const [key, value] of Object.entries(raw?.notes || {})) {
    const note = normalizeNote(value, key);
    if (note) notes[note.id] = note;
  }
  const order = [];
  for (const id of Array.isArray(raw?.order) ? raw.order : []) {
    const key = String(id || "");
    if (notes[key] && !order.includes(key)) order.push(key);
  }
  for (const id of Object.keys(notes)) if (!order.includes(id)) order.push(id);
  return { order, notes };
}

function normalizeState(raw) {
  if (!raw || typeof raw !== "object" || (raw.version != null && raw.version !== 1)) {
    throw new Error("지원하지 않는 메모 상태 형식");
  }
  const state = emptyState();
  for (const [space, bucket] of Object.entries(raw.localBySpace || {})) {
    if (!space) continue;
    state.localBySpace[space] = normalizeBucket(bucket);
  }
  const shared = raw.shared || {};
  state.shared = {
    text: typeof shared.text === "string" ? shared.text : "",
    rev: Number.isInteger(shared.rev) && shared.rev >= 0 ? shared.rev : 0,
    updatedAt: finiteTime(shared.updatedAt),
  };
  return state;
}

function defaultPersist(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function error(code, message, extra) {
  return { ok: false, error: { code, message, ...(extra || {}) } };
}

function cleanName(value) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
}

function recordsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class MemoNotesStore {
  constructor({ stateDir, filePath, now, idFactory, persistState } = {}) {
    const root = stateDir || stateHome();
    this.filePath = filePath || path.join(root, "memo-notes.json");
    this.now = typeof now === "function" ? now : () => Date.now();
    this.idFactory = typeof idFactory === "function" ? idFactory : () => crypto.randomUUID();
    this.persistState = typeof persistState === "function" ? persistState : defaultPersist;
    this.requests = new Map();
    this.loadError = null;
    this.state = emptyState();
    if (fs.existsSync(this.filePath)) {
      try {
        this.state = normalizeState(JSON.parse(fs.readFileSync(this.filePath, "utf8")));
      } catch (cause) {
        this.loadError = cause;
      }
    }
  }

  snapshot() { return clone(this.state); }

  #blocked() {
    return this.loadError ? error("CORRUPT_STATE", "메모 상태 파일이 손상되어 원본을 보존했습니다.") : null;
  }

  #dedup(requestId) {
    return requestId && this.requests.has(requestId) ? clone(this.requests.get(requestId)) : null;
  }

  #remember(requestId, result) {
    if (!requestId) return;
    this.requests.set(requestId, clone(result));
    while (this.requests.size > 500) this.requests.delete(this.requests.keys().next().value);
  }

  #commit(next, result, requestId) {
    try {
      this.persistState(this.filePath, next);
    } catch (cause) {
      return error("PERSIST_FAILED", "메모 상태를 저장하지 못했습니다.", { cause: String(cause?.message || cause) });
    }
    this.state = next;
    this.#remember(requestId, result);
    return clone(result);
  }

  #bucket(state, space, create = false) {
    if (!space) return null;
    if (!state.localBySpace[space] && create) state.localBySpace[space] = { order: [], notes: {} };
    return state.localBySpace[space] || null;
  }

  #newId(state) {
    for (let i = 0; i < 50; i++) {
      const id = String(this.idFactory() || "").trim();
      if (!id) continue;
      let used = false;
      for (const bucket of Object.values(state.localBySpace)) if (bucket.notes[id]) { used = true; break; }
      if (!used) return id;
    }
    return null;
  }

  #defaultName(bucket) {
    const names = new Set(Object.values(bucket.notes).map((note) => note.name));
    let n = 1;
    while (names.has(`메모 ${n}`)) n++;
    return `메모 ${n}`;
  }

  notesForSpace(space, { includeDeleted = false } = {}) {
    const bucket = this.#bucket(this.state, String(space || ""));
    if (!bucket) return [];
    return bucket.order.map((id) => bucket.notes[id]).filter((note) => note && (includeDeleted || note.deletedAt == null)).map(clone);
  }

  document({ scope, space, noteId, includeDeleted = false }) {
    if (scope === "shared") return clone(this.state.shared);
    if (scope !== "local") return null;
    const note = this.#bucket(this.state, String(space || ""))?.notes?.[String(noteId || "")];
    if (!note || (!includeDeleted && note.deletedAt != null)) return null;
    return clone(note);
  }

  hasSpace(space) {
    const bucket = this.#bucket(this.state, String(space || ""));
    return !!(bucket && bucket.order.length);
  }

  createLocal({ space, name, requestId } = {}) {
    const blocked = this.#blocked(); if (blocked) return blocked;
    const prior = this.#dedup(requestId); if (prior) return prior;
    space = String(space || "");
    if (!space || space === SHARED) return error("INVALID_SPACE", "로컬 메모를 만들 스페이스가 필요합니다.");
    const next = clone(this.state);
    const bucket = this.#bucket(next, space, true);
    let clean = cleanName(name);
    if (!clean) clean = this.#defaultName(bucket);
    if (clean.length > MAX_NAME) return error("NAME_TOO_LONG", `메모 이름은 ${MAX_NAME}자 이하여야 합니다.`);
    const id = this.#newId(next);
    if (!id) return error("ID_EXHAUSTED", "고유한 메모 ID를 만들지 못했습니다.");
    const at = this.now();
    const note = { id, name: clean, text: "", rev: 0, createdAt: at, updatedAt: at, deletedAt: null };
    bucket.notes[id] = note; bucket.order.push(id);
    return this.#commit(next, { ok: true, note: clone(note) }, requestId);
  }

  renameLocal({ space, noteId, name, requestId } = {}) {
    const blocked = this.#blocked(); if (blocked) return blocked;
    const prior = this.#dedup(requestId); if (prior) return prior;
    const clean = cleanName(name);
    if (!clean) return error("NAME_REQUIRED", "메모 이름이 필요합니다.");
    if (clean.length > MAX_NAME) return error("NAME_TOO_LONG", `메모 이름은 ${MAX_NAME}자 이하여야 합니다.`);
    const next = clone(this.state);
    const note = this.#bucket(next, String(space || ""))?.notes?.[String(noteId || "")];
    if (!note) return error("NOTE_NOT_FOUND", "메모를 찾지 못했습니다.");
    if (note.deletedAt != null) return error("NOTE_DELETED", "삭제된 메모입니다.");
    note.name = clean; note.updatedAt = this.now();
    return this.#commit(next, { ok: true, note: clone(note) }, requestId);
  }

  deleteLocal({ space, noteId, requestId } = {}) {
    const blocked = this.#blocked(); if (blocked) return blocked;
    const prior = this.#dedup(requestId); if (prior) return prior;
    const next = clone(this.state);
    const note = this.#bucket(next, String(space || ""))?.notes?.[String(noteId || "")];
    if (!note) return error("NOTE_NOT_FOUND", "메모를 찾지 못했습니다.");
    if (note.deletedAt != null) {
      const result = { ok: true, note: clone(note), unchanged: true };
      this.#remember(requestId, result); return result;
    }
    note.deletedAt = this.now(); note.updatedAt = note.deletedAt;
    return this.#commit(next, { ok: true, note: clone(note) }, requestId);
  }

  restoreLocal({ space, noteId, requestId } = {}) {
    const blocked = this.#blocked(); if (blocked) return blocked;
    const prior = this.#dedup(requestId); if (prior) return prior;
    const next = clone(this.state);
    const note = this.#bucket(next, String(space || ""))?.notes?.[String(noteId || "")];
    if (!note) return error("NOTE_NOT_FOUND", "메모를 찾지 못했습니다.");
    if (note.deletedAt == null) {
      const result = { ok: true, note: clone(note), unchanged: true };
      this.#remember(requestId, result); return result;
    }
    note.deletedAt = null; note.updatedAt = this.now();
    return this.#commit(next, { ok: true, note: clone(note) }, requestId);
  }

  setDocument({ scope, space, noteId, baseRev, text, requestId } = {}) {
    const blocked = this.#blocked(); if (blocked) return blocked;
    const prior = this.#dedup(requestId); if (prior) return prior;
    if (typeof text !== "string") return error("TEXT_REQUIRED", "메모 본문은 문자열이어야 합니다.");
    if (text.length > MAX_TEXT) return error("TEXT_TOO_LARGE", `메모 본문은 ${MAX_TEXT}자 이하여야 합니다.`);
    if (!Number.isInteger(baseRev) || baseRev < 0) return error("INVALID_REV", "유효한 메모 revision이 필요합니다.");
    const next = clone(this.state);
    let doc;
    if (scope === "shared") doc = next.shared;
    else if (scope === "local") {
      doc = this.#bucket(next, String(space || ""))?.notes?.[String(noteId || "")];
      if (!doc) return error("NOTE_NOT_FOUND", "메모를 찾지 못했습니다.");
      if (doc.deletedAt != null) return error("NOTE_DELETED", "삭제된 메모입니다.");
    } else return error("INVALID_SCOPE", "메모 범위가 올바르지 않습니다.");
    if (doc.rev !== baseRev) return { ...error("CONFLICT", "다른 창에서 메모가 먼저 바뀌었습니다."), current: clone(doc) };
    doc.text = text; doc.rev++; doc.updatedAt = this.now();
    const result = { ok: true, doc: clone(doc), rev: doc.rev };
    return this.#commit(next, result, requestId);
  }

  remapSpaces(map) {
    const blocked = this.#blocked(); if (blocked) return blocked;
    const next = clone(this.state);
    let changed = false;
    for (const [from, to] of Object.entries(map || {})) {
      if (!from || !to || from === to) continue;
      const source = next.localBySpace[from]; if (!source) continue;
      const dest = this.#bucket(next, to, true);
      for (const sourceId of source.order) {
        const sourceNote = source.notes[sourceId]; if (!sourceNote) continue;
        let id = sourceId;
        if (dest.notes[id]) {
          if (recordsEqual(dest.notes[id], sourceNote)) continue;
          id = this.#newId(next);
          if (!id) return error("ID_EXHAUSTED", "충돌한 메모를 보존할 ID를 만들지 못했습니다.");
        }
        dest.notes[id] = { ...clone(sourceNote), id };
        if (!dest.order.includes(id)) dest.order.push(id);
      }
      delete next.localBySpace[from]; changed = true;
    }
    if (!changed) return { ok: true, changed: false };
    return this.#commit(next, { ok: true, changed: true });
  }
}


