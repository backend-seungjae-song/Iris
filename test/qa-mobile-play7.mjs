import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createQaChannel} from '../server/qa-channel.js';
import {createQaMobile} from '../server/qa-mobile.js';
import {recordReactionJudgments} from '../server/qa-catalog.js';

const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz8AAAAASUVORK5CYII=','base64');
const device='11111111-1111-4111-8111-111111111111',repo=process.cwd(),oracle='기능의 용도';
const charter={question:'사용자가 이름을 입력할 수 있는가',scope:'모바일 이름 입력',exclusions:'외부 서비스',environment:'격리 AX fixture',sharedEnvironment:false,timebox:'1분',people:'없음',documents:'fixture'};
const plan={entries:[],surfaces:['모바일 이름 입력'],build:{repo},risks:[{id:'input',risk:'포커스 또는 입력 결과가 누락될 수 있다',size:'high',knowledge:'some',decision:'test'}],listRationale:'이름 입력 결과 확인'};
const row={action:'declare',id:'name',what:'이름 입력',given:'이름 필드가 있는 화면',basis:'spec',basisNote:'이름 입력 명세',paths:['정상'],risk:['input'],oracle:'기능의 용도: 이름 입력 확인',dataChanging:false,mustNotChange:{notApplicable:true,reason:'격리된 화면 값만 확인'} };
const target={role:'textbox',name:'Name'},expect={effects:[{type:'change',sel:'#name',from:'',to:'Ada',oracle}],within:100};

async function fixture(t,{waitOverlay=false}={}){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mobile-play7-')),events=[],inputs=[],commands=[];let clock=0,value='',overlayUntil=0;
 const originalState=process.env.IRIS_STATE_DIR;process.env.IRIS_STATE_DIR=directory;
 t.after(async()=>{await mobile.close('alice');if(originalState==null)delete process.env.IRIS_STATE_DIR;else process.env.IRIS_STATE_DIR=originalState;fs.rmSync(directory,{recursive:true,force:true});});
 const field=()=>({type:'TextField',AXLabel:'Name',AXValue:value,resourceId:'name',frame:{x:1,y:1,width:10,height:10}});
 const mobile=createQaMobile({shotsDir:directory,listDevices:async()=>({ok:true,data:{tabs:[{udid:device,tab:'phone',owner:'alice',mine:true}]}}),readTargets:()=>({alice:[device]}),reactionOptions:{now:()=>clock,wait:async ms=>{clock+=ms;},interval:5,tailMs:1},backend:{verify:async()=>{},tree:async()=>[field(),...(clock<overlayUntil?[{type:'Dialog',AXLabel:'Loading overlay',resourceId:'overlay',frame:{x:0,y:0,width:20,height:20}}]:[])],input:async(_,command,args)=>{inputs.push(command);if(command==='type')value=args.text;},screenshot:async(_,file)=>fs.writeFileSync(file,PNG)}});
 const nativeExecute=mobile.execute;mobile.execute=(session,command,args,context)=>{commands.push(command);return nativeExecute(session,command,args,context);};
 if(waitOverlay)recordReactionJudgments(repo,[{class:'방해 화면',condition:{sel:'overlay'},handler:{method:'wait',within:100,expect:{effects:[{type:'disappear',sel:'#overlay',oracle}]}},source:'server/qa-mobile.js:1',cause:'시간 경과 후 사라지는 로딩 화면'}],{runId:'previous',runSeq:1,seq:1});
 const append=async(_id,event)=>{const receipt={seq:events.length+1,event:structuredClone(event)};events.push(receipt);return receipt;};
 const ledger={append,begin:({runId,session,plan,charter})=>append(runId,{kind:'run_begin',session,plan,charter}),verify:async()=>({events:structuredClone(events)}),end:(id,args)=>append(id,{kind:'run_end',sessionRecord:args.session})};
 const call=createQaChannel({ledger,mobileFactory:()=>mobile,makeRoutes:()=>({list:async()=>[]}),createEntry:async()=>assert.fail('browser entry not expected'),execute:async()=>assert.fail('browser input not expected'),release:async()=>{},ask:async()=>({ok:true})});
 const begun=await call('run_begin',{plan,charter},'alice');assert.equal(begun.ok,true,begun.error);const run=begun.data.runId;
 const send=(command,args={})=>call(command,args,'alice',run);
 const registered=await send('app_target',{device});assert.equal(registered.ok,true,registered.error);
 assert.equal((await send('row',row)).ok,true);assert.equal((await send('row',{action:'open',row:'name',path:'정상'})).ok,true);
 const reviewed=await send('list_review',{review:{information:[{row:'name',text:'이름 값 표시'}],duplicates:[],distribution:'이름 입력 정상 경로 확인',missingRisks:'외부 저장은 이번 fixture에서 제외'}});assert.equal(reviewed.ok,true,reviewed.error);
 if(waitOverlay)overlayUntil=clock+40;
 return {send,inputs,events,commands};
}

test('mobile qa_play focuses once and types through the actual mobile reaction adapter',async t=>{
 const f=await fixture(t);const result=await f.send('play',{steps:[{action:'type',target,text:'Ada',device,expect}]});
 assert.equal(result.ok,true,result.error);assert.equal(result.data.pass,true,JSON.stringify(result.data));assert.deepEqual(f.inputs,['tap','type']);
 assert.equal(f.commands.filter(command=>command==='reaction_focus').length,1);assert.equal(f.commands.filter(command=>command==='reaction_start').length,1);
 assert.ok(f.events.some(record=>record.event.kind==='play_step'&&record.event.detail.status==='통과'));
});

test('mobile qa_play waits for a registered overlay without input then focuses and types',async t=>{
 const f=await fixture(t,{waitOverlay:true});const result=await f.send('play',{steps:[{action:'type',target,text:'Ada',device,expect}]});
 assert.equal(result.ok,true,result.error);assert.equal(result.data.pass,true,JSON.stringify(result.data));assert.deepEqual(f.inputs,['tap','type']);
 assert.equal(f.commands.filter(command=>command==='reaction_start').length,2);assert.equal(f.commands.filter(command=>command==='reaction_focus').length,1);
 assert.ok(f.events.some(record=>record.event.kind==='obstacle_action'&&record.event.detail.cmd==='wait'&&record.event.detail.pass));
});
