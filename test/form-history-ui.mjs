import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { build } from "esbuild";
import puppeteer from "puppeteer-core";
import { CAPABILITIES } from "../web/js/core/capabilities.js";
import { bootCapabilities } from "../web/js/core/capability-boot.js";
import { clearHooks, hasHook } from "../web/js/core/hooks.js";

const require = createRequire(import.meta.url);
const { headlessLaunchOptions } = require("../bin/headless-browser.cjs");
const file = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");

async function withPage(run) {
  const browser = await puppeteer.launch(headlessLaunchOptions());
  try { await run(await browser.newPage()); }
  finally { await browser.close(); }
}

function loadGuest(source) {
  window.sent = [];
  window.receivers = {};
  Function("require", source)(() => ({ ipcRenderer: {
    sendToHost: (...args) => sent.push(args),
    on: (channel, receive) => { receivers[channel] = (payload) => receive({}, payload); },
  } }));
}

async function withGuestPage(html, run) {
  await withPage(async (page) => {
    await page.setRequestInterception(true);
    page.on("request", (request) => void request.respond({ contentType: "text/html", body: html }));
    await page.goto("https://form.test");
    await page.evaluate(loadGuest, file("../native/electron/form-history-preload.cjs"));
    await run(page);
  });
}

const submissions = (page) => page.evaluate(() =>
  sent.filter(([channel]) => channel === "ac-fh-submit").map(([, payload]) => payload.entries));

test("신뢰 제출과 클릭을 한 번 수집하고 민감하거나 제출 대상이 아닌 입력은 제외한다", async () => {
  const source = file("../native/electron/form-history-preload.cjs");
  await withPage(async (page) => {
    await page.setRequestInterception(true);
    page.on("request", (request) => void request.respond({ contentType: "text/html; charset=utf-8", body: `
      <style>input { width: 40px }</style>
      <form id="form">
        <input name=" City ">
        <input id="Fallback" type="email">
        <input value="unnamed"><input name="memo" value=""><input name="toolong" value="${"x".repeat(201)}">
        <input name="p" type="password" value="example"><input name="h" type="hidden" value="example">
        <input name="disabled" disabled value="example"><input name="readonly" readonly value="example">
        <input name="invisible" style="visibility:hidden" value="example">
        <span style="opacity:0"><input name="opaque" value="example"></span>
        <input name="off" autocomplete="OFF" value="example">
        ${["one-time-code", "cc-exp", "new-password", "current-password"].map((token, i) =>
          `<input name="other${i}" autocomplete="section-test ${token}" value="example">`).join("")}
        ${["card", "cc-num", "cvc", "cvv", "otp", "pin", "ssn", "passwd", "password", "secret", "token", "주민"].map((name) =>
          `<input name="safe" id="prefix-${name}-suffix" value="example">`).join("")}
        <input name="digits">
        <input name="not-card-number" id="prefix-forbidden-card" value="example">
        <input name="telephone" type="tel">
        <textarea name="text">example</textarea><select name="select"><option>example</option></select>
        <div contenteditable name="content">example</div>
        <button id="submit">제출</button>
      </form>
      <form autocomplete="off"><input name="another" value="example"><button id="off">제출</button></form>
      <input name="query" id="outside" type="search">
    ` }));
    await page.goto("https://form.test");
    await page.evaluate(loadGuest, source);
    await page.evaluate(() => {
      document.addEventListener("submit", (event) => event.preventDefault());
      document.addEventListener("click", (event) => { if (!event.isTrusted) event.preventDefault(); });
      document.querySelector("#form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      document.querySelector("#submit").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    assert.deepEqual(await page.evaluate(() => sent.filter(([channel]) => channel === "ac-fh-submit")), []);
    for (const [selector, value] of [
      ['[name=" City "]', "Seoul"], ["#Fallback", "someone@example.test"],
      ['[name="telephone"]', "4111-1111 1111-1112"], ['[name="digits"]', "4111-1111 1111-1111"],
      ['[name="toolong"]', "x"], ['[name="another"]', "x"], ["#outside", "Iris"],
    ]) await page.type(selector, value);
    for (const field of await page.$$('[name="safe"], [autocomplete][name], [name="opaque"]')) {
      await field.type("x");
    }
    await page.click("#submit");
    await page.click("#submit");
    await page.click("#off");
    await page.focus("#outside");
    await page.keyboard.press("Enter");
    const form = [
      { key: "city", value: "Seoul" },
      { key: "fallback", value: "someone@example.test" },
      { key: "telephone", value: "4111-1111 1111-1112" },
    ];
    assert.deepEqual(await submissions(page), [form, form, [{ key: "query", value: "Iris" }]]);
  });
});

test("선택한 추천이 없으면 Enter가 페이지의 폼을 제출한다", async () => {
  await withGuestPage('<form><input name="city" value="S"></form>', async (page) => {
    await page.evaluate(() => {
      window.submitted = 0;
      document.addEventListener("submit", (event) => { event.preventDefault(); submitted++; });
    });
    await page.focus("input");
    const fieldId = await page.evaluate(() => sent.find(([channel]) => channel === "ac-fh-field")[1].fieldId);
    await page.evaluate((fieldId) => receivers["ac-fh-state"]({ fieldId, open: true, selected: false }), fieldId);
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => submitted), 1);
    assert.equal(await page.evaluate(() => sent.some(([channel]) => channel === "ac-fh-key")), false);
    await page.evaluate((fieldId) => receivers["ac-fh-state"]({ fieldId, open: true, selected: true }), fieldId);
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => submitted), 1);
    assert.deepEqual(await page.evaluate(() => sent.at(-1)), ["ac-fh-key", { fieldId, key: "Enter" }]);
  });
});

test("사람이 신뢰 input으로 편집한 칸만 제출 기록에 넣는다", async () => {
  await withGuestPage(`<form>
    <input name="prefilled" value="page value"><input name="synthetic"><input name="city">
    <button>Submit</button></form><input name="outside" value="page value">`, async (page) => {
    await page.evaluate(() => {
      document.addEventListener("submit", (event) => event.preventDefault());
      const input = document.querySelector('[name="synthetic"]');
      input.value = "script value";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.type('[name="city"]', "Seoul");
    await page.click("button");
    await page.focus('[name="outside"]');
    await page.keyboard.press("Enter");
    assert.deepEqual(await submissions(page), [[{ key: "city", value: "Seoul" }]]);
  });
});

test("비밀번호였거나 편집 중 자동완성이 금지된 칸은 속성이 바뀌어도 제출 기록에서 제외한다", async () => {
  await withGuestPage(`<form><input name="masked" type="password"><input name="brief">
    <input name="toggle" autocomplete="one-time-code"><input name="formoff"><input name="city">
    <button>Submit</button></form>`, async (page) => {
    await page.evaluate(() => {
      document.addEventListener("submit", (event) => event.preventDefault());
      document.querySelector('[name="masked"]').type = "text";
      const brief = document.querySelector('[name="brief"]');
      brief.type = "password";
      brief.type = "text";
    });
    await page.type('[name="masked"]', "first");
    await page.type('[name="brief"]', "second");
    await page.type('[name="toggle"]', "third");
    await page.$eval("form", (form) => { form.autocomplete = "off"; });
    await page.type('[name="formoff"]', "fourth");
    await page.evaluate(() => {
      document.querySelector('[name="toggle"]').removeAttribute("autocomplete");
      document.querySelector("form").removeAttribute("autocomplete");
    });
    await page.type('[name="toggle"]', " again");
    await page.type('[name="formoff"]', " again");
    await page.type('[name="city"]', "Seoul");
    await page.click("button");
    assert.deepEqual(await submissions(page), [[{ key: "city", value: "Seoul" }]]);
  });
});

test("게스트는 한 번에 편집한 항목을 50개까지만 보낸다", async () => {
  const fields = Array.from({ length: 51 }, (_, i) => `<input name="field-${i + 1}">`).join("");
  await withGuestPage(`<form>${fields}<button>Submit</button></form>`, async (page) => {
    await page.evaluate(() => document.addEventListener("submit", (event) => event.preventDefault()));
    for (let i = 1; i <= 51; i++) await page.type(`[name="field-${i}"]`, "x");
    await page.click("button");
    assert.deepEqual(await submissions(page), [Array.from({ length: 50 }, (_, i) => ({ key: `field-${i + 1}`, value: "x" }))]);
  });
});

test("같은 출처 프레임의 좌표와 대상 요청만 쓰고 교차 출처에서는 추천을 요청하지 않는다", async () => {
  const source = file("../native/electron/form-history-preload.cjs");
  await withPage(async (page) => {
    await page.setRequestInterception(true);
    page.on("request", (req) => void req.respond({ contentType: "text/html", body: new URL(req.url()).pathname === "/"
      ? '<iframe id="same" src="/child" style="position:absolute;top:90px;left:30px;border:2px solid"></iframe><iframe src="https://other.test/child"></iframe>'
      : '<input name="city" style="margin:0" value="S">' }));
    await page.goto("https://form.test/");
    const same = page.frames().find((frame) => frame.url() === "https://form.test/child");
    const other = page.frames().find((frame) => frame.url() === "https://other.test/child");
    await same.evaluate(loadGuest, source);
    await other.evaluate(loadGuest, source);
    await other.focus("input");
    assert.equal(await other.evaluate(() => sent.some(([channel]) => channel === "ac-fh-field")), false);

    await same.focus("input");
    const field = await same.evaluate(() => sent.find(([channel]) => channel === "ac-fh-field")[1]);
    assert.equal(field.key, "city");
    assert.equal(field.prefix, "S");
    const client = await same.$eval("input", (el) => ({ left: el.getBoundingClientRect().left, top: el.getBoundingClientRect().top }));
    assert.equal(field.rect.left, client.left + 32);
    assert.equal(field.rect.top, client.top + 92);

    await same.evaluate(({ fieldId }) => {
      window.keys = [];
      window.changes = [];
      const input = document.querySelector("input");
      input.addEventListener("keydown", (event) => keys.push([event.key, event.defaultPrevented]));
      for (const type of ["input", "change"]) input.addEventListener(type, () => changes.push(type));
      receivers["ac-fh-fill"]({ fieldId: "different-frame:1", value: "wrong" });
      receivers["ac-fh-state"]({ fieldId, open: true });
    }, field);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.down("Shift");
    await page.keyboard.press("Delete");
    await page.keyboard.up("Shift");
    assert.deepEqual(await same.evaluate(() => keys), [["ArrowDown", true], ["Shift", false], ["Delete", true]]);
    assert.equal(await same.$eval("input", (el) => el.value), "S");
    await same.evaluate(({ fieldId }) => receivers["ac-fh-fill"]({ fieldId, value: "Seoul" }), field);
    assert.equal(await same.$eval("input", (el) => el.value), "Seoul");
    assert.deepEqual(await same.evaluate(() => changes), ["input", "change"]);
    await same.$eval("input", (el) => el.blur());
    assert.equal(await same.evaluate(() => sent.at(-1)[0]), "ac-fh-hide");
  });
});

test("끄면 렌더러 기능이 로드되지 않고 작업 창과 분리 창에 기본 등록된다", async (t) => {
  clearHooks();
  t.after(clearHooks);
  const item = CAPABILITIES.find(({ id }) => id === "formhistory");
  assert.ok(item);
  assert.deepEqual(item.windows, ["main", "browser"]);
  assert.equal(item.native, true);
  assert.equal(item.optIn, undefined);
  const load = t.mock.method(item, "load");
  assert.deepEqual(await bootCapabilities({ items: [item], isOn: () => false }), []);
  assert.equal(load.mock.callCount(), 0);
  assert.equal(hasHook("formhistory.guest"), false);
});

test("호스트에서만 목록을 표시하고 선택값 하나만 해당 프레임으로 보낸다", async () => {
  const code = await build({
    stdin: { contents: 'export { initCapability } from "./web/js/browser/form-history.js"; export { callHook } from "./web/js/core/hooks.js"; export { setAiBusyTabs } from "./web/js/browser/ai-state.js";',
      resolveDir: process.cwd() },
    bundle: true, write: false, format: "iife", globalName: "FormHistory",
  });
  await withPage(async (page) => {
    await page.setContent('<div id="guest" class="active" style="position:absolute;inset:10px; width:600px;height:400px"></div>');
    await page.addStyleTag({ content: file("../web/css/00-tokens.css") + file("../web/css/45-form-history.css") });
    await page.addScriptTag({ content: code.outputFiles[0].text });
    await page.evaluate(() => {
      window.sent = [];
      window.saved = [];
      window.deleted = [];
      window.queries = [];
      window.acHost = {
        formHistoryQuery: (...args) => { queries.push(args); return Promise.resolve(["<first>", "second"]); },
        formHistoryAdd: (...args) => saved.push(args),
        formHistoryRemove: (...args) => { deleted.push(args); return Promise.resolve(true); },
      };
      const el = document.querySelector("#guest");
      el.getWebContentsId = () => 42;
      el.getZoomFactor = () => 2;
      el.sendToFrame = (...args) => { sent.push(args); return Promise.resolve(); };
      const context = { tabId: "tab", partition: "persist:acbrowser", el, frameId: [30, 40] };
      window.field = { fieldId: "frame:1", key: "city", prefix: "", rect: { left: 15, top: 18, width: 75, height: 22 } };
      FormHistory.initCapability();
      window.guest = (channel, payload, opts = {}) => FormHistory.callHook("formhistory.guest", channel, payload, { ...context, ...opts });
    });

    await page.evaluate(async () => {
      await guest("ac-fh-submit", { entries: [{ key: "city", value: "ignore" }] }, { blocked: true });
      await guest("ac-fh-field", field, { blocked: true });
    });
    assert.equal(await page.evaluate(() => saved.length + queries.length), 0);
    assert.equal(await page.$('[role="listbox"]:not([hidden])'), null);

    await page.evaluate(() => guest("ac-fh-field", field));
    const options = () => page.$$eval('[role="option"]', (items) => items.map((item) => item.textContent));
    assert.deepEqual(await options(), ["<first>", "second"]);
    assert.deepEqual(await page.$eval('[role="listbox"]', (el) => [el.style.left, el.style.top]), ["40px", "90px"]);
    const key = (key, frameId) => page.evaluate(({ key, frameId }) =>
      guest("ac-fh-key", { fieldId: field.fieldId, key }, frameId ? { frameId } : {}), { key, frameId });
    await key("Enter");
    assert.deepEqual(await page.evaluate(() => sent),
      [[[30, 40], "ac-fh-state", { fieldId: "frame:1", open: true, selected: false }]]);
    assert.deepEqual(await page.evaluate(() => queries), [["persist:acbrowser", "city", "", 42]]);
    await page.evaluate(() => guest("ac-fh-submit", { entries: [{ key: "city", value: "Seoul" }] }));
    assert.deepEqual(await page.evaluate(() => saved), [["persist:acbrowser", [{ key: "city", value: "Seoul" }], 42]]);
    await key("ArrowDown", [30, 41]);
    assert.equal(await page.$('[aria-selected="true"]'), null);
    await key("ArrowDown");
    assert.deepEqual(await page.evaluate(() => sent.at(-1)),
      [[30, 40], "ac-fh-state", { fieldId: "frame:1", open: true, selected: true }]);
    await key("Shift+Delete");
    assert.deepEqual(await options(), ["second"]);
    assert.equal(await page.$('[aria-selected="true"]'), null);
    assert.equal(await page.evaluate(() => sent.at(-1)[2].selected), false);
    assert.deepEqual(await page.evaluate(() => deleted), [["persist:acbrowser", "city", "<first>"]]);
    await key("ArrowDown");
    await key("Enter");
    assert.equal(await page.$('[role="listbox"]:not([hidden])'), null);
    const selected = await page.evaluate(() => sent.filter(([, channel]) => channel === "ac-fh-fill"));
    assert.deepEqual(selected, [[[30, 40], "ac-fh-fill", { fieldId: "frame:1", value: "second" }]]);

    await page.evaluate(() => guest("ac-fh-field", { ...field, fieldId: "frame:2" }));
    await page.click('[role="option"]');
    assert.deepEqual(await page.evaluate(() => sent.filter(([, channel]) => channel === "ac-fh-fill").at(-1)),
      [[30, 40], "ac-fh-fill", { fieldId: "frame:2", value: "<first>" }]);

    await page.evaluate(async () => {
      let deliver;
      acHost.formHistoryQuery = () => new Promise((resolve) => { deliver = resolve; });
      const pending = guest("ac-fh-field", { ...field, fieldId: "frame:3" });
      FormHistory.setAiBusyTabs(new Map([["tab", []]]));
      deliver(["delayed"]);
      await pending;
    });
    assert.equal(await page.$('[role="listbox"]:not([hidden])'), null);
  });
});
