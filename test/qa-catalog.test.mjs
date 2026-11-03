import os from "node:os";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { catalogStaleness,loadReactionCatalogForRun,recordReactionJudgments,reactionCatalogForAction,verifyReactionSource,matchCatalogReaction,classifyCatalogReaction,validateReactionJudgment } from '../server/qa-catalog.js';
import { qaPendingReactions } from '../server/qa-reaction.js';
const root=path.join(fs.realpathSync(os.tmpdir()),'impl7-checks');fs.mkdirSync(root,{recursive:true});process.env.IRIS_STATE_DIR=fs.mkdtempSync(path.join(root,'catalog7-'));
const repo=process.cwd(),source='server/qa-reaction.js:1',target={role:'button',name:'저장'};
const judgment={id:'x',class:'연관 반응',condition:{sel:'#header'},action:{kind:'click',target},expect:{effects:[{type:'change',sel:'#header',to:'완료',oracle:'기능의 용도'}]},source,cause:'저장 후 헤더 갱신',photo:'first.png'};
test('잘못된 source·줄·외부경로 거부, 미확인은 시도 필수',()=>{
  for(const value of ['missing.js:999','server/qa-reaction.js:999999','/etc/hosts:1','미확인'])assert.throws(()=>verifyReactionSource(value,{repo}));
  assert.equal(verifyReactionSource('미확인',{repo,attempts:['rg로 헤더 핸들러 검색']}).source,'미확인');
});
test('판단 입력에 식별조건 원인 연관기대 방해처리 필수',()=>{
  for(const key of ['condition','cause','source','action','expect']){const value={...judgment};delete value[key];assert.throws(()=>validateReactionJudgment(value,{repo}));}
  assert.throws(()=>validateReactionJudgment({...judgment,class:'방해 화면'},{repo}));
  assert.throws(()=>validateReactionJudgment({...judgment,class:'방해 화면',handler:{method:'wait',expect:judgment.expect}},{repo}));
});
test('출처해시·첫사진·회차·횟수 저장, 10회 미등장 재확인',()=>{
  const saved=recordReactionJudgments(repo,[judgment],{runId:'r1',runSeq:1,seq:2});
  recordReactionJudgments(repo,[{...judgment,count:3,photo:'second.png'}],{runId:'r2',runSeq:2,seq:3});
  assert.equal(saved.items[0].sourceHash.length,64);
  const loaded=loadReactionCatalogForRun(repo,{runSeq:12});assert.equal(loaded.items[0].needsReview,true);assert.equal(loaded.items[0].firstPhoto,'first.png');assert.equal(loaded.items[0].count,4);
  assert.equal(reactionCatalogForAction(loaded,{kind:'click',target}).length,1);assert.equal(reactionCatalogForAction(loaded,{kind:'click',target:{...target,name:'취소'}}).length,0);
});
test('파일해시 변경 또는 미확인은 재확인, 원래hash보존',()=>{
  const original={source,sourceHash:'old',lastRunSeq:2};assert.equal(catalogStaleness(original,{repo,runSeq:3}).needsReview,true);assert.equal(original.sourceHash,'old');
  assert.equal(catalogStaleness({source:'미확인'},{repo}).needsReview,true);
});
test('무관반응은 알려짐, 문제와 낡은 항목은 재판단',()=>{
  const items=[{key:'help',class:'무관 반응',condition:{sel:'#help',text:'도움'}},{key:'error',class:'문제',condition:{code:'K2'}}];
  assert.equal(matchCatalogReaction({items},{sel:'#other'}),null);
  assert.equal(classifyCatalogReaction({items},{sel:'#help',text:'도움말'}).known,true);
  assert.equal(classifyCatalogReaction({items},{code:'K2'}).recurrence,true);
  assert.equal(classifyCatalogReaction({items:[{...items[0],needsReview:true}]},{sel:'#help',text:'도움'}).known,false);
});
test('배경·모르는가림·문제재발 일괄검토, 반복판단 보존',()=>{
  const events=[{seq:1,event:{kind:'background_reaction',detail:{items:[{id:'b',shot:'b.png',text:'숫자'}]}}},
    {seq:2,event:{kind:'unknown_occlusion',detail:{id:'o',shot:'o.png',text:'도움'}}},
    {seq:3,event:{kind:'unexpected',detail:{id:'b',class:'배경 반응',verdict:'문제 아님'}}},
    {seq:4,event:{kind:'background_reaction',detail:{items:[{id:'b',count:3,lastAt:9}]}}},
    {seq:5,event:{kind:'reaction',detail:{candidates:[{id:'e',catalogClass:'문제',known:false,recurrence:true}]}}}];
  assert.deepEqual(qaPendingReactions(events).map(x=>x.id),['o','e']);
  events.push({seq:6,event:{kind:'unexpected',detail:{id:'e',class:'문제',verdict:'문제'}}});assert(qaPendingReactions(events).some(x=>x.id==='e'));
  events.push({seq:7,event:{kind:'unexpected_defect',detail:{id:'e',defectSeq:8}}});assert.deepEqual(qaPendingReactions(events).map(x=>x.id),['o']);
});
