import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const reaction=require('../native/electron/cdp-qa-reaction.cjs');

test('QA CDP hit excludes user agent shadow DOM', async () => {
  const input = fs.readFileSync(new URL('../native/electron/cdp-qa-input.cjs', import.meta.url), 'utf8');
  const hit = vm.runInNewContext('(' + input.match(/async function hit\(send, point\) \{[\s\S]*?\n\}/)[0] + ')', { nodeMeta: async () => ({ role: 'textbox' }) });
  const calls = [];
  const send = async (method, args) => {
    calls.push([method, args]);
    return method === 'DOM.getNodeForLocation' ? { backendNodeId: 1 } : {};
  };
  assert.equal((await hit(send, { x: 3.2, y: 4.1 })).role, 'textbox');
  const params = calls.find(([method]) => method === 'DOM.getNodeForLocation')[1];
  assert.deepEqual(JSON.parse(JSON.stringify(params)), { x: 3, y: 4, includeUserAgentShadowDOM: false });
});

test('QA target resolve excludes user agent shadow DOM', async () => {
  const calls = [];
  const node = { nodeId: 'n1', backendDOMNodeId: 1, name: { value: '이름' }, role: { value: 'textbox' } };
  const send = async (method, args) => {
    calls.push([method, args]);
    if (method === 'Accessibility.getFullAXTree' || method === 'Accessibility.getPartialAXTree') return { nodes: [node] };
    if (method === 'DOM.getBoxModel') return { model: { border: [0, 0, 10, 0, 10, 10, 0, 10] } };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'input' } };
    if (method === 'Runtime.callFunctionOn') return { result: { value: { displayed: true, offscreen: null, occluded: false, sel: '#name' } } };
    if (method === 'DOM.getNodeForLocation') return { backendNodeId: 1 };
    return {};
  };
  const commands = reaction.createQaReactionCommands({ observation: { subscribeEvents() {} }, screenshot: async () => ({ path: 'x' }) });
  const result = await commands['qa-target-resolve'](send, { id: 1 }, { target: { role: 'textbox', name: '이름' } });
  assert.equal(result.found, true);
  assert.equal(result.target.role, 'textbox');
  assert.deepEqual(calls.find(([method]) => method === 'DOM.getNodeForLocation')[1], { x: 5, y: 5, includeUserAgentShadowDOM: false });
});

test('clearAutoViewport keeps explicit device viewport and clears automatic viewport', () => {
  const source = fs.readFileSync(new URL('../native/electron/cdp-control.cjs', import.meta.url), 'utf8');
  const { createHiddenViewport } = require('../native/electron/cdp-hidden-viewport.cjs');
  const hiddenViewport = createHiddenViewport({});
  const calls = [];
  let explicit = { width: 1180, height: 800 };
  const clear = vm.runInNewContext('(' + source.match(/function clearAutoViewport\(wcId, webContentsMod\) \{[\s\S]*?\n\}/)[0] + ')', {
    hiddenViewport,
    deviceEmulation: { viewportFor: id => { assert.equal(id, 7); return explicit; } },
    ensureAttached: () => async method => { calls.push(method); },
  });
  const contents = { fromId: id => ({ id, isDestroyed: () => false }) };
  assert.equal(clear('7', contents), false);
  assert.deepEqual(calls, []);
  explicit = null;
  clear('7', contents);
  assert.deepEqual(calls, ['Emulation.clearDeviceMetricsOverride']);
});

test('reaction inspect tolerates Event arguments while mutation records still flag unchanged',()=>{
  let inspect,listener,emitted; const eventListeners={}; const node={isConnected:true,parentElement:null,localName:'input',value:'3',innerText:'',textContent:'',children:[],getAttribute:()=>null,hasAttribute:()=>false,getBoundingClientRect:()=>({x:0,y:0,width:10,height:10}),closest:()=>null,scrollWidth:10,clientWidth:10};
  const document={body:{innerText:'',isConnected:true,parentElement:null},documentElement:{scrollWidth:800},activeElement:null,querySelectorAll:()=>[node],getElementById:()=>null,elementFromPoint:()=>node,addEventListener:(name,fn)=>{eventListeners[name]=fn;if(name==='input')inspect=fn;},removeEventListener(){}}; node.parentElement=document.body;
  const context=vm.createContext({document,location:{href:'http://x'},innerWidth:800,innerHeight:600,Date:{now:()=>1},MutationObserver:class{constructor(fn){listener=fn;}observe(){}disconnect(){}},setInterval:()=>1,clearInterval(){},getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1',overflowX:'visible'}),binding:(x)=>{emitted=JSON.parse(x);}});
  vm.runInContext(`(${reaction.reactionWatch.toString()})(${JSON.stringify({id:'r',effects:[{id:'u',type:'unchanged',sel:'#x',oracle:'o'}],binding:'binding',deadline:1000})})`,context);
  vm.runInContext('globalThis.__irisQaReactionState.arm()',context);
  for (const name of ['input', 'change', 'load']) {
    assert.equal(typeof eventListeners[name], 'function');
    assert.doesNotThrow(() => eventListeners[name](new Event(name)));
  }
  assert.equal(typeof listener,'function');
  node.value='4';
  listener([{target:node,type:'characterData'}]);
  assert.deepEqual(emitted?.unchangedViolated,['u']);
  assert.equal(typeof inspect, 'function');
  assert.doesNotThrow(() => inspect(new Event('change')));
});

test('reaction sampling tolerates a document without documentElement',()=>{
  const document={body:{innerText:'',isConnected:true,parentElement:null},documentElement:null,activeElement:null,querySelectorAll:()=>[],getElementById:()=>null,elementFromPoint:()=>null};
  const context=vm.createContext({document,location:{href:'http://x'},innerWidth:800,innerHeight:600,Date:{now:()=>1},MutationObserver:class{constructor(){}observe(){}disconnect(){}},setInterval:()=>1,clearInterval(){},getComputedStyle:()=>({}),binding:()=>{}});
  document.addEventListener=()=>{}; document.removeEventListener=()=>{};
  assert.doesNotThrow(()=>vm.runInContext(`(${reaction.reactionWatch.toString()})({id:'r',effects:[],binding:'binding',deadline:1000})`,context));
});

test('reaction end removes new document scripts once and clears script state',async()=>{
  const calls=[]; const send=async(method,args)=>{calls.push([method,args]); if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'main'}}}; if(method==='Page.createIsolatedWorld')return {executionContextId:1}; if(method==='Runtime.evaluate')return {result:{value:{effects:[],bodyText:'x',visibleElements:1,busy:[],broken:[]}}}; if(method==='Page.addScriptToEvaluateOnNewDocument')return {identifier:'script-1'}; return {};};
  const wc={id:7}; const commands=reaction.createQaReactionCommands({observation:{subscribeEvents(){}},screenshot:async()=>({path:'x'}),now:()=>0,sleep:async()=>{}});
  const started=await commands['qa-reaction-start'](send,wc,{expect:{effects:[{id:'e',type:'none',oracle:'o'}],within:50},action:'click',target:null});
  await commands['qa-reaction-end'](send,wc,{id:started.id,delivered:false});
  const removes=calls.filter(([m])=>m==='Page.removeScriptToEvaluateOnNewDocument'); assert.equal(removes.length,1); assert.equal(removes[0][1].identifier,'script-1');
  assert.equal(commands.hasActive(7), true);
  assert.equal(calls.some(([method, args]) => method === 'Runtime.evaluate' && args.expression === 'globalThis.__irisQaReactionState?.stop()'), false);
  await commands.dispose(7);
  assert.equal(commands.hasActive(7), false);
  assert.equal(calls.filter(([method, args]) => method === 'Runtime.evaluate' && args.expression === 'globalThis.__irisQaReactionState?.stop()').length, 1);
  assert.equal(calls.filter(([m])=>m==='Page.removeScriptToEvaluateOnNewDocument').length,1);
});

test('hidden viewport pin skips tabs with an explicit QA viewport', () => {
  const source = fs.readFileSync(new URL('../native/electron/cdp-control.cjs', import.meta.url), 'utf8');
  const expression = source.match(/hasExplicitDevice: (\(wcId\) => [^\n]+),\n/)[1];
  let viewport = { width: 1180, height: 800, dpr: 1 };
  const hasExplicitDevice = vm.runInNewContext('(' + expression + ')', {
    deviceEmulation: { hasExplicitDevice: () => false, viewportFor: () => viewport },
  });
  const { createHiddenViewport } = require('../native/electron/cdp-hidden-viewport.cjs');
  const hiddenViewport = createHiddenViewport({ isTabShown: () => false, shownStateKnown: () => true, hasExplicitDevice,
    navigationEpoch: () => 0, now: () => 0, isDisabled: () => false });
  const calls = [];
  const send = async (method) => { calls.push(method); };
  assert.equal(hiddenViewport.pin(7, send), false);
  assert.deepEqual(calls, []);
  viewport = null;
  assert.equal(hiddenViewport.pin(7, send), true);
  assert.deepEqual(calls, ['Emulation.setDeviceMetricsOverride']);
});
