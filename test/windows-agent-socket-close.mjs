import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 클라이언트·서버 종료 순서 재현
const bootstrap = `
import net from 'node:net';
import childProcess from 'node:child_process';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';

const temporaryRoot = os.tmpdir();
os.tmpdir = () => temporaryRoot;
Object.defineProperty(process, 'platform', { value: 'win32' });
childProcess.execFileSync = () => Buffer.alloc(0);
let accept;
net.createServer = (handler) => {
  accept = handler;
  const server = new EventEmitter();
  const handle = setInterval(() => {}, 1_000);
  server.listen = () => queueMicrotask(() => server.emit('listening'));
  server.address = () => ({ port: 54321 });
  server.close = (done) => { clearInterval(handle); queueMicrotask(done); };
  return server;
};
net.createConnection = () => {
  const client = new EventEmitter();
  const server = new EventEmitter();
  for (const socket of [client, server]) {
    socket.destroyed = false;
    socket.writable = true;
    socket.setEncoding = () => socket;
    socket.end = () => socket;
  }
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    for (const socket of [client, server]) {
      socket.destroyed = true;
      socket.writable = false;
    }
    queueMicrotask(() => client.emit('close'));
    if (!process.env.IRIS_TEST_WITHHOLD_SERVER_CLOSE) {
      setTimeout(() => server.emit('close'), 30);
    }
  };
  for (const [socket, peer] of [[client, server], [server, client]]) {
    socket.destroy = () => { close(); return socket; };
    socket.write = (bytes, done) => {
      queueMicrotask(() => { peer.emit('data', String(bytes)); done?.(); });
      return true;
    };
  }
  queueMicrotask(() => { accept(server); client.emit('connect'); });
  return client;
};
syncBuiltinESMExports();
`;

function run(withholdClose = false) {
  const file = fileURLToPath(new URL('./windows-server-r4.mjs', import.meta.url));
  const env = { ...process.env, IRIS_TEST_WITHHOLD_SERVER_CLOSE: withholdClose ? '1' : '' };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [
    '--import', `data:text/javascript;base64,${Buffer.from(bootstrap).toString('base64')}`,
    '--test', '--test-name-pattern', '^Windows 원격 연결은 토큰을 확인하고 종료 시 연결 정보를 삭제한다$', file,
  ], {
    encoding: 'utf8', timeout: 15_000,
    env,
  });
}

test('Windows 연결 검사는 클라이언트 뒤에 발생하는 서버 close를 기다린다', () => {
  const result = run();
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /# pass 1/);
});

test('Windows 연결 검사는 서버 close가 누락되면 남은 연결을 실패로 보고한다', () => {
  const result = run(true);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /서버 종료 처리 후 연결 수/);
  assert.match(result.stdout, /actual: 1/);
});
