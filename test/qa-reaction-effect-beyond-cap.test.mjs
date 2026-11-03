// 요소가 많은 화면의 기대 효과 판정: body 끝에 붙는 알림
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { reactionWatch } = require("../native/electron/cdp-qa-reaction.cjs");

function page(count, toastText) {
  const body = { children: [], innerText: "화면", textContent: "화면", isConnected: true, parentElement: null, getAttribute: () => null };
  const node = (i, text) => ({ id: "", innerText: text, textContent: text, localName: "div", children: [], parentElement: body, isConnected: true,
    scrollWidth: 10, clientWidth: 10, getAttribute: () => null, hasAttribute: () => false, closest: () => null, contains: other => other === node,
    getBoundingClientRect: () => ({ x: 0, y: i, width: 10, height: 10 }) });
  const nodes = Array.from({ length: count }, (_, i) => node(i, "행 " + i));
  // 알림은 다른 요소 뒤, DOM 끝
  nodes.push(node(count, toastText));
  const document = { body, documentElement: { scrollWidth: 800 }, activeElement: null,
    querySelectorAll: sel => sel === "body *" ? nodes : [], getElementById: () => null, elementFromPoint: () => nodes[0],
    addEventListener() {}, removeEventListener() {} };
  const context = vm.createContext({ document, location: { href: "http://site/" }, innerWidth: 800, innerHeight: 600, Date,
    MutationObserver: class { observe() {} disconnect() {} }, setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1", overflowX: "visible", textOverflow: "clip" }),
    PerformanceObserver: class { observe() {} disconnect() {} }, binding: () => {} });
  const effects = [{ id: "e1", type: "appear", text: "동기화 완료" }];
  return vm.runInContext(`(${reactionWatch.toString()})(${JSON.stringify({ id: "w", effects, binding: "binding", deadline: 1e15 })})`, context);
}

test("요소가 3000개를 넘는 화면에서도 DOM 끝에 붙은 알림 글자로 appear 기대를 찾는다", () => {
  const snapshot = page(5300, "동기화 완료 — 신규 2 · 갱신 114 · 품절 1");
  assert.equal(snapshot.effects[0].found, true, JSON.stringify(snapshot.effects[0]));
  assert.match(snapshot.effects[0].text, /^동기화 완료/);
});

test("글자가 없으면 찾지 못한다", () => {
  assert.equal(page(10, "저장됨").effects[0].found, false);
});
