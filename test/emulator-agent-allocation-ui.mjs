import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import puppeteer from "puppeteer-core";

const { headlessLaunchOptions } = createRequire(import.meta.url)("../bin/headless-browser.cjs");
const web = path.resolve(import.meta.dirname, "../web");
const fixture = `
import { initCapability, panelHtml } from '/js/emulator/boot.js';
import { setCenterSpace } from '/js/center/tab-store.js';
const runtime='com.apple.CoreSimulator.SimRuntime.iOS-18-3';
const modelId='com.apple.CoreSimulator.SimDeviceType.iPhone-13';
window.devices=[{udid:'A',name:'iPhone 13',modelId,runtime,state:'Shutdown',isAvailable:true},
 {udid:'SE',name:'iPhone SE',modelId:'se3',runtime,state:'Shutdown',isAvailable:true}];
window.calls=[]; window.messages=[]; window.creations=[]; window.failCreate=false; window.failAttach=false; window.settingsOk=true; window.stopListeners=[];
const host={
 getSettings:async()=>settingsOk?({ok:true,settings:{mobileEmulatorDefaultDeviceUdid:'A'}}):({ok:false,error:'settings error'}),
 createDevice:async args=>{creations.push(args); if(failCreate)return {ok:false,error:'create failed'}; await new Promise(r=>setTimeout(r,20)); const device={...devices[0],udid:'copy-'+creations.length,name:'iPhone 13 · '+(creations.length+1),state:'Shutdown'};devices.push(device);return {ok:true,device};},
 rpc:async(method,args)=>{
  calls.push({method,args});
  if(method==='emulator.availability')return {ok:true,result:{platform:'darwin',simctl:{ok:true},serveSim:{ok:true},android:{},devices:devices.map(d=>({...d}))}};
  if(method==='emulator.listDevices')return {ok:true,result:devices.map(d=>({...d,id:d.udid,detail:d.runtime,state:d.state.toLowerCase()}))};
  if(method==='emulator.attach') {if(failAttach)return {ok:false,error:{message:'attach failed'}};const d=devices.find(d=>d.udid===args.device);d.state='Booted';return {ok:true,result:{attached:true,info:{deviceUdid:d.udid,displayName:d.name,state:'Booted'}}};}
  return {ok:true,result:{}};
 },
 useVolume:async()=>({ok:true,volume:1,muted:false}),openWindow:async()=>({ok:true}),closeWindow:async()=>({ok:true}),
 onWindowClosed(){},onQuitting(){},onWindowBounds(){},onControlRequest(){},setPickState(){},setRecordState(){},onSessionStopped(fn){stopListeners.push(fn);return()=>{};}
};
document.querySelector('#emu-panel').innerHTML=panelHtml;
setCenterSpace('space');
window.feature=initCapability({acHost:{emulator:host},getSelectedSpaceId:()=> 'space',getSpaces:()=>[{id:'space'}],spk:id=>id,renderTabs(){},showActiveTab(){},wsSend:m=>messages.push(m)});
feature.screen.enter();window.ready=true;
`;

async function withPage(run) {
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, "http://localhost").pathname;
      let content;
      if (pathname === "/") {
        res.setHeader("Content-Type", "text/html");
        content = '<!doctype html><body class="layout-on emu-active"><main class="app"><aside id="emu-panel"></aside><div id="center"><div id="tabbar-row"></div><div id="emulatorview"></div></div></main><script type="module" src="/fixture.js"></script>';
      } else if (pathname === "/fixture.js") content = fixture;
      else {
        const file = path.resolve(web, `.${pathname}`);
        if (!file.startsWith(`${web}/`)) throw new Error("invalid path");
        content = await readFile(file);
      }
      if (pathname !== "/") res.setHeader("Content-Type", "text/javascript");
      res.end(content);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await puppeteer.launch(headlessLaunchOptions());
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.ready);
    await page.waitForSelector(".emu-dp-row");
    await run(page);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function request(page,id,opts={}) {
 await page.evaluate(({id,opts})=>feature.ws['emulator-ask']({kind:'open',id,owner:'agent',wait:5000,limit:8,diskOk:true,...opts}),{id,opts});
 await page.waitForFunction(id=>messages.some(m=>m.id===id),{},id);
 return page.evaluate(id=>messages.find(m=>m.id===id),id);
}

test('MCP 기본 기기를 쓰는 동안 같은 기종의 빈 기기를 먼저 쓰고 모두 쓰일 때만 추가한다',async()=>withPage(async page=>{
 await page.evaluate(()=>devices.push({...devices[0],udid:'idle',name:'iPhone 13 · 2'}));
 assert.equal((await request(page,'first')).udid,'A');
 assert.equal((await request(page,'second',{owner:'other'})).udid,'idle');
 assert.equal(await page.evaluate(()=>creations.length),0);
 const third=await request(page,'third',{owner:'third'});
 assert.equal(third.udid,'copy-1');
 assert.deepEqual(await page.evaluate(()=>creations),[{platform:'ios',sourceDevice:'A',sourceName:'iPhone 13'}]);
 assert.equal(await page.evaluate(()=>calls.some(c=>c.method==='emulator.attach'&&c.args.device==='SE')),false);
}));

test('같은 세션 additional은 기존 기기를 유지하며 별도 탭을 연다',async()=>withPage(async page=>{
 assert.equal((await request(page,'first')).udid,'A');
 const added=await request(page,'added',{device:'A',additional:true});
 assert.equal(added.udid,'copy-1');
 await page.evaluate(()=>feature.ws['emulator-ask']({kind:'list',id:'list'}));
 const tabs=await page.evaluate(()=>messages.find(m=>m.id==='list').tabs);
 assert.deepEqual(tabs.map(t=>t.udid).sort(),['A','copy-1']);
 assert.ok(tabs.every(t=>t.owner==='agent'));
 assert.equal(await page.evaluate(()=>calls.filter(c=>c.method==='emulator.shutdown').length),0);
}));

test('동시 추가 요청은 서로 다른 기기를 예약하고 같은 세션의 기본 요청은 중복 생성하지 않는다',async()=>withPage(async page=>{
 const first=await Promise.all([request(page,'a'),request(page,'b')]);
 assert.ok(first.every(r=>r.udid==='A'));
 const extra=await Promise.all([request(page,'x',{additional:true,device:'A'}),request(page,'y',{additional:true,device:'A'})]);
 assert.equal(new Set(extra.map(r=>r.udid)).size,2);
 assert.ok(extra.every(r=>r.ok&&r.udid!=='A'));
 assert.equal(await page.evaluate(()=>creations.length),2);
}));

test('용량·동시실행 한도·생성 오류·설정 오류에서 다른 모델을 선택하거나 기기를 더 만들지 않는다',async()=>withPage(async page=>{
 await request(page,'first');
 const disk=await request(page,'disk',{additional:true,device:'A',diskOk:false});
 assert.equal(disk.code,'capacity');
 const capacity=await request(page,'capacity',{additional:true,device:'A',limit:1});
 assert.equal(capacity.code,'capacity');
 assert.equal(await page.evaluate(()=>creations.length),0);
 await page.evaluate(()=>failCreate=true);
 assert.equal((await request(page,'failure',{additional:true,device:'A'})).error,'create failed');
 await page.evaluate(()=>settingsOk=false);
 assert.equal((await request(page,'settings',{owner:'other'})).error,'settings error');
 assert.equal(await page.evaluate(()=>calls.filter(c=>c.method==='emulator.attach').length),1);
}));

test('UI 점검에서 다른 기종을 명시하면 해당 기기를 선택한다',async()=>withPage(async page=>{
 assert.equal((await request(page,'se',{device:'SE'})).udid,'SE');
 assert.equal(await page.evaluate(()=>creations.length),0);
}));

test('꺼진 공용 화면의 기기는 새 기기를 만들지 않고 세션에 배정한다',async()=>withPage(async page=>{
 await page.click('.emu-dp-row');
 await page.waitForFunction(()=>calls.some(c=>c.method==='emulator.attach'&&c.args.device==='A'));
 await page.evaluate(()=>{
  devices[0].state='Shutdown';
  const call=calls.find(c=>c.method==='emulator.attach'&&c.args.device==='A');
  for(const fn of stopListeners) fn({worktree:call.args.worktree,device:'A'});
 });
 const result=await request(page,'reuse');
 assert.equal(result.udid,'A');
 assert.equal(await page.evaluate(()=>creations.length),0);
 assert.equal(await page.$$eval('.emu-group-tabs [role=tab]',els=>els.length),1);
 await page.evaluate(()=>feature.ws['emulator-ask']({kind:'list',id:'list'}));
 assert.equal(await page.evaluate(()=>messages.find(m=>m.id==='list').tabs[0].owner),'agent');
}));


test('화면이 닫힌 지정 기기를 보존하고 명시적인 추가 요청은 원본을 재사용하지 않는다',async()=>withPage(async page=>{
 const first=await request(page,'reserved',{reservedDevices:['A']});
 assert.equal(first.udid,'copy-1');
 const extra=await request(page,'extra',{owner:'other',additional:true,device:'A'});
 assert.equal(extra.udid,'copy-2');
 assert.equal(await page.evaluate(()=>calls.some(c=>c.method==='emulator.attach'&&c.args.device==='A')),false);
}));


test('추가 기기의 연결 실패 후에는 생성한 기기를 다시 쓰고 더 만들지 않는다',async()=>withPage(async page=>{
 await request(page,'first');
 await page.evaluate(()=>failAttach=true);
 assert.equal((await request(page,'failed',{additional:true,device:'A'})).ok,false);
 await page.evaluate(()=>failAttach=false);
 const retry=await request(page,'retry',{additional:true,device:'A'});
 assert.equal(retry.udid,'copy-1');
 assert.equal(await page.evaluate(()=>creations.length),1);
}));


test('공용 기기 재사용 연결이 실패하면 소유 예약을 해제해 다음 세션도 재사용한다',async()=>withPage(async page=>{
 await page.click('.emu-dp-row');
 await page.waitForFunction(()=>calls.some(c=>c.method==='emulator.attach'&&c.args.device==='A'));
 await page.evaluate(()=>{
  devices[0].state='Shutdown';
  const call=calls.find(c=>c.method==='emulator.attach'&&c.args.device==='A');
  for(const fn of stopListeners) fn({worktree:call.args.worktree,device:'A'});
  failAttach=true;
 });
 assert.equal((await request(page,'failure')).ok,false);
 await page.evaluate(()=>failAttach=false);
 assert.equal((await request(page,'next',{owner:'next-agent'})).udid,'A');
 assert.equal(await page.evaluate(()=>creations.length),0);
}));
