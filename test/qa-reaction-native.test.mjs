import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require=createRequire(import.meta.url);
const {createQaReactionCommands,matchesPattern}=require(process.env.IRIS_NATIVE_REACTION_MODULE||'../native/electron/cdp-qa-reaction.cjs');
function harness(effects,{within=2000,baseline={}}={}) {
  let clock=0,listener,id,shot=0,hook;
  const screenshots=[];
  const snapshot={effects:effects.map((e,i)=>({id:e.id||`e${i+1}`,found:false,...baseline[e.id||`e${i+1}`]})),bodyText:'화면',visibleElements:1,busy:[],broken:[]};
  const send=async (method,args={})=>{
    if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'main'}}};
    if(method==='Page.createIsolatedWorld')return {executionContextId:1};
    if(method==='Runtime.evaluate')return {result:{value:snapshot}};
    return {};
  };
  const wc={id:1};
  const commands=createQaReactionCommands({observation:{subscribeEvents(fn){listener=fn;}},screenshot:async (_s,_w,args)=>{screenshots.push({at:clock,...args});return {path:`scene-${++shot}.png`};},now:()=>clock,sleep:async ms=>{clock+=ms;if(hook)hook(clock);}});
  const emit=(method,params)=>listener(1,method,params,'');
  const dom=payload=>emit('Runtime.bindingCalled',{name:'__irisQaReaction',executionContextId:1,payload:JSON.stringify({id,...payload})});
  return {commands,screenshots,send,setId(value){id=value;},advance(ms){clock+=ms;},emit,dom,setHook(fn){hook=fn;},get now(){return clock;},async start(){const r=await commands['qa-reaction-start'](send,wc,{expect:{effects,within},action:'click',target:{x:1,y:1}});id=r.id;return r;},async end(delivered=true){return commands['qa-reaction-end'](send,wc,{id,delivered});}};
}
const effect=(type,rest={})=>({type,oracle:'명세',...rest});
test('효과 이벤트 순간 S2 촬영과 효과 완료 뒤 200ms 꼬리',async()=>{
  const h=harness([effect('appear',{text:'저장됨'})]);await h.start();const at=h.now;
  h.dom({kind:'dom',effects:[{id:'e1',found:true,text:'저장됨',rect:{x:0,y:0,width:50,height:20}}],changes:[{text:'저장됨',rect:{x:0,y:0,width:50,height:20}}]});
  assert.equal(h.screenshots.length,2);assert.equal(h.screenshots[1].at,at);
  const r=await h.end();assert.equal(r.pass,true);assert.equal(r.elapsedMs,200);assert.deepEqual(r.scenes.map(s=>s.claim.kind),['S1','S2','S3']);assert.equal(r.unexpected.length,0);
});
test('부분 효과 누락은 within 종료와 K1·진단 기록',async()=>{
 const h=harness([effect('appear',{text:'완료'}),effect('request',{method:'POST',path:'/save',status:200})],{within:80});await h.start();h.dom({effects:[{id:'e1',found:true,text:'완료'}]});const r=await h.end();assert.equal(r.pass,false);assert.equal(r.elapsedMs,80);assert.ok(r.candidates.some(c=>c.code==='K1'));assert.ok(r.observation);assert.equal(r.scenes.at(-1).claim.kind,'S3');
});
test('콘솔·예외·5xx·실패 요청은 K2, 같은 변경 요청은 K9',async()=>{
 const h=harness([effect('none')]);await h.start();
 h.emit('Runtime.consoleAPICalled',{type:'error',args:[{value:'저장 오류'}]});h.emit('Runtime.exceptionThrown',{exceptionDetails:{text:'uncaught'}});
 for(const requestId of ['1','2'])h.emit('Network.requestWillBeSent',{requestId,request:{method:'POST',url:'http://site/save',postData:'x=1'}});
 h.emit('Network.responseReceived',{requestId:'1',response:{status:503,url:'http://site/save'}});h.emit('Network.loadingFailed',{requestId:'2',errorText:'failed'});
 const r=await h.end();assert.equal(r.pass,true);assert.equal(r.candidates.filter(c=>c.code==='K2').length,4);assert.equal(r.candidates.filter(c=>c.code==='K9').length,1);assert.ok(r.candidates.every(c=>r.scenes.some(s=>s.id===c.sceneId)));
});
test('무반응 K3와 1초 넘은 보이는 반응 K4',async()=>{
 const no=harness([effect('appear',{text:'완료'})],{within:60});await no.start();assert.ok((await no.end()).candidates.some(c=>c.code==='K3'));
 const late=harness([effect('appear',{text:'완료'})]);await late.start();const start=late.now;let sent=false;late.setHook(now=>{if(!sent&&now-start>1000){sent=true;late.dom({effects:[{id:'e1',found:true,text:'완료'}],changes:[{text:'완료'}]});}});const r=await late.end();assert.ok(r.candidates.some(c=>c.code==='K4'));assert.equal(r.pass,true);
});
test('로딩 10초 K5와 깨진 이미지 K6',async()=>{
 const h=harness([effect('appear',{text:'완료'})],{within:11000});await h.start();h.dom({snapshot:{bodyText:'화면',visibleElements:1,busy:[{rect:{x:1}}],broken:[{text:'bad.png'}]}});const r=await h.end();assert.ok(r.candidates.some(c=>c.code==='K5'));assert.ok(r.candidates.some(c=>c.code==='K6'));
});
test('none도 꼬리 구간의 보이는 변화를 실패로 판정',async()=>{
 const h=harness([effect('none')]);await h.start();let sent=false;h.setHook(()=>{if(!sent){sent=true;h.dom({changes:[{text:'총 4건',from:'총 3건'}]});}});const r=await h.end();assert.equal(r.pass,false);assert.equal(r.unexpected.length,1);
});
test('URL 패턴은 정규식 기호를 문자로 취급',()=>{
 assert.equal(matchesPattern('http://site/a?x=1','/a?x=*'),true);assert.equal(matchesPattern('http://site/abx=1','/a?x=*'),false);
});
test('사진 비교·동적 영역 사진 보정 없음',()=>{
 const source=fs.readFileSync(new URL('../native/electron/cdp-qa-reaction.cjs',import.meta.url),'utf8');assert.doesNotMatch(source,/toBitmap|compareReactionImages|calibrationMasks|createFromPath/);
});

import vm from 'node:vm';
const {reactionWatch}=require(process.env.IRIS_NATIVE_REACTION_MODULE||'../native/electron/cdp-qa-reaction.cjs');
function domHarness(effects=[]) {
 const messages=[],nodes=[];let mutate,tick,clock=0;
 const body={children:nodes,innerText:'화면'};
 const document={body,documentElement:{scrollWidth:800},activeElement:null,querySelectorAll(sel){return sel==='body *'?nodes:nodes.filter(n=>'#'+n.id===sel);},getElementById(id){return nodes.find(n=>n.id===id);},elementFromPoint(){return nodes.find(n=>n.localName==='button')||nodes[0];},addEventListener(){},removeEventListener(){}};
 const context=vm.createContext({document,location:{href:'http://site/'},innerWidth:800,innerHeight:600,Date:{now:()=>clock},MutationObserver:class{constructor(fn){mutate=fn;}observe(){}disconnect(){}},setInterval(fn){tick=fn;return 1;},clearInterval(){},getComputedStyle:n=>({display:'block',visibility:'visible',opacity:'1',overflowX:'visible',...n.css}),binding:raw=>messages.push(JSON.parse(raw))});
 const add=(id,text,tag='div',extra={})=>{const attrs=extra.attrs||{};const node={id,innerText:text,textContent:text,localName:tag,children:[],parentElement:body,isConnected:true,scrollWidth:100,clientWidth:100,css:{},getAttribute(k){return attrs[k]||null;},hasAttribute(k){return k in attrs;},closest(){return null;},getBoundingClientRect(){return {x:10,y:10,width:100,height:20,...this.box};},contains(e){return e===this;},...extra};nodes.push(node);return node;};
 // body는 표시 상태 조회에 필요한 부모 정보만 제공
 body.isConnected=true;body.parentElement=null;body.getAttribute=()=>null;
 return {messages,nodes,document,add,setClock(t){clock=t;},update(n,text){n.innerText=n.textContent=text;mutate();},mutate(records=[]){mutate(records);},start(){vm.runInContext(`(${reactionWatch.toString()})(${JSON.stringify({id:'dom',effects,binding:'binding',deadline:20000})})`,context);},arm(){vm.runInContext('globalThis.__irisQaReactionState.arm()',context);},tick(){tick();}};
}
test('DOM 이력은 반복 숫자와 조작 뒤 총 건수 변경을 모두 기록',()=>{
 const h=domHarness([{id:'e1',type:'none'}]),clock=h.add('clock','0'),total=h.add('total','총 3건');h.start();h.setClock(1000);h.update(clock,'1');h.arm();h.setClock(2000);h.update(clock,'2');assert.equal(h.messages.length,1);h.update(total,'총 4건');assert.equal(h.messages.length,2);assert.deepEqual(h.messages.at(-1).changes.map(c=>c.text),['총 4건']);
});
test('DOM 정상 화면은 후보 없음, 새 값·잘림·이름 누락은 K7 K8 K10',()=>{
 const h=domHarness();h.add('normal','정상');h.start();h.arm();h.tick();assert.equal(h.messages.length,0);
 h.add('leak','undefined');h.add('clip','아주 긴 문구','span',{scrollWidth:200,css:{overflowX:'hidden'}});h.add('unnamed','','button');h.mutate();const codes=h.messages.flatMap(m=>(m.candidates||[]).map(c=>c.code));for(const code of ['K7','K8','K10'])assert.ok(codes.includes(code),code);
});
test('0.8초 토스트는 born DOM 이벤트에 효과와 위치가 있고 gone도 기록',()=>{
 const h=domHarness([{id:'e1',type:'appear',text:'저장됨'}]);h.start();h.arm();const toast=h.add('toast','저장됨','div',{attrs:{role:'status'}});h.mutate();assert.equal(h.messages[0].effects[0].found,true);assert.equal(h.messages[0].changes[0].born,true);assert.equal(h.messages[0].changes[0].rect.width,100);h.setClock(800);h.nodes.splice(h.nodes.indexOf(toast),1);toast.isConnected=false;h.mutate();assert.ok(h.messages.some(m=>m.changes?.some(c=>c.gone)));
});

test('배경 이동으로 위치가 바뀐 요소의 글자 변경도 기록',()=>{
 const h=domHarness(),total=h.add('total','총 3건');h.start();total.box={x:20};h.tick();h.arm();total.box={x:30};h.tick();assert.equal(h.messages.length,1);h.update(total,'총 4건');assert.ok(h.messages.some(m=>m.changes?.some(c=>c.text==='총 4건')));
});

function targetHarness({occluded=false,duplicate=false}={}) {
 const selected={id:'save',localName:'input',innerText:'',textContent:'',getBoundingClientRect:()=>({width:100,height:20}),contains:e=>e===selected};
 const overlay={id:'cover',localName:'div',innerText:'닫기',textContent:'닫기',contains:e=>e===overlay};
 const document={elementFromPoint:()=>occluded?overlay:selected};selected.ownerDocument=document;
 const nodes=[{nodeId:'1',backendDOMNodeId:7,role:{value:'button'},name:{value:'계산된 이름'}}];if(duplicate)nodes.push({...nodes[0],nodeId:'2',backendDOMNodeId:8});
 const methods=[];
 const send=async(method,args={})=>{methods.push(method);
  if(method==='Accessibility.getFullAXTree')return {nodes};
  if(method==='DOM.getBoxModel')return {model:{border:[0,0,100,0,100,20,0,20]}};
  if(method==='DOM.resolveNode')return {object:{objectId:'node'}};
  if(method==='Runtime.callFunctionOn'){const f=vm.runInNewContext('('+args.functionDeclaration+')',{document,getComputedStyle:()=>({display:'block',visibility:'visible'}),innerWidth:800,innerHeight:600,CSS:{escape:x=>x}});return {result:{value:f.call(selected,...args.arguments.map(a=>a.value))}};}
  if(method==='DOM.getNodeForLocation')return {backendNodeId:occluded?9:7};
  if(method==='Accessibility.getPartialAXTree')return {nodes:[{backendDOMNodeId:occluded?9:7,role:{value:occluded?'dialog':'button'},name:{value:occluded?'닫기':'계산된 이름'}}]};
  return {};
 };
 return {send,methods};
}
test('target resolver uses the computed accessibility name and actual elementFromPoint blocker',async()=>{
 const h=harness([]), f=targetHarness({occluded:true});
 const r=await h.commands['qa-target-resolve'](f.send,{id:1},{target:{role:'button',name:'계산된 이름'}});
 assert.equal(r.found,true);assert.equal(r.target.name,'계산된 이름');assert.equal(r.occluded,true);
 assert.equal(r.blocker.sel,'#cover');assert.equal(r.blocker.role,'dialog');assert.equal(r.blocker.text,'닫기');assert.equal(typeof r.blocker.at,'number');
 assert.ok(f.methods.includes('Accessibility.getFullAXTree'));assert.ok(f.methods.includes('Runtime.callFunctionOn'));assert.ok(!f.methods.some(m=>m.startsWith('Input.')));
 const clear=await h.commands['qa-target-resolve'](targetHarness().send,{id:1},{target:{text:'계산된'}});assert.equal(clear.found,true);assert.equal(clear.occluded,false);
 const ambiguous=await h.commands['qa-target-resolve'](targetHarness({duplicate:true}).send,{id:1},{target:{role:'button',name:'계산된 이름'}});assert.equal(ambiguous.found,false);assert.equal(ambiguous.ambiguous,true);
});
test('background observes the first event for a fixed 1000ms without synthetic none failure',async()=>{
 const h=harness([]);let sent=false;
 h.setHook(now=>{if(!sent){sent=true;h.dom({changes:[{selector:'#clock',text:'1'}]});}});
 // Capture the id from the live start result so the binding has the real observation id.
 const original=h.commands['qa-reaction-start'];h.commands['qa-reaction-start']=async(...args)=>{const r=await original(...args);h.setId(r.id);return r;};
 // 실제 명령표처럼 this 없이 호출
 const observe=h.commands['qa-background-observe'];const r=await observe(h.send,{id:1},{duration:4});
 assert.equal(r.backgroundMs,1000);assert.equal(r.elapsedMs,1000);assert.equal(r.pass,true);assert.equal(r.unexpected.length,1);
 assert.equal(r.unexpected[0].atMs,20);assert.equal(h.screenshots.find(s=>s.caption.includes('기대 밖')).at,20);assert.ok(!r.candidates.some(c=>c.code==='K1'||c.code==='K3'));
});
test('unchanged waits the full window and rejects missing baseline or intermediate reversion',async()=>{
 const effectValue=effect('unchanged',{sel:'#total'}),baseline={e1:{found:true,text:'3'}};
 const stable=harness([effectValue],{within:80,baseline});await stable.start();stable.dom({effects:[{id:'e1',found:true,text:'3'}]});assert.equal(stable.screenshots.length,1);const good=await stable.end();assert.equal(good.pass,true);assert.equal(good.effects[0].elapsedMs,80);assert.ok(!good.candidates.some(c=>c.code==='K3'));
 const reverted=harness([effectValue],{within:80,baseline});await reverted.start();reverted.dom({effects:[{id:'e1',found:true,text:'4'}]});reverted.dom({effects:[{id:'e1',found:true,text:'3'}]});assert.equal((await reverted.end()).pass,false);
 const absent=harness([effectValue],{within:80});await assert.rejects(absent.start(),/기대 전제 불성립.*unchanged #total: 조작 전 화면에 조건에 맞는 요소 없음/);
});
test('unchanged DOM sampling includes target signatures and detects same-batch mutations',()=>{
 const h=domHarness([{id:'e1',type:'unchanged',sel:'#total'}]),total=h.add('total','3');h.start();h.arm();total.innerText=total.textContent='4';h.mutate([{target:total,type:'characterData'}]);
 assert.equal(h.messages[0].effects[0].found,true);assert.ok(h.messages[0].effects[0].signature);assert.deepEqual(h.messages[0].unchangedViolated,['e1']);
});
// 무인 실측 e2e5·e2e8: 같은 글자를 다시 쓴 변경을 바뀜으로 판정해 사람이 보기에 그대로인 화면이 실패로 기록됨
test('unchanged ignores a mutation that writes the same value back',()=>{
 const h=domHarness([{id:'e1',type:'unchanged',sel:'#total'}]),total=h.add('total','3');h.start();h.arm();total.innerText=total.textContent='3';h.mutate([{target:total,type:'childList'}]);
 assert.deepEqual(h.messages.flatMap(m=>m.unchangedViolated||[]),[]);
});
test('idle drain keeps a delayed 1800ms response and repeats update counts without another photograph',async()=>{
 const h=harness([effect('appear',{text:'완료'})],{within:80});const started=await h.start();h.dom({effects:[{id:'e1',found:true,text:'완료'}]});await h.end();h.advance(1800);
 h.dom({changes:[{selector:'#help',text:'도움말'}]});const first=await h.commands['qa-reaction-drain'](h.send,{id:1},{});assert.equal(first.id,started.id);assert.equal(first.unexpected[0].atMs,2000);const photos=h.screenshots.length;
 h.advance(500);h.dom({changes:[{selector:'#help',text:'다른 도움말'}]});const second=await h.commands['qa-reaction-drain'](h.send,{id:1},{});
 assert.equal(second.unexpected.length,1);assert.equal(second.unexpected[0].count,2);assert.equal(second.unexpected[0].periodicityMs,500);assert.equal(h.screenshots.length,photos);assert.equal(second.unexpected[0].text,'도움말');
 await h.commands.dispose(1);assert.equal(h.commands.hasActive(1),false);
});
test('error candidates carry the actual error and initiator stack on the candidate itself',async()=>{
 const h=harness([effect('none')]);await h.start();const stack=[{functionName:'save',url:'app.js',lineNumber:7}];
 h.emit('Runtime.consoleAPICalled',{type:'error',args:[{value:'저장 오류'}],stackTrace:{callFrames:stack}});
 h.emit('Network.requestWillBeSent',{requestId:'r',request:{url:'http://site/save',method:'POST'},initiator:{type:'script',stack:{callFrames:stack}}});h.emit('Network.loadingFailed',{requestId:'r',errorText:'offline'});
 const r=await h.end();const consoleError=r.candidates.find(c=>c.kind==='console');assert.equal(consoleError.text,'저장 오류');assert.deepEqual(consoleError.stack,stack);
 const network=r.candidates.find(c=>c.kind==='network');assert.deepEqual(network.initiatorStack,stack);assert.match(network.text,/offline/);assert.equal(typeof network.atMs,'number');
});
test('a moved element with the same text is one K8 move candidate, not a screen change',()=>{
 const h=domHarness([{id:'e1',type:'none'}]);const header=h.add('header','저장 전');h.start();h.arm();
 header.box={x:40};h.mutate();
 const last=h.messages.at(-1);
 assert.deepEqual(last.changes,[]);assert.ok(last.candidates.some(c=>c.code==='K8'&&c.description==='변경 요소의 위치 이동'));
 h.update(header,'저장됨');assert.deepEqual(h.messages.at(-1).changes.map(c=>c.text),['저장됨']);
});
test('a change inside the element observed for an expected effect is part of that effect',async()=>{
 const h=harness([effect('appear',{role:'dialog',name:'시험 가림'})]);await h.start();
 const dialog={x:100,y:100,width:300,height:200};
 h.dom({effects:[{id:'e1',found:true,text:'닫기 시험 가림',rect:dialog}],changes:[{text:'닫기',rect:{x:120,y:120,width:60,height:30},born:true},{text:'총 4건',rect:{x:10,y:500,width:60,height:20}}]});
 const r=await h.end();
 assert.deepEqual(r.unexpected.map(u=>u.text),['총 4건']);
});
test('an unchanged target that only moves keeps the same signature',()=>{
 const h=domHarness([{id:'e1',type:'unchanged',sel:'#stable'}]);const stable=h.add('stable','시험 계정: qa-local');const other=h.add('total','총 3건');h.start();h.arm();
 h.update(other,'총 4건');const before=h.messages.at(-1).effects[0].signature;stable.box={y:60};h.update(other,'총 5건');const moved=h.messages.at(-1).effects[0].signature;
 h.update(stable,'시험 계정: 다른 값');const edited=h.messages.at(-1).effects[0].signature;
 assert.equal(moved,before);assert.notEqual(edited,moved);
});
test('a child that disappears with an expected disappearing dialog is part of that effect',async()=>{
 const dialog={x:100,y:100,width:300,height:200};
 const h=harness([effect('disappear',{role:'dialog',name:'시험 가림'})],{baseline:{e1:{found:true,rect:dialog}}});await h.start();
 h.dom({effects:[{id:'e1',found:false}],changes:[{text:'닫기',gone:true,rect:{x:120,y:120,width:60,height:30}},{text:'총 4건',gone:true,rect:{x:10,y:500,width:60,height:20}}]});
 const r=await h.end();
 assert.deepEqual(r.unexpected.map(u=>u.text),['총 4건']);
});
test('target resolver treats img and image roles as the same image role',async()=>{
 const h=harness([]), f=targetHarness();
 const image={role:{value:'image'},name:{value:'배너 미리보기'}};
 const send=async(method,args)=>method==='Accessibility.getFullAXTree'?{nodes:[{nodeId:'1',backendDOMNodeId:7,...image}]}
  :method==='Accessibility.getPartialAXTree'?{nodes:[{backendDOMNodeId:7,...image}]}:f.send(method,args);
 const r=await h.commands['qa-target-resolve'](send,{id:1},{target:{role:'img',name:'배너 미리보기'}});
 assert.equal(r.found,true);
});
test('target resolver does not report the wrapping parent of a disabled target as a blocker',async()=>{
 const h=harness([]), f=targetHarness({occluded:true});
 const send=async(method,args)=>{
  if(method!=='Runtime.callFunctionOn')return f.send(method,args);
  const selected={id:'add',localName:'button',disabled:true,getBoundingClientRect:()=>({width:100,height:20}),contains:e=>e===selected};
  const wrapper={id:'row',localName:'div',innerText:'브랜드 추가',textContent:'브랜드 추가',contains:e=>e===wrapper||e===selected};
  const document={elementFromPoint:()=>wrapper};selected.ownerDocument=document;
  const fn=vm.runInNewContext('('+args.functionDeclaration+')',{document,getComputedStyle:()=>({display:'block',visibility:'visible',pointerEvents:'auto'}),innerWidth:800,innerHeight:600,CSS:{escape:x=>x}});
  return {result:{value:fn.call(selected,...args.arguments.map(a=>a.value))}};
 };
 const r=await h.commands['qa-target-resolve'](send,{id:1},{target:{role:'button',name:'계산된 이름'}});
 assert.equal(r.found,true);assert.equal(r.occluded,false);
});
