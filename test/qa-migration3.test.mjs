import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createQaLedger } from "../server/qa-ledger.js";
import { createQaChannel } from "../server/qa-channel.js";
import { createQaRoutes } from "../server/qa-routes.js";
import { legacyQaEvents } from "../server/qa-report.js";
import { qaCharter, qaPlan, qaRowContract } from "./qa-fixtures.mjs";
const {createQaLedgerAnchor} = createRequire(import.meta.url)("../native/electron/qa-ledger-anchor.cjs");
const root = path.join(fs.realpathSync(os.tmpdir()),"qa-migration3-tests");
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
      const response = hook?.(cmd,args,{shot}); if(response) return response;
      if(cmd === "qa-reaction-start" || cmd === "qa-reaction-end") {
        const phase=cmd.endsWith("start")?"S1":"S3";
        return {ok:true,data:{id:"r",pass:true,effects:[],scenes:[{id:phase,shot,claim:{kind:phase,description:phase}}]}};
      }
      return {ok:true,data:{url,path:shot,shot,screenshot:shot,snapshot:"Save",at:{x:10,y:20},target,trusted:true,pass:true,received:[{type:cmd === "qa-input" ? {click:"click",type:"input",key:"keydown",scroll:"wheel"}[args.action]:"click",trusted:true,...target}]}};
    }});
  let call=make(); const begin = await call("run_begin",{plan:qaPlan({entries:[url]}),charter:qaCharter()},"owner"); assert.equal(begin.ok,true,JSON.stringify(begin));
  const run=begin.data.runId; const send=(cmd,args={},session="owner")=>call(cmd,actionKinds.has(cmd)&&!args.expect?{...args,expect:defaultExpect}:args,session,run);
  await send("open_entry",{url});
  return {run,send,ledger,sent,restored,asked,released,dir,shot,restart:()=>{call=make();},events:async()=>(await ledger.verify(run)).events};
}
test("history·dialog 기대 장면과 viewport 실행 기록",async t=>{
  const f=await fixture(t);
  for(const [cmd,args] of [["history",{action:"back"}],["dialog",{answer:"cancel"}],["viewport",{width:800,height:600}]]) {
    assert.equal((await f.send("snapshot")).ok,true);
    assert.equal((await f.send(cmd,args)).ok,true);
    const events=await f.events(), action=events.findLast(r=>r.event.kind === "action");
    assert.equal(action.event.cmd,cmd);
    const frames=events.filter(r=>r.event.kind === "frame" && r.event.acceptedSeq === action.event.acceptedSeq);
    assert.equal(frames.length,cmd === "viewport" ? 0 : 2);
    assert.ok(frames.every(r=>r.event.shot));
  }
});
test("다중 탭과 재시작 후 원 소유 세션·열린 항목 복구",async t=>{
  const f=await fixture(t);
  await f.send("open_entry",{url,newTab:true});
  assert.deepEqual((await f.send("tabs")).data.tabs,["tab-1","tab-2"]);
  assert.equal((await f.send("tab",{tab:"foreign"})).ok,false);
  await f.send("tab",{tab:"tab-1"});
  await f.send("row",{action:"declare",...qaRowContract(),id:"r",what:"저장 표시",given:"화면 열림",basis:"spec",basisNote:"명세",paths:["정상"]});
  await f.send("row",{action:"open",row:"r",path:"정상"});
  f.restart();
  assert.equal((await f.send("run_resume",{},"foreign")).ok,false);
  const resumed=await f.send("run_resume"); assert.equal(resumed.ok,true,JSON.stringify(resumed));
  assert.equal(resumed.data.tab,"tab-1"); assert.deepEqual(resumed.data.open,[{id:"r",path:"정상"}]);
  assert.deepEqual(f.restored[0],["owner",["tab-1","tab-2"],f.run]);
  assert.equal((await f.send("open_entry",{url})).ok,false);
});
test("observe 진단과 moment·caption·marks를 해시 장부와 보고서 변환에 보존",async t=>{
  const f=await fixture(t,(cmd,args,{shot})=>cmd === "observe" ? {ok:true,data:{url,screenshot:shot,console:[{text:"오류"}],network:[{url,status:500}],exceptions:[],moments:[{text:"저장됨",shot,lived:250}]}}:undefined);
  assert.equal((await f.send("observe",{caption:"저장 결과",mark:["#save"]})).ok,true);
  const events=await f.events(),obs=events.find(r=>r.event.cmd === "observe" && r.event.kind === "observation" && !r.event.detail?.background).event;
  assert.ok(obs.detail);
  assert.equal(obs.detail.console[0].text,"오류"); assert.equal(obs.detail.network[0].status,500);
  assert.equal(obs.caption,"저장 결과");assert.deepEqual(obs.marks,["#save"]);
  const moment=events.find(r=>r.event.cmd === "moment")?.event; assert.ok(moment); assert.equal(moment.moment,"저장됨");assert.ok(moment.shot);
  const frames=legacyQaEvents(events,f.ledger.paths(f.run).folder);
  assert.ok(frames.some(frame=>frame.moment === "저장됨"));
});
test("늦게 전달된 moment는 촬영 시각과 그때의 조작 번호로 기록하고 보고서에 표시",async t=>{
  let late=null;
  const f=await fixture(t,(cmd,args,{shot})=>cmd === "observe" && late ? {ok:true,data:{url,screenshot:shot,console:[],network:[],exceptions:[],moments:[{text:"잠깐 뜬 알림",shot,ts:late}]}}:undefined);
  assert.equal((await f.send("click",{x:10,y:20})).ok,true);
  const accepted=(await f.events()).findLast(r=>r.event.kind === "accepted" && r.event.cmd === "click");
  late=accepted.event.at+1;
  await new Promise(resolve=>setTimeout(resolve,1100));
  assert.equal((await f.send("observe",{})).ok,true);
  const events=await f.events(),moment=events.find(r=>r.event.cmd === "moment");
  assert.ok(moment.seq > accepted.seq+3);
  assert.equal(moment.event.capturedAt,late);
  assert.equal(moment.event.acceptedSeq,accepted.seq);
  const frame=legacyQaEvents(events,f.ledger.paths(f.run).folder).find(item=>item.moment === "잠깐 뜬 알림");
  assert.match(frame.caption,new RegExp(`촬영 시점: #${accepted.seq} 조작 중 · 이 기록보다 \\d+(\\.\\d)?초 앞`));
});
test("select text/value는 읽기 해석 후 실제 키 입력",async t=>{
  const f=await fixture(t,cmd=>cmd === "qa-select-resolve" ? {ok:true,data:{index:1,typeahead:{char:"둘",count:1},selectedIndex:1}}:undefined);
  for(const condition of [{text:"둘째"},{value:"two"}]) {
    assert.equal((await f.send("snapshot")).ok,true);
    const result=await f.send("select",{x:10,y:20,...condition});assert.equal(result.ok,true);
  }
  // 고른 뒤 실제 선택을 다시 읽어 확인하므로 선택마다 두 번 해석
  assert.equal(f.sent.filter(x=>x.cmd === "qa-select-resolve").length,4);
  assert.equal(f.sent.filter(x=>x.cmd === "qa-input" && x.args.action === "typeahead").length,2);
});
test("저장 계정 선택과 결제·본인확인 사용자 전달",async t=>{
  let human=false;
  const f=await fixture(t,cmd=>cmd === "qa-login-info" ? {ok:true,data:{accounts:[{id:"a",local:true,allowed:true},{id:"b",local:true,allowed:true}],fields:[{field:"username",x:10,y:20}],humanRequired:human}}:undefined);
  const choices=await f.send("login");assert.equal(choices.data.selectionRequired,true);assert.equal(choices.data.accounts.length,2);
  const loginResult=await f.send("login",{account:"a"}); assert.equal(loginResult.ok,true,JSON.stringify(loginResult));
  assert.equal(f.sent.filter(x=>x.cmd === "qa-login-input").length,1);
  human=true;const response=await f.send("login",{account:"a"});assert.equal(response.data.humanRequired,true);assert.equal(f.asked.length,1);
  assert.equal(f.sent.filter(x=>x.cmd === "qa-login-input").length,1);
});
test("경로 재생은 도착 판정 장면만 기록",async t=>{
  const f=await fixture(t);
  const action=await f.ledger.append(f.run,{kind:"action",cmd:"click",pass:true,target,received:[{type:"click",trusted:true,...target}]});
  const end=await f.ledger.append(f.run,{kind:"assertion",pass:true,arrival:{mode:"exists",sel:"#done"}});
  assert.equal((await f.send("route_save",{name:"저장 화면",fromSeq:action.seq,toSeq:end.seq})).ok,true);
  const result=await f.send("route_replay",{name:"저장 화면"});assert.equal(result.ok,true,JSON.stringify(result));
  const events=await f.events();
  assert.deepEqual(events.filter(r=>r.event.kind === "frame" && r.event.mode === "route_replay").map(r=>r.event.phase),[]);
  assert.ok(events.some(r=>r.event.cmd === "route_arrival" && r.event.shot));
});
test("코드 revision 변경 시 경로 전체 재검증 후 새 revision 기록",async t=>{
  const f=await fixture(t);let revision="old",calls=0;
  const routes=createQaRoutes({ledger:f.ledger,dir:f.dir,revisionOf:()=>revision,executor:async({step})=>{calls++;return {ok:true,pass:true,topTarget:target,received:[{type:"click",trusted:true,...target}],arrival:step.arrival};}});
  const a=await f.ledger.append(f.run,{kind:"action",cmd:"click",pass:true,target,received:[{type:"click",trusted:true,...target}]});
  const b=await f.ledger.append(f.run,{kind:"assertion",pass:true,arrival:{mode:"exists",sel:"#done"}});
  await routes.save({runId:f.run,name:"저장",fromSeq:a.seq,toSeq:b.seq,currentUrl:url});
  revision="new";assert.equal((await routes.list())[0].revalidationRequired,true);
  const result=await routes.replay({runId:f.run,name:"저장"});assert.equal(result.revalidated,true);assert.equal(calls,1);
  assert.equal((await routes.list())[0].revalidationRequired,false);
});

test("장부 복사 뒤 QA 임시 촬영과 caption·marks 파일 정리",async t=>{
  const prior=process.env.IRIS_STATE_DIR, port=process.env.IRIS_PORT;
  const state=path.join(root,"cleanup-state");fs.mkdirSync(state,{recursive:true});
  process.env.IRIS_STATE_DIR=state;process.env.IRIS_PORT="4291";
  t.after(()=>{if(prior===undefined)delete process.env.IRIS_STATE_DIR;else process.env.IRIS_STATE_DIR=prior;if(port===undefined)delete process.env.IRIS_PORT;else process.env.IRIS_PORT=port;fs.rmSync(state,{recursive:true,force:true});});
  const {artifactDir}=await import("../server/artifacts-home.cjs");
  const temp=path.join(artifactDir("shots"),"qa-shot-cleanup.png");
  fs.mkdirSync(path.dirname(temp),{recursive:true});fs.writeFileSync(temp,"captured");
  fs.writeFileSync(temp+".caption.txt","캡션");fs.writeFileSync(temp+".marks.json",JSON.stringify([{x:1,y:2}]));
  const f=await fixture(t,cmd=>cmd === "screenshot" ? {ok:true,data:{path:temp,url}}:undefined);
  const result=await f.send("screenshot");assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(fs.existsSync(temp),false);assert.equal(fs.existsSync(temp+".caption.txt"),false);assert.equal(fs.existsSync(temp+".marks.json"),false);
  assert.equal(fs.readFileSync(result.data.path,"utf8"),"captured");
  const event=(await f.events()).findLast(r=>r.event.shot).event;
  assert.equal(event.caption,"캡션");assert.deepEqual(event.marks,[{x:1,y:2}]);
});

 test("배포 폴더의 코드 내용으로 revision 계산",async t=>{
  const {qaRevision} = await import("../server/qa-revision.js");
  const f=await fixture(t);
  for(const folder of ["server","native","web"]) fs.mkdirSync(path.join(f.dir,folder));
  const file=path.join(f.dir,"server","main.js");fs.writeFileSync(file,"version1");
  const before=qaRevision(f.dir);assert.match(before,/^[a-f0-9]{64}$/);
  fs.writeFileSync(file,"version2");assert.notEqual(qaRevision(f.dir),before);
});

test("snapshot 필터와 촬영 옵션의 허용 계약·파일 경로 주입 거부",async()=>{
  const {validateQaCommand}=await import("../server/qa-protocol.js");
  const snapshot={budget:300,cursor:"cursor-1",role:"button",name:"저장",region:"main"};
  assert.doesNotThrow(()=>validateQaCommand("snapshot",snapshot));
  assert.deepEqual(validateQaCommand("snapshot",snapshot),snapshot);
  const screenshot={crop:{x:0,y:0,width:300,height:200},mark:[{sel:"#save",label:"저장"}],mask:["#secret"],caption:"화면",dpr:2};
  assert.doesNotThrow(()=>validateQaCommand("screenshot",screenshot));
  assert.deepEqual(validateQaCommand("screenshot",screenshot),screenshot);
  assert.deepEqual(validateQaCommand("screenshot",{full:true,dpr:3}),{full:true,dpr:3});
  assert.throws(()=>validateQaCommand("screenshot",{path:"/tmp/arbitrary.png"}),/허용되지/);
  assert.throws(()=>validateQaCommand("snapshot",{eval:"document.body"}),/허용되지/);
});

test("자동 촬영 응답의 웹·모바일 moment 보존과 중복 제거",async t=>{
  const f=await fixture(t,(cmd,args,{shot})=>["screenshot","qa-reaction-start","qa-reaction-end"].includes(cmd) ? {ok:true,data:{path:shot,url,moments:[{text:"웹 순간 알림",shot,ts:1}]}}:undefined,
    ()=>({execute:async(_session,cmd)=>({ok:true,data:{targetId:"phone",path:f.shot,shot:f.shot,scenes:[{id:"s1",claim:{kind:"S1"},shot:f.shot},{id:"s3",claim:{kind:"S3"},shot:f.shot}],moments:["reaction_start","screenshot","reaction_end"].includes(cmd) ? [{text:"앱 순간 알림",shot:f.shot,ts:2,targetId:"phone"}]:[]}})}));
  assert.equal((await f.send("click",{x:10,y:20})).ok,true);
  const pending=await f.send("review");
  for (const item of pending.data.items) {
    const judged=await f.send("unexpected",{id:item.id,class:"무관 반응",source:"미확인",attempts:["시험 실행기의 누락 장면 응답 확인"],cause:"순간 알림 중복 검증을 위한 정상 반응",condition:{code:item.code || "missing"}});
    assert.equal(judged.ok,true,JSON.stringify(judged));
  }
  const appTap=await f.send("app_tap",{x:10,y:20,device:"phone",expect:defaultExpect}); assert.equal(appTap.ok,true,JSON.stringify(appTap));
  const events=await f.events();
  assert.equal(events.filter(r=>r.event.moment === "웹 순간 알림").length,1);
  assert.equal(events.filter(r=>r.event.moment === "앱 순간 알림").length,1);
});
// 압축 뒤 이어받을 때마다 qa_app_target 을 다시 부른 사례: 이어받기 결과가 이어서 쓸 기기를 알림
test("이어받기 결과는 회차가 쓰던 기기를 알리고 재시작 뒤에도 같은 기기를 다시 소유한다",async t=>{
  const claimed=[];
  const f=await fixture(t,undefined,(runId,onClaim)=>({execute:async(_session,cmd,args)=>{
    if(cmd==="targets")return {ok:true,data:{registered:["phone"],devices:[]}};
    if(args?.device){claimed.push([cmd,args.device]);onClaim(args.device);}
    return {ok:true,data:{targetId:"phone",pass:true,effects:[],scenes:[{id:"s1",claim:{kind:"S1"},shot:f.shot},{id:"s3",claim:{kind:"S3"},shot:f.shot}]}};
  }}));
  const before=await f.send("run_resume"); assert.equal(before.ok,true,JSON.stringify(before)); assert.equal(before.data.devices,undefined,"기기를 쓰기 전에는 알리지 않음");
  assert.equal((await f.send("app_tap",{x:10,y:20,device:"phone"})).ok,true);
  const same=await f.send("run_resume"); assert.deepEqual(same.data.devices,["phone"]); assert.match(same.data.deviceNote,/qa_app_target 을 다시 부르지 않아도/);
  f.restart(); claimed.length=0;
  const resumed=await f.send("run_resume"); assert.equal(resumed.ok,true,JSON.stringify(resumed));
  assert.deepEqual(resumed.data.devices,["phone"]); assert.deepEqual(claimed,[["snapshot","phone"]]);
});
