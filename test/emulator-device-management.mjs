import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { deviceRunnable, deviceReadiness } from '../web/js/emulator/devices-panel.js';

const require = createRequire(import.meta.url);
const { createDeviceManager, chooseDefaultDevice } = require('../native/electron/emulator/device-management.cjs');
const model = 'com.apple.CoreSimulator.SimDeviceType.iPhone-13';
const runtime = 'com.apple.CoreSimulator.SimRuntime.iOS-18-3';
const source = '11111111-1111-1111-1111-111111111111';
const created = '22222222-2222-2222-2222-222222222222';
const iosData = () => ({
  devicetypes: [{ identifier: model, name: 'iPhone 13', productFamily: 'iPhone', minRuntimeVersion: 15 * 65536, maxRuntimeVersion: 25 * 65536 }],
  runtimes: [{ identifier: runtime, name: 'iOS 18.3', version: '18.3', isAvailable: true }, { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-5', name: 'iOS 18.5', isAvailable: false }],
  devices: { [runtime]: [{ udid: source, name: 'Custom phone', deviceTypeIdentifier: model, isAvailable: true, state: 'Booted' }] },
});
function iosManager(data = iosData()) {
  const calls = [];
  const manager = createDeviceManager({ home: '/nonexistent/iris-test', env: {}, platform: 'darwin', run: async (file, args) => {
    calls.push({ file, args });
    if (args.includes('list')) return JSON.stringify(data);
    return created;
  } });
  return { manager, calls };
}

test('iOS 한 대 더는 같은 기종·런타임에 새 UDID를 생성하고 전원을 켜지 않는다', async () => {
  const { manager, calls } = iosManager();
  const result = await manager.create({ platform: 'ios', sourceDevice: source });
  assert.equal(result.udid, created);
  assert.equal(result.state, 'Shutdown');
  assert.deepEqual(calls.at(-1).args.slice(3), [model, runtime]);
  assert.equal(calls.at(-1).args[2], 'iPhone 13 · 2');
  assert.equal(calls.filter(c => c.args.includes('boot') || c.args.includes('shutdown') || c.args.includes('delete')).length, 0);
});

test('런타임 미설치·기종 불일치·원본 누락은 생성 전에 거부한다', async () => {
  const { manager, calls } = iosManager();
  await assert.rejects(manager.create({ platform: 'ios', modelId: model, runtimeId: 'com.apple.CoreSimulator.SimRuntime.iOS-18-5' }), /설치된/);
  await assert.rejects(manager.create({ platform: 'ios', modelId: 'arbitrary', runtimeId: runtime }), /기종/);
  await assert.rejects(manager.create({ platform: 'ios', sourceDevice: 'unknown' }), /원본/);
  assert.equal(calls.some(c => c.args.includes('create')), false);
});

test('선택한 iOS 버전을 지원하지 않는 기종은 생성하지 않는다', async () => {
  const data = iosData(); data.devicetypes[0].minRuntimeVersion = 19 * 65536;
  const { manager, calls } = iosManager(data);
  await assert.rejects(manager.create({ platform: 'ios', modelId: model, runtimeId: runtime }), /지원하지/);
  assert.equal(calls.some(c => c.args.includes('create')), false);
});

test('런타임 설치 상태와 실행 도구 상태를 각각 판정한다', async () => {
  const { manager } = iosManager();
  const inventory = await manager.catalog();
  const rows = manager.annotate([
    { udid: source, runtime, isAvailable: true, state: 'Shutdown' },
    { udid: 'missing', runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-18-5', isAvailable: false },
  ], inventory, { simctl: { ok: true }, serveSim: { ok: true } });
  assert.equal(rows[0].runnable, true);
  assert.equal(rows[0].canDuplicate, true);
  assert.equal(deviceReadiness(rows[0]), '설치됨 · 실행 가능');
  assert.equal(rows[1].runtimeInstalled, false);
  assert.equal(deviceRunnable(rows[1]), false);
  assert.equal(deviceReadiness(rows[1]), '런타임 설치 필요');
  const [noTool] = manager.annotate([rows[0]], inventory, { simctl: { ok: true }, serveSim: { ok: false } });
  assert.equal(noTool.runtimeInstalled, true);
  assert.equal(deviceReadiness(noTool), '도구 설정 필요');
});

test('자동 기본 기기는 iPhone 13을 선택하고 실행 불가·다른 기종을 제외한다', () => {
  const other = { udid: 'other', name: 'iPhone 16', state: 'Booted' };
  const preferred = { udid: 'preferred', name: 'Custom phone', modelId: model };
  assert.equal(chooseDefaultDevice([other, preferred]), preferred);
  assert.equal(chooseDefaultDevice([other, { ...preferred, runnable: false }]), null);
  assert.equal(chooseDefaultDevice([{ ...preferred, isAvailable: false }]), null);
});

test('기본 기기가 없으면 명시적 기본 기기 요청에서만 iPhone 13을 추가한다', async () => {
  const data = iosData(); data.devices = {};
  const { manager, calls } = iosManager(data);
  await manager.catalog();
  assert.equal(calls.some(c => c.args.includes('create')), false);
  const result = await manager.ensureDefault({ devices: [], simctl: { ok: true }, serveSim: { ok: true } });
  assert.equal(result.modelId, model);
  assert.equal(result.state, 'Shutdown');
  assert.deepEqual(calls.at(-1).args.slice(3), [model, runtime]);
});

test('사용자가 저장한 실행 가능한 기본 기기를 유지하고 생성하지 않는다', async () => {
  const calls = [];
  const manager = createDeviceManager({ platform: 'darwin', home: '/nonexistent', env: {}, getSettings: () => ({ mobileEmulatorDefaultDeviceUdid: source }), run: async (file, args) => { calls.push(args); return JSON.stringify(iosData()); } });
  const result = await manager.ensureDefault({ devices: [{ udid: source, name: 'Saved custom phone', runtime, isAvailable: true }], simctl: { ok: true }, serveSim: { ok: true } });
  assert.equal(result.udid, source);
  assert.equal(result.name, 'Saved custom phone');
  assert.equal(calls.some(args => args.includes('create')), false);
});

test('저장된 기본 기기가 실행 불가면 선택을 보존하고 다른 기기를 만들지 않는다', async () => {
  const calls = [];
  const manager = createDeviceManager({ platform: 'darwin', home: '/nonexistent', env: {}, getSettings: () => ({ mobileEmulatorDefaultDeviceUdid: 'missing-preference' }), run: async (file, args) => { calls.push(args); return JSON.stringify(iosData()); } });
  await assert.rejects(manager.ensureDefault({ devices: [{ udid: source, name: 'iPhone 13', runtime, isAvailable: true }], simctl: { ok: true }, serveSim: { ok: true } }), error => error.code === 'saved_device_unavailable');
  assert.equal(calls.some(args => args.includes('create')), false);
});

test('iOS 추가 이름은 기존 기기 번호와 충돌하지 않는다', async () => {
  const data = iosData(); data.devices[runtime][0].name = 'iPhone 13 · 2';
  const { manager, calls } = iosManager(data);
  await manager.create({ platform: 'ios', sourceDevice: source });
  assert.equal(calls.at(-1).args[2], 'iPhone 13 · 3');
});

test('기본 iPhone 13에 설치된 런타임이 없으면 다른 기종으로 바꾸지 않는다', async () => {
  const data = iosData(); data.runtimes.forEach(r => { r.isAvailable = false; }); data.devices = {};
  const { manager, calls } = iosManager(data);
  await assert.rejects(manager.ensureDefault({ devices: [{ udid: 'other', name: 'iPhone 16', runtime }], simctl: { ok: true }, serveSim: { ok: true } }), /런타임이 없습니다/);
  assert.equal(calls.some(c => c.args.includes('create')), false);
});

function androidFixture(t, preference = null) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'iris-device-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const sdk = path.join(home, 'sdk');
  const imageId = 'system-images;android-35;google_apis;arm64-v8a';
  for (const file of ['platform-tools/adb', 'emulator/emulator', 'cmdline-tools/latest/bin/avdmanager', 'system-images/android-35/google_apis/arm64-v8a/system.img']) {
    mkdirSync(path.dirname(path.join(sdk, file)), { recursive: true }); writeFileSync(path.join(sdk, file), '');
  }
  const avdHome = path.join(home, '.android', 'avd');
  const avd = path.join(avdHome, 'Original.avd'); mkdirSync(avd, { recursive: true });
  writeFileSync(path.join(avdHome, 'Original.ini'), `path=${avd}\n`);
  writeFileSync(path.join(avd, 'config.ini'), 'hw.device.name=pixel_7\nimage.sysdir.1=system-images/android-35/google_apis/arm64-v8a/\n');
  const calls = [];
  const manager = createDeviceManager({ home, platform: 'linux', env: {}, getSettings: () => ({ androidSdkPath: sdk, mobileEmulatorDefaultDeviceUdid: preference }), run: async (file, args, options) => {
    calls.push({ file, args, options });
    return args[0] === 'list' ? 'id: 0 or "pixel_7"\n    Name: Pixel 7\n    OEM : Google\n' : '';
  } });
  return { manager, calls, imageId, avd };
}

test('Android 한 대 더는 같은 시스템 이미지·기종에 별도 AVD를 만들고 원본 데이터는 보존한다', async t => {
  const { manager, calls, imageId, avd } = androidFixture(t);
  const inventory = await manager.catalog();
  assert.equal(inventory.android.avds[0].installed, true);
  assert.equal(inventory.android.avds[0].imageId, imageId);
  const result = await manager.create({ platform: 'android', sourceDevice: 'emulator-5554', sourceName: 'Original' });
  assert.match(result.udid, /^Iris_pixel_7_/);
  assert.equal(result.state, 'Shutdown');
  const command = calls.at(-1);
  assert.deepEqual(command.args.slice(4), ['--package', imageId, '--device', 'pixel_7']);
  assert.equal(command.args.includes('--force'), false);
  assert.equal(command.options.input, 'no\n');
  assert.equal(result.udid, command.args[3]);
  const { readFileSync } = await import('node:fs');
  assert.match(readFileSync(path.join(avd, 'config.ini'), 'utf8'), /hw.device.name=pixel_7/);
});

test('Android 이미지 누락과 실제 기기의 복제 요청을 거부한다', async t => {
  const { manager, calls, avd } = androidFixture(t);
  writeFileSync(path.join(avd, 'config.ini'), 'hw.device.name=pixel_7\nimage.sysdir.1=system-images/android-99/google_apis/arm64-v8a/\n');
  await assert.rejects(manager.create({ platform: 'android', sourceDevice: 'Original' }), /설치된/);
  await assert.rejects(manager.create({ platform: 'android', sourceDevice: 'physical-phone' }), /실제 기기/);
  assert.equal(calls.some(c => c.args[0] === 'create'), false);
});

test('Android 기본 기기는 전원을 켠 뒤에도 저장한 AVD 이름으로 같은 기기를 찾는다', async t => {
  const { manager, calls } = androidFixture(t, 'Original');
  const inventory = await manager.catalog();
  const [row] = manager.annotate([{ udid: 'emulator-5554', name: 'Original', runtime: 'Android', isAvailable: true }], inventory, { android: { sdkFound: true } });
  assert.equal(row.persistentId, 'Original');
  assert.equal(row.udid, 'emulator-5554');
  assert.equal(row.runnable, true);
  const selected = await manager.ensureDefault({ devices: [{ udid: 'emulator-5554', name: 'Original', runtime: 'Android', isAvailable: true }], android: { sdkFound: true } });
  assert.equal(selected.udid, 'emulator-5554');
  assert.equal(calls.some(c => c.args[0] === 'create'), false);
});

test('저장한 Android 실행 시리얼이 사라지면 다른 시리얼로 자동 변경하지 않는다', async t => {
  const { manager, calls } = androidFixture(t, 'emulator-5554');
  await assert.rejects(manager.ensureDefault({ devices: [{ udid: 'emulator-5556', name: 'Original', runtime: 'Android', isAvailable: true }], android: { sdkFound: true } }), error => error.code === 'saved_device_unavailable');
  assert.equal(calls.some(c => c.args[0] === 'create'), false);
});

test('동시에 두 번 추가하면 중복 생성 명령을 실행하지 않는다', async () => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const manager = createDeviceManager({ platform: 'darwin', home: '/nonexistent', env: {}, run: async (file, args) => args.includes('list') ? (await wait, JSON.stringify(iosData())) : created });
  const pending = manager.create({ platform: 'ios', modelId: model, runtimeId: runtime });
  await assert.rejects(manager.create({ platform: 'ios', modelId: model, runtimeId: runtime }), /추가하는 중/);
  release(); await pending;
});
