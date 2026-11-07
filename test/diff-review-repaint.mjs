import test from "node:test";
import assert from "node:assert/strict";
import { withWebPage, overrideFromEnv } from "./lib/web-page.mjs";

// DR_SRC: 고치기 전 판으로 같은 검사를 돌릴 때
// 기능 켜짐 상태는 서버에서 받으므로 켜진 것으로 고정
const overrides = { "/js/core/features.js": "export const featureHidden = () => new Set();", ...overrideFromEnv({ DR_SRC: "/js/diff-review/boot.js" }) };

test("diff 의견을 삭제·해결해 다시 그려도 펼친 이전 의견 상자와 열려 있던 줄 편집기의 포커스·커서를 유지", async () => {
  const r = await withWebPage((page) => page.evaluate(async () => {
    const hooks = await import("/js/core/hooks.js");
    const model = await import("/js/diff-review/model.js");
    const boot = await import("/js/diff-review/boot.js");
    const oldTab = { root: "/repo", path: "/repo/a.js", rel: "a.js", patch: "OLD" };
    const tab = { ...oldTab, patch: "@@ -1 +1 @@\n+new" };
    const s = model.createReviewStore();
    s.add(oldTab, "w1", { cls: "add", n: "1", text: "+x" }, "옛 의견 1", "n1");
    s.add(oldTab, "w1", { cls: "add", n: "2", text: "+y" }, "옛 의견 2", "n2");
    localStorage.setItem("iris.diffreview.v1", JSON.stringify(s.documents()));
    boot.initCapability({ showToast() {}, getLastAgents: () => [], getIsLocal: () => true, copyText() {} });
    const view = document.querySelector("#view"), toolbar = document.querySelector("#tb");
    const line = document.querySelector("#l0");
    const frame = { view, toolbar, lines: [line], tab, rows: [{ cls: "add", o: "", n: "1", text: "+new" }], spaceId: "w1" };
    const paint = () => hooks.callHook("diffreview.render", frame);
    paint();
    const box = () => document.querySelector("details.dr-stale");
    box().open = true;
    document.querySelector(".dr-line-action").click();          // 줄 편집기 열기
    const ta = () => document.querySelector(".dr-editor textarea");
    ta().value = "abcdef"; ta().dispatchEvent(new Event("input", { bubbles: true }));
    ta().setSelectionRange(2, 4);
    // 이전 의견 하나 삭제 → 다시 그림
    [...box().querySelectorAll("button")].find((b) => b.textContent === "삭제").click();
    return {
      open: !!box() && box().open,
      focused: !!ta() && document.activeElement === ta(),
      value: ta() && ta().value, sel: ta() && [ta().selectionStart, ta().selectionEnd],
    };
  }), { body: `<div id="view"><div id="tb"></div><div id="l0">line</div></div>`, overrides });
  assert.equal(r.open, true, "펼친 이전 의견 상자가 접히지 않음");
  assert.equal(r.focused, true, "줄 편집기 포커스 유지");
  assert.equal(r.value, "abcdef");
  assert.deepEqual(r.sel, [2, 4], "선택 범위 유지");
});
