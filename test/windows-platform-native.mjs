import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { windowsPowerShellEnv } from "../server/windows-powershell.cjs";
import { sliceBetween } from "../bin/slice-anchor.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = (file) => fs.readFileSync(path.join(root, file), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));
function cjs(file, { platform = "win32", env = {}, mocks = {} } = {}) {
  const module = { exports: {} };
  const require = createRequire(path.join(root, file));
  vm.runInNewContext(source(file), {
    module, process: { platform, arch: "x64", env },
    require: (name) => mocks[name] ?? (name === "node:path" ? (platform === "win32" ? path.win32 : path) : require(name)),
  }, { filename: file });
  return module.exports;
}
function esm(file, names, globals) {
  const body = source(file).replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
  return vm.runInNewContext(`${body}\n({ ${names.join(", ")} })`, globals, { filename: file });
}

for (const platform of ["darwin", "win32"]) test(`${platform} 보기 메뉴는 해당 운영체제의 수정키를 쓴다`, () => {
  const { createMenu } = cjs("native/electron/menu.cjs", { platform });
  const menu = createMenu({ platform, Menu: { buildFromTemplate: (template) => template, setApplicationMenu() {} } }).build();
  const view = menu.find((item) => item.label === "보기").submenu;
  const prefix = platform === "win32" ? "CmdOrCtrl" : "Cmd";
  if (platform === "win32") {
    assert.equal(view.some((item) => item.role === "reload" || item.role === "forceReload"), false);
    assert.equal(view.find((item) => item.label === "페이지 새로고침").accelerator, undefined);
    assert.equal(typeof view.find((item) => item.label === "앱 새로고침").click, "function");
  } else {
    assert.equal(view.find((item) => item.role === "reload").accelerator, prefix + "+R");
    assert.equal(view.find((item) => item.role === "forceReload").accelerator, prefix + "+Shift+R");
  }
  assert.equal(view.find((item) => item.role === "toggleDevTools").accelerator, prefix + "+Alt+I");
});

test("Windows SDK·Studio 탐색은 LocalAppData와 exe를 쓴다", () => {
  const sdk = "C:\\Users\\tester\\AppData\\Local\\Android\\Sdk";
  const studio = "C:\\Program Files\\Android\\Android Studio\\bin\\studio64.exe";
  const files = new Set([path.win32.join(sdk, "platform-tools", "adb.exe"), path.win32.join(sdk, "emulator", "emulator.exe"), studio]);
  const { inspectAndroidSetup } = cjs("native/electron/emulator/android-setup.cjs");
  const options = { home: "C:\\Users\\tester", env: { ProgramFiles: "C:\\Program Files" }, existsSync: (file) => files.has(file), readdirSync: () => ["Android Studio"] };
  assert.deepEqual(plain(inspectAndroidSetup(options)), { studioPath: studio, sdkPath: sdk, sdkParts: { adb: true, emulator: true } });
  const chosen = "D:\\SDK";
  files.add(path.win32.join(chosen, "platform-tools", "adb.exe"));
  assert.deepEqual(plain(inspectAndroidSetup({ ...options, configuredPath: chosen })).sdkParts, { adb: true, emulator: false });
  assert.equal(inspectAndroidSetup({ ...options, configuredPath: chosen }).sdkPath, chosen);
});

test("Windows adb는 ANDROID_HOME과 LocalAppData에서 adb.exe를 찾는다", () => {
  for (const env of [{ ANDROID_HOME: "D:\\SDK" }, { LOCALAPPDATA: "D:\\Profile\\Local" }]) {
    const expected = env.ANDROID_HOME ? path.win32.join(env.ANDROID_HOME, "platform-tools", "adb.exe") : path.win32.join(env.LOCALAPPDATA, "Android", "Sdk", "platform-tools", "adb.exe");
    const { adbPath } = esm("server/adb-path.js", ["adbPath"], { process: { platform: "win32", env }, path: path.win32, os: { homedir: () => "C:\\Users\\tester" }, fs: { existsSync: (file) => file === expected } });
    assert.equal(adbPath(), expected);
  }
});

for (const platform of ["darwin", "win32"]) test(`${platform} 모바일 emulation 해제는 원래 데스크톱 정체를 쓴다`, async () => {
  const payloads = [];
  const { createDeviceEmulation } = cjs("native/electron/cdp-device-emulation.cjs", { platform, mocks: { "./google-auth-user-agent.cjs": {
    clearDeviceUserAgentOverride() {}, sendDeviceUserAgentOverride: async (_wc, _send, payload) => payloads.push(payload),
  } } });
  const baseUa = "Mozilla/5.0 Chrome/140.0.7339.80 Safari/537.36";
  const wc = { id: 1, session: { getUserAgent: () => baseUa }, getURL: () => "https://example.com/", once() {}, reload() {} };
  const emulation = createDeviceEmulation({ attach: () => async () => {}, yieldToExplicitViewport() {} });
  await emulation.apply(wc, { width: 390, height: 844 });
  await emulation.apply(wc, { clear: true });
  assert.equal(payloads[0].userAgentMetadata.platform, "Android");
  const restored = payloads.at(-1);
  assert.equal(restored.userAgent, baseUa);
  assert.equal(restored.platform, platform === "win32" ? "Win32" : "MacIntel");
  assert.equal(restored.userAgentMetadata.platform, platform === "win32" ? "Windows" : "macOS");
  assert.equal(restored.userAgentMetadata.architecture, platform === "win32" ? "x86" : "arm");
});

function runFixture({ actual = 1700000000000, records = [], platform = "win32", killFails = false } = {}) {
  const calls = [], spawned = [], killed = [];
  const proc = new EventEmitter();
  proc.pid = 42; proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
  proc.kill = () => { throw new Error("single-process kill forbidden"); };
  const process = { platform, env: { Path: "C:\\tools;C:\\Windows", LOCALAPPDATA: "C:\\Local", ELECTRON_RUN_AS_NODE: "1" }, kill: (pid) => killed.push(pid) };
  const globals = { process, windowsPowerShellEnv: () => windowsPowerShellEnv(process.env), path: platform === "win32" ? path.win32 : path, os: { homedir: () => "C:\\Users\\tester" }, stateHome: () => "C:\\state", setTimeout: () => {},
    fs: { existsSync: (file) => file.endsWith("pnpm-lock.yaml"), readFileSync: (file) => file.endsWith("run-pids.json") ? JSON.stringify(records) : JSON.stringify({ scripts: { dev: "vite", 'dev&other': 'bad', 'dev space': 'vite' } }), mkdirSync() {}, writeFileSync() {} },
    spawn: (...args) => { spawned.push(args); return proc; },
    execFileSync: (file, args) => { calls.push([file, args]); if (file === "powershell.exe") return actual === null ? "" : String(actual); if (killFails) throw new Error("denied"); return ""; },
  };
  const { RunManager } = esm("server/run.js", ["RunManager"], globals);
  const manager = new RunManager();
  return { manager, calls, spawned, killed, setActual: (value) => { actual = value; } };
}

test("Windows npm 실행은 cmd shim을 사용하고 PATH 드라이브 문자를 보존한다", () => {
  const { manager, spawned } = runFixture();
  assert.equal(manager.start("C:\\project", "dev space").ok, true);
  const [file, args, options] = spawned[0];
  assert.equal(file, "cmd.exe");
  assert.deepEqual(plain(args), ['/d /v:off /s /c "pnpm run "dev space""']);
  assert.equal(options.windowsVerbatimArguments, true);
  assert.equal(options.env.Path, "C:\\Local\\pnpm;C:\\tools;C:\\Windows");
  assert.equal(Object.hasOwn(options.env, "PATH"), false);
  assert.equal(Object.hasOwn(options.env, "ELECTRON_RUN_AS_NODE"), false);
});

test("Windows 실행은 cmd에 해석될 스크립트 이름을 거부한다", () => {
  const { manager, spawned } = runFixture();
  assert.equal(manager.start("C:\\project", "dev&other").ok, false);
  assert.equal(spawned.length, 0);
});

test("Windows 실행 종료는 일치한 시작 시각의 프로세스 트리만 종료한다", () => {
  const { manager, calls, killed, setActual } = runFixture();
  manager.start("C:\\project", "dev");
  setActual(1700000000001);
  assert.equal(manager.stop("C:\\project").ok, false);
  assert.equal(calls.filter(([file]) => file === "taskkill.exe").length, 0);
  setActual(1700000000000);
  assert.equal(manager.stop("C:\\project").ok, true);
  assert.deepEqual(plain(calls.at(-1)), ["taskkill.exe", ["/PID", "42", "/T", "/F"]]);
  assert.deepEqual(killed, []);
});

test("Windows orphan 정리는 소유 시각이 없거나 바뀐 PID를 종료하지 않는다", () => {
  for (const startedAt of [null, undefined, 1700000000001]) {
    const { calls } = runFixture({ records: [{ pid: 42, startedAt }] });
    assert.equal(calls.filter(([file]) => file === "taskkill.exe").length, 0);
  }
  const { calls } = runFixture({ records: [{ pid: 42, startedAt: 1700000000000 }] });
  assert.equal(calls.filter(([file]) => file === "taskkill.exe").length, 1);
});

test("Windows 시작 시각 조회 실패와 taskkill 실패를 종료 성공으로 표시하지 않는다", () => {
  for (const options of [{ actual: null }, { killFails: true }]) {
    const { manager } = runFixture(options);
    manager.start("C:\\project", "dev");
    assert.equal(manager.stop("C:\\project").ok, false);
  }
});

test("Windows 브라우저 upload는 드라이브와 UNC 경로를 파일로 보낸다", () => {
  const body = source("bin/iris-browser.mjs");
  const parse = sliceBetween(body, "const arg = rest.join", "const session =", "브라우저 인자");
  for (const file of ["C:\\Users\\tester\\a.png", "\\\\host\\share\\a.png", "/tmp/a.png", "~/a.png"]) {
    const args = vm.runInNewContext(`${parse}\nargs`, { cmd: "upload", rest: [file], process: { platform: "win32" }, path: path.win32 });
    assert.deepEqual(plain(args), { paths: [file] });
  }
  const args = vm.runInNewContext(`${parse}\nargs`, { cmd: "upload", rest: ["input[type=file]", "C:\\a.png"], process: { platform: "win32" }, path: path.win32 });
  assert.deepEqual(plain(args), { sel: "input[type=file]", paths: ["C:\\a.png"] });
});

test("Windows headless 탐색은 LocalAppData의 전용 shell만 받는다", () => {
  const shell = "C:\\Local\\ms-playwright\\chromium_headless_shell-1\\chrome-headless-shell-win64\\chrome-headless-shell.exe";
  const dirs = new Map([[path.win32.dirname(path.win32.dirname(path.win32.dirname(shell))), ["chromium_headless_shell-1"]], [path.win32.dirname(path.win32.dirname(shell)), ["chrome-headless-shell-win64"]]]);
  const { headlessLaunchOptions } = cjs("bin/headless-browser.cjs", { mocks: { "node:fs": {
    constants: { X_OK: 1 }, readdirSync: (dir) => { if (!dirs.has(dir)) throw new Error("missing"); return dirs.get(dir); },
    accessSync: (file) => { if (file !== shell) throw new Error("missing"); }, realpathSync: (file) => file,
    statSync: () => ({ mtimeMs: 1, isFile: () => true }),
  } } });
  assert.deepEqual(plain(headlessLaunchOptions({ home: "C:\\Users\\tester", env: { LOCALAPPDATA: "C:\\Local" } })), { executablePath: shell, headless: "shell" });
  assert.throws(() => headlessLaunchOptions({ env: { CHROME_BIN: "C:\\Chrome\\chrome.exe" } }), /chrome-headless-shell/);
});

test("Windows Chrome 확장 탐색은 LocalAppData의 User Data를 쓴다", () => {
  const env = { LOCALAPPDATA: "D:\\User Local" };
  const chrome = path.win32.join(env.LOCALAPPDATA, "Google", "Chrome", "User Data");
  const observed = [];
  const { discoverChromeExtensions } = cjs("native/electron/browser-extension-catalog.cjs", { env, mocks: { "node:fs": {
    readFileSync: (file) => { observed.push(file); return "{}"; }, readdirSync: (file) => { observed.push(file); return []; }, realpathSync: (file) => file,
  } } });
  discoverChromeExtensions();
  assert.deepEqual(observed, [path.win32.join(chrome, "Local State"), chrome]);
  const { resolveExtension } = cjs("native/electron/extension-loader.cjs", { env });
  const result = resolveExtension({ fsImpl: { realpathSync: (file) => { observed.push(file); throw new Error("missing"); } } });
  assert.equal(result.path, path.win32.join(chrome, "Default", "Extensions", "fmkadmapgofadopljbjfkapdkoienihi"));
});

test("Windows gh PATH는 세미콜론과 원래 환경변수 대소문자를 보존한다", () => {
  const body = source("server/github-pr-handler.js");
  const fn = sliceBetween(body, "export function commandEnv", "async function runCommand", "GitHub 실행 환경").replace("export ", "");
  const commandEnv = vm.runInNewContext(`${fn}\ncommandEnv`, { process: { platform: "win32" }, path: path.win32 });
  const env = commandEnv({ Path: "C:\\Git\\cmd;C:\\Windows", ProgramFiles: "C:\\Program Files" });
  assert.equal(env.Path, "C:\\Git\\cmd;C:\\Windows;C:\\Program Files\\GitHub CLI");
  assert.equal(Object.hasOwn(env, "PATH"), false);
});

test("Windows avdmanager.bat는 cmd를 거쳐 실행하고 해석될 경로는 거부한다", async () => {
  for (const sdk of ["C:\\Android SDK", "C:\\Android%SDK"]) {
    const calls = [];
    const { createDeviceManager } = cjs("native/electron/emulator/device-management.cjs", { mocks: {
      "node:fs": { readdirSync: () => [], existsSync: (file) => file.endsWith("avdmanager.bat") },
      "./android-setup.cjs": { inspectAndroidSetup: () => ({ sdkPath: sdk }) },
      "node:child_process": { execFile: (file, args, options, callback) => { calls.push({ file, args, options }); callback(null, 'id: 1 or "pixel"\nName: Pixel\n'); return {}; } },
    } });
    const catalog = await createDeviceManager().catalog();
    if (sdk.includes("%")) {
      assert.equal(calls.length, 0);
      assert.match(catalog.android.error, /지원하지 않는 문자/);
    } else {
      assert.equal(calls[0].file, "cmd.exe");
      assert.equal(calls[0].options.windowsVerbatimArguments, true);
      assert.deepEqual(plain(calls[0].args), ['/d /v:off /s /c ""C:\\Android SDK\\cmdline-tools\\latest\\bin\\avdmanager.bat" "list" "device""']);
      assert.deepEqual(plain(catalog.android.models), [{ id: "pixel", name: "Pixel" }]);
    }
  }
});

test("Windows QA plan URL은 공백과 드라이브를 포함한 파일 경로로 바꾼다", () => {
  const body = source("bin/iris-browser.mjs");
  const block = sliceBetween(body, "  const runnerUrl =", "  process.exit(spawnSync", "QA plan 경로")
    .replace("import.meta.url", JSON.stringify("file:///C:/Iris%20App/bin/iris-browser.mjs"));
  const runner = vm.runInNewContext(`${block}\nrunner`, { URL, process: { platform: "win32" }, fileURLToPath: (url) => fileURLToPath(url, { windows: true }) });
  assert.equal(runner, "C:\\Iris App\\bin\\qa-plan.mjs");
});

test("Windows 실제 npm 스크립트와 자식 트리를 실행·종료한다", { skip: process.platform !== "win32", timeout: 45000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-run-"));
  const state = path.join(dir, "state");
  const oldState = process.env.IRIS_STATE_DIR;
  process.env.IRIS_STATE_DIR = state;
  const { RunManager } = await import(`../server/run.js?windows=${Date.now()}`);
  const manager = new RunManager();
  let childPid = null;
  t.after(() => {
    manager.stop(dir);
    if (oldState === undefined) delete process.env.IRIS_STATE_DIR; else process.env.IRIS_STATE_DIR = oldState;
    fs.rmSync(dir, { recursive: true });
  });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { "dev space": "node child.cjs" } }));
  fs.writeFileSync(path.join(dir, "child.cjs"), `const fs = require('node:fs'); const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true }); fs.writeFileSync('child.pid', String(child.pid)); setInterval(() => {}, 1000);`);
  assert.equal(manager.start(dir, "dev space").ok, true);
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(path.join(dir, "child.pid")) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(fs.existsSync(path.join(dir, "child.pid")), true, JSON.stringify(manager.status(dir)));
  childPid = Number(fs.readFileSync(path.join(dir, "child.pid"), "utf8"));
  const leader = manager.status(dir).pid;
  assert.equal(manager.stop(dir).ok, true);
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const exitDeadline = Date.now() + 5000;
  while ((alive(leader) || alive(childPid)) && Date.now() < exitDeadline) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(alive(leader), false);
  assert.equal(alive(childPid), false);
});

test("Windows UNC·확장 경로의 npm 실행은 spawn 전에 거부한다", () => {
  for (const cwd of ["\\\\server\\share\\project", "//server/share/project", "\\\\?\\UNC\\server\\share\\project", "\\\\?\\C:\\project"]) {
    const { manager, spawned } = runFixture();
    const result = manager.start(cwd, "dev");
    assert.equal(result.ok, false);
    assert.match(result.error, /UNC·확장 경로/);
    assert.equal(spawned.length, 0);
    assert.equal(manager.status(cwd).running, false);
  }
});

test("Windows 기본 기기는 기존 설정에서 선택한 Android만 사용한다", async () => {
  let preference = null;
  const calls = [];
  const { createDeviceManager } = cjs("native/electron/emulator/device-management.cjs", { mocks: {
    "./android-setup.cjs": { inspectAndroidSetup: () => ({ sdkPath: null }) },
  } });
  const manager = createDeviceManager({ getSettings: () => ({ mobileEmulatorDefaultDeviceUdid: preference }), run: async (...args) => { calls.push(args); return ""; } });
  const availability = { devices: [{ udid: "emulator-5554", name: "Pixel", runtime: "Android", isAvailable: true }], android: { sdkFound: true } };
  await assert.rejects(manager.ensureDefault(availability), error => error.code === "default_device_required" && error.message.includes("Android"));
  preference = "emulator-5554";
  assert.equal((await manager.ensureDefault(availability)).udid, preference);
  preference = "missing";
  await assert.rejects(manager.ensureDefault(availability), error => error.code === "saved_device_unavailable");
  assert.equal(calls.length, 0);
});
