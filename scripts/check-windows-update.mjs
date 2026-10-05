import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { windowsPowerShellEnv } from '../server/windows-powershell.cjs';

assert.equal(process.platform, 'win32');
const root = process.cwd();
const evidence = path.join(root, 'evidence', 'update-continuity');
fs.mkdirSync(evidence, { recursive: true });
const exe = path.join(process.env.LOCALAPPDATA, 'Programs', 'Iris', 'Iris.exe');
const unpacked = path.join(path.dirname(exe), 'resources', 'app.asar.unpacked');
const { HerdrClient } = await import(pathToFileURL(path.join(unpacked, 'server', 'herdr.js')));
const { herdrSession } = await import(pathToFileURL(path.join(unpacked, 'server', 'herdr-session.cjs')));
const herdr = new HerdrClient();
const session = herdrSession();
const workspace = await herdr.workspaceCreate({ cwd: evidence, label: 'Windows update continuity' });
const workspaceId = workspace?.workspace?.workspace_id || workspace?.workspace_id;
assert.ok(typeof workspaceId === 'string' && workspaceId.length > 0, 'created workspace ID');
const wait = async (read, predicate, label) => {
  const until = Date.now() + 20000;
  do {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < until);
  throw new Error(`${label}: timeout`);
};
const panes = await wait(() => herdr.paneList(workspaceId), value => value.length > 0, 'pane creation');
const paneId = panes[0].pane_id;
const token = randomUUID();
const record = path.join(evidence, 'terminal.json');
const sentinel = path.join(evidence, 'terminal.cjs');
fs.writeFileSync(sentinel, `const fs = require('node:fs'); const token = ${JSON.stringify(token)}; fs.writeFileSync(process.argv[2], JSON.stringify({pid:process.pid,token})); process.stdin.on('data',()=>console.log('continuity:'+token+':'+process.pid)); setInterval(()=>{},1000);`);
await herdr.paneSendText(paneId, `node "${sentinel}" "${record}"\r`);
const terminal = await wait(() => fs.existsSync(record) ? JSON.parse(fs.readFileSync(record, 'utf8')) : null, Boolean, 'terminal process');
const fixture = path.join(unpacked, 'bin', 'iris-mcp.mjs');
fs.writeFileSync(fixture, `import '../server/remote/channel/iris-channel.mjs';
import { createWinNative } from '../server/win-native.cjs';
import { spawn } from 'node:child_process';
let helper;
const native = createWinNative({ spawnImpl: (...args) => (helper = spawn(...args)) });
let buffer = '';
process.stdin.on('data', data => {
  buffer += data; let newline;
  while ((newline = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    const message = JSON.parse(line);
    if (message.method === 'continuity.native') native.request({op:'processes',pids:[process.pid]}).then(result => process.stdout.write(JSON.stringify({id:message.id,result:{native:result,helperPid:helper.pid}})+'\\n'));
  }
});
process.stdin.on('end', () => native.stop());
process.once('exit', () => native.stop());
`);
const mcp = spawn(exe, [fixture], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
});
let output = '';
mcp.stdout.on('data', data => { output += data; });
mcp.stderr.on('data', data => fs.appendFileSync(path.join(evidence, 'mcp-stderr.txt'), data));
const initialize = async id => {
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'initialize', params: {} }) + '\n');
  return wait(() => output.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(reply => reply.id === id), value => value?.result?.serverInfo?.name === 'iris-remote', 'MCP response');
};
const nativeProbe = async id => {
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'continuity.native' }) + '\n');
  return wait(() => output.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(reply => reply.id === id && reply.result?.native), value => value?.result?.native?.ok === true, 'native MCP helper response');
};
const processes = () => JSON.parse(execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '@(Get-CimInstance Win32_Process -OperationTimeoutSec 10 | Select-Object ProcessId,ParentProcessId,Name,CreationDate) | ConvertTo-Json -Compress'], { encoding: 'utf8', env: windowsPowerShellEnv(), windowsHide: true, timeout: 15000 }));
try {
  await initialize(1);
  const nativeBefore = await nativeProbe(101);
  const before = processes();
  const byId = new Map(before.map(value => [value.ProcessId, value]));
  let ancestor = byId.get(terminal.pid);
  while (ancestor && ancestor.Name.toLowerCase() !== 'herdr.exe') ancestor = byId.get(ancestor.ParentProcessId);
  assert.ok(ancestor, 'terminal must belong to a real herdr process');
  fs.writeFileSync(path.join(evidence, 'before.json'), JSON.stringify({ session, workspace, paneId, terminal, mcpPid: mcp.pid, nativeBefore, herdr: ancestor, processes: before }, null, 2));
  const collector = path.join(process.env.RUNNER_TEMP, 'iris-evidence.ps1');
  const collect = label => execFileSync('pwsh.exe', ['-NoProfile', '-File', collector, label], { stdio: 'inherit', timeout: 60000 });
  collect('before-second-setup');
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/v:off', '/s', '/c', 'setup.cmd --yes'], { cwd: root, stdio: 'inherit' });
      child.on('error', reject); child.on('exit', (code, signal) => resolve({ code, signal }));
    });
  } finally { collect('after-second-setup'); }
  assert.equal(result.code, 0, 'second setup');
  assert.equal(mcp.exitCode, null, 'same MCP process');
  await initialize(2);
  const nativeAfter = await nativeProbe(102);
  assert.equal(nativeAfter.result.helperPid, nativeBefore.result.helperPid, 'same native MCP helper');
  const after = processes();
  for (const pid of [terminal.pid, mcp.pid, ancestor.ProcessId, nativeBefore.result.helperPid]) {
    const old = byId.get(pid), current = after.find(value => value.ProcessId === pid);
    assert.ok(current, `process ${pid} survived`);
    assert.equal(current.CreationDate, old.CreationDate, `process ${pid} identity`);
  }
  assert.deepEqual(herdrSession(), session, 'same herdr session');
  assert.ok((await herdr.paneList(workspaceId)).some(pane => pane.pane_id === paneId), 'same pane');
  await herdr.paneSendText(paneId, 'continuity\r');
  await wait(() => herdr.paneRead(paneId), value => value.text?.includes(`continuity:${token}:${terminal.pid}`), 'same terminal memory');
  fs.writeFileSync(path.join(evidence, 'after.json'), JSON.stringify({ session, paneId, terminal, mcpPid: mcp.pid, nativeAfter, herdrPid: ancestor.ProcessId, processes: after }, null, 2));
  console.log('동일 herdr 세션·pane·터미널 프로세스·MCP 응답 유지');
} finally {
  mcp.stdin.end();
  await herdr.workspaceClose(workspaceId);
}
