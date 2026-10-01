import assert from "node:assert/strict";
import test from "node:test";

import { addTab } from "../web/js/center/tab-store.js";
import { pickTabAt } from "../web/js/browser/pick-host.js";
import { replaceBrowserState } from "../web/js/browser/state.js";
import { registerWebview } from "../web/js/browser/webview-store.js";

function tabEl(id) {
  const el = { dataset: { tab: id }, querySelector: () => null };
  return { closest: (selector) => (selector === ".ctab" ? el : null), el };
}

test("요소 선택의 탭 판정은 잠든 브라우저 탭도 지목 대상으로 본다", () => {
  replaceBrowserState({ activeSpace: "X", tabsBySpace: {} });
  addTab("X", { id: "awake", kind: "browser" });
  addTab("X", { id: "asleep", kind: "browser" });
  registerWebview("awake", { wc: 7, tabId: "awake" });

  const awake = pickTabAt(tabEl("awake"));
  assert.equal(awake.rec.wc, 7);
  const asleep = pickTabAt(tabEl("asleep"));
  assert.deepEqual([asleep.id, asleep.rec, asleep.docTab], ["asleep", null, undefined]);
  assert.equal(pickTabAt(tabEl("missing")), null);
});
