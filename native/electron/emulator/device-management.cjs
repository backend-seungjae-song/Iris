const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { inspectAndroidSetup } = require('./android-setup.cjs');

function runCommand(file, args, { input, timeout = 15000, env } = {}) {
  return new Promise((resolve, reject) => {
    const batch = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(file);
    if (batch && [file, ...args].some(value => /[\x00-\x1f"&|<>^%!]/.test(value))) {
      reject(new Error('Windows 명령 경로 또는 인자에 지원하지 않는 문자가 있습니다.'));
      return;
    }
    const command = batch ? env?.ComSpec || process.env.ComSpec || 'cmd.exe' : file;
    const commandArgs = batch ? [`/d /v:off /s /c "${[file, ...args].map(value => `"${value}"`).join(' ')}"`] : args;
    const child = execFile(command, commandArgs, { timeout, maxBuffer: 4 * 1024 * 1024, env, ...(batch ? { windowsHide: true, windowsVerbatimArguments: true } : {}) }, (error, stdout, stderr) => {
      if (error) { error.message = String(stderr || error.message).trim(); reject(error); }
      else resolve(stdout);
    });
    if (input != null) child.stdin.end(input);
  });
}
function fail(message, code = 'device_unavailable') { throw Object.assign(new Error(message), { code }); }
function readIni(file) {
  try { return Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(line => line.includes('=')).map(line => { const i = line.indexOf('='); return [line.slice(0, i).trim(), line.slice(i + 1).trim()]; })); }
  catch { return {}; }
}
function entries(dir) { try { return fs.readdirSync(dir); } catch { return []; } }
function parseAndroidModels(text) {
  return [...String(text).matchAll(/id:\s*\d+\s+or\s+"([^"]+)"\s*\n\s*Name:\s*([^\n]+)/g)].map(([, id, name]) => ({ id, name: name.trim() }));
}
function chooseDefaultDevice(devices) {
  const available = devices.filter(d => d.isAvailable !== false && d.runnable !== false);
  return available.find(d => d.modelId === 'com.apple.CoreSimulator.SimDeviceType.iPhone-13' || /^iPhone 13(?:$|\s*[·(])/.test(d.name || ''))
    || null;
}

function createDeviceManager({ run = runCommand, platform = process.platform, env = process.env, home = os.homedir(), getSettings = () => ({}) } = {}) {
  let creating = false;
  async function catalog() {
    const out = { ios: { models: [], runtimes: [], devices: [], error: null }, android: { models: [], images: [], avds: [], error: null } };
    await Promise.all([
      (async () => {
        if (platform !== 'darwin') return;
        try {
          const data = JSON.parse(await run('xcrun', ['simctl', 'list', '-j']));
          out.ios.models = (data.devicetypes || []).filter(d => d.productFamily === 'iPhone' || d.productFamily === 'iPad' || /^(iPhone|iPad)/.test(d.name || '')).map(d => ({ id: d.identifier, name: d.name, minRuntimeVersion: d.minRuntimeVersion, maxRuntimeVersion: d.maxRuntimeVersion }));
          out.ios.runtimes = (data.runtimes || []).filter(r => /SimRuntime\.iOS-/.test(r.identifier || '')).map(r => ({ id: r.identifier, name: r.name, installed: r.isAvailable === true, version: r.version, error: r.availabilityError || null }));
          out.ios.devices = Object.entries(data.devices || {}).flatMap(([runtime, devices]) => devices.map(d => ({ ...d, runtime, modelId: d.deviceTypeIdentifier })));
        } catch (error) { out.ios.error = error.message; }
      })(),
      (async () => {
        const setup = inspectAndroidSetup({ configuredPath: getSettings().androidSdkPath, home, env, platform });
        const sdk = setup.sdkPath;
        if (!sdk) { out.android.error = 'Android SDK를 찾지 못했습니다.'; return; }
        out.android.sdkPath = sdk;
        const tools = path.join(sdk, 'cmdline-tools');
        const candidates = ['latest', ...entries(tools).filter(v => v !== 'latest').sort().reverse()].map(v => path.join(tools, v, 'bin', platform === 'win32' ? 'avdmanager.bat' : 'avdmanager'));
        out.android.avdmanager = candidates.find(file => fs.existsSync(file)) || null;
        const imageRoot = path.join(sdk, 'system-images');
        for (const api of entries(imageRoot)) for (const tag of entries(path.join(imageRoot, api))) for (const abi of entries(path.join(imageRoot, api, tag))) {
          const dir = path.join(imageRoot, api, tag, abi);
          if (fs.existsSync(path.join(dir, 'system.img'))) out.android.images.push({ id: `system-images;${api};${tag};${abi}`, name: `${api.replace('android-', 'API ')} · ${tag} · ${abi}`, installed: true });
        }
        const avdHome = env.ANDROID_AVD_HOME || path.join(env.ANDROID_USER_HOME || env.ANDROID_EMULATOR_HOME || path.join(home, '.android'), 'avd');
        for (const file of entries(avdHome).filter(f => f.endsWith('.ini'))) {
          const meta = readIni(path.join(avdHome, file));
          const dir = meta.path || path.join(avdHome, file.replace(/\.ini$/, '.avd'));
          const config = readIni(path.join(dir, 'config.ini'));
          const imagePath = config['image.sysdir.1'];
          const imageDir = imagePath ? path.resolve(sdk, imagePath) : null;
          const image = out.android.images.find(i => path.resolve(sdk, ...i.id.split(';')) === imageDir);
          out.android.avds.push({ name: file.slice(0, -4), modelId: config['hw.device.name'], imageId: image?.id || null, installed: Boolean(imageDir && fs.existsSync(path.join(imageDir, 'system.img'))) });
        }
        if (!out.android.avdmanager) { out.android.error = 'Android SDK Command-line Tools를 설치하세요.'; return; }
        try { out.android.models = parseAndroidModels(await run(out.android.avdmanager, ['list', 'device'])); }
        catch (error) { out.android.error = error.message; }
      })(),
    ]);
    return out;
  }

  function annotate(devices, inventory, availability) {
    return devices.map(device => {
      if (device.runtime === 'Android') {
        const avd = inventory.android.avds.find(a => a.name === device.udid || a.name === device.name);
        const installed = avd ? avd.installed : device.isAvailable !== false;
        return { ...device, persistentId: avd?.name || device.udid, modelId: avd?.modelId, imageId: avd?.imageId, runtimeInstalled: installed,
          runnable: installed && device.isAvailable !== false && Boolean(availability.android?.sdkFound),
          canDuplicate: Boolean(avd?.imageId && avd?.modelId && inventory.android.avdmanager),
          missingReason: installed ? null : 'Android 시스템 이미지 설치 필요' };
      }
      const source = inventory.ios.devices.find(d => d.udid === device.udid);
      const runtime = inventory.ios.runtimes.find(r => r.id === device.runtime);
      const installed = runtime ? runtime.installed : device.isAvailable !== false;
      return { ...device, modelId: source?.modelId, runtimeInstalled: installed,
        runnable: installed && device.isAvailable !== false && Boolean(availability.simctl?.ok && availability.serveSim?.ok),
        canDuplicate: Boolean(installed && source?.modelId),
        missingReason: installed ? null : runtime?.error || 'iOS 런타임 설치 필요' };
    });
  }

  async function create(args) {
    if (creating) fail('다른 기기를 추가하는 중입니다.', 'device_creation_busy');
    if (!args || !['ios', 'android'].includes(args.platform)) fail('기기 플랫폼이 올바르지 않습니다.', 'invalid_device');
    creating = true;
    try {
      const inventory = await catalog();
      let modelId = args.modelId, runtimeId = args.runtimeId, imageId = args.imageId;
      if (args.platform === 'ios') {
        const source = args.sourceDevice && inventory.ios.devices.find(d => d.udid === args.sourceDevice);
        if (args.sourceDevice && !source) fail('원본 기기를 찾지 못했습니다. 목록을 새로 고침하세요.');
        if (source) { modelId = source.modelId; runtimeId = source.runtime; }
        const model = inventory.ios.models.find(m => m.id === modelId);
        const runtime = inventory.ios.runtimes.find(r => r.id === runtimeId && r.installed);
        if (!model || !runtime) fail('설치된 iOS 런타임과 지원하는 기종을 선택하세요.');
        const version = runtime.version?.split('.').map(Number);
        const packed = version && version[0] * 65536 + (version[1] || 0) * 256 + (version[2] || 0);
        if (packed != null && ((model.minRuntimeVersion != null && packed < model.minRuntimeVersion) || (model.maxRuntimeVersion != null && packed > model.maxRuntimeVersion))) fail('이 기종은 선택한 iOS 버전을 지원하지 않습니다.');
        const sameModel = inventory.ios.devices.filter(d => d.modelId === model.id || d.name === model.name || d.name?.startsWith(`${model.name} · `));
        const names = new Set(inventory.ios.devices.map(d => d.name));
        let number = sameModel.length + 1;
        while (names.has(`${model.name} · ${number}`)) number += 1;
        const name = `${model.name} · ${number}`;
        const udid = String(await run('xcrun', ['simctl', 'create', name, model.id, runtime.id], { timeout: 30000 })).trim();
        if (!/^[\da-f-]{36}$/i.test(udid)) fail('생성 결과를 확인하지 못했습니다. 기기 목록을 새로 고침하세요.', 'creation_unconfirmed');
        return { udid, name, runtime: runtime.id, modelId: model.id, state: 'Shutdown', isAvailable: true, runtimeInstalled: true };
      }
      const source = args.sourceDevice && inventory.android.avds.find(a => a.name === args.sourceDevice || a.name === args.sourceName);
      if (args.sourceDevice && !source) fail('복제할 Android 가상 기기를 찾지 못했습니다. 실제 기기는 복제할 수 없습니다.');
      if (source) { modelId = source.modelId; imageId = source.imageId; }
      const model = inventory.android.models.find(m => m.id === modelId);
      const image = inventory.android.images.find(i => i.id === imageId && i.installed);
      if (!model || !image || !inventory.android.avdmanager) fail('설치된 시스템 이미지·기종·Android Command-line Tools가 필요합니다.');
      const name = `Iris_${model.id.replace(/[^\w-]/g, '_')}_${crypto.randomUUID().slice(0, 8)}`;
      await run(inventory.android.avdmanager, ['create', 'avd', '--name', name, '--package', image.id, '--device', model.id], { input: 'no\n', timeout: 60000, env: { ...env, ANDROID_HOME: inventory.android.sdkPath, ANDROID_SDK_ROOT: inventory.android.sdkPath } });
      return { udid: name, name, runtime: 'Android', modelId: model.id, imageId: image.id, state: 'Shutdown', isAvailable: true, runtimeInstalled: true };
    } finally { creating = false; }
  }
  async function ensureDefault(availability) {
    const inventory = await catalog();
    const devices = annotate(availability.devices || [], inventory, availability);
    const preference = getSettings().mobileEmulatorDefaultDeviceUdid;
    const saved = preference && devices.find(d => (d.udid === preference || d.persistentId === preference) && d.runnable);
    if (saved) return saved;
    if (preference) fail('저장된 기본 기기를 실행할 수 없습니다. 런타임을 설치하거나 기본 기기 설정에서 다른 기기를 선택하세요.', 'saved_device_unavailable');
    if (platform === 'win32') fail('기본 기기 설정에서 실행 가능한 Android 기기를 선택하세요.', 'default_device_required');
    const existing = chooseDefaultDevice(devices);
    if (existing) return existing;
    if (inventory.ios.error || !availability.serveSim?.ok) fail('기본 iPhone 13을 추가하려면 Xcode와 iOS 시뮬레이터 도구를 먼저 설정하세요.');
    const model = inventory.ios.models.find(m => m.id === 'com.apple.CoreSimulator.SimDeviceType.iPhone-13');
    const runtime = inventory.ios.runtimes.filter(r => {
      if (!r.installed || !model) return false;
      const parts = String(r.version || '').split('.').map(Number);
      const packed = parts[0] * 65536 + (parts[1] || 0) * 256 + (parts[2] || 0);
      return (model.minRuntimeVersion == null || packed >= model.minRuntimeVersion) && (model.maxRuntimeVersion == null || packed <= model.maxRuntimeVersion);
    }).sort((a, b) => String(b.version).localeCompare(String(a.version), 'en', { numeric: true }))[0];
    if (!model || !runtime) fail('iPhone 13을 지원하는 iOS 런타임이 없습니다. Xcode에서 런타임을 설치한 뒤 다시 여세요.');
    return create({ platform: 'ios', modelId: model.id, runtimeId: runtime.id });
  }
  return { catalog, annotate, create, ensureDefault };
}
module.exports = { createDeviceManager, chooseDefaultDevice };
