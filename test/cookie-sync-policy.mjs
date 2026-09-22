import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { planCookieRefresh, loginFingerprint, sourceRevision } = require('../native/electron/cookie-sync-policy.cjs');
const login = (value, expirationDate = 1000) => ['SID', 'HSID', 'SAPISID'].map(name => ({name, value, domain:'.google.com',path:'/',expirationDate}));
const old = login('old');
const previous = {cid:'chrome:Default',sourceFingerprint:loginFingerprint(old,'google.com'),targetFingerprint:loginFingerprint(old,'google.com')};
const plan = (args = {}) => planCookieRefresh({source:login('new'), target:old, base:'google.com',cid:'chrome:Default',previous,...args});
test('Chrome 재로그인은 쿠키 한 벌을 적용하며 개별 만료 시각을 비교하지 않는다', () => {
  const source = login('new'); source[0].expirationDate=10; source[1].expirationDate=999999;
  assert.equal(plan({source}).reason,'source-session-changed');
  assert.equal(plan({source}).apply,true);
});
test('설정 쿠키나 만료 시각만 달라지면 Google 세션은 그대로 둔다', () => {
  const source=[...login('old',999999),{name:'PREF',value:'new',domain:'.google.com'}];
  assert.equal(plan({source}).apply,false);
});
test('Iris에서 따로 로그인했으면 Chrome 사본으로 되돌리지 않는다', () => {
  assert.equal(plan({target:login('local',10)}).reason,'local-session-changed');
});
test('출처 기록 없는 기존 로그인은 정상 탐색 중 보존한다', () => {
  assert.equal(plan({previous:null}).reason,'untracked-session');
  assert.equal(plan({previous:{...previous,cid:'chrome:Profile 9'}}).apply,false);
});
test('로그인 화면 자동 복구는 같은 Chrome 세션을 반복 적용하지 않는다', () => {
  const result=plan({recovering:true}); assert.equal(result.apply,true);
  assert.equal(plan({recovering:true,previous:{...result.state,attempted:result.state.sourceRevision}}).reason,'already-attempted');
});
test('새 Chrome 로그인은 이전 복구 시도 뒤에도 자동으로 가져올 수 있다', () => {
  assert.equal(plan({recovering:true,previous:{...previous,attempted:previous.sourceFingerprint}}).apply,true);
});
test('빈 Chrome 또는 불완전한 Google 로그인은 대상 로그인을 지우지 않는다', () => {
  assert.equal(plan({source:[],recovering:true}).apply,false);
  assert.equal(plan({source:login('new').slice(0,1),recovering:true}).apply,false);
});
test('사용자의 로그아웃은 평범한 탭 전환만으로 되돌리지 않는다', () => {
  assert.equal(plan({target:[]}).reason,'login-required');
});

test('Chrome이 동일 값의 만료를 연장하면 사라진 Iris 세션을 한 번 복구한다', () => {
  const imported = login('old',1000);
  const renewed = login('old',9000);
  const known = {...previous, sourceRevision:sourceRevision(imported,'google.com'), attempted:sourceRevision(imported,'google.com')};
  const result = plan({source:renewed,target:[],previous:known,recovering:true});
  assert.equal(result.apply,true);
  assert.equal(result.state.sourceFingerprint,known.sourceFingerprint);
  assert.notEqual(result.state.sourceRevision,known.sourceRevision);
  assert.equal(plan({source:renewed,target:[],recovering:true,
    previous:{...result.state,attempted:result.state.sourceRevision}}).reason,'already-attempted');
});
test('설정 쿠키 변경은 실패했던 로그인 재시도 횟수를 새로 주지 않는다',()=>{
  const source=login('old');
  const known={...previous, attempted:sourceRevision(source,'google.com')};
  source.push({name:'PREF',value:'updated',domain:'.google.com',expirationDate:99999});
  assert.equal(plan({source,target:[],recovering:true,previous:known}).reason,'already-attempted');
});
