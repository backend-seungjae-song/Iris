// 네이티브 MCP 명령(확인 창·업로드·다운로드·로그인·OS 창)의 worker 처리기 · 옛 cdp-cmd-native.cjs 본문과 cdp-control.cjs cdpExecRaw·cdpExecInner 순서를 기본 명령으로 옮김
// 비밀번호 원문은 worker 에 오지 않음: login.fill 이 메인 안에서 채우고 secret 을 지운 결과만 돌려줌
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { settleAnimations } from "./settle.js";
import { StepFailed, StepStopped, createStepKit, failure } from "./step-kit.js";

// dialog 는 worker 의 executeOne 이 browser.dialogAnswer(host 확인 창 연산)로 먼저 가져감 · 이 처리기는 그 안의 Electron 실행(host 작업 위임, host-task-service.js)이 씀
export const NATIVE_COMMAND_NAMES = Object.freeze(["dialog", "dialoginfo", "dialogs", "upload", "download", "login", "nativewin", "nativekey", "nativeclick"]);

// 옛 cdp-control.cjs QUEUE_BYPASS 중 옮긴 명령 · 막힌 명령 뒤에 서면 그것을 푸는 명령까지 갇힘 → 탭 대기열 밖에서 실행
export const OUTSIDE_COMMANDS = Object.freeze(new Set(["dialog", "dialoginfo", "dialogs", "nativewin", "nativekey", "nativeclick"]));

// 옛 cdp-control.cjs READ_ONLY_CMDS · NEEDS_KEYS · cdp-observation.cjs ANIMATES 중 옮긴 명령
const READ_ONLY = new Set(["dialoginfo", "nativewin"]);
const NEEDS_KEYS = new Set(["login"]);
const ANIMATES = new Set(["dialog", "upload", "nativeclick", "nativekey"]);
// 옛 값과의 대조용 (test/mcp-worker-native-route.mjs)
export const NATIVE_TRAITS = Object.freeze({ READ_ONLY, NEEDS_KEYS, ANIMATES });

// 옛 cdp-upload.cjs invalidPaths (cdp-control.cjs 가 path.isAbsolute · fs.existsSync 를 넣음)
export function invalidUploadPaths(files) {
  return files.filter((file) => !path.isAbsolute(file) || !fs.existsSync(file));
}

const expandHome = (value) => (value.startsWith("~") ? path.join(os.homedir(), value.slice(1)) : value);

async function execute(cmd, args, base) {
  const kit = createStepKit(base);
  const { rawCall, step, send, redacted, nodeFromArgs, focusState, hold } = kit;
  const wc = { id: null }; // 처리기는 wc.id 를 쓰지 않음

  const bodies = {
    // 지금 떠 있는 확인 창을 닫음 · 브라우저 층 명령이라 페이지가 멈춰 있어도 동작
    async dialog(bodyArgs) {
      const done = await step("dialog.answer", { answer: bodyArgs.answer, text: bodyArgs.text });
      if (done.none) return { ok: true, none: true, note: "떠 있는 확인 창이 없습니다." };
      return { ok: true, answered: done.answered, kind: done.kind, message: done.message };
    },
    async dialoginfo() {
      const { dialog } = await step("dialog.state", {});
      return { ok: true, dialog: dialog ? { kind: dialog.kind, message: String(dialog.message || "").slice(0, 300) } : null };
    },
    // 대화상자 자동 응답 무장/해제 · 기본(해제)은 사람이 처리
    async dialogs(bodyArgs) {
      const raw = String(bodyArgs.plan == null ? "" : bodyArgs.plan).trim();
      const text = bodyArgs.text == null ? null : String(bodyArgs.text);
      if (!raw || raw === "off") {
        await step("dialog.plan", { plan: null, text });
        return { ok: true, mode: "off", note: "사람이 처리" };
      }
      const parts = raw.split(",").map((item) => item.trim()).filter(Boolean);
      const bad = parts.find((item) => item !== "ok" && item !== "cancel");
      if (bad) return { error: `알 수 없는 응답 "${bad}" — ok · cancel · off 만 가능` };
      if (parts.length === 1) {
        await step("dialog.plan", { plan: { mode: parts[0] }, text });
        return { ok: true, mode: parts[0] };
      }
      await step("dialog.plan", { plan: { queue: parts }, text });
      return { ok: true, queue: parts };
    },
    // 네이티브 파일 선택 창: 페이지에 로컬 파일을 넣음
    async upload(bodyArgs) {
      const files = (Array.isArray(bodyArgs.paths) ? bodyArgs.paths : String(bodyArgs.paths || "").split(",").map((item) => item.trim()))
        .filter(Boolean).map(expandHome);
      if (!files.length) return { error: "올릴 파일 경로가 없습니다." };
      const missing = invalidUploadPaths(files);
      if (missing.length) return { error: "없거나 절대경로가 아닌 파일: " + missing.join(", ") };
      await send("DOM.enable", {});
      // 대상을 준 경우: 그 입력칸에 바로 넣음 · 네이티브 창이 뜨지 않아 가장 확실함
      if (bodyArgs.ref || bodyArgs.sel) {
        const { backendNodeId, sid } = await nodeFromArgs(send, wc, bodyArgs);
        await send.on(sid)("DOM.setFileInputFiles", { files, backendNodeId });
        return { ok: true, files, via: "direct" };
      }
      // 대상을 모르는 경우: 선택 창을 가로채도록 무장만 하고 바로 돌려줌 · 기다리면 뒤이은 click 이 대기열에 갇혀 선택 창이 안 열림
      const ms = Math.min(120000, Math.max(1000, Number(bodyArgs.timeout) || 60000));
      await step("upload.arm", { paths: files, timeoutMs: ms });
      return { ok: true, armed: true, files, expiresInSec: Math.round(ms / 1000),
        note: "이제 파일 선택을 여는 버튼을 누르세요. 선택창 대신 이 파일이 들어갑니다." };
    },
    // 다운로드 저장 창: 무장하면 네이티브 창 없이 지정 폴더에 저장
    async download(bodyArgs) {
      const raw = String(bodyArgs.dir == null ? "" : bodyArgs.dir).trim();
      if (!raw || raw === "off") {
        const state = await step("download.configure", { dir: "off" });
        return { ok: true, mode: "off", note: "사람이 저장 위치를 고릅니다", last: state.last };
      }
      const dir = expandHome(raw);
      if (!path.isAbsolute(dir)) return { error: "절대경로가 필요합니다: " + raw };
      const response = await rawCall("download.configure", { dir, once: bodyArgs.once === true || String(bodyArgs.once) === "true" });
      // 폴더를 만들지 못한 것은 옛 처리기처럼 값으로 돌려줌 · 그 밖의 실패는 그대로 실패
      if (!response.ok && response.code === "INVALID_REQUEST") return { error: response.error };
      if (!response.ok) throw new StepFailed(response);
      return { ok: true, dir: response.data.dir, once: response.data.once, last: response.data.last };
    },
    // 저장된 로그인으로 채움 · 허용 목록의 (사이트, 아이디)만 되고 비밀번호는 메인 안에서만 다룸
    async login(bodyArgs) {
      const result = await step("login.fill", { username: bodyArgs.username == null ? null : String(bodyArgs.username) });
      // 사람 개입이 필요하면 메인이 붙임 정책을 풀고(세대가 오름), 채우며 페이지가 이동할 수도 있음 · 이후 호출의 token 을 맞춤
      await step("cdp.sync", {});
      return result;
    },
    async nativewin() { return await step("native.window", {}); },
    async nativekey(bodyArgs) { return await step("native.windowKey", { key: bodyArgs.key }); },
    async nativeclick(bodyArgs) {
      const name = String(bodyArgs.button || "").trim();
      if (!name) return { error: "누를 버튼 이름이 필요합니다. 먼저 nativewin으로 확인하세요." };
      return await step("native.windowClick", { button: name });
    },
  };

  // 옛 runWithoutCdp(로그인 호스트) 와 cdpExecInner 의 CDP 경로 · 그림이 아니라 키·프레임이 필요한 명령만 창을 붙잡음
  async function runWithCdp() {
    await step("viewport.ensureReady", { command: cmd });
    const wantsFrames = ANIMATES.has(cmd);
    let held = false;
    if (wantsFrames || NEEDS_KEYS.has(cmd)) {
      const state = await focusState();
      if (state?.shown !== true) {
        try { held = await hold(true); }
        catch (error) { if (error instanceof StepStopped) throw error; held = false; }
      }
    }
    try {
      const out = await bodies[cmd](args);
      // 조작이 시작시킨 트랜지션이 끝날 때까지만 더 붙잡음 · 정지 화면이면 곧바로 해제
      if (held && wantsFrames) await settleAnimations(send);
      return out;
    } finally {
      if (held && !kit.blocked()) { try { await hold(false); } catch {} }
    }
  }

  async function inner() {
    const gate = await step("cdp.gate", { command: cmd });
    let ticket = null;
    if (!READ_ONLY.has(cmd)) ticket = (await step("ai.enter", {})).ticket;
    try { return gate.noCdp ? await bodies[cmd](args) : await runWithCdp(); }
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

export const NATIVE_HANDLERS = Object.freeze(Object.fromEntries(
  NATIVE_COMMAND_NAMES.map((cmd) => [cmd, ({ args, base }) => execute(cmd, args || {}, base)])));
