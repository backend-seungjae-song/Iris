import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {replaceCookieSnapshot,addMissingCookies}=require('../native/electron/cookie-snapshot.cjs');
const {cookieKey}=require('../native/electron/cookie-sync-policy.cjs');
const c=(name,value,domain='.example.com')=>({name,value,domain,path:'/',secure:true,httpOnly:true,sameSite:"unspecified"});
function fixture(before,{failName,readFail=false,rollbackFail=false,overwriteSecure=false,events=false,pageWrites=[],pageDeletes=[],pageAfter=1,dropName,chips=[]}={}) {
  const jar=new Map(before.map(c=>[cookieKey(c),c]));let writes=0,failed=false;const scopes=[],predicates=[];
  // Electron cookies 'changed' 이벤트 흉내: events 일 때만 on 제공
  const listeners=new Set();const put=cookie=>{jar.set(cookieKey(cookie),cookie);for(const l of listeners)l({},cookie,'explicit',false);};
  let pagePending=[...pageWrites],deletePending=[...pageDeletes];
  // 페이지가 document.cookie 로 지움: Chromium 은 'expired-overwrite' 삭제 이벤트를 보냄
  const pageDelete=name=>{for(const [k,c] of jar) if(c.name===name){jar.delete(k);for(const l of listeners)l({},c,'expired-overwrite',true);}};
  const session={cookies:{
    ...(events?{on:(name,l)=>{if(name==='changed')listeners.add(l);},removeListener:(name,l)=>listeners.delete(l)}:{}),
    // chips: 같은 key 의 파티션(CHIPS) 행. Electron cookies.get 은 partitionKey 없이 함께 돌려줌
    get:async()=>{if(readFail)throw Error('unavailable');return [...jar.values(),...chips];},
    set:async d=>{writes++; if((d.name===failName&&!failed)||(failed&&rollbackFail)) {failed=true;throw Error('rejected');}
      // HTTP 출처는 같은 이름의 Secure 쿠키와 겹치는 쿠키를 덮을 수 없다.
      if(overwriteSecure&&new URL(d.url).protocol==='http:'&&[...jar.values()].some(c=>c.secure&&c.name===d.name&&c.domain.replace(/^\./,'')===new URL(d.url).hostname)) throw Error('EXCLUDE_OVERWRITE_SECURE'); const cookie={...d,domain:d.domain||new URL(d.url).hostname};delete cookie.url;if(d.name!==dropName)put(cookie);
      // 교체 도중 페이지 스크립트가 쓴 쿠키(document.cookie)
      if(pagePending.length&&writes>=pageAfter){const w=pagePending;pagePending=[];for(const p of w)put(p);}
      if(deletePending.length&&writes>=pageAfter){const w=deletePending;deletePending=[];for(const n of w)pageDelete(n);}},
    remove:async(url,name)=>{for(const [k,c] of jar) if(c.name===name&&c.domain.replace(/^\./,'')===new URL(url).hostname)jar.delete(k);},
    flushStore:async()=>{},
  }};
  const transfer={run:async(scope,fn)=>{predicates.push(scope);scopes.push(scope({url:'https://example.com/a'}));scopes.push(scope({url:'https://unrelated.test/a'}));return fn();}};
  const scope=d=>d.replace(/^\./,'')==='example.com';
  const run=(list,extra={})=>replaceCookieSnapshot({session,transfer,scope,list,...extra});
  const add=list=>addMissingCookies({session,transfer,scope,list});
  return {jar,run,add,writes:()=>writes,scopes,predicates};
}
test('한 벌을 적용하고 범위 밖 쿠키는 보존하며 request scope를 도메인으로 바꾼다',async()=>{
  const f=fixture([c('old','old'),c('other','keep','.other.test')]);
  const result=await f.run([c('SID','new'),c('HSID','new')]);
  assert.equal(result.changed,1);assert.equal(result.live,2);
  assert.deepEqual([...f.jar.values()].map(c=>c.name).sort(),['HSID','SID','other']);
  assert.deepEqual(f.scopes,[true,false]);
});
test('중간 쓰기 실패는 기존 한 벌로 되돌리고 성공으로 보고하지 않는다',async()=>{
  const before=[c('SID','old'),c('HSID','old')]; const f=fixture(before,{failName:'HSID'});
  const result=await f.run([c('SID','new'),c('HSID','new')]);
  assert.equal(result.error,'cookie-transfer-failed'); assert.equal(result.rolledBack,true);
  assert.deepEqual([...f.jar.values()].map(c=>[c.name,c.value]),before.map(c=>[c.name,c.value]));
});
test('보상 실패는 별도 실패로 노출한다',async()=>{
  const f=fixture([c('SID','old'),c('HSID','old')],{failName:'HSID',rollbackFail:true});
  const result=await f.run([c('SID','new'),c('HSID','new')]);
  assert.equal(result.error,'cookie-rollback-incomplete');assert.equal(result.rolledBack,false);
});
test('원본 조회 실패와 지원하지 않는 partitioned 행은 쓰기 없이 실패한다',async()=>{
  const f=fixture([c('old','old')],{readFail:true});
  await assert.rejects(f.run([c('SID','new')]));assert.equal(f.writes(),0);
  const g=fixture([c('old','old')]);
  await assert.rejects(g.run([{...c('SID','new'),sourceRow:{top_frame_site_key:'https://example.org'}}]));
  assert.equal(g.writes(),0);
});
test('직전 재판정이 target drift를 감지하면 변경하지 않는다',async()=>{
  const f=fixture([c('SID','local')]);
  const result=await f.run([c('SID','source')],{decide:()=>({apply:false,reason:'target-changed'})});
  assert.equal(result.skipped,'target-changed');assert.equal(f.writes(),0);
});

test('클라이언트가 받은 보안 쿠키는 source에서 제외되어도 삭제하지 않는다',async()=>{
  const f=fixture([c('SID','old'),c('SIDCC','local'),c('cf_clearance','local')]);
  const result=await f.run([c('SID','new')],{preserveCookie:c=>['SIDCC','cf_clearance'].includes(c.name)});
  assert.equal(result.changed,1);
  assert.deepEqual([...f.jar.values()].map(c=>[c.name,c.value]).sort(),[['SID','new'],['SIDCC','local'],['cf_clearance','local']]);
});

test('source에만 있는 target-bound 쿠키는 desired/readback에 넣지 않는다',async()=>{
  const f=fixture([c('SID','old')]);
  const result=await f.run([c('SID','new'),c('cf_clearance','foreign')],{
    preserveCookie:c=>c.name==='cf_clearance',
  });
  assert.equal(result.changed,1);
  assert.equal(result.live,1);
  assert.equal(result.skipped,1);
  assert.deepEqual([...f.jar.values()].map(c=>[c.name,c.value]),[['SID','new']]);
});

test('쿠키 path가 //로 시작해도 삭제 URL의 origin을 바꾸지 않는다',async()=>{
  const stale={...c('stale','old'),path:'//attacker.test/private'};
  const f=fixture([stale,c('outside','keep','.attacker.test')]);
  const result=await f.run([c('SID','new')]);
  assert.equal(result.changed,1);
  assert.deepEqual([...f.jar.values()].map(c=>[c.domain,c.name]).sort(),[
    ['.attacker.test','outside'],['.example.com','SID'],
  ]);
});

test('같은 snapshot scope는 transfer request predicate도 재사용한다',async()=>{
  const f=fixture([c('SID','old')]);
  await f.run([c('SID','one')]);
  await f.run([c('SID','two')]);
  assert.equal(f.predicates.length,2);
  assert.equal(f.predicates[0],f.predicates[1]);
});

test('target 의 Secure 쿠키를 source 의 Secure 아닌 같은 쿠키로 바꿀 수 있다',async()=>{
  // Chrome 에는 Secure 없이, Iris 에는 Secure 로 저장된 같은 쿠키 하나 때문에 교체 전체가 되돌려졌다.
  const f=fixture([c('regStatus','old'),c('SID','old')],{overwriteSecure:true});
  const result=await f.run([{...c('regStatus','new'),secure:false},c('SID','new')]);
  assert.equal(result.changed,1);
  assert.deepEqual([...f.jar.values()].map(c=>[c.name,c.value,c.secure]).sort(),[['SID','new',true],['regStatus','new',false]]);
});

test('같은 이름의 서로 다른 path에 Secure 쿠키와 일반 쿠키를 함께 가져온다',async()=>{
  const f=fixture([],{overwriteSecure:true});
  const incoming=[c('session','secure'),{...c('session','plain'),path:'/account',secure:false}];
  const result=await f.run(incoming);
  assert.equal(result.changed,1);
  assert.deepEqual([...f.jar.values()].map(c=>[c.path,c.value,c.secure]),[['/','secure',true],['/account','plain',false]]);
});

test('교체 도중 페이지가 직접 쓴 쿠키는 실패로 보지 않고 페이지 값을 남긴다',async()=>{
  const f=fixture([c('SID','old'),c('_ga','old')],{events:true,pageWrites:[c('_ga','page'),c('_gid','page')],pageAfter:2});
  const result=await f.run([c('SID','new'),c('_ga','chrome')]);
  assert.equal(result.changed,1);
  assert.deepEqual([...f.jar.values()].map(c=>[c.name,c.value]).sort(),[['SID','new'],['_ga','page'],['_gid','page']]);
});

test('페이지 쓰기가 있어도 넣은 쿠키가 빠지면 되돌린다',async()=>{
  const before=[c('SID','old')];
  const f=fixture(before,{events:true,pageWrites:[c('_gid','page')],dropName:'HSID'});
  const result=await f.run([c('SID','new'),c('HSID','new')]);
  assert.equal(result.error,'cookie-transfer-failed');assert.equal(result.rolledBack,true);
  assert.deepEqual([...f.jar.values()].map(c=>[c.name,c.value]),[['SID','old']]);
});

test('이벤트를 주지 않는 세션에서는 페이지 쓰기를 구분하지 않고 되돌린다',async()=>{
  const f=fixture([c('SID','old')],{pageWrites:[c('_gid','page')]});
  const result=await f.run([c('SID','new')]);
  assert.equal(result.error,'cookie-transfer-failed');
});

test('교체 도중 페이지가 지운 쿠키는 실패로 보지 않고 지운 상태를 남긴다',async()=>{
  const f=fixture([c('SID','old'),c('tok','old')],{events:true,pageDeletes:['tok'],pageAfter:2});
  const result=await f.run([c('SID','new'),c('tok','chrome')]);
  assert.equal(result.changed,1);
  assert.deepEqual([...f.jar.values()].map(c=>[c.name,c.value]),[['SID','new']]);
});

test('페이지가 다른 쿠키를 지워도 넣은 쿠키가 빠지면 되돌린다',async()=>{
  const before=[c('SID','old'),c('tok','old')];
  const f=fixture(before,{events:true,pageDeletes:['tok'],dropName:'HSID'});
  const result=await f.run([c('SID','new'),c('HSID','new'),c('tok','chrome')]);
  assert.equal(result.error,'cookie-transfer-failed');assert.equal(result.rolledBack,true);
  // 실패 기록에는 어긋난 쿠키의 도메인·이름만 남고 값은 없음
  assert.equal(result.reason.message,'cookie-readback-mismatch');
  assert.deepEqual(result.reason.cookies,[{domain:'.example.com',name:'HSID',state:'missing'}]);
});

test('남겨 두는 쿠키에 같은 key 의 파티션(CHIPS) 행이 있어도 바로 적용한다',async()=>{
  const f=fixture([c('SID','old'),c('cf_clearance','plain')],{chips:[c('cf_clearance','chips')]});
  const result=await f.run([c('SID','new')],{preserveCookie:c=>c.name==='cf_clearance'});
  assert.equal(result.changed,1);assert.equal(result.live,1);
  assert.deepEqual([...f.jar.values()].map(c=>[c.name,c.value]).sort(),[['SID','new'],['cf_clearance','plain']]);
});

test('없는 쿠키만 넣고 같은 key 의 기존 쿠키와 대상에만 있는 쿠키는 그대로 둔다',async()=>{
  const f=fixture([c('SID','iris'),c('only','keep')]);
  const result=await f.add([c('SID','chrome'),c('NEW','chrome')]);
  assert.equal(result.added,1);assert.equal(result.kept,1);
  assert.deepEqual([...f.jar.values()].map(c=>[c.name,c.value]).sort(),[['NEW','chrome'],['SID','iris'],['only','keep']]);
});

test('없는 쿠키 넣기가 실패하면 넣은 것만 지우고 기존 쿠키는 그대로 둔다',async()=>{
  const f=fixture([c('SID','iris')],{dropName:'HSID'});
  const result=await f.add([c('SID','chrome'),c('NEW','chrome'),c('HSID','chrome')]);
  assert.equal(result.error,'cookie-transfer-failed');assert.equal(result.rolledBack,true);
  assert.deepEqual(result.reason.cookies,[{domain:'.example.com',name:'HSID',state:'missing'}]);
  assert.deepEqual([...f.jar.values()].map(c=>[c.name,c.value]),[['SID','iris']]);
});
