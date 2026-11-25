// 뒤에 깐 AI 탭이 실제 CSS·pane-view.js 배치에서 사용자가 열었을 때의 칸과 같은 상자를 갖는지 headless 브라우저로 잰다.
import assert from "node:assert/strict";
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import puppeteer from "puppeteer-core";

const require = createRequire(import.meta.url);
const { headlessLaunchOptions } = require("../bin/headless-browser.cjs");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" };

const PAGE = `<!doctype html><meta charset=utf-8>
${["00-tokens", "01-base", "03-feature-modes", "11-center-tabs", "17-editor-bar", "18-browser", "43-center-split"].map((n) => `<link rel=stylesheet href="/web/css/${n}.css">`).join("")}
<style>html,body{margin:0;width:100%;height:100%}#center{position:absolute;left:300px;top:20px;width:900px;height:700px;display:flex;flex-direction:column}</style>
<section class="center" id="center"><div class="tabbar-row" id="tabbar-row" style="height:36px"><div class="tabstrip" id="tabstrip"></div></div>
<div class="center-body" id="center-body"><div class="browserview" id="browserview" hidden><div class="urlbar" style="height:36px;flex:none"></div><div class="bookmark-line" style="height:28px;flex:none"></div>
<div class="wv-wrap" id="wv-stack"></div></div></div></section>
<script type="module">
import { initPaneView, syncPaneView, schedulePaneLayout } from "/web/js/center/pane-view.js";
import { setCenterSpace } from "/web/js/center/tab-store.js";
import { paneSplit, paneRatio, paneFocus, paneLayout } from "/web/js/center/pane-store.js";
window.api = { syncPaneView, schedulePaneLayout, setCenterSpace, paneSplit, paneRatio, paneFocus, paneLayout };
initPaneView({ tabstrip: document.getElementById("tabstrip"), browserview: document.getElementById("browserview"), onFocus() {}, onTransfer() {} });
window.ready = true;
</script>`;

let server, browser, base;
before(async () => {
  server = createServer((req, res) => {
    const file = path.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (req.url === "/" ) { res.setHeader("content-type", "text/html"); res.end(PAGE); return; }
    try { statSync(file); } catch { res.statusCode = 404; res.end(); return; }
    res.setHeader("content-type", TYPES[path.extname(file)] || "application/octet-stream");
    createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await puppeteer.launch({ ...headlessLaunchOptions(), args: ["--no-sandbox"] });
});
after(async () => { await browser?.close(); await new Promise((r) => server?.close(r)); });

async function open(viewport = { width: 1400, height: 800 }) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  await page.goto(base);
  await page.waitForFunction("window.ready === true");
  return page;
}
const frames = (page, n = 3) => page.evaluate((count) => new Promise((resolve) => {
  const step = (k) => (k ? requestAnimationFrame(() => step(k - 1)) : resolve());
  step(count);
}), n);
// 비활성 AI 탭 한 개를 뒤에 깔고 브라우저 칸은 숨긴 상태로 시작
async function setup(page, { active = false } = {}) {
  await page.evaluate((withActive) => {
    const stack = document.getElementById("wv-stack");
    for (const [id, cls] of [["A", withActive ? "active" : ""], ["B", "ai-behind"]]) {
      const w = document.createElement("webview");
      w.dataset.tab = id; w.id = id; if (cls) w.className = cls;
      stack.appendChild(w);
    }
    stack.classList.add("ai-keep");
    window.api.schedulePaneLayout();
  }, active);
  await frames(page);
}
const box = (page, id) => page.evaluate((i) => { const r = document.getElementById(i).getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), l: Math.round(r.left), t: Math.round(r.top) }; }, id);
// 같은 칸을 사용자가 열었을 때(브라우저 보임)의 칸 크기
const openedSlot = (page, pane) => page.evaluate((p) => {
  const b = document.getElementById("browserview"); b.dataset.pane = String(p); b.hidden = false;
  const r = document.querySelector(".center-browser-slot").getBoundingClientRect();
  b.hidden = true; return { w: Math.round(r.width), h: Math.round(r.height) };
}, pane);

test("중앙 영역이 접힌 채 시작하면 창 전체로 깔지 않고 0 크기로 둬 깔기를 포기하게 함", async () => {
  const page = await open();
  await page.evaluate(() => document.body.classList.add("util-full"));
  await setup(page);
  const b = await box(page, "B");
  assert.deepEqual([b.w, b.h], [0, 0], `접힌 시작에서 창 크기(1400×800)로 깔리면 사용자가 연 칸과 크기가 다름: ${JSON.stringify(b)}`);
  await page.close();
});

test("접히기 전에 잰 칸 크기는 같은 창 크기에서만 유지하고 창 크기가 바뀌면 버림", async () => {
  const page = await open();
  await setup(page);
  const open1 = await openedSlot(page, 0);
  const b1 = await box(page, "B");
  assert.deepEqual([b1.w, b1.h], [open1.w, open1.h], "접히기 전: 사용자가 열었을 때의 칸과 같은 크기");
  await page.evaluate(() => { document.body.classList.add("util-full"); window.api.schedulePaneLayout(); });
  await frames(page);
  const folded = await box(page, "B");
  assert.deepEqual([folded.w, folded.h], [open1.w, open1.h], "같은 창 크기에서 접히면 마지막 값 유지");
  await page.setViewport({ width: 1100, height: 700 });
  await frames(page);
  const resized = await box(page, "B");
  assert.deepEqual([resized.w, resized.h], [0, 0], "접힌 채 창 크기가 바뀌면 낡은 값을 쓰지 않음");
  await page.close();
});

test("크기를 지정한 탭 옆에서 뒤에 깐 탭은 앞 탭과 같은 상자라 남는 공간에 비치지 않음", async () => {
  const page = await open();
  await page.evaluate(() => { const b = document.getElementById("browserview"); b.hidden = false; });
  await setup(page, { active: true });
  await page.evaluate(() => {
    const s = document.getElementById("wv-stack");
    s.classList.add("sized");
    for (const [k, v] of Object.entries({ "--vleft": "40px", "--vtop": "30px", "--vw": "375px", "--vh": "500px" })) s.style.setProperty(k, v);
  });
  await frames(page);
  const a = await box(page, "A"), b = await box(page, "B");
  assert.deepEqual([a.w, a.h], [375, 500], "앞 탭은 지정 크기");
  assert.deepEqual(b, a, `뒤 탭이 지정 크기와 다르면 남는 공간에 비치고 열었을 때 크기가 바뀜: ${JSON.stringify(b)}`);
  await page.close();
});

test("숨은 칸의 크기는 포커스 칸이 아니라 AI 탭이 속한 칸으로 잼", async () => {
  const page = await open();
  await page.evaluate(() => {
    const { setCenterSpace, paneSplit, paneRatio, paneFocus } = window.api;
    setCenterSpace("s");
    const tabs = [{ id: "f1", kind: "file" }, { id: "A", kind: "browser" }, { id: "B", kind: "browser" }];
    paneSplit("s", tabs, "B");        // B 는 오른쪽 칸(1), 포커스는 1
    paneRatio("s", 0.3);              // 왼쪽 30% · 오른쪽 70%
    paneFocus("s", 0);                // 사용자는 왼쪽 칸을 보는 중
    window.api.syncPaneView();
  });
  await setup(page);
  const right = await openedSlot(page, 1), left = await openedSlot(page, 0);
  assert.notEqual(right.w, left.w, "두 칸 크기가 달라야 이 시험이 구별함");
  const b = await box(page, "B");
  assert.deepEqual([b.w, b.h], [right.w, right.h], `B 는 오른쪽 칸 크기여야 함(왼쪽 ${left.w}): ${JSON.stringify(b)}`);
  await page.close();
});

test("뒤에 깐 AI 탭의 포커스·포인터 신호는 가운데 칸 선택을 바꾸지 않고 앞에 올린 탭의 신호는 바꿈", async () => {
  const page = await open();
  await page.evaluate(() => {
    const { setCenterSpace, paneSplit, paneFocus } = window.api;
    setCenterSpace("s");
    paneSplit("s", [{ id: "f1", kind: "file" }, { id: "A", kind: "browser" }, { id: "B", kind: "browser" }], "B");   // B 는 칸 1
    paneFocus("s", 0);
    window.api.syncPaneView();
  });
  await setup(page);
  const focusOf = () => page.evaluate(() => window.api.paneLayout("s").focus);
  const fire = (events) => page.evaluate((list) => {
    const b = document.getElementById("B");
    for (const [kind, name] of list) {
      if (kind === "focusin") b.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      else if (kind === "focus") b.dispatchEvent(new Event("focus"));
      else { const e = new Event("ipc-message"); e.channel = name; b.dispatchEvent(e); }
    }
  }, events);
  const signals = [["focusin"], ["focus"], ["ipc", "ac-guest-pointerdown"]];
  await fire(signals); await frames(page);
  assert.equal(await focusOf(), 0, "뒤에 깐 탭의 신호(AI 조작이 만든 것)는 칸 선택을 옮기지 않음");
  await page.evaluate(() => document.getElementById("B").classList.remove("ai-behind"));
  await fire([["focus"]]); await frames(page);
  assert.equal(await focusOf(), 1, "사용자가 앞으로 올린 탭의 신호는 칸 선택을 따라 옮김");
  await page.close();
});

// 렌더러 판정(syncAiBehindPlacement)을 실제 모듈로 실행. 메인으로 가는 알림만 가짜 acHost 로 받음
async function mountRenderer(page, protectUntil) {
  await page.evaluate(async (until) => {
    const ai = await import("/web/js/browser/ai-state.js");
    const store = await import("/web/js/browser/webview-store.js");
    const wv = await import("/web/js/browser/webview.js");
    window.calls = [];
    window.acHost = { tabsBehind: (list) => window.calls.push(list), setWebviewThrottleState() {} };
    const b = document.getElementById("B");
    b.getWebContentsId = () => 42;
    store.registerWebview("B", { el: b, ready: true });
    ai.setAiTargets([]);
    ai.setAiRecentUse([{ tabId: "B", until }]);
    window.wv = wv;
  }, protectUntil);
}

test("크기 0 이라 깔기를 포기한 탭은 칸이 실제 크기를 얻으면 다시 판정해 메인에 알림", async () => {
  const page = await open();
  await page.evaluate(() => document.body.classList.add("util-full"));
  await setup(page);
  await mountRenderer(page, Date.now() + 60000);
  await page.evaluate(() => window.wv.syncAiBehindPlacement());
  assert.equal(await page.evaluate(() => document.getElementById("B").classList.contains("ai-behind")), false, "0 크기면 깔지 않음");
  assert.equal(await page.evaluate(() => document.getElementById("wv-stack").classList.contains("ai-keep")), false, "0 크기면 ai-keep도 제거");
  assert.deepEqual(await page.evaluate(() => window.calls), [], "깔리지 않았으니 메인에 알리지 않음");
  await page.evaluate(() => { document.body.classList.remove("util-full"); window.api.schedulePaneLayout(); });
  await frames(page, 5);
  assert.equal(await page.evaluate(() => document.getElementById("B").classList.contains("ai-behind")), true, "칸이 펼쳐지면 다시 깖");
  assert.equal(await page.evaluate(() => document.getElementById("wv-stack").classList.contains("ai-keep")), true, "공간 복구 뒤 ai-keep을 다시 붙임");
  assert.deepEqual(await page.evaluate(() => window.calls), [[42]], "다시 판정한 결과를 메인에 알림");
  await page.close();
});

test("AI 사용 보호가 끝나는 시각에 다시 판정해 뒤에 깐 탭을 거둠", async () => {
  const page = await open();
  await setup(page);
  await mountRenderer(page, Date.now() + 300);
  await page.evaluate(() => window.wv.syncAiBehindPlacement());
  assert.deepEqual(await page.evaluate(() => window.calls), [[42]], "보호 중에는 깔림");
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(await page.evaluate(() => document.getElementById("B").classList.contains("ai-behind")), false, "다른 이벤트가 없어도 만료 시각에 거둠");
  assert.deepEqual(await page.evaluate(() => window.calls.at(-1)), [], "거둔 목록을 메인에 알려 대체 크기를 다시 걸게 함");
  await page.close();
});
