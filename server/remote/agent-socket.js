import { randomBytes, timingSafeEqual } from "node:crypto";
import { privatePath } from "./windows-private.cjs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";

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
      if (!allowedKeys(option, ["label"], ["description"])
        || !bounded(option.label, 2_000)
        || (option.description !== undefined && !bounded(option.description, 8_192, true))
        || labels.has(option.label) || (question.multiSelect && option.label.includes(", "))) return false;
      labels.add(option.label);
    }
  }
  return true;
}

function normalizedQuestions(questions) {
  return questions.map((question) => ({
    question: question.question,
    header: question.header,
    multiSelect: question.multiSelect === true,
    options: question.options.map((option) => ({ label: option.label, description: option.description || "" })),
  }));
}

export function shouldWaitForQuestion(questions, remoteEnabled, registeredDeviceCount) {
  return validQuestions(questions) && remoteEnabled === true
    && Number.isSafeInteger(registeredDeviceCount) && registeredDeviceCount > 0;
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
    if (record.questionTimer) clearTimer(record.questionTimer);
    record.questionTimer = null;
  }

  function closeRecord(record, notifyQuestion = false) {
    if (record.closed) return;
    record.closed = true;
    if (record.helloTimer) clearTimer(record.helloTimer);
    if (notifyQuestion && record.role === "question-hook" && record.requestRef) {
      void writeLine(record.socket, { type: "question.none" });
    }
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
    if (!exactKeys(value, ["type", "questions"])
      || !shouldWaitForQuestion(value.questions, isRemoteEnabled(), hasRegisteredDevices() ? 1 : 0)) {
      await writeLine(record.socket, { type: "question.none" });
      return;
    }
    cancelRecord(record);
    const projected = requests.add({ paneId: record.paneId, kind: "claude-question", createdAt: now(),
      expiresAt: now() + requestTtl, body: { questions: normalizedQuestions(value.questions) } }, async (answer) => {
      if (record.closed || record.requestRef !== projected.ref) return "failed";
      if (record.questionTimer) clearTimer(record.questionTimer);
      record.questionTimer = null;
      record.requestRef = null;
      return await writeLine(record.socket, { type: "question.answer", answers: answer.answers })
        ? "delivered" : "failed";
    }, () => {
      if (!record.closed && record.requestRef === projected.ref) {
        requests.cancel(projected.ref);
        record.requestRef = null;
        void writeLine(record.socket, { type: "question.none" });
      }
    });
    record.requestRef = projected.ref;
    record.questionTimer = setTimer(() => {
      if (record.requestRef !== projected.ref) return;
      requests.cancel(projected.ref);
      record.requestRef = null;
      record.questionTimer = null;
      void writeLine(record.socket, { type: "question.none" });
    }, requestTtl);
    record.questionTimer?.unref?.();
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
      if (!validHello(value)) return record.socket.destroy();
      const agent = agents?.resolvePane?.(value.paneId);
      if (!agent || agent.kind !== "claude") return record.socket.destroy();
      if (record.helloTimer) clearTimer(record.helloTimer);
      record.helloTimer = null;
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
  }

  function accept(socket) {
    if (connections.size >= connectionLimit) return socket.destroy();
    socket.setEncoding("utf8");
    const record = { socket, buffer: "", role: null, paneId: null, cliSession: null, closed: false,
      latestPermission: null, requestRef: null, questionTimer: null, pendingMessages: new Map() };
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
      if (record.role === "question-hook" && record.requestRef) {
        await writeLine(record.socket, { type: "question.none" });
      }
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
    if (isRemoteEnabled() && hasRegisteredDevices()) return;
    for (const record of [...connections]) {
      if (record.role !== "question-hook" || !record.requestRef) continue;
      const requestRef = record.requestRef;
      record.requestRef = null;
      requests.cancel(requestRef);
      if (record.questionTimer) clearTimer(record.questionTimer);
      record.questionTimer = null;
      void writeLine(record.socket, { type: "question.none" });
    }
  }

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

  return { socketPath, start, stop, refreshAvailability, channel, connectionCount: () => connections.size };
}
