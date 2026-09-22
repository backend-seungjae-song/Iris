import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const centerTabs = fs.readFileSync("web/js/center/tabs.js", "utf8");
const sheetEdit = fs.readFileSync("web/js/sheet/edit.js", "utf8");
const sheetTabState = fs.readFileSync("web/js/sheet/tab-state.js", "utf8");

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  let brace = source.indexOf("{", start);
  assert.ok(brace >= 0, `${name} must have a body`);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  assert.fail(`${name} body must terminate`);
}

test("formula bar edit stays owned by its original cell", () => {
  const applied = [];
  const context = {
    fileview: { contains: () => true },
    svApply: (_tab, changes) => applied.push(...changes),
  };
  vm.runInNewContext(
    functionSource(sheetEdit, "svFormulaEditorDirty") + "\n" + functionSource(sheetEdit, "svCloseFormulaEdit"),
    context,
    { filename: "web/js/sheet/edit.js#formula-edit" },
  );

  const input = { isConnected: true, value: "기존값" };
  const tab = {
    sheetIdx: 0,
    _svSel: { r1: 9, c1: 9, r2: 9, c2: 9 },
    _svFxEd: { el: input, si: 0, r: 2, c: 3, orig: "기존값" },
  };
  assert.equal(context.svFormulaEditorDirty(tab), false);
  context.svCloseFormulaEdit(tab, true);
  assert.deepEqual(applied, [], "moving selection without typing must not create an edit");

  input.value = "사용자 수정";
  tab._svFxEd = { el: input, si: 0, r: 2, c: 3, orig: "기존값" };
  assert.equal(context.svFormulaEditorDirty(tab), true);
  context.svCloseFormulaEdit(tab, true);
  assert.equal(JSON.stringify(applied), JSON.stringify([{ r: 2, c: 3, src: "사용자 수정" }]),
    "a real edit must commit to the cell that owned the formula bar");
});

test("clean external sheet data replaces the view before no input is marked dirty", () => {
  const oldData = { sheets: [{ name: "목록", _cfi: [1] }] };
  const newData = { sheets: [{ name: "목록", _cfi: [2] }] };
  const events = [];
  const tab = {
    sheet: oldData,
    sheetIdx: 0,
    _svEd: {},
    _svFxEd: {},
    _svUndo: [1],
    _svRedo: [1],
    _svLayout: { stale: true },
  };
  // 이 함수는 다루는 칸이 전부 표의 것이라 앱 셸이 아니라 시트에 있다. 그래서 편집기
  // 닫기도 훅 이름이 아니라 같은 모듈의 함수를 직접 부른다. 여기서는 그 둘을 대신 채워 준다.
  const context = {
    isTabDirty: () => false,
    svCloseEdit: (target, commit) => {
      assert.equal(target.sheet, oldData);
      events.push(["cell", commit]);
      target._svEd = null;
    },
    svCloseFormulaEdit: (target, commit) => {
      assert.equal(target.sheet, oldData);
      events.push(["formula", commit]);
      target._svFxEd = null;
    },
  };
  vm.runInNewContext(functionSource(sheetTabState, "svApplyResponseData"), context,
    { filename: "web/js/sheet/tab-state.js#external-sheet" });

  assert.equal(context.svApplyResponseData(tab, newData), true);
  assert.equal(tab.sheet, newData);
  assert.deepEqual(events, [["cell", false], ["formula", false]],
    "unchanged open inputs must be discarded against the old snapshot before replacement");
  assert.equal("_cfi" in newData.sheets[0], false);

  const dirtyTab = { sheet: oldData, sheetIdx: 0 };
  context.isTabDirty = () => true;
  assert.equal(context.svApplyResponseData(dirtyTab, newData), false);
  assert.equal(dirtyTab.sheet, oldData, "real edits must still block external replacement");
});
