// 세션 공유 백그라운드 탭(native/electron/bg-tabs.cjs)
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const { createBgTabs, bgTabKey, checkOpenRequest, idleKeys } = require("../native/electron/bg-tabs.cjs");
const { isProfilePartition } = require("../native/electron/profile-session-policy.cjs");

test("같은 프로필·주소면 같은 키, 해시가 다르면 다른 키(해시 라우팅 페이지)", () => {
  const a = bgTabKey("https://www.figma.com/design/K/x?node-id=1-2", "persist:acprof:abc");
  assert.equal(a, bgTabKey("https://www.figma.com/design/K/x?node-id=1-2", "persist:acprof:abc"));
  assert.notEqual(a, bgTabKey("https://www.figma.com/design/K/x?node-id=1-2#/b", "persist:acprof:abc"));
  assert.notEqual(a, bgTabKey("https://www.figma.com/design/K/x?node-id=1-2", "persist:acbrowser"));
});

test("http(s) 주소와 프로필 정책이 허용한 partition 만 연다", () => {
  const ok = (p) => isProfilePartition(p);
  assert.equal(checkOpenRequest({ url: "https://a.com", partition: "persist:acbrowser" }, ok), null);
  assert.equal(checkOpenRequest({ url: "https://a.com", partition: "persist:acprof:zoo_1-x" }, ok), null);
  assert.match(checkOpenRequest({ url: "file:///etc/passwd", partition: "persist:acbrowser" }, ok), /http/);
  assert.match(checkOpenRequest({ url: "nope", partition: "persist:acbrowser" }, ok), /주소/);
  assert.match(checkOpenRequest({ url: "https://a.com", partition: "persist:other" }, ok), /partition/);
});

test("마지막 사용 뒤 유휴 시간이 지난 탭만 닫을 대상", () => {
  const entries = new Map([["a", { lastUsed: 0 }], ["b", { lastUsed: 900 }]]);
  assert.deepEqual(idleKeys(entries, 1000, 500), ["a"]);
  assert.deepEqual(idleKeys(entries, 1000, 2000), []);
});

// 숨은 창 페이지 흉내: webview 요소를 만들면 guest 를 만들고, 몇 번 물어본 뒤에야 getWebContentsId 가 id 를 줌
function fakeElectron(log, { attachAfter = 2, neverAttach = false } = {}) {
  let wcSeq = 100;
  const guests = new Map();     // wc id → guest
  const elements = new Map();   // dom id → { guest, polls }
  const marks = {};
  const fromId = (id) => guests.get(id) || null;
  class FakeWindow extends EventEmitter {
    constructor(opts) {
      super();
      this.opts = opts; this.destroyed = false;
      log.windows.push(this);
      this.webContents = Object.assign(new EventEmitter(), {
        executeJavaScript: async (src) => {
          const domId = (src.match(/"(bg-[^"]+)"/) || [])[1];
          if (/createElement\("webview"\)/.test(src)) {
            const vmCtx = vm.createContext({});
            vmCtx.window = vmCtx;
            const guest = Object.assign(new EventEmitter(), {
              id: ++wcSeq, vmCtx, getTitle: () => "t", getURL: () => "https://example.com/", setBackgroundThrottling: () => {},
              isDestroyed: () => false, executeJavaScript: async (code) => vm.runInContext(code, vmCtx),
            });
            guests.set(guest.id, guest);
            elements.set(domId, { guest, polls: 0 });
            log.guests.push(guest);
            return 1;
          }
          if (/getWebContentsId/.test(src)) {
            const el = elements.get(domId);
            if (!el) return -1;
            return !neverAttach && ++el.polls > attachAfter ? el.guest.id : 0;
          }
          if (/\.remove\(\)/.test(src)) { elements.delete(domId); log.removed.push(domId); return 1; }
          if (/__bgChallenge/.test(src)) return !!marks[domId];
          return 1;
        },
      });
    }
    loadURL() { return Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit("closed"); }
  }
  return { BrowserWindow: FakeWindow, webContents: { fromId }, marks };
}

function makeTabs(opts = {}, extra = {}) {
  const log = { windows: [], guests: [], sent: [], removed: [] };
  let t = 0, seq = 0;
  const electron = fakeElectron(log, opts);
  const tabs = createBgTabs({
    BrowserWindow: electron.BrowserWindow, webContents: electron.webContents, webviewPreloadPath: "/p.cjs",
    guardWebviewPartition: () => {}, isAllowedPartition: isProfilePartition,
    ctlSend: (m) => log.sent.push(m), randomUuid: () => "u" + (++seq), now: () => t,
    sleep: async (ms) => { t += ms; await new Promise((r) => setImmediate(r)); },
    setIntervalFn: () => ({ unref() {} }), clearIntervalFn: () => {}, ...extra,
  });
  return { tabs, log, electron, setNow: (v) => { t = v; } };
}

test("두 세션이 동시에 같은 주소를 열면 탭은 하나 · 다시 열면 서버에 재등록", async () => {
  const { tabs, log } = makeTabs();
  const req = { url: "https://example.com/a", partition: "persist:acbrowser" };
  const [a, b] = await Promise.all([tabs.open(req), tabs.open(req)]);
  assert.equal(a.tabId, b.tabId);
  assert.equal(log.guests.length, 1);
  assert.equal(log.windows.length, 1);
  assert.equal(log.windows[0].opts.show, false);
  const registered = () => log.sent.filter((m) => m.type === "browser-tab-wc" && m.tabId === a.tabId && m.win === "bg").length;
  const before = registered();
  assert.ok(before >= 1);
  const again = await tabs.open(req);
  assert.equal(again.tabId, a.tabId);
  assert.equal(again.fresh, false);
  assert.equal(registered(), before + 1);
});

test("동시에 만든 두 탭은 각자 자기 webview 의 guest 를 받음(늦게 붙어도)", async () => {
  const { tabs, log } = makeTabs({ attachAfter: 3 });
  const [a, b] = await Promise.all([
    tabs.open({ url: "https://example.com/a", partition: "persist:acbrowser" }),
    tabs.open({ url: "https://example.com/b", partition: "persist:acbrowser" }),
  ]);
  assert.notEqual(a.tabId, b.tabId);
  assert.equal(a.wcId, log.guests[0].id);
  assert.equal(b.wcId, log.guests[1].id);
});

test("webview 가 끝내 붙지 않으면 요소를 지우고 오류", async () => {
  const { tabs, log } = makeTabs({ neverAttach: true });
  await assert.rejects(() => tabs.open({ url: "https://example.com/a", partition: "persist:acbrowser" }), /붙지 않았습니다/);
  assert.equal(log.removed.length, 1);
  assert.equal((await tabs.handle({ op: "list" })).tabs.length, 0);
});

test("사람 확인 표시가 있으면 open 결과에 challenge", async () => {
  const { tabs, electron } = makeTabs();
  const req = { url: "https://example.com/a", partition: "persist:acbrowser" };
  assert.equal((await tabs.open(req)).challenge, false);
  electron.marks["bg-u1"] = true;
  assert.equal((await tabs.open(req)).challenge, true);
});

test("잘못된 요청은 창을 만들기 전에 거절", async () => {
  const { tabs, log } = makeTabs();
  await assert.rejects(() => tabs.open({ url: "file:///x", partition: "persist:acbrowser" }), /http/);
  await assert.rejects(() => tabs.open({ url: "https://example.com", partition: "persist:evil" }), /partition/);
  assert.equal(log.windows.length, 0);
});

test("마지막 탭을 닫으면 숨은 창도 없앰", async () => {
  const { tabs, log } = makeTabs();
  await tabs.open({ url: "https://example.com/a", partition: "persist:acbrowser" });
  const listed = await tabs.handle({ op: "list" });
  assert.equal(listed.tabs.length, 1);
  assert.equal(await tabs.close(listed.tabs[0].key), true);
  assert.equal(log.removed.length, 1);
  assert.equal(log.windows[0].destroyed, true);
});

test("save 는 페이지 작업 결과를 조각으로 읽어 새 파일로 쓰고 작업을 지움 · 이미 있는 파일은 덮지 않음", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bg-tabs-"));
  const { tabs, log } = makeTabs();
  const { tabId } = await tabs.open({ url: "https://example.com/a", partition: "persist:acbrowser" });
  const ctx = log.guests[0].vmCtx;
  // 4MB 조각 경계(4194304)에 서로게이트 쌍이 걸치게 함
  const big = "가".repeat(4 * 1024 * 1024 - 1) + "😀" + "가".repeat(1024 * 1024);
  ctx.__irisJobs = { j1: { state: "done", text: big }, j2: { state: "done", text: Buffer.from([1, 2, 3, 250]).toString("base64") }, j3: { state: "done", text: "x" } };
  const file = path.join(dir, "out.json");
  const r = await tabs.save({ tabId, jobId: "j1", file });
  assert.equal(r.bytes, Buffer.byteLength(big));
  assert.equal(fs.readFileSync(file, "utf8"), big);
  assert.equal(ctx.__irisJobs.j1, undefined);
  const png = await tabs.save({ tabId, jobId: "j2", file: path.join(dir, "a.png"), base64: true });
  assert.deepEqual([...fs.readFileSync(png.path)], [1, 2, 3, 250]);
  await assert.rejects(() => tabs.save({ tabId, jobId: "j3", file }), /EEXIST/);
  await assert.rejects(() => tabs.save({ tabId, jobId: "j9", file: path.join(dir, "n.json") }), /끝난 페이지 작업/);
  await assert.rejects(() => tabs.save({ tabId, jobId: "x;alert(1)", file: path.join(dir, "n.json") }), /작업 id/);
  await assert.rejects(() => tabs.save({ tabId, jobId: "j3", file: "rel.json" }), /절대 경로/);
  await assert.rejects(() => tabs.save({ tabId: "bg:none", jobId: "j3", file: path.join(dir, "n.json") }), /닫혔습니다/);
  fs.rmSync(dir, { recursive: true, force: true });
});
