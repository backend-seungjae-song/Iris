// Windows 네이티브 호출은 한 PowerShell 프로세스의 JSON 표준 입출력을 쓴다.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { windowsPowerShellEnv } = require('./windows-powershell.cjs');
const { StringDecoder } = require('node:string_decoder');
const SCRIPT = path.join(__dirname, 'win-native-helper.ps1');
function browserPath(browser = 'chrome', env = process.env) {
  const fs = require('node:fs');
  const suffix = { chrome: ['Google', 'Chrome', 'Application', 'chrome.exe'], edge: ['Microsoft', 'Edge', 'Application', 'msedge.exe'], brave: ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'] }[browser];
  if (!suffix) return null;
  for (const root of [env.LOCALAPPDATA, env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean)) {
    const bin = path.win32.join(root, ...suffix);
    if (fs.existsSync(bin)) return bin;
  }
  return null;
}
function createWinNative({ spawnImpl = spawn, platform = process.platform, timeoutMs = 15000, maxBytes = 16 << 20 } = {}) {
  let child = null, next = 1, buffer = '', stopped = false;
  const pending = new Map();
  const reference = (c, on) => {
    const method = on ? 'ref' : 'unref';
    c?.[method]?.();
    for (const stream of [c?.stdin, c?.stdout, c?.stderr]) stream?.[method]?.();
  };
  const fail = (error) => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.resolve({ ok: false, error }); }
    pending.clear(); buffer = '';
  };
  function terminate(error) {
    const old = child; child = null; fail(error);
    try { old?.stdin.end(); old?.kill(); } catch {}
  }
  function ensure() {
    if (child) { reference(child, true); return child; }
    const ps = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
    const c = spawnImpl(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: windowsPowerShellEnv() });
    child = c;
    const decoder = new StringDecoder('utf8');
    c.stdout.on('data', (chunk) => {
      if (child !== c) return;
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > maxBytes) return terminate('response-too-large');
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
        let msg; try { msg = JSON.parse(line); } catch { terminate('invalid-response'); return; }
        const p = pending.get(msg.id); if (!p) continue;
        pending.delete(msg.id); clearTimeout(p.timer); p.resolve(msg);
        if (!pending.size) reference(c, false);
      }
    });
    c.stderr.on('data', () => {});
    c.on('error', () => { if (child === c) terminate('helper-unavailable'); });
    c.stdin.on('error', () => { if (child === c) terminate('helper-input-failed'); });
    c.on('exit', () => { if (child === c) { child = null; fail('helper-exited'); } });
    return c;
  }
  return {
    available: platform === 'win32',
    request(input) {
      if (platform !== 'win32' || stopped) return Promise.resolve({ ok: false, error: stopped ? 'helper-stopped' : 'unsupported-platform' });
      if (!input || typeof input.op !== 'string') return Promise.resolve({ ok: false, error: 'invalid-request' });
      if (pending.size >= 128) return Promise.resolve({ ok: false, error: 'helper-busy' });
      let c; try { c = ensure(); } catch { return Promise.resolve({ ok: false, error: 'helper-unavailable' }); }
      const id = next++;
      return new Promise((resolve) => {
        const timer = setTimeout(() => terminate('timeout'), timeoutMs);
        pending.set(id, { resolve, timer });
        try { c.stdin.write(JSON.stringify({ ...input, id }) + '\n'); } catch { terminate('helper-input-failed'); }
      });
    },
    stop() { stopped = true; terminate('helper-stopped'); },
  };
}
const singleton = createWinNative();
process.once('exit', () => singleton.stop());
module.exports = { createWinNative, request: singleton.request, stop: singleton.stop, browserPath };
