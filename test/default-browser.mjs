// 다른 앱에서 누른 웹 링크의 수신과 기본 브라우저 후보 변환, 설정 화면 「링크 열기」 마크업 검사
//
// 소유 범위
//   default-browser.cjs 의 순수 함수와 대기열, settings-view 의 links 분류
//
// 영향 범위
//   지금 목록: node bin/importers.mjs test/default-browser.mjs

import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { webLink, linkTarget, browserChoices, createLinkInbox, createDefaultBrowser } = require("../native/electron/default-browser.cjs");

const previousFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({ exists: true, revision: 0, hidden: [], local: true }));
const { settingsMarkup } = await import("../web/js/devtool/settings-view.js");
globalThis.fetch = previousFetch;

test("webLink 는 http·https 만 통과", () => {
  assert.equal(webLink("https://example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(webLink("http://example.com"), "http://example.com/");
  assert.equal(webLink("file:///etc/passwd"), null);
  assert.equal(webLink("slack://open"), null);
  assert.equal(webLink("javascript:alert(1)"), null);
  assert.equal(webLink(""), null);
  assert.equal(webLink(undefined), null);
});

test("browserChoices 는 캐시 앱과 중복을 빼고 Iris 를 맨 앞에 둠", () => {
  const r = browserChoices({
    current: "com.google.Chrome",
    apps: [
      { id: "com.google.Chrome", path: "/Applications/Google Chrome.app", name: "Google Chrome" },
      { id: "com.google.chrome.for.testing", path: "/Users/you/Library/Caches/ms-playwright/x/Google Chrome for Testing.app", name: "Google Chrome for Testing" },
      { id: "app.iris.console", path: "/Applications/Iris.app", name: "Iris" },
      { id: "com.google.Chrome", path: "/Volumes/X/Google Chrome.app", name: "Google Chrome" },
      { id: "", path: "/Applications/Broken.app", name: "Broken" },
      null,
      { id: "com.apple.Safari", path: "/Applications/Safari.app", name: "Safari" },
    ],
  });
  assert.equal(r.current, "com.google.Chrome");
  assert.equal(r.irisRegistered, true);
  assert.deepEqual(r.choices.map((c) => c.id), ["app.iris.console", "com.google.Chrome", "com.apple.Safari"]);
  assert.equal(r.choices[0].name, "Iris");
});

test("browserChoices 는 깨진 입력에서 빈 목록", () => {
  assert.deepEqual(browserChoices(null), { current: null, choices: [], irisRegistered: false });
  assert.deepEqual(browserChoices({ apps: "x", current: 3 }), { current: null, choices: [], irisRegistered: false });
});

function fakeWc() {
  const sent = [];
  return { sent, destroyed: false, isDestroyed() { return this.destroyed; }, send(ch, m) { sent.push([ch, m]); } };
}

test("앱 준비 전에 받은 링크는 창 준비 뒤 순서대로 전달", () => {
  let ready = false, opened = 0;
  const inbox = createLinkInbox({ isAppReady: () => ready, openWindow: () => { opened++; } });
  assert.equal(inbox.receive("https://a.example/"), true);
  assert.equal(inbox.receive("ftp://b.example/"), false);
  inbox.receive("https://c.example/");
  assert.equal(opened, 0);
  ready = true;
  inbox.appReady();
  assert.equal(opened, 1);
  const wc = fakeWc();
  inbox.windowReady(wc);
  assert.deepEqual(wc.sent, [
    ["ac-inbound-link", { url: "https://a.example/" }],
    ["ac-inbound-link", { url: "https://c.example/" }],
  ]);
  assert.equal(inbox.pending(), 0);
});

test("창이 준비된 뒤 받은 링크는 바로 전달하고 창을 앞으로", () => {
  let opened = 0;
  const inbox = createLinkInbox({ isAppReady: () => true, openWindow: () => { opened++; } });
  const wc = fakeWc();
  inbox.windowReady(wc);
  inbox.receive("https://x.example/");
  assert.equal(opened, 1);
  assert.deepEqual(wc.sent, [["ac-inbound-link", { url: "https://x.example/" }]]);
});

test("창이 닫혔으면 새 창이 준비될 때까지 보관", () => {
  const inbox = createLinkInbox({ isAppReady: () => true, openWindow: () => {} });
  const old = fakeWc();
  inbox.windowReady(old);
  old.destroyed = true;
  inbox.receive("https://y.example/");
  assert.equal(old.sent.length, 0);
  assert.equal(inbox.pending(), 1);
  const fresh = fakeWc();
  inbox.windowReady(fresh);
  assert.deepEqual(fresh.sent, [["ac-inbound-link", { url: "https://y.example/" }]]);
});

function fakeExec(listJson, setJson = '{"http":0,"https":0}') {
  const calls = [];
  const execFile = (_bin, args, _opts, cb) => {
    calls.push(args);
    const isSet = args.length > 4;
    setImmediate(() => cb(null, isSet ? setJson : listJson));
  };
  return { calls, execFile };
}
const LIST = JSON.stringify({ current: "com.google.Chrome", apps: [
  { id: "com.google.Chrome", path: "/Applications/Google Chrome.app", name: "Google Chrome" },
  { id: "app.iris.console", path: "/Applications/Iris.app", name: "Iris" },
] });

test("choose 는 목록에 없는 앱을 LaunchServices 에 넘기지 않음", async () => {
  const fx = fakeExec(LIST);
  const db = createDefaultBrowser({ execFile: fx.execFile, platform: "darwin" });
  const r = await db.choose("com.evil.App");
  assert.equal(r.ok, false);
  assert.equal(fx.calls.length, 1);
});

test("choose 는 고른 앱 id 로 http·https 둘 다 요청", async () => {
  const fx = fakeExec(LIST);
  const db = createDefaultBrowser({ execFile: fx.execFile, platform: "darwin" });
  assert.deepEqual(await db.choose("app.iris.console"), { ok: true, requested: true });
  assert.equal(fx.calls.length, 2);
  assert.equal(fx.calls[1].at(-1), "app.iris.console");
  assert.deepEqual(await db.choose("com.google.Chrome"), { ok: true, requested: false });
});

test("choose 는 LaunchServices 오류 코드를 실패로 반환", async () => {
  const fx = fakeExec(LIST, '{"http":-54,"https":0}');
  const db = createDefaultBrowser({ execFile: fx.execFile, platform: "darwin" });
  assert.equal((await db.choose("app.iris.console")).ok, false);
});

test("macOS 가 아니면 조회하지 않음", async () => {
  const fx = fakeExec(LIST);
  const db = createDefaultBrowser({ execFile: fx.execFile, platform: "win32" });
  assert.equal((await db.status()).ok, false);
  assert.equal(fx.calls.length, 0);
});

test("설정 화면 링크 열기: 현재 앱은 사용 중, 나머지는 버튼", () => {
  const html = settingsMarkup({ section: "links", links: { ok: true, ...browserChoices(JSON.parse(LIST)) } });
  assert.match(html, /data-km-sec="links"/);
  assert.match(html, /<div class="km-tn">Iris<\/div>/);
  assert.match(html, /data-link-target="shared" aria-pressed="true"/, "기본은 공유 브라우저");
  assert.match(html, /data-link-app="app\.iris\.console"/);
  assert.doesNotMatch(html, /data-link-app="com\.google\.Chrome"/);
  assert.match(html, /사용 중/);
});

test("설정 화면 링크 열기: Iris 미등록·조회 중·오류·이름 escape", () => {
  const unreg = settingsMarkup({ section: "links", links: { ok: true, current: "a", irisRegistered: false,
    choices: [{ id: "a", name: "<b>A</b>", path: "/A.app", self: false }] } });
  assert.match(unreg, /다시 설치하면/);
  assert.match(unreg, /&lt;b&gt;A&lt;\/b&gt;/);
  assert.match(settingsMarkup({ section: "links", links: { loading: true } }), /읽는 중/);
  assert.match(settingsMarkup({ section: "links", links: { ok: false, error: "실패함" } }), /실패함/);
  assert.match(settingsMarkup({ section: "links", links: { ok: true, requested: true, choices: [] } }), /확인 창/);
});

test("세션 브라우저로 고르면 링크를 콘솔 창에 보내고 그 창을 앞으로", () => {
  let target = "session";
  const roles = [];
  const inbox = createLinkInbox({ isAppReady: () => true, target: () => target, openWindow: (role) => roles.push(role) });
  const shared = fakeWc(), consoleWc = fakeWc();
  inbox.windowReady(shared, "shared");
  inbox.windowReady(consoleWc, "session");
  inbox.receive("https://s.example/");
  assert.deepEqual(roles, ["session"]);
  assert.deepEqual(consoleWc.sent, [["ac-inbound-link", { url: "https://s.example/" }]]);
  assert.equal(shared.sent.length, 0);
  target = "shared";
  inbox.receive("https://t.example/");
  assert.deepEqual(roles, ["session", "shared"]);
  assert.deepEqual(shared.sent, [["ac-inbound-link", { url: "https://t.example/" }]]);
});

test("받을 창 값은 session 만 세션, 나머지는 공유", () => {
  assert.equal(linkTarget("session"), "session");
  for (const v of ["shared", undefined, null, "x", 1]) assert.equal(linkTarget(v), "shared");
});

test("설정 화면 링크 열기: 세션 브라우저를 고르면 그 단추가 눌린 상태와 설명", () => {
  const html = settingsMarkup({ section: "links", links: { ok: true, target: "session", ...browserChoices(JSON.parse(LIST)) } });
  assert.match(html, /data-link-target="session" aria-pressed="true"/);
  assert.match(html, /data-link-target="shared" aria-pressed="false"/);
  assert.match(html, /지금 보고 있는 스페이스의 브라우저/);
});
