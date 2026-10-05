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
//   Orca 의 worktree 자리에는 `iris:emulator:탭 id` 를 넣는다. 탭마다 활성 기기가 하나라서
//   같은 스페이스의 다른 기기를 종료하거나 스페이스 변경 때 세션을 교체하지 않는다.
//   렌더러 알림(ui:emulatorAutoAttach · emulator:pane-focus)은 모든 창에 보낸다. 에뮬레이터 탭은 분리
//   창에도 있을 수 있어서 창 하나를 고르면 그 탭이 알림을 받지 못한다.
//
// 영향 범위
//   preload 의 emulator* 함수와 web/js/emulator 의 탭 화면.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs native/electron/emulator/emulator-host.cjs
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const guard = require("./electron-guard.cjs");
const { cleanupPriorHelpers } = require("./stale-helper-cleanup.cjs");
const { XCODE_DOWNLOAD_URL, inspectXcode, switchXcode, xcodeAppPath } = require("./xcode-setup.cjs");
const { ANDROID_STUDIO_URL, inspectAndroidSetup } = require("./android-setup.cjs");
const { createVolumeController } = require("./audio-volume.cjs");
const { createDeviceManager } = require("./device-management.cjs");

const RENDERER_METHODS = new Set([
  "emulator.attach", "emulator.availability", "emulator.button", "emulator.gesture",
  "emulator.listDevices", "emulator.rotate", "emulator.shutdown", "emulator.tap",
]);
const BUTTON_NAMES = new Set(["back", "home", "recents", "volume_down", "volume_up", "lock"]);
const SETTINGS_FILE = "emulator-settings.json";
const SETTING_KEYS = ["mobileEmulatorDefaultDeviceUdid", "androidSdkPath"];
const IOS_UDID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
// 시뮬레이터 안 통화 서비스. 낮은 우선순위로 Mac 출력 장치를 계속 열어 두어 처리 기한을 놓치고,
// 같은 장치를 쓰는 Mac 전체 소리(유튜브 포함)가 지지직거림.
// bootout 만 효과 있음(disable·kill 은 launchd 가 다시 실행). 기기를 재부팅하면 다시 로드되므로 연결 때마다 실행.
// 이미 내린 기기에 다시 연결하면 실패하므로 결과는 무시
const SIM_CALL_SERVICE = "user/501/com.apple.telephonyutilities.callservicesd";

function stopSimCallService(udid) {
  execFile("xcrun", ["simctl", "spawn", udid, "launchctl", "bootout", SIM_CALL_SERVICE], { timeout: 15000 }, () => {});
}

function initCapability(ctx) {
  const { ipcMain, isTrustedSender, BrowserWindow, app, stateDir, shell, preloadPath, getAppUrl, loadUrlWithRetry } = ctx;
  const { dialog, screen } = require("electron");
  guard.configure(ctx);
  const orca = require("./orca-emulator.cjs");

  const settingsPath = path.join(stateDir, SETTINGS_FILE);
  function readSettings() {
    try {
      const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("에뮬레이터 설정 파일이 올바르지 않습니다");
      const out = {};
      for (const k of SETTING_KEYS) {
        if (raw[k] != null && typeof raw[k] !== "string") throw new Error("에뮬레이터 설정 값이 올바르지 않습니다");
        out[k] = raw[k] || null;
      }
      return out;
    } catch (error) {
      if (error.code === "ENOENT") return { mobileEmulatorDefaultDeviceUdid: null, androidSdkPath: null };
      throw error;
    }
  }

  const bridge = new orca.EmulatorBridge();
  const deviceManager = createDeviceManager({ getSettings: readSettings });
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
      if (arg.method === "emulator.attach" && !params.device && !readSettings().mobileEmulatorDefaultDeviceUdid) {
        const preferred = await deviceManager.ensureDefault(await commands.emulatorAvailability({}));
        params.device = preferred.udid;
      }
      if (arg.method === "emulator.button" && !BUTTON_NAMES.has(params?.name)) {
        return { ok: false, error: { code: "invalid_button", message: "지원하지 않는 기기 버튼" } };
      }
      const result = await method.handler(params, { runtime: commands });
      if (arg.method === "emulator.shutdown" && result?.ok === true && typeof result.deviceUdid === "string" && result.deviceUdid) {
        allWindows.webContents.send("ac-emulator-session-stopped", { worktree: params.worktree, device: result.deviceUdid });
      }
      if (arg.method === "emulator.availability" && result?.platform === "darwin") {
        result.xcode = inspectXcode();
      }
      if (arg.method === "emulator.availability") {
        result.androidSetup = inspectAndroidSetup({ configuredPath: readSettings().androidSdkPath });
        const catalog = await deviceManager.catalog();
        result.devices = deviceManager.annotate(result.devices || [], catalog, result);
      }
      if (arg.method === "emulator.attach" && result?.attached && result.info?.deviceUdid) {
        void cleanupPriorHelpers({
          runtimeRoot: path.join(app.getPath("userData"), "serve-sim-runtime"),
          deviceUdid: result.info.deviceUdid,
          activePid: result.info.helperPid,
          appUptimeSeconds: process.uptime(),
        }).then((pids) => {
          if (pids.length) console.info(`[emulator] stopped unused helpers from a prior Iris run: ${pids.join(", ")}`);
        }).catch((err) => console.warn("[emulator] prior helper check failed:", err));
      }
      if (arg.method === "emulator.attach" && result?.attached && IOS_UDID_RE.test(result.info?.deviceUdid || "")) {
        stopSimCallService(result.info.deviceUdid);
      }
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: { code: (err && err.code) || "error", message: String((err && err.message) || err) } };
    }
  });

  ipcMain.handle("ac-emulator-device-catalog", async (e) => {
    if (!isTrustedSender(e)) return { ok: false, error: "신뢰되지 않은 발신자" };
    try { return { ok: true, catalog: await deviceManager.catalog() }; }
    catch (error) { return { ok: false, error: String(error?.message || error) }; }
  });
  ipcMain.handle("ac-emulator-device-create", async (e, args) => {
    if (!isTrustedSender(e)) return { ok: false, error: "신뢰되지 않은 발신자" };
    try { return { ok: true, device: await deviceManager.create(args) }; }
    catch (error) { return { ok: false, error: String(error?.message || error), code: error?.code || "device_creation_failed" }; }
  });
  ipcMain.handle("ac-emulator-device-default", async (e) => {
    if (!isTrustedSender(e)) return { ok: false, error: "신뢰되지 않은 발신자" };
    try { return { ok: true, device: await deviceManager.ensureDefault(await commands.emulatorAvailability({})) }; }
    catch (error) { return { ok: false, error: String(error?.message || error), code: error?.code || "device_default_failed" }; }
  });

  ipcMain.handle("ac-emulator-settings-get", (e) => {
    if (!isTrustedSender(e)) return { ok: false, error: "신뢰되지 않은 발신자" };
    try { return { ok: true, settings: readSettings() }; }
    catch (error) { return { ok: false, error: String(error?.message || error) }; }
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

  // 기기별 음량. 프로세스 해석·도우미 실행은 audio-volume.cjs, 렌더러는 기기 id·저장 키만 전달
  const volume = createVolumeController({ stateDir });
  ipcMain.handle("ac-emulator-volume-use", (e, arg) => {
    if (!isTrustedSender(e)) return { ok: false, error: "신뢰되지 않은 발신자" };
    return volume.use({ device: arg && arg.device, key: arg && arg.key });
  });
  ipcMain.handle("ac-emulator-volume-set", (e, arg) => {
    if (!isTrustedSender(e)) return { ok: false, error: "신뢰되지 않은 발신자" };
    return volume.set({ device: arg && arg.device, key: arg && arg.key, volume: arg && arg.volume, muted: arg && arg.muted });
  });
  app.on("will-quit", () => volume.stopAll());

  ipcMain.handle("ac-emulator-pick-sdk", async (e) => {
    if (!isTrustedSender(e)) return { ok: false, error: "신뢰되지 않은 발신자" };
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win, { title: "Android SDK 폴더 선택", properties: ["openDirectory"] });
    return { ok: true, path: r.canceled || !r.filePaths[0] ? null : r.filePaths[0] };
  });
  ipcMain.handle("ac-emulator-android-action", async (e, action) => {
    if (!isTrustedSender(e)) return { ok: false, error: "신뢰되지 않은 발신자" };
    if (!['download', 'open'].includes(action)) return { ok: false, error: "Android Studio 작업이 올바르지 않습니다" };
    try {
      if (action === 'download') {
        await shell.openExternal(ANDROID_STUDIO_URL);
        return { ok: true };
      }
      const studioPath = inspectAndroidSetup().studioPath;
      if (!studioPath) return { ok: false, error: "Android Studio를 찾지 못했습니다. 먼저 설치하세요." };
      const error = await shell.openPath(studioPath);
      return error ? { ok: false, error } : { ok: true };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  });

  ipcMain.handle("ac-emulator-xcode-action", async (e, action) => {
    if (!isTrustedSender(e)) return { ok: false, error: "신뢰되지 않은 발신자" };
    if (!['download', 'open', 'select'].includes(action)) return { ok: false, error: "Xcode 작업이 올바르지 않습니다" };
    const status = inspectXcode();
    try {
      if (action === 'download') {
        await shell.openExternal(XCODE_DOWNLOAD_URL);
        return { ok: true };
      }
      if (action === 'open') {
        const appPath = xcodeAppPath(status.selectedDir || '') || status.installedApps?.[0]
          || xcodeAppPath(status.candidates[0]);
        if (!appPath) return { ok: false, error: "설치된 Xcode를 찾지 못했습니다" };
        const error = await shell.openPath(appPath);
        return error ? { ok: false, error } : { ok: true };
      }
      let developerDir = status.candidates.length === 1 ? status.candidates[0] : null;
      if (!developerDir) {
        const win = BrowserWindow.fromWebContents(e.sender);
        const choice = await dialog.showOpenDialog(win, {
          title: "Iris에서 사용할 Xcode 선택", defaultPath: "/Applications", properties: ["openFile"],
        });
        if (choice.canceled || !choice.filePaths[0]) return { ok: false, canceled: true };
        developerDir = path.join(choice.filePaths[0], "Contents", "Developer");
      }
      return await switchXcode(developerDir);
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  });

  // 분리 창. 앱 셸의 window.open 허용은 preload 를 붙이지 않아 그 창에는 acHost 가 없다. 그래서 탭 분리
  // (detached-tab-window.cjs)처럼 이 기능이 preload 를 붙여 창을 직접 만든다. 창을 닫는 것은 탭으로
  // 원래 자리로 되돌리는 것이므로 닫힐 때 모든 창에 알린다.
  const detachedWindows = new Map(); // tabId → BrowserWindow
  let mainContents = null;
  let pickState = false;
  let recordState = false;
  // 앱 종료 중 표시. 종료 때 닫히는 분리 창은 되돌리기(탭으로 복귀)가 아니므로 본 창이 자리 기록을 바꾸지 않게 함께 알림
  let quitting = false;
  const ID_RE = /^[\w.:-]{1,128}$/;
  // 복원할 분리 창 위치. 연결된 화면과 겹칠 때만 사용(모니터를 뗀 뒤 화면 밖에 뜨지 않게)
  function restoreBounds(b) {
    if (!b || !["x", "y", "width", "height"].every((k) => Number.isFinite(b[k]))) return null;
    const r = { x: Math.round(b.x), y: Math.round(b.y), width: Math.min(4000, Math.max(240, Math.round(b.width))), height: Math.min(4000, Math.max(300, Math.round(b.height))) };
    const onScreen = screen.getAllDisplays().some(({ workArea: a }) => r.x < a.x + a.width - 40 && r.x + r.width > a.x + 40 && r.y < a.y + a.height - 40 && r.y + r.height > a.y);
    return onScreen ? r : null;
  }
  ipcMain.handle("ac-emulator-window-open", (e, arg) => {
    if (!isTrustedSender(e)) return { ok: false, error: "신뢰되지 않은 발신자" };
    const { space, tab, device, pickAvailable, recordAvailable, pickOn, recordOn, bounds, connect } = arg || {};
    if (!ID_RE.test(String(space)) || !ID_RE.test(String(tab)) || (device != null && !ID_RE.test(String(device)))) {
      return { ok: false, error: "창 인자가 올바르지 않습니다" };
    }
    const existing = detachedWindows.get(tab);
    if (existing && !existing.isDestroyed()) {
      existing.show(); existing.focus();
      if (connect === true) existing.webContents.send("ac-emulator-connect", { device: device || null });
      return { ok: true };
    }
    mainContents = e.sender;
    pickState = !!pickOn;
    recordState = !!recordOn;
    const place = restoreBounds(bounds);
    const win = new BrowserWindow({
      width: 460, height: 920, title: "에뮬레이터", backgroundColor: "#0b0f14",
      webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, spellcheck: false },
    });
    // 생성 옵션의 크기는 주 모니터 작업 영역 높이로 잘림(다른 모니터의 세로 전체 창이 999 로 뜸). 만든 뒤 setBounds 는 그대로 적용
    if (place) win.setBounds(place);
    detachedWindows.set(tab, win);
    win.webContents.on("did-finish-load", () => {
      win.webContents.send("ac-emulator-pick-state", pickState);
      win.webContents.send("ac-emulator-record-state", recordState);
    });
    // 창 위치는 본 창이 자리 기록에 저장(앱 재시작 때 같은 위치로 복원)
    let boundsTimer = null;
    const sendBounds = () => {
      clearTimeout(boundsTimer);
      boundsTimer = setTimeout(() => {
        if (!win.isDestroyed() && mainContents && !mainContents.isDestroyed()) mainContents.send("ac-emulator-window-bounds", { tab, bounds: win.getBounds() });
      }, 400);
    };
    win.on("move", sendBounds);
    win.on("resize", sendBounds);
    sendBounds();
    win.on("closed", () => {
      clearTimeout(boundsTimer);
      detachedWindows.delete(tab);
      allWindows.webContents.send("ac-emulator-window-closed", { tab, quitting });
    });
    const query = new URLSearchParams({ space, tab });
    if (device) query.set("device", device);
    if (pickAvailable === true) query.set("pick", "1");
    if (recordAvailable === true) query.set("record", "1");
    if (connect === true) query.set("connect", "1");
    loadUrlWithRetry(win, getAppUrl() + "/emulator-window/?" + query.toString());
    return { ok: true };
  });
  ipcMain.handle("ac-emulator-window-close", (e, arg) => {
    if (!isTrustedSender(e)) return { ok: false, error: "신뢰되지 않은 발신자" };
    const win = detachedWindows.get(arg && arg.tab);
    if (win && !win.isDestroyed()) win.close();
    return { ok: true };
  });
  ipcMain.on("ac-emulator-control-request", (e, arg) => {
    if (!isTrustedSender(e) || !["pick", "record", "target", "device", "running"].includes(arg?.action)) return;
    const win = detachedWindows.get(arg.tab);
    if (!win || win.isDestroyed() || win.webContents !== e.sender) return;
    if (arg.device != null && !ID_RE.test(String(arg.device))) return;
    if (mainContents && !mainContents.isDestroyed()) mainContents.send("ac-emulator-control-request", { action: arg.action, tab: arg.tab, device: arg.device || null, on: arg.on === true });
  });
  ipcMain.on("ac-emulator-pick-state", (e, on) => {
    if ((!mainContents || mainContents.isDestroyed()) && isTrustedSender(e)) mainContents = e.sender;
    if (!isTrustedSender(e) || e.sender !== mainContents) return;
    pickState = !!on;
    for (const win of detachedWindows.values()) if (!win.isDestroyed()) win.webContents.send("ac-emulator-pick-state", !!on);
  });
  ipcMain.on("ac-emulator-record-state", (e, on) => {
    if (!isTrustedSender(e) || e.sender !== mainContents) return;
    recordState = !!on;
    for (const win of detachedWindows.values()) if (!win.isDestroyed()) win.webContents.send("ac-emulator-record-state", recordState);
  });
  ipcMain.on("ac-emulator-control-result", (e, arg) => {
    if (!isTrustedSender(e) || e.sender !== mainContents) return;
    const win = detachedWindows.get(arg?.tab);
    if (win && !win.isDestroyed() && typeof arg?.message === "string") {
      win.webContents.send("ac-emulator-control-result", arg.message.slice(0, 200));
    }
  });
  // serve-sim 헬퍼와 scrcpy 세션은 자식 프로세스라 앱이 끝나도 남는다. Orca 도 종료 시 정리를 기다린다.
  // 정리가 끝나기 전에 다른 종료 처리가 app.quit() 을 다시 불러도 계속 막는다. 막지 않으면 헬퍼가 남는다.
  // 기한은 Orca 종료 절차의 공용 기한(20초)과 같다.
  let cleaned = false, cleaning = false;
  app.on("before-quit", (event) => {
    // 기기를 끄기 전에 알림. 끄는 동안 본 창이 "꺼짐"을 자리 기록에 저장하면 다음 실행 때 기기를 다시 켜지 못함
    if (!quitting) { quitting = true; allWindows.webContents.send("ac-emulator-quitting", {}); }
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
