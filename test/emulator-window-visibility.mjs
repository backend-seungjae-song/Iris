import test from "node:test";
import assert from "node:assert/strict";
import { withWebPage, overrideFromEnv } from "./lib/web-page.mjs";

// WINDOW_SRC: 고치기 전 판의 emulator-window/window.js 로 같은 검사를 돌릴 때
const real = overrideFromEnv({ WINDOW_SRC: "/emulator-window/window.js" });
// pane 은 setVisible 호출만 기록하는 대역. 창 가림의 유예는 pane 쪽이 맡으므로 window.js 가 직접 알리면 안 됨
const PANE_STUB = `export function mountEmulatorPane() {
  window.__calls = [];
  return { setVisible: (v) => window.__calls.push(v), current: () => ({ attached: false }), connect() {}, dispose() {}, platform() {} };
}`;

test("분리 창은 가림·보임을 pane 에 직접 알리지 않아 잠깐 최소화해도 스트림이 다시 시작되지 않음", async () => {
  const calls = await withWebPage(async (page) => {
    await page.evaluateOnNewDocument(() => {
      const noop = () => {};
      window.acHost = { emulator: { onPickState: noop, onRecordState: noop, onControlResult: noop, onConnectRequested: noop, requestControl: noop } };
    });
    await page.goto(page.url() + "?space=w1&tab=t1");
    return page.evaluate(async () => {
      await import("/emulator-window/window.js");
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
      return window.__calls;
    });
  }, { body: `<div id="emu-window"></div>`, overrides: { "/js/emulator/pane.js": PANE_STUB, ...real } });
  assert.deepEqual(calls.filter((v) => v === false), [], "가림 즉시 setVisible(false) 를 부르지 않음");
});
