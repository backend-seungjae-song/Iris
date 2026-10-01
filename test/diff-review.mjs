import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createReviewStore, reviewKey, reviewDraft } from "../web/js/diff-review/model.js";
import { initDiffReviewHandler, handleDiffReview } from "../server/diff-review-handler.js";
const tab = { root: "/repo", path: "/repo/a.js", rel: "a.js", patch: "@@ -1 +1 @@\n-old\n+new" };
test("줄 의견은 비교 종류·스페이스·old/new 번호를 보존한다", () => {
  const s = createReviewStore();
  const n = s.add(tab, "w1", { cls: "del", o: "7", n: "", text: "-old" }, "고쳐 주세요", "1");
  assert.equal(n.line, 7); assert.equal(n.side, "old");
  const key = reviewKey(tab, "w1");
  assert.equal(s.current(key, tab.patch).length, 1);
  assert.equal(s.current(reviewKey({ ...tab, staged: true }, "w1"), tab.patch).length, 0);
  assert.equal(s.current(reviewKey(tab, "w2"), tab.patch).length, 0);
  assert.match(reviewDraft(tab, [n]), /변경 전 7행/);
});
test("patch 변경은 이전 의견을 재배치·해결하지 않고 분리한다", () => {
  const s = createReviewStore(), key = reviewKey(tab, "w1");
  s.add(tab, "w1", { cls: "add", n: "1", text: "+new" }, "의견", "1");
  assert.equal(s.current(key, "changed").length, 0);
  assert.equal(s.stale(key, "changed").length, 1);
  assert.equal(s.stale(key, "changed")[0].resolved, false);
  s.remove(key, "1"); assert.equal(s.documents().length, 0);
});
test("원격은 초안 writer를 호출하지 않는다", async () => {
  let calls = 0; initDiffReviewHandler({ draftWriter: async () => { calls++; } });
  const messages = []; await handleDiffReview({ _local: false, readyState: 1, send: (s) => messages.push(JSON.parse(s)) }, { type: "diffreview.draft", requestId: "1" });
  assert.equal(calls, 0); assert.equal(messages[0].error.code, "LOCAL_ONLY");
});

test("전달 창을 연 뒤 patch가 바뀌면 실제 제출 handler가 전송을 막는다", () => {
  const body = { children: [], append(...items) { this.children.push(...items); } };
  const createElement = () => ({ children: [], setAttribute() {}, addEventListener() {}, showModal() {},
    append(...items) { this.children.push(...items); } });
  const sent = [];
  const source = fs.readFileSync(new URL("../web/js/diff-review/boot.js", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "").replace("export function initCapability", "function initCapability");
  const context = vm.createContext({ document: { body, createElement, activeElement: null },
    createDropdown: () => ({ el: createElement(), destroy() {} }), reviewDraft,
    crypto: { randomUUID: () => "test-request" }, setTimeout: () => 1,
    provide() {}, featureHidden: () => new Set() });
  context.testCtx = { getIsLocal: () => true, wsIsOpen: () => true,
    getLastAgents: () => [{ paneId: "p1", terminalId: "t1", workspaceId: "w1", agent: "codex", status: "idle" }],
    wsSend: (message) => sent.push(message) };
  context.testFrame = { tab: { ...tab }, spaceId: "w1", view: { isConnected: false } };
  context.testNotes = [{ side: "new", line: 1, text: "의견", excerpt: "+new", resolved: false }];
  vm.runInContext(source + "\nctx = testCtx; openSend(testFrame, testNotes);", context);
  const popup = body.children[0];
  const actions = popup.children.find((element) => element.className === "dr-send-actions");
  const submit = actions?.children.find((element) => element.textContent === "입력창에 넣기");
  assert.ok(submit);
  context.testFrame.tab.patch = "changed";
  submit.onclick();
  assert.equal(sent.length, 0);
  assert.equal(submit.disabled, true);
  assert.match(popup.children.find((element) => element.className === "dr-delivery-status").textContent, /diff가 바뀌었습니다/);
});
