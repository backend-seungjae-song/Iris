// 일반 MCP 입력 명령의 worker 처리기 · 옛 cdp-control.cjs cdpExecRaw·cdpExecInner 순서를 기본 명령으로 옮김
// 원본 cdp-cmd-input.cjs 는 input-commands.js 사본으로 그대로 실행 (QA 입력·mouse·phone* 은 옛 경로)
import { createInputCommands } from "./input-commands.js";
import { withLayout } from "./layout.js";
import { settleAnimations } from "./settle.js";
import { StepFailed, StepStopped, codedError, createStepKit, failure } from "./step-kit.js";
import { insertTextInChunks } from "./text-insert.js";

export const INPUT_COMMAND_NAMES = Object.freeze(["click", "dblclick", "hover", "fill", "type", "key", "select",
  "check", "scroll", "scrollto", "focus", "clear", "bulkfill"]);

// 옛 cdp-control.cjs NEEDS_KEYS · cdp-observation.cjs ANIMATES 중 옮긴 명령
const NEEDS_KEYS = new Set(["fill", "type", "key"]);
const ANIMATES = new Set(["click", "dblclick", "type", "key", "fill", "select", "check", "clear", "hover", "focus",
  "scroll", "scrollto"]);

// 옛 cdp-control.cjs nativeClickSel · jsClickSel 의 페이지 식 (cdp-control.cjs 와 같은 문자열을 test 가 대조)
export function nativeRectExpression(sel) {
  return `(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;`
    + `e.scrollIntoView({block:'center',inline:'center'});const r=e.getBoundingClientRect();`
    + `if(r.width<=0||r.height<=0)return null;return {x:r.left+r.width/2,y:r.top+r.height/2};})()`;
}
export function jsClickExpression(sel, clickCount) {
  return `(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return {found:false};`
    + `e.scrollIntoView({block:'center',inline:'center'});const b=e.getBoundingClientRect();`
    + `if(e.offsetParent===null&&getComputedStyle(e).position!=='fixed')return {found:true,ok:false,why:'숨겨진 요소'};`
    + `if(e.disabled)return {found:true,ok:false,why:'비활성 요소'};`
    + `if(b.width<=0||b.height<=0)return {found:true,ok:false,why:'크기가 0인 요소'};`
    // 사람이 누를 때처럼 커서도 이동(입력칸을 누른 뒤 type 이 그 칸에 들어가게)
    + `if(typeof e.focus==='function'){try{e.focus({preventScroll:true});}catch(_){}}`
    + `for(let i=0;i<${clickCount};i++)e.click();return {found:true,ok:true};})()`;
}

async function execute(cmd, args, base) {
  const kit = createStepKit(base);
  const { rawCall, step, sender, send, refreshFrames, redacted, nodeFromArgs } = kit;
  let shown = false; // 옛 isTabShown 은 동기 · 가장 최근 focus.state 의 shown 을 씀 (모르면 안 보이는 쪽)

  // 옛 focusState 는 조회 실패를 "모름" 으로 보고 키·누르기를 모두 불허
  const focusState = async () => {
    const response = await rawCall("focus.state", {});
    if (!response.ok) return null;
    shown = response.data?.shown === true;
    return response.data;
  };

  // withLayout 이 거는 임시 layout 은 표시를 달아 보냄 · 메인이 단위가 닫힐 때 못 지운 것만 반환 (크기와 무관)
  const layoutSend = sender(null, { temporaryLayout: true });
  const markedLayoutSend = (innerSend) => (method, params) => (
    /^Emulation\.(set|clear)DeviceMetricsOverride$/.test(method) ? layoutSend(method, params) : innerSend(method, params));
  const commands = createInputCommands({
    withLayout: (layoutArg, fn) => withLayout(markedLayoutSend(layoutArg), fn),
    nodeFromArgs,
    insertTextInChunks,
    isTabShown: () => shown,
    run: (runSend, runWc, runCmd, runArgs) => commands[runCmd](runSend, runWc, runArgs),
    webContentsMod: () => null,
    ownsUserFocus: async () => (await focusState())?.canSendKeys === true,
    pressAllowed: async () => (await focusState())?.canPress === true,
  });
  const wc = { id: null }; // 처리기는 wc.id 를 위 주입 함수로만 씀

  // ref 없는 selector 클릭: CDP 를 붙이지 않고 누름 (옛 cdpExecRaw 맨 앞 분기 · AI 표식·붙임 정책 앞)
  async function selectorClick() {
    const clicks = cmd === "dblclick" ? 2 : 1;
    const exec = async (source) => {
      const response = await rawCall("wc.exec", { source, userGesture: true });
      if (!response.ok) throw new Error(response.error);
      return response.data;
    };
    try {
      await rawCall("cdp.detachIdle", {});
      const state = await focusState();
      const native = shown && state?.canPress === true;
      let r = null;
      if (native) {
        let rect;
        try { rect = await exec(nativeRectExpression(args.sel)); } catch (error) { if (error instanceof StepStopped) throw error; rect = null; }
        if (rect) {
          const x = Math.round(rect.x), y = Math.round(rect.y);
          try {
            for (const event of [{ type: "mouseMove", x: x - 4, y: y - 3 }, { type: "mouseMove", x, y },
              { type: "mouseDown", x, y, button: "left", clickCount: clicks }, { type: "mouseUp", x, y, button: "left", clickCount: clicks }]) {
              const response = await rawCall("wc.input", { event });
              if (!response.ok) throw new Error(response.error);
            }
            r = { ok: true, at: { x, y }, via: "native" };
          } catch (error) { if (error instanceof StepStopped) throw error; r = null; }
        }
      } else {
        let found;
        try { found = await exec(jsClickExpression(args.sel, clicks)); } catch (error) { if (error instanceof StepStopped) throw error; found = null; }
        if (found && found.found) r = found.ok ? { ok: true, via: "js-nocdp" } : { ok: false, error: found.why, via: "js-nocdp" };
      }
      return r ? { ...r, ref: args.sel } : null;
    } catch (error) {
      if (error instanceof StepStopped) throw error;
      return null;
    }
  }

  let ticket = null;
  let succeeded = false;
  let outcome;
  try {
    if ((cmd === "click" || cmd === "dblclick") && args.sel && !args.ref) {
      const done = await selectorClick();
      if (done) {
        // 마지막 기본 명령 · 메인이 이 호출로 단위를 닫고 관찰 순간을 붙임
        return await redacted({ ok: true, data: done }, true);
      }
    }
    await step("cdp.attach", { command: cmd });
    ticket = (await step("ai.enter", {})).ticket;
    await step("viewport.ensureReady", { command: cmd });
    const wantsKeys = NEEDS_KEYS.has(cmd);
    const wantsFrames = ANIMATES.has(cmd);
    let held = false;
    if (wantsKeys || wantsFrames || cmd === "bulkfill") {
      const state = await focusState();
      // 그림이 나와야 키가 도달함 · 보이는 탭인지보다 먼저 창 상태를 따짐 (순서가 바뀌면 검사가 우회됨)
      if (wantsKeys && state?.paint && !state.paint.ok) {
        throw codedError("window_not_drawing",
          `이 탭을 담은 창이 ${state.paint.why} 상태라 화면을 그리지 않습니다 — ${cmd} 를 보내도 도달하지 않습니다.`
          + " 창을 띄워 달라고 사람에게 부탁하고 다시 하세요(browser_ask_user).");
      }
      if ((wantsKeys || wantsFrames) && !shown) {
        try { held = (await rawCall("hold.capture", { on: true })).data?.held === true; }
        catch (error) { if (error instanceof StepStopped) throw error; held = false; }
      }
    }
    if (cmd === "type") await refreshFrames();
    let value;
    try {
      value = await commands[cmd](send, wc, args);
      if (held && wantsFrames) await settleAnimations(send);
    } finally {
      if (held && !kit.blocked()) { try { await rawCall("hold.capture", { on: false }); } catch {} }
    }
    if (kit.blocked()) return kit.blocked();
    outcome = { ok: true, data: value };
    succeeded = true;
  } catch (error) {
    if (error instanceof StepStopped) return kit.blocked();
    outcome = error instanceof StepFailed ? error.response : failure(error);
  }
  if (kit.blocked()) return kit.blocked();
  if (ticket) { try { await rawCall("ai.leave", { ticket }); } catch {} }
  if (kit.blocked()) return kit.blocked();
  // 성공이면 가리기 호출이 마지막 · 실패면 관찰 순간을 비우지 않음 (옛 경로도 실패 때는 비우지 않음)
  try { return await redacted(outcome, succeeded); }
  catch (error) { if (error instanceof StepStopped) return kit.blocked(); throw error; }
}

export const INPUT_HANDLERS = Object.freeze(Object.fromEntries(
  INPUT_COMMAND_NAMES.map((cmd) => [cmd, ({ args, base }) => execute(cmd, args || {}, base)])));
