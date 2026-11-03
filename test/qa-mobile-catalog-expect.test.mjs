// 반응 목록의 연관 반응 기대를 붙인 앱 조작: 관찰 시작 때 선언한 기대와 입력에 보내는 기대가 같아야 기기가 입력을 받음
import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { createQaLedger } from "../server/qa-ledger.js";
import { createQaChannel } from "../server/qa-channel.js";
import { createQaRoutes } from "../server/qa-routes.js";
import { recordReactionJudgments } from "../server/qa-catalog.js";
import { qaCharter, qaPlan, qaRowContract } from "./qa-fixtures.mjs";
const {createQaLedgerAnchor} = createRequire(import.meta.url)("../native/electron/qa-ledger-anchor.cjs");
const root = path.join(fs.realpathSync(os.tmpdir()),"qa-mobile-catalog-expect");
const repo = path.resolve(import.meta.dirname,"..");
const oracle = "기능의 용도";
const target = {role:"button",name:"찜"};

async function playWithCatalog(t, stepEffects) {
  fs.mkdirSync(root,{recursive:true});
  const dir = fs.mkdtempSync(path.join(root,"run-"));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  process.env.IRIS_STATE_DIR = path.join(dir,"state");
  recordReactionJudgments(repo,[{class:"연관 반응",condition:{text:"찜 목록에 담았어요"},action:{kind:"tap",target},
    expect:{effects:[{type:"appear",text:"찜 목록에 담았어요",oracle}]},source:"server/qa-channel.js:1",cause:"찜 저장 안내"}],{runId:"old",seq:1,runSeq:1});
  const ledger = createQaLedger({dir,anchor:createQaLedgerAnchor({dir:path.join(dir,"anchors")})});
  const shot = () => { const file = path.join(dir,`qa-${Math.random()}.png`); fs.writeFileSync(file,"png"); return file; };
  const seen = {start:null,input:null};
  const call = createQaChannel({ledger,
    createEntry:async()=>({ok:false,error:"웹 탭 없음"}),
    restore:async()=>({ok:true}), release:async()=>{}, ask:async()=>({ok:true,data:{answer:"승인"}}),
    makeRoutes:options=>createQaRoutes({...options,dir,revisionOf:()=>"revision-1"}),
    execute:async tab=>tab ? {ok:true,data:{}} : {ok:false,error:"QA 탭 소유권이 없습니다."},
    mobileFactory:(_run,onClaim)=>({execute:async(_session,cmd,args={})=>{
      onClaim("phone");
      const base = {targetId:"phone",device:"phone",platform:"ios"};
      if(cmd === "target_resolve") return {ok:true,data:{...base,found:true,x:5,y:5,occluded:false,target}};
      if(cmd === "reaction_start") { seen.start = args.expect; return {ok:true,data:{...base,reactionId:"w1",scenes:[{id:"s1",path:shot(),claim:{kind:"S1",description:"조작 전"}}]}}; }
      if(cmd === "tap") {
        seen.input = args.expect;
        // qa-mobile.js 와 같은 거부
        if(!isDeepStrictEqual(args.expect,seen.start)) return {ok:false,error:"관찰 시작 때 선언한 기대 효과와 다릅니다."};
        return {ok:true,data:{...base,native:true,inputAccepted:true}};
      }
      if(cmd === "reaction_end") return {ok:true,data:{...base,pass:true,effects:seen.start.effects.map(e=>({id:e.id,observed:true,sceneId:"s3"})),candidates:[],unexpected:[],scenes:[{id:"s3",path:shot(),claim:{kind:"S3",description:"조작 뒤"}}]}};
      if(cmd === "reaction_drain") return {ok:true,data:{...base,empty:true}};
      return {ok:true,data:{...base,inputAccepted:true,path:shot(),shot:shot()}};
    }})});
  const begin = await call("run_begin",{plan:qaPlan({entries:["http://localhost:3002/shop"]}),charter:qaCharter()},"owner");
  assert.equal(begin.ok,true,JSON.stringify(begin));
  const run = begin.data.runId, send = (cmd,args={}) => call(cmd,args,"owner",run);
  assert.equal((await send("app_target",{device:"phone"})).ok,true);
  assert.equal((await send("row",{action:"declare",...qaRowContract(),id:"r",what:"찜 저장",given:"상품 화면",basis:"spec",basisNote:"기획서",paths:["정상"]})).ok,true);
  const reviewed = await send("list_review",{review:{information:[{row:"r",text:"찜 저장의 독립 정보"}],duplicates:[],distribution:"정상 입력 경로",missingRisks:"위험을 모두 포함"}});
  assert.equal(reviewed.ok,true,JSON.stringify(reviewed));
  assert.equal((await send("row",{action:"open",row:"r",path:"정상"})).ok,true);
  const played = await send("play",{steps:[{action:"app_tap",target,expect:{effects:stepEffects}}]});
  return {played,seen};
}

test("목록 기대가 붙은 앱 조작도 입력이 전달된다", async t => {
  const {played,seen} = await playWithCatalog(t,[{type:"appear",text:"찜함",oracle}]);
  assert.equal(played.ok,true,JSON.stringify(played));
  assert.equal(seen.start.effects.length,2,"단계 기대 + 목록 기대");
  assert.deepEqual(seen.input,seen.start);
});

test("단계가 목록과 같은 기대를 선언하면 두 번 넣지 않는다", async t => {
  const {played,seen} = await playWithCatalog(t,[{type:"appear",text:"찜 목록에 담았어요",oracle}]);
  assert.equal(played.ok,true,JSON.stringify(played));
  assert.equal(seen.start.effects.length,1);
  assert.deepEqual(seen.input,seen.start);
});
