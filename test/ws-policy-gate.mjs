import test from "node:test";
import assert from "node:assert/strict";
import envMod from "../server/env.cjs";

// 창 WebSocket 의 서버 정책 확인
// 정책 확인 전: 연결 완료 처리·전달·전송 없음. 불일치: 종료, 재연결 없음
class FakeWs {
  static all = [];
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.closed = false; FakeWs.all.push(this); }
  send(data) { this.sent.push(data); }
  close() { this.closed = true; this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  recv(obj) { this.onmessage?.({ data: typeof obj === "string" ? obj : JSON.stringify(obj) }); }
}
globalThis.WebSocket = FakeWs;
// ws.js heartbeat 감시 타이머가 검사 프로세스를 붙들지 않게 unref
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms) => { const t = realSetInterval(fn, ms); t.unref?.(); return t; };
let seq = 0;
async function setup(getAppConnectionToken) {
  FakeWs.all = [];
  const ws = await import(`../web/js/core/ws.js?case=${++seq}`);
  const log = { open: [], dispatched: [], mismatch: [] };
  ws.initWs({
    url: "ws://127.0.0.1:1/",
    getAppConnectionToken,
    onOpen: (g) => log.open.push(g),
    onClose: () => {},
    onBinary: () => {},
    onPolicyMismatch: (m) => log.mismatch.push(m),
    dispatch: { caps: (m) => log.dispatched.push(m.type), state: (m) => log.dispatched.push(m.type) },
  });
  return { ws, log, sock: FakeWs.all[0] };
}

test("창과 서버의 정책 값 일치", async () => {
  const ws = await import(`../web/js/core/ws.js?case=${++seq}`);
  assert.equal(ws.EXPECTED_NET_POLICY, envMod.NET_POLICY);
});

test("앱 화면은 서버 정책을 확인한 뒤 다른 메시지보다 먼저 연결을 인증한다", async () => {
  const { ws, sock } = await setup(() => "fixture");
  sock.open();
  assert.deepEqual(sock.sent, []);
  sock.recv({ type: "caps", local: true, netPolicy: envMod.NET_POLICY });
  ws.wsSend({ type: "browser-tab-wc", tabId: "test-tab", wc: 7 });
  assert.deepEqual(sock.sent.map((data) => JSON.parse(data).type), ["app-auth", "browser-tab-wc"]);
});

test("정상 caps 이후에만 연결 완료·전달·전송", async () => {
  const { ws, log, sock } = await setup();
  sock.open();
  assert.deepEqual(log.open, [], "소켓 열림만으로 연결 완료 처리 없음");
  ws.wsSend({ type: "x" });
  assert.deepEqual(sock.sent, [], "확인 전 전송 없음");
  assert.equal(ws.getWs(), null, "확인 전 소켓 비공개");
  sock.recv({ type: "caps", local: true, netPolicy: envMod.NET_POLICY });
  assert.equal(log.open.length, 1);
  sock.recv({ type: "state" });
  assert.deepEqual(log.dispatched, ["caps", "state"]);
  ws.wsSend({ type: "x" });
  assert.equal(sock.sent.length, 1);
  assert.equal(ws.getWs(), sock);
});

for (const [name, first] of [
  ["정책 없는 caps(이전 서버)", { type: "caps", local: true }],
  ["다른 정책", { type: "caps", local: true, netPolicy: "old" }],
  ["caps 아닌 첫 메시지", { type: "state" }],
]) {
  test(`${name}: 종료, 전달·연결 완료 없음, 재연결 없음`, async () => {
    const { log, sock } = await setup();
    sock.open();
    sock.recv(first);
    assert.equal(sock.closed, true);
    assert.deepEqual(log.open, []);
    assert.deepEqual(log.dispatched, []);
    assert.equal(log.mismatch.length, 1);
    await new Promise((r) => setTimeout(r, 1300));
    assert.equal(FakeWs.all.length, 1, "재연결 시도 없음");
  });
}

test("확인된 소켓의 잘못된 JSON은 다음 상태 수신에 영향을 주지 않는다", async () => {
  const { log, sock } = await setup();
  sock.open();
  sock.recv({ type: "caps", netPolicy: envMod.NET_POLICY });
  sock.recv("{");
  sock.recv({ type: "state" });
  assert.deepEqual(log.dispatched, ["caps", "state"]);
});

test("재초기화된 소켓은 이전 세대의 수신을 처리하지 않는다", async () => {
  const { ws, log, sock } = await setup();
  sock.open();
  sock.recv({ type: "caps", netPolicy: envMod.NET_POLICY });
  const old = sock;
  ws.initWs({
    url: "ws://127.0.0.1:1/",
    onOpen: (generation) => log.open.push(generation),
    onClose: () => {},
    onBinary: () => {},
    dispatch: { state: (m) => log.dispatched.push(m.type) },
  });
  old.recv({ type: "state" });
  assert.deepEqual(log.dispatched, ["caps"]);
});
