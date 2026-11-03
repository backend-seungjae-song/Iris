import os from "node:os";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createQaChannel } from '../server/qa-channel.js';
import { playQaSteps } from '../server/qa-play.js';
import { recordReactionJudgments, loadReactionCatalogForRun, verifyReactionSource, catalogPath } from '../server/qa-catalog.js';
import { validateQaCommand } from '../server/qa-protocol.js';

const root=path.join(fs.realpathSync(os.tmpdir()),'impl7-checks');fs.mkdirSync(root,{recursive:true});
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
test('plan risks와 declare 필수 계약',async()=>{
  for(const key of ['risks','listRationale']){const p={...plan};delete p[key];assert.throws(()=>validateQaCommand('run_begin',{plan:p,charter}));}
  const f=fixture();await f.begin();for(const key of ['risk','oracle','mustNotChange']){const d={...row};delete d[key];assert.equal((await f.send('row',d)).ok,false);}
  assert.equal((await f.send('row',{...row,dataChanging:true,consumers:['missing-file:1']})).ok,false);
});
test('qa_play는 서버 안에서 연속 입력하며 매 단계 위치 조회',async()=>{
  const f=fixture();await f.begin();await f.open();const r=await f.send('play',{steps:[step,step]});assert.equal(r.data?.pass,true,r.error);
  assert.equal(f.sent.filter(x=>x.cmd==='qa-input').length,2);assert.equal(f.sent.filter(x=>x.cmd==='qa-target-resolve').length,2);
  assert.deepEqual(f.events.filter(x=>x.event.kind==='play_step').map(x=>x.event.detail.status),['통과','통과']);
});
test('목록 검토 누락과 중복 결정 누락은 첫 입력 전 거부',async()=>{
  const f=fixture();await f.begin();await f.send('row',row);await f.send('row',{action:'open',row:'row1',path:'정상'});
  assert.equal((await f.send('play',{steps:[step]})).ok,false);
  await f.send('row',{...row,id:'row2'});
  assert.equal((await f.send('list_review',{review:{...review,information:[...review.information,{row:'row2',text:'다른 정보'}]}})).ok,false);
  assert.equal(f.sent.some(x=>x.cmd==='qa-input'),false);
});
test('모르는 가림은 입력 없이 항목을 닫고 남은 단계 미실행, 다른 항목 실행',async()=>{
  let blocked=true;const f=fixture({execute:cmd=>cmd==='qa-target-resolve'?{found:true,x:10,y:20,occluded:blocked,blocker:{sel:'#overlay',text:'도움'}}:null});
  await f.begin();await f.open();const r=await f.send('play',{steps:[step,step]});assert.equal(r.data.status,'막힘');
  assert.equal(f.sent.some(x=>x.cmd==='qa-input'),false);assert.deepEqual(r.data.steps.map(x=>x.status),['막힘','미실행']);
  assert.match(r.data.steps[0].reason,/모르는 가림 — 도움 #overlay 이\(가\) 대상 중심을 덮음/,'무엇이 덮었는지 알림');
  assert.equal(f.events.findLast(x=>x.event.action==='close').event.rowData.color,'gray');
  blocked=false;await f.send('row',{...row,id:'row2',given:'다른 화면'});await f.send('row',{action:'open',row:'row2',path:'정상'});
  const rr=await f.send('list_review',{review:{...review,information:[{row:'row2',text:'다른 저장'}]}});assert.equal(rr.ok,true,rr.error);
  assert.equal((await f.send('play',{steps:[step]})).data.pass,true);
});
test('기대 실패 뒤 미실행 및 자동 실패 종료',async()=>{
  const f=fixture({execute:cmd=>cmd==='qa-reaction-end'?{pass:false,effects:[],candidates:[],unexpected:[],scenes:[]}:null});await f.begin();await f.open();
  const r=await f.send('play',{steps:[step,step]});assert.equal(r.data.pass,false);assert.equal(r.data.steps[1].status,'미실행');assert.equal(f.events.findLast(x=>x.event.action==='close').event.rowData.color,'red');
});
test('mustNotChange를 각 단계 자동 기대에 포함',async()=>{
  const f=fixture();await f.begin();await f.open({...row,mustNotChange:[{sel:'#fixed'}]});await f.send('play',{steps:[step]});
  assert.equal(f.sent.find(x=>x.cmd==='qa-reaction-start').args.expect.effects.some(e=>e.type==='unchanged'&&e.sel==='#fixed'),true);
});
test('미판단 반응은 다음 입력 허용, run_end 거부',async()=>{
  const f=fixture({execute:cmd=>cmd==='qa-reaction-end'?{pass:true,effects:[],candidates:[],unexpected:[{id:'tooltip',sel:'#help',text:'도움',description:'도움말'}],scenes:[]}:null});await f.begin();await f.open();
  assert.equal((await f.send('play',{steps:[step,step]})).data.pass,true);assert.equal((await f.send('review')).data.items.length,1);
  const ended=await f.send('run_end',{session});assert.equal(ended.ok,false);assert.match(ended.error,/반응 판단/);
});
test('등록 방해 화면은 실제 입력으로 닫고 원래 단계 재시도',async()=>{
  let blocked=true;const sent=[],scenes=[];
  const r=await playQaSteps({steps:[step],resolve:async t=>({found:true,x:1,y:2,occluded:t.name==='저장'&&blocked,blocker:{sel:'#overlay'}}),
    input:async s=>{sent.push(s);if(s.target?.name==='닫기')blocked=false;return {pass:true};},record:async()=>{},close:async()=>{},capture:async phase=>{scenes.push(phase);return {seq:scenes.length};},
    handlers:[{condition:{sel:'#overlay'},handler:{method:'click',target:{role:'button',name:'닫기'},expect:{effects:[{type:'disappear',text:'도움',oracle}]}}}]});
  assert.equal(r.pass,true);assert.deepEqual(sent.map(s=>s.target.name),['닫기','저장']);assert.deepEqual(scenes,['나타남','처리','사라짐']);
});
test('source 검증과 다음 실행의 연관 반응 필수 기대, 해시 변경 재확인',async()=>{
  const source='server/qa-play.js:1';assert.throws(()=>verifyReactionSource('missing:1',{repo}));assert.throws(()=>verifyReactionSource('미확인',{repo}));
  const f=fixture();await f.begin();
  const catalog=recordReactionJudgments(repo,[{class:'연관 반응',condition:{sel:'#header'},action:{kind:'click',target},expect:{effects:[{type:'change',sel:'#header',to:'저장 완료',oracle}]},source,cause:'저장 핸들러'}],{runId:'old',seq:1,runSeq:1});
  const g=fixture();await g.begin();await g.open();await g.send('play',{steps:[step]});assert(g.sent.find(x=>x.cmd==='qa-reaction-start').args.expect.effects.some(e=>e.sel==='#header'));
  const file=catalogPath(repo);const data=JSON.parse(fs.readFileSync(file));data.items[0].sourceHash='changed';fs.writeFileSync(file,JSON.stringify(data));
  assert.equal(loadReactionCatalogForRun(repo,{runSeq:2}).items[0].needsReview,true);
  fs.unlinkSync(file);
});
test('test 결정 위험의 row가 없으면 종료 거부',async()=>{
  const f=fixture();await f.begin();const result=await f.send('run_end',{session});assert.equal(result.ok,false);assert.match(result.error,/test 위험/);
});
test('사전 관찰 반응은 이후 테스트 후보에서 빠지고 첫 사진만 보존',async()=>{
  const scene={id:'clock-scene',path:path.join(home,'clock.png'),claim:{kind:'S4',candidateId:'clock'}};
  const f=fixture({execute:cmd=>cmd==='qa-background-observe'?{id:'bg',candidates:[],unexpected:[{id:'clock',sel:'#clock',text:'1',sceneId:'clock-scene'}],scenes:[scene]}:cmd==='qa-reaction-end'?{id:'action',pass:true,effects:[],candidates:[],unexpected:[{id:'clock2',sel:'#clock',text:'2',sceneId:'clock-scene2'}],scenes:[{...scene,id:'clock-scene2'}]}:null});
  await f.begin();await f.open();const r=await f.send('play',{steps:[step]});assert.equal(r.data.pass,true);
  assert.equal(f.events.findLast(r=>r.event.kind==='reaction').event.detail.unexpected.length,0);
  assert.equal(f.events.filter(r=>r.event.kind==='frame'&&r.event.claim?.kind==='S4').length,1);
  const pending=(await f.send('review')).data.items;assert.equal(pending.length,1);assert.equal(pending[0].background,true);assert.equal(pending[0].count,2);
});
test('대기 중 늦은 반응을 일괄검토에서 수집하고 누적 drain 사진은 중복 저장 안 함',async()=>{
  let active='bg';const f=fixture({execute:(cmd,args)=>{
    if(cmd==='qa-background-observe')return {id:'bg',scenes:[],candidates:[],unexpected:[]};
    if(cmd==='qa-reaction-start'){active='action';return {id:active,scenes:[]};}
    if(cmd==='qa-reaction-drain')return active==='action'?{id:'action',candidates:[],unexpected:[{id:'late',sel:'#late',text:'도움',count:1,sceneId:'late-s'}],scenes:[{id:'late-s',path:path.join(home,'late.png'),claim:{kind:'S4',candidateId:'late'}}]}:{id:'bg',scenes:[],candidates:[],unexpected:[]};
  }});await f.begin();await f.open();await f.send('play',{steps:[step]});
  const a=(await f.send('review')).data.items;const b=(await f.send('review')).data.items;assert.equal(a.length,1);assert.equal(b.length,1);assert.equal(a[0].sel,'#late');assert.equal(b[0].count,1);
  assert.equal(f.events.filter(r=>r.event.kind==='frame'&&r.event.claim?.candidateId?.includes('late')).length,1);
});
test('출처 미확인인 무관 반응은 다음 실행에서 재판단 가능',async()=>{
  const file=catalogPath(repo);try{fs.unlinkSync(file);}catch{}
  const f=fixture({execute:cmd=>cmd==='qa-reaction-end'?{pass:true,effects:[],candidates:[],unexpected:[{id:'help',sel:'#help',text:'도움'}],scenes:[]}:null});await f.begin();await f.open();await f.send('play',{steps:[step]});
  const pending=(await f.send('review')).data.items[0];
  const judged=await f.send('unexpected',{id:pending.id,class:'무관 반응',condition:{sel:'#help'},source:'미확인',attempts:['rg 도움말 타이머 검색 결과 없음'],cause:'타이머 추정'});assert.equal(judged.ok,true,judged.error);
  const g=fixture({execute:cmd=>cmd==='qa-reaction-end'?{pass:true,effects:[],candidates:[],unexpected:[{id:'help',sel:'#help',text:'도움'}],scenes:[]}:null});await g.begin();await g.open();await g.send('play',{steps:[step]});
  const again=(await g.send('review')).data.items[0];assert.equal(again.needsReview,true);
  assert.equal((await g.send('unexpected',{id:again.id,class:'무관 반응',condition:{sel:'#help'},source:'server/qa-play.js:1',cause:'도움말 타이머 확인'})).ok,true);
  fs.unlinkSync(file);
});
test('qa_play 대상 이름 끝의 qa_snapshot 순번 (7th) 은 nth 로 바꿔 대상을 찾는다',async()=>{
  const f=fixture();await f.begin();await f.open();
  const r=await f.send('play',{steps:[{...step,target:{role:'switch',name:'앱 상점 인기 교환 상품 노출 (7th)'}}]});assert.equal(r.data?.pass,true,r.error);
  assert.deepEqual(f.sent.find(x=>x.cmd==='qa-target-resolve').args.target,{role:'switch',name:'앱 상점 인기 교환 상품 노출',nth:7});
  const ambiguous=fixture({execute:cmd=>cmd==='qa-target-resolve'?{found:false,ambiguous:true,count:10}:null});await ambiguous.begin();await ambiguous.open();
  const failed=await ambiguous.send('play',{steps:[step]});assert.match(JSON.stringify(failed),/target\.nth/);
});
test('같은 이름 대상이 여럿이라 고르지 못한 qa_play 단계는 막힘(gray)으로 닫는다',async()=>{
  const f=fixture({execute:cmd=>cmd==='qa-target-resolve'?{found:false,ambiguous:true,count:10}:null});await f.begin();await f.open();
  const r=await f.send('play',{steps:[step]});assert.equal(r.data?.status,'막힘',JSON.stringify(r));
  assert.equal(f.events.findLast(x=>x.event.kind==='row'&&x.event.action==='close').event.rowData.color,'gray');
});
test('순번(nth)으로 고른 대상은 입력 직전 재확인에도 같은 순번을 넘긴다',async()=>{
  const f=fixture({execute:cmd=>cmd==='qa-target-resolve'?{found:true,x:10,y:20,occluded:false,target:{role:'checkbox',name:'찜 해제'}}:null});await f.begin();await f.open();
  const r=await f.send('play',{steps:[{...step,target:{role:'checkbox',name:'찜 해제 (2nd)'}}]});assert.equal(r.data?.pass,true,r.error);
  assert.deepEqual(f.sent.find(x=>x.cmd==='qa-input').args.expectedTarget,{role:'checkbox',name:'찜 해제',nth:2});
  const plain=fixture({execute:cmd=>cmd==='qa-target-resolve'?{found:true,x:10,y:20,occluded:false,target:{role:'button',name:'저장'}}:null});await plain.begin();await plain.open();
  await plain.send('play',{steps:[step]});assert.deepEqual(plain.sent.find(x=>x.cmd==='qa-input').args.expectedTarget,{role:'button',name:'저장'});
});
test('모바일 qa_play 단계의 request 기대는 입력 전에 이유와 함께 거절한다',()=>{
  const mobileExpect={effects:[{type:'request',method:'POST',path:'/wish',oracle}],within:100};
  assert.throws(()=>validateQaCommand('play',{steps:[{target,action:'app_tap',expect:mobileExpect}]}),/요청·콘솔은 계측하지 않음/);
  assert.doesNotThrow(()=>validateQaCommand('play',{steps:[{target,action:'click',expect:mobileExpect}]}));
});
test('확인 창이 떠 있으면 qa_dialog 는 화면 보기 조건과 반응 관찰 없이 창을 기록하고 답한다',async()=>{
  const f=fixture({execute:cmd=>cmd==='qa-dialog-state'?{dialog:{kind:'confirm',message:'고치던 내용을 버릴까요?'}}:cmd==='qa-dialog-answer'?{answered:'ok',via:'intercepted'}:null});
  await f.begin();await f.open();
  const r=await f.send('dialog',{answer:'ok',expect:{effects:[{type:'none',oracle}],within:100}});
  assert.equal(r.ok,true,r.error);assert.equal(r.data.answered,'ok');
  assert.equal(f.sent.some(x=>x.cmd==='qa-reaction-start'),false);
  assert.deepEqual(f.sent.find(x=>x.cmd==='qa-dialog-answer').args,{answer:'ok'});
  assert.equal(f.events.find(x=>x.event.cmd==='dialog_open').event.detail.message,'고치던 내용을 버릴까요?');
  assert.equal(f.events.findLast(x=>x.event.kind==='action').event.dialogBlocked,true);
});
test('이미 포커스가 있는 입력칸의 type 단계는 다시 누르지 않아 앞 단계 선택을 유지한다',async()=>{
  const box={role:'textbox',name:'배너 제목'};
  const run=async focused=>{const f=fixture({execute:cmd=>cmd==='qa-target-resolve'?{found:true,x:10,y:20,occluded:false,target:box}:cmd==='qa-focused'?{focused}:null});await f.begin();await f.open();
    const r=await f.send('play',{steps:[{target:box,action:'type',text:'새 제목',expect}]});assert.equal(r.data?.pass,true,r.error);
    return f.sent.filter(x=>x.cmd==='qa-input'&&x.args.action==='click').length;};
  assert.equal(await run(box),0);
  assert.equal(await run({role:'button',name:'저장'}),1);
});
test('select 단계는 첫 글자 입력으로 고르고, 실제 선택이 목표와 다르면 실패로 닫는다',async()=>{
  const box={role:'combobox',name:'추가할 브랜드'};
  const run=async selectedAfter=>{let resolved=0;const f=fixture({execute:(cmd,args)=>cmd==='qa-target-resolve'?{found:true,x:10,y:20,occluded:false,target:box}
    :cmd==='qa-select-resolve'?{index:2,selected:'교촌치킨',typeahead:{char:'교',count:2},selectedIndex:resolved++?selectedAfter:0}:null});
    await f.begin();await f.open();const r=await f.send('play',{steps:[{target:box,action:'select',text:'교촌치킨',expect}]});
    return {r,keys:f.sent.filter(x=>x.cmd==='qa-input').map(x=>x.args.key||`${x.args.action}:${x.args.text}`)};};
  const ok=await run(2);assert.equal(ok.r.data?.pass,true,JSON.stringify(ok.r));assert.deepEqual(ok.keys,['click:undefined','Escape','typeahead:교','typeahead:교']);
  const wrong=await run(1);assert.notEqual(wrong.r.data?.pass,true);assert.match(JSON.stringify(wrong.r),/바뀌지 않았습니다/);
});

test('unchanged accepts a text target like both judges, change still needs an element and messages name the effect type',()=>{
  // qa-92771d8c F2: text 로 적은 unchanged 가 "change에는…"으로 거부돼 원인을 찾기 어려웠음
  const effect=extra=>({expect:{effects:[{oracle:'기능의 용도',...extra}]}});
  assert.equal(validateQaCommand('app_tap',{x:1,y:1,...effect({type:'unchanged',text:'인기 검색어'})}).expect.effects[0].text,'인기 검색어');
  assert.throws(()=>validateQaCommand('app_tap',{x:1,y:1,...effect({type:'unchanged'})}),/unchanged에는 text, sel 또는 role·name/);
  assert.throws(()=>validateQaCommand('click',{x:1,y:1,...effect({type:'change',to:'B'})}),/change에는 sel 또는 role·name/);
});
test('클릭이 확인 창을 띄워 관찰 종료가 실패하면 qa_dialog 답 뒤에 그 관찰을 다시 끝낸다',async()=>{
  let ends=0,dialog=null;
  const f=fixture({execute:cmd=>{
    if(cmd==='qa-input'){dialog={kind:'alert',message:'아이디를 입력해주세요.'};throw new Error('페이지의 확인 창(alert)이 떠 있어 이 탭이 멈췄습니다');}
    if(cmd==='qa-reaction-end'&&++ends===1)throw new Error('페이지의 확인 창(alert)이 떠 있어 이 탭이 멈췄습니다');
    if(cmd==='qa-dialog-state')return {dialog};
    if(cmd==='qa-dialog-answer'){dialog=null;return {answered:'ok',via:'intercepted'};}
    return null;}});
  await f.begin();await f.open();
  await f.send('play',{steps:[step]});
  const started=f.sent.find(x=>x.cmd==='qa-reaction-start');
  const r=await f.send('dialog',{answer:'ok',expect:{effects:[{type:'none',oracle}],within:100}});
  assert.equal(r.ok,true,r.error);
  const after=f.sent.slice(f.sent.findIndex(x=>x.cmd==='qa-dialog-answer'));
  assert.ok(after.some(x=>x.cmd==='qa-reaction-end'),'답 뒤 관찰 종료를 다시 보내지 않았다');
  assert.ok(started);
});
