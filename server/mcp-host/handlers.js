import crypto from "node:crypto";
import qaExpiry from "../qa-expiry-guard.cjs";

import { appTargetsFor, readAppTargets, setAppTargets } from "../app-targets.js";
import {
  noteAppPick,
  noteBrowserPick,
  notifyHostUser,
  progressHostUser,
  runSessionCmd,
} from "../browser-commands.js";
import {
  handleQaSessionCmd,
  isActCmd,
  noteRunAccepted,
  noteRunEvent,
  noteTrace,
  recordFrame,
  runFor,
  runSurfaces,
} from "../qa-journal.js";
import {
  claimQaTabIfFree,
  qaOwner,
  releaseQaTabIfOwner,
} from "../qa-ownership.js";
import { hostError } from "./errors.js";
import { createHostLeaseStore } from "./lease-store.js";
import { HOST_OPERATION_NAMES } from "./operations.js";
import { createHostUserCoordinator } from "./user.js";

const targetOf = (input) => String(input?.target ?? input?.tabId ?? input?.device ?? "");
const tokenId = (input) => {
  const value = input?.runToken ?? input?.token;
  return String(value && typeof value === "object" ? value.id : value || "");
};

function required(owner, name) {
  const fn = owner?.[name];
  if (typeof fn !== "function") {
    return () => { throw hostError("INTERNAL", `host API port가 연결되지 않았습니다: ${name}`); };
  }
  return fn;
}

export function createMcpHostHandlers(ports = {}) {
  const browser = ports.browser || {};
  const qa = ports.qa || {};
  const app = ports.app || {};
  const user = ports.user || createHostUserCoordinator({ notify: notifyHostUser, progress: progressHostUser });
  const journal = ports.journal || {};
  const lease = ports.lease || createHostLeaseStore(ports.clock);
  const runTokens = new Map();
  const appTargetsRevision = () => crypto.createHash("sha256")
    .update(JSON.stringify(readAppTargets(ports.appTargetOptions))).digest("hex");

  const handlers = {
    "browser.sessionView": (ctx) => required(browser, "sessionView")(ctx),
    "browser.targetGet": (ctx) => required(browser, "targetGet")(ctx),
    "browser.targetSet": (ctx) => required(browser, "targetSet")(ctx),
    "browser.targetClear": (ctx) => required(browser, "targetClear")(ctx),
    "browser.commandGuard": (ctx) => required(browser, "commandGuard")(ctx),
    "browser.commandTargetState": (ctx) => required(browser, "commandTargetState")(ctx),
    "browser.resolveForCommand": (ctx) => required(browser, "resolveForCommand")(ctx),
    "browser.tabCreate": (ctx) => required(browser, "tabCreate")(ctx),
    "browser.tabWake": (ctx) => required(browser, "tabWake")(ctx),
    "browser.tabClose": (ctx) => required(browser, "tabClose")(ctx),
    "browser.status": (ctx) => required(browser, "status")(ctx),
    "browser.promptTargetsActivate": (ctx) => required(browser, "promptTargetsActivate")(ctx),
    "browser.pickRecord": ({ identity, input }) => {
      if (!input.pick || typeof input.pick !== "object" || Array.isArray(input.pick)) {
        throw hostError("INVALID_REQUEST", "저장할 pick이 필요합니다.");
      }
      const pickId = input.kind === "app" ? noteAppPick(identity.session, input.pick)
        : noteBrowserPick(identity.session, input.tabId, input.pick);
      return { saved: true, pickId, kind: input.kind === "app" ? "app" : "browser" };
    },
    "browser.pickList": ({ identity, input }) => {
      if (typeof browser.pickList === "function") return browser.pickList({ identity, input });
      return runSessionCmd(input.kind === "app" ? "app-picks" : "picks", {}, identity.session)
        || { ok: true, data: { count: 0, picks: [] } };
    },
    "browser.executeWithDialog": (ctx) => required(browser, "executeWithDialog")(ctx),
    "browser.dialogState": (ctx) => required(browser, "dialogState")(ctx),
    "browser.dialogAnswer": (ctx) => required(browser, "dialogAnswer")(ctx),
    "browser.legacyHostTask": (ctx) => required(browser, "legacyHostTask")(ctx),
    "qa.anchorUpdate": (ctx) => required(qa, "anchorUpdate")(ctx),

    "qa.claimIfFree": ({ identity, input }) => {
      const target = targetOf(input);
      if (!target) throw hostError("INVALID_REQUEST", "claim할 탭이나 기기가 필요합니다.");
      const result = claimQaTabIfFree(target, identity.run);
      if (!result.claimed && result.owner !== identity.run) {
        throw hostError("QA_OWNED", "다른 QA 회차가 소유한 대상입니다.", { details: { target } });
      }
      return result;
    },
    "qa.releaseIfOwner": ({ identity, input }) => {
      const target = targetOf(input);
      if (!target) throw hostError("INVALID_REQUEST", "release할 탭이나 기기가 필요합니다.");
      const result = releaseQaTabIfOwner(target, identity.run);
      if (!result.released && result.owner == null) throw hostError("NOT_FOUND", "QA 소유권이 없습니다.");
      if (!result.released) throw hostError("RUN_DENIED", "다른 QA 회차의 소유권입니다.");
      return result;
    },
    "qa.owner": ({ input }) => {
      const target = targetOf(input);
      if (!target) throw hostError("INVALID_REQUEST", "조회할 탭이나 기기가 필요합니다.");
      return { target, owner: qaOwner(target) };
    },
    "qa.tabCreate": (ctx) => required(qa, "tabCreate")(ctx),
    "qa.tabsRestore": (ctx) => required(qa, "tabsRestore")(ctx),
    "qa.tabClose": (ctx) => required(qa, "tabClose")(ctx),
    "qa.tabsPublish": (ctx) => required(qa, "tabsPublish")(ctx),
    "qa.deviceAuthorize": (ctx) => required(qa, "deviceAuthorize")(ctx),
    "app.targetsGet": ({ identity }) => {
      if (!identity.session) return runSessionCmd("app-targets-get", {}, identity.session);
      try {
        return { ok: true, data: { session: identity.session, devices: appTargetsFor(identity.session, ports.appTargetOptions) } };
      } catch (error) {
        return { ok: false, error: `기기 등록을 읽지 못했습니다: ${String(error?.message || error)}` };
      }
    },
    "app.targetsAll": () => ({ assignments: readAppTargets(ports.appTargetOptions), stateRevision: appTargetsRevision() }),
    "app.targetsSet": async ({ identity, input }) => {
      if (!Array.isArray(input.devices)) throw hostError("INVALID_REQUEST", "기기 목록이 필요합니다.");
      const before = appTargetsFor(identity.session, ports.appTargetOptions);
      const devices = setAppTargets(identity.session, input.devices, { ...ports.appTargetOptions, exclusive: input.exclusive === true });
      const removed = before.filter((device) => !devices.includes(device));
      // QA 등록 저장은 탭 소유권을 놓지 않음(eb90977: release 는 일반 app-targets-set 에만)
      if (input.release !== false && typeof app.afterTargetsSet === "function") await app.afterTargetsSet({ session: identity.session, devices, removed });
      return { ok: true, data: { session: identity.session, devices } };
    },
    "app.command": (ctx) => required(app, "command")(ctx),
    "qa.askUser": (ctx) => user.ask(ctx),
    "qa.reportOpen": (ctx) => required(qa, "reportOpen")(ctx),

    "journal.sessionCommand": ({ identity, input }) => {
      const result = handleQaSessionCmd(input.command, input.args || {}, identity.session, identity.run);
      if (result == null) throw hostError("DATA_INCOMPATIBLE", "지원하지 않는 journal 명령입니다.");
      return result;
    },
    "journal.accept": ({ identity, input, request }) => {
      if (typeof input.command !== "string" || !input.command) throw hostError("INVALID_REQUEST", "journal 명령 이름이 필요합니다.");
      const state = runFor(identity.session, identity.run);
      let commandUse = null;
      let outputUse = null;
      try {
        commandUse = state ? qaExpiry.acquireRun(state.runId, "browser-command") : null;
        outputUse = qaExpiry.acquirePaths([input.path], "browser-output");
      } catch (error) {
        commandUse?.release();
        throw error;
      }
      const callId = noteRunAccepted(input.command, input.args || {}, identity.session, identity.run);
      const token = `run-token-${crypto.randomUUID()}`;
      runTokens.set(token, { token, workerGeneration: request.workerGeneration,
        session: identity.session, run: state?.runId || identity.run, callId,
        command: input.command, args: input.args || {}, state, commandUse, outputUse, completed: false });
      return { callId, runToken: { id: token, run: state?.runId || identity.run }, captureFrames: Boolean(state && isActCmd(input.command)) };
    },
    "journal.complete": ({ input, request }) => {
      const token = runTokens.get(tokenId(input));
      if (!token) throw hostError("RUN_DENIED", "유효한 journal run token이 아닙니다.");
      if (token.workerGeneration !== request.workerGeneration) throw hostError("STALE_WORKER", "다른 worker 세대의 journal token입니다.");
      if (!token.completed) {
        noteRunEvent(token.callId, token.command, token.args, token.session, input.result,
          input.tries, token.run, token.state);
        token.completed = true;
      }
      return { completed: true, callId: token.callId };
    },
    "journal.release": ({ input, request }) => {
      const id = tokenId(input);
      const token = runTokens.get(id);
      if (!token) return { released: true };
      if (token.workerGeneration !== request.workerGeneration) throw hostError("STALE_WORKER", "다른 worker 세대의 journal token입니다.");
      runTokens.delete(id);
      try { token.outputUse?.release(); }
      finally { token.commandUse?.release(); }
      return { released: true };
    },
    "journal.trace": ({ identity, input }) => {
      noteTrace(input.command, input.args || {}, identity.session, input.result);
      return null;
    },
    "journal.recordFrame": async ({ input, request }) => {
      const token = runTokens.get(tokenId(input));
      if (!token) throw hostError("RUN_DENIED", "유효한 journal run token이 아닙니다.");
      if (token.workerGeneration !== request.workerGeneration) throw hostError("STALE_WORKER", "다른 worker 세대의 journal token입니다.");
      const capture = required(journal, "captureFrame");
      return recordFrame(token.state, input.tab, input.phase, (options) => capture({ token, input, options, request }));
    },
    "journal.surfaces": ({ identity }) => ({ surfaces: runSurfaces(identity.session, identity.run) }),
    "lease.grant": ({ identity, input }) => lease.grant(identity, input),
    "lease.check": ({ identity, input }) => lease.check(identity, input),
    "lease.revoke": ({ identity, input }) => lease.revoke(identity, input),
    "user.ask": (ctx) => user.ask(ctx),
    "user.notify": (ctx) => user.notify(ctx),
    "user.progress": (ctx) => user.progress(ctx),
  };

  for (const operation of HOST_OPERATION_NAMES) {
    if (typeof handlers[operation] !== "function") throw new Error(`host API handler 없음: ${operation}`);
  }
  handlers.releaseWorkerGeneration = workerGeneration => {
    let released = 0;
    for (const [id, token] of runTokens) {
      if (token.workerGeneration !== workerGeneration) continue;
      runTokens.delete(id);
      try { token.outputUse?.release(); }
      finally { token.commandUse?.release(); }
      released += 1;
    }
    return released;
  };
  return Object.freeze(handlers);
}
