// 페이지 안 반응 관찰기의 검사 빈도와 페이지 부담
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { reactionWatch } = require("../native/electron/cdp-qa-reaction.cjs");

function page({ costPerStyleMs }) {
  let clock = 0, scans = 0, tick, mutate;
  const timers = [];
  const body = { children: [], innerText: "화면", isConnected: true, parentElement: null, getAttribute: () => null };
  const nodes = Array.from({ length: 20 }, (_, i) => ({ id: "n" + i, innerText: "행 " + i, textContent: "행 " + i, localName: "div", children: [], parentElement: body,
    isConnected: true, scrollWidth: 10, clientWidth: 10, getAttribute: () => null, hasAttribute: () => false, closest: () => null,
    getBoundingClientRect: () => ({ x: 0, y: i * 10, width: 10, height: 10 }) }));
  const document = { body, documentElement: { scrollWidth: 800 }, activeElement: null,
    querySelectorAll: sel => { if (sel === "body *") scans++; return sel === "body *" ? nodes : []; }, getElementById: () => null, elementFromPoint: () => nodes[0],
    addEventListener() {}, removeEventListener() {} };
  const context = vm.createContext({ document, location: { href: "http://site/" }, innerWidth: 800, innerHeight: 600, Date: { now: () => clock },
    MutationObserver: class { constructor(fn) { mutate = fn; } observe() {} disconnect() {} },
    setInterval(fn) { tick = fn; return 1; }, clearInterval() {},
    setTimeout(fn, ms) { timers.push({ fn, at: clock + ms }); return timers.length; }, clearTimeout() {},
    // 스타일 계산 한 번에 시간이 흐르는 무거운 화면
    getComputedStyle: () => { clock += costPerStyleMs; return { display: "block", visibility: "visible", opacity: "1", overflowX: "visible", textOverflow: "clip" }; },
    PerformanceObserver: class { observe() {} disconnect() {} }, binding: () => {} });
  vm.runInContext(`(${reactionWatch.toString()})(${JSON.stringify({ id: "w", effects: [], binding: "binding", deadline: 1e12 })})`, context);
  return {
    get scans() { return scans; },
    advance(ms) { clock += ms; for (const timer of timers.splice(0).filter(t => t.at <= clock)) timer.fn(); },
    tick() { tick(); }, mutate() { mutate([]); },
  };
}

test("검사 한 번이 오래 걸리는 화면에서는 40ms 주기와 DOM 변경마다 검사하지 않고 비용의 4배를 쉰다", () => {
  const heavy = page({ costPerStyleMs: 5 });
  const before = heavy.scans;
  for (let i = 0; i < 25; i++) { heavy.advance(40); heavy.tick(); heavy.mutate(); }
  const runs = heavy.scans - before;
  // 1초(40ms × 25) 동안 주기 25번과 변경 25번. 검사 한 번이 수백 ms 라 몇 번만 실행돼야 함
  assert.ok(runs <= 10, String(runs));
});

test("가벼운 화면에서는 DOM 변경마다 바로 검사한다", () => {
  const light = page({ costPerStyleMs: 0 });
  const before = light.scans;
  for (let i = 0; i < 5; i++) light.mutate();
  assert.ok(light.scans - before >= 5, String(light.scans - before));
});

test("미룬 DOM 변경은 쉬는 시간이 지나면 검사한다", () => {
  const heavy = page({ costPerStyleMs: 5 });
  heavy.advance(10_000);
  heavy.mutate();
  const afterFirst = heavy.scans;
  heavy.mutate();
  assert.equal(heavy.scans, afterFirst);
  heavy.advance(60_000);
  assert.ok(heavy.scans > afterFirst);
});
