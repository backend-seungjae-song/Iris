// MCP 사용 기록: then·후보 첨부·until 이 쓰였는지와 결과를 한 줄씩 남긴다. 페이지 내용은 남기지 않는다.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { withMcp } from "./lib/mcp-child.mjs";

const reply = (cmd, args) => {
  if (cmd === "click" && args.sel === "#gone") return { ok: false, error: "선택자에 맞는 요소가 없습니다: #gone" };
  if (cmd === "click" && args.sel === "#zero") return { ok: true, data: { ok: false, error: "크기가 0인 요소" } };
  if (cmd === "snapshot") return { ok: true, data: { url: "http://x/", refCount: 2, snapshot: '[@e4] button "비밀 문구"\n[@e5] link "b"' } };
  if (cmd === "eval") return { ok: true, data: { value: { has: true, gone: null, text: null, h: 1, len: 1 } } };
  return { ok: true, data: {} };
};
const rows = (state) => fs.readFileSync(path.join(state, "mcp-use.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("호출마다 쓰임새와 결과를 남기고 페이지 글은 남기지 않는다", async () => {
  await withMcp(reply, async (callTool, seen, state) => {
    await callTool("browser_click", { ref: "@e1", then: { eval: "1" } });
    await callTool("browser_click", { selector: "#gone" });
    await callTool("browser_wait", { until: { selector: ".a" } });
    await callTool("browser_wait", { ms: 10 });
    await callTool("browser_click", { selector: "#zero" });
    const [thenRow, missRow, untilRow, msRow, zeroRow] = rows(state);
    assert.equal(zeroRow.ok, false, "전달은 됐어도 페이지에서 실패하면 실패로 남긴다");
    assert.deepEqual(thenRow.then, ["eval"]);
    assert.equal(thenRow.ok, true);
    assert.equal(missRow.miss, true);
    assert.deepEqual(missRow.candidates, ["e4", "e5"]);
    assert.equal(missRow.ok, false);
    assert.deepEqual(untilRow.until, ["selector"]);
    assert.equal(untilRow.met, true);
    assert.equal(msRow.ms, 10);
    assert.equal(msRow.until, null);
    assert.ok(!fs.readFileSync(path.join(state, "mcp-use.jsonl"), "utf8").includes("비밀 문구"));
  });
});
