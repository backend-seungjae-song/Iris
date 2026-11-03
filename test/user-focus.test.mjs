import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { focusState, canPress, canSendKeys, ownsUserFocus, claimWindowFocus, borrowWindowFocus, returnWindowFocus, focusProbeExpression } =
  require("../native/electron/user-focus.cjs");

// 앱 셸 문서를 흉내 냄: 식을 그 문서 위에서 실제 평가
function shell({ active = undefined, activeId = null, webviews = [], hostDestroyed = false, hang = false, throws = false } = {}) {
  const body = { tagName: "BODY" };
  const document = { body, documentElement: { tagName: "HTML" }, activeElement: null, querySelectorAll: () => webviews };
  document.activeElement = active !== undefined ? active
    : activeId == null ? { tagName: "INPUT" } : { tagName: "WEBVIEW", getWebContentsId: () => activeId };
  if (active === "body") document.activeElement = body;
  for (const el of webviews) el.focus = () => { document.activeElement = el; };
  return {
    document,
    isDestroyed: () => hostDestroyed,
    executeJavaScript(expression) {
      if (throws) return Promise.reject(new Error("렌더러 없음"));
      if (hang) return new Promise(() => {});
      return Promise.resolve(new Function("document", `return ${expression};`)(document));
    },
  };
}
const guest = (id, host) => ({ id, isDestroyed: () => false, hostWebContents: host });
const webview = (id) => ({ tagName: "WEBVIEW", getWebContentsId: () => id });

test("앱 셸에서 포커스를 가진 webview 가 이 탭이면 owns", async () => {
  const s = await focusState(guest(7, shell({ activeId: 7 })));
  assert.deepEqual(s, { owns: true, idle: false, windowFocused: true });
  assert.equal(canSendKeys(s), true);
  assert.equal(canPress(s), true);
  assert.equal(await ownsUserFocus(guest(7, shell({ activeId: 7 }))), true);
});

test("포커스가 다른 탭·앱 셸 입력칸이면 글·키·누르기 모두 불가", async () => {
  for (const host of [shell({ activeId: 8 }), shell()]) {
    const s = await focusState(guest(7, host), { windowFocused: () => false });
    assert.equal(canSendKeys(s), false);
    assert.equal(canPress(s), false);       // 그 창에 돌아올 사용자 포커스가 있음
  }
});

test("포커스된 요소가 없는 창은 사용자가 그 창을 쓰지 않을 때만 누르기 허용", async () => {
  const idle = guest(7, shell({ active: "body" }));
  const away = await focusState(idle, { windowFocused: () => false });
  assert.deepEqual(away, { owns: false, idle: true, windowFocused: false });
  assert.equal(canPress(away), true);
  assert.equal(canSendKeys(away), false);
  assert.equal(canPress(await focusState(idle, { windowFocused: () => true })), false);
  assert.equal(canPress(await focusState(guest(7, shell({ active: null })), { windowFocused: () => false })), true);
});

test("붙지 않은 webview 의 getWebContentsId 오류는 다른 요소로 봄", async () => {
  const detached = { tagName: "WEBVIEW", getWebContentsId: () => { throw new Error("not attached"); } };
  const s = await focusState(guest(7, shell({ active: detached })), { windowFocused: () => false });
  assert.equal(canPress(s), false);
});

test("앱 셸이 없거나 응답하지 않거나 오류면 아무것도 허용하지 않음", async () => {
  const cases = [
    { id: 7, isDestroyed: () => false, hostWebContents: null },
    { id: 7, isDestroyed: () => true },
    null,
    guest(7, shell({ hostDestroyed: true, activeId: 7 })),
    guest(7, shell({ throws: true })),
  ];
  for (const wc of cases) {
    const s = await focusState(wc, { windowFocused: () => false });
    assert.equal(canPress(s) || canSendKeys(s), false);
  }
  const started = Date.now();
  const s = await focusState(guest(7, shell({ hang: true })), { windowFocused: () => false, timeoutMs: 30 });
  assert.equal(canPress(s) || canSendKeys(s), false);
  assert.ok(Date.now() - started < 1000);
});

test("창 포커스 판정이 실패하면 사용자가 그 창을 쓰는 것으로 봄", async () => {
  const s = await focusState(guest(7, shell({ active: "body" })), { windowFocused: () => { throw new Error("x"); } });
  assert.equal(s.windowFocused, true);
  assert.equal(canPress(s), false);
});

test("claimWindowFocus 는 그 창에서 이 탭 webview 에만 포커스를 줌", async () => {
  const mine = webview(7), other = webview(8);
  const host = shell({ active: "body", webviews: [other, mine] });
  assert.equal(await claimWindowFocus(guest(7, host)), true);
  assert.equal(host.document.activeElement, mine);
  assert.equal(await claimWindowFocus(guest(9, shell({ active: "body", webviews: [other] }))), false);
  assert.equal(await claimWindowFocus(guest(7, shell({ hang: true })), { timeoutMs: 30 }), false);
});

test("빌린 포커스는 입력 뒤 사용자가 쓰던 요소로 돌아감", async () => {
  const mine = webview(7), terminal = { tagName: "TEXTAREA", isConnected: true };
  const host = shell({ active: terminal, webviews: [mine] });
  terminal.focus = () => { host.document.activeElement = terminal; };
  assert.equal(await borrowWindowFocus(guest(7, host)), true);
  assert.equal(host.document.activeElement, mine);
  assert.equal(await returnWindowFocus(guest(7, host)), "restored");
  assert.equal(host.document.activeElement, terminal);
});

test("빌린 사이 사용자가 포커스를 옮겼으면 반환하지 않음", async () => {
  const mine = webview(7), terminal = { tagName: "TEXTAREA", isConnected: true, focus() { throw new Error("옮기면 안 됨"); } };
  const other = { tagName: "INPUT" };
  const host = shell({ active: terminal, webviews: [mine] });
  assert.equal(await borrowWindowFocus(guest(7, host)), true);
  host.document.activeElement = other;
  assert.equal(await returnWindowFocus(guest(7, host)), "moved");
  assert.equal(host.document.activeElement, other);
});

test("빌리기 전 포커스가 없었으면 반환 때 이 탭 포커스를 풂", async () => {
  const mine = webview(7);
  const host = shell({ active: "body", webviews: [mine] });
  mine.blur = () => { host.document.activeElement = host.document.body; };
  assert.equal(await borrowWindowFocus(guest(7, host)), true);
  assert.equal(await returnWindowFocus(guest(7, host)), "blurred");
  assert.equal(host.document.activeElement, host.document.body);
  assert.equal(await borrowWindowFocus(guest(9, shell({ webviews: [mine] }))), false);
  assert.equal(await returnWindowFocus(guest(7, shell({ hang: true })), { timeoutMs: 30 }), null);
});

test("탭 번호는 숫자로만 식에 들어감", () => {
  assert.match(focusProbeExpression("7);alert(1"), /=== NaN/);
  assert.match(focusProbeExpression(12), /=== 12 \?/);
});
