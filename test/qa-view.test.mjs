import test from "node:test";
import assert from "node:assert/strict";
import { qaView } from "../bin/mcp/qa-view.mjs";

const head = "a".repeat(64);
const receipt = (detail, kind = "unexpected") => ({ runId: "qa-1", head, seq: 42, event: { kind, mode: "agent_action", surface: "tab:1", detail, at: 1792325082098 } });

test("영수증은 seq·종류와 입력에 없던 짧은 서버 계산 값만 남긴다", () => {
  const args = { id: "a1-x-c1", class: "문제", cause: "원인", ids: ["a1-x-c2"] };
  const out = qaView({ ok: true, data: receipt({ ...args, members: Array(200).fill("a1-x-c9"), verdict: "문제", status: "판단됨", sourceHash: "b".repeat(64), defectSeq: 7 }) }, args, "unexpected");
  assert.deepEqual(out, { ok: true, data: { seq: 42, kind: "unexpected", detail: { verdict: "문제", status: "판단됨", defectSeq: 7 } } });
  const fix = qaView({ ok: true, data: receipt({ defect: 3, commit: "abc", diff: "x".repeat(3000), affectedRows: ["C3"] }, "fix") }, { defect: 3, commit: "abc" }, "fix");
  assert.deepEqual(fix.data.detail, { affectedRows: ["C3"] });
});

test("조작 결과에서 내부 기록 칸은 빼고 다음 호출에 쓰는 id·seq·사진 경로·판정은 남긴다", () => {
  const candidate = { id: "a5-s-c1", absoluteId: "a5-s-c1", rawId: "s-c1", rawCount: 1, _signature: "[]", catalogKey: head, catalogClass: "무관 반응",
    needsReview: true, text: "반응 없음", description: "반응 없음", at: 1792325081674, atMs: 5049, firstAt: 1, lastAt: 1, periodicityMs: null, sceneSeq: 17 };
  const scene = { id: "s-s1", claim: { kind: "S1", description: "누름" }, caption: "누름", path: "/raw.png", shot: "/qa/17.png", seq: 17,
    captureTarget: { type: "tab", id: 8 }, stability: { stable: false }, signalAt: 1792325076254, capturedAt: 1792325076558 };
  const out = qaView({ ok: true, data: { pass: false, effects: [{ id: "e1", type: "change", observed: false }], candidates: [candidate], scenes: [scene],
    events: [{ kind: "dom", effects: [{ id: "e1", found: true, text: "지금 글", rect: { x: 1 }, signature: "[]" }], snapshot: { bodyText: "긴 본문" }, changes: [] }],
    target: { x: 712.203125, y: 330.15625 }, receipt: receipt({}, "action"), next: "qa_unexpected로 판단" } }, {}, "click");
  assert.deepEqual(out.data.candidates, [{ id: "a5-s-c1", catalogClass: "무관 반응", needsReview: true, text: "반응 없음", atMs: 5049, sceneSeq: 17 }]);
  assert.deepEqual(out.data.scenes, [{ id: "s-s1", claim: { kind: "S1", description: "누름" }, shot: "/qa/17.png", seq: 17 }]);
  assert.deepEqual(out.data.events, [{ kind: "dom", effects: [{ id: "e1", found: true, text: "지금 글" }] }]);
  assert.deepEqual(out.data.target, { x: 712.2, y: 330.2 });
  assert.deepEqual(out.data.receipt, { seq: 42, kind: "action" });
  assert.equal(out.data.next, "qa_unexpected로 판단");
  assert.deepEqual(out.data.effects, [{ id: "e1", type: "change", observed: false }]);
});

test("qa_row는 선언 때 쓴 항목 정의를 되돌리지 않고 경로별 판정만 보낸다", () => {
  const row = { id: "C4", what: "긴 설명", given: "전제", basis: "spec", basisNote: "근거", oracle: "기준", mustNotChange: [{ text: "a" }], consumers: ["x"], rerun: { mode: "setup" },
    risk: ["r"], paths: ["정상", "실패"], state: "open", walked: { 정상: { color: "green", sceneJudgment: "모델이 쓴 판단", frames: [3] }, 실패: { color: "red", automatic: true, sceneJudgment: "자동 실행 중단: 막힘" } } };
  const out = qaView({ ok: true, data: { open: [], gaps: [], row, rowCount: 3, event: receipt({}, "row") } }, { action: "close", id: "C4" }, "row");
  assert.deepEqual(out.data.row, { id: "C4", basis: "spec", paths: ["정상", "실패"], state: "open", walked: { 정상: { color: "green", frames: [3] }, 실패: { color: "red", automatic: true, sceneJudgment: "자동 실행 중단: 막힘" } } });
  assert.deepEqual(out.data.event, { seq: 42, kind: "row" });
});

test("수정 목록 요약은 qa_play 결과에만 하고 조회 명령은 그대로 둔다", () => {
  const defects = Array.from({ length: 8 }, (_, i) => ({ seq: i, status: i < 6 ? "수정 미확인" : "수정 확인", waiting: i < 6 ? ["qa_fix 기록 없음"] : [] }));
  const play = qaView({ ok: true, data: { steps: [], remediation: { defects, confirmed: 2 } } }, {}, "play");
  assert.deepEqual(play.data.remediation, { confirmed: 2, defectCount: 8, byStatus: { "수정 미확인": 6, "수정 확인": 2 }, waiting: defects.slice(0, 5), more: "나머지는 qa_list_review remediation" });
  const list = qaView({ ok: true, data: { remediation: { defects, confirmed: 2 } } }, {}, "list_review");
  assert.equal(list.data.remediation.defects.length, 8);
});

test("실패 결과와 오류 문구는 바꾸지 않는다", () => {
  const failed = { ok: false, error: "args.expect: 필수 인자", data: { head, seq: 1 } };
  assert.equal(qaView(failed, {}, "click"), failed);
});

test("반응 목록 항목은 맞은 반응 ID·회차 목록을 개수로 바꾸고 고칠 때 쓰는 key는 남긴다", () => {
  const item = { id: "a1", class: "무관 반응", key: head, ids: ["a1", "a2", "a3"], runs: ["qa-1", "qa-2"], firstRun: "qa-1", lastRun: "qa-2", firstPhoto: "/1.png", photo: "/2.png", sourceHash: head, cause: "원인" };
  const out = qaView({ ok: true, data: { app: "repo", items: [item] } }, { repo: "/r" }, "catalog");
  assert.deepEqual(out.data.items, [{ id: "a1", class: "무관 반응", key: head, lastRun: "qa-2", photo: "/2.png", cause: "원인", idCount: 3, runCount: 2 }]);
});
