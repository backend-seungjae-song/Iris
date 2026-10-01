import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";

const hostPath = path.resolve("native/electron/desk-layout/host.cjs");
const require = createRequire(hostPath);
const source = readFileSync(process.env.DESK_LAYOUT_TEST_SOURCE || hostPath, "utf8");

for (const openedAtLogin of [false, true]) {
  test(`수동 저장과 시작·모니터 재연결 자동 복원을 유지한다 (로그인: ${openedAtLogin})`, async (t) => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "iris-desk-manual-"));
    t.after(() => rmSync(stateDir, { recursive: true, force: true }));
    const record = path.join(stateDir, "desk-layouts", "login-item.json");
    mkdirSync(path.dirname(record)); writeFileSync(record, '{}');
    const shortcuts = new Map(), handlers = new Map(), timers = new Map(), loginChanges = [], errors = [];
    const powerMonitor = new EventEmitter();
    const display = { id: 1, bounds: { x: 0, y: 0, width: 1000, height: 800 }, workArea: { x: 0, y: 0, width: 1000, height: 800 } };
    let displays = [display];
    const external = { ...display, id: 2, bounds: { ...display.bounds, x: 1000 }, workArea: { ...display.workArea, x: 1000 } };
    const screen = Object.assign(new EventEmitter(), { getAllDisplays: () => displays, getPrimaryDisplay: () => display });
    const app = Object.assign(new EventEmitter(), {
      isPackaged: true, whenReady: async () => {},
      getLoginItemSettings: () => ({ openAtLogin: true, wasOpenedAtLogin: openedAtLogin }),
      setLoginItemSettings: (value) => loginChanges.push(value.openAtLogin),
    });
    const electron = {
      powerMonitor,
      globalShortcut: { register: (key, fn) => { shortcuts.set(key, fn); return true; }, unregister: (key) => shortcuts.delete(key) },
      systemPreferences: { isTrustedAccessibilityClient: () => true },
    };
    const exported = { exports: {} };
    vm.runInNewContext(source, {
      module: exported, process, console,
      require: (id) => id === "electron" ? electron : id === "./hud.cjs" ? { createHud: () => ({ show() {}, owns: () => false }) } : require(id),
      setInterval: (fn, ms) => { timers.set(fn, { ms, repeat: true }); return fn; },
      setTimeout: (fn, ms) => { timers.set(fn, { ms, repeat: false }); return fn; },
      clearInterval: (fn) => timers.delete(fn), clearTimeout: (fn) => timers.delete(fn),
    }, { filename: hostPath });
    let listed = 0, applied = 0;
    let rect = { x: 10, y: 20, width: 400, height: 300 };
    const mac = {
      listWindows: async () => { listed++; return { ok: true, windows: [{ bundle: "example.app", pid: 42, cgId: 7, title: "문서", rect, desktop: 1, onCurrent: true }], desktops: [] }; },
      runningBundleIds: async () => ({ ok: true, regular: [], bundles: [] }),
      applyWindows: async (items) => { applied += items.length; return { ok: true, results: items.map(() => ({ ok: true })) }; },
    };
    exported.exports.initCapability({ app, screen, mac, stateDir, selfPid: -1,
      BrowserWindow: { getAllWindows: () => [] }, isTrustedSender: (e) => e.trusted === true,
      ipcMain: { handle: (key, fn) => handlers.set(key, fn) }, error: (...args) => errors.push(args),
    });
    await new Promise(setImmediate);
    assert.deepEqual(errors, []);
    assert.equal(timers.size, 1, "시작 복원만 예약한다");
    assert.ok([...timers.values()].every((timer) => !timer.repeat), "주기 저장은 예약하지 않는다");
    assert.equal(listed, 0);
    assert.deepEqual(loginChanges, []);
    assert.equal(existsSync(record), true, "자동 로그인 설정을 유지한다");
    assert.deepEqual(readdirSync(path.dirname(record)), ["login-item.json"], "시작할 때 배치를 저장하지 않는다");
    const runTimer = async (ms) => {
      const entry = [...timers].find(([, timer]) => timer.ms === ms);
      assert.ok(entry, `${ms}ms 복원 예약이 있어야 한다`);
      timers.delete(entry[0]);
      await entry[0]();
      await new Promise(setImmediate);
    };
    const host = exported.exports.createHost({ stateDir, screen, mac, selfPid: -1 });
    assert.equal((await host.saveNow("auto")).reason, "manual-only");
    assert.equal(listed, 0, "자동 저장 요청은 창 목록도 읽지 않는다");
    await handlers.get("ac-desklayout-save-now")({ trusted: false });
    await handlers.get("ac-desklayout-restore-now")({ trusted: false });
    assert.equal(listed, 0);

    shortcuts.get("Control+Alt+S")();
    await new Promise(setImmediate);
    const savedFile = path.join(stateDir, "desk-layouts", "monitors-1.json");
    const saved = readFileSync(savedFile, "utf8");
    rect = { x: 100, y: 100, width: 200, height: 200 };
    await runTimer(5000);
    assert.equal(applied, 1, "다시 켜면 저장한 배치를 복원한다");
    assert.equal(readFileSync(savedFile, "utf8"), saved, "복원이 저장본을 덮어쓰지 않는다");
    shortcuts.get("Control+Alt+R")();
    await new Promise(setImmediate);
    assert.equal(applied, 2, "수동 복원도 유지한다");
    displays = [display, external];
    assert.equal((await handlers.get("ac-desklayout-save-now")({ trusted: true })).result.saved, true);
    const multiFile = path.join(stateDir, "desk-layouts", "monitors-2.json");
    const multiSaved = readFileSync(multiFile, "utf8");
    rect = { x: 0, y: 0, width: 100, height: 100 };
    screen.emit("display-added");
    await runTimer(3000);
    assert.equal(applied, 3, "모니터가 여러 대로 바뀌면 해당 배치를 복원한다");
    displays = [display];
    screen.emit("display-removed");
    await runTimer(3000);
    assert.equal(applied, 4);
    powerMonitor.emit("lock-screen");
    displays = [display, external];
    screen.emit("display-added");
    await runTimer(3000);
    assert.equal(applied, 4, "잠금 중에는 창을 옮기지 않는다");
    powerMonitor.emit("unlock-screen");
    await runTimer(3000);
    assert.equal(applied, 5, "잠금 중 재연결한 모니터는 잠금 해제 뒤 복원한다");
    assert.equal((await handlers.get("ac-desklayout-restore-now")({ trusted: true })).result.restored, true);
    assert.equal(applied, 6);
    assert.equal(readFileSync(savedFile, "utf8"), saved);
    assert.equal(readFileSync(multiFile, "utf8"), multiSaved);
    assert.equal(timers.size, 0, "자동 저장 예약이 남지 않는다");
    assert.deepEqual(errors, []);
    handlers.get("ac-desklayout-disable")({ trusted: true });
    assert.equal(shortcuts.size, 0);
  });
}
