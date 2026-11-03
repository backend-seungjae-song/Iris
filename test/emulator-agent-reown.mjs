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
const devices = ['one','two'].map((udid,i)=>({udid,name:'iPhone 13 · '+(i+1),state:'Booted',runtime:'com.apple.CoreSimulator.SimRuntime.iOS-18-3',isAvailable:true,canDelete:true}));
window.calls=[]; window.windows=[]; window.messages=[]; window.currentTarget="session-A"; window.callHook=callHook; let closed;
const host = {
 getSettings:async()=>({ok:true,settings:{}}), setSettings:async settings=>({ok:true,settings}),
 rpc:async(method,args)=>{ calls.push({method,args}); return {ok:true,result: method==='emulator.availability'?{platform:'darwin',simctl:{ok:true},serveSim:{ok:true},android:{},devices}:method==='emulator.listDevices'?devices.map(d=>({...d,id:d.udid,detail:d.runtime,state:d.state.toLowerCase()})):method==='emulator.attach'?{attached:true,info:{deviceUdid:args.device,displayName:devices.find(d=>d.udid===args.device)?.name,state:'Booted'}}:{}}; },
 useVolume:async()=>({ok:true,volume:1,muted:false}),
 deleteDevice:async args=>{if(window.deleteCanceled)return {ok:true,canceled:true};const i=devices.findIndex(d=>d.udid===args.device);devices.splice(i,1);return {ok:true,deleted:true,device:{udid:args.device,persistentId:args.device}}},
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


// 세션이 지정한 기기가 소유자 없는 탭에 열려 있으면 그 탭을 세션 소유로 옮기고, 다른 세션 것은 건드리지 않음
test('에이전트가 지정한 기기의 소유자 없는 탭은 그 세션 소유가 된다', async () => {
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
  for (const [i,udid] of [[0,'one'],[1,'two']]) {
   await page.evaluate(i=>document.querySelectorAll('.emu-dp-row')[i].click(),i);
   await page.waitForFunction(udid=>calls.some(c=>c.method==='emulator.attach'&&c.args.device===udid),{},udid);
  }
  const ask=async(m)=>{
   await page.evaluate(m=>feature.ws['emulator-ask'](m),m);
   await page.waitForFunction(id=>messages.some(x=>x.id===id),{},m.id);
   return page.evaluate(id=>messages.find(x=>x.id===id),m.id);
  };
  const owners=async(id)=>Object.fromEntries((await ask({kind:'list',id})).tabs.map(t=>[t.udid,t.owner]));
  assert.deepEqual(await owners('l0'),{one:null,two:null});
  const opened=await ask({kind:'open',id:'o1',device:'one',owner:'session-B',wait:5000,reservedDevices:[]});
  assert.equal(opened.ok,true,JSON.stringify(opened));
  assert.equal(opened.owner,'session-B');
  // 다른 세션이 등록한 기기와 다른 세션 소유 탭은 그대로
  await ask({kind:'open',id:'o2',device:'two',owner:'session-C',wait:5000,reservedDevices:['two']});
  await ask({kind:'open',id:'o3',device:'one',owner:'session-C',wait:5000,reservedDevices:[]});
  assert.deepEqual(await owners('l1'),{one:'session-B',two:null});
  assert.deepEqual(errors,[]);
 } finally { await browser?.close(); server.close(); }
});
