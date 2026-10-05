import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter, once } from "node:events";
import { spawn } from "node:child_process";
import os from "node:os";
import { createRequire } from "node:module";
import { test } from "node:test";
import { sliceBetween } from "../bin/slice-anchor.mjs";

const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL("../native/electron/server-host.cjs", import.meta.url), "utf8");

function fixture(platform, { openFails = false } = {}) {
  const module = { exports: {} };
  const writes = [], opened = [], logs = [], notified = [], sent = [], killed = [];
  const timers = new Set();
  const stream = new EventEmitter();
  stream.write = (text) => writes.push(text);
  const child = new EventEmitter();
  child.pid = 81;
  child.connected = true;
  child.send = (message) => sent.push(message);
  child.kill = (signal) => killed.push(signal);
  for (const name of ["stdout", "stderr"]) {
    child[name] = new EventEmitter();
    child[name].pipe = () => {};
    child[name].setEncoding = () => {};
  }
  const mocks = {
    "node:child_process": { spawn: () => child },
    "node:fs": {
      existsSync: () => true,
      mkdirSync() {},
      appendFileSync(file, text) {
        if (openFails) throw new Error("log unavailable");
        writes.push(text);
      },
      createWriteStream(file, options) {
        if (openFails) throw new Error("log unavailable");
        opened.push({ file, options });
        return stream;
      },
    },
    "../../server/env.cjs": { childEnv: () => ({}), NET_POLICY: "fixture" },
    "./dev-source-watch.cjs": { createDevSourceWatch: () => { throw new Error("unexpected watcher"); } },
  };
  vm.runInNewContext(source, {
    module, __dirname: "/fixture/native/electron",
    require: (name) => mocks[name] ?? require(name),
    process: { platform, pid: 41, execPath: "/fixture/Iris", resourcesPath: "/fixture/resources", env: { IRIS_SERVER_ROOT: "/fixture", IRIS_SERVER_NODE: "/fixture/node" }, stdout: { write() {} }, stderr: { write() {} } },
    console: { log: (text) => logs.push(text) },
    setTimeout(fn, ms) { const timer = { fn, ms, unref() {} }; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); }, clearInterval() {},
  });
  const host = new module.exports.ServerHost({ app: { isPackaged: true }, port: 4291, stateDir: "/fixture/state", onLog: (text) => notified.push(text) });
  return { host, child, writes, opened, logs, notified, stream, sent, killed, timers };
}

function appFixture(platform = "win32") {
  const f = fixture(platform);
  const app = new EventEmitter();
  let exited = false;
  app.quit = () => {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    app.emit("will-quit", event);
    if (!event.prevented) exited = true;
  };
  f.host.app = app;
  const main = fs.readFileSync(new URL("../native/electron/main.cjs", import.meta.url), "utf8");
  vm.runInNewContext(sliceBetween(main, '// 앱이 종료될 때 자식 프로세스도', 'app.whenReady().then', '앱 종료 연결'), {
    app, serverHost: f.host, switcherHost: { stop() {} }, process: { platform },
  });
  f.host.spawnOnce();
  return { ...f, app, exited: () => exited };
}

test("Windows 창 닫기는 서버 종료 전 앱 종료를 보류하고 중복 요청을 합친다", async () => {
  const f = appFixture();
  f.app.quit();
  assert.equal(f.exited(), false, "서버가 잠금을 해제하기 전 앱 종료 금지");
  f.app.quit();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].type, "iris:shutdown");
  f.child.emit("exit", 0, null);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.exited(), true);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.killed, []);
});

test("Windows 종료 예산은 원격 상태 ACL 두 번의 제한 시간보다 길다", async () => {
  const f = appFixture();
  f.app.quit();
  for (const timer of [...f.timers]) if (timer.ms <= 30000) timer.fn();
  assert.deepEqual(f.killed, [], "15초 ACL 두 번을 마치기 전 강제 종료 금지");
  assert.equal(f.exited(), false);
  f.child.emit("exit", 0, null);
  await Promise.resolve();
});

test("Windows 종료 제한을 넘으면 해당 자식만 종료하고 잠금은 외부에서 지우지 않는다", async () => {
  const f = appFixture();
  f.app.quit();
  const deadline = [...f.timers][0];
  f.timers.delete(deadline);
  deadline.fn();
  assert.deepEqual(f.killed, ["SIGKILL"]);
  f.child.emit("exit", null, "SIGKILL");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.exited(), true);
  assert.equal(f.timers.size, 0);
  assert.match(f.writes.join(""), /강제 종료/);
});

test("macOS 앱 종료는 기존 SIGTERM 요청과 즉시 반환을 유지한다", () => {
  const f = appFixture("darwin");
  f.app.quit();
  assert.equal(f.exited(), true);
  assert.deepEqual(f.killed, ["SIGTERM"]);
});

test("Windows 강제 종료 후에도 자식 종료를 확인하지 못하면 실패를 남긴다", async () => {
  const f = appFixture();
  f.child.kill = () => { throw new Error("access denied"); };
  f.app.quit();
  const deadline = [...f.timers][0];
  f.timers.delete(deadline);
  deadline.fn();
  const fallback = [...f.timers][0];
  f.timers.delete(fallback);
  fallback.fn();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.exited(), true);
  assert.match(f.writes.join(""), /서버 강제 종료 실패 — access denied/);
  assert.match(f.writes.join(""), /서버 종료 확인 실패/);
  assert.match(f.writes.join(""), /server.lock 남음/);
});

test("Windows 연결만 한 서버에는 종료 요청을 보내지 않는다", async () => {
  const f = appFixture();
  f.host.owned = false;
  f.app.quit();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.exited(), true);
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.killed, []);
});

for (const transport of ["IPC", "disconnect"]) {
  test(`Windows 실제 자식의 ${transport} 종료는 저장 후 자기 잠금을 해제한다`, { timeout: 10000 }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "iris-windows-shutdown-"));
    const index = fs.readFileSync(new URL("../server/index.js", import.meta.url), "utf8");
    const handlers = sliceBetween(index, "function logWindowsShutdown", "// transcript는", "종료 요청");
    const finalizers = sliceBetween(index, "function flushPendingState()", "// 포트가 이미 사용 중이면", "저장·잠금 해제");
    const script = `
      import fs from 'node:fs';
      import path from 'node:path';
      import { stateHome } from ${JSON.stringify(new URL("../server/state-home.cjs", import.meta.url).href)};
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const IRIS_HOME = stateHome();
      const LOCK_PATH = path.join(IRIS_HOME, 'server.lock');
      fs.writeFileSync(LOCK_PATH, String(process.pid), { flag: 'wx' });
      const shutdownCapabilities = [function slowSave() {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
        fs.writeFileSync(path.join(IRIS_HOME, 'callback-saved'), 'saved');
      }];
      const flushBrowserStateNow = () => {
        if (fs.readFileSync(LOCK_PATH, 'utf8') !== String(process.pid)) throw new Error('owner lost');
        if (!fs.existsSync(path.join(IRIS_HOME, 'callback-saved'))) throw new Error('callback missing');
        fs.writeFileSync(path.join(IRIS_HOME, 'state-saved'), 'saved');
      };
      const spaceKey = { flushNow() {} }, archive = { flushNow() {} };
      const flushBrowserRuntimeNow = () => ({}), flushMemoNow = () => {};
      const exitCapabilities = [];
      ${handlers}
      ${finalizers}
      process.send({ ready: true });
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, IRIS_STATE_DIR: directory, IRIS_PORT: "4291" },
      stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exit = once(child, "exit");
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) { child.kill(); await exit; }
      fs.rmSync(directory, { recursive: true });
    });
    await once(child, "message");
    assert.equal(fs.readFileSync(path.join(directory, "server.lock"), "utf8"), String(child.pid));
    const f = appFixture();
    f.host.child = child;
    if (transport === "IPC") {
      f.app.quit();
      assert.equal(f.exited(), false);
    } else child.disconnect();
    const [code, signal] = await exit;
    await Promise.resolve();
    assert.equal(code, 0, stderr);
    assert.equal(signal, null);
    assert.equal(fs.existsSync(path.join(directory, "server.lock")), false);
    assert.equal(fs.readFileSync(path.join(directory, "state-saved"), "utf8"), "saved");
    const log = fs.readFileSync(path.join(directory, "server.log"), "utf8");
    assert.match(log, new RegExp(`종료 요청 ${transport}`));
    assert.match(log, /콜백 시작 0:slowSave[\s\S]*콜백 완료 0:slowSave[\s\S]*상태 저장 완료[\s\S]*잠금 해제 확인 없음/);
    if (transport === "IPC") assert.equal(f.exited(), true);
  });
}

test("Windows 서버 호스트 로그는 시각과 앱 PID를 server.log에 기록한다", () => {
  const f = fixture("win32");
  f.host.log("준비 확인");
  f.host.log("응답 없음");
  assert.equal(f.opened.length, 1);
  assert.equal(f.opened[0].file, path.join("/fixture/state", "server.log"));
  assert.equal(f.opened[0].options.flags, "a");
  assert.match(f.writes[0], /^\[server-host\] \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z app pid 41 준비 확인\n$/);
  assert.deepEqual(f.writes, f.logs.map((line) => `${line}\n`));
  assert.deepEqual(f.notified, f.logs);
});

test("Windows 자식 시작·종료 요청·종료 로그는 동일한 자식 PID를 남긴다", () => {
  const f = fixture("win32");
  f.host.spawnOnce();
  f.host.stop();
  f.child.emit("exit", 0, null);
  assert.match(f.writes[0], /기동 — 포트 4291, 자식 pid 81\n$/);
  assert.match(f.writes[1], /서버 자식 종료 요청 — pid 81\n$/);
  assert.match(f.writes[2], /서버 자식 종료 — pid 81, code 0, signal -\n$/);
  assert.match(f.writes[3], /서버 종료 대기 완료 — pid 81, server.lock 남음\n$/);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].type, "iris:shutdown");
  assert.deepEqual(f.killed, []);
});

test("macOS 서버 호스트 로그의 형식과 저장 동작은 유지한다", () => {
  const f = fixture("darwin");
  f.host.log("준비 확인");
  assert.deepEqual(f.logs, ["[server-host] 준비 확인"]);
  assert.deepEqual(f.notified, f.logs);
  assert.deepEqual(f.opened, []);
  f.host.spawnOnce();
  f.host.stop();
  f.child.emit("exit", 0, null);
  assert.deepEqual(f.writes, []);
  assert.equal(f.logs.length, 2);
  assert.match(f.logs[1], /기동 — 포트 4291$/);
  assert.deepEqual(f.killed, ["SIGTERM"]);
});

test("Windows 진단 로그 저장 실패는 기존 로그 전달을 막지 않는다", () => {
  const f = fixture("win32", { openFails: true });
  assert.doesNotThrow(() => f.host.log("준비 확인"));
  assert.equal(f.logs.length, 1);
  assert.deepEqual(f.notified, f.logs);
  const g = fixture("win32");
  g.host.log("준비 확인");
  assert.doesNotThrow(() => g.stream.emit("error", new Error("log unavailable")));
});
