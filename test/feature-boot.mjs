import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { bootCapabilities } from "../web/js/core/capability-boot.js";

test("WS 중복 거절은 실제 main 배선에서 실패로 올라가고 다음 기능은 계속 부팅한다", async () => {
  const main = fs.readFileSync(new URL("../web/js/main.js", import.meta.url), "utf8");
  const match = main.match(/onWs: (\(type, fn, id\) => \{[\s\S]*?\n    \}),\n    onError:/);
  assert.ok(match, "main의 WS 등록 콜백");
  const first = () => "first";
  const dispatch = { shared: first };
  const onWs = vm.runInNewContext(`(${match[1]})`, { WS_DISPATCH: dispatch, dispatchWs: (fn) => fn, console: { error() {} } });
  const errors = [];
  const loaded = await bootCapabilities({
    items: [
      { id: "duplicate", load: async () => ({ initCapability: () => ({ ws: { shared() {} } }) }) },
      { id: "next", load: async () => ({ initCapability: () => ({ ws: { own() {} } }) }) },
    ],
    onWs, onError: (id, error) => errors.push([id, error.message]),
  });
  assert.deepEqual(loaded, ["next"]);
  assert.equal(errors[0][0], "duplicate");
  assert.match(errors[0][1], /WS 중복 등록 shared/);
  assert.equal(dispatch.shared, first);
  assert.equal(typeof dispatch.own, "function");
});

test("느린 capability 로드가 뒤 capability 로드를 막지 않는다", async () => {
  let releaseSlow;
  const slow = new Promise((resolve) => { releaseSlow = resolve; });
  let fastLoaded = false;
  const pending = bootCapabilities({
    items: [
      { id: "slow", load: () => slow },
      { id: "fast", load: async () => { fastLoaded = true; return {}; } },
    ],
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fastLoaded, true);
  releaseSlow({});
  assert.deepEqual(await pending, ["slow", "fast"]);
});

test("capability 로드는 병렬이고 async 초기화는 표의 순서를 지킨다", async () => {
  const events = [];
  let releaseFirstLoad;
  let releaseFirstInit;
  const firstLoad = new Promise((resolve) => { releaseFirstLoad = resolve; });
  const firstInit = new Promise((resolve) => { releaseFirstInit = resolve; });
  let secondLoaded;
  const secondLoad = new Promise((resolve) => { secondLoaded = resolve; });
  const pending = bootCapabilities({
    items: [
      { id: "first", load: async () => { events.push("first-load"); await firstLoad; events.push("first-loaded"); return { initCapability: async () => { events.push("first-init"); await firstInit; events.push("first-initialized"); } }; } },
      { id: "second", load: async () => { events.push("second-load"); secondLoaded(); return { initCapability: () => { events.push("second-init"); } }; } },
    ],
  });
  await secondLoad;
  assert.deepEqual(events, ["first-load", "second-load"]);
  releaseFirstLoad();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first-load", "second-load", "first-loaded", "first-init"]);
  releaseFirstInit();
  assert.deepEqual(await pending, ["first", "second"]);
  assert.deepEqual(events, ["first-load", "second-load", "first-loaded", "first-init", "first-initialized", "second-init"]);
});

test("초기화 뒤 등록이 실패하면 capability가 만든 상태를 역순으로 정리한다", async () => {
  const events = [];
  const errors = [];
  const loaded = await bootCapabilities({
    items: [{ id: "broken", rail: "broken", load: async () => ({
      panelHtml: "<div></div>",
      initCapability: () => ({
        screen: { enter() {} },
        ws: { duplicate() {} },
        dispose: () => { events.push("dispose"); },
      }),
    }) }],
    onPanel: () => { events.push("panel"); return () => events.push("remove-panel"); },
    onScreen: () => { events.push("screen"); return () => events.push("remove-screen"); },
    onWs: () => { events.push("ws"); return false; },
    onError: (id, error) => errors.push([id, error.message]),
  });
  assert.deepEqual(loaded, []);
  assert.deepEqual(events, ["panel", "screen", "ws", "dispose", "remove-screen", "remove-panel"]);
  assert.match(errors[0][1], /WS 중복 등록 duplicate/);
});
