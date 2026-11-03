import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {HerdrClient} from '../server/herdr.js';
import {handleFocus,handleTabFocus,handleWorkspaceFocus,initHerdrHandlers} from '../server/herdr-handlers.js';
import {initRuntimeState,replace} from '../server/runtime-state.js';
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

test('one local agent selection focuses its tab before zooming its pane',async()=>{
  const calls=[];const messages=[];let updates=0;
  initRuntimeState({scheduleRecompute:async()=>{updates++}});
  initHerdrHandlers({herdr:{
    paneGet:async pane=>{if(pane==='missing')throw Error('missing pane');return {tab_id:`${pane}-tab`}},
    tabFocus:async tab=>{calls.push({tab})},
    paneZoom:async(pane,mode)=>{calls.push({pane,mode})},
  }});
  const ws={_local:true,readyState:1,send:message=>messages.push(JSON.parse(message))};
  await handleFocus(ws,{target:'parent'});
  assert.deepEqual(calls,[{tab:'parent-tab'},{pane:'parent',mode:'on'}]);assert.equal(updates,1);
  handleFocus({_local:false},{target:'child'});handleFocus(ws,{});
  assert.equal(calls.length,2);
  await handleFocus(ws,{target:'missing'});
  assert.deepEqual(messages,[{type:'control-error',message:'missing pane'}]);assert.equal(updates,1);
});


test('a pane whose tab the last snapshot already knows is focused without asking herdr for the pane',async()=>{
  const calls=[];
  initRuntimeState({scheduleRecompute:async()=>{}});
  replace({state:[{paneId:'known',tabId:'known-tab'}]});
  initHerdrHandlers({herdr:{
    paneGet:async()=>assert.fail('snapshot 이 탭을 알면 pane.get 을 보내지 않는다'),
    tabFocus:async tab=>{calls.push({tab})},
    paneZoom:async(pane,mode)=>{calls.push({pane,mode})},
  }});
  const ws={_local:true,readyState:1,send:()=>assert.fail('unexpected focus error')};
  await handleFocus(ws,{target:'known'});
  assert.deepEqual(calls,[{tab:'known-tab'},{pane:'known',mode:'on'}]);
  replace({state:[]});
});

test('a finished selection is broadcast as focused before the recompute reports back',async()=>{
  const local=[];let recomputed=0;
  initRuntimeState({scheduleRecompute:async()=>{recomputed++}});
  replace({
    state:[{paneId:'a',tabId:'ta',workspaceId:'w1',focused:true},{paneId:'b',tabId:'tb',workspaceId:'w2',focused:false}],
    tabs:{w1:[{tabId:'ta',focused:true}],w2:[{tabId:'tb',focused:false},{tabId:'tc',focused:true}]},
    workspaces:[{id:'w1',focused:true},{id:'w2',focused:false}],
  });
  initHerdrHandlers({herdr:{tabFocus:async()=>{},paneZoom:async()=>{},workspaceFocus:async()=>{}},broadcastLocal:m=>local.push(m)});
  const ws={_local:true,readyState:1,send:()=>assert.fail('unexpected focus error')};
  await handleFocus(ws,{target:'b'});
  assert.equal(local.length,1);assert.equal(local[0].type,'state');assert.equal(local[0].focusStale,false);
  assert.deepEqual(local[0].agents.map(a=>a.focused),[false,true]);
  assert.deepEqual(local[0].tabs.w2.map(t=>t.focused),[true,false]);
  assert.deepEqual(local[0].workspaces.map(w=>w.focused),[false,true]);
  assert.equal(recomputed,1,'실제 재계산은 그대로 뒤따른다');
  await handleTabFocus(ws,{tabId:'ta'});
  assert.deepEqual(local[1].agents.map(a=>a.focused),[false,false],'탭만 고르면 어느 pane 이 focused 가 될지 모르므로 모두 내린다');
  assert.deepEqual(local[1].tabs.w1.map(t=>t.focused),[true]);
  assert.deepEqual(local[1].workspaces.map(w=>w.focused),[true,false]);
  await handleWorkspaceFocus(ws,{workspaceId:'w2'});
  assert.deepEqual(local[2].workspaces.map(w=>w.focused),[false,true]);
  replace({state:[],tabs:{},workspaces:[]});
});

test('rapid parent/child/tab selections preserve arrival order even when the first focus is delayed',async()=>{
  const calls=[];let release,focused;
  const gate=new Promise(resolve=>{release=resolve});
  initRuntimeState({scheduleRecompute:async()=>{}});
  initHerdrHandlers({herdr:{
    paneGet:async pane=>({tab_id:`${pane}-tab`}),
    paneZoom:async pane=>{calls.push(pane);if(pane==='child')await gate;focused=pane},
    tabFocus:async tab=>{calls.push(tab);focused=tab},
  }});
  const ws={_local:true,readyState:1,send:()=>assert.fail('unexpected focus error')};
  const first=handleFocus(ws,{target:'child'});
  const second=handleFocus(ws,{target:'parent'});
  const third=handleTabFocus(ws,{tabId:'other-tab'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,['child-tab','child'],'later selections cannot overtake an unfinished focus');
  release();await Promise.all([first,second,third]);
  assert.deepEqual(calls,['child-tab','child','parent-tab','parent','other-tab']);assert.equal(focused,'other-tab');
});

test('a failed selection does not prevent the next queued selection',async()=>{
  const errors=[];let focused;
  initRuntimeState({scheduleRecompute:async()=>{}});
  initHerdrHandlers({herdr:{
    paneGet:async pane=>{if(pane==='gone')throw Error('pane gone');return {tab_id:`${pane}-tab`}},
    tabFocus:async()=>{},paneZoom:async pane=>{focused=pane},
  }});
  const ws={_local:true,readyState:1,send:m=>errors.push(JSON.parse(m))};
  await Promise.all([handleFocus(ws,{target:'gone'}),handleFocus(ws,{target:'parent'})]);
  assert.equal(focused,'parent');assert.deepEqual(errors,[{type:'control-error',message:'pane gone'}]);
});

test('empty workspace selection reaches Herdr and remote clients cannot focus it',async()=>{
  const calls=[];let updates=0;
  initRuntimeState({scheduleRecompute:async()=>{updates++}});
  initHerdrHandlers({herdr:{workspaceFocus:async id=>calls.push(id)}});
  const ws={_local:true,readyState:1,send:()=>assert.fail('unexpected focus error')};
  await handleWorkspaceFocus(ws,{workspaceId:'w2'});
  await handleWorkspaceFocus({_local:false},{workspaceId:'w3'});
  assert.deepEqual(calls,['w2']);assert.equal(updates,1);
});
