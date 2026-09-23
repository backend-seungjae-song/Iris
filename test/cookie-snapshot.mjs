import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {replaceCookieSnapshot}=require('../native/electron/cookie-snapshot.cjs');
const {cookieKey}=require('../native/electron/cookie-sync-policy.cjs');
const c=(name,value,domain='.example.com')=>({name,value,domain,path:'/',secure:true,httpOnly:true,sameSite:"unspecified"});
function fixture(before,{failName,readFail=false,rollbackFail=false,overwriteSecure=false}={}) {
  const jar=new Map(before.map(c=>[cookieKey(c),c]));let writes=0,failed=false;const scopes=[],predicates=[];
  const session={cookies:{
    get:async()=>{if(readFail)throw Error('unavailable');return [...jar.values()];},
    set:async d=>{writes++; if((d.name===failName&&!failed)||(failed&&rollbackFail)) {failed=true;throw Error('rejected');}
      // Chromium 은 Secure 가 아닌 쿠키로 같은 이름의 Secure 쿠키를 덮지 못하게 한다(EXCLUDE_OVERWRITE_SECURE).
      if(overwriteSecure&&!d.secure&&[...jar.values()].some(c=>c.secure&&c.name===d.name&&c.domain.replace(/^\./,'')===new URL(d.url).hostname)) throw Error('EXCLUDE_OVERWRITE_SECURE'); const cookie={...d,domain:d.domain||new URL(d.url).hostname};delete cookie.url;jar.set(cookieKey(cookie),cookie);},
    remove:async(url,name)=>{for(const [k,c] of jar) if(c.name===name&&c.domain.replace(/^\./,'')===new URL(url).hostname)jar.delete(k);},
    flushStore:async()=>{},
  }};
  const transfer={run:async(scope,fn)=>{predicates.push(scope);scopes.push(scope({url:'https://example.com/a'}));scopes.push(scope({url:'https://unrelated.test/a'}));return fn();}};
  const scope=d=>d.replace(/^\./,'')==='example.com';
  const run=(list,extra={})=>replaceCookieSnapshot({session,transfer,scope,list,...extra});
  return {jar,run,writes:()=>writes,scopes,predicates};
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
