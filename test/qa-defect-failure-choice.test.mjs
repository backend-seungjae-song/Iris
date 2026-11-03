// qa_defect 가 연결할 실패 판정을 고르거나 연결하지 않는 경우(qa-92771d8c 결함 3841·4049 가 관계없는 실패에 묶인 사례)
import test from "node:test";
import assert from "node:assert/strict";
import { deriveQaDefect } from "../server/qa-session.js";
import { applyQaFix } from "../server/qa-fix.js";
import { deriveQaRemediation, assertQaReplayContract } from "../server/qa-remediation.js";
import { fixture } from "./qa-fix5.test.mjs";
import { qaCharter, qaPlan, qaRowContract } from "./qa-fixtures.mjs";

const defect = { problem: "교환 내역 응답에 받는번호가 새로 실림", oracle: "명세나 대화에서 정한 내용", oracleNote: "기존 앱 응답은 바뀌면 안 됨",
  importance: "기존 앱 사용자 응답 변경", reproducible: "가끔 재현됨", tried: "develop 서버와 응답 비교" };
const rec = (seq, event) => ({ seq, event: { mode: "agent_action", ...event } });
const events = () => [rec(1, { kind: "run_begin", plan: qaPlan(), charter: qaCharter() }),
  rec(2, { kind: "entry", url: "http://localhost:3002", surface: "web", tab: "web" }),
  rec(3, { kind: "row", action: "declare", rowId: "O1", rowData: { ...qaRowContract(), paths: ["정상"] } }),
  rec(4, { kind: "row", action: "open", rowId: "O1", path: "정상", rowData: {} }),
  rec(5, { kind: "reaction", rowId: "O1", path: "정상", surface: "web", expected: { effects: [{ type: "appear", text: "닫힘" }] }, pass: false, shot: "shots/5.png" }),
  rec(6, { kind: "assertion", rowId: "O1", path: "정상", surface: "web", expected: { mode: "exists", sel: "#list" }, pass: false, shot: "shots/6.png" })];

test("noFailure 결함은 실패 판정을 붙이지 않고, failureSeq 로 고른 판정을 붙인다", () => {
  assert.equal(deriveQaDefect(events(), defect).failureSeq, 6);
  const unbound = deriveQaDefect(events(), { ...defect, noFailure: true });
  assert.equal(unbound.failureSeq, undefined);
  assert.deepEqual(unbound.failureSeqs, []);
  assert.equal(deriveQaDefect(events(), { ...defect, failureSeq: 5 }).failureSeq, 5);
  assert.throws(() => deriveQaDefect(events(), { ...defect, failureSeq: 4 }), /실패 판정/);
  assert.throws(() => deriveQaDefect(events(), { ...defect, failureSeq: 5, noFailure: true }), /함께/);
});

test("noFailure 결함은 failureSeq 없이 qa_fix 를 기록하고 재실행 통과로 수정 확인한다", async t => {
  const f = await fixture(t), { execFileSync } = await import("node:child_process");
  const d = await f.ledger.append("source", { kind: "defect", mode: "agent_action", detail: { problem: "응답 변경", noFailure: true } });
  execFileSync("git", ["-C", f.repo, "checkout", "-b", "fix/response"]); const hash = f.commit("response");
  await assert.rejects(f.fix({ defect: d.seq, failureSeq: f.failure.seq, commit: hash }), /failureSeq 없이/);
  const receipt = await applyQaFix({ ledger: f.ledger, runId: "source", args: { defect: d.seq, commit: hash, summary: "응답에서 받는번호 제외", diagnosis: { source: "value.txt:1", reason: "응답에 필드 추가" } } });
  assert.equal(receipt.event.detail.failureSeq, undefined);
  const list = [rec(1, { kind: "defect", detail: { problem: "응답 변경", noFailure: true } }), rec(2, { kind: "fix", detail: { defect: 1, commit: "abc", affectedRows: [] } })];
  assert.doesNotThrow(() => assertQaReplayContract(list, "O1", [{ action: "click", target: { text: "교환 내역" }, expect: { effects: [{ type: "appear", text: "교환 내역", oracle: "기능의 용도" }] } }], { fixSeq: 2, defect: 1 }));
  const passed = [...list, rec(3, { kind: "play_result", rowId: "O1", detail: { pass: true, startSeq: 2, retestOf: { defect: 1 }, retestFix: { seq: 2 }, steps: [] } })];
  assert.equal(deriveQaRemediation(passed).defects[0].status, "수정 확인");
});

test("수정으로 대상 이름만 바뀐 재실행은 받고, 조작·기대값이 다르면 다른 곳을 알려 거부한다", () => {
  const expect = { effects: [{ type: "appear", text: "준비 중인 브랜드가 없어요", oracle: "명세나 대화에서 정한 내용" }], within: 5000 };
  const old = [{ action: "app_tap", target: { role: "Button", name: "백화점\n백화점" }, expect }];
  const list = [
    { seq: 1, event: { kind: "play_result", rowId: "M2", path: "경계", detail: { pass: true, steps: old } } },
    { seq: 2, event: { kind: "fix", detail: { defect: 9, commit: "abc", affectedRows: ["M2"] } } },
  ];
  assert.doesNotThrow(() => assertQaReplayContract(list, "M2", [{ ...old[0], target: { role: "Button", name: "백화점" } }], { fixSeq: 2, path: "경계" }));
  assert.throws(() => assertQaReplayContract(list, "M2", [{ ...old[0], target: { role: "Button", name: "백화점" }, action: "app_swipe" }], { fixSeq: 2, path: "경계" }), /1번째 단계의 action/);
});

test("판정을 무효 처리한 실행은 영향 항목 재실행의 기준으로 삼지 않는다", () => {
  const expect = { effects: [{ type: "disappear", text: "상품 교환", oracle: "명세나 대화에서 정한 내용" }], within: 5000 };
  const steps = [{ action: "app_tap", target: { role: "Button", name: "교환하기" }, expect }];
  const list = [
    { seq: 1, event: { kind: "observation", rowId: "E2", path: "정상" } },
    { seq: 2, event: { kind: "reaction", rowId: "E2", path: "정상", pass: false } },
    { seq: 3, event: { kind: "play_result", rowId: "E2", path: "정상", detail: { pass: false, startSeq: 1, steps } } },
    { seq: 4, event: { kind: "row", action: "void", rowData: { receipt: "2", why: "팝업에 가려 관찰할 수 없는 기대" } } },
    { seq: 5, event: { kind: "fix", detail: { defect: 9, commit: "abc", affectedRows: ["E2"] } } },
  ];
  const changed = [{ ...steps[0], expect: { effects: [{ type: "appear", text: "교환 완료", oracle: "명세나 대화에서 정한 내용" }], within: 5000 } }];
  assert.doesNotThrow(() => assertQaReplayContract(list, "E2", changed, { fixSeq: 5, path: "정상" }));
  assert.throws(() => assertQaReplayContract(list.filter(r => r.seq !== 4).map(r => r.seq === 3 ? { ...r, event: { ...r.event, detail: { ...r.event.detail, pass: true } } } : r), "E2", changed, { fixSeq: 5, path: "정상" }), /같은 조작·기대값/);
});

test("실패한 실행은 영향 항목 재실행의 기준이 아니고, 그 앞의 통과한 실행이 기준이다", () => {
  const popup = [{ action: "app_tap", target: { text: "교환하기" }, expect: { effects: [{ type: "appear", text: "포인트가 부족해요", oracle: "명세나 대화에서 정한 내용" }], within: 5000 } }];
  const leave = [{ action: "app_tap", target: { text: "포인트 모으러가기" }, expect: { effects: [{ type: "disappear", text: "상품 교환", oracle: "명세나 대화에서 정한 내용" }], within: 6000 } }];
  const list = [
    { seq: 1, event: { kind: "play_result", rowId: "E2", path: "정상", detail: { pass: true, startSeq: 0, steps: popup } } },
    { seq: 3, event: { kind: "play_result", rowId: "E2", path: "정상", detail: { pass: false, startSeq: 2, steps: leave } } },
    { seq: 5, event: { kind: "fix", detail: { defect: 9, commit: "abc", affectedRows: ["E2"] } } },
  ];
  assert.doesNotThrow(() => assertQaReplayContract(list, "E2", popup, { fixSeq: 5, path: "정상" }));
  assert.throws(() => assertQaReplayContract(list, "E2", leave, { fixSeq: 5, path: "정상" }), /seq 1/);
});

test("영향 항목 재실행은 기대값 안의 요소 이름(role·name)이 바뀐 것도 받고, 확인할 글자가 바뀌면 거부한다", () => {
  const step = { action: "app_tap", target: { role: "Button", name: "편의점\n편의점" },
    expect: { effects: [{ type: "appear", role: "Button", name: "상품권\n상품권", oracle: "명세나 대화에서 정한 내용" }, { type: "appear", text: "준비 중", oracle: "명세나 대화에서 정한 내용" }], within: 5000 } };
  const list = [
    { seq: 1, event: { kind: "play_result", rowId: "C6a", path: "정상", detail: { pass: true, steps: [step] } } },
    { seq: 2, event: { kind: "fix", detail: { defect: 9, commit: "abc", affectedRows: ["C6a"] } } },
  ];
  const renamed = { ...step, target: { role: "Button", name: "편의점" }, expect: { ...step.expect, effects: [{ ...step.expect.effects[0], name: "상품권" }, step.expect.effects[1]] } };
  assert.doesNotThrow(() => assertQaReplayContract(list, "C6a", [renamed], { fixSeq: 2, path: "정상" }));
  const textChanged = { ...renamed, expect: { ...renamed.expect, effects: [renamed.expect.effects[0], { ...step.expect.effects[1], text: "다른 글자" }] } };
  assert.throws(() => assertQaReplayContract(list, "C6a", [textChanged], { fixSeq: 2, path: "정상" }), /1번째 단계의 expect/);
});

test("failureSeq 로 고른 앞선 실패는 그 실패 시점의 항목·진입·조작·장면으로 재현 절차를 만든다", () => {
  // qa-6face637 결함 1224: K2 실패 248 을 골랐는데 나중 항목 C5 의 진입 936 과 장면 1223 이 붙음
  const list = [...events().slice(0, 2),
    rec(3, { kind: "row", action: "declare", rowId: "K2", rowData: { ...qaRowContract(), paths: ["정상"] } }),
    rec(4, { kind: "row", action: "open", rowId: "K2", path: "정상", rowData: {} }),
    rec(5, { kind: "action", cmd: "click", rowId: "K2", path: "정상", surface: "web", target: { text: "삭제" }, pass: true, acceptedSeq: 5 }),
    rec(6, { kind: "frame", rowId: "K2", path: "정상", surface: "web", acceptedSeq: 5, shot: "shots/6.png" }),
    rec(7, { kind: "reaction", rowId: "K2", path: "정상", surface: "web", acceptedSeq: 5, expected: { effects: [{ type: "disappear", text: "카테고리" }] }, pass: false }),
    rec(8, { kind: "failure", rowId: "K2", path: "정상", surface: "web", detail: { failureSeq: 7 }, shot: "shots/8.png" }),
    rec(9, { kind: "row", action: "close", rowId: "K2", path: "정상", rowData: { color: "orange" } }),
    rec(10, { kind: "row", action: "declare", rowId: "C5", rowData: { ...qaRowContract(), paths: ["경계"] } }),
    rec(11, { kind: "entry", url: "http://localhost:3002/mysticbox-products", surface: "web", tab: "web" }),
    rec(12, { kind: "row", action: "open", rowId: "C5", path: "경계", rowData: {} }),
    rec(13, { kind: "action", cmd: "click", rowId: "C5", path: "경계", surface: "web", target: { text: "저장" }, pass: true, shot: "shots/13.png" }),
    rec(14, { kind: "row", action: "close", rowId: "C5", path: "경계", rowData: { color: "green" } })];
  const value = deriveQaDefect(list, { ...defect, failureSeq: 7 }, { surface: "web" });
  assert.equal(value.rowId, "K2");
  assert.deepEqual(value.steps.map(s => s.seq), [2, 5]);
  assert.deepEqual(value.frames.map(f => f.seq).sort((a, b) => a - b), [6, 8]);
  assert.ok(value.endSeq < 10);
});
