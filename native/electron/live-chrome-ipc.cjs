// 실행 중인 사용자의 Chrome에 붙는 백엔드를 Electron IPC에 좁게 연결한다.
//
// 소유 범위
//   trusted renderer별 연결 참여와 Iris가 만든 논리 target의 sender 소유권, frame/state 라우팅,
//   Chrome 원격 디버깅 동의 화면 안내다.
//
// 의존 대상
//   live-chrome-backend의 소유 target API, capability ctx의 ipcMain/isTrustedSender/shell/app이다.
//
// 유지 조건
//   renderer가 보낸 owner는 신뢰하지 않고 sender.id로 덮어쓴다. 오류에 websocket endpoint나 로컬
//   프로필 경로를 싣지 않는다. 초기화·설정 안내는 Chrome 연결을 자동으로 시작하지 않는다.

const { createLiveChromeBackend, LiveChromeError } = require("./live-chrome-backend.cjs");
const { spawn } = require("node:child_process");

const SETTINGS_URL = "chrome://inspect/#remote-debugging";
const SAFE_MESSAGES = Object.freeze({
  "chrome-unavailable": "Chrome을 실행하고 chrome://inspect/#remote-debugging에서 원격 디버깅을 켜 주세요.",
  "command-failed": "Chrome 명령이 실패했습니다.",
  "command-not-allowed": "이 Chrome 명령은 허용되지 않습니다.",
  "command-timeout": "Chrome 명령 시간이 초과됐습니다.",
  "connection-cancelled": "Chrome 연결을 취소했습니다.",
  "connection-conflict": "다른 디버깅 연결을 닫고 다시 시도해 주세요.",
  "connection-failed": "Chrome 연결을 시작하지 못했습니다.",
  "connector-incompatible": "Chrome 연결기가 필요한 API를 제공하지 않습니다.",
  "connector-unavailable": "Chrome 연결 기능을 불러오지 못했습니다.",
  "id-collision": "Chrome 탭 ID를 만들지 못했습니다.",
  "input-too-large": "Chrome 입력이 너무 깁니다.",
  "invalid-owner": "Chrome 탭 owner가 올바르지 않습니다.",
  "native-interaction": "Chrome에서 진행 중인 사용자 작업이 끝난 뒤 다시 연결해 주세요.",
  "native-open-failed": "Google Chrome에서 주소를 열지 못했습니다.",
  "not-connected": "Chrome에 먼저 연결해 주세요.",
  "permission-denied": "Chrome에서 원격 디버깅 연결을 허용해 주세요.",
  "tab-not-owned": "이 창이 만든 Chrome 탭이 아닙니다.",
  "target-unavailable": "Chrome 탭 연결이 열려 있지 않습니다.",
  "unsafe-url": "Chrome 탭은 자격증명 없는 http(s) 주소만 열 수 있습니다.",
});

function safeFailure(value, fallbackCode = "connection-failed") {
  const candidate = value && typeof value === "object" ? String(value.code || "") : "";
  const code = Object.hasOwn(SAFE_MESSAGES, candidate) ? candidate : fallbackCode;
  return { ok: false, code, message: SAFE_MESSAGES[code] || SAFE_MESSAGES["connection-failed"] };
}

function safeResult(result) {
  if (!result || result.ok !== true) return safeFailure(result);
  const clean = { ok: true };
  if (typeof result.state === "string") clean.state = result.state;
  if (Number.isInteger(result.restored)) clean.restored = result.restored;
  if (typeof result.id === "string") clean.id = result.id;
  if (typeof result.url === "string") {
    try { clean.url = nativeUrl(result.url); } catch {}
  }
  if (result.mode === "native") clean.mode = "native";
  if (result.target && result.target.kind === "owned-page" && typeof result.target.id === "string") {
    clean.target = { kind: "owned-page", id: result.target.id };
  }
  return clean;
}

function nativeUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("unsafe");
    return url.href;
  } catch {
    throw new LiveChromeError("unsafe-url", SAFE_MESSAGES["unsafe-url"]);
  }
}

function defaultOpenNative(url) {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/osascript", ["-"], { stdio: ["pipe", "ignore", "ignore"] });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(new LiveChromeError("native-open-failed", SAFE_MESSAGES["native-open-failed"]));
    }, 10000);
    timer.unref?.();
    child.once("error", finish);
    child.stdin.once("error", finish);
    child.once("close", (code) => {
      if (code === 0) finish();
      else finish(new LiveChromeError("native-open-failed", SAFE_MESSAGES["native-open-failed"]));
    });
    // URL은 process argv나 로그에 싣지 않는다. JSON 문자열 escape는 AppleScript 문자열에도 맞고,
    // URL.href는 제어문자를 percent-encode한다.
    child.stdin.end(`set targetUrl to ${JSON.stringify(url)}\n`
      + "tell application \"Google Chrome\"\n"
      + "  activate\n"
      + "  set targetWindow to make new window\n"
      + "  set URL of active tab of targetWindow to targetUrl\n"
      + "end tell\n");
  });
}

class LiveChromeIpc {
  constructor(ctx, { createBackend = createLiveChromeBackend, openNativeFn = defaultOpenNative } = {}) {
    if (!ctx?.app || !ctx?.ipcMain || typeof ctx.isTrustedSender !== "function" || !ctx.shell) {
      throw new Error("Live Chrome Electron ctx가 없습니다.");
    }
    this.ctx = ctx;
    this.clients = new Map();
    this.ownerByTab = new Map();
    this.openNativeFn = openNativeFn;
    this.backend = createBackend({
      onFrame: (frame) => this.routeFrame(frame),
      onState: (state) => this.routeState(state),
    });
  }

  trusted(event) {
    if (!this.ctx.isTrustedSender(event)) throw new LiveChromeError("permission-denied", "신뢰되지 않은 발신자입니다.");
    return event.sender;
  }

  track(sender) {
    const key = String(sender.id);
    if (this.clients.has(key)) return key;
    this.clients.set(key, sender);
    sender.once?.("destroyed", () => {
      this.clients.delete(key);
      if (this.clients.size === 0) void this.backend.disconnect().catch(() => {});
    });
    return key;
  }

  owns(sender, id) {
    const key = String(sender.id);
    const wanted = String(id || "");
    if (!wanted || this.ownerByTab.get(wanted) !== key) {
      throw new LiveChromeError("tab-not-owned", SAFE_MESSAGES["tab-not-owned"]);
    }
    return wanted;
  }

  send(sender, channel, payload) {
    try {
      if (!sender?.isDestroyed?.()) sender.send(channel, payload);
    } catch {}
  }

  async routeFrame(frame) {
    if (!frame || typeof frame.id !== "string" || typeof frame.data !== "string") return;
    const sender = this.clients.get(this.ownerByTab.get(frame.id));
    if (!sender) return;
    this.send(sender, "live-chrome-frame", {
      id: frame.id,
      data: frame.data,
      metadata: frame.metadata && typeof frame.metadata === "object" ? frame.metadata : {},
    });
  }

  routeState(value) {
    if (!value || typeof value.state !== "string") return;
    const state = { state: value.state };
    if (typeof value.code === "string" && Object.hasOwn(SAFE_MESSAGES, value.code)) state.code = value.code;
    if (Number.isInteger(value.restored)) state.restored = value.restored;
    if (typeof value.url === "string") {
      try {
        const url = new URL(value.url);
        if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) state.url = url.href;
      } catch {}
    }
    if (typeof value.id === "string") {
      state.id = value.id;
      const sender = this.clients.get(this.ownerByTab.get(value.id));
      if (sender) this.send(sender, "live-chrome-state", state);
      return;
    }
    for (const sender of this.clients.values()) this.send(sender, "live-chrome-state", state);
  }

  async connect(event) {
    const sender = this.trusted(event);
    const key = this.track(sender);
    try {
      const result = await this.backend.connect();
      if (!result?.ok && ![...this.ownerByTab.values()].includes(key)) this.clients.delete(key);
      return safeResult(result);
    } catch (error) {
      if (![...this.ownerByTab.values()].includes(key)) this.clients.delete(key);
      return safeFailure(error);
    }
  }

  async open(event, payload) {
    const sender = this.trusted(event);
    const key = String(sender.id);
    if (!this.clients.has(key)) return safeFailure({ code: "not-connected" });
    try {
      const result = await this.backend.openTab({
        url: payload?.url,
        owner: `renderer:${key}`,
        screencast: payload?.screencast,
      });
      if (result?.ok && typeof result.id === "string") this.ownerByTab.set(result.id, key);
      return safeResult(result);
    } catch (error) {
      return safeFailure(error, "target-unavailable");
    }
  }

  async command(event, payload) {
    const sender = this.trusted(event);
    try {
      const id = this.owns(sender, payload?.id);
      const command = String(payload?.command || "");
      if (command === "Navigation.back" || command === "Navigation.forward") {
        const history = await this.backend.command(id, "Page.getNavigationHistory", {});
        const offset = command === "Navigation.back" ? -1 : 1;
        const entry = Array.isArray(history?.entries) ? history.entries[history.currentIndex + offset] : null;
        if (entry && Number.isInteger(entry.id)) {
          await this.backend.command(id, "Page.navigateToHistoryEntry", { entryId: entry.id });
          return { ok: true, navigated: true };
        }
        return { ok: true, navigated: false };
      }
      await this.backend.command(id, command, payload?.args);
      return { ok: true };
    } catch (error) {
      return safeFailure(error, "command-failed");
    }
  }

  async close(event, payload) {
    const sender = this.trusted(event);
    try {
      const id = this.owns(sender, payload?.id);
      const result = await this.backend.closeTab(id);
      if (result?.ok) this.ownerByTab.delete(id);
      return safeResult(result);
    } catch (error) {
      return safeFailure(error, "target-unavailable");
    }
  }

  async native(event, payload) {
    const sender = this.trusted(event);
    try {
      const id = this.owns(sender, payload?.id);
      return safeResult(await this.backend.beginNativeInteraction(id));
    } catch (error) {
      return safeFailure(error, "target-unavailable");
    }
  }

  async disconnect(event) {
    this.trusted(event);
    try { return safeResult(await this.backend.disconnect()); }
    catch (error) { return safeFailure(error); }
  }

  async openSettings(event) {
    this.trusted(event);
    const message = `열리지 않으면 Chrome 주소창에 ${SETTINGS_URL} 를 입력해 주세요.`;
    try {
      await this.ctx.shell.openExternal(SETTINGS_URL);
      return { ok: true, attempted: true, url: SETTINGS_URL, message };
    } catch {
      return { ok: false, code: "open-settings-failed", attempted: true, url: SETTINGS_URL, message };
    }
  }

  async openNative(event, payload) {
    this.trusted(event);
    try {
      const url = nativeUrl(payload?.url);
      // Google 로그인 창을 만드는 순간 Iris CDP 연결이 남아 있으면 '자동화 연결 없음'이 아니다.
      // Iris transport만 먼저 떼고 Chrome/탭은 닫지 않는다.
      await this.backend.disconnect();
      await this.openNativeFn(url);
      return { ok: true, requested: true };
    } catch (error) {
      return safeFailure(error, "native-open-failed");
    }
  }

  register() {
    const ipc = this.ctx.ipcMain;
    ipc.handle("ac-live-chrome-connect", (event) => this.connect(event));
    ipc.handle("ac-live-chrome-open", (event, payload) => this.open(event, payload));
    ipc.handle("ac-live-chrome-command", (event, payload) => this.command(event, payload));
    ipc.handle("ac-live-chrome-close", (event, payload) => this.close(event, payload));
    ipc.handle("ac-live-chrome-native", (event, payload) => this.native(event, payload));
    ipc.handle("ac-live-chrome-disconnect", (event) => this.disconnect(event));
    ipc.handle("ac-live-chrome-open-settings", (event) => this.openSettings(event));
    ipc.handle("ac-live-chrome-open-native", (event, payload) => this.openNative(event, payload));
    this.ctx.app.once("will-quit", () => { void this.backend.disconnect().catch(() => {}); });
    return this;
  }
}

function initLiveChromeIpc(ctx, options) {
  return new LiveChromeIpc(ctx, options).register();
}

module.exports = {
  LiveChromeIpc,
  SETTINGS_URL,
  initLiveChromeIpc,
  safeFailure,
};
