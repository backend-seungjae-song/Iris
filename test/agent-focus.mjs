import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {HerdrClient} from '../server/herdr.js';
import {handleFocus,handleTabFocus,initHerdrHandlers} from '../server/herdr-handlers.js';
import {initRuntimeState} from '../server/runtime-state.js';
const {createMainWindow}=createRequire(import.meta.url)('../native/electron/main-window.cjs');

test('main console delivers the activation click to the clicked agent',()=>{
  const stopped=Symbol('captured constructor');let options;
  const api=createMainWindow({
    app:{on(){}},webContents:{on(){}},markAppAlive(){},
    windowLayout:{applySavedBounds:()=>null},
    BrowserWindow:class{constructor(opts){options=opts;throw stopped;}},
  });
  assert.throws(()=>api.createWindow(),error=>error===stopped);
  assert.equal(options.acceptFirstMouse,true);
});

test('pane-only focus requests use on rather than a toggle',async()=>{
  const h=new HerdrClient();const sent=[];
  h.call=async(method,params)=>{sent.push({method,params});return {type:'pane_zoom'}};
  await h.paneZoom('w1:p1');await h.paneZoom('w1:p2');await h.paneZoom('w1:p2');
  assert.deepEqual(sent.map(s=>s.params),[
    {pane_id:'w1:p1',mode:'on'},{pane_id:'w1:p2',mode:'on'},{pane_id:'w1:p2',mode:'on'},
  ]);
  assert.ok(sent.every(s=>s.method==='pane.zoom'));
});

test('one local agent selection focuses a single pane; remote and failures do not silently fall back',async()=>{
  const calls=[];const messages=[];let updates=0;
  initRuntimeState({scheduleRecompute:async()=>{updates++}});
  initHerdrHandlers({herdr:{paneZoom:async(pane,mode)=>{calls.push({pane,mode});if(pane==='missing')throw Error('missing pane')} }});
  const ws={_local:true,readyState:1,send:message=>messages.push(JSON.parse(message))};
  handleFocus(ws,{target:'parent'});await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,[{pane:'parent',mode:'on'}]);assert.equal(updates,1);
  handleFocus({_local:false},{target:'child'});handleFocus(ws,{});
  assert.equal(calls.length,1);
  handleFocus(ws,{target:'missing'});await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(messages,[{type:'control-error',message:'missing pane'}]);assert.equal(updates,1);
});


test('rapid parent/child/tab selections preserve arrival order even when the first focus is delayed',async()=>{
  const calls=[];let release,focused;
  const gate=new Promise(resolve=>{release=resolve});
  initRuntimeState({scheduleRecompute:async()=>{}});
  initHerdrHandlers({herdr:{
    paneZoom:async pane=>{calls.push(pane);if(pane==='child')await gate;focused=pane},
    tabFocus:async tab=>{calls.push(tab);focused=tab},
  }});
  const ws={_local:true,readyState:1,send:()=>assert.fail('unexpected focus error')};
  const first=handleFocus(ws,{target:'child'});
  const second=handleFocus(ws,{target:'parent'});
  const third=handleTabFocus(ws,{tabId:'other-tab'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,['child'],'later selections cannot overtake an unfinished focus');
  release();await Promise.all([first,second,third]);
  assert.deepEqual(calls,['child','parent','other-tab']);assert.equal(focused,'other-tab');
});

test('a failed selection does not prevent the next queued selection',async()=>{
  const errors=[];let focused;
  initRuntimeState({scheduleRecompute:async()=>{}});
  initHerdrHandlers({herdr:{paneZoom:async pane=>{if(pane==='gone')throw Error('pane gone');focused=pane}}});
  const ws={_local:true,readyState:1,send:m=>errors.push(JSON.parse(m))};
  await Promise.all([handleFocus(ws,{target:'gone'}),handleFocus(ws,{target:'parent'})]);
  assert.equal(focused,'parent');assert.deepEqual(errors,[{type:'control-error',message:'pane gone'}]);
});
