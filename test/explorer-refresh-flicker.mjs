import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sliceBetween } from "../bin/slice-anchor.mjs";
import { withWebPage, overrideFromEnv } from "./lib/web-page.mjs";

// MAIN_SRC·TREE_SRC: 고치기 전 판의 파일로 같은 검사를 돌릴 때
const mainSrc = readFileSync(process.env.MAIN_SRC || new URL("../web/js/main.js", import.meta.url), "utf8");
const overrides = overrideFromEnv({ TREE_SRC: "/js/explorer/tree.js" });
// 폴더 변경 알림을 받았을 때 트리를 다루는 첫 문장(main.js handleDirChangedMessage)
const onDirChanged = sliceBetween(mainSrc, "function handleDirChangedMessage(m) {", "callHook(\"git.refreshFor\"", "폴더 변경 처리")
  .replace("function handleDirChangedMessage(m) {", "");

test("내려 둔 탐색기는 폴더 변경 알림을 받아도 응답 전까지 화면과 스크롤이 그대로", async () => {
  const r = await withWebPage((page) => page.evaluate(async (onDirChanged) => {
    document.body.innerHTML = `<div id="space-list"></div><span id="explorer-space"></span><button id="file-add"></button><button id="folder-add"></button>
      <div id="file-tree" style="height:200px;overflow-y:auto"></div>`;
    const tree = await import("/js/explorer/tree.js");
    const dirCache = new Map(), sent = [];
    const ROOT = "/p", SUB = "/p/shots";
    tree.initTree({
      $: (s) => document.querySelector(s), esc: (s) => String(s), wsSend: (m) => sent.push(m),
      orderedSpaces: () => [{ id: "s1", folder: ROOT, label: "p" }], getIsLocal: () => true, getSelectedSpaceId: () => "s1",
      getActiveFile: () => null, setActiveFile() {}, saveCollapsed() {}, syncWatchDirs() {}, collapsed: { dirs: new Set() }, dirCache,
    });
    dirCache.set(ROOT, [{ dir: true, name: "shots", path: SUB }, ...Array.from({ length: 15 }, (_, i) => ({ name: `r${i}.md`, path: `${ROOT}/r${i}.md` }))]);
    dirCache.set(SUB, Array.from({ length: 40 }, (_, i) => ({ name: `cs-${i}.png`, path: `${SUB}/cs-${i}.png` })));
    tree.renderFileTree();
    const box = document.getElementById("file-tree");
    box.scrollTop = 300;
    const before = { top: box.scrollTop, html: box.innerHTML };
    // main.js 의 문장을 그 모듈이 쓰는 이름으로 실행
    const scope = { m: { dir: SUB }, dirCache, ...tree };
    new Function(...Object.keys(scope), onDirChanged)(...Object.values(scope));
    const during = { top: box.scrollTop, same: box.innerHTML === before.html };
    return { before: before.top, during, asked: sent.some((m) => m.type === "fs.list" && m.path === SUB) };
  }, onDirChanged), { overrides });
  assert.equal(r.asked, true, "바뀐 폴더 목록을 다시 요청");
  assert.equal(r.during.same, true, "응답 전에 트리 내용이 바뀌지 않음");
  assert.equal(r.during.top, r.before, "응답 전에 스크롤 위치가 바뀌지 않음");
});
