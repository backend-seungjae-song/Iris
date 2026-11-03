// 닫히는 대화상자가 body 의 포인터 입력을 막는 동안 누른 클릭이 html 에 들어감(qa-6face637 결함 1224)
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import puppeteer from "puppeteer-core";
import { playQaSteps } from "../server/qa-play.js";

const require = createRequire(import.meta.url);
const { headlessLaunchOptions } = require("../bin/headless-browser.cjs");
const { createQaReactionCommands } = require("../native/electron/cdp-qa-reaction.cjs");

test("body 가 포인터 입력을 막으면 대상을 아직 누를 수 없음으로 알리고, 버튼 안 글자의 pointer-events:none 은 누를 수 있음으로 둔다", async t => {
  const browser = await puppeteer.launch(headlessLaunchOptions());
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<button id=del>삭제</button><button id=add><span style="pointer-events:none">추가</span></button>`);
  const cdp = await page.target().createCDPSession();
  const send = (method, params) => cdp.send(method, params);
  const resolve = createQaReactionCommands({ observation: { subscribeEvents() {} }, screenshot: async () => ({}) })["qa-target-resolve"];
  const button = { role: "button", name: "삭제" };
  assert.equal((await resolve(send, {}, { target: button })).inert, false);
  assert.equal((await resolve(send, {}, { target: { text: "추가" } })).inert, false);
  await page.evaluate(() => { document.body.style.pointerEvents = "none"; });
  const blocked = await resolve(send, {}, { target: button });
  assert.equal(blocked.found, true);
  assert.equal(blocked.occluded, false);
  assert.equal(blocked.inert, true);
});

test("누를 수 없는 대상은 풀릴 때까지 기다렸다 누르고, 끝까지 풀리지 않으면 누르지 않고 막힘으로 멈춘다", async () => {
  let clock = 0, inertLeft = 3;
  const inputs = [];
  const step = { action: "click", target: { role: "button", name: "삭제" }, expect: { effects: [] } };
  const base = { record: async () => {}, capture: async () => ({}), close: async () => {}, now: () => clock, wait: async ms => { clock += ms; } };
  const passed = await playQaSteps({ ...base, steps: [step], input: async (s, location) => { inputs.push(location); return { pass: true }; },
    resolve: async () => ({ found: true, occluded: false, inert: inertLeft-- > 0 }) });
  assert.equal(passed.pass, true);
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].inert, false, "풀린 뒤에 누름");
  clock = 0;
  const stuck = await playQaSteps({ ...base, steps: [step], input: async () => { throw Error("누르면 안 됨"); },
    resolve: async () => ({ found: true, occluded: false, inert: true }) });
  assert.equal(stuck.steps[0].status, "막힘");
  assert.match(stuck.steps[0].reason, /pointer-events/);
});
