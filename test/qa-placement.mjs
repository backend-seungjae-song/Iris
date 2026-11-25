import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import puppeteer from 'puppeteer-core';
const require = createRequire(import.meta.url);
const { headlessLaunchOptions } = require('../bin/headless-browser.cjs');

test('QA 배치는 숨김·작은 창·다른 화면에서 크기를 유지하고 앞 화면의 입력을 받지 않는다', async () => {
  const browser = await puppeteer.launch(headlessLaunchOptions());
  try {
    const page = await browser.newPage();
    const css = ['01-base', '03-feature-modes', '11-center-tabs', '18-browser', '19-terminal']
      .map(name => fs.readFileSync(new URL(`../web/css/${name}.css`, import.meta.url), 'utf8')).join('\n');
    for (const [width, height] of [[720, 600], [800, 1100], [1440, 900]]) {
      await page.setViewport({ width, height });
      for (const mode of ['', 'util-full']) {
        await page.setContent(`<style>${css}\nhtml,body,.app{margin:0;width:100%;height:100%}.app{position:relative}.center{flex-direction:column;width:100%;height:100%}#front{position:absolute;inset:0;z-index:2}</style>
          <div class="app"><section class="center"><div class="center-body" style="--keep-left:10px;--keep-top:20px;--keep-width:500px;--keep-height:300px"><div id="wv-stack" class="wv-wrap center-webviews" data-ai-keep-pending hidden><webview class="ai-behind"></webview></div></div></section><button id="front">앞 화면</button></div>`);
        await page.evaluate(m => { document.body.className = m; }, mode);
        const pendingSize = await page.$eval('#wv-stack', el => {
          const rect = el.getBoundingClientRect();
          return [rect.width, rect.height];
        });
        assert.deepEqual(pendingSize, [500, 300], `보호 표시 전 ${width}×${height} ${mode}`);
        await page.$eval('#wv-stack', el => {
          el.classList.add('ai-keep');
          el.removeAttribute('data-ai-keep-pending');
        });
        const state = await page.evaluate(() => {
          const w = document.querySelector('webview'), rect = w.getBoundingClientRect();
          return { width: rect.width, height: rect.height, pointer: getComputedStyle(w).pointerEvents,
            top: document.elementFromPoint(100, 100)?.id };
        });
        // pane-view 가 잰 칸 크기(--keep-*)로 유지. 창 크기와 무관해야 사용자가 열었을 때와 같음
        assert.deepEqual([state.width, state.height], [500, 300], `${width}×${height} ${mode}: ${JSON.stringify(state)}`);
        assert.equal(state.pointer, 'none');
        assert.equal(state.top, 'front');
      }
    }
  } finally { await browser.close(); }
});

test('사람이 앞에 띄운 QA 탭은 누르고 입력할 수 있다', async () => {
  const browser = await puppeteer.launch(headlessLaunchOptions());
  try {
    const page = await browser.newPage();
    const css = ['01-base', '03-feature-modes', '11-center-tabs', '18-browser', '19-terminal']
      .map(name => fs.readFileSync(new URL(`../web/css/${name}.css`, import.meta.url), 'utf8')).join('\n');
    await page.setViewport({ width: 1200, height: 800 });
    await page.setContent(`<style>${css}\nhtml,body{margin:0;width:100%;height:100%}.wv-wrap{position:relative;width:800px;height:600px}</style>
      <div id="wv-stack" class="wv-wrap center-webviews ai-keep"><webview id="front" class="ai-behind active"></webview><webview id="back" class="ai-behind"></webview></div>`);
    const state = await page.evaluate(() => ({
      front: getComputedStyle(document.getElementById('front')).pointerEvents,
      back: getComputedStyle(document.getElementById('back')).pointerEvents,
      top: document.elementFromPoint(100, 100)?.id,
    }));
    assert.notEqual(state.front, 'none');
    assert.equal(state.back, 'none');
    assert.equal(state.top, 'front');
  } finally { await browser.close(); }
});
