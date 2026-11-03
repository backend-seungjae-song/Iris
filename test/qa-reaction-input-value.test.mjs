// 입력 단계의 기대: 입력 칸·textarea 에 넣은 값을 appear·change 로 찾음(qa-6face637 K2 134·175)
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import puppeteer from "puppeteer-core";

const require = createRequire(import.meta.url);
const { headlessLaunchOptions } = require("../bin/headless-browser.cjs");
const { reactionWatch } = require("../native/electron/cdp-qa-reaction.cjs");

test("입력 칸과 textarea 에 넣은 값을 appear 글자와 role·name 대상의 글자로 읽는다", async () => {
  const browser = await puppeteer.launch(headlessLaunchOptions());
  try {
    const page = await browser.newPage();
    await page.setContent(`<div role="dialog"><label for="n">이름</label><input id="n"><textarea aria-label="메모"></textarea></div>`);
    await page.type("#n", "새 카테고리");
    await page.type("textarea", "메모 값");
    const effects = [
      { id: "a", type: "appear", text: "새 카테고리" },
      { id: "m", type: "appear", text: "메모 값" },
      { id: "c", type: "change", role: "textbox", name: "이름", to: "새 카테고리" },
      { id: "t", type: "change", role: "textbox", name: "메모", to: "메모 값" },
    ];
    const snapshot = await page.evaluate(`window.binding = () => {}; (${reactionWatch.toString()})(${JSON.stringify({ id: "w", effects, binding: "binding", deadline: 1e15 })})`);
    const byId = Object.fromEntries(snapshot.effects.map(effect => [effect.id, effect]));
    assert.equal(byId.a.found, true, "입력 칸 값을 appear 글자로 찾음");
    assert.equal(byId.m.found, true, "textarea 값을 appear 글자로 찾음");
    assert.equal(byId.c.text, "새 카테고리", "role·name 으로 찾은 입력 칸의 글자는 값");
    assert.equal(byId.t.text, "메모 값", "role·name 으로 찾은 textarea 의 글자는 값");
  } finally {
    await browser.close();
  }
});
