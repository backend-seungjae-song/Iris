import assert from "node:assert/strict";
import test from "node:test";

import { initRun, requestRunList, handleRunMessage } from "../web/js/devtool/run.js";
import { setCenterSpace } from "../web/js/center/tab-store.js";

// 실행 패널이 어느 경로의 스크립트를 묻고 실행하는지. 고른 스페이스의 경로가 없을 때 다른 스페이스
// 경로를 쓰면 패널과 실행 보호(dataset.path 대조)가 둘 다 남의 프로젝트를 가리킨다.
const agents = [{ workspaceId: "proj", cwd: "/w/proj" }];
const spaces = [
  { id: "home", folder: "/Users/you" },          // 에이전트 없는 홈 스페이스
  { id: "proj", folder: "/w/proj-folder" },
  { id: "bare", folder: null },                  // 경로를 전혀 모르는 스페이스
];
let selected = null;
const sent = [];
const body = { dataset: {}, innerHTML: "", listener: null, addEventListener(_t, fn) { this.listener = fn; } };
const meta = { textContent: "", innerHTML: "" };
initRun({
  $: (sel) => (sel === "#run-body" ? body : sel === "#run-meta" ? meta : null),
  esc: (s) => String(s),
  wsSend: (m) => sent.push(m),
  browserMode: false,
  spaceRootFor: (sp) => agents.find((a) => a.workspaceId === sp)?.cwd || null,
  getSelectedSpaceId: () => selected,
  getSpaces: () => spaces,
  openBrowser() {}, consoleSpace: () => null, newTabId: () => "t",
});
const paths = () => sent.map((m) => m.path);
const reset = () => { sent.length = 0; body.innerHTML = ""; delete body.dataset.path; };
const click = (act, script) => body.listener({ target: { closest: (q) => (q === "[data-run-act]" ? { dataset: { runAct: act, script } } : null) } });

test("에이전트가 있는 스페이스는 에이전트 cwd 를 쓴다", () => {
  reset(); selected = "proj"; setCenterSpace("home");
  requestRunList();
  assert.deepEqual(paths(), ["/w/proj", "/w/proj"]);
});

test("에이전트 없는 홈 스페이스는 그 스페이스 폴더를 쓰고 가운데 스페이스로 대신하지 않는다", () => {
  reset(); selected = "home"; setCenterSpace("proj");
  requestRunList();
  assert.deepEqual(paths(), ["/Users/you", "/Users/you"]);
  handleRunMessage({ type: "run-scripts", path: "/Users/you", ok: true, scripts: {} });
  assert.match(body.innerHTML, /스크립트 없음/);
  assert.equal(body.dataset.path, "/Users/you");
});

test("고른 스페이스의 경로를 모르면 다른 스페이스 경로를 묻지 않는다", () => {
  reset(); selected = "bare"; setCenterSpace("proj");
  requestRunList();
  assert.deepEqual(sent, []);
  assert.match(body.innerHTML, /스페이스를 선택하세요/);
});

test("고른 스페이스가 없을 때만 가운데 스페이스를 쓴다", () => {
  reset(); selected = null; setCenterSpace("proj");
  requestRunList();
  assert.deepEqual(paths(), ["/w/proj", "/w/proj"]);
});

test("패널이 이전 스페이스 것으로 그려져 있으면 실행하지 않고 새로 묻는다", () => {
  reset(); selected = "proj"; setCenterSpace(null);
  handleRunMessage({ type: "run-scripts", path: "/w/proj", ok: true, scripts: { dev: "vite" } });
  assert.equal(body.dataset.path, "/w/proj");
  selected = "home"; sent.length = 0;
  click("start", "dev");
  assert.ok(!sent.some((m) => m.type === "run.start"), "이전 스페이스의 스크립트를 실행했다");
  assert.deepEqual(sent.map((m) => m.type), ["run.list", "run.status"]);
  assert.deepEqual(paths(), ["/Users/you", "/Users/you"]);
});

test("같은 스페이스로 그려진 패널에서는 그 경로로 실행한다", () => {
  reset(); selected = "home"; setCenterSpace("proj");
  handleRunMessage({ type: "run-scripts", path: "/Users/you", ok: true, scripts: { dev: "x" } });
  sent.length = 0;
  click("start", "dev");
  assert.deepEqual(sent, [{ type: "run.start", path: "/Users/you", script: "dev" }]);
});
