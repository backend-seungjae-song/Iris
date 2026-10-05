// 사용 표시는 회차 종료와 별개로 남는다. 중단된 프로세스의 표시는 자동 회수하지 않는다.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { stateHome } = require("./state-home.cjs");
const { artifactDir } = require("./artifacts-home.cjs");
const VERSION = 1;
const RUN = /^run-[0-9]{13}$/;
const REQUEST = /^[a-f0-9]{32}$/;
const identity = (p) => {
  const s = fs.lstatSync(p, { bigint: true });
  if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("QA directory required");
  return { dev: String(s.dev), ino: String(s.ino) };
};
const same = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino;
function safeDir(p, create = false) {
  const absolute = path.resolve(p);
  let current = path.parse(absolute).root;
  // 루트 뒤 조각만 순회(Windows 드라이브 문자 중복 결합 방지)
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (create) { try { fs.mkdirSync(current, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") throw e; } }
    identity(current);
  }
  return p;
}
// Windows 는 디렉터리 open·fsync 미지원
function syncDir(p) { if (process.platform === "win32") return; const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function read(p) {
  const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.nlink !== 1 || s.size > 65536) throw new Error("unknown QA control file");
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally { fs.closeSync(fd); }
}
function atomic(p, value) {
  const tmp = p + ".tmp-" + crypto.randomUUID();
  const fd = fs.openSync(tmp, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, p); syncDir(path.dirname(p));
}
function context() {
  const root = artifactDir("qa");
  const control = path.join(stateHome(), "qa-expiry-control");
  safeDir(control, true);
  return { root, control };
}
function admission(fn) {
  const c = context(), lock = path.join(c.control, "admission");
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (e) { if (e.code === "EEXIST") e.code = "QA_ADMISSION_BUSY"; throw e; }
  // 오류 또는 crash로 남은 admission도 알 수 없는 상태다. PID나 경과 시간으로 풀지 않는다.
  try { syncDir(c.control); return fn(c); }
  finally { fs.rmdirSync(lock); syncDir(c.control); }
}
function runName(rid) {
  if (typeof rid !== "string" || !rid || rid === "." || rid === ".." || /[/\\\x00]/.test(rid)) throw new Error("invalid QA run name");
  return rid;
}
function runControl(c, rid) {
  const p = path.join(c.control, crypto.createHash("sha256").update(runName(rid).toLocaleLowerCase("en-US")).digest("hex"));
  safeDir(p, true);
  const label = path.join(p, "run.json");
  if (!fs.existsSync(label)) atomic(label, { version: VERSION, root: c.root, runId: rid });
  const rec = read(label);
  if (rec.version !== VERSION || rec.root !== c.root || rec.runId !== rid) throw new Error("QA run alias or control mismatch");
  return p;
}
function checkAllowed(p) {
  const names = fs.readdirSync(p);
  if (names.some((n) => n !== "run.json" && !/^use-[a-f0-9]{32}\.json$/.test(n))) throw new Error("expired or unresolved QA run");
  for (const n of names.filter((n) => n.startsWith("use-"))) {
    const marker = read(path.join(p, n));
    if (marker.version !== VERSION || !REQUEST.test(marker.token || "") || n !== `use-${marker.token}.json` ||
        marker.runId !== read(path.join(p, "run.json")).runId || !Number.isSafeInteger(marker.pid) || marker.pid < 1 ||
        typeof marker.owner !== "string" || !marker.owner) throw new Error("unknown QA writer marker");
  }
}
function acquireRun(rid, owner) {
  return admission((c) => {
    if (String(rid).toLowerCase().startsWith(".expired-")) throw new Error("QA quarantine is read-only");
    const p = runControl(c, rid); checkAllowed(p);
    safeDir(c.root, true);
    const dest = path.join(c.root, rid);
    if (fs.existsSync(dest)) safeDir(dest);
    const token = crypto.randomUUID().replaceAll("-", "");
    const file = path.join(p, "use-" + token + ".json");
    atomic(file, { version: VERSION, token, runId: rid, owner, pid: process.pid });
    let released = false, pending = null;
    const delays = [20, 100, 500];
    function releaseAttempt(index = 0) {
      try {
        if (artifactDir("qa") !== c.root || path.join(stateHome(), "qa-expiry-control") !== c.control) throw new Error("QA state changed during use");
        safeDir(c.control);
        admission((current) => {
          if (current.root !== c.root || current.control !== c.control) throw new Error("QA state changed during use");
          if (read(file).token !== token) throw new Error("QA usage marker changed");
          fs.unlinkSync(file); syncDir(p); released = true;
        });
        return { released: true };
      } catch (e) {
        // 해제 실패가 이미 끝난 조작의 응답을 실패로 바꾸면 호출자가 조작을 반복한다.
        // 소유 token만 제한적으로 재시도하고, 실패한 표시는 남겨 격리를 막는다.
        if (e.code === "QA_ADMISSION_BUSY" && index < delays.length) {
          pending = setTimeout(() => { pending = null; releaseAttempt(index + 1); }, delays[index]);
          pending.unref();
        } else console.error("[qa-expiry] usage release held: " + String(e.code || e.message));
        return { released: false, reason: String(e.code || e.message) };
      }
    }
    return { runId: rid, root: c.root, release() {
      if (released) return { released: true };
      if (pending) return { released: false, reason: "QA_ADMISSION_BUSY" };
      return releaseAttempt();
    } };
  });
}
function runOfPath(value) {
  if (typeof value !== "string" || !value) return null;
  const root = artifactDir("qa"), resolved = path.resolve(value);
  let ancestor = resolved;
  while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
  const physical = fs.realpathSync(ancestor);
  const physicalRoot = fs.existsSync(root) ? fs.realpathSync(root) : root;
  if (physical !== ancestor && (physical === physicalRoot || physical.startsWith(physicalRoot + path.sep))) throw new Error("QA path alias refused");
  const rel = path.relative(root, resolved);
  if (!rel || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return null;
  const rid = rel.split(path.sep)[0];
  // 하위 링크를 통해 다른 회차를 쓰는 경로는 별도 사용 표시로 보호할 수 없다.
  let current = root;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error("QA symlink output refused"); }
    catch (e) { if (e.code !== "ENOENT") throw e; }
  }
  return runName(rid);
}
function acquirePaths(values, owner) {
  const leases = [];
  try {
    for (const rid of new Set(values.map(runOfPath).filter(Boolean))) leases.push(acquireRun(rid, owner));
  } catch (e) { for (const lease of leases.reverse()) lease.release(); throw e; }
  return { release() { for (const lease of leases.splice(0).reverse()) lease.release(); } };
}
function validateReceipt(c, rec, args) {
  if (rec.version !== VERSION || rec.requestId !== args.requestId || rec.runId !== args.runId || rec.root !== c.root ||
      !same(rec.original, args.expected) || !same(rec.rootIdentity, args.rootIdentity) ||
      rec.quarantine !== `.expired-${args.runId}-${args.requestId}`) throw new Error("QA receipt mismatch");
  return rec;
}
function expiry(args) {
  return admission((c) => {
    if (args.action === "expiry_capability") return { version: VERSION, root: c.root, rootIdentity: identity(safeDir(c.root)), participants: ["journal", "browser-command", "mcp-report"], deploymentRequired: true };
    if (!RUN.test(args.runId || "") || !REQUEST.test(args.requestId || "")) throw new Error("canonical QA identity required");
    if (Number(args.runId.slice(4)) < 1e12 || Number(args.runId.slice(4)) > Date.now() - 30 * 24 * 3600 * 1000) throw new Error("QA run execution is recent or invalid");
    const p = runControl(c, args.runId), file = path.join(p, "isolation.json");
    if (!same(identity(safeDir(c.root)), args.rootIdentity)) throw new Error("QA root identity changed");
    let rec;
    if (fs.existsSync(file)) {
      rec = validateReceipt(c, read(file), args);
      if (rec.phase === "intent") {
        const q = path.join(c.root, rec.quarantine);
        // 같은 요청의 rename 완료만 재조정한다. 원래 경로를 다시 rename하지 않는다.
        if (fs.existsSync(q) && same(identity(q), rec.original) && !fs.existsSync(path.join(c.root, args.runId))) {
          syncDir(c.root); rec = { ...rec, phase: "isolated", isolated: identity(q) }; atomic(file, rec);
        } else throw new Error("unresolved QA isolation intent");
      }
      return rec;
    }
    if (args.action !== "expiry_isolate") throw new Error("QA receipt missing");
    checkAllowed(p);
    if (fs.readdirSync(p).some((n) => n.startsWith("use-"))) {
      const e = new Error("QA run is in use"); e.code = "QA_IN_USE"; throw e;
    }
    const original = identity(safeDir(path.join(c.root, args.runId)));
    if (!same(original, args.expected)) throw new Error("QA run identity changed");
    rec = { version: VERSION, requestId: args.requestId, runId: args.runId, root: c.root,
      rootIdentity: args.rootIdentity, original, quarantine: `.expired-${args.runId}-${args.requestId}`, phase: "intent" };
    if (fs.existsSync(path.join(c.root, rec.quarantine))) throw new Error("QA quarantine exists");
    atomic(file, rec);
    fs.renameSync(path.join(c.root, args.runId), path.join(c.root, rec.quarantine)); syncDir(c.root);
    rec = { ...rec, phase: "isolated", isolated: identity(path.join(c.root, rec.quarantine)) }; atomic(file, rec);
    return rec;
  });
}
module.exports = { VERSION, acquireRun, acquirePaths, runOfPath, expiry };
