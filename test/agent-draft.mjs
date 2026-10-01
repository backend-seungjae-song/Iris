import test from "node:test";
import assert from "node:assert/strict";
import { createAgentDraftWriter } from "../server/agent-draft.js";

function fixture() {
  const state = [{ paneId: "p1", terminalId: "t1", workspaceId: "w1", agent: "codex", status: "idle" }];
  const writes = [];
  const herdr = { paneGet: async () => ({ terminal_id: "t1", workspace_id: "w1" }),
    paneSendText: async (...args) => { writes.push(args); } };
  return { state, herdr, writes, send: createAgentDraftWriter({ herdr, getSnapshot: () => ({ state }) }) };
}
const request = { requestId: "d1", paneId: "p1", terminalId: "t1", spaceId: "w1", text: "line 1\nline 2" };
test("선택 pane에 초안을 한 번만 입력하고 Enter를 보내지 않는다", async () => {
  const f = fixture();
  await Promise.all([f.send(request), f.send(request)]);
  assert.deepEqual(f.writes, [["p1", "\x1b[200~line 1\nline 2\x1b[201~"]]);
  await assert.rejects(f.send({ ...request, text: "다른 내용" }), { code: "REQUEST_CONFLICT" });
});
test("pane 교체·스페이스 변경·작업 중·제어문자에는 입력하지 않는다", async () => {
  for (const patch of [{ terminalId: "other" }, { spaceId: "other" }, { text: "escape\x1b[201~\r" }]) {
    const f = fixture(); await assert.rejects(f.send({ ...request, ...patch })); assert.equal(f.writes.length, 0);
  }
  const f = fixture(); f.state[0].status = "working";
  await assert.rejects(f.send(request), { code: "TARGET_CHANGED" });
});
test("실제 pane identity 재검증과 불확실한 결과의 재전송 차단", async () => {
  const f = fixture(); f.herdr.paneGet = async () => ({ terminal_id: "reused", workspace_id: "w1" });
  await assert.rejects(f.send(request), { code: "TARGET_CHANGED" }); assert.equal(f.writes.length, 0);
  const g = fixture(); let attempts = 0;
  g.herdr.paneSendText = async () => { attempts++; throw new Error("timeout"); };
  await assert.rejects(g.send(request), { code: "DELIVERY_UNKNOWN" });
  await assert.rejects(g.send(request), { code: "DELIVERY_UNKNOWN" }); assert.equal(attempts, 1);
});
