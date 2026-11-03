// QA 입력·로그인·화면 크기·QA 모드 worker 경로 시험용: 가짜 페이지 시나리오 · 옛 처리기 실행기(cdp-control.cjs cdpExecRaw·cdpExecInner 원문을 vm 에서 실행) · worker 경로 전체 대역
// 옛 경로의 처리기는 실제 cdp-qa-input.cjs · cdp-qa-login.cjs · cdp-qa-viewport.cjs · setQaMode·ensureQaReady 원문
// worker 경로는 실제 QA 실행기(createQaExecutor) → host 확인 창 게이트 → 명령 단위(command-units) → Electron 중계(relay) 를 거침 · 메인 모듈만 대역
import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import vm from "node:vm";

import { createBrowserDialogHost } from "../../server/mcp-host/browser-dialog.js";
import { HOST_OPERATION_DEFINITIONS } from "../../server/mcp-host/operations.js";
import { createQaExecutor } from "../../server/mcp-worker/qa-service.js";
import { CONTROL_SOURCE, LEGACY_PARTS, slice } from "./input-route-scenarios.mjs";

const require = createRequire(import.meta.url);
const { createQaInputCommands } = require("../../native/electron/cdp-qa-input.cjs");
const { createQaLoginCommands } = require("../../native/electron/cdp-qa-login.cjs");
const { createQaViewportCommands } = require("../../native/electron/cdp-qa-viewport.cjs");
const { createObservation } = require("../../native/electron/cdp-observation.cjs");
const { createElectronRelay } = require("../../native/electron/relay/index.cjs");
const { createCommandUnits } = require("../../native/electron/relay/command-units.cjs");
const { createUnitWiring } = require("../../native/electron/relay/unit-wiring.cjs");

export { CONTROL_SOURCE, LEGACY_PARTS };
export const WC_ID = 7;
export const GENERATION = "boot:1";
export const PASSWORD = "hunter2-pw";
export const USER = "qa-user@example.test";
export const ORIGIN = "https://example.test";
export const LOGIN_URL = `${ORIGIN}/login`;
const clone = (v) => JSON.parse(JSON.stringify(v ?? null));
const coded = (code, message) => Object.assign(new Error(message), { code });
const failure = (error) => ({ ok: false, error: String((error && error.message) || error), ...(error && error.code ? { code: error.code } : {}) });
const mask = (state, v) => (state.secret ? JSON.parse(JSON.stringify(v ?? null).split(state.secret).join("••••")) : v);
const CDP_FREE = ["goto", "url", "back", "forward", "reload", "wait", "text", "screenshot", "login", "dialogs", "download", "nativewin", "nativekey", "nativeclick"];
const RANDOM_NAMES = [/__irisQaInput_[0-9a-f]{16}(_world)?/g, /iris-qa-login-[0-9a-f]{16}/g];
// 옛 경로와 worker 경로가 효과를 비교할 때 지우는 무작위 이름
const normalize = (value) => JSON.parse(RANDOM_NAMES.reduce((text, pattern) => text.replace(pattern, (m) => m.replace(/[0-9a-f]{16}/, "<rand>")), JSON.stringify(value ?? null)));

// cdp-control.cjs 원문 구간 (원본이 바뀌어 못 찾으면 시험이 실패)
export const QA_LEGACY_PARTS = {
  readOnly: /^const READ_ONLY_CMDS = new Set\(\[[\s\S]*?\]\);\n/m.exec(CONTROL_SOURCE)?.[0] || "",
  ensureQaReady: slice(CONTROL_SOURCE, "async function ensureQaReady(send, wc, cmd) {", "function cdpExec("),
  setQaMode: slice(CONTROL_SOURCE, "async function setQaMode(send, wc, enabled) {", "const commandHandlers = "),
};

const point = { x: 100, y: 120 };
const shown = { shown: true };
const hidden = { shown: false };
const account = (overrides = {}) => ({ username: USER, password: PASSWORD, allowed: true, local: false, ...overrides });
const provider = (accounts = [account()], extra = {}) => ({ origin: ORIGIN, accounts, unavailable: [], ...extra });
const loginFields = [{ field: "username", x: 40, y: 50 }, { field: "password", x: 40, y: 90 }];

// 이벤트 이름 → 페이지가 받은 믿을 수 있는 입력 기록 (cdp-qa-input.cjs EVENTS 의 일부)
const MOUSE_EVENTS = { mousePressed: ["pointerdown", "mousedown"], mouseReleased: ["pointerup", "mouseup", "click"], mouseMoved: ["pointermove", "mousemove"], mouseWheel: ["wheel"] };

// 페이지 대역: 공통 CDP 메서드를 흉내내고 입력이 오면 믿을 수 있는 이벤트를 binding 과 페이지 기록 양쪽에 남김
export function qaPage(options = {}) {
  const { width = 1280, height = 800, reasons = [], fields = [], focused = { role: "textbox", name: "아이디", tag: "input", at: { x: 40, y: 50 }, disabled: false },
    hit = { role: "button", name: "저장", tag: "button" }, bindingEvents = true, pageEvents = true, trusted = true, disabledHit = false,
    loginValid = true, extra = {}, evaluate = null, select = null, nodes = null, covered = false, pull = null } = options;
  return (ctl) => {
    let contextId = 0;
    let binding = null;
    let recorded = [];
    ctl.tabInput = () => deliver(["beforeinput", "input"], null);
    const deliver = (types, sid) => {
      for (const type of types) {
        const record = { type, trusted, role: hit.role, name: hit.name, tag: hit.tag };
        if (pageEvents) recorded.push(record);
        if (bindingEvents && binding) ctl.emit("Runtime.bindingCalled", { name: binding, payload: JSON.stringify(record), executionContextId: 1 }, sid);
      }
    };
    return async (method, params = {}, sid = null) => {
      if (extra[method]) return extra[method](params, sid);
      switch (method) {
        case "Page.getFrameTree": return { frameTree: { frame: { id: `frame-${sid || "top"}` } } };
        case "Page.createIsolatedWorld": return { executionContextId: ++contextId };
        case "Runtime.addBinding": binding = params.name; return {};
        case "Runtime.removeBinding": return {};
        case "Page.getLayoutMetrics": return { cssVisualViewport: { clientWidth: width, clientHeight: height } };
        case "DOM.enable": return {};
        case "DOM.getNodeForLocation": return { backendNodeId: 55 };
        case "Accessibility.getPartialAXTree": return { nodes: [{ backendDOMNodeId: 55, role: { value: hit.role }, name: { value: hit.name } }] };
        case "Accessibility.getFullAXTree": return { nodes: nodes || [{ backendDOMNodeId: 55, role: { value: hit.role }, name: { value: hit.name } }] };
        case "DOM.describeNode": return { node: { localName: hit.tag, attributes: [], backendNodeId: params.objectId ? 56 : 55 } };
        case "DOM.getBoxModel": return { model: { border: [90, 110, 110, 110, 110, 130, 90, 130] } };
        case "DOM.resolveNode": return { object: { objectId: `obj-${params.backendNodeId}` } };
        case "Runtime.releaseObject": return {};
        case "Runtime.callFunctionOn": {
          const fn = String(params.functionDeclaration);
          if (fn.includes("selectedIndex")) return { result: { value: select } };
          if (fn.includes("document.elementFromPoint")) return { result: { value: { top: !covered, disabled: false } } };
          return { result: { value: { disabled: disabledHit } } };
        }
        case "Input.dispatchMouseEvent":
          deliver(MOUSE_EVENTS[params.type] || [], sid);
          if (params.type === "mouseReleased" && params.clickCount === 2) deliver(["dblclick"], sid);
          return {};
        case "Input.insertText": deliver(["beforeinput", "input"], sid); return {};
        case "Input.dispatchKeyEvent":
          if (params.type === "char") deliver(["beforeinput", "input"], sid);
          else if (params.type !== "keyUp") deliver(["keydown"], sid);
          return {};
        case "Runtime.evaluate": {
          const expression = String(params.expression);
          if (evaluate) { const out = evaluate(expression, params, sid); if (out !== undefined) return out; }
          if (expression.includes("function inspectLoginPage")) return { result: { value: { fields, reasons } } };
          if (expression.includes("const events = [], types")) return { result: { value: true } };
          if (expression.includes("const capture = window.__irisQaInputCapture; if (!capture) return []")) {
            if (pull === "lost") throw new Error("Cannot find context with specified id");
            const out = recorded;
            recorded = [];
            return { result: { value: out } };
          }
          if (expression.includes("window.__irisQaInputCapture?.events")) return { result: { value: recorded.map((e) => `${e.type}:${e.trusted}`) } };
          if (expression.includes("document.activeElement, offsetX")) return { result: { value: focused } };
          if (expression.includes("let n = document.activeElement")) return focused ? { result: { objectId: "focus-obj" } } : { result: {} };
          if (expression.includes("e === document.activeElement")) return { result: { value: loginValid } };
          if (expression.includes('addEventListener("mousedown", guard')) return { result: { value: true } };
          if (expression.includes("scrollHeight")) return { result: { value: [] } };
          return { result: { value: true } };
        }
        default: return {};
      }
    };
  };
}

export const SCENARIOS = [
  // qa-input · 포인터
  { name: "input-click", cmd: "qa-input", args: { action: "click", ...point }, env: shown, page: qaPage() },
  { name: "input-click-hidden-tab", cmd: "qa-input", args: { action: "click", ...point }, env: hidden, page: qaPage() },
  { name: "input-click-frame-binding", cmd: "qa-input", args: { action: "click", ...point }, frames: ["frame-1"], env: shown, page: qaPage() },
  { name: "input-dblclick", cmd: "qa-input", args: { action: "dblclick", ...point }, env: shown, page: qaPage() },
  { name: "input-hover", cmd: "qa-input", args: { action: "hover", ...point }, env: shown, page: qaPage() },
  { name: "input-drag", cmd: "qa-input", args: { action: "drag", ...point, toX: 300, toY: 320 }, env: shown, page: qaPage() },
  { name: "input-scroll", cmd: "qa-input", args: { action: "scroll", ...point, deltaY: 400 }, env: shown, page: qaPage() },
  { name: "input-click-binding-only", cmd: "qa-input", args: { action: "click", ...point }, env: shown, page: qaPage({ pull: "lost" }) },
  { name: "input-click-page-only", cmd: "qa-input", args: { action: "click", ...point }, env: shown, page: qaPage({ bindingEvents: false }) },
  { name: "input-click-untrusted", cmd: "qa-input", args: { action: "click", ...point }, env: shown, page: qaPage({ trusted: false }) },
  { name: "input-click-no-events", cmd: "qa-input", args: { action: "click", ...point }, env: shown, page: qaPage({ bindingEvents: false, pageEvents: false }) },
  { name: "input-click-offscreen", cmd: "qa-input", args: { action: "click", x: 5000, y: 5 }, env: shown, page: qaPage() },
  { name: "input-click-disabled", cmd: "qa-input", args: { action: "click", ...point }, env: shown, page: qaPage({ disabledHit: true }) },
  { name: "input-click-human-required", cmd: "qa-input", args: { action: "click", ...point }, env: shown, page: qaPage({ reasons: ["결제 창"] }) },
  { name: "input-click-expected-target-moved", cmd: "qa-input", args: { action: "click", ...point, expectedTarget: { role: "link", name: "다른 곳" } }, env: shown, page: qaPage() },
  { name: "input-click-expected-target-same", cmd: "qa-input", args: { action: "click", ...point, expectedTarget: { role: "button", name: "저장" } }, env: shown, page: qaPage() },
  { name: "input-bad-action", cmd: "qa-input", args: { action: "teleport" }, env: shown, page: qaPage() },
  // qa-input · 키보드와 포커스 판정
  { name: "input-type-trusted", cmd: "qa-input", args: { action: "type", text: "안녕" }, env: shown, page: qaPage() },
  { name: "input-type-borrowed", cmd: "qa-input", args: { action: "type", text: "안녕" }, env: { ...shown, focus: "borrowed", focusReturn: "returned" }, page: qaPage() },
  { name: "input-type-guarded-chars", cmd: "qa-input", args: { action: "type", text: "ab가" }, env: { ...shown, focus: "guarded" }, page: qaPage() },
  { name: "input-type-busy-chars", cmd: "qa-input", args: { action: "type", text: "ab" }, env: { ...shown, focus: "busy" }, page: qaPage() },
  { name: "input-key-guarded", cmd: "qa-input", args: { action: "key", key: "Enter" }, env: { ...shown, focus: "guarded" }, page: qaPage() },
  { name: "input-key-busy", cmd: "qa-input", args: { action: "key", key: "Enter" }, env: { ...shown, focus: "busy" }, page: qaPage() },
  { name: "input-key-enter", cmd: "qa-input", args: { action: "key", key: "Enter" }, env: shown, page: qaPage() },
  { name: "input-key-hidden-tab", cmd: "qa-input", args: { action: "key", key: "Meta+a" }, env: hidden, page: qaPage() },
  { name: "input-key-tab-no-focus", cmd: "qa-input", args: { action: "key", key: "Tab" }, env: shown, page: qaPage({ focused: null }) },
  { name: "input-key-no-focus", cmd: "qa-input", args: { action: "key", key: "Enter" }, env: shown, page: qaPage({ focused: null }) },
  { name: "input-typeahead", cmd: "qa-input", args: { action: "typeahead", text: "k" }, env: shown, page: qaPage() },
  { name: "input-type-expected-focus-mismatch", cmd: "qa-input", args: { action: "type", text: "x", expectedTarget: { role: "button", name: "다른 칸" } }, env: shown, page: qaPage() },
  { name: "input-type-no-text", cmd: "qa-input", args: { action: "type" }, env: shown, page: qaPage() },
  { name: "input-window-not-drawing", cmd: "qa-input", args: { action: "click", ...point }, env: { ...shown, paint: { ok: false, why: "최소화" } }, page: qaPage() },
  { name: "input-blocked-host-at-mode", cmd: "qa-input", args: { action: "click", ...point }, env: { ...shown, blockedHost: true }, page: qaPage() },
  { name: "input-blocked-host", cmd: "qa-input", args: { action: "click", ...point }, env: { ...shown, blockedAfterEnable: true }, page: qaPage() },
  { name: "locate-blocked-host", cmd: "qa-locate", args: { role: "button", name: "저장" }, env: { ...shown, blockedAfterEnable: true }, page: qaPage() },
  { name: "viewport-blocked-host", cmd: "qa-viewport", args: { width: 390, height: 844 }, env: { ...shown, blockedAfterEnable: true }, page: qaPage() },
  { name: "input-type-secret-masked", cmd: "qa-input", args: { action: "type", text: "pw" }, env: { ...shown, secret: PASSWORD }, page: qaPage({ focused: { role: "textbox", name: PASSWORD, tag: "input", at: { x: 40, y: 50 }, disabled: false } }) },
  // qa-select-resolve · qa-locate · qa-focused
  { name: "select-resolve-by-text", cmd: "qa-select-resolve", args: { ...point, text: "부산" }, env: shown,
    page: qaPage({ select: { selectedIndex: 0, multiple: false, disabled: false, options: [{ index: 0, text: "서울", value: "S", disabled: false }, { index: 1, text: "부산", value: "B", disabled: false }] } }) },
  { name: "select-resolve-no-select", cmd: "qa-select-resolve", args: { ...point, index: 0 }, env: shown, page: qaPage() },
  { name: "select-resolve-two-selectors", cmd: "qa-select-resolve", args: { ...point, index: 0, value: "S" }, env: shown,
    page: qaPage({ select: { selectedIndex: 0, multiple: false, disabled: false, options: [{ index: 0, text: "서울", value: "S", disabled: false }] } }) },
  { name: "select-resolve-missing-option", cmd: "qa-select-resolve", args: { ...point, value: "Z" }, env: shown,
    page: qaPage({ select: { selectedIndex: 0, multiple: false, disabled: false, options: [{ index: 0, text: "서울", value: "S", disabled: false }] } }) },
  { name: "select-resolve-multiple", cmd: "qa-select-resolve", args: { ...point, index: 0 }, env: shown,
    page: qaPage({ select: { selectedIndex: 0, multiple: true, disabled: false, options: [{ index: 0, text: "서울", value: "S", disabled: false }] } }) },
  { name: "locate-found", cmd: "qa-locate", args: { role: "button", name: "저장" }, env: shown, page: qaPage() },
  { name: "locate-missing-name", cmd: "qa-locate", args: { role: "button" }, env: shown, page: qaPage() },
  { name: "locate-none", cmd: "qa-locate", args: { role: "link", name: "없음" }, env: shown, page: qaPage() },
  { name: "locate-covered", cmd: "qa-locate", args: { role: "button", name: "저장" }, env: shown, page: qaPage({ covered: true }) },
  { name: "locate-two", cmd: "qa-locate", args: { role: "button", name: "저장" }, env: shown,
    page: qaPage({ nodes: [{ backendDOMNodeId: 55, role: { value: "button" }, name: { value: "저장" } }, { backendDOMNodeId: 57, role: { value: "button" }, name: { value: "저장" } }] }) },
  { name: "focused-ax", cmd: "qa-focused", args: {}, env: shown, page: qaPage() },
  { name: "focused-none", cmd: "qa-focused", args: {}, env: shown, page: qaPage({ focused: null }) },
  // qa-login-info
  { name: "login-info-single", cmd: "qa-login-info", args: {}, env: { ...shown, login: provider() }, page: qaPage({ fields: loginFields }) },
  { name: "login-info-account-filter", cmd: "qa-login-info", args: { account: "other@example.test" }, env: { ...shown, login: provider([account(), account({ username: "other@example.test", password: "other-pw-1" })]) }, page: qaPage({ fields: loginFields }) },
  { name: "login-info-choose", cmd: "qa-login-info", args: {}, env: { ...shown, login: provider([account(), account({ username: "other@example.test", password: "other-pw-1" })]) }, page: qaPage({ fields: loginFields }) },
  { name: "login-info-sensitive", cmd: "qa-login-info", args: {}, env: { ...shown, login: provider() }, page: qaPage({ fields: loginFields, reasons: ["카드 정보 입력"] }) },
  { name: "login-info-no-accounts", cmd: "qa-login-info", args: {}, env: { ...shown, login: provider([]) }, page: qaPage({ fields: loginFields }) },
  { name: "login-info-no-fields", cmd: "qa-login-info", args: {}, env: { ...shown, login: provider() }, page: qaPage({ fields: [] }) },
  { name: "login-info-unavailable-listed", cmd: "qa-login-info", args: {}, env: { ...shown, login: provider([account()], { unavailable: [{ username: "locked@example.test", allowed: false, local: false }] }) }, page: qaPage({ fields: loginFields }) },
  { name: "login-info-provider-error", cmd: "qa-login-info", args: {}, env: { ...shown, login: { error: "저장소 잠김" } }, page: qaPage({ fields: loginFields }) },
  { name: "login-info-other-origin", cmd: "qa-login-info", args: {}, env: { ...shown, login: provider([account()], { origin: "https://other.test" }) }, page: qaPage({ fields: loginFields }) },
  { name: "login-info-blocked-host", cmd: "qa-login-info", args: {}, env: { ...shown, blockedAfterEnable: true, login: provider() }, page: qaPage({ fields: loginFields }) },
  // qa-login-input
  { name: "login-input-password", cmd: "qa-login-input", args: { accountId: "ID(USER)", field: "password", x: 40, y: 90, origin: ORIGIN }, env: { ...shown, secret: PASSWORD, login: provider() }, page: qaPage({ fields: loginFields }) },
  { name: "login-input-username-hidden-tab", cmd: "qa-login-input", args: { accountId: "ID(USER)", field: "username", x: 40, y: 50, origin: ORIGIN }, env: { ...hidden, login: provider() }, page: qaPage({ fields: loginFields }) },
  { name: "login-input-password-guarded-chars", cmd: "qa-login-input", args: { accountId: "ID(USER)", field: "password", x: 40, y: 90, origin: ORIGIN }, env: { ...shown, focus: "guarded", secret: PASSWORD, login: provider() }, page: qaPage({ fields: loginFields }) },
  { name: "login-input-password-borrowed", cmd: "qa-login-input", args: { accountId: "ID(USER)", field: "password", x: 40, y: 90, origin: ORIGIN }, env: { ...shown, focus: "borrowed", focusReturn: "returned", secret: PASSWORD, login: provider() }, page: qaPage({ fields: loginFields }) },
  { name: "login-input-not-allowed", cmd: "qa-login-input", args: { accountId: "ID(USER)", field: "password", x: 40, y: 90, origin: ORIGIN }, env: { ...shown, login: provider([account({ allowed: false })]) }, page: qaPage({ fields: loginFields }) },
  { name: "login-input-approved", cmd: "qa-login-input", args: { accountId: "ID(USER)", field: "password", x: 40, y: 90, origin: ORIGIN, approved: true }, env: { ...shown, secret: PASSWORD, login: provider([account({ allowed: false })]) }, page: qaPage({ fields: loginFields }) },
  { name: "login-input-unknown-account", cmd: "qa-login-input", args: { accountId: "ffffffffffffffffffffffff", field: "password", x: 40, y: 90, origin: ORIGIN }, env: { ...shown, login: provider() }, page: qaPage({ fields: loginFields }) },
  { name: "login-input-bad-field", cmd: "qa-login-input", args: { accountId: "ID(USER)", field: "otp", x: 40, y: 90, origin: ORIGIN }, env: { ...shown, login: provider() }, page: qaPage({ fields: loginFields }) },
  { name: "login-input-origin-changed", cmd: "qa-login-input", args: { accountId: "ID(USER)", field: "password", x: 40, y: 90, origin: "https://moved.test" }, env: { ...shown, login: provider() }, page: qaPage({ fields: loginFields }) },
  { name: "login-input-payment-page", cmd: "qa-login-input", args: { accountId: "ID(USER)", field: "password", x: 40, y: 90, origin: ORIGIN }, env: { ...shown, login: provider() }, page: qaPage({ fields: loginFields, reasons: ["결제 창"] }) },
  { name: "login-input-field-moved", cmd: "qa-login-input", args: { accountId: "ID(USER)", field: "password", x: 41, y: 99, origin: ORIGIN }, env: { ...shown, login: provider() }, page: qaPage({ fields: loginFields }) },
  { name: "login-input-not-focused", cmd: "qa-login-input", args: { accountId: "ID(USER)", field: "password", x: 40, y: 90, origin: ORIGIN }, env: { ...shown, login: provider() }, page: qaPage({ fields: loginFields, loginValid: false }) },
  { name: "login-input-empty-password", cmd: "qa-login-input", args: { accountId: "ID(USER)", field: "password", x: 40, y: 90, origin: ORIGIN }, env: { ...shown, login: provider([account({ password: "" })]) }, page: qaPage({ fields: loginFields }) },
  { name: "login-input-window-not-drawing", cmd: "qa-login-input", args: { accountId: "ID(USER)", field: "password", x: 40, y: 90, origin: ORIGIN }, env: { ...shown, paint: { ok: false, why: "숨김" }, login: provider() }, page: qaPage({ fields: loginFields }) },
  { name: "login-input-no-trusted-event", cmd: "qa-login-input", args: { accountId: "ID(USER)", field: "password", x: 40, y: 90, origin: ORIGIN }, env: { ...shown, secret: PASSWORD, login: provider() }, page: qaPage({ fields: loginFields, bindingEvents: false, pageEvents: false }) },
  // qa-viewport · qa-viewport-state
  { name: "viewport-set", cmd: "qa-viewport", args: { width: 390, height: 844, dpr: 2 }, env: shown, page: qaPage() },
  { name: "viewport-set-zoomed", cmd: "qa-viewport", args: { width: 390, height: 844, dpr: 2 }, env: { ...shown, zoom: 1.25 }, page: qaPage() },
  { name: "viewport-clear", cmd: "qa-viewport", args: { clear: true }, env: { ...shown, viewport: { width: 390, height: 844, dpr: 2 } }, page: qaPage() },
  { name: "viewport-bad-size", cmd: "qa-viewport", args: { width: 0, height: 10 }, env: shown, page: qaPage() },
  { name: "viewport-bad-dpr", cmd: "qa-viewport", args: { width: 390, height: 844, dpr: 9 }, env: shown, page: qaPage() },
  { name: "viewport-state-none", cmd: "qa-viewport-state", args: {}, env: shown, page: qaPage() },
  { name: "viewport-state-set", cmd: "qa-viewport-state", args: {}, env: { ...shown, viewport: { width: 390, height: 844, dpr: 2 } }, page: qaPage() },
  { name: "viewport-state-reconcile-zoom", cmd: "qa-viewport-state", args: {}, env: { ...shown, viewport: { width: 390, height: 844, dpr: 2 }, zoom: 1.5, zoomApplied: 1 }, page: qaPage() },
  // qa-mode 해제
  { name: "mode-off", via: "modeOff", cmd: "qa-mode", args: { enabled: false }, env: shown, page: qaPage() },
  { name: "mode-off-moments", via: "modeOff", cmd: "qa-mode", args: { enabled: false }, env: { ...shown, moments: [{ kind: "toast", text: "저장됨" }] }, page: qaPage() },
  { name: "mode-off-blocked-host", via: "modeOff", cmd: "qa-mode", args: { enabled: false }, env: { ...shown, blockedAfterEnable: true }, page: qaPage() },
];
// 로그인 시나리오의 계정 id 자리표시 · 실제 id 는 출처와 아이디의 해시
export const accountId = (username) => require("node:crypto").createHash("sha256").update(ORIGIN + "\n" + username).digest("hex").slice(0, 24);
const resolveArgs = (args) => JSON.parse(JSON.stringify(args).replace("ID(USER)", accountId(USER)));

// 옛 처리기와 worker 경로가 같이 쓰는 메인 대역 · 효과는 같은 이름과 모양으로 기록
function createWorld(scenario) {
  const env = scenario.env || {};
  const args = resolveArgs(scenario.args ?? {});
  const effects = [];
  const gens = { documentGeneration: 3, debuggerGeneration: 4 };
  const state = { secret: env.secret ?? null, viewport: env.viewport ? clone(env.viewport) : null, blockedLate: false };
  const isBlocked = () => env.blockedHost === true || state.blockedLate;
  const subscribers = new Set();
  const debuggerListeners = new Set();
  const ctl = { emit: (method, params, sid) => {
    for (const listener of [...debuggerListeners]) listener(null, method, clone(params), sid || undefined);
    for (const listener of [...subscribers]) listener(WC_ID, method, clone(params), sid || undefined);
  } };
  const page = scenario.page(ctl);
  const raw = async (method, params, sid) => {
    effects.push(["cdp", method, clone(params ?? {}), sid || null]);
    return clone(await page(method, params ?? {}, sid || null));
  };
  const frames = scenario.frames || [];
  const sandbox = { console, setTimeout, clearTimeout, setImmediate, Buffer, Intl, __effects: effects };
  const context = vm.createContext(sandbox);
  const qaContents = new Set();
  const appliedZoom = { value: env.zoomApplied };
  const guest = Object.assign(new EventEmitter(), {
    id: WC_ID,
    debugger: {
      isAttached: () => env.attached !== false,
      sendCommand: (method, params, sid) => raw(method, params, sid ?? null),
      on: (_name, listener) => { debuggerListeners.add(listener); },
      removeListener: (_name, listener) => { debuggerListeners.delete(listener); },
    },
    hostWebContents: { id: 1, isDestroyed: () => false },
    isDestroyed: () => false,
    getType: () => "webview",
    getURL: () => env.url || LOGIN_URL,
    getTitle: () => "페이지",
    isLoading: () => false,
    canGoBack: () => false,
    canGoForward: () => false,
    getZoomFactor: () => env.zoom ?? 1,
    sendInputEvent: (event) => { effects.push(["wc.input", clone(event)]); ctl.tabInput?.(event); },
  });
  const viewportOwner = {
    viewportFor: (wcId) => (Number(wcId) === WC_ID ? clone(state.viewport) : null),
    setViewportState: (wcId, value) => { effects.push(["viewport.state", wcId, clone(value)]); state.viewport = clone(value); },
  };
  const qaInput = createQaInputCommands({
    prepareFocus: async () => { effects.push(["focus.prepare"]); return env.focus || "trusted"; },
    returnFocus: async () => { effects.push(["focus.return"]); return env.focusReturn ?? null; },
    isTabShown: () => env.shown === true,
  });
  const qaViewport = createQaViewportCommands({
    viewportOwner,
    notify: (id, box) => { effects.push(["viewport.notify", id, clone(box)]); },
    yieldViewport: (id) => { effects.push(["viewport.yield", id]); },
  });
  const provide = async (_wc, options) => {
    effects.push(["login.provider", clone(options)]);
    return clone(env.login);
  };
  const rememberSecret = (wcId, secret) => { effects.push(["rememberSecret", wcId, secret]); if (secret) state.secret = secret; };
  const qaLogin = createQaLoginCommands({
    loginProvider: () => provide,
    input: qaInput["qa-input"],
    resultSafety: { rememberSecret, redactSecrets: (_id, value) => mask(state, value) },
  });
  Object.assign(sandbox, {
    qaContents, qaViewportCommands: qaViewport,
    qaReactionCommands: { dispose: async () => { effects.push(["reaction.dispose"]); } },
    hiddenViewport: {
      ensureReady: async (_send, wcId, command) => { effects.push(["ensureReady", command]); return { ready: true }; },
      yieldToExplicitViewport: (id) => { effects.push(["hidden.yield", id]); },
    },
    deviceEmulation: { viewportFor: (id) => viewportOwner.viewportFor(id) },
  });
  vm.runInContext(`${QA_LEGACY_PARTS.ensureQaReady}${QA_LEGACY_PARTS.setQaMode}\nthis.__qa = { ensureQaReady, setQaMode };`, context);
  if (env.zoomApplied != null) {
    // reconcile 은 앞서 적용한 확대 비율을 기억함 · 시나리오가 정한 값으로 한 번 적용해 둠
    const previous = guest.getZoomFactor;
    guest.getZoomFactor = () => env.zoomApplied;
    state.prime = async () => {
      await qaViewport["qa-viewport"](raw, guest, { ...env.viewport });
      guest.getZoomFactor = previous;
      effects.length = 0;
    };
  }
  // QA 모드를 켠 직후부터 로그인 호스트가 되는 시나리오 (QA 채널은 항상 qa-mode 켜기를 먼저 보냄)
  const setQaMode = async (send, wc, enabled) => {
    const result = await sandbox.__qa.setQaMode(send, wc, enabled);
    if (enabled && env.blockedAfterEnable) state.blockedLate = true;
    return result;
  };
  const parts = { qaInput, qaViewport, qaLogin, rememberSecret, provide, viewportOwner, ensureQaReady: sandbox.__qa.ensureQaReady, setQaMode };
  const finish = () => { effects.push(["final", { viewport: clone(state.viewport), qa: [...qaContents] }]); };
  return { env, args, effects, gens, state, page, raw, frames, parts, finish, ctl, qaContents, guest, subscribers, normalize, isBlocked };
}

// 옛 경로: cdp-control.cjs 의 cdpExecRaw·cdpExecInner 원문을 vm 에서 실행하고 처리기는 실제 cdp-qa-*.cjs · 호출 순서는 QA 채널과 같음(qa-mode 켜기 → 명령)
export async function runLegacy(scenario) {
  const world = createWorld(scenario);
  const { env, args, effects, state, raw, frames, parts, qaContents, guest } = world;
  const send = (method, params) => raw(method, params, null);
  send.on = (sid) => (method, params) => raw(method, params, sid || null);
  send.frames = () => [null, ...frames];
  send.ask = (sid, method, params) => send.on(sid)(method, params).catch(() => null);
  send.all = async (method, params) => (await Promise.all(send.frames().map((sid) => send.ask(sid, method, params)))).filter((r) => r != null);
  const sandbox = { console, setTimeout, clearTimeout, setImmediate, Buffer, Intl };
  const context = vm.createContext(sandbox);
  vm.runInContext(`${LEGACY_PARTS.prelude}${LEGACY_PARTS.consts}${QA_LEGACY_PARTS.readOnly}\nthis.__readOnly = READ_ONLY_CMDS;`, context);
  const observation = createObservation({ captureHold: () => false, isTabShown: () => false, now: Date.now, shotsDir: "/nonexistent", captureMoment: async () => null });
  const commands = {
    ...parts.qaInput, ...parts.qaViewport, ...parts.qaLogin,
    "qa-mode": async (s, w, a) => parts.setQaMode(s, w, a.enabled === true),
  };
  Object.assign(sandbox, {
    qaLedgerAnchor: async () => ({ ok: true }),
    contextActionCommand: async () => ({}),
    commandWebContentsMods: new WeakMap(),
    detachIdle: () => { effects.push(["detachIdle"]); },
    detachAiSession: () => { effects.push(["detachAiSession"]); return false; },
    isTabShown: () => env.shown === true,
    pressAllowed: async () => false,
    paintableProbe: () => env.paint || { ok: true },
    captureHold: async (_id, on) => { effects.push(["hold", on]); return true; },
    observation,
    attachPolicy: { blocked: () => world.isBlocked(), touch() {}, release() {} },
    isGoogleAuthUrl: () => false,
    identityOwnsDebugger: () => false,
    cdpSession: { primed: () => false },
    enterAiCommand: (wcId, cmd) => { if (sandbox.__readOnly.has(cmd)) return null; effects.push(["ai.enter"]); return wcId; },
    leaveAiCommand: (ticket) => { if (ticket != null) effects.push(["ai.leave"]); },
    ensureAttached: () => send,
    ensureQaReady: (s, w, cmd) => parts.ensureQaReady(s, w, cmd),
    runCdpCmd: async (s, w, cmd, cmdArgs) => commands[cmd](s, w, cmdArgs),
    commandHandlers: commands,
    fs: require("node:fs"), path: require("node:path"), SHOTS_DIR: "/nonexistent", pruneShots() {},
  });
  vm.runInContext(`${LEGACY_PARTS.exec}\nthis.__cdpExecRaw = cdpExecRaw;`, context);
  const webContentsMod = { fromId: () => guest };
  const attachMoments = (out) => (env.moments && !qaContents.has(WC_ID) && out && typeof out === "object" && !Array.isArray(out) ? { ...out, moments: clone(env.moments) } : out);
  const exec = async (cmd, cmdArgs) => {
    const out = await sandbox.__cdpExecRaw(webContentsMod, WC_ID, cmd, cmdArgs);
    return attachMoments(out);
  };
  let response;
  try {
    if (scenario.via === "modeOff") {
      await exec("qa-mode", { enabled: true });
      effects.length = 0;
      response = { ok: true, data: mask(state, clone(await exec("qa-mode", { enabled: false }))) };
    } else {
      if (world.state.prime) await world.state.prime();
      await exec("qa-mode", { enabled: true });
      response = { ok: true, data: mask(state, clone(await exec(scenario.cmd, args))) };
    }
  } catch (error) { response = failure(error); }
  world.finish();
  return { response: normalize(response), effects: normalize(effects) };
}

// worker 경로 전체: QA 실행기 → host 확인 창 게이트 → 명령 단위 → Electron 중계 · 메인 모듈은 world 의 대역
export function createWorkerRun(scenario, {
  features = ["worker-command-unit", "worker-qa-input-commands"], hostDialog = null, serial = null, unitIdleMs, unitTimeoutMs = 25000,
  commandId = `${GENERATION}/qa-1`, routes, onExecute = null, identity = { session: "pane", run: "run-1", key: "key-1" }, listen = true,
} = {}) {
  const world = createWorld(scenario);
  const { env, args, effects, gens, state, raw, frames, parts, qaContents, guest, subscribers } = world;
  const relays = [];
  const responses = [];
  const hostState = { dialog: hostDialog };
  const relayListeners = new Set();
  const webContents = { fromId: (id) => (Number(id) === WC_ID ? guest : null) };
  const relay = createElectronRelay({
    webContents,
    targetState: {
      generations: () => ({ ...gens }),
      ownsChildSession: (wcId, sid) => Number(wcId) === WC_ID && frames.includes(sid),
      frames: () => [...frames],
      reset: () => ({ ...gens }),
      isRegistered: () => true,
    },
    currentUrl: () => env.url || LOGIN_URL,
    pendingUrl: () => "",
    blockedUrl: () => false,
    redact: (_wcId, value) => mask(state, value),
    rememberSecret: parts.rememberSecret,
    releaseAttach: () => {},
    observation: { subscribeEvents: (listener) => { subscribers.add(listener); return () => subscribers.delete(listener); }, drainMoments: () => null, clearDiagnostics() {} },
    upload: { invalidPaths: () => [], arm() {}, forget() {}, armed: () => false },
    downloadState: { snapshot: () => ({}), arm() {}, disarm() {} },
    dialogPlan: { set() {} },
    clearDialogPlan() {},
    refs: { record() {}, resolve: () => ({}) },
    loginProvider: parts.provide,
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
    captureHold: async (_wcId, on) => { effects.push(["hold", on]); return true; },
    focus: {
      state: async () => ({ canSendKeys: false, canPress: false, shown: env.shown === true, shownKnown: true, paint: env.paint || { ok: true } }),
      prepare: async () => { effects.push(["focus.prepare"]); return env.focus || "trusted"; },
      return: async () => { effects.push(["focus.return"]); return env.focusReturn ?? null; },
    },
    hiddenViewport: {
      // 옛 cdp-control.cjs 가 viewport.ensureReady 에 넘기는 것과 같은 함수(ensureQaReady 원문)
      ensureReady: async (wc, command, send) => { await parts.ensureQaReady(send, wc, command); return { ready: true }; },
      release: async () => ({}),
    },
    viewport: {
      explicit: (wcId) => parts.viewportOwner.viewportFor(wcId),
      current: (wcId) => parts.viewportOwner.viewportFor(wcId),
      revision: () => 0,
      apply: async () => ({}),
    },
    qaMode: (wc, enabled, send) => parts.setQaMode(send, wc, enabled),
    qaViewport: (wc, viewportArgs, send) => parts.qaViewport["qa-viewport"](send, wc, viewportArgs),
    qaViewportRelease: () => { effects.push(["qa-viewport.release"]); },
    emitEvent: (event) => { for (const listener of [...relayListeners]) listener(event); return true; },
    codedError: coded,
  });
  const queues = new Map();
  const releases = [];
  const units = createCommandUnits({
    queues,
    execute: (request) => relay.execute(request),
    redact: (_key, value) => mask(state, value),
    attachMoments: (_key, cmd, value) => (env.moments && !qaContents.has(WC_ID) && cmd !== "qa-observe" && value && typeof value === "object" && !Array.isArray(value) ? { ...value, moments: clone(env.moments) } : value),
    resetSession: () => {},
    liveTab: () => true,
    watchTab: () => () => {},
    codedError: coded,
    onClose: async (info) => { releases.push(info); await relay.releaseCommand(info.generation, info.commandId); },
    timeoutMs: unitTimeoutMs,
    tailGraceMs: 10,
  });
  const wiring = createUnitWiring({ getUnits: () => units, getRelay: () => relay, codedError: coded, liveWc: () => guest });
  // cdp-control.cjs cdpExec 의 worker 분기와 같은 모양
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
        // 단위 표시 없는 옛 봉투 · 옛 처리기는 이 시험의 대상이 아니라 명령 이름만 돌려줌
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
    resolveForCommand: async (_identity, input) => ({ tabId: input.tabId, wcId: WC_ID, targetToken: input.targetToken }),
    execute,
    raceDialog: async (_target, pending) => pending,
    currentDialog: () => hostState.dialog,
    redact: async (text) => text,
  });
  let sequence = 0;
  const context = new AsyncLocalStorage();
  const hostApi = {
    withCommand: (command, run) => context.run(command, run),
    current: () => context.getStore() || {},
    onRelayEvent: (listener) => { if (!listen) return () => {}; relayListeners.add(listener); return () => relayListeners.delete(listener); },
    call: async (operation, input) => {
      const store = context.getStore() || {};
      const currentId = store.commandId || commandId;
      if (operation === "browser.resolveForCommand") return { tabId: input.tabId, targetToken: { wcId: WC_ID, ...gens } };
      if (operation === "browser.status") return { executorReady: true, executor: { app: "x", pid: 1, features } };
      if (operation !== "browser.executeWithDialog") return {};
      const { command, args: baseArgs, unit } = input.relay;
      relays.push({ command, args: clone(baseArgs), unit: clone(unit), targetToken: clone(input.targetToken), commandId: currentId, input: clone({ ...input, relay: undefined }) });
      const ctx = { identity: store.identity || identity, input, request: { workerGeneration: GENERATION, commandId: currentId, callId: ++sequence } };
      const locks = HOST_OPERATION_DEFINITIONS["browser.executeWithDialog"].locks(ctx);
      const response = await (serial ? serial.run(locks, () => dialogHost.executeWithDialog(ctx)) : dialogHost.executeWithDialog(ctx));
      responses.push(clone(response));
      return response;
    },
  };
  const executor = createQaExecutor({ hostApi, ...(routes ? { routes } : {}) });
  let accepted = false;
  const accept = async () => {
    if (accepted) return;
    accepted = true;
    await relay.acceptGeneration(GENERATION, { id: "conn" });
  };
  const inContext = (run) => hostApi.withCommand({ identity, commandId }, run);
  return {
    effects, relays, responses, hostState, queues, releases, relay, units, world, args, executor, hostApi, accept, inContext,
    execute: async (command = scenario.cmd, executeArgs = args) => {
      await accept();
      return clone(await inContext(() => executor.execute("tab-a", command, executeArgs)));
    },
    run: async () => {
      await accept();
      let response;
      if (scenario.via === "modeOff") {
        // QA 모드를 켠 상태로 시작 · 켜기는 읽기 전용 명령 하나를 실행하며 함께 일어남
        await inContext(() => executor.execute("tab-a", "qa-viewport-state", {}));
        effects.length = 0;
        response = clone(await inContext(() => executor.modeOff("tab-a")));
      } else {
        if (world.state.prime) await world.state.prime();
        response = clone(await inContext(() => executor.execute("tab-a", scenario.cmd, args)));
      }
      world.finish();
      return { response: normalize(response), effects: normalize(effects) };
    },
  };
}
