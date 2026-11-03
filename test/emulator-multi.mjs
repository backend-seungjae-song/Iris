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

// 기기 패널의 그 기기 행에서 표시 위치를 '같은 열의 탭'으로 골라 외부 창에서 되돌림
async function returnViaPanel(page, device) {
 const index = device === 'one' ? 0 : 1;
 // 분리 직후 패널의 위치 값은 새로 고침해야 '외부 창'이 됨
 await page.evaluate(() => document.querySelector('.emu-ib[title="새로 고침"]').click());
 await page.waitForFunction(i => document.querySelectorAll('.emu-dp-placement .cc-dd-value')[i]?.textContent === '외부 창', {}, index);
 // 기기 패널은 레일 화면을 나가면 숨겨져 메뉴가 화면에 안 보임. 열고 항목 클릭 이벤트를 보냄
 await page.evaluate(i => document.querySelectorAll('.emu-dp-placement .cc-dd-trigger')[i].click(), index);
 await page.waitForFunction(i => document.querySelectorAll('.emu-dp-placement')[i].querySelector('.cc-dd-item[data-value=column]'), {}, index);
 await page.evaluate(i => document.querySelectorAll('.emu-dp-placement')[i].querySelector('.cc-dd-item[data-value=column]').click(), index);
 // 옮기는 동안 패널 단추가 잠김. 끝나 다시 그려질 때까지 기다림
 await page.waitForFunction(i => { const t = document.querySelectorAll('.emu-dp-placement .cc-dd-trigger')[i]; return t && !t.disabled && t.querySelector('.cc-dd-value')?.textContent === '같은 열의 탭'; }, {}, index);
}

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
  await page.evaluateOnNewDocument(()=>{
    if(localStorage.getItem('deletion-fixture-seeded'))return;
    localStorage.setItem('deletion-fixture-seeded','true');
    localStorage.setItem('ac.emulator.places',JSON.stringify([
      {key:'unopened-space',id:'pending-deleted',deviceId:'one',deviceKey:'one',place:'column'},
      {key:'unopened-space',id:'pending-other',deviceId:'other',deviceKey:'other',place:'column'},
    ]));
  });
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
  await returnViaPanel(page, await page.evaluate(()=>windows[0].device));
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
  await returnViaPanel(page, await page.evaluate(()=>windows[1].device));
  await returnViaPanel(page, await page.evaluate(()=>windows[2].device));
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
  // 화면 닫기는 기기를 끄지 않고 그 화면의 연결만 끊음(끄는 것은 전원 버튼뿐)
  await page.click('.emu-group-head button[title="이 기기 화면 닫기"]');
  await page.waitForFunction(()=>calls.some(c=>c.method==='emulator.unregisterActive'));
  const closedKeys=await page.evaluate(()=>calls.filter(c=>c.method==='emulator.unregisterActive').map(c=>c.args.worktree));
  const firstKey=await page.evaluate(()=>calls.find(c=>c.method==='emulator.attach'&&c.args.device==='one').args.worktree);
  assert.deepEqual([...new Set(closedKeys)],[firstKey]);
  assert.deepEqual(await page.evaluate(()=>calls.filter(c=>c.method==='emulator.shutdown')),[], '화면 닫기가 기기를 껐다');
  assert.equal(await page.$eval('.emu-group-tabs [role=tab]',el=>el.textContent),'iPhone 13 · 2');
  // 사람이 외부 창을 닫으면 되돌리지 않고 화면만 없앰. 기기는 켜 둠
  const releasedBefore=await page.evaluate(()=>calls.filter(c=>c.method==='emulator.unregisterActive').length);
  assert.equal(await page.evaluate(()=>document.querySelectorAll('.emu-tab-host').length),1);
  await page.evaluate(()=>[...document.querySelectorAll('button[title="이 화면을 별도 창으로 옮깁니다"]')].find(b=>b.offsetParent).click());
  // 새로 고침으로 windows 기록이 비었으므로 이 창이 첫 번째
  await page.waitForFunction(()=>windows.length===1);
  await page.waitForFunction(()=>document.querySelectorAll('.emu-tab-host').length===0);
  await page.evaluate(()=>host.closeWindow({tab:windows[0].tab}));
  await page.waitForFunction(n=>calls.filter(c=>c.method==='emulator.unregisterActive').length===n+1,{},releasedBefore);
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.method==='emulator.unregisterActive').pop().args.worktree),
    await page.evaluate(()=>windows[0].space));
  await new Promise(r=>setTimeout(r,300));
  assert.equal(await page.evaluate(()=>document.querySelectorAll('.emu-tab-host').length),0,'닫은 외부 창이 화면으로 되돌아왔다');
  assert.deepEqual(await page.evaluate(()=>calls.filter(c=>c.method==='emulator.shutdown')),[], '외부 창 닫기가 기기를 껐다');
  // 삭제 취소는 열린 화면을 유지하고 삭제 성공은 해당 외부 창과 저장된 화면만 제거한다.
  await page.evaluate(async()=>{feature.screen.enter();await document.querySelector('.emu-ib[title="새로 고침"]').click();});
  await page.waitForSelector('[data-device="one"] .emu-dp-row');
  await page.evaluate(()=>document.querySelector('[data-device="one"] .emu-dp-row').click());
  await page.waitForFunction(()=>document.querySelector('.emu-tab-host'));
  await page.waitForFunction(()=>!document.querySelector('[data-device="two"] .emu-dp-row').disabled);
  await page.evaluate(()=>document.querySelector('[data-device="two"] .emu-dp-row').click());
  await page.waitForFunction(()=>document.querySelectorAll('.emu-tab-host').length===2);
  await page.waitForFunction(()=>!document.querySelector('[data-device="one"] .emu-dp-actions .emu-btn-danger').disabled);
  await page.evaluate(()=>{window.deleteCanceled=true;document.querySelector('[data-device="one"] .emu-dp-actions .emu-btn-danger').click();});
  await page.waitForFunction(()=>!document.querySelector('[data-device="one"] .emu-dp-actions .emu-btn-danger').disabled);
  assert.equal(await page.evaluate(()=>document.querySelectorAll('.emu-tab-host').length),2);
  await page.evaluate(()=>{window.deleteCanceled=false;document.querySelector('[data-device="one"] .emu-dp-placement .cc-dd-trigger').click();});
  await page.evaluate(()=>document.querySelector('[data-device="one"] [data-value="external"]').click());
  await page.waitForFunction(()=>windows.length===2);
  await page.waitForFunction(()=>!document.querySelector('[data-device="one"] .emu-dp-actions .emu-btn-danger').disabled);
  await page.evaluate(()=>document.querySelector('[data-device="one"] .emu-dp-actions .emu-btn-danger').click());
  await page.waitForFunction(()=>!document.querySelector('[data-device="one"]'));
  const savedPending=await page.evaluate(()=>JSON.parse(localStorage.getItem('ac.emulator.places')).filter(rec=>rec.key==='unopened-space'));
  assert.deepEqual(savedPending.map(rec=>rec.deviceId),['other'],'삭제한 기기의 복원 대기 기록만 제거한다');
  assert.equal(await page.evaluate(()=>document.querySelectorAll('.emu-tab-host').length),1);
  assert.equal(await page.$eval('.emu-group-tabs [role=tab]',el=>el.textContent),'iPhone 13 · 2');
  await page.evaluate(()=>document.querySelector('[data-device="two"] .emu-dp-actions .emu-btn-danger').click());
  await page.waitForFunction(()=>!document.querySelector('[data-device="two"]'));
  assert.equal(await page.evaluate(()=>document.querySelectorAll('.emu-tab-host').length),0);
  await page.reload();
  await page.waitForFunction(()=>window.ready);
  assert.equal(await page.evaluate(()=>document.querySelectorAll('.emu-tab-host').length),0,'삭제한 기기 화면이 다시 열렸다');
  assert.deepEqual(errors,[]);
 } finally {await browser?.close();await new Promise(r=>server.close(r));}
});
