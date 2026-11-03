import os from "node:os";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createQaChannel } from '../server/qa-channel.js';
import { deriveQaRemediation, assertQaRemediationComplete } from '../server/qa-remediation.js';
import { playQaSteps } from '../server/qa-play.js';
import { recordReactionJudgments, loadReactionCatalogForRun, verifyReactionSource, catalogPath } from '../server/qa-catalog.js';
import { validateQaCommand } from '../server/qa-protocol.js';

const root=path.join(fs.realpathSync(os.tmpdir()),'impl8-checks');fs.mkdirSync(root,{recursive:true});
const home=fs.mkdtempSync(path.join(root,'play7-'));process.env.IRIS_STATE_DIR=home;
const repo=process.cwd(),oracle='기능의 용도';
const expect={effects:[{type:'appear',text:'저장됨',oracle}],within:100};
const target={role:'button',name:'저장'};
const step={target,action:'click',expect};
const charter={question:'저장 결과를 볼 수 있는가',scope:'저장',exclusions:'외부 서비스',environment:'격리 fixture',sharedEnvironment:false,timebox:'1분',people:'없음',documents:'fixture'};
const session={work:'저장',curios:'없음',checked:'저장',unverified:{items:'없음',reason:'해당 없음'},blockers:'없음',outOfScope:'없음',risks:'없음',stopCriterion:'questions_answered',remainingQuestions:'없음'};
const plan={entries:['http://localhost:4321'],build:{repo},risks:[{id:'save',risk:'저장 결과가 누락될 수 있다',size:'high',knowledge:'some',decision:'test'}],listRationale:'저장 결과 관찰'};
const row={action:'declare',id:'row1',what:'저장 결과',given:'저장 화면',basis:'spec',basisNote:'저장 명세',paths:['정상'],risk:['save'],oracle:'기능의 용도: 저장 확인',dataChanging:false,mustNotChange:{notApplicable:true,reason:'화면 결과만 확인'}};
const review={information:[{row:'row1',text:'저장 결과 표시'}],duplicates:[],distribution:'정상 경로의 저장 결과 확인',missingRisks:'외부 소비자는 이번 fixture에 없음'};
function fixture(overrides={}){
  const events=[],sent=[];let serial=0;
  const append=async(_id,event)=>{const r={seq:events.length+1,event:structuredClone(event)};events.push(r);return r;};
  const ledger={append,begin:({runId,session,plan,charter})=>append(runId,{kind:'run_begin',session,plan,charter}),verify:async()=>({events:structuredClone(events)}),end:(id,args)=>append(id,{kind:'run_end',sessionRecord:args.session})};
  const call=createQaChannel({ledger,makeRoutes:()=>({list:async()=>[]}),createEntry:async()=>({ok:true,data:{tabId:'tab'}}),release:async()=>{},ask:async()=>({ok:true}),
    execute:async(_tab,cmd,args)=>{sent.push({cmd,args});let data;
      if(overrides.execute)data=await overrides.execute(cmd,args,sent);
      if(data)return {ok:true,data};
      if(cmd==='qa-background-observe')data={candidates:[],unexpected:[],scenes:[]};
      else if(cmd==='qa-target-resolve')data={found:true,x:10,y:20,occluded:false};
      else if(cmd==='qa-reaction-start')data={id:'r'+(++serial),scenes:[]};
      else if(cmd==='qa-reaction-end')data={pass:true,effects:[],candidates:[],unexpected:[],scenes:[]};
      else data={trusted:true,pass:true,url:'http://localhost:4321',path:path.join(home,'missing.png')};
      return {ok:true,data};}});
  return {events,sent,call,async begin(){const r=await call('run_begin',{plan,charter},'session');assert.equal(r.ok,true,r.error);this.run=r.data.runId;await this.send('open_entry',{url:plan.entries[0]});},send(cmd,args={}){return call(cmd,args,'session',this.run);},async open(declaration=row){const r=await this.send('row',declaration);assert.equal(r.ok,true,r.error);await this.send('row',{action:'open',row:declaration.id,path:'정상'});await this.send('list_review',{review});}};
}

test('수정은 retestOf 통과 및 영향 row 재실행 전 미확인',async()=>{
 const f=fixture();await f.begin();await f.open();
 const add=e=>{const r={seq:f.events.length+1,event:e};f.events.push(r);return r.seq;};
 const failure=add({kind:'reaction',pass:false,rowId:'row1',expected:expect});
 const defect=add({kind:'defect',rowId:'row1',detail:{failureSeq:failure,problem:'저장 실패'}});
 const fix=add({kind:'fix',detail:{defect,commit:'a',affectedRows:['row1','other']}});
 assert.equal(deriveQaRemediation(f.events).defects[0].status,'수정 미확인');
 await f.send('play',{steps:[step]});
 add({kind:'play_result',rowId:'other',detail:{pass:true}});
 assert.equal(deriveQaRemediation(f.events).defects[0].status,'수정 미확인');
 add({kind:'fix',detail:{defect,commit:'a',affectedRows:['row1','other']}});
 const r=await f.send('play',{steps:[step],retestOf:{run:f.run,defect}});assert.equal(r.ok,true,r.error);
 assert.equal(deriveQaRemediation(f.events).defects[0].status,'수정 미확인');
 add({kind:'play_result',rowId:'other',detail:{pass:true}});
 assert.equal(deriveQaRemediation(f.events).defects[0].status,'수정 확인');
 assert.doesNotThrow(()=>assertQaRemediationComplete(f.events));
});
test('영향 row의 이전 통과 뒤 재실패는 회귀 결함',async()=>{
 const f=fixture({execute:cmd=>cmd==='qa-reaction-end'?{pass:false,effects:[],candidates:[],unexpected:[],scenes:[]}:null});
 await f.begin();await f.open();
 f.events.push({seq:f.events.length+1,event:{kind:'play_result',rowId:'row1',detail:{pass:true}}});
 f.events.push({seq:f.events.length+1,event:{kind:'fix',detail:{defect:999,commit:'a',affectedRows:['row1']}}});
 const r=await f.send('play',{steps:[step]});assert.equal(r.ok,true,r.error);
 const defect=f.events.findLast(r=>r.event.kind==='defect');assert(defect?.event.detail.regressionOf);
 assert.equal(f.events.find(r=>r.seq===defect.event.detail.failureSeq).event.pass,false);
});
test('재실행 필요와 미해결 결함은 종료 거부, 이유 있는 사람 확인 허용',async()=>{
 const f=fixture();await f.begin();await f.open();
 f.events.push({seq:f.events.length+1,event:{kind:'defect',rowId:'row1',detail:{problem:'문제'}}});
 const defect=f.events.at(-1).seq;
 f.events.push({seq:f.events.length+1,event:{kind:'retest_required',detail:{row:'row1'}}});
 assert.throws(()=>assertQaRemediationComplete(f.events),/재실행 필요/);
 const noReason=await f.send('review',{decisions:[{row:'row1',reason:''}]});assert.equal(noReason.ok,false);
 const rowOnly=await f.send('review',{decisions:[{row:'row1',reason:'실제 결제 필요'}]});assert.equal(rowOnly.ok,true,rowOnly.error);
 assert.throws(()=>assertQaRemediationComplete(f.events),/판정이 필요한 결함/);
 const done=await f.send('review',{decisions:[{defect,reason:'본인확인 필요'}]});assert.equal(done.ok,true,done.error);
 assert.doesNotThrow(()=>assertQaRemediationComplete(f.events));
});
test('모르는 가림 처리 등록 뒤 해당 row 재실행 필요',async()=>{
 const f=fixture({execute:cmd=>cmd==='qa-target-resolve'?{found:true,x:10,y:20,occluded:true,blocker:{sel:'#overlay',text:'도움'}}:null});
 await f.begin();await f.open();await f.send('play',{steps:[step]});
 const item=(await f.send('review')).data.items[0];assert(item);
 const judged=await f.send('unexpected',{id:item.id,class:'방해 화면',condition:{sel:'#overlay'},source:'server/qa-play.js:1',cause:'도움말',handler:{method:'escape',expect:{effects:[{type:'disappear',text:'도움',oracle}]}}});
 assert.equal(judged.ok,true,judged.error);
 assert.equal(deriveQaRemediation(f.events).pendingRows[0]?.row,'row1');
});
test('두 번째 수정의 재실패는 마지막 시도와 고치지 못함 기록',async()=>{
 const f=fixture({execute:cmd=>cmd==='qa-reaction-end'?{pass:false,effects:[],candidates:[],unexpected:[],scenes:[]}:null});await f.begin();await f.open();
 const add=e=>{const r={seq:f.events.length+1,event:e};f.events.push(r);return r.seq;};
 const failure=add({kind:'reaction',rowId:'row1',pass:false,expected:expect});const defect=add({kind:'defect',rowId:'row1',detail:{failureSeq:failure}});
 add({kind:'fix',detail:{defect,commit:'first',affectedRows:['row1']}});add({kind:'fix',detail:{defect,commit:'last',affectedRows:['row1']}});
 const r=await f.send('play',{steps:[step],retestOf:{run:f.run,defect}});assert.equal(r.ok,true,r.error);
 const last=f.events.findLast(r=>r.event.kind==='fix').event.detail;assert.equal(last.status,'고치지 못함');assert.equal(last.lastAttempt.commit,'last');
});
test('실패로 자동 종료한 항목의 qa_defect는 K1 seq와 row를 보존',async()=>{
 const f=fixture({execute:cmd=>cmd==='qa-reaction-end'?{pass:false,effects:[],candidates:[],unexpected:[],scenes:[]}:null});await f.begin();await f.open();
 await f.send('play',{steps:[step]});
 const d=await f.send('defect',{problem:'헤더 갱신 누락',oracle:'기능의 용도',oracleNote:'저장 결과 표시',importance:'저장 결과를 알 수 없음',reproducible:'가끔 재현됨',tried:'저장 한 번'});
 assert.equal(d.ok,true,d.error);assert.equal(d.data.event.detail.rowId,'row1');
 assert.equal(f.events.find(r=>r.seq===d.data.event.detail.failureSeq).event.kind,'reaction');
});
test('run_end는 닫힌 row라도 재실행 필요가 있으면 거부',async()=>{
 const f=fixture();await f.begin();await f.open();await f.send('play',{steps:[step]});
 await f.send('row',{action:'close',row:'row1',path:'정상',color:'green',note:'효과 확인',sceneJudgment:'저장 표시 확인'});
 f.events.push({seq:f.events.length+1,event:{kind:'retest_required',detail:{row:'row1'}}});
 const result=await f.send('run_end',{session});assert.equal(result.ok,false);assert.match(result.error,/재실행 필요/);
});
test('사람 확인으로 넘긴 모르는 가림은 다음 항목을 막지 않는다',async()=>{
 const f=fixture({execute:cmd=>cmd==='qa-target-resolve'?{found:true,x:1,y:1,occluded:true,blocker:{sel:'#unknown'}}:null});await f.begin();await f.open();await f.send('play',{steps:[step]});
 const deferred=await f.send('review',{decisions:[{row:'row1',reason:'본인확인 화면 처리에는 사람 필요'}]});assert.equal(deferred.ok,true,deferred.error);
 assert.equal((await f.send('review')).data.items.length,0);
 assert.equal((await f.send('run_end',{session})).ok,true);
});
test('모든 경로 재실행과 통과 뒤 새 실패를 수정 확인에 반영',()=>{
 const events=[];const add=event=>{events.push({seq:events.length+1,event});return events.length;};
 add({kind:'row',action:'declare',rowId:'save',rowData:{paths:['정상','경계']}});
 const defect=add({kind:'defect',rowId:'save',detail:{problem:'저장'}});
 add({kind:'play_result',rowId:'save',path:'경계',detail:{pass:true}});
 const fix=add({kind:'fix',detail:{defect,commit:'c',affectedRows:['save']}});
 add({kind:'play_result',rowId:'save',path:'정상',detail:{pass:true,retestOf:{run:'run',defect},retestFix:{seq:fix,commit:'c'}}});
 assert.equal(deriveQaRemediation(events).defects[0].status,'수정 미확인');
 assert.throws(()=>assertQaRemediationComplete(events),/재실행 필요/);
 add({kind:'play_result',rowId:'save',path:'경계',detail:{pass:true}});
 assert.equal(deriveQaRemediation(events).defects[0].status,'수정 확인');
 add({kind:'reaction',rowId:'save',path:'정상',pass:false});
 assert.equal(deriveQaRemediation(events).defects[0].status,'수정 미확인');
 assert.throws(()=>assertQaRemediationComplete(events),/재실행 필요/);
});
test('수정 재실행에서 원래 조작이나 기대를 바꾸면 입력 전 거부',async()=>{
 const f=fixture();await f.begin();await f.open();
 await f.send('play',{steps:[step]});
 const failure={seq:f.events.length+1,event:{kind:'reaction',rowId:'row1',pass:false,expected:expect}};f.events.push(failure);
 const defect={seq:f.events.length+1,event:{kind:'defect',rowId:'row1',detail:{failureSeq:failure.seq}}};f.events.push(defect);
 f.events.push({seq:f.events.length+1,event:{kind:'fix',detail:{defect:defect.seq,commit:'c',affectedRows:['row1']}}});
 const count=f.sent.filter(s=>s.cmd==='qa-input').length;
 const result=await f.send('play',{retestOf:{run:f.run,defect:defect.seq},steps:[{...step,target:{role:'button',name:'도움말'},expect:{effects:[{type:'appear',text:'도움',oracle}],within:100}}]});
 assert.equal(result.ok,false);assert.match(result.error,/원래 (항목|실패 기대값)/);assert.equal(f.sent.filter(s=>s.cmd==='qa-input').length,count);
});
test('실패를 만든 play의 조작을 바꾸면 같은 기대라도 거부',async()=>{
 const f=fixture({execute:cmd=>cmd==='qa-reaction-end'?{pass:false,effects:[],candidates:[],unexpected:[],scenes:[]}:null});await f.begin();await f.open();await f.send('play',{steps:[step]});
 const d=await f.send('defect',{problem:'헤더 갱신 누락',oracle:'기능의 용도',oracleNote:'저장 결과 표시',importance:'저장 확인',reproducible:'가끔 재현됨',tried:'저장 한 번'});assert.equal(d.ok,true,d.error);
 f.events.push({seq:f.events.length+1,event:{kind:'fix',detail:{defect:d.data.seq,commit:'c',affectedRows:['row1']}}});
 await f.send('row',{action:'open',row:'row1',path:'정상'});
 const result=await f.send('play',{retestOf:{run:f.run,defect:d.data.seq},steps:[{...step,target:{role:'button',name:'다른 버튼'}}]});
 assert.equal(result.ok,false);assert.match(result.error,/원래 항목/);
});

// 무인 실측 e2e5: 새 항목에서 재실행하면 원래 실행을 못 찾고, 기대값을 손으로 다시 적다가 자동으로 붙은 기대 때문에 매번 거부됨
test('retestOf만 넣은 play는 실패 판정을 만든 원래 단계를 다른 항목에서도 그대로 실행',async()=>{
  let fail=true;
  const f=fixture({execute:cmd=>cmd==='qa-reaction-end'&&fail?{pass:false,effects:[],candidates:[],unexpected:[],scenes:[]}:null});await f.begin();await f.open();
  assert.equal((await f.send('play',{steps:[step]})).ok,true);
  const d=await f.send('defect',{problem:'헤더 갱신 누락',oracle:'기능의 용도',oracleNote:'저장 결과 표시',importance:'저장 확인',reproducible:'가끔 재현됨',tried:'저장 한 번'});assert.equal(d.ok,true,d.error);
  f.events.push({seq:f.events.length+1,event:{kind:'fix',detail:{defect:d.data.seq,commit:'c',affectedRows:['row1']}}});
  fail=false;
  const declared=await f.send('row',{...row,id:'row1-r',retestOf:{run:f.run,defect:d.data.seq}});assert.equal(declared.ok,true,declared.error);
  const reviewed=await f.send('list_review',{review:{...review,information:[...review.information,{row:'row1-r',text:'수정 뒤 재실행'}],duplicates:[{rows:['row1','row1-r'],decision:'split',reason:'수정 전 실패와 수정 뒤 재실행'}]}});assert.equal(reviewed.ok,true,reviewed.error);
  assert.equal((await f.send('row',{action:'open',row:'row1-r',path:'정상'})).ok,true);
  const before=f.sent.filter(x=>x.cmd==='qa-input').length;
  const result=await f.send('play',{retestOf:{run:f.run,defect:d.data.seq}});
  assert.equal(result.ok,true,result.error);
  assert.equal(f.sent.filter(x=>x.cmd==='qa-input').length,before+1);
  const played=f.events.findLast(r=>r.event.kind==='play_result');
  assert.equal(played.event.rowId,'row1-r');
  assert.deepEqual(played.event.detail.steps,f.events.find(r=>r.event.kind==='play_result').event.detail.steps);
  assert.equal(played.event.detail.pass,true);
});
test('steps 없는 play는 retestOf 없이 거부',()=>{
  assert.throws(()=>validateQaCommand('play',{}),/단계가 필요합니다/);
});
