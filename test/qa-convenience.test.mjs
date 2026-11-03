import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createQaChannel } from "../server/qa-channel.js";
import { qaCharter, qaPlan, qaRowContract } from "./qa-fixtures.mjs";

const fixtureRoot = path.join(fs.realpathSync(os.tmpdir()), "qa-convenience-fixture");
const local = "http://localhost:4321/prepare";

async function started({ url = local, surfaces = [url + "/verification"], hook, askHook, answers = [] } = {}) {
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const journals = new Map(), sent = [], asked = [];
  const state = { url, inputCount: 0, typeCount: 0, reactions: new Map() };
  const append = async (runId, event) => {
    const events = journals.get(runId);
    const record = { seq: events.length + 1, event: structuredClone(event) };
    events.push(record); return record;
  };
  const ledger = {
    begin: async ({ runId, charter, plan }) => { journals.set(runId, []); return append(runId, { kind: "run_begin", charter, plan }); },
    append,
    verify: async (runId) => ({ events: structuredClone(journals.get(runId)) }),
    paths: (runId) => ({ folder: path.join(fixtureRoot, runId) }),
  };
  const call = createQaChannel({ ledger, makeRoutes: () => ({ list: async () => [] }),
    mobileFactory: () => ({}), release: async () => {},
    createEntry: async () => ({ ok: true, data: { tabId: "convenience-tab" } }),
    ask: async (_tab, _session, reason, options) => {
      asked.push({ reason, options });
      askHook?.(state);
      return { ok: true, data: { answer: answers.shift() || "승인" } };
    },
    execute: async (tab, cmd, args) => {
      sent.push({ tab, cmd, args: structuredClone(args) });
      const response = hook?.(cmd, args, state, sent);
      if (response) return response;
      if (cmd === "qa-reaction-start") {
        const id = `reaction-${sent.length}`;
        state.reactions.set(id, args.expect);
        return { ok: true, data: { id, effects: args.expect.effects.map(effect => ({ ...effect, observed: false })), scenes: [{ id: `${id}-s1`, path: `shots/${id}-s1.png`, claim: { kind: "S1", description: "조작 전 기대" } }] } };
      }
      if (cmd === "qa-reaction-end") {
        const expect = state.reactions.get(args.id) || { effects: [] };
        return { ok: true, data: { pass: true, effects: expect.effects.map(effect => ({ ...effect, observed: true, elapsedMs: 1, sceneId: `${args.id}-s2` })), scenes: [{ id: `${args.id}-s2`, path: `shots/${args.id}-s2.png`, claim: { kind: "S3", description: "기대 확인" } }] } };
      }
      if (cmd === "qa-select-resolve") return {ok:true,data:{index:args.index,keySteps:args.index,typeahead:{char:"가",count:args.index},selectedIndex:args.index}};
      if (cmd === "url") return { ok: true, data: { url: state.url } };
      if (cmd === "qa-input") {
        state.inputCount++;
        if (args.action === "type") state.typeCount++;
        return { ok: true, data: { trusted: true, target: { role: "textbox", name: "입력칸" },
          received: [{ type: { click: "click", type: "input", key: "keydown" }[args.action], trusted: true, role: "textbox", name: "입력칸" }] } };
      }
      return { ok: true, data: { path: `shots/capture-${sent.length}.png`, snapshot: "S0 입력칸", url: state.url } };
    },
  });
  const result = await call("run_begin", { plan: qaPlan({ entries: [url], surfaces }), charter: qaCharter() }, "session");
  assert.equal(result.ok, true, JSON.stringify(result));
  const runId = result.data.runId;
  const send = (cmd, args = {}) => {
    const action = ["click","dblclick","type","key","select","drag","scroll","history","dialog","app_tap","app_swipe","app_type","app_key"].includes(cmd);
    if (action && !args.expect) args = { ...args, expect: cmd === "type" ? { effects: [{ type: "change", sel: "input:focus", to: args.text || "", oracle: "기능의 용도" }], within: 1000 } : { effects: [{ type: "none", oracle: "기능의 용도" }], within: 1000 } };
    return call(cmd, args, "session", runId);
  };
  assert.equal((await send("open_entry", { url })).ok, true);
  return { send, call, ledger, runId, state, sent, asked, events: journals.get(runId) };
}

async function openRow(f) {
  assert.equal((await f.send("row", { action: "declare", ...qaRowContract(), id: "input", what: "입력 결과 표시", given: "입력 화면을 연 사용자",
    basis: "spec", basisNote: "입력 내용 표시 명세", paths: ["정상"] })).ok, true);
  assert.equal((await f.send("row", { action: "open", row: "input", path: "정상" })).ok, true);
}

test("로컬 대량 기입 계획은 실제 입력으로 실행하고 토큰을 한 번만 사용한다", async () => {
  const f = await started();
  const values = ["기입원문첫째", "기입원문둘째"];
  const planned = await f.send("bulk_fill", { action: "plan", values });
  assert.equal(planned.ok, true);
  assert.equal(planned.data.approvalRequired, false);
  assert.equal(f.state.inputCount, 0);
  const result = await f.send("bulk_fill", { action: "commit", token: planned.data.token });
  assert.deepEqual(result.data, { typed: 2, total: 2 });
  assert.equal(f.asked.length, 0);
  assert.deepEqual(f.sent.filter((call) => call.cmd === "qa-input").map((call) => call.args.action), ["type", "key", "type"]);
  assert.deepEqual(f.sent.filter((call) => call.cmd === "qa-input" && call.args.action === "type").map((call) => call.args.text), values);
  const actions = f.events.filter((record) => record.event.kind === "action");
  assert.equal(actions.length, 3);
  assert.ok(actions.every((record) => record.event.mode === "preparation"));
  for (const record of actions) {
    const frames = f.events.filter((item) => item.event.kind === "frame" && item.event.acceptedSeq === record.event.acceptedSeq);
    assert.deepEqual(frames.map((item) => item.event.claim?.kind || item.event.phase), ["S1", "S3"]);
    assert.ok(frames[0].seq < frames[1].seq && frames[1].seq < record.seq);
    assert.ok(f.events.some((item) => item.seq < frames[0].seq && item.event.kind === "observation" && item.event.cmd === "snapshot"));
  }
  for (const value of values) assert.equal(JSON.stringify(f.events).includes(value), false);
  const count = f.state.inputCount;
  assert.equal((await f.send("bulk_fill", { action: "commit", token: planned.data.token })).ok, false);
  assert.equal(f.state.inputCount, count);
});

test("대량 기입은 토큰 없는 실행·URL 변경·확인 항목 내부·선언한 화면을 거부한다", async () => {
  const f = await started();
  assert.equal((await f.send("bulk_fill", { action: "commit", token: "unknown" })).ok, false);
  const planned = await f.send("bulk_fill", { action: "plan", values: ["일반 값"] });
  assert.equal(planned.ok, true);
  f.state.url = local + "/changed";
  assert.equal((await f.send("bulk_fill", { action: "commit", token: planned.data.token })).ok, false);
  assert.equal(f.state.inputCount, 0);
  f.state.url = local;
  await openRow(f);
  assert.equal((await f.send("bulk_fill", { action: "plan", values: ["일반 값"] })).ok, false);
  assert.equal((await f.send("bulk_fill", { action: "commit", token: planned.data.token })).ok, false);
  const declared = await started({ surfaces: [local] });
  assert.equal((await declared.send("bulk_fill", { action: "plan", values: ["일반 값"] })).ok, false);
  assert.equal(declared.state.inputCount, 0);
});

test("대량 기입은 계산식·줄바꿈·탭과 잘못된 계획 인자를 거부한다", async () => {
  const f = await started();
  for (const value of ["=1+1", "+1", "-1", "@SUM(A1)", "위\n아래", "앞\t뒤", "앞\r뒤"]) {
    assert.equal((await f.send("bulk_fill", { action: "plan", values: [value] })).ok, false);
  }
  for (const args of [{ action: "plan" }, { action: "plan", values: [] },
    { action: "plan", values: ["일반 값"], allowFormula: true }])
    assert.equal((await f.send("bulk_fill", args)).ok, false);
  assert.equal(f.state.inputCount, 0);
});

// 사람 승인은 세션 대화에서 받음. userApproved 없이 부르면 물을 내용만 돌려주고 입력하지 않음
test("원격 대량 기입은 대화에서 승인받아 userApproved로 다시 부를 때만 입력한다", async () => {
  const f = await started({ url: "https://qa.example.org/prepare" });
  const planned = await f.send("bulk_fill", { action: "plan", values: ["일반 값"] });
  assert.equal(planned.ok, true);
  assert.equal(planned.data.approvalRequired, true);
  const pending = await f.send("bulk_fill", { action: "commit", token: planned.data.token });
  assert.equal(pending.ok, false);
  assert.match(pending.error, /userApproved:true/);
  assert.equal(f.state.typeCount, 0);
  assert.equal(f.asked.length, 1);
  assert.deepEqual(f.asked[0].options.choices, ["승인", "취소"]);
  const approved = await f.send("bulk_fill", { action: "commit", token: planned.data.token, userApproved: true });
  assert.equal(approved.ok, true);
  assert.equal(f.state.typeCount, 1);
});

test("원격 대량 기입은 승인 대기 중 대상 URL이 바뀌면 입력하지 않는다", async () => {
  const f = await started({ url: "https://qa.example.org/prepare", askHook: (state) => { state.url = "https://other.example.org/prepare"; } });
  const planned = await f.send("bulk_fill", { action: "plan", values: ["일반 값"] });
  const result = await f.send("bulk_fill", { action: "commit", token: planned.data.token });
  assert.equal(result.ok, false);
  assert.equal(f.state.inputCount, 0);
});

test("대량 기입은 일부 입력 후 실패하면 진행 개수와 실패를 반환하고 토큰 재실행을 거부한다", async () => {
  const f = await started({ hook: (cmd, args, state) => cmd === "qa-input" && args.action === "type" && state.typeCount === 1
    ? { ok: false, error: "두 번째 입력 실패" } : undefined });
  const planned = await f.send("bulk_fill", { action: "plan", values: ["첫째", "둘째", "셋째"] });
  const result = await f.send("bulk_fill", { action: "commit", token: planned.data.token });
  assert.equal(result.ok, false);
  assert.equal(result.data.typed, 1);
  assert.equal(result.data.total, 3);
  assert.equal(f.state.typeCount, 1);
  assert.equal((await f.send("bulk_fill", { action: "commit", token: planned.data.token })).ok, false);
});

test("실제 문자열 입력 후 촬영이 실패해도 이미 입력한 개수를 결과에 남긴다", async () => {
  const f = await started({ hook: (cmd, _args, state) => cmd === "qa-reaction-end" && state.typeCount === 1
    ? { ok: false, error: "입력 후 촬영 실패" } : undefined });
  const planned = await f.send("bulk_fill", { action: "plan", values: ["첫째", "둘째"] });
  const result = await f.send("bulk_fill", { action: "commit", token: planned.data.token });
  assert.equal(result.ok, false);
  assert.equal(f.state.typeCount, 1);
  assert.equal(f.events.filter((record) => record.event.kind === "action" && record.event.cmd === "type" && record.event.input?.delivered).length, 1);
  assert.equal(result.data.typed, 1);
});

test("로그인은 실제 입력을 사용하고 원문을 기록하지 않으며 로컬은 별도 승인을 요구하지 않는다", async () => {
  const f = await started();
  const fields = [{ x: 10, y: 20, text: "계정입력원문" }, { x: 30, y: 40, text: "암호입력원문" }];
  const result = await f.send("login", { account: "qa-account", fields });
  assert.deepEqual(result.data, { filled: 2, submitted: false });
  assert.equal(f.asked.length, 0);
  assert.deepEqual(f.sent.filter((call) => call.cmd === "qa-input").map((call) => call.args.action), ["click", "key", "type", "click", "key", "type"]);
  // 칸에 남은 값 뒤에 이어 붙지 않게 입력 전에 전체 선택(qa-92771d8c C4 'editor@local.test20:31admin@local.test')
  assert.deepEqual(f.sent.filter((call) => call.cmd === "qa-input" && call.args.action === "key").map((call) => call.args.key), Array(2).fill(process.platform === "darwin" ? "Meta+a" : "Control+a"));
  for (const field of fields) assert.equal(JSON.stringify(f.events).includes(field.text), false);
  assert.deepEqual(f.events.filter((record) => record.event.kind === "action" && record.event.cmd === "type").map((record) => record.event.input.length), fields.map((field) => field.text.length));
});

test("원격 로그인은 출처와 계정마다 대화 승인을 받고 같은 승인만 재사용한다", async () => {
  const f = await started({ url: "https://qa.example.org/login" });
  const args = { account: "qa-account", fields: [{ x: 10, y: 20, text: "입력원문" }] };
  const pending = await f.send("login", args);
  assert.equal(pending.ok, false); assert.match(pending.error, /userApproved:true/);
  assert.equal(f.state.inputCount, 0);
  assert.equal((await f.send("login", { ...args, userApproved: true })).ok, true);
  assert.equal((await f.send("login", args)).ok, true, "같은 출처·계정 승인은 재사용");
  assert.equal(f.asked.length, 1);
  assert.equal((await f.send("login", { ...args, account: "other-account" })).ok, false);
  assert.equal(f.asked.length, 2);
  f.state.url = "https://other.example.org/login";
  assert.equal((await f.send("login", args)).ok, false);
  assert.equal(f.asked.length, 3);
});

test("로그인은 승인 대기 중 다른 출처로 이동하면 계정값을 입력하지 않는다", async () => {
  const f = await started({ url: "https://qa.example.org/login", askHook: (state) => { state.url = "https://other.example.org/login"; } });
  const result = await f.send("login", { account: "qa-account", fields: [{ x: 10, y: 20, text: "계정입력원문" }] });
  assert.equal(result.ok, false);
  assert.equal(f.state.inputCount, 0);
});

test("편의 입력은 입력 전 S0 snapshot이 실패하면 실제 입력을 보내지 않는다", async () => {
  for (const command of ["bulk_fill", "login", "select"]) {
    const f = await started({ hook: (cmd) => ["snapshot","qa-reaction-start"].includes(cmd) ? { ok: false, error: "입력 전 화면 읽기 실패" } : undefined });
    let args;
    if (command === "bulk_fill") {
      const planned = await f.send(command, { action: "plan", values: ["일반 값"] });
      args = { action: "commit", token: planned.data.token };
    } else if (command === "login") args = { account: "qa-account", fields: [{ x: 10, y: 20, text: "계정입력원문" }] };
    else args = { x: 10, y: 20, index: 1 };
    assert.equal((await f.send(command, args)).ok, false);
    assert.equal(f.state.inputCount, 0);
  }
});

test("diff는 현재 장부의 사진 순번 두 개를 절대경로로 바꿔 실행한다", async () => {
  const f = await started();
  await f.send("screenshot"); await f.send("screenshot");
  const shots = f.events.filter((record) => record.event.shot);
  const result = await f.send("diff", { before: shots[0].seq, after: shots[1].seq });
  assert.equal(result.ok, true, JSON.stringify(result));
  const call = f.sent.find((call) => call.cmd === "diff");
  assert.deepEqual({before:call.args.before,after:call.args.after}, { before: path.join(fixtureRoot, f.runId, shots[0].event.shot), after: path.join(fixtureRoot, f.runId, shots[1].event.shot) });
  assert.equal(result.data.receipt.event.kind, "diff");
  const count = f.sent.filter((call) => call.cmd === "diff").length;
  const other = await f.call("run_begin", { plan: qaPlan({ entries: [local] }), charter: qaCharter() }, "session");
  const foreign = await f.ledger.append(other.data.runId, { kind: "frame", shot: "shots/other-run.png" });
  assert.equal((await f.send("diff", { before: foreign.seq, after: shots[1].seq })).ok, false);
  for (const args of [{ before: 1, after: shots[1].seq }, { before: 10000, after: shots[1].seq },
    { before: "../../other.png", after: shots[1].seq }, { before: shots[0].seq, after: shots[1].seq, path: "other.png" }])
    assert.equal((await f.send("diff", args)).ok, false);
  assert.equal(f.sent.filter((call) => call.cmd === "diff").length, count);
});

test("shot_sizes는 실패를 크기별로 모으고 이전 viewport를 복구한다", async () => {
  const previous = {width:800,height:600,dpr:2};
  const f = await started({hook:(cmd,args)=>cmd === "qa-viewport-state" ? {ok:true,data:{viewport:previous}} : cmd === "viewport" && args.width === 390 ? {ok:false,error:"크기 실패"}:undefined});
  const result = await f.send("shot_sizes", {sizes:["mobile","desktop"],caption:"크기 확인",dpr:2});
  assert.equal(result.ok,true);
  assert.equal(result.data.failed,1);
  assert.match(result.data.shots[0].error,/크기 실패/);
  assert.equal(result.data.shots[1].width,1440);
  assert.deepEqual(f.sent.filter(c=>c.cmd === "viewport").at(-1).args,previous);
  assert.equal(f.events.filter(r=>r.event.kind === "action" && r.event.cmd === "viewport").length,3);
});

test("select는 실제 클릭·키 입력과 장면만 사용하고 범위를 넘긴 선택은 실행하지 않는다", async () => {
  const f = await started();
  const result = await f.send("select", { x: 10, y: 20, index: 2 });
  assert.equal(result.data.index, 2);
  assert.ok(f.sent.every((call) => ["qa-background-observe", "qa-reaction-drain", "qa-settle", "snapshot", "screenshot", "qa-input", "qa-select-resolve", "qa-reaction-start", "qa-reaction-end"].includes(call.cmd)));
  const inputs = f.sent.filter((call) => call.cmd === "qa-input");
  assert.equal(inputs[0].args.action, "click");
  // macOS 닫힌 선택 상자는 화살표 키로 값이 안 바뀌어 첫 글자 입력으로 고름
  assert.deepEqual(inputs.slice(1).map((call) => call.args.key || `${call.args.action}:${call.args.text}`), ["Escape", "typeahead:가", "typeahead:가"]);
  assert.equal(f.events.filter((record) => record.event.kind === "frame").length, 2);
  const count = f.sent.length;
  for (const index of [-1, 1001]) assert.equal((await f.send("select", { x: 10, y: 20, index })).ok, false);
  assert.equal(f.sent.length, count);
});
