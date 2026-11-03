// 같은 조작의 판정이 실행마다 갈리지 않게: 조작 전 안정 대기, 반응 없는 첫 클릭 재시도, 미전달 조작과 확인 창 처리
// 실측: 같은 조작·기대 119묶음 중 55묶음 판정이 갈림. 실패 판정 253건 중 68건은 입력이 전달되지 않은 도구 실패
import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createQaChannel } from "../server/qa-channel.js";
import { checkText } from "../bin/mcp/report-plain.mjs";

const root = path.join(fs.realpathSync(os.tmpdir()), "qa-determinism-checks"); fs.mkdirSync(root, { recursive: true });
const home = fs.mkdtempSync(path.join(root, "run-")); process.env.IRIS_STATE_DIR = home;
const oracle = "기능의 용도";
const appear = { effects: [{ type: "appear", text: "저장됨", oracle }], within: 100 };
const charter = { question: "저장 결과를 볼 수 있는가", scope: "저장", exclusions: "외부 서비스", environment: "격리 fixture", sharedEnvironment: false, timebox: "1분", people: "없음", documents: "fixture" };
const plan = { entries: ["http://localhost:4321"], build: { repo: process.cwd() }, risks: [{ id: "save", risk: "저장 결과가 누락될 수 있다", size: "high", knowledge: "some", decision: "test" }], listRationale: "저장 결과 관찰" };
const row = { action: "declare", id: "row1", what: "저장 결과", given: "저장 화면", basis: "spec", basisNote: "저장 명세", paths: ["정상"], risk: ["save"], oracle: "기능의 용도: 저장 확인", dataChanging: false, mustNotChange: { notApplicable: true, reason: "화면 결과만 확인" } };
const review = { information: [{ row: "row1", text: "저장 결과 표시" }], duplicates: [], distribution: "정상 경로의 저장 결과 확인", missingRisks: "외부 소비자는 이번 fixture에 없음" };

// respond(cmd,args) 가 값을 주면 그대로 응답(raw 는 {ok,...} 전체), 아니면 기본 응답
function fixture(respond = () => undefined) {
  const events = [], sent = []; let serial = 0;
  const append = async (_id, event) => { const r = { seq: events.length + 1, event: structuredClone(event) }; events.push(r); return r; };
  const ledger = { append, begin: ({ runId, session, plan, charter }) => append(runId, { kind: "run_begin", session, plan, charter }), verify: async () => ({ events: structuredClone(events) }), end: async () => ({}) };
  const call = createQaChannel({ ledger, makeRoutes: () => ({ list: async () => [] }), createEntry: async () => ({ ok: true, data: { tabId: "tab" } }), release: async () => {}, ask: async () => ({ ok: true }),
    execute: async (_tab, cmd, args) => {
      sent.push({ cmd, args });
      const custom = await respond(cmd, args, sent);
      if (custom?.raw) return custom.raw;
      if (custom) return { ok: true, data: custom };
      if (cmd === "qa-background-observe") return { ok: true, data: { candidates: [], unexpected: [], scenes: [] } };
      if (cmd === "qa-target-resolve") return { ok: true, data: { found: true, x: 10, y: 20, occluded: false } };
      if (cmd === "qa-settle") return { ok: true, data: { waitedMs: 5, stable: true, remaining: [] } };
      if (cmd === "qa-reaction-start") return { ok: true, data: { id: "r" + (++serial), scenes: [] } };
      if (cmd === "qa-reaction-end") return { ok: true, data: { pass: true, effects: [{ ...appear.effects[0], id: "e1", observed: true }], events: [{ method: "dom" }], candidates: [], unexpected: [], scenes: [] } };
      return { ok: true, data: { trusted: true, pass: true, url: "http://localhost:4321", path: path.join(home, "missing.png") } };
    } });
  const f = { events, sent,
    send: (cmd, args = {}) => call(cmd, args, "session", f.run),
    async begin() {
      const r = await call("run_begin", { plan, charter }, "session"); assert.equal(r.ok, true, r.error); f.run = r.data.runId;
      await f.send("open_entry", { url: plan.entries[0] });
      assert.equal((await f.send("row", row)).ok, true);
      await f.send("list_review", { review });
      assert.equal((await f.send("row", { action: "open", row: "row1", path: "정상" })).ok, true);
      await f.send("snapshot");
    },
    reactions: () => events.filter(r => r.event.kind === "reaction" && r.event.rowId === "row1"),
  };
  return f;
}
const silentEnd = { pass: false, effects: [{ ...appear.effects[0], id: "e1", observed: false }], events: [], candidates: [{ id: "k3", code: "K3", description: "입력 전달 뒤 DOM·주소·요청·대화상자 반응 없음" }], unexpected: [], scenes: [] };

test("반응이 없던 첫 클릭은 안정 대기 뒤 한 번 더 누르고, 첫 시도는 판정에서 빼고 재시도에 표시한다", async () => {
  let ends = 0;
  const f = fixture(cmd => cmd === "qa-reaction-end" && ++ends === 1 ? structuredClone(silentEnd) : undefined);
  await f.begin();
  const r = await f.send("click", { x: 10, y: 20, expect: appear });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.pass, true);
  assert.match(r.data.note, /다시 누름/);
  const [first, second] = f.reactions();
  assert.equal(first.event.pass, null);
  assert.equal(first.event.detail.noReaction, true);
  assert.equal(first.event.detail.candidates.some(item => item.code === "K3"), false, "첫 시도의 반응 없음은 판단 대기로 남기지 않음");
  assert.equal(second.event.pass, true);
  assert.equal(second.event.detail.retryOf, first.seq);
  assert.equal(f.sent.filter(x => x.cmd === "qa-input").length, 2);
  // 입력마다 그 직전에 안정 대기
  const order = f.sent.map(x => x.cmd).filter(cmd => ["qa-settle", "qa-reaction-start", "qa-input"].includes(cmd));
  assert.deepEqual(order, ["qa-settle", "qa-reaction-start", "qa-input", "qa-settle", "qa-reaction-start", "qa-input"]);
  assert.equal(f.events.some(x => x.event.kind === "failure"), false);
});

test("두 번 모두 반응이 없으면 재시도 판정을 실패로 남기고 세 번째는 누르지 않는다", async () => {
  const f = fixture(cmd => cmd === "qa-reaction-end" ? structuredClone(silentEnd) : undefined);
  await f.begin();
  const r = await f.send("click", { x: 10, y: 20, expect: appear });
  assert.equal(r.data.pass, false);
  assert.equal(f.sent.filter(x => x.cmd === "qa-input").length, 2);
  const [first, second] = f.reactions();
  assert.equal(first.event.pass, null);
  assert.equal(second.event.pass, false);
  assert.equal(second.event.detail.retryOf, first.seq);
});

test("입력·키 조작은 반응이 없어도 다시 보내지 않는다", async () => {
  const f = fixture(cmd => cmd === "qa-reaction-end" ? structuredClone(silentEnd) : cmd === "qa-focused" ? { focused: null } : undefined);
  await f.begin();
  const r = await f.send("key", { key: "Enter", expect: appear });
  assert.equal(r.data.pass, false);
  assert.equal(f.sent.filter(x => x.cmd === "qa-input").length, 1);
  assert.equal(f.reactions()[0].event.pass, false);
});

test("전달되지 않은 조작은 판정이 아니며 실패 기록과 판단 대기를 만들지 않는다", async () => {
  const f = fixture(cmd => { if (cmd === "qa-input") throw new Error("No node found at given location"); });
  await f.begin();
  const r = await f.send("click", { x: 10, y: 20, expect: appear });
  assert.equal(r.data.delivered, false);
  assert.match(r.error, /No node found/);
  const [reaction] = f.reactions();
  assert.equal(reaction.event.pass, null);
  assert.equal(reaction.event.detail.candidates.some(item => item.code === "K1"), false);
  assert.equal(f.events.some(x => x.event.kind === "failure"), false);
  assert.equal(f.sent.filter(x => x.cmd === "qa-input").length, 1, "전달 실패는 다시 누르지 않음");
});

const dialogFixture = () => {
  let dialog = null;
  return fixture(cmd => {
    if (cmd === "qa-input") { dialog = { kind: "alert", message: "상품옵션을 선택해주세요." };
      return { raw: { ok: false, dialogOpen: dialog, error: `페이지의 확인 창(alert)이 떠 있어 이 탭이 멈췄습니다: "${dialog.message}".` } }; }
    if (cmd === "qa-dialog-state") return { dialog };
    if (cmd === "qa-dialog-answer") { dialog = null; return { answered: "ok", via: "intercepted" }; }
  });
};

test("클릭으로 뜬 확인 창은 전달된 반응이며 대화상자 기대이면 통과한다", async () => {
  const f = dialogFixture();
  await f.begin();
  const r = await f.send("click", { x: 10, y: 20, expect: { effects: [{ type: "dialog", kind: "alert", text: "옵션", oracle }], within: 100 } });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.delivered, true);
  assert.equal(r.data.pass, true);
  assert.match(r.data.next, /qa_dialog/);
  assert.equal(f.sent.some(x => x.cmd === "qa-reaction-end"), false, "멈춘 페이지에 관찰 종료를 보내지 않음");
  const answered = await f.send("dialog", { answer: "ok", expect: { effects: [{ type: "none", oracle }], within: 100 } });
  assert.equal(answered.ok, true, answered.error);
  assert.ok(f.sent.some(x => x.cmd === "qa-reaction-end"), "답 뒤 남은 관찰 종료");
});

test("다른 결과를 기대한 클릭에 확인 창이 뜨면 확인 창 내용을 이유로 실패 판정한다", async () => {
  const f = dialogFixture();
  await f.begin();
  const r = await f.send("click", { x: 10, y: 20, expect: appear });
  assert.equal(r.data.delivered, true);
  assert.equal(r.data.pass, false);
  assert.match(r.error, /조작 뒤 확인 창\(alert\)이 떠 페이지가 멈춤: "상품옵션을 선택해주세요."/);
  const [reaction] = f.reactions();
  assert.equal(reaction.event.pass, false);
  assert.equal(reaction.event.detail.dialog.message, "상품옵션을 선택해주세요.");
  assert.equal(f.sent.filter(x => x.cmd === "qa-input").length, 1, "확인 창은 다시 누르지 않음");
});

test("보고서 확인 줄은 다시 눌러 얻은 판정을 표시하고 다른 판정과 묶지 않는다", () => {
  const effects = [{ type: "appear", name: "저장됨", observed: true }];
  const plain = checkText({ pass: true, act: { kind: "click", name: "저장" }, effects });
  const retried = checkText({ pass: true, act: { kind: "click", name: "저장", retried: true }, effects });
  assert.match(retried.want, /첫 클릭에 화면 반응이 없어 다시 누름/);
  assert.doesNotMatch(plain.want, /다시 누름/);
  assert.notEqual(plain.key, retried.key);
});
