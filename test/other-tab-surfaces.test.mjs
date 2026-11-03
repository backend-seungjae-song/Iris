import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { sliceBetween } from "../bin/slice-anchor.mjs";

const require = createRequire(import.meta.url);
const { createQaInputCommands } = require("../native/electron/cdp-qa-input.cjs");

// 다른 탭의 확인 창·선택 목록이 사람이 보는 화면에 뜨지 않는지

const webviewSource = readFileSync(new URL("../web/js/browser/webview.js", import.meta.url), "utf8");
const pendingSource = sliceBetween(webviewSource, "export function pendingDialogTabId(", "\nexport function renderTabDialog(", "확인 창 대상 탭")
  .replace("export function", "function");
// shown: 앞에 그려진 탭, behind: 뒤에 깔려 그려지는 QA 탭, hiddenStack: 브라우저 칸이 숨은 상태
// held: 캡처 동안만 화면 위로 올린 안 보이는 탭
const pendingDialogTabId = ({ active, dialogs, shown = [], behind = [], hiddenStack = false, held = [] }) => new Function("activeBrowserId", "getWebview", "tabDialogs",
  `${pendingSource}\nreturn pendingDialogTabId();`)(() => active,
  (id) => ({
    getClientRects: () => (shown.includes(id) || behind.includes(id) || held.includes(id) ? [{}] : []),
    dataset: held.includes(id) ? { acHeld: " " } : {},
    classList: { contains: (c) => (c === "qa-owned" ? behind.includes(id) : c === "active" ? shown.includes(id) : false) },
    closest: (sel) => (hiddenStack && /\[hidden\]/.test(sel) ? {} : null),
  }), dialogs);

test("확인 창은 보고 있는 탭이나 화면에 그려진 탭의 것만 띄움", () => {
  const dialogs = { "tab-ai": { kind: "confirm", message: "주문할까요" } };
  assert.equal(pendingDialogTabId({ active: "tab-user", dialogs, shown: ["tab-user"] }), null, "다른 탭 확인 창은 띄우지 않음");
  assert.equal(pendingDialogTabId({ active: "tab-ai", dialogs, shown: [] }), "tab-ai");
  assert.equal(pendingDialogTabId({ active: "tab-user", dialogs, shown: ["tab-ai"] }), "tab-ai", "활성 판정이 어긋나도 보이는 탭이면 띄움");
  assert.doesNotMatch(webviewSource, /\(다른 탭\)/);
});

test("뒤에 깔려 그려지는 QA 탭이나 숨은 브라우저 칸의 탭 확인 창은 띄우지 않음", () => {
  const dialogs = { "tab-qa": { kind: "alert", message: "응모 완료" } };
  assert.equal(pendingDialogTabId({ active: "tab-user", dialogs, shown: ["tab-user"], behind: ["tab-qa"] }), null, "QA 탭 알림이 보는 탭 위에 뜨지 않음");
  assert.equal(pendingDialogTabId({ active: "tab-qa", dialogs, behind: [], shown: ["tab-qa"] }), "tab-qa", "QA 탭을 앞에 띄우면 뜸");
  assert.equal(pendingDialogTabId({ active: "tab-user", dialogs: { "tab-x": { kind: "alert", message: "x" } }, shown: ["tab-x"], hiddenStack: true }), null);
});

test("캡처 동안 올린 안 보이는 탭의 확인 창은 띄우지 않음", () => {
  const dialogs = { "tab-bg": { kind: "confirm", message: "삭제할까요" } };
  assert.equal(pendingDialogTabId({ active: "tab-user", dialogs, shown: ["tab-user"], held: ["tab-bg"] }), null);
});

function qaFixture() {
  const calls = [];
  const send = async (method, params = {}) => {
    calls.push({ method, params });
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
    if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 500, clientHeight: 300 } };
    if (method === "DOM.getNodeForLocation") return { backendNodeId: 7 };
    if (method === "Accessibility.getPartialAXTree") return { nodes: [{ backendDOMNodeId: 7, role: { value: "combobox" }, name: { value: "수량" } }] };
    if (method === "DOM.describeNode") return { node: { localName: "select", attributes: [] } };
    if (method === "DOM.resolveNode") return { object: { objectId: "node" } };
    if (method === "Runtime.callFunctionOn") return { result: { value: { top: true, disabled: false } } };
    if (method === "Runtime.evaluate") return { result: { value: params.expression.includes("inspectLoginPage") ? { fields: [], reasons: [] }
      : params.expression.includes("capture.events") ? [{ type: "click", trusted: true }] : { fields: [], reasons: [] } } };
    return {};
  };
  send.on = () => send;
  send.frames = () => [null];
  return { send, calls };
}
const guardIndex = (calls) => calls.findIndex((c) => c.method === "Runtime.evaluate" && /preventDefault/.test(c.params.expression || ""));
const pressIndex = (calls) => calls.findIndex((c) => c.method === "Input.dispatchMouseEvent" && c.params.type === "mousePressed");

test("안 보이는 탭의 QA 누르기는 누르기 전에 선택 목록 창을 막고, 보이는 탭은 그대로 누름", async () => {
  const hidden = qaFixture();
  await createQaInputCommands({ isTabShown: () => false })["qa-input"](hidden.send, {}, { action: "click", x: 20, y: 20 });
  assert.ok(guardIndex(hidden.calls) >= 0, "가드를 검");
  assert.ok(guardIndex(hidden.calls) < pressIndex(hidden.calls), "누르기 전에 검");
  assert.match(hidden.calls[guardIndex(hidden.calls)].params.expression, /let left = 1;/);
  const shown = qaFixture();
  await createQaInputCommands({ isTabShown: () => true })["qa-input"](shown.send, {}, { action: "click", x: 20, y: 20 });
  assert.equal(guardIndex(shown.calls), -1);
  assert.ok(pressIndex(shown.calls) >= 0);
});
