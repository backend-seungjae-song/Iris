// 대상을 못 찾은 행동은 지금 화면의 후보를 같은 결과에 붙인다. 누르지는 않는다.
import assert from "node:assert/strict";
import test from "node:test";
import { withMcp } from "./lib/mcp-child.mjs";

const SNAP = '[@e1] button "저장"\n[@e2] button "취소"';
const page = (miss) => (cmd, args) => {
  if (cmd === "snapshot") {
    if (args.name && !"저장 취소".includes(args.name)) return { ok: true, data: { url: "http://x/", refCount: 0, snapshot: "" } };
    return { ok: true, data: { url: "http://x/", refCount: 2, snapshot: args.name ? `[@e7] button "${args.name}"` : SNAP } };
  }
  if (cmd === "click") return miss;
  return { ok: true, data: {} };
};
const NOT_FOUND = { ok: false, error: '선택자에 맞는 요소가 없습니다: button:has-text("저장")' };
const EXPIRED = { ok: false, error: "페이지가 이동되어 ref가 만료됐습니다 — 재-snapshot 필요." };

test("선택자에 든 문구로 좁힌 후보를 붙이고 누르지 않는다", async () => {
  await withMcp(page(NOT_FOUND), async (callTool, seen) => {
    const r = await callTool("browser_click", { selector: 'button:has-text("저장")' });
    assert.deepEqual(seen.map((s) => s.cmd), ["click", "snapshot"]);
    assert.equal(seen[1].args.name, "저장");
    assert.ok(r.isError);
    assert.match(r.content[0].text, /좁힌 이름: "저장", 누르지 않았다/);
    assert.match(r.content[0].text, /\[@e7\] button "저장"/);
  });
});

test("만료된 ref 는 마지막 snapshot 에서 본 이름으로 좁힌다", async () => {
  await withMcp(page(EXPIRED), async (callTool, seen) => {
    await callTool("browser_snapshot", {});
    await callTool("browser_click", { ref: "@e2" });
    assert.deepEqual(seen.map((s) => s.cmd), ["snapshot", "click", "snapshot"]);
    assert.equal(seen[2].args.name, "취소");
  });
});

test("좁힌 이름으로 없으면 화면 앞부분을 붙인다", async () => {
  await withMcp(page(NOT_FOUND), async (callTool, seen) => {
    const r = await callTool("browser_click", { selector: '[aria-label="없는버튼"]' });
    assert.deepEqual(seen.map((s) => s.cmd), ["click", "snapshot", "snapshot"]);
    assert.equal(seen[2].args.name, undefined);
    assert.match(r.content[0].text, /좁힌 이름 "없는버튼"에 맞는 요소가 없어 화면 앞부분/);
  });
});

test("다른 실패와 성공에는 붙이지 않는다", async () => {
  await withMcp(page({ ok: false, error: "숨겨진 요소" }), async (callTool, seen) => {
    await callTool("browser_click", { selector: "#x" });
    assert.deepEqual(seen.map((s) => s.cmd), ["click"]);
  });
  await withMcp(page({ ok: true, data: { ok: true } }), async (callTool, seen) => {
    await callTool("browser_click", { selector: "#x" });
    assert.deepEqual(seen.map((s) => s.cmd), ["click"]);
  });
});
