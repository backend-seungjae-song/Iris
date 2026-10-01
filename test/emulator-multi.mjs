import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { headlessLaunchOptions } = require('../bin/headless-browser.cjs');
const puppeteer = require('puppeteer-core');
const web = path.resolve('web');
const fixture = `
import { initCapability, panelHtml } from '/js/emulator/boot.js';
import { callHook } from '/js/core/hooks.js';
import { setCenterSpace } from '/js/center/tab-store.js';
const devices = ['one','two'].map((udid,i)=>({udid,name:'iPhone 13 · '+(i+1),state:'Booted',runtime:'com.apple.CoreSimulator.SimRuntime.iOS-18-3',isAvailable:true}));
window.calls=[]; window.windows=[]; window.messages=[]; window.currentTarget="session-A"; window.callHook=callHook; let closed;
const host = {
 getSettings:async()=>({ok:true,settings:{}}), setSettings:async settings=>({ok:true,settings}),
 rpc:async(method,args)=>{ calls.push({method,args}); return {ok:true,result: method==='emulator.availability'?{platform:'darwin',simctl:{ok:true},serveSim:{ok:true},android:{},devices}:method==='emulator.listDevices'?devices.map(d=>({...d,id:d.udid,detail:d.runtime,state:d.state.toLowerCase()})):method==='emulator.attach'?{attached:true,info:{deviceUdid:args.device,displayName:devices.find(d=>d.udid===args.device)?.name,state:'Booted'}}:{}}; },
 useVolume:async()=>({ok:true,volume:1,muted:false}),
 openWindow:async args=>{windows.push(args);return {ok:true}},closeWindow:async({tab})=>{closed({tab});return {ok:true}},
 onWindowClosed:fn=>closed=fn,onQuitting(){},onWindowBounds(){},onControlRequest(){},setPickState(){},setRecordState(){}
};
document.querySelector('#emu-panel').innerHTML=panelHtml;
setCenterSpace('space');
window.feature=initCapability({acHost:{emulator:host},getSelectedSpaceId:()=> 'space',getCurTarget:()=>currentTarget,wsSend:m=>messages.push(m),getSpaces:()=>[{id:'space'}],spk:id=>id,renderTabs(){},showActiveTab(){},showToast:console.error});
window.host=host;
window.feature.screen.enter();
window.ready=true;
`;

test('두 기기의 탭·열·외부 창 전환은 실행을 종료하지 않는다', async () => {
 const server = http.createServer(async(req,res)=>{
  try {
   const pathname = new URL(req.url,'http://localhost').pathname;
   let text, type='text/javascript';
   if(pathname==='/') {text='<html><head><link rel="stylesheet" href="/css/00-tokens.css"><link rel="stylesheet" href="/css/01-base.css"><link rel="stylesheet" href="/css/11-center-tabs.css"><link rel="stylesheet" href="/css/33-emulator.css"></head><body class="layout-on emu-active"><main class="app"><aside id="emu-panel"></aside><div id="center"><div id="tabbar-row" class="tabbar-row"></div><div id="emulatorview"></div></div></main><script type="module" src="/fixture.js"></script></body></html>';type='text/html';}
   else if(pathname==='/fixture.js') text=fixture;
   else { const file=path.resolve(web,'.'+pathname); if(!file.startsWith(web+'/'))throw Error();text=await readFile(file);type=pathname.endsWith('.css')?'text/css':'text/javascript'; }
   res.writeHead(200,{'Content-Type':type});res.end(text);
  } catch {res.writeHead(404);res.end();}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 let browser;
 try {
  browser=await puppeteer.launch(headlessLaunchOptions());
  const page=await browser.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.waitForFunction(()=>window.ready);
  await page.waitForSelector('.emu-dp-row');
  await page.evaluate(()=>document.querySelectorAll('.emu-dp-row')[0].click());
  await page.waitForFunction(()=>calls.some(c=>c.method==='emulator.attach'&&c.args.device==='one'));
  await page.evaluate(()=>document.querySelectorAll('.emu-dp-row')[1].click());
  await page.waitForFunction(()=>calls.some(c=>c.method==='emulator.attach'&&c.args.device==='two'));
  assert.equal(await page.$$eval('.emu-group-tabs [role=tab]',els=>els.length),2);
  const keys=await page.evaluate(()=>calls.filter(c=>c.method==='emulator.attach').map(c=>c.args.worktree));
  assert.equal(new Set(keys).size,2);
  await page.evaluate(()=>{window.firstPane=document.querySelector('.emu-group-body .emu-tab-host');});
  await page.click('.emu-group-tabs [role=tab]');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.$eval('.emu-group-tabs [aria-selected=true]',el=>el.textContent),'iPhone 13 · 2');
  await page.click('.emu-group-head button[title="새 세로 열로 분리"]');
  assert.equal(await page.$$eval('.emu-group:not([hidden])',els=>els.length),2);
  await page.evaluate(()=>feature.screen.leave());
  assert.equal(await page.evaluate(()=>firstPane.isConnected),true);
  assert.equal(await page.$$eval('.emu-column .emu-tab-host:not([hidden])',els=>els.length),2);
  await page.evaluate(()=>document.querySelectorAll('.emu-group-head button[title="기본 열의 탭으로 모으기"]')[1].click());
  assert.equal(await page.$$eval('.emu-column .emu-tab-host:not([hidden])',els=>els.length),1);
  await page.evaluate(()=>document.querySelector('.emu-column .emu-group-tools button[title="이 화면을 별도 창으로 옮깁니다"]')?.click());
  await page.waitForFunction(()=>windows.length===1);
  await page.evaluate(()=>host.closeWindow({tab:windows[0].tab}));
  await page.waitForFunction(()=>document.querySelectorAll('.emu-column .emu-group-tabs [role=tab]').length===2);
  assert.deepEqual(await page.evaluate(()=>calls.filter(c=>c.method==='emulator.shutdown')),[]);
  // 지정 요청 뒤 세션을 바꾸면 다른 세션의 입력으로 전달하지 않는다.
  await page.evaluate(()=>{
    const tab=document.querySelector('.emu-column [role=tab]');
    const target=callHook('emulator.pickTarget',tab);
    window.designated=target;
    callHook('emulator.designate',target);
  });
  const pending=await page.evaluate(()=>messages.find(m=>m.type==='emulator.target-pending'));
  assert.equal(pending.udid,'one');
  await page.evaluate(pending=>{
    currentTarget='session-B';
    feature.ws['emulator.target-pending-result']({ok:true,request:pending.request,delimiter:'test-target',udid:pending.udid});
  },pending);
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='pty.input').length),0);
  await page.evaluate(()=>{
    feature.ws['emulator-ask']({kind:'reown',id:'reown',devices:['one'],owner:'session-A'});
    feature.ws['emulator-ask']({kind:'list',id:'list'});
  });
  const tabs=await page.evaluate(()=>messages.find(m=>m.id==='list').tabs);
  assert.equal(tabs.find(t=>t.udid==='one').owner,'session-A');
  assert.equal(tabs.length,2, JSON.stringify({tabs,calls:await page.evaluate(()=>calls)}));
  const keyAfter=await page.evaluate(()=>calls.filter(c=>c.method==='emulator.attach'&&c.args.device==='one').map(c=>c.args.worktree));
  assert.equal(new Set(keyAfter).size,1);
  // 둘을 각각 외부 창에 두고 독립적으로 되돌린다.
  await page.evaluate(()=>document.querySelector('.emu-column .emu-group-tools button[title="이 화면을 별도 창으로 옮깁니다"]').click());
  await page.waitForFunction(()=>windows.length===2);
  await page.evaluate(()=>document.querySelector('.emu-column .emu-group-tools button[title="이 화면을 별도 창으로 옮깁니다"]').click());
  await page.waitForFunction(()=>windows.length===3);
  assert.equal(await page.evaluate(()=>new Set(windows.slice(1).map(w=>w.tab)).size),2);
  await page.evaluate(async()=>{await host.closeWindow({tab:windows[1].tab});await host.closeWindow({tab:windows[2].tab});});
  await page.waitForFunction(()=>document.querySelectorAll('.emu-column [role=tab]').length===2);
  assert.deepEqual(await page.evaluate(()=>calls.filter(c=>c.method==='emulator.shutdown')),[]);
  const savedKeys=await page.evaluate(()=>calls.filter(c=>c.method==='emulator.attach').map(c=>c.args.worktree));
  await page.reload();
  await page.waitForFunction(()=>document.querySelectorAll('.emu-group-tabs [role=tab]').length===2);
  await page.waitForFunction(()=>new Set(calls.filter(c=>c.method==='emulator.attach').map(c=>c.args.worktree)).size===2);
  const restoredKeys=await page.evaluate(()=>calls.filter(c=>c.method==='emulator.attach').map(c=>c.args.worktree));
  assert.deepEqual([...new Set(restoredKeys)].sort(),[...new Set(savedKeys)].sort());
  await page.click('.emu-group-tabs button[title="iPhone 13 · 1"]');
  await page.evaluate(()=>{feature.screen.leave();feature.screen.enter();});
  assert.equal(await page.$eval('.emu-group-tabs [aria-selected=true]',el=>el.textContent),'iPhone 13 · 1');
  await page.click('.emu-group-head button[title="이 기기 화면 닫기"]');
  await page.waitForFunction(()=>calls.some(c=>c.method==='emulator.shutdown'));
  const closedKeys=await page.evaluate(()=>calls.filter(c=>c.method==='emulator.shutdown').map(c=>c.args.worktree));
  const firstKey=await page.evaluate(()=>calls.find(c=>c.method==='emulator.attach'&&c.args.device==='one').args.worktree);
  assert.deepEqual([...new Set(closedKeys)],[firstKey]);
  assert.equal(await page.$eval('.emu-group-tabs [role=tab]',el=>el.textContent),'iPhone 13 · 2');
  assert.deepEqual(errors,[]);
 } finally {await browser?.close();await new Promise(r=>server.close(r));}
});
