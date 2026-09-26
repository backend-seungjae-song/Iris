import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import * as gate from "../server/http-handler.js";

// 이 서버는 로컬 판정(터미널·실행·/browser-cmd)을 소켓 주소로 한다. 같은 기기의 리버스 프록시가
// 외부 요청을 루프백으로 넘기면 소켓 주소는 127.0.0.1 이 되어 원격 요청이 로컬 권한을 얻는다.
// 프록시를 거쳐 들어오는 정당한 클라이언트는 없으므로 프록시 헤더가 붙은 요청은 연결부터 거부한다.
// Origin 은 이 서버 자신의 origin(스킴·호스트·포트)만 받는다. 127/8 전체나 다른 포트를 받으면
// 같은 기기의 다른 로컬 서버가 띄운 페이지가 이 서버에 명령을 보낼 수 있다.

const { PORT, connectionAllowed, createHttpHandler } = gate;
const fakeReq = ({ ip = "127.0.0.1", headers = {}, method = "GET", url = "/" } = {}) =>
  Object.assign(new EventEmitter(), { method, url, headers, socket: { remoteAddress: ip } });

const selfTs = new Set(Object.values(os.networkInterfaces()).flat()
  .filter((a) => a && a.family === "IPv4" && /^100\./.test(a.address)).map((a) => a.address));
const otherTs = ["100.127.255.254", "100.64.0.2"].find((ip) => !selfTs.has(ip));

test("프록시 헤더가 붙은 루프백 요청은 연결 자체를 거부한다", () => {
  assert.equal(connectionAllowed(fakeReq()), true);
  assert.equal(connectionAllowed(fakeReq({ headers: { "x-forwarded-for": "203.0.113.9" } })), false);
  assert.equal(connectionAllowed(fakeReq({ headers: { forwarded: "for=203.0.113.9" } })), false);
  assert.equal(connectionAllowed(fakeReq({ headers: { "x-real-ip": "203.0.113.9" } })), false);
  // 값이 비어 있어도 헤더가 있다는 것은 프록시를 지났다는 뜻이다.
  assert.equal(connectionAllowed(fakeReq({ headers: { "x-forwarded-for": "" } })), false);
});

test("로컬 판정: 루프백 소켓이고 프록시 헤더가 없을 때만 로컬", () => {
  assert.equal(typeof gate.isLoopbackRequest, "function", "http-handler.js 가 isLoopbackRequest 를 내보내야 한다");
  const local = gate.isLoopbackRequest;
  assert.equal(local(fakeReq()), true);
  assert.equal(local(fakeReq({ ip: "::1" })), true);
  assert.equal(local(fakeReq({ ip: "::ffff:127.0.0.1" })), true);
  assert.equal(local(fakeReq({ ip: "100.64.0.2" })), false);
  assert.equal(local(fakeReq({ ip: "127.0.0.2" })), false);
  assert.equal(local(fakeReq({ headers: { "x-forwarded-for": "127.0.0.1" } })), false);
  assert.equal(local(fakeReq({ headers: { forwarded: "for=127.0.0.1" } })), false);
  assert.equal(local(fakeReq({ headers: { "x-real-ip": "127.0.0.1" } })), false);
});

test("Origin 은 자기 origin 만 허용하고, 없으면 허용한다", () => {
  const allowed = (origin) => connectionAllowed(fakeReq({ headers: { origin } }));
  assert.equal(connectionAllowed(fakeReq()), true, "Origin 없음(CLI·MCP)은 허용");
  for (const o of [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, `http://[::1]:${PORT}`]) {
    assert.equal(allowed(o), true, o);
  }
  for (const o of [`http://127.0.0.2:${PORT}`, `http://127.0.0.1:${PORT + 1}`, `https://localhost:${PORT}`,
    `http://localhost`, `http://${otherTs}:${PORT}`, "null", "http://attacker.example", `http://127.0.0.1.nip.io:${PORT}`]) {
    assert.equal(allowed(o), false, o);
  }
});

test("이 Mac 의 Tailscale 주소는 자기 포트로만 허용한다", () => {
  assert.equal(typeof gate.originAllowed, "function", "http-handler.js 가 originAllowed 를 내보내야 한다");
  const ts = ["100.101.102.103"];
  const ok = (origin) => gate.originAllowed(fakeReq({ headers: { origin } }), ts);
  assert.equal(ok(`http://100.101.102.103:${PORT}`), true);
  assert.equal(ok(`http://100.101.102.104:${PORT}`), false);
  assert.equal(ok(`http://100.101.102.103:${PORT + 1}`), false);
  assert.equal(ok(`https://100.101.102.103:${PORT}`), false);
});

test("IRIS_ALLOWED_ORIGIN_HOSTS 로 명시한 이름은 종전대로 허용한다", () => {
  const prev = process.env.IRIS_ALLOWED_ORIGIN_HOSTS;
  process.env.IRIS_ALLOWED_ORIGIN_HOSTS = "mac.tailnet.example";
  try {
    assert.equal(connectionAllowed(fakeReq({ headers: { origin: `http://mac.tailnet.example:${PORT}` } })), true);
    assert.equal(connectionAllowed(fakeReq({ headers: { origin: "http://other.tailnet.example" } })), false);
  } finally {
    if (prev === undefined) delete process.env.IRIS_ALLOWED_ORIGIN_HOSTS; else process.env.IRIS_ALLOWED_ORIGIN_HOSTS = prev;
  }
});

test("HTTP /browser-cmd·/features·/pick-source 도 같은 판정을 쓴다", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "iris-loopback-gate-"));
  const prev = process.env.IRIS_STATE_DIR;
  process.env.IRIS_STATE_DIR = home;
  const request = (url, method, opts) => new Promise((resolve) => {
    const req = fakeReq({ url, method, ...opts });
    const res = {
      writeHead(status) { this.status = status; return this; },
      end(value) { resolve({ status: this.status, value: String(value ?? "") }); },
    };
    createHttpHandler({ irisHome: home })(req, res);
    // 게이트를 통과하면 본문을 읽는다. 깨진 JSON 은 400 이므로 통과 여부를 명령 실행 없이 가른다.
    req.emit("data", "{"); req.emit("end");
  });
  try {
    for (const url of ["/browser-cmd", "/pick-source"]) {
      assert.equal((await request(url, "POST")).status, 400, `${url} 헤더 없는 루프백은 통과`);
      assert.equal((await request(url, "POST", { headers: { "x-forwarded-for": "203.0.113.9" } })).status, 403, `${url} XFF`);
      assert.equal((await request(url, "POST", { headers: { forwarded: "for=203.0.113.9" } })).status, 403, `${url} Forwarded`);
      assert.equal((await request(url, "POST", { headers: { origin: `http://127.0.0.2:${PORT}` } })).status, 403, `${url} 127.0.0.2`);
      assert.equal((await request(url, "POST", { headers: { origin: `http://127.0.0.1:${PORT}` } })).status, 400, `${url} 자기 Origin`);
    }
    assert.equal((await request("/features", "GET", { headers: { "x-real-ip": "203.0.113.9" } })).status, 403);
    const plain = await request("/features", "GET");
    assert.equal(plain.status, 200);
    assert.equal(JSON.parse(plain.value).local, true);
  } finally {
    if (prev === undefined) delete process.env.IRIS_STATE_DIR; else process.env.IRIS_STATE_DIR = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// 헤더 개수 제한을 넘기면 Node 가 뒤쪽 헤더를 조용히 버린다. 짧은 헤더를 채워 프록시가 붙인
// X-Forwarded-For 를 밀어내면 판정이 헤더를 못 본다. 가짜 req 로는 이 경로가 안 보이므로 실제
// http 서버의 파서로 확인한다. 제한을 없애지 않은 서버에서 우회가 성립하는 것도 함께 확인해,
// 이 검사가 그 실패를 실제로 잡는다는 것을 보인다.
async function probe(harden) {
  const http = await import("node:http");
  const net = await import("node:net");
  const server = http.createServer((req, res) => {
    res.end(JSON.stringify({ local: gate.isLoopbackRequest(req), allowed: connectionAllowed(req) }));
  });
  if (harden) gate.hardenHeaderParsing(server);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const filler = Array.from({ length: 1000 }, (_, i) => `W${i.toString(36)}: b`).join("\r\n");
  const raw = `GET /x HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${filler}\r\nX-Forwarded-For: 192.168.1.55\r\nConnection: close\r\n\r\n`;
  const body = await new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => sock.end(raw));
    let buf = ""; sock.on("data", (d) => { buf += d; }); sock.on("end", () => resolve(buf)); sock.on("error", reject);
  });
  await new Promise((r) => server.close(r));
  const [head, payload = ""] = body.split("\r\n\r\n");
  const status = Number(head.split(" ")[1]);
  return status === 200 ? JSON.parse(payload) : { status };
}

test("헤더를 채워 프록시 헤더를 밀어내도 로컬로 판정하지 않는다", async () => {
  // 넘친 헤더를 Node 22.22·24.18 은 잘라 버리고(우회 성립), 22.23 부터는 431 로 거부한다. 어느 쪽이든 받는다.
  const unguarded = await probe(false);
  if (!("status" in unguarded)) assert.deepEqual(unguarded, { local: true, allowed: true }, "제한을 둔 서버에서는 우회가 성립해야 이 검사가 의미가 있다");
  else assert.equal(unguarded.status, 431);
  assert.deepEqual(await probe(true), { local: false, allowed: false });
});

test("실제 서버는 헤더 개수 제한을 없앤 채 뜬다", () => {
  const src = fs.readFileSync(new URL("../server/index.js", import.meta.url), "utf8");
  assert.match(src, /const server = hardenHeaderParsing\(http\.createServer\(/);
});

test("인터페이스 조회가 실패하면 tailnet origin 을 거부하고 던지지 않는다", () => {
  const orig = os.networkInterfaces;
  os.networkInterfaces = () => { throw new Error("boom"); };
  try {
    assert.deepEqual(gate.selfTailscaleIps(), []);
    assert.equal(connectionAllowed(fakeReq({ headers: { origin: `http://100.64.0.2:${PORT}` } })), false);
  } finally { os.networkInterfaces = orig; }
});
