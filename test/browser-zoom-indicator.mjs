import assert from "node:assert/strict";
import test from "node:test";

test("도구 막대는 현재 탭의 배율만 반올림해 표시하고 100%에서 숨김", async () => {
  const { createZoomIndicator } = await import("../web/js/browser/zoom.js");
  const badge = { hidden: true, textContent: "" };
  const tab = (wc, factor) => ({ ready: true, el: { getWebContentsId: () => wc, getZoomFactor: () => factor } });
  const a = tab(1, 1.095);
  const b = tab(2, 1);
  let active = a;
  let notify;
  const acHost = { onBrowserZoomChanged(callback) { notify = callback; } };
  const update = createZoomIndicator({ badge, activeWebview: () => active, acHost });

  update();
  assert.equal(badge.hidden, false);
  assert.equal(badge.textContent, "110%");
  notify({ wc: 2, factor: 1.4 });
  assert.equal(badge.textContent, "110%");

  active = b;
  update();
  assert.equal(badge.hidden, true);
  notify({ wc: 2, factor: 0.913 });
  assert.equal(badge.hidden, false);
  assert.equal(badge.textContent, "91%");
  notify({ wc: 2, factor: 1 });
  assert.equal(badge.hidden, true);
});

test("실패한 확대 입력은 현재 탭의 실제 배율과 함께 안내", async () => {
  const { createZoomIndicator } = await import("../web/js/browser/zoom.js");
  const badge = { hidden: false, textContent: "110%" };
  const active = { ready: true, el: { getWebContentsId: () => 1 } };
  const notices = [];
  let notify;
  createZoomIndicator({
    badge, activeWebview: () => active,
    acHost: { onBrowserZoomChanged(callback) { notify = callback; } },
    showNotice: (message) => notices.push(message),
  });
  const notice = "이 페이지의 확대·축소를 적용하지 못했습니다.";

  notify({ wc: 2, factor: 1, notice });
  assert.equal(badge.textContent, "110%");
  assert.deepEqual(notices, []);
  notify({ wc: 1, factor: 1, notice });
  assert.equal(badge.hidden, true);
  assert.deepEqual(notices, [notice]);

  active.ready = false;
  notify({ wc: 1, factor: 1.1, notice });
  assert.equal(badge.textContent, "110%");
  assert.deepEqual(notices, [notice, notice]);
});
