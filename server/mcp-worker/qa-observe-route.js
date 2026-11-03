// QA 확인·캡처·관찰·반응 명령의 worker 처리기 · 옛 cdp-control.cjs cdpExecRaw·cdpExecInner 순서를 기본 명령으로 옮김
// 본문은 사본으로 그대로 실행: qa-expect-commands.js · qa-capture-commands.js · qa-stability.js · qa-reaction-commands.js
// 반응 상태(qa-reaction-commands.js)는 worker 에 있고 명령 단위를 넘어 산다 · 장면 촬영은 대기열 밖 별도 단위(reactionCapture)
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { artifactDir } from "../artifacts-home.cjs";
import { createQaCaptureCommands } from "./qa-capture-commands.js";
import { createQaExpectCommands } from "./qa-expect-commands.js";
import { StepFailed, StepStopped, codedError, createStepKit, failure } from "./step-kit.js";

export const QA_OBSERVE_COMMAND_NAMES = Object.freeze(["qa-expect", "qa-screenshot", "qa-observe", "qa-settle",
  "qa-reaction-start", "qa-reaction-poll", "qa-reaction-end", "qa-reaction-drain", "qa-target-resolve", "qa-background-observe"]);

// 옛 cdp-control.cjs READ_ONLY_CMDS · NEEDS_PIXELS 중 옮긴 명령 · qa-expect 만 읽기 전용 목록에 없음 · QA 명령은 cdp-observation.cjs ANIMATES 에 없음
const READ_ONLY = new Set(["qa-screenshot", "qa-observe", "qa-settle", "qa-reaction-start", "qa-reaction-poll", "qa-reaction-end",
  "qa-reaction-drain", "qa-target-resolve", "qa-background-observe"]);
const NEEDS_PIXELS = new Set(["qa-screenshot"]);
// 옛 값과의 대조용 (test/mcp-worker-qa-observe-route.mjs)
export const QA_OBSERVE_TRAITS = Object.freeze({ READ_ONLY, NEEDS_PIXELS });

// 반응 관찰이 듣는 CDP 이벤트 · 옛 cdp-qa-reaction.cjs ingest 가 읽는 method 전부
const REACTION_METHODS = Object.freeze(["Runtime.bindingCalled", "Runtime.consoleAPICalled", "Runtime.exceptionThrown", "Log.entryAdded",
  "Network.requestWillBeSent", "Network.responseReceived", "Network.loadingFailed", "Runtime.executionContextsCleared",
  "Page.frameNavigated", "Page.navigatedWithinDocument", "Page.javascriptDialogOpening"]);

// 옛 nativeImage.createFromBuffer(png).getSize() · PNG 머리말(IHDR)의 가로·세로 · PNG 가 아니면 0×0
export function pngSize(png) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.length < 24 || signature.some((byte, index) => png[index] !== byte)) return { width: 0, height: 0 };
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

// 반응 관찰이 쓰는 명령 단위별 연결 · 구독 이벤트는 메인 → 공용 서버 → worker 로 와서 listener 에 전달
export function createReactionIo(kit, context = {}) {
  const { rawCall, step } = kit;
  return {
    async subscribe(listener) {
      if (typeof context.onRelayEvent !== "function") throw new Error("반응 관찰에는 중계 이벤트 수신이 필요합니다.");
      const id = `qa-rx-${randomUUID()}`;
      const stop = context.onRelayEvent((event) => { if (event?.subscriptionId === id) listener(event); });
      try { await step("cdp.subscribe", { subscriptionId: id, methods: REACTION_METHODS }); }
      catch (error) { try { stop(); } catch {} throw error; }
      return { id, stop };
    },
    // 정리 실패(탭 닫힘·확인 창 차단)는 관찰 종료를 막지 않음 · 메인이 worker 세대 은퇴 때 구독을 거둠
    async unsubscribe(subscription) {
      try { subscription.stop(); } catch {}
      if (kit.blocked()) return;
      try { await rawCall("cdp.unsubscribe", { subscriptionId: subscription.id }); } catch {}
    },
    async diagSince(since) { return (await step("obs.since", { since })).diag; },
    capture(captureArgs) {
      if (typeof context.spawnCapture !== "function") return Promise.reject(new Error("반응 장면 촬영 단위를 열 수 없습니다."));
      return context.spawnCapture(captureArgs);
    },
  };
}

// 옛 wc 의 일부 · 처리기가 동기로 읽는 값은 wc.info 로 받아 둠 · id 는 webContents id (결과의 tab·captureTarget 에 나옴)
function createTabShim(step) {
  let info = null;
  const wc = {
    id: null,
    getURL: () => info?.url ?? "",
    getTitle: () => info?.title ?? "",
    getZoomFactor: () => info?.zoom ?? 1,
  };
  const load = async () => {
    info = await step("wc.info", {});
    wc.id = info.wcId;
    return info;
  };
  return { wc, load };
}

// 화면을 찍는 도구 묶음 · 반응 장면(reactionCapture)과 qa-screenshot·qa-observe·qa-expect 가 같이 씀
function createCapture(kit, shotsDir) {
  const { rawCall, step, hold } = kit;
  const redact = async (_id, value) => {
    const response = await rawCall("result.redact", { value });
    if (!response.ok || !response.data || !("value" in response.data)) throw new Error("결과를 안전하게 가리지 못했습니다.");
    return response.data.value;
  };
  const pending = async () => (await step("obs.pending", {})).pending;
  const observation = {
    observe: async (_id, level, limit) => await step("obs.read", { level, limit }),
    pendingRequests: pending,
  };
  return createQaCaptureCommands({
    fs, path, shotsDir,
    nativeImage: { createFromBuffer: (png) => ({ getSize: () => pngSize(png) }) },
    renderImage: async (png, options) => Buffer.from((await step("img.render", { data: png.toString("base64"), options })).data, "base64"),
    captureHold: async (_wcId, on) => await hold(on),
    observation,
    refRegistry: {
      resolveRef: async (_id, ref) => {
        const response = await rawCall("ref.resolve", { ref });
        if (!response.ok) throw response.code ? codedError(response.code, response.error) : new Error(response.error);
        return response.data;
      },
    },
    redact,
  });
}

async function execute(cmd, args, base, context = {}) {
  const kit = createStepKit(base);
  const { rawCall, step, send, redacted, focusState, refreshFrames } = kit;
  const shotsDir = artifactDir("shots");
  const reactionIo = createReactionIo(kit, context);
  const tab = createTabShim(step);
  // 반응 명령의 탭 식별은 호스트 탭 id (상태가 명령 단위를 넘어 살아서 단위마다 같은 값이어야 함)
  const reactionWc = { id: context.tab };

  const capture = createCapture(kit, shotsDir);
  const expectCommands = createQaExpectCommands({ screenshot: (_send, _wc, shotArgs) => nested("qa-screenshot", shotArgs) });

  const bodies = {
    async "qa-expect"(bodyArgs) { await tab.load(); return await expectCommands["qa-expect"](send, tab.wc, bodyArgs); },
    async "qa-screenshot"(bodyArgs) { await tab.load(); return await capture["qa-screenshot"](send, tab.wc, bodyArgs); },
    async "qa-observe"(bodyArgs) { await tab.load(); return await capture["qa-observe"](send, tab.wc, bodyArgs); },
    async "qa-settle"() { await tab.load(); return await capture["qa-settle"](send, tab.wc); },
  };
  const reactionBody = async (reactionCmd, bodyArgs) => {
    if (!context.reactions) throw new Error("반응 관찰 저장소가 없습니다.");
    return await context.reactions[reactionCmd](send, reactionWc, bodyArgs, reactionIo);
  };
  for (const name of ["qa-reaction-start", "qa-reaction-poll", "qa-reaction-end", "qa-reaction-drain", "qa-target-resolve", "qa-background-observe"]) {
    bodies[name] = (bodyArgs) => reactionBody(name, bodyArgs);
  }

  // 옛 cdpExecInner · QA 탭은 호스트 확대 보정 준비 · 그림이 실제로 있어야 하는 명령만 창 상태를 따짐 (보이는 탭인지보다 먼저)
  async function runWithCdp(runCmd, runArgs) {
    await step("viewport.ensureReady", { command: runCmd });
    if (NEEDS_PIXELS.has(runCmd)) {
      const state = await focusState();
      if (state?.paint && !state.paint.ok) {
        throw codedError("window_not_drawing",
          `이 탭을 담은 창이 ${state.paint.why} 상태라 화면을 그리지 않습니다 — ${runCmd} 를 보내도 도달하지 않습니다.`
          + " 창을 띄워 달라고 사람에게 부탁하고 다시 하세요(browser_ask_user).");
      }
    }
    await refreshFrames();
    return await bodies[runCmd](runArgs);
  }

  // 옛 cdpExecRaw 의 로그인 호스트 판정 · 붙임 · AI 표식. qa-expect 안의 촬영(옛 cdpExecRaw 중첩 호출)도 같은 단계를 지남
  async function nested(runCmd, runArgs) {
    try { return await inner(runCmd, runArgs || {}); }
    finally { try { await tab.load(); } catch {} }
  }
  async function inner(runCmd, runArgs) {
    await step("cdp.gate", { command: runCmd });
    let ticket = null;
    if (!READ_ONLY.has(runCmd)) ticket = (await step("ai.enter", {})).ticket;
    try { return await runWithCdp(runCmd, runArgs); }
    finally {
      if (ticket && !kit.blocked()) { try { await rawCall("ai.leave", { ticket }); } catch {} }
    }
  }

  let succeeded = false;
  let outcome;
  try {
    outcome = { ok: true, data: await inner(cmd, args) };
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

export const QA_OBSERVE_HANDLERS = Object.freeze(Object.fromEntries(
  QA_OBSERVE_COMMAND_NAMES.map((cmd) => [cmd, ({ args, base, ...context }) => execute(cmd, args || {}, base, context)])));

// 반응 장면 촬영 · 옛 경로는 이벤트 처리 안에서 qa-screenshot 본문을 대기열 밖에서 바로 불렀음 (관문·준비·창 검사 없음)
// 대기열 밖 단위로 실행하고 단위가 닫히면 메인이 hold 를 반환 · 결과는 qa-screenshot 본문 그대로(오류는 던짐)
export async function reactionCapture({ args, base }) {
  const kit = createStepKit(base);
  const tab = createTabShim(kit.step);
  const capture = createCapture(kit, artifactDir("shots"));
  try {
    await tab.load();
    return await capture["qa-screenshot"](kit.send, tab.wc, args);
  } catch (error) {
    if (error instanceof StepStopped) throw new Error(kit.blocked()?.error || "확인 창이 열려 있어 장면을 찍지 못했습니다");
    if (error instanceof StepFailed) throw new Error(error.message);
    throw error;
  }
}
