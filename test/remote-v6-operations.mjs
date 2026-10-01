import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

import { isRemoteRequest, REMOTE_REQUEST_TYPES } from "../server/remote/contract/requests.js";
import {
  MAX_BROWSER_FRAME_JPEG_BYTES,
  MAX_REMOTE_FRAME_BYTES,
} from "../server/remote/contract/ipc.js";
import { createBrowserFeature } from "../server/remote/features/browser.js";
import { createRemoteFeatures } from "../server/remote/features/index.js";
import { createSourceControlFeature } from "../server/remote/features/source-control.js";
import { createTerminalFeature } from "../server/remote/features/terminal.js";
import { createRemoteOperations } from "../server/remote/ops/index.js";
import { createMessageOperation } from "../server/remote/ops/message.js";
import { publicHttpUrl, redactMacPaths } from "../server/remote/public-text.js";
import { projectFeature } from "../server/remote/projection.js";
import { createRequestStore } from "../server/remote/requests.js";

const REF = "a".repeat(32);
const TAB = "b".repeat(32);
const SPACE = "c".repeat(32);
const FILE = "d".repeat(32);
const MOD = { ctrl: false, alt: false, shift: false, cmd: false };
const requireCjs = createRequire(import.meta.url);

function randomSequence() {
  let value = 1;
  return (size) => Buffer.alloc(size, value++);
}

function fixture() {
  const calls = [];
  const ok = () => ({ ok: true });
  const features = {
    terminal: {
      watch: async () => ({ revision: 2, text: "화면", truncated: false }),
      submit: async () => true, input: async () => true, key: async () => true,
      keys: () => ({ keys: [], defaults: [], macShortcuts: [] }),
      setKeys: (keys) => ({ keys, defaults: [], macShortcuts: [] }), closeConnection() {}, close() {}, available: () => true,
    },
    browser: {
      catalog: () => ({ spaces: [{ ref: SPACE, name: "작업" }], tabs: [{ ref: TAB, space: SPACE, title: "문서",
        url: "https://example.test", profile: "기본", aiControlled: false, controlling: [], active: true, sleeping: false }] }),
      watchFrame: async () => true, pointer: async () => ok(), mouse: async () => ok(), type: async () => ok(), key: async () => ok(),
      scroll: async () => ok(), history: async () => ok(), navigate: async () => ok(), newTab: async () => ok(),
      locate: async () => ({ ok: true, viewport: { width: 800, height: 600 }, element: { selector: "#save", text: "저장", rect: { x: 1, y: 2, width: 3, height: 4 } } }),
      hoverElement: async () => ({ ok: true, viewport: { width: 800, height: 600 }, element: { selector: "#save", text: "저장", rect: { x: 1, y: 2, width: 3, height: 4 } } }),
      focus: async () => ({ ok: true, focus: { editable: true, kind: "text", multiline: false, selectedText: "선택" } }),
      dialog: async () => ({ ok: true, dialog: { kind: "confirm", message: "계속할까요?" } }),
      pickElement: async () => ({ ok: true, draft: { ref: REF, kind: "element", summary: "저장",
        display: "⟦Iris⟧ 요소 선택 #p1 · 탭 문서 · https://example.test\n선택자: #save\n⟦/Iris⟧" } }),
      sendElement: async () => ({ ok: true, draft: { ref: REF, kind: "element", summary: "저장",
        display: "[브라우저 요소]\n글자: 저장" } }),
      recordStart: () => ({ steps: [], elapsedMs: 0 }), recordPause: () => ({ steps: ["클릭"], elapsedMs: 24000 }),
      recordFinish: async () => ({ ok: true, draft: { ref: REF, kind: "record", summary: "1단계",
        display: "[폰 브라우저 조작 기록]\n1. 클릭" } }),
      sendSketch: async () => ({ ok: true, draft: { ref: REF, kind: "sketch", summary: "문서",
        display: "[폰 화면 스케치]\n대상: 문서" } }), removeDraft: () => ({ ok: true }),
      profiles: () => ["기본"], setProfile: () => ({ ok: true, changed: true }), desktop: async () => ok(),
      translate: async () => ok(),
      bookmarks: () => [{ title: "문서", url: "https://example.test", folder: null }],
      setBookmark: () => ({ ok: true, changed: false }), direct: () => ({ ok: true, changed: true }),
      interactiveAvailable: () => true, closeConnection() {}, close() {},
    },
    source: {
      status: async () => ({ ok: true, data: { branch: "feature", ahead: 1, behind: 0,
        base: "main", commitCount: 2, additions: 12, deletions: 5,
        files: [{ ref: FILE, path: "src/a.js", code: "M", staged: false, untracked: false,
          additions: 12, deletions: 5 }], bases: ["main"] } }),
      diff: async () => ({ ok: true, patch: { text: "@@ -1 +1 @@", truncated: false } }),
      diffDraft: async () => ok(), pr: async () => ({ ok: true, pr: { number: 3, title: "PR", url: "https://github.com/o/r/pull/3",
        state: "OPEN", isDraft: false, head: "feature", base: "main", author: "dev", body: "", comments: [], reviews: [],
        reviewComments: [], files: [], checks: [], reviewCommentsLimited: false, reviewCommentsError: "" } }),
      checkLog: async () => ({ ok: true, log: { text: "실패", truncated: false } }), checkDraft: async () => ok(),
      gitAvailable: () => true, githubAvailable: () => true,
    },
    capabilities: () => REMOTE_REQUEST_TYPES.slice(8), closeConnection() {}, close() {},
  };
  const idleStore = { subscribe: () => () => {}, list: () => [], close() {}, closeConnection() {} };
  const operations = createRemoteOperations({ features, agents: idleStore, requests: idleStore,
    macName: async () => "MacBook Pro",
    transcripts: idleStore, messages: {}, send: (...args) => calls.push(args) });
  return { operations, calls, features };
}

const requests = [
  { type: "terminal.watch", rid: "1", agent: REF },
  { type: "terminal.input", rid: "2", agent: REF, text: "ls" },
  { type: "terminal.key", rid: "3", agent: REF, key: "Enter", modifiers: MOD },
  { type: "terminal.keys.get", rid: "4" },
  { type: "terminal.keys.set", rid: "5", keys: [{ id: "enter", label: "Enter", key: "Enter", modifiers: MOD }] },
  { type: "browser.tabs", rid: "6" },
  { type: "browser.frame.watch", rid: "7", tab: TAB, width: 390, fps: 2, desktop: false },
  { type: "browser.pointer", rid: "8", tab: TAB, x: 10, y: 20, width: 390, height: 800, action: "click" },
  { type: "browser.mouse", rid: "8m", tab: TAB, x: 10, y: 20, width: 390, height: 800, action: "move" },
  { type: "browser.mouse", rid: "8c", tab: TAB, x: 10, y: 20, width: 390, height: 800, action: "context" },
  { type: "browser.type", rid: "9", tab: TAB, text: "hello" },
  { type: "browser.key", rid: "10", tab: TAB, key: "Enter", modifiers: MOD },
  { type: "browser.scroll", rid: "11", tab: TAB, dy: 300 },
  { type: "browser.history", rid: "12", tab: TAB, action: "reload" },
  { type: "browser.navigate", rid: "13", tab: TAB, url: "https://example.test/next" },
  { type: "browser.tab.new", rid: "14", space: SPACE, url: "https://example.test" },
  { type: "browser.element", rid: "15", tab: TAB, x: 10, y: 20, width: 390, height: 800 },
  { type: "browser.element.hover", rid: "15h", tab: TAB, x: 10, y: 20, width: 390, height: 800 },
  { type: "browser.element.pick", rid: "15p", tab: TAB, agent: REF, x: 10, y: 20, width: 390, height: 800 },
  { type: "browser.focus", rid: "15f", tab: TAB },
  { type: "browser.dialog", rid: "15d", tab: TAB, action: "get" },
  { type: "browser.element.send", rid: "16", tab: TAB, agent: REF, x: 10, y: 20, width: 390, height: 800, text: "고쳐 주세요" },
  { type: "browser.record.start", rid: "17", tab: TAB },
  { type: "browser.record.pause", rid: "18", paused: true },
  { type: "browser.record.finish", rid: "19", agent: REF, note: "재현" },
  { type: "browser.sketch.send", rid: "20", agent: REF, tab: TAB, image: "data:image/png;base64,aGVsbG8=", text: "강조" },
  { type: "browser.draft.remove", rid: "20b", ref: REF },
  { type: "browser.profiles", rid: "21" },
  { type: "browser.profile.set", rid: "22", tab: TAB, profile: "기본" },
  { type: "browser.desktop", rid: "23", tab: TAB, enabled: true },
  { type: "browser.translate", rid: "24", tab: TAB },
  { type: "browser.bookmarks", rid: "25", space: SPACE },
  { type: "browser.bookmark.set", rid: "26", tab: TAB, bookmarked: true },
  { type: "browser.direct", rid: "27", tab: TAB },
  { type: "git.changes", rid: "28", agent: REF },
  { type: "git.diff", rid: "29", agent: REF, file: FILE, view: "working" },
  { type: "git.diff.draft", rid: "30", agent: REF, file: FILE, side: "new", line: 3, text: "검토" },
  { type: "github.pr", rid: "31", agent: REF },
  { type: "github.check.log", rid: "32", agent: REF, run: "123" },
  { type: "github.check.draft", rid: "33", agent: REF, run: "123", text: "고쳐 주세요" },
];

test("v6 요청은 모두 정확한 계약을 거쳐 처리표 결과를 만든다", async () => {
  const { operations } = fixture();
  for (const request of requests) {
    assert.equal(isRemoteRequest(request), true, request.type);
    const result = await operations.table.get(request.type)({ connId: "phone" }, request);
    assert.notEqual(result?.type, "error", request.type);
    assert.equal(JSON.stringify(result).includes("/private/secret"), false, request.type);
  }
  operations.close();
});

test("v6 요청은 모르는 키·위험한 URL·본문과 이미지 상한을 거부한다", () => {
  for (const request of requests) assert.equal(isRemoteRequest({ ...request, extra: true }), false, request.type);
  assert.equal(isRemoteRequest({ type: "terminal.input", rid: "x", agent: REF, text: "x".repeat(4001) }), false);
  assert.equal(isRemoteRequest({ type: "terminal.input", rid: "x", agent: REF, text: "a\t\r\nb" }), true);
  assert.equal(isRemoteRequest({ type: "terminal.input", rid: "x", agent: REF, text: "a\u0000b" }), false);
  assert.equal(isRemoteRequest({ type: "browser.navigate", rid: "x", tab: TAB, url: "file:///private/secret" }), false);
  assert.equal(isRemoteRequest({ type: "browser.frame.watch", rid: "x", tab: TAB, width: 2560, fps: 2, desktop: true }), true);
  assert.equal(isRemoteRequest({ type: "browser.frame.watch", rid: "x", tab: TAB, width: 2561, fps: 2, desktop: true }), false);
  assert.equal(isRemoteRequest({ type: "browser.mouse", rid: "x", tab: TAB,
    x: 10, y: 20, width: 390, height: 800, action: "wheel", dy: 120 }), true);
  assert.equal(isRemoteRequest({ type: "browser.mouse", rid: "x", tab: TAB,
    x: 10, y: 20, width: 390, height: 800, action: "move", dy: 120 }), false);
  assert.equal(isRemoteRequest({ type: "browser.mouse", rid: "x", tab: TAB,
    x: 10, y: 20, width: 390, height: 800, action: "wheel" }), false);
  assert.equal(isRemoteRequest({ type: "browser.dialog", rid: "x", tab: TAB,
    action: "accept", text: "입력" }), true);
  assert.equal(isRemoteRequest({ type: "browser.dialog", rid: "x", tab: TAB,
    action: "cancel", text: "입력" }), false);
  assert.equal(isRemoteRequest({ type: "browser.sketch.send", rid: "x", agent: REF, tab: TAB,
    image: `data:image/png;base64,${"A".repeat(49 * 1024)}`, text: "x" }), false);
  assert.equal(isRemoteRequest({ type: "git.diff.draft", rid: "x", agent: REF, file: FILE,
    side: "new", line: 0, text: "x" }), false);
  assert.throws(() => projectFeature({ type: "browser.tabs.result", rid: "x",
    spaces: [{ ref: SPACE, name: "작업", internalId: "secret" }], tabs: [] }), /projection/);
  assert.throws(() => projectFeature({ type: "browser.bookmarks.result", rid: "x",
    bookmarks: [{ title: "문서", url: "https://example.test", folder: null, path: "/private/secret" }] }), /projection/);
});

test("원격 문서는 terminal.input의 CR·LF·탭 허용 계약을 적는다", () => {
  const protocol = fs.readFileSync(new URL("../docs/remote-protocol.md", import.meta.url), "utf8");
  assert.match(protocol, /`terminal\.input`[^\n]+CR, LF, 탭을 허용/);
});

test("원격 문서는 마크다운 표시와 브라우저 실패 사유를 각각 계약한다", () => {
  const protocol = fs.readFileSync(new URL("../docs/remote-protocol.md", import.meta.url), "utf8");
  assert.match(protocol, /GitHub Flavored Markdown/);
  assert.match(protocol, /사용자가 이 버튼을 누를 때만/);
  assert.match(protocol, /이미지도 네트워크에서 받지 않는다/);
  for (const code of ["browser-controller-unavailable", "browser-tab-unavailable",
    "browser-frame-unavailable", "browser-command-unavailable"]) {
    assert.equal(protocol.includes("| `" + code + "` |"), true, code);
  }
  assert.match(protocol, /`browser\.mouse`[^\n]+`move`, `click`, `double`, `context`, `wheel`, `down`, `drag`, `up`/);
  assert.match(protocol, /`caps\.requests`에 `browser\.mouse`가 있으면 폰의 기본 브라우저 조작은 터치패드/);
});

test("터미널 재구독과 연결 종료는 읽는 중인 이전 구독을 되살리지 않는다", async () => {
  const timers = [];
  const reads = [];
  const agents = { resolve: (ref) => ({ source: { paneId: ref } }) };
  const terminal = createTerminalFeature({ agents,
    getHerdr: () => ({ paneRead: (paneId) => new Promise((resolve) => reads.push({ paneId, resolve })),
      paneSendText: async () => {} }),
    setTimer: (callback) => { const timer = { callback, unref() {} }; timers.push(timer); return timer; },
    clearTimer() {}, send() {}, keyRows: { get: () => ({}), set: () => ({}) } });

  const first = terminal.watch({ connId: "phone" }, REF);
  await Promise.resolve();
  const second = terminal.watch({ connId: "phone" }, "e".repeat(32));
  await Promise.resolve();
  reads[1].resolve({ revision: 2, text: "둘째" });
  assert.equal((await second).text, "둘째");
  reads[0].resolve({ revision: 1, text: "첫째" });
  assert.equal(await first, null);
  assert.equal(timers.length, 1);

  terminal.closeConnection("phone");
  const closing = terminal.watch({ connId: "phone" }, REF);
  await Promise.resolve();
  terminal.closeConnection("phone");
  reads[2].resolve({ revision: 3, text: "닫힘" });
  assert.equal(await closing, null);
  assert.equal(timers.length, 1);
  terminal.close();
});

test("터미널 보내기는 같은 pane에 Enter를 붙이고 바뀐 화면을 즉시 푸시한다", async () => {
  const paneCalls = [];
  const frames = [];
  let revision = 1;
  const terminal = createTerminalFeature({
    agents: { resolve: () => ({ source: { paneId: "pane-1" } }) },
    getHerdr: () => ({
      paneRead: async () => ({ revision, text: revision === 1 ? "$ " : "$ pwd\n/work\n" }),
      paneSendText: async (...args) => { paneCalls.push(args); revision = 2; },
    }),
    setTimer: () => ({ unref() {} }),
    clearTimer() {},
    send: (_connId, frame) => frames.push(frame),
    keyRows: { get: () => ({}), set: () => ({}) },
  });
  await terminal.watch({ connId: "phone" }, REF);
  assert.equal(await terminal.submit({ connId: "phone" }, REF, "pwd"), true);
  assert.deepEqual(paneCalls, [["pane-1", "\x1b[200~pwd\x1b[201~\r"]]);
  assert.equal(frames.at(-1).type, "terminal.frame");
  assert.match(frames.at(-1).text, /\$ pwd/);
  assert.equal(frames.at(-1).text.includes("/work"), false);
  assert.equal(frames.at(-1).text.split("\n")[1].length, 5);
  terminal.close();
});

test("2048자를 넘는 탭 주소 하나가 브라우저 탭 목록 응답 전체를 막지 않는다", () => {
  const long = `https://auth.example.test/callback?code=${"a".repeat(2100)}`;
  const state = { tabsBySpace: { work: [{ id: "tab-long", url: long }, { id: "tab-short", url: "https://example.test/" }] },
    activeBySpace: {}, profiles: [] };
  const browser = createBrowserFeature({ randomBytes: randomSequence(), browserState: () => state,
    runtimeSnapshot: () => ({ workspaces: [{ id: "work", label: "작업" }] }),
    tabMeta: () => ({}), controlSnapshot: () => [], send() {}, agents: {}, messages: {} });
  const catalog = browser.catalog();
  assert.doesNotThrow(() => projectFeature({ type: "browser.tabs.result", rid: "r1", ...catalog }));
  assert.deepEqual(catalog.tabs.map((tab) => tab.url), ["", "https://example.test/"]);
  assert.equal(publicHttpUrl(long), "");
  browser.close();
});

test("브라우저 재구독은 읽는 중인 이전 탭의 프레임과 타이머를 남기지 않는다", async () => {
  const timers = [];
  const captures = [];
  const sent = [];
  const state = { tabsBySpace: { work: [{ id: "tab-one" }, { id: "tab-two" }] }, activeBySpace: {}, profiles: [] };
  const browser = createBrowserFeature({ randomBytes: randomSequence(), browserState: () => state,
    runtimeSnapshot: () => ({ workspaces: [{ id: "work", label: "작업" }] }),
    tabMeta: () => ({ wc: 1 }), controlSnapshot: () => [], cdpReady: () => true,
    captureFrame: (tab) => new Promise((resolve) => captures.push({ id: tab.id, resolve })),
    setTimer: (callback) => { const timer = { callback, unref() {} }; timers.push(timer); return timer; },
    clearTimer() {}, send: (_connId, value) => sent.push(value), agents: {}, messages: {} });
  const tabs = browser.catalog().tabs;
  const first = browser.watchFrame({ connId: "phone" }, { tab: tabs[0].ref, width: 390, fps: 2, desktop: false });
  await Promise.resolve();
  const second = browser.watchFrame({ connId: "phone" }, { tab: tabs[1].ref, width: 390, fps: 2, desktop: false });
  await Promise.resolve();
  captures.find((item) => item.id === "tab-one").resolve({ bytes: Buffer.from("old"), width: 390, height: 800 });
  captures.find((item) => item.id === "tab-two").resolve({ bytes: Buffer.from("new"), width: 390, height: 800 });
  assert.deepEqual(await first, { ok: false, code: "browser-frame-unavailable" });
  assert.deepEqual(await second, { ok: true });
  assert.equal(timers.length, 1);
  assert.deepEqual(sent.map((item) => item.tab), [tabs[1].ref]);
  browser.close();
});

test("브라우저 구독은 잠든 탭을 기존 소유 함수로 깨우고 첫 프레임 뒤 수락한다", async () => {
  const timers = [];
  const sent = [];
  const wakes = [];
  let wc = null;
  const state = { tabsBySpace: { work: [{ id: "sleeping-tab" }] }, activeBySpace: {}, profiles: [] };
  const browser = createBrowserFeature({
    randomBytes: randomSequence(), browserState: () => state,
    runtimeSnapshot: () => ({ workspaces: [{ id: "work", label: "작업" }] }),
    tabMeta: () => ({ wc }), controlSnapshot: () => [], cdpReady: () => true,
    wakeSleepingTab: (id) => wakes.push(id),
    waitForTabWc: async (id, timeout) => { assert.equal(id, "sleeping-tab"); assert.equal(timeout, 12_000); wc = 42; return wc; },
    captureFrame: async (tab) => ({ ok: true, bytes: Buffer.from("first"), width: 390, height: 800, tab }),
    setTimer: (callback) => { const timer = { callback, unref() {} }; timers.push(timer); return timer; },
    clearTimer() {}, send: (_connId, value) => sent.push(value), agents: {}, messages: {},
  });
  const tab = browser.catalog().tabs[0];
  assert.equal(tab.sleeping, true);
  assert.deepEqual(await browser.watchFrame({ connId: "phone" }, {
    tab: tab.ref, width: 390, fps: 2, desktop: false,
  }), { ok: true });
  assert.deepEqual(wakes, ["sleeping-tab"]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].tab, tab.ref);
  assert.equal(timers.length, 1);
  browser.close();
});

test("브라우저 구독은 제어기·탭 깨우기·첫 캡처 실패를 구분한다", async () => {
  const state = { tabsBySpace: { work: [{ id: "tab-one" }] }, activeBySpace: {}, profiles: [] };
  const makeBrowser = ({ ready = true, wc = 1, waited = 1, frame = null } = {}) => {
    let currentWc = wc;
    const browser = createBrowserFeature({
      randomBytes: randomSequence(), browserState: () => state,
      runtimeSnapshot: () => ({ workspaces: [{ id: "work", label: "작업" }] }),
      tabMeta: () => ({ wc: currentWc }), controlSnapshot: () => [], cdpReady: () => ready,
      wakeSleepingTab() {}, waitForTabWc: async () => { currentWc = waited; return waited; },
      captureFrame: async () => frame,
      setTimer: () => { throw new Error("실패한 구독이 타이머를 남김"); }, clearTimer() {},
      send() { throw new Error("실패한 구독이 프레임을 보냄"); }, agents: {}, messages: {},
    });
    browser.catalog();
    return browser;
  };
  const request = (browser) => ({ tab: browser.catalog().tabs[0].ref, width: 390, fps: 2, desktop: false });

  const controller = makeBrowser({ ready: false });
  assert.deepEqual(await controller.watchFrame({ connId: "phone" }, request(controller)),
    { ok: false, code: "browser-controller-unavailable" });
  controller.close();

  const sleeping = makeBrowser({ wc: null, waited: null });
  assert.deepEqual(await sleeping.watchFrame({ connId: "phone" }, request(sleeping)),
    { ok: false, code: "browser-tab-unavailable" });
  sleeping.close();

  const capture = makeBrowser({ frame: { ok: false, code: "browser-frame-unavailable" } });
  assert.deepEqual(await capture.watchFrame({ connId: "phone" }, request(capture)),
    { ok: false, code: "browser-frame-unavailable" });
  capture.close();
});

test("브라우저 CDP 실패와 프레임 구독 실패 코드는 원격 응답에 보존된다", async () => {
  const state = { tabsBySpace: { work: [{ id: "tab-one" }] }, activeBySpace: {}, profiles: [] };
  const browser = createBrowserFeature({
    randomBytes: randomSequence(), browserState: () => state,
    runtimeSnapshot: () => ({ workspaces: [{ id: "work", label: "작업" }] }),
    tabMeta: () => ({ wc: 42 }), controlSnapshot: () => [], cdpReady: () => true,
    requestCdp: async () => ({ ok: false, error: "timeout" }),
    captureFrame: async () => ({ ok: false, code: "browser-frame-unavailable" }),
    setTimer: () => ({ unref() {} }), clearTimer() {}, send() {}, agents: {}, messages: {},
  });
  const tab = browser.catalog().tabs[0].ref;
  assert.deepEqual(await browser.type({ connId: "phone" }, { tab, text: "x" }),
    { ok: false, code: "browser-command-unavailable" });

  const { operations, features } = fixture();
  features.browser.watchFrame = async () => ({ ok: false, code: "browser-frame-unavailable" });
  const result = await operations.table.get("browser.frame.watch")({ connId: "phone" }, {
    type: "browser.frame.watch", rid: "frame-error", tab: TAB, width: 390, fps: 2, desktop: false,
  });
  assert.deepEqual(result, { type: "error", rid: "frame-error", error: { code: "browser-frame-unavailable" } });
  operations.close();
  browser.close();
});

test("브라우저 프레임은 절대 스크린샷 경로만 변환한다", async () => {
  const state = { tabsBySpace: { work: [{ id: "tab-one" }] }, activeBySpace: {}, profiles: [] };
  let converted = false;
  const browser = createBrowserFeature({
    randomBytes: randomSequence(), browserState: () => state, stateDir: "/tmp",
    runtimeSnapshot: () => ({ workspaces: [{ id: "work", label: "작업" }] }),
    tabMeta: () => ({ wc: 42 }), controlSnapshot: () => [], cdpReady: () => true,
    requestCdp: async () => ({ ok: true, data: { path: "relative.png" } }),
    execFile: () => { converted = true; }, setTimer: () => ({ unref() {} }), clearTimer() {},
    send() {}, agents: {}, messages: {},
  });
  const tab = browser.catalog().tabs[0].ref;
  assert.deepEqual(await browser.watchFrame({ connId: "phone" }, {
    tab, width: 390, fps: 2, desktop: false,
  }), { ok: false, code: "browser-frame-unavailable" });
  assert.equal(converted, false);
  browser.close();
});

test("브라우저 프레임은 sips 실패와 384 KiB 초과를 같은 공개 사유로 구분한다", async (t) => {
  const state = { tabsBySpace: { work: [{ id: "tab-one" }] }, activeBySpace: {}, profiles: [] };
  const stateDirs = [];
  t.after(() => {
    for (const directory of stateDirs) fs.rmSync(directory, { recursive: true, force: true });
  });
  const makeBrowser = (execFile) => {
    const stateDir = fs.mkdtempSync("/tmp/iris-remote-v6-");
    stateDirs.push(stateDir);
    const browser = createBrowserFeature({
      randomBytes: randomSequence(), browserState: () => state, stateDir,
      runtimeSnapshot: () => ({ workspaces: [{ id: "work", label: "작업" }] }),
      tabMeta: () => ({ wc: 42 }), controlSnapshot: () => [], cdpReady: () => true,
      requestCdp: async () => ({ ok: true, data: { path: "/tmp/source.png" } }), execFile,
      setTimer: () => ({ unref() {} }), clearTimer() {}, send() {}, agents: {}, messages: {},
    });
    const tab = browser.catalog().tabs[0].ref;
    return { browser, request: { tab, width: 390, fps: 2, desktop: false } };
  };

  const failed = makeBrowser((_file, _args, _options, callback) => callback(new Error("sips failed")));
  assert.deepEqual(await failed.browser.watchFrame({ connId: "phone" }, failed.request),
    { ok: false, code: "browser-frame-unavailable" });
  failed.browser.close();

  const calls = [];
  const oversized = makeBrowser((file, args, options, callback) => {
    calls.push({ file, args, options });
    fs.writeFileSync(args.at(-1), Buffer.alloc(MAX_BROWSER_FRAME_JPEG_BYTES + 1));
    callback(null, "", "");
  });
  assert.deepEqual(await oversized.browser.watchFrame({ connId: "phone" }, oversized.request),
    { ok: false, code: "browser-frame-unavailable" });
  assert.equal(calls.length, 16);
  assert.equal(calls.every((call) => call.file === "/usr/bin/sips"), true);
  assert.equal(calls.every((call) => call.options.timeout === 3_000), true);
  oversized.browser.close();
});

test("브라우저 결과는 연결·에이전트에 묶고 메시지를 보낼 때 원문으로 푼다", async () => {
  const state = { tabsBySpace: { work: [{ id: "tab-one" }] }, activeBySpace: {}, profiles: [] };
  const agent = { kind: "codex", source: { paneId: "pane-one", sessionUuid: "11111111-1111-4111-8111-111111111111" } };
  let command = 0;
  const browser = createBrowserFeature({
    randomBytes: randomSequence(), browserState: () => state,
    runtimeSnapshot: () => ({ workspaces: [{ id: "work", label: "작업" }] }),
    tabMeta: () => ({ wc: 42 }), controlSnapshot: () => [], cdpReady: () => true,
    requestCdp: async () => ++command === 1
      ? { ok: true, data: { value: { width: 800, height: 600 } } }
      : { ok: true, data: { value: { selector: "#save", text: "저장 버튼",
        rect: { x: 1, y: 2, width: 3, height: 4 } } } },
    agents: { resolve: (ref) => ref === REF ? agent : null }, send() {},
  });
  const tab = browser.catalog().tabs[0].ref;
  const created = await browser.sendElement({ connId: "phone-one" }, {
    tab, agent: REF, x: 10, y: 20, width: 400, height: 300, text: "고쳐 주세요",
  });
  assert.equal(created.ok, true);
  assert.equal(created.draft.summary, "저장 버튼");
  assert.equal(created.draft.display.includes("#save"), true);
  assert.equal(browser.expandDrafts("phone-two", REF, [created.draft.ref], "요청").ok, false);
  assert.equal(browser.expandDrafts("phone-one", "f".repeat(32), [created.draft.ref], "요청").ok, false);

  const sent = [];
  const operation = createMessageOperation({
    agents: { resolve: (ref) => ref === REF ? agent : null },
    messages: { send: async (_agent, text) => { sent.push(text); return "sent"; } },
    browserDrafts: browser,
    transcripts: { refreshAgent() {} },
  });
  assert.deepEqual(await operation({ connId: "phone-one" }, {
    rid: "message", agent: REF, text: "요청", drafts: [created.draft.ref],
  }), { type: "agent.message.result", rid: "message", result: "sent" });
  assert.equal(sent[0], "요청\n\n[브라우저 요소]\n선택자: #save\n글자: 저장 버튼\n영역: 1,2 3×4\n\n고쳐 주세요");
  assert.equal(browser.expandDrafts("phone-one", REF, [created.draft.ref], "").ok, false);
  browser.close();
});

test("페이지 포커스·요소 호버·연속 선택은 폰 계약과 데스크톱 선택 본문을 유지한다", async () => {
  const state = { tabsBySpace: { work: [{ id: "tab-one", name: "문서" }] }, activeBySpace: { work: "tab-one" }, profiles: [] };
  const agent = { kind: "codex", source: { paneId: "pane-one", sessionUuid: "11111111-1111-4111-8111-111111111111" } };
  const values = [
    { editable: true, kind: "text", multiline: false, selectedText: "고른 글" },
    { viewport: { width: 800, height: 600 }, pick: { tag: "button", id: "save", cls: ["primary"],
      selector: "#save", usel: "#save", text: "저장", attrs: ["id=\"save\""],
      title: "문서", html: '<button id="save" class="primary">저장</button>',
      src: { file: "src/SaveButton.tsx", line: 12, component: "SaveButton", framework: "react" },
      url: "https://example.test/page", pageUrl: "https://example.test/page", rect: { x: 10, y: 20, width: 100, height: 40 } } },
    { viewport: { width: 800, height: 600 }, pick: { tag: "button", id: "save", cls: ["primary"],
      selector: "#save", usel: "#save", text: "저장", attrs: ["id=\"save\""],
      title: "문서", html: '<button id="save" class="primary">저장</button>',
      src: { file: "src/SaveButton.tsx", line: 12, component: "SaveButton", framework: "react" },
      url: "https://example.test/page", pageUrl: "https://example.test/page", rect: { x: 10, y: 20, width: 100, height: 40 } } },
  ];
  let issuedTarget;
  const browser = createBrowserFeature({
    randomBytes: randomSequence(), browserState: () => state,
    runtimeSnapshot: () => ({ workspaces: [{ id: "work", label: "작업" }] }),
    tabMeta: () => ({ wc: 42, title: "문서", url: "https://example.test/page" }),
    controlSnapshot: () => [], cdpReady: () => true,
    requestCdp: async (cmd) => cmd === "screenshot"
      ? { ok: true, data: { path: "/work/.iris/picks/p1.png" } }
      : { ok: true, data: { value: values.shift() } },
    resolvePickSource: async () => ({ root: "/work", copy: null, local: true, host: "example.test", port: 443,
      why: null, markup: [{ file: "src/page.html", line: 7 }],
      style: [{ file: "src/page.css", line: 9 }], script: [{ file: "src/page.js", line: 11 }] }),
    handleForTab: () => "work-tab-A1B2C3",
    aiTargetsSnapshot: () => [],
    issuePromptTarget: (value) => {
      issuedTarget = value;
      return { delimiter: "@work-tab-A1B2C3~nonce1234" };
    },
    noteBrowserPick: () => {},
    agents: { resolve: (ref) => ref === REF ? agent : null }, send() {},
  });
  const tab = browser.catalog().tabs[0].ref;
  assert.deepEqual(await browser.focus(tab), { ok: true,
    focus: { editable: true, kind: "text", multiline: false, selectedText: "고른 글" } });
  const hovered = await browser.hoverElement(tab, { x: 20, y: 30, width: 400, height: 300 });
  assert.equal(hovered.element.selector, "#save");
  assert.deepEqual(hovered.viewport, { width: 800, height: 600 });
  const picked = await browser.pickElement({ connId: "phone" }, {
    tab, agent: REF, x: 20, y: 30, width: 400, height: 300,
  });
  assert.equal(picked.ok, true, JSON.stringify(picked));
  assert.deepEqual({ pane: issuedTarget.pane, kind: issuedTarget.kind, ref: issuedTarget.ref,
    target: issuedTarget.target }, {
    pane: "pane-one", kind: "element", ref: "@work-tab-A1B2C3", target: { tabId: "tab-one" },
  });
  assert.match(picked.draft.display, /^⟦Iris⟧ 요소 선택 #p1 · 탭 @work-tab-A1B2C3  문서 · https:\/\/example\.test\/page/m);
  assert.match(picked.draft.display, /등록 구분자: @work-tab-A1B2C3~nonce1234/);
  assert.match(picked.draft.display, /소스: src\/SaveButton\.tsx:12 \(react dev\)/);
  assert.match(picked.draft.display, /컴포넌트: <SaveButton> \(react\)/);
  assert.match(picked.draft.display, /스타일: src\/page\.css:9/);
  assert.match(picked.draft.display, /동작: src\/page\.js:11/);
  assert.match(picked.draft.display, /요소 코드: <button id="save" class="primary">저장<\/button>/);
  assert.match(picked.draft.body, /요소 그림: \/work\/\.iris\/picks\/p1\.png/);
  assert.match(picked.draft.display, /요소 그림: \[Mac 경로\]/);
  assert.equal(picked.draft.display.includes("/work"), false);
  assert.match(picked.draft.display, /⟦\/Iris⟧$/);
  browser.close();
});

test("브라우저 포인터는 프레임 좌표를 페이지 좌표로 바꿔 Iris CDP 소유 함수에 클릭을 보낸다", async () => {
  const calls = [];
  const state = { tabsBySpace: { work: [{ id: "tab-one" }] }, activeBySpace: {}, profiles: [] };
  const browser = createBrowserFeature({
    randomBytes: randomSequence(),
    browserState: () => state,
    runtimeSnapshot: () => ({ workspaces: [{ id: "work", label: "작업" }] }),
    tabMeta: () => ({ wc: 42, url: "https://example.test/start" }),
    controlSnapshot: () => [],
    cdpReady: () => true,
    requestCdp: async (cmd, args, wc, timeout) => {
      calls.push({ cmd, args, wc, timeout });
      if (calls.length === 1) return { ok: true, data: { value: { width: 800, height: 600 } } };
      if (calls.length === 2) return { ok: true, data: { value: {
        selector: "#next", text: "다음", rect: { x: 390, y: 290, width: 20, height: 20 },
      } } };
      return { ok: true, data: {} };
    },
    agents: {}, messages: {}, send() {},
  });
  const tab = browser.catalog().tabs[0].ref;
  const result = await browser.pointer({ connId: "registered-phone" }, {
    tab, x: 200, y: 150, width: 400, height: 300, action: "click",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls[0], { cmd: "eval", args: { expression: "({width:innerWidth,height:innerHeight})" }, wc: 42, timeout: 30_000 });
  assert.match(calls[1].args.expression, /\{"x":400,"y":300\}/);
  assert.deepEqual(calls[2], { cmd: "click", args: { sel: "#next" }, wc: 42, timeout: 30_000 });
  browser.close();
});

test("브라우저 마우스는 프레임 좌표를 CSS 좌표로 바꿔 좌표 명령을 보낸다", async () => {
  const calls = [];
  const state = { tabsBySpace: { work: [{ id: "tab-one" }] }, activeBySpace: {}, profiles: [] };
  const browser = createBrowserFeature({
    randomBytes: randomSequence(), browserState: () => state,
    runtimeSnapshot: () => ({ workspaces: [{ id: "work", label: "작업" }] }),
    tabMeta: () => ({ wc: 42 }), controlSnapshot: () => [], cdpReady: () => true,
    requestCdp: async (cmd, args, wc, timeout) => {
      calls.push({ cmd, args, wc, timeout });
      if (cmd === "eval") return { ok: true, data: { value: { width: 1200, height: 900 } } };
      return { ok: true, data: {} };
    },
    agents: {}, messages: {}, send() {},
  });
  const tab = browser.catalog().tabs[0].ref;
  const result = await browser.mouse({ connId: "registered-phone" }, {
    tab, x: 300, y: 200, width: 600, height: 400, action: "wheel", dy: 180,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls[0], { cmd: "eval", args: { expression: "({width:innerWidth,height:innerHeight})" }, wc: 42, timeout: 30_000 });
  assert.deepEqual(calls[1], { cmd: "mouse", args: { action: "wheel", x: 600, y: 450, dy: 180 }, wc: 42, timeout: 30_000 });
  browser.close();
});

test("CDP 좌표 마우스 명령은 이동·클릭·드래그·휠을 실제 Input 이벤트로 보낸다", async () => {
  const { dispatchMouse } = requireCjs("../native/electron/cdp-cmd-input.cjs");
  const calls = [];
  const send = async (method, params) => { calls.push({ method, params }); return {}; };

  await dispatchMouse(send, { action: "move", x: 12.5, y: 24.5 });
  await dispatchMouse(send, { action: "click", x: 20, y: 30 });
  await dispatchMouse(send, { action: "double", x: 22, y: 32 });
  await dispatchMouse(send, { action: "context", x: 23, y: 33 });
  await dispatchMouse(send, { action: "down", x: 24, y: 34 });
  await dispatchMouse(send, { action: "drag", x: 30, y: 40 });
  await dispatchMouse(send, { action: "up", x: 30, y: 40 });
  await dispatchMouse(send, { action: "wheel", x: 20, y: 30, dy: -160 });

  assert.deepEqual(calls.map((call) => call.params.type), [
    "mouseMoved",
    "mouseMoved", "mousePressed", "mouseReleased",
    "mouseMoved", "mousePressed", "mouseReleased",
    "mouseMoved", "mousePressed", "mouseReleased",
    "mousePressed", "mouseMoved", "mouseReleased",
    "mouseMoved", "mouseWheel",
  ]);
  assert.equal(calls[5].params.clickCount, 2);
  assert.equal(calls[8].params.button, "right");
  assert.deepEqual(calls[11].params, {
    type: "mouseMoved", x: 30, y: 40, button: "left", buttons: 1,
  });
  assert.deepEqual(calls.at(-1).params, {
    type: "mouseWheel", x: 20, y: 30, deltaX: 0, deltaY: -160,
  });
});

test("폰 페이지 키는 전용 명령으로 contenteditable 편집과 커서 이동을 실행한다", async () => {
  const state = { tabsBySpace: { work: [{ id: "tab-one" }] }, activeBySpace: {}, profiles: [] };
  const calls = [];
  const browser = createBrowserFeature({
    randomBytes: randomSequence(), browserState: () => state,
    runtimeSnapshot: () => ({ workspaces: [{ id: "work", label: "작업" }] }),
    tabMeta: () => ({ wc: 42 }), controlSnapshot: () => [], cdpReady: () => true,
    requestCdp: async (cmd, args, wc, timeout) => {
      calls.push({ cmd, args, wc, timeout });
      return { ok: true, data: {} };
    },
    agents: {}, messages: {}, send() {},
  });
  const tab = browser.catalog().tabs[0].ref;
  assert.deepEqual(await browser.key({ connId: "phone" }, { tab, key: "Backspace", modifiers: MOD }), {
    ok: true, data: {},
  });
  assert.deepEqual(calls, [{ cmd: "phonekey", args: { key: "Backspace" }, wc: 42, timeout: 30_000 }]);
  browser.close();

  const { createInputCommands } = requireCjs("../native/electron/cdp-cmd-input.cjs");
  const edits = [];
  const moves = [];
  const selection = { modify: (...args) => moves.push(args) };
  const ownerDocument = {
    getSelection: () => selection,
    execCommand: (command) => { edits.push(command); return true; },
  };
  const element = {
    tagName: "DIV", isContentEditable: true, ownerDocument,
    dispatchEvent: () => true,
  };
  const document = {
    activeElement: element, body: {}, documentElement: {}, querySelectorAll: () => [],
  };
  class DomEvent { constructor(_name, init = {}) { Object.assign(this, init); } }
  const send = async (method, params) => {
    assert.equal(method, "Runtime.evaluate");
    return { result: { value: vm.runInNewContext(params.expression, {
      document, KeyboardEvent: DomEvent, InputEvent: DomEvent, Event: DomEvent,
    }) } };
  };
  const commands = createInputCommands({});
  assert.equal((await commands.phonetype(send, {}, { text: "한글" })).typed, 2);
  assert.equal((await commands.phonekey(send, {}, { key: "Backspace" })).did, "편집");
  assert.deepEqual(edits, ["insertText", "delete"]);
  assert.equal((await commands.phonekey(send, {}, { key: "ArrowLeft" })).did, "커서 이동");
  assert.deepEqual(moves, [["move", "backward", "character"]]);

  const frameKeySend = async () => ({ result: { value: { ok: false, error: "입력 초점이 없습니다" } } });
  frameKeySend.frames = () => [null, "child-frame"];
  frameKeySend.on = (sid) => sid == null ? frameKeySend : send;
  assert.equal((await commands.phonekey(frameKeySend, {}, { key: "Delete" })).did, "편집");
  assert.deepEqual(edits, ["insertText", "delete", "forwardDelete"]);

  const frameSend = async () => ({ result: { value: {
    editable: false, kind: "none", multiline: false, selectedText: "",
  } } });
  frameSend.frames = () => [null, "child-frame"];
  frameSend.on = (sid) => async () => ({ result: { value: sid == null ? {
    editable: false, kind: "none", multiline: false, selectedText: "",
  } : {
    editable: true, kind: "multiline", multiline: true, selectedText: "iframe 글",
  } } });
  assert.deepEqual(await commands.phonefocus(frameSend), {
    ok: true, editable: true, kind: "multiline", multiline: true, selectedText: "iframe 글",
  });
});

test("폰 브라우저 대화상자는 조회하고 응답한 뒤 남은 창을 다시 확인한다", async () => {
  const state = { tabsBySpace: { work: [{ id: "tab-one" }] }, activeBySpace: {}, profiles: [] };
  const calls = [];
  const browser = createBrowserFeature({
    randomBytes: randomSequence(), browserState: () => state,
    runtimeSnapshot: () => ({ workspaces: [{ id: "work", label: "작업" }] }),
    tabMeta: () => ({ wc: 42 }), controlSnapshot: () => [], cdpReady: () => true,
    requestCdp: async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "dialoginfo") return { ok: true, data: { dialog: calls.length === 1
        ? { kind: "prompt", message: "이름" } : null } };
      return { ok: true, data: {} };
    },
    agents: {}, messages: {}, send() {},
  });
  const tab = browser.catalog().tabs[0].ref;
  assert.deepEqual(await browser.dialog({ tab, action: "get" }), {
    ok: true, dialog: { kind: "prompt", message: "이름" },
  });
  assert.deepEqual(await browser.dialog({ tab, action: "accept", text: "홍길동" }), {
    ok: true, dialog: null,
  });
  assert.deepEqual(calls, [
    { cmd: "dialoginfo", args: {} },
    { cmd: "dialog", args: { answer: "ok", text: "홍길동" } },
    { cmd: "dialoginfo", args: {} },
  ]);
  browser.close();

  const { createNativeCommands } = requireCjs("../native/electron/cdp-cmd-native.cjs");
  let open = { type: "prompt", message: "이름" };
  const handled = [];
  const native = createNativeCommands({
    observation: {
      dialogOpen: () => open,
      closeDialog: () => { open = null; },
    },
  });
  assert.deepEqual(await native.dialoginfo(null, { id: 42 }), {
    ok: true, dialog: { kind: "prompt", message: "이름" },
  });
  assert.deepEqual(await native.dialog(async (method, params) => {
    handled.push({ method, params });
  }, { id: 42 }, { answer: "ok", text: "홍길동" }), {
    ok: true, answered: "ok", kind: "prompt", message: "이름",
  });
  assert.deepEqual(handled, [{
    method: "Page.handleJavaScriptDialog", params: { accept: true, promptText: "홍길동" },
  }]);
});

test("사람 차례는 첫 답 뒤 같은 알림에 새 ref를 만들지 않고 공개 글만 보낸다", async () => {
  const session = "w1:p7";
  const uuid = "01234567-89ab-4def-8123-456789abcdef";
  const notice = { id: "ask-review", session, wait: 30,
    title: `로그인 ${session} /Users/you/project ${uuid}`,
    text: `완료 후 ${session} /Users/you/project/file ${uuid}`, tabId: null };
  const callbacks = [];
  const delivered = [];
  const store = createRequestStore({ randomBytes: randomSequence(), setTimer: () => ({ unref() {} }), clearTimer() {} });
  const features = createRemoteFeatures({ requests: store, agents: { resolvePane: () => ({ ref: REF }) },
    pendingUserNotices: () => [notice], answerUserAsk: (_id, answer) => delivered.push(answer),
    askSetTimer: (callback) => { callbacks.push(callback); return { unref() {} }; }, askClearTimer() {},
    terminalFeature: { available: () => false, closeConnection() {}, close() {} },
    browserFeature: { refForTabId: () => null, interactiveAvailable: () => false, closeConnection() {}, close() {} },
    sourceControlFeature: { gitAvailable: () => false, githubAvailable: () => false } });
  const first = store.list()[0];
  assert.equal(JSON.stringify(first).includes("/Users/you/project"), false);
  assert.equal(JSON.stringify(first).includes(session), false);
  assert.equal(JSON.stringify(first).includes(uuid), false);
  assert.equal(await store.answer(first.ref, { choice: "done" }), "delivered");
  callbacks[0]();
  assert.deepEqual(store.list(), []);
  assert.equal(await store.answer(first.ref, { choice: "unable" }), "already-answered");
  assert.deepEqual(delivered, ["다 했음"]);
  features.close();
  store.close();
});

test("폰으로 보내는 글은 Mac 절대 경로를 숨기고 공개 URL만 유지한다", () => {
  assert.equal(redactMacPaths("오류 /Users/you/project/a.js:3 및 https://example.test/a"),
    "오류 [Mac 경로] 및 https://example.test/a");
  assert.equal(publicHttpUrl("file:///Users/you/secret.html"), "");
  assert.equal(publicHttpUrl("https://example.test/path"), "https://example.test/path");
});

test("실제 기능 투영은 pane·탭·스페이스 ID와 절대 경로를 내보내지 않는다", async () => {
  const paneId = "w1:p7";
  const sessionUuid = "01234567-89ab-4def-8123-456789abcdef";
  const terminal = createTerminalFeature({
    agents: { resolve: () => ({ source: { paneId, sessionUuid } }) },
    getHerdr: () => ({ paneRead: async (_pane, source, format, stripAnsi) => {
      assert.deepEqual([source, format, stripAnsi], ["visible", "ansi", false]);
      return { text: `\x1b[31mcwd /Users/you/secret\x1b[0m\n\x1b]0;secret\x07pane ${paneId}\nsession ${sessionUuid}`, revision: 4 };
    },
      paneSendText: async () => {} }),
    setTimer: () => ({ unref() {} }), clearTimer() {}, send() {},
    keyRows: { get: () => ({ keys: [], defaults: [], macShortcuts: [] }), set: () => ({}) },
  });
  const frame = await terminal.watch({ connId: "phone" }, REF);
  assert.equal(frame.text.includes("/Users/you/secret"), false);
  assert.equal(frame.text.includes(paneId), false);
  assert.equal(frame.text.includes(sessionUuid), false);
  assert.equal(frame.text.includes("\x1b[31m"), true);
  assert.equal(frame.text.includes("\x1b]"), false);
  assert.equal("paneId" in frame, false);
  terminal.close();

  const state = { tabsBySpace: { "space-internal": [{ id: "tab-internal", url: "file:///Users/you/secret.html" }] },
    activeBySpace: { "space-internal": "tab-internal" }, profiles: [] };
  let translated = false;
  const browser = createBrowserFeature({ randomBytes: randomSequence(), browserState: () => state,
    runtimeSnapshot: () => ({ workspaces: [{ id: "space-internal", label: "작업" }] }),
    tabMeta: () => ({ wc: 7, title: "문서", url: "file:///Users/you/secret.html" }),
    controlSnapshot: () => [{ tabId: "tab-internal", labels: [paneId] }], cdpReady: () => true,
    requestCdp: async (cmd, args) => { translated = cmd === "eval" && args.expression.includes("__irisPageTranslateV1");
      return { ok: true, data: { value: { ok: true } } }; }, agents: {}, messages: {}, send() {},
  });
  const catalog = browser.catalog();
  const encoded = JSON.stringify(catalog);
  assert.equal(encoded.includes("tab-internal"), false);
  assert.equal(encoded.includes("space-internal"), false);
  assert.equal(encoded.includes(paneId), false);
  assert.equal(catalog.tabs[0].url, "");
  assert.deepEqual(catalog.tabs[0].controlling, ["에이전트"]);
  assert.equal((await browser.translate({ tab: catalog.tabs[0].ref })).ok, true);
  assert.equal(translated, true, "기존 페이지 번역 스크립트를 실행한다");
  browser.close();
});

test("Git·GitHub 기능은 소유 함수를 호출하고 절대 경로를 제거한다", async () => {
  const agent = { status: "idle", source: { cwd: "/Users/you/project" } };
  const agents = { resolve: () => agent };
  const gitHandler = async (ws, message) => ws.send(JSON.stringify(message.type === "git.status"
    ? { type: "git-status", isRepo: true, root: "/Users/you/project", branch: "feature", ahead: 0, behind: 0,
      staged: [], changes: [{ rel: "src/a.js", code: "U", untracked: true }], base: "main", branches: ["main"] }
    : { type: "git-diff", patch: "diff --git a/Users/you/project/src/a.js b/Users/you/project/src/a.js\n"
      + "--- /dev/null\n+++ b/Users/you/project/src/a.js\n@@ -0,0 +1 @@\n+새 파일" }));
  const githubHandler = async (ws, message) => ws.send(JSON.stringify(message.type === "githubpr.status"
    ? { ok: true, pr: { root: "/Users/you/project", number: 2, title: "PR", body: "log /Users/you/project/a.js",
      comments: [], reviews: [], reviewComments: [], files: [], checks: [] } }
    : { ok: true, log: "failed at /Users/you/project/a.js" }));
  const source = createSourceControlFeature({ agents, randomBytes: randomSequence(), gitHandler, githubHandler,
    runtimeSnapshot: () => ({ workspaces: [] }), getHerdr: () => ({}), gitExecutable: "/usr/bin/git",
    execFileSync: (_file, args) => args[0] === "rev-list" ? "3\n" : "12\t5\tsrc/a.js\n" });
  const status = await source.status(REF);
  assert.equal(status.ok, true);
  assert.equal(JSON.stringify(status.data).includes("/Users/you/project"), false);
  assert.deepEqual({ base: status.data.base, commitCount: status.data.commitCount,
    additions: status.data.additions, deletions: status.data.deletions },
  { base: "main", commitCount: 3, additions: 12, deletions: 5 });
  assert.deepEqual({ additions: status.data.files[0].additions, deletions: status.data.files[0].deletions },
    { additions: 12, deletions: 5 });
  const diff = await source.diff({ agent: REF, file: status.data.files[0].ref, view: "working" });
  assert.equal(diff.ok, true);
  assert.match(diff.patch.text, /^diff --git a\/src\/a\.js b\/src\/a\.js/m);
  assert.match(diff.patch.text, /^\+\+\+ b\/src\/a\.js/m);
  assert.equal(diff.patch.text.includes("/Users/you/project"), false);
  const pr = await source.pr(REF);
  assert.equal(pr.ok, true);
  assert.equal(JSON.stringify(pr.pr).includes("/Users/you/project"), false);
  assert.equal("root" in pr.pr, false);
  const log = await source.checkLog(REF, "123");
  assert.equal(log.log.text.includes("/Users/you/project"), false);
});

test("diff와 검사 로그는 UTF-8 바이트로 잘라 64 KiB 응답 안에 표시한다", async () => {
  const agent = { status: "idle", source: { cwd: "/Users/you/project" } };
  const agents = { resolve: () => agent };
  const gitHandler = async (ws, message) => ws.send(JSON.stringify(message.type === "git.status"
    ? { type: "git-status", isRepo: true, root: "/Users/you/project", branch: "feature", ahead: 0, behind: 0,
      staged: [], changes: [{ rel: "src/a.js", code: "M" }], branches: [] }
    : { type: "git-diff", patch: "한".repeat(48_000) }));
  const githubHandler = async (ws) => ws.send(JSON.stringify({ ok: true, log: "한".repeat(40_000) }));
  const source = createSourceControlFeature({ agents, randomBytes: randomSequence(), gitHandler, githubHandler,
    runtimeSnapshot: () => ({ workspaces: [] }), getHerdr: () => ({}) });
  const status = await source.status(REF);
  const diff = await source.diff({ agent: REF, file: status.data.files[0].ref, view: "working" });
  const diffResult = projectFeature({ type: "git.diff.result", rid: "diff", file: status.data.files[0].ref,
    patch: diff.patch.text, truncated: diff.patch.truncated });
  assert.equal(diffResult.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(diffResult), "utf8") <= MAX_REMOTE_FRAME_BYTES);

  const log = await source.checkLog(REF, "123");
  const logResult = projectFeature({ type: "github.check.log.result", rid: "log", run: "123",
    log: log.log.text, truncated: log.log.truncated });
  assert.equal(logResult.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(logResult), "utf8") <= MAX_REMOTE_FRAME_BYTES);
});

test("caps는 현재 기능만 내보내고 기능 경계 거부를 오류 코드로 돌린다", async () => {
  const { operations, features } = fixture();
  features.capabilities = () => ["terminal.watch", "browser.tabs", "git.changes"];
  const caps = await operations.table.get("caps.get")({}, { type: "caps.get" });
  assert.deepEqual(caps.requests.slice(-3), ["terminal.watch", "browser.tabs", "git.changes"]);
  features.browser.newTab = async () => ({ ok: false, code: "forbidden" });
  features.source.diff = async () => ({ ok: false, code: "forbidden" });
  assert.equal((await operations.table.get("browser.tab.new")({}, requests[13])).error.code, "forbidden");
  assert.equal((await operations.table.get("git.diff")({}, requests[28])).error.code, "forbidden");
  operations.close();
});
