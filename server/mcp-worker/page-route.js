// 페이지·읽기·캡처 MCP 명령의 worker 처리기 · 옛 cdp-control.cjs cdpExecRaw·cdpExecInner 순서를 기본 명령으로 옮김
// 본문은 사본으로 그대로 실행: inspect-commands.js(eval·locate·text·observe) · capture-commands.js(diff·screenshot·pdf·shotsizes)
// 페이지 이동 6개는 옛 cdp-cmd-page.cjs 의 조건·문구를 기본 명령으로 옮긴 본문이 이 파일에 있음
import fs from "node:fs";
import path from "node:path";

import { artifactDir } from "../artifacts-home.cjs";
import { createCaptureCommands } from "./capture-commands.js";
import { createWorkerCaptureTools } from "./capture-tools.js";
import { DRAW_MARKS } from "./draw-marks.js";
import { createInspectCommands } from "./inspect-commands.js";
import { withLayout } from "./layout.js";
import { humanHint, loginHint } from "./page-hints.js";
import { settleAnimations } from "./settle.js";
import { StepFailed, StepStopped, codedError, createStepKit, failure } from "./step-kit.js";

// expect 는 일반 MCP 에서 막힌 QA 전용 명령(qa-command-contract.js)이라 여기에 없음 · iris-qa 가 옛 처리기를 계속 씀
export const PAGE_COMMAND_NAMES = Object.freeze(["goto", "wait", "back", "forward", "reload", "viewport",
  "eval", "locate", "text", "observe", "diff", "screenshot", "pdf", "shotsizes"]);

// 옛 cdp-control.cjs READ_ONLY_CMDS 중 옮긴 명령 · 페이지를 건드리지 않아 AI 표식을 달지 않음
const READ_ONLY = new Set(["text", "shotsizes", "screenshot", "diff", "locate", "observe"]);
// 옛 cdp-control.cjs NEEDS_PIXELS · cdp-observation.cjs ANIMATES 중 옮긴 명령
const NEEDS_PIXELS = new Set(["screenshot"]);
const ANIMATES = new Set(["goto", "back", "forward", "reload"]);
// send.all 로 프레임마다 묻는 처리기 · 실행 전에 프레임 목록을 읽음
const WITH_FRAMES = new Set(["text", "locate"]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 옛 cdp-control.cjs gotoTarget 과 cdp-cmd-page.cjs goto 가 같은 규칙으로 스킴을 붙임
function withScheme(url) {
  const hasScheme = /^(https?|data|about|blob|file):/i.test(url) || /^[a-z][a-z0-9+.-]*:\/\//i.test(url);
  return hasScheme ? url : "https://" + url;
}

const READY_PARAMS = { expression: "document.readyState", returnByValue: true };

async function execute(cmd, args, base, options = {}) {
  const kit = createStepKit(base);
  const { rawCall, step, sender, send, refreshFrames, redacted, focusState, hold } = kit;
  const shotsDir = options.shotsDir ? options.shotsDir() : artifactDir("shots");
  let info = null; // 처리기가 동기로 읽는 wc.getURL·getTitle 의 값 · 필요한 때 다시 읽음
  let pendingReset = Promise.resolve();

  const loadInfo = async () => { info = await step("wc.info", {}); };
  // 옛 처리기가 쓰는 webContents 의 일부 · 나머지는 기본 명령
  const wc = {
    id: null,
    getURL: () => info?.url ?? "",
    getTitle: () => info?.title ?? "",
    async capturePage(rect) {
      await pendingReset;
      const data = await step("wc.capture", rect ? { rect } : {});
      const png = Buffer.from(data.data, "base64");
      return { toPNG: () => png };
    },
    async printToPDF(printOptions) {
      const data = await step("wc.pdf", { options: printOptions });
      const buffer = Buffer.from(data.data, "base64");
      await loadInfo();
      return buffer;
    },
  };

  // withLayout 이 거는 임시 layout 은 표시를 달아 보냄 · 메인이 단위가 닫힐 때 못 지운 것만 반환 (크기와 무관)
  const layoutSend = sender(null, { temporaryLayout: true });
  const markedLayoutSend = (innerSend) => (method, params) => (
    /^Emulation\.(set|clear)DeviceMetricsOverride$/.test(method) ? layoutSend(method, params) : innerSend(method, params));

  const tools = createWorkerCaptureTools({
    fs, path,
    resolveRef: async (ref) => {
      const response = await rawCall("ref.resolve", { ref });
      if (!response.ok) throw response.code ? codedError(response.code, response.error) : new Error(response.error);
      return response.data;
    },
    composeTiles: async (tiles, width, height, px) => Buffer.from((await step("img.stitch", { tiles, W: width, H: height, px })).data, "base64"),
  });

  let clearAfterObserve = false;
  let observed = null;
  let downloads = null;
  const inspect = createInspectCommands({
    buildSnapshot: null,
    refRegistry: null,
    loginHint,
    humanHint,
    observation: { observe: () => observed, clearDiagnostics: () => { clearAfterObserve = true; } },
    downloadState: { snapshot: () => downloads },
    cdpExecRaw: (_mod, _id, nestedCmd, nestedArgs) => nested(nestedCmd, nestedArgs),
    webContentsMod: () => ({}),
    fs,
    path,
    shotsDir,
  });
  const capture = createCaptureCommands({
    withLayout: (layoutArg, fn) => withLayout(markedLayoutSend(layoutArg), fn),
    rectOf: tools.rectOf,
    readZoom: tools.readZoom,
    setZoom: tools.setZoom,
    DRAW_MARKS,
    viewportClip: tools.viewportClip,
    waitRenderIdle: tools.waitRenderIdle,
    captureHold: (_wcId, on) => hold(on),
    stitchFullPage: tools.stitchFullPage,
    screencastShot: async (_wc, ms) => Buffer.from((await step("cdp.screencastShot", { ms })).data, "base64"),
    // 옛 처리기는 기다리지 않고 부름 · 뒤따르는 capturePage 가 끝나기를 기다림
    resetCdpSession: () => { pendingReset = step("cdp.reset", {}).catch(() => {}); },
    pruneShots: tools.pruneShots,
    diffPng: (before, after, out, threshold) => step("img.diff", { before: path.resolve(before), after: path.resolve(after),
      out: path.resolve(out), threshold }),
    samePng: async (prev, png) => (await step("img.same", { prev: path.resolve(prev), data: png.toString("base64") })).same === true,
    deviceEmulation: { apply: async (_wc, viewportArgs) => (await step("viewport.apply", viewportArgs)) },
    cdpExecRaw: (_mod, _id, nestedCmd, nestedArgs) => nested(nestedCmd, nestedArgs),
    webContentsMod: () => ({}),
    fs,
    path,
    shotsDir,
  });

  // 옛 cdp-cmd-page.cjs · cdp-control.cjs runWithoutCdp 의 페이지 본문
  const pageBodies = {
    async goto(bodyArgs) {
      const url = bodyArgs.url; if (!url) throw new Error("url 필요");
      const done = await step("wc.nav", { action: "load", url: withScheme(url) });
      return { ok: true, url: done.url };
    },
    async wait(bodyArgs) {
      // 로드 완료 대기: readyState==='complete' 폴링(기본 최대 10s). wait <ms>=고정 대기.
      if (bodyArgs.ms != null) { await sleep(Math.max(0, Number(bodyArgs.ms))); return { ok: true, waited_ms: Number(bodyArgs.ms) }; }
      const timeout = 10000, start = Date.now(); // Date.now: 런타임 코드(워크플로우 스크립트 아님)라 허용
      // 명령 도중 문서가 바뀌면(이동 완료) 세대가 달라진 뒤 한 번 다시 맞추고 계속 기다림
      const ready = async () => {
        let response = await rawCall("cdp.send", { method: "Runtime.evaluate", params: READY_PARAMS });
        if (!response.ok && response.code === "STALE_TARGET") {
          await step("cdp.sync", {});
          response = await rawCall("cdp.send", { method: "Runtime.evaluate", params: READY_PARAMS });
        }
        if (!response.ok) throw new Error(response.error);
        return response.data;
      };
      for (;;) {
        const r = await ready();
        if (r.result && r.result.value === "complete") return { ok: true, readyState: "complete", waited_ms: Date.now() - start };
        if (Date.now() - start >= timeout) return { ok: true, readyState: String(r.result && r.result.value), waited_ms: timeout, note: "timeout" };
        await sleep(150);
      }
    },
    async back() { return await moveHistory("back"); },
    async forward() { return await moveHistory("forward"); },
    async reload() {
      const done = await step("wc.nav", { action: "reload" });
      return { ok: true, url: done.url };
    },
    // 탭 화면 크기 지정. 주소줄의 크기 버튼과 같은 동작이다(반응형 확인).
    async viewport(bodyArgs) { return await step("viewport.apply", bodyArgs); },
  };
  async function moveHistory(dir) {
    const moved = await step("wc.navHistory", { dir });
    if (!moved.moved) return { ok: false, error: (dir === "back" ? "뒤로" : "앞으로") + " 갈 기록이 없습니다." };
    return { ok: true, url: moved.url };
  }

  const bodies = {
    ...pageBodies,
    async eval(bodyArgs) { return await inspect.eval(send, wc, bodyArgs); },
    async locate(bodyArgs) { return await inspect.locate(send, wc, bodyArgs); },
    async text() { return await inspect.text(send); },
    async observe(bodyArgs) {
      // 옛 observe 는 처음에 진단 버퍼와 다운로드 상태를 읽음 · 처리기가 동기로 읽으므로 먼저 받아 둠
      const level = bodyArgs.level || "error";
      const limit = Math.max(1, Number(bodyArgs.limit) || 40);
      downloads = await step("download.state", {});
      observed = await step("obs.read", { level, limit });
      await loadInfo();
      const out = await inspect.observe(send, wc, bodyArgs);
      if (clearAfterObserve) await step("obs.clear", {});
      return out;
    },
    async diff(bodyArgs) { return await capture.diff(send, wc, bodyArgs); },
    async screenshot(bodyArgs) { await loadInfo(); return await capture.screenshot(send, wc, bodyArgs); },
    async pdf(bodyArgs) { await loadInfo(); return await capture.pdf(send, wc, bodyArgs); },
    async shotsizes(bodyArgs) { await loadInfo(); return await capture.shotsizes(send, wc, bodyArgs); },
  };

  // 옛 cdp-control.cjs screenshotWithoutCdp · waitWithoutCdp · runWithoutCdp 의 text
  async function runWithoutCdp(runCmd, runArgs) {
    if (runCmd === "wait") {
      if (runArgs.ms != null) {
        await sleep(Math.max(0, Number(runArgs.ms)));
        return { ok: true, waited_ms: Number(runArgs.ms) };
      }
      const timeout = 10000, start = Date.now();
      for (;;) {
        const response = await rawCall("wc.info", {});
        const loading = response.ok && response.data?.loading === true;
        if (!loading) return { ok: true, readyState: "complete", waited_ms: Date.now() - start, via: "nocdp" };
        if (Date.now() - start >= timeout) return { ok: true, readyState: "loading", waited_ms: timeout, note: "timeout", via: "nocdp" };
        await sleep(150);
      }
    }
    if (runCmd === "text") {
      const response = await rawCall("wc.exec", { source: "document.body ? document.body.innerText : ''", userGesture: true });
      const text = response.ok ? response.data : "";
      return { text: String(text || ""), via: "nocdp" };
    }
    if (runCmd === "screenshot") {
      const png = (await wc.capturePage()).toPNG();
      fs.mkdirSync(shotsDir, { recursive: true });
      if (!runArgs.path) tools.pruneShots(shotsDir);
      const p = runArgs.path ? String(runArgs.path) : path.join(shotsDir, "shot-" + Date.now() + ".png");
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, png);
      await loadInfo();
      return { ok: true, path: p, url: wc.getURL(), title: wc.getTitle(), via: "capturePage", dpr: 1,
        note: "로그인 호스트라 CDP 없이 창 단위로 찍었습니다(표시·마스킹·전체 페이지 미지원)." };
    }
    return await bodies[runCmd](runArgs);
  }

  // 옛 cdpExecInner
  async function runWithCdp(runCmd, runArgs) {
    await step("viewport.ensureReady", { command: runCmd });
    // 그림이 실제로 있어야 하는 명령만 창 상태를 따짐 · ensureReady 뒤, 보이는 탭인지보다 먼저
    if (NEEDS_PIXELS.has(runCmd)) {
      const state = await focusState();
      if (state?.paint && !state.paint.ok) {
        throw codedError("window_not_drawing",
          `이 탭을 담은 창이 ${state.paint.why} 상태라 화면을 그리지 않습니다 — ${runCmd} 를 보내도 도달하지 않습니다.`
          + " 창을 띄워 달라고 사람에게 부탁하고 다시 하세요(browser_ask_user).");
      }
    }
    const wantsFrames = ANIMATES.has(runCmd);
    let held = false;
    if (wantsFrames) {
      const state = await focusState();
      if (state?.shown !== true) {
        try { held = await hold(true); }
        catch (error) { if (error instanceof StepStopped) throw error; held = false; }
      }
    }
    try {
      if (WITH_FRAMES.has(runCmd)) await refreshFrames();
      const out = await bodies[runCmd](runArgs);
      // 조작이 시작시킨 트랜지션이 끝날 때까지만 더 붙잡음 · 정지 화면이면 곧바로 해제
      if (held && wantsFrames) await settleAnimations(send);
      return out;
    } finally {
      if (held && !kit.blocked()) { try { await hold(false); } catch {} }
    }
  }

  // 옛 cdpExecRaw 의 로그인 호스트 판정 · 붙임 · AI 표식. 처리기 안의 중첩 호출(shotsizes 의 screenshot)도 같은 단계를 지남
  async function nested(runCmd, runArgs) {
    try { return await inner(runCmd, runArgs || {}); }
    finally { try { await loadInfo(); } catch {} }
  }
  async function inner(runCmd, runArgs) {
    const gate = await step("cdp.gate", { command: runCmd, url: runArgs.url });
    let ticket = null;
    if (!READ_ONLY.has(runCmd)) ticket = (await step("ai.enter", {})).ticket;
    try { return gate.noCdp ? await runWithoutCdp(runCmd, runArgs) : await runWithCdp(runCmd, runArgs); }
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

export const PAGE_HANDLERS = Object.freeze(Object.fromEntries(
  PAGE_COMMAND_NAMES.map((cmd) => [cmd, ({ args, base }) => execute(cmd, args || {}, base)])));
