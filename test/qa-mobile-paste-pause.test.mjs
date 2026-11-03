// iOS 한글 입력(붙여넣기) 동안의 반응 관찰 기준 시점
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createQaMobile } from "../server/qa-mobile.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz8AAAAASUVORK5CYII=","base64");
const device = "11111111-1111-4111-8111-111111111111", oracle = "기능의 용도";
const el = (label, more = {}) => ({type:"StaticText", AXLabel:label, resourceId:label, frame:{x:1,y:1,width:10,height:10}, ...more});
const tick = () => new Promise(resolve => setImmediate(resolve));

test("붙여넣기 허용 창을 처리하는 동안 빈 접근성 트리는 판정에 쓰지 않고, 입력이 끝난 뒤부터 기대 시간을 센다", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),"qa-mobile-paste-pause-"));
  t.after(() => fs.rmSync(directory,{recursive:true,force:true}));
  let clock = 0, phase = "before";
  const field = () => el("검색", {type:"TextField", resourceId:"search", AXValue:phase === "after" ? "없음" : ""});
  // 실제 측정: 허용 창 처리 약 4.5초, 창이 닫힌 뒤 약 3.5초 동안 트리가 요소 1개
  const tree = async () => phase === "pasting" ? [{type:"Application", AXLabel:""}] : phase === "after" ? [field(), el("검색 결과가 없어요")] : [field(), el("상품")];
  const mobile = createQaMobile({shotsDir:directory, listDevices:async()=>({ok:true,data:{tabs:[{udid:device,tab:"phone",owner:"alice",mine:true}]}}),
    readTargets:()=>({alice:[device]}), reactionOptions:{now:()=>clock, wait:async ms=>{clock+=ms; await tick();}, interval:100, tailMs:1},
    backend:{verify:async()=>{}, tree, screenshot:async(_,file)=>fs.writeFileSync(file,PNG),
      input:async(_,command)=>{ if(command !== "type")return; phase = "pasting"; for(let i = 0; i < 20; i++){ clock += 400; await tick(); } phase = "after"; }}});
  t.after(() => mobile.close("alice"));
  const args = {text:"없음", x:6, y:6}, expect = {effects:[{type:"appear", text:"검색 결과가 없어요", oracle}], within:1000};
  const start = await mobile.execute("alice","reaction_start",{expect,action:{command:"type",args}});
  assert.equal(start.ok,true,start.error);
  const typed = await mobile.execute("alice","type",{...args,expect});
  assert.equal(typed.ok,true,typed.error);
  const ended = await mobile.execute("alice","reaction_end",{id:start.data.reactionId,delivered:true});
  assert.equal(ended.ok,true,ended.error);
  assert.equal(ended.data.pass,true,JSON.stringify(ended.data.candidates.map(c=>c.description)));
  assert.equal(ended.data.candidates.some(c=>c.code === "K6"),false);
});
