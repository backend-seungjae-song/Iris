// 새로고침·이동으로 실행 환경이 지워진 뒤 반응 관찰 종료가 지워진 환경 ID 로 조회하지 않는다
// 실제 앱 재현: qa_act reload 가 "Cannot find context with specified id" 로 실패 (2026-11-03)
import test from "node:test";
import assert from "node:assert/strict";
import { createQaReactionCommands } from "../server/mcp-worker/qa-reaction-commands.js";

const oracle = "명세나 대화에서 정한 내용";

test("실행 환경이 지워진 뒤 종료 판정은 새 환경만 조회하고 기대 변화를 관찰한다", async () => {
  let clock = 0, listener = null;
  const live = new Set([1]);
  const before = { effects: [{ id: "e1", found: true, text: "바로 바뀜" }], bodyText: "화면", visibleElements: 1, busy: [], broken: [] };
  const after = { effects: [{ id: "e1", found: true, text: "처음 상태" }], bodyText: "화면", visibleElements: 1, busy: [], broken: [] };
  const send = async (method, params = {}) => {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
    if (method === "Runtime.evaluate") {
      if (params.contextId != null && !live.has(params.contextId)) throw new Error("Cannot find context with specified id");
      return { result: { value: params.contextId === 2 ? after : before } };
    }
    return {};
  };
  send.on = () => send;
  const io = {
    async subscribe(fn) { listener = fn; return { id: "s1" }; },
    async unsubscribe() {},
    async capture() { return { path: "scene.png" }; },
    async diagSince() { return null; },
  };
  const commands = createQaReactionCommands({ now: () => clock, sleep: async ms => { clock += ms; } });
  const wc = { id: 1 };
  const { id } = await commands["qa-reaction-start"](send, wc, { expect: { effects: [{ type: "change", sel: "#out", to: "처음 상태", oracle }], within: 200 }, action: "reload", target: null }, io);
  // 새로고침: 옛 환경 1 이 지워지고 새 문서의 자동 주입 스크립트가 환경 2 에서 결과를 보냄
  live.delete(1); live.add(2);
  listener({ method: "Runtime.executionContextsCleared", params: {} });
  listener({ method: "Runtime.bindingCalled", params: { name: "__irisQaReaction", executionContextId: 2, payload: JSON.stringify({ id, snapshot: after }) } });
  const result = await commands["qa-reaction-end"](send, wc, { id, delivered: true }, io);
  assert.equal(result.ok, true);
  assert.equal(result.effects.find(e => e.id === "e1").observed, true);
});
