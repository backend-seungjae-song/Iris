import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createQaLedger } from "../server/qa-ledger.js";

const require = createRequire(import.meta.url);
const { createQaLedgerAnchor } = require("../native/electron/qa-ledger-anchor.cjs");
const root = path.join(fs.realpathSync(os.tmpdir()), "qa-ledger-anchor-tests");
const hashA = "a".repeat(64), hashB = "b".repeat(64);
const setup = (t) => {
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, "anchor-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const begin = (anchor, runId = "run-1") => anchor({ op: "begin", runId, hash: hashA, seq: 0 });
const advance = (anchor, runId = "run-1") => anchor({ op: "advance", runId, previousHash: hashA, hash: hashB, seq: 1 });

test("기본 호출은 stateHome의 native 파일에 저장하고 재시작 후 복구한다", async (t) => {
  const dir = setup(t);
  const previous = process.env.IRIS_STATE_DIR;
  process.env.IRIS_STATE_DIR = dir;
  try {
    const anchor = createQaLedgerAnchor();
    assert.equal((await begin(anchor)).ok, true);
    assert.equal((await advance(anchor)).ok, true);
    const file = path.join(dir, "native-private", "qa-ledger-heads.json");
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).heads["run-1"].seq, 1);
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const restarted = createQaLedgerAnchor();
    assert.deepEqual(await restarted({ op: "read", runId: "run-1" }), { ok: true, data: { hash: hashB, seq: 1 } });
    assert.equal((await begin(restarted)).ok, false);
    assert.equal((await advance(restarted)).ok, false);
  } finally {
    if (previous === undefined) delete process.env.IRIS_STATE_DIR;
    else process.env.IRIS_STATE_DIR = previous;
  }
});

test("여러 회차와 메모리 반환값은 서로 영향을 주지 않는다", async (t) => {
  const dir = setup(t);
  const anchor = createQaLedgerAnchor({ dir });
  await begin(anchor, "one");
  await begin(anchor, "two");
  await advance(anchor, "one");
  const response = await anchor({ op: "read", runId: "one" });
  response.data.hash = hashA;
  const restarted = createQaLedgerAnchor({ dir });
  assert.deepEqual((await restarted({ op: "read", runId: "one" })).data, { hash: hashB, seq: 1 });
  assert.deepEqual((await restarted({ op: "read", runId: "two" })).data, { hash: hashA, seq: 0 });
  assert.deepEqual((await anchor({ op: "read", runId: "one" })).data, { hash: hashB, seq: 1 });
});

test("저장 단계의 오류는 실패로 반환하고 디스크와 메모리를 갱신하지 않는다", async (t) => {
  for (const method of ["mkdirSync", "openSync", "writeFileSync", "fsyncSync", "renameSync"]) {
    const dir = setup(t);
    await begin(createQaLedgerAnchor({ dir }));
    const before = fs.readFileSync(path.join(dir, "qa-ledger-heads.json"), "utf8");
    const files = { ...fs, [method]: () => { throw new Error("injected write failure"); } };
    const anchor = createQaLedgerAnchor({ dir, fs: files });
    assert.equal((await advance(anchor)).ok, false, method);
    assert.deepEqual((await anchor({ op: "read", runId: "run-1" })).data, { hash: hashA, seq: 0 }, method);
    assert.equal(fs.readFileSync(path.join(dir, "qa-ledger-heads.json"), "utf8"), before, method);
    assert.deepEqual(fs.readdirSync(dir), ["qa-ledger-heads.json"], method);
    assert.equal((await begin(anchor, "run-2")).ok, false, method);
    assert.equal((await anchor({ op: "read", runId: "run-2" })).ok, false, method);
  }
});

test("깨진 저장 파일과 읽기 오류는 빈 앵커로 처리하거나 덮어쓰지 않는다", async (t) => {
  const invalid = ["{", "null", JSON.stringify({ version: 2, heads: {} }),
    JSON.stringify({ version: 1, heads: [] }),
    JSON.stringify({ version: 1, heads: { "run-1": { hash: hashA, seq: -1 } } }),
    JSON.stringify({ version: 1, heads: { "run-1": { hash: "wrong", seq: 0 } } }),
    JSON.stringify({ version: 1, heads: { "../bad": { hash: hashA, seq: 0 } } })];
  for (const data of invalid) {
    const dir = setup(t), file = path.join(dir, "qa-ledger-heads.json");
    fs.writeFileSync(file, data);
    const anchor = createQaLedgerAnchor({ dir });
    assert.equal((await begin(anchor)).ok, false);
    assert.equal((await anchor({ op: "read", runId: "run-1" })).ok, false);
    assert.equal(fs.readFileSync(file, "utf8"), data);
  }
  const dir = setup(t);
  const anchor = createQaLedgerAnchor({ dir, fs: { ...fs, readFileSync: () => { throw Object.assign(new Error("unreadable"), { code: "EACCES" }); } } });
  assert.equal((await begin(anchor)).ok, false);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("재시작 후에도 장부만 되감으면 저장된 머리와 달라 거부한다", async (t) => {
  const dir = setup(t), anchorDir = path.join(dir, "native");
  const ledger = createQaLedger({ dir, anchor: createQaLedgerAnchor({ dir: anchorDir }) });
  await ledger.begin({ runId: "resume", session: "s", plan: {}, charter: {
    question: "재시작 후 사용자가 기록을 다시 읽을 수 있는가?", scope: "QA 장부 복구", exclusions: "없음",
    environment: "격리된 테스트 폴더", sharedEnvironment: false, timebox: "1분", people: "없음", documents: "없음",
  } });
  const journal = path.join(dir, "resume", "journal.jsonl");
  const before = fs.readFileSync(journal, "utf8");
  await ledger.append("resume", { kind: "observation" });
  const restarted = createQaLedger({ dir, anchor: createQaLedgerAnchor({ dir: anchorDir }) });
  assert.equal((await restarted.verify("resume")).seq, 2);
  fs.writeFileSync(journal, before);
  await assert.rejects(restarted.verify("resume"), /머리 해시.*다릅니다/);
});

test("잘못된 해시, 순번과 회차는 저장하지 않는다", async (t) => {
  const dir = setup(t), anchor = createQaLedgerAnchor({ dir });
  for (const args of [{ runId: "../run", hash: hashA, seq: 0 }, { runId: 1, hash: hashA, seq: 0 },
    { runId: "run", hash: "wrong", seq: 0 }, { runId: "run", hash: hashA, seq: 1 }])
    assert.equal((await anchor({ op: "begin", ...args })).ok, false);
  assert.deepEqual(fs.readdirSync(dir), []);
  await begin(anchor);
  for (const args of [{ previousHash: hashB, seq: 1 }, { previousHash: hashA, seq: 2 },
    { previousHash: hashA, seq: NaN }, { previousHash: hashA, seq: 1, hash: "wrong" }])
    assert.equal((await anchor({ op: "advance", runId: "run-1", hash: hashB, ...args })).ok, false);
  assert.deepEqual((await anchor({ op: "read", runId: "run-1" })).data, { hash: hashA, seq: 0 });
});

test("머리 해시 갱신이 실패하면 방금 쓴 장부 줄과 사진을 되돌려 다음 검증이 통과한다", async (t) => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-ledger-rollback-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const real = createQaLedgerAnchor({ dir: path.join(dir, "native") });
  let down = false;
  // 앱 종료 중 메인 프로세스가 응답하지 않는 경우
  const anchor = async (request) => down && request.op === "advance" ? { ok: false, error: "메인 프로세스 종료 중" } : real(request);
  const ledger = createQaLedger({ dir: path.join(dir, "ledger"), anchor });
  const { qaPlan, qaCharter } = await import("./qa-fixtures.mjs");
  await ledger.begin({ runId: "run", session: "s", plan: qaPlan({ entries: [] }), charter: qaCharter() });
  const before = await ledger.verify("run");
  const source = path.join(dir, "shot.png"); fs.writeFileSync(source, "png");
  down = true;
  await assert.rejects(ledger.append("run", { kind: "frame", mode: "agent_action", phase: "S4", shotSource: source }), /종료 중/);
  down = false;
  const after = await ledger.verify("run");
  assert.equal(after.seq, before.seq);
  assert.equal(after.head, before.head);
  const shots = path.join(dir, "ledger", "run", "shots");
  assert.deepEqual(fs.existsSync(shots) ? fs.readdirSync(shots) : [], []);
  assert.equal((await ledger.append("run", { kind: "frame", mode: "agent_action", phase: "S4" })).seq, before.seq + 1);
});

test("머리 해시를 저장한 뒤 응답만 잃었으면 장부 줄을 유지한다", async (t) => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-ledger-lost-reply-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const real = createQaLedgerAnchor({ dir: path.join(dir, "native") });
  let lose = false;
  const anchor = async (request) => { const result = await real(request); return lose && request.op === "advance" ? { ok: false, error: "응답 시간 초과" } : result; };
  const ledger = createQaLedger({ dir: path.join(dir, "ledger"), anchor });
  const { qaPlan, qaCharter } = await import("./qa-fixtures.mjs");
  await ledger.begin({ runId: "run", session: "s", plan: qaPlan({ entries: [] }), charter: qaCharter() });
  const before = await ledger.verify("run");
  lose = true;
  const appended = await ledger.append("run", { kind: "frame", mode: "agent_action", phase: "S4" });
  lose = false;
  assert.equal(appended.seq, before.seq + 1);
  assert.equal((await ledger.verify("run")).seq, before.seq + 1);
});

test("머리 해시 갱신 응답과 다시 읽기가 모두 실패하면 장부 줄을 되돌리지 않는다", async (t) => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-ledger-unknown-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const real = createQaLedgerAnchor({ dir: path.join(dir, "native") });
  let silent = false, advanced = false;
  // 갱신은 저장됐지만 응답과 그 뒤 다시 읽기가 시간 초과. 되돌리면 앵커만 앞서 영구히 막힘
  const anchor = async (request) => {
    if (!silent) return real(request);
    if (request.op === "advance") { advanced = true; await real(request); return { ok: false, error: "timeout" }; }
    return advanced ? { ok: false, error: "timeout" } : real(request);
  };
  const ledger = createQaLedger({ dir: path.join(dir, "ledger"), anchor });
  const { qaPlan, qaCharter } = await import("./qa-fixtures.mjs");
  await ledger.begin({ runId: "run", session: "s", plan: qaPlan({ entries: [] }), charter: qaCharter() });
  const before = await ledger.verify("run");
  silent = true;
  await assert.rejects(ledger.append("run", { kind: "frame", mode: "agent_action", phase: "S4" }), /timeout/);
  silent = false;
  assert.equal((await ledger.verify("run")).seq, before.seq + 1);
});

test("앞선 서버 프로세스가 머리 해시 없이 남긴 마지막 한 줄은 재개 때 따로 옮기고, 같은 프로세스가 남긴 줄은 옮기지 않는다", async (t) => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-ledger-unanchored-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const real = createQaLedgerAnchor({ dir: path.join(dir, "native") });
  let gone = false;
  // 앱 종료 중 창 연결이 끊겨 갱신·읽기 모두 실패
  const anchor = async (request) => gone && request.op !== "begin" && request.op !== "read" ? { ok: false, error: "연결 끊김" }
    : gone && request.op === "read" && afterWrite ? { ok: false, error: "연결 끊김" } : real(request);
  let afterWrite = false;
  const wrapped = async (request) => { const result = await anchor(request); if (gone && request.op === "advance") afterWrite = true; return result; };
  const { qaPlan, qaCharter } = await import("./qa-fixtures.mjs");
  const first = createQaLedger({ dir: path.join(dir, "ledger"), anchor: wrapped });
  await first.begin({ runId: "run", session: "s", plan: qaPlan({ entries: [] }), charter: qaCharter() });
  const before = await first.verify("run");
  gone = true;
  await assert.rejects(first.append("run", { kind: "frame", mode: "agent_action", phase: "S4" }), /연결 끊김/);
  gone = false; afterWrite = false;
  await assert.rejects(first.verify("run"), /머리 해시가 장부와 다릅니다/);
  assert.equal(await first.recoverUnanchored("run"), null);
  // 서버 재시작: 새 프로세스의 장부 객체
  const second = createQaLedger({ dir: path.join(dir, "ledger"), anchor: real });
  const recovered = await second.recoverUnanchored("run");
  assert.equal(recovered.seq, before.seq + 1);
  const after = await second.verify("run");
  assert.equal(after.seq, before.seq + 1);
  assert.equal(after.events.at(-1).event.cmd, "ledger_recovery");
  const kept = fs.readFileSync(path.join(dir, "ledger", "run", "journal.unanchored.jsonl"), "utf8").trim().split("\n");
  assert.equal(JSON.parse(kept[0]).seq, before.seq + 1);
  assert.equal(await second.recoverUnanchored("run"), null);
});

test("두 줄 앞서거나 해시가 맞지 않는 장부는 옮기지 않는다", async (t) => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-ledger-unanchored-bad-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const real = createQaLedgerAnchor({ dir: path.join(dir, "native") });
  const { qaPlan, qaCharter } = await import("./qa-fixtures.mjs");
  const ledger = createQaLedger({ dir: path.join(dir, "ledger"), anchor: real });
  await ledger.begin({ runId: "run", session: "s", plan: qaPlan({ entries: [] }), charter: qaCharter() });
  const journal = path.join(dir, "ledger", "run", "journal.jsonl");
  const last = JSON.parse(fs.readFileSync(journal, "utf8").trim().split("\n").at(-1));
  fs.appendFileSync(journal, JSON.stringify({ seq: last.seq + 1, prevHash: last.hash, event: { kind: "frame" }, hash: "f".repeat(64) }) + "\n");
  const other = createQaLedger({ dir: path.join(dir, "ledger"), anchor: real });
  assert.equal(await other.recoverUnanchored("run"), null);
  await assert.rejects(other.verify("run"));
});

test("회차 시작 줄(seq 1)만 앵커보다 앞선 장부는 분리하지 않는다", async (t) => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-ledger-unanchored-begin-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const real = createQaLedgerAnchor({ dir: path.join(dir, "native") });
  let advanced = false;
  const wrapped = async (request) => {
    if (request.op === "advance") { advanced = true; return { ok: false, error: "연결 끊김" }; }
    return request.op === "read" && advanced ? { ok: false, error: "연결 끊김" } : real(request);
  };
  const { qaPlan, qaCharter } = await import("./qa-fixtures.mjs");
  await assert.rejects(createQaLedger({ dir: path.join(dir, "ledger"), anchor: wrapped }).begin({ runId: "run", session: "s", plan: qaPlan({ entries: [] }), charter: qaCharter() }));
  const journal = path.join(dir, "ledger", "run", "journal.jsonl");
  const bytes = fs.readFileSync(journal, "utf8");
  assert.equal(bytes.split("\n").filter(Boolean).length, 1);
  assert.equal(await createQaLedger({ dir: path.join(dir, "ledger"), anchor: real }).recoverUnanchored("run"), null);
  assert.equal(fs.readFileSync(journal, "utf8"), bytes);
});
