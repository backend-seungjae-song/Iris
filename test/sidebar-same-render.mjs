import test from "node:test";
import assert from "node:assert/strict";
import { withWebPage, overrideFromEnv } from "./lib/web-page.mjs";

// TREE_SRC: 고치기 전 판의 tree.js 로 같은 검사를 돌릴 때
const overrides = overrideFromEnv({ TREE_SRC: "/js/explorer/tree.js" });

test("상태 방송으로 같은 스페이스 목록·파일 트리를 다시 그리면 줄을 새로 만들지 않음", async () => {
  const r = await withWebPage((page) => page.evaluate(async () => {
    document.body.innerHTML = `<div id="space-list"></div><span id="explorer-space"></span><button id="file-add"></button><button id="folder-add"></button><div id="file-tree"></div>`;
    const tree = await import("/js/explorer/tree.js");
    const dirCache = new Map([["/p", [{ name: "a.md", path: "/p/a.md" }]]]);
    tree.initTree({
      $: (s) => document.querySelector(s), esc: (s) => String(s), wsSend() {},
      orderedSpaces: () => [{ id: "s1", folder: "/p", label: "p" }, { id: "s2", folder: "/q", label: "q" }], getIsLocal: () => true, getSelectedSpaceId: () => "s1",
      getActiveFile: () => null, setActiveFile() {}, saveCollapsed() {}, syncWatchDirs() {}, collapsed: { dirs: new Set() }, dirCache,
    });
    tree.renderSpaces(); tree.renderFileTree();
    const row = document.querySelector(".space-row"), file = document.querySelector(".fitem.file");
    tree.renderSpaces(); tree.renderFileTree();
    const kept = { row: document.querySelector(".space-row") === row, file: document.querySelector(".fitem.file") === file };
    // 다른 코드가 DOM 을 직접 바꿨으면 다시 그려 되돌림
    row.querySelector(".space-name").textContent = "고치는 중";
    tree.renderSpaces();
    const restored = document.querySelector(".space-row .space-name").textContent;
    return { kept, restored };
  }), { overrides });
  assert.equal(r.kept.row, true, "스페이스 줄 유지");
  assert.equal(r.kept.file, true, "파일 줄 유지");
  assert.equal(r.restored, "p", "직접 바뀐 DOM 은 다시 그림");
});
