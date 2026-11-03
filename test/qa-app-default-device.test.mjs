// 앱만 조작하는 회차에서 device 를 생략한 조작 뒤 반응 판단 도구 사용
import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createQaLedger } from "../server/qa-ledger.js";
import { createQaChannel } from "../server/qa-channel.js";
import { createQaRoutes } from "../server/qa-routes.js";
import { qaCharter, qaPlan, qaRowContract } from "./qa-fixtures.mjs";
const {createQaLedgerAnchor} = createRequire(import.meta.url)("../native/electron/qa-ledger-anchor.cjs");
const root = path.join(fs.realpathSync(os.tmpdir()),"qa-app-default-device-tests");

test("device 를 생략한 qa_app_tap 의 반응은 이 회차의 기기로 기록되고 qa_review·qa_unexpected·qa_row close 가 통과한다", async t => {
  fs.mkdirSync(root,{recursive:true});
  const dir = fs.mkdtempSync(path.join(root,"run-"));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const ledger = createQaLedger({dir,anchor:createQaLedgerAnchor({dir:path.join(dir,"anchors")})});
  const shot = () => { const file = path.join(dir,`qa-${Math.random()}.png`); fs.writeFileSync(file,"png"); return file; };
  const mobileCalls = [];
  const call = createQaChannel({ledger,
    createEntry:async()=>({ok:false,error:"웹 탭 없음"}),
    restore:async()=>({ok:true}), release:async()=>{}, ask:async()=>({ok:true,data:{answer:"승인"}}),
    makeRoutes:options=>createQaRoutes({...options,dir,revisionOf:()=>"revision-1"}),
    // 실제 실행기처럼 소유하지 않은 탭(웹 탭 없음)은 거부
    execute:async tab=>tab ? {ok:true,data:{}} : {ok:false,error:"QA 탭 소유권이 없습니다."},
    mobileFactory:(_run,onClaim)=>({execute:async(_session,cmd,args={})=>{
      mobileCalls.push([cmd,args.device]);
      onClaim("phone");
      const base = {targetId:"phone",device:"phone",platform:"ios"};
      if(cmd === "reaction_start") return {ok:true,data:{...base,reactionId:"w1",scenes:[{id:"s1",path:shot(),claim:{kind:"S1",description:"조작 전"}}]}};
      if(cmd === "reaction_end") return {ok:true,data:{...base,pass:true,effects:[{id:"e1",observed:true,sceneId:"s3"}],candidates:[],
        unexpected:[{id:"u1",code:"U1",description:"방해 화면",sceneId:"s3"}],scenes:[{id:"s3",path:shot(),claim:{kind:"S3",description:"조작 뒤"}}]}};
      if(cmd === "reaction_drain") return {ok:true,data:{...base,empty:true}};
      return {ok:true,data:{...base,inputAccepted:true,path:shot(),shot:shot()}};
    }})});
  const begin = await call("run_begin",{plan:qaPlan({entries:["http://localhost:3002/shop"]}),charter:qaCharter()},"owner");
  assert.equal(begin.ok,true,JSON.stringify(begin));
  const run = begin.data.runId, send = (cmd,args={}) => call(cmd,args,"owner",run);
  assert.equal((await send("app_target",{device:"phone"})).ok,true);
  assert.equal((await send("row",{action:"declare",...qaRowContract(),id:"r",what:"상점 열기",given:"홈 화면",basis:"spec",basisNote:"기획서",paths:["정상"]})).ok,true);
  assert.equal((await send("row",{action:"open",row:"r",path:"정상"})).ok,true);
  const tap = await send("app_tap",{x:1,y:1,expect:{effects:[{id:"e1",type:"appear",text:"상점",oracle:"기능의 용도"}]}});
  assert.equal(tap.ok,true,JSON.stringify(tap));
  const events = (await ledger.verify(run)).events;
  assert.equal(events.find(r=>r.event.kind === "accepted" && r.event.cmd === "app_tap").event.surface,"phone");
  const review = await send("review");
  assert.equal(review.ok,true,JSON.stringify(review));
  const item = review.data.items.find(item=>item.id.endsWith("u1"));
  assert.ok(item,JSON.stringify(review.data.items));
  const judged = await send("unexpected",{id:item.id,class:"방해 화면",handler:"click"});
  assert.notEqual(judged.error,"QA 탭 소유권이 없습니다.");
  const closed = await send("row",{action:"close",id:"r",path:"정상",color:"green",note:"상점 열림",sceneJudgment:"상점 화면 전체 확인"});
  assert.notEqual(closed.error,"QA 탭 소유권이 없습니다.");
});
