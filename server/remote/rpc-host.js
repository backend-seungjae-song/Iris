import { fork as nodeFork } from "node:child_process";
import { randomBytes as nodeRandomBytes } from "node:crypto";

import {
  fitsRemoteIpc,
  fitsRemoteOutboundPayload,
  isGatewayMessage,
  isHostMessage,
} from "./contract/ipc.js";
import { isRemoteOutbound } from "./contract/connection.js";
import { hasRemoteRequestType, isRemoteRequest, isRequestId } from "./contract/requests.js";
import { createAgentStore } from "./agents.js";
import { createHostIpcQueue } from "./host-ipc-queue.js";
import { createMessageBridge } from "./messaging.js";
import { createRemoteOperations } from "./ops/index.js";
import {
  projectAuthResult,
  projectChallenge,
  projectError,
  projectPairPending,
  projectPinError,
  projectPinRequired,
} from "./projection.js";
import { createRequestStore } from "./requests.js";
import { createTranscriptService } from "./transcript.js";
import { resetTokenBucket, takeToken } from "./contract/rate-limit.js";

const RESTART_DELAYS = Object.freeze([1_000, 2_000, 4_000, 8_000]);
const FAILURE_WINDOW_MS = 5 * 60_000;
const FAILURE_LIMIT = 5;
const PREAUTH_RATE = 5;
const AUTHENTICATED_RATE = 10;
const AUTHENTICATED_BURST = 30;

export function createRemoteRpcHost(options) {
  const serverInstance = options?.serverInstance;
  if (!/^[0-9a-f]{32}$/.test(serverInstance || "")) throw new TypeError("serverInstance must be 128-bit hex");
  const forkProcess = options.fork || nodeFork;
  const randomBytes = options.randomBytes || nodeRandomBytes;
  const now = options.now || Date.now;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const onFailureLimit = options.onFailureLimit || (() => {});
  const onStatus = options.onStatus || (() => {});
  const onAudit = options.onAudit || (() => {});
  const onFrame = options.onFrame;
  const onPairRequest = options.onPairRequest;
  const auth = options.auth;
  const connections = new Map();
  const bySequence = new Map();
  let active = false;
  let child = null;
  let childRecord = null;
  let queue = null;
  let generation = 0;
  let restartTimer = null;
  let failures = [];
  let configuration = null;
  let readyPromise = null;
  let resolveReady = null;
  let rejectReady = null;
  let listening = null;
  const messages = options.messageBridge || createMessageBridge({
    execFile: options.execFile,
    codexExecutable: options.codexExecutable,
  });
  const agents = options.agentStore || createAgentStore({ randomBytes });
  const requests = options.requestStore || createRequestStore({
    randomBytes,
    now,
    setTimer,
    clearTimer,
    agentRefForPane: agents.refForPane,
  });
  const transcripts = options.transcriptService || createTranscriptService({
    agents,
    randomBytes,
    setTimer,
    clearTimer,
    stateDir: options.stateDir,
  });

  function randomId() {
    return randomBytes(16).toString("hex");
  }

  function settleReady(error, value) {
    if (!resolveReady) return;
    const resolve = resolveReady;
    const reject = rejectReady;
    resolveReady = null;
    rejectReady = null;
    if (error) reject(error);
    else resolve(value);
  }

  function clearConnections(reason) {
    for (const connId of connections.keys()) {
      auth?.close(connId);
      operations.closeConnection(connId);
      onAudit({ type: "conn.closed", connId, reason });
    }
    connections.clear();
    bySequence.clear();
  }

  function detach(record) {
    if (!record?.process || !record.handlers) return;
    for (const [event, handler] of Object.entries(record.handlers)) record.process.off?.(event, handler);
    record.handlers = null;
  }

  function kill(record = childRecord) {
    if (!record?.process) return true;
    try {
      if (record.process.kill("SIGTERM") === false) return false;
      detach(record);
      return true;
    } catch {
      return false;
    }
  }

  function terminateCurrent(reason) {
    const record = childRecord;
    if (!record || record.failed) return;
    record.failed = true;
    const stopped = kill(record);
    clearConnections(reason);
    listening = null;
    if (!stopped) {
      active = false;
      const error = Object.assign(new Error("gateway-stop-failed"), { code: "gateway-stop-failed" });
      settleReady(error);
      onStatus({ type: "failed", code: error.code, reason });
      onFailureLimit({ code: error.code, reason });
      return;
    }
    if (childRecord === record) {
      childRecord = null;
      child = null;
      queue = null;
    }
    handleFailure(reason);
  }

  function sendControl(message, key = "gateway") {
    if (!queue || !isHostMessage(message)) return false;
    return queue.enqueue(message, key, { control: true });
  }

  function closeConnection(connId, reason) {
    const entry = connections.get(connId);
    if (!entry) return false;
    connections.delete(connId);
    auth?.close(connId);
    operations.closeConnection(connId);
    bySequence.delete(entry.gwSeq);
    queue?.discard(connId);
    sendControl({ type: "conn.close", connId, reason }, connId);
    onAudit({ type: "conn.closed", connId, reason });
    return true;
  }

  function framePayload(connId, projected) {
    let payload;
    try { payload = JSON.stringify(projected); } catch { return null; }
    const fits = (value) => fitsRemoteOutboundPayload(value)
      && fitsRemoteIpc({ type: "conn.send", connId, payload: value });
    if (fits(payload)) return payload;
    const field = ({
      "terminal.watch.result": "text",
      "terminal.frame": "text",
      "git.diff.result": "patch",
      "github.check.log.result": "log",
    })[projected?.type];
    // ANSI 격자를 보존하기 위한 전체 화면 오류 응답
    if (projected?.type === "terminal.scrollback.result") return JSON.stringify(projectError("terminal-frame-too-large", projected.rid));
    if (projected?.type === "terminal.watch.result" || projected?.type === "terminal.frame") {
      console.warn("[remote] terminal-frame-too-large");
      return JSON.stringify({ ...projected, text: "", truncated: false, error: "terminal-frame-too-large" });
    }
    if (field && typeof projected[field] === "string" && typeof projected.truncated === "boolean") {
      let low = 0, high = projected[field].length, fitted = null;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const end = middle > 0 && /[\uD800-\uDBFF]/.test(projected[field][middle - 1]) ? middle - 1 : middle;
        const candidate = { ...projected, [field]: projected[field].slice(0, end), truncated: true };
        const encoded = JSON.stringify(candidate);
        if (isRemoteOutbound(candidate) && fits(encoded)) {
          fitted = encoded;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      if (fitted) return fitted;
    }
    if (!isRequestId(projected?.rid)) return null;
    return JSON.stringify(projectError("limit-exceeded", projected.rid));
  }

  function sendRemote(connId, projected) {
    const entry = connections.get(connId);
    if (!entry || entry.generation !== generation || !isRemoteOutbound(projected)) return false;
    const payload = framePayload(connId, projected);
    if (!payload) return false;
    const message = { type: "conn.send", connId, payload };
    if (!isHostMessage(message)) return false;
    return queue?.enqueue(message, connId) || false;
  }

  function blockIp(peerIp, blockedUntil) {
    return sendControl({ type: "ip.block", peerIp, blockedUntil }, `ip:${peerIp}`);
  }

  const operations = options.operations || createRemoteOperations({
    agents,
    requests,
    transcripts,
    messages,
    getHerdr: options.getHerdr,
    send: sendRemote,
    now,
    setTimer,
    clearTimer,
    randomBytes,
    stateDir: options.stateDir,
    broadcast: options.broadcast,
    execFile: options.execFile,
    macName: options.macName,
  });
  const authenticatedRequests = operations.table;

  function makeQueue(record) {
    return createHostIpcQueue({
      send(message, callback) {
        if (record !== childRecord || !record.process.connected) {
          callback(new Error("gateway IPC disconnected"));
          return false;
        }
        return record.process.send(message, callback);
      },
      perConnectionLimit: options.perConnectionPendingLimit,
      totalLimit: options.totalPendingLimit,
      onConnectionOverflow(connId) { closeConnection(connId, "ipc-backpressure"); },
      onFailure(error) {
        if (record === childRecord) terminateCurrent(error?.message || "ipc-send-failed");
      },
    });
  }

  function acceptConnection(message, record) {
    if (message.certHash !== configuration.certHash || bySequence.has(message.gwSeq)) {
      terminateCurrent("invalid-connection-open");
      return;
    }
    const connId = randomId();
    const entry = {
      connId,
      gwSeq: message.gwSeq,
      generation: record.generation,
      peerIp: message.peerIp,
      nodeId: message.nodeId,
      certHash: message.certHash,
      rateTokens: PREAUTH_RATE,
      rateUpdatedAt: now(),
    };
    connections.set(connId, entry);
    bySequence.set(message.gwSeq, connId);
    if (!sendControl({ type: "conn.accept", gwSeq: message.gwSeq, connId }, connId)) {
      closeConnection(connId, "accept-failed");
      return;
    }
    if (auth) {
      const opened = auth.open(entry);
      if (!opened.ok) {
        if (opened.blockedUntil) blockIp(entry.peerIp, opened.blockedUntil);
        closeConnection(connId, "authentication-rejected");
        return;
      }
      if (!sendRemote(connId, projectChallenge(opened.challenge))) closeConnection(connId, "challenge-send-failed");
    }
    onAudit({ type: "conn.opened", connId, peerIp: entry.peerIp, nodeId: entry.nodeId });
  }

  async function handleAuthenticatedFrame(entry, parsed) {
    if (parsed?.type === "auth.response") {
      closeConnection(entry.connId, "duplicate-authentication");
      return;
    }
    const validRequest = hasRemoteRequestType(parsed) && isRemoteRequest(parsed);
    const admitted = auth.beginRequest(entry.connId, {
      activity: validRequest && (parsed.type !== "ping" || parsed.active === true),
    });
    if (!admitted.ok) {
      if (admitted.close) closeConnection(entry.connId, "request-limit");
      // 요청 번호 포함. 없으면 폰이 어느 요청의 거절인지 몰라 응답 한도까지 기다림
      else sendRemote(entry.connId, projectError(admitted.error, isRequestId(parsed?.rid) ? parsed.rid : undefined));
      return;
    }
    try {
      const rid = isRequestId(parsed?.rid) ? parsed.rid : undefined;
      let projected;
      if (!hasRemoteRequestType(parsed)) projected = projectError(typeof parsed?.type === "string" ? "unsupported-request" : "invalid-request", rid);
      else if (!validRequest) projected = projectError("invalid-request", rid);
      else projected = await authenticatedRequests.get(parsed.type)(entry, parsed);
      for (const output of Array.isArray(projected) ? projected : [projected]) {
        if (output) sendRemote(entry.connId, output);
      }
    } catch {
      const rid = isRequestId(parsed?.rid) ? parsed.rid : undefined;
      sendRemote(entry.connId, projectError("unavailable", rid));
    } finally {
      auth.endRequest(entry.connId);
    }
  }

  function completeAuthentication(entry, timestamp, accepted) {
    entry.authenticated = true;
    entry.deviceAuthenticated = true;
    resetTokenBucket(entry, timestamp, AUTHENTICATED_BURST);
    if (!sendControl({ type: "conn.authenticated", connId: entry.connId }, entry.connId)
      || !sendRemote(entry.connId, projectAuthResult(accepted.resumeToken, accepted.pinIdleMinutes))) {
      closeConnection(entry.connId, "authentication-result-failed");
    }
  }

  async function handleUnauthenticatedFrame(entry, parsed, timestamp) {
    if (entry.pinBusy) {
      closeConnection(entry.connId, "authentication-rejected");
      return;
    }
    if (!entry.deviceAuthenticated && parsed?.type === "pair.request") {
      let paired = null;
      try {
        if (entry.peerIp !== configuration.address && typeof onPairRequest === "function") {
          paired = onPairRequest({ ...entry }, parsed);
        }
      } catch {}
      if (!paired?.ok) {
        const rejected = auth.reject(entry.connId);
        if (rejected.blockedUntil) blockIp(entry.peerIp, rejected.blockedUntil);
        closeConnection(entry.connId, "authentication-rejected");
        return;
      }
      if (!sendRemote(entry.connId, projectPairPending(paired.pending))) {
        closeConnection(entry.connId, "pairing-result-failed");
        return;
      }
      auth.close(entry.connId);
      return;
    }
    if (!entry.deviceAuthenticated) {
      const authenticated = auth.authenticate(entry.connId, parsed);
      if (!authenticated.ok) {
        if (authenticated.blockedUntil) blockIp(entry.peerIp, authenticated.blockedUntil);
        closeConnection(entry.connId, "authentication-rejected");
        return;
      }
      if (authenticated.pinRequired) {
        entry.deviceAuthenticated = true;
        if (!sendRemote(entry.connId, projectPinRequired())) {
          closeConnection(entry.connId, "pin-prompt-failed");
        }
        return;
      }
      for (const replaced of authenticated.replacedConnIds || []) closeConnection(replaced, "session-resumed");
      completeAuthentication(entry, timestamp, authenticated);
      return;
    }
    if (parsed?.type !== "pin.submit" || typeof auth.submitPin !== "function") {
      closeConnection(entry.connId, "authentication-rejected");
      return;
    }
    entry.pinBusy = true;
    let accepted;
    try {
      accepted = await auth.submitPin(entry.connId, parsed);
    } catch {
      accepted = { ok: false, error: "unavailable", retryAfterMs: 0 };
    }
    finally { entry.pinBusy = false; }
    if (!connections.has(entry.connId)) return;
    if (!accepted.ok) {
      if (["incorrect", "retry-later", "unavailable"].includes(accepted.error)) {
        if (!sendRemote(entry.connId, projectPinError(accepted.error, accepted.retryAfterMs || 0))) {
          closeConnection(entry.connId, "pin-result-failed");
        }
      } else {
        if (accepted.blockedUntil) blockIp(entry.peerIp, accepted.blockedUntil);
        closeConnection(entry.connId, "authentication-rejected");
      }
      return;
    }
    completeAuthentication(entry, now(), accepted);
  }

  function receiveFrame(message) {
    const entry = connections.get(message.connId);
    if (!entry || entry.generation !== generation) {
      onAudit({ type: "conn.ignored", connId: message.connId, reason: "unknown-connection" });
      return;
    }
    const timestamp = now();
    const rate = entry.authenticated ? AUTHENTICATED_RATE : PREAUTH_RATE;
    const capacity = entry.authenticated ? AUTHENTICATED_BURST : PREAUTH_RATE;
    if (!takeToken(entry, timestamp, { capacity, perSecond: rate })) {
      closeConnection(entry.connId, "rate-limit");
      return;
    }
    if (!auth) {
      if (typeof onFrame === "function") return onFrame({ ...entry }, message.payload);
      closeConnection(entry.connId, "authentication-not-available");
      return;
    }
    let parsed;
    try { parsed = JSON.parse(message.payload); } catch { parsed = null; }
    if (!entry.authenticated) {
      void handleUnauthenticatedFrame(entry, parsed, timestamp);
      return;
    }
    void handleAuthenticatedFrame(entry, parsed);
  }

  function receive(message, record) {
    if (record !== childRecord || record.failed) return;
    if (!fitsRemoteIpc(message) || !isGatewayMessage(message)) {
      terminateCurrent("invalid-gateway-message");
      return;
    }
    if (!record.hello) {
      if (message.type !== "hello" || message.serverInstance !== serverInstance) {
        terminateCurrent("hello-mismatch");
        return;
      }
      record.hello = true;
      sendControl(configuration);
      return;
    }
    if (message.type === "hello") {
      terminateCurrent("duplicate-hello");
      return;
    }
    if (message.type === "listening") {
      if (message.address !== configuration.address || message.port !== configuration.port
        || message.certHash !== configuration.certHash) {
        terminateCurrent("listen-mismatch");
        return;
      }
      listening = { address: message.address, port: message.port, certHash: message.certHash };
      onStatus({ type: "listening", ...listening, generation });
      settleReady(null, { ...listening });
      for (const blocked of auth?.activeBlocks?.() || []) blockIp(blocked.peerIp, blocked.blockedUntil);
      return;
    }
    if (message.type === "listen.error") {
      terminateCurrent(message.code);
      return;
    }
    if (message.type === "conn.open") return acceptConnection(message, record);
    if (message.type === "conn.abandon") {
      const connId = bySequence.get(message.gwSeq);
      if (connId) closeConnection(connId, "peer-abandoned");
      return;
    }
    const entry = connections.get(message.connId);
    if (!entry || entry.generation !== record.generation) {
      onAudit({ type: "conn.ignored", connId: message.connId, reason: "unknown-connection" });
      return;
    }
    if (message.type === "conn.close") {
      connections.delete(entry.connId);
      auth?.close(entry.connId);
      operations.closeConnection(entry.connId);
      bySequence.delete(entry.gwSeq);
      queue?.discard(entry.connId);
      onAudit({ type: "conn.closed", connId: entry.connId, reason: message.reason });
      return;
    }
    receiveFrame(message);
  }

  function spawn() {
    if (!active || childRecord) return;
    generation++;
    let processHandle;
    try {
      processHandle = forkProcess(new URL("./gateway/child.js", import.meta.url), [serverInstance], {
        serialization: "json",
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
    } catch (error) {
      handleFailure(error?.message || "fork-failed");
      return;
    }
    const record = { process: processHandle, generation, hello: false, failed: false, handlers: null };
    child = processHandle;
    childRecord = record;
    queue = makeQueue(record);
    const failed = (reason, terminate = false) => {
      if (record !== childRecord) return;
      if (record.failed) {
        if (!terminate) {
          detach(record);
          childRecord = null;
          child = null;
          queue = null;
        }
        return;
      }
      if (terminate) {
        terminateCurrent(reason);
        return;
      }
      record.failed = true;
      detach(record);
      childRecord = null;
      child = null;
      queue = null;
      clearConnections(reason);
      listening = null;
      handleFailure(reason);
    };
    record.handlers = {
      message: (message) => receive(message, record),
      error: () => failed("gateway-error", true),
      disconnect: () => failed("gateway-disconnect", true),
      exit: () => failed("gateway-exit"),
    };
    for (const [event, handler] of Object.entries(record.handlers)) processHandle.on(event, handler);
    onStatus({ type: "starting", generation });
  }

  function handleFailure(reason) {
    if (!active) return;
    const timestamp = now();
    failures = failures.filter((value) => timestamp - value < FAILURE_WINDOW_MS);
    failures.push(timestamp);
    if (failures.length >= FAILURE_LIMIT) {
      active = false;
      if (restartTimer) clearTimer(restartTimer);
      restartTimer = null;
      clearConnections("failure-limit");
      const error = new Error("gateway-restart-limit");
      settleReady(error);
      onStatus({ type: "failed", code: "gateway-restart-limit", reason });
      onFailureLimit({ code: "gateway-restart-limit", reason });
      return;
    }
    const delay = RESTART_DELAYS[Math.min(failures.length - 1, RESTART_DELAYS.length - 1)];
    onStatus({ type: "restarting", delay, reason, generation });
    restartTimer = setTimer(() => {
      restartTimer = null;
      spawn();
    }, delay);
    restartTimer?.unref?.();
  }

  function start(input) {
    if (!isHostMessage(input) || input.type !== "configure" || input.serverInstance !== serverInstance) {
      return Promise.reject(new TypeError("invalid RPC host configuration"));
    }
    if (active) return readyPromise || Promise.resolve(listening && { ...listening });
    active = true;
    failures = [];
    configuration = structuredClone(input);
    readyPromise = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    spawn();
    return readyPromise;
  }

  function stop() {
    const wasActive = active || !!childRecord || !!restartTimer;
    active = false;
    if (restartTimer) clearTimer(restartTimer);
    restartTimer = null;
    settleReady(new Error("gateway-stopped"));
    const record = childRecord;
    const stopped = kill(record);
    if (stopped && childRecord === record) {
      childRecord = null;
      child = null;
      queue = null;
    }
    listening = null;
    clearConnections("gateway-stopped");
    onStatus({ type: "stopped", generation });
    return !wasActive || stopped;
  }

  return {
    start,
    stop,
    closeConnection,
    status: () => ({ active, generation, listening: listening && { ...listening }, connections: connections.size,
      restartScheduled: !!restartTimer, failures: failures.length, queue: queue?.status() || null, child: !!child }),
  };
}
