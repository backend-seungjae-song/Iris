// qa_row void 의 receipt 에 조작 결과의 receipt(action seq)나 실패 장면 seq 를 넣은 경우
import { qaPlan, qaRowContract } from "./qa-fixtures.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { applyQaRow } from "../server/qa-rows.js";

async function failedTap() {
  const events = [{ seq: 1, event: { kind: "run_begin", plan: qaPlan() } }];
  const ledger = { verify: async () => ({ events: structuredClone(events) }),
    append: async (_run, event) => { const rec = { seq: events.length + 1, event: structuredClone(event) }; events.push(rec); return rec; } };
  const call = args => applyQaRow({ ledger, runId: "test", args });
  const lane = { rowId: "R1", path: "정상" };
  await call({ action: "declare", ...qaRowContract(), id: "R1", what: "상태 표시", given: "로그인한 사용자", basis: "spec", paths: ["정상"] });
  await call({ action: "open", row: "R1", path: "정상" });
  const accepted = await ledger.append("test", { kind: "accepted", cmd: "app_tap", ...lane });
  const action = await ledger.append("test", { kind: "action", cmd: "app_tap", ...lane, acceptedSeq: accepted.seq, pass: false });
  const reaction = await ledger.append("test", { kind: "reaction", cmd: "app_tap", ...lane, acceptedSeq: accepted.seq, pass: false });
  const failure = await ledger.append("test", { kind: "failure", ...lane, shot: "shots/fail.png", detail: { failureSeq: action.seq } });
  return { events, ledger, call, action, reaction, failure };
}
const voidOf = events => events.findLast(r => r.event.kind === "row" && r.event.action === "void").event.rowData;

test("조작 결과의 receipt(action seq)로 무효 처리하면 같은 조작의 반응 판정을 무효로 기록한다", async () => {
  const f = await failedTap();
  await f.call({ action: "void", receipt: String(f.action.seq), why: "잘못 선언한 기대" });
  assert.equal(voidOf(f.events).receipt, String(f.reaction.seq));
  assert.equal(voidOf(f.events).requested, String(f.action.seq));
  assert.match(voidOf(f.events).resolved, new RegExp(`seq ${f.action.seq}\\(action\\)의 판정 ${f.reaction.seq}\\(reaction\\)`));
});

test("실패 장면 seq 로 무효 처리해도 같은 조작의 반응 판정을 무효로 기록한다", async () => {
  const f = await failedTap();
  await f.call({ action: "void", receipt: String(f.failure.seq), why: "도구 조회 시간 초과" });
  assert.equal(voidOf(f.events).receipt, String(f.reaction.seq));
});

test("앱에 전달되지 않아 판정이 없는 조작은 조작 seq 로 무효 처리한다", async () => {
  const events = [{ seq: 1, event: { kind: "run_begin", plan: qaPlan() } }];
  const ledger = { verify: async () => ({ events: structuredClone(events) }),
    append: async (_run, event) => { const rec = { seq: events.length + 1, event: structuredClone(event) }; events.push(rec); return rec; } };
  const call = args => applyQaRow({ ledger, runId: "test", args });
  const lane = { rowId: "R1", path: "정상" };
  await call({ action: "declare", ...qaRowContract(), id: "R1", what: "상태 표시", given: "로그인한 사용자", basis: "spec", paths: ["정상"] });
  await call({ action: "open", row: "R1", path: "정상" });
  const accepted = await ledger.append("test", { kind: "accepted", cmd: "app_tap", ...lane });
  const action = await ledger.append("test", { kind: "action", cmd: "app_tap", ...lane, acceptedSeq: accepted.seq, pass: false, reason: "모바일 조작 대상이 바뀌었거나 가려졌습니다." });
  const reaction = await ledger.append("test", { kind: "reaction", cmd: "app_tap", ...lane, acceptedSeq: accepted.seq, pass: null });
  await assert.rejects(call({ action: "void", receipt: String(reaction.seq), why: "판정 아님" }), /판정과 연결되지 않습니다/);
  await call({ action: "void", receipt: String(action.seq), why: "조작이 앱에 전달되지 않음" });
  assert.equal(voidOf(events).receipt, String(action.seq));
  assert.equal(voidOf(events).pass, false);
});

test("통과한 조작은 판정이 없어도 무효 대상이 아니다", async () => {
  const f = await failedTap();
  const accepted = await f.ledger.append("test", { kind: "accepted", cmd: "app_tap", rowId: "R1", path: "정상" });
  const passed = await f.ledger.append("test", { kind: "action", cmd: "app_tap", rowId: "R1", path: "정상", acceptedSeq: accepted.seq, pass: true });
  await assert.rejects(f.call({ action: "void", receipt: String(passed.seq), why: "잘못된 대상" }), /판정과 연결되지 않습니다/);
});

test("판정과 연결되지 않은 번호는 여전히 거부한다", async () => {
  const f = await failedTap();
  await assert.rejects(f.call({ action: "void", receipt: "1", why: "잘못된 대상" }), /seq 1\(run_begin\)은 판정과 연결되지 않습니다/);
  await assert.rejects(f.call({ action: "void", receipt: "999", why: "잘못된 대상" }), /이 회차에 없는 판정/);
});

test("qa_play 실패(play_failure) seq 로 무효 처리하면 그 단계의 마지막 실패 판정을 무효로 기록한다", async () => {
  const f = await failedTap();
  const assertion = await f.ledger.append("test", { kind: "assertion", rowId: "R1", path: "정상", pass: false, expected: { mode: "exists", text: "조작 가능한 대상" } });
  const played = await f.ledger.append("test", { kind: "play_failure", rowId: "R1", path: "정상", reason: "조작 대상이 여러 개입니다" });
  await f.call({ action: "void", receipt: String(played.seq), why: "같은 이름 스위치 여럿, 도구가 대상을 고르지 못함" });
  assert.equal(voidOf(f.events).receipt, String(assertion.seq));
});

test("입력 전에 멈춘 qa_play 실패는 실행 범위 밖의 예전 실패 판정에 연결하지 않고 거절한다", async () => {
  const f = await failedTap();
  await f.ledger.append("test", { kind: "play_result", rowId: "R1", path: "정상", detail: { pass: true, startSeq: 1, steps: [] } });
  const step = await f.ledger.append("test", { kind: "play_step", rowId: "R1", path: "정상", detail: { index: 0, status: "실패", reason: "조작 대상을 찾을 수 없음" } });
  const played = await f.ledger.append("test", { kind: "play_failure", rowId: "R1", path: "정상", reason: "조작 대상을 찾을 수 없음" });
  await f.ledger.append("test", { kind: "play_result", rowId: "R1", path: "정상", detail: { pass: false, startSeq: step.seq, steps: [] } });
  await assert.rejects(f.call({ action: "void", receipt: String(played.seq), why: "대상 이름 오류" }), /무효로 할 판정이 없습니다/);
  assert.equal(f.events.some(r => r.event.kind === "row" && r.event.action === "void"), false);
});

test("qa_play 실행 결과·실패 기록·실패 장면 관찰 seq 로도 그 실행의 실패 판정을 무효로 기록한다", async () => {
  for (const pick of ["result", "failure", "observe"]) {
    const f = await failedTap();
    await f.ledger.append("test", { kind: "play_result", rowId: "R1", path: "정상", detail: { pass: true, startSeq: 1, steps: [] } });
    const start = await f.ledger.append("test", { kind: "observation", cmd: "app_snapshot", rowId: "R1", path: "정상", pass: true });
    const assertion = await f.ledger.append("test", { kind: "assertion", rowId: "R1", path: "정상", pass: false, reason: "조작 대상을 찾을 수 없음", expected: { mode: "exists", text: "조작 가능한 대상" } });
    const failure = await f.ledger.append("test", { kind: "failure", rowId: "R1", path: "정상", detail: { failureSeq: assertion.seq } });
    const observe = await f.ledger.append("test", { kind: "observation", cmd: "app_observe", rowId: "R1", path: "정상", pass: true, detail: { failureSeq: assertion.seq } });
    await f.ledger.append("test", { kind: "play_failure", rowId: "R1", path: "정상", reason: "조작 대상을 찾을 수 없음" });
    const result = await f.ledger.append("test", { kind: "play_result", rowId: "R1", path: "정상", detail: { pass: false, startSeq: start.seq, steps: [] } });
    const receipt = String({ result, failure, observe }[pick].seq);
    await f.call({ action: "void", receipt, why: "수정으로 바뀐 대상 이름" });
    assert.equal(voidOf(f.events).receipt, String(assertion.seq), pick);
  }
});

// qa_play 실패가 경로를 자동으로 닫은 뒤 그 실패를 무효로 하면 open 을 다시 부르지 않아도 이어 갈 수 있음(한 경로에서 open 5번 사례)
test("자동으로 닫힌 경로는 그 실패를 무효로 하면 다시 열리고, 사람이 다시 연 경로는 건드리지 않는다", async () => {
  const { reopenAfterVoid } = await import("../server/qa-rows.js");
  const f = await failedTap();
  await f.ledger.append("test", { kind: "row", rowId: "R1", path: "정상", action: "close", rowData: { color: "red", note: "기대 효과 미관찰", automatic: true } });
  await f.call({ action: "void", receipt: String(f.action.seq), why: "잘못 선언한 기대" });
  const again = await reopenAfterVoid({ ledger: f.ledger, runId: "test", voided: voidOf(f.events) });
  assert.deepEqual(again.reopened, { row: "R1", path: "정상" });
  assert.equal(f.events.at(-1).event.action, "open");
  assert.deepEqual(again.result.open, [{ id: "R1", path: "정상" }]);
  assert.equal(await reopenAfterVoid({ ledger: f.ledger, runId: "test", voided: voidOf(f.events) }), null, "이미 다시 열린 경로");
  assert.equal(await reopenAfterVoid({ ledger: f.ledger, runId: "test", voided: null }), null);
});

test("자동으로 닫히지 않은 경로의 무효 처리는 경로를 열지 않는다", async () => {
  const { reopenAfterVoid } = await import("../server/qa-rows.js");
  const f = await failedTap();
  await f.call({ action: "void", receipt: String(f.action.seq), why: "잘못 선언한 기대" });
  assert.equal(await reopenAfterVoid({ ledger: f.ledger, runId: "test", voided: voidOf(f.events) }), null);
});
