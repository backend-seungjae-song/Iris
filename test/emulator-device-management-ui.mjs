import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import puppeteer from 'puppeteer-core';
const require = createRequire(import.meta.url);
const { headlessLaunchOptions } = require('../bin/headless-browser.cjs');
const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');

async function fixture(run) {
  const browser = await puppeteer.launch({ ...headlessLaunchOptions(), args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 1000 });
    await page.setContent('<!doctype html><style>[hidden]{display:none!important}.emu-dp{width:288px}.cc-dd-menu{background:white}.cc-dd-menu li{min-height:24px}.emu-device-dialog{min-width:350px}</style><div class="right-head"><span class="sess"></span></div><div id="devices"></div>');
    await page.evaluate(async sources => {
      const url = source => URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      const dropdown = url(sources.dropdown), xcode = url(sources.xcode), android = url(sources.android);
      const panelUrl = url(sources.panel.replace('"../core/dropdown.js"', JSON.stringify(dropdown)).replace('"./xcode-guidance.js"', JSON.stringify(xcode)).replace('"./android-guidance.js"', JSON.stringify(android)));
      const panelModule = await import(panelUrl);
      const launchModule = await import(url(sources.launch.replace('"./devices-panel.js"', JSON.stringify(panelUrl))));
      window.calls = [];
      window.devices = [
        { udid: 'one', name: 'iPhone 13', runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-18-3', state: 'Booted', isAvailable: true, runnable: true, runtimeInstalled: true, canDuplicate: true },
        { udid: 'two', name: 'iPhone 15', runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-18-3', state: 'Shutdown', isAvailable: true, runnable: true, runtimeInstalled: true, canDuplicate: true },
        { udid: 'missing', name: 'iPhone 16', runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-18-5', state: 'Shutdown', isAvailable: false, runnable: false, runtimeInstalled: false, canDuplicate: false },
      ];
      window.places = { one: 'column', two: 'column' };
      const host = window.host = {
        getSettings: async () => ({ ok: true, settings: { mobileEmulatorDefaultDeviceUdid: null } }),
        setSettings: async settings => { calls.push(['settings', settings]); return { ok: true, settings }; },
        rpc: async () => ({ ok: true, result: { platform: 'darwin', available: true, simctl: { ok: true }, serveSim: { ok: true }, android: { sdkFound: false }, devices } }),
        deviceCatalog: async () => { calls.push(['catalog']); return { ok: true, catalog: { ios: { models: [{ id: 'iphone13', name: 'iPhone 13' }, { id: 'iphone15', name: 'iPhone 15' }], runtimes: [{ id: 'ios18', name: 'iOS 18.3', installed: true }, { id: 'missing18', name: 'iOS 18.5', installed: false }] }, android: { models: [], images: [] } } }; },
        createDevice: async args => {
          calls.push(['create', args]);
          if (window.createError) return { ok: false, error: createError };
          const device = { ...devices[1], udid: 'new-device', state: 'Shutdown', name: args.modelId === 'iphone15' ? 'iPhone 15 · 2' : 'iPhone 13 · 2' };
          devices.push(device); return { ok: true, device };
        },
        xcodeAction: async action => { calls.push(['xcode', action]); return { ok: true }; },
        androidAction: async action => { calls.push(['android', action]); return { ok: true }; },
      };
      window.panel = panelModule.mountDevicePanel(document.querySelector('#devices'), { host,
        currentUdid: () => 'one', deviceLocation: id => places[id] || null,
        onOpenDevice: async device => { calls.push(['open', device.udid]); device.state = 'Booted'; },
        onMoveDevice: async (device, place) => { calls.push(['move', device.udid, place]); places[device.udid] = place; },
        onStopDevice: async device => { calls.push(['stop', device.udid]); device.state = 'Shutdown'; },
      });
      await panel.refresh();
      window.launch = launchModule.mountLaunchButton({ host, hasTab: () => true, onOpen: d => calls.push(['launch', d.udid]) });
    }, { dropdown: read('web/js/core/dropdown.js'), xcode: read('web/js/emulator/xcode-guidance.js'), android: read('web/js/emulator/android-guidance.js'), panel: read('web/js/emulator/devices-panel.js'), launch: read('web/js/emulator/launch-button.js') });
    await run(page);
  } finally { await browser.close(); }
}
const row = id => `[data-device="${id}"]`;
const action = async (page, id, text) => {
  await page.evaluate(({ id, text }) => [...document.querySelectorAll(`[data-device="${id}"] .emu-dp-actions button`)].find(b => b.textContent === text).click(), { id, text });
  await page.waitForFunction(() => !document.querySelector('.emu-dp-note.busy'));
};

test('각 기기 행에서 이동·끄기·켜기·한 대 더를 실행하고 다른 기기는 유지한다', async () => fixture(async page => {
  assert.equal(await page.evaluate(() => calls.some(c => c[0] === 'create' || c[0] === 'catalog')), false, '목록 진입은 생성하지 않는다');
  await page.click(row('one') + ' .cc-dd-trigger');
  await page.click(row('one') + ' [data-value="external"]');
  await page.waitForFunction(() => calls.some(c => c[0] === 'move'));
  assert.deepEqual(await page.evaluate(() => calls[0]), ['move', 'one', 'external']);
  assert.equal(await page.evaluate(() => devices[0].state), 'Booted');
  await action(page, 'one', '끄기');
  await action(page, 'two', '켜기');
  assert.deepEqual(await page.evaluate(() => devices.slice(0, 2).map(d => d.state)), ['Shutdown', 'Booted']);
  await action(page, 'two', '한 대 더');
  assert.deepEqual(await page.evaluate(() => calls.find(c => c[0] === 'create')[1]), { platform: 'ios', sourceDevice: 'two', sourceName: 'iPhone 15' });
  assert.equal(await page.evaluate(() => devices.at(-1).state), 'Shutdown');
  assert.equal(await page.evaluate(() => calls.filter(c => c[0] === 'open').length), 1, '한 대 더는 추가 기기를 열지 않는다');
}));

test('기종 추가 창에서 다른 모델·설치 버전을 선택해 새 기기를 추가한다', async () => fixture(async page => {
  await page.evaluate(() => [...document.querySelectorAll('.emu-dp-add button')].find(b => b.textContent === '+ iOS 기종').click());
  await page.waitForSelector('.emu-device-form .cc-dd-trigger');
  await page.click('[aria-label="추가할 기종"]');
  await page.click('.emu-device-dialog [data-value="iphone15"]');
  await page.evaluate(() => [...document.querySelectorAll('.emu-device-dialog button')].find(b => b.textContent === '기기 추가').click());
  await page.waitForFunction(() => !document.querySelector('.emu-device-dialog'));
  assert.deepEqual(await page.evaluate(() => calls.find(c => c[0] === 'create')[1]), { platform: 'ios', modelId: 'iphone15', runtimeId: 'ios18' });
  assert.equal(await page.$eval(row('new-device') + ' .emu-dp-name', el => el.textContent), 'iPhone 15 · 2');
  assert.equal(await page.evaluate(() => calls.some(c => c[0] === 'open')), false);
}));

test('런타임 미설치 행은 실행을 막고 설치 안내를 제공한다', async () => fixture(async page => {
  assert.equal(await page.$eval(row('missing') + ' .emu-dp-row', el => el.disabled), true);
  assert.equal(await page.$eval(row('missing') + ' .emu-dp-readiness', el => el.textContent), '런타임 설치 필요');
  await page.click(row('missing') + ' .emu-dp-actions button');
  assert.match(await page.$eval('.emu-device-dialog', el => el.textContent), /iOS 18.5.*Xcode/);
  await page.evaluate(() => [...document.querySelectorAll('.emu-device-dialog button')].find(b => b.textContent === 'Xcode 열기').click());
  await page.waitForFunction(() => calls.some(c => c[0] === 'xcode'));
  assert.equal(await page.evaluate(() => calls.some(c => c[0] === 'open' || c[0] === 'create')), false);
  await page.click('.emu-launch');
  await page.waitForSelector('.emu-launch-item');
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('.emu-launch-item')].find(el => el.textContent.includes('iPhone 16')).disabled), true);
}));

test('생성 실패는 오류를 표시하고 자동으로 재시도하지 않는다', async () => fixture(async page => {
  await page.evaluate(() => { window.createError = '디스크 공간이 부족합니다.'; });
  await action(page, 'two', '한 대 더');
  assert.equal(await page.$eval('.emu-dp-note', el => el.textContent), '디스크 공간이 부족합니다.');
  assert.equal(await page.evaluate(() => calls.filter(c => c[0] === 'create').length), 1);
  assert.equal(await page.evaluate(() => devices.length), 3);
}));

test('설치된 iOS 버전을 지원하지 않는 기종은 추가를 막고 지원 버전을 안내한다', async () => fixture(async page => {
  await page.evaluate(() => {
    host.deviceCatalog = async () => ({ ok: true, catalog: { ios: {
      models: [{ id: 'iphone13', name: 'iPhone 13', minRuntimeVersion: 15 * 65536, maxRuntimeVersion: 19 * 65536 }, { id: 'newer', name: 'Newer iPhone', minRuntimeVersion: 19 * 65536 }],
      runtimes: [{ id: 'ios18', name: 'iOS 18.3', version: '18.3', installed: true }, { id: 'ios19', name: 'iOS 19', version: '19.0', installed: true }, { id: 'missing20', name: 'iOS 20', version: '20.0', installed: false }],
    } } });
    [...document.querySelectorAll('.emu-dp-add button')].find(b => b.textContent === '+ iOS 기종').click();
  });
  await page.waitForSelector('.emu-device-form .cc-dd-trigger');
  await page.click('[aria-label="추가할 기종"]');
  await page.click('.emu-device-dialog [data-value="newer"]');
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('.emu-device-dialog button')].find(b => b.textContent === '기기 추가').disabled), true);
  assert.equal(await page.$eval('.emu-device-form .emu-dp-desc', el => el.textContent), '선택한 기종은 이 iOS 버전을 지원하지 않습니다. 지원하는 버전을 선택하세요.');
  assert.equal(await page.evaluate(() => calls.some(c => c[0] === 'create')), false);
  await page.click('[aria-label="iOS 버전"]');
  await page.click('.emu-device-dialog [data-value="missing20"]');
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('.emu-device-dialog button')].find(b => b.textContent === '설치 안내').disabled), false);
  await page.click('[aria-label="iOS 버전"]');
  await page.click('.emu-device-dialog [data-value="ios19"]');
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('.emu-device-dialog button')].find(b => b.textContent === '기기 추가').disabled), false);
  await page.evaluate(() => [...document.querySelectorAll('.emu-device-dialog button')].find(b => b.textContent === '기기 추가').click());
  await page.waitForFunction(() => !document.querySelector('.emu-device-dialog'));
  assert.deepEqual(await page.evaluate(() => calls.find(c => c[0] === 'create')[1]), { platform: 'ios', modelId: 'newer', runtimeId: 'ios19' });
}));
