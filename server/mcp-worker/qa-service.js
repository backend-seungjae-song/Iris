import crypto from "node:crypto";

import { createQaChannel } from "../qa-channel.js";
import { createQaLedger } from "../qa-ledger.js";
import { createQaMobile } from "../qa-mobile.js";
import { COMMAND_ROUTES, requiredFeatures, workerHandlerFor } from "./command-routes.js";
import { QA_OBSERVE_COMMAND_NAMES, reactionCapture } from "./qa-observe-route.js";
import { createQaReactionCommands } from "./qa-reaction-commands.js";
import { QA_COMMAND_NAMES, qaUnitCommand } from "./qa-route.js";
import { commandResponse, mainHasFeatures, runUnitHandler } from "./unit-runner.js";

const requireOk = result => {
  if (!result || result.ok === false) throw new Error(result?.error || "실행기 응답 오류");
  return result;
};

// QA 채널이 보내는 일반 명령 이름 · 일반 MCP 와 같은 worker 처리기를 QA 표시(iris-qa)로 실행
export const QA_GENERIC_NAMES = Object.freeze(["goto", "url", "snapshot", "text", "diff", "wait", "back", "forward", "reload"]);

// QA 명령 실행 · 이름이 QA 표나 일반 이름 목록에 있고 worker 경로이며 메인이 그 명령의 기능을 알릴 때만 worker 처리기, 아니면 옛 봉투
// reactionClock: 시험용 시계(now · sleep)
export function createQaExecutor({ hostApi, routes = COMMAND_ROUTES, reactionClock } = {}) {
  const call = (operation, input, options) => hostApi.call(operation, input, options);
  // 반응 관찰 상태는 worker 에 두고 명령 단위를 넘어 유지 (start → end · 종료는 qa-mode 해제 때)
  const reactions = createQaReactionCommands(reactionClock);
  const qaHandlerFor = name => (QA_COMMAND_NAMES.includes(name) || QA_OBSERVE_COMMAND_NAMES.includes(name) || QA_GENERIC_NAMES.includes(name) ? workerHandlerFor(name, routes) : null);
  const unitsReady = (...names) => names.some(name => qaHandlerFor(name))
    ? mainHasFeatures(call, requiredFeatures("qa-mode")) : false;
  // 단위마다 새 commandId · 같은 commandId 로 이어 보내면 앞 단위가 닫힌 뒤의 자원 반환(releaseCommand)이 뒤 단위가 얻은 표식까지 거둠
  const runQaUnit = (handler, name, args, tab, target, fields, timeoutMs) => {
    const current = hostApi.current();
    const unitId = `${current.commandId}/unit/${crypto.randomUUID()}`;
    const relayFor = (targetToken) => (relayCommand, relayArgs, unit, token = targetToken) => call("browser.executeWithDialog", {
      tabId: tab, targetToken: token, controlLabel: "iris-qa", ...fields,
      relay: { command: relayCommand, args: relayArgs, timeoutMs, ...(unit ? { unit } : {}) },
    });
    // 명령 도중 세대가 바뀌면 현재 token 을 다시 받음 · 소유 조건은 장면 촬영과 같음
    const refreshToken = async () => (await call("browser.resolveForCommand", { tabId: tab,
      requireQaOwner: fields.lifecycle !== true, lifecycle: fields.lifecycle === true }))?.targetToken;
    // 반응 장면 촬영 · 이벤트가 오는 때에는 열린 단위가 없을 수 있어 새 commandId 의 대기열 밖 단위로 실행 (옛 경로는 대기열 밖에서 바로 촬영)
    // 명령이 끝난 뒤의 token 은 낡았을 수 있어 호스트에서 현재 대상을 다시 받음
    const spawnCapture = captureArgs => {
      const captureId = `${current.commandId}/unit/${crypto.randomUUID()}`;
      return hostApi.withCommand({ ...current, commandId: captureId }, async () => {
        const fresh = await call("browser.resolveForCommand", { tabId: tab, requireQaOwner: fields.lifecycle !== true, lifecycle: fields.lifecycle === true });
        return runUnitHandler({ handler: reactionCapture, command: "qa-screenshot", args: captureArgs, token: fresh.targetToken,
          outside: true, relayCall: relayFor(fresh.targetToken), refreshToken });
      });
    };
    return hostApi.withCommand({ ...current, commandId: unitId }, () => runUnitHandler({
      handler, command: qaUnitCommand(name, args), args, token: target.targetToken,
      relayCall: relayFor(target.targetToken),
      refreshToken,
      context: { onRelayEvent: listener => hostApi.onRelayEvent?.(listener), mainHasFeatures: features => mainHasFeatures(call, features), reactions, tab, spawnCapture },
    }));
  };
  return {
    // 회차 종료의 QA 모드 해제 · 확인 창이 떠 있어도 통과해야 함 (host 가 단위 이름 qa-mode-off 로 알아봄)
    async modeOff(tab) {
      const target = await call("browser.resolveForCommand", { tabId: tab, requireQaOwner: true });
      if (await unitsReady("qa-mode")) return runQaUnit(qaHandlerFor("qa-mode"), "qa-mode", { enabled: false }, tab, target, {}, 10000);
      return call("browser.executeWithDialog", { tabId: tab, targetToken: target.targetToken,
        controlLabel: "iris-qa", relay: { command: "qa-mode", args: { enabled: false }, timeoutMs: 10000 } });
    },
    async execute(tab, command, args) {
      const currentIdentity = hostApi.current().identity || {};
      const lifecycle = Boolean(currentIdentity.run && !currentIdentity.key);
      const target = await call("browser.resolveForCommand", { tabId: tab, requireQaOwner: !lifecycle, lifecycle });
      if (command === "qa-dialog-state") {
        return commandResponse(await call("browser.dialogState", { tabId: tab, targetToken: target.targetToken,
          controlLabel: "iris-qa", requireQaOwner: true, lifecycle },
          { allowDuringDrain: true }));
      }
      if (command === "qa-dialog-answer") {
        return commandResponse(await call("browser.dialogAnswer", { tabId: tab, targetToken: target.targetToken,
          controlLabel: "iris-qa", answerTool: "qa_dialog", qa: true, lifecycle, ...args }, { allowDuringDrain: true }));
      }
      const fields = { answerTool: "qa_dialog", lifecycle };
      const relayName = ({ screenshot: "qa-screenshot", observe: "qa-observe", viewport: "qa-viewport" })[command] || command;
      const viaUnits = await unitsReady("qa-mode", relayName);
      // 확인·캡처·관찰·반응 명령과 일반 이름은 그 명령의 기능 알림(worker-qa-observe-commands · worker-page-commands 등)이 더 있어야 worker 처리기를 씀
      const observeReady = !(QA_OBSERVE_COMMAND_NAMES.includes(relayName) || QA_GENERIC_NAMES.includes(relayName))
        || await mainHasFeatures(call, requiredFeatures(relayName));
      const mode = viaUnits && qaHandlerFor("qa-mode")
        ? await runQaUnit(qaHandlerFor("qa-mode"), "qa-mode", { enabled: true }, tab, target, fields, 10000)
        : await call("browser.executeWithDialog", { tabId: tab, targetToken: target.targetToken,
          controlLabel: "iris-qa", answerTool: "qa_dialog", lifecycle,
          relay: { command: "qa-mode", args: { enabled: true }, timeoutMs: 10000 } });
      if (mode?.ok === false) return commandResponse(mode);
      requireOk(mode);
      if (viaUnits && observeReady && qaHandlerFor(relayName)) {
        return commandResponse(await runQaUnit(qaHandlerFor(relayName), relayName, args, tab, target, fields, 30000));
      }
      const relay = { command: relayName, args, timeoutMs: 30000 };
      return commandResponse(await call("browser.executeWithDialog", { tabId: tab, targetToken: target.targetToken,
        controlLabel: "iris-qa", answerTool: "qa_dialog", lifecycle, relay }));
    },
  };
}

export function createWorkerQaService({ hostApi, activity, ledgerDir, workerGeneration, routes = COMMAND_ROUTES } = {}) {
  if (!hostApi || typeof hostApi.call !== "function") throw new Error("QA worker host API가 필요합니다.");
  const ledger = createQaLedger({ dir: ledgerDir, activity, anchor: request => hostApi.call("qa.anchorUpdate", request) });
  const call = (operation, input, options) => hostApi.call(operation, input, options);
  const executor = createQaExecutor({ hostApi, routes });
  const mobileFactory = (runId, onClaim) => createQaMobile({
    activity,
    listDevices: session => call("app.command", { command: "list", session, qa: true }),
    openDevice: (session, args) => call("app.command", { command: "open", session, args, qa: true }),
    readPicks: session => call("browser.pickList", { kind: "app", session }),
    readTargets: async () => (await call("app.targetsAll", {})).assignments || {},
    setTargets: (session, devices) => call("app.targetsSet", { session, devices, exclusive: false, release: false }),
    authorize: async (session, device) => {
      const output = await call("qa.deviceAuthorize", { session, run: runId, device: device.targetId });
      onClaim(device.targetId);
      return output;
    },
  });
  const grants = {
    approve: (args, session) => call("lease.grant", { session, ...args }),
    renew: (args, session) => call("lease.check", { session, renew: true, ...args }),
    end: (args, session) => call("lease.revoke", { session, ...args }),
    forRun: (session, repo, charter) => call("lease.check", { session, repo, charter, forRun: true }),
    active: async session => Boolean((await call("lease.check", { session, active: true }))?.active),
  };
  const ask = async (tab, session, message, options = {}, limits) => {
    const approve = options?._kind === "approve";
    const text = String(approve ? options.summary || message || "" : message || "").trim().slice(0, 300);
    if (!text) return { ok: false, error: approve ? "summary를 적어 주세요." : "reason을 적어 주세요." };
    const choices = approve
      ? [String(options.approve_label || "승인"), String(options.deny_label || "취소")]
      : (Array.isArray(options.choices) ? options.choices : undefined);
    return commandResponse(await call("qa.askUser", { tab, session, message: text, ...(choices ? { choices } : {}),
      ...(approve ? { _kind: "approve" } : {}), limits, requestId: crypto.randomUUID() }));
  };
  const channel = createQaChannel({
    runKeys: true,
    autoResume: true,
    ledger,
    activity,
    grants,
    mobileFactory,
    runContext: (state, invoke) => hostApi.withCommand({
      identity: { session: state.session, run: state.id, lifecycle: true },
      commandId: `${workerGeneration}/lifecycle/${state.id}/${crypto.randomUUID()}`,
    }, invoke),
    createEntry: (session, url, run) => call("qa.tabCreate", { session, run, url }),
    restore: (session, tabs, run) => call("qa.tabsRestore", { session, run, tabs }),
    openReport: (session, url) => call("qa.reportOpen", { session, url }),
    ask,
    release: async (tab, run) => {
      const mode = await executor.modeOff(tab);
      requireOk(mode);
      await call("qa.releaseIfOwner", { run, target: tab });
      await call("qa.tabsPublish", { run });
    },
    releaseDevice: (target, run) => call("qa.releaseIfOwner", { run, target }),
    close: (tab, run) => call("qa.tabClose", { tabId: tab, run }),
    execute: executor.execute,
  });
  return {
    ledger,
    stopObservations: reason => channel.stopObservations(reason),
    async dispatch({ command, args = {}, identity, commandId } = {}) {
      if (!identity || typeof identity.session !== "string") return { ok: false, error: "세션 식별자가 필요합니다." };
      return hostApi.withCommand({ identity, commandId }, () => channel(command, args, identity.session, identity.run, identity.key));
    },
  };
}
