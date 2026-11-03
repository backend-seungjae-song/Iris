// appear 기대가 조작 전부터 맞는 요소 때문에 미관찰일 때의 K1 문구
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { createMobileReaction } = await import("../server/qa-mobile-reaction.js");
const require = createRequire(import.meta.url);
const { createQaReactionCommands } = require("../native/electron/cdp-qa-reaction.cjs");

const el = (label, x, y, type = "StaticText") => ({type, AXLabel:label, frame:{x, y, width:10, height:10}});

test("모바일 appear text 가 조작 전 요소에 이미 포함돼 미관찰이면 K1 에 그 요소를 적는다", async () => {
  let tapped = false;
  const watch = createMobileReaction({before:[el("피자·\n치킨", 10, 10)], expect:{effects:[{type:"appear", text:"치킨", oracle:"기능의 용도"}], within:50},
    action:{command:"tap", args:{x:1, y:1}}, identity:{targetId:"phone"}, interval:5, tailMs:1, operationTimeoutMs:50,
    readTree:async () => tapped ? [el("피자·치킨·버거", 10, 10), el("치킨", 260, 491, "Image")] : [el("피자·\n치킨", 10, 10)],
    capture:async () => ({path:"shot.png"})});
  await watch.initial(); watch.arm(); tapped = true; watch.delivered(true);
  const result = await watch.finish();
  await watch.stop();
  const k1 = result.candidates.find(item => item.code === "K1");
  assert.equal(result.pass, false);
  assert.match(k1.description, /조작 전부터/);
  assert.match(k1.description, /피자·\s*치킨/);
});

test("웹 appear 대상이 조작 전부터 있으면 조작을 보내기 전에 그 요소를 밝혀 거부한다", async () => {
  let clock = 0, id;
  const snapshot = {effects:[{id:"e1", found:true, text:"피자·치킨"}], bodyText:"화면", visibleElements:1, busy:[], broken:[]};
  const send = async method => method === "Page.getFrameTree" ? {frameTree:{frame:{id:"main"}}} : method === "Page.createIsolatedWorld" ? {executionContextId:1}
    : method === "Runtime.evaluate" ? {result:{value:snapshot}} : {};
  const commands = createQaReactionCommands({observation:{subscribeEvents(){}}, screenshot:async () => ({path:"scene.png"}), now:() => clock, sleep:async ms => { clock += ms; }});
  await assert.rejects(commands["qa-reaction-start"](send, {id:1}, {expect:{effects:[{type:"appear", text:"치킨", oracle:"명세"}], within:60}, action:"click", target:{x:1, y:1}}),
    /기대 전제 불성립\(조작 안 보냄\): appear 치킨: 조작 전부터 조건에 맞는 요소 있음\(피자·치킨\)/);
  assert.equal(commands.hasActive(1), false, "거부한 관찰은 남기지 않음");
});

test("모바일 disappear 대상이 조작 전 트리에 없어 미관찰이면 K1 에 그 사실을 적는다", async () => {
  let tapped = false;
  const watch = createMobileReaction({before:[el("전체 삭제", 10, 10, "Button")], expect:{effects:[{type:"disappear", text:"커피", oracle:"기능의 용도"}], within:50},
    action:{command:"tap", args:{x:1, y:1}}, identity:{targetId:"phone"}, interval:5, tailMs:1, operationTimeoutMs:50,
    readTree:async () => tapped ? [el("최근 검색어 없음", 10, 10)] : [el("전체 삭제", 10, 10, "Button")],
    capture:async () => ({path:"shot.png"})});
  await watch.initial(); watch.arm(); tapped = true; watch.delivered(true);
  const result = await watch.finish();
  await watch.stop();
  const k1 = result.candidates.find(item => item.code === "K1");
  assert.equal(result.pass, false);
  assert.match(k1.description, /조작 전 화면에 조건에 맞는 요소 없음/);
});

test("종료가 오지 않은 웹 반응 관찰은 대기 상한 뒤 30초가 지나면 새 관찰 시작 때 정리한다", async () => {
  let clock = 0;
  const snapshot = {effects:[{id:"e1", found:false}], bodyText:"화면", visibleElements:1, busy:[], broken:[]};
  const send = async method => method === "Page.getFrameTree" ? {frameTree:{frame:{id:"main"}}} : method === "Page.createIsolatedWorld" ? {executionContextId:1}
    : method === "Runtime.evaluate" ? {result:{value:snapshot}} : {};
  const commands = createQaReactionCommands({observation:{subscribeEvents(){}}, screenshot:async () => ({path:"scene.png"}), now:() => clock, sleep:async ms => { clock += ms; }});
  const args = {expect:{effects:[{type:"appear", text:"버릴까요", oracle:"명세"}], within:5000}, action:"click", target:{x:1, y:1}};
  await commands["qa-reaction-start"](send, {id:1}, args);
  clock += 5000 + 10000;
  await assert.rejects(commands["qa-reaction-start"](send, {id:1}, args), /끝나지 않은 반응 관찰/);
  clock += 30000;
  const next = await commands["qa-reaction-start"](send, {id:1}, args);
  assert.ok(next.id);
});
