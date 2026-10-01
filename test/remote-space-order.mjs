import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAgentStore } from "../server/remote/agents.js";
import { createWatchOperation } from "../server/remote/ops/watch.js";
import { createSpaceOrderStore, handleSpaceOrderMessage } from "../server/space-order.js";

const KEYS = {
  "space-one": "folder:v2:one:one",
  "space-two": "folder:v2:two:two",
  "space-three": "folder:v2:three:three",
};

function createStore(filePath) {
  const keyOf = (value) => KEYS[value] || value;
  return createSpaceOrderStore({
    filePath,
    keyOf,
    isFolderKey: (value) => typeof value === "string" && value.startsWith("folder:v2:"),
    knownKeys: () => Object.values(KEYS),
    idOfKey: (key, liveIds) => liveIds.find((id) => keyOf(id) === key) || null,
  });
}

function runtimeFixture(store) {
  const runtime = {
    state: [
      { paneId: "pane-one", workspaceId: "space-one", tabId: "tab-one", tabLabel: "하나" },
      { paneId: "pane-two", workspaceId: "space-two", tabId: "tab-two", tabLabel: "둘" },
      { paneId: "pane-three", workspaceId: "space-three", tabId: "tab-three", tabLabel: "셋" },
    ],
    workspaces: [
      { id: "space-one", label: "하나" },
      { id: "space-two", label: "둘" },
      { id: "space-three", label: "셋" },
    ],
    tabs: {},
  };
  let random = 1;
  const agents = createAgentStore({
    getSnapshot: () => runtime,
    orderWorkspaces: store.orderWorkspaces,
    subscribeSpaceOrder: store.subscribe,
    randomBytes: (size) => Buffer.alloc(size, random++),
  });
  return { agents, runtime };
}

function socket(local, ui) {
  return {
    _local: local,
    _ui: ui,
    sent: [],
    send(raw) { this.sent.push(JSON.parse(raw)); },
  };
}

test("로컬 Iris UI 순서는 파일에 저장되고 폰 agents 순서와 푸시에 반영된다", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "iris-space-order-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "space-order.json");
  const store = createStore(filePath);
  store.initialize();
  const { agents } = runtimeFixture(store);
  const timers = [];
  const sent = [];
  const watch = createWatchOperation({
    agents,
    requests: { list: () => [], subscribe: () => () => {} },
    send: (_connId, value) => sent.push(value),
    now: () => 1_000,
    setTimer(fn, delay) { const timer = { fn, delay, unref() {} }; timers.push(timer); return timer; },
    clearTimer() {},
  });
  watch.handle({ connId: "phone" }, { rid: "watch-1" });

  const localUi = socket(true, true);
  assert.equal(handleSpaceOrderMessage(localUi, {
    type: "space-order.set",
    order: [KEYS["space-two"], "folder:v2:unknown:key", KEYS["space-one"], KEYS["space-two"]],
  }, store), true);
  assert.deepEqual(JSON.parse(await fsp.readFile(filePath, "utf8")), [KEYS["space-two"], KEYS["space-one"]]);
  assert.deepEqual(agents.list().map((agent) => [agent.name, agent.spaceOrder]), [["둘", 0], ["하나", 1], ["셋", 2]]);
  assert.equal(timers.length, 1);
  timers[0].fn();
  assert.deepEqual(sent.map((message) => message.type), ["agents"]);
  assert.deepEqual(sent[0].agents.map((agent) => agent.name), ["둘", "하나", "셋"]);
  assert.equal((await fsp.stat(filePath)).mode & 0o777, 0o600);

  handleSpaceOrderMessage(localUi, {
    type: "space-order.set",
    order: [KEYS["space-two"], KEYS["space-one"]],
  }, store);
  assert.equal(timers.length, 1);

  watch.close();
  agents.close();

  const restarted = createStore(filePath);
  restarted.initialize();
  const restartedFixture = runtimeFixture(restarted);
  assert.deepEqual(restartedFixture.agents.list().map((agent) => agent.name), ["둘", "하나", "셋"]);
  restartedFixture.agents.close();
});

test("원격 또는 UI 인증 없는 피어는 저장된 스페이스 순서를 바꾸지 못한다", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "iris-space-order-deny-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "space-order.json");
  const store = createStore(filePath);
  store.initialize();
  assert.equal(store.set([KEYS["space-one"]]).ok, true);

  for (const denied of [socket(false, true), socket(true, false)]) {
    handleSpaceOrderMessage(denied, { type: "space-order.set", order: [KEYS["space-two"]] }, store);
    assert.equal(denied.sent[0].type, "control-error");
  }
  assert.deepEqual(store.list(), [KEYS["space-one"]]);
  assert.deepEqual(JSON.parse(await fsp.readFile(filePath, "utf8")), [KEYS["space-one"]]);
});

test("렌더러는 드래그 저장과 space-keys 적용 뒤 현재 순서를 전송한다", async () => {
  const source = await fsp.readFile(new URL("../web/js/main.js", import.meta.url), "utf8");
  assert.match(source, /function saveOrder\(list\).*sendSpaceOrder\(\); \}/);
  assert.match(source, /function handleSpaceKeysMessage\(m\) \{[\s\S]*?applySpaceKeys\([^\n]+\);\n\s+sendSpaceOrder\(\);/);
  assert.match(source, /function sendSpaceOrder\(\) \{ if \(!AUX_MODE\) wsSend\(\{ type: "space-order\.set", order: spaceOrder \}\); \}/);
});

test("스페이스 순서 파일은 stateHome 아래에서 정한다", async () => {
  const source = await fsp.readFile(new URL("../server/space-order.js", import.meta.url), "utf8");
  assert.match(source, /import \{ stateHome \} from "\.\/state-home\.cjs";/);
  assert.match(source, /path\.join\(stateHome\(\), "space-order\.json"\)/);
});
