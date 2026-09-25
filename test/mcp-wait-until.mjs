// browser_wait until: 조건이 맞는 순간 돌아오고, 넘으면 마지막 상태와 함께 돌아온다.
import assert from "node:assert/strict";
import test from "node:test";
import { evalWriteHit } from "../server/human-path.js";
import { withMcp } from "./lib/mcp-child.mjs";

// eval 을 부를 때마다 다음 상태를 준다. 마지막 상태는 계속 반복한다.
const states = (list, seenExpr = []) => {
  let i = 0;
  return (cmd, args) => {
    if (cmd !== "eval") return { ok: true, data: {} };
    seenExpr.push(args.expression);
    const v = list[Math.min(i++, list.length - 1)];
    return { ok: true, data: { value: v } };
  };
};
const parse = (r) => JSON.parse(r.content[0].text.split("\n\n")[0]);

test("gone 조건은 요소가 사라진 첫 판정에서 돌아온다", async () => {
  await withMcp(states([
    { has: null, gone: false, text: null, h: 1, len: 5 },
    { has: null, gone: false, text: null, h: 2, len: 9 },
    { has: null, gone: true, text: null, h: 3, len: 12 },
  ]), async (callTool, seen) => {
    const r = await callTool("browser_wait", { until: { gone: 'button[aria-label="응답 중단"]' } });
    const d = parse(r);
    assert.equal(d.met, true);
    assert.equal(d.polls, 3);
    assert.equal(seen.filter((s) => s.cmd === "eval").length, 3);
  });
});

test("stable_ms 는 본문이 그 시간 동안 같아야 맞는다", async () => {
  await withMcp(states([
    { has: null, gone: null, text: null, h: 1, len: 5 },
    { has: null, gone: null, text: null, h: 1, len: 5 },
    { has: null, gone: null, text: null, h: 2, len: 6 },   // 약 1.4초에 글이 바뀐다
    { has: null, gone: null, text: null, h: 2, len: 6 },
  ]), async (callTool) => {
    const d = parse(await callTool("browser_wait", { until: { stable_ms: 1000 } }));
    assert.equal(d.met, true);
    assert.ok(d.state.stable_for_ms >= 1000);
    assert.ok(d.waited_ms >= 2000, `바뀐 뒤부터 다시 세야 한다: ${d.waited_ms}ms`);
  });
});

test("시간이 넘으면 met:false 와 마지막 상태로 돌아오고 then 관측은 한다", async () => {
  const reply = states([{ has: false, gone: null, text: null, h: 1, len: 5 }]);
  await withMcp((cmd, args) => (cmd === "snapshot"
    ? { ok: true, data: { url: "http://x/", refCount: 1, snapshot: '[@e1] button "다시 시도"' } } : reply(cmd, args)), async (callTool) => {
    const r = await callTool("browser_wait", { until: { selector: ".answer" }, timeout_ms: 1000, then: { snapshot: { role: "button" } } });
    const d = parse(r);
    assert.equal(d.met, false);
    assert.equal(d.state.selector, false);
    assert.match(r.content[0].text, /대기 뒤 관측/);
    assert.match(r.content[0].text, /다시 시도/);
  });
});

test("잘못된 until·읽을 수 없는 선택자는 오류로 돌려준다", async () => {
  await withMcp(states([{ has: "bad", gone: null, text: null, h: 1, len: 1 }]), async (callTool, seen) => {
    const a = await callTool("browser_wait", { until: { shown: "#x" } });
    const b = await callTool("browser_wait", { until: {} });
    assert.ok(a.isError && b.isError);
    assert.equal(seen.length, 0);
    const c = await callTool("browser_wait", { until: { selector: "##" } });
    assert.ok(c.isError);
    assert.match(c.content[0].text, /선택자를 읽을 수 없습니다/);
  });
});

test("판정 식은 서버의 eval 쓰기 차단에 걸리지 않는다", async () => {
  const exprs = [];
  await withMcp(states([{ has: true, gone: true, text: true, h: 1, len: 1 }], exprs), async (callTool) => {
    await callTool("browser_wait", { until: { selector: "input.q[name='x']", gone: ".spinner", text: "완료", stable_ms: 0 } });
  });
  assert.equal(exprs.length, 1);
  assert.equal(evalWriteHit(exprs[0]), null);
});

test("until 이 없으면 지금처럼 고정 대기를 서버에 넘긴다", async () => {
  await withMcp(states([]), async (callTool, seen) => {
    await callTool("browser_wait", { ms: 50 });
    assert.deepEqual(seen, [{ cmd: "wait", args: { ms: 50 } }]);
  });
});
