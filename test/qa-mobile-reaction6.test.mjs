import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
const { createMobileReaction, validateMobileReaction } = await import(process.env.IRIS_MOBILE_REACTION_MODULE || "../server/qa-mobile-reaction.js");
const { createQaMobile } = await import(process.env.IRIS_MOBILE_ADAPTER_MODULE || "../server/qa-mobile.js");

const oracle = "기능의 용도";
const el = (label, extra = {}) => ({type:"StaticText", AXLabel:label, resourceId:label,
  frame:{x:1,y:1,width:10,height:10}, ...extra});
const expectation = (effects, within = 100) => ({effects:effects.map(effect => ({oracle,...effect})),within});
async function reaction({before = [], effects = [{type:"appear",text:"Saved"}], within = 100,
  trees = () => [el("Saved")], delivered = true, interval = 10, tailMs = 20, capture, operationTimeoutMs = 50} = {}) {
  let clock = 0, index = 0, shots = 0;
  const watch = createMobileReaction({before,expect:expectation(effects,within),action:{command:"tap",args:{x:1,y:1}},
    identity:{targetId:"phone"},now:()=>clock,wait:async ms=>{clock += ms;},interval,tailMs,operationTimeoutMs,
    readTree:async()=>trees(clock,index++),capture:async()=>{shots++;return capture ? capture(shots) : {path:`shot-${shots}.png`};}});
  await watch.initial();watch.arm();watch.delivered(delivered);
  const result = await watch.finish();
  return {result, clock, shots};
}

test("mobile declarations accept stable effect IDs and empty change values, reject unsupported effects", () => {
  const valid = validateMobileReaction(expectation([{id:"name",type:"change",sel:"#field",from:"text",to:""}]));
  assert.equal(valid.effects[0].id,"name");
  for (const type of ["navigate","dialog","request"]) assert.throws(()=>validateMobileReaction(expectation([{type,url:"app://next"}])),/허용되지 않은/);
  assert.throws(()=>validateMobileReaction(expectation([{type:"none"},{type:"appear",text:"Saved"}])),/none/);
  assert.throws(()=>validateMobileReaction(expectation([{id:"same",type:"appear",text:"one"},{id:"same",type:"appear",text:"two"}])),/ID/);
});

test("appear, disappear and change effects carry independent S2 claim photographs", async () => {
  const field = el("Field",{resourceId:"field",AXValue:"old"});
  const {result} = await reaction({before:[el("Old"),field],effects:[{id:"a",type:"appear",text:"Saved"},
    {id:"d",type:"disappear",text:"Old"},{id:"c",type:"change",sel:"#field",from:"old",to:""}],
    trees:()=>[el("Saved"),{...field,AXValue:""}]});
  assert.equal(result.pass,true);
  assert.deepEqual(result.effects.map(e=>e.id),["a","d","c"]);
  for (const effect of result.effects) {
    const scene=result.scenes.find(s=>s.id===effect.sceneId);
    assert.equal(scene.claim.kind,"S2");assert.equal(scene.claim.effectId,effect.id);assert.ok(scene.shot);
  }
  assert.equal(new Set(result.effects.map(e=>e.sceneId)).size,3);
  assert.ok(result.scenes.some(s=>s.claim.kind==="S1"));assert.ok(result.scenes.some(s=>s.claim.kind==="S3"));
});

test("none waits through within and a short tail without K1 or K3", async () => {
  const {result,clock} = await reaction({before:[el("Ready")],effects:[{id:"still",type:"none"}],trees:()=>[el("Ready")]});
  assert.equal(result.pass,true);assert.equal(result.completedMs,100);assert.equal(clock,120);
  assert.deepEqual(result.candidates,[]);
});

test("missing effects and an inert delivered action produce K1 and K3 with S4 claims on the S3 photograph", async () => {
  const {result} = await reaction({before:[el("Ready")],trees:()=>[el("Ready")]});
  assert.equal(result.pass,false);assert.deepEqual(result.candidates.map(c=>c.code),["K1","K3"]);
  const end=result.scenes.find(s=>s.claim.kind==="S3");
  for (const item of result.candidates) {
    const scene=result.scenes.find(s=>s.id===item.sceneId);
    assert.equal(scene.claim.kind,"S4");assert.equal(scene.claim.candidateId,item.id);
    assert.equal(scene.sameSceneId,end.id);assert.equal(scene.shot,end.shot);
  }
  assert.deepEqual(result.unavailable,["K2","K8","K9"]);
});

test("effects appearing after within do not pass and loading does not extend a short observation", async () => {
  const {result,clock}=await reaction({effects:[{type:"appear",text:"Saved"}],trees:()=>[el("Loading",{type:"ProgressBar"})]});
  assert.equal(result.pass,false);assert.equal(clock,100);assert.equal(result.candidates.some(c=>c.code==="K5"),false);
  const late=await reaction({trees:clock=>clock>=100 ? [el("Saved")] : [],within:95,interval:30});
  assert.equal(late.result.pass,false);assert.equal(late.clock,95);
});

test("K4, K5, K6, K7 and K10 derive from visible accessibility evidence", async () => {
  const slow=await reaction({within:1500,interval:100,trees:clock=>clock>=1200 ? [el("Saved")] : []});
  assert.ok(slow.result.candidates.some(c=>c.code==="K4"));
  const busy=el("Loading",{type:"ProgressBar"});
  const loading=await reaction({before:[busy],within:11000,interval:500,effects:[{type:"none"}],trees:()=>[busy]});
  assert.ok(loading.result.candidates.some(c=>c.code==="K5"));
  const empty=await reaction({before:[el("Ready")],trees:()=>[]});
  assert.ok(empty.result.candidates.some(c=>c.code==="K6"));
  const invalid=await reaction({trees:()=>[el("Saved"),el("undefined"),el("",{type:"Button",resourceId:"unnamed"})]});
  assert.ok(invalid.result.candidates.some(c=>c.code==="K7"));assert.ok(invalid.result.candidates.some(c=>c.code==="K10"));
  for (const item of invalid.result.candidates) assert.equal(invalid.result.scenes.find(s=>s.id===item.sceneId).claim.kind,"S4");
});

test("an expected disappearance does not suppress another disappearing element", async () => {
  const {result}=await reaction({before:[el("Old"),el("Unrelated")],effects:[{type:"disappear",text:"Old"}],trees:()=>[]});
  assert.equal(result.pass,true);assert.equal(result.unexpected.length,1);
  assert.equal(result.scenes.find(s=>s.id===result.unexpected[0].sceneId).claim.candidateId,result.unexpected[0].id);
});

test("successive notifications at the same position retain a photograph for each expected effect", async () => {
  const {result}=await reaction({effects:[{type:"appear",text:"Saved"},{type:"appear",text:"Copied"}],
    trees:clock=>clock<20 ? [el("Saved",{resourceId:"toast"})] : clock<40 ? [el("Copied",{resourceId:"toast"})] : []});
  assert.equal(result.pass,true);
  const proofs=result.effects.map(effect=>result.scenes.find(scene=>scene.id===effect.sceneId));
  assert.ok(proofs.every(scene=>scene.claim.kind==="S2" && scene.shot));
  assert.notEqual(proofs[0].shot,proofs[1].shot);
});

test("capture failure produces explicit S6 and cannot pass an observed effect", async () => {
  const {result}=await reaction({capture:shots=>{if(shots===2)throw Error("capture failed");return {path:`shot-${shots}.png`};}});
  assert.equal(result.effects[0].observed,true);assert.equal(result.pass,false);
  assert.match(result.effects[0].noPhotoReason,/capture failed/);assert.ok(result.scenes.some(s=>s.claim.kind==="S6"));
});

test("an uncaptured S3 conclusion cannot pass even when S2 was captured", async () => {
  const {result}=await reaction({capture:shots=>{if(shots===3)throw Error("conclusion capture failed");return {path:`shot-${shots}.png`};}});
  assert.equal(result.effects[0].observed,true);assert.equal(result.pass,false);
  assert.ok(result.scenes.some(s=>s.claim.kind==="S6"));
});

test("none keeps unexpected changes in the tail for later judgment", async () => {
  const {result}=await reaction({before:[el("Ready")],effects:[{type:"none"}],trees:clock=>clock>100 ? [el("Ready"),el("Late")] : [el("Ready")]});
  assert.equal(result.pass,true);assert.equal(result.unexpected.length,1);
  assert.ok(result.scenes.some(s=>s.claim.kind==="S4" && s.claim.candidateId===result.unexpected[0].id));
});

test("failed delivery cannot claim pass even if effects become visible", async () => {
  const {result}=await reaction({delivered:false});assert.equal(result.pass,false);
});

test("stalled accessibility lookup stops with a bounded error and S6 evidence", async () => {
  const watch=createMobileReaction({before:[],expect:expectation([{type:"appear",text:"Saved"}],20),
    readTree:()=>new Promise(()=>{}),capture:async()=>({path:"last.png"}),identity:{},operationTimeoutMs:5});
  await watch.initial();watch.arm();watch.delivered();const result=await watch.finish();
  assert.equal(result.pass,false);assert.match(result.error,/時間|시간/);assert.ok(result.scenes.some(s=>s.claim.kind==="S6"));
});

const PNG=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz8AAAAASUVORK5CYII=","base64");
function mobileFixture(t) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"mobile-reaction-test-"));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const device="11111111-1111-4111-8111-111111111111";let clock=0;const inputs=[],shots=[];
  const mobile=createQaMobile({shotsDir:directory,listDevices:async()=>({ok:true,data:{tabs:[{udid:device,tab:"phone",owner:"alice",mine:true}]}}),
    readTargets:()=>({alice:[device]}),reactionOptions:{now:()=>clock,wait:async ms=>{clock+=ms;},interval:1,tailMs:1},
    backend:{verify:async()=>{},tree:async()=>[el("Ready")],input:async(_,cmd,args)=>inputs.push([cmd,args]),
      screenshot:async(_,file)=>{shots.push(file);fs.writeFileSync(file,PNG);}}});
  return {mobile,device,inputs,shots,directory};
}

test("every mobile input requires an expectation before device access",async t=>{
  const f=mobileFixture(t);
  for(const [cmd,args] of [["tap",{x:1,y:2}],["swipe",{x1:1,y1:2,x2:3,y2:4}],["type",{text:"name"}],["key",{key:"ENTER"}]])
    assert.equal((await f.mobile.execute("alice",cmd,args)).ok,false);
  assert.equal(f.inputs.length,0);assert.equal(f.shots.length,0);
  const result=await f.mobile.execute("alice","tap",{x:1,y:2,expect:expectation([{type:"none"}],1)});
  assert.equal(result.ok,true);assert.equal(result.data.reaction.pass,true);assert.equal(f.shots.length,3);
});

test("a started mobile reaction binds action arguments and allows only one input",async t=>{
  const f=mobileFixture(t),expect=expectation([{type:"none"}],1);
  const start=await f.mobile.execute("alice","reaction_start",{expect,action:{command:"tap",args:{x:1,y:2}}});
  assert.equal(start.ok,true);
  assert.equal((await f.mobile.execute("alice","tap",{x:2,y:2,expect})).ok,false);
  assert.equal((await f.mobile.execute("alice","tap",{y:2,x:1,expect})).ok,true);
  assert.equal((await f.mobile.execute("alice","tap",{x:1,y:2,expect})).ok,false);
  const end=await f.mobile.execute("alice","reaction_end",{reactionId:start.data.reactionId,delivered:true});
  assert.equal(end.ok,true);assert.equal(end.data.pass,true);assert.equal(f.inputs.length,1);
});

test("S1 input claims record text length without the typed value", async t=>{
  const f=mobileFixture(t);
  const result=await f.mobile.execute("alice","type",{text:"private input",expect:expectation([{type:"none"}],1)});
  assert.equal(result.ok,true);
  assert.deepEqual(result.data.reaction.scenes.find(s=>s.claim.kind==="S1").claim.action,{command:"type",args:{length:13}});
});

test('unchanged requires a baseline and rejects any observed intermediate AX value change',async()=>{
 const ready=el('Ready',{resourceId:'total',AXValue:'3'}),effects=[{type:'unchanged',sel:'#total'}];
 const stable=await reaction({before:[ready],effects,trees:()=>[ready]});assert.equal(stable.result.pass,true);assert.equal(stable.result.effects[0].atMs,100);assert.ok(!stable.result.candidates.some(c=>c.code==='K3'));
 const changed=await reaction({before:[ready],effects,trees:clock=>[{...ready,AXValue:clock===20?'4':'3'}]});assert.equal(changed.result.pass,false);assert.equal(changed.result.effects[0].violated,true);
 const removed=await reaction({before:[ready],effects,trees:clock=>clock===20?[]:[ready]});assert.equal(removed.result.pass,false);
 const absent=await reaction({effects,trees:()=>[]});assert.equal(absent.result.pass,false);
});

test('mobile target resolution rejects duplicates, maps AX roles and excludes a dialog ancestor',async t=>{
 const f=mobileFixture(t);let current=[];
 // This adapter is separate so the tree changes represent fresh backend accessibility reads.
 const mobile=createQaMobile({shotsDir:f.directory,listDevices:async()=>({ok:true,data:{tabs:[{udid:f.device,tab:'phone',owner:'alice',mine:true}]}}),readTargets:()=>({alice:[f.device]}),backend:{verify:async()=>{},tree:async()=>current}});
 const save=el('Save',{type:'Button',resourceId:'save'}),dialog=el('Dialog',{type:'Dialog',resourceId:'dialog',frame:{x:0,y:0,width:100,height:100},children:[save]});current=[dialog,save];
 const run=async target=>(await mobile.execute('alice','target_resolve',{target})).data;
 assert.equal((await run({role:'button',name:'Save'})).occluded,false);
 current=[...current,el('Cover',{type:'Button',resourceId:'cover'})];const blocked=await run({role:'button',name:'Save'});assert.equal(blocked.occluded,true);assert.equal(blocked.blocker.sel,'cover');assert.equal(blocked.blocker.text,'Cover');assert.equal(typeof blocked.blocker.at,'number');
 current=[save,{...save,resourceId:'save2'}];const duplicate=await run({text:'Save'});assert.equal(duplicate.found,false);assert.equal(duplicate.ambiguous,true);
});

test('mobile target resolution does not treat an enclosing card button earlier in a flat tree as covering its child',async t=>{
 const f=mobileFixture(t);let current=[];
 const mobile=createQaMobile({shotsDir:f.directory,listDevices:async()=>({ok:true,data:{tabs:[{udid:f.device,tab:'phone',owner:'alice',mine:true}]}}),readTargets:()=>({alice:[f.device]}),backend:{verify:async()=>{},tree:async()=>current}});
 // idb describe-all 처럼 부모·자식 정보가 없는 평평한 트리(qa-92771d8c W1a)
 const card=el('버거킹 몬스터와퍼',{type:'Button',resourceId:'card',frame:{x:36,y:375,width:317,height:97}}),heart=el('찜 해제',{type:'CheckBox',resourceId:'heart',frame:{x:91,y:428,width:37,height:37}});
 const run=async()=>(await mobile.execute('alice','target_resolve',{target:{role:'checkbox',name:'찜 해제'}})).data;
 current=[card,heart];assert.equal((await run()).occluded,false);
 const barrier=el('닫기',{type:'Button',resourceId:'barrier',frame:{x:0,y:0,width:390,height:844}});
 current=[card,heart,barrier];const covered=await run();assert.equal(covered.occluded,true);assert.equal(covered.blocker.sel,'barrier');
});

test('mobile target resolution picks one of several same-named targets by nth in tree order',async t=>{
 const f=mobileFixture(t);
 const toggles=[1,2,3].map(i=>el('인기 노출',{type:'Switch',resourceId:'t'+i,frame:{x:10,y:i*50,width:30,height:30}}));
 const mobile=createQaMobile({shotsDir:f.directory,listDevices:async()=>({ok:true,data:{tabs:[{udid:f.device,tab:'phone',owner:'alice',mine:true}]}}),readTargets:()=>({alice:[f.device]}),backend:{verify:async()=>{},tree:async()=>toggles}});
 const run=async target=>(await mobile.execute('alice','target_resolve',{target})).data;
 assert.equal((await run({text:'인기 노출'})).ambiguous,true);
 const second=await run({text:'인기 노출',nth:2});assert.equal(second.found,true);assert.equal(second.y,115);
 const missing=await run({text:'인기 노출',nth:4});assert.equal(missing.found,false);assert.equal(missing.count,3);assert.equal(missing.ambiguous,undefined);
});

test('mobile target resolution treats a visible registered obstacle as covering the target',async t=>{
 const f=mobileFixture(t);let current=[];
 const mobile=createQaMobile({shotsDir:f.directory,listDevices:async()=>({ok:true,data:{tabs:[{udid:f.device,tab:'phone',owner:'alice',mine:true}]}}),readTargets:()=>({alice:[f.device]}),backend:{verify:async()=>{},tree:async()=>current}});
 // 말풍선 글자는 대상과 겹치지 않음. 터치를 가로채는 투명 영역은 접근성 트리에 없음
 const shop=el('상점',{type:'Button',frame:{x:300,y:740,width:60,height:40}}),tip=el('친구 초대하고 보상 받기',{type:'StaticText',frame:{x:20,y:100,width:200,height:30}});
 current=[shop,tip];
 const run=async obstacles=>(await mobile.execute('alice','target_resolve',{target:{text:'상점'},...(obstacles?{obstacles}:{})})).data;
 assert.equal((await run()).occluded,false);
 const covered=await run([{text:'친구 초대하고'}]);
 assert.equal(covered.occluded,true);assert.match(covered.blocker.text,/친구 초대하고/);
 assert.equal((await run([{text:'다른 안내'}])).occluded,false);
 current=[shop];assert.equal((await run([{text:'친구 초대하고'}])).occluded,false);
 assert.equal((await mobile.execute('alice','target_resolve',{target:{text:'상점'},obstacles:[{}]})).ok,false);
});

test('mobile background watches first changes for exactly 1000ms and idle drain keeps late responses',async t=>{
 const f=mobileFixture(t);let clock=0,late=false,shots=0;
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mobile7-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const mobile=createQaMobile({shotsDir:directory,listDevices:async()=>({ok:true,data:{tabs:[{udid:f.device,tab:'phone',owner:'alice',mine:true}]}}),readTargets:()=>({alice:[f.device]}),reactionOptions:{now:()=>clock,wait:async ms=>{clock+=ms;},interval:10,tailMs:1},backend:{verify:async()=>{},tree:async()=>[el('Ready'),...(clock>=10?[el(String(clock),{resourceId:'clock'})]:[]),...(late?[el('Help',{resourceId:'help'})]:[])],input:async()=>assert.fail('background must not input'),screenshot:async(_,file)=>{shots++;fs.writeFileSync(file,PNG);}}});t.after(()=>mobile.close('alice'));
 const start=await mobile.execute('alice','background_observe',{duration:1});assert.equal(start.ok,true);assert.equal(start.data.backgroundMs,1000);assert.equal(clock,1000);assert.equal(start.data.pass,true);assert.ok(!start.data.candidates.some(c=>c.code==='K1'||c.code==='K3'));assert.equal(start.data.unexpected[0].atMs,10);assert.ok(start.data.unexpected[0].count>1);
 const clockReaction=start.data.unexpected.find(item=>item.sel==='clock'),clockScene=start.data.scenes.filter(s=>s.claim.candidateId===clockReaction.id);assert.equal(clockScene.length,1);
 late=true;clock=1800;const drain=await mobile.execute('alice','reaction_drain',{});assert.equal(drain.data.reactionId,start.data.reactionId);assert.ok(drain.data.unexpected.some(item=>item.text.includes('Help')&&item.atMs===1800));
 const photos=shots;clock=1900;await mobile.execute('alice','reaction_drain',{});assert.equal(shots,photos);
 const flushed=await mobile.flush('alice',{close:true});assert.equal(flushed.observations[0].reactionId,start.data.reactionId);
});

test('mobile input rechecks the expected target and blocks a newly overlapping element',async t=>{
 const f=mobileFixture(t);let reads=0,inputs=0;
 const save=el('Save',{type:'Button',resourceId:'save'}),cover=el('Cover',{type:'Button',resourceId:'cover'});
 const mobile=createQaMobile({shotsDir:f.directory,listDevices:async()=>({ok:true,data:{tabs:[{udid:f.device,tab:'phone',owner:'alice',mine:true}]}}),readTargets:()=>({alice:[f.device]}),reactionOptions:{interval:1,tailMs:0},backend:{verify:async()=>{},tree:async()=>++reads===1?[save]:[save,cover],input:async()=>inputs++,screenshot:async(_,file)=>fs.writeFileSync(file,PNG)}});t.after(()=>mobile.close('alice'));
 const result=await mobile.execute('alice','tap',{x:6,y:6,expectedTarget:{role:'button',name:'Save'},expect:expectation([{type:'none'}],1)});assert.equal(result.ok,false);assert.match(result.error,/가려/);assert.equal(inputs,0);
});

test('mobile focus and main type share one observation and each input is consumed once',async t=>{
 const f=mobileFixture(t),inputs=[];let clock=0,value='';
 const field=()=>el('Name',{type:'TextField',resourceId:'name',AXValue:value});
 const mobile=createQaMobile({shotsDir:f.directory,listDevices:async()=>({ok:true,data:{tabs:[{udid:f.device,tab:'phone',owner:'alice',mine:true}]}}),readTargets:()=>({alice:[f.device]}),reactionOptions:{now:()=>clock,wait:async ms=>{clock+=ms;},interval:1,tailMs:1},backend:{verify:async()=>{},tree:async()=>[field()],input:async(_,command,args)=>{inputs.push(command);if(command==='type')value=args.text;},screenshot:async(_,file)=>fs.writeFileSync(file,PNG)}});t.after(()=>mobile.close('alice'));
 const expectedTarget={role:'textbox',name:'Name'},args={text:'Ada',x:6,y:6,expectedTarget},expect=expectation([{type:'change',sel:'#name',from:'',to:'Ada'}],100);
 const start=await mobile.execute('alice','reaction_start',{expect,action:{command:'type',args}});assert.equal(start.ok,true,start.error);
 const focus={id:start.data.reactionId,x:6,y:6,expectedTarget};
 assert.equal((await mobile.execute('alice','reaction_focus',{...focus,x:7})).ok,false);assert.deepEqual(inputs,[]);
 const focused=await mobile.execute('alice','reaction_focus',focus);assert.equal(focused.ok,true,focused.error);assert.equal(focused.data.native,true);assert.equal(focused.data.inputAccepted,true);
 assert.equal((await mobile.execute('alice','reaction_focus',focus)).ok,false);assert.deepEqual(inputs,['tap']);
 const typed=await mobile.execute('alice','type',{...args,expect});assert.equal(typed.ok,true,typed.error);
 assert.equal((await mobile.execute('alice','type',{...args,expect})).ok,false);assert.deepEqual(inputs,['tap','type']);
 const ended=await mobile.execute('alice','reaction_end',{id:start.data.reactionId,delivered:true});assert.equal(ended.ok,true,ended.error);assert.equal(ended.data.pass,true);assert.equal(ended.data.effects[0].observed,true);
 assert.equal(ended.data.scenes.filter(scene=>scene.claim.kind==='S1').length,1);
});

test('mobile wait arms without input and observes an overlay disappearance within its bound',async t=>{
 const f=mobileFixture(t);let clock=0,inputs=0;
 const ready=el('Ready'),overlay=el('Overlay',{type:'Dialog',resourceId:'overlay'});
 const mobile=createQaMobile({shotsDir:f.directory,listDevices:async()=>({ok:true,data:{tabs:[{udid:f.device,tab:'phone',owner:'alice',mine:true}]}}),readTargets:()=>({alice:[f.device]}),reactionOptions:{now:()=>clock,wait:async ms=>{clock+=ms;},interval:5,tailMs:1},backend:{verify:async()=>{},tree:async()=>clock<20?[ready,overlay]:[ready],input:async()=>inputs++,screenshot:async(_,file)=>fs.writeFileSync(file,PNG)}});t.after(()=>mobile.close('alice'));
 const expect=expectation([{type:'disappear',sel:'#overlay'}],100);
 const start=await mobile.execute('alice','reaction_start',{expect,action:{command:'wait',args:{}}});assert.equal(start.ok,true,start.error);
 const ended=await mobile.execute('alice','reaction_end',{id:start.data.reactionId,delivered:true});assert.equal(ended.ok,true,ended.error);assert.equal(ended.data.pass,true);assert.equal(ended.data.effects[0].atMs,20);assert.equal(inputs,0);
 const bad=await mobile.execute('alice','reaction_start',{expect,action:{command:'wait',args:{x:1}}});assert.equal(bad.ok,false);assert.equal(inputs,0);
});

test('mobile target resolution accepts the device type shown in snapshot as role and suggests near names when missing',async t=>{
 const f=mobileFixture(t);
 // qa-92771d8c L1 18257: snapshot 의 [TextField] 와 이름을 그대로 적었는데 역할이 textbox 로만 비교돼 못 찾음
 const field=el('상품·브랜드 검색\n상품·브랜드를 검색해주세요',{type:'TextField',resourceId:'search'});
 const mobile=createQaMobile({shotsDir:f.directory,listDevices:async()=>({ok:true,data:{tabs:[{udid:f.device,tab:'phone',owner:'alice',mine:true}]}}),readTargets:()=>({alice:[f.device]}),backend:{verify:async()=>{},tree:async()=>[field]}});
 const run=async target=>(await mobile.execute('alice','target_resolve',{target})).data;
 assert.equal((await run({role:'TextField',name:field.AXLabel})).found,true);
 assert.equal((await run({role:'textbox',name:field.AXLabel})).found,true);
 const missing=await run({role:'TextField',name:'상품·브랜드 검색'});
 assert.equal(missing.found,false);assert.deepEqual(missing.near,[{role:'textbox',name:field.AXLabel}]);
 assert.deepEqual((await run({role:'Button',name:'전혀 다른 이름'})).near,[]);
});

test('mobile key rejection lists the allowed key names',async t=>{
 const f=mobileFixture(t);
 const mobile=createQaMobile({shotsDir:f.directory,listDevices:async()=>({ok:true,data:{tabs:[{udid:f.device,tab:'phone',owner:'alice',mine:true}]}}),readTargets:()=>({alice:[f.device]}),backend:{verify:async()=>{},tree:async()=>[]}});
 const rejected=await mobile.execute('alice','key',{key:'Return',expect:{effects:[{type:'none',oracle:'기능의 용도'}],within:100}});
 assert.equal(rejected.ok,false);assert.match(JSON.stringify(rejected),/Return.*ENTER/);
});

test('mobile declarations accept the catalog fields that qa_play adds and name the rejected field',()=>{
 // qa-92771d8c F1 18489: 반응 목록 연관 반응이 붙은 '전체보기' 단계가 모르는 칸으로 거부됨
 const catalog={type:'appear',role:'Button',name:'뒤로 가기',oracle,id:'catalog-1db6-0',catalogKey:'1db628de5325',needsReview:false};
 assert.equal(validateMobileReaction(expectation([{type:'disappear',role:'Button',name:'분식'},catalog])).effects[1].catalogKey,'1db628de5325');
 assert.throws(()=>validateMobileReaction(expectation([{type:'appear',text:'A',url:'x'}])),/모르는 칸 url/);
 assert.throws(()=>validateMobileReaction(expectation([{type:'navigate',text:'A'}])),/type navigate/);
 assert.throws(()=>validateMobileReaction(expectation([{...catalog,needsReview:'no'}])),/needsReview/);
});

test('mobile unchanged and none are judged even when the last tree read ends after the deadline',async()=>{
 // iOS 트리 조회 약 0.7초: 기한 전에 시작한 조회가 기한 뒤에 끝나면 마지막 판정을 건너뛰어 미관찰이 됨(qa-92771d8c F2 18687·18761)
 for(const [effects,before] of [[[{type:'unchanged',role:'Button',name:'뒤로 가기'}],[el('뒤로 가기',{type:'Button'})]],[[{type:'none'}],[el('Ready')]]]){
  let clock=0;
  const watch=createMobileReaction({before,expect:expectation(effects,1000),action:{command:'tap',args:{x:1,y:1}},identity:{targetId:'phone'},
   now:()=>clock,wait:async ms=>{clock+=ms;},interval:100,tailMs:20,operationTimeoutMs:5000,
   readTree:async()=>{clock+=700;return before;},capture:async()=>({path:'shot.png'})});
  await watch.initial();watch.arm();watch.delivered(true);
  const result=await watch.finish();
  assert.equal(result.effects[0].observed,true,effects[0].type);assert.equal(result.pass,true,effects[0].type);
 }
});
