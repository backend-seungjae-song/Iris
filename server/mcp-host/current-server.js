import crypto from "node:crypto";

import { readAppTargets } from "../app-targets.js";
import { askEmulator } from "../emulator-bridge.js";
import {
  closeBrowserTab,
  createQaEntry,
  openQaReport,
  publishQaTabs,
  restoreQaTabs,
  runBrowserCmd,
  runQaAppCommand,
  runSessionCmd,
} from "../browser-commands.js";
import {
  MAX_PINS,
  absorbIntoSessionGroup,
  answerDialogAsk,
  cdpExecutorReady,
  goneReply,
  grantTabIdsOf,
  handleFor,
  hasTab,
  markControl,
  raceDialog,
  requestCdp,
  resolveTarget,
  sessionSpace,
  setLastTab,
  setTabDialog,
  tabAllowed,
  tabExistsInState,
  tabIdOfRef,
  tabMeta,
  waitForTabWc,
  wakeSleepingTab,
  wcOfTabId,
} from "../browser-runtime.js";
import * as spaceKey from "../space-key.js";
import { claimQaTabIfFree, qaOwner, releaseQaTabIfOwner } from "../qa-ownership.js";
import { createBrowserDialogHost, sameTargetToken } from "./browser-dialog.js";
import { hostError } from "./errors.js";

function output(response, code = "INTERNAL") {
  if (!response || response.ok === false) throw hostError(response?.code || code, response?.error || "공용 서버 상태 연산이 실패했습니다.");
  return response.data === undefined ? response : response.data;
}

export function createCurrentServerHostPorts({ targetTokenFor, executeRelay, delegateHostTask,
  status = () => ({}), browserState = {}, serial = null } = {}) {
  let mutationRevision = 0;
  const access = {
    tabIdOfRef, tabAllowed, qaOwner, wcOfTabId, tabMeta, handleFor,
    sessionResponse: session => runSessionCmd("tabs", {}, session),
    ...browserState,
  };
  const sessionResponse = (session) => access.sessionResponse(session);
  const sessionSnapshot = (session) => output(sessionResponse(session));
  const stateRevision = (session) => crypto.createHash("sha256")
    .update(JSON.stringify(sessionSnapshot(session))).digest("hex");
  const appTargetsRevision = () => crypto.createHash("sha256")
    .update(JSON.stringify(readAppTargets())).digest("hex");

  const resolveForCommand = async (identity, input) => {
    const explicit = input.tabRef ?? input.tabId ?? input.tab;
    const tabId = explicit == null ? resolveTarget(identity.session)?.tabId : access.tabIdOfRef(explicit);
    if (!tabId) throw hostError("NOT_FOUND", "명령을 실행할 탭을 찾지 못했습니다.");
    const gate = access.tabAllowed(identity.session, tabId);
    if (!gate.ok) throw hostError("SESSION_DENIED", gate.why || "이 세션이 쓸 수 있는 탭이 아닙니다.");
    const owner = access.qaOwner(tabId);
    if (input.requireQaOwner && owner !== identity.run) throw hostError("QA_OWNED", "QA 탭 소유권이 없습니다.");
    if (!input.requireQaOwner && owner && owner !== identity.run) throw hostError("QA_OWNED", "다른 QA 회차가 소유한 탭입니다.");
    const wcId = access.wcOfTabId(tabId);
    if (!wcId) throw hostError(tabExistsInState(tabId) ? "STALE_TARGET" : "NOT_FOUND", "현재 실행할 수 있는 탭이 아닙니다.");
    if (typeof targetTokenFor !== "function") throw hostError("EXECUTOR_GONE", "target token 발급 port가 연결되지 않았습니다.");
    const token = await targetTokenFor({ tabId, wcId, meta: access.tabMeta(tabId) });
    if (!token) throw hostError("STALE_TARGET", "현재 문서 세대의 target token을 만들지 못했습니다.");
    if (input.targetToken !== undefined && !sameTargetToken(input.targetToken, token)) {
      throw hostError("STALE_TARGET", "현재 문서 세대의 target token이 아닙니다.");
    }
    return { tabId, wc: wcId, wcId, handle: access.handleFor(tabId), tab: { ...(access.tabMeta(tabId) || {}) },
      documentGeneration: token.documentGeneration, debuggerGeneration: token.debuggerGeneration,
      targetToken: token, stateRevision: stateRevision(identity.session) };
  };

  const commandTargetState = async (identity, input) => {
    if (!cdpExecutorReady()) return { response: { ok: false,
      error: "브라우저 제어기(앱)가 연결 안 됨 — Iris 앱을 실행하세요(pnpm app).", sent: false, appGone: true } };
    const explicit = input.tabRef != null;
    const want = explicit ? tabIdOfRef(input.tabRef) : null;
    if (explicit && want == null) {
      const reply = goneReply(null, identity.session);
      return { response: { ...reply, error: `그런 탭 핸들이 없습니다: ${input.tabRef}.`
        + reply.error.replace(/^이 세션에 고정된 탭이 없습니다\./, "") } };
    }
    if (want != null) {
      const gate = tabAllowed(identity.session, want);
      if (!gate.ok) {
        if (!hasTab(want)) {
          const reply = goneReply(null, identity.session);
          return { response: { ...reply, error: `지정한 탭 @${handleFor(want) || want}이(가) 없습니다(닫혔거나 다른 창).`
            + reply.error.replace(/^이 세션에 고정된 탭이 없습니다\./, "") } };
        }
        return { response: { ok: false, error: gate.why } };
      }
      if (qaOwner(want)) return { response: { ok: false, error: "QA 회차가 소유한 탭입니다." } };
      const meta = tabMeta(want);
      if (meta && spaceKey.sameStorageSpace(meta.space, sessionSpace(identity.session))) absorbIntoSessionGroup(identity.session, want);
    }
    const resolved = want != null ? { tabId: want, pinned: false, adhoc: true } : resolveTarget(identity.session);
    const asleep = input.noAutoTab || resolved.staleP || resolved.needTab
      ? null : (resolved.tabId && !wcOfTabId(resolved.tabId) ? resolved.tabId : (resolved.notReady ? resolved.waitTab : null));
    if (asleep && tabExistsInState(asleep)) return { wakeTab: asleep, wakeHandle: handleFor(asleep) || asleep,
      stateRevision: stateRevision(identity.session) };
    const wc = resolved.tabId ? wcOfTabId(resolved.tabId) : null;
    if (!wc) {
      if (resolved.staleP) return { response: goneReply(resolved.deadTab, identity.session) };
      if (resolved.needTab) {
        const granted = [...(grantTabIdsOf(identity.session) || [])]
          .filter(id => spaceKey.sameStorageSpace((tabMeta(id) || {}).space, resolved.space));
        if (granted.length) {
          for (const id of granted) absorbIntoSessionGroup(identity.session, id);
          const pick = granted[granted.length - 1];
          setLastTab(String(identity.session), pick);
          return { grantedTab: pick };
        }
        return { needTab: true };
      }
      if (resolved.notReady) return { response: { ok: false, sent: false,
        error: "고정한 탭이 아직 브라우저에 뜨지 않았습니다(앱 기동 중일 수 있음) — 고정은 그대로 두었습니다. 잠시 뒤 다시 시도하세요.",
        data: { tab: handleFor(resolved.waitTab) || resolved.waitTab, pending: true } } };
      return { response: { ok: false, error: resolved.noSession
        ? "세션 식별자가 없어(HERDR_PANE_ID·IRIS_SESSION 둘 다 없음) 어느 탭을 쓸지 정할 수 없습니다. 임의로 고르지 않습니다 — herdr pane 안에서 실행하거나, 위임 프로세스라면 IRIS_SESSION에 부모 pane id(예: w3:pS)를 넘겨주세요."
        : resolved.noSpace
          ? "이 세션의 스페이스를 알 수 없어 조작할 탭을 정할 수 없습니다 — 앱에서 탭을 지목해 고정해 주세요."
          : resolved.sharedBlocked
            ? "공유 브라우저 창은 지목 없이 쓰지 않습니다 — 앱에서 그 탭을 직접 지목해 주세요."
            : resolved.space
              ? `스페이스 ${resolved.space}에 열린 브라우저 탭이 없습니다 — 이 스페이스에서 브라우저를 열거나 탭을 지목해 고정하세요.`
              : "제어할 브라우저 탭이 없습니다 — 앱에서 브라우저를 열거나, 탭을 지목해 고정하세요(`iris-browser tabs`)." } };
    }
    return { target: await resolveForCommand(identity, { tabId: resolved.tabId }) };
  };

  const relay = typeof executeRelay === "function" ? executeRelay
    : ({ target, relay: call }) => requestCdp(call.command, call.args, target?.wcId, call.timeoutMs || 30000);
  const legacyHostTask = async ({ target, relay: legacyRelay, request }) => {
    if (typeof delegateHostTask === "function") {
      try {
        return await delegateHostTask({
          task: { type: "legacyRelay", target, relay: legacyRelay },
          identity: request.identity || {},
          commandId: request.commandId,
          callId: request.callId,
          // worker 안쪽 호출도 같은 상한으로 Electron 을 기다리므로 IPC 왕복·탭 잠금 대기만큼 여유
          timeoutMs: Number.isFinite(legacyRelay.timeoutMs) ? legacyRelay.timeoutMs + 2000 : undefined,
        });
      } catch (error) {
        if (error?.code !== "WORKER_UNAVAILABLE") throw error;
      }
    }
    return relay({ target, relay: legacyRelay, request });
  };
  const dialog = createBrowserDialogHost({
    serial,
    resolveForCommand,
    ownerOf: qaOwner,
    markControl,
    execute: (target, input, request) => relay({ target, relay: input.relay || {
      command: input.command, args: input.args, timeoutMs: input.timeout,
    }, request }),
    raceDialog: (target, pending, answerTool) => raceDialog(target.wcId, pending, answerTool),
    currentDialog: (target) => tabMeta(target.tabId)?.dialog || null,
    answerIntercepted: (target, answer, text) => answerDialogAsk(target.wcId, answer, text),
    answerExecutor: (target, answer, text, request) => legacyHostTask({ target,
      relay: { command: "dialog", args: { answer, text }, timeoutMs: 10000 }, request }),
    clearDialog: target => setTabDialog(target.wcId, false),
    redact: async (text, target, request) => {
      const result = await legacyHostTask({ target, relay: { command: "redact", args: { text }, timeoutMs: 3000 }, request });
      return result?.data?.text ?? result?.text;
    },
  });

  const browser = {
    sessionView: ({ identity }) => sessionResponse(identity.session),
    targetGet: ({ identity }) => runSessionCmd("target", {}, identity.session),
    targetSet: ({ identity, input }) => runSessionCmd("target", { tab: input.tabRef }, identity.session),
    targetClear: ({ identity, input }) => runSessionCmd("untarget", { tab: input.tabRef }, identity.session),
    commandGuard: ({ input }) => ({ qaOwned: Boolean(qaOwner(tabIdOfRef(input.tabRef))) }),
    commandTargetState: ({ identity, input }) => commandTargetState(identity, input),
    resolveForCommand: ({ identity, input }) => resolveForCommand(identity, input),
    tabCreate: async ({ identity, input }) => {
      const result = await runBrowserCmd("newtab", input, identity.session);
      if (result?.ok) mutationRevision += 1;
      return result;
    },
    tabWake: async ({ identity, input }) => {
      const rawTabId = input.tabId == null ? null : String(input.tabId);
      const tabId = rawTabId && tabExistsInState(rawTabId) ? rawTabId : tabIdOfRef(rawTabId);
      if (!tabId || !tabExistsInState(tabId)) throw hostError("STALE_TARGET", "저장된 탭이 아닙니다.");
      const gate = tabAllowed(identity.session, tabId);
      if (!gate.ok) throw hostError("SESSION_DENIED", gate.why || "이 세션의 탭이 아닙니다.");
      wakeSleepingTab(tabId);
      const wcId = await waitForTabWc(tabId, Number(input.timeoutMs) || 12000);
      if (!wcId) throw hostError("TIMEOUT", "탭을 깨우지 못했습니다.", { retryable: true });
      return resolveForCommand(identity, { tabId });
    },
    tabClose: async ({ identity, input }) => {
      const result = await runBrowserCmd("closetab", { tab: input.tabRef }, identity.session);
      if (result?.ok) mutationRevision += 1;
      return result;
    },
    status: () => ({ executorReady: cdpExecutorReady(), mutationRevision, ...status() }),
    promptTargetsActivate: ({ identity, input }) => runSessionCmd("prompt-targets", input, identity.session),
    pickList: ({ identity, input }) => input.kind === "app" && identity.run
      ? runQaAppCommand("app-picks", {}, identity.session)
      : runSessionCmd(input.kind === "app" ? "app-picks" : "picks", {}, identity.session),
    executeWithDialog: dialog.executeWithDialog,
    dialogState: async ({ identity, input, request }) => {
      const target = await resolveForCommand(identity, { ...input, requireQaOwner: input.requireQaOwner === true });
      markControl(target.tabId, input.controlLabel || (identity.run ? "iris-qa" : identity.session));
      const open = tabMeta(target.tabId)?.dialog || null;
      if (!open) return { dialog: null };
      const source = typeof open.full === "string" ? open.full : String(open.message || "");
      const redacted = await legacyHostTask({ target, relay: { command: "redact", args: { text: source }, timeoutMs: 3000 }, request });
      const text = redacted?.data?.text ?? redacted?.text;
      return { dialog: { ...open, message: typeof text === "string" ? text.slice(0, 200) : "(확인 창 문구를 가리지 못해 뺐습니다)" } };
    },
    dialogAnswer: dialog.dialogAnswer,
    legacyHostTask: ({ input, request }) => {
      if (!["dialog", "redact", "qa-mode", "screenshot"].includes(input?.relay?.command)) {
        throw hostError("INVALID_REQUEST", "지원하지 않는 legacy host 작업입니다.");
      }
      return relay({ target: input.target, relay: input.relay, request });
    },
  };

  const qa = {
    anchorUpdate: ({ identity, input, request }) => relay({ target: null,
      relay: { command: "qa.anchor", args: { ...input, run: input.runId }, timeoutMs: 10000 }, request }),
    tabCreate: async ({ identity, input }) => {
      const result = await createQaEntry(identity.session, input.url, identity.run);
      if (result?.ok) mutationRevision += 1;
      return result;
    },
    tabsRestore: async ({ identity, input }) => {
      const result = await restoreQaTabs(identity.session, input.tabs || [], identity.run);
      if (result?.ok) mutationRevision += 1;
      return result;
    },
    tabClose: async ({ identity, input }) => {
      const tabId = String(input.tabId || "");
      if (!releaseQaTabIfOwner(tabId, identity.run).released) throw hostError("RUN_DENIED", "QA 탭 소유권이 다릅니다.");
      if (!closeBrowserTab(tabId)) throw hostError("STALE_TARGET", "QA 탭을 닫지 못했습니다.");
      mutationRevision += 1;
      return { closed: true, tabId, stateRevision: stateRevision(identity.session) };
    },
    tabsPublish: ({ identity }) => {
      publishQaTabs();
      return { stateRevision: stateRevision(identity.session) };
    },
    deviceAuthorize: async ({ identity, input }) => {
      const target = String(input.device || "");
      const claimed = claimQaTabIfFree(`device:${target}`, identity.run);
      if (!claimed.claimed && claimed.owner !== identity.run) throw hostError("QA_OWNED", "다른 QA 회차가 소유한 기기입니다.");
      mutationRevision += 1;
      return { device: target, owner: identity.run, stateRevision: appTargetsRevision() };
    },
    reportOpen: ({ identity, input }) => openQaReport(identity.session, input.url),
  };

  const app = {
    command: async ({ identity, input }) => {
      const target = input.device ? `device:${input.device}` : null;
      const owner = target ? qaOwner(target) : null;
      if (owner && owner !== identity.run) throw hostError("QA_OWNED", "다른 QA 회차가 소유한 기기입니다.");
      const command = ({ list: "app-devices", viewport: "app-viewport", open: "app-open", picks: "app-picks" })[input.command];
      if (!command) throw hostError("INVALID_REQUEST", "지원하지 않는 앱 명령입니다.");
      return input.qa === true
        ? runQaAppCommand(command, input.args || input, identity.session)
        : runBrowserCmd(command, input.args || input, identity.session);
    },
    afterTargetsSet: ({ session, devices }) => { askEmulator("release", { owner: session, keep: devices }, 3000).catch(() => {}); },
  };

  const journal = {
    captureFrame: async ({ token, input, options, request }) => {
      const identity = { session: token.session, run: token.run };
      const target = await resolveForCommand(identity, { tabRef: options.tab });
      return legacyHostTask({ target, relay: { command: "screenshot", args: options, timeoutMs: 30000 }, request });
    },
  };

  return { browser, qa, app, journal, dialog, stateRevision };
}
