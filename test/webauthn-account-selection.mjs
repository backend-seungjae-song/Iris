import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { allowsFileSystemRead, createProfileSessionPolicy } = createRequire(import.meta.url)('../native/electron/profile-session-policy.cjs');
function fixture(chooseWebauthnAccount) {
  const listeners = new Map();
  const sess = {setDevicePermissionHandler(){}, removeListener(){}, on(n,f){listeners.set(n,f)}, setPermissionRequestHandler(){}, setPermissionCheckHandler(){}};
  const policy = createProfileSessionPolicy({basePartition:'persist:acbrowser',fromPartition:()=>sess,hardenBrowserSession(){},userAgentForPartition(){},audioInputPermission:()=>false,installSessionHook(){},chooseWebauthnAccount});
  policy.hardenSession(sess);
  return listeners.get('select-webauthn-account');
}
const details = {frame:{url:'https://example.test/'}, relyingPartyId:'example.test',accounts:[{credentialId:'a',name:'First'},{credentialId:'b',name:'Second'}]};
test('multiple passkeys select the chosen credential instead of cancelling', async () => {
  const handler = fixture(async d => {assert.equal(d,details); return 'b'});
  const result = await new Promise(resolve=>handler({preventDefault(){}},details,resolve));
  assert.equal(result,'b');
});
test('invalid choice, rejected picker and insecure frame cancel exactly once', async () => {
  for (const [picker, input] of [[async()=> 'unknown', details],[async()=>{throw Error('cancel')},details],[async()=> 'a',{...details,frame:{url:'http://example.test/'}}]]) {
    const calls=[];
    fixture(picker)({preventDefault(){}},input,x=>calls.push(x));
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(calls,[null]);
  }
});
test('history access recognizes only registered profile sessions and forget revokes access',()=>{
  const sess = {setDevicePermissionHandler(){},removeListener(){},on(){},setPermissionRequestHandler(){},setPermissionCheckHandler(){}};
  const policy=createProfileSessionPolicy({basePartition:'persist:acbrowser',fromPartition:()=>sess,hardenBrowserSession(){},userAgentForPartition(){},audioInputPermission:()=>false,installSessionHook(){}});
  assert.equal(policy.ownsSession(sess),false);
  policy.hardenSession(sess,'persist:acprof:test');
  assert.equal(policy.ownsSession(sess),true);
  assert.equal(policy.ownsSession({}),false);
  policy.forget('persist:acprof:test');
  assert.equal(policy.ownsSession(sess),false);
});

const readableFile = {
  requestingUrl: 'https://chatgpt.com/images',
  fileAccessType: 'readable',
  filePath: '/tmp/reference.png',
  isDirectory: false,
};

test('secure pages may read a file explicitly supplied through the browser',()=>{
  assert.equal(allowsFileSystemRead('fileSystem','https://chatgpt.com',readableFile),true);
  assert.equal(allowsFileSystemRead('fileSystem','https://chatgpt.com',{
    ...readableFile,requestingUrl:undefined,
  }),true);
  assert.equal(allowsFileSystemRead('fileSystem','http://localhost:4291',{
    ...readableFile,requestingUrl:'http://localhost:4291/test',
  }),true);
});

test('filesystem permission keeps writes, directories, missing paths, and insecure pages denied',()=>{
  for (const [permission,origin,details] of [
    ['fileSystem','https://chatgpt.com',{...readableFile,fileAccessType:'writable'}],
    ['fileSystem','https://chatgpt.com',{...readableFile,isDirectory:true}],
    ['fileSystem','https://chatgpt.com',(({isDirectory,...details})=>details)(readableFile)],
    ['fileSystem','https://chatgpt.com',{...readableFile,filePath:''}],
    ['fileSystem','https://chatgpt.com',{...readableFile,requestingUrl:'http://example.test/'}],
    ['fileSystem','http://example.test',{...readableFile,requestingUrl:'http://example.test/'}],
    ['notifications','https://chatgpt.com',readableFile],
  ]) assert.equal(allowsFileSystemRead(permission,origin,details),false);
});

test('request and check handlers both grant only the bounded readable-file case',()=>{
  let requestHandler=null,checkHandler=null;
  const sess={
    setDevicePermissionHandler(){},removeListener(){},on(){},setDisplayMediaRequestHandler(){},
    setPermissionRequestHandler(handler){requestHandler=handler},
    setPermissionCheckHandler(handler){checkHandler=handler},
  };
  const policy=createProfileSessionPolicy({
    basePartition:'persist:acbrowser',fromPartition:()=>sess,hardenBrowserSession(){},userAgentForPartition(){},
    audioInputPermission:()=>false,installSessionHook(){},platform:'darwin',
    systemPreferences:{getMediaAccessStatus:()=> 'granted',askForMediaAccess:()=>Promise.resolve(true)},
  });
  policy.hardenSession(sess);
  let requested=null;
  requestHandler({isDestroyed:()=>false},'fileSystem',value=>{requested=value},readableFile);
  assert.equal(requested,true);
  assert.equal(checkHandler(null,'fileSystem','https://chatgpt.com',readableFile),true);
  const writable={...readableFile,fileAccessType:'writable'};
  requestHandler({isDestroyed:()=>false},'fileSystem',value=>{requested=value},writable);
  assert.equal(requested,false);
  assert.equal(checkHandler(null,'fileSystem','https://chatgpt.com',writable),false);
});
