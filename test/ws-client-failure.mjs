import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { attachWs, broadcast, broadcastLocal, initWsTransport } from "../server/ws-transport.js";

const wss = new EventEmitter();
initWsTransport({ wss, isLocalRequest: () => true });
attachWs({ initialState() {}, dispatch() {}, onClose() {} });
const broken = Object.assign(new EventEmitter(), {
  readyState: 1, send() { throw new Error("write failed"); }, terminate() {},
});
wss.emit("connection", broken, {});
broken.emit("error", new Error("connection reset"));
let terminated = false;
const slow = { readyState: 1, bufferedAmount: 64 * 1024 * 1024, _local: true,
  terminate() { terminated = true; }, send() { assert.fail("queued another frame"); } };
const received = [];
wss.clients = [broken, slow, { readyState: 1, _local: true, send: data => received.push(JSON.parse(data)) }];
broadcast({ type: "all" });
broadcastLocal({ type: "local" });
assert.ok(terminated);
assert.deepEqual(received, [{ type: "all" }, { type: "local" }]);
