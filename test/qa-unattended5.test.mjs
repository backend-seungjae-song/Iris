import test from "node:test";
import assert from "node:assert/strict";
import { createQaChannel } from "../server/qa-channel.js";
import { assertQaInvestigationTime, qaUnattendedPolicy } from "../server/qa-unattended.js";
import { validateQaCharter } from "../server/qa-session-contract.js";
import { recordQaSession } from "../server/qa-session.js";
import { qaArguments, QA_TOOLS } from "../bin/iris-qa.mjs";
import { qaCharter, qaPlan, qaRowContract } from "./qa-fixtures.mjs";

function fixture(charter = {}, options = {}) {
  const events = options.events || [], calls = [], asks = [];
  const append = async (_, event) => {
    const record = {seq:events.length+1,event:{...structuredClone(event),at:Date.now()}};
    events.push(record); return record;
  };
  const ledger = {append,begin:args=>append(args.runId,{kind:"run_begin",...args}),verify:async()=>({events:structuredClone(events)})};
  const channel = createQaChannel({ledger,
    createEntry:async()=>({ok:true,data:{tabId:"web"}}),release:async()=>{},restore:async()=>({ok:true}),
    ask:async(...args)=>{asks.push(args); if(options.neverAsk) return new Promise(()=>{}); const answer=options.answer || "승인"; return {ok:true,data:{answer,answered:answer!=="무응답",approved:answer==="승인",uiConnected:options.uiConnected ?? true}};},
    execute:async(tab,cmd,args)=>{
      calls.push({tab,cmd,args});
      const response = await options.execute?.(cmd,args);
      if (response !== undefined) return response;
      if(cmd === "qa-reaction-start" || cmd === "qa-reaction-end") {
        const phase=cmd.endsWith("start")?"S1":"S3";
        return {ok:true,data:{id:"r",pass:true,effects:[],candidates:[],scenes:[{id:phase,claim:{kind:phase,description:"장면"},path:"shot.png",url:"https://example.test/start",...options.data}]}};
      }
      if (cmd === "url") return {ok:true,data:{url:"https://example.test/start"}};
      if (cmd === "qa-login-info") return {ok:true,data:{accounts:[{id:"account",allowed:false}],fields:[{x:1,y:1,field:"username"}],...options.login}};
      return {ok:true,data:{pass:true,path:"shot.png",shot:"shot.png",url:"https://example.test/start",trusted:true,received:[],...options.data}};
    },makeRoutes:options.makeRoutes || (()=>({list:async()=>[]}))});
  return {events,calls,asks,ledger,channel,async start(){
    const result = await channel("run_begin",{plan:qaPlan({entries:["https://example.test/start"],...(options.plan || {})}),charter:{...qaCharter(),...charter}},"session");
    if(!result.ok) return result;
    this.run = result.data.runId;
    this.send = (cmd,args={})=> {
      const action=["click","dblclick","type","key","select","drag","scroll","history","dialog","app_tap","app_swipe","app_type","app_key"].includes(cmd);
      if(action&&!args.expect) args={...args,expect:cmd==="type"?{effects:[{type:"change",sel:"input:focus",to:args.text||"",oracle:"기능의 용도"}],within:1000}:{effects:[{type:"none",oracle:"기능의 용도"}],within:1000}};
      return channel(cmd,args,"session",this.run);
    };
    assert.equal((await this.send("open_entry",{url:"https://example.test/start"})).ok,true);
    return result;
  },async row(id="row"){
    assert.equal((await this.send("row",{action:"declare",...qaRowContract(),id,what:"결과",given:"입력 화면",basis:"assumed",paths:["정상"]})).ok,true);
    assert.equal((await this.send("row",{action:"open",row:id,path:"정상"})).ok,true);
  }};
}
const policy = {unattended:true,approvals:{logins:["account"],bulkFill:true},investigationLimitMin:1};

test("무인 설정은 선택 값이며 MCP와 장부 검증이 같은 값을 보존한다",()=>{
  const charter = {...qaCharter(),...policy};
  assert.deepEqual(validateQaCharter(charter),charter);
  assert.deepEqual(qaArguments("qa_run_begin",{plan:qaPlan({entries:[]}),charter}).args.charter,charter);
  for(const invalid of [{unattended:"true"},{approvals:{logins:[1],bulkFill:true}},{investigationLimitMin:0},{investigationLimitMin:Infinity}])
    assert.throws(()=>validateQaCharter({...charter,...invalid}));
  assert.equal(qaUnattendedPolicy([{event:{kind:"run_begin",charter:{unattended:true}}}]).investigationLimitMin,10);
  assert.ok(QA_TOOLS.find(tool=>tool.name === "qa_summary").inputSchema.properties.runIds);
  assert.deepEqual(qaArguments("qa_summary",{runIds:["r"]}),{cmd:"summary",args:{runIds:["r"]}});
});

test("무인 시작은 승인 창 없이 바로 장부를 만들고 사용자 지시로 기록한다",async()=>{
  const f=fixture(policy,{neverAsk:true}); assert.equal((await f.start()).ok,true); assert.equal(f.asks.length,0);
  assert.equal(f.events.find(r=>r.event.kind==="start_approval").event.detail.via,"사용자 지시");
  // 앱 화면이 연결되지 않아도 시작
  const unseen=fixture(policy,{neverAsk:true,uiConnected:false}); assert.equal((await unseen.start()).ok,true); assert.equal(unseen.asks.length,0);
});

test("무인 ask_user는 열린 항목 막힘 또는 세션 메모를 기록하고 기다리지 않는다",{timeout:1500},async()=>{
  const f=fixture(policy,{neverAsk:true}); await f.start();
  const note=await f.send("ask_user",{reason:"계정 확인"});
  assert.equal(note.data.recorded,true); assert.match(note.data.next,/다음 항목/);
  assert.deepEqual(f.events.at(-1).event.detail,{kind:"막힘",text:"사람 필요: 계정 확인"});
  await f.row(); const blocked=await f.send("ask_user",{reason:"본인확인"});
  assert.equal(blocked.data.blocked,true); assert.equal(f.events.at(-1).event.kind,"blocked");
  assert.equal(f.events.at(-1).event.reason,"사람 필요: 본인확인"); assert.equal(f.asks.length,0);
});

// .test 는 로컬 주소로 판정되므로 계정 승인 범위 시험은 원격 주소에서
const remote={execute:(cmd)=>cmd === "url" ? {ok:true,data:{url:"https://example.com/start"}} : undefined};
test("무인 승인 계정 로그인은 재질문하지 않고 승인 밖 로그인과 본인확인은 막힘이다",{timeout:1500},async()=>{
  const f=fixture(policy,{neverAsk:true,...remote}); await f.start();
  assert.equal((await f.send("login",{account:"account"})).ok,true);
  assert.equal(f.asks.length,0); assert.ok(f.calls.some(call=>call.cmd === "qa-login-input" && call.args.approved));
  f.calls.length=0;
  const denied=await f.send("login",{account:"other",fields:[{x:1,y:1,text:"value"}]});
  assert.equal(denied.data.blocked,true); assert.ok(!f.calls.some(call=>call.cmd === "qa-input"));
  const human=fixture(policy,{neverAsk:true,login:{humanRequired:true,sensitive:true}});await human.start();
  assert.equal((await human.send("login",{account:"account"})).data.humanRequired,true);assert.equal(human.asks.length,0);
});

test("로컬 주소의 무인 로그인은 승인 범위 밖 계정과 직접 입력 값도 묻지 않고 진행한다",{timeout:1500},async()=>{
  const f=fixture({...policy,approvals:{logins:[],bulkFill:true}},{neverAsk:true,
    execute:(cmd)=>cmd === "url" ? {ok:true,data:{url:"http://localhost:3002/login"}} : undefined}); await f.start();
  const result=await f.send("login",{account:"account"});
  assert.equal(result.ok,true); assert.notEqual(result.data?.blocked,true); assert.equal(f.asks.length,0);
  assert.ok(f.calls.some(call=>call.cmd === "qa-login-input" && call.args.approved));
  f.calls.length=0;
  const typed=await f.send("login",{account:"account",fields:[{x:1,y:1,text:"admin"}]});
  assert.equal(typed.ok,true); assert.notEqual(typed.data?.blocked,true); assert.equal(f.asks.length,0);
  assert.ok(f.calls.some(call=>call.cmd === "qa-input"));
  const human=fixture(policy,{neverAsk:true,login:{humanRequired:true,sensitive:true},
    execute:(cmd)=>cmd === "url" ? {ok:true,data:{url:"http://localhost:3002/login"}} : undefined});await human.start();
  assert.equal((await human.send("login",{account:"account"})).data.humanRequired,true);
});

test("일반 회차는 기존 ask_user 대기를 유지한다",async()=>{
  const f=fixture();await f.start();assert.equal(f.asks.length,0);
  await f.send("ask_user",{reason:"확인"}); assert.equal(f.asks.length,1);
  assert.equal(f.events.at(-1).event.kind,"observation");
});

test("무인 humanRequired 조작 응답도 사용자 대기 없이 기록한다",{timeout:1500},async()=>{
  const f=fixture(policy,{neverAsk:true,data:{humanRequired:true,reason:"결제"}}); await f.start();await f.row();
  const response=await f.send("click",{x:1,y:2}); assert.equal(response.data.blocked,true);assert.equal(f.asks.length,0);
});

test("조사 상한은 첫 미해결 실패부터 계산하며 조작을 거부하고 blocked 후 해제한다",async()=>{
  const f=fixture(policy);await f.start();await f.row();
  await f.ledger.append(f.run,{kind:"assertion",rowId:"row",pass:false}); f.events.at(-1).event.at=Date.now()-60001;
  const count=f.calls.length;
  const result=await f.send("click",{x:1,y:1}); assert.equal(result.ok,false);assert.match(result.error,/중단·미해결/);
  assert.equal(f.calls.length,count);
  assert.equal((await f.send("blocked",{reason:"중단·미해결"})).ok,true);
  assert.equal((await f.send("click",{x:1,y:1})).ok,true);
});

test("조사 상한은 다른 항목과 이미 결함 기록한 실패를 제외하고 재개해도 유지한다",async()=>{
  const events=[{seq:1,event:{kind:"run_begin",charter:policy}},{seq:2,event:{kind:"assertion",rowId:"a",pass:false,at:1000}},
    {seq:3,event:{kind:"action",rowId:"b",pass:false,at:2000}}];
  assert.throws(()=>assertQaInvestigationTime(events,[{id:"a"}],62000),/조사 상한/);
  assert.doesNotThrow(()=>assertQaInvestigationTime(events,[{id:"c"}],62000));
  events.push({seq:4,event:{kind:"defect",rowId:"a",detail:{failureSeq:2,failureSeqs:[2]}}});
  assert.doesNotThrow(()=>assertQaInvestigationTime(events,[{id:"a"}],62000));
  assert.throws(()=>assertQaInvestigationTime(events,[{id:"b"}],62000),/조사 상한/);
  const f=fixture(policy);await f.start();await f.row();await f.ledger.append(f.run,{kind:"action",rowId:"row",pass:false});f.events.at(-1).event.at=Date.now()-60001;
  const fresh=fixture(policy,{events:f.events});
  assert.equal((await fresh.channel("run_resume",{},"session",f.run)).ok,true);
  assert.equal((await fresh.channel("key",{key:"Tab"},"session",f.run)).ok,false);
  assert.equal(fresh.asks.length,0);
});

test("charter 변경으로 시작 승인이나 조사 상한을 늘릴 수 없다",async()=>{
  const f=fixture(policy);await f.start();
  for(const update of [{unattended:false},{approvals:{logins:["other"],bulkFill:true}},{investigationLimitMin:100}])
    await assert.rejects(recordQaSession({ledger:f.ledger,runId:f.run,cmd:"charter",args:{charter:{...qaCharter(),...policy,...update},reason:"범위 변경"}}),/새 회차/);
});


test("무인 대량 기입은 사전 승인 값으로 진행하고 미승인은 즉시 기록한다",{timeout:1500},async()=>{
  for(const allowed of [true,false]) {
    const f=fixture({...policy,approvals:{logins:[],bulkFill:allowed}},{neverAsk:true,plan:{surfaces:["https://example.test/result"]}});
    await f.start();
    const planned=await f.send("bulk_fill",{action:"plan",values:["one","two"]}); assert.equal(planned.ok,true);
    const result=await f.send("bulk_fill",{action:"commit",token:planned.data.token});
    assert.equal(result.ok,true);
    if(allowed) assert.equal(result.data.typed,2); else assert.equal(result.data.blocked,true);
    assert.equal(f.asks.length,0);
  }
});

test("사진 장부에 실행기 안정 정보와 대상·주소·화면 크기를 보존한다",async()=>{
  const stability={waitedMs:123,stable:false,remaining:["network"]};
  const f=fixture({}, {data:{stability,viewport:{width:800,height:600}}});await f.start();await f.row();
  await f.send("click",{x:1,y:1});await f.send("expect",{mode:"exists",sel:"body"});
  const photos=f.events.filter(r=>r.event.shot);
  assert.ok(photos.length>=3);
  for(const {event} of photos) {
    assert.deepEqual(event.stability,stability);assert.equal(event.captureTarget.id,"web");
    assert.deepEqual(event.viewport,{width:800,height:600});assert.match(event.url,/example.test/);
  }
  assert.ok(f.calls.some(c=>c.cmd === "qa-reaction-start"));
  assert.ok(f.calls.some(c=>c.cmd === "qa-reaction-end"));
});

test("무인 로그인은 승인한 계정 이름이 저장 계정 ID로 변환되어도 재질문하지 않는다",{timeout:1500},async()=>{
  const f=fixture({...policy,approvals:{logins:["tester"],bulkFill:false}}, {neverAsk:true,
    login:{accounts:[{id:"origin-account-hash",username:"tester",allowed:false}],selectedAccount:"origin-account-hash"}});
  await f.start();
  const result=await f.send("login",{account:"tester"});
  assert.equal(result.ok,true);assert.equal(result.data.filled,1);
  assert.equal(f.asks.length,0);
  const input=f.calls.find(call=>call.cmd === "qa-login-input");
  assert.equal(input.args.accountId,"origin-account-hash");assert.equal(input.args.approved,true);
});

test("무인 로그인은 승인 계정 이름으로 다른 직접 입력 값을 보낼 수 없다",{timeout:1500},async()=>{
  const f=fixture(policy,{neverAsk:true,...remote});await f.start();
  const result=await f.send("login",{account:"account",fields:[{x:1,y:1,text:"other-user"}]});
  assert.equal(result.ok,true);assert.equal(result.data.humanRequired,true);assert.equal(result.data.blocked,true);
  assert.match(result.data.next,/다음 항목/);assert.equal(f.asks.length,0);
  assert.equal(f.calls.some(call=>call.cmd === "qa-input" || call.cmd === "qa-login-input"),false);
});

for(const cmd of ["select","login","bulk_fill"]) test(`무인 ${cmd} 중 사람 필요 응답은 이후 입력을 중단하고 막힘을 반환`,{timeout:1500},async()=>{
  const blockedAction=cmd === "bulk_fill" ? "type":"click";
  const f=fixture(policy,{neverAsk:true,plan:{surfaces:["https://example.test/result"]},execute:async(command,args)=>{
    if(command === "qa-select-resolve") return {ok:true,data:{index:1,keySteps:1,typeahead:{char:"가",count:1},selectedIndex:1}};
    if(command === "qa-input" && args.action === blockedAction) return {ok:false,humanRequired:true,reason:"본인확인"};
  }});
  await f.start();
  if(cmd !== "bulk_fill") await f.row();
  let args;
  if(cmd === "select") args={x:1,y:1,index:1};
  else if(cmd === "login") args={account:"account"};
  else {
    const plan=await f.send("bulk_fill",{action:"plan",values:["one","two"]});
    assert.equal(plan.ok,true);args={action:"commit",token:plan.data.token};
  }
  const result=await f.send(cmd,args);
  assert.equal(result.ok,true);assert.equal(result.data.humanRequired,true);assert.equal(result.data.blocked,true);
  assert.match(result.data.next,/다음 항목/);assert.equal(f.asks.length,0);
  assert.deepEqual(f.calls.filter(call=>call.cmd === "qa-input").map(call=>call.args.action),[blockedAction]);
  assert.equal(f.calls.some(call=>call.cmd === "qa-login-input"),false);
  assert.equal(f.events.some(record=>record.event.kind === "observation" && record.event.cmd === cmd && record.event.pass),false);
  assert.equal(f.events.at(-1).event.kind,cmd === "bulk_fill" ? "session_note":"blocked");
});

test("무인 경로 재생의 사람 필요 응답은 다음 단계 전에 막힘을 반환",{timeout:1500},async()=>{
  const step={origin:"http://localhost:4291",cmd:"click",target:{role:"button",name:"Continue"},arrival:{mode:"exists",sel:"body"}};
  const f=fixture(policy,{neverAsk:true,execute:async(command)=>{
    if(command === "url") return {ok:true,data:{url:"http://localhost:4291/start"}};
    if(command === "qa-locate") return {ok:true,data:{at:{x:1,y:1}}};
    if(command === "qa-input") return {ok:false,humanRequired:true,reason:"경로 재생 중 본인확인"};
  },makeRoutes:({executor})=>({list:async()=>[],replay:async({runId})=>{
    await executor({runId,step,params:{}});
    await executor({runId,step,params:{}});
  }})});
  await f.start();
  const result=await f.send("route_replay",{name:"continue"});
  assert.equal(result.ok,true);assert.equal(result.data.humanRequired,true);assert.equal(result.data.blocked,true);
  assert.match(result.data.next,/다음 항목/);assert.equal(f.asks.length,0);
  assert.equal(f.calls.filter(call=>call.cmd === "qa-input").length,1);
  assert.equal(f.events.filter(record=>record.event.kind === "session_note" && record.event.detail.kind === "막힘").length,1);
});
