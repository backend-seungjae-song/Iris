// 모바일 qa_play 의 대상→도착 swipe 단계 인자
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createQaChannel } from "../server/qa-channel.js";
import { createQaMobile } from "../server/qa-mobile.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz8AAAAASUVORK5CYII=","base64");
const device = "11111111-1111-4111-8111-111111111111", repo = process.cwd(), oracle = "기능의 용도";
const charter = {question:"사용자가 목록을 넘겨 볼 수 있는가", scope:"모바일 목록", exclusions:"외부 서비스", environment:"격리 AX fixture", sharedEnvironment:false, timebox:"1분", people:"없음", documents:"fixture"};
const plan = {entries:[], surfaces:["모바일 목록"], build:{repo}, risks:[{id:"swipe", risk:"넘기기가 전달되지 않을 수 있다", size:"mid", knowledge:"some", decision:"test"}], listRationale:"넘기기 결과 확인"};
const row = {action:"declare", id:"list", what:"목록 넘기기", given:"목록 화면", basis:"spec", basisNote:"목록 명세", paths:["정상"], risk:["swipe"], oracle:"기능의 용도: 넘기기 확인", dataChanging:false, mustNotChange:{notApplicable:true, reason:"격리된 화면만 확인"}};
const el = (label, x, y) => ({type:"StaticText", AXLabel:label, resourceId:label, frame:{x, y, width:10, height:10}});

test("대상에서 도착 대상으로 넘기는 app_swipe 단계는 x1·y1·x2·y2만 넘기고 실행기 인자 검사를 통과한다", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),"qa-play-swipe-")), events = [], inputs = [];
  const originalState = process.env.IRIS_STATE_DIR; process.env.IRIS_STATE_DIR = directory;
  let swiped = false;
  const mobile = createQaMobile({shotsDir:directory, listDevices:async()=>({ok:true,data:{tabs:[{udid:device,tab:"phone",owner:"alice",mine:true}]}}), readTargets:()=>({alice:[device]}),
    reactionOptions:{interval:1, tailMs:1},
    backend:{verify:async()=>{}, tree:async()=>swiped ? [el("두 번째 카드",10,10), el("끝",100,500)] : [el("첫 카드",10,10), el("끝",100,500)],
      input:async(_,command,args)=>{ inputs.push([command,args]); if(command === "swipe") swiped = true; }, screenshot:async(_,file)=>fs.writeFileSync(file,PNG)}});
  t.after(async()=>{ await mobile.close("alice"); if(originalState == null) delete process.env.IRIS_STATE_DIR; else process.env.IRIS_STATE_DIR = originalState; fs.rmSync(directory,{recursive:true,force:true}); });
  const append = async(_id,event)=>{ const receipt = {seq:events.length+1, event:structuredClone(event)}; events.push(receipt); return receipt; };
  const ledger = {append, begin:({runId,session,plan,charter})=>append(runId,{kind:"run_begin",session,plan,charter}), verify:async()=>({events:structuredClone(events)}), end:(id,args)=>append(id,{kind:"run_end",sessionRecord:args.session})};
  const call = createQaChannel({ledger, mobileFactory:()=>mobile, makeRoutes:()=>({list:async()=>[]}), createEntry:async()=>assert.fail("browser entry not expected"), execute:async()=>assert.fail("browser input not expected"), release:async()=>{}, ask:async()=>({ok:true})});
  const begun = await call("run_begin",{plan,charter},"alice"); assert.equal(begun.ok,true,begun.error);
  const send = (command,args={}) => call(command,args,"alice",begun.data.runId);
  assert.equal((await send("app_target",{device})).ok,true);
  assert.equal((await send("row",row)).ok,true);
  assert.equal((await send("row",{action:"open",row:"list",path:"정상"})).ok,true);
  assert.equal((await send("list_review",{review:{information:[{row:"list",text:"카드 목록"}],duplicates:[],distribution:"목록 넘기기 정상 경로",missingRisks:"없음"}})).ok,true);
  const played = await send("play",{steps:[{action:"app_swipe", target:{text:"첫 카드"}, to:{text:"끝"}, device, expect:{effects:[{type:"appear", text:"두 번째 카드", oracle}], within:100}}]});
  assert.equal(played.ok,true,played.error);
  assert.equal(played.data.pass,true,JSON.stringify(played.data.steps));
  const swipe = inputs.find(([command])=>command === "swipe")?.[1];
  assert.ok(swipe, JSON.stringify(inputs));
  assert.equal("x" in swipe || "y" in swipe, false);
  assert.deepEqual([swipe.x1,swipe.y1,swipe.x2,swipe.y2].every(Number.isFinite), true);
});
