// 입력 명령 worker 경로 시험용: 가짜 페이지 시나리오 · 옛 처리기 실행기(cdp-control.cjs 원문을 vm 에서 실행) · worker 경로 대역
import fs from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

import { createWorkerBrowserService } from "../../server/mcp-worker/browser-service.js";

const require = createRequire(import.meta.url);
const refRegistry = require("../../native/electron/cdp-ref-registry.cjs");
const { createInputCommands } = require("../../native/electron/cdp-cmd-input.cjs");
const { withLayout } = require("../../native/electron/cdp-layout.cjs");
const { createObservation } = require("../../native/electron/cdp-observation.cjs");

export const CONTROL_SOURCE = fs.readFileSync(new URL("../../native/electron/cdp-control.cjs", import.meta.url), "utf8");
const WC_ID = 7;
const TOKEN = { wcId: WC_ID, documentGeneration: 3, debuggerGeneration: 4 };

// cdp-control.cjs 에서 [시작 문구, 끝 문구) 구간을 그대로 꺼냄 · 원본이 바뀌어 못 찾으면 시험이 실패
export function slice(source, from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  if (start < 0 || end < 0) throw new Error(`cdp-control.cjs 에서 구간을 찾지 못했습니다: ${from.slice(0, 30)}`);
  return source.slice(start, end);
}
const statement = (name) => {
  const match = new RegExp(`^const ${name} = [\\s\\S]*?;\\n`, "m").exec(CONTROL_SOURCE);
  if (!match) throw new Error(`cdp-control.cjs 에서 ${name} 를 찾지 못했습니다`);
  return match[0];
};

export const LEGACY_PARTS = {
  prelude: slice(CONTROL_SOURCE, "const ERROR_CODES = Object.freeze({", "// ref map과 navigation/snapshot 세대는"),
  consts: ["CDP_FREE_CMDS", "NEEDS_PIXELS", "KEYS_NEED_PAINT", "NEEDS_KEYS"].map(statement).join(""),
  nodeFromArgs: slice(CONTROL_SOURCE, "async function nodeFromArgs(send, wc, args) {", "// 모든 명령을 순차 실행한다"),
  insert: slice(CONTROL_SOURCE, "// Input.insertText 한 번에 붙여 넣기 크기의", "// selector 로 찾은 요소를 CDP 없이"),
  exec: slice(CONTROL_SOURCE, "// selector 로 찾은 요소를 CDP 없이 네이티브 입력으로 누른다.", "async function runCdpCmd("),
};

const BOX = { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } };
const value = (v) => ({ result: { value: v } });

// 페이지 대역: 공통 CDP 메서드를 흉내내고 시나리오가 evaluate·callFn 으로 나머지를 정함
export function pageOf({ innerWidth = 1280, evaluate = () => ({}), callFn = () => ({}), box = BOX, extra = {} } = {}) {
  let n = 0;
  return async (method, params = {}, sid = null) => {
    n += 1;
    if (extra[method]) return extra[method](params, sid, n);
    switch (method) {
      case "Runtime.evaluate":
        if (params.expression === "innerWidth") return value(innerWidth);
        if (String(params.expression).includes("getAnimations")) return value(0);
        return evaluate(String(params.expression), sid, params, n);
      case "DOM.getBoxModel": return box;
      case "DOM.resolveNode": return { object: { objectId: `obj-${params.backendNodeId}` } };
      case "Runtime.callFunctionOn": return callFn(params, sid, n);
      default: return {};
    }
  };
}

const ref1 = { "@e1": { backendDOMNodeId: 11, role: "button", name: "저장", sid: null } };
const refFrame = { "@e1": { backendDOMNodeId: 21, role: "button", name: "결제", sid: "frame-1" } };
const shownEnv = { attached: true, owns: true, canPress: true, shown: true, paint: { ok: true }, moments: [{ kind: "toast", text: "저장됨" }] };
const hiddenEnv = { ...shownEnv, owns: false, canPress: false, shown: false };
const fillVerify = (ok = true, got = "iris") => value({ ok, got, contenteditable: false });
const callFnValue = (v) => () => value(v);

export const SCENARIOS = [
  { name: "click-ref-input", cmd: "click", args: { ref: "@e1" }, refs: ref1, env: shownEnv, page: () => pageOf() },
  { name: "click-ref-element-focus-guard", cmd: "click", args: { ref: "@e1" }, refs: ref1, env: { ...shownEnv, owns: false, canPress: false }, page: () => pageOf() },
  { name: "click-ref-hidden-layout", cmd: "click", args: { ref: "@e1" }, refs: ref1, env: hiddenEnv, page: () => pageOf({ innerWidth: 0 }) },
  { name: "click-ref-iframe", cmd: "click", args: { ref: "@e1" }, refs: refFrame, frames: ["frame-1"], env: shownEnv, page: () => pageOf() },
  { name: "click-ref-no-snapshot", cmd: "click", args: { ref: "@e1" }, env: shownEnv, page: () => pageOf() },
  { name: "click-ref-unknown", cmd: "click", args: { ref: "@zz" }, refs: ref1, env: shownEnv, page: () => pageOf() },
  { name: "click-ref-box-failure", cmd: "click", args: { ref: "@e1" }, refs: ref1, env: shownEnv, page: () => pageOf({ extra: { "DOM.getBoxModel": () => { throw new Error("노드 없음"); } } }) },
  { name: "dblclick-ref-input", cmd: "dblclick", args: { ref: "@e1" }, refs: ref1, env: shownEnv, page: () => pageOf() },
  { name: "click-blocked-host", cmd: "click", args: { ref: "@e1" }, refs: ref1, env: { ...shownEnv, blockedHost: true }, page: () => pageOf() },
  { name: "click-sel-native", cmd: "click", args: { sel: "#save" }, env: { ...shownEnv, exec: () => ({ x: 120.4, y: 80.6 }) }, page: () => pageOf() },
  { name: "dblclick-sel-native", cmd: "dblclick", args: { sel: "#save" }, env: { ...shownEnv, exec: () => ({ x: 120.4, y: 80.6 }) }, page: () => pageOf() },
  { name: "click-sel-js-focus-guard", cmd: "click", args: { sel: "#save" }, env: { ...shownEnv, canPress: false, exec: () => ({ found: true, ok: true }) }, page: () => pageOf() },
  { name: "click-sel-js-hidden-tab", cmd: "click", args: { sel: "#save" }, env: { ...hiddenEnv, exec: () => ({ found: true, ok: true }) }, page: () => pageOf() },
  { name: "click-sel-js-refused", cmd: "click", args: { sel: "#save" }, env: { ...hiddenEnv, exec: () => ({ found: true, ok: false, why: "숨겨진 요소" }) }, page: () => pageOf() },
  { name: "click-sel-detached-before", cmd: "click", args: { sel: "#save" }, env: { ...shownEnv, attached: false, exec: () => ({ x: 5, y: 6 }) }, page: () => pageOf() },
  {
    name: "click-sel-not-found-falls-to-cdp", cmd: "click", args: { sel: "#save" }, frames: ["frame-1"],
    env: { ...shownEnv, canPress: false, exec: () => ({ found: false }) },
    page: () => pageOf({ extra: {
      "DOM.getDocument": (_p, sid) => ({ root: { nodeId: sid ? 2 : 1 } }),
      "DOM.querySelector": (_p, sid) => (sid ? { nodeId: 9 } : { nodeId: 0 }),
      "DOM.describeNode": () => ({ node: { backendNodeId: 31 } }),
    } }),
  },
  { name: "click-sel-nowhere", cmd: "click", args: { sel: "#nope" }, env: { ...shownEnv, exec: () => null },
    page: () => pageOf({ extra: { "DOM.getDocument": () => ({ root: { nodeId: 1 } }), "DOM.querySelector": () => ({ nodeId: 0 }) } }) },
  { name: "hover-ref", cmd: "hover", args: { ref: "@e1" }, refs: ref1, env: shownEnv, page: () => pageOf() },
  { name: "hover-ref-iframe", cmd: "hover", args: { ref: "@e1" }, refs: refFrame, frames: ["frame-1"], env: shownEnv, page: () => pageOf() },
  { name: "fill-ref-input", cmd: "fill", args: { ref: "@e1", text: "iris" }, refs: ref1, env: shownEnv,
    page: () => pageOf({ evaluate: (expr) => (expr.includes("ok:v===") ? fillVerify() : {}) }) },
  { name: "fill-ref-direct-focus-guard", cmd: "fill", args: { ref: "@e1", text: "iris" }, refs: ref1, env: { ...shownEnv, owns: false },
    page: () => pageOf({ callFn: callFnValue({ ok: true, got: "iris", contenteditable: false }) }) },
  { name: "fill-ref-hidden-tab-hold", cmd: "fill", args: { ref: "@e1", text: "iris" }, refs: ref1, env: hiddenEnv,
    page: () => pageOf({ callFn: callFnValue({ ok: true, got: "iris", contenteditable: true }) }) },
  { name: "fill-ref-iframe", cmd: "fill", args: { ref: "@e1", text: "iris" }, refs: refFrame, frames: ["frame-1"], env: shownEnv,
    page: () => pageOf({ callFn: callFnValue({ ok: true, got: "iris", contenteditable: false }) }) },
  { name: "fill-ref-press-fallback", cmd: "fill", args: { ref: "@e1", text: "iris" }, refs: ref1, env: shownEnv,
    page: () => pageOf({ evaluate: (() => { let verifies = 0; return (expr) => (expr.includes("ok:v===") ? fillVerify(++verifies > 1, verifies > 1 ? "iris" : "") : {}); })() }) },
  { name: "fill-ref-forced-fallback", cmd: "fill", args: { ref: "@e1", text: "iris" }, refs: ref1, env: shownEnv,
    page: () => pageOf({ evaluate: (expr) => (expr.includes("입력칸에 포커스가 없습니다") ? fillVerify(true, "iris") : expr.includes("ok:v===") ? fillVerify(false, "") : {}) }) },
  { name: "fill-ref-all-fail", cmd: "fill", args: { ref: "@e1", text: "iris" }, refs: ref1, env: shownEnv,
    page: () => pageOf({ evaluate: (expr) => (expr.includes("입력칸에 포커스가 없습니다") ? fillVerify(false, "x") : expr.includes("ok:v===") ? fillVerify(false, "") : {}) }) },
  { name: "fill-window-not-drawing", cmd: "fill", args: { ref: "@e1", text: "iris" }, refs: ref1, env: { ...shownEnv, paint: { ok: false, why: "최소화" } }, page: () => pageOf() },
  { name: "type-owns-focus", cmd: "type", args: { text: "안녕" }, env: shownEnv, page: () => pageOf() },
  { name: "type-expression-focus-guard", cmd: "type", args: { text: "안녕" }, env: { ...shownEnv, owns: false },
    page: () => pageOf({ evaluate: () => value({ ok: true, via: "페이지 안 입력" }) }) },
  { name: "type-cross-frame", cmd: "type", args: { text: "안녕" }, frames: ["frame-1", "frame-2"], env: { ...shownEnv, owns: false },
    page: () => pageOf({ evaluate: (expr, sid) => (expr.includes("crossFrame") || expr.includes("insertText") ? (sid ? value({ ok: true, via: "페이지 안 입력" }) : value({ ok: false, crossFrame: true })) : value(sid === "frame-2")) }) },
  { name: "type-no-cursor", cmd: "type", args: { text: "x" }, env: { ...shownEnv, owns: false }, page: () => pageOf({ evaluate: () => value({ ok: false, why: "커서가 어디에도 없습니다" }) }) },
  { name: "key-enter", cmd: "key", args: { key: "Enter" }, env: shownEnv, page: () => pageOf({ evaluate: () => value(JSON.stringify({ did: "폼 보냄", prevented: false, on: "INPUT" })) }) },
  { name: "key-bad-name", cmd: "key", args: { key: "Hyper+X+Y" }, env: shownEnv, page: () => pageOf() },
  { name: "select-ref", cmd: "select", args: { ref: "@e1", value: "KR" }, refs: ref1, env: shownEnv, page: () => pageOf({ callFn: callFnValue({ ok: true, selected: "한국", value: "KR" }) }) },
  { name: "select-ref-missing-option", cmd: "select", args: { ref: "@e1", value: "ZZ" }, refs: ref1, env: shownEnv, page: () => pageOf({ callFn: callFnValue({ ok: false, err: "옵션을 찾을 수 없음: ZZ" }) }) },
  { name: "check-ref", cmd: "check", args: { ref: "@e1", value: false }, refs: ref1, env: shownEnv, page: () => pageOf({ callFn: callFnValue({ ok: true, was: true, now: false, via: "input" }) }) },
  { name: "check-ref-reverted", cmd: "check", args: { ref: "@e1" }, refs: ref1, env: shownEnv, page: () => pageOf({ callFn: callFnValue({ ok: false, was: false, now: false, via: "input" }) }) },
  { name: "clear-ref", cmd: "clear", args: { ref: "@e1" }, refs: ref1, env: shownEnv, page: () => pageOf({ callFn: callFnValue({ ok: true, left: 0 }) }) },
  { name: "clear-ref-left", cmd: "clear", args: { ref: "@e1" }, refs: ref1, env: shownEnv, page: () => pageOf({ callFn: callFnValue({ ok: true, left: 3 }) }) },
  { name: "focus-ref", cmd: "focus", args: { ref: "@e1" }, refs: ref1, env: shownEnv, page: () => pageOf({ callFn: callFnValue({ ok: true, tag: "input" }) }) },
  { name: "scroll-down", cmd: "scroll", args: {}, env: shownEnv, page: () => pageOf({ evaluate: () => value({ y: 600, h: 3000, vh: 700 }) }) },
  { name: "scroll-pixels-hidden-tab", cmd: "scroll", args: { amount: "-120" }, env: hiddenEnv, page: () => pageOf({ evaluate: () => value({ y: 0, h: 3000, vh: 700 }) }) },
  { name: "scrollto", cmd: "scrollto", args: { x: 0, y: 900 }, env: shownEnv, page: () => pageOf({ evaluate: () => value({ y: 900, x: 0 }) }) },
  { name: "bulkfill-ok", cmd: "bulkfill", args: { values: ["가", "나", "다"], advance: "Tab" }, env: shownEnv,
    page: () => pageOf({ evaluate: (() => { let texts = 0; return (expr) => (expr.includes("innerText") ? value(++texts === 1 ? "시작" : "시작 다") : value({ ok: true, via: "입력칸" })); })() }) },
  { name: "bulkfill-hidden-tab", cmd: "bulkfill", args: { values: ["가"] }, env: hiddenEnv, page: () => pageOf() },
  { name: "bulkfill-bad-advance", cmd: "bulkfill", args: { values: ["가"], advance: "Escape" }, env: shownEnv, page: () => pageOf() },
  { name: "bulkfill-stops-secret", cmd: "bulkfill", args: { values: ["가", "hunter2-pw", "다"] }, env: { ...shownEnv, secret: "hunter2-pw" },
    page: () => pageOf({ evaluate: (() => { let ones = 0; return (expr) => (expr.includes("innerText") ? value("본문") : ++ones < 2 ? value({ ok: true, via: "입력칸" }) : value({ ok: false, why: "커서가 어디에도 없습니다" })); })() }) },
  { name: "bulkfill-stops", cmd: "bulkfill", args: { values: ["가", "나", "다"] }, env: shownEnv,
    page: () => pageOf({ evaluate: (() => { let ones = 0; return (expr) => (expr.includes("innerText") ? value("본문") : ++ones < 2 ? value({ ok: true, via: "입력칸" }) : value({ ok: false, why: "커서가 어디에도 없습니다" })); })() }) },
];

// 메인 redactSecrets 대역: 저장된 비밀 문자열을 가림
const mask = (env, v) => (env.secret ? JSON.parse(JSON.stringify(v ?? null).split(env.secret).join("••••")) : v);
const clone = (v) => JSON.parse(JSON.stringify(v ?? null));
const failure = (error) => ({ ok: false, error: String((error && error.message) || error), ...(error && error.code ? { code: error.code } : {}) });

function recordRefs(scenario) {
  refRegistry.clear(WC_ID);
  if (scenario.refs) {
    refRegistry.recordSnapshot(WC_ID, new Map(Object.entries(scenario.refs)));
  }
}

// 옛 경로: cdp-control.cjs 의 cdpExecRaw·cdpExecInner 원문을 vm 에서 실행 · 바깥 상태는 대역
export async function runLegacy(scenario) {
  const effects = [];
  const env = scenario.env;
  const page = scenario.page();
  recordRefs(scenario);
  const raw = async (method, params, sid) => {
    effects.push(["cdp", method, clone(params ?? {}), sid || null]);
    return clone(await page(method, params ?? {}, sid || null));
  };
  const send = (method, params) => raw(method, params, null);
  send.on = (sid) => (method, params) => raw(method, params, sid || null);
  send.frames = () => [null, ...(scenario.frames || [])];
  send.ask = (sid, method, params) => send.on(sid)(method, params).catch(() => null);
  send.all = async (method, params) => (await Promise.all(send.frames().map((sid) => send.ask(sid, method, params)))).filter((r) => r != null);

  const wc = {
    id: WC_ID, isDestroyed: () => false,
    debugger: { isAttached: () => env.attached !== false },
    executeJavaScript: async (source, gesture) => { effects.push(["wc.exec", source, gesture]); return clone(env.exec ? env.exec(source) : null); },
    sendInputEvent: (event) => { effects.push(["wc.input", clone(event)]); },
  };
  const sandbox = { console, setTimeout, clearTimeout, setImmediate, Buffer, Intl };
  const context = vm.createContext(sandbox);
  vm.runInContext(`${LEGACY_PARTS.prelude}${LEGACY_PARTS.consts}`, context);
  const observation = createObservation({ captureHold: () => false, isTabShown: () => false, now: Date.now, shotsDir: "/nonexistent", captureMoment: async () => null });
  // nodeFromArgs · insertTextInChunks 도 원문 그대로
  sandbox.refRegistry = refRegistry;
  vm.runInContext(`${LEGACY_PARTS.nodeFromArgs}${LEGACY_PARTS.insert}\nthis.__parts = { nodeFromArgs, insertTextInChunks };`, context);
  const { nodeFromArgs, insertTextInChunks } = sandbox.__parts;

  const commands = createInputCommands({
    withLayout, nodeFromArgs, insertTextInChunks,
    isTabShown: () => env.shown === true,
    run: (s, w, cmd, args) => commands[cmd](s, w, args),
    webContentsMod: () => ({}),
    ownsUserFocus: async () => env.owns === true,
    pressAllowed: async () => env.canPress === true,
  });
  Object.assign(sandbox, {
    qaLedgerAnchor: async () => ({ ok: true }),
    contextActionCommand: async () => ({}),
    commandWebContentsMods: new WeakMap(),
    detachIdle: () => { effects.push(["detachIdle"]); },
    detachAiSession: () => false,
    isTabShown: () => env.shown === true,
    pressAllowed: async () => env.canPress === true,
    paintableProbe: () => env.paint,
    captureHold: async (_id, on) => { effects.push(["hold", on]); return true; },
    observation,
    attachPolicy: { blocked: () => env.blockedHost === true, touch() {}, release() {} },
    isGoogleAuthUrl: () => false,
    identityOwnsDebugger: () => false,
    cdpSession: { primed: () => false },
    enterAiCommand: (id) => { effects.push(["ai.enter"]); return id; },
    leaveAiCommand: () => { effects.push(["ai.leave"]); },
    ensureAttached: () => send,
    ensureQaReady: async (_s, _w, cmd) => { effects.push(["ensureReady", cmd]); },
    runCdpCmd: async (s, w, cmd, args) => commands[cmd](s, w, args),
    commandHandlers: commands,
    fs, path: require("node:path"), SHOTS_DIR: "/nonexistent", pruneShots() {},
  });
  vm.runInContext(`${LEGACY_PARTS.exec}\nthis.__cdpExecRaw = cdpExecRaw;`, context);
  const webContentsMod = { fromId: () => wc };
  let response;
  try {
    const out = await sandbox.__cdpExecRaw(webContentsMod, WC_ID, scenario.cmd, scenario.args);
    // execWithReattach → attachMoments: 성공한 객체 응답에만 관찰 순간을 비워 붙임
    if (env.moments && out && typeof out === "object" && !Array.isArray(out)) out.moments = clone(env.moments);
    response = { ok: true, data: mask(env, clone(out)) };
  } catch (error) { response = failure(error); }
  return { response: clone(response), effects };
}

const done = (data) => ({ ok: true, data, commandState: "completed" });
const fail = (error, code) => ({ ok: false, error, ...(code ? { code } : {}), commandState: "completed" });

// worker 경로: 메인 기본 명령 대역 · 효과는 옛 경로 효과와 같은 모양으로 기록
export function createWorkerRun(scenario, { legacyResponse = null, blockAt = null, features = ["worker-command-unit", "worker-input-commands"], routes } = {}) {
  const env = scenario.env;
  const page = scenario.page();
  const effects = [];
  const relays = [];
  recordRefs(scenario);
  let sends = 0;
  let blocked = false;
  const block = () => ({ ok: false, dialogOpen: { kind: "alert", message: "열림" }, error: "확인 창", commandState: "blocked" });
  const hostApi = {
    withCommand: (_command, run) => run(),
    call: async (operation, input) => {
      if (operation === "journal.accept") return {};
      if (operation === "browser.commandGuard") return { qaOwned: false };
      if (operation === "browser.commandTargetState") return { target: { tabId: "tab-a", targetToken: TOKEN, tab: { url: "http://localhost:3000/sheet" } } };
      if (operation === "browser.status") return { executorReady: true, executor: { app: "x", pid: 1, features } };
      if (operation !== "browser.executeWithDialog") return {};
      const { command, args, unit } = input.relay;
      relays.push({ command, args, unit, targetToken: input.targetToken });
      if (command === "unit.end") return done({ ended: true });
      if (blocked) return block();
      const out = await baseCommand(command, args);
      // 마지막 호출의 응답에 관찰 순간을 비워 붙임 (메인 attachMoments)
      if (unit?.phase === "last" && out.ok && env.moments && out.data && typeof out.data === "object") {
        return { ...out, data: { ...out.data, moments: clone(env.moments) } };
      }
      return out;
    },
  };
  async function baseCommand(command, args) {
    switch (command) {
      case "cdp.attach":
        if (env.blockedHost) return fail(legacyResponse?.error || "로그인 호스트에서는 CDP 를 붙이지 않아 실행할 수 없습니다.", "cdp_blocked");
        return done({ documentGeneration: TOKEN.documentGeneration, debuggerGeneration: TOKEN.debuggerGeneration });
      case "ai.enter": effects.push(["ai.enter"]); return done({ ticket: "t1" });
      case "ai.leave": effects.push(["ai.leave"]); return done({ left: true });
      case "viewport.ensureReady": effects.push(["ensureReady", args.command]); return done({ ready: true });
      case "focus.state": return done({ canSendKeys: env.owns === true, canPress: env.canPress === true, shown: env.shown === true, shownKnown: true, paint: env.paint });
      case "hold.capture": effects.push(["hold", args.on !== false]); return done({ held: true });
      case "cdp.frames": return done({ frames: scenario.frames || [], documentGeneration: 3, debuggerGeneration: 4 });
      case "cdp.detachIdle":
        if (env.attached !== false) effects.push(["detachIdle"]);
        // 떼면 debugger 세대가 오름 (붙어 있었을 때만)
        return done({ wasAttached: env.attached !== false, documentGeneration: TOKEN.documentGeneration, debuggerGeneration: env.attached !== false ? 9 : TOKEN.debuggerGeneration });
      case "ref.resolve":
        try { const entry = refRegistry.resolveRef(WC_ID, args.ref); return done({ backendDOMNodeId: entry.backendDOMNodeId, sid: entry.sid ?? null }); }
        catch (error) { return fail(error.message, error.code); }
      case "wc.exec": effects.push(["wc.exec", args.source, args.userGesture === true]); return done(clone(env.exec ? env.exec(args.source) : null));
      case "wc.input": effects.push(["wc.input", clone(args.event)]); return done({ ok: true });
      case "result.redact": return done({ value: mask(env, clone(args.value)) });
      case "cdp.send": {
        sends += 1;
        if (blockAt === sends) { blocked = true; return block(); }
        effects.push(["cdp", args.method, clone(args.params ?? {}), args.sessionId || null]);
        try { return done(clone(await page(args.method, args.params ?? {}, args.sessionId || null))); }
        catch (error) { return fail(String(error.message || error)); }
      }
      default: throw new Error(`예상하지 않은 중계 명령 ${command}`);
    }
  }
  const service = createWorkerBrowserService({ hostApi, activity: { run: (_kind, _id, run) => run() }, ...(routes ? { routes } : {}) });
  return {
    effects, relays,
    run: async () => clone(await service.dispatch({ command: scenario.cmd, args: scenario.args, identity: { session: "pane" }, commandId: "c/1" })),
  };
}
