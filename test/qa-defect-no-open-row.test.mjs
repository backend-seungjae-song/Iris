// 열린 항목이 없을 때 qa_defect 가 이어받는 실패 장면
import test from "node:test";
import assert from "node:assert/strict";
import { deriveQaDefect } from "../server/qa-session.js";
import { qaCharter, qaPlan, qaRowContract } from "./qa-fixtures.mjs";

const defect = { problem: "선택 상자 옵션을 고를 수 없다", oracle: "명세나 대화에서 정한 내용", oracleNote: "옵션을 고르면 값이 바뀌어야 한다",
  importance: "운영자가 분류를 바꿀 수 없다", reproducible: "가끔 재현됨", tried: "두 번 눌렀다" };
const rec = (seq, event) => ({ seq, event: { mode: "agent_action", ...event } });
const failedPlay = () => [rec(1, { kind: "run_begin", plan: qaPlan(), charter: qaCharter() }),
  rec(2, { kind: "entry", url: "http://localhost:3002", surface: "web", tab: "web" }),
  rec(3, { kind: "row", action: "declare", rowId: "A3", rowData: { ...qaRowContract(), paths: ["경계"] } }),
  rec(4, { kind: "row", action: "open", rowId: "A3", path: "경계", rowData: {} }),
  rec(5, { kind: "play_step", rowId: "A3", path: "경계", surface: "web" }),
  rec(6, { kind: "reaction", rowId: "A3", path: "경계", surface: "web", expected: { effects: [{ type: "appear", text: "빙수" }] }, pass: false, shot: "shots/6.png" }),
  rec(7, { kind: "play_failure", rowId: "A3", path: "경계", surface: "web", reason: "기대 효과 미관찰" }),
  rec(8, { kind: "row", action: "close", rowId: "A3", path: "경계", rowData: { automatic: true } }),
  rec(9, { kind: "play_result", rowId: "A3", path: "경계", surface: "web", detail: { pass: false } })];

test("qa_play 실패 직후의 결함은 그 항목과 실패 판정을 이어받는다", () => {
  const value = deriveQaDefect(failedPlay(), defect);
  assert.equal(value.rowId, "A3");
  assert.equal(value.failureSeq, 6);
});

test("qa_play 실패 뒤 다른 항목을 진행했으면 열린 항목 없는 결함에 그 실패를 붙이지 않는다", () => {
  const events = [...failedPlay(),
    rec(10, { kind: "row", action: "declare", rowId: "B1", rowData: { ...qaRowContract(), paths: ["정상"] } }),
    rec(11, { kind: "row", action: "open", rowId: "B1", path: "정상", rowData: {} }),
    rec(12, { kind: "action", cmd: "click", rowId: "B1", path: "정상", surface: "web", pass: true }),
    rec(13, { kind: "row", action: "close", rowId: "B1", path: "정상", rowData: {} }),
    rec(14, { kind: "observation", cmd: "defect_context", surface: "web", shot: "shots/current.png" })];
  const value = deriveQaDefect(events, defect);
  assert.equal(value.rowId, undefined);
  assert.equal(value.failureSeq, undefined);
  assert.deepEqual(value.failureSeqs, []);
  assert.equal(value.frames[0].shot, "shots/current.png");
});
