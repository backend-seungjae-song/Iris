import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../native/electron/emulator/emulator-host.cjs', import.meta.url), 'utf8');
// 표에 없는 모듈은 emulator-host 와 같은 폴더 기준으로 찾음
const hostRequire = createRequire(new URL('../native/electron/emulator/emulator-host.cjs', import.meta.url));

function fixture({ settingsText } = {}) {
  const handlers = new Map(), windows = [], messages = [];
  const confirmations = [], removals = [];
  let response = 0, pendingSettings;
  let shutdownResult = { ok: true, deviceUdid: 'canonical-device' };
  let shutdownError = null;
  class Window {
    constructor() {
      this.webContents = { on() {}, send(channel, payload) { messages.push({ channel, payload }); } };
      windows.push(this);
    }
    isDestroyed() { return false; }
    show() {}
    focus() {}
    on() {}
    getBounds() { return { x: 0, y: 0, width: 400, height: 800 }; }
    static getAllWindows() { return windows; }
    static fromWebContents() { return windows[0]; }
  }
  const manager = { catalog: async () => ({}), create: async () => ({}), ensureDefault: async () => ({ udid: 'default' }),
    remove: async (args, hooks) => {
      removals.push(args);
      const device = { udid: 'canonical-device', persistentId: 'saved-avd', name: 'Test phone' };
      if (!await hooks.confirm(device)) return { canceled: true };
      await hooks.stop(device);
      return { deleted: true, device };
    },
  };
  const orca = {
    EmulatorBridge: class {},
    RuntimeEmulatorCommands: class { async emulatorShutdown() { if (shutdownError) throw shutdownError; return shutdownResult; } },
    EMULATOR_METHODS: [{ name: 'emulator.shutdown', params: { parse: v => v }, handler: async () => {
      if (shutdownError) throw shutdownError;
      return shutdownResult;
    } }],
    registerEmulatorFrameStreamHandlers() {}, registerEmulatorVideoStreamHandlers() {},
  };
  const loaded = { exports: {} };
  const modules = {
    fs: { ...require('node:fs'), readFileSync(file, ...args) {
      if (settingsText !== undefined && String(file).endsWith('emulator-settings.json')) return settingsText;
      return require('node:fs').readFileSync(file, ...args);
    }, mkdirSync() {}, writeFileSync(file, contents) { pendingSettings = contents; }, renameSync() { settingsText = pendingSettings; } },
    './electron-guard.cjs': { configure() {} },
    './stale-helper-cleanup.cjs': {}, './xcode-setup.cjs': {}, './android-setup.cjs': {},
    './audio-volume.cjs': { createVolumeController: () => ({ stopAll() {} }) },
    './device-preview.cjs': { createDevicePreview: () => ({ dispose() {} }) },
    './device-management.cjs': { createDeviceManager: () => manager },
    './shared-device-guard.cjs': { guardSharedDevices: () => ({ beforeAttach: async () => {} }) },
    './helper-watchdog.cjs': { createHelperWatchdog: () => ({ start() {}, stop() {} }) },
    './orca-emulator.cjs': orca,
    electron: { dialog: { showMessageBox: async (win, options) => { confirmations.push(options); return { response }; } }, screen: { getAllDisplays: () => [] } },
  };
  vm.runInNewContext(source, { require: name => modules[name] || hostRequire(name), module: loaded, console, process, URLSearchParams, setTimeout, clearTimeout });
  loaded.exports.initCapability({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), on() {} }, isTrustedSender: e => e.trusted,
    BrowserWindow: Window, app: { on() {} }, stateDir: '/unused-iris-test', shell: {}, preloadPath: '/unused', getAppUrl: () => 'http://test', loadUrlWithRetry() {},
  });
  new Window();
  return { handlers, messages, confirmations, removals, setResponse: value => { response = value; }, setResult: value => { shutdownResult = value; }, setError: value => { shutdownError = value; } };
}

test('종료 성공은 실제 종료한 기기와 worktree를 모든 화면에 알린다', async () => {
  const f = fixture();
  const result = await f.handlers.get('ac-emulator-rpc')({ trusted: true }, { method: 'emulator.shutdown', params: { worktree: 'iris:emulator:one', device: 'requested-device' } });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(f.messages)), [{ channel: 'ac-emulator-session-stopped', payload: { worktree: 'iris:emulator:one', device: 'canonical-device' } }]);
});

test('종료 실패·managedOnly의 실제 작업 없는 응답·신뢰하지 않는 요청은 종료 알림을 보내지 않는다', async () => {
  const f = fixture();
  const invoke = event => f.handlers.get('ac-emulator-rpc')(event, { method: 'emulator.shutdown', params: { worktree: 'one', managedOnly: true } });
  f.setResult({ ok: true }); await invoke({ trusted: true });
  f.setError(new Error('shutdown failed')); assert.equal((await invoke({ trusted: true })).ok, false);
  assert.equal((await invoke({ trusted: false })).ok, false);
  assert.equal(f.messages.length, 0);
});

test('이미 열린 외부 창은 명시적 connect만 받아 기기를 다시 켠다', () => {
  const f = fixture();
  const event = { trusted: true, sender: { isDestroyed: () => true } };
  const open = f.handlers.get('ac-emulator-window-open');
  assert.equal(open(event, { space: 'space', tab: 'tab', device: 'one' }).ok, true);
  open(event, { space: 'space', tab: 'tab', device: 'one' });
  assert.equal(f.messages.length, 0, '기존 창 포커스는 전원을 켜지 않는다');
  open(event, { space: 'space', tab: 'tab', device: 'one', connect: true });
  assert.deepEqual(JSON.parse(JSON.stringify(f.messages)), [{ channel: 'ac-emulator-connect', payload: { device: 'one' } }]);
});

test('손상된 기본 기기 설정을 자동 기본값으로 바꾸지 않는다', () => {
  for (const settingsText of ['{broken', '[]', '{"mobileEmulatorDefaultDeviceUdid":42}']) {
    const f = fixture({ settingsText });
    const result = f.handlers.get('ac-emulator-settings-get')({ trusted: true });
    assert.equal(result.ok, false);
    assert.equal(result.settings, undefined);
  }
  const f = fixture({ settingsText: '{"mobileEmulatorDefaultDeviceUdid":"exact-device"}' });
  assert.equal(f.handlers.get('ac-emulator-settings-get')({ trusted: true }).settings.mobileEmulatorDefaultDeviceUdid, 'exact-device');
});

test('가상 기기 삭제는 신뢰된 창에서 취소가 기본인 확인 창을 제공한다', async () => {
  const f = fixture({ settingsText: '{"mobileEmulatorDefaultDeviceUdid":"saved-avd"}' });
  const remove = f.handlers.get('ac-emulator-device-delete');
  assert.equal((await remove({ trusted: false }, { platform: 'android', device: 'one' })).ok, false);
  assert.equal(f.removals.length, 0);
  const result = await remove({ trusted: true }, { platform: 'android', device: 'one' });
  assert.equal(result.canceled, true);
  assert.equal(f.confirmations[0].defaultId, 0);
  assert.equal(f.confirmations[0].cancelId, 0);
  assert.deepEqual(Array.from(f.confirmations[0].buttons), ['취소', '삭제']);
  assert.match(f.confirmations[0].detail, /앱과 데이터.*복구할 수 없습니다/);
  assert.equal(f.messages.length, 0);
  assert.equal(f.handlers.get('ac-emulator-settings-get')({ trusted: true }).settings.mobileEmulatorDefaultDeviceUdid, 'saved-avd');
});

test('삭제 성공은 기본 기기를 해제하고 종료 실패는 선택을 유지한다', async () => {
  const f = fixture({ settingsText: '{"mobileEmulatorDefaultDeviceUdid":"saved-avd"}' });
  f.setResponse(1);
  const remove = f.handlers.get('ac-emulator-device-delete');
  f.setError(new Error('shutdown failed'));
  assert.equal((await remove({ trusted: true }, { platform: 'android', device: 'one' })).ok, false);
  assert.equal(f.handlers.get('ac-emulator-settings-get')({ trusted: true }).settings.mobileEmulatorDefaultDeviceUdid, 'saved-avd');
  f.setError(null);
  const result = await remove({ trusted: true }, { platform: 'android', device: 'one' });
  assert.equal(result.deleted, true);
  assert.equal(f.handlers.get('ac-emulator-settings-get')({ trusted: true }).settings.mobileEmulatorDefaultDeviceUdid, null);
  assert.ok(f.messages.every(m => m.channel === 'ac-emulator-session-stopped' && m.payload.device === 'canonical-device'));
});
