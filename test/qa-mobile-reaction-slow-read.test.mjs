// 한 번 조회가 꼬리 시간보다 긴 기기(iOS idb)에서 반응 관찰의 오류 종료 여부
import test from "node:test";
import assert from "node:assert/strict";
const { createMobileReaction } = await import(process.env.IRIS_MOBILE_REACTION_MODULE || "../server/qa-mobile-reaction.js");

const oracle = "기능의 용도";
const el = (label) => ({type:"StaticText", AXLabel:label, resourceId:label, frame:{x:1,y:1,width:10,height:10}});
const realSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run(effects, trees) {
  let clock = 0;
  const watch = createMobileReaction({before:[el("Ready")], expect:{effects:effects.map(e => ({oracle,...e})), within:100},
    action:{command:"tap",args:{x:1,y:1}}, identity:{targetId:"phone"}, now:()=>clock, wait:async ms => { clock += ms; },
    interval:10, tailMs:20, operationTimeoutMs:50,
    // 실제 조회 시간 40ms, 꼬리 시간 20ms. 가짜 시계는 조회 한 번에 30 진행
    readTree:async () => { await realSleep(40); clock += 30; return trees(); },
    capture:async () => ({path:"shot.png"})});
  await watch.initial(); watch.arm(); watch.delivered(true);
  return watch.finish();
}

test("appear observed, then a slow read in the short tail ends without an error", async () => {
  const result = await run([{type:"appear",text:"Saved"}], () => [el("Saved")]);
  assert.equal(result.error ?? null, null);
  assert.equal(result.pass, true);
});

test("none waits to the deadline with slow reads and still passes", async () => {
  const result = await run([{type:"none"}], () => [el("Ready")]);
  assert.equal(result.error ?? null, null);
  assert.equal(result.pass, true);
});

test("missing effect with slow reads is a normal failure, not a timeout error", async () => {
  const result = await run([{type:"appear",text:"Saved"}], () => [el("Ready")]);
  assert.equal(result.error ?? null, null);
  assert.equal(result.pass, false);
});
