import assert from "node:assert/strict";
import test from "node:test";

import { handleLocaldev } from "../server/localdev-bridge.js";

// 상태 응답은 창이 보낸 요청 id 를 돌려준다. 창은 이것으로 늦게 온 응답을 새 요청 것과 가린다.
function fakeWs(local) {
  const out = [];
  let done;
  const got = new Promise((r) => { done = r; });
  return { _local: local, readyState: 1, send(s) { out.push(JSON.parse(s)); done(); }, out, got };
}

test("원격 창의 상태 요청에도 id 를 돌려준다", async () => {
  const ws = fakeWs(false);
  assert.equal(handleLocaldev(ws, { type: "localdev.status", id: "st7" }), true);
  await ws.got;
  assert.deepEqual(ws.out[0], { type: "localdev.status", id: "st7", ok: false, reason: "remote" });
});

test("라우터에서 읽은 상태에도 id 를 돌려준다(응답 내용이 id 를 덮지 않는다)", async (t) => {
  const prev = globalThis.fetch;
  t.after(() => { globalThis.fetch = prev; });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ id: "x", routes: [], projects: [] }) });
  const ws = fakeWs(true);
  handleLocaldev(ws, { type: "localdev.status", id: "st8" });
  await ws.got;
  assert.equal(ws.out[0].id, "st8");
  assert.equal(ws.out[0].ok, true);
  globalThis.fetch = async () => { throw new Error("down"); };
  const ws2 = fakeWs(true);
  handleLocaldev(ws2, { type: "localdev.status", id: "st9" });
  await ws2.got;
  assert.equal(ws2.out[0].id, "st9");
  assert.equal(ws2.out[0].ok, false);
});
