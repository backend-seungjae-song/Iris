import test from 'node:test';
import assert from 'node:assert/strict';
import {nextRootAgentPane} from '../web/js/herdr/agent-tree.js';
import {replaceHerdrState} from '../web/js/herdr/state.js';
import {initHerdrHandlers,handlePaneClose} from '../server/herdr-handlers.js';
import {initRuntimeState} from '../server/runtime-state.js';
const previousFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({ exists: true, revision: 0, hidden: [], local: true }));
const {initKeynav,cycleAgent} = await import('../web/js/core/keynav.js');
const {initAgents} = await import('../web/js/herdr/agents.js');
globalThis.fetch = previousFetch;
const agent=(paneId,parentPaneId=null)=>({paneId,parentPaneId,terminalId:`term-${paneId}`,workspaceId:'w1',tabId:'shared',agent:'codex'});
const rows=[agent('a'),agent('a-child','a'),agent('grandchild','a-child'),agent('b'),agent('b-child','b'),agent('c')];

test('both directions skip children, including when starting from a grandchild',()=>{
  assert.equal(nextRootAgentPane(rows,'a',1),'b');
  assert.equal(nextRootAgentPane(rows,'a',-1),'c');
  assert.equal(nextRootAgentPane(rows,'grandchild',1),'b');
  assert.equal(nextRootAgentPane(rows,'grandchild',-1),'c');
  assert.equal(nextRootAgentPane(rows,'b-child',-1),'a');
  assert.equal(nextRootAgentPane(rows,'gone',1),'a');
  assert.equal(nextRootAgentPane([],'gone',1),null);
  assert.equal(nextRootAgentPane([agent('orphan','gone')],'orphan',1),'orphan');
});

test('keyboard owner navigates roots and closes exact selected child without fallback to parent',async()=>{
  const listeners=[];globalThis.document={addEventListener:(event,fn)=>listeners.push(fn),getElementById:()=>null};
  let target='a-child',local=true;const sent=[],selected=[],pending=[];
  const alive=new Set(rows.map(a=>a.paneId));
  initRuntimeState({scheduleRecompute:async()=>{}});
  initHerdrHandlers({herdr:{paneGet:async id=>({terminal_id:`term-${id}`}),paneClose:async id=>alive.delete(id)}});
  replaceHerdrState({agents:rows,workspaces:[{id:'w1'}],tabs:{w1:[{tabId:'shared',paneCount:rows.length,focused:true}]}});
  initAgents({spk:x=>x,cssEsc:x=>x,$:()=>({addEventListener(){},querySelector:()=>null}),orderedSpaces:()=>[{id:'w1'}],collapsed:{groups:new Set()},saveCollapsed(){}});
  initKeynav({wsSend:m=>{sent.push(m);if(m.type==='pane-close')pending.push(handlePaneClose({_local:true,readyState:1},m))},
    BROWSER_MODE:false,MEMO_MODE:false,orderedSpaces:()=>[{id:'w1'}],selectSession:id=>{target=id;selected.push(id)},
    getCurTarget:()=>target,getSelectedSpaceId:()=> 'w1',getIsLocal:()=>local,lastTabBySpace:{}});
  cycleAgent(1);cycleAgent(-1);assert.deepEqual(selected,['b','a']);
  target='a-child';
  const press=(repeat=false)=>listeners.forEach(fn=>fn({key:'w',metaKey:true,ctrlKey:false,altKey:false,shiftKey:false,repeat,preventDefault(){},stopPropagation(){}}));
  press();await Promise.all(pending);
  assert.deepEqual(sent,[{type:'pane-close',paneId:'a-child',terminalId:'term-a-child'}]);
  assert.equal(alive.has('a'),true);assert.equal(alive.has('a-child'),false);
  target='a';press(true);assert.equal(sent.length,1,'holding close never cascades onto newly focused parent');
  target='a-child';replaceHerdrState({agents:[{...agent('a'),focused:true}],workspaces:[{id:'w1'}],tabs:{w1:[{tabId:'shared',paneCount:1,focused:true}]}});
  press();assert.equal(sent.length,1,'removed child target cannot fall back to its focused parent');
  target='a';local=false;press();assert.equal(sent.length,1);
  local=true;replaceHerdrState({agents:[{...agent('a'),terminalId:null}],workspaces:[{id:'w1'}],tabs:{w1:[{tabId:'shared',paneCount:1,focused:true}]}});
  press();assert.equal(sent.length,1,'missing terminal identity never falls back to closing a tab');
  delete globalThis.document;
});
