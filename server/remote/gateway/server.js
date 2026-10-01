import https from "node:https";
import { TextDecoder } from "node:util";

import { WebSocketServer } from "ws";

import {
  fitsRemoteIpc,
  isHostMessage,
  MAX_REMOTE_FRAME_BYTES,
  utf8Bytes,
} from "../contract/ipc.js";
import { isAllowedListenAddress } from "./address.js";
import { createGatewayIpcQueue } from "./ipc-queue.js";
import { createWhoisResolver } from "./whois.js";
import { resetTokenBucket, takeToken } from "../contract/rate-limit.js";

const PREAUTH_GLOBAL_LIMIT = 16;
const PREAUTH_IP_LIMIT = 4;
const PREAUTH_LIFETIME_MS = 60_000;
const PREAUTH_RATE = 5;
const AUTHENTICATED_RATE = 10;
const AUTHENTICATED_BURST = 30;
const WS_PENDING_LIMIT = 1024 * 1024;

const GATEWAY_LIMITS = Object.freeze({
  preauthGlobal: PREAUTH_GLOBAL_LIMIT,
  preauthPerIp: PREAUTH_IP_LIMIT,
  preauthLifetimeMs: PREAUTH_LIFETIME_MS,
  preauthRate: PREAUTH_RATE,
  authenticatedRate: AUTHENTICATED_RATE,
  authenticatedBurst: AUTHENTICATED_BURST,
  frameBytes: MAX_REMOTE_FRAME_BYTES,
  websocketPendingBytes: WS_PENDING_LIMIT,
});

function peerAddress(socket) {
  const value = socket?.remoteAddress || "";
  return value.startsWith("::ffff:") ? value.slice(7) : value;
}

export function createGateway(options) {
  const sendIpc = options?.sendIpc;
  if (typeof sendIpc !== "function") throw new TypeError("gateway IPC sender is required");
  const fatal = options.onFatal || (() => {});
  const allowListenAddress = options.allowListenAddress || isAllowedListenAddress;
  const createHttpsServer = options.createHttpsServer || ((tlsOptions, listener) => https.createServer(tlsOptions, listener));
  const WebSocketServerClass = options.WebSocketServer || WebSocketServer;
  const now = options.now || Date.now;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const connections = new Map();
  const bySequence = new Map();
  const connectionsBySocket = new WeakMap();
  const sockets = new Set();
  const socketReservations = new Map();
  const perIp = new Map();
  const blockedIps = new Map();
  let gatewaySequence = 0;
  let server = null;
  let websocketServer = null;
  let config = null;
  let stopping = false;
  let failed = false;

  function fail(error) {
    if (failed || stopping) return;
    failed = true;
    stop();
    fatal(error instanceof Error ? error : new Error(String(error)));
  }

  function lookupQueueKey(key) {
    if (typeof key !== "string") return null;
    if (key.startsWith("gw:")) return bySequence.get(Number(key.slice(3))) || null;
    return connections.get(key) || null;
  }

  const ipc = createGatewayIpcQueue({
    send: sendIpc,
    maximumPerConnection: options.ipcPendingLimit,
    onOverflow(key) {
      const connection = lookupQueueKey(key);
      if (connection) closeConnection(connection, "ipc-backpressure");
    },
    onFailure: fail,
  });

  function emit(message, key) {
    return ipc.enqueue(message, key);
  }

  function releaseSocket(socket) {
    if (!sockets.delete(socket)) return;
    const reservation = socketReservations.get(socket);
    socketReservations.delete(socket);
    clearTimer(reservation?.timer);
    const address = reservation?.address || "";
    const next = Math.max(0, (perIp.get(address) || 0) - 1);
    if (next === 0) perIp.delete(address);
    else perIp.set(address, next);
  }

  function finalizeConnection(connection, reason, notify = true) {
    if (connection.closed) return;
    connection.closed = true;
    bySequence.delete(connection.gwSeq);
    if (connection.connId) {
      connections.delete(connection.connId);
      ipc.discard(connection.connId);
      if (notify) emit({ type: "conn.close", connId: connection.connId, reason }, connection.connId);
    } else {
      const key = `gw:${connection.gwSeq}`;
      ipc.discard(key);
      if (notify) emit({ type: "conn.abandon", gwSeq: connection.gwSeq }, key);
    }
  }

  function closeConnection(connection, reason, notify = true) {
    finalizeConnection(connection, reason, notify);
    try {
      if (reason === "idle-timeout") connection.ws.close(4001, reason);
      else connection.ws.terminate();
    } catch {}
  }

  function onFrame(connection, data, isBinary) {
    if (connection.closed) return;
    const bytes = data?.byteLength ?? Buffer.byteLength(String(data));
    if (isBinary || bytes > MAX_REMOTE_FRAME_BYTES || !connection.connId) {
      closeConnection(connection, isBinary ? "binary-frame" : bytes > MAX_REMOTE_FRAME_BYTES ? "frame-too-large" : "frame-before-accept");
      return;
    }
    const timestamp = now();
    const rate = connection.authenticated ? AUTHENTICATED_RATE : PREAUTH_RATE;
    const capacity = connection.authenticated ? AUTHENTICATED_BURST : PREAUTH_RATE;
    if (!takeToken(connection, timestamp, { capacity, perSecond: rate })) {
      closeConnection(connection, "rate-limit");
      return;
    }
    let payload;
    try {
      payload = new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
      closeConnection(connection, "invalid-utf8");
      return;
    }
    const message = { type: "conn.frame", connId: connection.connId, payload };
    if (!fitsRemoteIpc(message)) {
      closeConnection(connection, "ipc-message-too-large");
      return;
    }
    emit(message, connection.connId);
  }

  function acceptWebSocket(ws, socket, peerIp, nodeId) {
    const availability = config.availability || "enabled";
    if (availability !== "enabled") {
      ws.on("error", () => {});
      ws.send(JSON.stringify({ type: "service.status", v: config.v, reason: availability }), () => {
        try { ws.close(4003, availability); } catch {}
      });
      return;
    }
    const gwSeq = ++gatewaySequence;
    const connection = {
      ws,
      socket,
      gwSeq,
      connId: null,
      peerIp,
      authenticated: false,
      closed: false,
      rateTokens: PREAUTH_RATE,
      rateUpdatedAt: now(),
    };
    bySequence.set(gwSeq, connection);
    connectionsBySocket.set(socket, connection);
    ws.on("message", (data, isBinary) => onFrame(connection, data, isBinary));
    ws.on("close", () => finalizeConnection(connection, "peer-closed"));
    ws.on("error", () => closeConnection(connection, "socket-error"));
    emit({ type: "conn.open", gwSeq, peerIp, nodeId, certHash: config.certHash }, `gw:${gwSeq}`);
  }

  function reserveSocket(socket, address) {
    if (sockets.has(socket)) return true;
    const blockedUntil = blockedIps.get(address) || 0;
    if (blockedUntil > now()) return null;
    if (blockedUntil) blockedIps.delete(address);
    if (sockets.size >= (options.globalLimit ?? PREAUTH_GLOBAL_LIMIT)) return null;
    const count = perIp.get(address) || 0;
    if (count >= (options.perIpLimit ?? PREAUTH_IP_LIMIT)) return null;
    sockets.add(socket);
    perIp.set(address, count + 1);
    const timer = setTimer(() => {
      const connection = connectionsBySocket.get(socket);
      if (connection) closeConnection(connection, "authentication-timeout");
      else socket.destroy();
    }, options.preauthLifetimeMs ?? PREAUTH_LIFETIME_MS);
    timer?.unref?.();
    socketReservations.set(socket, { address, timer });
    socket.once("close", () => releaseSocket(socket));
    return true;
  }

  async function start(nextConfig) {
    if (server || config) throw new Error("gateway already started");
    if (!isHostMessage(nextConfig) || nextConfig.type !== "configure" || !fitsRemoteIpc(nextConfig)) {
      throw new Error("invalid gateway configuration");
    }
    if (!allowListenAddress(nextConfig.address)) throw new Error("listen address is not allowed");
    config = nextConfig;
    const whois = options.whoisResolver || createWhoisResolver({
      executable: config.tailscalePath,
      execFile: options.execFile,
      now,
      setTimer,
      clearTimer,
      timeoutMs: options.whoisTimeoutMs,
    });
    websocketServer = new WebSocketServerClass({ noServer: true, maxPayload: MAX_REMOTE_FRAME_BYTES });
    server = createHttpsServer({
      key: config.keyPem,
      cert: config.certPem,
      minVersion: "TLSv1.3",
      handshakeTimeout: options.handshakeTimeoutMs ?? 2_000,
    }, (_request, response) => {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    });
    server.maxConnections = options.globalLimit ?? PREAUTH_GLOBAL_LIMIT;
    server.on("secureConnection", (socket) => {
      const peerIp = peerAddress(socket);
      if (!peerIp || !reserveSocket(socket, peerIp)) socket.destroy();
    });
    server.on("upgrade", (request, socket, head) => {
      if (stopping || failed) return socket.destroy();
      const peerIp = peerAddress(socket);
      if (!peerIp || !sockets.has(socket)) return socket.destroy();
      Promise.resolve(whois.resolve(peerIp)).then((nodeId) => {
        if (stopping || failed || socket.destroyed) return socket.destroy();
        websocketServer.handleUpgrade(request, socket, head, (ws) => acceptWebSocket(ws, socket, peerIp, nodeId));
      }, () => socket.destroy());
    });
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        server.on("error", fail);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(config.port, config.address);
    });
    const bound = server.address();
    emit({ type: "listening", address: config.address, port: bound?.port || config.port, certHash: config.certHash }, "gateway");
    return { address: config.address, port: bound?.port || config.port };
  }

  function receive(message) {
    if (!fitsRemoteIpc(message) || !isHostMessage(message) || message.type === "configure") {
      fail(new Error("invalid host IPC message"));
      return false;
    }
    if (message.type === "conn.accept") {
      const connection = bySequence.get(message.gwSeq);
      if (!connection || connection.closed || connection.connId || connections.has(message.connId)) return false;
      connection.connId = message.connId;
      connections.set(message.connId, connection);
      return true;
    }
    if (message.type === "ip.block") {
      if (message.blockedUntil > now()) blockedIps.set(message.peerIp, message.blockedUntil);
      else blockedIps.delete(message.peerIp);
      for (const connection of [...connections.values()]) {
        if (connection.peerIp === message.peerIp) closeConnection(connection, "authentication-blocked", false);
      }
      for (const [socket, reservation] of socketReservations) {
        if (reservation.address === message.peerIp) socket.destroy();
      }
      return true;
    }
    const connection = connections.get(message.connId);
    if (!connection || connection.closed) return false;
    if (message.type === "conn.close") {
      closeConnection(connection, message.reason, false);
      return true;
    }
    if (message.type === "conn.authenticated") {
      connection.authenticated = true;
      resetTokenBucket(connection, now(), AUTHENTICATED_BURST);
      const reservation = socketReservations.get(connection.socket);
      if (reservation?.timer) {
        clearTimer(reservation.timer);
        reservation.timer = null;
      }
      return true;
    }
    const bytes = utf8Bytes(message.payload);
    if (connection.ws.bufferedAmount + bytes > (options.wsPendingLimit ?? WS_PENDING_LIMIT)) {
      closeConnection(connection, "ws-backpressure");
      return false;
    }
    connection.ws.send(message.payload, (error) => {
      if (error) closeConnection(connection, "ws-send-failed");
    });
    return true;
  }

  function stop() {
    if (stopping) return;
    stopping = true;
    for (const connection of [...bySequence.values()]) closeConnection(connection, "gateway-stopped", false);
    for (const socket of [...sockets]) socket.destroy();
    try { websocketServer?.close(); } catch {}
    try { server?.close(); } catch {}
  }

  return {
    start,
    receive,
    stop,
    status: () => ({ connections: bySequence.size, sockets: sockets.size, blockedIps: blockedIps.size,
      failed, stopping, ipc: ipc.status() }),
  };
}
