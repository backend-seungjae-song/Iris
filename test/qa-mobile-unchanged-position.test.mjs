// 앱 화면 unchanged 기대: 내용이 그대로면 위치가 조금 움직여도 유지로 판정(qa-92771d8c W3a 13396)
import test from "node:test";
import assert from "node:assert/strict";
const { createMobileReaction } = await import("../server/qa-mobile-reaction.js");

const el = (type, label, y, value) => ({type, AXLabel:label, ...(value != null ? {AXValue:value} : {}), frame:{x:10, y, width:100, height:20}});

async function run(after) {
  let tapped = false;
  const before = [el("StaticText", "6건의 상품", 100), el("CheckBox", "찜하기", 200)];
  const watch = createMobileReaction({before, expect:{effects:[{type:"disappear", role:"CheckBox", name:"찜하기", oracle:"명세나 대화에서 정한 내용"},
    {type:"unchanged", role:"StaticText", name:"6건의 상품", oracle:"명세나 대화에서 정한 내용"}], within:60},
    action:{command:"tap", args:{x:1, y:1}}, identity:{targetId:"phone"}, interval:5, tailMs:1, operationTimeoutMs:50,
    readTree:async () => tapped ? after : before, capture:async () => ({path:"shot.png"})});
  await watch.initial(); watch.arm(); tapped = true; watch.delivered(true);
  const result = await watch.finish(); await watch.stop();
  return result;
}

test("앱 unchanged 대상이 조작 뒤 위치만 조금 움직이면 유지로 판정한다", async () => {
  const result = await run([el("StaticText", "6건의 상품", 101)]);
  assert.equal(result.effects.find(e => e.expected.type === "unchanged").observed, true);
  assert.equal(result.pass, true);
});

test("앱 unchanged 대상의 글자가 바뀌면 유지가 아니다", async () => {
  const result = await run([el("StaticText", "5건의 상품", 100)]);
  assert.equal(result.effects.find(e => e.expected.type === "unchanged").observed, false);
});

test("앱 unchanged 대상이 관찰 중 잠깐 사라지면 그 순간을 실패 이유에 적는다", async () => {
  let reads = 0, tapped = false;
  const before = [el("Button", "검색", 50), el("CheckBox", "찜하기", 200)];
  const watch = createMobileReaction({before, expect:{effects:[{type:"unchanged", role:"Button", name:"검색", oracle:"명세나 대화에서 정한 내용"}], within:60},
    action:{command:"swipe", args:{}}, identity:{targetId:"phone"}, interval:5, tailMs:1, operationTimeoutMs:50,
    readTree:async () => !tapped ? before : ++reads === 1 ? [el("ProgressIndicator", "로딩", 10)] : before, capture:async () => ({path:"shot.png"})});
  await watch.initial(); watch.arm(); tapped = true; watch.delivered(true);
  const result = await watch.finish(); await watch.stop();
  assert.match(result.candidates.find(c => c.code === "K1").description, /관찰 중 \d+ms에 대상 사라짐/);
});
