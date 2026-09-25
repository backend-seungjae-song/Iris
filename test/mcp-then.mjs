// 행동 도구의 then: 행동 뒤 관측을 같은 호출에 붙인다. 가짜 서버로 MCP 를 실제로 띄워
// 서버에 간 명령의 순서와 돌아온 글을 본다.
import assert from "node:assert/strict";
import test from "node:test";
import { withMcp } from "./lib/mcp-child.mjs";

const ok = (cmd, args) => {
  if (cmd === "snapshot") return { ok: true, data: { url: "http://x/", refCount: 1, snapshot: '@e3 dialog "저장됨"', query: { role: args.role } } };
  if (cmd === "eval") return { ok: true, data: { value: { count: 2 } } };
  return { ok: true, data: { ref: "@e1" } };
};

test("then: 행동 → 대기 → 좁힌 스냅샷 → eval 순서로 보내고 한 결과에 담는다", async () => {
  await withMcp(ok, async (callTool, seen) => {
    const r = await callTool("browser_click", { ref: "@e1",
      then: { snapshot: { role: "dialog" }, eval: "({count: 2})", after_ms: 300 } });
    assert.deepEqual(seen.map((s) => s.cmd), ["click", "wait", "snapshot", "eval"]);
    assert.equal(seen[1].args.ms, 300);
    assert.equal(seen[2].args.budget, 4000);
    const text = r.content[0].text;
    assert.match(text, /행동 뒤 관측 \(300ms 뒤\)/);
    assert.match(text, /@e3 dialog "저장됨"/);
    assert.match(text, /eval: \{"count":2\}/);
    assert.ok(!r.isError);
  });
});

test("then: 좁히지 않은 스냅샷·모르는 이름은 행동을 보내기 전에 거절한다", async () => {
  await withMcp(ok, async (callTool, seen) => {
    const a = await callTool("browser_click", { ref: "@e1", then: { snapshot: {} } });
    const b = await callTool("browser_fill", { ref: "@e1", text: "x", then: { shot: true } });
    const c = await callTool("browser_click", { ref: "@e1", then: { eval: "1", after_ms: 9000 } });
    assert.ok(a.isError && b.isError && c.isError);
    assert.match(a.content[0].text, /좁혀야/);
    assert.equal(seen.length, 0);
  });
});

test("then: 행동이 실패하면 관측하지 않는다", async () => {
  await withMcp((cmd) => (cmd === "click" ? { ok: false, error: "요소를 찾지 못했습니다" } : ok(cmd, {})), async (callTool, seen) => {
    const r = await callTool("browser_click", { selector: "#none", then: { snapshot: { name: "저장" } } });
    assert.deepEqual(seen.map((s) => s.cmd), ["click"]);
    assert.ok(r.isError);
    assert.match(r.content[0].text, /행동이 실패해 관측하지 않았다/);
  });
});

test("then: 전달은 됐어도 페이지에서 실패한 행동 뒤에는 관측하지 않는다", async () => {
  await withMcp((cmd) => (cmd === "click" ? { ok: true, data: { ok: false, error: "크기가 0인 요소" } } : ok(cmd, {})), async (callTool, seen) => {
    const r = await callTool("browser_click", { selector: "h1", then: { eval: "1" } });
    assert.deepEqual(seen.map((s) => s.cmd), ["click"]);
    assert.match(r.content[0].text, /행동이 실패해 관측하지 않았다/);
  });
});

test("then 없는 행동 뒤 좁힌 관측을 따로 부르면 한 번만 알려 준다", async () => {
  await withMcp(ok, async (callTool) => {
    await callTool("browser_click", { ref: "@e1" });
    const first = await callTool("browser_snapshot", { role: "dialog" });
    await callTool("browser_click", { ref: "@e1" });
    const second = await callTool("browser_eval", { expression: "1" });
    assert.match(first.content[0].text, /then 에 적어/);
    assert.doesNotMatch(second.content[0].text, /then 에 적어/);
  });
});

test("then 은 행동 도구에만 있다", async () => {
  await withMcp(ok, async (callTool, seen) => {
    const r = await callTool("browser_snapshot", { role: "dialog", then: { eval: "1" } });
    assert.ok(r.isError);
    assert.equal(seen.length, 0);
  });
});
