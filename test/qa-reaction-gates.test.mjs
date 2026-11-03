import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createQaChannel} from '../server/qa-channel.js';
import {qaCharter,qaSession, qaPlan } from './qa-fixtures.mjs';
const expect={effects:[{type:'appear',text:'저장됨',oracle:'기능의 용도'}],within:50};
async function fixture(pass=true) {
 fs.rmSync(path.join(process.env.IRIS_STATE_DIR,"qa-reactions"),{recursive:true,force:true});
 const events=[],calls=[];
 const append=async(_,event)=>{const r={seq:events.length+1,event:structuredClone(event)};events.push(r);return r;};
 const ledger={append,begin:async a=>append(a.runId,{kind:'run_begin',...a}),verify:async()=>({events}),end:async()=>({})};
 const channel=createQaChannel({ledger,createEntry:async()=>({ok:true,data:{tabId:'t'}}),release:async()=>{},makeRoutes:()=>({list:async()=>[]}),execute:async(_tab,cmd)=>{
  calls.push(cmd);
  if(cmd==='qa-reaction-start')return {ok:true,data:{id:'r',scenes:[{id:'s1',path:'s1.png',claim:{kind:'S1',description:'저장 클릭'}}]}};
  if(cmd==='qa-reaction-end')return {ok:true,data:{pass,effects:[{id:'e1',observed:pass,sceneId:pass?'s2':null}],candidates:[{id:'err',code:pass?'K2':'K1',description:'확인할 반응',sceneId:'s3'}],unexpected:[],scenes:[...(pass?[{id:'s2',path:'s2.png',claim:{kind:'S2',effectId:'e1',description:'저장됨'}}]:[]),{id:'s3',path:'s3.png',claim:{kind:'S3',description:'판정'}}],observation:{console:[{text:'오류'}],network:[{status:500}],exceptions:[{text:'예외'}]}}};
  return {ok:true,data:{trusted:true,path:'shot.png',shot:'shot.png',pass:true,url:'http://localhost/'}};
 }});
 const run=(await channel('run_begin',{plan:qaPlan({entries:['http://localhost/']}),charter:qaCharter()},'s')).data.runId;
 const send=(cmd,args={})=>channel(cmd,args,'s',run);await send('open_entry',{url:'http://localhost/'});return {send,events,calls};
}
test('미판단 후보는 다음 조작을 허용하고 run_end를 거부한다',async()=>{
 const f=await fixture();const r=await f.send('click',{x:1,y:1,expect});assert.equal(r.data.pass,true);const item=r.data.reactions.items[0];assert.ok(item.sceneSeq);
 assert.equal((await f.send('snapshot')).ok,true);
 assert.equal((await f.send('click',{x:1,y:1,expect})).ok,true);
 const blocked=await f.send('run_end',{session:qaSession()});assert.equal(blocked.ok,false);assert.match(blocked.error,/반응 판단/);
 assert.equal((await f.send('unexpected',{id:item.id,class:'무관 반응',source:'미확인',attempts:['시험 실행기에서 오류 후보 생성 경로 확인'],cause:'시험 페이지가 의도한 오류',condition:{code:'K2'}})).ok,true);assert.equal((await f.send('run_end',{session:qaSession()})).ok,true);
});
test('기대 미관찰은 S3 재사용과 콘솔·네트워크·예외 보존',async()=>{
 const f=await fixture(false);const r=await f.send('click',{x:1,y:1,expect});assert.equal(r.data.pass,false);const failure=f.events.find(x=>x.event.kind==='failure');assert.equal(failure.event.shot,'s3.png');assert.equal(failure.event.detail.console[0].text,'오류');assert.equal(failure.event.detail.network[0].status,500);assert.equal(failure.event.detail.exceptions[0].text,'예외');assert.ok(!f.calls.includes('screenshot'));
});
test('문제로 판단한 후보는 결함 기록 전 run_end를 거부한다',async()=>{
 const f=await fixture();const r=await f.send('click',{x:1,y:1,expect});const judged=await f.send('unexpected',{id:r.data.reactions.items[0].id,class:'문제',source:'미확인',attempts:['시험 실행기에서 저장 오류 생성 경로 확인'],cause:'저장 오류',condition:{code:'K2'}});assert.equal(judged.ok,true,JSON.stringify(judged));const next=await f.send('run_end',{session:qaSession()});assert.equal(next.ok,false);assert.match(next.error,/qa_defect 필요|반응 판단/);
});
test('J3 판단 없는 종료는 장면을 추가하기 전에 거부한다',async()=>{
 const f=await fixture();const before=f.events.length;
 const result=await f.send('row',{action:'close',row:'r1',path:'정상',color:'green',note:'확인'});
 assert.equal(result.ok,false);assert.match(result.error,/sceneJudgment/);
 assert.equal(f.events.slice(before).filter(r=>r.event.claim?.kind==='S5').length,0);
});
// 무인 실측 e2e4·e2e7: 결함을 먼저 기록한 뒤 반응을 문제로 분류하면 연결할 방법이 없어 같은 결함을 두 번 기록함
test('문제로 분류한 반응은 이미 기록한 결함 seq에 연결할 수 있다',async()=>{
 const f=await fixture();const r=await f.send('click',{x:1,y:1,expect});
 const defect=await f.send('defect',{problem:'저장 오류',oracle:'기능의 용도',oracleNote:'저장 결과 표시',importance:'저장 확인',reproducible:'가끔 재현됨',tried:'저장 한 번'});assert.equal(defect.ok,true,JSON.stringify(defect));
 const judgment={id:r.data.reactions.items[0].id,class:'문제',source:'미확인',attempts:['시험 실행기에서 저장 오류 생성 경로 확인'],cause:'저장 오류',condition:{code:'K2'}};
 const wrong=await f.send('unexpected',{...judgment,defect:9999});assert.equal(wrong.ok,false);assert.match(wrong.error,/이 회차의 결함 seq/);
 const judged=await f.send('unexpected',{...judgment,defect:defect.data.seq});assert.equal(judged.ok,true,JSON.stringify(judged));
 const link=f.events.findLast(x=>x.event.kind==='unexpected_defect');assert.equal(link.event.detail.defectSeq,defect.data.seq);
 assert.equal(f.events.filter(x=>x.event.kind==='defect').length,1);
});
