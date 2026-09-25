import assert from "node:assert/strict";
import test from "node:test";

import { computeLayout, defaultTree, leafIds, moveRegion, normalizeTree, setKidSize } from "../web/js/core/layout-tree.js";

const BOX = { x: 52, y: 30, w: 1600, h: 900 };
const ctxOf = (hidden = [], extra = {}) => ({ visible: (id) => !hidden.includes(id), collapsedPx: () => null, toolKey: null, ...extra });
const base = ["tools", "emulator"]; // 평소: 도구 화면 없음, 기능 영역 비어 있음
const withEmu = () => normalizeTree(defaultTree(), { registered: [{ id: "emulator", size: 360 }] });

test("기본 배치: 사이드바 272(Spaces · Agents 위, 탐색기가 남은 높이), 채팅 400, 가운데가 나머지", () => {
  const { rects } = computeLayout(defaultTree(), BOX, ctxOf(base));
  assert.deepEqual(rects.spaces, { x: 52, y: 30, w: 272, h: 350 });
  assert.deepEqual(rects.explorer, { x: 52, y: 380, w: 272, h: 550 });
  assert.deepEqual(rects.center, { x: 324, y: 30, w: 928, h: 900 });
  assert.deepEqual(rects.chat, { x: 1252, y: 30, w: 400, h: 900 });
  assert.equal(rects.tools, undefined);
});

test("도구 화면이 열리면 사이드바 자리를 대신하고, 도구마다 저장한 폭을 쓴다", () => {
  const tree = defaultTree({ toolW: { "sc-panel": 360 } });
  const { rects } = computeLayout(tree, BOX, ctxOf(["emulator"], { toolKey: "tools:sc-panel" }));
  assert.deepEqual(rects.tools, { x: 52, y: 30, w: 360, h: 900 });
  assert.equal(rects.explorer, undefined);
  assert.equal(rects.center.w, 1600 - 360 - 400);
});

test("전체형 화면은 가운데가 빠진 자리까지 도구가 늘어난다", () => {
  const { rects } = computeLayout(defaultTree(), BOX, ctxOf(["emulator", "center"], { toolKey: "tools:ml-panel" }));
  assert.deepEqual(rects.tools, { x: 52, y: 30, w: 1600 - 400, h: 900 });
  assert.equal(rects.chat.w, 400);
});

test("채팅을 접으면 가운데가 그 자리를 받는다", () => {
  const { rects } = computeLayout(defaultTree(), BOX, ctxOf([...base, "chat"]));
  assert.equal(rects.center.w, 1600 - 272);
  assert.equal(rects.chat, undefined);
});

test("기능 영역은 등록한 크기로 채팅 왼쪽에 세로로 놓인다", () => {
  const { rects } = computeLayout(withEmu(), BOX, ctxOf(["tools"]));
  assert.deepEqual(rects.emulator, { x: 52 + 1600 - 400 - 360, y: 30, w: 360, h: 900 });
});

test("영역을 옮기면 빠진 자리는 형제가 나누고, 새 자리에서 나뉜다", () => {
  // 채팅을 가운데 아래로
  const t1 = moveRegion(defaultTree(), "chat", "center", "bottom", 300);
  const r1 = computeLayout(t1, BOX, ctxOf(base)).rects;
  assert.deepEqual(r1.center, { x: 324, y: 30, w: 1600 - 272, h: 600 });
  assert.deepEqual(r1.chat, { x: 324, y: 630, w: 1600 - 272, h: 300 });
  // 스페이스 칸을 채팅 오른쪽으로(같은 방향 split 에는 형제로 더한다)
  const t2 = moveRegion(defaultTree(), "spaces", "chat", "right", 250);
  const r2 = computeLayout(t2, BOX, ctxOf(base)).rects;
  assert.equal(r2.spaces.x, 52 + 1600 - 250);
  assert.equal(r2.spaces.h, 900);
  assert.deepEqual(r2.explorer, { x: 52, y: 30, w: 272, h: 900 });
  assert.equal(t2.kids.length, 4);
});

test("겹치기: 같은 자리에 두면 보이는 첫 영역을 표시한다", () => {
  const t = moveRegion(defaultTree(), "spaces", "chat", "stack");
  const r = computeLayout(t, BOX, ctxOf(base)).rects;
  assert.equal(r.spaces, undefined);
  assert.equal(r.chat.w, 400);
  const r2 = computeLayout(t, BOX, ctxOf([...base, "chat"])).rects;
  assert.deepEqual(r2.spaces, { x: 52 + 1600 - 400, y: 30, w: 400, h: 900 });
});

test("경계를 끌면 늘어나지 않는 쪽 크기가 바뀐다", () => {
  const { splits } = computeLayout(defaultTree(), BOX, ctxOf(base));
  const chatEdge = splits.find((s) => s.dir === "row" && s.sign === -1);
  assert.ok(chatEdge, "가운데와 채팅 사이 경계");
  const t = setKidSize(defaultTree(), chatEdge.path, chatEdge.index, chatEdge.key, 500);
  assert.equal(computeLayout(t, BOX, ctxOf(base)).rects.chat.w, 500);
});

test("접힌 칸은 머리 높이로 고정되고 그 칸 경계는 끌 수 없다", () => {
  const ctx = ctxOf(base, { collapsedPx: (id) => (id === "spaces" ? 30 : null) });
  const { rects, splits } = computeLayout(defaultTree(), BOX, ctx);
  assert.equal(rects.spaces.h, 30);
  assert.equal(rects.explorer.y, 60);
  assert.equal(rects.spaces.y, 30);
  // 남은 칸(explorer)이 늘어나는 칸이라 끌 수 있는 세로 경계가 없다.
  assert.equal(splits.filter((s) => s.dir === "col").length, 0);
});

test("늘어나는 칸(탐색기)을 접으면 접히지 않은 칸이 남은 높이를 받는다", () => {
  const ctx = ctxOf(base, { collapsedPx: (id) => (id === "explorer" ? 30 : null) });
  const { rects } = computeLayout(defaultTree(), BOX, ctx);
  assert.deepEqual(rects.spaces, { x: 52, y: 30, w: 272, h: 870 });
  assert.deepEqual(rects.explorer, { x: 52, y: 900, w: 272, h: 30 });
  // 둘 다 접히면 마지막 칸이 남은 자리를 받는다(예전과 같다).
  const both = computeLayout(defaultTree(), BOX, ctxOf(base, { collapsedPx: () => 30 })).rects;
  assert.equal(both.spaces.h, 30);
});

test("정규화: 깨진 저장본은 기본 배치로, 등록된 기능 영역은 채팅 왼쪽에 더한다", () => {
  assert.deepEqual(normalizeTree({ t: "leaf", id: "center" }), defaultTree());
  assert.deepEqual(normalizeTree("garbage"), defaultTree());
  assert.ok(!leafIds(defaultTree()).includes("emulator"));
  const back = normalizeTree(defaultTree(), { registered: [{ id: "emulator", size: 360 }] });
  const ids = leafIds(back);
  assert.equal(ids.filter((i) => i === "emulator").length, 1);
  assert.ok(ids.indexOf("emulator") < ids.indexOf("chat"));
  // 등록되지 않은 기능 영역은 지우지 않는다
  assert.ok(leafIds(normalizeTree(withEmu(), { registered: [] })).includes("emulator"));
  // 같은 id 가 두 번이면 하나만 남는다
  const dup = { t: "split", dir: "row", kids: [{ node: defaultTree(), size: {} }, { node: { t: "leaf", id: "chat" }, size: { base: 1 } }] };
  assert.equal(leafIds(normalizeTree(dup)).filter((i) => i === "chat").length, 1);
});

test("편집 화면은 겹친 자리에서 실제로 보이는 쪽을 먼저 보여 준다", () => {
  const ctx = { visible: () => true, prefer: (id) => !base.includes(id), collapsedPx: () => null, toolKey: null };
  const { rects, stacks } = computeLayout(defaultTree(), BOX, ctx);
  assert.ok(rects.explorer && !rects.tools);
  assert.deepEqual(stacks[0].members, [["tools"], ["spaces", "explorer"]]);
  const forced = computeLayout(defaultTree(), BOX, { ...ctx, pick: new Map([["0", 0]]) }).rects;
  assert.ok(forced.tools && !forced.explorer);
});

test("고정 크기의 합이 창보다 크면 가운데에 최소폭을 남기고 줄인다", () => {
  const { rects } = computeLayout(defaultTree(), { x: 0, y: 0, w: 700, h: 600 }, ctxOf(base));
  assert.ok(rects.center.w >= 160);
  assert.equal(rects.explorer.w + rects.center.w + rects.chat.w, 700);
});

test("합치기 전 저장본의 agents 칸은 지우고, 스페이스 칸이 남은 높이를 받는다", () => {
  const legacy = { t: "split", dir: "row", kids: [
    { node: { t: "stack", kids: [{ t: "leaf", id: "tools" }, { t: "split", dir: "col", kids: [
      { node: { t: "leaf", id: "explorer" }, size: { base: 300 } },
      { node: { t: "leaf", id: "spaces" }, size: { base: 182 } },
      { node: { t: "leaf", id: "agents" }, size: {} },
    ] }] }, size: { base: 280 } },
    { node: { t: "leaf", id: "center" }, size: {} },
    { node: { t: "leaf", id: "chat" }, size: { base: 420 } },
  ] };
  const t = normalizeTree(legacy);
  assert.ok(!leafIds(t).includes("agents"));
  const { rects } = computeLayout(t, BOX, ctxOf(base));
  assert.deepEqual(rects.explorer, { x: 52, y: 30, w: 280, h: 300 });
  assert.deepEqual(rects.spaces, { x: 52, y: 330, w: 280, h: 600 });
});
