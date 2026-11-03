import os from "node:os";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createQaLedger } from '../server/qa-ledger.js';
import { createQaChannel } from '../server/qa-channel.js';
import { deriveQaRows } from '../server/qa-rows.js';
import { qaPendingReactions } from '../server/qa-reaction.js';

const require=createRequire(import.meta.url);
const {createQaLedgerAnchor}=require('../native/electron/qa-ledger-anchor.cjs');
const root=path.join(fs.realpathSync(os.tmpdir()),'impl7-checks');
fs.mkdirSync(root,{recursive:true});
const repo=path.resolve(import.meta.dirname,'..');
const url='http://127.0.0.1:4397/round7/';
const target={role:'button',name:'저장'};
const oracle='기능의 용도';
const expectation={effects:[{type:'appear',text:'저장됨',oracle}],within:1000};
const charter={question:'수행자가 저장과 가림을 실제 입력 경로로 확인할 수 있는가?',scope:'저장·가림·앱 목록',exclusions:'실제 앱',environment:'파일 장부와 native adapter',sharedEnvironment:false,timebox:'1분',people:'없음',documents:'7차 계약'};
const session={work:'저장·가림 확인',curios:'없음',checked:'기대와 입력 영수증',unverified:{items:'실제 앱',reason:'계약 통합 검사'},blockers:'없음',outOfScope:'없음',risks:'실제 앱 동작 미확인',stopCriterion:'questions_answered',remainingQuestions:'없음'};
const plan=()=>({build:{repo},entries:[url],risks:[{id:'save',risk:'결과 누락',size:'high',knowledge:'some',decision:'test'}],listRationale:'저장과 가림을 구분한다.'});
const declaration=id=>({action:'declare',id,what:id+' 결과',given:id+' 화면',basis:'plan',basisNote:'저장 기획',paths:['정상'],risk:['save'],oracle:'기능의 용도: 저장 결과',dataChanging:false,mustNotChange:[{sel:'#stable',reason:'계정 고정'}]});
const review=ids=>({information:ids.map(row=>({row,text:row+'의 독립 정보'})),duplicates:[],distribution:'모든 항목은 정상 입력 경로',missingRisks:'위험을 모두 포함'});
const sourceHash=file=>createHash('sha256').update(fs.readFileSync(path.join(repo,file))).digest('hex');

function setup() {
  const dir=fs.mkdtempSync(path.join(root,'integration7-'));
  process.env.IRIS_STATE_DIR=path.join(dir,'state');
  const ledger=createQaLedger({dir:path.join(dir,'ledger'),anchor:createQaLedgerAnchor({dir:path.join(dir,'anchor')})});
  const shot=path.join(dir,'frame.png');
  fs.writeFileSync(shot,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZB7sAAAAASUVORK5CYII=','base64'));
  const native={overlay:false,header:false,events:[],expect:null,sequence:0,emitBackground:true};
  const picture=(kind,description)=>({id:'scene-'+(++native.sequence),path:shot,claim:{kind,description},url,viewport:{width:1,height:1}});
  const ok=data=>({ok:true,data});
  const execute=async(_tab,cmd,args)=>{
    native.events.push({cmd,args:structuredClone(args)});
    if(cmd==='qa-background-observe')return ok({id:'background-'+(++native.sequence),pass:true,candidates:native.emitBackground?[{id:'console',code:'K2',kind:'console',text:'고유 배경 오류',description:'브라우저 오류: 고유 배경 오류',sceneId:'console-photo'}]:[],unexpected:[],scenes:[{...picture('S4','배경 오류'),id:'console-photo'}]});
    if(cmd==='qa-reaction-drain')return ok({});
    if(cmd==='qa-target-resolve')return ok({found:true,x:args.target.name==='닫기'?90:10,y:10,occluded:native.overlay && args.target.name!=='닫기',blocker:native.overlay?{sel:'#overlay',role:'dialog',name:'시험 가림',text:'닫기'}:null});
    if(cmd==='qa-reaction-start'){native.expect=args.expect;return ok({id:'action-'+(++native.sequence),scenes:[picture('S1','기대')],effects:[],candidates:[],unexpected:[]});}
    if(cmd==='qa-input'){
      if(args.x===90)native.overlay=false;
      return ok({trusted:true,target:args.x===90?{role:'button',name:'닫기'}:target,received:[{trusted:true,type:'click',...(args.x===90?{role:'button',name:'닫기'}:target)}]});
    }
    if(cmd==='qa-reaction-end'){
      const effects=native.expect.effects.map(e=>({...e,observed:true}));
      const header=!native.header && !effects.some(e=>e.sel==='#header');native.header=true;
      return ok({pass:true,effects,candidates:[],unexpected:header?[{id:'header',sel:'#header',text:'저장 완료',description:'기대 밖 화면 변화: 저장 완료',sceneId:'header-photo'}]:[],scenes:[picture('S2','효과'),...(header?[{...picture('S4','헤더'),id:'header-photo'}]:[])]});
    }
    if(cmd==='screenshot')return ok({path:shot,url,viewport:{width:1,height:1}});
    if(['snapshot','observe','url'].includes(cmd))return ok({snapshot:'저장 닫기',path:cmd==='observe'?shot:undefined,url});
    throw Error('UNEXPECTED_NATIVE_COMMAND_'+cmd);
  };
  const channel=createQaChannel({ledger,execute,createEntry:async()=>ok({tabId:'t-'+(++native.sequence)}),release:async()=>{},restore:async()=>ok({}),makeRoutes:()=>({list:async()=>[]})});
  const raw=(cmd,args={},run)=>channel(cmd,args,'integration-owner',run);
  const call=async(cmd,args={},run)=>{
    const r=await raw(cmd,args,run);assert.equal(r.ok,true,cmd+': '+JSON.stringify(r));return r.data;
  };
  const begin=async()=>{
    native.header=false;
    const begun=await call('run_begin',{plan:plan(),charter});
    await call('open_entry',{url},begun.runId);
    return begun;
  };
  const rows=async(run,ids)=>{for(const id of ids)await call('row',declaration(id),run);await call('list_review',{review:review(ids)},run);};
  return {dir,ledger,native,raw,call,begin,rows};
}

test('실제 장부는 위험과 목록 작성 근거를 시작 기록에 보존한다',async()=>{
  const f=setup(),begun=await f.begin();
  const first=(await f.ledger.verify(begun.runId)).events[0].event;
  assert.deepEqual(first.plan.risks,plan().risks);
  assert.equal(first.plan.listRationale,plan().listRationale);
});

test('실제 장부의 항목 선언 뒤 목록 검토와 변경분 재검토가 실행된다',async()=>{
  const f=setup(),{runId:run}=await f.begin();
  await f.rows(run,['save']);
  const inventory=await f.call('list_review',{},run);
  assert.deepEqual(inventory.changedRows,[]);
  assert.deepEqual(inventory.rows[0].risk,['save']);
  await f.call('list_review',{review:{...review([]),information:[]}},run);
});

test('실제 장부 두 회차에서 반응 조사와 가림 처리 및 관련 기대가 이어진다',async()=>{
  const f=setup(),first=await f.begin(),run=first.runId;
  assert.deepEqual(first.reactions.items,[]);
  await f.rows(run,['save','blocker']);
  await f.call('row',{action:'open',id:'save',path:'정상'},run);
  const firstPlay=await f.call('play',{steps:[{action:'click',target,expect:expectation}]},run);
  assert.ok(Array.isArray(firstPlay.remediation.defects),'첫 qa_play 는 조치 목록 전체');
  const pending=await f.call('review',{},run);
  const header=pending.items.find(i=>i.sel==='#header'),background=pending.items.find(i=>i.code==='K2');
  assert(header && background);
  await f.call('unexpected',{id:header.id,class:'연관 반응',condition:{sel:'#header'},source:'server/qa-reaction.js:1',cause:'저장 후 헤더 갱신',action:{kind:'click',target},expect:{effects:[{type:'change',sel:'#header',to:'저장 완료',oracle}]}},run);
  await f.call('unexpected',{id:background.id,class:'배경 반응',condition:{code:'K2',kind:'console',text:'고유 배경 오류'},source:'server/qa-reaction.js:1',cause:'입력 전 고유 콘솔 오류'},run);
  await f.call('row',{action:'close',id:'save',path:'정상',color:'green',note:'확인한 효과 기록',sceneJudgment:'시험 저장 결과 확인'},run);
  f.native.overlay=true;
  await f.call('row',{action:'open',id:'blocker',path:'정상'},run);
  const blocked=await f.call('play',{steps:[{action:'click',target,expect:expectation},{action:'click',target,expect:expectation}]},run);
  assert.equal(blocked.status,'막힘');assert.equal(blocked.steps[1].status,'미실행');
  assert.equal(blocked.remediation.unchanged,true,'바뀌지 않은 조치 목록은 다시 보내지 않음');assert.equal(blocked.remediation.defects,undefined);
  assert.deepEqual(deriveQaRows((await f.ledger.verify(run)).events).open,[]);
  const obstruction=(await f.call('review',{},run)).items.find(i=>i.kind==='unknown_occlusion');assert(obstruction);
  await f.call('unexpected',{id:obstruction.id,class:'방해 화면',condition:{role:'dialog',name:'시험 가림'},source:'server/qa-play.js:1',cause:'입력 대상 가림',handler:{method:'click',target:{role:'button',name:'닫기'},expect:{effects:[{type:'disappear',role:'dialog',name:'시험 가림',oracle}]}}},run);
  await f.call('review',{decisions:[{row:'blocker',reason:'다음 회차에서 목록 재사용 확인'}]},run);
  await f.call('run_end',{session},run);
  const log1=(await f.ledger.verify(run)).events;
  const catalogEvent=log1.find(r=>r.event.kind==='catalog_begin');assert(catalogEvent);
  const second=await f.begin(),run2=second.runId;
  assert.equal(second.reactions.items.length,3);
  for(const item of second.reactions.items){assert.equal(item.needsReview,false);assert.equal(item.sourceHash,sourceHash(item.source.split(':')[0]));}
  assert.deepEqual((await f.call('review',{},run2)).items,[]);
  await f.rows(run2,['save']);
  await f.call('row',{action:'open',id:'save',path:'정상'},run2);
  f.native.overlay=true;
  const played=await f.call('play',{steps:[{action:'click',target,expect:expectation}]},run2);
  assert.equal(played.pass,true);
  assert(played.steps[0].effects.some(e=>e.id.startsWith('catalog-') && e.sel==='#header'));
  assert(f.native.events.some(e=>e.cmd==='qa-input' && e.args.x===90));
  assert.deepEqual(qaPendingReactions((await f.ledger.verify(run2)).events),[]);
  await f.call('row',{action:'close',id:'save',path:'정상',color:'green',note:'확인한 효과 기록',sceneJudgment:'등록한 닫기와 헤더 기대 확인'},run2);
  await f.call('run_end',{session},run2);
});

test('순환 병합 거부는 유효하지 않은 목록 검토를 장부에 남기지 않는다',async()=>{
  const f=setup();f.native.emitBackground=false;
  const {runId:run}=await f.begin();
  for(const id of ['a','b'])await f.call('row',declaration(id),run);
  const answer={...review(['a','b']),information:[{row:'a',text:'a',sameAs:'b',decision:'merge',reason:'공동 정보'},{row:'b',text:'b',sameAs:'a',decision:'merge',reason:'공동 정보'}]};
  const before=(await f.ledger.verify(run)).events.filter(r=>r.event.kind==='list_review').length;
  const rejected=await f.raw('list_review',{review:answer},run);
  assert.equal(rejected.ok,false);
  assert.equal((await f.ledger.verify(run)).events.filter(r=>r.event.kind==='list_review').length,before,'거부한 검토는 확정 기록이 될 수 없음');
});

test('출처가 바뀐 관련 반응은 필수 기대를 유지하면서 재판단 후보로 남는다',async()=>{
  const {catalogPath}=await import('../server/qa-catalog.js');
  const f=setup();f.native.emitBackground=false;
  const {runId:run}=await f.begin();
  await f.rows(run,['save']);
  await f.call('row',{action:'open',id:'save',path:'정상'},run);
  await f.call('play',{steps:[{action:'click',target,expect:expectation}]},run);
  const header=(await f.call('review',{},run)).items.find(i=>i.sel==='#header');assert(header);
  await f.call('unexpected',{id:header.id,class:'연관 반응',condition:{sel:'#header'},source:'server/qa-reaction.js:1',cause:'헤더 갱신',action:{kind:'click',target},expect:{effects:[{type:'change',sel:'#header',to:'저장 완료',oracle}]}},run);
  await f.call('row',{action:'close',id:'save',path:'정상',color:'green',note:'효과 확인',sceneJudgment:'헤더 확인'},run);
  await f.call('run_end',{session},run);
  const file=catalogPath(repo),cache=JSON.parse(fs.readFileSync(file,'utf8'));
  cache.items[0].sourceHash='0'.repeat(64);
  fs.writeFileSync(file,JSON.stringify(cache));
  const begun=await f.begin(),run2=begun.runId;
  assert.equal(begun.reactions.items[0].needsReview,true);
  await f.rows(run2,['save']);
  await f.call('row',{action:'open',id:'save',path:'정상'},run2);
  const played=await f.call('play',{steps:[{action:'click',target,expect:expectation}]},run2);
  assert(played.steps[0].effects.some(e=>e.sel==='#header' && e.needsReview===true),'낡은 관련 반응도 필수 기대에 유지');
  assert((await f.call('review',{},run2)).items.some(item=>item.needsReview && (item.sel==='#header' || item.catalogKey===begun.reactions.items[0].key)),'기대에 흡수되어도 재판단 후보 보존');
});

test('출처가 바뀐 가림 처리도 실행되고 실제 가림 사진을 재판단한다',async()=>{
  const {catalogPath}=await import('../server/qa-catalog.js');
  const f=setup();f.native.emitBackground=false;f.native.overlay=true;
  const {runId:run}=await f.begin();
  await f.rows(run,['save']);
  await f.call('row',{action:'open',id:'save',path:'정상'},run);
  assert.equal((await f.call('play',{steps:[{action:'click',target,expect:expectation}]},run)).status,'막힘');
  const item=(await f.call('review',{},run)).items.find(i=>i.kind==='unknown_occlusion');assert(item);
  await f.call('unexpected',{id:item.id,class:'방해 화면',condition:{role:'dialog',name:'시험 가림'},source:'server/qa-play.js:1',cause:'시험 가림',handler:{method:'click',target:{role:'button',name:'닫기'},expect:{effects:[{type:'disappear',role:'dialog',name:'시험 가림',oracle}]}}},run);
  await f.call('review',{decisions:[{row:'save',reason:'다음 회차에서 변경된 출처 확인'}]},run);
  await f.call('run_end',{session},run);
  const file=catalogPath(repo),cache=JSON.parse(fs.readFileSync(file,'utf8'));
  cache.items[0].sourceHash='0'.repeat(64);fs.writeFileSync(file,JSON.stringify(cache));
  const {runId:run2,reactions}=await f.begin();
  assert.equal(reactions.items[0].needsReview,true);
  await f.rows(run2,['save']);f.native.header=true;
  await f.call('row',{action:'open',id:'save',path:'정상'},run2);
  assert.equal((await f.call('play',{steps:[{action:'click',target,expect:expectation}]},run2)).pass,true);
  assert.equal(f.native.overlay,false);
  const review2=(await f.call('review',{},run2)).items;
  assert(review2.some(i=>i.kind==='obstacle_seen' && i.needsReview===true && i.sceneSeq && i.shot));
});

test('문제 반응은 결함 기록 전 종료를 거부하고 다음 회차에 재발로 나타난다',async()=>{
  const f=setup(),{runId:run}=await f.begin();
  await f.rows(run,['save']);
  const item=(await f.call('review',{},run)).items.find(i=>i.code==='K2');assert(item);
  await f.call('unexpected',{id:item.id,class:'문제',condition:{code:'K2',kind:'console',text:'고유 배경 오류'},source:'server/qa-reaction.js:1',cause:'고의 문제 분류 계약 확인'},run);
  const rejected=await f.raw('run_end',{session},run);
  assert.equal(rejected.ok,false);assert.match(rejected.error,/qa_defect/);
  await f.call('defect',{problem:'고유 배경 오류 기록',oracle,oracleNote:'고의 문제 분류의 결함 연결 검사',importance:'QA 종료 계약',reproducible:'가끔 재현됨',tried:'입력 전 후보 한 번 확인'},run);
  await f.call('row',{action:'close',id:'save',path:'정상',color:'gray',note:'계약 확인만 수행',sceneJudgment:'실제 기능 입력은 제외'},run);
  const defect=(await f.ledger.verify(run)).events.findLast(r=>r.event.kind==='defect');
  await f.call('review',{decisions:[{defect:defect.seq,reason:'배경 오류 원인에 사람 확인 필요'}]},run);
  await f.call('run_end',{session},run);
  const {runId:run2}=await f.begin();
  const recurrence=(await f.call('review',{},run2)).items.find(i=>i.code==='K2');
  assert(recurrence && recurrence.recurrence===true && recurrence.known===false);
});

test('없는 항목을 병합한 목록 검토는 장부 기록 전에 거부한다',async()=>{
  const f=setup();f.native.emitBackground=false;
  const {runId:run}=await f.begin();
  await f.call('row',declaration('save'),run);
  const answer={...review(['save']),duplicates:[{rows:['save','ghost'],decision:'merge',reason:'존재하지 않는 항목'}]};
  const rejected=await f.raw('list_review',{review:answer},run);
  assert.equal(rejected.ok,false);
  assert.equal((await f.ledger.verify(run)).events.filter(r=>r.event.kind==='list_review').length,0,'참조 검증 전에 확정 기록 금지');
});

test('대상 속성 순서가 달라도 같은 저장 조작에 관련 기대를 적용한다',async()=>{
  const f=setup();f.native.emitBackground=false;
  const {runId:run}=await f.begin();
  await f.rows(run,['save']);
  await f.call('row',{action:'open',id:'save',path:'정상'},run);
  await f.call('play',{steps:[{action:'click',target,expect:expectation}]},run);
  const header=(await f.call('review',{},run)).items.find(i=>i.sel==='#header');assert(header);
  await f.call('unexpected',{id:header.id,class:'연관 반응',condition:{sel:'#header'},source:'server/qa-reaction.js:1',cause:'같은 저장 조작',action:{kind:'click',target:{name:target.name,role:target.role}},expect:{effects:[{type:'change',sel:'#header',to:'저장 완료',oracle}]}},run);
  await f.call('row',{action:'close',id:'save',path:'정상',color:'green',note:'효과 확인',sceneJudgment:'헤더 확인'},run);
  await f.call('run_end',{session},run);
  const {runId:run2}=await f.begin();
  await f.rows(run2,['save']);
  await f.call('row',{action:'open',id:'save',path:'정상'},run2);
  const played=await f.call('play',{steps:[{action:'click',target,expect:expectation}]},run2);
  assert(played.steps[0].effects.some(e=>e.sel==='#header' && e.id.startsWith('catalog-')),'동일 대상 속성 순서로 관련 기대를 누락할 수 없음');
});
