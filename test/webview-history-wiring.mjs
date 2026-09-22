import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as feedback from '../web/js/browser/navigation-feedback.js';
const source = fs.readFileSync(new URL('../web/js/browser/webview-factory.js', import.meta.url), 'utf8');
const history = {index:1,entries:[{url:'https://example.test/a'},{url:'https://example.test/b'},{url:'https://example.test/c'}]};
function fixture({restoreOk=true,reopened=true,fallbackLoaded=false}={}) {
  const stubs={};
  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*"[^"]+";/g)) {
    for (const name of match[1].split(',').map(x=>x.trim()).filter(Boolean)) stubs[name]=()=>{};
  }
  const callbacks=new Map(), attrs={}, records=new Map(), changes=[], loads=[];
  let stages=0, finishes=0;
  const element={dataset:{},classList:{contains:()=>false,toggle(){}},
    setAttribute:(k,v)=>{attrs[k]=v},addEventListener:(k,f)=>{if(!callbacks.has(k))callbacks.set(k,[]);callbacks.get(k).push(f)},
    getURL:()=>currentUrl,getTitle:()=>'',getWebContentsId:()=>44,loadURL:u=>{loads.push(u);currentUrl=u}};
  let currentUrl='about:blank';
  const emit=async(k,event={})=>{if(event.url)currentUrl=event.url;await Promise.all((callbacks.get(k)||[]).map(f=>f(event)))};
  const host={
    browserHistoryStage:value=>{stages++;assert.equal(value,history);return {ok:true,token:'fixture_token',src:'about:blank#iris-history:fixture_token'}},
    browserHistoryFinish:async token=>{finishes++;assert.equal(token,'fixture_token');return {ok:restoreOk,fallbackLoaded}},
  };
  const context=vm.createContext({...stubs,...feedback,console,Promise,URL,
    window:{acHost:host},document:{createElement:()=>element,activeElement:null},
    getWebview:id=>records.get(id),registerWebview:(id,rec)=>records.set(id,rec),
    takeReopenedBrowserHistory:()=>reopened?history:null,
    partitionFor:()=> 'persist:acprof:test',profileIdForStored:x=>x,profileOfTab:()=> 'test',
    getBrowserState:()=>({tabsBySpace:{test:[{id:'tab'}]}}),bsMutate:m=>changes.push(m),activeBrowserId:()=>null});
  vm.runInContext(source.replace(/import\s*\{[^}]+\}\s*from\s*"[^"]+";/g,'').replace(/\bexport /g,''),context);
  context.initWebviewFactory({acHost:host,wvStack:{appendChild(){for(const fn of callbacks.get('did-attach')||[])fn({})}},wsSend(){},blog(){},showToast(){},urlInput:{},bNote:{},isNewTab:()=>false});
  const rec=context.createWebview('tab','test',history.entries[1].url);
  return {context,rec,emit,attrs,changes,loads,stages:()=>stages,finishes:()=>finishes};
}
test('reopened tab stages a marker before attach and finishes restored history once',async()=>{
  const f=fixture(); assert.equal(f.attrs.src,'about:blank#iris-history:fixture_token');
  assert.equal(f.stages(),1);
  await f.emit('did-navigate',{url:history.entries[1].url,isMainFrame:true});
  await f.emit('dom-ready');await f.emit('dom-ready');
  assert.equal(f.finishes(),1);assert.deepEqual(f.loads,[]);
  assert.equal(f.rec.ready,true);assert.equal(f.changes[0].url,history.entries[1].url);
});
test('restore failure loads saved URL, while fresh tabs attach directly to destination',async()=>{
  const f=fixture({restoreOk:false});await f.emit('dom-ready');await Promise.resolve();
  assert.deepEqual(f.loads,[history.entries[1].url]);
  assert.equal(fixture({reopened:false}).attrs.src,history.entries[1].url);
});
test('main-loaded restore fallback does not navigate the saved URL twice',async()=>{
  const f=fixture({restoreOk:false,fallbackLoaded:true});await f.emit('dom-ready');await Promise.resolve();
  assert.deepEqual(f.loads,[]);assert.equal(f.rec.ready,true);
});
test('user navigation requested during restore wins over fallback',async()=>{
  const f=fixture({restoreOk:false});f.context.navigateOn(f.rec,'https://example.test/user');
  await f.emit('dom-ready');await Promise.resolve();
  assert.deepEqual(f.loads,['https://example.test/user']);
});
