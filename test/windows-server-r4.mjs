import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { windowsCommand, quoteWindows } from '../server/windows-shell.js';
import { mdnsRecords } from '../server/windows-mdns.js';
import { createAgentSocketServer } from '../server/remote/agent-socket.js';
import { connectAgent } from '../server/remote/agent-endpoint.mjs';
import { createTailscaleSetup } from '../server/remote/tailscale-setup.js';

const windows = process.platform === 'win32';

async function waitForNoConnections(server) {
  const deadline = Date.now() + 2_000;
  while (server.connectionCount() !== 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(server.connectionCount(), 0, '서버 종료 처리 후 연결 수');
}

test('Windows 명령은 셸별 경로와 명령을 인용하고 cd 실패 시 실행을 막는다', () => {
  assert.equal(windowsCommand(['codex', '--resume', 'a b'], 'C:\\O\'Brien & co', 'powershell'), "try { Set-Location -LiteralPath 'C:\\O''Brien & co' -ErrorAction Stop; & 'codex' '--resume' 'a b' } catch { Write-Error $_ }");
  assert.equal(windowsCommand(['claude'], 'D:\\한 글 & a', 'cmd'), 'cd /d "D:\\한 글 & a" && "claude"');
  assert.throws(() => quoteWindows('C:\\%PATH%', 'cmd'));
  assert.throws(() => quoteWindows('x\ny', 'powershell'));
  assert.throws(() => windowsCommand(['codex'], null, null));
});

test('mDNS 잘린 응답과 순환 압축 포인터를 거부한다', () => {
  assert.deepEqual(mdnsRecords(Buffer.alloc(2)), []);
  const packet = Buffer.alloc(16); packet.writeUInt16BE(0x8400, 2); packet.writeUInt16BE(1, 6);
  packet[12] = 0xc0; packet[13] = 12;
  assert.throws(() => mdnsRecords(packet), /pointer loop/);
  packet[12] = 0; assert.throws(() => mdnsRecords(packet), /header truncated/);
});

test('Tailscale Windows 설치는 winget과 고정 패키지 ID를 사용한다', async () => {
  let installed = false; const calls = [];
  const setup = createTailscaleSetup({ platform: 'win32', username: 'test',
    findExecutable: async () => { if (!installed) throw new Error('absent'); return 'C:\\Tailscale\\tailscale.exe'; },
    execFile: async (exe, args) => { calls.push([exe, args]); if (args[0] === 'install') installed = true; return { stdout: '' }; },
  });
  assert.deepEqual(await setup.install(), { ok: true });
  assert(calls.some(([exe, args]) => exe === 'winget.exe' && args.includes('Tailscale.Tailscale')));
  assert(!calls.some(([exe]) => /brew|osascript/.test(exe)));
  assert.deepEqual(await setup.install(), { ok: true, unchanged: true });
});

test('Windows 원격 연결은 토큰을 확인하고 종료 시 연결 정보를 삭제한다', { skip: !windows, timeout: 45000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'iris-r4-'));
  const socketPath = path.join(root, 'remote', 'agent.sock');
  const server = createAgentSocketServer({ socketPath, connectionLimit: 1, agents: { resolvePane: () => ({ kind: 'claude' }) }, requests: { cancel() {} } });
  t.after(async () => { await server.stop(); await fs.rm(root, { recursive: true }); });
  await server.start();
  const idle = connectAgent(socketPath).socket;
  idle.on('error', () => {});
  await new Promise((resolve) => idle.once('close', resolve));
  await waitForNoConnections(server);
  const endpoint = JSON.parse(await fs.readFile(socketPath, 'utf8'));
  assert.match(endpoint.token, /^[a-f0-9]{64}$/);
  const wrong = net.createConnection({ host: '127.0.0.1', port: endpoint.port });
  await new Promise((resolve, reject) => { wrong.once('connect', () => wrong.write(JSON.stringify({ role: 'channel', v: 1, paneId: 'p', cliSession: 's', token: '0'.repeat(64) }) + '\n')); wrong.once('close', resolve); wrong.once('error', reject); });
  await waitForNoConnections(server);
  const { socket, auth } = connectAgent(socketPath);
  t.after(() => socket.destroy());
  const hello = await new Promise((resolve, reject) => { socket.once('connect', () => socket.write(JSON.stringify({ role: 'channel', v: 1, paneId: 'p', cliSession: 's', ...auth }) + '\n')); socket.once('data', (bytes) => resolve(JSON.parse(bytes))); socket.once('error', reject); });
  assert.equal(hello.type, 'hello.ok');
  assert.equal(server.connectionCount(), 1);
  const source = '$a=[IO.File]::GetAccessControl($env:IRIS_TEST_ACL); $s=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; if(!$a.AreAccessRulesProtected){exit 2}; foreach($r in $a.Access){if($r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $s){exit 3}}';
  execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { env: { ...process.env, IRIS_TEST_ACL: socketPath }, windowsHide: true });
  socket.destroy();
  await waitForNoConnections(server);
  await server.stop();
  await assert.rejects(fs.stat(socketPath), { code: 'ENOENT' });
});

test('Windows PowerShell은 특수 문자가 있는 작업 폴더에서 실행한다', { skip: !windows }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'iris-r4-shell-'));
  const cwd = path.join(root, "한 글 O'Brien & x"); await fs.mkdir(cwd);
  t.after(() => fs.rm(root, { recursive: true }));
  const cmd = windowsCommand(['powershell.exe', '-NoProfile', '-Command', '(Get-Location).Path'], cwd, 'powershell');
  const result = execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(cmd, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true });
  assert(result.trim().endsWith("O'Brien & x"));
});


test('Windows 배치 실행은 npm shim을 찾고 출력 바이트·종료 코드를 보존한다', { skip: !windows, timeout: 30000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'iris-r4-worker-'));
  t.after(() => fs.rm(root, { recursive: true }));
  const { fileURLToPath } = await import('node:url');
  const cli = fileURLToPath(new URL('../bin/agent-run.mjs', import.meta.url));
  const program = path.join(root, 'fixture.cjs');
  await fs.writeFile(program, 'process.stdin.on("data", b => process.stdout.write(b)); process.stdin.on("end", () => { process.stderr.write(Buffer.from([65,66,67])); process.exitCode=7; });');
  await fs.writeFile(path.join(root, 'r4fixture.cmd'), `@echo off\r\n"${process.execPath}" "${program}"\r\n`);
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') || 'PATH';
  const env = { ...process.env, [pathKey]: root + path.delimiter + process.env[pathKey] };
  const bytes = Buffer.from([0,65,255,10]);
  const { spawnSync } = await import('node:child_process');
  const direct = spawnSync(process.execPath, [cli, '--', 'r4fixture'], { env, input: bytes, windowsHide: true });
  assert.equal(direct.status, 7, String(direct.stderr));
  assert.deepEqual(direct.stdout, bytes); assert.equal(String(direct.stderr), 'ABC');
  const config = path.join(root, 'run.json');
  await fs.writeFile(path.join(root, 'in.txt'), bytes);
  await fs.writeFile(config, JSON.stringify({ dir: root, cwd: root, argv: ['r4fixture'], env }));
  const worker = spawnSync(process.execPath, [cli, '--worker', config], { env, windowsHide: true });
  assert.equal(worker.status, 7, String(worker.stderr));
  assert.deepEqual(await fs.readFile(path.join(root, 'out.log')), bytes);
  assert.equal(await fs.readFile(path.join(root, 'err.log'), 'utf8'), 'ABC');
  assert.equal(await fs.readFile(path.join(root, 'status.txt'), 'utf8'), '7');
});

test('mDNS는 PTR·SRV·TXT 응답에서 서비스 이름·포트·인증 코드를 읽는다', () => {
  const name = (text) => Buffer.concat([...text.split('.').map((label) => { const b = Buffer.from(label); return Buffer.concat([Buffer.from([b.length]), b]); }), Buffer.from([0])]);
  const service = '_dartVmService._tcp.local', instance = 'sample.' + service;
  const record = (owner, type, data) => { const fields = Buffer.alloc(10); fields.writeUInt16BE(type, 0); fields.writeUInt16BE(1, 2); fields.writeUInt32BE(120, 4); fields.writeUInt16BE(data.length, 8); return Buffer.concat([name(owner), fields, data]); };
  const port = Buffer.alloc(6); port.writeUInt16BE(4567, 4);
  const auth = Buffer.from('authCode=abc_123=');
  const header = Buffer.alloc(12); header.writeUInt16BE(0x8400, 2); header.writeUInt16BE(3, 6);
  const values = mdnsRecords(Buffer.concat([header, record(service, 12, name(instance)), record(instance, 33, Buffer.concat([port, name('host.local')])), record(instance, 16, Buffer.concat([Buffer.from([auth.length]), auth]))]));
  assert.equal(values[0].target, instance); assert.equal(values[1].port, 4567); assert.deepEqual(values[2].text, ['authCode=abc_123=']);
});

test('Windows 원격 연결 정보가 없어도 MCP 초기화에는 응답한다', () => {
  const moduleUrl = new URL('../server/remote/channel/iris-channel.mjs', import.meta.url).href;
  const source = `Object.defineProperty(process,'platform',{value:'win32'}); process.argv[2]='Z:/iris-r4-missing-${process.pid}/agent.sock'; await import(${JSON.stringify(moduleUrl)});`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', source], { input: JSON.stringify({ id: 1, method: 'initialize' }) + '\n', encoding: 'utf8', env: { ...process.env, HERDR_PANE_ID: 'fixture', CLAUDE_CODE_SESSION_ID: 'fixture' }, timeout: 5000 });
  assert.equal(JSON.parse(out).result.serverInfo.name, 'iris-remote');
});
