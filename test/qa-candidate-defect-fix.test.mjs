// 반응 후보(접근성 등)에서 나온 결함의 수정 기록과 재확인(qa-92771d8c 하트 스위치 결함)
import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./qa-fix5.test.mjs";
import { deriveQaRemediation, qaCandidateFailure } from "../server/qa-remediation.js";

const heart = { id: "a40-heart", code: "K10", sel: "heart-toggle", text: "", description: "이름 없는 Switch" };

async function candidateDefect(f) {
  const reaction = await f.ledger.append("source", { kind: "reaction", mode: "agent_action", rowId: "save", pass: true, acceptedSeq: 3,
    expected: { effects: [{ type: "appear", text: "찜", oracle: "기능의 용도" }] }, detail: { candidates: [heart], unexpected: [] } });
  const defect = await f.ledger.append("source", { kind: "defect", mode: "agent_action", detail: { problem: "하트가 사용할 수 없는 스위치로 읽힘" } });
  await f.ledger.append("source", { kind: "unexpected_defect", detail: { id: heart.id, defectSeq: defect.seq } });
  return { reaction, defect };
}

test("반응 후보에서 나온 결함은 후보가 기록된 반응 seq 로 qa_fix 를 기록한다", async t => {
  const f = await fixture(t), { reaction, defect } = await candidateDefect(f);
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["-C", f.repo, "checkout", "-b", "fix/heart"]); const hash = f.commit("heart");
  await assert.rejects(f.fix({ defect: defect.seq, failureSeq: f.failure.seq, commit: hash }), new RegExp(`실패 근거는 seq ${reaction.seq}입니다\\(반응 후보`));
  const receipt = await f.fix({ defect: defect.seq, failureSeq: reaction.seq, commit: hash });
  assert.equal(receipt.event.detail.failureSeq, reaction.seq);
});

test("failureSeq 를 빼면 결함 기록의 실패 근거로 채운다", async t => {
  const f = await fixture(t), { reaction, defect } = await candidateDefect(f);
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["-C", f.repo, "checkout", "-b", "fix/heart"]); const hash = f.commit("heart");
  const receipt = await f.fix({ defect: defect.seq, failureSeq: undefined, commit: hash });
  assert.equal(receipt.event.detail.failureSeq, reaction.seq);
});

test("재확인 구간에 같은 후보가 다시 기록되면 수정 미확인, 없으면 수정 확인", () => {
  const base = [
    { seq: 1, event: { kind: "reaction", rowId: "W1", detail: { candidates: [heart] } } },
    { seq: 2, event: { kind: "defect", detail: { problem: "하트" } } },
    { seq: 3, event: { kind: "unexpected_defect", detail: { id: heart.id, defectSeq: 2 } } },
    { seq: 4, event: { kind: "fix", detail: { defect: 2, failureSeq: 1, commit: "abc", affectedRows: [] } } },
  ];
  assert.equal(qaCandidateFailure(base, 2).seq, 1);
  const retest = (candidates) => [...base,
    { seq: 5, event: { kind: "reaction", rowId: "W1", detail: { candidates } } },
    { seq: 6, event: { kind: "play_result", rowId: "W1", detail: { pass: true, startSeq: 4, retestOf: { defect: 2 }, retestFix: { seq: 4 }, steps: [] } } }];
  assert.equal(deriveQaRemediation(retest([])).defects[0].status, "수정 확인");
  const again = deriveQaRemediation(retest([{ ...heart, id: "a5-heart" }])).defects[0];
  assert.equal(again.status, "수정 미확인");
  assert.match(again.waiting.join(" "), /같은 반응 후보\(K10\)/);
});
