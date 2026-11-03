import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import puppeteer from "puppeteer-core";

const require = createRequire(import.meta.url);
const { headlessLaunchOptions } = require("../bin/headless-browser.cjs");
const { dispatchKey } = require("../native/electron/cdp-qa-keys.cjs");

// 사람이 누른 것처럼 폼 제출·줄바꿈·버튼 누름이 일어나야 함. Enter 를 글자 없이 보내 2차 인증 폼이 제출되지 않던 사례
const PAGE = `<form onsubmit="event.preventDefault();window.submitted=(window.submitted||0)+1"><input id=code><button type=submit>인증</button></form>
<textarea id=memo></textarea><button id=act onclick="window.clicked=(window.clicked||0)+1">눌러</button>`;

test("QA Enter 는 폼을 제출하고 textarea 에서는 줄을 바꾸며, Space 는 버튼을 누른다", async () => {
  const browser = await puppeteer.launch(headlessLaunchOptions());
  try {
    const page = await browser.newPage();
    await page.setContent(PAGE);
    const client = await page.createCDPSession();
    const send = (method, params) => client.send(method, params);
    await page.focus("#code");
    await dispatchKey(send, "Enter");
    assert.equal(await page.evaluate(() => window.submitted || 0), 1, "입력 칸 Enter 로 폼 제출");
    await page.focus("#memo");
    await page.keyboard.type("가");
    await dispatchKey(send, "Enter");
    assert.equal(await page.evaluate(() => document.querySelector("#memo").value), "가\n", "textarea Enter 는 줄바꿈");
    await page.focus("#act");
    await dispatchKey(send, "Space");
    assert.equal(await page.evaluate(() => window.clicked || 0), 1, "버튼 Space 로 누름");
  } finally {
    await browser.close();
  }
});
