// 판정이 끝난 반응의 대기 관찰 조회 실패와 다음 조작
import test from "node:test";
import assert from "node:assert/strict";
const { createMobileReaction } = await import("../server/qa-mobile-reaction.js");

const oracle = "기능의 용도";
const el = (label) => ({type:"StaticText", AXLabel:label, resourceId:label, frame:{x:1,y:1,width:10,height:10}});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test("대기 관찰 중 한 번 실패한 조회는 다음 drain을 오류로 만들지 않고 idleError로 남긴다", async () => {
  let reads = 0, failing = false;
  const watch = createMobileReaction({before:[el("Ready")], expect:{effects:[{type:"appear", text:"Saved", oracle}], within:200},
    action:{command:"tap", args:{x:1, y:1}}, identity:{targetId:"phone"}, interval:5, tailMs:1, operationTimeoutMs:50, retainIdle:true,
    readTree:async () => { reads++; if (failing) { failing = false; throw new Error("모바일 접근성 조회 시간 초과"); } return [el("Saved")]; },
    capture:async () => ({path:"shot.png"})});
  await watch.initial(); watch.arm(); watch.delivered(true);
  const finished = await watch.finish();
  assert.equal(finished.pass, true);
  failing = true;
  const before = reads;
  for (let i = 0; i < 100 && reads < before + 3; i++) await sleep(5);
  const drained = await watch.drain();
  await watch.stop();
  assert.equal(drained.error ?? null, null);
  assert.match(drained.idleError, /시간 초과/);
});

test("drain 자신의 조회 실패도 오류가 아니라 idleError로 돌려준다", async () => {
  let failing = false;
  const watch = createMobileReaction({before:[el("Ready")], expect:{effects:[{type:"appear", text:"Saved", oracle}], within:200},
    action:{command:"tap", args:{x:1, y:1}}, identity:{targetId:"phone"}, interval:1000, tailMs:1, operationTimeoutMs:50, retainIdle:true,
    readTree:async () => { if (failing) throw new Error("모바일 접근성 조회 시간 초과"); return [el("Saved")]; },
    capture:async () => ({path:"shot.png"})});
  await watch.initial(); watch.arm(); watch.delivered(true);
  await watch.finish();
  failing = true;
  const drained = await watch.drain();
  failing = false;
  const again = await watch.drain();
  await watch.stop();
  assert.equal(drained.error ?? null, null);
  assert.match(drained.idleError, /시간 초과/);
  assert.equal(again.error ?? null, null);
});
