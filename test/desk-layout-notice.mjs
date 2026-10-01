import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { createHost } = require("../native/electron/desk-layout/host.cjs");

const MAIN = { id: 1, bounds: { x: 0, y: 0, width: 1728, height: 1117 }, workArea: { x: 0, y: 38, width: 1728, height: 1079 } };
const screen = { getPrimaryDisplay: () => MAIN, getAllDisplays: () => [MAIN] };
const mac = {
  listWindows: async () => ({ ok: true, locked: false, desktops: [{ order: [3], current: 3 }], windows: [
    { bundle: "com.tinyspeck.slackmacgap", appName: "Slack", pid: 20, cgId: 200, title: "채널", rect: { x: 0, y: 38, width: 1728, height: 1079 }, desktop: 1, onCurrent: true },
  ] }),
  runningBundleIds: async () => ({ ok: true, bundles: [], regular: [] }),
};

// 창 레이아웃 알림은 Iris 알림(ctx.notice → ac-native-notice)으로. macOS 알림은 Iris 알림 권한이 꺼져 있으면 안 보였음(2026-09-28)
test("단축키 저장 결과는 Iris 알림으로 간다", async (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "iris-desk-notice-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const sent = [];
  const host = createHost({ stateDir, screen, mac, selfPid: -1, notice: (m) => sent.push(m) });
  const r = await host.saveNow("shortcut");
  assert.equal(r.saved, true);
  assert.deepEqual(sent, [{ text: "창 레이아웃: 저장했습니다: 모니터 1대, 창 1개", level: "ok" }]);

  sent.length = 0;
  await createHost({ stateDir, screen: { ...screen, getAllDisplays: () => [MAIN, { ...MAIN, id: 2 }] }, mac, selfPid: -1, notice: (m) => sent.push(m) }).restoreWithDesktops();
  assert.deepEqual(sent, [{ text: "창 레이아웃: 모니터 2대 레이아웃이 아직 없습니다", level: "warn" }]);
});

test("여러 줄 알림은 한 줄로 이어 보낸다", () => {
  const sent = [];
  createHost({ stateDir: tmpdir(), screen, mac, notice: (m) => sent.push(m) }).notify("제자리 2개\n실행 중이 아닌 창 1개", "warn");
  assert.deepEqual(sent, [{ text: "창 레이아웃: 제자리 2개. 실행 중이 아닌 창 1개", level: "warn" }]);
});

test("macOS 알림(Notification)을 쓰지 않는다", () => {
  const src = readFileSync(new URL("../native/electron/desk-layout/host.cjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /new Notification\(/);
});

// 단축키 저장·복원 결과는 모니터 가운데 정사각 알림(hud.cjs, 사용자 시안 H2 2026-09-28)
const { createHud } = require("../native/electron/desk-layout/hud.cjs");

function fakeElectron() {
  const made = [];
  class FakeWindow {
    constructor(options) { this.options = options; this.calls = []; this.destroyed = false; made.push(this);
      this.webContents = { executeJavaScript: async (code) => { this.calls.push(["js", code]); } }; }
    setAlwaysOnTop(...a) { this.calls.push(["top", ...a]); }
    setVisibleOnAllWorkspaces(...a) { this.calls.push(["spaces", ...a]); }
    setIgnoreMouseEvents(v) { this.calls.push(["ignore", v]); }
    on() {}
    async loadURL(url) { this.url = url; }
    setBounds(b) { this.bounds = b; }
    showInactive() { this.calls.push(["showInactive"]); }
    show() { this.calls.push(["show"]); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  const LEFT = { bounds: { x: -1920, y: 0, width: 1920, height: 1080 } };
  const screen = { getCursorScreenPoint: () => ({ x: -500, y: 300 }), getDisplayNearestPoint: (p) => (p.x < 0 ? LEFT : MAIN) };
  return { BrowserWindow: FakeWindow, screen, made };
}

test("가운데 알림은 커서가 있는 모니터 가운데, 모든 앱 위, 포커스·마우스를 가져가지 않는다", async () => {
  const { BrowserWindow, screen, made } = fakeElectron();
  const hud = createHud({ BrowserWindow, screen });
  await hud.show({ kind: "ok", title: "창 레이아웃 저장함", sub: "모니터 1대 · 창 1개" });
  const win = made[0];
  assert.deepEqual(win.bounds, { x: -1920 + 860, y: 440, width: 200, height: 200 });
  assert.equal(win.options.focusable, false);
  assert.equal(win.options.transparent, true);
  assert.deepEqual(win.calls.find((c) => c[0] === "top"), ["top", true, "screen-saver"]);
  assert.deepEqual(win.calls.find((c) => c[0] === "ignore"), ["ignore", true]);
  assert.ok(win.calls.some((c) => c[0] === "showInactive"));
  assert.ok(!win.calls.some((c) => c[0] === "show"), "show() 는 Iris 를 앞으로 가져옴");
  assert.match(win.calls.find((c) => c[0] === "js")[1], /render\(\{"kind":"ok","title":"창 레이아웃 저장함","sub":"모니터 1대 · 창 1개"/);
  assert.equal(hud.owns(win), true);
  hud.hide();
  await new Promise((r) => setTimeout(r, 260));
  assert.equal(win.destroyed, true, "숨긴 뒤 창을 남기지 않는다");
});

test("가운데 알림이 있으면 단축키 저장·복원 결과를 거기로 보낸다", async (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "iris-desk-hud-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const shown = [], sent = [];
  const hud = { show: (s) => shown.push(s), owns: () => false };
  const host = createHost({ stateDir, screen, mac, selfPid: -1, hud, notice: (m) => sent.push(m) });
  await host.saveNow("shortcut");
  assert.deepEqual(shown, [{ kind: "ok", title: "창 레이아웃 저장함", sub: "모니터 1대 · 창 1개" }]);
  assert.deepEqual(sent, [], "Iris 알림 목록에는 보내지 않는다");

  shown.length = 0;
  await createHost({ stateDir, screen: { ...screen, getAllDisplays: () => [MAIN, { ...MAIN, id: 2 }] }, mac, selfPid: -1, hud, notice: (m) => sent.push(m) }).restoreWithDesktops();
  assert.deepEqual(shown, [{ kind: "warn", title: "복원할 레이아웃 없음", sub: "모니터 2대 레이아웃이 아직 없습니다" }]);
  assert.deepEqual(sent, []);
});

test("창 레이아웃 저장은 가운데 알림 창을 저장하지 않는다", async (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "iris-desk-hud-own-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const hudWin = { id: 7, isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, getTitle: () => "창 레이아웃 알림", getMediaSourceId: () => "window:900:0" };
  const ownMac = { ...mac, listWindows: async () => ({ ok: true, locked: false, desktops: [{ order: [3], current: 3 }], windows: [
    { bundle: "com.tinyspeck.slackmacgap", appName: "Slack", pid: 20, cgId: 200, title: "채널", rect: { x: 0, y: 38, width: 1728, height: 1079 }, desktop: 1, onCurrent: true },
    { bundle: "app.iris.console", appName: "Iris", pid: 99, cgId: 900, title: "", rect: { x: 764, y: 458, width: 200, height: 200 }, desktop: 1, onCurrent: true },
  ] }) };
  const host = createHost({ stateDir, screen, mac: ownMac, selfPid: 99, BrowserWindow: { getAllWindows: () => [hudWin] },
    hud: { show() {}, owns: (w) => w === hudWin }, notice() {} });
  const r = await host.saveNow("shortcut");
  assert.equal(r.windows, 1);
});
