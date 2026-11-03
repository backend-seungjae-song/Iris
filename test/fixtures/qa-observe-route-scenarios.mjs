// QA 확인·캡처·관찰·반응 worker 경로 시험용: 가짜 페이지 시나리오 · 옛 처리기 실행기(cdp-control.cjs cdpExecRaw·cdpExecInner 원문을 vm 에서 실행) · worker 경로 전체 대역
// 옛 경로의 처리기는 실제 cdp-qa-capture.cjs · cdp-qa-expect.cjs · cdp-qa-reaction.cjs · cdp-qa-stability.cjs · setQaMode·ensureQaReady 원문
// worker 경로는 실제 QA 실행기(createQaExecutor) → host 확인 창 게이트 → 명령 단위(command-units) → Electron 중계(relay) 를 거침 · 메인 모듈만 대역
import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

import { createBrowserDialogHost } from "../../server/mcp-host/browser-dialog.js";
import { HOST_OPERATION_DEFINITIONS } from "../../server/mcp-host/operations.js";
import { createQaExecutor } from "../../server/mcp-worker/qa-service.js";
import { LEGACY_PARTS, CONTROL_SOURCE, slice } from "./input-route-scenarios.mjs";
import { QA_LEGACY_PARTS } from "./qa-input-route-scenarios.mjs";

const require = createRequire(import.meta.url);
const { createQaCaptureCommands } = require("../../native/electron/cdp-qa-capture.cjs");
const { createQaExpectCommands } = require("../../native/electron/cdp-qa-expect.cjs");
const { createQaReactionCommands } = require("../../native/electron/cdp-qa-reaction.cjs");
const { createQaViewportCommands } = require("../../native/electron/cdp-qa-viewport.cjs");
const { createObservation } = require("../../native/electron/cdp-observation.cjs");
const { createElectronRelay } = require("../../native/electron/relay/index.cjs");
const { createCommandUnits } = require("../../native/electron/relay/command-units.cjs");
const { createUnitWiring } = require("../../native/electron/relay/unit-wiring.cjs");

export { CONTROL_SOURCE, LEGACY_PARTS };
export const WC_ID = 7;
export const GENERATION = "boot:1";
export const SECRET = "tok-SECRET-9f2";
const clone = (v) => JSON.parse(JSON.stringify(v ?? null));
const coded = (code, message) => Object.assign(new Error(message), { code });
const failure = (error) => ({ ok: false, error: String((error && error.message) || error), ...(error && error.code ? { code: error.code } : {}) });
const mask = (state, v) => (state.secret ? JSON.parse(JSON.stringify(v ?? null).split(state.secret).join("••••")) : v);
const CDP_FREE = ["goto", "url", "back", "forward", "reload", "wait", "text", "screenshot", "login", "dialogs", "download", "nativewin", "nativekey", "nativeclick"];
const START = 1_700_000_000_000;
// 실행마다 새 폴더를 쓰는 임시 위치 · IRIS_TEST_SCRATCH 로 바꿀 수 있음
export const SCRATCH = path.join(process.env.IRIS_TEST_SCRATCH || path.join(os.tmpdir(), "iris-qa-observe-test"), "/");

// 실행마다 달라지는 값을 지움: 무작위 이름 · 무작위 id · 실제 시각 · 안정 확인에 넘기는 남은 시간
const VOLATILE = [
  [/iris-qa-(expect|login|stability|reaction)-?[0-9a-f]{0,32}/g, "iris-qa-$1"],
  [/[0-9a-f]{24}/g, "<id>"],
  [/"(capturedAt|waitedMs)":\d+/g, '"$1":0'],
  [/(__irisQaStability[\s\S]*?\}\)\()\d+(\)")/g, "$1N$2"],
];
const normalize = (value) => JSON.parse(VOLATILE.reduce((text, [pattern, to]) => text.replace(pattern, to), JSON.stringify(value ?? null)));

export function pngOf(width, height) {
  const out = Buffer.alloc(32);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(out);
  out.writeUInt32BE(13, 8);
  out.write("IHDR", 12);
  out.writeUInt32BE(width, 16);
  out.writeUInt32BE(height, 20);
  return out;
}
// 옛 Electron nativeImage 대역: PNG 머리말의 크기 · PNG 가 아니면 0×0
const nativeImage = {
  createFromBuffer: (png) => ({ getSize: () => (png.length >= 24 && png.readUInt32BE(0) === 0x89504e47 ? { width: png.readUInt32BE(16), height: png.readUInt32BE(20) } : { width: 0, height: 0 }) }),
};

const frameRect = { x: 10, y: 20, width: 100, height: 40 };

// 페이지 대역: 캡처·안정 확인·판정·반응 관찰이 부르는 CDP 메서드를 흉내냄
export function qaObservePage(options = {}) {
  const { width = 1280, height = 800, content = { width: 1280, height: 2400 }, masks = [], pageDpr = 1, rect = frameRect, rectNull = false,
    animations = 0, quiet = 500, mismatch = false, captureError = null, entries = null, extra = {}, reaction = {}, frameTrees = {}, ax = null } = options;
  return (ctl) => {
    let contextId = 0, script = 0, shots = 0, evaluates = 0, refreshes = 0;
    const worldFrame = new Map();
    return async (method, params = {}, sid = null) => {
      if (extra[method]) return extra[method](params, sid);
      switch (method) {
        case "Page.getFrameTree": return { frameTree: frameTrees[sid || "top"] || { frame: { id: `frame-${sid || "top"}` } } };
        case "Page.createIsolatedWorld": { worldFrame.set(contextId + 1, params.frameId); return { executionContextId: ++contextId }; }
        case "Page.getLayoutMetrics": return { cssVisualViewport: { clientWidth: width, clientHeight: height, pageX: 0, pageY: 0 }, cssContentSize: content };
        case "Page.captureScreenshot": {
          shots += 1;
          if (captureError) throw new Error(captureError);
          const scale = params.clip?.scale || 1;
          const w = Math.round(params.clip.width * scale), h = Math.round(params.clip.height * scale);
          return { data: pngOf(mismatch ? w + 1 : w, h).toString("base64") };
        }
        case "Runtime.addBinding": return {};
        case "Page.addScriptToEvaluateOnNewDocument": return { identifier: `script-${++script}` };
        case "Page.removeScriptToEvaluateOnNewDocument": return {};
        case "DOM.getFrameOwner": return { backendNodeId: 90 };
        case "DOM.resolveNode": return { object: { objectId: `obj-${params.backendNodeId}` } };
        case "Runtime.releaseObject": return {};
        case "Runtime.callFunctionOn": {
          const fn = String(params.functionDeclaration);
          if (fn.includes("rendered(this)")) return { result: { value: true } };
          if (fn.includes("elementFromPoint")) return ctl.callFn ? ctl.callFn(params) : { result: { value: ax?.inspected ?? null } };
          return { result: { value: null } };
        }
        case "DOM.getBoxModel": return { model: { border: [10, 20, 110, 20, 110, 60, 10, 60] } };
        case "DOM.getContentQuads": return { quads: [[10, 20, 110, 20, 110, 60, 10, 60]] };
        case "Accessibility.getFullAXTree": return { nodes: ax?.nodes || [] };
        case "DOM.getNodeForLocation": return { backendNodeId: 55 };
        case "Accessibility.getPartialAXTree": return { nodes: ax?.partial || [] };
        case "Runtime.evaluate": {
          evaluates += 1;
          const expression = String(params.expression);
          if (expression.includes("__irisQaReactionState.arm()")) return { result: { value: reaction.snapshot ? reaction.snapshot(null, "arm") : emptySnapshot([]) } };
          if (expression.includes("__irisQaReactionState.refresh()")) {
            refreshes += 1;
            return { result: { value: reaction.refresh ? reaction.refresh(refreshes) : emptySnapshot([]) } };
          }
          if (expression.includes("__irisQaReactionState?.stop()")) return { result: { value: true } };
          if (expression.startsWith("(function reactionWatch(")) {
            const config = JSON.parse(/\)\((\{.*\})\)$/s.exec(expression)[1]);
            return { result: { value: reaction.snapshot ? reaction.snapshot(config, "install") : emptySnapshot(config.effects) } };
          }
          if (expression.includes("__irisQaStability")) return { result: { value: { animations, quietForMs: quiet } } };
          if (expression.includes("input[type=\"password\"]")) return { result: { value: { dpr: pageDpr, masks } } };
          if (expression.includes("elements.length === 1 ? elements[0] : null") || expression.includes("elements[")) return { result: { value: rectNull ? null : rect } };
          if (expression.includes("queried")) {
            const frame = worldFrame.get(params.contextId);
            const value = entries ? entries(frame, expression) : { entries: [], queried: 0 };
            if (value instanceof Error) throw value;
            return { result: { value } };
          }
          return { result: { value: true } };
        }
        default: return {};
      }
    };
  };
}

// 반응 관찰이 읽는 페이지 상태 대역
export function emptySnapshot(effects, patch = {}) {
  return { url: "https://example.test/page", bodyText: "본문", horizontal: false,
    effects: effects.map((effect) => ({ id: effect.id, found: false, text: null, rect: null, signature: "[]", unsupported: false })),
    visibleElements: 3, target: null, busy: [], broken: [], ...patch };
}

const binding = (payload) => ({ name: "__irisQaReaction", payload: JSON.stringify(payload), executionContextId: 1 });
const found = (id, text, rect = { x: 5, y: 6, width: 70, height: 20 }) => ({ id, found: true, text, rect, signature: JSON.stringify([[text, "status", ""]]), unsupported: false });
// 시나리오가 쓰는 페이지 이벤트
export const EVENTS = {
  appear: (id = "e1", text = "저장됨") => ({ method: "Runtime.bindingCalled", params: binding({ id: "__REACTION__", kind: "dom", domChanged: true, effects: [found(id, text)],
    changes: [{ text, from: null, rect: { x: 5, y: 6, width: 70, height: 20 }, born: true, role: "status", selector: "#toast" }], candidates: [], snapshot: emptySnapshot([]) }) }),
  console: (text) => ({ method: "Runtime.consoleAPICalled", params: { type: "error", args: [{ value: text }] } }),
  request: (method, url, requestId = "r1") => ({ method: "Network.requestWillBeSent", params: { requestId, request: { url, method, postData: "{}" }, initiator: { type: "script" } } }),
  response: (url, status, requestId = "r1") => ({ method: "Network.responseReceived", params: { requestId, response: { url, status } } }),
  navigate: (url) => ({ method: "Page.frameNavigated", params: { frame: { url } } }),
  dialog: (message) => ({ method: "Page.javascriptDialogOpening", params: { type: "alert", message } }),
};

const A11Y = (role, name, id = 55) => ({ backendDOMNodeId: id, nodeId: String(id), role: { value: role }, name: { value: name }, childIds: [] });
const AX_BUTTON = { nodes: [A11Y("button", "저장")], partial: [A11Y("button", "저장")],
  inspected: { displayed: true, offscreen: null, occluded: false, inert: false, sel: "button", blocker: null } };

const reactionEffects = [{ type: "appear", text: "저장됨", oracle: "저장 알림" }];
const startArgs = (extraExpect = {}) => ({ expect: { effects: reactionEffects, within: 400, ...extraExpect }, action: "click", target: { x: 30, y: 40 } });
const withIds = (effects) => effects.map((effect, index) => ({ ...effect, id: `e${index + 1}` }));
const reactionPage = (more = {}) => qaObservePage({
  reaction: { snapshot: (config) => emptySnapshot(config ? config.effects : withIds(reactionEffects)), refresh: () => emptySnapshot(withIds(reactionEffects)) },
  ...more });

export const SCENARIOS = [
  // 캡처
  { name: "screenshot-stable", cmd: "qa-screenshot", args: {}, env: { shown: true }, page: qaObservePage() },
  { name: "screenshot-mark-mask-password", cmd: "qa-screenshot", args: { stable: false, caption: `토큰 ${SECRET}`, mark: { x: 10, y: 20, width: 50, height: 20, label: "확인" }, dpr: 2 },
    env: { shown: true, secret: SECRET }, page: qaObservePage({ masks: [{ x: 5, y: 5, width: 40, height: 10 }] }) },
  { name: "screenshot-sel-mark-and-element-crop", cmd: "qa-screenshot", args: { stable: false, mark: { sel: "button.save", label: "저장" }, element: "button.save" }, env: { shown: true }, page: qaObservePage() },
  { name: "screenshot-ref-mark", cmd: "qa-screenshot", args: { stable: false, mark: { ref: "e5", label: "ref" } }, env: { shown: true, refs: { e5: { backendDOMNodeId: 77, sid: null } } }, page: qaObservePage() },
  { name: "screenshot-ref-missing", cmd: "qa-screenshot", args: { stable: false, mark: { ref: "e9" } }, env: { shown: true, refs: {} }, page: qaObservePage() },
  { name: "screenshot-full-page", cmd: "qa-screenshot", args: { stable: false, full: true }, env: { shown: true }, page: qaObservePage() },
  { name: "screenshot-moment", cmd: "qa-screenshot", args: { moment: true, caption: "순간" }, env: { shown: true }, page: qaObservePage() },
  { name: "screenshot-bad-dpr", cmd: "qa-screenshot", args: { dpr: 9 }, env: { shown: true }, page: qaObservePage() },
  { name: "screenshot-crop-outside", cmd: "qa-screenshot", args: { stable: false, crop: { x: 1200, y: 0, width: 200, height: 100 } }, env: { shown: true }, page: qaObservePage() },
  { name: "screenshot-size-mismatch", cmd: "qa-screenshot", args: { stable: false }, env: { shown: true }, page: qaObservePage({ mismatch: true }) },
  { name: "screenshot-cdp-failure", cmd: "qa-screenshot", args: { stable: false }, env: { shown: true }, page: qaObservePage({ captureError: "Target closed unexpectedly" }) },
  { name: "screenshot-hidden-tab-zoom", cmd: "qa-screenshot", args: { stable: false }, env: { shown: false, zoom: 1.25 }, page: qaObservePage() },
  { name: "screenshot-window-not-drawing", cmd: "qa-screenshot", args: {}, env: { shown: true, paint: { ok: false, why: "최소화" } }, page: qaObservePage() },
  { name: "screenshot-blocked-host", cmd: "qa-screenshot", args: {}, env: { shown: true, blockedAfterEnable: true }, page: qaObservePage() },
  // 안정 확인
  { name: "settle-stable", cmd: "qa-settle", args: {}, env: { shown: true, pending: [0] }, page: qaObservePage() },
  { name: "settle-network-then-stable", cmd: "qa-settle", args: {}, env: { shown: true, pending: [2, 1, 0] }, page: qaObservePage() },
  { name: "screenshot-unstable-deadline-passed", cmd: "qa-screenshot", args: { settle: -1 }, env: { shown: true, pending: [1] }, page: qaObservePage({ animations: 2 }) },
  { name: "settle-frame-tree-failure", cmd: "qa-settle", args: {}, env: { shown: true }, page: qaObservePage({ extra: { "Page.getFrameTree": () => { throw new Error("frame tree 실패"); } } }) },
  // 진단 + 촬영
  { name: "observe-with-screenshot", cmd: "qa-observe", args: { level: "warn", limit: 20 }, env: { shown: true, secret: SECRET, moments: [{ kind: "toast", text: "알림" }],
    observed: { console: [{ level: "error", text: `실패 ${SECRET}` }], exceptions: [], network: [], dialogs: [], downloads: [] } }, page: qaObservePage() },
  { name: "observe-no-screenshot", cmd: "qa-observe", args: { screenshot: false }, env: { shown: true, observed: { console: [], exceptions: [], network: [], dialogs: [] } }, page: qaObservePage() },
  { name: "observe-bad-level", cmd: "qa-observe", args: { level: "debug" }, env: { shown: true }, page: qaObservePage() },
  { name: "observe-bad-limit", cmd: "qa-observe", args: { limit: 151 }, env: { shown: true }, page: qaObservePage() },
  // 판정
  { name: "expect-exists-pass", cmd: "qa-expect", args: { mode: "exists", sel: "#toast" }, env: { shown: true },
    page: qaObservePage({ entries: () => ({ entries: [{ text: "저장됨", tag: "div", rect: frameRect }], queried: 1 }) }) },
  { name: "expect-contains-in-iframe", cmd: "qa-expect", args: { mode: "contains", sel: "p", text: "안녕" }, env: { shown: true },
    page: qaObservePage({ frameTrees: { top: { frame: { id: "top-frame" }, childFrames: [{ frame: { id: "child-frame", parentId: "top-frame" } }] } },
      entries: (frame) => (frame === "child-frame" ? { entries: [{ text: "안녕하세요", tag: "p", rect: frameRect }], queried: 1 } : { entries: [], queried: 0 }) }) },
  { name: "expect-oop-iframe", cmd: "qa-expect", args: { mode: "contains", sel: "p", text: "원격" }, env: { shown: true }, frames: ["oop-1"],
    page: qaObservePage({ frameTrees: { "oop-1": { frame: { id: "oop-frame" } } },
      entries: (frame) => (frame === "oop-frame" ? { entries: [{ text: "원격 프레임", tag: "p", rect: frameRect }], queried: 1 } : { entries: [], queried: 0 }) }) },
  { name: "settle-oop-iframe", cmd: "qa-settle", args: {}, env: { shown: true, pending: [0] }, frames: ["oop-1"],
    page: qaObservePage({ frameTrees: { "oop-1": { frame: { id: "oop-frame" } } } }) },
  { name: "expect-absent-pass", cmd: "qa-expect", args: { mode: "absent", sel: ".spinner" }, env: { shown: true }, page: qaObservePage() },
  { name: "expect-equals-fail", cmd: "qa-expect", args: { mode: "equals", sel: "h1", text: "제목" }, env: { shown: true },
    page: qaObservePage({ entries: () => ({ entries: [{ text: "다른 제목", tag: "h1", rect: frameRect }], queried: 1 }) }) },
  { name: "expect-inspection-error", cmd: "qa-expect", args: { mode: "exists", sel: "#x" }, env: { shown: true }, page: qaObservePage({ entries: () => new Error("조회 예외") }) },
  { name: "expect-shot-fails", cmd: "qa-expect", args: { mode: "exists", sel: "#toast" }, env: { shown: true },
    page: qaObservePage({ captureError: "Target closed unexpectedly", entries: () => ({ entries: [{ text: "x", tag: "div", rect: frameRect }], queried: 1 }) }) },
  { name: "expect-bad-mode", cmd: "qa-expect", args: { mode: "near" }, env: { shown: true }, page: qaObservePage() },
  { name: "expect-window-not-drawing", cmd: "qa-expect", args: { mode: "exists", sel: "#toast" }, env: { shown: true, paint: { ok: false, why: "최소화" } },
    page: qaObservePage({ entries: () => ({ entries: [{ text: "x", tag: "div", rect: frameRect }], queried: 1 }) }) },
  { name: "expect-blocked-host", cmd: "qa-expect", args: { mode: "exists", sel: "#toast" }, env: { shown: true, blockedAfterEnable: true }, page: qaObservePage() },
  // 대상 해석
  { name: "target-resolve-found", cmd: "qa-target-resolve", args: { target: { role: "button", name: "저장" } }, env: { shown: true }, page: qaObservePage({ ax: AX_BUTTON }) },
  { name: "target-resolve-missing", cmd: "qa-target-resolve", args: { target: { role: "button", name: "없음" } }, env: { shown: true }, page: qaObservePage({ ax: AX_BUTTON }) },
  { name: "target-resolve-invalid", cmd: "qa-target-resolve", args: { target: {} }, env: { shown: true }, page: qaObservePage({ ax: AX_BUTTON }) },
  // 반응 관찰 (여러 명령에 걸침)
  { name: "reaction-appear-observed", steps: [
    { cmd: "qa-reaction-start", args: startArgs() },
    { emit: [EVENTS.appear("e1", "저장됨")] },
    { cmd: "qa-reaction-poll", args: { id: "$id" } },
    { cmd: "qa-reaction-end", args: { id: "$id", delivered: true } },
    { cmd: "qa-reaction-drain", args: { id: "$id" } },
    { cmd: "qa-reaction-drain", args: {} },
  ], env: { shown: true, diag: { console: [{ text: "log" }], exceptions: [], network: [], dialogs: [], moments: [] } }, page: reactionPage() },
  { name: "reaction-during-wait", steps: [
    { cmd: "qa-reaction-start", args: startArgs() },
    { cmd: "qa-reaction-end", args: { id: "$id", delivered: true }, schedule: [{ at: 60, ...EVENTS.appear("e1", "저장됨") }, { at: 80, ...EVENTS.request("POST", "https://example.test/api/save") },
      { at: 90, ...EVENTS.response("https://example.test/api/save", 500) }, { at: 100, ...EVENTS.console("boom") }] },
  ], env: { shown: true }, page: reactionPage() },
  { name: "reaction-not-observed", steps: [
    { cmd: "qa-reaction-start", args: startArgs({ within: 100 }) },
    { cmd: "qa-reaction-end", args: { id: "$id", delivered: true } },
  ], env: { shown: true }, page: reactionPage() },
  { name: "reaction-unexpected-dialog-and-navigation", steps: [
    { cmd: "qa-reaction-start", args: startArgs({ within: 100 }) },
    { cmd: "qa-reaction-end", args: { id: "$id", delivered: false }, schedule: [{ at: 20, ...EVENTS.dialog("정말요?") }, { at: 40, ...EVENTS.navigate("https://example.test/next") }] },
  ], env: { shown: true }, page: reactionPage() },
  { name: "reaction-background-observe", steps: [{ cmd: "qa-background-observe", args: {} }],
    env: { shown: true }, page: reactionPage() },
  { name: "reaction-start-twice-blocks", steps: [
    { cmd: "qa-reaction-start", args: startArgs() },
    { cmd: "qa-reaction-start", args: startArgs() },
    { cmd: "qa-reaction-end", args: { id: "$id", delivered: true } },
    { cmd: "qa-reaction-start", args: startArgs() },
  ], env: { shown: true }, page: reactionPage() },
  { name: "reaction-premise-rejected", steps: [{ cmd: "qa-reaction-start", args: startArgs() }],
    env: { shown: true }, page: reactionPage({ reaction: { snapshot: (config, kind) => (kind === "arm" ? emptySnapshot([], { effects: [found("e1", "저장됨")] }) : emptySnapshot(config.effects)),
      refresh: () => emptySnapshot([]) } }) },
  { name: "reaction-invalid-expectations", steps: [
    { cmd: "qa-reaction-start", args: { expect: { effects: [] } } },
    { cmd: "qa-reaction-start", args: { expect: { effects: [{ type: "appear", oracle: "x" }] } } },
    { cmd: "qa-reaction-start", args: { expect: { effects: reactionEffects, within: 5 } } },
    { cmd: "qa-reaction-end", args: { id: "missing" } },
    { cmd: "qa-reaction-drain", args: {} },
  ], env: { shown: true }, page: reactionPage() },
  { name: "reaction-mode-off-disposes", steps: [
    { cmd: "qa-reaction-start", args: startArgs() },
    { modeOff: true },
    { cmd: "qa-reaction-poll", args: { id: "$id" } },
  ], env: { shown: true }, page: reactionPage() },
  { name: "reaction-blocked-host", steps: [{ cmd: "qa-reaction-start", args: startArgs() }], env: { shown: true, blockedAfterEnable: true }, page: reactionPage() },
];

// 알려진 차이: 단위가 호출마다 응답을 메인의 비밀 가리기에 거쳐 페이지가 돌려준 비밀 글자가 판정 전에 가려짐 (골든 대상 아님)
export const EXPECT_SECRET_SCENARIO = { name: "expect-secret-text", cmd: "qa-expect", args: { mode: "contains", sel: "p", text: SECRET }, env: { shown: true, secret: SECRET },
    page: qaObservePage({ entries: () => ({ entries: [{ text: `값 ${SECRET}`, tag: "p", rect: frameRect }], queried: 1 }) }) };

// 시계: 반응 관찰의 now · sleep · sleep 안에서 일정에 맞는 이벤트를 쏘고, 끝난 비동기 일(촬영)이 가라앉을 때까지 매크로 턴을 기다림
export function createClock() {
  let t = START;
  let schedule = [];
  let emit = () => {};
  const drain = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
  return {
    drain,
    now: () => t,
    bind: (fn) => { emit = fn; },
    plan: (items) => { schedule = items.map((item) => ({ ...item, at: START + item.at })).sort((a, b) => a.at - b.at); },
    sleep: async (ms) => {
      await drain();
      t += ms;
      while (schedule.length && schedule[0].at <= t) { const { method, params, sid } = schedule.shift(); emit(method, params, sid); }
      await drain();
    },
  };
}

// 이벤트 안의 반응 id 자리표시를 지금 진행 중인 관찰 id 로 바꿈 (id 는 무작위)
function withReactionId(params, id) {
  if (!id || typeof params?.payload !== "string") return params;
  return { ...params, payload: params.payload.replace("__REACTION__", id) };
}

// 옛 처리기와 worker 경로가 같이 쓰는 메인 대역 · 효과는 같은 이름과 모양으로 기록
function createWorld(scenario, root) {
  const env = scenario.env || {};
  const effects = [];
  const gens = { documentGeneration: 3, debuggerGeneration: 4 };
  const state = { secret: env.secret ?? null, blockedLate: false, reactionId: null };
  const isBlocked = () => env.blockedHost === true || state.blockedLate;
  const subscribers = new Set();
  const debuggerListeners = new Set();
  const clock = createClock();
  const ctl = { emit: (method, params, sid) => {
    const payload = clone(withReactionId(params, state.reactionId));
    for (const listener of [...debuggerListeners]) listener(null, method, payload, sid || undefined);
    for (const listener of [...subscribers]) listener(WC_ID, method, payload, sid || undefined);
  } };
  clock.bind(ctl.emit);
  const page = scenario.page(ctl);
  const raw = async (method, params, sid) => {
    effects.push(["cdp", method, clone(params ?? {}), sid || null]);
    if (method === "Runtime.addBinding" || method === "Page.addScriptToEvaluateOnNewDocument") state.armedReaction = true;
    return clone(await page(method, params ?? {}, sid || null));
  };
  // 반응 관찰 id 를 이벤트에 끼워 넣기 위해 설치 때 쓰는 config.id 를 읽음
  const rawTracking = async (method, params, sid) => {
    if (method === "Runtime.evaluate" && String(params?.expression).startsWith("(function reactionWatch(")) {
      state.reactionId = JSON.parse(/\)\((\{.*\})\)$/s.exec(String(params.expression))[1]).id;
    }
    return raw(method, params, sid);
  };
  const frames = scenario.frames || [];
  const sandbox = { console, setTimeout, clearTimeout, setImmediate, Buffer, Intl, __effects: effects };
  const context = vm.createContext(sandbox);
  const qaContents = new Set();
  const shotsDir = path.join(root, "artifacts", "shots");
  const guest = Object.assign(new EventEmitter(), {
    id: WC_ID,
    debugger: {
      isAttached: () => true,
      sendCommand: (method, params, sid) => rawTracking(method, params, sid ?? null),
      on: (_name, listener) => { debuggerListeners.add(listener); },
      removeListener: (_name, listener) => { debuggerListeners.delete(listener); },
    },
    hostWebContents: { id: 1, isDestroyed: () => false },
    isDestroyed: () => false,
    getType: () => "webview",
    getURL: () => env.url || "https://example.test/page",
    getTitle: () => "페이지",
    isLoading: () => false,
    canGoBack: () => false,
    canGoForward: () => false,
    getZoomFactor: () => env.zoom ?? 1,
    sendInputEvent: () => {},
  });
  const viewportOwner = {
    viewportFor: () => null,
    setViewportState: (wcId, value) => { effects.push(["viewport.state", wcId, clone(value)]); },
  };
  const qaViewport = createQaViewportCommands({
    viewportOwner,
    notify: (id, box) => { effects.push(["viewport.notify", id, clone(box)]); },
    yieldViewport: (id) => { effects.push(["viewport.yield", id]); },
  });
  const observed = env.observed || { console: [], exceptions: [], network: [], dialogs: [] };
  let pendingCalls = 0;
  const observation = {
    observe: (id, level, limit) => { effects.push(["observe", id, level, limit]); return clone(observed); },
    pendingRequests: () => { const list = env.pending ?? [0]; return list[Math.min(pendingCalls++, list.length - 1)]; },
    subscribeEvents: (listener) => { subscribers.add(listener); return () => { subscribers.delete(listener); }; },
    diagSince: (id, since) => { effects.push(["diagSince", id, since]); return clone(env.diag ?? { console: [], exceptions: [], network: [], dialogs: [], moments: [] }); },
    drainMoments: () => null,
    clearDiagnostics() {},
  };
  const renderImage = async (png, options) => { effects.push(["renderImage", png.length, clone(options)]); return Buffer.concat([png, Buffer.from("|masked")]); };
  const captureHold = async (_id, on) => { effects.push(["hold", on]); return true; };
  const resolveRef = (_id, ref) => {
    effects.push(["ref.resolve", ref]);
    const entry = env.refs?.[ref];
    if (!entry) throw coded("not_found", `ref ${ref} 를 찾을 수 없습니다`);
    return entry;
  };
  const redact = (_id, value) => mask(state, value);
  Object.assign(sandbox, {
    qaContents, qaViewportCommands: qaViewport,
    hiddenViewport: {
      ensureReady: async (_send, _wcId, command) => { effects.push(["ensureReady", command]); return { ready: true }; },
      yieldToExplicitViewport: (id) => { effects.push(["hidden.yield", id]); },
    },
    deviceEmulation: { viewportFor: () => null },
  });
  const parts = { qaViewport, observation, renderImage, captureHold, resolveRef, redact, shotsDir };
  const finish = () => { effects.push(["final", { qa: [...qaContents] }]); };
  return { env, effects, gens, state, raw: rawTracking, frames, parts, finish, ctl, qaContents, guest, subscribers, isBlocked, clock, sandbox, context, shotsDir, root };
}

function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else out.push({ file: path.relative(root, full), bytes: fs.readFileSync(full).toString("hex") });
    }
  };
  walk(root);
  return out;
}
const rootNormalizer = (root) => (value) => normalize(JSON.parse(JSON.stringify(value ?? null).split(root).join("<RUN>")));
// 파일은 이름만 지움 · 내용(바이트)은 그대로 비교
const filesNormalizer = (root) => (list) => list.map((item) => ({ file: rootNormalizer(root)(item.file), bytes: item.bytes }));

const stepsOf = (scenario) => scenario.steps || [{ cmd: scenario.cmd, args: scenario.args ?? {} }];
// 단계 인자의 "$id" 는 앞 단계 응답의 관찰 id (id 는 무작위라 시나리오에 적을 수 없음)
const resolveId = (args, last) => JSON.parse(JSON.stringify(args ?? {}).replace('"$id"', JSON.stringify(last.id)));
const rememberId = (last, response) => { if (response?.ok && typeof response.data?.id === "string") last.id = response.data.id; };

// 옛 경로: cdp-control.cjs 의 cdpExecRaw·cdpExecInner 원문을 vm 에서 실행하고 처리기는 실제 cdp-qa-*.cjs · 호출 순서는 QA 채널과 같음(qa-mode 켜기 → 명령)
export async function runLegacy(scenario, root) {
  fs.mkdirSync(root, { recursive: true });
  const world = createWorld(scenario, root);
  const { env, effects, state, raw, frames, parts, qaContents, guest, clock, sandbox, context, shotsDir } = world;
  const send = (method, params) => raw(method, params, null);
  send.on = (sid) => (method, params) => raw(method, params, sid || null);
  send.frames = () => [null, ...frames];
  send.ask = (sid, method, params) => send.on(sid)(method, params).catch(() => null);
  send.all = async (method, params) => (await Promise.all(send.frames().map((sid) => send.ask(sid, method, params)))).filter((r) => r != null);
  vm.runInContext(`${LEGACY_PARTS.prelude}${LEGACY_PARTS.consts}${QA_LEGACY_PARTS.readOnly}\nthis.__readOnly = READ_ONLY_CMDS;`, context);
  const legacyObservation = createObservation({ captureHold: () => false, isTabShown: () => false, now: Date.now, shotsDir: "/nonexistent", captureMoment: async () => null });
  const qaCapture = createQaCaptureCommands({ fs, path, shotsDir, nativeImage, refRegistry: { resolveRef: parts.resolveRef }, renderImage: parts.renderImage,
    captureHold: parts.captureHold, observation: parts.observation, redact: parts.redact });
  const qaReaction = createQaReactionCommands({ observation: parts.observation, screenshot: qaCapture["qa-screenshot"], now: clock.now, sleep: clock.sleep });
  const qaExpect = createQaExpectCommands({ screenshot: (_send, wc, args) => sandbox.__cdpExecRaw(webContentsMod, wc.id, "qa-screenshot", args) });
  Object.assign(sandbox, { qaReactionCommands: qaReaction });
  vm.runInContext(`${QA_LEGACY_PARTS.ensureQaReady}${QA_LEGACY_PARTS.setQaMode}\nthis.__qa = { ensureQaReady, setQaMode };`, context);
  const setQaMode = async (s, w, enabled) => {
    const result = await sandbox.__qa.setQaMode(s, w, enabled);
    if (enabled && env.blockedAfterEnable) state.blockedLate = true;
    return result;
  };
  const commands = { ...qaCapture, ...qaExpect, ...qaReaction,
    "qa-mode": async (s, w, a) => setQaMode(s, w, a.enabled === true) };
  Object.assign(sandbox, {
    qaLedgerAnchor: async () => ({ ok: true }),
    contextActionCommand: async () => ({}),
    commandWebContentsMods: new WeakMap(),
    detachIdle: () => { effects.push(["detachIdle"]); },
    detachAiSession: () => { effects.push(["detachAiSession"]); return false; },
    isTabShown: () => env.shown === true,
    pressAllowed: async () => false,
    paintableProbe: () => env.paint || { ok: true },
    captureHold: parts.captureHold,
    observation: legacyObservation,
    attachPolicy: { blocked: () => world.isBlocked(), touch() {}, release() {} },
    isGoogleAuthUrl: () => false,
    identityOwnsDebugger: () => false,
    cdpSession: { primed: () => false },
    enterAiCommand: (wcId, cmd) => { if (sandbox.__readOnly.has(cmd)) return null; effects.push(["ai.enter"]); return wcId; },
    leaveAiCommand: (ticket) => { if (ticket != null) effects.push(["ai.leave"]); },
    ensureAttached: () => send,
    ensureQaReady: (s, w, cmd) => sandbox.__qa.ensureQaReady(s, w, cmd),
    runCdpCmd: async (s, w, cmd, cmdArgs) => commands[cmd](s, w, cmdArgs),
    commandHandlers: commands,
    fs, path, SHOTS_DIR: shotsDir, pruneShots() {},
  });
  vm.runInContext(`${LEGACY_PARTS.exec}\nthis.__cdpExecRaw = cdpExecRaw;`, context);
  const webContentsMod = { fromId: () => guest };
  // 옛 attachMoments: QA 탭은 qa-observe 만 관찰 순간을 비워 붙임
  const attachMoments = (cmd, out) => (env.moments && cmd === "qa-observe" && qaContents.has(WC_ID) && out && typeof out === "object" && !Array.isArray(out) ? { ...out, moments: clone(env.moments) } : out);
  const exec = async (cmd, cmdArgs) => attachMoments(cmd, await sandbox.__cdpExecRaw(webContentsMod, WC_ID, cmd, cmdArgs));
  const responses = [];
  const last = { id: null };
  for (const step of stepsOf(scenario)) {
    if (step.emit) { for (const item of step.emit) emitItem(world, item); await clock.drain(); continue; }
    try {
      if (step.modeOff) { await exec("qa-mode", { enabled: false }); responses.push({ ok: true, data: { ok: true } }); continue; }
      await exec("qa-mode", { enabled: true });
      clock.plan(step.schedule || []);
      const response = { ok: true, data: mask(state, clone(await exec(step.cmd, resolveId(step.args, last)))) };
      rememberId(last, response);
      responses.push(response);
    } catch (error) { responses.push(failure(error)); }
  }
  world.finish();
  const normalizer = rootNormalizer(root);
  return { responses: normalizer(responses), effects: normalizer(effects), files: filesNormalizer(root)(listFiles(path.join(root, "artifacts"))) };
}
const emitItem = (world, item) => world.ctl.emit(item.method, item.params, item.sid);

// worker 경로 전체: QA 실행기 → host 확인 창 게이트 → 명령 단위 → Electron 중계 · 메인 모듈은 world 의 대역
export function createWorkerRun(scenario, root, {
  features = ["worker-command-unit", "worker-qa-input-commands", "worker-qa-observe-commands"], hostDialog = null, serial = null, unitIdleMs, unitTimeoutMs = 25000,
  commandId = `${GENERATION}/qa-1`, routes, identity = { session: "pane", run: "run-1", key: "key-1" }, onExecute = null,
} = {}) {
  fs.mkdirSync(root, { recursive: true });
  const world = createWorld(scenario, root);
  const { env, effects, gens, state, frames, parts, qaContents, guest, subscribers, clock } = world;
  const relays = [];
  const responses = [];
  const hostState = { dialog: hostDialog };
  const relayListeners = new Set();
  const webContents = { fromId: (id) => (Number(id) === WC_ID ? guest : null) };
  const sandbox = world.sandbox;
  vm.runInContext(`${QA_LEGACY_PARTS.ensureQaReady}${QA_LEGACY_PARTS.setQaMode}\nthis.__qa = { ensureQaReady, setQaMode };`, world.context);
  Object.assign(sandbox, { qaReactionCommands: { dispose: async () => {} } });
  const setQaMode = async (send, wc, enabled) => {
    const result = await sandbox.__qa.setQaMode(send, wc, enabled);
    if (enabled && env.blockedAfterEnable) state.blockedLate = true;
    return result;
  };
  const relay = createElectronRelay({
    webContents,
    targetState: {
      generations: () => ({ ...gens }),
      ownsChildSession: (wcId, sid) => Number(wcId) === WC_ID && frames.includes(sid),
      frames: () => [...frames],
      reset: () => ({ ...gens }),
      isRegistered: () => true,
    },
    currentUrl: () => env.url || "https://example.test/page",
    pendingUrl: () => "",
    blockedUrl: () => false,
    redact: (_wcId, value) => mask(state, value),
    rememberSecret() {},
    releaseAttach: () => {},
    observation: parts.observation,
    upload: { invalidPaths: () => [], arm() {}, forget() {}, armed: () => false },
    downloadState: { snapshot: () => ({}), arm() {}, disarm() {} },
    dialogPlan: { set() {} },
    clearDialogPlan() {},
    refs: { record() {}, resolve: parts.resolveRef },
    loginProvider: async () => ({}),
    nativeAx: {},
    gate: (_wc, command) => {
      const noCdp = world.isBlocked();
      if (noCdp) {
        effects.push(["detachAiSession"]);
        if (!CDP_FREE.includes(command)) {
          throw coded("cdp_blocked", `로그인 호스트에서는 CDP 를 붙이지 않아 ${command} 를 실행할 수 없습니다. 쓸 수 있는 것: ${CDP_FREE.join(" ")}. 사람이 로그인해야 하면 browser_ask_user 로 넘기세요.`);
        }
      }
      return { noCdp, ...gens };
    },
    attach: () => ({ ...gens }),
    ai: {
      enter: () => { effects.push(["ai.enter"]); return { ticket: true }; },
      leave: () => { effects.push(["ai.leave"]); },
    },
    captureHold: parts.captureHold,
    renderImage: parts.renderImage,
    focus: {
      state: async () => ({ canSendKeys: false, canPress: false, shown: env.shown === true, shownKnown: true, paint: env.paint || { ok: true } }),
      prepare: async () => "trusted",
      return: async () => null,
    },
    hiddenViewport: {
      ensureReady: async (wc, command, send) => { await sandbox.__qa.ensureQaReady(send, wc, command); return { ready: true }; },
      release: async () => ({}),
    },
    viewport: { explicit: () => null, current: () => null, revision: () => 0, apply: async () => ({}) },
    qaMode: (wc, enabled, send) => setQaMode(send, wc, enabled),
    qaViewport: (wc, viewportArgs, send) => parts.qaViewport["qa-viewport"](send, wc, viewportArgs),
    qaViewportRelease: () => {},
    emitEvent: (event) => { for (const listener of [...relayListeners]) listener(event); return true; },
    codedError: coded,
  });
  const queues = new Map();
  const releases = [];
  const units = createCommandUnits({
    queues,
    execute: (request) => relay.execute(request),
    redact: (_key, value) => mask(state, value),
    attachMoments: (_key, cmd, value) => (env.moments && cmd === "qa-observe" && value && typeof value === "object" && !Array.isArray(value) ? { ...value, moments: clone(env.moments) } : value),
    resetSession: () => {},
    liveTab: () => true,
    watchTab: () => () => {},
    codedError: coded,
    onClose: async (info) => { releases.push(info); await relay.releaseCommand(info.generation, info.commandId); },
    timeoutMs: unitTimeoutMs,
    tailGraceMs: 10,
  });
  const wiring = createUnitWiring({ getUnits: () => units, getRelay: () => relay, codedError: coded, liveWc: () => guest });
  const execute = async (target, input, request) => {
    const meta = { workerGeneration: request.workerGeneration, commandId: request.commandId, callId: request.callId, targetToken: input.targetToken, unit: input.relay.unit };
    try {
      if (onExecute) await onExecute(input.relay, meta);
      let data;
      if (relay.isBaseCommand(input.relay.command)) {
        const tokenTarget = { ...(meta.targetToken || {}) };
        if (tokenTarget.wcId == null) tokenTarget.wcId = WC_ID;
        data = await wiring.dispatchBase({ workerGeneration: meta.workerGeneration, commandId: meta.commandId, callId: meta.callId,
          command: input.relay.command, target: tokenTarget, args: input.relay.args || {} }, meta.unit);
      } else if (meta.unit?.phase === "end") {
        data = await wiring.endUnit(meta, WC_ID);
      } else if (!meta.unit) {
        data = { ok: true, legacy: input.relay.command };
      } else {
        throw new Error(`예상하지 않은 중계 명령 ${input.relay.command}`);
      }
      return { ok: true, data };
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error), ...(error && error.code ? { code: error.code } : {}) };
    }
  };
  const dialogHost = createBrowserDialogHost({
    serial,
    ...(unitIdleMs ? { unitIdleMs } : {}),
    resolveForCommand: async (_identity, input) => ({ tabId: input.tabId, wcId: WC_ID, targetToken: { wcId: WC_ID, ...gens } }),
    execute,
    raceDialog: async (_target, pending) => pending,
    currentDialog: () => hostState.dialog,
    redact: async (text) => text,
  });
  let sequence = 0;
  const als = new AsyncLocalStorage();
  const hostApi = {
    withCommand: (command, run) => als.run(command, run),
    current: () => als.getStore() || {},
    onRelayEvent: (listener) => { relayListeners.add(listener); return () => relayListeners.delete(listener); },
    call: async (operation, input) => {
      const store = als.getStore() || {};
      const currentId = store.commandId || commandId;
      if (operation === "browser.resolveForCommand") return { tabId: input.tabId, targetToken: { wcId: WC_ID, ...gens } };
      if (operation === "browser.status") return { executorReady: true, executor: { app: "x", pid: 1, features } };
      if (operation !== "browser.executeWithDialog") return {};
      const { command, args: baseArgs, unit } = input.relay;
      relays.push({ command, args: clone(baseArgs), unit: clone(unit), targetToken: clone(input.targetToken), commandId: currentId });
      const ctx = { identity: store.identity || identity, input, request: { workerGeneration: GENERATION, commandId: currentId, callId: ++sequence } };
      const locks = HOST_OPERATION_DEFINITIONS["browser.executeWithDialog"].locks(ctx);
      const response = await (serial ? serial.run(locks, () => dialogHost.executeWithDialog(ctx)) : dialogHost.executeWithDialog(ctx));
      responses.push(clone(response));
      return response;
    },
  };
  const executor = createQaExecutor({ hostApi, ...(routes ? { routes } : {}), reactionClock: { now: clock.now, sleep: clock.sleep } });
  let accepted = false;
  const accept = async () => {
    if (accepted) return;
    accepted = true;
    await relay.acceptGeneration(GENERATION, { id: "conn" });
  };
  const inContext = (run) => hostApi.withCommand({ identity, commandId }, run);
  const normalizer = rootNormalizer(root);
  return {
    effects, relays, responses, hostState, queues, releases, relay, units, world, executor, hostApi, accept, inContext, subscribers, relayListeners,
    execute: async (command, executeArgs = {}) => {
      await accept();
      return clone(await inContext(() => executor.execute("tab-a", command, executeArgs)));
    },
    run: async () => {
      await accept();
      const out = [];
      const last = { id: null };
      const previous = process.env.IRIS_STATE_DIR;
      process.env.IRIS_STATE_DIR = root;
      try { for (const step of stepsOf(scenario)) {
        if (step.emit) { for (const item of step.emit) emitItem(world, item); await clock.drain(); continue; }
        try {
          if (step.modeOff) { out.push(clone(await inContext(() => executor.modeOff("tab-a")))); continue; }
          clock.plan(step.schedule || []);
          const response = clone(await inContext(() => executor.execute("tab-a", step.cmd, resolveId(step.args, last))));
          rememberId(last, response);
          out.push(response);
        } catch (error) { out.push(failure(error)); }
      } } finally { if (previous === undefined) delete process.env.IRIS_STATE_DIR; else process.env.IRIS_STATE_DIR = previous; }
      world.finish();
      return { responses: normalizer(out), effects: normalizer(effects), files: filesNormalizer(root)(listFiles(path.join(root, "artifacts"))) };
    },
  };
}
