import crypto from "node:crypto";

import { COMMAND_ROUTES, requiredFeatures, workerHandlerFor } from "./command-routes.js";
import { qaUnitCommand } from "./qa-route.js";
import { mainHasFeatures, runUnitHandler } from "./unit-runner.js";

// host 가 worker 에 맡길 수 있는 작업 이름 · host 의 legacyHostTask 허용 목록과 같음
const LEGACY_COMMANDS = new Set(["dialog", "redact", "qa-mode", "screenshot"]);

// 처리기가 있는 작업은 기본 명령 단위로, 없거나 메인이 단위를 모르면 host 의 legacyHostTask(옛 Electron 명령)로 보냄
// redact: 열린 확인 창 문구를 메인의 비밀 가리기에 한 번 거침 (옛 redact 는 탭 대기열 밖이고 CDP 를 붙이지 않음)
const HOST_HANDLERS = Object.freeze({
  async redact({ args, base }) {
    const { raw, response } = await base("result.redact", { value: { ok: true, text: String(args.text == null ? "" : args.text) } }, { last: true });
    if (raw?.commandState !== "completed" || !response.ok || !response.data || !("value" in response.data)) return response;
    return { ok: true, data: response.data.value };
  },
});

function normalizeHostTask(task) {
  if (!task || task.type !== "legacyRelay" || !task.target || !task.relay) {
    throw Object.assign(new Error("host 작업 형식이 올바르지 않습니다."), { code: "INVALID_REQUEST" });
  }
  const command = String(task.relay.command || "");
  if (!LEGACY_COMMANDS.has(command)) {
    throw Object.assign(new Error(`지원하지 않는 legacy host 작업입니다: ${command}`), { code: "INVALID_REQUEST" });
  }
  return {
    tabId: task.target.tabId,
    target: structuredClone(task.target),
    relay: { command, args: structuredClone(task.relay.args || {}), timeoutMs: task.relay.timeoutMs },
  };
}

export function createWorkerHostTaskService({ hostApi, routes = COMMAND_ROUTES } = {}) {
  if (!hostApi?.call || !hostApi?.withCommand) throw new Error("host 작업용 host API가 필요합니다.");
  // screenshot 은 일반 MCP 의 screenshot 처리기(page-route.js)를 씀 · 옛 host 작업도 같은 처리기를 탭 대기열 안에서 실행했음
  const handlerFor = (command) => (
    HOST_HANDLERS[command] && routes[command] === "worker" ? HOST_HANDLERS[command] : workerHandlerFor(command, routes));

  // 기본 명령 단위 · 확인 창을 푸는 단위(outside)는 탭 잠금 밖이라 host 연산이 쥔 잠금과 겹치지 않음
  // 하위 호출의 commandId 는 새 값 (같은 commandId·callId·입력이면 host 가 앞 결과를 돌려주는 중복 방지에 걸림)
  function runHostUnit(handler, input, { identity, commandId }) {
    const { command, args, timeoutMs } = input.relay;
    // qa-mode 와 screenshot 은 탭 대기열 안 (옛 host 작업의 requestCdp 도 cdpQueues 에 섰음) · 나머지는 확인 창을 푸는 단위라 밖
    const outside = !["qa-mode", "screenshot"].includes(command);
    const unitId = `${commandId}/host/${crypto.randomUUID()}`;
    const fields = { controlLabel: identity.run ? "iris-qa" : identity.session, ...(identity.lifecycle === true ? { lifecycle: true } : {}) };
    return hostApi.withCommand({ identity, commandId: unitId }, () => runUnitHandler({
      handler, command: qaUnitCommand(command, args), args, token: input.target.targetToken, outside,
      refreshToken: async () => (await hostApi.call("browser.resolveForCommand", { tabId: input.tabId },
        { activityKind: "relayCommands", allowDuringDrain: true }))?.targetToken,
      relayCall: (relayCommand, relayArgs, unit, token = input.target.targetToken) => hostApi.call("browser.executeWithDialog", {
        tabId: input.tabId, targetToken: token, ...fields,
        relay: { command: relayCommand, args: relayArgs, timeoutMs: timeoutMs || 30000, ...(unit ? { unit } : {}) },
      }, { activityKind: "relayCommands", allowDuringDrain: true }),
      context: { onRelayEvent: listener => hostApi.onRelayEvent?.(listener) },
    }));
  }

  return {
    async dispatch({ task, identity = {}, commandId, callId } = {}) {
      const input = normalizeHostTask(task);
      const handler = handlerFor(input.relay.command);
      const status = (operation, body) => hostApi.withCommand({ identity, commandId }, () => hostApi.call(operation, body));
      if (handler && await mainHasFeatures(status, requiredFeatures(input.relay.command))) {
        return runHostUnit(handler, input, { identity, commandId });
      }
      return hostApi.withCommand({ identity, commandId }, () => hostApi.call("browser.legacyHostTask", input, {
        identity,
        commandId,
        callId,
        activityKind: "relayCommands",
        allowDuringDrain: true,
      }));
    },
  };
}
