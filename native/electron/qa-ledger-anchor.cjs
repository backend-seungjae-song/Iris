const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { stateHome } = require("../../server/state-home.cjs");

const HASH = /^[a-f0-9]{64}$/;
const RUN_ID = /^[A-Za-z0-9_-]{1,100}$/;
const validHash = (value) => typeof value === "string" && HASH.test(value);
const validRun = (value) => typeof value === "string" && RUN_ID.test(value);

function createQaLedgerAnchor({ dir, fs: files = fs } = {}) {
  const root = dir || path.join(stateHome(), "native-private");
  const file = path.join(root, "qa-ledger-heads.json");
  let heads = new Map();
  let loadError = false;
  try {
    const saved = JSON.parse(files.readFileSync(file, "utf8"));
    if (!saved || saved.version !== 1 || Object.keys(saved).some((key) => !["version", "heads"].includes(key))
      || !saved.heads || typeof saved.heads !== "object" || Array.isArray(saved.heads)) throw new Error("invalid");
    for (const [runId, head] of Object.entries(saved.heads)) {
      if (!validRun(runId) || !head || Object.keys(head).some((key) => !["hash", "seq"].includes(key))
        || !validHash(head.hash) || !Number.isSafeInteger(head.seq) || head.seq < 0) throw new Error("invalid");
      heads.set(runId, { hash: head.hash, seq: head.seq });
    }
  } catch (error) {
    if (error.code !== "ENOENT") loadError = true;
  }

  const persist = (next) => {
    files.mkdirSync(root, { recursive: true, mode: 0o700 });
    const temporary = path.join(root, `.qa-ledger-heads-${randomUUID()}.tmp`);
    let fd;
    try {
      fd = files.openSync(temporary, "wx", 0o600);
      files.writeFileSync(fd, JSON.stringify({ version: 1, heads: Object.fromEntries(next) }) + "\n");
      files.fsyncSync(fd);
      files.closeSync(fd);
      fd = undefined;
      files.renameSync(temporary, file);
    } finally {
      if (fd !== undefined) { try { files.closeSync(fd); } catch {} }
      try { files.unlinkSync(temporary); } catch {}
    }
  };
  const update = (runId, hash, seq) => {
    const next = new Map(heads);
    next.set(runId, { hash, seq });
    try { persist(next); }
    catch { return { ok: false, error: "QA 머리 해시를 파일에 저장하지 못했습니다." }; }
    heads = next;
    return { ok: true, data: { hash, seq } };
  };

  // 다른 계정의 접근 제한용 파일 권한, 같은 계정의 앵커·장부 동시 되감기는 탐지 범위 밖
  return async function qaLedgerAnchor({ op, runId, hash, previousHash, seq } = {}) {
    if (!validRun(runId)) return { ok: false, error: "QA 회차 ID가 잘못됐습니다." };
    if (loadError) return { ok: false, error: "저장된 QA 머리 해시를 읽지 못했습니다." };
    const current = heads.get(runId);
    if (op === "begin") {
      if (current) return { ok: false, error: "이미 열린 QA 회차입니다." };
      if (!validHash(hash) || seq !== 0) return { ok: false, error: "초기 머리 해시가 잘못됐습니다." };
      return update(runId, hash, seq);
    }
    if (!current) return { ok: false, error: "QA 머리 해시가 메인 프로세스에 없습니다." };
    if (op === "read") return { ok: true, data: { ...current } };
    if (op === "advance") {
      if (current.hash !== previousHash || !Number.isSafeInteger(seq) || seq !== current.seq + 1 || !validHash(hash))
        return { ok: false, error: "QA 머리 해시 또는 순번이 맞지 않습니다." };
      return update(runId, hash, seq);
    }
    return { ok: false, error: "지원하지 않는 QA 앵커 명령입니다." };
  };
}

module.exports = { createQaLedgerAnchor };
