import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stateHome } from "./state-home.cjs";

const MAX_TEXT = 200_000;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function error(code, message, extra) {
  return { ok: false, error: { code, message, ...(extra || {}) } };
}

function normalizeTexts(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("지원하지 않는 중앙 메모 상태 형식");
  const out = {};
  for (const [space, text] of Object.entries(raw)) {
    if (!space || typeof text !== "string") throw new Error("중앙 메모 상태에 문자열이 아닌 본문이 있습니다");
    out[space] = text;
  }
  return out;
}

function durablePersist(filePath, texts) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + ".tmp";
  let fd = null;
  try {
    fd = fs.openSync(tmp, "w", 0o600);
    fs.writeFileSync(fd, JSON.stringify(texts), "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = null;
    fs.renameSync(tmp, filePath);
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch {}
  }
  // rename까지 끝나면 새 파일은 정본이다. 디렉터리 fsync는 지원하는 파일시스템에서만 보강한다.
  let dirFd = null;
  try {
    dirFd = fs.openSync(path.dirname(filePath), fs.constants.O_RDONLY);
    fs.fsyncSync(dirFd);
  } catch {} finally {
    if (dirFd != null) try { fs.closeSync(dirFd); } catch {}
  }
}

function requestSignature({ space, baseVersion, text }) {
  return JSON.stringify([space, baseVersion, text]);
}

function mergeText(dest, source) {
  dest = String(dest || ""); source = String(source || "");
  if (dest === source || dest.includes(source)) return dest;
  if (source.includes(dest)) return source;
  if (!dest.trim()) return source;
  if (!source.trim()) return dest;
  return `${dest.replace(/\s+$/, "")}\n\n---\n${source}`;
}

export function memoVersion(text) {
  return "sha256:" + crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

export class MemoDockStore {
  constructor({ stateDir, filePath, persistState } = {}) {
    const root = stateDir || stateHome();
    this.filePath = filePath || path.join(root, "memos.json");
    this.persistState = typeof persistState === "function" ? persistState : durablePersist;
    this.requests = new Map();
    this.loadError = null;
    this.texts = {};
    if (fs.existsSync(this.filePath)) {
      try {
        this.texts = normalizeTexts(JSON.parse(fs.readFileSync(this.filePath, "utf8")));
      } catch (cause) {
        this.loadError = cause;
      }
    }
  }

  snapshot() {
    const texts = clone(this.texts);
    const versions = {};
    for (const [space, text] of Object.entries(texts)) versions[space] = memoVersion(text);
    return { texts, versions };
  }

  document(space) {
    space = String(space || "");
    const text = Object.prototype.hasOwnProperty.call(this.texts, space) ? this.texts[space] : "";
    return { text, version: memoVersion(text) };
  }

  hasSpace(space) {
    return Object.prototype.hasOwnProperty.call(this.texts, String(space || ""));
  }

  #blocked() {
    return this.loadError ? error("CORRUPT_STATE", "중앙 메모 상태 파일이 손상되어 원본을 보존했습니다.") : null;
  }

  #dedup(requestId, signature) {
    if (!requestId || !this.requests.has(requestId)) return null;
    const previous = this.requests.get(requestId);
    if (previous.signature !== signature) return error("REQUEST_REUSED", "같은 요청 ID가 다른 중앙 메모 쓰기에 재사용됐습니다.");
    return clone(previous.result);
  }

  #remember(requestId, signature, result) {
    if (!requestId) return;
    this.requests.set(requestId, { signature, result: clone(result) });
    while (this.requests.size > 500) this.requests.delete(this.requests.keys().next().value);
  }

  #commit(next, result, requestId, signature) {
    try {
      this.persistState(this.filePath, next);
    } catch (cause) {
      return error("PERSIST_FAILED", "중앙 메모를 디스크에 저장하지 못했습니다.", { cause: String(cause?.message || cause) });
    }
    this.texts = next;
    this.#remember(requestId, signature, result);
    return clone(result);
  }

  setDocument({ space, baseVersion, text, requestId } = {}) {
    const blocked = this.#blocked(); if (blocked) return blocked;
    space = String(space || "");
    if (!space) return error("INVALID_SPACE", "중앙 메모를 저장할 스페이스가 필요합니다.");
    if (typeof text !== "string") return error("TEXT_REQUIRED", "중앙 메모 본문은 문자열이어야 합니다.");
    if (text.length > MAX_TEXT) return error("TEXT_TOO_LARGE", `중앙 메모 본문은 ${MAX_TEXT}자 이하여야 합니다.`);
    if (typeof baseVersion !== "string" || !baseVersion) return error("INVALID_VERSION", "유효한 중앙 메모 baseVersion이 필요합니다.");
    requestId = String(requestId || "");
    const signature = requestSignature({ space, baseVersion, text });
    const prior = this.#dedup(requestId, signature); if (prior) return prior;
    const current = this.document(space);
    if (current.text === text) {
      const result = { ok: true, unchanged: true, doc: current };
      this.#remember(requestId, signature, result);
      return clone(result);
    }
    if (current.version !== baseVersion) {
      return { ...error("CONFLICT", "다른 창에서 중앙 메모가 먼저 바뀌었습니다."), current };
    }
    const next = clone(this.texts);
    next[space] = text;
    const doc = { text, version: memoVersion(text) };
    return this.#commit(next, { ok: true, doc }, requestId, signature);
  }

  remapSpaces(map) {
    const blocked = this.#blocked(); if (blocked) return blocked;
    const next = clone(this.texts);
    let changed = false;
    for (const [from, to] of Object.entries(map || {})) {
      if (!from || !to || from === to || !Object.prototype.hasOwnProperty.call(next, from)) continue;
      const source = next[from];
      next[to] = Object.prototype.hasOwnProperty.call(next, to) ? mergeText(next[to], source) : source;
      delete next[from];
      changed = true;
    }
    if (!changed) return { ok: true, changed: false };
    return this.#commit(next, { ok: true, changed: true });
  }
}

export { MAX_TEXT };
