import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createChromeHandoffIpc}=require('../native/electron/chrome-handoff-ipc.cjs');
function harness() {
  const handlers=new Map(),calls=[];let finish;
  const wait=new Promise(resolve=>{finish=resolve;});
  createChromeHandoffIpc({ipcMain:{handle:(n,f)=>handlers.set(n,f),on(){}},
    isTrustedSender:e=>e.trusted===true,isProfilePartition:p=>p==='persist:acprof:test',
    chromeImportRegistry:{latestForPartition:()=>({cid:'chrome:Default'})},chromeProfileCid:()=> 'chrome:Default',
    cookieImport:{listChromeProfiles:()=>[{}],refreshFromChrome:async(entry,partition,scope,options)=>{
      calls.push({partition,google:scope('.google.com'),evil:scope('.evilgoogle.com'),recovering:options.recovering,current:options.isCurrent()});
      await wait;return {changed:0,refreshed:0,skipped:'same-session'};
    }},
  });
  return {refresh:handlers.get('ac-refresh-chrome-cookies'),calls,finish};
}
const invoke=(h,url='https://accounts.google.com/ServiceLogin')=>h.refresh({trusted:true},{partition:'persist:acprof:test',url});
test('동시 점검은 한 번만 실행하며 이미 같은 로그인은 새로고침하지 않는다',async()=>{
  const h=harness();const a=invoke(h),b=invoke(h);h.finish();
  assert.equal((await a).changed,0);assert.equal((await b).changed,0);assert.equal(h.calls.length,1);
  assert.deepEqual(h.calls[0],{partition:'persist:acprof:test',google:true,evil:false,recovering:true,current:true});
  assert.equal((await invoke(h)).skipped,'recent');
});
test('일반 점검 TTL이 직후 로그인 벽 복구를 막지 않는다',async()=>{
  const h=harness();h.finish();await invoke(h,'https://accounts.google.com/');await invoke(h);
  assert.deepEqual(h.calls.map(c=>c.recovering),[false,true]);
});
test('신뢰·파티션·URL 경계를 지킨다',async()=>{
  const h=harness();h.finish();
  for(const [trusted,partition,url] of [[false,'persist:acprof:test','https://example.com/'],[true,'persist:unknown','https://example.com/'],[true,'persist:acprof:test','file:///tmp/example'],[true,'persist:acprof:test','invalid']])
    assert.equal((await h.refresh({trusted},{partition,url})).ok,false);
  assert.equal(h.calls.length,0);
});
test('페이지 이동과 탭 전환 점검은 유지하고 실제 적용 뒤에만 화면을 갱신한다',()=>{
  const s=fs.readFileSync(new URL('../web/js/browser/webview-factory.js',import.meta.url),'utf8');
  assert.match(s,/refreshChromeSession\(tabId, e\.url\)/);assert.match(s,/refreshChromeSession\(id, active\.url\)/);
  assert.match(s,/!result\.changed \|\| !result\.refreshed/);
  assert.match(s,/getWebview\(tabId\) !== rec \|\| rec\.url !== url/);
});

test('Google 브라우저 거부는 쿠키 만료로 오인해 재수집하지 않는다',async()=>{
  const h=harness();h.finish();
  const result=await invoke(h,'https://accounts.google.com/v3/signin/rejected');
  assert.equal(result.skipped,'unsupported-browser');assert.equal(h.calls.length,0);
});
