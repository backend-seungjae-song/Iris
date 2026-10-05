import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { createWin } = require('../native/electron/desk-layout/win.cjs');
const row = { id: 123, cgId: 123, pid: 12, pidStart: '2026-01-01', exe: 'C:\\App.exe', appKey: 'c:\\app.exe', matchApp: 'App', matchTitle: 'Document', bounds: [1,2,400,300], desktopId: 'desk-a', onCurrent: true, onScreen: true, reachable: 'cg', idConfidence: 'exact' };
test('Windows layout applies only current desktop windows and checks resulting bounds', async () => {
  const calls = [];
  const owner = createWin({ request: async (r) => { calls.push(r); return r.op === 'windows' ? { ok: true, windows: [row, {...row, id: 456, cgId:456, onCurrent: false, desktopId: 'desk-b'}] } : { ok: true, bounds: r.bounds }; } });
  const list = await owner.listWindows(); assert.equal(list.windows.length, 2); assert.deepEqual(list.desktops, []); assert.equal(list.windows[0].desktopId, 'desk-a'); assert.equal(list.windows[0].desktop, null);
  const r = await owner.applyWindows([{pid:12,cgId:123,pidStart:row.pidStart,to:{x:30,y:40,width:500,height:350}}, {pid:12,cgId:456,pidStart:row.pidStart,to:{x:30,y:40,width:500,height:350}}]);
  assert.equal(r.results[0].ok, true); assert.equal(r.results[1].reason, 'desktop-switch-failed');
  const recycled = await owner.applyWindows([{pid:12,cgId:123,pidStart:'old-process',to:{x:30,y:40,width:500,height:350}}]);
  assert.equal(recycled.results[0].reason, 'process-identity-changed');
  assert.equal(calls.filter((c) => c.op === 'move').length,1); assert.equal(calls.find((c) => c.op === 'move').start, row.pidStart);
  const restored = await owner.restoreAcrossDesktops({visits:[{index:1,items:[{key:'cross',pid:12,cgId:123,target:2,to:{x:0,y:0,width:500,height:350}}]}]});
  assert.equal(restored.results.cross.ok,false);
});
function catalogFixture(windows, focus = {ok:true}) {
  const module = {exports:{}}; const calls = [];
  vm.runInNewContext(fs.readFileSync(new URL('../native/electron/window-catalog.cjs', import.meta.url),'utf8'), {
    module, process:{platform:'win32'}, require:(name) => name === '../../server/win-native.cjs' ? {request:async (r)=>{ calls.push(r); return r.op==='windows'?{ok:true,windows,front:0}:focus; }} : require(path.resolve('native/electron',name)),
  });
  return { catalog:module.exports.createWindowCatalog({execFile(){throw Error('must use helper');},readCoreSource(){throw Error('must use helper');}}),calls };
}
test('Windows switcher raises resolved selected window and preserves process start',async()=>{
  const f=catalogFixture([row]); const list=await f.catalog.enumerate();
  assert.equal(list.windows[0].pidStart,row.pidStart);
  const r=await f.catalog.step({ordered:[123],targets:list.windows,dir:1,ownPid:99});
  assert.equal(r.raised,123); assert.equal(f.calls.at(-1).op,'focus'); assert.equal(f.calls.at(-1).start,row.pidStart);
});
test('Windows switcher rejects reused HWND and reports desktop refusal without dropping selection',async()=>{
  const f=catalogFixture([{...row,pidStart:'new-process'}]);
  const r=await f.catalog.step({ordered:[123],targets:[{...row,ordinal:1}],dir:1,ownPid:99});
  assert.equal(r.raised,null); assert.equal(f.calls.filter((c)=>c.op==='focus').length,0);
  const g=catalogFixture([row],{ok:false,error:'desktop-switch-unsupported'});
  const list=await g.catalog.enumerate(); const blocked=await g.catalog.step({ordered:[123],targets:list.windows,dir:1,ownPid:99});
  assert.equal(blocked.missing[0].reason,'desktop-switch-failed');
});
