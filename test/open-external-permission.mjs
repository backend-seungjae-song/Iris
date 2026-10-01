import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createProfileSessionPolicy, isAppSchemeUrl, requestingSite } = require("../native/electron/profile-session-policy.cjs");
const nativeAx = require("../native/electron/cdp-native-ax.cjs");

const FIGMA = "https://www.figma.com/app_auth/x/grant";

function fakeWc(id = 7) {
  const once = new Map();
  return { id, isDestroyed: () => false, once(name, fn) { once.set(name, fn); }, fire(name) { const fn = once.get(name); once.delete(name); fn?.(); } };
}

function requestHandler({ confirm, driving = () => false } = {}) {
  let handler = null;
  const sess = { setDevicePermissionHandler() {}, removeListener() {}, on() {},
    setPermissionRequestHandler(f) { handler = f; }, setPermissionCheckHandler() {} };
  const policy = createProfileSessionPolicy({ basePartition: "persist:acbrowser", fromPartition: () => sess,
    hardenBrowserSession() {}, userAgentForPartition() {}, audioInputPermission: () => false, installSessionHook() {},
    aiDriving: driving, confirmExternalOpen: confirm });
  policy.hardenSession(sess);
  requestHandler.policy = policy;
  return (externalURL, { wc = fakeWc(), requestingUrl = FIGMA } = {}) =>
    new Promise((resolve) => handler(wc, "openExternal", resolve, { externalURL, requestingUrl }));
}

test("앱 주소만 앱 열기 대상이고, 크롬이 막는 형식은 뺀다", () => {
  assert.equal(isAppSchemeUrl("figma://app_auth/redeem?g=1"), true);
  assert.equal(isAppSchemeUrl("zoommtg://zoom.us/join"), true);
  for (const url of ["https://figma.com", "http://a.test", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,x",
    "afp://host/share", "applescript://com.apple.scripteditor", "", "not a url"]) {
    assert.equal(isAppSchemeUrl(url), false, url);
  }
});

test("요청 사이트는 http(s) origin 만 쓴다", () => {
  assert.equal(requestingSite(FIGMA), "https://www.figma.com");
  for (const raw of ["about:srcdoc", "about:blank", "data:text/html,www.figma.com", "", "null"]) assert.equal(requestingSite(raw), "", raw);
});

test("사람이 확인한 앱 주소만 연다", async () => {
  const asked = [];
  const open = requestHandler({ confirm: async (req) => { asked.push(req); return true; } });
  assert.equal(await open("figma://app_auth/redeem?g=1"), true);
  assert.deepEqual(asked, [{ url: "figma://app_auth/redeem?g=1", site: "https://www.figma.com", unsure: false }]);
  assert.equal(await requestHandler({ confirm: async () => { throw new Error("closed"); } })("figma://x"), false);
});

test("자동화 중이거나 웹 주소거나 요청 사이트를 모르면 묻지 않고 거절한다", async () => {
  let asked = 0;
  const confirm = async () => { asked++; return true; };
  assert.equal(await requestHandler({ confirm, driving: () => true })("figma://x"), false);
  assert.equal(await requestHandler({ confirm })("https://evil.test"), false);
  assert.equal(await requestHandler({ confirm })("figma://x", { requestingUrl: "about:srcdoc" }), false);
  assert.equal(asked, 0);
});

test("확인 창이 닫힐 때 자동화가 조작 중이면 거절한다", async () => {
  let driving = false;
  const open = requestHandler({ confirm: async () => { driving = true; return true; }, driving: () => driving });
  assert.equal(await open("figma://x"), false);
});

test("탭마다 한 번에 하나만 묻고, 거절하면 다음 이동 전까지 묻지 않는다", async () => {
  let asked = 0;
  let answer;
  const open = requestHandler({ confirm: () => { asked++; return new Promise((r) => { answer = r; }); } });
  const wc = fakeWc();
  const first = open("figma://x", { wc });
  await new Promise((r) => setImmediate(r));
  assert.equal(await open("figma://y", { wc }), false);
  answer(false);
  assert.equal(await first, false);
  assert.equal(await open("figma://z", { wc }), false);
  assert.equal(asked, 1);
  wc.fire("did-navigate");
  const again = open("figma://z", { wc });
  await new Promise((r) => setImmediate(r));
  answer(true);
  assert.equal(await again, true);
  assert.equal(asked, 2);
});

test("새 창 요청도 같은 판정을 쓰고, 이동 요청에서 거절한 탭은 새 창 요청으로도 묻지 않는다", async () => {
  let asked = 0;
  const open = requestHandler({ confirm: async () => { asked++; return false; } });
  const { policy } = requestHandler;
  const wc = fakeWc();
  assert.equal(await open("figma://x", { wc }), false);
  assert.equal(await policy.requestExternalOpen(wc, "mailto:a@example.com", FIGMA), false);
  assert.equal(await policy.requestExternalOpen(fakeWc(8), "https://evil.test", FIGMA), false);
  assert.equal(asked, 1);
});

test("요청 프레임을 모르는 새 창 요청은 확인 창에 그 사실을 넘긴다", async () => {
  const asked = [];
  requestHandler({ confirm: async (req) => { asked.push(req); return false; } });
  await requestHandler.policy.requestExternalOpen(fakeWc(9), "zoommtg://x", FIGMA, { unsure: true });
  assert.deepEqual(asked, [{ url: "zoommtg://x", site: "https://www.figma.com", unsure: true }]);
});

// 막는 코드가 깨지면 실제 AppleScript 가 실행된다. 없는 버튼 이름만 쓰고 키는 보내지 않는다(axKey 는 같은 막음을 쓴다).
test("앱 열기 확인 창이 떠 있는 동안 에이전트의 OS 창 버튼 누르기는 거절된다", async () => {
  nativeAx.holdNativeInput("앱 열기");
  try {
    assert.match((await nativeAx.axClick("iris-test-no-such-button")).error || "", /사람이 답합니다/);
  } finally { nativeAx.holdNativeInput(null); }
});
