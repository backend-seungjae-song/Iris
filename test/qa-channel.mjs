import { qaPlan, qaRowContract } from "./qa-fixtures.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createQaChannel } from "../server/qa-channel.js";
import { ordinaryCommandDenied, sanitizeBrowserArgs } from "../server/qa-command-contract.js";
import { claimQaTab, releaseQaTab } from "../server/qa-ownership.js";

const charter = {
  question: "사용자가 저장 후 결과를 볼 수 있는가", scope: "저장 화면", exclusions: "없음",
  environment: "로컬 테스트 계정과 격리 데이터", sharedEnvironment: false, timebox: "10분", people: "없음", documents: "저장 명세",
};
const sessionRecord = {
  work: "저장 화면 확인", curios: "없음", checked: "저장 결과 표시",
  unverified: { items: "없음", reason: "해당 없음" }, blockers: "없음", outOfScope: "없음", risks: "없음",
  stopCriterion: "questions_answered", remainingQuestions: "없음",
};
const noVisibleChange = { expect: { effects: [{ id: "none", type: "none", oracle: "기능의 용도" }] } };

function fixture({ execute, ask, mobileFactory } = {}) {
  const events = [], sent = [], released = [], closed = [];
  const append = async (_id, event) => {
    const record = { seq: events.length + 1, event: structuredClone(event) };
    events.push(record); return record;
  };
  const ledger = {
    begin: async ({ runId, session, plan, charter }) => append(runId, { kind: "run_begin", session, plan, charter }),
    verify: async () => ({ events: structuredClone(events), head: "test-head" }),
    end: async (id, { session }) => append(id, { kind: "run_end", sessionRecord: session }),
    append,
  };
  const call = createQaChannel({ ledger, ...(mobileFactory ? {mobileFactory} : {}),
    createEntry: async () => ({ ok: true, data: { tabId: "test-tab" } }),
    execute: async (tab, cmd, args) => {
      sent.push({ tab, cmd, args });
      if (execute) return execute(tab, cmd, args, sent);
      return { ok: true, data: { ok: true, pass: true, shot: "shots/assertion.png", path: `shots/capture-${sent.length}.png`,
        snapshot: "Save", url: "http://localhost:4321/start", target: { role: "button", name: "Save" },
        received: [{ type: "click", trusted: true, role: "button", name: "Save" }], trusted: true } };
    },
    release: async (...args) => released.push(args), close: async (...args) => closed.push(args), ask: ask || (async () => ({ ok: true, data: { answer: "승인" } })),
    makeRoutes: () => ({ list: async () => [] }),
  });
  return { call, events, sent, released, closed, ledger };
}
async function started(options) {
  const f = fixture(options);
  const r = await f.call("run_begin", { plan: qaPlan({ entries: ["http://localhost:4321/start"] }), charter }, "test-session");
  assert.equal(r.ok, true, JSON.stringify(r));
  f.run = r.data.runId;
  f.send = (cmd, args = {}, session = "test-session") => f.call(cmd, args, session, f.run);
  assert.equal((await f.send("open_entry", { url: "http://localhost:4321/start" })).ok, true);
  assert.equal(f.sent[0].cmd, "qa-background-observe");
  f.sent.length = 0;
  return f;
}
async function openRow(f) {
  assert.equal((await f.send("row", { action: "declare", ...qaRowContract(), id: "save", what: "저장 결과 표시", given: "저장 화면을 연 사용자",
    basis: "spec", basisNote: "저장 후 결과 표시 명세", paths: ["정상"] })).ok, true);
  assert.equal((await f.send("row", { action: "open", row: "save", path: "정상" })).ok, true);
}
test("close_tab closes only this run's tab outside a row and resume does not reopen it", async () => {
  const f = await started();
  assert.equal((await f.send("close_tab", { tab: "other-tab" })).ok, false);
  await openRow(f);
  assert.equal((await f.send("close_tab", { tab: "test-tab" })).ok, false);
  assert.equal(f.closed.length, 0);
  const fresh = await started();
  const r = await fresh.send("close_tab", { tab: "test-tab" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.data, { closed: "test-tab", tabs: [], active: null });
  assert.deepEqual(fresh.closed, [["test-tab", fresh.run]]);
  assert.equal(fresh.events.at(-1).event.cmd, "close_tab");
  assert.deepEqual((await fresh.send("tabs")).data, { tabs: [], active: null });
  const restored = [];
  const resumed = createQaChannel({ ledger: fresh.ledger, createEntry: async () => ({ ok: true }), execute: async () => ({ ok: true, data: {} }),
    release: async () => {}, close: async () => {}, ask: async () => ({ ok: true }), makeRoutes: () => ({ list: async () => [] }),
    restore: async (_session, tabs) => { restored.push(tabs); return { ok: true }; } });
  const resume = await resumed("run_resume", {}, "test-session", fresh.run);
  assert.equal(resume.ok, true, JSON.stringify(resume));
  assert.deepEqual(restored, [[]]);
  assert.deepEqual(resume.data.tabs, []);
});
test("resume keeps only the tabs restore returned and reports tabs closed outside the tool", async () => {
  const fresh = await started();
  const resumed = createQaChannel({ ledger: fresh.ledger, createEntry: async () => ({ ok: true }), execute: async () => ({ ok: true, data: {} }),
    release: async () => {}, close: async () => {}, ask: async () => ({ ok: true }), makeRoutes: () => ({ list: async () => [] }),
    restore: async () => ({ ok: true, data: { tabs: [], gone: ["test-tab"] } }) });
  const resume = await resumed("run_resume", {}, "test-session", fresh.run);
  assert.equal(resume.ok, true, JSON.stringify(resume));
  assert.deepEqual(resume.data.tabs, []);
  assert.deepEqual(resume.data.goneTabs, ["test-tab"]);
});
for (const [name, cmd, args] of [
  ["goto reason", "goto", { url: "http://localhost:4321/deep", reason: "test" }],
  ["cross origin", "goto", { url: "https://other.test/" }],
  ["entry argument", "open_entry", { url: "http://localhost:4321/start", entry: true }],
  ["new_tab reuse", "newtab", { url: "http://localhost:4321/deep", parallel: false }],
  ["eval computed click", "eval", { expression: 'document.querySelector("button")["click"]()' }],
  ["synthetic input fallback", "click", { x: 3, y: 4, force: true }],
]) test(`QA rejects ${name} before executor`, async () => {
  const f = await started();
  assert.equal((await f.send(cmd, args)).ok, false);
  assert.equal(f.sent.length, 0);
});
test("only frozen entry URL and bound session", async () => {
  const f = await started();
  assert.equal((await f.send("open_entry", { url: "http://localhost:4321/deep" })).ok, false);
  assert.equal((await f.send("text", {}, "other-session")).ok, false);
  await openRow(f);
  assert.equal((await f.send("open_entry", { url: "http://localhost:4321/start" })).ok, false);
  assert.equal(f.sent.length, 0);
});
test("coordinate action uses only qa-input and server receipt", async () => {
  const f = await started();
  await openRow(f);
  assert.equal((await f.send("snapshot")).ok, true);
  f.sent.length = 0;
  assert.equal((await f.send("click", { x: 25, y: 30, ...noVisibleChange })).ok, true);
  assert.deepEqual(f.sent.map(call => call.cmd), ["qa-reaction-drain", "qa-settle", "qa-reaction-start", "qa-input", "qa-reaction-end"]);
  assert.deepEqual(f.sent[3], { tab: "test-tab", cmd: "qa-input", args: { x: 25, y: 30, action: "click", expect: { ...noVisibleChange.expect, within: 5000 } } });
  const action = f.events.find(r => r.event.kind === "action");
  const frames = f.events.filter(r => r.event.kind === "frame");
  assert.deepEqual(frames, []);
  assert.equal((await f.send("observe")).ok, true);
  const r = await f.send("expect", { mode: "contains", text: "Saved" });
  assert.equal(r.data.receipt.event.kind, "assertion");
  assert.equal(r.data.receipt.event.rowId, "save");
  assert.equal(r.data.pass, true);
  assert.equal((await f.send("row", { action: "close", row: "save", path: "정상", color: "green", note: "저장 결과 표시", sceneJudgment: "화면 전체를 확인함" })).ok, true);
  assert.equal((await f.send("run_end", { session: sessionRecord })).ok, true);
  assert.equal((await f.send("click", { x: 25, y: 30, ...noVisibleChange })).ok, false);
  assert.deepEqual(f.events[0].event.charter, charter);
  assert.deepEqual(f.events.at(-1).event.sessionRecord, sessionRecord);
  assert.equal(f.released.length, 1);
});

test("undeclared row aliases cannot begin execution", async () => {
  const f = await started();
  for (const args of [{ action: "begin", id: "missing" }, { action: "open", row: "missing", path: "정상" }])
    assert.equal((await f.send("row", args)).ok, false);
  assert.equal(f.events.filter(r => r.event.kind === "row").length, 0);
  assert.equal(f.sent.length, 0);
});

test("run_end requires a complete session record and does not release on rejection", async () => {
  const f = await started();
  for (const args of [{}, { session: { work: "저장 확인" } }, { session: { ...sessionRecord, remainingQuestions: " " } }])
    assert.equal((await f.send("run_end", args)).ok, false);
  assert.equal(f.events.some(r => r.event.kind === "run_end"), false);
  assert.equal(f.released.length, 0);
  assert.equal((await f.send("snapshot")).ok, true);
});

test("ask_user rejects an internal ok:false result at the channel boundary", async () => {
  const f = await started({ ask: async () => ({ ok: true, data: { ok: false, error: "사용자 요청 전달 실패" } }) });
  const result = await f.send("ask_user", { reason: "계정 확인" });
  assert.equal(result.ok, false);
  assert.match(result.error, /사용자 요청 전달 실패/);
});

test("failed automatic before capture retains accepted request and prevents input", async () => {
  const f = await started({ execute: async (_tab, cmd) => ["qa-background-observe", "qa-reaction-drain"].includes(cmd) ? { ok: true, data: {} } : { ok: false, error: "자동 캡처 실패" } });
  await openRow(f);
  const result = await f.send("click", { x: 25, y: 30, ...noVisibleChange });
  assert.equal(result.ok, false);
  assert.match(result.error, /캡처 실패/);
  assert.deepEqual(f.sent.map(call => call.cmd), ["qa-reaction-drain", "qa-settle", "qa-reaction-start"]);
  const accepted = f.events.find(r => r.event.kind === "accepted");
  assert.ok(accepted);
  assert.equal(f.events.some(r => r.event.kind === "action" || r.event.kind === "frame"), false);
  assert.equal((await f.send("run_end", { session: sessionRecord })).ok, false);
});

test("failed automatic after capture preserves the action and rejects completion", async () => {
  const f = await started({ execute: async (_tab, cmd) => ["qa-reaction-end", "reaction_end", "qa-input"].includes(cmd)
    ? { ok: false, error: "후속 캡처 실패" } : { ok: true, data: { path: "shots/before.png", trusted: true } } });
  await openRow(f);
  assert.equal((await f.send("click", { x: 25, y: 30, ...noVisibleChange })).ok, false);
  // 입력이 전달되지 않은 조작은 제품 판정이 아니라 실패 장면(screenshot·observe)을 남기지 않음
  assert.deepEqual(f.sent.map(call => call.cmd), ["qa-reaction-drain", "qa-settle", "qa-reaction-start", "qa-input", "qa-reaction-end"]);
  assert.equal(f.events.filter(r => r.event.kind === "accepted").length, 1);
  assert.equal(f.events.filter(r => r.event.kind === "action").length, 1);
  assert.equal(f.events.find(r => r.event.kind === "reaction").event.pass, null);
  assert.deepEqual(f.events.filter(r => r.event.kind === "frame").map(r => r.event.phase), []);
});
test("ordinary channel cannot invoke QA commands", async () => {
  for (const cmd of ["qa-input", "qa-anchor", "run", "row", "journal", "expect", "report"])
    assert.equal(ordinaryCommandDenied(cmd), true);
});
test("external browser arguments lose internal markers", () => {
  assert.deepEqual(sanitizeBrowserArgs({ entry: true, qaRunId: "x", _internal: true, run: "x", channel: "qa", url: "https://example.test" }), { url: "https://example.test" });
  claimQaTab("tab", "run");
  assert.throws(() => claimQaTab("tab", "other"));
  assert.throws(() => releaseQaTab("tab", "other"));
  releaseQaTab("tab", "run");
});

test("모바일 촬영 실패도 완료 기록을 남기고 입력을 보내지 않는다", async () => {
  const calls = [];
  const f = await started({mobileFactory:()=>({execute:async (_session,cmd)=>{
    calls.push(cmd);
    return ["screenshot", "reaction_start"].includes(cmd) ? {ok:false,error:"모바일 촬영 실패"} : {ok:true,data:{}};
  }})});
  await openRow(f);
  const result = await f.send("app_tap",{x:10,y:10,device:"phone",...noVisibleChange});
  assert.equal(result.ok,false);
  assert.deepEqual(calls,["reaction_start"]);
  const accepted = f.events.find(r=>r.event.kind === "accepted");
  const failed = f.events.find(r=>r.event.cmd === "capture_failed");
  assert.equal(failed.event.acceptedSeq,accepted.seq);
  assert.equal(failed.event.pass,false);
  assert.equal((await f.send("row",{action:"close",row:"save",path:"정상",color:"gray",note:"촬영 실패",sceneJudgment:"촬영 실패 장면을 확인함"})).ok,true);
  assert.equal((await f.send("run_end",{session:sessionRecord})).ok,true);
});
