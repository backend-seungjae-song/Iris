import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sliceBetween } from "../bin/slice-anchor.mjs";

// 앱 쪽 적용이 실패하면 화면 쪽 지정 기록을 실패 전 값으로 되돌리는지
// - 기록만 지우면 페이지에는 크기가 남은 채 크기 메뉴의 해제가 비활성이 됨

const source = readFileSync(new URL("../web/js/panel/viewport.js", import.meta.url), "utf8");
const body = sliceBetween(source, "export async function applyViewport(", "\n// 지정한 크기 그대로", "applyViewport")
  .replace("export async function", "async function");

function rig(result) {
  const viewportByTab = { t1: { w: 390, h: 844 } };
  const toasts = [];
  const calls = { layout: 0 };
  const apply = new Function("getWebview", "viewportByTab", "setTouchDrag", "updateSizeBtn", "viewportLayout", "showToast", "acHost", "deviceClassOf",
    `${body}\nreturn applyViewport;`)(
    () => ({ el: { getWebContentsId: () => 11 } }), viewportByTab, () => {}, () => {}, () => { calls.layout++; },
    (msg, o) => toasts.push({ msg, level: o && o.level }), { setViewport: async () => result }, () => "모바일");
  return { apply, viewportByTab, toasts, calls };
}

test("해제가 실패하면 지정 크기를 남겨 다시 해제할 수 있음", async () => {
  const r = rig({ ok: false, error: "세션 끊김" });
  await r.apply("t1", null);
  assert.deepEqual(r.viewportByTab.t1, { w: 390, h: 844 });
  assert.equal(r.toasts.at(-1).level, "err");
});

test("크기 변경이 실패하면 이전 크기로 되돌림", async () => {
  const r = rig({ ok: false, error: "x" });
  await r.apply("t1", { w: 820, h: 1180 });
  assert.deepEqual(r.viewportByTab.t1, { w: 390, h: 844 });
});

test("해제가 성공하면 기록을 지움", async () => {
  const r = rig({ ok: true, cleared: true });
  await r.apply("t1", null);
  assert.equal(r.viewportByTab.t1, undefined);
});
