import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createExtensionTabs } = require("../native/electron/browser-extension-tabs.cjs");

function fixture() {
  const ipcMain = new EventEmitter(), session = {}, otherSession = {}, sent = [];
  const host = { isDestroyed: () => false, send: (channel, data) => sent.push({ channel, ...data }) };
  const otherHost = { isDestroyed: () => false };
  const window = { id: 7 };
  const guest = (id, owner = host, profile = session) => ({ id, hostWebContents: owner, session: profile,
    isDestroyed: () => false, getType: () => "webview", getURL: () => "https://example.test/", getTitle: () => "Example", isLoading: () => false });
  const contents = [guest(11), guest(12, otherHost, otherSession)];
  const bridge = createExtensionTabs({ ipcMain, webContents: { getAllWebContents: () => contents, fromId: (id) => contents.find((wc) => wc.id === id) },
    BrowserWindow: { fromWebContents: (wc) => wc === host ? window : { id: 8 }, getFocusedWindow: () => window },
    isTrustedSender: (event) => event.sender === host || event.sender === otherHost, timeoutMs: 100 });
  const reply = (data, sender = host) => ipcMain.emit("ac-extension-tab-created", { sender }, { requestId: sent.at(-1).requestId, ...data });
  return { bridge, session, otherSession, sent, contents, guest, reply, host, otherHost };
}

test("확장이 만든 탭은 같은 창·프로필의 새 webview만 반환한다", async () => {
  const f = fixture();
  try {
    const promise = f.bridge.create(f.session, { url: "https://example.test/", active: false, openerTabId: 11 });
    assert.deepEqual({ ...f.sent[0], requestId: "nonce" }, { channel: "ac-extension-create-tab", requestId: "nonce", openerWc: 11, url: "https://example.test/", active: false });
    f.contents.push(f.guest(13));
    f.reply({ webContentsId: 13, index: 2 }, f.otherHost);
    f.reply({ webContentsId: 13, index: 2 });
    assert.deepEqual(await promise, { id: 13, windowId: 7, index: 2, active: false, highlighted: false, pinned: false,
      incognito: false, url: "https://example.test/", title: "Example", status: "complete" });
  } finally { f.bridge.dispose(); }
});

test("기존 탭·다른 프로필·다른 창을 새 탭으로 응답할 수 없다", async () => {
  for (const kind of ["existing", "profile", "host"]) {
    const f = fixture();
    try {
      const promise = f.bridge.create(f.session, { url: "https://example.test/" });
      const rejected = assert.rejects(promise, /프로필/);
      if (kind !== "existing") f.contents.push(f.guest(13, kind === "host" ? f.otherHost : f.host, kind === "profile" ? f.otherSession : f.session));
      f.reply({ webContentsId: kind === "existing" ? 11 : 13 });
      await rejected;
    } finally { f.bridge.dispose(); }
  }
});

test("지원하지 않는 주소·옵션과 다른 프로필 opener는 탭을 열지 않는다", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.bridge.create(f.session, { url: "file:///etc/passwd" }), /HTTP/);
    await assert.rejects(f.bridge.create(f.session, { url: "javascript:alert(1)" }), /HTTP/);
    await assert.rejects(f.bridge.create(f.session, { url: "https://example.test", openerTabId: 12 }), /먼저/);
    await assert.rejects(f.bridge.create(f.session, { pinned: true }), /옵션/);
    assert.equal(f.sent.length, 0);
  } finally { f.bridge.dispose(); }
});

test("새 탭 응답이 없으면 자동 재시도 없이 실패한다", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.bridge.create(f.session), /응답/);
    assert.equal(f.sent.length, 1);
  } finally { f.bridge.dispose(); }
});
