// 창 밖에 있는 웹 대상은 "찾을 수 없음"이 아니라 방향을 알려 스크롤 단계를 넣게 함(C3 정상 '컴포즈 빼기' 사례)
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { playQaSteps } from "../server/qa-play.js";
const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");
const { headlessLaunchOptions } = require("../bin/headless-browser.cjs");
const { createQaReactionCommands } = require("../native/electron/cdp-qa-reaction.cjs");

test("창 밖 대상은 방향과 함께 못 찾음으로 돌려주고, nth 는 창 밖 요소까지 qa_snapshot 순서로 센다", async t => {
  const browser = await puppeteer.launch(headlessLaunchOptions());
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setViewport({ width: 400, height: 300 });
  await page.setContent(`<body style="margin:0"><button style="height:40px">빼기</button><div style="height:1000px"></div><button style="height:40px">컴포즈 빼기</button><button style="height:40px">빼기</button></body>`);
  const cdp = await page.target().createCDPSession();
  const send = (method, params) => cdp.send(method, params);
  send.on = () => send;
  const resolve = createQaReactionCommands({ observation: { subscribeEvents() {} }, screenshot: async () => ({}) })["qa-target-resolve"];
  const below = await resolve(send, {}, { target: { role: "button", name: "컴포즈 빼기" } });
  assert.equal(below.found, false);
  assert.equal(below.offscreen, "아래");
  const second = await resolve(send, {}, { target: { role: "button", name: "빼기", nth: 2 } });
  assert.equal(second.offscreen, "아래");
  const first = await resolve(send, {}, { target: { role: "button", name: "빼기", nth: 1 } });
  assert.equal(first.found, true);
  assert.equal((await resolve(send, {}, { target: { role: "button", name: "빼기" } })).found, true);
  assert.equal((await resolve(send, {}, { target: { role: "button", name: "없음" } })).offscreen, undefined);
});

test("창 밖 대상 단계는 제품 실패가 아니라 막힘으로 멈추고 스크롤 단계를 안내한다", async () => {
  const results = await playQaSteps({ steps: [{ action: "click", target: { text: "컴포즈 빼기" }, expect: { effects: [] } }],
    resolve: async () => ({ found: false, offscreen: "아래" }), input: async () => { throw Error("입력하면 안 됨"); },
    record: async () => {}, capture: async () => ({}), close: async () => {} });
  const last = results.steps.at(-1);
  assert.equal(last.blocked, true);
  assert.match(last.reason, /창 아래.*scroll/);
});

test("scroll 단계의 대상이 창 밖이면 그 대상에 scroll 을 다시 걸라고 하지 않고 창 안 요소를 대상으로 삼으라고 안내한다", async () => {
  // qa-6face637 C5: 안내대로 창 밖 대상에 scroll 을 걸자 그 scroll 단계도 같은 막힘으로 멈춤
  const results = await playQaSteps({ steps: [{ action: "scroll", target: { text: "배스킨라빈스" }, deltaY: 4600, expect: { effects: [] } }],
    resolve: async () => ({ found: false, offscreen: "위" }), input: async () => { throw Error("입력하면 안 됨"); },
    record: async () => {}, capture: async () => ({}), close: async () => {} });
  const last = results.steps.at(-1);
  assert.equal(last.blocked, true);
  assert.match(last.reason, /창 안에 보이는 요소/);
  assert.match(last.reason, /음수/);
  assert.doesNotMatch(last.reason, /앞에 scroll 단계를 넣어/);
});
