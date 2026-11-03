import { randomBytes, timingSafeEqual } from "node:crypto";
import { privatePath } from "./windows-private.cjs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { projectRequest } from "./projection.js";

import stateHomeModule from "../state-home.cjs";

const { stateHome } = stateHomeModule;
const MAX_LINE = 64 * 1024;
const MAX_CONNECTIONS = 64;
const REQUEST_TTL = 590_000;

function exactKeys(value, required) {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === required.length
    && required.every((key) => Object.hasOwn(value, key));
}

function allowedKeys(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function bounded(value, maximum, allowEmpty = false) {
  return typeof value === "string" && value.length <= maximum && (allowEmpty || value.length > 0);
}

export function validQuestions(questions) {
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 4) return false;
  if (Buffer.byteLength(JSON.stringify(questions)) > 16 * 1024) return false;
  const texts = new Set();
  for (const question of questions) {
    if (!allowedKeys(question, ["question", "header", "options"], ["multiSelect"])
      || !bounded(question.question, 8_192) || !bounded(question.header, 1_024)
      || (question.multiSelect !== undefined && typeof question.multiSelect !== "boolean")
      || !Array.isArray(question.options) || question.options.length === 0) return false;
    if (texts.has(question.question)) return false;
    texts.add(question.question);
    const labels = new Set();
    for (const option of question.options) {
      // 터미널 전용 preview 제외
      if (!allowedKeys(option, ["label"], ["description", "preview"])
        || !bounded(option.label, 2_000)
        || (option.description !== undefined && !bounded(option.description, 8_192, true))
        || (option.preview !== undefined && !bounded(option.preview, 8_192, true))
        || labels.has(option.label) || (question.multiSelect && option.label.includes(", "))) return false;
      labels.add(option.label);
    }
  }
  return true;
}

const clean = text => text.replace(/[\x00-\x1f\x7f-\x9f]/g, "");

function normalizedQuestions(questions) {
  return questions.map((question) => ({
    question: clean(question.question),
    header: clean(question.header),
    multiSelect: question.multiSelect === true,
    options: question.options.map((option) => ({ label: clean(option.label), description: clean(option.description || "") })),
  }));
}

function validHello(value) {
  return exactKeys(value, ["role", "v", "paneId", "cliSession"])
    && (value.role === "channel" || value.role === "question-hook") && value.v === 1
    && bounded(value.paneId, 256) && bounded(value.cliSession, 256);
}

function activeSocket(socket) {
  return socket && !socket.destroyed && socket.writable;
}

function writeLine(socket, value) {
  if (!activeSocket(socket)) return Promise.resolve(false);
  return new Promise((resolve) => {
    try { socket.write(`${JSON.stringify(value)}\n`, (error) => resolve(!error && activeSocket(socket))); }
    catch { resolve(false); }
  });
}

function probeSocket(socketPath, timeout = 250) {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (connected) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(connected);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    const timer = setTimeout(() => finish(false), timeout);
    timer.unref?.();
  });
}

async function removeStaleSocket(socketPath) {
  if (await probeSocket(socketPath)) throw Object.assign(new Error("agent socket already active"), { code: "EADDRINUSE" });
  let stat;
  try { stat = await fsp.lstat(socketPath); }
  catch (cause) { if (cause?.code === "ENOENT") return; throw cause; }
  const uid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
  if (stat.isSymbolicLink() || !stat.isSocket() || stat.uid !== uid) {
    throw Object.assign(new Error("unsafe stale agent socket"), { code: "EACCES" });
  }
  await fsp.unlink(socketPath);
}

export function createAgentSocketServer(options = {}) {
  const socketPath = options.socketPath || path.join(stateHome(), "remote", "agent.sock");
  const windows = process.platform === "win32";
  let endpointToken = null;
  const agents = options.agents;
  const requests = options.requests;
  const isRemoteEnabled = options.isRemoteEnabled || (() => false);
  const hasRegisteredDevices = options.hasRegisteredDevices || (() => false);
  const log = options.log || console.log;
  const terminalTtl = 24 * 60 * 60 * 1000;
  const terminalQuestions = new Map();
  // 승인 화면의 도구 이름·대상(PermissionRequest 훅), 창이 이어지는 동안만 유지
  const permissionHints = new Map();
  const questionSubscribers = new Set();
  const now = options.now || Date.now;
  const requestTtl = options.requestTtl ?? REQUEST_TTL;
  const connectionLimit = options.connectionLimit ?? MAX_CONNECTIONS;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const onChannelsChanged = options.onChannelsChanged || (() => {});
  const connections = new Set();
  const channelsByPane = new Map();
  let server = null;
  let stopPromise = null;
  let messageSequence = 0;

  function questionChanged() {
    for (const subscriber of questionSubscribers) { try { subscriber(); } catch {} }
  }

  function removeTerminal(paneId, reason = "replaced") {
    const stored = terminalQuestions.get(paneId);
    if (!stored) return;
    clearTimer(stored.timer);
    if (stored.transitionTimer) clearTimer(stored.transitionTimer);
    terminalQuestions.delete(paneId);
    log(`[remote] question reason=${reason}`);
    questionChanged();
  }

  function reconcileQuestions() {
    for (const [paneId, stored] of terminalQuestions) {
      const agent = agents.resolvePane(paneId);
      // herdr 상태가 대기가 아니어도, 화면에서 질문이 최근 확인됐으면 대기 중
      const waiting = agent?.source.question || agent?.status === "blocked" || stored.verifiedAt && now() - stored.verifiedAt < 5_000;
      if (!agent || agent.ref !== stored.agent || agent.source.sessionUuid && agent.source.sessionUuid !== stored.cliSession
        || now() >= stored.expiresAt || (!waiting && (stored.seenWaiting || now() - stored.createdAt >= 20_000))) {
        removeTerminal(paneId, !agent || agent.ref !== stored.agent || agent.source.sessionUuid && agent.source.sessionUuid !== stored.cliSession
          ? "session-ended" : now() >= stored.expiresAt ? "expired" : "computer-answered");
      } else if (waiting) stored.seenWaiting = true;
    }
  }

  function reconcileHints() {
    for (const [paneId, hint] of permissionHints) {
      const agent = agents.resolvePane(paneId);
      const waiting = agent?.source.question || agent?.status === "blocked";
      if (!agent || agent.ref !== hint.agent || agent.source.sessionUuid && agent.source.sessionUuid !== hint.cliSession
        || now() >= hint.expiresAt || (!waiting && (hint.seenWaiting || now() - hint.createdAt >= 20_000))) permissionHints.delete(paneId);
      else if (waiting) hint.seenWaiting = true;
    }
  }

  function retainHint(record, value) {
    const agent = agents.resolvePane(record.paneId);
    if (!isRemoteEnabled() || !agent || agent.ref !== record.agentRef
      || agent.source.sessionUuid && agent.source.sessionUuid !== record.cliSession) return;
    permissionHints.delete(record.paneId);
    permissionHints.set(record.paneId, { agent: agent.ref, cliSession: record.cliSession, tool: clean(value.tool),
      target: clean(value.target), createdAt: now(), expiresAt: now() + 10 * 60 * 1000,
      seenWaiting: !!(agent.source.question || agent.status === "blocked") });
    while (permissionHints.size > 32) permissionHints.delete(permissionHints.keys().next().value);
  }

  agents?.subscribe?.(() => { reconcileQuestions(); reconcileHints(); });

  function retainQuestion(record) {
    const agent = agents.resolvePane(record.paneId);
    if (!record.questions || !agent || agent.ref !== record.agentRef
      || agent.source.sessionUuid && agent.source.sessionUuid !== record.cliSession) return;
    removeTerminal(record.paneId);
    const stored = { ref: record.questionRef, agent: agent.ref, kind: "claude-question",
      createdAt: now(), expiresAt: now() + terminalTtl, body: { questions: record.questions },
      cliSession: record.cliSession, seenWaiting: !!(agent.source.question || agent.status === "blocked"), timer: null };
    projectRequest(stored);
    terminalQuestions.set(record.paneId, stored);
    stored.timer = setTimer(() => removeTerminal(record.paneId, "expired"), terminalTtl);
    stored.timer?.unref?.();
    stored.transitionTimer = setTimer(reconcileQuestions, 20_000);
    stored.transitionTimer?.unref?.();
    while (terminalQuestions.size > 32 || Buffer.byteLength(JSON.stringify([...terminalQuestions.values()].map(projectRequest))) > 32 * 1024) {
      removeTerminal(terminalQuestions.keys().next().value);
    }
    questionChanged();
  }

  function forgetChannel(record) {
    if (record.role !== "channel" || !record.paneId) return;
    const entries = channelsByPane.get(record.paneId);
    entries?.delete(record);
    if (entries?.size === 0) channelsByPane.delete(record.paneId);
    try { onChannelsChanged(); } catch {}
  }

  function cancelRecord(record) {
    if (record.requestRef) requests.cancel(record.requestRef);
    record.requestRef = null;
  }

  function closeRecord(record) {
    if (record.closed) return;
    record.closed = true;
    if (record.helloTimer) clearTimer(record.helloTimer);
    cancelRecord(record);
    forgetChannel(record);
    for (const pending of record.pendingMessages.values()) {
      clearTimer(pending.timer);
      pending.resolve("failed");
    }
    record.pendingMessages.clear();
    connections.delete(record);
  }

  function channelForPane(paneId) {
    const entries = channelsByPane.get(paneId);
    if (!entries) return null;
    return [...entries].reverse().find((entry) => !entry.closed && activeSocket(entry.socket)) || null;
  }

  async function permissionRequest(record, value) {
    if (!exactKeys(value, ["type", "requestId", "seq", "tool", "description", "input"])
      || ![value.requestId, value.tool].every((field) => bounded(field, 256))
      || !Number.isSafeInteger(value.seq) || value.seq < 1
      || !bounded(value.description, 8_192, true) || !bounded(value.input, 16_384, true)
      || !isRemoteEnabled()) return;
    cancelRecord(record);
    const token = { requestId: value.requestId, seq: value.seq };
    record.latestPermission = token;
    const projected = requests.add({ paneId: record.paneId, kind: "claude-permission", createdAt: now(),
      expiresAt: now() + requestTtl,
      body: { tool: value.tool, description: value.description, input: value.input } }, async (answer) => {
      if (record.closed || record.latestPermission !== token) return "failed";
      const written = await writeLine(record.socket, { type: "permission_verdict", requestId: value.requestId,
        seq: value.seq, behavior: answer.behavior });
      if (written) record.latestPermission = null;
      return written ? "delivered" : "failed";
    }, () => {
      if (record.requestRef === projected.ref) {
        requests.cancel(projected.ref);
        record.requestRef = null;
        record.latestPermission = null;
      }
    });
    record.requestRef = projected.ref;
  }

  async function questionRequest(record, value) {
    const agent = agents.resolvePane(record.paneId);
    if (agent?.ref === record.agentRef
      && (!agent.source.sessionUuid || agent.source.sessionUuid === record.cliSession)) removeTerminal(record.paneId);
    const reason = !exactKeys(value, ["type", "questions"]) || !validQuestions(value.questions)
      || !agent || agent.ref !== record.agentRef || agent.source.sessionUuid && agent.source.sessionUuid !== record.cliSession
      ? "validation-rejected" : !isRemoteEnabled() ? "remote-disabled" : !hasRegisteredDevices() ? "no-device" : null;
    if (reason) {
      log(`[remote] question reason=${reason}`);
      await writeLine(record.socket, { type: "question.none" });
      return;
    }
    record.questions = normalizedQuestions(value.questions);
    if (!validQuestions(record.questions)) {
      log("[remote] question reason=validation-rejected");
      return;
    }
    record.questionRef = randomBytes(16).toString("hex");
    retainQuestion(record);
    record.questions = null;
    log("[remote] question reason=retained");
    await writeLine(record.socket, { type: "question.none" });
  }

  function messageWritten(record, value) {
    if (!exactKeys(value, ["type", "msgId"]) || !bounded(value.msgId, 128)) return;
    const pending = record.pendingMessages.get(value.msgId);
    if (!pending) return;
    record.pendingMessages.delete(value.msgId);
    clearTimer(pending.timer);
      pending.resolve("delivered");
  }

  function handleValue(record, value) {
    if (!record.role) {
      if (windows) {
        const supplied = typeof value?.token === "string" ? Buffer.from(value.token) : Buffer.alloc(0);
        const expected = Buffer.from(endpointToken || "");
        if (!expected.length || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return record.socket.destroy();
        value = { ...value }; delete value.token;
      }
      if (!validHello(value)) {
        if (value?.role === "question-hook") log("[remote] question reason=validation-rejected");
        return record.socket.destroy();
      }
      const agent = agents?.resolvePane?.(value.paneId);
      if (!agent || agent.kind !== "claude") {
        if (value.role === "question-hook") log("[remote] question reason=validation-rejected");
        return record.socket.destroy();
      }
      if (record.helloTimer) clearTimer(record.helloTimer);
      record.helloTimer = null;
      record.agentRef = agent.ref;
      record.role = value.role;
      record.paneId = value.paneId;
      record.cliSession = value.cliSession;
      if (record.role === "channel") {
        const entries = channelsByPane.get(record.paneId) || new Set();
        entries.add(record);
        channelsByPane.set(record.paneId, entries);
        try { onChannelsChanged(); } catch {}
      }
      void writeLine(record.socket, { type: "hello.ok", v: 1 });
      return;
    }
    if (record.role === "channel" && value?.type === "permission_request") void permissionRequest(record, value);
    else if (record.role === "channel" && value?.type === "message_written") messageWritten(record, value);
    else if (record.role === "question-hook" && value?.type === "question") void questionRequest(record, value);
    else if (record.role === "question-hook" && value?.type === "hint"
      && exactKeys(value, ["type", "tool", "target"]) && bounded(value.tool, 128) && bounded(value.target, 300, true)) retainHint(record, value);
  }

  function accept(socket) {
    if (connections.size >= connectionLimit) return socket.destroy();
    socket.setEncoding("utf8");
    const record = { socket, buffer: "", role: null, paneId: null, cliSession: null, closed: false,
      latestPermission: null, requestRef: null, pendingMessages: new Map() };
    if (windows) {
      record.helloTimer = setTimer(() => socket.destroy(), 2_000);
      record.helloTimer?.unref?.();
    }
    connections.add(record);
    socket.on("data", (chunk) => {
      record.buffer += chunk;
      if (Buffer.byteLength(record.buffer) > MAX_LINE) return socket.destroy();
      let newline;
      while ((newline = record.buffer.indexOf("\n")) >= 0) {
        const line = record.buffer.slice(0, newline); record.buffer = record.buffer.slice(newline + 1);
        if (!line) continue;
        let value;
        try { value = JSON.parse(line); } catch { return socket.destroy(); }
        handleValue(record, value);
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => closeRecord(record));
  }

  async function start() {
    if (server) return;
    await fsp.mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    if (windows) privatePath(path.dirname(socketPath));
    else {
      await fsp.chmod(path.dirname(socketPath), 0o700);
      await removeStaleSocket(socketPath);
    }
    if (windows) endpointToken = randomBytes(32).toString("hex");
    const next = net.createServer(accept);
    await new Promise((resolve, reject) => {
      const failed = (cause) => { next.off("listening", ready); reject(cause); };
      const ready = () => { next.off("error", failed); resolve(); };
      next.once("error", failed);
      next.once("listening", ready);
      next.listen(windows ? { host: "127.0.0.1", port: 0, exclusive: true } : socketPath);
    });
    server = next;
    if (windows) {
      try {
        const temporary = `${socketPath}.${process.pid}.tmp`;
        await fsp.writeFile(temporary, JSON.stringify({ port: next.address().port, token: endpointToken }), { flag: "wx" });
        privatePath(temporary);
        await fsp.rename(temporary, socketPath);
      } catch (cause) { await performStop(); throw cause; }
    } else await fsp.chmod(socketPath, 0o600);
  }

  async function performStop() {
    const current = server;
    server = null;
    const closed = current ? new Promise((resolve) => current.close(resolve)) : Promise.resolve();
    for (const record of [...connections]) {
      record.questions = null;
      closeRecord(record);
      record.socket.end();
      record.socket.destroy();
    }
    await closed;
    if (windows) {
      try {
        const saved = JSON.parse(await fsp.readFile(socketPath, "utf8"));
        if (saved.token === endpointToken) await fsp.unlink(socketPath);
      } catch (cause) { if (cause?.code !== "ENOENT") throw cause; }
      endpointToken = null;
      return;
    }
    try {
      const stat = await fsp.lstat(socketPath);
      const uid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
      if (stat.isSocket() && !stat.isSymbolicLink() && stat.uid === uid) await fsp.unlink(socketPath);
    } catch (cause) { if (cause?.code !== "ENOENT") throw cause; }
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopPromise = performStop().finally(() => { stopPromise = null; });
    return stopPromise;
  }

  function refreshAvailability() {
    if (!isRemoteEnabled() || !hasRegisteredDevices()) {
      for (const paneId of terminalQuestions.keys()) removeTerminal(paneId,
        !isRemoteEnabled() ? "remote-disabled" : "no-device");
    }
  }

  const questions = {
    list() { reconcileQuestions(); return [...terminalQuestions.values()].map(projectRequest); },
    // 프롬프트 저장소가 화면에서 이 질문을 방금 확인했음을 알림
    touch(agentRef) { for (const stored of terminalQuestions.values()) if (stored.agent === agentRef) { stored.verifiedAt = now(); stored.seenWaiting = true; } },
    hint(agentRef) {
      reconcileHints();
      for (const hint of permissionHints.values()) if (hint.agent === agentRef) return { tool: hint.tool, target: hint.target };
      return null;
    },
    dismiss(ref, reason) { for (const [paneId, stored] of terminalQuestions) if (stored.ref === ref) removeTerminal(paneId, reason); },
    subscribe(callback) { questionSubscribers.add(callback); return () => questionSubscribers.delete(callback); },
  };

  const channel = {
    canSend(source) { return !!channelForPane(source?.paneId); },
    async send(source, content) {
      const record = channelForPane(source?.paneId);
      if (!record) return "failed";
      const msgId = `${now().toString(36)}-${(++messageSequence).toString(36)}`;
      return new Promise(async (resolve) => {
        const timer = setTimer(() => {
          record.pendingMessages.delete(msgId);
          resolve("failed");
        }, 10_000);
        timer?.unref?.();
        record.pendingMessages.set(msgId, { resolve: (result) => resolve(result === "delivered" ? "sent" : result), timer });
        if (!await writeLine(record.socket, { type: "message", msgId, content })) {
          record.pendingMessages.delete(msgId);
          clearTimer(timer);
          resolve("failed");
        }
      });
    },
  };

  return { socketPath, start, stop, refreshAvailability, questions, channel, connectionCount: () => connections.size };
}
