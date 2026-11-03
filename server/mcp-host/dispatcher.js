import crypto from "node:crypto";

import { HostApiError, hostError, hostErrorShape } from "./errors.js";
import { HOST_OPERATION_DEFINITIONS } from "./operations.js";
import { createKeyedSerialExecutor } from "./serial.js";

const MAX_COMMAND_RESULTS = 2000;

function canonical(value) {
  if (value == null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object") throw hostError("INVALID_REQUEST", "IPC 요청에는 JSON 값만 넣을 수 있습니다.");
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function fingerprint(request) {
  const body = canonical({ operation: request.operation,
    identity: { session: request.identity?.session, run: request.identity?.run }, input: request.input || {} });
  return crypto.createHash("sha256").update(body).digest("hex");
}

function validateMessage(message, workerGeneration) {
  if (!message || typeof message !== "object" || Array.isArray(message)
      || message.protocol !== 1 || message.type !== "host.request") {
    throw hostError("INVALID_REQUEST", "host API 요청 형식이 올바르지 않습니다.");
  }
  if (typeof message.requestId !== "string" || !message.requestId || message.requestId.length > 200) {
    throw hostError("INVALID_REQUEST", "requestId가 필요합니다.");
  }
  if (message.workerGeneration !== workerGeneration) {
    throw hostError("STALE_WORKER", "현재 작업 프로세스 세대가 아닙니다.");
  }
  const definition = HOST_OPERATION_DEFINITIONS[message.operation];
  if (!definition) throw hostError("INVALID_REQUEST", `지원하지 않는 host API 연산입니다: ${String(message.operation)}`);
  if (definition.mutates && (typeof message.commandId !== "string" || !message.commandId)) {
    throw hostError("INVALID_REQUEST", "부수효과가 있는 host API 요청에는 commandId가 필요합니다.");
  }
  if (definition.mutates && !((typeof message.callId === "string" && message.callId)
      || (Number.isSafeInteger(message.callId) && message.callId >= 0))) {
    throw hostError("INVALID_REQUEST", "부수효과가 있는 host API 요청에는 하위 호출 번호가 필요합니다.");
  }
  if (message.identity != null && (typeof message.identity !== "object" || Array.isArray(message.identity))) {
    throw hostError("INVALID_REQUEST", "identity 형식이 올바르지 않습니다.");
  }
  if (message.identity?.lifecycle === true
      && !String(message.commandId || "").startsWith(`${workerGeneration}/lifecycle/${message.identity.run}/`)) {
    throw hostError("INVALID_REQUEST", "lifecycle commandId가 worker 세대와 QA 회차에 속하지 않습니다.");
  }
  if (message.input != null && (typeof message.input !== "object" || Array.isArray(message.input))) {
    throw hostError("INVALID_REQUEST", "input 형식이 올바르지 않습니다.");
  }
  return definition;
}

export function createMcpHostExecutionCoordinator({ serial = createKeyedSerialExecutor() } = {}) {
  const active = new Map();
  const waiters = new Map();
  const retired = new Set();
  const retiredCleanup = new Map();
  const cleanup = workerGeneration => {
    const invoke = retiredCleanup.get(workerGeneration);
    if (typeof invoke !== "function") return;
    try { invoke(); } catch {}
  };
  const finish = workerGeneration => {
    const next = (active.get(workerGeneration) || 1) - 1;
    if (next > 0) active.set(workerGeneration, next);
    else {
      active.delete(workerGeneration);
      for (const resolve of waiters.get(workerGeneration) || []) resolve();
      waiters.delete(workerGeneration);
    }
    if (retired.has(workerGeneration)) cleanup(workerGeneration);
  };
  return {
    serial,
    async run(workerGeneration, locks, invoke) {
      active.set(workerGeneration, (active.get(workerGeneration) || 0) + 1);
      try {
        return await serial.run(locks, () => {
          if (retired.has(workerGeneration)) throw hostError("STALE_WORKER", "종료된 작업 프로세스 세대입니다.");
          return invoke();
        });
      }
      finally { finish(workerGeneration); }
    },
    runUnlocked(invoke) { return serial.runUnlocked(invoke); },
    retireGeneration(workerGeneration, onLateCompletion) {
      retired.add(workerGeneration);
      if (typeof onLateCompletion === "function") retiredCleanup.set(workerGeneration, onLateCompletion);
      cleanup(workerGeneration);
    },
    waitForGeneration(workerGeneration) {
      if (!active.has(workerGeneration)) return Promise.resolve();
      return new Promise(resolve => {
        const list = waiters.get(workerGeneration) || [];
        list.push(resolve);
        waiters.set(workerGeneration, list);
      });
    },
    activeFor(workerGeneration) { return active.get(workerGeneration) || 0; },
  };
}

export function createMcpHostDispatcher({
  workerGeneration,
  identityAuthority,
  handlers,
  authorizeWorker = () => true,
  serial = createKeyedSerialExecutor(),
  execution = null,
}) {
  if (typeof workerGeneration !== "string" || !workerGeneration) throw new Error("workerGeneration 필요");
  if (!identityAuthority || typeof identityAuthority.authorize !== "function") throw new Error("identityAuthority 필요");
  const commands = new Map();
  const coordinator = execution || createMcpHostExecutionCoordinator({ serial });

  const response = (request, result) => ({ protocol: 1, type: "host.response",
    requestId: request?.requestId, workerGeneration, ...result });

  function remember(key, entry) {
    commands.set(key, entry);
    while (commands.size > MAX_COMMAND_RESULTS) {
      const completed = [...commands].find(([, value]) => value.state === "completed");
      if (!completed) break;
      commands.delete(completed[0]);
    }
  }

  async function dispatch(message, connection) {
    let definition;
    try {
      if (!authorizeWorker(connection, message)) throw hostError("UNAUTHORIZED_WORKER", "허용된 작업 프로세스가 아닙니다.");
      definition = validateMessage(message, workerGeneration);
    } catch (error) {
      return response(message, { ok: false, error: hostErrorShape(error) });
    }

    let commandKey = null;
    const identity = message.identity || {};
    const input = message.input || {};
    const requirements = typeof definition.identity === "function"
      ? definition.identity(identity, input) : definition.identity;
    try {
      identityAuthority.authorize(identity, requirements, { commandId: message.commandId });
    } catch (error) {
      return response(message, { ok: false, error: hostErrorShape(error) });
    }
    if (definition.mutates) {
      try { commandKey = `${message.commandId}:${message.callId}:${fingerprint(message)}`; }
      catch (error) { return response(message, { ok: false, error: hostErrorShape(error) }); }
      const previous = commands.get(commandKey);
      if (previous?.state === "running") {
        return response(message, { ok: false, error: hostErrorShape(hostError("BUSY", "같은 명령이 실행 중입니다.", {
          retryable: true, details: { commandId: message.commandId },
        })) });
      }
      if (previous?.state === "completed") return response(message, previous.result);
      remember(commandKey, { state: "running", result: null });
    }

    let result;
    try {
      const locks = definition.locks({ identity, input, request: message });
      const output = await coordinator.run(workerGeneration, locks, async () => {
        const authorizedIdentity = identityAuthority.authorize(identity, requirements, { commandId: message.commandId });
        const handler = handlers[message.operation];
        if (typeof handler !== "function") throw hostError("INTERNAL", "host API 연산이 연결되지 않았습니다.");
        return handler({ identity: authorizedIdentity, input, request: message, locks });
      });
      result = { ok: true, output: output === undefined ? null : output };
    } catch (error) {
      result = { ok: false, error: hostErrorShape(error instanceof HostApiError ? error : error) };
    }
    if (commandKey) remember(commandKey, { state: "completed", result });
    return response(message, result);
  }

  function commandStatus(commandId, callId) {
    const prefix = callId == null ? `${commandId}:` : `${commandId}:${callId}:`;
    return [...commands.entries()].filter(([key]) => key.startsWith(prefix))
      .map(([, entry]) => ({ state: entry.state, ok: entry.result?.ok,
        result: entry.result == null ? null : structuredClone(entry.result) }));
  }

  return { dispatch, commandStatus, serial: coordinator.serial,
    retire: onLateCompletion => coordinator.retireGeneration(workerGeneration, onLateCompletion),
    waitForIdle: () => coordinator.waitForGeneration(workerGeneration) };
}
