import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const flush = () => new Promise((resolve) => setImmediate(resolve));

function fixture() {
  const { createBrowserTabZoom } = require("../native/electron/browser-tab-zoom.cjs");
  const origin = { level: 1.5 };
  const host = { isDestroyed: () => false, sent: [], send(channel, message) { this.sent.push({ channel, ...message }); } };
  const otherHost = { ...host, sent: [] };
  const requests = [];
  const errors = [];
  const ipcMain = new EventEmitter();
  const guests = new Map();
  const controller = createBrowserTabZoom({
    isolate(wc) {
      const { promise, resolve, reject } = Promise.withResolvers();
      requests.push({ wc, resolve() { wc.localLevel = wc.getZoomLevel(); resolve(); }, reject });
      return promise;
    },
    ipcMain,
    findContents: (id) => guests.get(id),
    isTrustedSender: ({ trusted }) => trusted,
    error: (...args) => errors.push(args.join(" ")),
  });

  function guest(id, owner = host, url = "https://same.test/") {
    const wc = Object.assign(new EventEmitter(), {
      id, url, hostWebContents: owner, destroyed: false, localLevel: undefined,
      isDestroyed() { return this.destroyed; },
      getURL() { return this.url; },
      getZoomLevel() { return this.localLevel ?? origin.level; },
      getZoomFactor() { return 1.2 ** this.getZoomLevel(); },
      setZoomLevel(value) {
        if (this.localLevel === undefined) origin.level = value;
        else this.localLevel = value;
      },
      navigate(url = "https://same.test/next") {
        this.url = url; this.localLevel = undefined; this.emit("did-navigate", {}, url);
      },
      destroy() { this.destroyed = true; this.emit("destroyed"); },
    });
    guests.set(id, wc);
    controller.attach(wc);
    return wc;
  }
  return { guest, controller, origin, host, otherHost, requests, errors, ipcMain };
}

test("같은 Iris 탭은 새 창의 webview로 옮겨도 배율을 복원하고 닫은 뒤 다시 열면 원복", async () => {
  const { createCdpTransport } = require("../native/electron/cdp-transport.cjs");
  const { guest, controller, host, otherHost, requests, ipcMain, origin } = fixture();
  const tabId = "browser:a";
  const socket = new EventEmitter();
  const transport = createCdpTransport({
    WebSocket: function () { return socket; },
    setIntervalFn: () => ({}),
  });
  transport.setupCdpControl({}, controller.reconcileTabs);
  const snapshot = (tabIds) => socket.emit("message", JSON.stringify({
    type: "browser-state", state: { tabsBySpace: { space: tabIds.map((id) => ({ id })) } },
  }));
  const report = (sender, wc, trusted = true) => ipcMain.emit("ac-browser-tab-zoom-bind", { sender, trusted }, wc.id, tabId);
  const first = guest(1);
  const unrelated = guest(2);
  report(host, first);
  requests[0].resolve();
  requests[1].resolve();
  await flush();
  controller.adjust(first, "in");
  snapshot(["browser:b"]);
  snapshot([tabId, "browser:b"]);
  first.destroy();

  const moved = guest(3, otherHost);
  report(host, moved);
  report(otherHost, moved, false);
  requests[2].resolve();
  await flush();
  assert.equal(moved.getZoomLevel(), 0);
  report(otherHost, moved);
  assert.equal(moved.getZoomLevel(), 0.5);
  assert.equal(unrelated.getZoomLevel(), 0);
  assert.equal(origin.level, 1.5);

  moved.destroy();
  snapshot(["browser:b"]);
  snapshot([tabId, "browser:b"]);
  const reopened = guest(4);
  report(host, reopened);
  requests[3].resolve();
  await flush();
  assert.equal(reopened.getZoomLevel(), 0);
});

test("첫 탭의 범위 설정을 기다렸다가 확대하고 기존 호스트 배율과 다른 탭 배율을 유지", async () => {
  const { guest, origin, requests, controller, host } = fixture();
  const a = guest(1);
  const b = guest(2);
  assert.equal(requests.length, 2);
  controller.adjust(a, "in");
  assert.equal(origin.level, 1.5);
  assert.equal(host.sent.length, 0);

  requests.forEach((request) => request.resolve());
  await flush();
  assert.equal(a.getZoomLevel(), 0.5);
  assert.equal(b.getZoomLevel(), 0);
  assert.equal(origin.level, 1.5);
  assert.deepEqual(host.sent, [
    { channel: "ac-browser-zoom-changed", wc: 1, factor: 1.2 ** 0.5 },
    { channel: "ac-browser-zoom-changed", wc: 2, factor: 1 },
  ]);
});

test("새 문서로 연속 이동하면 마지막 범위 설정 후에만 배율을 복원", async () => {
  const { guest, origin, requests, controller } = fixture();
  const wc = guest(1);
  requests[0].resolve();
  await flush();
  controller.adjust(wc, "in");
  wc.emit("did-navigate-in-page", {}, "https://same.test/#hash", true);
  wc.emit("did-frame-navigate", {}, "https://child.test", 200, "OK", false);
  assert.equal(requests.length, 1);
  assert.equal(wc.getZoomLevel(), 0.5);

  wc.navigate();
  wc.navigate();
  controller.adjust(wc, "in");
  requests[1].resolve();
  await flush();
  assert.equal(wc.getZoomLevel(), 1.5);
  requests[2].resolve();
  await flush();
  assert.equal(wc.getZoomLevel(), 1);
  assert.equal(origin.level, 1.5);
});

test("실패한 범위 설정 이후 휠로 다시 요청해 복구하고 닫힌 탭에는 적용하지 않음", async () => {
  const { guest, requests, origin, errors, host } = fixture();
  const wc = guest(1);
  requests[0].reject(new Error("워커 응답 없음"));
  await flush();
  assert.match(errors.join(), /워커 응답 없음/);

  wc.emit("zoom-changed", {}, "out");
  assert.equal(requests.length, 2);
  assert.equal(origin.level, 1.5);
  requests[1].resolve();
  await flush();
  assert.equal(wc.getZoomLevel(), -0.5);
  assert.equal(host.sent.at(-1).factor, 1.2 ** -0.5);

  wc.navigate();
  const notificationsBeforeClose = host.sent.slice();
  wc.destroyed = true;
  wc.emit("destroyed");
  requests[2].resolve();
  await flush();
  assert.deepEqual(host.sent, notificationsBeforeClose);
});

test("범위 설정에 실패하면 실제 배율과 반영되지 않은 입력을 알림", async () => {
  const { guest, requests, origin, controller, host } = fixture();
  const wc = guest(1);
  requests[0].resolve();
  await flush();
  controller.adjust(wc, "in");
  assert.equal(host.sent.at(-1).factor, 1.2 ** 0.5);

  wc.navigate();
  controller.adjust(wc, "in");
  requests[1].reject(new Error("워커 응답 없음"));
  await flush();

  assert.equal(wc.getZoomLevel(), origin.level);
  assert.deepEqual(host.sent.at(-1), {
    channel: "ac-browser-zoom-changed", wc: 1, factor: 1.2 ** origin.level,
    notice: "이 페이지의 확대·축소를 적용하지 못했습니다.",
  });
});

test("실패한 문서의 확대 입력은 새 문서나 같은 문서 재시도에 누적되지 않음", async () => {
  const { guest, requests, origin, controller } = fixture();
  const wc = guest(1);
  requests[0].resolve();
  await flush();
  controller.adjust(wc, "in");

  wc.navigate();
  controller.adjust(wc, "in");
  controller.adjust(wc, "in");
  requests[1].reject(new Error("워커 응답 없음"));
  await flush();

  controller.adjust(wc, "in");
  controller.adjust(wc, "out");
  requests[2].resolve();
  await flush();
  assert.equal(wc.getZoomLevel(), 0);
  wc.navigate();
  requests[3].resolve();
  await flush();
  assert.equal(wc.getZoomLevel(), 0);
  assert.equal(origin.level, 1.5);
});

test("이동으로 교체된 확대 입력은 알림을 보내고 새 문서에 적용하지 않음", async () => {
  const { guest, requests, controller, host } = fixture();
  const wc = guest(1);
  requests[0].resolve();
  await flush();

  wc.navigate();
  controller.adjust(wc, "in");
  wc.navigate();
  requests[1].resolve();
  requests[2].resolve();
  await flush();

  assert.equal(wc.getZoomLevel(), 0);
  assert.ok(host.sent.some(({ notice }) => notice === "페이지가 이동해 확대·축소를 적용하지 못했습니다."));
});

const accessDenied = "Error: Cannot access contents of the page. Extension manifest must request permission to access this host.";
const timeout = "탭별 확대 범위 설정 응답 없음";

test("이미 교체된 요청의 실패는 기록하지 않고 현재 문서의 접근 거부는 기록", async () => {
  const { guest, requests, errors } = fixture();
  const wc = guest(1);
  wc.navigate();

  requests[0].reject(new Error(timeout));
  requests[1].reject(new Error(accessDenied));
  await flush();

  assert.deepEqual(errors, [`[browser-tab-zoom] 1 ${accessDenied}`]);
});

test("최초 빈 문서의 접근 거부만 빼고 워커 시간 초과와 이후 빈 문서의 접근 거부는 기록", async () => {
  const { guest, requests, errors, controller, host } = fixture();
  const popup = guest(1, null, "");
  const blank = guest(2, host, "about:blank");
  requests[0].reject(new Error(accessDenied));
  requests[1].reject(new Error(accessDenied));
  await flush();

  controller.adjust(blank, "in");
  requests[2].reject(new Error(timeout));
  popup.navigate();
  requests[3].resolve();
  await flush();
  popup.navigate("about:blank");
  requests[4].reject(new Error(accessDenied));
  await flush();

  assert.deepEqual(errors, [`[browser-tab-zoom] 2 ${timeout}`, `[browser-tab-zoom] 1 ${accessDenied}`]);
  assert.equal(host.sent.at(-1).notice, "이 페이지의 확대·축소를 적용하지 못했습니다.");
});

test("주소창의 확대·원복은 탭을 소유한 신뢰된 창에서만 적용하고 그 창에만 알림", async () => {
  const { guest, requests, host, otherHost, ipcMain } = fixture();
  const wc = guest(1, otherHost);
  requests[0].resolve();
  await flush();

  ipcMain.emit("ac-browser-zoom", { sender: host, trusted: true }, 1, "in");
  ipcMain.emit("ac-browser-zoom", { sender: otherHost, trusted: false }, 1, "in");
  ipcMain.emit("ac-browser-zoom", { sender: otherHost, trusted: true }, 1, "unknown");
  assert.equal(wc.getZoomLevel(), 0);

  ipcMain.emit("ac-browser-zoom", { sender: otherHost, trusted: true }, 1, "in");
  assert.equal(wc.getZoomLevel(), 0.5);
  ipcMain.emit("ac-browser-zoom", { sender: otherHost, trusted: true }, 1, "reset");
  assert.equal(wc.getZoomLevel(), 0);
  assert.equal(host.sent.length, 0);
  assert.deepEqual(otherHost.sent.map(({ factor }) => factor), [1, 1.2 ** 0.5, 1]);
});
