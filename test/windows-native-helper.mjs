import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { createWinNative } = require('../server/win-native.cjs');
const { windowsPowerShellEnv } = require('../server/windows-powershell.cjs');
const root = fileURLToPath(new URL('../', import.meta.url));
function startWindowFixture(spawnImpl = spawn) {
  return spawnImpl('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'test/windows-native-fixture.ps1')], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false, env: windowsPowerShellEnv() });
}
function fixture() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let killed = 0, refs = 0, unrefs = 0;
  child.kill = () => { killed++; }; child.ref = () => { refs++; }; child.unref = () => { unrefs++; };
  return { child, state: () => ({ killed, refs, unrefs }) };
}
test('native helper shares process, handles partial JSON and releases idle handles', async () => {
  const f = fixture(); let spawns = 0; const sent = [];
  f.child.stdin.on('data', (b) => sent.push(JSON.parse(String(b))));
  const client = createWinNative({ platform: 'win32', spawnImpl: () => { spawns++; return f.child; } });
  const first = client.request({ op: 'processes' }), second = client.request({ op: 'windows' });
  assert.equal(spawns, 1);
  f.child.stdout.write(JSON.stringify({ id: sent[1].id, ok: true, windows: [] }) + '\n');
  const response = Buffer.from(JSON.stringify({ id: sent[0].id, ok: true, processes: [{cwd:'C:\\한글'}] }) + '\n');
  const split = response.indexOf(Buffer.from('한')) + 1;
  f.child.stdout.write(response.subarray(0, split)); f.child.stdout.write(response.subarray(split));
  assert.equal((await first).processes[0].cwd, 'C:\\한글'); assert.equal((await second).ok, true);
  assert.equal(f.state().unrefs, 1);
  const third = client.request({ op: 'windows' });
  assert.ok(f.state().refs > 0);
  client.stop(); assert.equal((await third).error, 'helper-stopped'); assert.equal(f.state().killed, 1);
});
test('spawn error, timeout and malformed output fail every pending request', async () => {
  for (const mode of ['error', 'timeout', 'invalid']) {
    const f = fixture(); const client = createWinNative({ platform: 'win32', timeoutMs: 10, spawnImpl: () => f.child });
    const a = client.request({ op: 'processes' }); const b = client.request({ op: 'windows' });
    if (mode === 'error') f.child.emit('error', new Error('missing'));
    if (mode === 'invalid') f.child.stdout.write('invalid\n');
    assert.equal((await a).ok, false); assert.equal((await b).ok, false); assert.equal(f.state().killed, 1);
    client.stop();
  }
});
test('unsupported hosts do not spawn PowerShell', async () => {
  const client = createWinNative({ platform: 'darwin', spawnImpl: () => { throw new Error('unexpected'); } });
  assert.equal((await client.request({ op: 'windows' })).error, 'unsupported-platform');
});
test('GUI fixture preserves the first WinForms window visibility', () => {
  const f = fixture();
  const gui = startWindowFixture((file, args, options) => {
    assert.equal(file, 'powershell.exe');
    assert.equal(args.at(-1), path.join(root, 'test/windows-native-fixture.ps1'));
    assert.equal(options.windowsHide, false, '첫 WinForms 창 표시');
    assert.deepEqual(options.env, windowsPowerShellEnv());
    return f.child;
  });
  assert.equal(gui, f.child);
});
if (process.platform === 'win32') test('Windows helper reads real cwd, attributes port, enumerates and moves real window, invokes native button', { timeout: 90000 }, async () => {
  const client = createWinNative({ timeoutMs: 30000 });
  const listener = net.createServer();
  let gui;
  try {
    await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
    const table = await client.request({ op: 'processes', pids: [process.pid] });
    assert.equal(table.ok, true, JSON.stringify(table)); assert.equal(table.processes.length, 1);
    assert.equal(path.resolve(table.processes[0].cwd).toLowerCase(), process.cwd().toLowerCase());
    assert.ok(table.processes[0].ppid > 0); assert.equal(table.processes[0].cwdStatus, 'known');
    const port = await client.request({ op: 'portCwd', port: listener.address().port });
    assert.equal(port.ok, true, JSON.stringify(port)); assert.equal(port.pid, process.pid);
    const denied = await client.request({ op: 'focus', hwnd: 1, pid: process.pid }); assert.equal(denied.ok, false);
    gui = startWindowFixture();
    let err = ''; gui.stderr.on('data', (b) => { err += b; });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fixture timeout: ' + err)), 20000);
      gui.once('error', (e) => { clearTimeout(timer); reject(e); });
      gui.once('exit', () => { clearTimeout(timer); reject(new Error('fixture exit: ' + err)); });
      gui.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    });
    const list = await client.request({ op: 'windows' }); assert.equal(list.ok, true, JSON.stringify(list));
    const window = list.windows.find((w) => w.pid === gui.pid && w.matchTitle === 'Iris 한글 Windows Native Test'); assert.ok(window, JSON.stringify(list));
    assert.ok(window.bounds[2] > 80); assert.ok(window.pidStart);
    const move = await client.request({ op: 'move', hwnd: window.id, pid: window.pid, start: window.pidStart, bounds: [100, 100, 420, 260] });
    assert.equal(move.ok, true, JSON.stringify(move)); assert.deepEqual(move.bounds, [100, 100, 420, 260]);
    const bad = await client.request({ op: 'move', hwnd: window.id, pid: process.pid, bounds: [0, 0, 420, 260] }); assert.equal(bad.ok, false);
    const focused = await client.request({ op: 'focus', hwnd: window.id, pid: window.pid, start: window.pidStart });
    assert.equal(focused.ok, true, JSON.stringify(focused));
    const key = await client.request({ op: 'key', pid: gui.pid, key: 'enter' });
    assert.equal(key.ok, false, 'background dialog button must not receive Enter');
    const description = await client.request({ op: 'describe', pid: gui.pid }); assert.equal(description.ok, true, JSON.stringify(description));
    assert.ok(description.windows.some((w) => w.buttons.includes('Iris Test Close')));
    const exited = once(gui, 'exit');
    const click = await client.request({ op: 'click', pid: gui.pid, button: 'Iris Test Close' }); assert.equal(click.ok, true, JSON.stringify(click));
    await exited; gui = null;
  } finally { gui?.kill(); listener.close(); client.stop(); }
});
