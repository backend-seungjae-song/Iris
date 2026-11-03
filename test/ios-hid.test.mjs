// iOS 입력을 serve-sim 도우미 웹소켓 프레임으로 바꾸는 계산과 전송 순서
import assert from "node:assert/strict";
import test from "node:test";
import { createIosHid, frame, keyEvents, normalize, parseHelperPorts, swipePoints, typeable } from "../bin/mcp/ios-hid.mjs";

const U = "76EDA0E3-F8CC-47FC-8267-EF94ED5F2811";
const decode = (buf) => ({ tag: buf[0], ...JSON.parse(buf.subarray(1).toString()) });
const tree = [{ type: "Application", frame: { x: 0, y: 0, width: 390, height: 844 } }];

test("포인트 좌표를 화면 기준 0..1 로 바꾸고 화면 밖은 가장자리로 둔다", () => {
  assert.deepEqual(normalize(195, 422, { width: 390, height: 844 }), { x: 0.5, y: 0.5 });
  assert.deepEqual(normalize(-5, 900, { width: 390, height: 844 }), { x: 0, y: 1 });
});

test("글자는 US 자판 usage 로, 대문자·기호는 Shift 를 감싼다", () => {
  assert.deepEqual(keyEvents("a"), [{ type: "down", usage: 4 }, { type: "up", usage: 4 }]);
  assert.deepEqual(keyEvents("A").map((e) => e.usage), [225, 4, 4, 225]);
  assert.deepEqual(keyEvents("@").map((e) => e.usage), [225, 31, 31, 225]);
  assert.equal(typeable("stick 12!"), true);
  assert.equal(typeable("스틱"), false);
  assert.throws(() => keyEvents("스"), /입력할 수 없는 글자/);
});

test("스와이프는 begin·move·end 순서로 끝점에서 끝난다", () => {
  const points = swipePoints({ x: 0.5, y: 0.8 }, { x: 0.5, y: 0.2 }, 0.1);
  assert.equal(points[0].type, "begin");
  assert.equal(points.at(-1).type, "end");
  assert.deepEqual(points.at(-1), { x: 0.5, y: 0.2, type: "end" });
  assert.ok(points.slice(1, -1).every((p) => p.type === "move"));
});

test("ps 출력에서 그 기기의 도우미 포트만 찾는다", () => {
  const ps = `/x/serve-sim-bin ${U} --port 3100\n/x/serve-sim-bin OTHER --port 3101\n/usr/bin/idb_companion --udid ${U}`;
  assert.deepEqual(parseHelperPorts(ps, U), [3100]);
});

test("탭은 화면 크기로 정규화한 begin·end 터치 프레임으로 보낸다", async () => {
  const sent = [];
  const hid = createIosHid({ readTree: async () => tree, locate: async () => "ws://127.0.0.1:9/ws", transmit: async (url, frames) => sent.push([url, frames.map(decode)]) });
  await hid.tap(U, 195, 211);
  assert.deepEqual(sent, [["ws://127.0.0.1:9/ws", [{ tag: 3, x: 0.5, y: 0.25, type: "begin" }, { tag: 3, x: 0.5, y: 0.25, type: "end" }]]]);
});

test("버튼·키·붙여넣기는 각자의 프레임 종류로 보낸다", async () => {
  const sent = [];
  const hid = createIosHid({ readTree: async () => tree, locate: async () => "ws://h/ws", transmit: async (_url, frames) => sent.push(frames.map(decode)) });
  await hid.button(U, "HOME");
  await hid.key(U, 40);
  await hid.paste(U);
  assert.deepEqual(sent[0], [{ tag: 4, button: "home" }]);
  assert.deepEqual(sent[1], [{ tag: 6, type: "down", usage: 40 }, { tag: 6, type: "up", usage: 40 }]);
  assert.deepEqual(sent[2].map((e) => e.usage), [227, 25, 25, 227]);
  await assert.rejects(hid.button(U, "SIRI"), /HOME·LOCK/);
});

test("도우미가 없으면 idb 로 돌아가지 않고, 다시 뜨기를 기다린 뒤에도 없으면 그 이유로 오류를 낸다", async () => {
  let waited = 0;
  const hid = createIosHid({ readTree: async () => tree, locate: async () => null, transmit: async () => assert.fail("보내면 안 됨"), pause: async (ms) => { waited += ms; } });
  await assert.rejects(hid.tap(U, 1, 1), /화면 도우미\(serve-sim\)가 떠 있지 않아/);
  assert.equal(waited, 8000);
});

test("도우미가 다시 뜨는 동안의 입력은 기다렸다 보낸다", async () => {
  const sent = [];
  let calls = 0;
  const hid = createIosHid({ readTree: async () => tree, locate: async () => (++calls < 3 ? null : "ws://h/ws"), transmit: async (url) => sent.push(url), pause: async () => {} });
  await hid.tap(U, 1, 1);
  assert.deepEqual([calls, sent], [3, ["ws://h/ws"]]);
});

test("프레임은 종류 바이트 뒤에 JSON 을 붙인다", () => {
  assert.deepEqual(decode(frame(3, { x: 0.1, y: 0.2, type: "begin" })), { tag: 3, x: 0.1, y: 0.2, type: "begin" });
});
