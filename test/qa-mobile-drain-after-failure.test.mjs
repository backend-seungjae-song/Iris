// 반응 관찰 중 조회 실패 뒤의 다음 조작과 기기를 놓은 뒤의 회차 종료
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createQaMobile } from "../server/qa-mobile.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz8AAAAASUVORK5CYII=","base64");
const device = "11111111-1111-4111-8111-111111111111", oracle = "기능의 용도";
const el = (label) => ({type:"StaticText", AXLabel:label, resourceId:label, frame:{x:1,y:1,width:10,height:10}});

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),"qa-mobile-drain-"));
  t.after(() => fs.rmSync(directory,{recursive:true,force:true}));
  let targets = {alice:[device]}, failing = false;
  const mobile = createQaMobile({shotsDir:directory,
    listDevices:async()=>({ok:true,data:{tabs:[{udid:device,tab:"phone",owner:"alice",mine:true}]}}),
    readTargets:()=>structuredClone(targets), setTargets:async(session,devices)=>{targets={...targets,[session]:devices};},
    openDevice:async()=>({ok:false,error:"디스크 여유가 부족해 기기를 추가하거나 켜지 않습니다."}),
    reactionOptions:{interval:5, tailMs:1, operationTimeoutMs:50},
    backend:{verify:async()=>{}, screenshot:async(_,file)=>fs.writeFileSync(file,PNG), input:async()=>{},
      tree:async()=>{ if (failing) throw new Error("모바일 접근성 조회 시간 초과"); return [el("닉네임")]; }}});
  t.after(() => mobile.close("alice"));
  return { mobile, fail:(value)=>{ failing = value; }, release:()=>{ targets = {...targets, alice:[], bob:[device]}; } };
}

async function failedTap(mobile, fail) {
  const expect = {effects:[{type:"unchanged", text:"닉네임", oracle}], within:100};
  const start = await mobile.execute("alice","reaction_start",{expect,action:{command:"tap",args:{x:5,y:5}}});
  assert.equal(start.ok,true,start.error);
  fail(true);
  assert.equal((await mobile.execute("alice","tap",{x:5,y:5,expect})).ok,true);
  const ended = await mobile.execute("alice","reaction_end",{id:start.data.reactionId,delivered:true});
  fail(false);
  assert.match(ended.data.error, /시간 초과/);
  return start.data.reactionId;
}

test("조작 중 한 번 실패한 조회 오류를 다음 drain 이 다시 돌려주지 않음", async t => {
  const { mobile, fail } = setup(t);
  const id = await failedTap(mobile, fail);
  const drained = await mobile.execute("alice","reaction_drain",{device,id});
  assert.equal(drained.ok,true,drained.error);
  assert.equal(drained.data.error ?? null, null);
});

test("기기를 놓은 뒤 drain 은 기기 선택 없이 빈 결과", async t => {
  const { mobile, fail, release } = setup(t);
  const id = await failedTap(mobile, fail);
  assert.equal((await mobile.execute("alice","target",{clear:true})).ok,true);
  release();
  const drained = await mobile.execute("alice","reaction_drain",{device,id});
  assert.equal(drained.ok,true,drained.error);
  assert.equal(drained.data.empty,true);
});
