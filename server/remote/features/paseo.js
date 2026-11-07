// 폰 웹뷰의 대화 화면(Paseo UI 빌드)과 대화 데이터
//
// 소유 범위
//   paseo.open(웹뷰 티켓) · chat.open/older/close 요청 처리, 연결별 가짜 로컬 연결 하나
//
// 제공 API
//   createPaseoFeature(options) → { available(), open(entry), chatOpen(entry, message),
//                                   chatOlder(entry, message), chatClose(entry, message), closeConnection(connId), close() }
//   options.chatBackend: { handle(ws, msg), uiStatus() }(server/agent-chat.js · paseo-ui 의 함수)
//   options.paseoGrant · options.paseoPane: 게이트웨이에 티켓·가짜 pane 토큰 등록(boolean 반환)
//
// 유지 조건
//   폰에는 pane id 를 주지 않음. 대화마다 임의 토큰을 key 로 쓰고 게이트웨이가 이미지 요청의 토큰을 pane id 로 바꿈
//   handleAgentChat 은 로컬 연결만 받음. 원격 연결 대신 이 모듈이 만든 가짜 로컬 연결을 넘기고 응답을 원격 프레임으로 바꿔 보냄
//   프레임 하나는 원격 상한(64 KiB) 안. 큰 메시지는 잘라 표시

import { randomBytes as nodeRandomBytes } from "node:crypto";

import { projectFeature } from "../projection.js";
import { redactMacPaths } from "../public-text.js";
import { chunkMessages, publicMessage } from "./chat-frames.js";

const FRAME_MESSAGE_BYTES = 40 * 1024;
const MAX_CHATS_PER_CONNECTION = 4;
const UI_POLL_MS = 1000;

function publicMessages(messages) {
  return Array.isArray(messages) ? messages.map((message) => publicMessage(message, redactMacPaths)) : [];
}

export function createPaseoFeature(options) {
  const chat = options.chatBackend;
  const grant = options.paseoGrant;
  const addPane = options.paseoPane;
  const getPort = options.getServerPort;
  const send = options.send;
  const agents = options.agents;
  const random = options.randomBytes || nodeRandomBytes;
  const setTimer = options.setTimer || setInterval;
  const clearTimer = options.clearTimer || clearInterval;
  const sinks = new Map();   // connId → { ws, keys:Set, timer, ui }

  const available = () => !!chat && [grant, addPane, getPort, send].every((fn) => typeof fn === "function") && !!agents;

  function push(connId, message) {
    try { send(connId, projectFeature(message)); } catch {}
  }

  function route(connId, text) {
    let frame;
    try { frame = JSON.parse(text); } catch { return; }
    const sink = sinks.get(connId);
    if (!sink || !sink.keys.has(frame?.key)) return;
    if (frame.type === "agentchat.frame") {
      if (frame.kind === "missing" || frame.kind === "error") {
        push(connId, { type: "chat.frame", key: frame.key, kind: frame.kind, reason: String(frame.reason || "").slice(0, 300) });
        return;
      }
      const groups = chunkMessages(publicMessages(frame.messages), FRAME_MESSAGE_BYTES);
      if (!groups.length) groups.push([]);
      groups.forEach((messages, index) => {
        const first = index === 0;
        push(connId, { type: "chat.frame", key: frame.key, kind: first ? frame.kind : "append", messages,
          ...(first && typeof frame.hasOlder === "boolean" ? { hasOlder: frame.hasOlder } : {}) });
      });
    } else if (frame.type === "agentchat.older") {
      const groups = chunkMessages(publicMessages(frame.messages), FRAME_MESSAGE_BYTES);
      if (!groups.length) groups.push([]);
      // 앞쪽에 붙는 묶음이라 가장 뒤쪽 묶음부터 보냄
      for (const messages of groups.reverse()) push(connId, { type: "chat.older", key: frame.key, messages, hasOlder: !!frame.hasOlder });
    }
  }

  function sinkFor(connId) {
    let sink = sinks.get(connId);
    if (sink) return sink;
    sink = { keys: new Set(), timer: null, ui: "", ws: null };
    sink.ws = { _local: true, readyState: 1, send: (text) => route(connId, text), once() {} };
    sinks.set(connId, sink);
    return sink;
  }

  function pushUi(connId, sink, force = false) {
    let status;
    try { status = chat.uiStatus(); } catch { return; }
    const message = { type: "chat.ui", phase: String(status?.phase || "none"),
      ...(typeof status?.version === "string" && status.version ? { version: status.version } : {}),
      ...(typeof status?.url === "string" && status.url ? { url: status.url } : {}),
      message: String(status?.message || "").slice(0, 300) };
    const signature = JSON.stringify(message);
    if (!force && signature === sink.ui) return;
    sink.ui = signature;
    push(connId, message);
  }

  function stopSink(connId) {
    const sink = sinks.get(connId);
    if (!sink) return;
    for (const key of sink.keys) {
      try { chat.handle(sink.ws, { type: "agentchat.close", key }); } catch {}
    }
    if (sink.timer) clearTimer(sink.timer);
    sinks.delete(connId);
  }

  return {
    available,
    async open(entry) {
      if (!available()) return { ok: false, code: "unavailable" };
      const port = Number(getPort());
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return { ok: false, code: "unavailable" };
      const ticket = random(32).toString("hex");
      if (!grant({ connId: entry.connId, ticket, nodeId: entry.nodeId, port })) return { ok: false, code: "unavailable" };
      return { ok: true, ticket };
    },
    chatOpen(entry, message) {
      if (!available()) return { ok: false, code: "unavailable" };
      const agent = agents.resolve(message.agent);
      const paneId = agent?.source?.paneId;
      if (typeof paneId !== "string" || !paneId) return { ok: false, code: "forbidden" };
      const sink = sinkFor(entry.connId);
      if (sink.keys.size >= MAX_CHATS_PER_CONNECTION) return { ok: false, code: "forbidden" };
      const key = random(16).toString("hex");
      if (!addPane({ connId: entry.connId, token: key, paneId })) return { ok: false, code: "unavailable" };
      sink.keys.add(key);
      try { chat.handle(sink.ws, { type: "agentchat.open", key, paneId }); } catch {
        sink.keys.delete(key);
        return { ok: false, code: "unavailable" };
      }
      if (!sink.timer) {
        sink.timer = setTimer(() => pushUi(entry.connId, sink), UI_POLL_MS);
        sink.timer.unref?.();
      }
      pushUi(entry.connId, sink, true);
      return { ok: true, key };
    },
    chatOlder(entry, message) {
      const sink = sinks.get(entry.connId);
      if (!sink?.keys.has(message.key)) return { ok: false, code: "forbidden" };
      try { chat.handle(sink.ws, { type: "agentchat.older", key: message.key }); } catch { return { ok: false, code: "unavailable" }; }
      return { ok: true };
    },
    chatClose(entry, message) {
      const sink = sinks.get(entry.connId);
      if (!sink?.keys.has(message.key)) return { ok: false, code: "forbidden" };
      try { chat.handle(sink.ws, { type: "agentchat.close", key: message.key }); } catch {}
      sink.keys.delete(message.key);
      if (!sink.keys.size) { if (sink.timer) clearTimer(sink.timer); sink.timer = null; }
      return { ok: true };
    },
    closeConnection: stopSink,
    close() { for (const connId of [...sinks.keys()]) stopSink(connId); },
  };
}
