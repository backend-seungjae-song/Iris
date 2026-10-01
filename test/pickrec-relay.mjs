import assert from "node:assert/strict";
import test from "node:test";

import { initHerdrHandlers, relayToOneConsole } from "../server/herdr-handlers.js";
import { handlePickrecRelay } from "../server/pickrec-relay.js";

function socket(local, ui) {
  const sent = [];
  return { _local: local, _ui: ui, sent, send(value) { sent.push(JSON.parse(value)); } };
}

test("지목 relay는 인증된 로컬 UI만 콘솔에 전달한다", () => {
  for (const ws of [socket(true, false), socket(false, true), socket(false, false)]) {
    const relayed = [];
    assert.equal(handlePickrecRelay(ws, { type: "pickrec.relay", kind: "tab", payload: { id: "t1" } },
      { relay: (message) => relayed.push(message) }), true);
    assert.deepEqual(relayed, []);
    assert.match(ws.sent[0]?.message || "", /인증된 Iris UI/);
  }

  const ws = socket(true, true);
  const relayed = [];
  assert.equal(handlePickrecRelay(ws, { type: "pickrec.relay", kind: "tab", payload: { id: "t1" } },
    { relay: (message, opts) => relayed.push([message, opts]) }), true);
  assert.deepEqual(relayed, [[{ type: "pickrec.deliver", kind: "tab", payload: { id: "t1" } }, { uiOnly: true }]]);
});

test("UI 전용 전달은 인증 안 된 로컬 콘솔로 보내지 않고 대신 전체 방송도 하지 않는다", () => {
  const plain = { ...socket(true, false), readyState: 1 };
  const ui = { ...socket(true, true), readyState: 1 };
  let broadcast = 0;
  let clients = [plain, ui];
  initHerdrHandlers({ herdr: {}, ptyManager: { clients: () => clients }, broadcastLocal: () => { broadcast++; } });
  relayToOneConsole({ type: "pickrec.deliver" }, { uiOnly: true });
  assert.deepEqual([plain.sent.length, ui.sent.length, broadcast], [0, 1, 0]);

  clients = [plain];
  relayToOneConsole({ type: "pickrec.deliver" }, { uiOnly: true });
  assert.deepEqual([plain.sent.length, broadcast], [0, 0]);

  relayToOneConsole({ type: "pick-relay" });
  assert.deepEqual([plain.sent.length, broadcast], [1, 0]);
});

test("지목 relay는 알 수 없는 종류와 객체가 아닌 값을 전달하지 않는다", () => {
  const ws = socket(true, true);
  const relayed = [];
  for (const message of [
    { type: "pickrec.relay", kind: "unknown", payload: {} },
    { type: "pickrec.relay", kind: "tab", payload: "t1" },
  ]) assert.equal(handlePickrecRelay(ws, message, { relay: (value) => relayed.push(value) }), true);
  assert.deepEqual(relayed, []);
  assert.equal(handlePickrecRelay(ws, { type: "other" }, { relay: (value) => relayed.push(value) }), false);
});
