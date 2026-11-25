import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import puppeteer from "puppeteer-core";

import { WORKER_HANDLERS } from "../server/mcp-worker/command-routes.js";
import { createQaInputCommands } from "../server/mcp-worker/qa-input-commands.js";
import { createQaReactionCommands } from "../server/mcp-worker/qa-reaction-commands.js";

const require = createRequire(import.meta.url);
const { headlessLaunchOptions } = require("../bin/headless-browser.cjs");
const { pruneAxNodes } = require("../native/electron/ax-prune.cjs");
const registry = require("../native/electron/cdp-ref-registry.cjs");

const iframe = (html, x, y) => `<iframe style="position:absolute;left:${x}px;top:${y}px;width:500px;height:300px;border:3px solid"
  srcdoc="${html.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></iframe>`;
const pageHtml = `<button id="decoy" onclick="this.dataset.clicked='yes'">최상위 버튼</button>${iframe(
  `<button>바깥 iframe 버튼</button>${iframe(`
    <button id="search" onclick="this.dataset.clicked=event.isTrusted">조회</button>
    <div id="cell" style="width:100px;cursor:pointer" ondblclick="this.dataset.clicked=event.isTrusted; editor.hidden=false; editor.focus()">노출순서 셀</div>
    <input hidden id="editor" aria-label="노출순서" value="기존 값">
    <p><button id="label"><span aria-hidden="true" style="display:inline-block;width:80px">안쪽</span>바깥</button></p>
  `, 54, 32)}`, 133, 90)}`;

let browser;
let wcId = 0;

test.before(async () => {
  // 같은 CDP 세션의 프레임을 네트워크와 별도 렌더러 없이 실행
  browser = await puppeteer.launch({ ...headlessLaunchOptions(), pipe: true,
    args: ["--no-sandbox", "--single-process", "--disable-gpu"] });
});
test.after(() => browser?.close());

async function fixture(t) {
  const id = ++wcId;
  const page = await browser.newPage();
  t.after(async () => { registry.clear(id); await page.close(); });
  await page.setContent(pageHtml);
  const outer = page.mainFrame().childFrames()[0];
  const inner = outer.childFrames()[0];
  const cdp = await page.createCDPSession();
  const send = (method, params) => cdp.send(method, params);
  send.on = () => send;
  send.frames = () => [null];
  const done = (data) => ({ raw: { commandState: "completed" }, response: { ok: true, data } });
  let canSendKeys = true;
  const base = async (command, args) => {
    switch (command) {
      case "cdp.send": return done(await send(args.method, args.params));
      case "cdp.batch": return done({ results: await Promise.all(args.commands.map(({ method, params }) => send(method, params))) });
      case "ax.tree": return done({ nodes: pruneAxNodes((await send("Accessibility.getFullAXTree")).nodes) });
      case "ref.record": registry.recordSnapshot(id, new Map(args.refs)); return done({});
      case "ref.resolve": return done(registry.resolveRef(id, args.ref));
      case "cdp.frames": return done({ frames: [] });
      case "wc.info": return done({ url: page.url(), title: await page.title() });
      case "cdp.attach": case "viewport.ensureReady": case "ai.leave": return done({});
      case "ai.enter": return done({ ticket: "test" });
      case "focus.state": return done({ shown: true, canPress: true, canSendKeys });
      case "result.redact": return done({ value: args.value });
      default: throw new Error(`예상하지 않은 기본 명령 ${command}`);
    }
  };
  const run = async (command, args = {}) => {
    const result = await WORKER_HANDLERS[command]({ args, base, mainHasFeatures: async () => true });
    assert.equal(result.ok, true, result.error);
    return result.data;
  };
  return { id, page, inner, cdp, send, run, guardKeys: () => { canSendKeys = false; } };
}

function refFor(snapshot, role, name) {
  const ref = snapshot.split("\n").map((line) => line.trim()).find((line) => line.endsWith(`] ${role} "${name}"`))?.match(/^\[(@e\d+)\]/)?.[1];
  assert.ok(ref, `${role} "${name}"의 ref가 없습니다\n${snapshot}`);
  return ref;
}

async function center(frame, selector) {
  const element = await frame.$(selector);
  const { x, y, width, height } = await element.boundingBox();
  return { x: Math.round(x + width / 2), y: Math.round(y + height / 2) };
}

test("snapshot은 같은 출처 iframe 두 겹의 버튼과 입력칸에 ref를 매긴다", async (t) => {
  const { id, inner, run } = await fixture(t);
  await inner.$eval("#editor", (el) => { el.hidden = false; });
  const { snapshot } = await run("snapshot");
  assert.equal(refFor(snapshot, "button", "최상위 버튼"), "@e1");
  assert.equal(refFor(snapshot, "button", "바깥 iframe 버튼"), "@e2");
  const button = refFor(snapshot, "button", "조회");
  const input = refFor(snapshot, "text input", "노출순서");
  assert.notEqual(button, input);
  assert.equal(registry.resolveRef(id, button).sid, null);
  assert.equal(registry.resolveRef(id, input).sid, null);
  const narrowed = await run("snapshot", { name: "조회" });
  assert.equal(refFor(narrowed.snapshot, "button", "조회"), button);
});

test("iframe ref로 click·dblclick하고 열린 입력칸에 fill·type이 도달한다", async (t) => {
  const { page, inner, run, guardKeys } = await fixture(t);
  const { snapshot } = await run("snapshot");
  const clicked = await run("click", { ref: refFor(snapshot, "button", "조회") });
  assert.equal(clicked.via, "input");
  assert.deepEqual(clicked.at, await center(inner, "#search"));
  assert.equal(await inner.$eval("#search", (el) => el.dataset.clicked), "true");
  assert.equal(await page.$eval("#decoy", (el) => el.dataset.clicked), undefined);

  const doubled = await run("dblclick", { ref: refFor(snapshot, "clickable", "노출순서 셀") });
  assert.equal(doubled.via, "input");
  assert.deepEqual(doubled.at, await center(inner, "#cell"));
  assert.equal(await inner.$eval("#cell", (el) => el.dataset.clicked), "true");

  const input = refFor((await run("snapshot")).snapshot, "text input", "노출순서");
  await run("fill", { ref: input, text: "12" });
  assert.equal(await inner.$eval("#editor", (el) => el.value), "12");
  await run("type", { text: "3" });
  assert.equal(await inner.$eval("#editor", (el) => el.value), "123");
  guardKeys();
  await run("type", { text: "4" });
  assert.equal(await inner.$eval("#editor", (el) => el.value), "1234");
});

test("QA target resolve는 안쪽 iframe 버튼의 탭 좌표와 가림 여부를 반환한다", async (t) => {
  const { inner, page, send } = await fixture(t);
  const target = { role: "button", name: "조회" };
  const expected = await center(inner, "#search");
  const resolve = createQaReactionCommands()["qa-target-resolve"];
  const resolved = await resolve(send, {}, { target });
  assert.equal(resolved.found, true);
  assert.equal(resolved.occluded, false);
  assert.deepEqual({ x: Math.round(resolved.x), y: Math.round(resolved.y) }, expected);

  await page.evaluate(() => {
    document.body.insertAdjacentHTML("beforeend", '<div id="cover" style="position:absolute;inset:0">가림</div>');
  });
  const covered = await resolve(send, {}, { target });
  assert.equal(covered.found, true);
  assert.equal(covered.occluded, true);
  assert.equal(covered.blocker.sel, "#cover");
});

test("QA locate는 안쪽 iframe 버튼의 탭 좌표를 반환한다", async (t) => {
  const { inner, send } = await fixture(t);
  const target = { role: "button", name: "조회" };
  const expected = await center(inner, "#search");
  const located = await createQaInputCommands()["qa-locate"](send, {}, target);
  assert.deepEqual(located.at, expected);
  assert.equal(located.target.name, "조회");
});

test("QA 입력은 같은 출처 iframe에서 이름이 지정된 버튼의 자식까지 누른다", async (t) => {
  const { cdp, page, inner, send } = await fixture(t);
  await page.evaluate(() => document.body.insertAdjacentHTML("beforeend", "<button>바깥</button>"));
  const events = new Map();
  const wc = { debugger: {
    on(_event, listener) {
      const handler = (params) => listener(null, "Runtime.bindingCalled", params);
      events.set(listener, handler);
      cdp.on("Runtime.bindingCalled", handler);
    },
    removeListener(_event, listener) { cdp.off("Runtime.bindingCalled", events.get(listener)); },
  } };
  const input = createQaInputCommands()["qa-input"];
  const result = await input(send, wc, { action: "click", ...await center(inner, "#label span"),
    expectedTarget: { role: "button", name: "바깥" } });
  assert.equal(result.trusted, true);
  assert.ok(result.received.some((event) => event.type === "click" && event.trusted));
});
