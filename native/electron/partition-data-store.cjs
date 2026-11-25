// 네이티브 기능의 프로필별 저장소와 삭제 재시도
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { isProfilePartition } = require("./profile-session-policy.cjs");

function atomicWrite(fs, file, bytes) {
  const tmp = `${file}.tmp-${randomUUID()}`;
  try {
    fs.writeFileSync(tmp, bytes, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw error;
  }
}

function withoutPartition(data, partition, persist) {
  if (!data) return false;
  if (!Object.hasOwn(data, partition)) return true;
  const next = { ...data };
  delete next[partition];
  return persist(next);
}

function memoryStore() {
  let data = {};
  function persist(next) { data = next; return true; }
  return { load: () => data, persist, purge: (partition) => withoutPartition(data, partition, persist) };
}

function openStore({ file, stateDir, fs, safeStorage, onError }) {
  let cached;

  function read(source) {
    let encrypted;
    try {
      encrypted = fs.readFileSync(source);
    } catch (error) {
      if (error.code === "ENOENT") return {};
      onError("read");
      return null;
    }
    try {
      if (!safeStorage.isEncryptionAvailable()) return null;
      const data = JSON.parse(safeStorage.decryptString(encrypted));
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("입력 기록 파일 형식 오류");
      return data;
    } catch {
      onError("decrypt");
      return null;
    }
  }

  function load() {
    if (!cached) cached = read(file);
    return cached;
  }

  function write(target, data) {
    try {
      if (!safeStorage.isEncryptionAvailable()) return false;
      const encrypted = safeStorage.encryptString(JSON.stringify(data));
      fs.mkdirSync(stateDir, { recursive: true });
      atomicWrite(fs, target, encrypted);
      return true;
    } catch {
      onError("write");
      return false;
    }
  }

  function persist(data) {
    if (!write(file, data)) return false;
    cached = data;
    return true;
  }

  function purge(partition) {
    let done = withoutPartition(load(), partition, persist);
    const name = path.basename(file);
    for (const entry of fs.readdirSync(stateDir, { withFileTypes: true })) {
      if (!entry.isFile() || !(entry.name.startsWith(`${name}.unreadable-`)
        || entry.name === `${name}.tmp` || entry.name.startsWith(`${name}.tmp-`))) continue;
      const copy = path.join(stateDir, entry.name);
      if (!withoutPartition(read(copy), partition, (data) => write(copy, data))) done = false;
    }
    return done;
  }

  return { load, persist, purge };
}

function createPartitionStores({ stateDir, fs, safeStorage, files, error, platform = process.platform }) {
  const memoryOnly = platform === "win32";
  const journal = path.join(stateDir, "partition-purges.json");
  const pending = new Set();
  // 이미 사라진 게스트의 IPC가 늦게 도착해 프로필 기록을 되살리는 경우 방지
  const blocked = new Set();
  const running = new Map();
  let journalLoaded = memoryOnly;
  const stores = new Map(files.map((name) => [name, memoryOnly ? memoryStore() : openStore({
    file: path.join(stateDir, name), stateDir, fs, safeStorage,
    onError: (operation) => error?.("[profile-store] 저장소 작업 실패", name, operation),
  })]));

  function readJournal() {
    if (journalLoaded) return;
    try {
      const ids = JSON.parse(fs.readFileSync(journal, "utf8"));
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string"
        && id.startsWith("persist:acprof:") && isProfilePartition(id))) throw new Error();
      for (const id of ids) { pending.add(id); blocked.add(id); }
    } catch (cause) {
      if (cause.code !== "ENOENT") throw new Error("프로필 삭제 목록을 읽지 못했습니다");
    }
    journalLoaded = true;
  }

  function writeJournal(ids) {
    if (memoryOnly) return;
    try {
      if (ids.length) {
        fs.mkdirSync(stateDir, { recursive: true });
        atomicWrite(fs, journal, JSON.stringify(ids));
      } else fs.rmSync(journal, { force: true });
    } catch {
      throw new Error("프로필 삭제 목록을 저장하지 못했습니다");
    }
  }

  function beginPurge(partition) {
    readJournal();
    if (pending.has(partition)) return;
    writeJournal([...pending, partition]);
    pending.add(partition);
    blocked.add(partition);
  }

  function finishPurge(partition) {
    let done = true;
    for (const store of stores.values()) {
      if (!store.purge(partition)) done = false;
    }
    if (!done) throw new Error("프로필 입력 기록을 모두 지우지 못했습니다");
    writeJournal([...pending].filter((id) => id !== partition));
    pending.delete(partition);
  }

  function retryPurges() {
    try { readJournal(); } catch {
      error?.("[profile-store] 프로필 삭제 목록을 읽지 못했습니다");
      return false;
    }
    for (const partition of pending) {
      if (running.has(partition)) continue;
      try { finishPurge(partition); } catch {
        error?.("[profile-store] 프로필 입력 기록 삭제를 완료하지 못했습니다");
      }
    }
    return true;
  }

  function open(name) {
    const store = stores.get(name);
    if (!store) throw new Error("등록되지 않은 프로필 저장소");
    return {
      load: (partition) => retryPurges() && !blocked.has(partition) ? store.load() : null,
      persist: store.persist,
    };
  }

  function purge(partition, clearSession) {
    if (running.has(partition)) return running.get(partition);
    beginPurge(partition);
    const operation = Promise.resolve().then(() => clearSession?.(partition)).finally(() => {
      running.delete(partition);
      finishPurge(partition);
    });
    running.set(partition, operation);
    return operation;
  }

  return { open, beginPurge, purge, retryPurges };
}

module.exports = { createPartitionStores };
