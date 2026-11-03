// 모바일 qa_play 가 조작 대상을 못 찾아 실패로 닫을 때 실패 화면 기록
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
const require = createRequire(import.meta.url);
const {createQaLedgerAnchor} = require("../native/electron/qa-ledger-anchor.cjs");
const {artifactDir} = require("../server/artifacts-home.cjs");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz8AAAAASUVORK5CYII=","base64");

test("대상을 못 찾은 단계의 실패 기록은 회차 폴더로 옮긴 사진을 다시 읽어 ENOENT 없이 닫힌다", async t => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),"qa-play-failure-shot-"));
  const original = process.env.IRIS_STATE_DIR;
  process.env.IRIS_STATE_DIR = dir;
  t.after(()=>{ if(original == null) delete process.env.IRIS_STATE_DIR; else process.env.IRIS_STATE_DIR = original; fs.rmSync(dir,{recursive:true,force:true}); });
  // 실제 실행기처럼 공용 shots 폴더의 qa- 임시 사진. 회차 기록에 옮긴 뒤 지워짐
  const shot = () => { const shots = artifactDir("shots"); fs.mkdirSync(shots,{recursive:true}); const file = path.join(shots,`qa-mobile-${Math.random()}.png`); fs.writeFileSync(file,PNG); return file; };
  const ledger = createQaLedger({dir,anchor:createQaLedgerAnchor({dir:path.join(dir,"anchors")})});
  const call = createQaChannel({ledger,
    createEntry:async()=>({ok:false,error:"웹 탭 없음"}),
    restore:async()=>({ok:true}), release:async()=>{}, ask:async()=>({ok:true,data:{answer:"승인"}}),
    makeRoutes:options=>createQaRoutes({...options,dir,revisionOf:()=>"revision-1"}),
    execute:async()=>({ok:false,error:"웹 탭 없음"}),
    mobileFactory:(_run,onClaim)=>({execute:async(_session,cmd)=>{
      onClaim("phone");
      const base = {targetId:"phone",device:"phone",platform:"ios"};
      if(cmd === "target_resolve") return {ok:true,data:{...base,found:false}};
      if(cmd === "screenshot") return {ok:true,data:{...base,path:shot()}};
      return {ok:true,data:base};
    }})});
  const begin = await call("run_begin",{plan:qaPlan({entries:["http://localhost:3002/shop"]}),charter:qaCharter()},"owner");
  assert.equal(begin.ok,true,JSON.stringify(begin));
  const run = begin.data.runId, send = (cmd,args={}) => call(cmd,args,"owner",run);
  assert.equal((await send("app_target",{device:"phone"})).ok,true);
  assert.equal((await send("row",{action:"declare",...qaRowContract(),id:"r",what:"편의점 카테고리 열기",given:"전체 카테고리 화면",basis:"spec",basisNote:"기획서",paths:["정상"]})).ok,true);
  assert.equal((await send("row",{action:"open",row:"r",path:"정상"})).ok,true);
  const reviewed = await send("list_review",{review:{information:[{row:"r",text:"편의점 브랜드 목록"}],duplicates:[],distribution:"편의점 카테고리 정상 경로",missingRisks:"없음"}});
  assert.equal(reviewed.ok,true,reviewed.error);
  const played = await send("play",{steps:[{action:"app_tap",target:{text:"편의점"},device:"phone",expect:{effects:[{type:"appear",text:"브랜드",oracle:"기능의 용도"}]}}]});
  assert.equal(played.ok,true,JSON.stringify(played));
  assert.equal(played.data.pass,false);
  const events = (await ledger.verify(run)).events;
  const failure = events.find(r=>r.event.kind === "failure");
  assert.ok(failure?.event.shot,JSON.stringify(events.map(r=>r.event.kind)));
  assert.equal(events.find(r=>r.event.kind === "row" && r.event.action === "close")?.event.rowData.color,"red");
});
