import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createQaMobile } from "../server/qa-mobile.js";

const require = createRequire(import.meta.url);
const { waitForWebStability, inspectStabilityFrame } = require(process.env.QA_WEB_STABILITY_MUTANT || "../native/electron/cdp-qa-stability.cjs");
const { createObservation } = require("../native/electron/cdp-observation.cjs");
const { createQaCaptureCommands } = require(process.env.QA_CAPTURE_MUTANT || "../native/electron/cdp-qa-capture.cjs");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz8AAAAASUVORK5CYII=", "base64");

function webFixture(probe, pending = () => 0) {
  let clock = 0, samples = 0;
  const send = async method => {
    if (method === "Page.getFrameTree") return { frameTree:{frame:{id:"root"}} };
    if (method === "Page.createIsolatedWorld") return { executionContextId:1 };
    clock += 40;
    return { result:{value:probe(++samples)} };
  };
  return { send, now:()=>clock, observation:{pendingRequests:pending}, samples:()=>samples };
}

test("web capture waits for animation, pending request and DOM quiet together", async () => {
  const f = webFixture(n => ({ animations:n < 2 ? 1:0, quietForMs:n < 4 ? 50:150 }), () => f.samples() < 3 ? 1:0);
  const result = await waitForWebStability(f.send,{id:7},{...f,timeoutMs:300});
  assert.equal(result.stable,true);
  assert.equal(result.waitedMs,160);
  assert.deepEqual(result.remaining,[]);
});

for (const [condition, probe, pending] of [
  ["animations",{animations:1,quietForMs:200},()=>0],
  ["network",{animations:0,quietForMs:200},()=>1],
  ["dom",{animations:0,quietForMs:0},()=>0],
]) test(`web timeout reports remaining ${condition}`,async()=>{
  const f=webFixture(()=>probe,pending);
  const result=await waitForWebStability(f.send,{id:7},{...f,timeoutMs:160});
  assert.equal(result.stable,false);
  assert.deepEqual(result.remaining,[condition]);
  assert.equal(result.waitedMs,160);
});

test("unobservable or stalled web page cannot claim stability",async()=>{
  const f=webFixture(()=>({}));
  const bad=await waitForWebStability(f.send,{id:1},{...f,timeoutMs:100});
  assert.equal(bad.stable,false);assert.ok(bad.remaining.includes("observation"));
  const started=Date.now();
  const stalled=await waitForWebStability(()=>new Promise(()=>{}),{id:1},{timeoutMs:25});
  assert.equal(stalled.stable,false);assert.ok(stalled.remaining.length);
  assert.ok(Date.now()-started<500);
});

test("request tracking keeps unfinished requests and separates child sessions",()=>{
  const o=createObservation({now:Date.now});
  o.noteRequest(7,"same","https://first","");
  o.noteRequest(7,"same","https://child","child");
  o.noteRequest(7,"same","https://redirect","");
  assert.equal(o.pendingRequests(7),2);
  o.finishRequest(7,"same","");assert.equal(o.pendingRequests(7),1);
  o.forgetRequests(7,"child");assert.equal(o.pendingRequests(7),0);
  o.noteRequest(7,"failed","https://failed");o.finishRequest(7,"failed");assert.equal(o.pendingRequests(7),0);
  for(let i=0;i<510;i++)o.noteRequest(7,String(i),"https://pending");
  assert.equal(o.pendingRequests(7),510);
  o.forgetRequests(7);assert.equal(o.pendingRequests(7),0);
});

test("native captures include stable result, tab, address and viewport; before skips wait",async()=>{
  let waits=0;
  const commands=createQaCaptureCommands({fs:{mkdirSync(){},writeFileSync(){}},path,shotsDir:"/qa/shots",
    nativeImage:{createFromBuffer:()=>({getSize:()=>({width:10,height:20})})},
    waitForStability:async()=>{waits++;return {waitedMs:75,stable:false,remaining:["network"]};}});
  const send=async method=>method==="Page.getFrameTree" ? {frameTree:{frame:{id:"root"}}}
    : method==="Page.createIsolatedWorld" ? {executionContextId:1}
    : method==="Runtime.evaluate" ? {result:{value:{dpr:1,masks:[]}}}
    : method==="Page.getLayoutMetrics" ? {cssVisualViewport:{clientWidth:10,clientHeight:20}}
    : {data:PNG.toString("base64")};
  const wc={id:17,getURL:()=>"https://target",getTitle:()=>"target"};
  const after=await commands["qa-screenshot"](send,wc,{});
  assert.equal(after.tab,17);assert.equal(after.url,"https://target");
  assert.deepEqual(after.captureTarget,{type:"tab",id:17});
  assert.deepEqual(after.viewport,{width:10,height:20,dpr:1});assert.equal(after.stability.stable,false);
  const before=await commands["qa-screenshot"](send,wc,{stable:false});
  assert.equal(waits,1);assert.deepEqual(before.stability.remaining,["not-requested"]);
});

test("native annotation metadata uses image-relative coordinates for crop, full page and DPR",async()=>{
  for(const args of [{crop:{x:5,y:10,width:40,height:30},dpr:2},{full:true,dpr:2}]) {
    let clip;
    const commands=createQaCaptureCommands({fs:{mkdirSync(){},writeFileSync(){}},path,shotsDir:"/qa/shots",
      nativeImage:{createFromBuffer:()=>({getSize:()=>({width:clip.width*2,height:clip.height*2})})},
      renderImage:async()=>{throw Error("annotations cannot change original image");}});
    const send=async(method,params)=>method==="Page.getFrameTree" ? {frameTree:{frame:{id:"root"}}}
      : method==="Page.createIsolatedWorld" ? {executionContextId:1}
      : method==="Runtime.evaluate" ? {result:{value:{dpr:1,masks:[]}}}
      : method==="Page.getLayoutMetrics" ? {cssVisualViewport:{clientWidth:100,clientHeight:80,pageY:40},cssContentSize:{width:100,height:160}}
      : (clip=params.clip,{data:PNG.toString("base64")});
    const result=await commands["qa-screenshot"](send,{id:1,getURL:()=>"https://target",getTitle:()=>"target"},
      {...args,stable:false,caption:"label",mark:{x:10,y:20,width:20,height:10,label:"target"}});
    const m=result.marks[0];assert.equal(m.label,"target");
    assert.equal(m.x,args.full ? 10/100:5/40);assert.equal(m.y,args.full ? 60/160:10/30);
    assert.equal(m.w,args.full ? 20/100:20/40);assert.equal(m.h,args.full ? 10/160:10/30);
  }
});

test("mobile screenshot, observe and assertion capture once without image comparison",async t=>{
  const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "capture-stability-test-"));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const device="11111111-1111-4111-8111-111111111111";let shots=0;
  const mobile=createQaMobile({shotsDir:directory,
    listDevices:async()=>({ok:true,data:{tabs:[{udid:device,tab:"phone-tab",owner:"alice",mine:true}]}}),
    readTargets:async()=>({alice:[device]}),backend:{verify:async()=>{},tree:async()=>[
      {type:"StaticText",AXLabel:"Saved",frame:{x:0,y:0,width:100,height:20}}],
    screenshot:async(_device,file)=>{shots++;fs.writeFileSync(file,PNG);}}});
  for(const [command,args] of [["screenshot",{}],["observe",{}],["expect",{mode:"exists",label:"Saved"}]]) {
    const result=await mobile.execute("alice",command,args);
    assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.data.stability.stable,false);assert.deepEqual(result.data.stability.remaining,["not-requested"]);
    assert.equal(result.data.targetId,device);assert.equal(result.data.url,"app://"+device);
    assert.deepEqual(result.data.captureTarget,{type:"device",id:device});
    assert.deepEqual(result.data.viewport,{width:1,height:1,unit:"image-pixels"});
  }
  assert.equal(shots,3);
  const before=await mobile.execute("alice","screenshot",{stable:false});
  assert.equal(shots,4);assert.deepEqual(before.data.stability.remaining,["not-requested"]);
});

test("frame observer resets DOM quiet for text and attribute mutations and counts infinite animations",async()=>{
  let clock=0,changed,observed,animations=[{playState:"running",effect:{getTiming:()=>({iterations:Infinity})}},{playState:"paused"}];
  const document={readyState:"complete",getAnimations:()=>animations};
  const sandbox={document,performance:{now:()=>clock},setTimeout,clearTimeout,cancelAnimationFrame(){},
    requestAnimationFrame:callback=>{clock+=40;queueMicrotask(callback);return 1;},
    MutationObserver:class{constructor(callback){changed=callback;}observe(doc,options){observed={doc,options};}}};
  const context=vm.createContext(sandbox);
  const probe=()=>vm.runInContext(`(${inspectStabilityFrame.toString()})(1000)`,context);
  const first=await probe();assert.equal(first.animations,1);
  assert.equal(observed.doc,document);assert.equal(observed.options.characterData,true);assert.equal(observed.options.attributes,true);
  await probe();await probe();assert.equal((await probe()).quietForMs,160);
  changed([{type:"characterData"}]);assert.equal((await probe()).quietForMs,40);
  clock+=150;animations=[];assert.equal((await probe()).animations,0);
  document.readyState="loading";assert.equal((await probe()).quietForMs,0);
});
