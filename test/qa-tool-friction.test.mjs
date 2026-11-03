// 기록에 이미 있는 값은 도구가 채우고, 같은 호출을 다시 해도 거부하지 않음
// 실측: 실패 1,061건 중 형식 거부 637건(qa_row 259, qa_play 191, qa_unexpected 88 …)
import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createQaChannel } from "../server/qa-channel.js";

const root = path.join(fs.realpathSync(os.tmpdir()), "qa-friction-checks"); fs.mkdirSync(root, { recursive: true });
process.env.IRIS_STATE_DIR = fs.mkdtempSync(path.join(root, "run-"));
const oracle = "기능의 용도";
const appear = { effects: [{ type: "appear", text: "저장됨", oracle }], within: 100 };
const step = { target: { role: "button", name: "저장" }, action: "click", expect: appear };
const charter = { question: "저장 결과를 볼 수 있는가", scope: "저장", exclusions: "외부 서비스", environment: "격리 fixture", sharedEnvironment: false, timebox: "1분", people: "없음", documents: "fixture" };
const plan = { entries: ["http://localhost:4321"], build: { repo: process.cwd() }, risks: [{ id: "save", risk: "저장 결과가 누락될 수 있다", size: "high", knowledge: "some", decision: "test" }], listRationale: "저장 결과 관찰" };
const row = (id, more = {}) => ({ action: "declare", id, what: "저장 결과", given: "저장 화면", basis: "spec", basisNote: "저장 명세", paths: ["정상"], risk: ["save"], oracle: "기능의 용도: 저장 확인", dataChanging: false, mustNotChange: { notApplicable: true, reason: "화면 결과만 확인" }, ...more });
const review = ids => ({ information: ids.map(id => ({ row: id, text: "저장 결과 표시" })), duplicates: [], distribution: "정상 경로의 저장 결과 확인", missingRisks: "외부 소비자는 이번 fixture에 없음" });

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
      if (cmd === "qa-reaction-start") return { ok: true, data: { id: "r" + (++serial), scenes: [] } };
      if (cmd === "qa-reaction-end") return { ok: true, data: { pass: true, effects: [{ ...appear.effects[0], id: "e1", observed: true }], events: [{ method: "dom" }], candidates: [], unexpected: [], scenes: [] } };
      return { ok: true, data: { trusted: true, pass: true, url: "http://localhost:4321", path: "shot.png" } };
    } });
  const f = { events, sent,
    send: (cmd, args = {}) => call(cmd, args, "session", f.run),
    async begin(ids = ["row1"], declare = row) {
      const r = await call("run_begin", { plan, charter }, "session"); assert.equal(r.ok, true, r.error); f.run = r.data.runId;
      await f.send("open_entry", { url: plan.entries[0] });
      for (const id of ids) assert.equal((await f.send("row", declare(id))).ok, true);
      assert.equal((await f.send("list_review", { review: review(ids) })).ok, true);
    },
  };
  return f;
}

test("mustNotChange 는 text 만 적어도 받고, 실행 단계의 바뀌지 않음 기대로 들어간다", async () => {
  const f = fixture();
  await f.begin(["row1"], id => row(id, { mustNotChange: [{ text: "응모 화면 상품 목록", reason: "발행은 그 당첨만 바꿈" }] }));
  assert.equal((await f.send("play", { row: "row1", steps: [step] })).ok, true);
  const accepted = f.events.find(r => r.event.kind === "accepted" && r.event.rowId === "row1");
  assert.ok(accepted.event.expected.effects.some(effect => effect.type === "unchanged" && effect.text === "응모 화면 상품 목록"));
  const rejected = await f.send("row", row("row2", { mustNotChange: [{ reason: "대상 없음" }] }));
  assert.match(rejected.error, /sel, role\+name, text 중 하나/);
});

test("열린 항목이 없으면 qa_play 의 row 로 그 항목을 열고 실행한다", async () => {
  const f = fixture();
  await f.begin();
  const r = await f.send("play", { row: "row1", steps: [step] });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.pass, true);
  assert.ok(f.events.some(x => x.event.kind === "row" && x.event.action === "open" && x.event.rowId === "row1"));
  assert.match((await f.send("play", { row: "row2", steps: [step] })).error, /항목 row1이 열려 있습니다/);
});

test("직전 qa_play 가 막힘으로 닫은 항목은 row 없이 다시 열고, 빨강으로 닫은 항목은 row 가 있어야 연다", async () => {
  let occluded = true, fail = false;
  const f = fixture(cmd => {
    if (cmd === "qa-target-resolve") return { found: true, x: 10, y: 20, occluded, blocker: occluded ? { sel: "#tip", text: "도움말" } : undefined };
    if (cmd === "qa-reaction-end" && fail) return { pass: false, effects: [{ ...appear.effects[0], id: "e1", observed: false }], events: [{ method: "dom" }], candidates: [], unexpected: [], scenes: [] };
  });
  await f.begin();
  const blocked = await f.send("play", { row: "row1", steps: [step] });
  assert.equal(blocked.data.pass, false);
  assert.equal(f.events.findLast(x => x.event.kind === "row" && x.event.action === "close").event.rowData.color, "gray");
  occluded = false; fail = true;
  const failed = await f.send("play", { steps: [step] });
  assert.equal(failed.ok, true, failed.error);
  assert.equal(f.events.findLast(x => x.event.kind === "row" && x.event.action === "close").event.rowData.color, "red");
  assert.match((await f.send("play", { steps: [step] })).error, /열린 확인 항목/);
  fail = false;
  assert.equal((await f.send("play", { row: "row1", steps: [step] })).data.pass, true);
});

test("같은 분류로 이미 판단한 반응을 다시 부르면 기존 판단을 돌려주고, 다른 분류면 이유를 알린다", async () => {
  const f = fixture(cmd => cmd === "qa-reaction-end" ? { pass: true, effects: [{ ...appear.effects[0], id: "e1", observed: true }], events: [{ method: "dom" }], candidates: [{ id: "k2", code: "K2", description: "브라우저 오류: 시험" }], unexpected: [], scenes: [] } : undefined);
  await f.begin();
  await f.send("row", { action: "open", row: "row1", path: "정상" });
  await f.send("snapshot");
  const clicked = await f.send("click", { x: 10, y: 20, expect: appear });
  const id = clicked.data.reactions.items[0].id;
  const judgment = { id, class: "무관 반응", source: "미확인", attempts: ["시험 실행기에서 오류 생성 경로 확인"], cause: "시험 페이지 오류", condition: { code: "K2" } };
  assert.equal((await f.send("unexpected", judgment)).ok, true);
  const again = await f.send("unexpected", judgment);
  assert.equal(again.ok, true, again.error);
  assert.equal(again.data.alreadyJudged, true);
  const other = await f.send("unexpected", { ...judgment, class: "배경 반응" });
  assert.match(other.error, /이미 '무관 반응'로 판단/);
});

test("reproducible 을 빼면 같은 기대의 실패·통과 판정 수로 정한다", async () => {
  let fail = true;
  const f = fixture(cmd => cmd === "qa-reaction-end" && fail ? { pass: false, effects: [{ ...appear.effects[0], id: "e1", observed: false }], events: [{ method: "dom" }], candidates: [], unexpected: [], scenes: [] } : undefined);
  await f.begin();
  await f.send("row", { action: "open", row: "row1", path: "정상" });
  const defect = { problem: "저장 표시 누락", oracle, oracleNote: "저장 뒤 표시가 없음", importance: "저장 확인 불가", tried: "저장 두 번" };
  const click = async () => { await f.send("snapshot"); await f.send("click", { x: 10, y: 20, expect: appear }); };
  await click();
  assert.equal((await f.send("defect", defect)).data.event?.detail?.reproducible ?? f.events.findLast(x => x.event.kind === "defect").event.detail.reproducible, "재현 안 됨");
  await click();
  await f.send("defect", defect);
  assert.equal(f.events.findLast(x => x.event.kind === "defect").event.detail.reproducible, "재현됨");
  assert.deepEqual(f.events.findLast(x => x.event.kind === "defect").event.detail.reproduction, { failed: 2, passed: 0, derived: true });
  fail = false; await click();
  await f.send("defect", defect);
  assert.equal(f.events.findLast(x => x.event.kind === "defect").event.detail.reproducible, "가끔 재현됨");
});

test("늦은 반응 모으기는 이미 기록한 반응을 다시 기록하지 않는다", async () => {
  const candidate = { id: "k2", code: "K2", description: "브라우저 오류: 시험", count: 1 };
  const f = fixture(cmd => {
    if (cmd === "qa-reaction-end") return { pass: true, effects: [{ ...appear.effects[0], id: "e1", observed: true }], events: [{ method: "dom" }], candidates: [structuredClone(candidate)], unexpected: [], scenes: [] };
    if (cmd === "qa-reaction-drain") return { id: "r1", candidates: [structuredClone(candidate)], unexpected: [], scenes: [] };
  });
  await f.begin();
  await f.send("row", { action: "open", row: "row1", path: "정상" });
  await f.send("snapshot"); await f.send("click", { x: 10, y: 20, expect: appear });
  const before = f.events.filter(x => x.event.kind === "reaction").length;
  await f.send("snapshot"); await f.send("click", { x: 10, y: 20, expect: appear });
  const drained = f.events.filter(x => x.event.kind === "reaction" && !x.event.cmd);
  assert.equal(drained.length, 0, "횟수가 그대로인 반응은 drain 기록을 만들지 않음");
  assert.equal(f.events.filter(x => x.event.kind === "reaction").length, before + 1);
});
