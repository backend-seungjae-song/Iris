// 조작·qa_play 응답 요약: 실제 회차에서 조작 하나 8천 자, qa_play 1.7만 자가 대화에 쌓여 압축이 17분마다 일어난 사례
import test from "node:test";
import assert from "node:assert/strict";
import { briefActionResponse, briefPlayResponse } from "../server/qa-reaction.js";

const long = "상품 교환까지 25,000P 남았어요\n35,000P 모으면 첫 상품권으로 교환할 수 있어요 ".repeat(20);
const scene = (seq, kind) => ({ id: `s${seq}`, seq, shot: `/qa/shots/${seq}.png`, path: `/tmp/${seq}.png`, claim: { kind, description: "장면" },
  device: "76EDA0E3", targetId: "76EDA0E3", tab: "emu-1", url: "http://localhost:3001/admin", viewport: { width: 390, height: 844 },
  captureTarget: { kind: "device" }, stability: { stable: true, frames: 3 }, capturedAt: 1, observedAt: 2, markCount: 25 });
const full = (pass) => ({
  device: "76EDA0E3", targetId: "76EDA0E3", platform: "ios", tab: "emu-1", native: true, inputAccepted: true, reactionId: "r1", backend: "idb", input: { kind: "none" },
  pass, action: { kind: "tap" },
  effects: pass
    ? [{ id: "e1", expected: { type: "appear", text: "전체보기", oracle: "명세" }, observed: true, sceneId: "s100", atMs: 3162, description: "전체보기 나타남", sceneSeq: 100 }]
    : [{ type: "disappear", text: "건강 접근", oracle: "명세", id: "e1", observed: false }],
  candidates: pass ? [] : [{ id: "a19-missing", code: "K1", description: "상한 시간 안에 기대 효과를 확인하지 못함", known: false, _signature: long, sceneSeq: 21 }],
  unexpected: [
    { id: "a97-u1", description: `기대 밖 화면 변화: ${long}`, text: long, _signature: long, known: false, sceneSeq: 99, absoluteId: "a97-u1", rawId: "u1" },
    { id: "a97-u2", known: true, catalogKey: "home-refresh", description: long, count: 3, sceneSeq: 98 },
  ],
  events: Array.from({ length: 50 }, (_, i) => ({ method: "Network.requestWillBeSent", url: `http://localhost/${i}`, initiatorStack: long })),
  firstReactionMs: 674, completedMs: 4253, unavailable: ["K2", "K8"], limits: ["접근성 트리 조회 사이에 나타났다 사라진 변화", "K2 기기 콘솔 미계측"],
  receipt: { runId: "qa-1", head: "d91447", seq: 101, event: { kind: "action", expected: { effects: [{ type: "appear", text: "전체보기" }] }, lanes: [] } },
  scenes: [scene(99, "S4"), scene(100, "S2"), scene(102, "S3")],
  delivered: true, next: "qa_unexpected로 각 반응을 판단하세요.",
  ...(pass ? {} : { ok: false, error: "상한 시간 안에 기대 효과를 확인하지 못함" }),
});

test("통과한 조작 응답은 영수증 번호·효과 요약·미판단 반응 요약만 남긴다", () => {
  const brief = briefActionResponse(full(true));
  assert.equal(brief.pass, true);
  assert.equal(brief.receipt, 101);
  assert.deepEqual(brief.effects, [{ id: "e1", type: "appear", text: "전체보기", observed: true, description: "전체보기 나타남", sceneSeq: 100, shot: "/qa/shots/100.png" }]);
  assert.equal(brief.reactions.pending, 1);
  assert.equal(brief.reactions.items[0].id, "a97-u1");
  assert.equal(brief.reactions.items[0].sceneSeq, 99);
  assert.ok(brief.reactions.items[0].description.length <= 160);
  assert.doesNotMatch(brief.reactions.items[0].description, /\n/);
  assert.equal(brief.knownReactions, 1);
  assert.equal(brief.next, "qa_unexpected로 각 반응을 판단하세요.");
  for (const key of ["scenes", "events", "limits", "unavailable", "candidates", "unexpected", "device", "backend"]) assert.equal(brief[key], undefined, key);
  assert.equal(brief.shot, undefined, "통과한 조작에는 실패 장면이 없음");
  assert.ok(JSON.stringify(brief).length < 800, JSON.stringify(brief).length);
});

test("실패한 조작 응답은 실패 장면 사진 경로와 오류·실패 반응을 남긴다", () => {
  const brief = briefActionResponse(full(false));
  assert.equal(brief.pass, false);
  assert.equal(brief.ok, false);
  assert.equal(brief.error, "상한 시간 안에 기대 효과를 확인하지 못함");
  assert.equal(brief.shot, "/qa/shots/102.png");
  assert.deepEqual(brief.effects, [{ id: "e1", type: "disappear", text: "건강 접근", observed: false }]);
  assert.deepEqual(brief.reactions.items.map(item => item.code ?? null), ["K1", null]);
  assert.equal(brief.reactions.pending, 2);
});

test("효과 배열이 없는 응답은 그대로 둔다", () => {
  const humanRequired = { humanRequired: true, reason: "결제 확인" };
  assert.equal(briefActionResponse(humanRequired), humanRequired);
  assert.equal(briefActionResponse(null), null);
});

test("qa_play 응답은 통과 단계에 영수증·효과만, 실패 단계에 요약을, 결함은 상태·대기 사유별 번호로 묶는다", () => {
  const passed = { index: 0, status: "통과", ...full(true), effects: [{ id: "catalog-header", expected: { type: "change", sel: "#header", needsReview: true }, observed: true }] };
  const failed = { index: 1, status: "실패", ...full(false), reason: "기대 효과 미관찰" };
  const brief = briefPlayResponse({ pass: false, status: "실패", steps: [passed, failed, { index: 2, status: "미실행" }],
    remediation: { defects: [
      { seq: 10, status: "수정 미확인", waiting: ["qa_fix 기록 없음"], reason: long },
      { seq: 11, status: "수정 미확인", waiting: ["qa_fix 기록 없음"] },
      { seq: 12, status: "사람 확인", fixSeq: 30, reason: long },
    ], confirmed: 4, pendingRows: [{ row: "C3", afterSeq: 40, reason: long }], detail: "전체 기록은 qa_review" } });
  assert.deepEqual(brief.steps[0], { index: 0, status: "통과", receipt: 101,
    effects: [{ id: "catalog-header", type: "change", sel: "#header", observed: true, needsReview: true }], reactions: brief.steps[0].reactions, knownReactions: 1 });
  assert.equal(brief.steps[1].status, "실패");
  assert.equal(brief.steps[1].reason, "기대 효과 미관찰");
  assert.equal(brief.steps[1].shot, "/qa/shots/102.png");
  assert.equal(brief.steps[1].scenes, undefined);
  assert.deepEqual(brief.steps[2], { index: 2, status: "미실행" });
  assert.deepEqual(brief.remediation.defects, [
    { status: "수정 미확인", waiting: ["qa_fix 기록 없음"], waitingCount: 1, seqs: [10, 11] },
    { status: "사람 확인", seqs: [12] },
  ]);
  assert.equal(brief.remediation.confirmed, 4);
  assert.ok(brief.remediation.pendingRows[0].reason.length <= 100);
  assert.ok(JSON.stringify(brief).length < 2000, JSON.stringify(brief).length);
});
