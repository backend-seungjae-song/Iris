// 조작 응답 크기: 화면 전체가 바뀐 조작 하나의 응답이 6만 자가 된 사례(qa-427cb182 seq 5734~5741)
import test from "node:test";
import assert from "node:assert/strict";
import { createMobileReaction } from "../server/qa-mobile-reaction.js";
import { compactReactionResponse } from "../server/qa-reaction.js";

const oracle = "기능의 용도";
const el = (label, i) => ({ type: "StaticText", AXLabel: label, resourceId: `r${i}`, frame: { x: i, y: i, width: 10, height: 10 } });

test("기대 밖 화면 변화 설명은 요소 이름 몇 개로 줄이고 mark label에는 요소 이름 첫 줄만 넣는다", async () => {
  let clock = 0;
  const names = Array.from({ length: 25 }, (_, i) => `카테고리 ${i}\n카테고리 ${i}\n두 번째 줄`);
  const watch = createMobileReaction({ before: [el("찜 목록", 99)], expect: { effects: [{ type: "disappear", text: "찜 목록", oracle }], within: 50 },
    action: { command: "tap", args: { x: 1, y: 1 } }, identity: { targetId: "phone" }, now: () => clock, wait: async ms => { clock += ms; },
    interval: 10, tailMs: 10, operationTimeoutMs: 50, readTree: async () => [el("찜 목록", 99), ...names.map(el)], capture: async () => ({ path: "shot.png" }) });
  await watch.initial(); watch.arm(); watch.delivered(true);
  const result = await watch.finish();
  const item = result.unexpected[0];
  assert.ok(item.description.length <= 300, item.description);
  assert.match(item.description, /외 \d+개/);
  assert.doesNotMatch(item.description, /\n/);
  const scene = result.scenes.find(s => s.id === item.sceneId);
  assert.equal(scene.marks.length, 25);
  assert.deepEqual(scene.marks.slice(0, 2).map(m => m.label), ["카테고리 0", "카테고리 1"]);
});

test("조작 응답에서 알려진 반응은 요약만, 장면은 표시 좌표 없이 준다", () => {
  const long = "보유 포인트 ".repeat(200);
  const response = compactReactionResponse({
    candidates: [{ id: "a1-k1", code: "K1", known: false, description: "기대 효과 미관찰: 찜 목록", text: "찜 목록", sceneSeq: 5 }],
    unexpected: [{ id: "a1-u1", known: true, catalogKey: "home-refresh", catalogClass: "연관 반응", description: long, text: long, count: 3, sceneSeq: 6, action: { kind: "tap" }, _signature: "x" }],
    scenes: [{ id: "s1", seq: 6, shot: "shots/6.png", claim: { kind: "S4", description: "기대 밖 화면 변화" }, marks: Array.from({ length: 25 }, () => ({ label: long, x: 0, y: 0, w: 1, h: 1 })) }],
  });
  assert.deepEqual(response.candidates[0], { id: "a1-k1", code: "K1", known: false, description: "기대 효과 미관찰: 찜 목록", text: "찜 목록", sceneSeq: 5 });
  const known = response.unexpected[0];
  assert.deepEqual(Object.keys(known).sort(), ["catalogClass", "catalogKey", "count", "description", "id", "known", "sceneSeq"]);
  assert.ok(known.description.length <= 120);
  assert.equal(response.scenes[0].marks, undefined);
  assert.equal(response.scenes[0].markCount, 25);
  assert.ok(JSON.stringify(response).length < 1500, JSON.stringify(response).length);
});
