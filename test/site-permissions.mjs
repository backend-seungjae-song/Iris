// 위치·화면 공유·마이크·파일 쓰기: 기능을 켠 사이트만 묻고, 사람이 고른 것을 사이트별로 기억하는지 검증한다.
//
// 소유 범위
//   site-permissions.cjs 의 사용 스위치·사이트 기록·중복 물음과 profile-session-policy.cjs 의 권한 핸들러 연결.
//
// 제공 API
//   node --test test/site-permissions.mjs
//
// 의존 대상
//   가짜 저장소·확인 창·session 만 쓴다. Electron 없이 판정한다.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createSitePermissions } = require("../native/electron/site-permissions.cjs");
const { createProfileSessionPolicy } = require("../native/electron/profile-session-policy.cjs");

function store() {
  let saved = {};
  return { read: () => saved.sitePermissions, write: (patch) => { saved = { ...saved, ...patch }; } };
}
function perms(answers) {
  const st = store();
  const asked = [];
  const sp = createSitePermissions({ read: st.read, write: st.write,
    confirm: async (req) => { asked.push(req.kind + "@" + req.site); const a = answers.shift(); if (a instanceof Error) throw a; return a; } });
  return { sp, asked };
}
const A = "https://a.example", B = "https://b.example";

test("꺼진 기능은 묻지 않고 거절하고, 켜면 사이트마다 따로 묻는다", async () => {
  const { sp, asked } = perms([true, false]);
  assert.equal(await sp.ask("geolocation", A), false);
  assert.deepEqual(asked, []);
  sp.setFeature("geolocation", true);
  assert.equal(await sp.ask("geolocation", A), true);
  assert.equal(await sp.ask("geolocation", B), false);
  assert.deepEqual(asked, ["geolocation@" + A, "geolocation@" + B]);
});

test("허용·차단은 그 사이트와 그 기능에만 기억하고 다시 묻지 않는다", async () => {
  const { sp, asked } = perms([true]);
  sp.setFeature("geolocation", true); sp.setFeature("microphone", true);
  assert.equal(await sp.ask("geolocation", A), true);
  assert.equal(await sp.ask("geolocation", A), true);
  assert.equal(sp.decision("geolocation", A), true);
  assert.equal(sp.decision("microphone", A), undefined);
  assert.deepEqual(asked, ["geolocation@" + A]);
});

test("기능을 끄면 기억한 허용도 무효이고, 다시 켜면 살아난다", async () => {
  const { sp } = perms([true]);
  sp.setFeature("display", true);
  await sp.ask("display", A);
  sp.setFeature("display", false);
  assert.equal(sp.decision("display", A), undefined);
  assert.equal(await sp.ask("display", A), false);
  sp.setFeature("display", true);
  assert.equal(sp.decision("display", A), true);
});

test("창을 닫거나 오류면 거절하고 기억하지 않는다", async () => {
  const { sp } = perms([null, new Error("x")]);
  sp.setFeature("fileWrite", true);
  assert.equal(await sp.ask("fileWrite", A), false);
  assert.equal(await sp.ask("fileWrite", A), false);
  assert.equal(sp.decision("fileWrite", A), undefined);
});

test("같은 사이트·기능의 겹친 물음은 창 하나로 답하고, 묻는 동안 기능이 꺼지면 허용하지 않는다", async () => {
  let release; let calls = 0;
  const st = store();
  const sp = createSitePermissions({ read: st.read, write: st.write, confirm: () => { calls++; return new Promise((r) => { release = r; }); } });
  sp.setFeature("microphone", true);
  const first = sp.ask("microphone", A), second = sp.ask("microphone", A);
  await new Promise((r) => setImmediate(r));
  sp.setFeature("microphone", false);
  release(true);
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(calls, 1);
  assert.equal(sp.decision("microphone", A), undefined);
});

test("기록 지우기는 그 기능만 지우고 요약은 개수를 준다", async () => {
  const { sp } = perms([true, false, true]);
  sp.setFeature("geolocation", true); sp.setFeature("microphone", true);
  await sp.ask("geolocation", A); await sp.ask("geolocation", B); await sp.ask("microphone", A);
  const row = (id) => sp.summary().find((r) => r.id === id);
  assert.deepEqual([row("geolocation").allowed, row("geolocation").blocked, row("microphone").allowed], [1, 1, 1]);
  sp.clearSites("geolocation");
  assert.deepEqual([row("geolocation").allowed, row("geolocation").blocked, row("microphone").allowed], [0, 0, 1]);
  assert.equal(row("geolocation").on, true);
});

function policyFixture({ sp, driving = () => false, source = { id: "screen:1" } }) {
  let request = null, check = null, display = null;
  const sess = { setDevicePermissionHandler() {}, removeListener() {}, on() {},
    setPermissionRequestHandler(f) { request = f; }, setPermissionCheckHandler(f) { check = f; }, setDisplayMediaRequestHandler(f) { display = f; } };
  const mic = [];
  createProfileSessionPolicy({ basePartition: "persist:acbrowser", fromPartition: () => sess, hardenBrowserSession() {},
    userAgentForPartition() {}, installSessionHook() {}, platform: "darwin",
    audioInputPermission: (p, d) => p === "media" && ((Array.isArray(d.mediaTypes) && d.mediaTypes.includes("audio")) || d.mediaType === "audio"),
    systemPreferences: { getMediaAccessStatus: () => "granted", askForMediaAccess: async (k) => { mic.push(k); return true; } },
    aiDriving: driving, sitePermissions: sp, frameWebContents: () => wc, pickDisplaySource: async () => source }).hardenSession(sess);
  const nav = [];
  const wc = { id: 3, isDestroyed: () => false, getURL: () => top, once: (n, fn) => { if (n === "did-navigate") nav.push(fn); } };
  let top = A + "/";
  return {
    mic, wc,
    setTop: (url) => { top = url; },
    navigate: () => { while (nav.length) nav.shift()(); },
    ask: (permission, details) => new Promise((resolve) => request(wc, permission, resolve, details)),
    check: (permission, origin, details) => check(wc, permission, origin, details),
    share: (url) => new Promise((resolve) => display({ frame: { url } }, resolve)),
  };
}

test("위치·마이크·파일 쓰기 요청은 사이트별 허용을 따르고, 확인 핸들러는 허용한 사이트만 통과시킨다", async () => {
  const { sp } = perms([true, true, true]);
  for (const k of ["geolocation", "microphone", "fileWrite"]) sp.setFeature(k, true);
  const f = policyFixture({ sp });
  assert.equal(f.check("geolocation", A, { requestingUrl: A + "/x" }), false);
  assert.equal(await f.ask("geolocation", { requestingUrl: A + "/x" }), true);
  assert.equal(f.check("geolocation", A, { requestingUrl: A + "/x" }), true);
  assert.equal(f.check("geolocation", B, { requestingUrl: B + "/" }), false);
  assert.equal(await f.ask("media", { requestingUrl: A + "/", mediaTypes: ["audio"] }), true);
  assert.deepEqual(f.mic, ["microphone"]);
  assert.equal(f.check("media", A, { requestingUrl: A + "/", mediaType: "audio" }), true);
  f.setTop(B + "/");
  assert.equal(f.check("media", B, { requestingUrl: B + "/", mediaType: "audio" }), false);
  f.setTop(A + "/");
  assert.equal(await f.ask("fileSystem", { requestingUrl: A + "/", fileAccessType: "writable", isDirectory: false, filePath: "/x" }), true);
  assert.equal(f.check("fileSystem", A, { requestingUrl: A + "/", fileAccessType: "writable", isDirectory: true }), true);
});

test("기능이 꺼져 있거나 보안 문맥이 아니거나 자동화 중이면 묻지 않고 거절한다", async () => {
  const { sp, asked } = perms([true, true, true]);
  sp.setFeature("geolocation", true);
  assert.equal(await policyFixture({ sp }).ask("media", { requestingUrl: A + "/", mediaTypes: ["audio"] }), false);
  assert.equal(await policyFixture({ sp }).ask("geolocation", { requestingUrl: "http://plain.example/" }), false);
  assert.equal(await policyFixture({ sp, driving: () => true }).ask("geolocation", { requestingUrl: A + "/" }), false);
  assert.deepEqual(asked, []);
});

test("화면 공유는 허용한 사이트에만 고른 화면을 주고, 자동화 중이거나 화면을 못 고르면 거절한다", async () => {
  const { sp } = perms([true, true]);
  sp.setFeature("display", true);
  assert.deepEqual(await policyFixture({ sp }).share(A + "/room"), { video: { id: "screen:1" } });
  assert.deepEqual(await policyFixture({ sp, source: null }).share(A + "/room"), { video: undefined, audio: undefined });
  assert.deepEqual(await policyFixture({ sp, driving: () => true }).share(A + "/room"), { video: undefined, audio: undefined });
  const off = perms([true]);
  assert.deepEqual(await policyFixture({ sp: off.sp }).share(A + "/room"), { video: undefined, audio: undefined });
});

test("다른 출처 iframe 의 요청은 허용한 출처여도 묻지 않고 거절한다", async () => {
  const { sp, asked } = perms([true]);
  sp.setFeature("microphone", true);
  const f = policyFixture({ sp });
  assert.equal(await f.ask("media", { requestingUrl: A + "/", mediaTypes: ["audio"] }), true);
  f.setTop(B + "/");
  assert.equal(await f.ask("media", { requestingUrl: A + "/", mediaTypes: ["audio"] }), false);
  assert.equal(f.check("media", A, { requestingUrl: "", mediaType: "audio" }), false);
  assert.deepEqual(asked, ["microphone@" + A]);
});

test("허용하지 않은 탭은 다음 이동 전까지 다시 묻지 않고, 창이 떠 있는 동안 같은 탭의 요청은 거절한다", async () => {
  let release; let calls = 0;
  const st = store();
  const sp = createSitePermissions({ read: st.read, write: st.write, confirm: () => { calls++; return new Promise((r) => { release = r; }); } });
  sp.setFeature("geolocation", true);
  const f = policyFixture({ sp });
  const first = f.ask("geolocation", { requestingUrl: A + "/" });
  await new Promise((r) => setImmediate(r));
  assert.equal(await f.ask("geolocation", { requestingUrl: A + "/" }), false);
  release(null);
  assert.equal(await first, false);
  assert.equal(await f.ask("geolocation", { requestingUrl: A + "/" }), false);
  assert.equal(calls, 1);
  f.navigate();
  const again = f.ask("geolocation", { requestingUrl: A + "/" });
  await new Promise((r) => setImmediate(r));
  release(true);
  assert.equal(await again, true);
  assert.equal(calls, 2);
});

test("허용 기록은 프로필별이다", async () => {
  const { sp } = perms([true]);
  sp.setFeature("geolocation", true);
  assert.equal(await sp.ask("geolocation", A, "persist:acprof:one"), true);
  assert.equal(sp.decision("geolocation", A, "persist:acprof:one"), true);
  assert.equal(sp.decision("geolocation", A, "persist:acprof:two"), undefined);
  assert.equal(sp.decision("geolocation", A), undefined);
});

test("확인 창이 겹쳐도 먼저 닫힌 창이 남은 창의 에이전트 조작 차단을 풀지 않는다", async () => {
  const nativeAx = require("../native/electron/cdp-native-ax.cjs");
  const blocked = async () => /사람이 답합니다/.test((await nativeAx.axClick("iris-test-no-such-button")).error || "");
  nativeAx.holdNativeInput("위치"); nativeAx.holdNativeInput("마이크");
  nativeAx.holdNativeInput(null);
  assert.equal(await blocked(), true);
  nativeAx.holdNativeInput(null);
  assert.equal(await blocked(), false);
});
