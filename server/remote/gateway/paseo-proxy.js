// 폰 웹뷰용 대화 화면 프록시
//
// 소유 범위
//   일회용 티켓, 쿠키 세션, 가짜 pane 토큰, 127.0.0.1 의 Iris 서버로 정해진 GET 경로만 전달
//
// 유지 조건
//   세션은 remote/1 연결(connId) 하나에 묶음. 연결이 닫히면 세션·pane 토큰·열린 전달 소켓 모두 종료
//   쿠키 없는 요청은 전달하지 않음. 전달 경로는 /paseo-ui/ 아래와 /agentchat-image 뿐
//   upstream 은 grant 로 받은 127.0.0.1 포트 하나. 요청이 대상을 바꾸지 못함
//   x-forwarded-* 를 붙이지 않음(Iris 서버가 프록시 헤더가 있는 요청을 로컬 요청으로 보지 않음)
//   응답 본문은 가공하지 않고 스트리밍. 자식 프로세스 재시작 시 티켓·세션 소멸(fail-closed)

import http from "node:http";

export const PASEO_ENTER_PATH = "/.iris-paseo/enter";
export const PASEO_COOKIE = "__Host-iris-paseo";
export const PASEO_TICKET_TTL_MS = 30_000;
export const MAX_PASEO_TICKETS = 8;

const UI_PREFIX = "/paseo-ui/";
// 대화에 들어 있는 이미지. pane 값은 폰이 아는 가짜 토큰이고 전달할 때 진짜 pane id 로 바꿈
const IMAGE_PATH = "/agentchat-image";
export const MAX_PANE_TOKENS = 32;
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "proxy-connection"]);
const TICKET = /^[0-9a-f]{64}$/;
const COOKIE_VALUE = /^[0-9a-f]{64}$/;

function deny(response, status = 404) {
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8", connection: "close" });
  response.end(status === 404 ? "Not found" : "Unavailable");
}

// "a=1; b=2" 에서 이 프록시 쿠키 값과, 이를 뺀 나머지 쿠키 문자열
export function splitCookie(header) {
  let value = null;
  const rest = [];
  for (const part of String(header || "").split(";")) {
    const text = part.trim();
    if (!text) continue;
    const eq = text.indexOf("=");
    const name = eq < 0 ? text : text.slice(0, eq);
    if (name === PASEO_COOKIE) { if (value === null) value = eq < 0 ? "" : text.slice(eq + 1); continue; }
    rest.push(text);
  }
  return { value, rest: rest.join("; ") };
}

// 폰 요청 주소 → Iris 서버에 보낼 경로. 허용하지 않는 주소와 모르는 pane 토큰은 null
export function upstreamPath(requestUrl, paneIds) {
  if (typeof requestUrl !== "string" || !requestUrl.startsWith("/") || requestUrl.startsWith("//")) return null;
  let url;
  try { url = new URL(requestUrl, "https://iris.invalid"); } catch { return null; }
  if (url.pathname.startsWith(UI_PREFIX) || url.pathname === "/paseo-ui") {
    return url.pathname === "/paseo-ui" ? `${UI_PREFIX}${url.search}` : `${url.pathname}${url.search}`;
  }
  if (url.pathname === IMAGE_PATH) {
    // 서브에이전트 이미지는 폰에서 열지 않음
    if (url.searchParams.has("agent")) return null;
    const paneId = paneIds?.get(url.searchParams.get("pane") || "");
    if (!paneId) return null;
    url.searchParams.set("pane", paneId);
    return `${url.pathname}${url.search}`;
  }
  return null;
}

export function createPaseoProxy(options) {
  const now = options.now || Date.now;
  const randomHex = options.randomHex;
  const isLive = options.isConnectionLive;
  const resolveNode = options.resolveNode;
  const externalHost = options.externalHost;
  const promote = options.promoteSocket;
  const requestHttp = options.httpRequest || http.request;
  if (typeof randomHex !== "function" || typeof isLive !== "function" || typeof resolveNode !== "function"
    || typeof externalHost !== "function" || typeof promote !== "function") {
    throw new TypeError("paseo proxy dependencies are incomplete");
  }
  const tickets = new Map();   // 티켓 → { connId, nodeId, port, expiresAt }
  const sessions = new Map();  // 쿠키 값 → { connId, nodeId, port, sockets:Set }
  const panes = new Map();     // connId → Map(토큰 → 진짜 pane id)

  function pruneTickets() {
    const at = now();
    for (const [key, ticket] of tickets) if (ticket.expiresAt <= at) tickets.delete(key);
  }

  function grant(message) {
    pruneTickets();
    if (!isLive(message.connId)) return false;
    while (tickets.size >= MAX_PASEO_TICKETS) tickets.delete(tickets.keys().next().value);
    tickets.set(message.ticket, { connId: message.connId, nodeId: message.nodeId, port: message.port,
      expiresAt: now() + PASEO_TICKET_TTL_MS });
    return true;
  }

  // 폰이 대화를 열 때 호스트가 알려 주는 가짜 토큰. 연결마다 MAX_PANE_TOKENS 개
  function addPane(message) {
    if (!isLive(message.connId)) return false;
    let map = panes.get(message.connId);
    if (!map) { map = new Map(); panes.set(message.connId, map); }
    while (map.size >= MAX_PANE_TOKENS && !map.has(message.token)) map.delete(map.keys().next().value);
    map.set(message.token, message.paneId);
    return true;
  }

  function revokeConnection(connId) {
    panes.delete(connId);
    for (const [key, ticket] of tickets) if (ticket.connId === connId) tickets.delete(key);
    for (const [key, session] of sessions) {
      if (session.connId !== connId) continue;
      sessions.delete(key);
      for (const socket of session.sockets) socket.destroy();
      session.sockets.clear();
    }
  }

  function stop() {
    tickets.clear();
    for (const [, session] of sessions) { for (const socket of session.sockets) socket.destroy(); }
    sessions.clear();
    panes.clear();
  }

  function hostMatches(request) {
    return request.headers.host === externalHost();
  }

  // 쿠키 세션 + 연결 생존 + 같은 Tailscale 노드
  async function sessionFor(request) {
    const { value } = splitCookie(request.headers.cookie);
    if (!value || !COOKIE_VALUE.test(value)) return null;
    const session = sessions.get(value);
    if (!session) return null;
    if (!isLive(session.connId)) { revokeConnection(session.connId); return null; }
    const peerIp = request.socket.remoteAddress?.replace(/^::ffff:/, "") || "";
    let node = null;
    try { node = await resolveNode(peerIp); } catch {}
    if (!node || node !== session.nodeId) return null;
    // whois 대기 중 연결이 끊겼을 수 있음
    return sessions.get(value) === session && isLive(session.connId) ? session : null;
  }

  async function enter(request, response, url) {
    pruneTickets();
    const key = url.searchParams.get("t") || "";
    const ticket = TICKET.test(key) ? tickets.get(key) : null;
    tickets.delete(key);
    if (!ticket || ticket.expiresAt <= now() || !isLive(ticket.connId)) return deny(response);
    const peerIp = request.socket.remoteAddress?.replace(/^::ffff:/, "") || "";
    let node = null;
    try { node = await resolveNode(peerIp); } catch {}
    if (!node || node !== ticket.nodeId || !isLive(ticket.connId)) return deny(response);
    if (!promote(request.socket)) return deny(response, 503);
    const cookie = randomHex(32);
    const session = { connId: ticket.connId, nodeId: ticket.nodeId, port: ticket.port, sockets: new Set([request.socket]) };
    sessions.set(cookie, session);
    request.socket.once("close", () => session.sockets.delete(request.socket));
    response.writeHead(303, {
      location: UI_PREFIX,
      "set-cookie": `${PASEO_COOKIE}=${cookie}; Secure; HttpOnly; SameSite=Strict; Path=/`,
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    response.end();
  }

  function forwardHeaders(request, rest, port) {
    const headers = {};
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const name = request.rawHeaders[index];
      const lower = name.toLowerCase();
      if (HOP_BY_HOP.has(lower) || lower === "cookie" || lower === "host" || lower.startsWith("x-forwarded-")) continue;
      headers[name] = headers[name] === undefined ? request.rawHeaders[index + 1] : `${headers[name]}, ${request.rawHeaders[index + 1]}`;
    }
    headers.host = `127.0.0.1:${port}`;
    if (rest) headers.cookie = rest;
    return headers;
  }

  async function forward(request, response) {
    if (request.method !== "GET") return deny(response);
    const session = await sessionFor(request);
    if (!session) return deny(response);
    const target = upstreamPath(request.url, panes.get(session.connId));
    if (!target) return deny(response);
    if (!promote(request.socket)) return deny(response, 503);
    session.sockets.add(request.socket);
    request.socket.once("close", () => session.sockets.delete(request.socket));
    const { rest } = splitCookie(request.headers.cookie);
    const upstream = requestHttp({ host: "127.0.0.1", port: session.port, method: "GET", path: target,
      headers: forwardHeaders(request, rest, session.port) }, (reply) => {
      const headers = {};
      for (let index = 0; index < reply.rawHeaders.length; index += 2) {
        const lower = reply.rawHeaders[index].toLowerCase();
        if (HOP_BY_HOP.has(lower)) continue;
        const name = reply.rawHeaders[index];
        headers[name] = headers[name] === undefined ? reply.rawHeaders[index + 1] : [].concat(headers[name], reply.rawHeaders[index + 1]);
      }
      response.writeHead(reply.statusCode || 502, reply.statusMessage, headers);
      reply.pipe(response);
      reply.on("error", () => response.destroy());
    });
    session.sockets.add(upstream);
    upstream.once("close", () => session.sockets.delete(upstream));
    upstream.on("error", () => deny(response, 502));
    response.on("close", () => upstream.destroy());
    upstream.end();
  }

  async function handleRequest(request, response) {
    if (!hostMatches(request)) return deny(response);
    // 브라우저는 교차 출처 요청과 POST 에 Origin 을 붙임. 있으면 이 주소여야 함
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== `https://${externalHost()}`) return deny(response);
    let url;
    try { url = new URL(request.url, "https://iris.invalid"); } catch { return deny(response); }
    if (url.pathname === PASEO_ENTER_PATH) {
      if (request.method !== "GET") return deny(response);
      return enter(request, response, url);
    }
    return forward(request, response);
  }

  return {
    grant, addPane, revokeConnection, stop, handleRequest,
    status: () => ({ tickets: tickets.size, sessions: sessions.size }),
  };
}
