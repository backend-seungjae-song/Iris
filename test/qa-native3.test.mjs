import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const require = createRequire(import.meta.url);
const { createQaInputCommands } = require("../native/electron/cdp-qa-input.cjs");
const { createQaLoginCommands, inspectLoginPage } = require("../native/electron/cdp-qa-login.cjs");
const { createQaCaptureCommands, imageRenderer, momentMark, inspectCapturePage } = require("../native/electron/cdp-qa-capture.cjs");
const { createQaViewportCommands } = require("../native/electron/cdp-qa-viewport.cjs");
const { createDeviceEmulation } = require("../native/electron/cdp-device-emulation.cjs");
const safety = require("../native/electron/cdp-result-safety.cjs");
const { createAiLoginPolicy } = require("../native/electron/ai-login-policy.cjs");
const { createObservation } = require("../native/electron/cdp-observation.cjs");

function selectFixture(options, { disabled = false, multiple = false, tag = "select", selectedIndex } = {}) {
  const calls = [];
  const send = async (method, args) => {
    calls.push([method, args]);
    if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 100, clientHeight: 100 } };
    if (method === "DOM.getNodeForLocation") return { backendNodeId: 9 };
    if (method === "Accessibility.getPartialAXTree") return { nodes: [{ backendDOMNodeId:9, role:{value:"combobox"},name:{value:"지역"} }] };
    if (method === "DOM.describeNode") return { node:{localName:tag,attributes:[]} };
    if (method === "DOM.resolveNode") return {object:{objectId:"select"}};
    if (method === "Runtime.callFunctionOn") return {result:{value:args.functionDeclaration.includes("options:") ? tag === "select" ? {options,disabled,multiple,selectedIndex} : null : {disabled}}};
    return {};
  };
  send.on = () => send;
  return {send,calls};
}

test("native select resolves text/value/index without changing page or sending input", async () => {
  for (const selector of [{index:1},{text:"서울"},{value:"seoul"}]) {
    const f = selectFixture([{index:0,text:"선택",value:""},{index:1,text:"서울",value:"seoul",disabled:false}]);
    const result = await createQaInputCommands()["qa-select-resolve"](f.send,{}, {x:20,y:20,...selector});
    assert.equal(result.index,1); assert.equal(result.selected,"서울");
    assert.equal(f.calls.some(([method,args]) => method.startsWith("Input.") || /dispatchEvent|\.value\s*=|selectedIndex\s*=/.test(JSON.stringify(args))),false);
    assert.equal(f.calls.at(-1)[0],"Runtime.releaseObject");
  }
});

test("native select refuses disabled, duplicate, missing, multiple and nonselect options", async () => {
  for (const [options,settings,selector] of [
    [[{index:0,text:"동일",value:"a"},{index:1,text:"동일",value:"b"}],{}, {text:"동일"}],
    [[{index:0,text:"없음",value:"a",disabled:true}],{}, {index:0}],
    [[{index:0,text:"항목",value:"a"}],{multiple:true}, {index:0}],
    [[{index:0,text:"항목",value:"a"}],{disabled:true}, {index:0}],
    [[],{tag:"button"},{index:0}], [[],{}, {index:99}],
  ]) {
    const f=selectFixture(options,settings);
    await assert.rejects(createQaInputCommands()["qa-select-resolve"](f.send,{}, {x:20,y:20,...selector}));
  }
});

test("native select key count skips disabled options",async()=>{
  const f=selectFixture([{index:0,text:"사용 안 함",value:"0",disabled:true},{index:1,text:"첫 항목",value:"1"},{index:2,text:"사용 안 함",value:"2",disabled:true},{index:3,text:"목표",value:"3"}]);
  const result=await createQaInputCommands()["qa-select-resolve"](f.send,{}, {x:10,y:10,text:"목표"});
  assert.equal(result.index,3);assert.equal(result.keySteps,1);
});

test("native select counts first-letter presses from the current selection, wrapping and skipping other letters",async()=>{
  const options=[{index:0,text:"추가할 브랜드",value:""},{index:1,text:"교촌치킨 순살",value:"u1"},{index:2,text:"교촌치킨",value:"u2"},{index:3,text:"BBQ",value:"u3"}];
  for(const [selectedIndex,text,count] of [[0,"교촌치킨",2],[2,"교촌치킨 순살",1],[2,"교촌치킨",0],[0,"BBQ",1],[3,"교촌치킨",2]]) {
    const result=await createQaInputCommands()["qa-select-resolve"](selectFixture(options,{selectedIndex}).send,{}, {x:10,y:10,text});
    assert.deepEqual(result.typeahead,{char:Array.from(text)[0],count},`${selectedIndex}→${text}`);
  }
});

test("payment/identity classification blocks ordinary QA click and type before any input", async () => {
  for(const action of ["click","type","key"]) {
    const calls=[];
    const send=async(method)=>{calls.push(method);
      if(method==="Page.getFrameTree")return {frameTree:{frame:{id:"root"}}};
      if(method==="Page.createIsolatedWorld")return {executionContextId:1};
      return {result:{value:{fields:[],reasons:["카드 정보 입력"]}}};}; send.on=()=>send;
    const result=await createQaInputCommands()["qa-input"](send,{}, {action,x:10,y:10,text:"secret",key:"Enter"});
    assert.equal(result.humanRequired,true);assert.equal(result.ok,false);
    assert.deepEqual(calls,["Page.getFrameTree","Page.createIsolatedWorld","Runtime.evaluate"]);
  }
});

test("payment/identity detector reads visible DOM signals without mutation", () => {
  const element={getBoundingClientRect:()=>({left:1,top:1,right:20,bottom:20,width:19,height:19}),src:"https://checkout.example/payment"};
  const value=vm.runInNewContext(`(${inspectLoginPage.toString()})()`,{
    innerWidth:100,innerHeight:100,getComputedStyle:()=>({display:"block",visibility:"visible",opacity:"1"}),
    document:{querySelectorAll:selector=>selector === "iframe" ? [element] : selector.includes("cc-number") ? [element] : []}
  });
  assert.deepEqual(Array.from(value.reasons),["프레임 안 화면은 사람이 확인해야 합니다","카드 정보 입력","결제 창"]);
});

test("generic same-origin iframe sensitive inputs and inaccessible iframe require a person",()=>{
  const child={querySelectorAll:selector=>selector.includes("cc-number") ? [element] : []};
  const element={getBoundingClientRect:()=>({left:1,top:1,right:20,bottom:20,width:19,height:19}),contentDocument:child};
  const context={innerWidth:100,innerHeight:100,getComputedStyle:()=>({display:"block",visibility:"visible",opacity:"1"}),document:{querySelectorAll:selector=>selector==="iframe"?[element]:[]}};
  assert.deepEqual(Array.from(vm.runInNewContext(`(${inspectLoginPage.toString()})()`,context).reasons),["카드 정보 입력"]);
  delete element.contentDocument;
  assert.deepEqual(Array.from(vm.runInNewContext(`(${inspectLoginPage.toString()})()`,context).reasons),["프레임 안 화면은 사람이 확인해야 합니다"]);
});

test("capture masks same-origin iframe passwords and inaccessible frame content",()=>{
  const password={getBoundingClientRect:()=>({x:2,y:3,width:10,height:8})};
  const child={querySelectorAll:selector=>selector.includes("password")?[password]:[]};
  const frame={getBoundingClientRect:()=>({x:20,y:30,width:40,height:30}),contentDocument:child};
  const context={window:{devicePixelRatio:2},getComputedStyle:()=>({display:"block",visibility:"visible"}),document:{querySelectorAll:selector=>selector==="iframe"?[frame]:[]}};
  const masks=vm.runInNewContext(`(${inspectCapturePage.toString()})()`,context).masks;
  assert.equal(masks[0].x,22);assert.equal(masks[0].y,33);
  delete frame.contentDocument;
  assert.equal(vm.runInNewContext(`(${inspectCapturePage.toString()})()`,context).masks[0].width,40);
});

function loginFixture({ reasons = [], valid = true, origin = "http://localhost:4291", allowed = true, password = "x" } = {}) {
  let inputCalls=0;
  const wc={id:3901,getURL:()=>origin};
  const fields=[{field:"username",x:10,y:20},{field:"password",x:10,y:40}];
  const send=async(method,args)=>{
    if(method==="Page.getFrameTree")return {frameTree:{frame:{id:"root"}}};
    if(method==="Page.createIsolatedWorld")return {executionContextId:1};
    if(method==="Runtime.evaluate")return {result:{value:args.expression.includes("inspectLoginPage") ? {fields,reasons} : valid}};
    return {};
  };
  const provider=async(_wc,opts)=>({origin,accounts:allowed || opts.qaApproved ? [{username:"tester",password,allowed,local:true}] : [],unavailable:allowed?[]:[{username:"tester",allowed:false,local:false}]});
  const commands=createQaLoginCommands({loginProvider:()=>provider,resultSafety:safety,input:async(_send,_wc,args)=>{
    inputCalls++; await args.verifyBeforeInput(); return {ok:true,trusted:true,received:[{type:"input",trusted:true,name:password}],target:{name:password}};
  }});
  return {wc,send,commands,fields,inputCalls:()=>inputCalls};
}

test("saved/local login lists public accounts and sends password only through secure input", async () => {
  const f=loginFixture();
  const info=await f.commands["qa-login-info"](f.send,f.wc,{});
  assert.equal(info.humanRequired,false);assert.equal(info.accounts[0].username,"tester");
  assert.equal(Object.hasOwn(info.accounts[0],"password"),false);
  const result=await f.commands["qa-login-input"](f.send,f.wc,{origin:info.origin,accountId:info.selectedAccount,field:"password",x:10,y:40});
  assert.equal(result.length,1);assert.equal(result.trusted,true);
  assert.equal(result.target.name,"••••••••");assert.equal(result.received[0].name,"••••••••");
  safety.forgetSecrets(f.wc.id);
});

test("login rejects source changes, wrong account/field, nonempty focus, protected step before typing", async () => {
  for(const params of [{origin:"https://other.invalid"},{accountId:"bad"},{field:"card"},{x:15},{valid:false},{reasons:["인증번호 입력"]}]) {
    const f=loginFixture({...params,origin:"http://localhost:4291"});
    const info=await f.commands["qa-login-info"](f.send,f.wc,{});
    await assert.rejects(f.commands["qa-login-input"](f.send,f.wc,{origin:info.origin,accountId:info.selectedAccount,field:"password",x:10,y:40,...params}));
    assert.equal(f.inputCalls(),0);safety.forgetSecrets(f.wc.id);
  }
});

test("unapproved saved account requires internal approval and remains public before approval",async()=>{
  const f=loginFixture({allowed:false,password:"private-password"});
  const info=await f.commands["qa-login-info"](f.send,f.wc,{});
  assert.equal(info.accounts[0].allowed,false);assert.equal(info.humanRequired,false);
  const args={origin:info.origin,accountId:info.selectedAccount,field:"password",x:10,y:40};
  await assert.rejects(f.commands["qa-login-input"](f.send,f.wc,args));
  assert.equal((await f.commands["qa-login-input"](f.send,f.wc,{...args,approved:true})).trusted,true);
  safety.forgetSecrets(f.wc.id);
});

for(const [origin,savedUsable] of [["http://localhost:4291",true],["https://example.com",false]])
test(`QA provider discovers local account and reads partition saved accounts without preload value writes (${origin})`,async()=>{
  let provider,filled=0;
  createAiLoginPolicy({fs:{readFileSync:()=>"[]"},path:require("node:path"),stateDir:"/mock",ipcMain:{handle(){}},isTrustedSender:()=>true,
    credentialService:{listForOrigin:(partition,url)=>{assert.equal(partition,"partition");assert.equal(url,origin);return [{username:"saved"}];},passwordFor:()=>"test-value"},
    partitionForSession:()=>"partition",localLoginFor:()=>savedUsable && ({username:"local",password:"local-test-value",from:".iris-local.json"}),
    setLoginProvider:(value)=>{provider=value;},ctlSend:()=>{filled++;}});
  const wc={id:9,session:{},getURL:()=>origin,send:()=>{filled++;}};
  const first=await provider(wc,{qaAccounts:true});
  // 로컬 주소는 계정별 허용 없이 저장 계정을 씀. 원격은 허용한 계정만
  if(savedUsable){assert.deepEqual(first.accounts.map(a=>[a.username,a.allowed]),[["saved",true],["local",true]]);assert.equal(first.unavailable.length,0);}
  else{assert.equal(first.accounts.length,0);assert.equal(first.unavailable[0].username,"saved");}
  const approved=await provider(wc,{qaAccounts:true,qaApproved:true});assert.equal(approved.accounts.length,savedUsable?2:1);assert.equal(filled,0);
});

test("QA moment capture uses protected image callback, keeps sidecar and never falls back after error",async()=>{
  assert.deepEqual(momentMark([1,2,3,4],"순간 알림"),{x:1,y:2,width:3,height:4,label:"순간 알림"});
  const moments=createObservation({now:()=>100,shotsDir:"/mock",captureHold:()=>{throw Error("unexpected hold");},isTabShown:()=>false,
    captureMoment:async()=>({path:"/qa/qa-moment-test.png",caption:"순간 알림",marks:[{x:1,y:2,width:3,height:4}]})});
  await moments.noteMoment(1,()=>{throw Error("unprotected screenshot");},{kind:"born",why:"role",text:"순간 알림",id:"notice"});
  const captured=moments.observe(1,"all",40).moments[0];assert.equal(captured.shot,"/qa/qa-moment-test.png");assert.equal(captured.caption,"순간 알림");assert.equal(captured.marks.length,1);
  const drained=moments.drainMoments(1).list[0];assert.equal(drained.caption,"순간 알림");assert.equal(drained.marks.length,1);assert.equal(drained.ts,100);
  const failed=createObservation({now:()=>100,shotsDir:"/mock",captureHold:()=>{throw Error("unexpected hold");},isTabShown:()=>false,captureMoment:async()=>{throw Error("mask failure");}});
  await failed.noteMoment(1,()=>{throw Error("unprotected screenshot");},{kind:"born",why:"role",text:"순간 알림",id:"notice"});
  assert.equal(failed.observe(1,"all",40).moments[0].shot,null);assert.match(failed.observe(1,"all",40).moments[0].shotError,/QA/);
});

test("native QA intermediate commands preserve moments until explicit observe",async()=>{
  const source=readFileSync(new URL("../native/electron/cdp-control.cjs",import.meta.url),"utf8");
  const body=source.match(/async function execWithReattach\(webContentsMod, wcId, cmd, args\) \{[\s\S]*?\n\}/)?.[0];assert.ok(body);
  let drains=0,commits=0;
  const attachBody=source.match(/function attachMoments\(wcId, cmd, out\) \{[\s\S]*?\n\}/)?.[0];assert.ok(attachBody);
  const context={qaContents:new Set([1]),execWithReattachRaw:async()=>({ok:true}),observation:{drainMoments:()=>{drains++;return {list:[{text:"알림"}],commit:()=>{commits++;}};}}};
  vm.runInNewContext(attachBody,context);
  const run=vm.runInNewContext(`(${body})`,context);
  for(const command of ["qa-mode","qa-screenshot","snapshot","qa-input"])await run({},1,command,{});
  assert.equal(drains,0);assert.equal(commits,0);
  const observed=await run({},1,"qa-observe",{});assert.equal(observed.moments[0].text,"알림");assert.equal(drains,1);assert.equal(commits,1);
  await run({},2,"snapshot",{});assert.equal(drains,2);
});

function captureFixture({ size = {width:100,height:80}, fail = false }={}) {
  const calls=[],writes=[],holds=[],rendered=[];
  const send=async(method,args)=>{
    calls.push([method,args]);
    if (["Runtime.evaluate","Page.getLayoutMetrics"].includes(method)) assert.equal(holds.at(-1),true,"capture layout must be measured while held");
    if(method==="Page.getFrameTree")return {frameTree:{frame:{id:"root"}}};
    if(method==="Page.createIsolatedWorld")return {executionContextId:1};
    if(method==="Runtime.evaluate")return {result:{value:{dpr:1,masks:[{x:10,y:20,width:20,height:10}]}}};
    if(method==="Page.getLayoutMetrics")return {cssVisualViewport:{clientWidth:100,clientHeight:80,pageY:40},cssContentSize:{width:100,height:160}};
    if(method==="Page.captureScreenshot"){if(fail)throw Error("capture failed");return {data:Buffer.from("image").toString("base64")};}
    return {};
  };
  const commands=createQaCaptureCommands({fs:{mkdirSync(){},writeFileSync:(...args)=>writes.push(args)},path:require("node:path"),shotsDir:"/qa/shots",
    nativeImage:{createFromBuffer:()=>({getSize:()=>size})},captureHold:async(id,on)=>{holds.push(on);return true;},
    renderImage:async(png,options)=>{rendered.push(options);return png;},observation:{observe:()=>({console:[{text:"error"}],network:[],moments:[{shot:"/legacy/moment.png",text:"notice"}],counts:{moments:1}})}});
  const wc={id:1,getURL:()=>"http://localhost",getTitle:()=>"QA"};
  return {commands,wc,send,calls,writes,holds,rendered};
}

test("QA capture masks password rectangles, preserves caption/marks and scroll-correct crop without DOM writes",async()=>{
  const f=captureFixture();
  const result=await f.commands["qa-screenshot"](f.send,f.wc,{caption:"결과",mark:{x:1,y:2,width:3,height:4,label:"변경"}});
  assert.match(result.path,/qa-shot-[a-f0-9]+\.png$/);assert.equal(result.caption,"결과");
  assert.equal(f.rendered[0].boxes.every(box=>box.mask),true);assert.equal(f.rendered[0].caption,"");assert.equal(result.marks[0].label,"변경");
  const capture=f.calls.find(([method])=>method==="Page.captureScreenshot");assert.equal(capture[1].clip.y,40);
  assert.deepEqual(f.holds,[true,false]);assert.equal(f.writes.length,1);
  assert.equal(f.calls.some(([,args])=>/dispatchEvent|scrollTo|appendChild|\.value\s*=/.test(JSON.stringify(args))),false);
});

test("QA capture fails clipped full/missing mask/failed capture without writing unmasked bytes",async()=>{
  for(const [config,args] of [[{}, {full:true}],[{fail:true},{}],[{}, {crop:{x:90,y:0,width:20,height:20}}]]) {
    const f=captureFixture(config);
    await assert.rejects(f.commands["qa-screenshot"](f.send,f.wc,args));assert.equal(f.writes.length,0);
    if(f.holds.length)assert.equal(f.holds.at(-1),false);
  }
});

test("QA observe preserves console/network/moments and optional shot metadata",async()=>{
  const f=captureFixture();const result=await f.commands["qa-observe"](f.send,f.wc,{caption:"순간 알림"});
  assert.equal(result.console[0].text,"error");assert.equal(result.moments[0].shot,"/legacy/moment.png");assert.equal(result.caption,"순간 알림");
  assert.equal(result.screenshot,result.path);
  const other=captureFixture();await other.commands["qa-observe"](other.send,other.wc,{screenshot:false});assert.equal(other.writes.length,0);
});

test("QA viewport restores exact overrides without UA changes, reload or arbitrary navigation",async()=>{
  const commands=createQaViewportCommands({}),wc={},calls=[],send=async(method,args)=>{calls.push([method,args]);return {};};
  assert.equal((await commands["qa-viewport-state"](send,wc)).viewport,null);
  await commands["qa-viewport"](send,wc,{width:390,height:844,dpr:2});
  const saved=(await commands["qa-viewport-state"](send,wc)).viewport;assert.deepEqual(saved,{width:390,height:844,dpr:2});
  await commands["qa-viewport"](send,wc,{width:1440,height:900});await commands["qa-viewport"](send,wc,saved);
  assert.deepEqual((await commands["qa-viewport-state"](send,wc)).viewport,saved);
  await commands["qa-viewport"](send,wc,{clear:true});assert.equal((await commands["qa-viewport-state"](send,wc)).viewport,null);
  assert.equal(calls.some(([method])=>!/^(Emulation.setDeviceMetricsOverride|Emulation.clearDeviceMetricsOverride)$/.test(method)),false);
});

test("QA viewport shares address-bar viewport state and restores its dimensions and automatic DPR",async()=>{
  const calls=[],send=async(method,args)=>{calls.push([method,args]);return {};};
  const wc={id:44,on(){},once(){},getURL:()=>"http://localhost",getUserAgent:()=>"Chrome/140.0.0.0",session:{getUserAgent:()=>"Chrome/140.0.0.0"}};
  const owner=createDeviceEmulation({attach:()=>send,yieldToExplicitViewport(){},notify(){}});
  await owner.apply(wc,{width:1440,height:900,dpr:0});
  const commands=createQaViewportCommands({viewportOwner:owner});
  const saved=(await commands["qa-viewport-state"](send,wc)).viewport;assert.deepEqual(saved,{width:1440,height:900,dpr:0});
  const from=calls.length;await commands["qa-viewport"](send,wc,{width:390,height:844,dpr:2});await commands["qa-viewport"](send,wc,saved);
  assert.deepEqual(owner.viewportFor(wc.id),saved);
  assert.equal(calls.slice(from).some(([method])=>method!=="Emulation.setDeviceMetricsOverride"),false);
  await owner.apply(wc,{width:1300,height:800,dpr:2});assert.deepEqual((await commands["qa-viewport-state"](send,wc)).viewport,{width:1300,height:800,dpr:2});
});

test("native QA modules contain no page value writes/synthetic dispatch/unrestricted evaluation endpoint",()=>{
  for(const file of ["cdp-qa-login.cjs","cdp-qa-capture.cjs","cdp-qa-viewport.cjs"]){
    const source=readFileSync(new URL("../native/electron/"+file,import.meta.url),"utf8");
    assert.equal(/dispatchEvent|Input\.dispatch.*|\.value\s*=|selectedIndex\s*=|async\s+eval\b|args\.expression/.test(source),false,file);
  }
});

test("QA 이미지 가림 창은 offscreen으로 생성하고 성공·실패 뒤 정리",async()=>{
  for(const fail of [false,true]) {
    let options,destroyed=false;
    class Window {
      constructor(args){options=args;this.webContents={executeJavaScript:async()=>{if(fail)throw Error("렌더 실패");return Buffer.from("image").toString("base64");}};}
      async loadURL(){} destroy(){destroyed=true;}
    }
    const render=imageRenderer(Window),pending=render(Buffer.from("png"),{boxes:[],caption:"",scale:1,origin:{x:0,y:0}});
    if(fail) await assert.rejects(pending,/렌더 실패/);else assert.equal((await pending).toString(),"image");
    assert.equal(options.show,false);assert.equal(options.webPreferences.offscreen,true);assert.equal(destroyed,true);
  }
});

test("QA Cmd shortcuts carry text and macOS editing commands so they never fall through to the app menu", async () => {
  const { dispatchKey, macCommands } = require("../native/electron/cdp-qa-keys.cjs");
  const sent = [];
  await dispatchKey(async (_method, params) => sent.push(params), "Meta+A");
  const down = sent[0];
  assert.equal(down.type, "keyDown");
  assert.equal(down.key, "a");
  assert.equal(down.text, "a");
  assert.equal(down.nativeVirtualKeyCode, undefined);
  if (process.platform === "darwin") assert.deepEqual(down.commands, ["selectAll"]);
  assert.deepEqual(macCommands("KeyA", 4, "darwin"), ["selectAll"]);
  assert.deepEqual(macCommands("KeyZ", 12, "darwin"), ["redo"]);
  assert.deepEqual(macCommands("Enter", 0, "darwin"), []);
  assert.deepEqual(macCommands("KeyA", 4, "linux"), []);
});
