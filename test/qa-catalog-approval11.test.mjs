import os from "node:os";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createQaLedger } from '../server/qa-ledger.js';
import { createQaChannel } from '../server/qa-channel.js';
import { qaPendingReactions } from '../server/qa-reaction.js';
import { catalogPath, loadReactionCatalog } from '../server/qa-catalog.js';
import { createQaSummary } from '../server/qa-summary.js';
import { createQaGrants, QA_GRANT_LEASE_MS } from '../server/qa-grants.js';

const require=createRequire(import.meta.url);
const {createQaLedgerAnchor}=require('../native/electron/qa-ledger-anchor.cjs');
const root=path.join(fs.realpathSync(os.tmpdir()),'qa-catalog-approval11');
fs.mkdirSync(root,{recursive:true});
const repo=path.resolve(import.meta.dirname,'..');
const url='http://127.0.0.1:4397/round11/';
const target={role:'button',name:'저장'};
const oracle='기능의 용도';
const expectation={effects:[{type:'appear',text:'저장됨',oracle}],within:1000};
const charter={question:'반응 목록과 시작 승인이 계약대로 동작하는가?',scope:'반응 목록·시작 승인',exclusions:'실제 앱',environment:'파일 장부와 native adapter',sharedEnvironment:false,timebox:'1분',people:'없음',documents:'11차 계약'};
const session={work:'반응 목록 확인',curios:'없음',checked:'목록 변경',unverified:{items:'실제 앱',reason:'계약 검사'},blockers:'없음',outOfScope:'없음',risks:'실제 앱 미확인',stopCriterion:'questions_answered',remainingQuestions:'없음'};
const plan=()=>({build:{repo},entries:[url],risks:[{id:'save',risk:'결과 누락',size:'high',knowledge:'some',decision:'test'}],listRationale:'저장 결과를 확인한다.'});
const declaration=id=>({action:'declare',id,what:id+' 결과',given:id+' 화면',basis:'plan',basisNote:'저장 기획',paths:['정상'],risk:['save'],oracle:'기능의 용도: 저장 결과',dataChanging:false,mustNotChange:[{sel:'#stable',reason:'계정 고정'}]});
const review=ids=>({information:ids.map(row=>({row,text:row+'의 독립 정보'})),duplicates:[],distribution:'모든 항목은 정상 입력 경로',missingRisks:'위험을 모두 포함'});
const related={class:'연관 반응',condition:{sel:'#header'},source:'server/qa-reaction.js:1',cause:'저장 후 헤더 갱신',action:{kind:'click',target},expect:{effects:[{type:'change',sel:'#header',to:'저장 완료',oracle}]}};
const OWNER='catalog-owner';

function setup({answer='승인'}={}) {
  const dir=fs.mkdtempSync(path.join(root,'run-'));
  process.env.IRIS_STATE_DIR=path.join(dir,'state');
  const ledger=createQaLedger({dir:path.join(dir,'ledger'),anchor:createQaLedgerAnchor({dir:path.join(dir,'anchor')})});
  const shot=path.join(dir,'frame.png');
  fs.writeFileSync(shot,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZB7sAAAAASUVORK5CYII=','base64'));
  // drop: 이 sel 의 기대 효과를 관찰하지 못한 것으로 응답
  const native={header:false,expect:null,sequence:0,drop:new Set(),asks:[],answer};
  const picture=(kind,description)=>({id:'scene-'+(++native.sequence),path:shot,claim:{kind,description},url,viewport:{width:1,height:1}});
  const ok=data=>({ok:true,data});
  const execute=async(_tab,cmd,args)=>{
    if(cmd==='qa-background-observe')return ok({id:'background-'+(++native.sequence),pass:true,candidates:[],unexpected:[],scenes:[]});
    // strict: 실제 브라우저처럼 시작 때 이전 관찰을 정리하고, 정리한 번호는 찾지 못함
    if(cmd==='qa-reaction-drain'){if(native.strict&&args.id&&!native.live.has(args.id))return {ok:false,error:'이 탭의 반응 관찰을 찾지 못했습니다'};return ok({});}
    if(cmd==='qa-target-resolve')return ok({found:true,x:10,y:10,occluded:false,blocker:null});
    if(cmd==='qa-reaction-start'){native.live?.clear();if(native.startError){const message=native.startError;native.startError=null;return {ok:false,error:message};}native.expect=args.expect;const startedId='action-'+(++native.sequence);native.live?.add(startedId);return ok({id:startedId,scenes:[picture('S1','기대')],effects:[],candidates:[],unexpected:[]});}
    if(cmd==='qa-input')return ok({trusted:true,target,received:[{trusted:true,type:'click',...target}],...native.inputExtra});
    if(cmd==='qa-reaction-end'){
      const effects=native.expect.effects.map(e=>({...e,observed:!native.drop.has(e.sel)}));
      const header=!native.header && !effects.some(e=>e.sel==='#header') && !native.drop.has('#header');native.header=true;
      return ok({pass:effects.every(e=>e.observed),effects,candidates:[],unexpected:header?[native.headerItems?.shift()||{id:'header',sel:'#header',text:'저장 완료',description:'기대 밖 화면 변화: 저장 완료',sceneId:'header-photo'}].flat():[],scenes:[picture('S2','효과'),...(header?[{...picture('S4','헤더'),id:'header-photo'}]:[])]});
    }
    if(cmd==='screenshot')return ok({path:shot,url,viewport:{width:1,height:1}});
    if(['snapshot','observe','url'].includes(cmd))return ok({snapshot:'저장',path:cmd==='observe'?shot:undefined,url});
    throw Error('UNEXPECTED_NATIVE_COMMAND_'+cmd);
  };
  const ask=async(_tab,owner,message,options={})=>{native.asks.push({owner,message,options});await native.beforeAnswer?.();return ok(options._kind==='approve'?{approved:native.answer==='승인'}:{answer:native.answer});};
  const create=()=>createQaChannel({ledger,execute,ask,createEntry:async()=>ok({tabId:'t-'+(++native.sequence)}),release:async()=>{},restore:async()=>ok({}),openReport:async()=>ok({tabId:'report'}),makeRoutes:()=>({list:async()=>[]})});
  let channel=create();
  // 서버 재시작: 같은 장부·상태 폴더로 새 채널
  const restart=()=>{channel=create();};
  const raw=(cmd,args={},run,owner=OWNER)=>channel(cmd,args,owner,run);
  const call=async(cmd,args={},run,owner=OWNER)=>{const r=await raw(cmd,args,run,owner);assert.equal(r.ok,true,cmd+': '+JSON.stringify(r));return r.data;};
  const begin=async(extra={},owner=OWNER)=>{
    native.header=false;
    const begun=await call('run_begin',{plan:{...plan(),...extra.plan},charter:{...charter,...extra.charter}},undefined,owner);
    await call('open_entry',{url},begun.runId,owner);
    return begun;
  };
  const rows=async(run,ids)=>{for(const id of ids)await call('row',declaration(id),run);await call('list_review',{review:review(ids)},run);};
  return {dir,ledger,native,raw,call,begin,rows,restart};
}

// 첫 회차에서 헤더 갱신을 연관 반응으로 등록
async function registerHeader(f) {
  const {runId:run}=await f.begin();
  await f.rows(run,['save']);
  await f.call('row',{action:'open',id:'save',path:'정상'},run);
  await f.call('play',{steps:[{action:'click',target,expect:expectation}]},run);
  const header=(await f.call('review',{},run)).items.find(i=>i.sel==='#header');assert(header);
  await f.call('unexpected',{id:header.id,...related},run);
  await f.call('row',{action:'close',id:'save',path:'정상',color:'green',note:'효과 확인',sceneJudgment:'헤더 확인'},run);
  await f.call('run_end',{session},run);
  return loadReactionCatalog(repo).items[0].key;
}

// 둘째 회차: 등록한 헤더 기대가 나타나지 않는 저장
async function mismatchRun(f,extra) {
  f.native.drop.add('#header');
  const begun=await f.begin(extra),run=begun.runId;
  await f.rows(run,['save']);
  await f.call('row',{action:'open',id:'save',path:'정상'},run);
  const played=await f.call('play',{steps:[{action:'click',target,expect:expectation}]},run);
  assert.equal(played.pass,false,'목록에서 붙인 기대 실패는 그 회차의 실패로 유지');
  return run;
}

test('목록에서 붙인 기대가 나타나지 않으면 재판단 항목이 생기고 판단 전 종료를 거부한다',async()=>{
  const f=setup(),key=await registerHeader(f);
  const run=await mismatchRun(f);
  const item=(await f.call('review',{},run)).items.find(i=>i.catalogMismatch);
  assert(item,'목록 기대 불일치 항목');
  assert.equal(item.catalogKey,key);
  const ended=await f.raw('run_end',{session},run);
  assert.equal(ended.ok,false,'판단하지 않은 불일치가 있으면 종료 거부');
});

test('세션은 불일치 항목을 목록에서 삭제하고 삭제 기록과 이유를 남긴다',async()=>{
  const f=setup(),key=await registerHeader(f);
  const run=await mismatchRun(f);
  const item=(await f.call('review',{},run)).items.find(i=>i.catalogMismatch);
  const rejected=await f.raw('unexpected',{id:item.id,remove:true,class:'무관 반응',source:'server/qa-reaction.js:1',cause:'헤더는 저장과 무관'},run);
  assert.equal(rejected.ok,false,'remove와 class 동시 입력 거부');
  await f.call('unexpected',{id:item.id,remove:true,source:'server/qa-reaction.js:1',cause:'헤더는 저장과 무관'},run);
  const catalog=loadReactionCatalog(repo);
  assert.equal(catalog.items.some(i=>i.key===key),false);
  assert.equal(catalog.removed.at(-1).item.key,key);
  assert.equal(catalog.removed.at(-1).cause,'헤더는 저장과 무관');
  const events=(await f.ledger.verify(run)).events;
  assert(events.some(r=>r.event.kind==='catalog_update' && r.event.detail.removed && r.event.detail.mismatch));
  assert.equal(qaPendingReactions(events).some(i=>i.id===item.id),false);
});

test('불일치를 문제로 판단하면 목록은 유지하고 결함 연결 전까지 미판단으로 남는다',async()=>{
  const f=setup(),key=await registerHeader(f);
  const run=await mismatchRun(f);
  const item=(await f.call('review',{},run)).items.find(i=>i.catalogMismatch);
  await f.call('unexpected',{id:item.id,class:'문제',condition:{sel:'#header'},source:'server/qa-reaction.js:1',cause:'저장 뒤 헤더 미갱신'},run);
  const catalog=loadReactionCatalog(repo);
  assert.equal(catalog.items.find(i=>i.key===key).class,'연관 반응','등록 유지');
  assert(qaPendingReactions((await f.ledger.verify(run)).events).some(i=>i.id===item.id),'결함 연결 전 미판단');
});

test('불일치가 아닌 반응에는 remove를 쓸 수 없다',async()=>{
  const f=setup();
  const {runId:run}=await f.begin();
  await f.rows(run,['save']);
  await f.call('row',{action:'open',id:'save',path:'정상'},run);
  await f.call('play',{steps:[{action:'click',target,expect:expectation}]},run);
  const header=(await f.call('review',{},run)).items.find(i=>i.sel==='#header');
  const rejected=await f.raw('unexpected',{id:header.id,remove:true,source:'server/qa-reaction.js:1',cause:'삭제 시도'},run);
  assert.equal(rejected.ok,false);
});

test('세션이 사람 승인 없이 바꾼 목록은 무인 여부와 관계없이 사람 할 일에 오른다',async()=>{
  const f=setup();await registerHeader(f);
  const run=await mismatchRun(f);
  const item=(await f.call('review',{},run)).items.find(i=>i.catalogMismatch);
  await f.call('unexpected',{id:item.id,remove:true,source:'server/qa-reaction.js:1',cause:'헤더는 저장과 무관'},run);
  const report=await createQaSummary(f.ledger,[run],{out:path.join(f.dir,'summary.html')});
  assert(report.summary.humanTasks.some(task=>task.startsWith('반응 목록 변경 확인: 연관 반응 {"sel":"#header"} → 삭제')),JSON.stringify(report.summary.humanTasks));
});

test('사람이 승인하면 반응 목록을 고치고 삭제한 항목도 되돌린다',async()=>{
  const f=setup(),key=await registerHeader(f);
  const listed=await f.call('catalog',{repo});
  assert.equal(listed.items[0].key,key);
  // 사람 승인은 세션 대화에서 받음. userApproved 없이 부르면 물을 내용만 돌려주고 고치지 않음
  const pending=await f.raw('catalog_revise',{repo,key,class:'무관 반응',source:'server/qa-reaction.js:1',cause:'헤더는 저장과 무관'});
  assert.equal(pending.ok,false);assert.match(pending.error,/userApproved:true/);
  assert.equal(loadReactionCatalog(repo).items.find(i=>i.key===key).class,'연관 반응');
  await f.call('catalog_revise',{repo,key,class:'무관 반응',source:'server/qa-reaction.js:1',cause:'헤더는 저장과 무관',userApproved:true});
  let catalog=loadReactionCatalog(repo);
  assert.equal(catalog.items.find(i=>i.key===key).class,'무관 반응');
  assert.equal(catalog.items.find(i=>i.key===key).revisedBy,'사람 승인');
  const asked=f.native.asks.at(-1);
  assert.equal(asked.options._kind,'approve','늦게 누른 답이 남지 않는 승인 창');
  assert.equal(asked.options.title,'반응 목록을 고칠까요?');
  assert.match(asked.message,/항목: 연관 반응 \{"sel":"#header"\} · 동작: 수정 · class: "연관 반응" → "무관 반응" · 이유: 헤더는 저장과 무관/);
  await f.call('catalog_revise',{repo,key,remove:true,source:'server/qa-reaction.js:1',cause:'중복 등록',userApproved:true});
  assert.equal(loadReactionCatalog(repo).items.some(i=>i.key===key),false);
  await f.call('catalog_revise',{repo,key,...related,userApproved:true});
  catalog=loadReactionCatalog(repo);
  assert.equal(catalog.items.find(i=>i.key===key).class,'연관 반응','삭제 기록에서 복원');
});

test('승인하지 않거나 무인 실행 중이거나 회차 진행 중이면 반응 목록을 고치지 않는다',async()=>{
  const f=setup(),key=await registerHeader(f);
  f.native.answer='취소';
  assert.equal((await f.raw('catalog_revise',{repo,key,class:'무관 반응',source:'server/qa-reaction.js:1',cause:'시험'})).ok,false);
  assert.equal(loadReactionCatalog(repo).items[0].class,'연관 반응');
  f.native.answer='승인';
  const {grant}=await f.call('unattended_approve',{repo,fixTree:repo,logins:[]});
  const unattended=await f.raw('catalog_revise',{repo,key,class:'무관 반응',source:'server/qa-reaction.js:1',cause:'시험'});
  assert.equal(unattended.ok,false);assert.match(unattended.error,/무인 실행 중/);
  await f.call('unattended_end',{fixTree:repo,grant});
  await f.begin();
  const during=await f.raw('catalog_revise',{repo,key,class:'무관 반응',source:'server/qa-reaction.js:1',cause:'시험'});
  assert.equal(during.ok,false);assert.match(during.error,/회차가 진행 중/);
  assert.equal(loadReactionCatalog(repo).items[0].class,'연관 반응');
});

test('실행기 범위는 승인 창 없이 등록되고 같은 세션·worktree 회차에서 그 범위를 쓴다',async()=>{
  const f=setup();
  const approved=await f.call('unattended_approve',{repo,fixTree:repo,logins:['qa'],investigationLimitMin:5});
  assert.match(approved.grant,/^grant-/);
  await f.begin({charter:{unattended:true,approvals:{logins:['qa'],bulkFill:false}}});
  const second=await f.begin({charter:{unattended:true}});
  assert.equal(f.native.asks.length,0,'실행기 등록과 회차 시작 모두 묻지 않음');
  const events=(await f.ledger.verify(second.runId)).events;
  assert.equal(events.find(r=>r.event.kind==='start_approval').event.detail.via,'실행기 시작');
  assert.equal(events.find(r=>r.event.kind==='run_begin').event.charter.investigationLimitMin,5,'조사 상한은 실행기 값');
});

test('실행기 범위 밖 요청은 거부하고 다른 세션·종료한 범위는 묻지 않고 사용자 지시로 시작한다',async()=>{
  const f=setup();
  const {grant}=await f.call('unattended_approve',{repo,fixTree:repo,logins:['qa'],investigationLimitMin:5});
  for(const extra of [{approvals:{logins:['admin'],bulkFill:false}},{approvals:{logins:[],bulkFill:true}},{investigationLimitMin:30}]) {
    const rejected=await f.raw('run_begin',{plan:plan(),charter:{...charter,unattended:true,...extra}});
    assert.equal(rejected.ok,false,JSON.stringify(extra));
  }
  const other=await f.begin({charter:{unattended:true}},'other-owner');
  const via=async run=>(await f.ledger.verify(run.runId)).events.find(r=>r.event.kind==='start_approval').event.detail.via;
  assert.equal(await via(other),'사용자 지시','다른 세션은 범위를 재사용하지 않음');
  assert.equal((await f.call('unattended_end',{fixTree:repo,grant},undefined,'other-owner')).ended,false,'다른 세션은 종료 불가');
  assert.equal((await f.call('unattended_end',{fixTree:repo})).ended,false,'grant id 없이는 종료 불가');
  assert.equal((await f.call('unattended_end',{fixTree:repo,grant})).ended,true);
  assert.equal(await via(await f.begin({charter:{unattended:true}})),'사용자 지시','종료한 범위는 재사용 불가');
  assert.equal(f.native.asks.length,0);
});

test('MCP 도구 목록에 반응 목록 명령은 있고 실행기 전용 승인 명령은 없다',async()=>{
  const {QA_TOOLS,qaArguments}=await import('../bin/iris-qa.mjs');
  const names=QA_TOOLS.map(tool=>tool.name);
  assert(names.includes('qa_catalog') && names.includes('qa_catalog_revise'));
  assert.equal(names.some(name=>name.includes('unattended')),false);
  assert.deepEqual(qaArguments('qa_catalog',{repo}),{cmd:'catalog',args:{repo}});
  assert.throws(()=>qaArguments('qa_unattended_approve',{repo}));
});

test('무인 승인이 살아 있는 세션은 사람 회차로 시작할 수 없다',async()=>{
  const f=setup();
  await f.call('unattended_approve',{repo,fixTree:repo,logins:[]});
  const rejected=await f.raw('run_begin',{plan:plan(),charter});
  assert.equal(rejected.ok,false);assert.match(rejected.error,/무인 실행 중인 세션/);
});

test('목록 수정 승인 창에 다 담을 수 없으면 자르지 않고 거부한다',async()=>{
  const f=setup(),key=await registerHeader(f);
  const rejected=await f.raw('catalog_revise',{repo,key,class:'무관 반응',source:'server/qa-reaction.js:1',cause:'긴 이유 '.repeat(60)});
  assert.equal(rejected.ok,false);assert.match(rejected.error,/승인 창에 모두 표시할 수 없습니다/);
  assert.equal(f.native.asks.length,0);
});

test('시작 승인은 짧은 임대로 남고 실행기가 갱신하지 않으면 끝난다',async()=>{
  let clock=1000;
  const grants=createQaGrants({ask:async()=>({approved:true}),now:()=>clock});
  const fixTree=path.join(root,'lease','repo');
  const {grant}=await grants.approve({repo,fixTree,logins:[],hours:12},OWNER);
  assert(grants.forRun(OWNER,fixTree,{}));
  clock+=QA_GRANT_LEASE_MS-1000;
  assert.equal(grants.renew({fixTree,grant},OWNER).renewed,true);
  assert.equal(grants.renew({fixTree,grant:'grant-other'},OWNER).renewed,false,'다른 승인 id 로는 갱신 불가');
  clock+=QA_GRANT_LEASE_MS-1000;
  assert(grants.forRun(OWNER,fixTree,{}),'갱신하면 유지');
  clock+=2000;
  assert.equal(grants.forRun(OWNER,fixTree,{}),null,'갱신이 끊기면 임대 만료');
  assert.equal(grants.active(OWNER),false);
});

test('다음 회차 시작은 다른 회차를 사진 확인·줄 보관 없이 읽고, 목록의 등장 기록은 전과 같다',async()=>{
  const f=setup();await registerHeader(f);
  const calls=[],verify=f.ledger.verify;
  f.ledger.verify=(id,options)=>{calls.push({id,options});return verify(id,options);};
  const {runId:second}=await f.begin();
  const begin=(await verify(second)).events.find(r=>r.event.kind==='catalog_begin').event.detail;
  const header=begin.catalog.items.find(item=>item.condition?.sel==='#header');
  // 등장 기록: 첫 회차에서 한 번 본 반응
  assert.equal(header.lastRunSeq,1);
  assert.ok(header.lastRun && header.lastRun!==second);
  assert.equal(header.count,1);
  const other=calls.filter(call=>call.id!==second);
  assert.ok(other.length>0,'다른 회차를 읽음');
  assert.ok(other.every(call=>call.options?.photos===false && call.options?.retain===false),JSON.stringify(other));
});

test('서버가 재시작돼도 바뀌지 않은 다른 회차는 다시 읽지 않고 등장 기록은 같다',async()=>{
  const f=setup();await registerHeader(f);
  // 둘째 회차는 목록을 저장한 뒤에도 줄이 늘어 다시 읽는 것이 맞음. 첫 회차는 그대로
  const {runId:second}=await f.begin();
  f.restart();
  const calls=[],verify=f.ledger.verify;
  f.ledger.verify=(id,options)=>{calls.push(id);return verify(id,options);};
  const {runId:third}=await f.begin();
  const header=(await verify(third)).events.find(r=>r.event.kind==='catalog_begin').event.detail.catalog.items.find(item=>item.condition?.sel==='#header');
  assert.equal(header.lastRunSeq,1);
  assert.equal(header.count,1);
  assert.deepEqual(calls.filter(id=>id!==third),[second],'바뀌지 않은 첫 회차는 디스크에 저장한 목록을 씀');
});

test('한 판단이 같은 식별 조건의 대기 반응을 함께 처리하고, 무효로 한 판정의 기대 미관찰은 판단 대상에서 뺀다',async()=>{
  // qa-92771d8c 마감 전 미판단 986건: 같은 저장 판단 42개·무효 판정의 K1 99건을 하나씩 판단해야 했음
  const f=setup();const {runId:run}=await f.begin();
  await f.rows(run,['save']);
  await f.call('row',{action:'open',id:'save',path:'정상'},run);
  f.native.headerItems=[{id:'toast-a',sel:'#toast-a',text:'저장 알림',description:'기대 밖 화면 변화: 저장 알림'},{id:'toast-b',sel:'#toast-b',text:'저장 알림',description:'기대 밖 화면 변화: 저장 알림 둘째'},{id:'toast-c',sel:'#toast-c',text:'저장 알림 10',description:'기대 밖 화면 변화: 저장 알림 10'}];
  await f.call('play',{steps:[{action:'click',target,expect:expectation}]},run);
  f.native.header=false;
  await f.call('play',{steps:[{action:'click',target,expect:expectation}]},run);
  f.native.header=false;
  await f.call('play',{steps:[{action:'click',target,expect:expectation}]},run);
  f.native.drop.add('#saved');
  await f.call('play',{steps:[{action:'click',target,expect:{effects:[{type:'change',sel:'#saved',to:'저장됨',oracle}],within:1000}}]},run);
  f.native.drop.clear();
  let items=(await f.call('review',{},run)).items;
  assert.equal(items.filter(i=>/toast/.test(i.sel)).length,3);
  const k1=items.find(i=>i.code==='K1');assert(k1,'기대 미관찰 반응');
  await f.call('row',{action:'void',receipt:String(k1.seq),why:'기대 대상 sel을 잘못 적음'},run);
  const repId=items.find(i=>i.sel==='#toast-a').id,memberId=items.find(i=>i.sel==='#toast-b').id;
  const judged=await f.call('unexpected',{id:repId,class:'무관 반응',condition:{text:'저장 알림'},source:'server/qa-reaction.js:1',cause:'헤더는 저장과 무관'},run);
  assert.equal(judged.alsoJudged,1);
  items=(await f.call('review',{},run)).items;
  // 조건 글자가 전체 일치하는 반응만 묶음. '저장 알림 10' 은 부분 일치라 남음(qa-92771d8c 20168 text "10" 이 101건을 묶은 사례)
  assert.deepEqual(items.filter(i=>/toast/.test(i.sel)).map(i=>i.sel),['#toast-c']);
  // 잘못 묶인 반응은 undo 로 판단 전으로 되돌림. 대표를 넣으면 묶음 전체
  const undoMember=await f.call('unexpected',{id:memberId,undo:true,source:'server/qa-reaction.js:1',cause:'다른 화면 반응'},run);
  assert.deepEqual(undoMember.ids,[memberId]);
  assert.deepEqual((await f.call('review',{},run)).items.filter(i=>/toast-[ab]/.test(i.sel)).map(i=>i.id),[memberId]);
  const undoGroup=await f.call('unexpected',{id:repId,undo:true,source:'server/qa-reaction.js:1',cause:'묶음 전체 다시 판단'},run);
  assert.deepEqual(undoGroup.ids,[repId]);
  assert.equal((await f.call('review',{},run)).items.filter(i=>/toast/.test(i.sel)).length,3);
  assert.equal((await f.raw('unexpected',{id:'a-unknown',undo:true,source:'server/qa-reaction.js:1',cause:'없는 반응'},run)).ok,false);
  assert.equal(items.some(i=>i.code==='K1'&&i.seq===k1.seq),false,'무효 판정의 기대 미관찰은 대상 아님');
});

test('조작 전 기대 검사로 시작이 거부된 뒤에도 같은 탭의 다음 조작이 진행된다',async()=>{
  // qa-92771d8c C4 19607: 거부된 시작 뒤 "이 탭의 반응 관찰을 찾지 못했습니다"로 모든 조작이 멈춤
  const f=setup();f.native.strict=true;f.native.live=new Set();
  const {runId:run}=await f.begin();
  await f.rows(run,['save']);
  await f.call('row',{action:'open',id:'save',path:'정상'},run);
  assert.equal((await f.call('play',{steps:[{action:'click',target,expect:expectation}]},run)).pass,true);
  f.native.startError='기대 전제 불성립(조작 안 보냄): appear 저장됨: 조작 전부터 조건에 맞는 요소 있음';
  const rejected=await f.call('play',{steps:[{action:'click',target,expect:expectation}]},run);
  assert.equal(rejected.pass,false);
  await f.call('row',{action:'open',id:'save',path:'정상'},run).catch(()=>{});
  const next=await f.call('play',{steps:[{action:'click',target,expect:expectation}]},run);
  assert.equal(next.pass,true,JSON.stringify(next).slice(0,300));
});

test('숫자뿐인 짧은 조건은 저장하지 않고, 이미 저장된 것은 새 반응 분류에 쓰지 않는다',async()=>{
  // qa-92771d8c 20168: text "10" 저장 판단이 앱 포인트 부족 팝업(a2450)에도 붙어 CMS 이유로 묶였음
  const {matchCatalogReaction}=await import('../server/qa-catalog.js');
  const catalog={items:[{key:'weak',class:'무관 반응',condition:{text:'10'}},{key:'word',class:'무관 반응',condition:{text:'저장 알림'}}]};
  assert.equal(matchCatalogReaction(catalog,{text:'포인트 10P 부족'})?.key,undefined);
  assert.equal(matchCatalogReaction(catalog,{text:'저장 알림 뜸'})?.key,'word');
  const f=setup();const {runId:run}=await f.begin();
  await f.rows(run,['save']);
  await f.call('row',{action:'open',id:'save',path:'정상'},run);
  f.native.headerItems=[{id:'web-a',sel:'#web-a',text:'저장 알림',description:'기대 밖 화면 변화: 저장 알림'}];
  await f.call('play',{steps:[{action:'click',target,expect:expectation}]},run);
  const item=(await f.call('review',{},run)).items.find(i=>i.sel==='#web-a');
  const weak=await f.raw('unexpected',{id:item.id,class:'무관 반응',condition:{text:'10'},source:'server/qa-reaction.js:1',cause:'짧은 조건'},run);
  assert.equal(weak.ok,false);assert.match(weak.error,/숫자뿐이거나 한 글자/);
});

test('ids 로 고른 반응은 한 번에 같은 판단을 받고, 없는 id 가 섞이면 아무것도 기록하지 않는다',async()=>{
  // qa-92771d8c: sel 이 모두 다른 text 없는 DOM 변화 315건을 조건으로 묶을 수 없었음
  const f=setup();const {runId:run}=await f.begin();
  await f.rows(run,['save']);
  await f.call('row',{action:'open',id:'save',path:'정상'},run);
  f.native.headerItems=[{id:'dom-a',sel:'#dom-a',description:'기대 밖 화면 변화: 요소 표시'},{id:'dom-b',sel:'#dom-b',description:'기대 밖 화면 변화: 요소 표시 둘'},{id:'dom-c',sel:'#dom-c',description:'기대 밖 화면 변화: 요소 표시 셋'}];
  for(let i=0;i<3;i++){f.native.header=false;await f.call('play',{steps:[{action:'click',target,expect:expectation}]},run);}
  const items=(await f.call('review',{},run)).items.filter(i=>/dom-/.test(i.sel));
  assert.equal(items.length,3);
  const [a,b,c]=['#dom-a','#dom-b','#dom-c'].map(sel=>items.find(i=>i.sel===sel).id);
  const judgment={class:'무관 반응',condition:{sel:'#dom-a'},source:'server/qa-reaction.js:1',cause:'CMS 목록 다시 그림'};
  const before=loadReactionCatalog(repo).items.length;
  const bad=await f.raw('unexpected',{id:a,...judgment,ids:[b,'a-missing']},run);
  assert.equal(bad.ok,false);assert.match(bad.error,/a-missing/);
  assert.equal(loadReactionCatalog(repo).items.length,before,'거부되면 반응 목록도 그대로');
  const judged=await f.call('unexpected',{id:a,...judgment,ids:[b,c]},run);
  assert.equal(judged.alsoJudged,2);
  assert.equal((await f.call('review',{},run)).items.some(i=>/dom-/.test(i.sel)),false);
});

test('키가 같아도 새 조건에 맞지 않는 반응은 묶지 않고, ids 를 주면 넣은 반응만 판단한다',async()=>{
  // qa-92771d8c 20196: 숫자 조건 시절 붙은 키 26561d 를 따라 ids 에 넣지 않은 9건이 함께 판단됨
  const f=setup();
  const catalog=loadReactionCatalog(repo);
  catalog.items.push({key:'loose-key',class:'무관 반응',condition:{text:'알림'},needsReview:true});
  fs.mkdirSync(path.dirname(catalogPath(repo)),{recursive:true});fs.writeFileSync(catalogPath(repo),JSON.stringify(catalog));
  const {runId:run}=await f.begin();
  await f.rows(run,['save']);
  await f.call('row',{action:'open',id:'save',path:'정상'},run);
  f.native.headerItems=['저장 알림','삭제 알림','알림 끔','알림 켬'].map((text,i)=>({id:'n-'+i,sel:'#n-'+i,text,description:'기대 밖 화면 변화: '+text}));
  for(let i=0;i<4;i++){f.native.header=false;await f.call('play',{steps:[{action:'click',target,expect:expectation}]},run);}
  const items=(await f.call('review',{},run)).items.filter(i=>/#n-/.test(i.sel));
  assert.equal(items.length,4);
  assert(items.every(i=>i.catalogKey==='loose-key'),JSON.stringify(items.map(i=>i.catalogKey)));
  const id=sel=>items.find(i=>i.sel===sel).id;
  const first=await f.call('unexpected',{id:id('#n-0'),class:'무관 반응',condition:{text:'저장 알림'},source:'server/qa-reaction.js:1',cause:'저장 알림'},run);
  assert.equal(first.alsoJudged,undefined,'새 조건 "저장 알림"에 맞지 않는 같은 키 반응은 남음');
  const picked=await f.call('unexpected',{id:id('#n-1'),class:'무관 반응',condition:{text:'알림'},source:'server/qa-reaction.js:1',cause:'알림 표시',ids:[id('#n-3')]},run);
  assert.equal(picked.alsoJudged,1,'ids 에 넣은 반응만 함께 판단');
  assert.deepEqual((await f.call('review',{},run)).items.filter(i=>/#n-/.test(i.sel)).map(i=>i.sel),['#n-2']);
});

test('ids 로 함께 문제 판단한 묶음에도 결함이 연결되고, 연결만 빠진 문제 반응은 defect 만 넣어 연결한다',async()=>{
  // qa-92771d8c 결함 20220: 대표가 화면 변화 묶음이면 ids 로 넣은 다른 묶음 3건이 결함 연결 없이 -changes-problem 으로 남아 회차 종료를 막음
  const f=setup();const {runId:run}=await f.begin();
  await f.rows(run,['save']);
  await f.call('row',{action:'open',id:'save',path:'정상'},run);
  const change=(id,text)=>({id,sel:'#'+id,text,description:'기대 밖 화면 변화: '+text});
  f.native.headerItems=[[change('g-u1','가'),change('g-u2','나')],[change('h-u1','다'),change('h-u2','라')],change('lone','마')];
  for(let i=0;i<3;i++){f.native.header=false;await f.call('play',{steps:[{action:'click',target,expect:expectation}]},run);}
  let items=(await f.call('review',{},run)).items;
  const groups=items.filter(i=>/-changes$/.test(i.id));
  assert.equal(groups.length,2,JSON.stringify(items.map(i=>i.id)));
  const lone=items.find(i=>i.sel==='#lone').id;
  const defect=await f.call('defect',{problem:'저장 뒤 요소가 남음',oracle,oracleNote:'결함 연결 검사',importance:'회차 종료',reproducible:'가끔 재현됨',tried:'저장 한 번'},run);
  const problem={class:'문제',condition:{sel:'#g-u1'},source:'server/qa-reaction.js:1',cause:'저장 뒤 요소 남음'};
  await f.call('unexpected',{id:groups[0].id,...problem,defect:defect.seq,ids:[groups[1].id]},run);
  items=(await f.call('review',{},run)).items;
  assert.deepEqual(items.map(i=>i.id).filter(id=>/changes|lone/.test(id)),[lone],'ids 로 넣은 묶음도 결함 연결');
  await f.call('unexpected',{id:lone,...problem,condition:{sel:'#lone'}},run);
  const refused=await f.raw('unexpected',{id:lone,...problem,condition:{sel:'#lone'}},run);
  assert.match(refused.error,/defect에 결함 seq만/);
  await f.call('unexpected',{id:lone,defect:defect.seq,source:'server/qa-reaction.js:1',cause:'결함 연결'},run);
  assert.equal((await f.call('review',{},run)).items.some(i=>/changes|lone/.test(i.id)),false);
});

test('run_end 는 종료 기록 전에 보고서 검사를 돌려, 앞선 실패가 남은 green 경로가 있으면 회차를 끝내지 않는다',async()=>{
  // qa-92771d8c: 회차를 끝낸 뒤 보고서 검사에서 28건이 거부되어 무효 처리·재실행을 더 기록할 수 없었음
  const f=setup();const {runId:run}=await f.begin();
  await f.rows(run,['save']);
  await f.call('row',{action:'open',id:'save',path:'정상'},run);
  f.native.drop.add('#saved');
  const failed=await f.call('play',{steps:[{action:'click',target,expect:{effects:[{type:'change',sel:'#saved',to:'저장됨',oracle}],within:1000}}]},run);
  assert.equal(failed.pass,false);
  f.native.drop.clear();
  await f.call('row',{action:'open',id:'save',path:'정상'},run);
  assert.equal((await f.call('play',{steps:[{action:'click',target,expect:expectation}]},run)).pass,true);
  // 자동으로 닫힌 뒤 다시 연 경로는 앞선 실패까지 세므로 green 은 닫을 때 거부
  assert.match((await f.raw('row',{action:'close',id:'save',path:'정상',color:'green',note:'효과 확인',sceneJudgment:'헤더 확인'},run)).error,/red/);
  // 사람이 red 로 닫고 다시 열면 새로 세어 green 으로 닫힘. 앞선 실패는 run_end 의 보고서 검사가 잡음
  await f.call('row',{action:'close',id:'save',path:'정상',color:'red',note:'저장 효과 없음',sceneJudgment:'헤더 확인'},run);
  await f.call('row',{action:'open',id:'save',path:'정상'},run);
  assert.equal((await f.call('play',{steps:[{action:'click',target,expect:expectation}]},run)).pass,true);
  await f.call('row',{action:'close',id:'save',path:'정상',color:'green',note:'효과 확인',sceneJudgment:'헤더 확인'},run);
  const items=(await f.call('review',{},run)).items;
  await f.call('unexpected',{id:items.find(i=>i.sel==='#header').id,...related},run);
  await f.call('unexpected',{id:items.find(i=>i.code==='K1').id,class:'무관 반응',condition:{code:'K1'},source:'server/qa-reaction.js:1',cause:'시험 기기가 저장 효과를 돌려주지 않음'},run);
  const ended=await f.raw('run_end',{session},run);
  assert.equal(ended.ok,false);
  assert.match(ended.error,/경로 색과 판정이 맞지 않아/);
  assert.match(ended.error,/save 정상 실패 판정이 있습니다/);
  assert.equal((await f.ledger.verify(run)).events.some(r=>r.event.kind==='run_end'),false,'회차는 끝나지 않음');
});

test('끝난 회차의 결함을 새 회차에서 retestOf 로 선언한 항목이 원래 실패 단계로 재확인한다',async()=>{
  // qa-6face637: 다른 회차 결함을 retestOf 로 선언은 받았지만 qa_play 가 "결함을 기록한 회차에서 실행하세요"로 거부
  const f=setup();
  const {runId:first}=await f.begin();
  await f.rows(first,['save']);
  await f.call('row',{action:'open',id:'save',path:'정상'},first);
  f.native.drop.add('#saved');
  assert.equal((await f.call('play',{steps:[{action:'click',target,expect:{effects:[{type:'change',sel:'#saved',to:'저장됨',oracle}],within:1000}}]},first)).pass,false);
  f.native.drop.clear();
  const failure=(await f.ledger.verify(first)).events.findLast(r=>['reaction','assertion'].includes(r.event.kind) && r.event.pass===false);
  const defect=await f.ledger.append(first,{kind:'defect',rowId:'save',detail:{problem:'저장 표시 안 됨',rowId:'save',failureSeq:failure.seq}});
  await f.ledger.append(first,{kind:'fix',detail:{defect:defect.seq,commit:'a'.repeat(40)}});
  const {runId:second}=await f.begin();
  const retestOf={run:first,defect:defect.seq};
  await f.call('row',{...declaration('recheck'),retestOf},second);
  await f.call('list_review',{review:review(['recheck'])},second);
  await f.call('row',{action:'open',id:'recheck',path:'정상'},second);
  const replayed=await f.call('play',{retestOf},second);
  assert.equal(replayed.pass,true,JSON.stringify(replayed).slice(0,300));
  const result=(await f.ledger.verify(second)).events.findLast(r=>r.event.kind==='play_result');
  assert.deepEqual(result.event.detail.retestOf,retestOf);
});

test('휠 입력 뒤 스크롤 위치가 그대로면 그 메모를 조작 기록에도 남긴다',async()=>{
  // qa-6face637 seq 895: 위로 스크롤이 움직이지 않았는데 어느 스크롤 영역인지가 응답에만 있어 원인을 찾지 못함
  const f=setup();const {runId:run}=await f.begin();
  await f.rows(run,['save']);
  await f.call('row',{action:'open',id:'save',path:'정상'},run);
  f.native.inputExtra={atEdge:false,scrollUnchanged:true,scrollNote:'휠 입력 뒤 스크롤 위치 그대로([["main.flex-1",4600,0,9000]])'};
  await f.call('play',{steps:[{action:'scroll',target,deltaY:-6000,expect:expectation}]},run).catch(()=>{});
  const action=(await f.ledger.verify(run)).events.findLast(r=>r.event.kind==='action' && r.event.cmd==='scroll');
  assert.ok(action,'scroll 조작 기록');
  assert.match(action.event.scrollNote,/main\.flex-1/);
  // 도구가 휠 기본 동작을 대신한 경우도 남김
  f.native.inputExtra={atEdge:false,scrollApplied:'main.flex-1',scrollNote:'휠은 전달됐지만 위치가 그대로라 페이지가 막지 않은 휠의 기본 동작대로 main.flex-1을 옮김(4600, 0)'};
  await f.call('row',{action:'open',id:'save',path:'정상'},run).catch(()=>{});
  await f.call('play',{steps:[{action:'scroll',target,deltaY:4600,expect:expectation}]},run).catch(()=>{});
  const applied=(await f.ledger.verify(run)).events.findLast(r=>r.event.kind==='action' && r.event.cmd==='scroll');
  assert.notEqual(applied.seq,action.seq);
  assert.match(applied.event.scrollNote,/기본 동작대로/);
});

test('연결 저장소(build.related) 출처는 회차 중 등록과 사람 승인 수정 모두 받는다',async()=>{
  const {execFileSync}=await import('node:child_process');
  const f=setup();
  const admin=path.join(f.dir,'admin');fs.mkdirSync(admin);fs.writeFileSync(path.join(admin,'a.ts'),'one\ntwo\n');
  execFileSync('git',['init','-q'],{cwd:admin});execFileSync('git',['add','.'],{cwd:admin});
  execFileSync('git',['-c','user.email=a@b','-c','user.name=a','commit','-qm','i'],{cwd:admin});
  const source=path.join(admin,'a.ts')+':2';
  const {runId:run}=await f.begin({plan:{build:{repo,related:[admin]}}});
  await f.rows(run,['save']);
  await f.call('row',{action:'open',id:'save',path:'정상'},run);
  await f.call('play',{steps:[{action:'click',target,expect:expectation}]},run);
  const header=(await f.call('review',{},run)).items.find(i=>i.sel==='#header');
  await f.call('unexpected',{id:header.id,...related,source},run);
  const key=loadReactionCatalog(repo).items[0].key;
  assert.equal(loadReactionCatalog(repo).items[0].source,source);
  await f.call('row',{action:'close',id:'save',path:'정상',color:'green',note:'효과 확인',sceneJudgment:'헤더 확인'},run);
  await f.call('run_end',{session},run);
  await f.call('catalog_revise',{repo,key,class:'무관 반응',source,cause:'관리자 화면 갱신',userApproved:true});
  assert.equal(loadReactionCatalog(repo).items[0].class,'무관 반응');
});
