// 에이전트 없이 셸만 열린 스페이스에서도 파일 검색과 터미널 상대 경로가 스페이스 폴더를 기준으로 동작해야 한다.
// 에이전트 cwd 만 보면 파일 검색은 "열린 스페이스가 없습니다", 상대 경로 ⌘클릭은 "경로를 해석할 수 없습니다"가 된다.
import assert from "node:assert/strict";
import test from "node:test";

globalThis.window = { innerWidth: 1200 };
const state = await import("../web/js/herdr/state.js");
const palette = await import("../web/js/center/file-palette.js");
const routing = await import("../web/js/center/file-routing.js");

const toasts = [], requested = [];
let agents = [];
palette.initFilePalette({ esc: (s) => s, wsSend: () => {}, getLastAgents: () => agents });
routing.initFileRouting({
  $: () => ({ classList: { add() {}, remove() {} } }), showToast: (m) => toasts.push(m), acHost: null,
  terminalBarePathToken: (s) => s, agentByPane: (p) => agents.find((a) => a.paneId === p), BROWSER_MODE: false,
  makeFileTab: (path) => ({ id: "file:" + path, path }), requestFileContent: (path) => requested.push(path),
  trackFileWatch: () => {}, renderTabs: () => {}, showActiveTab: () => {}, persistFileTabs: () => {},
  syncWatchDirs: () => {}, newBrowserTab: () => {}, getHostHome: () => "/Users/x", getCurTarget: () => null,
  getLastAgents: () => agents, getSelectedSpaceId: () => "w2",
});
state.replaceHerdrState({ agents: [], workspaces: [{ id: "w2", folder: "/p/sample" }] });

test("셸만 있는 스페이스의 루트는 스페이스 폴더다", () => {
  agents = [];
  assert.equal(palette.spaceRootFor("w2"), "/p/sample");
});

test("에이전트가 있으면 그 cwd 를 먼저 쓴다", () => {
  agents = [{ paneId: "w2:p1", workspaceId: "w2", cwd: "/p/sample/sub" }];
  assert.equal(palette.spaceRootFor("w2"), "/p/sample/sub");
  agents = [];
});

test("셸 출력의 상대 경로는 스페이스 폴더 기준으로 연다", () => {
  agents = []; toasts.length = 0; requested.length = 0;
  routing.openTerminalPath("src/a.js");
  assert.deepEqual(toasts, []);
  assert.deepEqual(requested, ["/p/sample/src/a.js"]);
});

test("스페이스 폴더 밖으로 나가는 상대 경로는 열지 않는다", () => {
  agents = []; toasts.length = 0; requested.length = 0;
  routing.openTerminalPath("../other/b.js");
  assert.deepEqual(requested, []);
  assert.match(toasts[0] || "", /작업 폴더 밖/);
});
