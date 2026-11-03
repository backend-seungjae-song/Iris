// iOS ASCII 밖 글자 붙여넣기 순서와 붙여넣기판 정리
import assert from "node:assert/strict";
import test from "node:test";
import { allowPastePoint, needsPaste, pasteIosText } from "../bin/mcp/idb-paste.mjs";

test("ASCII 밖 글자만 붙여넣기로 보낸다", () => {
  assert.equal(needsPaste("stick 12!"), false);
  assert.equal(needsPaste("스틱"), true);
  assert.equal(needsPaste("café"), true);
});

test("붙여넣기 허용 버튼 중심을 정수로 찾는다", () => {
  const button = (label) => ({ type: "Button", AXLabel: label, frame: { x: 100.4, y: 490, width: 190, height: 45.5 } });
  assert.deepEqual(allowPastePoint([{ AXLabel: "검색" }, button("붙여넣기 허용")]), { x: 195, y: 513 });
  assert.deepEqual(allowPastePoint([button("Allow Paste")]), { x: 195, y: 513 });
  assert.equal(allowPastePoint([button("붙여넣기 허용 안 함")]), null);
  assert.equal(allowPastePoint(null), null);
});

test("붙여넣기판에 넣고 Cmd+V, 허용을 누른 뒤 붙여넣기판을 비운다", async () => {
  const calls = [];
  const options = { pbcopy: async (_udid, value) => calls.push(["pbcopy", value]), cmdV: async () => calls.push(["cmdV"]),
    describe: async () => (calls.some((call) => call[0] === "tap") ? [] : [{ AXLabel: "붙여넣기 허용", frame: { x: 0, y: 0, width: 10, height: 10 } }]), tap: async (_udid, x, y) => calls.push(["tap", x, y]), wait: async () => {} };
  assert.deepEqual(await pasteIosText("U", "스틱", options), { allowed: true });
  assert.deepEqual(calls.filter((call) => call[0] !== "wait"), [["pbcopy", "스틱"], ["cmdV"], ["tap", 5, 5], ["pbcopy", ""]]);
});

test("창이 뜬 뒤 0.8초 기다렸다가 누르고, 창이 닫혀 앱 화면이 다시 읽힌 뒤에 붙여넣기판을 비운다", async () => {
  const calls = [];
  const dialog = [{ AXLabel: "붙여넣기 허용", frame: { x: 0, y: 0, width: 10, height: 10 } }];
  const app = [{ type: "Application", AXLabel: "마블워크" }];
  const trees = [dialog, dialog, app, app, [...app, { type: "TextField", AXValue: "스틱" }]];
  const options = { pbcopy: async (_udid, value) => calls.push(["pbcopy", value]), cmdV: async () => {},
    describe: async () => trees.shift(), tap: async () => calls.push(["tap"]), wait: async (ms) => calls.push(["wait", ms]) };
  assert.deepEqual(await pasteIosText("U", "스틱", options), { allowed: true });
  assert.deepEqual(calls.slice(1), [["wait", 800], ["tap"], ["wait", 800], ["wait", 250], ["pbcopy", ""]]);
  assert.equal(trees.length, 0);
});

test("누른 뒤에도 창이 남아 있으면 다시 누르고, 끝내 남으면 오류를 내고 붙여넣기판을 비운다", async () => {
  const calls = [];
  const dialog = [{ AXLabel: "붙여넣기 허용", frame: { x: 0, y: 0, width: 10, height: 10 } }];
  const options = { pbcopy: async (_udid, value) => calls.push(["pbcopy", value]), cmdV: async () => {},
    describe: async () => dialog, tap: async () => calls.push(["tap"]), wait: async () => {} };
  await assert.rejects(pasteIosText("U", "스틱", options), /붙여넣기 허용 창을 닫지 못했습니다/);
  assert.deepEqual(calls, [["pbcopy", "스틱"], ["tap"], ["tap"], ["tap"], ["pbcopy", ""]]);
});

test("확인 창이 뜨지 않으면 누르지 않고, 실패해도 붙여넣기판을 비운다", async () => {
  const calls = [];
  const base = { pbcopy: async (_udid, value) => calls.push(["pbcopy", value]), describe: async () => [], tap: async () => calls.push(["tap"]), wait: async () => {} };
  assert.deepEqual(await pasteIosText("U", "스틱", { ...base, cmdV: async () => {} }), { allowed: false });
  assert.equal(calls.some((call) => call[0] === "tap"), false);
  calls.length = 0;
  await assert.rejects(pasteIosText("U", "비밀", { ...base, cmdV: async () => { throw new Error("cmd 실패"); } }), /cmd 실패/);
  assert.deepEqual(calls, [["pbcopy", "비밀"], ["pbcopy", ""]]);
});
