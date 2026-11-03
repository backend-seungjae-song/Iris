import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import puppeteer from "puppeteer-core";
import { sliceBetween } from "../bin/slice-anchor.mjs";

const require = createRequire(import.meta.url);
const { headlessLaunchOptions } = require("../bin/headless-browser.cjs");
const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
const main = read("../web/js/main.js");
const handler = sliceBetween(main, "function handleAiNotifyMessage(", "\nfunction handleAiProgressMessage(", "확인 알림 처리");

// 알림 목록 모듈과 main.js 의 ai-notify 처리를 그대로 띄움. 탭 이동은 tabs 에 있는 id 만 성공
async function fixture(run) {
  const browser = await puppeteer.launch({ ...headlessLaunchOptions(), args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setContent("<!doctype html><body></body>");
    await page.evaluate(async ({ noticeSource, handler }) => {
      const notices = await import(URL.createObjectURL(new Blob([noticeSource], { type: "text/javascript" })));
      window.os = []; window.moved = []; window.tabs = new Set(["tab-live"]);
      window.acHost = { notify: (m) => window.os.push(m) };
      const gotoTabById = (id) => { if (!window.tabs.has(id)) return false; window.moved.push(id); return true; };
      window.handle = new Function("pushNotice", "hasNotice", "gotoTabById", "callHook", "wsSend", "window",
        `${handler}\nreturn handleAiNotifyMessage;`)(notices.pushNotice, notices.hasNotice, gotoTabById, () => false, () => {}, window);
    }, { noticeSource: read("../web/js/core/notice-center.js"), handler });
    await run(page);
  } finally { await browser.close(); }
}
const card = (page, id) => page.evaluate((id) => {
  const el = document.querySelector(`[data-id="${id}"]`);
  return el && { buttons: [...el.querySelectorAll(".iris-notice-actions button")].map((b) => ({ text: b.textContent, disabled: b.disabled })) };
}, id);

test("review 알림은 시간이 지나도 남고 앱이 뒤에 있으면 macOS 알림을 요청한다", async () => fixture(async (page) => {
  await page.evaluate(() => {
    window.handle({ id: "r1", level: "info", title: "보고서 확인", tab: "tab-live", review: true });
    window.handle({ id: "p1", level: "info", title: "일반 알림", tab: "tab-live" });
  });
  await new Promise((resolve) => setTimeout(resolve, 4600));
  assert.ok(await card(page, "r1"), "review 알림이 남아 있음");
  assert.equal(await card(page, "p1"), null, "일반 info 알림은 4초 뒤 사라짐");
  assert.deepEqual(await page.evaluate(() => window.os.map((m) => m.id)), ["r1"]);
  assert.deepEqual(await page.evaluate(() => window.moved), [], "알림만으로는 이동하지 않음");
}));

test("그 탭으로는 그 탭으로만 가고 탭이 없으면 옮기지 않고 사유를 보인다", async () => fixture(async (page) => {
  // 접힌 목록은 최근 알림 하나만 그리므로 하나씩 띄움
  await page.evaluate(() => window.handle({ id: "live", level: "info", title: "살아 있는 탭", tab: "tab-live", review: true }));
  await page.click('[data-id="live"] .iris-notice-actions button');
  assert.deepEqual(await page.evaluate(() => window.moved), ["tab-live"]);
  assert.deepEqual((await card(page, "live")).buttons, [{ text: "그 탭에 있음", disabled: false }]);
  await page.evaluate(() => window.handle({ id: "gone", level: "info", title: "닫힌 탭", tab: "tab-gone", review: true }));
  await page.click('[data-id="gone"] .iris-notice-actions button');
  assert.deepEqual(await page.evaluate(() => window.moved), ["tab-live"], "다른 탭으로 보내지 않음");
  assert.deepEqual((await card(page, "gone")).buttons, [{ text: "탭이 닫혀 이동할 수 없음", disabled: true }]);
}));
