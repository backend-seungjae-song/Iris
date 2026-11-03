import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createQaLedger } from "../server/qa-ledger.js";
import { createQaChannel } from "../server/qa-channel.js";
import { createQaRoutes } from "../server/qa-routes.js";
import { legacyQaEvents, qaReportProblems } from "../server/qa-report.js";
import { qaCharter, qaPlan, qaRowContract } from "./qa-fixtures.mjs";
const {createQaLedgerAnchor} = createRequire(import.meta.url)("../native/electron/qa-ledger-anchor.cjs");
const root = path.join(fs.realpathSync(os.tmpdir()),"qa-failure4-tests");
const url = "http://localhost:4321/start";
const target = {role:"button",name:"Save"};
const actionKinds = new Set(["click","dblclick","type","key","select","drag","scroll","history","dialog","app_tap","app_swipe","app_type","app_key"]);
const defaultExpect = {effects:[{id:"none",type:"none",oracle:"기능의 용도"}]};
async function fixture(t,hook,mobileFactory) {
  fs.mkdirSync(root,{recursive:true});
  const dir = fs.mkdtempSync(path.join(root,"run-"));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const shot = path.join(dir,"source.png"); fs.writeFileSync(shot,"png");
  const ledger = createQaLedger({dir,anchor:createQaLedgerAnchor({dir:path.join(dir,"anchors")})});
  let n=0; const sent=[],restored=[],asked=[],released=[];
  const make = () => createQaChannel({ledger,
    createEntry:async()=>({ok:true,data:{tabId:`tab-${++n}`}}),
    restore:async(...args)=>{restored.push(args);return {ok:true};},
    mobileFactory:mobileFactory || (()=>({})), release:async tab=>released.push(tab),
    ask:async(...args)=>{asked.push(args);return {ok:true,data:{answer:"승인"}};},
    makeRoutes:options=>createQaRoutes({...options,dir,revisionOf:()=>"revision-1"}),
    execute:async(tab,cmd,args)=>{
      sent.push({tab,cmd,args});
      const response = await hook?.(cmd,args,{shot}); if(response) return response;
      return {ok:true,data:{url,path:shot,shot,screenshot:shot,snapshot:"Save",at:{x:10,y:20},target,trusted:true,pass:true,received:[{type:cmd === "qa-input" ? {click:"click",type:"input",key:"keydown",scroll:"wheel"}[args.action]:"click",trusted:true,...target}]}};
    }});
  let call=make(); const begin = await call("run_begin",{plan:qaPlan({entries:[url]}),charter:qaCharter()},"owner"); assert.equal(begin.ok,true,JSON.stringify(begin));
  const run=begin.data.runId; const send=(cmd,args={},session="owner")=>call(cmd,actionKinds.has(cmd)&&!args.expect?{...args,expect:defaultExpect}:args,session,run);
  await send("open_entry",{url});
  return {run,send,ledger,sent,restored,asked,released,dir,shot,restart:()=>{call=make();},events:async()=>(await ledger.verify(run)).events};
}
async function openRow(f) {
  assert.equal((await f.send("row",{action:"declare",...qaRowContract(),id:"r",what:"저장 표시",given:"화면 열림",basis:"spec",basisNote:"저장 명세",paths:["정상"]})).ok,true);
  assert.equal((await f.send("row",{action:"open",row:"r",path:"정상"})).ok,true);
}
for (const throws of [false,true]) test(`웹 기대 ${throws ? "예외":"불일치"} 순간 촬영·진단을 다음 입력 전에 보존`,async t=>{
  let resolveObserve, entered;
  const ready=new Promise(resolve=>entered=resolve);
  const f=await fixture(t,async(cmd,args,{shot})=>{
    if(cmd === "qa-expect") { if(throws) throw Error("판정 오류"); return {ok:true,data:{pass:false,shot,url,got:"다른 값"}}; }
    if(cmd === "observe") { entered(); await new Promise(resolve=>resolveObserve=resolve); return {ok:true,data:{console:[{text:"콘솔 오류"}],network:[{status:500}],exceptions:[{text:"예외"}],url,viewport:{width:640,height:480}}}; }
  });
  await openRow(f);
  const pending=f.send("expect",{mode:"equals",sel:"#status",text:"저장됨"});
  await Promise.race([ready,pending.then(()=>assert.fail("실패 진단을 수집하지 않고 명령을 끝냈습니다"))]);
  const next=f.send("click",{x:1,y:1});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.sent.some(s=>s.cmd === "qa-input"),false);
  resolveObserve();
  await pending; await next;
  const events=await f.events(), failure=events.find(r=>r.event.kind === "failure");
  assert.ok(failure.event.shot);
  assert.equal(failure.event.detail.console[0].text,"콘솔 오류");
  assert.equal(failure.event.detail.network[0].status,500);
  assert.equal(failure.event.detail.exceptions[0].text,"예외");
  assert.equal(failure.event.detail.environment.url,url);
  assert.equal(events.find(r=>r.seq === failure.event.detail.failureSeq).event.kind,"assertion");
  assert.ok(failure.seq < events.find(r=>r.event.cmd === "click" && r.event.kind === "accepted").seq);
});
test("실패한 웹 조작과 모바일 조작·판정 모두 실패 순간 기록",async t=>{
  const mobile=[];
  const f=await fixture(t,cmd=>cmd === "qa-input" ? {ok:false,error:"입력 실패"}:undefined,()=>({execute:async(_session,cmd)=>{
    mobile.push(cmd);
    if(["tap","expect"].includes(cmd)) return {ok:false,error:"기기 실행 실패"};
    return {ok:true,data:{targetId:"phone",device:"phone",platform:"ios",path:f.shot,shot:f.shot,snapshot:"오류 화면",alerts:["실패"]}};
  }}));
  await openRow(f);
  assert.equal((await f.send("click",{x:1,y:1})).ok,false);
  assert.equal((await f.send("app_tap",{device:"phone",x:1,y:1})).ok,false);
  assert.equal((await f.send("app_expect",{device:"phone",mode:"exists",label:"완료"})).ok,false);
  // 입력이 전달되지 않은 웹·기기 조작은 제품 판정이 아니라 실패 순간 기록 없음. 판정 실패(app_expect)만 기록
  const events=await f.events();
  assert.deepEqual(events.filter(r=>r.event.kind === "reaction").map(r=>r.event.pass),[null,null]);
  const failures=events.filter(r=>r.event.kind === "failure");
  assert.equal(failures.length,1);
  assert.ok(failures.every(r=>r.event.shot));
  assert.equal(failures[0].event.detail.snapshot,"오류 화면");
  assert.deepEqual(failures[0].event.detail.unavailable,["console","network","exceptions"]);
  assert.equal(failures[0].event.detail.environment.device.targetId,"phone");
  assert.equal(mobile.filter(c=>c === "observe").length,1);
});
test("실패 화면 촬영 오류여도 observe를 시도하고 수집 오류 보존",async t=>{
  const f=await fixture(t,cmd=>{
    if(cmd === "qa-expect") throw Error("판정 중단");
    if(cmd === "screenshot") throw Error("촬영 불가");
    if(cmd === "observe") return {ok:true,data:{url,console:[{text:"진단 보존"}]}};
  });
  await openRow(f);
  assert.equal((await f.send("expect",{mode:"exists",sel:"#status"})).ok,false);
  const failure=(await f.events()).find(r=>r.event.kind === "failure").event;
  assert.equal(failure.detail.captureError,"촬영 불가");
  assert.equal(failure.detail.console[0].text,"진단 보존");
  assert.equal(failure.shot,undefined);
});
test("반응 없던 첫 클릭을 다시 눌러 통과하면 실제 장부에 첫 시도가 판정 없음으로 남고 항목을 통과로 닫을 수 있다",async t=>{
  let ends=0;
  const expect={effects:[{type:"appear",text:"저장됨",oracle:"기능의 용도"}],within:100};
  const f=await fixture(t,(cmd,_args,{shot})=>{
    if(cmd==="qa-reaction-start")return {ok:true,data:{id:"r"+ends,scenes:[]}};
    if(cmd!=="qa-reaction-end")return undefined;
    if(++ends===1)return {ok:true,data:{pass:false,effects:[{id:"e1",observed:false}],events:[],candidates:[{id:"k3",code:"K3",description:"입력 전달 뒤 DOM·주소·요청·대화상자 반응 없음"}],unexpected:[],scenes:[]}};
    return {ok:true,data:{pass:true,effects:[{id:"e1",observed:true,sceneId:"s2"}],events:[{method:"dom"}],candidates:[],unexpected:[],scenes:[{id:"s2",path:shot,claim:{kind:"S2",effectId:"e1",description:"저장됨"}}]}};
  });
  await openRow(f);
  assert.equal((await f.send("snapshot")).ok,true);
  const clicked=await f.send("click",{x:1,y:1,expect});
  assert.equal(clicked.data.pass,true,clicked.error);
  const events=await f.events();
  const reactions=events.filter(r=>r.event.kind==="reaction"&&r.event.rowId==="r");
  assert.deepEqual(reactions.map(r=>r.event.pass),[null,true]);
  assert.deepEqual(events.filter(r=>r.event.kind==="action"&&r.event.rowId==="r").map(r=>r.event.pass),[null,true]);
  assert.equal(reactions[1].event.detail.retryOf,reactions[0].seq);
  assert.ok(events.filter(r=>r.event.kind==="action"&&r.event.rowId==="r").every(r=>r.event.detail?.settle),"조작마다 안정 대기 결과 저장");
  const closed=await f.send("row",{action:"close",row:"r",path:"정상",color:"green",note:"저장 표시 확인",sceneJudgment:"다시 누른 뒤 저장됨 표시"});
  assert.equal(closed.ok,true,closed.error);
  const problems=qaReportProblems(await f.events());
  assert.equal(problems.some(p=>/실패한 조작|실패 판정이 있습니다/.test(p)),false,problems.join("\n"));
});
