import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import * as feedback from '../web/js/browser/navigation-feedback.js';
// WF_SRC: 고치기 전 판으로 같은 검사를 돌릴 때
const source = fs.readFileSync(process.env.WF_SRC || new URL('../web/js/browser/webview-factory.js', import.meta.url), 'utf8');
const history = {index:1,entries:[{url:'https://example.test/a'}]};
function fixture({restoreOk=true,reopened=false,fallbackLoaded=false,slept=false}={}) {
  const stubs={};
  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*"[^"]+";/g)) {
    for (const name of match[1].split(',').map(x=>x.trim()).filter(Boolean)) stubs[name]=()=>{};
  }
  const callbacks=new Map(), attrs={}, records=new Map(), changes=[], loads=[], statuses=[];
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
    getBrowserState:()=>({tabsBySpace:{test:[{id:'tab'}]}}),bsMutate:m=>changes.push(m),activeBrowserId:()=>null,
    setTabStatus:(id,patch)=>statuses.push(patch)});
  vm.runInContext(source.replace(/import\s*\{[^}]+\}\s*from\s*"[^"]+";/g,'').replace(/\bexport /g,''),context);
  context.initWebviewFactory({acHost:host,wvStack:{appendChild(){for(const fn of callbacks.get('did-attach')||[])fn({})}},wsSend(){},blog(){},showToast(){},urlInput:{},bNote:{},isNewTab:()=>false});
  const rec=context.createWebview('tab','test',history.entries[0].url,slept?history:null);
  return {context,rec,emit,attrs,changes,loads,statuses,stages:()=>stages,finishes:()=>finishes};
}
test('같은 문서 안 이동(isInPlace)은 파비콘을 지우지 않고 "여는 중…"을 띄우지 않음',async()=>{
  const f=fixture();
  await f.emit('did-navigate',{url:'https://example.test/app',isMainFrame:true});
  await f.emit('did-stop-loading');
  f.statuses.length=0;
  await f.emit('did-start-navigation',{url:'https://example.test/app#step2',isMainFrame:true,isInPlace:true});
  assert.equal(f.statuses.filter(p=>'icon' in p).length,0,'파비콘이 지워짐');
  assert.notEqual(f.rec.navigationState,'loading');
});
test('새 문서로 가는 이동은 그대로 파비콘을 지우고 로딩 상태로 둠',async()=>{
  const f=fixture();
  await f.emit('did-navigate',{url:'https://example.test/app',isMainFrame:true});
  await f.emit('did-stop-loading');
  f.statuses.length=0;
  await f.emit('did-start-navigation',{url:'https://example.test/other',isMainFrame:true,isInPlace:false});
  assert.equal(JSON.stringify(f.statuses.filter(p=>'icon' in p)),'[{"icon":""}]');
  assert.equal(f.rec.navigationState,'loading');
});
