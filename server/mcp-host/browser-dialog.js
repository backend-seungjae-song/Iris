import crypto from "node:crypto";

import { hostError } from "./errors.js";

const sourceText = (dialog) => dialog && typeof dialog.full === "string"
  ? dialog.full : String(dialog?.message || "");
const canonical = (value) => {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
};
export const sameTargetToken = (left, right) => canonical(left) === canonical(right);
const commandKey = (request, input) => `${request.commandId}:${request.callId}:${crypto.createHash("sha256")
  .update(JSON.stringify(input)).digest("hex")}`;

async function maskedDialog(dialog, redact, answerTool, target, request) {
  const kind = String(dialog?.kind || "alert");
  let message = null;
  try {
    const result = await redact(sourceText(dialog), target, request);
    message = typeof result === "string" ? result : result?.text;
  } catch {}
  const safe = typeof message === "string"
    ? message.slice(0, 200) : "(확인 창 문구를 가리지 못해 뺐습니다)";
  return {
    ok: false,
    dialogOpen: { kind, message: safe },
    error: `페이지의 확인 창(${kind})이 떠 있어 이 탭이 멈췄습니다: "${safe}". ${answerTool}로 answer "ok" 또는 "cancel"을 보내 닫은 뒤 이어 가세요.`,
  };
}

export function createBrowserDialogHost({
  resolveForCommand,
  ownerOf = () => null,
  markControl = () => {},
  execute,
  raceDialog,
  currentDialog = () => null,
  answerIntercepted = () => null,
  answerExecutor,
  clearDialog = () => {},
  redact,
  serial = null,
  unitIdleMs = 35000,
}) {
  if (typeof resolveForCommand !== "function" || typeof execute !== "function"
      || typeof raceDialog !== "function" || typeof redact !== "function") {
    throw new Error("browser dialog host port가 빠졌습니다");
  }
  const commands = new Map();

  async function resolve(identity, input) {
    const target = await resolveForCommand(identity, input);
    if (!target || target.tabId !== input.tabId) throw hostError("STALE_TARGET", "현재 탭 대상이 아닙니다.");
    if (!sameTargetToken(target.targetToken, input.targetToken)) throw hostError("STALE_TARGET", "현재 문서 세대의 target token이 아닙니다.");
    const owner = ownerOf(target.tabId);
    if (owner && owner !== identity.run) throw hostError("QA_OWNED", "다른 QA 회차가 소유한 탭입니다.");
    return target;
  }

  // 명령 단위(relay.unit)의 탭 잠금 보유자 · 첫 호출이 잠금을 얻어 last·end·유휴 만료까지 쥠
  // 같은 commandId 의 호출은 잠금 없이 실행하고 다른 명령은 그 잠금 뒤에 섬
  const unitHolds = new Map();
  const tabLockKey = (input) => `tab:${input?.tabId ?? input?.tabRef ?? input?.tab ?? "unknown"}`;

  function armUnitHold(hold) {
    clearTimeout(hold.timer);
    hold.timer = setTimeout(() => hold.release(), unitIdleMs);
    hold.timer.unref?.();
  }

  function startUnitHold(lockKey, commandId) {
    return new Promise((resolveHold, rejectHold) => {
      const hold = { lockKey, commandId, timer: null, released: false };
      const done = new Promise((resolve) => { hold.release = () => { hold.released = true; clearTimeout(hold.timer); resolve(); }; });
      serial.run([lockKey], async () => {
        unitHolds.set(lockKey, hold);
        armUnitHold(hold);
        resolveHold(hold);
        await done;
        if (unitHolds.get(lockKey) === hold) unitHolds.delete(lockKey);
      }).catch(rejectHold);
    });
  }

  async function executeUnitCall(ctx) {
    const { input, request } = ctx;
    const phase = input.relay.unit.phase;
    const lockKey = tabLockKey(input);
    let hold = unitHolds.get(lockKey);
    if (!hold || hold.commandId !== request.commandId) {
      // 끝난 단위의 명시 종료는 잠금 없이 전달 (메인 쪽 해제만 남음)
      if (phase === "end") return executeOne(ctx);
      hold = await startUnitHold(lockKey, request.commandId);
    }
    clearTimeout(hold.timer);
    try { return await executeOne(ctx); }
    finally {
      if (phase === "last" || phase === "end") hold.release();
      else if (!hold.released) armUnitHold(hold);
    }
  }

  // outside 단위는 탭 잠금을 쥐지도 기다리지도 않음 · 확인 창을 푸는 명령이라 막힌 단위 뒤에 서면 안 됨 (옛 eb90977 은 탭 잠금 없이 Electron QUEUE_BYPASS 로 바로 실행)
  function executeWithDialog(ctx) {
    const unit = ctx.input?.relay?.unit;
    if (serial && unit && unit.outside !== true) return executeUnitCall(ctx);
    return executeOne(ctx);
  }

  async function executeOne({ identity, input, request }) {
    const key = commandKey(request, input);
    const prior = commands.get(key);
    if (prior) {
      if (prior.tabId !== input.tabId) throw hostError("COMMAND_INDETERMINATE", "같은 명령 ID가 다른 탭을 가리킵니다.");
      if (prior.state === "completed") return { ...prior.result, commandState: "completed" };
      if (prior.dialog) return { ...prior.dialog, commandState: "running" };
      return { commandState: "running" };
    }

    const target = await resolve(identity, input);
    markControl(target.tabId, input.controlLabel || identity.session);
    const open = currentDialog(target);
    const answerTool = input.answerTool || (identity.run ? "qa_dialog" : "browser_dialog");
    const relayCommand = input.relay?.command || input.command;
    const relayArgs = input.relay?.args || input.args || {};
    // qa-mode 는 회차 종료의 해제만 통과. 켜기는 창이 열린 동안 Chromium 이 응답하지 않음(eb90977 qa-channel)
    // 단위 명시 종료는 확인 창이 떠 있어도 통과 (막히면 탭 대기열이 시간 초과까지 잠김)
    // dialogs 는 worker 처리기가 여러 기본 명령을 부르므로 단위의 사용자 명령 이름으로도 통과 (옛 browser-commands.js 가 dialog·dialogs 만 통과시킴)
    // redact 는 열린 확인 창 문구를 가리는 단위, qa-mode-off 는 qa-mode 해제 단위 (켜기는 qa-mode 라 계속 막힘)
    const bypassDialogGate = ["dialog", "dialogs", "dialog.answer", "dialog.plan"].includes(relayCommand)
      || ["dialog", "dialogs", "redact", "qa-mode-off"].includes(input.relay?.unit?.command)
      || input.relay?.unit?.phase === "end"
      || (relayCommand === "qa-mode" && relayArgs.enabled === false);
    if (open && !bypassDialogGate) return { ...(await maskedDialog(open, redact, answerTool, target, request)), commandState: "blocked" };

    const entry = { tabId: target.tabId, state: "running", dialog: null, result: null };
    commands.set(key, entry);
    while (commands.size > 2000) {
      const completed = [...commands].find(([, value]) => value.state === "completed");
      if (!completed) break;
      commands.delete(completed[0]);
    }
    const pending = Promise.resolve().then(() => execute(target, input, request));
    pending.then((result) => {
      entry.state = "completed";
      entry.result = result;
    }, (error) => {
      entry.state = "completed";
      entry.result = { ok: false, error: String(error?.message || error) };
    });

    const first = bypassDialogGate ? await pending : await raceDialog(target, pending, answerTool);
    if (first?.dialogOpen) {
      entry.dialog = await maskedDialog(first.dialogOpen, redact, answerTool, target, request);
      return { ...entry.dialog, commandState: "running" };
    }
    entry.state = "completed";
    entry.result = first;
    return { ...first, commandState: "completed" };
  }

  async function dialogAnswer({ identity, input, request }) {
    const target = await resolve(identity, input);
    markControl(target.tabId, input.controlLabel || (identity.run ? "iris-qa" : identity.session));
    const answer = input.answer === "ok" ? "ok" : "cancel";
    const clearTrackedDialog = () => {
      for (const entry of commands.values()) if (entry.tabId === target.tabId && entry.state === "running") entry.dialog = null;
    };
    const intercepted = answerIntercepted(target, answer, input.text);
    if (intercepted) {
      const safe = await maskedDialog(intercepted, redact, input.answerTool || "browser_dialog", target, request);
      clearTrackedDialog();
      clearDialog(target);
      return { ok: true, data: input.qa === true
        ? { ...safe.dialogOpen, via: "intercepted" }
        : { answered: answer, ...safe.dialogOpen, via: "intercepted" } };
    }
    if (typeof answerExecutor !== "function") throw hostError("EXECUTOR_GONE", "확인 창 실행기가 연결되지 않았습니다.");
    const result = await answerExecutor(target, answer, input.text, request);
    if (!result) throw hostError("EXECUTOR_GONE", "확인 창 실행기가 응답하지 않았습니다.");
    if (result.ok === false) return result;
    clearTrackedDialog();
    clearDialog(target);
    return result;
  }

  const commandState = (commandId) => commands.get(commandId)
    || [...commands.entries()].find(([key]) => key.startsWith(`${commandId}:`))?.[1] || null;
  return { executeWithDialog, dialogAnswer, commandState };
}
