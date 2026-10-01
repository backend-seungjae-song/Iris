import assert from "node:assert/strict";
import { collectResults, filterResults } from "../web/js/unified-search/model.js";
import { replaceHerdrState } from "../web/js/herdr/state.js";
import { addTab, replaceTabs } from "../web/js/center/tab-store.js";

replaceHerdrState({ agents: [], workspaces: [], tabs: {
  alpha: [{ tabId: "terminal-1", label: "첫 터미널", number: 1 }], beta: [],
} });
replaceTabs("alpha", []);
replaceTabs("beta", []);
addTab("alpha", { id: "browser-1", kind: "browser", label: "오래된 제목" });
addTab("beta", { id: "file:/beta/src/b.js", kind: "file", label: "b.js", path: "/beta/src/b.js" });

const spaces = [{ id: "alpha", label: "첫 스페이스", folder: "/alpha" },
  { id: "beta", label: "둘째 스페이스", folder: "/beta" }];
const rows = collectResults({ spaces,
  agents: [{ workspaceId: "beta", paneId: "agent-1", tabLabel: "검토", agent: "codex" }],
  browserState: { tabsBySpace: { alpha: [
    { id: "browser-1", title: "최신 제목", url: "https://example.com" },
    { id: "browser-2", title: "분리 탭", url: "https://example.org" },
  ] } },
  filesByRoot: new Map([["/alpha", ["/alpha/src/a.js"]], ["/beta", ["/beta/src/b.js"]]]) });

assert.equal(rows.filter((row) => row.kind === "스페이스").length, 2);
assert.equal(rows.filter((row) => row.kind === "에이전트").length, 1);
assert.equal(rows.filter((row) => row.kind === "탭" && row.id === "browser-1").length, 1);
assert.equal(rows.find((row) => row.id === "browser-1").title, "최신 제목");
assert.equal(rows.find((row) => row.id === "/beta/src/b.js").spaceId, "beta");
assert.equal(filterResults(rows, "파일", "src/b").length, 1);
assert.equal(filterResults(rows, "에이전트", "검토")[0].spaceId, "beta");
assert.equal(filterResults(rows, "전체", "example.org")[0].id, "browser-2");
