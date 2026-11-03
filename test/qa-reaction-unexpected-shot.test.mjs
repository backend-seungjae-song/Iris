// 기대 밖 변화 장면(S4) 사진 실패와 웹 반응 판정
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createQaReactionCommands } = require("../native/electron/cdp-qa-reaction.cjs");

function harness(failKinds) {
  let clock = 0, listener, id;
  const snapshot = {effects:[{id:"e1", found:false}], bodyText:"화면", visibleElements:1, busy:[], broken:[]};
  const send = async method => method === "Page.getFrameTree" ? {frameTree:{frame:{id:"main"}}} : method === "Page.createIsolatedWorld" ? {executionContextId:1}
    : method === "Runtime.evaluate" ? {result:{value:snapshot}} : {};
  const commands = createQaReactionCommands({observation:{subscribeEvents(fn){ listener = fn; }}, now:() => clock, sleep:async ms => { clock += ms; },
    screenshot:async (_s, _w, args) => { if (failKinds.some(kind => args.caption.startsWith(kind))) throw new Error("반응 관찰 시간 상한"); return {path:"scene.png"}; }});
  const dom = payload => listener(1, "Runtime.bindingCalled", {name:"__irisQaReaction", executionContextId:1, payload:JSON.stringify({id, ...payload})}, "");
  return {
    async run() {
      ({id} = await commands["qa-reaction-start"](send, {id:1}, {expect:{effects:[{type:"appear", text:"저장됨", oracle:"명세"}], within:2000}, action:"click", target:{x:1, y:1}}));
      dom({effects:[{id:"e1", found:true, text:"저장됨", rect:{x:0, y:0, width:50, height:20}}], changes:[{text:"저장됨", rect:{x:0, y:0, width:50, height:20}}, {text:"광고 배너", rect:{x:0, y:100, width:50, height:20}}]});
      return commands["qa-reaction-end"](send, {id:1}, {id, delivered:true});
    }};
}

test("기대 밖 변화 장면의 사진만 실패하면 관찰된 기대 효과는 통과한다", async () => {
  const result = await harness(["기대 밖"]).run();
  assert.ok(result.scenes.some(scene => scene.claim.kind === "S4" && scene.shotError), JSON.stringify(result.scenes.map(scene => scene.claim)));
  assert.equal(result.pass, true);
});

test("기대 효과 장면의 사진이 실패하면 통과하지 않는다", async () => {
  const result = await harness(["기대한 요소"]).run();
  assert.ok(result.scenes.some(scene => scene.claim.kind === "S2" && scene.shotError));
  assert.equal(result.pass, false);
});

test("한 번에 바뀐 요소가 많아도 기대 밖 변화 사진은 묶음마다 한 장이고, 찍는 중이면 그 장면을 함께 쓴다", async () => {
  let clock = 0, listener, id, shots = 0;
  const snapshot = {effects:[{id:"e1", found:false}], bodyText:"화면", visibleElements:1, busy:[], broken:[]};
  const send = async method => method === "Page.getFrameTree" ? {frameTree:{frame:{id:"main"}}} : method === "Page.createIsolatedWorld" ? {executionContextId:1}
    : method === "Runtime.evaluate" ? {result:{value:snapshot}} : {};
  const commands = createQaReactionCommands({observation:{subscribeEvents(fn){ listener = fn; }}, now:() => clock, sleep:async ms => { clock += ms; },
    screenshot:async () => { shots++; await new Promise(resolve => setTimeout(resolve, 5)); return {path:"scene.png"}; }});
  const dom = payload => listener(1, "Runtime.bindingCalled", {name:"__irisQaReaction", executionContextId:1, payload:JSON.stringify({id, ...payload})}, "");
  ({id} = await commands["qa-reaction-start"](send, {id:1}, {expect:{effects:[{type:"appear", text:"저장됨", oracle:"명세"}], within:2000}, action:"click", target:{x:1, y:1}}));
  const before = shots;
  const rows = from => Array.from({length:50}, (_, i) => ({text:`행 ${from + i}`, selector:`tr:${from + i}`, rect:{x:0, y:i * 20, width:100, height:20}}));
  dom({changes:rows(0)});
  dom({changes:rows(50)});
  dom({effects:[{id:"e1", found:true, text:"저장됨", rect:{x:0, y:0, width:50, height:20}}], changes:[{text:"저장됨", rect:{x:0, y:0, width:50, height:20}}]});
  const result = await commands["qa-reaction-end"](send, {id:1}, {id, delivered:true});
  const s4 = result.scenes.filter(scene => scene.claim.kind === "S4");
  assert.equal(result.unexpected.length, 100);
  assert.equal(s4.length, 1, JSON.stringify(s4.map(scene => scene.claim.description)));
  assert.ok(result.unexpected.every(item => item.sceneId === s4[0].id));
  assert.equal(result.pass, true);
  assert.ok(shots - before <= 3, String(shots - before));
});
