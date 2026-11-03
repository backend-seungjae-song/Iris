import os from "node:os";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { createQaLedger } from '../server/qa-ledger.js';
import { createQaChannel } from '../server/qa-channel.js';
import { createQaSummary } from '../server/qa-summary.js';
import { callQa } from '../bin/iris-qa.mjs';

const require=createRequire(import.meta.url);
const {createQaLedgerAnchor}=require('../native/electron/qa-ledger-anchor.cjs');
const root=path.join(fs.realpathSync(os.tmpdir()),'qa-security13');
fs.mkdirSync(root,{recursive:true});
const repo=path.resolve(import.meta.dirname,'..');
const url='http://127.0.0.1:4397/round13/';
const charter={question:'회차 소유와 보고서 범위가 지켜지는가?',scope:'회차 열쇠·보고서 회차',exclusions:'실제 앱',environment:'파일 장부',sharedEnvironment:false,timebox:'1분',people:'없음',documents:'13차 계약'};
const plan=()=>({build:{repo},entries:[url],risks:[{id:'own',risk:'다른 호출자가 회차를 조작',size:'high',knowledge:'some',decision:'test'}],listRationale:'회차 소유 확인'});
const ok=data=>({ok:true,data});

function setup(dir=fs.mkdtempSync(path.join(root,'run-')),{restore=async()=>ok({}),ask=async()=>ok({approved:true})}={}) {
  process.env.IRIS_STATE_DIR=path.join(dir,'state');
  const ledger=createQaLedger({dir:path.join(dir,'ledger'),anchor:createQaLedgerAnchor({dir:path.join(dir,'anchor')})});
  const channel=createQaChannel({runKeys:true,ledger,execute:async()=>ok({}),ask,createEntry:async()=>ok({tabId:'t1'}),
    release:async()=>{},restore,openReport:async()=>ok({tabId:'report'}),makeRoutes:()=>({list:async()=>[]})});
  return {dir,ledger,channel};
}

test('회차는 연 호출자가 받은 열쇠로만 이어서 조작한다',async()=>{
  const f=setup();
  const begun=await f.channel('run_begin',{plan:plan(),charter},'owner');
  assert.equal(begun.ok,true,begun.error);
  const {runId,runKey}=begun.data;
  assert.match(runKey,/^[0-9a-f]{64}$/);
  const stored=(await f.ledger.verify(runId)).events.find(r=>r.event.kind==='run_key').event.detail.hash;
  assert.notEqual(stored,runKey,'장부에는 열쇠 원문이 아닌 해시');
  for(const key of [undefined,'0'.repeat(64)]) {
    const r=await f.channel('tabs',{},'owner',runId,key);
    assert.equal(r.ok,false);assert.match(r.error,/이 회차를 연 도구 연결이 아닙니다/);
  }
  assert.equal((await f.channel('tabs',{},'owner',runId,runKey)).ok,true);
  // 서버가 다시 뜬 뒤에도 장부의 해시로 확인
  let restored=0;
  // 다른 세션의 열쇠 없는 재개는 거부
  const again=setup(f.dir,{restore:async()=>{restored++;return ok({});}});
  assert.equal((await again.channel('run_resume',{},'intruder',runId)).ok,false);
  assert.equal(restored,0,'거부한 재개는 탭을 복원하지 않음');
  const resumed=await again.channel('run_resume',{},'owner',runId,runKey);
  assert.equal(resumed.ok,true,resumed.error);
});

test('도구 연결은 열쇠를 메모리에만 두고 LLM 에게 주는 결과에서 뺀다',async()=>{
  const sent=[],keys=new Map();
  const request=(_options,onResponse)=>{
    const req=new EventEmitter();
    req.end=payload=>{
      const body=JSON.parse(payload);sent.push(body);
      const res=new EventEmitter();onResponse(res);
      const data=body.cmd==='run_begin'?{runId:'qa-1',runKey:'k'.repeat(64),plan:{}}:{tabs:[]};
      res.emit('data',JSON.stringify({ok:true,data}));res.emit('end');
    };
    return req;
  };
  const begun=await callQa('qa_run_begin',{plan:plan(),charter},{session:async()=>'owner',request,keys});
  assert.equal(begun.data.runKey,undefined,'결과에 열쇠 없음');
  assert.equal(keys.get('qa-1'),'k'.repeat(64));
  await callQa('qa_tabs',{run:'qa-1'},{session:async()=>'owner',request,keys});
  assert.equal(sent.at(-1).key,'k'.repeat(64),'후속 호출에 열쇠를 붙임');
});

test('실행기 보고서는 세션이 넘긴 회차와 관계없이 그 실행의 회차를 모두 넣는다',async()=>{
  const f=setup();
  const startedAt=new Date(Date.now()-1000).toISOString();
  const open=async owner=>(await f.channel('run_begin',{plan:plan(),charter},owner)).data.runId;
  const shown=await open('owner'),hidden=await open('owner'),other=await open('other-owner');
  const runDir=path.join(f.dir,'unattended');fs.mkdirSync(runDir);
  const runJson=path.join(runDir,'run.json');
  fs.writeFileSync(runJson,JSON.stringify({repo,fixBranch:'qa-fix/x',fixTree:repo,startedAt}));
  const report=await createQaSummary(f.ledger,[shown],{out:path.join(f.dir,'summary.html'),session:'owner',runJson});
  const included=report.summary.builds.map(build=>build.runId);
  assert(included.includes(hidden),'세션이 빼고 넘긴 회차도 포함');
  assert(!included.includes(other),'다른 세션 회차는 제외');
  const plain=await createQaSummary(f.ledger,[shown],{out:path.join(f.dir,'plain.html'),session:'owner'});
  assert.deepEqual(plain.summary.builds.map(build=>build.runId),[shown],'실행기 보고서가 아니면 넘긴 회차만');
});

test('승인 창 답은 앱 UI 로 인증한 연결에서만 받는다',()=>{
  const source=fs.readFileSync(path.join(repo,'server/browser-message-handlers.js'),'utf8');
  const start=source.indexOf('else if (msg.type === "ai-ask-answer")');
  const end=source.indexOf('else if (msg.type === "browser-profiles")',start);
  const branch=source.slice(start,end);
  const answered=[];
  const run=ws=>new Function('msg','ws','answerUserAsk',`if (false) {} ${branch}`)({type:'ai-ask-answer',id:'a1',answer:'승인'},ws,(...args)=>answered.push(args));
  run({_local:true});
  assert.equal(answered.length,0,'로컬 프로세스는 답할 수 없음');
  run({_local:true,_ui:true});
  assert.deepEqual(answered,[['a1','승인']]);
});
