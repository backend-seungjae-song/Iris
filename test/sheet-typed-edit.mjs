// 글자를 쳐서 시작한 칸 편집은 한 글자만 쳐도 확정된다.
// 확인 결과: 입력칸이 친 글자로 열리면서 그 글자가 원래 값으로 저장되어, "3" 칸에 "9" 를 치고
// Enter 를 누르면 바뀐 것이 없다고 판정되어 버려졌다.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const sheetEdit = fs.readFileSync("web/js/sheet/edit.js", "utf8");

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  const brace = source.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  assert.fail(`${name} body must terminate`);
}

function harness(cellValue) {
  const applied = [];
  const host = {
    children: [],
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 500, height: 300 }),
    appendChild(el) { el.isConnected = true; el.parentNode = host; this.children.push(el); },
    removeChild(el) { el.isConnected = false; el.parentNode = null; },
  };
  const context = {
    fileview: { contains: () => true },
    document: {
      createElement: () => ({ style: {}, value: "", focus() {}, select() {}, addEventListener() {}, scrollHeight: 20 }),
    },
    svSheet: () => ({ src: { "1,1": cellValue } }),
    svCellEl: () => ({ getBoundingClientRect: () => ({ left: 10, top: 10, width: 80, height: 20 }) }),
    svOverlayHost: () => host,
    svSrcAt: (sh, r, c) => sh.src[r + "," + c] ?? "",
    svApply: (_t, changes) => applied.push(...changes),
    svSet: () => {},
    svPane: () => null,
  };
  vm.runInNewContext(functionSource(sheetEdit, "svEdit") + "\n" + functionSource(sheetEdit, "svCloseEdit"),
    context, { filename: "web/js/sheet/edit.js#cell-edit" });
  return { context, applied };
}

test("한 글자를 쳐서 시작한 편집을 Enter 로 확정하면 칸에 들어간다", () => {
  const { context, applied } = harness("3");
  const tab = { sheetIdx: 0 };
  context.svEdit(tab, 1, 1, "9");
  context.svCloseEdit(tab, true, [1, 0]);
  assert.equal(JSON.stringify(applied), JSON.stringify([{ r: 1, c: 1, src: "9" }]));
});

test("값을 바꾸지 않고 닫으면 편집이 생기지 않는다", () => {
  const { context, applied } = harness("3");
  const tab = { sheetIdx: 0 };
  context.svEdit(tab, 1, 1);
  context.svCloseEdit(tab, true, [1, 0]);
  assert.deepEqual(applied, []);
});

test("원래 값과 같은 글자를 쳐서 확정하면 편집이 생기지 않는다", () => {
  const { context, applied } = harness("3");
  const tab = { sheetIdx: 0 };
  context.svEdit(tab, 1, 1, "3");
  context.svCloseEdit(tab, true, [1, 0]);
  assert.deepEqual(applied, []);
});
