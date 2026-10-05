// 커밋·스테이지·전환 뒤 git status 가 다시 오면 그 레포의 열린 diff 탭을 다시 요청한다.
// 요청하지 않으면 탭이 옛 patch 를 계속 보인다.
import assert from "node:assert/strict";
import test from "node:test";

globalThis.window ??= globalThis;
const { addTab, ensureTabSpace } = await import("../web/js/center/tab-store.js");
const { initDiff, refreshDiffTabs } = await import("../web/js/devtool/diff.js");

const sent = [];
initDiff({ $: () => null, esc: String, wsSend: (m) => sent.push(m), getSelectedSpaceId: () => "w1", renderTabs() {}, showActiveTab() {} });
ensureTabSpace("w1");
addTab("w1", { id: "d1", kind: "diff", path: "/r/a.txt", root: "/r", staged: false, untracked: true, mode: "", patch: "old" });
addTab("w1", { id: "d2", kind: "diff", path: "/r/b.txt", root: "/r", staged: true, mode: "", patch: "old" });
addTab("w1", { id: "d3", kind: "diff", path: "/o/c.txt", root: "/o", staged: false, mode: "", patch: "old" });
addTab("w1", { id: "d4", kind: "diff", path: "/r/x.txt", root: "/r", mode: "pullrequest", patch: "pr" });

test("status 가 온 레포의 커밋 전 diff 탭만 다시 요청한다", () => {
  sent.length = 0;
  refreshDiffTabs({ root: "/r", changes: [] });
  assert.deepEqual(sent.map((m) => [m.file, m.staged, m.untracked]), [["/r/a.txt", false, false], ["/r/b.txt", true, false]]);
});

test("아직 untracked 인 파일은 /dev/null 대비로 요청한다", () => {
  sent.length = 0;
  refreshDiffTabs({ root: "/r", changes: [{ abs: "/r/a.txt", code: "U" }] });
  assert.equal(sent.find((m) => m.file === "/r/a.txt").untracked, true);
});

test("소스 제어가 status 를 받을 때 부른다", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../web/js/devtool/source-control.js", import.meta.url), "utf8");
  const { sliceBetween } = await import("../bin/slice-anchor.mjs");
  const body = sliceBetween(src, "function scOnStatus(m)", "function scOnBranchDiff(");
  assert.match(body, /if \(m\.isRepo !== false\) \{[^}]*refreshDiffTabs\(m\);/);
});
