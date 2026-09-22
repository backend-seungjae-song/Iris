import assert from "node:assert/strict";
import { checkAsync } from "../core.mjs";
import { runBrowserFileDropRuntime } from "../browser-file-drop-runtime.mjs";
import { openDroppedEntries } from "../../../web/js/center/file-drop.js";
import { initFileRouting, openDroppedLocal } from "../../../web/js/center/file-routing.js";
import { initBrowserState, getBrowserState, replaceBrowserState } from "../../../web/js/browser/state.js";
import { clearFileKinds, fileKinds, registerFileKind } from "../../../web/js/core/file-kinds.js";

export const cases = {
  "브라우저 드롭은 등록 뷰어 또는 인코딩한 file URL의 기존 열기 경로로 간다"() {
    const savedKinds = fileKinds(), savedState = getBrowserState();
    const urls = [], mutations = [], fallbacks = [];
    try {
      clearFileKinds(); registerFileKind({ id: "drop-test-viewer", test: (path) => path.endsWith(".sheet-test") });
      initBrowserState({ BROWSER_MODE: true, BOUND_SPACE: "drop-space", wsSend: (message) => mutations.push(message.mutation) });
      replaceBrowserState({ docked: false, tabsBySpace: {} });
      initFileRouting({ BROWSER_MODE: true, newBrowserTab: (url) => urls.push(url),
        acHost: { openInConsole: (path) => fallbacks.push(path), revealInFinder: (path) => fallbacks.push(path) },
        showToast: (message) => fallbacks.push(message) });
      for (const suffix of [".txt", ".md", ".html", ".png", ".pdf", ""]) openDroppedLocal("/tmp/한글 #100%" + suffix);
      assert.deepEqual(urls, [".txt", ".md", ".html", ".png", ".pdf", ""].map((suffix) => "file:///tmp/" + encodeURIComponent("한글 #100%" + suffix)));
      openDroppedLocal("/tmp/table.sheet-test");
      assert.equal(urls.length, 6);
      assert.deepEqual(mutations.at(-1), { op: "tab.open", space: "drop-space", id: "file:/tmp/table.sheet-test", kind: "drop-test-viewer", path: "/tmp/table.sheet-test", title: "table.sheet-test" });
      assert.deepEqual(fallbacks, []);
    } finally {
      clearFileKinds(); savedKinds.forEach(registerFileKind); replaceBrowserState(savedState);
    }
  },
  "드롭 릴레이는 폴더·잘못된 경로를 거절하고 다음 정상 파일을 연다"() {
    const opened = [], notices = [];
    openDroppedEntries([{ error: "directory", path: "/folder" }, { path: "file:///tmp/a" }, { path: "/tmp/\0bad" }, { error: "entry" }, { path: "/tmp/valid" }],
      (path) => opened.push(path), (message) => notices.push(message));
    assert.deepEqual(opened, ["/tmp/valid"]); assert.equal(notices.length, 4); assert.match(notices[0], /폴더/);
  },
  "실제 Chromium 파일 드롭이 호스트·격리 게스트까지 도달하고 사이트 업로드를 보존한다": runBrowserFileDropRuntime,
};

export default async function run() {
  for (const [name, test] of Object.entries(cases)) await checkAsync(name, test);
}
