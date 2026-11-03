import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createQaLedger } from "../server/qa-ledger.js";
import { createQaRoutes } from "../server/qa-routes.js";
import { qaCharter, qaPlan } from "./qa-fixtures.mjs";

const require = createRequire(import.meta.url);
const { createQaLedgerAnchor } = require("../native/electron/qa-ledger-anchor.cjs");
const root = path.join(fs.realpathSync(os.tmpdir()), "qa-route-input-tests");
const target = { role: "textbox", name: "검색어" };
const arrival = { mode: "exists", sel: "#result" };
const types = { click: "click", type: "input", key: "keydown", scroll: "wheel" };
const input = {
  type: { kind: "text", param: "query", length: 8 },
  key: { kind: "key", key: "Enter" },
  scroll: { kind: "scroll", deltaX: 0, deltaY: 120 },
};
const action = (cmd, overrides = {}) => ({ kind: "action", mode: "agent_action", cmd, pass: true, target,
  received: [{ type: types[cmd], trusted: true, ...target }], input: input[cmd], ...overrides });

async function setup(t, executor) {
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, "route-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = createQaLedger({ dir, anchor: createQaLedgerAnchor({ dir: path.join(dir, "native") }) });
  await ledger.begin({ runId: "source", session: "s", plan: qaPlan(), charter: qaCharter() });
  const entry = await ledger.append("source", { kind: "entry", url: "http://localhost:4291" });
  const routes = createQaRoutes({ ledger, dir, executor: executor || (async ({ step }) => ({
    ok: true, pass: true, topTarget: step.target, arrival: step.arrival,
    received: [{ type: types[step.cmd], trusted: true, ...step.target }],
  })) });
  const save = async (events) => {
    let end;
    for (const event of events) end = await ledger.append("source", event);
    return routes.save({ runId: "source", name: "검색 준비", fromSeq: entry.seq + 1, toSeq: end.seq, currentUrl: "http://localhost:4291" });
  };
  return { dir, ledger, routes, save };
}

test("문자열 매개변수·키·스크롤을 저장하고 촬영과 관찰은 조작을 대신하지 않는다", async (t) => {
  const { save, routes, dir } = await setup(t);
  const events = [];
  for (const cmd of ["type", "key", "scroll"]) {
    const acceptedSeq = events.length + 4;
    events.push({ kind: "frame", phase: "before", surface: "browser", path: "frame-before.png" },
      { kind: "accepted", cmd }, action(cmd, { acceptedSeq }), { kind: "observation", cmd: "snapshot", pass: true },
      { kind: "observation", cmd: "observe", pass: true },
      { kind: "frame", phase: "after", surface: "browser", path: "frame-after.png" },
      { kind: "assertion", pass: true, arrival });
  }
  const saved = await save(events);
  assert.deepEqual(saved.steps.map((step) => step.input), [{ param: "query" }, { key: "Enter" }, { deltaX: 0, deltaY: 120 }]);
  assert.equal(saved.steps.length, 3);
  assert.deepEqual((await routes.list())[0].params, ["query"]);
  assert.equal(fs.readFileSync(path.join(dir, "validated-routes.json"), "utf8").includes('"text"'), false);
  for (const step of saved.steps) assert.equal(Object.hasOwn(step.input, "length"), false);
});

test("매개변수 값은 실행기에만 주고 재생 기록에는 이름과 길이만 남긴다", async (t) => {
  const calls = [], text = "일반 검색어";
  const { save, routes, ledger, dir } = await setup(t, async ({ step, params }) => {
    calls.push({ step, params });
    return { ok: true, pass: true, topTarget: target, arrival,
      received: [{ type: types[step.cmd], trusted: true, ...target }] };
  });
  await save([action("type"), { kind: "assertion", pass: true, arrival }, action("key"),
    { kind: "assertion", pass: true, arrival }, action("scroll"), { kind: "assertion", pass: true, arrival }]);
  const replay = await routes.replay({ runId: "source", name: "검색 준비", params: { query: text } });
  assert.equal(replay.ok,true); assert.equal(replay.steps,3); assert.equal(replay.revalidated,false);
  assert.equal(calls[0].params.query, text);
  const verified = await ledger.verify("source");
  const steps = verified.events.filter((record) => record.event.kind === "route_step").map((record) => record.event);
  assert.equal(steps.length, 3);
  assert.ok(steps.every((event) => event.mode === "route_replay"));
  assert.deepEqual(steps[0].input, { kind: "text", length: text.length, param: "query" });
  for (const file of [path.join(dir, "validated-routes.json"), path.join(dir, "source", "journal.jsonl")])
    assert.equal(fs.readFileSync(file, "utf8").includes(text), false);
});

test("누락·추가·민감·잘못된 매개변수는 입력 실행 전에 거부한다", async (t) => {
  let calls = 0;
  const { save, routes, ledger } = await setup(t, async () => { calls++; });
  await save([action("type"), { kind: "assertion", pass: true, arrival }]);
  for (const params of [undefined, {}, null, [], { query: "" }, { query: " \n " }, { query: 1 },
    { query: "일반 검색어", other: "다른 값" }, { query: "password" }, { query: "일반 검색어", token: "일반 값" }])
    await assert.rejects(routes.replay({ runId: "source", name: "검색 준비", params }), /매개변수/);
  assert.equal(calls, 0);
  assert.equal((await ledger.verify("source")).events.filter((record) => record.event.kind === "route_step").length, 0);
  assert.equal((await routes.list())[0].misses, 0);
});

test("입력 식별자가 없거나 민감하고 키·스크롤 정보가 잘못되면 저장을 거부한다", async (t) => {
  const invalid = [action("type", { input: { kind: "text", length: 8 } }),
    action("type", { input: { kind: "text", param: "password" } }),
    action("type", { input: { kind: "text", param: "../query" } }),
    action("key", { input: { kind: "key" } }), action("key", { input: { kind: "key", key: " " } }),
    action("scroll", { input: { kind: "scroll", deltaX: 0, deltaY: 0 } }),
    action("scroll", { input: { kind: "scroll", deltaX: 0 } })];
  for (const event of invalid) {
    const { save } = await setup(t);
    await assert.rejects(save([event, { kind: "assertion", pass: true, arrival }]));
  }
});

test("각 입력의 실제 수신 대상과 통과한 도착 확인점이 필요하다", async (t) => {
  for (const cmd of ["type", "key", "scroll"]) {
    for (const received of [[], [{ type: types[cmd], trusted: false, ...target }],
      [{ type: types[cmd], trusted: true, role: "button", name: "다른 대상" }],
      [{ type: "click", trusted: true, ...target }]]) {
      const { save } = await setup(t);
      await assert.rejects(save([action(cmd, { received }), { kind: "assertion", pass: true, arrival }]), /수신/);
    }
    for (const assertion of [{ kind: "assertion", pass: false, arrival }, { kind: "assertion", pass: true }]) {
      const { save } = await setup(t);
      await assert.rejects(save([action(cmd), assertion]), /도착/);
    }
  }
});

test("실패한 관찰·촬영·미완료 접수와 사진만 든 경로는 저장하지 않는다", async (t) => {
  const variants = [[{ kind: "observation", cmd: "snapshot", pass: false }],
    [{ kind: "observation", cmd: "observe", pass: false }], [{ kind: "frame", pass: false }],
    [{ kind: "accepted", cmd: "snapshot" }], [{ kind: "observation", cmd: "ask_user", pass: true }]];
  for (const extra of variants) {
    const { save } = await setup(t);
    await assert.rejects(save([action("type"), ...extra, { kind: "assertion", pass: true, arrival }]));
  }
  const { save } = await setup(t);
  await assert.rejects(save([{ kind: "frame" }, { kind: "observation", cmd: "snapshot", pass: true }]), /조작/);
});

test("재생 수신 대상이 다르거나 도착 확인점이 다르면 다음 단계를 실행하지 않는다", async (t) => {
  const variants = [{ received: [] }, { topTarget: { role: "textbox", name: "다른 대상" } },
    { arrival: { mode: "exists", sel: "#elsewhere" } }];
  for (const override of variants) {
    let calls = 0;
    const { save, routes } = await setup(t, async ({ step }) => {
      calls++;
      return { ok: true, pass: true, topTarget: target, arrival,
        received: [{ type: types[step.cmd], trusted: true, ...target }], ...override };
    });
    await save([action("type"), { kind: "assertion", pass: true, arrival },
      action("key"), { kind: "assertion", pass: true, arrival }]);
    const result = await routes.replay({ runId: "source", name: "검색 준비", params: { query: "일반 검색어" } });
    assert.equal(result.ok, false);
    assert.equal(result.step, 1);
    assert.equal(calls, 1);
  }
});

test("실행기 예외에 입력값이 포함돼도 장부와 결과에 기록하지 않는다", async (t) => {
  const text = "검색문자노출확인";
  const { save, routes, dir } = await setup(t, async ({ params }) => { throw new Error(params.query); });
  await save([action("type"), { kind: "assertion", pass: true, arrival }]);
  const result = await routes.replay({ runId: "source", name: "검색 준비", params: { query: text } });
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes(text), false);
  assert.equal(fs.readFileSync(path.join(dir, "source", "journal.jsonl"), "utf8").includes(text), false);
});


test("사람 필요로 기록한 경로 입력은 다음 단계 없이 상위 응답에 전달한다", async t => {
  let calls = 0;
  const human = {humanRequired:true,blocked:true,recorded:true,next:"다음 항목"};
  const {save,routes} = await setup(t, async () => {
    calls++;
    throw Object.assign(new Error("사람 필요"), {qaHumanResult:human});
  });
  await save([action("click"), {kind:"assertion",pass:true,arrival},action("key"),{kind:"assertion",pass:true,arrival}]);
  await assert.rejects(routes.replay({runId:"source",name:"검색 준비"}), error => error.qaHumanResult === human);
  assert.equal(calls,1);
});
