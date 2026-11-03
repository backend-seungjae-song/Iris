// 네이티브 명령 worker 경로 시험용: 가짜 페이지·OS 창 시나리오 · 옛 처리기 실행기(cdp-control.cjs cdpExecRaw·cdpExecInner 원문을 vm 에서 실행) · worker 경로 전체 대역
// worker 경로는 실제 worker 서비스 → 실제 host 확인 창 게이트 → 실제 명령 단위(command-units) → 실제 Electron 중계(relay) 를 거침 · 메인 모듈만 대역
import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

import { createBrowserDialogHost } from "../../server/mcp-host/browser-dialog.js";
import { HOST_OPERATION_DEFINITIONS } from "../../server/mcp-host/operations.js";
import { createWorkerBrowserService } from "../../server/mcp-worker/browser-service.js";
import { createWorkerHostTaskService } from "../../server/mcp-worker/host-task-service.js";
import { CONTROL_SOURCE, LEGACY_PARTS, pageOf } from "./input-route-scenarios.mjs";

const require = createRequire(import.meta.url);
const refRegistry = require("../../native/electron/cdp-ref-registry.cjs");
const { createNativeCommands } = require("../../native/electron/cdp-cmd-native.cjs");
const { createObservation } = require("../../native/electron/cdp-observation.cjs");
const { createUploadController } = require("../../native/electron/cdp-upload.cjs");
const { createElectronRelay } = require("../../native/electron/relay/index.cjs");
const { createCommandUnits } = require("../../native/electron/relay/command-units.cjs");
const { createUnitWiring } = require("../../native/electron/relay/unit-wiring.cjs");

export const WC_ID = 7;
export const FAKE_SECRET = "pw-SECRET-4f9a2c";
export const GENERATION = "boot:1";
const clone = (v) => JSON.parse(JSON.stringify(v ?? null));
const coded = (code, message) => Object.assign(new Error(message), { code });
const failure = (error) => ({ ok: false, error: String((error && error.message) || error), ...(error && error.code ? { code: error.code } : {}) });
const mask = (state, v) => (state.secret ? JSON.parse(JSON.stringify(v ?? null).split(state.secret).join("••••")) : v);
const CDP_FREE = ["goto", "url", "back", "forward", "reload", "wait", "text", "screenshot", "login", "dialogs", "download", "nativewin", "nativekey", "nativeclick"];

export { CONTROL_SOURCE, LEGACY_PARTS };

// 옛 cdp-control.cjs READ_ONLY_CMDS 원문
const READ_ONLY_SOURCE = (() => {
  const match = /^const READ_ONLY_CMDS = new Set\(\[[\s\S]*?\]\);\n/m.exec(CONTROL_SOURCE);
  if (!match) throw new Error("cdp-control.cjs 에서 READ_ONLY_CMDS 를 찾지 못했습니다");
  return match[0];
})();

const frameDoc = {
  "DOM.getDocument": (_p, sid) => ({ root: { nodeId: sid ? 2 : 1 } }),
  "DOM.querySelector": (_p, sid) => (sid ? { nodeId: 9 } : { nodeId: 0 }),
  "DOM.describeNode": () => ({ node: { backendNodeId: 31 } }),
};
const ref1 = { "@e1": { backendDOMNodeId: 11, role: "textbox", name: "파일", sid: null } };
const filesAt = (root, ...names) => names.map((name) => path.join(root, "files", name));
const setupFiles = (root) => {
  fs.mkdirSync(path.join(root, "files"), { recursive: true });
  fs.writeFileSync(path.join(root, "files", "a.txt"), "a");
  fs.writeFileSync(path.join(root, "files", "b.txt"), "b");
};
const shownEnv = { shown: true };
const hiddenEnv = { shown: false };
const longMessage = "긴 문구 ".repeat(100);

export const SCENARIOS = [
  // dialoginfo
  { name: "dialoginfo-open", cmd: "dialoginfo", args: {}, env: { ...shownEnv, dialog: { type: "confirm", message: "삭제할까요?" } } },
  { name: "dialoginfo-none", cmd: "dialoginfo", args: {}, env: shownEnv },
  { name: "dialoginfo-long-message", cmd: "dialoginfo", args: {}, env: { ...shownEnv, dialog: { type: "alert", message: longMessage } } },
  { name: "dialoginfo-blocked-host", cmd: "dialoginfo", args: {}, env: { ...shownEnv, blockedHost: true } },
  // dialogs
  { name: "dialogs-off-default", cmd: "dialogs", args: {}, env: shownEnv },
  { name: "dialogs-off-word", cmd: "dialogs", args: { plan: " off " }, env: shownEnv },
  { name: "dialogs-off-with-text", cmd: "dialogs", args: { plan: "off", text: "메모" }, env: shownEnv },
  { name: "dialogs-ok", cmd: "dialogs", args: { plan: "ok" }, env: shownEnv },
  { name: "dialogs-cancel-with-text", cmd: "dialogs", args: { plan: "cancel", text: "사유" }, env: shownEnv },
  { name: "dialogs-queue", cmd: "dialogs", args: { plan: "ok, cancel ,ok" }, env: shownEnv },
  { name: "dialogs-bad-word", cmd: "dialogs", args: { plan: "ok,maybe" }, env: shownEnv },
  { name: "dialogs-blocked-host", cmd: "dialogs", args: { plan: "ok" }, env: { ...shownEnv, blockedHost: true } },
  { name: "dialogs-hidden-tab", cmd: "dialogs", args: { plan: "cancel" }, env: hiddenEnv },
  // upload
  { name: "upload-arm", cmd: "upload", args: (root) => ({ paths: filesAt(root, "a.txt") }), setup: setupFiles, env: shownEnv },
  { name: "upload-arm-timeout", cmd: "upload", args: (root) => ({ paths: filesAt(root, "a.txt", "b.txt"), timeout: 5000 }), setup: setupFiles, env: shownEnv },
  { name: "upload-arm-timeout-clamped", cmd: "upload", args: (root) => ({ paths: filesAt(root, "a.txt"), timeout: 999999 }), setup: setupFiles, env: shownEnv },
  { name: "upload-arm-comma-string", cmd: "upload", args: (root) => ({ paths: filesAt(root, "a.txt", "b.txt").join(" , ") }), setup: setupFiles, env: shownEnv },
  { name: "upload-direct-ref", cmd: "upload", args: (root) => ({ paths: filesAt(root, "a.txt"), ref: "@e1" }), setup: setupFiles, refs: ref1, env: shownEnv },
  { name: "upload-direct-sel-iframe", cmd: "upload", args: (root) => ({ paths: filesAt(root, "a.txt"), sel: "input[type=file]" }), setup: setupFiles, frames: ["frame-1"],
    page: () => pageOf({ extra: { ...frameDoc, "DOM.querySelector": (_p, sid) => (sid ? { nodeId: 9 } : { nodeId: 0 }) } }), env: shownEnv },
  { name: "upload-direct-ref-unknown", cmd: "upload", args: (root) => ({ paths: filesAt(root, "a.txt"), ref: "@zz" }), setup: setupFiles, refs: ref1, env: shownEnv },
  { name: "upload-direct-sel-nowhere", cmd: "upload", args: (root) => ({ paths: filesAt(root, "a.txt"), sel: "#nope" }), setup: setupFiles,
    page: () => pageOf({ extra: { "DOM.getDocument": () => ({ root: { nodeId: 1 } }), "DOM.querySelector": () => ({ nodeId: 0 }) } }), env: shownEnv },
  { name: "upload-direct-set-files-fails", cmd: "upload", args: (root) => ({ paths: filesAt(root, "a.txt"), ref: "@e1" }), setup: setupFiles, refs: ref1,
    page: () => pageOf({ extra: { "DOM.setFileInputFiles": () => { throw new Error("파일 입력칸이 아닙니다"); } } }), env: shownEnv },
  { name: "upload-hidden-tab-hold", cmd: "upload", args: (root) => ({ paths: filesAt(root, "a.txt") }), setup: setupFiles, env: hiddenEnv },
  { name: "upload-no-paths", cmd: "upload", args: {}, env: shownEnv },
  { name: "upload-empty-string", cmd: "upload", args: { paths: " , " }, env: shownEnv },
  { name: "upload-missing-file", cmd: "upload", args: (root) => ({ paths: [...filesAt(root, "a.txt"), path.join(root, "files", "none.txt")] }), setup: setupFiles, env: shownEnv },
  { name: "upload-relative-path", cmd: "upload", args: { paths: ["relative/a.txt"] }, env: shownEnv },
  { name: "upload-home-missing", cmd: "upload", args: { paths: "~/__iris_no_such_upload__.txt" }, env: shownEnv },
  { name: "upload-blocked-host", cmd: "upload", args: (root) => ({ paths: filesAt(root, "a.txt") }), setup: setupFiles, env: { ...shownEnv, blockedHost: true } },
  // download
  { name: "download-off-default", cmd: "download", args: {}, env: { ...shownEnv, downloadLast: { path: "/tmp/x.pdf", state: "completed", at: 1 } } },
  { name: "download-off-word", cmd: "download", args: { dir: " off " }, env: shownEnv },
  { name: "download-arm", cmd: "download", args: (root) => ({ dir: path.join(root, "dl") }), env: shownEnv },
  { name: "download-arm-once", cmd: "download", args: (root) => ({ dir: path.join(root, "dl-once"), once: true }), env: shownEnv },
  { name: "download-arm-once-string", cmd: "download", args: (root) => ({ dir: path.join(root, "dl-str"), once: "true" }), env: shownEnv },
  { name: "download-arm-once-other-string", cmd: "download", args: (root) => ({ dir: path.join(root, "dl-no"), once: "yes" }), env: shownEnv },
  { name: "download-relative-dir", cmd: "download", args: { dir: "downloads" }, env: shownEnv },
  { name: "download-mkdir-fails", cmd: "download", args: (root) => ({ dir: path.join(root, "plain-file", "sub") }),
    setup: (root) => { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(root, "plain-file"), "x"); }, env: shownEnv },
  { name: "download-blocked-host", cmd: "download", args: (root) => ({ dir: path.join(root, "dl-host") }), env: { ...shownEnv, blockedHost: true } },
  // login
  { name: "login-filled", cmd: "login", args: {}, env: { ...shownEnv, login: { ok: true, origin: "https://example.test", username: "user@example.test", secret: FAKE_SECRET, filled: ["username", "password"] } } },
  { name: "login-username", cmd: "login", args: { username: "second@example.test" }, env: { ...shownEnv, login: { ok: true, origin: "https://example.test", username: "second@example.test", secret: FAKE_SECRET } } },
  { name: "login-secret-echoed-in-result", cmd: "login", args: {}, env: { ...shownEnv, login: { ok: true, origin: "https://example.test", username: "user", secret: FAKE_SECRET, note: `값 ${FAKE_SECRET} 를 채움` } } },
  { name: "login-need-user", cmd: "login", args: {}, env: { ...shownEnv, login: { ok: false, needUser: true, origin: "https://example.test", reason: "no-saved" } } },
  { name: "login-need-user-not-allowed", cmd: "login", args: {}, env: { ...shownEnv, login: { ok: false, needUser: true, origin: "https://example.test", reason: "not-allowed", accounts: ["a", "b"] } } },
  { name: "login-choose", cmd: "login", args: {}, env: { ...shownEnv, login: { ok: false, choose: true, origin: "https://example.test", accounts: ["a", "b"] } } },
  { name: "login-hidden-tab-hold", cmd: "login", args: {}, env: { ...hiddenEnv, login: { ok: true, origin: "https://example.test", username: "user", secret: FAKE_SECRET } } },
  { name: "login-blocked-host", cmd: "login", args: {}, env: { ...shownEnv, blockedHost: true, login: { ok: true, origin: "https://accounts.example.test", username: "user", secret: FAKE_SECRET } } },
  { name: "login-blocked-host-need-user", cmd: "login", args: {}, env: { ...shownEnv, blockedHost: true, login: { ok: false, needUser: true, origin: "https://accounts.example.test", reason: "no-saved" } } },
  // nativewin
  { name: "nativewin-sheet", cmd: "nativewin", args: {}, env: { ...shownEnv, ax: { window: { ok: true, windows: [{ kind: "sheet", name: "열기", buttons: ["취소", "열기"], text: "" }], blocking: [{ kind: "sheet", name: "열기" }], note: "시트가 떠 있습니다" } } } },
  { name: "nativewin-none", cmd: "nativewin", args: {}, env: { ...shownEnv, ax: { window: { ok: true, windows: [], blocking: [], note: "지금 막고 있는 네이티브 시트는 없습니다." } } } },
  { name: "nativewin-access-denied", cmd: "nativewin", args: {}, env: { ...shownEnv, ax: { window: { ok: false, error: "접근성 접근 실패 — 시스템 설정 > 개인정보 보호 및 보안 > 손쉬운 사용에서 이 앱을 허용해야 합니다." } } } },
  { name: "nativewin-blocked-host", cmd: "nativewin", args: {}, env: { ...shownEnv, blockedHost: true, ax: { window: { ok: true, windows: [], blocking: [], note: "x" } } } },
  // nativekey
  { name: "nativekey-escape", cmd: "nativekey", args: { key: "escape" }, env: { ...shownEnv, ax: { key: { ok: true, key: "escape" } } } },
  { name: "nativekey-default", cmd: "nativekey", args: {}, env: { ...shownEnv, ax: { key: { ok: true, key: "escape" } } } },
  { name: "nativekey-bad-key", cmd: "nativekey", args: { key: "tab" }, env: { ...shownEnv, ax: { key: { error: "escape 또는 enter만 보낼 수 있습니다." } } } },
  { name: "nativekey-held-by-human-dialog", cmd: "nativekey", args: { key: "enter" }, env: { ...shownEnv, ax: { key: { ok: false, error: "앱 열기 확인 창은 사람이 답합니다." } } } },
  { name: "nativekey-hidden-tab-hold", cmd: "nativekey", args: { key: "enter" }, env: { ...hiddenEnv, ax: { key: { ok: true, key: "enter" } } } },
  { name: "nativekey-blocked-host", cmd: "nativekey", args: { key: "escape" }, env: { ...shownEnv, blockedHost: true, ax: { key: { ok: true, key: "escape" } } } },
  // nativeclick
  { name: "nativeclick-ok", cmd: "nativeclick", args: { button: "열기" }, env: { ...shownEnv, ax: { click: { ok: true, clicked: "열기", where: "OK-sheet" } } } },
  { name: "nativeclick-trimmed-name", cmd: "nativeclick", args: { button: "  취소  " }, env: { ...shownEnv, ax: { click: { ok: true, clicked: "취소", where: "OK-window" } } } },
  { name: "nativeclick-no-name", cmd: "nativeclick", args: {}, env: shownEnv },
  { name: "nativeclick-blank-name", cmd: "nativeclick", args: { button: "   " }, env: shownEnv },
  { name: "nativeclick-not-found", cmd: "nativeclick", args: { button: "없음" }, env: { ...shownEnv, ax: { click: { ok: false, error: "\"없음\" 버튼을 찾지 못했습니다. nativewin으로 이름을 확인하세요." } } } },
  { name: "nativeclick-hidden-tab-hold", cmd: "nativeclick", args: { button: "열기" }, env: { ...hiddenEnv, ax: { click: { ok: true, clicked: "열기", where: "OK-sheet" } } } },
  { name: "nativeclick-blocked-host", cmd: "nativeclick", args: { button: "열기" }, env: { ...shownEnv, blockedHost: true, ax: { click: { ok: true, clicked: "열기", where: "OK-sheet" } } } },
  // dialog · redact 는 host 확인 창 연산의 Electron 실행(host 작업 위임, host-task-service.js)이 부름
  { name: "dialog-confirm-ok", via: "hostTask", cmd: "dialog", args: { answer: "ok" }, env: { ...shownEnv, dialog: { type: "confirm", message: "삭제할까요?" } } },
  { name: "dialog-confirm-cancel", via: "hostTask", cmd: "dialog", args: { answer: "cancel" }, env: { ...shownEnv, dialog: { type: "confirm", message: "삭제할까요?" } } },
  { name: "dialog-default-cancels", via: "hostTask", cmd: "dialog", args: {}, env: { ...shownEnv, dialog: { type: "alert", message: "저장됨" } } },
  { name: "dialog-prompt-text", via: "hostTask", cmd: "dialog", args: { answer: "ok", text: "답변" }, env: { ...shownEnv, dialog: { type: "prompt", message: "이름?" } } },
  { name: "dialog-confirm-text-ignored", via: "hostTask", cmd: "dialog", args: { answer: "ok", text: "무시" }, env: { ...shownEnv, dialog: { type: "confirm", message: "확인?" } } },
  { name: "dialog-none", via: "hostTask", cmd: "dialog", args: { answer: "ok" }, env: shownEnv },
  { name: "dialog-hidden-tab-hold", via: "hostTask", cmd: "dialog", args: { answer: "ok" }, env: { ...hiddenEnv, dialog: { type: "confirm", message: "삭제할까요?" } } },
  { name: "dialog-handle-fails", via: "hostTask", cmd: "dialog", args: { answer: "ok" }, env: { ...shownEnv, dialog: { type: "confirm", message: "삭제할까요?" } },
    page: () => pageOf({ extra: { "Page.handleJavaScriptDialog": () => { throw new Error("대화상자가 이미 닫혔습니다"); } } }) },
  { name: "dialog-blocked-host", via: "hostTask", cmd: "dialog", args: { answer: "ok" }, env: { ...shownEnv, blockedHost: true, dialog: { type: "confirm", message: "삭제할까요?" } } },
  { name: "dialog-moments", via: "hostTask", cmd: "dialog", args: { answer: "ok" }, env: { ...shownEnv, moments: [{ kind: "toast", text: "저장됨" }], dialog: { type: "confirm", message: "삭제할까요?" } } },
  { name: "redact-plain", via: "hostTask", cmd: "redact", args: { text: "삭제할까요?" }, env: shownEnv },
  { name: "redact-secret", via: "hostTask", cmd: "redact", args: { text: `비밀번호 ${FAKE_SECRET} 입력` }, env: { ...shownEnv, secret: FAKE_SECRET } },
  { name: "redact-no-text", via: "hostTask", cmd: "redact", args: {}, env: shownEnv },
  { name: "redact-blocked-host", via: "hostTask", cmd: "redact", args: { text: "문구" }, env: { ...shownEnv, blockedHost: true } },
  { name: "redact-moments", via: "hostTask", cmd: "redact", args: { text: "문구" }, env: { ...shownEnv, moments: [{ kind: "toast", text: "저장됨" }] } },
  // 관찰 순간은 성공한 객체 응답에만 붙음
  { name: "nativewin-moments", cmd: "nativewin", args: {}, env: { ...shownEnv, moments: [{ kind: "toast", text: "저장됨" }], ax: { window: { ok: true, windows: [], blocking: [], note: "x" } } } },
  { name: "dialogs-moments", cmd: "dialogs", args: { plan: "ok" }, env: { ...shownEnv, moments: [{ kind: "toast", text: "저장됨" }] } },
];

const normalizer = (root) => (value) => JSON.parse(JSON.stringify(value ?? null)
  .split(JSON.stringify(root).slice(1, -1)).join("<ROOT>")
  .split(JSON.stringify(os.homedir()).slice(1, -1)).join("<HOME>"));

// 옛 처리기와 worker 경로가 같이 쓰는 메인 대역 · 효과는 같은 이름과 모양으로 기록
function createWorld(scenario, root) {
  const env = scenario.env || {};
  fs.mkdirSync(root, { recursive: true });
  if (scenario.setup) scenario.setup(root);
  const args = clone(typeof scenario.args === "function" ? scenario.args(root) : scenario.args ?? {});
  refRegistry.clear(WC_ID);
  if (scenario.refs) refRegistry.recordSnapshot(WC_ID, new Map(Object.entries(scenario.refs)));
  const effects = [];
  const gens = { documentGeneration: 3, debuggerGeneration: 4 };
  const state = {
    dialog: env.dialog ? clone(env.dialog) : null,
    plan: { queue: [], mode: null, text: null },
    secret: env.secret ?? null,
    download: { dir: null, once: false, last: clone(env.downloadLast ?? null), pending: null },
  };
  const page = scenario.page ? scenario.page() : pageOf();
  const raw = async (method, params, sid) => {
    effects.push(["cdp", method, clone(params ?? {}), sid || null]);
    return clone(await page(method, params ?? {}, sid || null));
  };
  const frames = scenario.frames || [];
  const uploadController = createUploadController({
    isAbsolute: path.isAbsolute,
    existsSync: fs.existsSync,
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    windowFromWebContents: () => null,
    recordUpload() {},
    clearChooser() {},
    setTimeoutFn: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; },
  });
  const parts = {
    observation: {
      dialogOpen: () => state.dialog,
      closeDialog: () => { effects.push(["dialog.close"]); state.dialog = null; },
    },
    planFor: () => state.plan,
    ctlSend: (message) => { effects.push(["ctlSend", clone(message)]); },
    upload: {
      invalidPaths: (files) => uploadController.invalidPaths(files),
      arm: (wcId, files, ms) => { effects.push(["upload.arm", wcId, clone(files), ms]); uploadController.arm(wcId, files, ms); },
      forget: (wcId) => { effects.push(["upload.forget", wcId]); uploadController.forget(wcId); },
      armed: (wcId) => uploadController.armed(wcId),
    },
    downloadState: {
      snapshot: () => clone(state.download),
      arm: (dir, once) => { effects.push(["download.arm", dir, once]); state.download.dir = dir; state.download.once = once; },
      disarm: () => { effects.push(["download.disarm"]); state.download.dir = null; state.download.once = false; },
    },
    provider: async (_wc, options) => {
      effects.push(["login.provider", clone(options)]);
      if (env.loginThrows) throw new Error(env.loginThrows);
      return clone(env.login);
    },
    rememberSecret: (wcId, secret) => { effects.push(["rememberSecret", wcId, secret]); state.secret = secret; },
    releaseAttach: (wcId) => { effects.push(["attach.release", wcId]); gens.debuggerGeneration += 1; },
    ax: {
      describe: async () => { effects.push(["ax.describe"]); return clone(env.ax?.window); },
      key: async (key) => { effects.push(["ax.key", key ?? null]); return clone(env.ax?.key); },
      click: async (button) => { effects.push(["ax.click", button]); return clone(env.ax?.click); },
    },
  };
  const finish = () => { uploadController.forget(WC_ID); effects.push(["plan.final", clone(state.plan)]); };
  return { env, args, effects, gens, state, page, raw, frames, parts, finish, normalize: normalizer(root) };
}

// 옛 경로: cdp-control.cjs 의 cdpExecRaw·cdpExecInner 원문을 vm 에서 실행하고 처리기는 실제 cdp-cmd-native.cjs
export async function runLegacy(scenario, root) {
  const world = createWorld(scenario, root);
  const { env, args, effects, state, raw, frames, parts } = world;
  const send = (method, params) => raw(method, params, null);
  send.on = (sid) => (method, params) => raw(method, params, sid || null);
  send.frames = () => [null, ...frames];
  send.ask = (sid, method, params) => send.on(sid)(method, params).catch(() => null);
  send.all = async (method, params) => (await Promise.all(send.frames().map((sid) => send.ask(sid, method, params)))).filter((r) => r != null);
  const wc = {
    id: WC_ID, isDestroyed: () => false,
    debugger: { isAttached: () => env.attached !== false },
    executeJavaScript: async () => null,
    sendInputEvent: () => {},
  };
  const sandbox = { console, setTimeout, clearTimeout, setImmediate, Buffer, Intl };
  const context = vm.createContext(sandbox);
  vm.runInContext(`${LEGACY_PARTS.prelude}${LEGACY_PARTS.consts}${READ_ONLY_SOURCE}\nthis.__readOnly = READ_ONLY_CMDS;`, context);
  sandbox.refRegistry = refRegistry;
  vm.runInContext(`${LEGACY_PARTS.nodeFromArgs}\nthis.__nodeFromArgs = nodeFromArgs;`, context);
  const observation = createObservation({ captureHold: () => false, isTabShown: () => false, now: Date.now, shotsDir: "/nonexistent", captureMoment: async () => null });
  const commands = createNativeCommands({
    observation: parts.observation,
    planFor: parts.planFor,
    ctlSend: parts.ctlSend,
    upload: parts.upload,
    nodeFromArgs: sandbox.__nodeFromArgs,
    downloadState: parts.downloadState,
    loginProvider: () => parts.provider,
    resultSafety: { rememberSecret: parts.rememberSecret },
    nativeAx: { axDescribe: parts.ax.describe, axKey: parts.ax.key, axClick: parts.ax.click },
    fs, path, os,
  });
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
    attachPolicy: { blocked: () => env.blockedHost === true, touch() {}, release: (wcId) => { parts.releaseAttach(wcId); } },
    isGoogleAuthUrl: () => false,
    identityOwnsDebugger: () => false,
    cdpSession: { primed: () => false },
    enterAiCommand: (wcId, cmd) => { if (sandbox.__readOnly.has(cmd)) return null; effects.push(["ai.enter"]); return wcId; },
    leaveAiCommand: (ticket) => { if (ticket != null) effects.push(["ai.leave"]); },
    ensureAttached: () => send,
    ensureQaReady: async (_s, _w, cmd) => { effects.push(["ensureReady", cmd]); },
    runCdpCmd: async (s, w, cmd, cmdArgs) => commands[cmd](s, w, cmdArgs),
    commandHandlers: commands,
    fs, path, SHOTS_DIR: "/nonexistent", pruneShots() {},
  });
  vm.runInContext(`${LEGACY_PARTS.exec}\nthis.__cdpExecRaw = cdpExecRaw;`, context);
  const webContentsMod = { fromId: () => wc };
  let response;
  try {
    const out = await sandbox.__cdpExecRaw(webContentsMod, WC_ID, scenario.cmd, args);
    // execWithReattach → attachMoments: 성공한 객체 응답에만 관찰 순간을 비워 붙임
    if (env.moments && out && typeof out === "object" && !Array.isArray(out)) out.moments = clone(env.moments);
    response = { ok: true, data: mask(state, clone(out)) };
  } catch (error) { response = failure(error); }
  world.finish();
  return { response: world.normalize(response), effects: world.normalize(effects) };
}

// worker 경로 전체: worker 서비스 → host 확인 창 게이트 → 명령 단위 → Electron 중계 · 메인 모듈은 world 의 대역
export function createWorkerRun(scenario, root, {
  features = ["worker-command-unit", "worker-native-commands"], hostDialog = null, serial = null, unitIdleMs, unitTimeoutMs = 25000,
  commandId = `${GENERATION}/1`, routes, onExecute = null,
} = {}) {
  const world = createWorld(scenario, root);
  const { env, args, effects, gens, state, raw, frames, parts } = world;
  const relays = [];
  const hostCalls = [];
  const responses = [];
  const hostState = { dialog: hostDialog };
  const guest = Object.assign(new EventEmitter(), {
    id: WC_ID,
    debugger: { isAttached: () => env.attached !== false, sendCommand: (method, params, sid) => raw(method, params, sid ?? null) },
    hostWebContents: { id: 1, isDestroyed: () => false },
    isDestroyed: () => false,
    getType: () => "webview",
    getURL: () => "https://example.test/page",
    getTitle: () => "페이지",
    isLoading: () => false,
    canGoBack: () => false,
    canGoForward: () => false,
    getZoomFactor: () => 1,
  });
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
    currentUrl: () => "https://example.test/page",
    pendingUrl: () => "",
    blockedUrl: () => false,
    redact: (_wcId, value) => mask(state, value),
    rememberSecret: parts.rememberSecret,
    releaseAttach: parts.releaseAttach,
    observation: { ...parts.observation, subscribeEvents: () => () => {}, drainMoments: () => null, clearDiagnostics() {} },
    upload: parts.upload,
    downloadState: parts.downloadState,
    dialogPlan: {
      set: (wcId, value, text) => {
        const plan = parts.planFor(wcId);
        plan.queue = value?.queue ? [...value.queue] : [];
        plan.mode = value?.mode || null;
        plan.text = text;
        parts.ctlSend({ type: "browser-dialog-plan", wc: Number(wcId), plan: value, text });
      },
    },
    clearDialogPlan: (wcId) => {
      effects.push(["plan.clear", wcId]);
      Object.assign(state.plan, { queue: [], mode: null, text: null });
    },
    refs: { record: () => {}, resolve: (wcId, ref) => refRegistry.resolveRef(wcId, ref) },
    loginProvider: parts.provider,
    nativeAx: parts.ax,
    gate: (_wc, command) => {
      const noCdp = env.blockedHost === true;
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
    focus: { state: async () => ({ canSendKeys: false, canPress: false, shown: env.shown === true, shownKnown: true, paint: env.paint || { ok: true } }) },
    hiddenViewport: { ensureReady: async (_wc, command) => { effects.push(["ensureReady", command]); return { ready: true }; }, release: async () => ({}) },
    viewport: { explicit: () => null, current: () => null },
    emitEvent: () => true,
    codedError: coded,
  });
  const queues = new Map();
  const releases = [];
  const units = createCommandUnits({
    queues,
    execute: (request) => relay.execute(request),
    redact: (_key, value) => mask(state, value),
    attachMoments: (_key, _cmd, value) => (env.moments && value && typeof value === "object" && !Array.isArray(value) ? { ...value, moments: clone(env.moments) } : value),
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
    call: async (operation, input) => {
      const currentId = context.getStore()?.commandId || commandId;
      if (operation === "journal.accept") return {};
      if (operation === "browser.commandGuard") return { qaOwned: false };
      if (operation === "browser.commandTargetState") return { target: { tabId: "tab-a", targetToken: { wcId: WC_ID, ...gens }, tab: { url: "https://example.test/page" } } };
      if (operation === "browser.status") return { executorReady: true, executor: { app: "x", pid: 1, features } };
      if (operation !== "browser.executeWithDialog") { hostCalls.push([operation, clone(input)]); return {}; }
      const { command, args: baseArgs, unit } = input.relay;
      relays.push({ command, args: clone(baseArgs), unit: clone(unit), targetToken: clone(input.targetToken), commandId: currentId,
        input: clone({ tabId: input.tabId, targetToken: input.targetToken, controlLabel: input.controlLabel, lifecycle: input.lifecycle }) });
      const ctx = { identity: { session: "pane" }, input, request: { workerGeneration: GENERATION, commandId: currentId, callId: ++sequence } };
      // host dispatcher 가 연산 정의의 잠금 키로 실행하는 것과 같음
      const locks = HOST_OPERATION_DEFINITIONS["browser.executeWithDialog"].locks(ctx);
      const response = await (serial ? serial.run(locks, () => dialogHost.executeWithDialog(ctx)) : dialogHost.executeWithDialog(ctx));
      responses.push(clone(response));
      return response;
    },
  };
  const service = createWorkerBrowserService({ hostApi, activity: { run: (_kind, _id, run) => run() }, ...(routes ? { routes } : {}) });
  const hostTaskService = createWorkerHostTaskService({ hostApi, ...(routes ? { routes } : {}) });
  // host 확인 창 연산이 Electron 실행을 worker 에 맡기는 요청과 같은 모양
  const hostTask = (command = scenario.cmd, taskArgs = args, id = commandId, identity = { session: "pane" }) => hostTaskService.dispatch({
    task: { type: "legacyRelay", target: { tabId: "tab-a", wcId: WC_ID, targetToken: { wcId: WC_ID, ...gens } }, relay: { command, args: taskArgs, timeoutMs: 10000 } },
    identity, commandId: id, callId: 1,
  });
  let accepted = false;
  const accept = async () => {
    if (accepted) return;
    accepted = true;
    await relay.acceptGeneration(GENERATION, { id: "conn" });
  };
  return {
    effects, relays, hostCalls, responses, hostState, queues, releases, relay, units, world, args, root, hostTask,
    accept,
    dispatch: async (command = scenario.cmd, dispatchArgs = args, id = commandId) => {
      await accept();
      return clone(await service.dispatch({ command, args: dispatchArgs, identity: { session: "pane" }, commandId: id }));
    },
    run: async () => {
      await accept();
      const response = clone(scenario.via === "hostTask"
        ? await hostTask()
        : await service.dispatch({ command: scenario.cmd, args, identity: { session: "pane" }, commandId }));
      world.finish();
      return { response: world.normalize(response), effects: world.normalize(effects) };
    },
  };
}
