import test from 'node:test';
import assert from 'node:assert/strict';
import {handlePaneClose,handleTabClose,initHerdrHandlers} from '../server/herdr-handlers.js';
import {initRuntimeState} from '../server/runtime-state.js';

function fixture() {
  const panes=new Map(['parent','child'].map(id=>[id,{pane_id:id,terminal_id:`term-${id}`,tab_id:'shared'}]));
  const errors=[],closed=[];let updates=0;
  initRuntimeState({scheduleRecompute:async()=>{updates++}});
  initHerdrHandlers({herdr:{
    paneGet:async id=>{if(!panes.has(id))throw Error('missing');return panes.get(id)},
    paneClose:async id=>{closed.push(id);panes.delete(id)},
    paneList:async()=>[...panes.values()],
    call:async(method)=>{assert.equal(method,'tab.get');return {tab:{workspace_id:'w1'}}},
    tabClose:()=>assert.fail('must never close a shared tab'),
  }});
  return {panes,closed,errors,updates:()=>updates,ws:{_local:true,readyState:1,send:m=>errors.push(JSON.parse(m))}};
}

test('closing child preserves parent sharing its tab',async()=>{
  const f=fixture();await handlePaneClose(f.ws,{paneId:'child',terminalId:'term-child'});
  assert.deepEqual(f.closed,['child']);assert.equal(f.panes.has('parent'),true);assert.equal(f.updates(),1);
});
test('stale terminal, missing target, remote caller and incomplete identity cannot close another session',async()=>{
  const f=fixture();
  await handlePaneClose(f.ws,{paneId:'child',terminalId:'previous-terminal'});
  await handlePaneClose(f.ws,{paneId:'gone',terminalId:'term-gone'});
  await handlePaneClose({...f.ws,_local:false},{paneId:'child',terminalId:'term-child'});
  await handlePaneClose(f.ws,{paneId:'child'});
  assert.deepEqual(f.closed,[]);assert.equal(f.errors.length,2);assert.equal(f.updates(),0);
});
test('legacy tab close rejects multiple panes, then closes only the sole remaining pane',async()=>{
  const f=fixture();await handleTabClose(f.ws,{tabId:'shared'});
  assert.deepEqual(f.closed,[]);assert.equal(f.errors.length,1);
  f.panes.delete('child');await handleTabClose(f.ws,{tabId:'shared'});
  assert.deepEqual(f.closed,['parent']);assert.equal(f.updates(),1);
});

test('concurrent duplicate closes keep the original child identity and never retarget parent',async()=>{
  const f=fixture();
  await Promise.all([
    handlePaneClose(f.ws,{paneId:'child',terminalId:'term-child'}),
    handlePaneClose(f.ws,{paneId:'child',terminalId:'term-child'}),
  ]);
  assert.deepEqual(f.closed,['child','child']);assert.equal(f.panes.has('parent'),true);
});
