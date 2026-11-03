// 웹 진입 주소와 앱 기기를 함께 쓰는 회차의 보고서 검사(qa-427cb182 보고서 거부 사례)
import { qaPlan, qaRowContract } from "./qa-fixtures.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { checkQaReport } from "../server/qa-report.js";

const charter = {
  question: "사용자가 상점 탭에서 상품을 고를 수 있는가", scope: "상점 화면", exclusions: "없음",
  environment: "격리한 로컬 데이터", sharedEnvironment: false, timebox: "10분", people: "없음", documents: "상점 기획서",
};
const sessionRecord = {
  work: "상점 확인", defects: "없음", curios: "없음", checked: "상점 탭", unverified: { items: "없음", reason: "해당 없음" },
  blockers: "없음", outOfScope: "없음", risks: "없음", stopCriterion: "questions_answered", remainingQuestions: "없음",
};
const D = "76EDA0E3-F8CC-47FC-8267-EF94ED5F2811", url = "app://" + D;
const lane = { rowId: "shop", path: "정상", lanes: [["shop", "정상"]] };
const expected = { effects: [{ type: "appear", text: "상점", oracle: "명세나 대화에서 정한 내용", id: "e1" }], within: 1200 };

// 조작 하나: 접수 → S1 → (결과 장면) → action → reaction. 장부 순번으로 acceptedSeq 를 잇는다
function tap(events, { pass = true, scope = lane, failureScene = false, interrupted = false } = {}) {
  const at = events.length + 1;
  events.push({ kind: "accepted", cmd: "app_tap", ...scope, surface: D, expected });
  events.push({ kind: "frame", claim: { kind: "S1" }, ...scope, acceptedSeq: at, shot: `shots/${at}-s1.png`, url, surface: D });
  if (interrupted) return;
  if (pass) events.push({ kind: "frame", claim: { kind: "S2" }, ...scope, acceptedSeq: at, shot: `shots/${at}-s2.png`, url, surface: D });
  events.push({ kind: "action", cmd: "app_tap", ...scope, acceptedSeq: at, surface: D, pass, ...(pass ? {} : { reason: "모바일 접근성 조회 시간 초과" }) });
  const actionSeq = events.length;
  events.push({ kind: "reaction", cmd: "app_tap", ...scope, acceptedSeq: at, surface: D, pass });
  if (failureScene) events.push({ kind: "failure", ...scope, shot: `shots/${actionSeq}-fail.png`, url, surface: D, claim: { kind: "S3" }, detail: { failureSeq: actionSeq } });
}
function build(body, { color = "green" } = {}) {
  const events = [
    { kind: "run_begin", charter, plan: qaPlan({ entries: ["http://localhost:3002/shop-categories"], surfaces: ["http://localhost:3002/"] }) },
    { kind: "row", action: "declare", rowId: "shop", rowData: { ...qaRowContract(), id: "shop", what: "상점 탭 표시", given: "홈 화면의 사용자", basis: "spec", basisNote: "상점 기획서", paths: ["정상"] } },
    { kind: "accepted", cmd: "app_target" },
    { kind: "observation", cmd: "app_target", acceptedSeq: 3, url, surface: D, pass: true },
    { kind: "observation", cmd: "app_snapshot", surface: D, pass: true },
  ];
  body(events);
  events.push({ kind: "row", action: "close", ...lane, rowData: { color, sceneJudgment: "화면 전체에 추가 이상이 보이지 않았다.", note: "상점 탭 표시", frames: 2, receipts: 1, failed: 0 } });
  events.push({ kind: "run_end", sessionRecord });
  return events.map((event, index) => ({ seq: index + 1, event: structuredClone(event) }));
}
const open = events => events.push({ kind: "row", action: "open", ...lane, rowData: {} });

test("웹 진입 주소가 있는 회차에서 app_target 으로 연결한 기기 화면의 판정을 받는다", () => {
  assert.doesNotThrow(() => checkQaReport(build(events => { open(events); tap(events); })));
});

test("모바일 조작은 반응 관찰이 화면을 읽으므로 연속 탭 사이에 따로 관찰하지 않아도 된다", () => {
  assert.doesNotThrow(() => checkQaReport(build(events => { open(events); tap(events); tap(events); })));
});

test("결과 장면 전에 실패한 조작은 실패 기록의 화면을 결과 장면으로 쓰고, 무효 처리한 실패는 통과 항목을 막지 않는다", () => {
  const events = build(events => {
    open(events);
    tap(events, { pass: false, failureScene: true });
    const reaction = events.findLastIndex(e => e.kind === "reaction") + 1;
    events.push({ kind: "row", action: "void", ...lane, rowData: { receipt: reaction, why: "도구의 접근성 조회 시간 초과" } });
    tap(events);
  });
  assert.doesNotThrow(() => checkQaReport(events));
});

test("무효 처리하지 않은 실패가 있으면 통과 항목을 여전히 거부한다", () => {
  const events = build(events => { open(events); tap(events, { pass: false, failureScene: true }); tap(events); });
  assert.throws(() => checkQaReport(events), /^Error: \[execution\]|\[P1c\]/);
});

test("항목을 열기 전 준비 단계 조작의 반응은 항목 판정이 아니다", () => {
  const prep = { mode: "preparation", lanes: [] };
  const events = build(events => { tap(events, { pass: false, scope: prep, failureScene: true }); open(events); tap(events); });
  assert.doesNotThrow(() => checkQaReport(events));
});

test("중간에 끊긴 실행은 판정이 없을 뿐이고, 마지막 실행이 끊긴 회차는 거부한다", () => {
  assert.doesNotThrow(() => checkQaReport(build(events => { open(events); tap(events, { interrupted: true }); tap(events); })));
  assert.throws(() => checkQaReport(build(events => { open(events); tap(events); tap(events, { interrupted: true }); })), /\[execution\]/);
});

test("기기를 다시 연결한 직후의 모바일 조작은 그 조작의 S1 장면을 조작 전 관찰로 쓴다", () => {
  const events = build(events => {
    open(events);
    events.push({ kind: "accepted", cmd: "app_target" });
    events.push({ kind: "observation", cmd: "app_target", acceptedSeq: events.length, url, surface: D, pass: true });
    tap(events);
  });
  assert.doesNotThrow(() => checkQaReport(events));
});

test("확인 창이 떠 있어 반응 관찰 없이 답한 qa_dialog 는 창 기록을 조작 전 관찰로 받고 뒤따르는 관찰을 요구한다", () => {
  // 멈춘 페이지의 증거(dialogBlocked·dialog_open)가 없는 qa_dialog 는 장면이 필요함
  const dialog = (events, { blocked = true, after = true } = {}) => {
    const at = events.length + 1;
    events.push({ kind: "accepted", cmd: "dialog", ...lane, surface: D, expected });
    if (blocked) events.push({ kind: "observation", cmd: "dialog_open", ...lane, surface: D, acceptedSeq: at, pass: true, detail: { kind: "confirm", message: "고치던 내용을 버릴까요?" } });
    events.push({ kind: "action", cmd: "dialog", ...lane, surface: D, acceptedSeq: at, pass: true, ...(blocked ? { dialogBlocked: true } : {}) });
    if (after) events.push({ kind: "observation", cmd: "app_snapshot", surface: D, pass: true });
    events.push({ kind: "assertion", ...lane, surface: D, url, pass: true, shot: `shots/${events.length + 1}-expect.png`, expected: { mode: "absent", text: "고치던 내용을 버릴까요?" } });
  };
  assert.doesNotThrow(() => checkQaReport(build(events => { open(events); tap(events); dialog(events); })));
  assert.throws(() => checkQaReport(build(events => { open(events); tap(events); dialog(events, { blocked: false }); })), /\[P3\]/);
  assert.throws(() => checkQaReport(build(events => { open(events); tap(events); dialog(events, { after: false }); })), /\[L\]/);
});
