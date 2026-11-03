import crypto from "node:crypto";

import { bulkPolicy } from "../bulk-fill.js";
import { ordinaryCommandDenied, sanitizeBrowserArgs } from "../qa-command-contract.js";
import { COMMAND_ROUTES, requiredFeatures, runsOutsideQueue, workerHandlerFor } from "./command-routes.js";
import { INTERNAL_HOST_API_COMMANDS, INTERNAL_RELAY_COMMANDS } from "./relay-contract.js";
import { commandResponse, mainHasFeatures, runUnitHandler } from "./unit-runner.js";

const MAX_TARGETS = 4;
const READ_ONLY = new Set(["url", "text", "snapshot", "screenshot", "observe", "tabs", "console", "network", "history", "locate"]);
const ACT_COMMANDS = new Set(["click", "dblclick", "type", "key", "fill", "select", "check", "clear", "hover", "focus",
  "goto", "back", "forward", "reload", "upload", "scroll", "scrollto", "nativeclick", "nativekey", "dialog", "bulkfill"]);
const RETRY_DELAYS = [700, 1200, 2000, 3000];
const APP_GONE_DELAYS = [500, 1000, 1500, 2000, 3000, 4000, 5000, 6000, 8000, 10000, 10000, 9000];
const SENT_UNKNOWN_RE = /timeout\(30s\)/;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function resultError(error) {
  return { ok: false, error: String(error?.message || error), ...(error?.code ? { code: error.code } : {}),
    ...(error?.sent === false ? { sent: false } : {}), ...(error?.appGone ? { appGone: true } : {}) };
}

function targetRefs(value) {
  if (value == null) return null;
  const refs = (Array.isArray(value) ? value : String(value).split(","))
    .map(item => String(item).trim()).filter(Boolean);
  return [...new Set(refs)];
}

function askInput(command, args) {
  const approve = command === "approve";
  const text = String(approve ? args?.summary || "" : args?.message || "").trim().slice(0, 300);
  if (!text) return { error: approve ? "summary를 적어 주세요." : "message를 적어 주세요." };
  const choices = approve
    ? [String(args.approve_label || "승인"), String(args.deny_label || "취소")]
    : (Array.isArray(args?.choices) ? args.choices.map(value => String(value).trim()).filter(Boolean) : null);
  return { input: { message: text, ...(choices ? { choices } : {}), ...(approve ? { _kind: "approve" } : {}),
    requestId: args.requestId || crypto.randomUUID() } };
}

export function createWorkerBrowserService({ hostApi, activity, routes = COMMAND_ROUTES } = {}) {
  if (!hostApi?.call) throw new Error("browser worker host API가 필요합니다.");
  const call = (operation, input, options) => hostApi.call(operation, input, options);

  const hasFeatures = (features) => mainHasFeatures(call, features);
  // 명령 도중 세대가 바뀌면 같은 탭의 현재 token 을 host 에서 다시 받음
  const freshToken = tabId => async () => (await call("browser.resolveForCommand", { tabId }))?.targetToken;
  const runWorkerHandler = (handler, command, args, relayCall, token, outside = false, tabId = null) => runUnitHandler({
    handler, command, args, relayCall, token, outside, refreshToken: tabId == null ? undefined : freshToken(tabId), context: { onRelayEvent: listener => hostApi.onRelayEvent?.(listener), mainHasFeatures: hasFeatures },
  });

  const sessionCommand = async (command, args) => {
    if (command === "trace") return commandResponse(await call("journal.sessionCommand", { command, args }));
    if (command === "tabs") return commandResponse(await call("browser.sessionView", {}));
    if (command === "target") {
      if (args.tab == null && args.wc == null) return commandResponse(await call("browser.targetGet", {}));
      return commandResponse(await call("browser.targetSet", { tabRef: args.tab ?? args.wc }));
    }
    if (command === "untarget") return commandResponse(await call("browser.targetClear", { tabRef: args.tab }));
    if (command === "prompt-targets") return commandResponse(await call("browser.promptTargetsActivate", args));
    if (command === "picks" || command === "app-picks") {
      return commandResponse(await call("browser.pickList", { kind: command === "app-picks" ? "app" : "browser" }));
    }
    if (command === "app-targets-get") return commandResponse(await call("app.targetsGet", {}));
    if (command === "app-targets-set") return commandResponse(await call("app.targetsSet", {
      devices: Array.isArray(args?.devices) ? args.devices : [],
    }));
    if (command === "newtab") return commandResponse(await call("browser.tabCreate", args));
    if (command === "closetab") return commandResponse(await call("browser.tabClose", { tabRef: args.tab }));
    if (["app-devices", "app-viewport", "app-open"].includes(command)) {
      const appCommand = { "app-devices": "list", "app-viewport": "viewport", "app-open": "open" }[command];
      return commandResponse(await call("app.command", { command: appCommand, args, qa: false }));
    }
    if (command === "notify") return commandResponse(await call("user.notify", args));
    if (command === "progress") return commandResponse(await call("user.progress", args));
    if (command === "ask" || command === "approve") {
      const prepared = askInput(command, args);
      if (prepared.error) return { ok: false, error: prepared.error };
      return commandResponse(await call("user.ask", prepared.input));
    }
    return null;
  };

  const executeOne = async (command, args, identity, noAutoTab = false) => {
    const local = await sessionCommand(command, args);
    if (local) {
      if (command !== "newtab" || !local.ok || !local.data?._navigate) return local;
      const { _navigate, ...data } = local.data;
      const navigated = await executeOne("goto", { url: _navigate, tab: data.tabId, entry: true }, identity, true);
      return { ok: true, data: { ...data, ...(!navigated.ok ? { navError: navigated.error } : {}) } };
    }
    const state = await call("browser.commandTargetState", { tabRef: args.tab, noAutoTab });
    if (state.response) return state.response;
    if (state.wakeTab) {
      try {
        await call("browser.tabWake", { tabId: state.wakeTab, stateRevision: state.stateRevision, timeoutMs: 12000 });
      } catch {
        return { ok: false, error: `잠든 탭 @${state.wakeHandle || state.wakeTab}을(를) 깨우지 못했습니다 — 이 탭을 띄울 브라우저 창(공유 탭이면 공유 브라우저 창)이 열려 있는지 확인하세요.`,
          data: { tab: state.wakeHandle || state.wakeTab, sleeping: true } };
      }
      return executeOne(command, args, identity, true);
    }
    if (state.grantedTab) return executeOne(command, { ...args, tab: state.grantedTab }, identity, true);
    if (state.needTab) {
      if (noAutoTab) return { ok: false, error: "이 세션 몫의 탭을 만들었지만 브라우저가 아직 띄우지 못했습니다 — 잠시 뒤 다시 시도하세요.", sent: false };
      const created = commandResponse(await call("browser.tabCreate", {}));
      if (!created.ok) return created;
      const response = await executeOne(command, args, identity, true);
      return response.ok ? { ...response, data: { ...(response.data || {}), createdTab: created.data?.handle, note: created.data?.note } } : response;
    }
    const target = state.target;
    if (!target?.tabId) return { ok: false, error: "명령을 실행할 탭을 찾지 못했습니다." };
    if (command === "dialog") {
      return commandResponse(await call("browser.dialogAnswer", { ...args, tabId: target.tabId,
        targetToken: target.targetToken, answerTool: "browser_dialog", qa: false }));
    }
    if (command === "bulkfill") {
      const journal = await call("journal.surfaces", {});
      const policy = bulkPolicy({
        url: target.tab?.url || "",
        values: args.values || [],
        where: args.where || "",
        surfaces: journal.surfaces || [],
        approved: args.approved === true,
        allowFormula: args.allowFormula === true,
      });
      if (policy.mode !== "free") return { ok: false, error: policy.reason, need: policy.mode, cap: policy.cap };
    }
    const relayCall = (relayCommand, relayArgs, unit, token = target.targetToken) => call("browser.executeWithDialog", {
      tabId: target.tabId,
      targetToken: token,
      answerTool: "browser_dialog",
      relay: { command: relayCommand, args: relayArgs, timeoutMs: 30000, ...(unit ? { unit } : {}) },
    });
    const workerHandler = workerHandlerFor(command, routes);
    // 메인이 단위 실행을 알릴 때만 worker 경로 · 아니면 옛 봉투로 보내 지금 설치 앱의 메인과 호환
    if (workerHandler && await hasFeatures(requiredFeatures(command))) return runWorkerHandler(workerHandler, command, args, relayCall, target.targetToken, runsOutsideQueue(command), target.tabId);
    return commandResponse(await relayCall(command, args));
  };

  const execute = async (command, rawArgs, identity, onAttempt) => {
    if (ordinaryCommandDenied(command)) return { ok: false, error: "QA 전용 명령은 iris-qa에서만 실행합니다." };
    if (INTERNAL_RELAY_COMMANDS.has(String(command)) || INTERNAL_HOST_API_COMMANDS.has(String(command))) {
      return { ok: false, error: "내부 명령은 일반 MCP 요청으로 호출할 수 없습니다." };
    }
    let args = sanitizeBrowserArgs(rawArgs);
    const refs = targetRefs(args.tab);
    const guardedRefs = refs || (args.tab ? [args.tab] : []);
    if (["notify", "progress", "approve"].includes(command)) {
      if (guardedRefs.length) {
        const guards = await Promise.all(guardedRefs.map(tabRef => call("browser.commandGuard", { tabRef })));
        if (guards.some(guard => guard.qaOwned)) return { ok: false, error: "QA 회차가 소유한 탭입니다." };
      }
      return sessionCommand(command, args);
    }
    if (refs && refs.length !== 1) {
      if (!refs.length) return { ok: false, error: "대상 탭이 비어 있습니다." };
      if (refs.length > MAX_TARGETS) return { ok: false, error: `한 번에 최대 ${MAX_TARGETS}개까지 조작합니다(요청 ${refs.length}개).` };
      const targets = await Promise.all(refs.map(async tab => {
        try {
          const guard = await call("browser.commandGuard", { tabRef: tab });
          if (guard.qaOwned) return { tab, ok: false, error: "QA 회차가 소유한 탭입니다." };
          return { tab, ...await executeOne(command, { ...args, tab }, identity) };
        } catch (error) {
          return { tab, ...resultError(error) };
        }
      }));
      const okCount = targets.filter(item => item.ok).length;
      const result = { ok: okCount === targets.length, multi: true, count: targets.length, okCount,
        error: okCount === targets.length ? undefined
          : targets.filter(item => !item.ok).map(item => `${item.tab}: ${item.error || "실패"}`).join(" / "),
        targets };
      await onAttempt?.(result);
      return result;
    }
    if (refs) args = { ...args, tab: refs[0] };
    if (guardedRefs.length) {
      const guard = await call("browser.commandGuard", { tabRef: guardedRefs[0] });
      if (guard.qaOwned) return { ok: false, error: "QA 회차가 소유한 탭입니다." };
    }
    let last = null;
    let tries = 0;
    let step = 0;
    let longWait = false;
    for (let attempt = 0; ; attempt++) {
      tries = attempt + 1;
      try { last = await executeOne(command, args, identity); }
      catch (error) { last = resultError(error); }
      await onAttempt?.(last);
      if (last?.ok) return { result: attempt ? { ...last, data: { ...(last.data || {}), retried: attempt } } : last, tries };
      const why = String(last?.error || "");
      const notSent = last?.sent === false;
      const sentUnknown = last?.sent === true || SENT_UNKNOWN_RE.test(why);
      const retryable = notSent || (sentUnknown && READ_ONLY.has(command));
      const gone = last?.appGone === true;
      if (gone !== longWait) {
        longWait = gone;
        step = 0;
      }
      const ladder = longWait ? APP_GONE_DELAYS : RETRY_DELAYS;
      if (!retryable || step >= ladder.length) break;
      await delay(ladder[step++]);
    }
    if (last && !last.ok && tries > 1) last = { ...last, error: `${last.error} (${tries}회 시도)` };
    return { result: last, tries };
  };

  return {
    async dispatch({ command, args = {}, identity = {}, commandId } = {}) {
      return hostApi.withCommand({ identity, commandId }, () => activity.run("commands", commandId, async () => {
        let accepted = null;
        let result = null;
        let tries = 0;
        try {
          accepted = await call("journal.accept", { command, args, path: args?.path });
          if (accepted?.captureFrames && ACT_COMMANDS.has(command)) {
            try { await call("journal.recordFrame", { runToken: accepted.runToken, tab: args?.tab, phase: "before" }); } catch {}
          }
          const executed = await execute(command, args, identity,
            value => call("journal.trace", { command, args, result: value }));
          result = executed?.result ?? executed;
          tries = executed?.tries || 1;
          if (accepted?.runToken) await call("journal.complete", { runToken: accepted.runToken, result, tries });
          if (result?.ok && accepted?.captureFrames && ACT_COMMANDS.has(command)) {
            try { await call("journal.recordFrame", { runToken: accepted.runToken, tab: args?.tab, phase: "after" }); } catch {}
          }
          return result;
        } catch (error) {
          result = resultError(error);
          if (accepted?.runToken) {
            try { await call("journal.complete", { runToken: accepted.runToken, result, tries: tries || 1 }); } catch {}
          }
          return result;
        } finally {
          if (accepted?.runToken) {
            try { await call("journal.release", { runToken: accepted.runToken }); } catch {}
          }
        }
      }));
    },
  };
}
