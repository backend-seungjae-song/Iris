import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import test from "node:test";
import { once } from "node:events";

import WebSocket from "ws";

import { prepareGatewayCertificate } from "../server/remote/certificate.js";
import { REMOTE_RPC_VERSION } from "../server/remote/contract/ipc.js";
import { createGateway } from "../server/remote/gateway/server.js";
import { splitCookie, upstreamPath } from "../server/remote/gateway/paseo-proxy.js";

const SERVER_INSTANCE = "2".repeat(32);
const NODE = "node-stable-id";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function eventually(check, timeout = 2_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    (function inspect() {
      const result = check();
      if (result) return resolve(result);
      if (Date.now() - started >= timeout) return reject(new Error("condition timed out"));
      setTimeout(inspect, 5);
    })();
  });
}

// 가짜 Iris 서버: 받은 요청을 기록하고 경로를 그대로 돌려줌
async function upstreamFixture(t) {
  const seen = [];
  const server = http.createServer((request, response) => {
    seen.push({ url: request.url, method: request.method, headers: request.headers });
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("iris-body");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { port: server.address().port, seen };
}

async function fixture(t, options = {}) {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "iris-paseo-proxy-"));
  t.after(() => fsp.rm(stateDir, { recursive: true, force: true }));
  const certificate = await prepareGatewayCertificate({ stateDir });
  const port = await freePort();
  const sent = [];
  const upstream = await upstreamFixture(t);
  const gateway = createGateway({
    allowListenAddress: (address) => address === "127.0.0.1",
    whoisResolver: { resolve: async () => options.node || NODE },
    sendIpc(message, callback) { sent.push(structuredClone(message)); queueMicrotask(() => callback?.(null)); return true; },
    onFatal: (error) => { throw error; },
  });
  await gateway.start({
    type: "configure", v: REMOTE_RPC_VERSION, serverInstance: SERVER_INSTANCE, address: "127.0.0.1", port,
    keyPem: certificate.keyPem, certPem: certificate.certPem, certHash: certificate.certHash, tailscalePath: "/tailscale",
  });
  t.after(() => gateway.stop());
  // 인증된 remote/1 연결 하나
  const phone = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
  phone.on("error", () => {});
  await once(phone, "open");
  const opened = await eventually(() => sent.find((message) => message.type === "conn.open"));
  const connId = opened.gwSeq.toString(16).padStart(32, "0");
  gateway.receive({ type: "conn.accept", gwSeq: opened.gwSeq, connId });
  gateway.receive({ type: "conn.authenticated", connId });
  t.after(() => phone.terminate());
  const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
  t.after(() => agent.destroy());
  const host = `127.0.0.1:${port}`;
  function get(pathname, headers = {}, fresh = false) {
    return new Promise((resolve, reject) => {
      const request = https.request({ host: "127.0.0.1", port, path: pathname, method: "GET", agent: fresh ? false : agent, rejectUnauthorized: false,
        headers: { host, ...headers } }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
      });
      request.on("error", reject);
      request.end();
    });
  }
  function grant(ticket = "a".repeat(64)) {
    return gateway.receive({ type: "paseo.grant", connId, ticket, nodeId: NODE, port: upstream.port });
  }
  function pane(token = "e".repeat(32), paneId = "w1:p2") {
    return f_receive({ type: "paseo.pane", connId, token, paneId });
  }
  const f_receive = (message) => gateway.receive(message);
  async function enter(ticket = "a".repeat(64)) {
    const response = await get(`/.iris-paseo/enter?t=${ticket}`);
    const cookie = response.headers["set-cookie"]?.[0]?.split(";")[0];
    return { response, cookie };
  }
  return { gateway, sent, port, host, connId, upstream, get, grant, pane, enter, certificate };
}

test("쿠키 없는 요청은 Iris 서버에 닿지 않고 404", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.get("/paseo-ui/")).status, 404);
  assert.equal(f.upstream.seen.length, 0);
});

test("티켓 교환은 303 과 보안 쿠키를 주고 화면 경로만 Iris 서버로 전달한다", async (t) => {
  const f = await fixture(t);
  assert.equal(f.grant(), true);
  const { response, cookie } = await f.enter();
  assert.equal(response.status, 303);
  assert.equal(response.headers.location, "/paseo-ui/");
  assert.match(response.headers["set-cookie"][0], /^__Host-iris-paseo=[0-9a-f]{64}; Secure; HttpOnly; SameSite=Strict; Path=\/$/);
  const page = await f.get("/paseo-ui/?v=1", { cookie: `${cookie}; other=1`, "sec-fetch-site": "same-origin" });
  assert.equal(page.status, 200);
  assert.equal(page.body, "iris-body");
  const seen = f.upstream.seen.at(-1);
  assert.equal(seen.url, "/paseo-ui/?v=1");
  assert.equal(seen.headers.host, `127.0.0.1:${f.upstream.port}`);
  assert.equal(seen.headers.cookie, "other=1");
  assert.equal(seen.headers["sec-fetch-site"], "same-origin");
  assert.equal(Object.keys(seen.headers).some((name) => name.startsWith("x-forwarded-")), false);
});

test("허용한 경로 밖과 GET 이 아닌 요청은 쿠키가 있어도 전달하지 않는다", async (t) => {
  const f = await fixture(t);
  f.grant();
  const { cookie } = await f.enter();
  for (const pathname of ["/", "/api/state", "/ws", "/paseo-uix", "/agentchat-image", "/agentchat-file", "/paseo-ui/../api/x"]) {
    assert.equal((await f.get(pathname, { cookie })).status, 404, pathname);
  }
  assert.equal(f.upstream.seen.some((entry) => entry.url === "/api/state" || entry.url === "/ws"), false);
  const post = await new Promise((resolve, reject) => {
    const request = https.request({ host: "127.0.0.1", port: f.port, path: "/paseo-ui/", method: "POST", rejectUnauthorized: false,
      headers: { host: f.host, cookie } }, (response) => { response.resume(); resolve(response.statusCode); });
    request.on("error", reject);
    request.end("x");
  });
  assert.equal(post, 404);
});

test("대화 이미지는 가짜 토큰만 진짜 pane 으로 바꿔 전달하고 모르는 토큰은 거절한다", async (t) => {
  const f = await fixture(t);
  f.grant();
  const { cookie } = await f.enter();
  const token = "e".repeat(32);
  assert.equal((await f.get(`/agentchat-image?pane=${token}&off=3&i=0`, { cookie })).status, 404);
  assert.equal(f.pane(token, "w1:p2"), true);
  const image = await f.get(`/agentchat-image?pane=${token}&off=3&i=0`, { cookie });
  assert.equal(image.status, 200);
  const seen = new URL(f.upstream.seen.at(-1).url, "http://x");
  assert.equal(seen.pathname, "/agentchat-image");
  assert.equal(seen.searchParams.get("pane"), "w1:p2");
  assert.equal(seen.searchParams.get("off"), "3");
  // 서브에이전트 이미지와 임의 파일 읽기는 전달하지 않음
  assert.equal((await f.get(`/agentchat-image?pane=${token}&off=3&i=0&agent=abc`, { cookie })).status, 404);
  assert.equal((await f.get(`/agentchat-image?pane=w1:p2&off=3&i=0`, { cookie })).status, 404);
  assert.equal((await f.get("/agentchat-file?path=%2Ftmp%2Fa.png&cwd=%2Ftmp", { cookie })).status, 404);
});

test("티켓은 한 번만 쓰이고 잘못된 값·다른 Host 는 거절한다", async (t) => {
  const f = await fixture(t);
  f.grant();
  assert.equal((await f.get(`/.iris-paseo/enter?t=${"b".repeat(64)}`)).status, 404);
  assert.equal((await f.get("/.iris-paseo/enter?t=zz")).status, 404);
  assert.equal((await f.get(`/.iris-paseo/enter?t=${"a".repeat(64)}`, { host: "evil.example:1" })).status, 404);
  assert.equal((await f.enter()).response.status, 303);
  assert.equal((await f.enter()).response.status, 404);
});

test("다른 Tailscale 노드가 쓴 티켓은 거절한다", async (t) => {
  const f = await fixture(t, { node: "other-node" });
  f.grant();
  assert.equal((await f.enter()).response.status, 404);
  assert.equal(f.upstream.seen.length, 0);
});

test("인증되지 않았거나 닫힌 연결의 티켓·토큰 등록은 거절한다", async (t) => {
  const f = await fixture(t);
  const other = "f".repeat(32);
  assert.equal(f.gateway.receive({ type: "paseo.grant", connId: other, ticket: "c".repeat(64), nodeId: NODE, port: f.upstream.port }), false);
  assert.equal(f.gateway.receive({ type: "paseo.pane", connId: other, token: "d".repeat(32), paneId: "w1:p1" }), false);
});

test("HTTP 요청에 Origin 이 있으면 이 주소여야 한다", async (t) => {
  const f = await fixture(t);
  f.grant();
  const { cookie } = await f.enter();
  assert.equal((await f.get("/paseo-ui/", { cookie, origin: "https://evil.example" })).status, 404);
  assert.equal((await f.get("/paseo-ui/", { cookie, origin: `https://${f.host}` })).status, 200);
});

test("/ws 같은 WebSocket 업그레이드는 쿠키가 있어도 받지 않는다", async (t) => {
  const f = await fixture(t);
  f.grant();
  const { cookie } = await f.enter();
  const opened = await new Promise((resolve) => {
    const ws = new WebSocket(`wss://127.0.0.1:${f.port}/ws`, { rejectUnauthorized: false,
      headers: { host: f.host, origin: `https://${f.host}`, cookie } });
    ws.on("open", () => resolve(true));
    ws.on("error", () => resolve(false));
    ws.on("unexpected-response", () => resolve(false));
  });
  assert.equal(opened, false);
});

test("원격 연결이 닫히면 쿠키가 즉시 끊기고 토큰도 사라진다", async (t) => {
  const f = await fixture(t);
  f.grant();
  f.pane();
  const { cookie } = await f.enter();
  assert.equal((await f.get("/paseo-ui/", { cookie })).status, 200);
  f.gateway.receive({ type: "conn.close", connId: f.connId, reason: "pin-expired" });
  await eventually(() => f.gateway.status().connections === 0);
  assert.equal((await f.get("/paseo-ui/", { cookie }, true)).status, 404);
});

test("기기 해제처럼 연결이 남아 있어도 paseo.revoke 가 쿠키를 끊는다", async (t) => {
  const f = await fixture(t);
  f.grant();
  const { cookie } = await f.enter();
  assert.equal(f.gateway.receive({ type: "paseo.revoke", connId: f.connId }), true);
  assert.equal((await f.get("/paseo-ui/", { cookie }, true)).status, 404);
  // remote/1 연결 자체는 남아 응답을 보낼 수 있음
  assert.equal(f.gateway.receive({ type: "conn.send", connId: f.connId, payload: "{}" }), true);
});

test("upstreamPath 는 화면·이미지 경로만 허용한다", () => {
  const panes = new Map([["t1", "w1:p2"]]);
  assert.equal(upstreamPath("/paseo-ui/?v=1", panes), "/paseo-ui/?v=1");
  assert.equal(upstreamPath("/paseo-ui", panes), "/paseo-ui/");
  assert.equal(upstreamPath("/agentchat-image?pane=t1&off=1&i=0", panes), "/agentchat-image?pane=w1%3Ap2&off=1&i=0");
  assert.equal(upstreamPath("/agentchat-image?pane=zz", panes), null);
  assert.equal(upstreamPath("/agentchat-image", undefined), null);
  assert.equal(upstreamPath("/agentchat-file?path=a.png&cwd=b", panes), null);
  assert.equal(upstreamPath("/agentchat-image?pane=t1&agent=x&off=1&i=0", panes), null);
  for (const bad of ["/", "/api/x", "/ws", "/paseo-ui/../api/x", "//evil.example/paseo-ui/"]) assert.equal(upstreamPath(bad, panes), null, bad);
});

test("splitCookie 는 프록시 쿠키만 떼어 낸다", () => {
  assert.deepEqual(splitCookie("a=1; __Host-iris-paseo=abc; b=2"), { value: "abc", rest: "a=1; b=2" });
  assert.deepEqual(splitCookie(undefined), { value: null, rest: "" });
});
