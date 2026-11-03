// QA 입력·로그인·화면 크기·QA 모드 명령의 worker 처리기 · 옛 cdp-control.cjs cdpExecRaw·cdpExecInner 순서를 기본 명령으로 옮김
// 입력 본문은 qa-input-commands.js 사본으로 그대로 실행 · 로그인은 비밀 원문이 worker 에 오지 않도록 메인 안에서 값을 읽고 넣음
// 화면 크기·QA 모드의 상태는 메인에 있고(QA 탭 집합·기기 에뮬레이션) worker 는 viewport.qa·qa.mode 로 부름
import { randomUUID } from "node:crypto";

import { createQaInputCommands } from "./qa-input-commands.js";
import { createReactionIo } from "./qa-observe-route.js";
import { inIsolatedWorld, inspectLoginPage } from "./qa-login-page.js";
import { StepFailed, StepStopped, codedError, createStepKit, failure } from "./step-kit.js";

export const QA_COMMAND_NAMES = Object.freeze(["qa-input", "qa-select-resolve", "qa-locate", "qa-focused",
  "qa-login-info", "qa-login-input", "qa-viewport", "qa-viewport-state", "qa-mode"]);

// 옛 cdp-control.cjs READ_ONLY_CMDS · NEEDS_KEYS 중 옮긴 명령 · QA 명령은 cdp-observation.cjs ANIMATES 에 없음
const READ_ONLY = new Set(["qa-login-info", "qa-select-resolve", "qa-viewport-state"]);
const NEEDS_KEYS = new Set(["qa-input", "qa-login-input"]);
// 옛 값과의 대조용 (test/mcp-worker-qa-input-route.mjs)
export const QA_TRAITS = Object.freeze({ READ_ONLY, NEEDS_KEYS });

// 로그인 입력의 비밀 자리표시 · 한 글자라 Input.insertText 한 번 · 탭 char 키 한 번으로 바뀜 (실제 값은 메인 login.input 이 넣음)
const SECRET_SENTINEL = "";
const BINDING_METHOD = "Runtime.bindingCalled";

// 이름이 qa-mode 이고 enabled 가 false 이면 해제 단위 · 확인 창이 떠 있어도 host 가 통과시킴 (이름은 host 와 같은 값)
export function qaUnitCommand(command, args) {
  return command === "qa-mode" && args?.enabled === false ? "qa-mode-off" : command;
}

async function execute(cmd, args, base, context = {}) {
  const kit = createStepKit(base);
  const { rawCall, step, send, redacted, hold, refreshFrames } = kit;
  let shown = false; // 옛 isTabShown 은 동기 · 가장 최근 focus.state 의 shown 을 씀 (모르면 안 보이는 쪽)
  let secret = null; // qa-login-input 의 메인 입력 호출

  const focusState = async () => {
    const state = await kit.focusState();
    shown = state?.shown === true;
    return state;
  };

  // 입력 수신 기록용 이벤트 · 옛 wc.debugger.on("message") 를 메인 구독 이벤트로 대신함
  const listeners = new Set();
  let subscriptionId = null;
  let stopEvents = null;
  const eventful = typeof context.onRelayEvent === "function";
  async function openEvents() {
    if (!eventful) return;
    subscriptionId = `qa-in-${randomUUID()}`;
    stopEvents = context.onRelayEvent((event) => {
      if (event?.subscriptionId !== subscriptionId || event.error) return;
      for (const listener of [...listeners]) listener(null, event.method, event.params, event.childSessionId);
    });
    // scoped: 단위가 막혀 닫혀도 메인이 구독을 거둠
    await step("cdp.subscribe", { subscriptionId, methods: [BINDING_METHOD], scoped: true });
  }
  async function closeEvents() {
    if (!subscriptionId) return;
    try { stopEvents?.(); } catch {}
    const id = subscriptionId;
    subscriptionId = null;
    if (kit.blocked()) return;
    try { await rawCall("cdp.unsubscribe", { subscriptionId: id }); } catch {}
  }

  // 옛 wc.sendInputEvent 는 동기 · 순서를 지키는 대기열로 보내고 다음 CDP 호출 전에 끝나기를 기다림
  let pendingInput = Promise.resolve();
  let inputFailure = null;
  const queueInput = (task) => { pendingInput = pendingInput.then(task).catch((error) => { inputFailure = inputFailure || error; }); };
  const flushInput = async () => {
    await pendingInput;
    if (inputFailure) { const error = inputFailure; inputFailure = null; throw error; }
  };
  const wc = {
    id: null,
    ...(eventful ? { debugger: {
      on: (_name, listener) => { listeners.add(listener); },
      removeListener: (_name, listener) => { listeners.delete(listener); },
    } } : {}),
    sendInputEvent(event) {
      if (secret && event?.keyCode === SECRET_SENTINEL) queueInput(() => secret.insert("chars"));
      else queueInput(() => step("wc.input", { event }));
    },
  };
  const inputSend = (() => {
    const call = async (method, params, sid) => {
      await flushInput();
      if (secret && !sid && method === "Input.insertText" && params?.text === SECRET_SENTINEL) { await secret.insert("cdp"); return {}; }
      return (sid ? send.on(sid) : send)(method, params);
    };
    const wrapped = (method, params) => call(method, params, null);
    wrapped.on = (sid) => (method, params) => call(method, params, sid);
    wrapped.frames = send.frames;
    wrapped.ask = send.ask;
    wrapped.all = send.all;
    return wrapped;
  })();

  const inputCommands = createQaInputCommands({
    prepareFocus: async () => (await step("focus.prepare", {})).state,
    returnFocus: async () => (await step("focus.return", {})).state,
    isTabShown: () => shown,
  });

  const inspect = (inspectSend) => inIsolatedWorld(inspectSend, `(${inspectLoginPage.toString()})()`);
  const qaAccounts = async (approved) => await step("login.accounts", { qa: true, approved });

  const bodies = {
    "qa-select-resolve": (bodyArgs) => inputCommands["qa-select-resolve"](send, wc, bodyArgs),
    "qa-locate": (bodyArgs) => inputCommands["qa-locate"](send, wc, bodyArgs),
    "qa-focused": () => inputCommands["qa-focused"](send),
    "qa-input": (bodyArgs) => inputCommands["qa-input"](inputSend, wc, bodyArgs),
    // 옛 cdp-qa-viewport.cjs: 상태는 메인(기기 에뮬레이션)에 있고 읽기만 함
    async "qa-viewport-state"() {
      const state = await step("viewport.get", {});
      return { ok: true, viewport: state.current ?? null };
    },
    async "qa-viewport"(bodyArgs) { return await step("viewport.qa", bodyArgs); },
    // 옛 setQaMode: 해제는 이 탭의 반응 관찰을 먼저 정리 (심은 스크립트·바인딩·구독) · 관찰 상태가 worker 에 있음
    async "qa-mode"(bodyArgs) {
      if (bodyArgs.enabled !== true && context.reactions) await context.reactions.dispose(context.tab, send, createReactionIo(kit, context));
      return await step("qa.mode", { enabled: bodyArgs.enabled === true });
    },
    // 옛 cdp-qa-login.cjs qa-login-info
    async "qa-login-info"(bodyArgs) {
      const page = await inspect(send);
      const { origin, accounts, unavailable } = await qaAccounts(false);
      const publicAccounts = [...accounts, ...unavailable].map(({ id, username, allowed, local }) => ({ id, username, allowed: allowed === true, local: local === true }));
      const candidates = bodyArgs.account ? publicAccounts.filter((account) => account.id === bodyArgs.account || account.username === bodyArgs.account) : publicAccounts;
      const selected = candidates.length === 1 ? candidates[0] : null;
      return { ok: true, origin, accounts: publicAccounts, fields: page.fields, selectedAccount: selected?.id || null,
        sensitive: page.reasons.length > 0,
        humanRequired: page.reasons.length > 0 || !publicAccounts.length || page.fields.length !== 2,
        reason: page.reasons.join(" · ") || (!publicAccounts.length ? "사용 가능한 저장 계정이나 로컬 테스트 계정이 없습니다" : page.fields.length !== 2 ? "로그인 칸을 하나로 확인하지 못했습니다" : null),
        choose: !selected && publicAccounts.length > 1 };
    },
    // 옛 cdp-qa-login.cjs qa-login-input · 계정 확인 → 칸 확인 → 입력값 확인 → qa-input 의 type 순서
    async "qa-login-input"(bodyArgs) {
      if (!["username", "password"].includes(bodyArgs.field)) throw new Error("로그인 필드가 올바르지 않습니다");
      const approved = bodyArgs.approved === true;
      const { origin, accounts } = await qaAccounts(approved);
      if (origin !== bodyArgs.origin) throw new Error("로그인 승인 후 출처가 바뀌었습니다");
      const account = accounts.find((entry) => entry.id === bodyArgs.accountId);
      if (!account || (account.allowed !== true && bodyArgs.approved !== true)) throw new Error("허용된 로그인 계정이 아닙니다");
      const verify = async () => {
        const info = await step("wc.info", {});
        if (new URL(info.url).origin !== origin) throw new Error("로그인 입력 전 출처가 바뀌었습니다");
        const page = await inspect(send);
        if (page.reasons.length) throw new Error("결제·본인확인·캡차는 사람이 처리해야 합니다");
        const field = page.fields.find((entry) => entry.field === bodyArgs.field);
        if (!field || Math.abs(field.x - bodyArgs.x) > 1 || Math.abs(field.y - bodyArgs.y) > 1) throw new Error("로그인 칸이 바뀌었습니다");
        const valid = await inIsolatedWorld(send, `(() => { const e = document.elementFromPoint(${JSON.stringify(bodyArgs.x)},${JSON.stringify(bodyArgs.y)}); return !!e && e === document.activeElement && e.localName === 'input' && ${bodyArgs.field === "password" ? "e.type === 'password'" : "e.type !== 'password'"} && !e.value; })()`);
        if (valid !== true) throw new Error("비어 있는 로그인 칸에 포커스가 필요합니다");
      };
      await verify();
      // 값은 메인에만 있음 · 비어 있으면 입력 전에 실패 (옛 text 검사 자리)
      const checked = await step("login.input", { qa: "check", accountId: account.id, origin, field: bodyArgs.field, approved });
      secret = { insert: (mode) => step("login.input", { qa: mode, accountId: account.id, origin, field: bodyArgs.field, approved }) };
      let result;
      try { result = await inputCommands["qa-input"](inputSend, wc, { action: "type", text: SECRET_SENTINEL, verifyBeforeInput: verify }); }
      catch { throw new Error("QA 로그인 입력 실패"); }
      return { ...result, accountId: account.id, field: bodyArgs.field, length: checked.length };
    },
  };

  // 옛 cdpExecInner · QA 탭은 호스트 확대 보정 준비(메인 viewport.ensureReady 가 옛 ensureQaReady 와 같음)
  async function runWithCdp() {
    await step("viewport.ensureReady", { command: cmd });
    let held = false;
    if (NEEDS_KEYS.has(cmd)) {
      const state = await focusState();
      // 그림이 나와야 키가 도달함 · 보이는 탭인지보다 먼저 창 상태를 따짐 (순서가 바뀌면 검사가 우회됨)
      if (state?.paint && !state.paint.ok) {
        throw codedError("window_not_drawing",
          `이 탭을 담은 창이 ${state.paint.why} 상태라 화면을 그리지 않습니다 — ${cmd} 를 보내도 도달하지 않습니다.`
          + " 창을 띄워 달라고 사람에게 부탁하고 다시 하세요(browser_ask_user).");
      }
      if (!shown) {
        try { held = await hold(true); }
        catch (error) { if (error instanceof StepStopped) throw error; held = false; }
      }
      await refreshFrames();
      await openEvents();
    }
    try {
      return await bodies[cmd](args);
    } finally {
      await closeEvents();
      if (held && !kit.blocked()) { try { await hold(false); } catch {} }
    }
  }

  async function inner() {
    // 옛 cdpExecRaw: 로그인 호스트 판정(CDP_FREE 가 아닌 QA 명령은 막힘) · 붙임 · AI 표식
    await step("cdp.gate", { command: cmd });
    let ticket = null;
    if (!READ_ONLY.has(cmd)) ticket = (await step("ai.enter", {})).ticket;
    try { return await runWithCdp(); }
    finally {
      if (ticket && !kit.blocked()) { try { await rawCall("ai.leave", { ticket }); } catch {} }
    }
  }

  let succeeded = false;
  let outcome;
  try {
    outcome = { ok: true, data: await inner() };
    succeeded = true;
  } catch (error) {
    if (error instanceof StepStopped) return kit.blocked();
    outcome = error instanceof StepFailed ? error.response : failure(error);
  }
  if (kit.blocked()) return kit.blocked();
  // 성공이면 가리기 호출이 마지막 · 실패면 관찰 순간을 비우지 않음 (옛 경로도 실패 때는 비우지 않음)
  try { return await redacted(outcome, succeeded); }
  catch (error) { if (error instanceof StepStopped) return kit.blocked(); throw error; }
}

export const QA_HANDLERS = Object.freeze(Object.fromEntries(
  QA_COMMAND_NAMES.map((cmd) => [cmd, ({ args, base, ...context }) => execute(cmd, args || {}, base, context)])));
