// 모바일 에뮬레이터의 네이티브 쪽. Orca 번들(orca-emulator.cjs)을 Iris 창과 IPC 에 연결한다.
//
// 소유 범위
//   EmulatorBridge 하나, Orca RuntimeEmulatorCommands 의 host 구현, ac-emulator-* IPC, 분리 창, 앱 종료 시 정리.
//   에뮬레이터 동작 자체는 번들이 소유하고 여기서 바꾸지 않는다.
//
// 제공 API
//   initCapability(ctx). 네이티브 기능 표(capabilities.cjs)가 호출하는 진입점이다.
//
// 의존 대상
//   ctx 의 ipcMain · isTrustedSender · BrowserWindow · app · stateDir · shell · preloadPath · getAppUrl ·
//   loadUrlWithRetry. 번들과 electron-guard.cjs.
//
// 유지 조건
//   렌더러에는 Orca 화면이 실제로 부르는 RPC 만 연다. Orca 의 나머지 메서드(exec · install · permissions
//   등)는 Orca CLI 용이고, exec 는 serve-sim 하위 명령을 그대로 실행한다.
//   매개변수는 Orca 의 zod 스키마로 검사한다. 스키마를 거치지 않은 값을 handler 에 넘기지 않는다.
//   Orca 의 worktree 자리에는 스페이스 id 를 넣는다. 탭이 스페이스에 속하므로, Orca 가 작업 트리마다
//   활성 에뮬레이터를 하나 두는 규칙이 스페이스마다 하나로 옮겨진다.
//   렌더러 알림(ui:emulatorAutoAttach · emulator:pane-focus)은 모든 창에 보낸다. 에뮬레이터 탭은 분리
//   창에도 있을 수 있어서 창 하나를 고르면 그 탭이 알림을 받지 못한다.
//
// 영향 범위
//   preload 의 emulator* 함수와 web/js/emulator 의 탭 화면.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs native/electron/emulator/emulator-host.cjs
const fs = require("fs");
const path = require("path");

const guard = require("./electron-guard.cjs");

const RENDERER_METHODS = new Set([
  "emulator.attach", "emulator.availability", "emulator.button", "emulator.gesture",
  "emulator.listDevices", "emulator.rotate", "emulator.shutdown", "emulator.tap",
]);
const SETTINGS_FILE = "emulator-settings.json";
const ANDROID_STUDIO_URL = "https://developer.android.com/studio";
const SETTING_KEYS = ["mobileEmulatorDefaultDeviceUdid", "androidSdkPath"];

function initCapability(ctx) {
  const { ipcMain, isTrustedSender, BrowserWindow, app, stateDir, shell, preloadPath, getAppUrl, loadUrlWithRetry } = ctx;
  const { dialog } = require("electron");
  guard.configure(ctx);
  const orca = require("./orca-emulator.cjs");

  const settingsPath = path.join(stateDir, SETTINGS_FILE);
  function readSettings() {
    try {
      const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      const out = {};
      for (const k of SETTING_KEYS) out[k] = typeof raw[k] === "string" && raw[k] ? raw[k] : null;
      return out;
    } catch { return { mobileEmulatorDefaultDeviceUdid: null, androidSdkPath: null }; }
  }

  const bridge = new orca.EmulatorBridge();
  const allWindows = {
    webContents: {
      send(channel, payload) {
        for (const w of BrowserWindow.getAllWindows()) {
          try { if (!w.isDestroyed()) w.webContents.send(channel, payload); } catch {}
        }
      },
    },
  };
  const commands = new orca.RuntimeEmulatorCommands({
    getEmulatorBridge: () => bridge,
    resolveEmulatorWorkspaceId: async (selector) => selector,
    resolveEmulatorCleanupWorkspaceId: async (selector) => selector,
    getAuthoritativeWindow: () => allWindows,
    // 기능을 끄면 이 모듈이 로드되지 않으므로 여기까지 왔으면 켜져 있다.
    getSettings: () => ({ mobileEmulatorEnabled: true, ...readSettings() }),
  });
  const methods = new Map(orca.EMULATOR_METHODS.filter((m) => RENDERER_METHODS.has(m.name)).map((m) => [m.name, m]));

  orca.registerEmulatorFrameStreamHandlers();
  orca.registerEmulatorVideoStreamHandlers();

  // 실패는 던지지 않고 { ok:false } 로 돌려준다. invoke 가 던지면 렌더러에는 Electron 이 덧붙인 문구만 남아
  // Orca 오류 코드(emulator_device_not_found 등)를 화면이 구분하지 못한다.
  ipcMain.handle("ac-emulator-rpc", async (e, arg) => {
    if (!isTrustedSender(e)) return { ok: false, error: { code: "untrusted", message: "신뢰되지 않은 발신자" } };
    const method = methods.get(arg && arg.method);
    if (!method) return { ok: false, error: { code: "unknown_method", message: String(arg && arg.method) } };
    try {
      const params = method.params ? method.params.parse(arg.params ?? {}) : undefined;
      return { ok: true, result: await method.handler(params, { runtime: commands }) };
    } catch (err) {
      return { ok: false, error: { code: (err && err.code) || "error", message: String((err && err.message) || err) } };
    }
  });

  ipcMain.handle("ac-emulator-settings-get", (e) => {
    if (!isTrustedSender(e)) return { ok: false, error: "신뢰되지 않은 발신자" };
    return { ok: true, settings: readSettings() };
  });
  ipcMain.handle("ac-emulator-settings-set", (e, patch) => {
    if (!isTrustedSender(e)) return { ok: false, error: "신뢰되지 않은 발신자" };
    const next = readSettings();
    for (const k of SETTING_KEYS) {
      if (!patch || !(k in patch)) continue;
      const v = patch[k];
      if (v !== null && typeof v !== "string") return { ok: false, error: `${k} 값이 올바르지 않습니다` };
      next[k] = v || null;
    }
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      const tmp = settingsPath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
      fs.renameSync(tmp, settingsPath);
      return { ok: true, settings: next };
    } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  });

  // SDK 상태 화면의 두 버튼. Orca 는 범용 pickDirectory·openExternal 을 쓰지만, 여기서는 이 화면이 쓰는
  // 한 가지 용도로만 연다. 임의 주소를 여는 통로가 되지 않게 주소는 Orca 의 ANDROID_STUDIO_URL 하나다.
  ipcMain.handle("ac-emulator-pick-sdk", async (e) => {
    if (!isTrustedSender(e)) return { ok: false, error: "신뢰되지 않은 발신자" };
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win, { title: "Android SDK 폴더 선택", properties: ["openDirectory"] });
    return { ok: true, path: r.canceled || !r.filePaths[0] ? null : r.filePaths[0] };
  });
  ipcMain.handle("ac-emulator-open-android-studio", (e) => {
    if (!isTrustedSender(e)) return { ok: false, error: "신뢰되지 않은 발신자" };
    shell.openExternal(ANDROID_STUDIO_URL);
    return { ok: true };
  });

  // 분리 창. 앱 셸의 window.open 허용은 preload 를 붙이지 않아 그 창에는 acHost 가 없다. 그래서 탭 분리
  // (detached-tab-window.cjs)처럼 이 기능이 preload 를 붙여 창을 직접 만든다. 창을 닫는 것은 탭으로
  // 되돌리는 것이므로 닫힐 때 모든 창에 알린다.
  const detachedWindows = new Map(); // tabId → BrowserWindow
  const ID_RE = /^[\w.:-]{1,128}$/;
  ipcMain.handle("ac-emulator-window-open", (e, arg) => {
    if (!isTrustedSender(e)) return { ok: false, error: "신뢰되지 않은 발신자" };
    const { space, tab, device } = arg || {};
    if (!ID_RE.test(String(space)) || !ID_RE.test(String(tab)) || (device != null && !ID_RE.test(String(device)))) {
      return { ok: false, error: "창 인자가 올바르지 않습니다" };
    }
    const existing = detachedWindows.get(tab);
    if (existing && !existing.isDestroyed()) { existing.show(); existing.focus(); return { ok: true }; }
    const win = new BrowserWindow({
      width: 460, height: 920, title: "에뮬레이터", backgroundColor: "#0b0f14",
      webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, spellcheck: false },
    });
    detachedWindows.set(tab, win);
    win.on("closed", () => {
      detachedWindows.delete(tab);
      allWindows.webContents.send("ac-emulator-window-closed", { tab });
    });
    const query = new URLSearchParams({ space, tab });
    if (device) query.set("device", device);
    loadUrlWithRetry(win, getAppUrl() + "/emulator-window/?" + query.toString());
    return { ok: true };
  });
  ipcMain.handle("ac-emulator-window-close", (e, arg) => {
    if (!isTrustedSender(e)) return { ok: false, error: "신뢰되지 않은 발신자" };
    const win = detachedWindows.get(arg && arg.tab);
    if (win && !win.isDestroyed()) win.close();
    return { ok: true };
  });

  // serve-sim 헬퍼와 scrcpy 세션은 자식 프로세스라 앱이 끝나도 남는다. Orca 도 종료 시 정리를 기다린다.
  // 정리가 끝나기 전에 다른 종료 처리가 app.quit() 을 다시 불러도 계속 막는다. 막지 않으면 헬퍼가 남는다.
  // 기한은 Orca 종료 절차의 공용 기한(20초)과 같다.
  let cleaned = false, cleaning = false;
  app.on("before-quit", (event) => {
    if (cleaned) return;
    event.preventDefault();
    if (cleaning) return;
    cleaning = true;
    const deadline = new Promise((resolve) => setTimeout(resolve, 20000));
    Promise.race([Promise.resolve(bridge.onAppQuit()).catch(() => {}), deadline]).finally(() => {
      cleaned = true;
      app.quit();
    });
  });
}

module.exports = { initCapability };
