import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import guard from "../server/qa-expiry-guard.cjs";
import { handleQaSessionCmd, recordFrame, runFor, noteRunAccepted, noteRunEvent } from "../server/qa-journal.js";
import { buildReport } from "../bin/mcp/report.mjs";
import { runBrowserCmdResilient } from "../server/browser-commands.js";

const helper = new URL("../server/qa-expiry-guard.cjs", import.meta.url).pathname;
const report = new URL("../bin/mcp/report.mjs", import.meta.url).href;
const id = (p) => { const s = fs.lstatSync(p, { bigint: true }); return { dev: String(s.dev), ino: String(s.ino) }; };
function fixture(t) {
  const state = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qa-coordinate-")));
  process.env.IRIS_STATE_DIR = state;
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const root = path.join(state, "artifacts", "qa");
  fs.mkdirSync(root, { recursive: true });
  const rid = "run-" + String(1700000000000 + crypto.randomInt(1000000));
  fs.mkdirSync(path.join(root, rid));
  fs.writeFileSync(path.join(root, rid, "journal.jsonl"), '{"t":1700000000000}\n');
  const args = () => ({ action: "expiry_isolate", runId: rid, requestId: crypto.randomUUID().replaceAll("-", ""), expected: id(path.join(root, rid)), rootIdentity: id(root) });
  return { state, root, rid, args };
}
function control(f) { return path.join(f.state, "qa-expiry-control", crypto.createHash("sha256").update(f.rid).digest("hex")); }
function child(f, code) {
  const p = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, IRIS_STATE_DIR: f.state }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let errors = ""; p.stderr.on("data", (b) => errors += b);
  p.errors = () => errors;
  return p;
}
async function message(p) {
  return await Promise.race([once(p, "message").then(([m]) => m), once(p, "exit").then(([rc]) => { throw new Error("fixture child exit " + rc + ": " + p.errors()); })]);
}

test("durable active writer across processes blocks isolation until release", async (t) => {
  const f = fixture(t), a = f.args();
  const p = child(f, `import guard from ${JSON.stringify(helper)}; const use = guard.acquireRun(${JSON.stringify(f.rid)}, "fixture-writer"); process.send("ready"); process.once("message", () => { use.release(); process.send("released"); process.disconnect(); });`);
  t.after(() => { if (p.exitCode == null) p.kill(); });
  assert.equal(await message(p), "ready");
  assert.throws(() => guard.expiry(a), /in use/);
  p.send("release"); assert.equal(await message(p), "released");
  const rec = guard.expiry(a);
  assert.equal(rec.phase, "isolated");
  assert.equal(fs.existsSync(path.join(f.root, f.rid)), false);
  assert.deepEqual(guard.expiry({ ...a, action: "expiry_receipt" }), rec);
  assert.throws(() => guard.acquireRun(f.rid, "new-writer"), /expired|unresolved/);
  assert.throws(() => guard.acquireRun(rec.quarantine, "new-writer"), /quarantine/);
  assert.throws(() => guard.acquireRun(rec.quarantine.toUpperCase(), "new-writer"), /quarantine/);
  assert.throws(() => guard.acquirePaths([path.join(f.root, rec.quarantine.toUpperCase(), "out.html")], "new-writer"), /quarantine|alias/);
});

test("process crash leaves durable use marker; PID absence never admits deletion", async (t) => {
  const f = fixture(t), a = f.args();
  const p = child(f, `import guard from ${JSON.stringify(helper)}; guard.acquireRun(${JSON.stringify(f.rid)}, "fixture-crash"); process.send("ready");`);
  t.after(() => { if (p.exitCode == null) p.kill(); });
  assert.equal(await message(p), "ready");
  const exited = once(p, "exit"); p.kill("SIGKILL"); await exited;
  assert.throws(() => guard.expiry(a), /in use/);
  assert.ok(fs.existsSync(path.join(f.root, f.rid, "journal.jsonl")));
});

test("admission crash or unknown marker holds every later operation", (t) => {
  const f = fixture(t);
  const u = guard.acquireRun(f.rid, "fixture"); u.release();
  fs.writeFileSync(path.join(control(f), "unknown.json"), "{}");
  assert.throws(() => guard.expiry(f.args()), /unresolved/);
  fs.mkdirSync(path.join(f.state, "qa-expiry-control", "admission"));
  assert.throws(() => guard.acquireRun("new-run", "fixture"), /EEXIST/);
});

test("journal active lifetime blocks rename even while idle, end permits isolation", (t) => {
  const f = fixture(t);
  assert.equal(handleQaSessionCmd("run", { action: "begin", runId: f.rid }, "fixture").ok, true);
  assert.throws(() => guard.expiry(f.args()), /in use/);
  assert.equal(handleQaSessionCmd("run", f.args(), null).code, "QA_IN_USE");
  assert.equal(handleQaSessionCmd("run", { action: "end", runId: f.rid, force: true }, "fixture").ok, true);
  const rec = guard.expiry(f.args());
  const resumed = handleQaSessionCmd("run", { action: "begin", runId: f.rid }, "fixture");
  assert.equal(resumed.ok, false);
  assert.match(resumed.error, /expired|unresolved/);
  assert.equal(handleQaSessionCmd("run", { action: "begin" }, "fixture").ok, true);
  assert.ok(fs.existsSync(path.join(f.root, rec.quarantine, "journal.jsonl")));
});

test("end during await does not release frame or command lifetime; completed event retained", async (t) => {
  const f = fixture(t);
  handleQaSessionCmd("run", { action: "begin", runId: f.rid }, "fixture");
  const st = runFor("fixture", f.rid);
  const use = guard.acquireRun(f.rid, "browser-command");
  const cid = noteRunAccepted("click", {}, "fixture", f.rid);
  let ready, finish;
  const started = new Promise((r) => ready = r);
  const pending = recordFrame(st, "tab", "before", async (args) => {
    ready(); await new Promise((r) => finish = r);
    fs.writeFileSync(args.path, "fixture-frame"); return { ok: true, data: { path: args.path } };
  });
  await started;
  handleQaSessionCmd("run", { action: "end", runId: f.rid, force: true }, "fixture");
  assert.throws(() => guard.expiry(f.args()), /in use/);
  finish(); await pending;
  assert.throws(() => guard.expiry(f.args()), /in use/);
  noteRunEvent(cid, "click", {}, "fixture", { ok: true }, 1, f.rid, st); use.release();
  assert.match(fs.readFileSync(path.join(f.root, f.rid, "journal.jsonl"), "utf8"), /"kind":"completed"/);
  assert.equal(guard.expiry(f.args()).phase, "isolated");
});

test("normal resume and new run work; path traversal and alias are refused", (t) => {
  const f = fixture(t);
  for (let i = 0; i < 2; i++) {
    assert.equal(handleQaSessionCmd("run", { action: "begin", runId: f.rid }, "fixture").ok, true);
    assert.equal(handleQaSessionCmd("run", { action: "end", runId: f.rid, force: true }, "fixture").ok, true);
  }
  assert.throws(() => guard.acquireRun("../outside", "fixture"), /invalid/);
  const link = path.join(f.state, "alias"); fs.symlinkSync(f.root, link);
  assert.throws(() => guard.acquirePaths([path.join(link, f.rid, "report.html")], "fixture"), /alias/);
  assert.throws(() => guard.expiry({ ...f.args(), runId: f.rid.toUpperCase() }), /canonical/);
});

test("changed root or run inode and invalid request fail before rename", (t) => {
  const f = fixture(t), a = f.args();
  assert.throws(() => guard.expiry({ ...a, requestId: "../bad" }), /canonical/);
  fs.renameSync(path.join(f.root, f.rid), path.join(f.root, "old")); fs.mkdirSync(path.join(f.root, f.rid));
  assert.throws(() => guard.expiry(a), /identity changed/);
  assert.ok(fs.existsSync(path.join(f.root, f.rid)));
});

test("rename failure retains intent; response loss after rename reconciles same receipt", (t) => {
  const f = fixture(t), a = f.args(), rename = fs.renameSync;
  try {
    fs.renameSync = (from, to) => { if (from === path.join(f.root, f.rid)) throw new Error("fixture rename failure"); return rename(from, to); };
    assert.throws(() => guard.expiry(a), /fixture rename failure/);
  } finally { fs.renameSync = rename; }
  assert.throws(() => guard.expiry({ ...a, action: "expiry_receipt" }), /unresolved/);
  assert.throws(() => guard.acquireRun(f.rid, "fixture"), /expired|unresolved/);
  const intent = JSON.parse(fs.readFileSync(path.join(control(f), "isolation.json")));
  fs.renameSync(path.join(f.root, f.rid), path.join(f.root, intent.quarantine));
  assert.equal(guard.expiry({ ...a, action: "expiry_receipt" }).phase, "isolated");
  fs.mkdirSync(path.join(f.root, f.rid)); fs.writeFileSync(path.join(f.root, f.rid, "new.txt"), "new work");
  assert.equal(guard.expiry({ ...a, action: "expiry_receipt" }).phase, "isolated");
  assert.equal(fs.readFileSync(path.join(f.root, f.rid, "new.txt"), "utf8"), "new work");
});

test("report guards primary and other QA output, thumbnail source and crash lifetime", async (t) => {
  const f = fixture(t), a = f.args();
  const signal = path.join(f.state, "signal"), go = path.join(f.state, "go");
  const shot = path.join(f.root, f.rid, "source.png"); fs.writeFileSync(shot, "fixture");
  const p = child(f, `import fs from "node:fs"; import { buildReport } from ${JSON.stringify(report)};
    const copy = fs.copyFileSync; fs.copyFileSync = (...args) => { fs.writeFileSync(${JSON.stringify(signal)}, "ready");
      while (!fs.existsSync(${JSON.stringify(go)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); return copy(...args); };
    buildReport({runId:"report-own", title:"fixture", steps:[{before:${JSON.stringify(shot)}}], out:${JSON.stringify(path.join(f.root, f.rid, "out.html"))}}); process.send("done"); process.disconnect();`);
  t.after(() => { if (p.exitCode == null) p.kill(); });
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(signal) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.ok(fs.existsSync(signal), p.errors());
  assert.throws(() => guard.expiry(a), /in use/);
  fs.writeFileSync(go, "go"); assert.equal(await message(p), "done");
  assert.ok(fs.existsSync(path.join(f.root, f.rid, "out.html")));
  assert.equal(guard.expiry(a).phase, "isolated");
});

test("report errors release known uses; symlink or quarantined output never writes", (t) => {
  const f = fixture(t);
  const link = path.join(f.root, f.rid, "alias"); fs.symlinkSync(f.root, link);
  assert.throws(() => buildReport({ runId: "report-own", out: path.join(link, "x.html") }), /symlink|alias/);
  const rec = guard.expiry(f.args());
  assert.throws(() => buildReport({ runId: "report-own", out: path.join(f.root, rec.quarantine, "out.html") }), /quarantine/);
  assert.throws(() => buildReport({ runId: rec.quarantine.toUpperCase(), steps: [] }), /quarantine/);
});

test("fsync and receipt failure preserve original or isolated content and hold admission", (t) => {
  const f = fixture(t), a = f.args(), sync = fs.fsyncSync;
  try { fs.fsyncSync = () => { throw new Error("fixture sync failure"); }; assert.throws(() => guard.expiry(a), /sync failure/); }
  finally { fs.fsyncSync = sync; }
  assert.ok(fs.existsSync(path.join(f.root, f.rid, "journal.jsonl")));
  const rec = guard.expiry(a);
  const other = { ...a, requestId: crypto.randomUUID().replaceAll("-", "") };
  assert.throws(() => guard.expiry(other), /receipt mismatch/);
  assert.ok(fs.existsSync(path.join(f.root, rec.quarantine, "journal.jsonl")));
});

test("actual browser command keeps its lease through end handler and final completion", async (t) => {
  const f = fixture(t);
  handleQaSessionCmd("run", { action: "begin", runId: f.rid }, "fixture");
  const append = fs.appendFileSync;
  let observed = false;
  try {
    fs.appendFileSync = (file, data, ...rest) => {
      if (String(data).includes('"kind":"run_end"')) { observed = true; assert.throws(() => guard.expiry(f.args()), /in use/); }
      return append(file, data, ...rest);
    };
    const result = await runBrowserCmdResilient("run", { action: "end", runId: f.rid, force: true }, "fixture", f.rid);
    assert.equal(result.ok, true);
  } finally { fs.appendFileSync = append; }
  assert.equal(observed, true);
  assert.equal(guard.expiry(f.args()).phase, "isolated");
});

test("simultaneous multiprocess begin vs isolation never both succeed", async (t) => {
  for (let i = 0; i < 12; i++) {
    const f = fixture(t), a = f.args();
    const code = (operation) => `import guard from ${JSON.stringify(helper)}; let use; process.send("ready");
      process.once("message", () => { try { ${operation}; process.send({ok:true}); }
        catch(e) { process.send({ok:false,error:e.message}); } process.once("message", () => { if(use) use.release(); process.disconnect(); }); });`;
    const writer = child(f, code(`use=guard.acquireRun(${JSON.stringify(f.rid)}, "fixture-race")`));
    const isolator = child(f, code(`guard.expiry(${JSON.stringify(a)})`));
    t.after(() => { for (const p of [writer, isolator]) if (p.exitCode == null) p.kill(); });
    await Promise.all([message(writer), message(isolator)]);
    const results = [message(writer), message(isolator)]; writer.send("go"); isolator.send("go");
    const [w, x] = await Promise.all(results);
    assert.equal(w.ok && x.ok, false);
    assert.equal(w.ok || x.ok, true, JSON.stringify([w, x]));
    const exited = [once(writer, "exit"), once(isolator, "exit")];
    writer.send("release"); isolator.send("release"); await Promise.all(exited);
    if (w.ok) assert.ok(fs.existsSync(path.join(f.root, f.rid, "journal.jsonl")));
    else assert.ok(fs.existsSync(path.join(f.root, `.expired-${f.rid}-${a.requestId}`, "journal.jsonl")));
  }
});

test("final receipt write failure after rename reconciles without touching recreated original", (t) => {
  const f = fixture(t), a = f.args(), write = fs.writeFileSync;
  let writes = 0;
  try {
    fs.writeFileSync = (file, data, ...rest) => {
      if (String(data).includes('"phase":')) { writes++; if (writes === 2) throw new Error("fixture final receipt failure"); }
      return write(file, data, ...rest);
    };
    assert.throws(() => guard.expiry(a), /final receipt failure/);
  } finally { fs.writeFileSync = write; }
  const rec = guard.expiry({ ...a, action: "expiry_receipt" });
  assert.equal(rec.phase, "isolated");
  fs.mkdirSync(path.join(f.root, f.rid)); fs.writeFileSync(path.join(f.root, f.rid, "new.txt"), "new work");
  assert.equal(guard.expiry({ ...a, action: "expiry_receipt" }).phase, "isolated");
  assert.equal(fs.readFileSync(path.join(f.root, f.rid, "new.txt"), "utf8"), "new work");
});

test("report copy failure fallback guards actual thumbnail writes in the source run", (t) => {
  const f = fixture(t), a = f.args();
  const source = path.join(f.root, f.rid, "source.png");
  const png = Buffer.alloc(24); png.write("PNG", 1, "latin1"); png.writeUInt32BE(2000, 16); png.writeUInt32BE(1000, 20); fs.writeFileSync(source, png);
  const copy = fs.copyFileSync;
  let guarded = false;
  try {
    fs.copyFileSync = () => { guarded = true; assert.throws(() => guard.expiry(a), /in use/); throw new Error("fixture copy failure"); };
    buildReport({ runId: "fallback-report", title: "fixture", steps: [{ before: source }] });
  } finally { fs.copyFileSync = copy; }
  assert.equal(guarded, true);
  // sips가 이 합성 PNG를 읽지 못해도 forEmbed 사용 표시는 전체 시도를 보호한다.
  assert.equal(guard.expiry(a).phase, "isolated");
});

test("successful journal response survives release contention and bounded retry frees marker", async (t) => {
  const f = fixture(t);
  handleQaSessionCmd("run", { action: "begin", runId: f.rid }, "fixture");
  const lock = path.join(f.state, "qa-expiry-control", "admission"), held = path.join(f.state, "held");
  const peer = child(f, `import fs from "node:fs"; process.send("ready"); process.once("message", () => {
    fs.mkdirSync(${JSON.stringify(lock)}); fs.writeFileSync(${JSON.stringify(held)}, "held");
    setTimeout(() => { fs.rmdirSync(${JSON.stringify(lock)}); process.disconnect(); }, 500); });`);
  t.after(() => { if (peer.exitCode == null) peer.kill(); });
  await message(peer);
  const exited = once(peer, "exit"), append = fs.appendFileSync;
  try {
    fs.appendFileSync = (file, data, ...rest) => {
      const result = append(file, data, ...rest);
      if (String(data).includes('"kind":"observation"')) {
        peer.send("hold"); const deadline = Date.now() + 5000;
        while (!fs.existsSync(held) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        assert.ok(fs.existsSync(held));
      }
      return result;
    };
    const result = await runBrowserCmdResilient("journal", { event: { kind: "observation", source: "server" } }, "fixture", f.rid);
    assert.equal(result.ok, true);
    assert.equal(fs.readdirSync(control(f)).filter((n) => n.startsWith("use-")).length, 2);
  } finally { fs.appendFileSync = append; }
  await exited;
  const deadline = Date.now() + 2000;
  while (fs.readdirSync(control(f)).filter((n) => n.startsWith("use-")).length > 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.equal(fs.readdirSync(control(f)).filter((n) => n.startsWith("use-")).length, 1);
  const journal = fs.readFileSync(path.join(f.root, f.rid, "journal.jsonl"), "utf8");
  assert.equal(journal.split("\n").filter((line) => line.includes('"kind":"observation"')).length, 1);
  handleQaSessionCmd("run", { action: "end", runId: f.rid, force: true }, "fixture");
  assert.equal(guard.expiry(f.args()).phase, "isolated");
});

test("unresolved release retains marker and emits failure without replacing success", async (t) => {
  const f = fixture(t), use = guard.acquireRun(f.rid, "fixture-release-failure");
  const lock = path.join(f.state, "qa-expiry-control", "admission"), errors = [], log = console.error;
  fs.mkdirSync(lock);
  try {
    console.error = (line) => errors.push(String(line));
    assert.equal(use.release().released, false);
    await new Promise((r) => setTimeout(r, 750));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /usage release held: QA_ADMISSION_BUSY/);
    assert.equal(fs.readdirSync(control(f)).filter((n) => n.startsWith("use-")).length, 1);
  } finally { console.error = log; fs.rmdirSync(lock); }
  assert.throws(() => guard.expiry(f.args()), /in use/);
  assert.equal(use.release().released, true);
  assert.equal(guard.expiry(f.args()).phase, "isolated");
});
