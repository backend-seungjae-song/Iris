import os from "node:os";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createQaChannel } from '../server/qa-channel.js';

const root=path.join(fs.realpathSync(os.tmpdir()),'qa-rerun12');fs.mkdirSync(root,{recursive:true});
const home=fs.mkdtempSync(path.join(root,'state-'));process.env.IRIS_STATE_DIR=home;
const repo=process.cwd(),oracle='기능의 용도';
const save={role:'button',name:'저장'},field={role:'textbox',name:'이름'};
const charter={question:'저장한 이름이 보이는가',scope:'이름 저장',exclusions:'외부 서비스',environment:'격리 fixture',sharedEnvironment:false,timebox:'1분',people:'없음',documents:'fixture'};
const plan={entries:['http://localhost:4321'],build:{repo},risks:[{id:'save',risk:'저장한 이름이 제목에 안 보일 수 있다',size:'high',knowledge:'some',decision:'test'}],listRationale:'저장 결과 관찰'};
const declaration=(rerun,extra={})=>({action:'declare',id:'row1',what:'이름 저장 뒤 제목',given:'이름 저장 화면',basis:'spec',basisNote:'저장 명세',paths:['정상'],risk:['save'],oracle:'기능의 용도: 저장한 이름 표시',
  dataChanging:true,consumers:['server/qa-play.js:1'],mustNotChange:{notApplicable:true,reason:'입력 칸과 제목만 확인'},...(rerun?{rerun}:{}),...extra});
const review={information:[{row:'row1',text:'저장한 이름 표시'}],duplicates:[],distribution:'정상 경로의 저장 결과 확인',missingRisks:'외부 소비자는 이번 fixture에 없음'};
const typed=text=>({target:field,action:'type',text,expect:{effects:[{type:'change',sel:'#name',to:text,oracle}],within:100}});
const click=to=>({target:save,action:'click',expect:{effects:[{type:'change',sel:'#title',to,oracle}],within:100}});

function fixture(){
  const events=[],sent=[];let serial=0;
  const append=async(_id,event)=>{const r={seq:events.length+1,event:structuredClone(event)};events.push(r);return r;};
  const ledger={append,begin:({runId,session,plan,charter})=>append(runId,{kind:'run_begin',session,plan,charter}),verify:async()=>({events:structuredClone(events)}),end:(id,args)=>append(id,{kind:'run_end',sessionRecord:args.session})};
  const call=createQaChannel({ledger,makeRoutes:()=>({list:async()=>[]}),createEntry:async()=>({ok:true,data:{tabId:'tab'}}),release:async()=>{},ask:async()=>({ok:true}),
    execute:async(_tab,cmd,args)=>{sent.push({cmd,args:structuredClone(args)});let data;
      if(cmd==='qa-background-observe')data={candidates:[],unexpected:[],scenes:[]};
      else if(cmd==='qa-target-resolve')data={found:true,x:10,y:20,occluded:false};
      else if(cmd==='qa-reaction-start')data={id:'r'+(++serial),scenes:[]};
      else if(cmd==='qa-reaction-end')data={pass:true,effects:[],candidates:[],unexpected:[],scenes:[]};
      else data={trusted:true,pass:true,url:'http://localhost:4321',path:path.join(home,'missing.png')};
      return {ok:true,data};}});
  const f={events,sent,
    async begin(){const r=await call('run_begin',{plan,charter},'session');assert.equal(r.ok,true,r.error);f.run=r.data.runId;await f.send('open_entry',{url:plan.entries[0]});},
    send:(cmd,args={})=>call(cmd,args,'session',f.run),
    async open(rerun){const r=await f.send('row',declaration(rerun));assert.equal(r.ok,true,r.error);await f.send('row',{action:'open',row:'row1',path:'정상'});await f.send('list_review',{review});},
    // 수정 커밋이 row1 에 영향을 준 상태
    fixed(){f.events.push({seq:f.events.length+1,event:{kind:'fix',detail:{defect:999,commit:'a',affectedRows:['row1']}}});},
    reopen:()=>f.send('row',{action:'open',row:'row1',path:'정상'}),
  };
  return f;
}
const expected=(text,message)=>{assert.equal(text.ok,false);assert.match(text.error,message);};

test('데이터를 바꾸는 항목은 재실행 방식 없이 선언할 수 없다',async()=>{
  const f=fixture();await f.begin();
  expected(await f.send('row',declaration()),/declare\.rerun: 데이터를 바꾸는 항목은 수정 뒤 다시 실행할 방식을 정합니다/);
  expected(await f.send('row',declaration({mode:'setup',reason:''})),/rerun\.reason/);
  const ok=await f.send('row',declaration({mode:'setup',reason:'이름을 먼저 다른 값으로 저장할 수 있음'}));
  assert.equal(ok.ok,true,ok.error);
  assert.deepEqual(f.events.findLast(r=>r.event.kind==='row').event.rowData.rerun,{mode:'setup',reason:'이름을 먼저 다른 값으로 저장할 수 있음'});
});

test('setup 항목은 준비 단계를 앞에 두고 수정 뒤 재실행에서 준비 단계부터 다시 실행한다',async()=>{
  const f=fixture();await f.begin();await f.open({mode:'setup',reason:'이름을 먼저 이로 저장'});
  const steps=[{...typed('이'),setup:true},{...click('저장 완료: 이'),setup:true},typed('김'),click('저장 완료: 김')];
  expected(await f.send('play',{steps:steps.map(({setup,...step})=>step)}),/rerun\.mode가 setup입니다/);
  expected(await f.send('play',{steps:[steps[2],{...steps[0]}]}),/setup 단계는 확인할 조작 단계보다 앞에/);
  expected(await f.send('play',{steps:steps.slice(0,2)}),/setup 단계 뒤에 확인할 조작 단계가 필요합니다/);
  const first=await f.send('play',{steps});assert.equal(first.ok,true,first.error);
  const before=f.sent.filter(s=>s.cmd==='qa-reaction-start').length;
  f.fixed();await f.reopen();
  const again=await f.send('play',{steps});assert.equal(again.ok,true,again.error);
  assert.equal(f.sent.filter(s=>s.cmd==='qa-reaction-start').length-before,4,'준비 단계 2개와 확인 단계 2개를 모두 다시 실행');
  assert.deepEqual(f.events.filter(r=>r.event.kind==='play_step').slice(-4).map(r=>r.event.detail.setup===true),[true,true,false,false],'기록에 준비 단계 표시');
});

test('setup 단계와 {{unique}}는 선언한 방식의 항목에만 쓴다',async()=>{
  const f=fixture();await f.begin();await f.open({mode:'generated',reason:'이름은 자유 입력'});
  expected(await f.send('play',{steps:[{...typed('kim-{{unique}}'),setup:true},click('저장 완료: kim-{{unique}}')]}),/setup 단계는 rerun\.mode가 setup인 항목에만/);
  expected(await f.send('play',{steps:[typed('김'),click('저장 완료: 김')]}),/rerun\.mode가 generated입니다/);
  const g=fixture();await g.begin();await g.open({mode:'setup',reason:'이름을 먼저 저장'});
  expected(await g.send('play',{steps:[{...typed('이'),setup:true},typed('kim-{{unique}}')]}),/\{\{unique\}\}는 rerun\.mode가 generated인 항목에만/);
});

test('generated 항목은 실행마다 다른 값으로 입력·기대하고 원래 단계와는 치환 전 단계로 대조한다',async()=>{
  const f=fixture();await f.begin();await f.open({mode:'generated',reason:'이름은 자유 입력이라 실행마다 새 값 사용'});
  const steps=[typed('kim-{{unique}}'),click('저장 완료: kim-{{unique}}')];
  const first=await f.send('play',{steps});assert.equal(first.ok,true,first.error);
  f.fixed();await f.reopen();
  const again=await f.send('play',{steps});assert.equal(again.ok,true,again.error);
  const results=f.events.filter(r=>r.event.kind==='play_result').map(r=>r.event.detail);
  assert.equal(results.length,2);
  for(const result of results)assert.deepEqual(result.steps,steps,'기록은 치환 전 단계');
  assert.notEqual(results[0].unique,results[1].unique,'실행마다 다른 값');
  const typedTexts=f.sent.filter(s=>s.cmd==='qa-reaction-start').map(s=>JSON.stringify(s.args.expect));
  assert(typedTexts.some(text=>text.includes(`kim-${results[0].unique}`)) && typedTexts.some(text=>text.includes(`kim-${results[1].unique}`)));
  assert.equal(typedTexts.some(text=>text.includes('{{unique}}')),false,'실제 기대에는 치환한 값');
});

test('human 항목은 수정 뒤 재실행을 거부하고 사람 확인으로 넘긴다',async()=>{
  const f=fixture();await f.begin();await f.open({mode:'human',reason:'저장한 이름을 되돌릴 화면이 없음'});
  const steps=[typed('김'),click('저장 완료: 김')];
  const first=await f.send('play',{steps});assert.equal(first.ok,true,first.error);
  f.fixed();await f.reopen();
  expected(await f.send('play',{steps}),/사람 확인으로 선언했습니다\(저장한 이름을 되돌릴 화면이 없음\)\. 다시 실행하지 않고 qa_review decisions/);
  const deferred=await f.send('review',{decisions:[{row:'row1',reason:'저장한 이름을 되돌릴 화면이 없음'}]});
  assert.equal(deferred.ok,true,deferred.error);
});
