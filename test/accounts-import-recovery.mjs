import assert from "node:assert/strict";
import test from "node:test";
import * as state from "../web/js/browser/state.js";
import * as profiles from "../web/js/browser/profiles.js";
import { initAccountsScreen } from "../web/js/browser/accounts-screen.js";

test("가져오기 거절·실패·스테이징 뒤 버튼을 복구하고 다시 시도할 수 있다", async () => {
  const sent = [], toasts = [];
  state.initBrowserState({ wsSend: m => sent.push(m) });
  state.replaceBrowserState({ profiles: [{ id: "test", name: "Test" }] });
  profiles.ensureProfileData();
  const originalWindow = globalThis.window, originalDocument = globalThis.document, originalHost = globalThis.acHost;
  const host = {};
  globalThis.window = { acHost: host };
  globalThis.acHost = host;
  globalThis.document = { getElementById: () => null };
  let click;
  const body = { addEventListener: (name, fn) => { if (name === "click") click = fn; }, querySelectorAll: () => [], querySelector: () => null };
  initAccountsScreen({ $: q => q === "#acct-body" ? body : null, cssEsc: value => value, BROWSER_MODE: false, orderedSpaces: () => [],
    showToast: (message, options) => toasts.push({ message, ...options }) });
  const button = { dataset: { impCid: "chrome:Default", impLabel: "Test" }, disabled: false,
    textContent: "가져오기", innerHTML: "", classList: { add() {}, remove() {} } };
  const event = { target: { closest: selector => selector === "[data-imp-cid]" ? button : null } };
  try {
    host.importChromeProfile = async () => { throw new Error("IPC disconnected"); };
    await click(event);
    assert.equal(button.disabled, false);
    assert.equal(button.textContent, "가져오기");
    assert.equal(toasts.at(-1).detail, "IPC disconnected");
    host.importChromeProfile = async () => ({ error: "키체인 취소" });
    await click(event);
    assert.equal(button.disabled, false);
    assert.equal(toasts.at(-1).detail, "키체인 취소");
    host.importChromeProfile = async () => ({ imported: 2, live: 0, staged: 2, skipped: 0, domains: ["example.com"] });
    await click(event);
    assert.equal(button.disabled, false);
    assert.equal(toasts.at(-1).level, "ok");
    assert.match(toasts.at(-1).message, /가져오기 완료: Test \(쿠키 2개 추가/);
    let finish, calls = 0;
    host.importChromeProfile = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
    const pending = click(event);
    assert.equal(button.disabled, true);
    await click(event);
    assert.equal(calls, 1);
    finish({ error: "취소" });
    await pending;
    assert.equal(button.disabled, false);
  } finally {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.acHost = originalHost;
  }
});
