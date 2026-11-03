// 실제 브라우저에서 휠 입력의 wheel 이벤트가 CDP 응답보다 늦게 와도 수신으로 확인(C3 정상 스크롤 단계가 "수신 확인 못함"으로 멈춘 사례)
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");
const { headlessLaunchOptions } = require("../bin/headless-browser.cjs");
const { createQaInputCommands } = require("../native/electron/cdp-qa-input.cjs");

test("실제 브라우저의 스크롤 입력은 늦게 도착한 wheel 이벤트로 수신을 확인한다", async t => {
  const browser = await puppeteer.launch(headlessLaunchOptions());
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setViewport({ width: 400, height: 300 });
  await page.setContent(`<body style="margin:0"><main style="height:5000px"><h2 style="margin:0;height:300px">상점 인기 관리</h2></main>`);
  const cdp = await page.target().createCDPSession();
  const send = (method, params) => cdp.send(method, params);
  send.on = () => send;
  send.frames = () => [null];
  await send("DOM.getDocument", { depth: -1 });
  const commands = createQaInputCommands();
  // 헤드리스 셸은 스크롤한 뒤 DOM.getNodeForLocation 이 노드를 못 찾는 경우가 있어 회차마다 맨 위로 되돌림
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => scrollTo(0, 0));
    const result = await commands["qa-input"](send, {}, { action: "scroll", x: 100, y: 100, deltaX: 0, deltaY: 400 });
    assert.equal(result.trusted, true);
    assert.ok(result.received.some(event => event.type === "wheel" && event.trusted));
    assert.ok(await page.waitForFunction(() => scrollY > 0, { timeout: 2000 }));
  }
});

test("휠 이벤트가 전달돼도 스크롤 위치가 그대로면 결과에 남기고(실패 아님), 이미 끝이면 atEdge 를 적는다", async t => {
  const browser = await puppeteer.launch(headlessLaunchOptions());
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setViewport({ width: 400, height: 300 });
  // 페이지가 휠 기본 동작을 막으면 이벤트는 받지만 스크롤은 안 됨(C5 정상 -6000 과 같은 관찰 결과)
  await page.setContent(`<body style="margin:0"><main id=list style="height:5000px">목록</main><script>list.addEventListener("wheel", e => { if (window.block) e.preventDefault(); }, { passive: false });</script>`);
  const cdp = await page.target().createCDPSession();
  const send = (method, params) => cdp.send(method, params);
  send.on = () => send;
  send.frames = () => [null];
  await send("DOM.getDocument", { depth: -1 });
  const input = createQaInputCommands()["qa-input"];
  const top = await input(send, {}, { action: "scroll", x: 100, y: 100, deltaX: 0, deltaY: -400 });
  assert.equal(top.atEdge, true);
  await page.evaluate(() => { window.block = true; });
  const blocked = await input(send, {}, { action: "scroll", x: 100, y: 100, deltaX: 0, deltaY: 400 });
  assert.equal(blocked.trusted, true);
  assert.equal(blocked.scrollUnchanged, true);
  assert.match(blocked.scrollNote, /스크롤 위치 그대로/);
  assert.match(blocked.scrollNote, /\[\["body",0,0,\d+\]\]/, "어느 스크롤 영역인지 적음(doctype 없는 문서는 body)");
  await page.evaluate(() => { window.block = false; });
  const moved = await input(send, {}, { action: "scroll", x: 100, y: 100, deltaX: 0, deltaY: 400 });
  assert.equal(moved.scrollUnchanged, undefined);
  assert.equal(moved.atEdge, false);
});

test("페이지가 막지 않은 휠인데 위치가 그대로면 기본 동작대로 스크롤 영역을 옮기고 그렇게 했다고 알린다", async t => {
  // 배경 탭에서 휠은 전달되는데 위치가 그대로이던 사례(qa-6face637 seq 895, qa-2ab6e345 seq 130·157). 휠 이동량을 거의 0으로 바꿔 같은 상태를 만듦
  const browser = await puppeteer.launch(headlessLaunchOptions());
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setViewport({ width: 400, height: 300 });
  await page.setContent(`<!doctype html><body style="margin:0"><div style="position:fixed;inset:0;display:flex;flex-direction:column"><main id=box style="flex:1;overflow-y:auto"><div style="height:5000px">목록</div></main></div><script>box.addEventListener("wheel", e => { if (window.block) e.preventDefault(); }, { passive: false });</script>`);
  const cdp = await page.target().createCDPSession();
  const send = (method, params) => cdp.send(method, method === "Input.dispatchMouseEvent" && params.type === "mouseWheel" ? { ...params, deltaY: Math.sign(params.deltaY) * 0.01 } : params);
  send.on = () => send;
  send.frames = () => [null];
  await send("DOM.getDocument", { depth: -1 });
  const input = createQaInputCommands()["qa-input"];
  const moved = await input(send, {}, { action: "scroll", x: 100, y: 100, deltaX: 0, deltaY: 400 });
  assert.equal(moved.scrollUnchanged, undefined);
  assert.equal(moved.scrollApplied, "main#box");
  assert.match(moved.scrollNote, /기본 동작대로 main#box/);
  assert.equal(await page.evaluate(() => box.scrollTop), 400);
  await page.evaluate(() => { window.block = true; });
  const blocked = await input(send, {}, { action: "scroll", x: 100, y: 100, deltaX: 0, deltaY: 400 });
  assert.equal(blocked.scrollUnchanged, true, "페이지가 막은 휠은 옮기지 않음");
  assert.match(blocked.scrollNote, /페이지가 휠 기본 동작을 막음/);
  assert.equal(await page.evaluate(() => box.scrollTop), 400);
});
