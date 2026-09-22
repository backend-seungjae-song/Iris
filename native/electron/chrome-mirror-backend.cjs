// 진짜 Chrome 프로세스와 page별 CDP 미러를 소유한다.
//
// 소유 범위
//   Iris 전용 Chrome 프로필, 숨긴 headed Chrome 한 인스턴스, mirror별 독립 창/page target과
//   screencast/input/viewport IPC. Chrome의 쿠키나 사용자 Chrome 프로필은 읽지 않는다.
//
// 의존 대상
//   Chrome 실행 파일 경로(CHROME_BIN)는 이 기능이 스스로 소유하고, 상태 루트는 server/state-home
//   (server 모듈이라 공유 허용)을 직접 가져온다. 공용 ctx는 app·ipcMain·isTrustedSender·log만 준다.
//   renderer에는 base64 JPEG 프레임만 보내며 URL, 쿠키, 입력 문자열은 로그에 남기지 않는다.
//
// 유지 조건
//   headless로 바꾸지 않는다. 전용 --user-data-dir와 `open -g -j` hidden headed 실행이
//   Cloudflare 통과와 포커스 유지의 전제다. 앱 종료와 마지막 mirror 해제는 profile PID를 거둔다.

const { execFile, execFileSync, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const WebSocket = require("ws");
// 상태 루트는 ctx로 주입받는 것이 기본이지만, 주입이 없을 때의 기본값은
// server/state-home.cjs 한 곳이 정한다. dev(~/.iris-dev)·real(~/.iris) 분리가 그 파일에 있다.
const { stateHome: canonicalStateHome } = require("../../server/state-home.cjs");
// claude.ai 미러를 사용자의 기존 세션으로 로그인 0회로 여는 씨앗. server/ 모듈이라 기능 경계를
// 넘지 않는다(chrome-auth·cookie-import 같은 native 앱 셸 모듈은 직접 require 금지, bin/smoke 가 검사).
const { readClaudeSessionCookies } = require("../../server/chrome-cookie-read.cjs");
const { initLiveChromeIpc } = require("./live-chrome-ipc.cjs");

const CLAUDE_ORIGIN = "https://claude.ai";
const PROFILE_DIR_NAME = "chrome-mirror-profile";
// 미러가 띄우는 것은 설치된 실제 Chrome 뿐이다. 이 경로는 이 기능이 자기 것으로 소유한다.
// chrome-auth(앱 셸 모듈)를 가져오면 기능 경계가 깨진다(bin/smoke tool-screens). 다른 브라우저는
// 미러 대상이 아니다.
const CHROME_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
function defaultBrowserForEntry(entry) {
  if (entry && entry.browser && entry.browser.id === "chrome") return { bin: CHROME_BIN };
  return undefined;
}
const HTTP_TIMEOUT_MS = 1200;
const READY_TIMEOUT_MS = 15000;
const CDP_TIMEOUT_MS = 10000;
const RESTART_BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 15000];
const STABLE_RUN_MS = 30000;
const HEALTH_POLL_MS = 1500;
const HEALTH_FAILURE_LIMIT = 3;
const FRAME_QUALITY = 75;
const MAX_TEXT_LENGTH = 65536;
const MIN_VIEWPORT = Object.freeze({ width: 320, height: 240 });
const MAX_VIEWPORT = Object.freeze({ width: 3840, height: 2160 });

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errorText = (error) => String(error && error.message || error || "알 수 없는 오류");

function normalizeMirrorRequest(value, manualHost = "") {
  const raw = String(value || CLAUDE_ORIGIN + "/");
  let parsed;
  try { parsed = new URL(raw); }
  catch { throw new Error("Chrome 미러 주소를 해석할 수 없습니다."); }
  if (parsed.username || parsed.password || !["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Chrome 미러는 자격증명 없는 http(s) 주소만 열 수 있습니다.");
  }
  if (parsed.origin === CLAUDE_ORIGIN) {
    return { url: parsed.href, scope: { kind: "claude", host: parsed.host } };
  }
  const wantedHost = String(manualHost || "").trim().toLowerCase();
  if (!wantedHost || parsed.host.toLowerCase() !== wantedHost) {
    throw new Error("이 주소는 사람이 지정한 Chrome 미러 host가 아닙니다.");
  }
  return { url: parsed.href, scope: { kind: "manual", host: wantedHost } };
}

function normalizeClaudeUrl(value) {
  const normalized = normalizeMirrorRequest(value);
  if (normalized.scope.kind !== "claude") throw new Error("Chrome 미러는 https://claude.ai 주소만 열 수 있습니다.");
  return normalized.url;
}

function reportablePageUrl(value) {
  try { return ["http:", "https:"].includes(new URL(String(value || "")).protocol); }
  catch { return false; }
}

function boundedInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function normalizeViewport(value, fallback = { width: 1280, height: 900 }) {
  const source = value && typeof value === "object" ? value : {};
  return {
    width: boundedInteger(source.width, MIN_VIEWPORT.width, MAX_VIEWPORT.width, fallback.width),
    height: boundedInteger(source.height, MIN_VIEWPORT.height, MAX_VIEWPORT.height, fallback.height),
  };
}

function requestJson(port, pathname) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      error ? reject(error) : resolve(value);
    };
    const req = http.get({ host: "127.0.0.1", port, path: pathname, timeout: HTTP_TIMEOUT_MS }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
        if (body.length > 2 * 1024 * 1024) req.destroy(new Error("CDP 응답이 너무 큽니다."));
      });
      res.on("end", () => {
        if (res.statusCode !== 200) return finish(new Error(`CDP HTTP ${res.statusCode}`));
        try { finish(null, JSON.parse(body)); }
        catch { finish(new Error("CDP 응답 JSON을 해석할 수 없습니다.")); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("CDP HTTP timeout")));
    req.on("error", (error) => finish(error));
  });
}

async function waitForJson(port, pathname, isCurrent = () => true, timeoutMs = READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (!isCurrent()) throw new Error("Chrome 프로세스가 준비 전에 종료되었습니다.");
    try { return await requestJson(port, pathname); }
    catch (error) { lastError = error; }
    await wait(120);
  }
  throw new Error(`Chrome CDP가 준비되지 않았습니다: ${errorText(lastError)}`);
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

class CdpClient {
  constructor(socket, { onEvent, onClose } = {}) {
    this.socket = socket;
    this.onEvent = onEvent || (() => {});
    this.onClose = onClose || (() => {});
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    socket.on("message", (data) => this.receive(data));
    socket.on("close", () => this.fail(new Error("CDP WebSocket이 닫혔습니다.")));
    socket.on("error", (error) => this.fail(error));
  }

  static open(url, handlers) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
      let opened = false;
      const failOpen = (error) => { if (!opened) reject(error); };
      socket.once("error", failOpen);
      socket.once("open", () => {
        opened = true;
        socket.removeListener("error", failOpen);
        resolve(new CdpClient(socket, handlers));
      });
    });
  }

  receive(data) {
    let message;
    try { message = JSON.parse(data.toString()); }
    catch { return; }
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || `CDP ${pending.method} 실패`));
      else pending.resolve(message.result || {});
      return;
    }
    if (message.method) {
      try { this.onEvent(message.method, message.params || {}); } catch {}
    }
  }

  call(method, params = {}) {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP 연결이 열려 있지 않습니다."));
    }
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timeout`));
      }, CDP_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    try { this.onClose(error); } catch {}
  }

  close() {
    if (!this.closed) {
      try { this.socket.close(); } catch {}
      this.fail(new Error("CDP 연결을 종료했습니다."));
    }
  }
}

function escapePgrepPattern(value) {
  return String(value || "").replace(/[\\.^$|?*+()[\]{}]/g, "\\$&");
}

function parsePidList(stdout) {
  return String(stdout || "").split(/\s+/).map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

function pgrepPids(marker, execFileFn = execFile) {
  return new Promise((resolve, reject) => {
    execFileFn("pgrep", ["-f", "--", escapePgrepPattern(marker)], { encoding: "utf8" }, (error, stdout) => {
      if (error && error.code !== 1) { reject(error); return; }
      resolve(parsePidList(stdout));
    });
  });
}

function pgrepPidsSync(marker, execFileSyncFn = execFileSync) {
  try {
    return parsePidList(execFileSyncFn("pgrep", ["-f", "--", escapePgrepPattern(marker)], { encoding: "utf8" }));
  } catch (error) {
    if (error && error.status === 1) return [];
    throw error;
  }
}

function sanitizeTabKey(value) {
  const tabKey = String(value || "").trim();
  if (!tabKey || tabKey.length > 256) throw new Error("유효한 tabKey가 필요합니다.");
  return tabKey;
}

function finiteNumber(value, fallback = 0, min = -100000, max = 100000) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function modifiersOf(value) {
  return boundedInteger(value, 0, 15, 0);
}

const KEY_DEFAULTS = Object.freeze({
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
});

class ChromeMirrorBackend {
  constructor({
    app,
    browserForEntry = defaultBrowserForEntry,
    stateHome = canonicalStateHome,
    spawnFn = spawn,
    execFileFn = execFile,
    execFileSyncFn = execFileSync,
    killFn = process.kill.bind(process),
    reservePortFn = reservePort,
    waitForJsonFn = waitForJson,
    requestJsonFn = requestJson,
    openCdpFn = CdpClient.open,
    randomUuid = () => crypto.randomUUID(),
    fsImpl = fs,
    pathImpl = path,
    log = (...args) => console.log(...args),
    error = (...args) => console.error(...args),
  } = {}) {
    this.app = app;
    this.browserForEntry = browserForEntry;
    this.stateHome = stateHome;
    this.spawnFn = spawnFn;
    this.execFileFn = execFileFn;
    this.execFileSyncFn = execFileSyncFn;
    this.killFn = killFn;
    this.reservePortFn = reservePortFn;
    this.waitForJsonFn = waitForJsonFn;
    this.requestJsonFn = requestJsonFn;
    this.openCdpFn = openCdpFn;
    this.randomUuid = randomUuid;
    this.fs = fsImpl;
    this.path = pathImpl;
    this.logSink = log;
    this.errorSink = error;
    this.mirrors = new Map();
    this.tabMirrors = new Map();
    this.ownerMirrors = new Map();
    this.openProcess = null;
    this.browserClient = null;
    this.cdpPort = null;
    this.profileDir = null;
    this.browserEpoch = 0;
    this.launching = null;
    this.cleanupTask = null;
    this.restartTimer = null;
    this.stableTimer = null;
    this.healthTimer = null;
    this.healthFailures = 0;
    this.restartAttempt = 0;
    this.bootstrapTargetIds = new Set();
    this.ownedPids = new Set();
    this.stopping = false;
    this.exitCleanup = () => {
      this.killChromeSync();
    };
    process.once("exit", this.exitCleanup);
  }

  log(name, details = {}) {
    this.logSink("[chrome-mirror]", name, details);
  }

  reportError(name, details = {}) {
    this.errorSink("[chrome-mirror]", name, details);
  }

  resolveChrome() {
    if (typeof this.browserForEntry !== "function") throw new Error("Chrome 탐색 service가 없습니다.");
    const browser = this.browserForEntry({ browser: { id: "chrome" } });
    if (!browser || !browser.bin) throw new Error("Google Chrome 실행 파일 경로를 확인할 수 없습니다.");
    try { this.fs.accessSync(browser.bin, this.fs.constants.X_OK); }
    catch { throw new Error("Google Chrome이 설치되어 있지 않거나 실행할 수 없습니다."); }
    return browser.bin;
  }

  resolveProfileDir() {
    if (typeof this.stateHome !== "function") throw new Error("stateHome service가 없습니다.");
    const root = this.stateHome();
    if (!this.path.isAbsolute(root)) throw new Error("stateHome은 절대경로여야 합니다.");
    const profileDir = this.path.join(root, PROFILE_DIR_NAME);
    this.fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    this.profileDir = profileDir;
    return profileDir;
  }

  async ensureBrowser(viewport) {
    if (this.stopping) throw new Error("Chrome 미러가 종료 중입니다.");
    if (this.cleanupTask) await this.cleanupTask;
    if (this.cdpPort && this.browserClient && !this.browserClient.closed) return;
    if (this.launching) return this.launching;
    const launching = this.launchBrowser(viewport);
    this.launching = launching;
    launching.then(
      () => { if (this.launching === launching) this.launching = null; },
      () => { if (this.launching === launching) this.launching = null; },
    );
    return launching;
  }

  async launchBrowser(viewport) {
    this.resolveChrome();
    const profileDir = this.resolveProfileDir();
    const port = await this.reservePortFn();
    if (this.stopping || !this.mirrors.size) throw new Error("Chrome 미러 요청이 취소되었습니다.");
    const epoch = ++this.browserEpoch;
    const size = normalizeViewport(viewport);
    // --enable-automation을 쓰지 않고 infobar도 끈다. headless 플래그는 이 경로에 들어오면 안 된다.
    const chromeArgs = [
      `--user-data-dir=${profileDir}`,
      `--window-size=${size.width},${size.height}`,
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      "--disable-features=CalculateNativeWinOcclusion",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-infobars",
      "--disable-session-crashed-bubble",
      "--hide-crash-restore-bubble",
      "about:blank",
    ];
    const args = ["-g", "-j", "-n", "-a", "Google Chrome", "--args", ...chromeArgs];
    await this.killChromePids(profileDir);
    if (this.stopping || epoch !== this.browserEpoch || !this.mirrors.size) {
      throw new Error("Chrome 미러 요청이 취소되었습니다.");
    }
    let child;
    try {
      child = this.spawnFn("open", args, { stdio: "ignore" });
    } catch (error) {
      throw new Error("Google Chrome 프로세스를 시작하지 못했습니다: " + errorText(error));
    }
    if (!child || !Number.isInteger(child.pid)) {
      try { child?.once("error", () => {}); child?.kill(); } catch {}
      throw new Error("Chrome 실행 요청 프로세스를 시작하지 못했습니다.");
    }
    this.openProcess = child;
    this.cdpPort = port;
    child.once("error", () => {});
    child.once("exit", () => { if (this.openProcess === child) this.openProcess = null; });
    child.unref?.();
    this.log("process-start", { width: size.width, height: size.height });

    let browserClient = null;
    try {
      const isCurrent = () => this.browserEpoch === epoch && this.cdpPort === port && !this.stopping;
      const version = await this.waitForJsonFn(port, "/json/version", isCurrent);
      if (!version || !version.webSocketDebuggerUrl) throw new Error("browser CDP endpoint가 없습니다.");
      browserClient = await this.openCdpFn(version.webSocketDebuggerUrl, {
        onEvent: (method, params) => this.onBrowserEvent(browserClient, method, params),
        onClose: () => { void this.onBrowserGone(epoch, browserClient, "browser-cdp-close"); },
      });
      if (!isCurrent()) { browserClient.close(); throw new Error("Chrome 미러 요청이 취소되었습니다."); }
      this.browserClient = browserClient;
      await browserClient.call("Target.setDiscoverTargets", { discover: true });
      const targets = await this.requestJsonFn(port, "/json");
      this.bootstrapTargetIds = new Set((Array.isArray(targets) ? targets : [])
        .filter((target) => target && target.type === "page" && target.id)
        .map((target) => target.id));
      // launch 창을 즉시 최소화해 이후 미러들의 host 창으로 삼는다. 미러는 newWindow:false 로
      // 이 최소화된 창에 탭으로 붙어 화면에 뜨지 않는다. 여기서 한 번 최소화하므로 남는 노출은
      // Chrome 실행~이 호출 사이의 startup 창 1회뿐이고 탭마다 반복되지 않는다. off-screen 이동은
      // macOS 가 화면 안으로 클램프해 쓸 수 없고(확인 결과: -3200 요청→(0,38)), 최소화만 확실히 동작한다.
      await this.minimizeBootstrapWindow();
      for (const pid of await this.findChromePids(profileDir)) this.ownedPids.add(pid);
      this.startHealthMonitor(epoch, port, browserClient);
      clearTimeout(this.stableTimer);
      this.stableTimer = setTimeout(() => { this.restartAttempt = 0; }, STABLE_RUN_MS);
      this.stableTimer.unref?.();
      return;
    } catch (error) {
      if (browserClient) browserClient.close();
      if (this.browserEpoch === epoch) {
        this.browserEpoch += 1;
        if (this.browserClient === browserClient) this.browserClient = null;
        if (this.cdpPort === port) this.cdpPort = null;
        this.stopHealthMonitor();
      }
      await this.killChromePids(profileDir, port, false);
      throw error;
    }
  }

  async findChromePids(profileDir = this.profileDir, port = null) {
    if (!profileDir) return [];
    const marker = port ? `--remote-debugging-port=${port}` : `--user-data-dir=${profileDir}`;
    return pgrepPids(marker, this.execFileFn);
  }

  killPids(pids) {
    for (const pid of new Set(pids)) {
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
      try { this.killFn(pid, "SIGKILL"); } catch {}
      this.ownedPids.delete(pid);
    }
  }

  async killChromePids(profileDir = this.profileDir, port = null, includeOwned = true) {
    let found = [];
    try { found = await this.findChromePids(profileDir, port); } catch {}
    this.killPids([...(includeOwned ? this.ownedPids : []), ...found]);
  }

  killChromeSync() {
    let found = [];
    try {
      if (this.profileDir) found = pgrepPidsSync(`--user-data-dir=${this.profileDir}`, this.execFileSyncFn);
    } catch {}
    this.killPids([...this.ownedPids, ...found]);
  }

  startHealthMonitor(epoch, port, browserClient) {
    this.stopHealthMonitor();
    this.healthFailures = 0;
    this.healthTimer = setInterval(() => {
      void this.requestJsonFn(port, "/json/version").then(() => {
        if (this.browserEpoch === epoch) this.healthFailures = 0;
      }).catch(() => {
        if (this.browserEpoch !== epoch || this.browserClient !== browserClient) return;
        this.healthFailures += 1;
        if (this.healthFailures >= HEALTH_FAILURE_LIMIT) {
          void this.onBrowserGone(epoch, browserClient, "cdp-health-failed");
        }
      });
    }, HEALTH_POLL_MS);
    this.healthTimer.unref?.();
  }

  stopHealthMonitor() {
    clearInterval(this.healthTimer);
    this.healthTimer = null;
    this.healthFailures = 0;
  }

  async onBrowserGone(epoch, browserClient, reason) {
    if (this.browserEpoch !== epoch || this.browserClient !== browserClient) return;
    this.browserEpoch += 1;
    this.browserClient = null;
    this.cdpPort = null;
    this.stopHealthMonitor();
    clearTimeout(this.stableTimer);
    this.stableTimer = null;
    if (browserClient) browserClient.close();
    for (const mirror of this.mirrors.values()) {
      clearTimeout(mirror.reconnectTimer);
      mirror.reconnectTimer = null;
      const client = mirror.pageClient;
      mirror.pageClient = null;
      mirror.targetId = null;
      mirror.opening = null;
      if (client) client.close();
    }
    const cleanup = this.killChromePids();
    this.cleanupTask = cleanup;
    try { await cleanup; } finally { if (this.cleanupTask === cleanup) this.cleanupTask = null; }
    if (this.stopping || !this.mirrors.size) return;
    this.reportError(reason);
    this.scheduleRestart();
  }

  scheduleRestart() {
    if (this.stopping || !this.mirrors.size || this.restartTimer) return;
    const index = Math.min(this.restartAttempt, RESTART_BACKOFF_MS.length - 1);
    const delay = RESTART_BACKOFF_MS[index];
    this.restartAttempt += 1;
    this.log("restart-wait");
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.recover().catch(() => this.scheduleRestart());
    }, delay);
    this.restartTimer.unref?.();
  }

  async recover() {
    if (this.stopping || !this.mirrors.size) return;
    const first = this.mirrors.values().next().value;
    try {
      await this.ensureBrowser(first && first.viewport);
      for (const mirror of [...this.mirrors.values()]) await this.ensureMirrorPage(mirror);
      this.log("restart-ready");
    } catch (error) {
      this.reportError("restart-failed");
      await this.stopBrowser();
      throw error;
    }
  }

  mirrorForTarget(targetId) {
    if (!targetId) return null;
    for (const mirror of this.mirrors.values()) if (mirror.targetId === targetId) return mirror;
    return null;
  }

  acceptsMirrorUrl(mirror, value) {
    let url;
    try { url = new URL(String(value || "")); } catch { return false; }
    if (!mirror || !mirror.scope || url.username || url.password || !["http:", "https:"].includes(url.protocol)) return false;
    return mirror.scope.kind === "claude" ? url.origin === CLAUDE_ORIGIN : url.host.toLowerCase() === mirror.scope.host;
  }

  sendMeta(mirror, patch = {}) {
    if (!mirror || !this.mirrors.has(mirror.mirrorId)) return;
    const nextUrl = typeof patch.url === "string" && patch.url ? patch.url : mirror.metaUrl;
    const nextTitle = typeof patch.title === "string" ? patch.title : mirror.metaTitle;
    if (nextUrl === mirror.metaUrl && nextTitle === mirror.metaTitle) return;
    mirror.metaUrl = nextUrl;
    mirror.metaTitle = nextTitle;
    const sender = mirror.sender;
    if (!sender || (typeof sender.isDestroyed === "function" && sender.isDestroyed())) return;
    try { sender.send("mirror-meta", { mirrorId: mirror.mirrorId, url: nextUrl || "", title: nextTitle || "" }); } catch {}
  }

  onBrowserEvent(client, method, params) {
    if (client !== this.browserClient || method !== "Target.targetInfoChanged") return;
    const info = params && params.targetInfo;
    const mirror = info && this.mirrorForTarget(info.targetId);
    if (!mirror || info.type !== "page" || !reportablePageUrl(info.url)) return;
    if (this.acceptsMirrorUrl(mirror, info.url)) mirror.url = info.url;
    this.sendMeta(mirror, { url: info.url || "", title: info.title || "" });
  }

  async targetFor(targetId) {
    const port = this.cdpPort;
    if (!port) throw new Error("Chrome CDP port가 없습니다.");
    const deadline = Date.now() + CDP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const targets = await this.requestJsonFn(port, "/json");
      const target = (Array.isArray(targets) ? targets : []).find((entry) =>
        entry && entry.type === "page" && entry.id === targetId && entry.webSocketDebuggerUrl);
      if (target) return target;
      await wait(80);
    }
    throw new Error("생성한 Chrome page target의 CDP endpoint를 찾지 못했습니다.");
  }

  async closeBootstrapTargets(exceptTargetId) {
    const ids = [...this.bootstrapTargetIds];
    this.bootstrapTargetIds.clear();
    for (const targetId of ids) {
      if (targetId === exceptTargetId) continue;
      try { await this.browserClient?.call("Target.closeTarget", { targetId }); } catch {}
    }
  }

  ensureMirrorPage(mirror) {
    if (mirror.pageClient && !mirror.pageClient.closed) return Promise.resolve(mirror);
    if (mirror.opening) return mirror.opening;
    mirror.opening = this.openMirrorPage(mirror).finally(() => { mirror.opening = null; });
    return mirror.opening;
  }

  async openMirrorPage(mirror) {
    if (!this.mirrors.has(mirror.mirrorId)) throw new Error("Chrome 미러가 이미 닫혔습니다.");
    await this.ensureBrowser(mirror.viewport);
    if (!this.mirrors.has(mirror.mirrorId)) throw new Error("Chrome 미러가 이미 닫혔습니다.");
    const browserClient = this.browserClient;
    if (!browserClient) throw new Error("browser CDP 연결이 없습니다.");
    let targetId = null;
    let pageClient = null;
    try {
      // newWindow:false = launch 때 만들어 이미 최소화해 둔 host 창(minimizeBootstrapWindow)에
      // 탭으로 붙는다. newWindow:true 는 미러(claude.ai 탭)마다 새 창을 만들어 그때마다 화면에
      // 표시됐다. newWindow:false 탭은 새 창을 만들지 않고 최소화된 host 를
      // 복원하지도 않아, 탭을 반복 생성해도 화면에 뜨지 않는다(확인 결과: 5개 연속 생성 전 구간 onscreen 0).
      // background:true 로 포커스도 가져가지 않는다. headed 실제 Chrome 이라 Cloudflare 는 스스로 통과한다.
      const created = await browserClient.call("Target.createTarget", { url: "about:blank", newWindow: false, background: true });
      targetId = created && created.targetId;
      if (!targetId) throw new Error("Chrome page target id를 받지 못했습니다.");
      if (!this.mirrors.has(mirror.mirrorId)) throw new Error("Chrome 미러가 이미 닫혔습니다.");
      // 안전망: host 창이 어떤 이유로 닫혀 이 타깃이 새 창에 생겼으면 즉시 최소화한다. host 가
      // 살아 있어 탭으로 붙은 정상 경로에서는 이미 최소화된 창이라 no-op 이다. page attach
      // 전에 부른다. 최소화 상태에서도 occlusion 비활성 플래그로 스크린캐스트는 계속 흐른다(확인 결과).
      await this.hideMirrorWindow(targetId, mirror);
      const target = await this.targetFor(targetId);
      pageClient = await this.openCdpFn(target.webSocketDebuggerUrl, {
        onEvent: (method, params) => this.onPageEvent(mirror, pageClient, method, params),
        onClose: () => {
          if (mirror.pageClient !== pageClient || this.stopping || !this.mirrors.has(mirror.mirrorId)) return;
          mirror.pageClient = null;
          mirror.targetId = null;
          this.reportError("page-cdp-close", { mirrorId: mirror.mirrorId });
          try { void this.browserClient?.call("Target.closeTarget", { targetId }).catch(() => {}); } catch {}
          this.scheduleMirrorReconnect(mirror);
        },
      });
      if (!this.mirrors.has(mirror.mirrorId)) throw new Error("Chrome 미러가 이미 닫혔습니다.");
      mirror.targetId = targetId;
      mirror.pageClient = pageClient;
      await pageClient.call("Page.enable");
      // macOS 앱/target을 활성화하지 않고도 hidden 창이 계속 그리게 한다. activateTarget은
      // Chrome을 앞으로 끌어와 사용자의 포커스를 빼앗으므로 이 경로에 들어오면 안 된다.
      await pageClient.call("Emulation.setFocusEmulationEnabled", { enabled: true });
      await this.applyViewport(mirror, false);
      await pageClient.call("Page.startScreencast", this.screencastOptions(mirror.viewport));
      if (mirror.scope && mirror.scope.kind === "claude") await this.seedClaudeLogin(mirror);
      await pageClient.call("Page.navigate", { url: mirror.url });
      await this.closeBootstrapTargets(targetId);
      this.log("mirror-ready", { mirrorId: mirror.mirrorId, width: mirror.viewport.width, height: mirror.viewport.height });
      return mirror;
    } catch (error) {
      if (mirror.pageClient === pageClient) mirror.pageClient = null;
      if (mirror.targetId === targetId) mirror.targetId = null;
      if (pageClient) pageClient.close();
      if (targetId) { try { await browserClient.call("Target.closeTarget", { targetId }); } catch {} }
      throw error;
    }
  }

  // 미러 창을 화면에서 지운다. 최소화는 macOS Dock 에만 남고 어느 디스플레이에도 그려지지 않으며,
  // occlusion 비활성 플래그 덕에 스크린캐스트 프레임은 계속 흐른다(확인 결과). best-effort 이므로
  // 실패해도 미러 동작 자체는 이어간다(창이 보이는 것은 결함이지만 기능은 유지된다).
  async hideMirrorWindow(targetId, mirror) {
    const browserClient = this.browserClient;
    if (!browserClient || !targetId) return;
    try {
      const win = await browserClient.call("Browser.getWindowForTarget", { targetId });
      if (win && win.windowId != null) {
        if (mirror) mirror.windowId = win.windowId;
        await browserClient.call("Browser.setWindowBounds", { windowId: win.windowId, bounds: { windowState: "minimized" } });
      }
    } catch (error) {
      this.log("mirror-hide-skip", { mirrorId: mirror && mirror.mirrorId, reason: errorText(error) });
    }
  }

  // launch 직후 부트스트랩(startup) 창을 최소화해 host 창으로 만든다. 이후 미러들은 newWindow:false
  // 로 이 최소화된 창에 탭으로 붙어 화면에 뜨지 않는다. bootstrap 페이지가 여러 창이면 각각 최소화한다
  // (windowId dedup). best-effort 이므로 실패해도 미러 동작은 이어가고 openMirrorPage 의
  // hideMirrorWindow 안전망이 개별 창을 다시 처리한다.
  async minimizeBootstrapWindow() {
    const browserClient = this.browserClient;
    if (!browserClient) return;
    const seen = new Set();
    for (const targetId of this.bootstrapTargetIds) {
      try {
        const win = await browserClient.call("Browser.getWindowForTarget", { targetId });
        if (win && win.windowId != null && !seen.has(win.windowId)) {
          seen.add(win.windowId);
          this.hostWindowId = win.windowId;
          await browserClient.call("Browser.setWindowBounds", { windowId: win.windowId, bounds: { windowState: "minimized" } });
        }
      } catch (error) {
        this.log("mirror-host-hide-skip", { reason: errorText(error) });
      }
    }
  }

  // 사용자가 이미 로그인한 claude.ai 세션을 미러 Chrome에 심어 로그인 0회로 연다. best-effort 이므로
  // 실패(키체인 거부·세션 없음·프로필 못 찾음)하면 조용히 수동 로그인으로 내려간다(회귀 없음).
  // 이미 세션이 있으면(프로필이 지속) 건드리지 않는다. 쿠키 값은 로그에 남기지 않는다.
  async seedClaudeLogin(mirror) {
    const browserClient = this.browserClient;
    if (!browserClient) return;
    try {
      const existing = await browserClient.call("Storage.getCookies", {}).catch(() => null);
      const loggedIn = existing && Array.isArray(existing.cookies)
        && existing.cookies.some((c) => c.name === "sessionKey" && /(^|\.)claude\.ai$/.test(String(c.domain || "").replace(/^\./, "")));
      if (loggedIn) return;
      const { profile, cookies } = readClaudeSessionCookies();
      if (!cookies.length) { this.log("mirror-login-none", { mirrorId: mirror.mirrorId }); return; }
      await browserClient.call("Storage.setCookies", {
        cookies: cookies.map((c) => ({
          name: c.name, value: c.value, domain: c.domain, path: c.path, secure: true, httpOnly: c.httpOnly,
        })),
      });
      this.log("mirror-login-seeded", { mirrorId: mirror.mirrorId, count: cookies.length, profile });
    } catch (error) {
      this.log("mirror-login-seed-skip", { mirrorId: mirror.mirrorId, reason: errorText(error) });
    }
  }

  scheduleMirrorReconnect(mirror) {
    if (!mirror || mirror.reconnectTimer || this.stopping || !this.mirrors.has(mirror.mirrorId)) return;
    mirror.reconnectTimer = setTimeout(() => {
      mirror.reconnectTimer = null;
      if (this.stopping || !this.mirrors.has(mirror.mirrorId)) return;
      void this.ensureMirrorPage(mirror).catch(() => this.scheduleMirrorReconnect(mirror));
    }, 500);
    mirror.reconnectTimer.unref?.();
  }

  screencastOptions(viewport) {
    return {
      format: "jpeg",
      quality: FRAME_QUALITY,
      maxWidth: viewport.width,
      maxHeight: viewport.height,
      everyNthFrame: 1,
    };
  }

  onPageEvent(mirror, client, method, params) {
    if (method === "Page.frameNavigated") {
      const frame = params && params.frame;
      if (frame && !frame.parentId && reportablePageUrl(frame.url)) {
        if (this.acceptsMirrorUrl(mirror, frame.url)) mirror.url = frame.url;
        this.sendMeta(mirror, { url: frame.url });
      }
      return;
    }
    if (method !== "Page.screencastFrame") return;
    void client.call("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
    if (mirror.pageClient !== client || !this.mirrors.has(mirror.mirrorId)) return;
    const data = typeof params.data === "string" ? params.data : "";
    if (!data) return;
    const sender = mirror.sender;
    if (!sender || (typeof sender.isDestroyed === "function" && sender.isDestroyed())) return;
    try { sender.send("mirror-frame", { mirrorId: mirror.mirrorId, data }); }
    catch { return; }
    mirror.frameCount += 1;
    if (mirror.frameCount === 1) {
      this.log("first-frame", { mirrorId: mirror.mirrorId, bytes: Buffer.byteLength(data, "base64") });
    }
  }

  async applyViewport(mirror, restartScreencast = true) {
    const client = mirror.pageClient;
    if (!client) throw new Error("Chrome page CDP 연결이 없습니다.");
    if (restartScreencast) {
      try { await client.call("Page.stopScreencast"); } catch {}
    }
    await client.call("Emulation.setDeviceMetricsOverride", {
      width: mirror.viewport.width,
      height: mirror.viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: mirror.viewport.width,
      screenHeight: mirror.viewport.height,
    });
    if (restartScreencast) await client.call("Page.startScreencast", this.screencastOptions(mirror.viewport));
  }

  ownerKey(ownerId, tabKey) {
    return `${ownerId}\n${tabKey}`;
  }

  trackOwner(sender, mirrorId) {
    const ownerId = sender.id;
    let entry = this.ownerMirrors.get(ownerId);
    if (!entry) {
      entry = { sender, mirrorIds: new Set() };
      this.ownerMirrors.set(ownerId, entry);
      try { sender.once("destroyed", () => { void this.stopOwner(ownerId); }); } catch {}
    }
    entry.mirrorIds.add(mirrorId);
  }

  async start({ tabKey: rawTabKey, url: rawUrl, viewport: rawViewport, manualHost } = {}, sender) {
    if (!sender || !Number.isInteger(sender.id)) throw new Error("요청 renderer를 확인할 수 없습니다.");
    const tabKey = sanitizeTabKey(rawTabKey);
    const normalized = normalizeMirrorRequest(rawUrl, manualHost);
    const { url, scope } = normalized;
    const viewport = normalizeViewport(rawViewport);
    const key = this.ownerKey(sender.id, tabKey);
    const existingId = this.tabMirrors.get(key);
    const existing = existingId && this.mirrors.get(existingId);
    if (existing) {
      if (existing.scope.kind !== scope.kind || existing.scope.host !== scope.host) {
        throw new Error("열려 있는 Chrome 미러의 허용 host를 바꿀 수 없습니다.");
      }
      const prior = { url: existing.url, viewport: existing.viewport };
      existing.url = url;
      existing.viewport = viewport;
      try {
        await this.ensureMirrorPage(existing);
        await this.applyViewport(existing);
        await existing.pageClient.call("Page.navigate", { url });
      } catch (error) {
        existing.url = prior.url;
        existing.viewport = prior.viewport;
        try { await this.applyViewport(existing); } catch {}
        throw error;
      }
      return { ok: true, mirrorId: existing.mirrorId };
    }

    const mirrorId = "mirror:" + this.randomUuid();
    const mirror = {
      mirrorId, tabKey, url, scope, viewport, sender, ownerId: sender.id,
      targetId: null, pageClient: null, opening: null, reconnectTimer: null, frameCount: 0,
      metaUrl: url, metaTitle: "",
    };
    this.mirrors.set(mirrorId, mirror);
    this.tabMirrors.set(key, mirrorId);
    this.trackOwner(sender, mirrorId);
    try {
      await this.ensureMirrorPage(mirror);
      return { ok: true, mirrorId };
    } catch (error) {
      await this.stop(mirrorId, sender).catch(() => {});
      throw error;
    }
  }

  mirrorFor(mirrorId, sender) {
    const mirror = this.mirrors.get(String(mirrorId || ""));
    if (!mirror || !sender || mirror.ownerId !== sender.id) throw new Error("Chrome 미러를 찾을 수 없습니다.");
    return mirror;
  }

  async input(mirrorId, event, sender) {
    const mirror = this.mirrorFor(mirrorId, sender);
    await this.ensureMirrorPage(mirror);
    const client = mirror.pageClient;
    const value = event && typeof event === "object" ? event : {};
    const kind = String(value.kind || "");
    if (kind === "navigation") {
      const command = String(value.command || "");
      if (command === "reload" || command === "forceReload") {
        await client.call("Page.reload", { ignoreCache: command === "forceReload" });
        return { ok: true };
      }
      if (command === "back" || command === "forward") {
        const history = await client.call("Page.getNavigationHistory");
        const offset = command === "back" ? -1 : 1;
        const entry = Array.isArray(history.entries) ? history.entries[history.currentIndex + offset] : null;
        if (entry && Number.isInteger(entry.id)) await client.call("Page.navigateToHistoryEntry", { entryId: entry.id });
        return { ok: true, navigated: !!entry };
      }
      throw new Error("지원하지 않는 mirror navigation입니다.");
    }
    if (kind === "text") {
      if (typeof value.text !== "string" || !value.text || value.text.length > MAX_TEXT_LENGTH) {
        throw new Error("입력할 text 값이 올바르지 않습니다.");
      }
      await client.call("Input.insertText", { text: value.text });
      return { ok: true };
    }
    if (kind === "wheel" || (kind === "mouse" && value.type === "wheel")) {
      await client.call("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: finiteNumber(value.x, 0, 0, mirror.viewport.width),
        y: finiteNumber(value.y, 0, 0, mirror.viewport.height),
        deltaX: finiteNumber(value.deltaX),
        deltaY: finiteNumber(value.deltaY),
        modifiers: modifiersOf(value.modifiers),
      });
      return { ok: true };
    }
    if (kind === "mouse") {
      const types = { move: "mouseMoved", press: "mousePressed", release: "mouseReleased",
        mouseMoved: "mouseMoved", mousePressed: "mousePressed", mouseReleased: "mouseReleased" };
      const type = types[value.type];
      if (!type) throw new Error("지원하지 않는 mouse event입니다.");
      const allowedButtons = new Set(["none", "left", "middle", "right", "back", "forward"]);
      const fallbackButton = type === "mouseMoved" ? "none" : "left";
      const button = allowedButtons.has(value.button) ? value.button : fallbackButton;
      await client.call("Input.dispatchMouseEvent", {
        type,
        x: finiteNumber(value.x, 0, 0, mirror.viewport.width),
        y: finiteNumber(value.y, 0, 0, mirror.viewport.height),
        button,
        buttons: boundedInteger(value.buttons, 0, 31, type === "mousePressed" ? 1 : 0),
        clickCount: boundedInteger(value.clickCount, 0, 3, type === "mouseMoved" ? 0 : 1),
        modifiers: modifiersOf(value.modifiers),
      });
      return { ok: true };
    }
    if (kind === "key") {
      const typeMap = { down: "keyDown", up: "keyUp", keyDown: "keyDown", keyUp: "keyUp",
        rawKeyDown: "rawKeyDown", char: "char" };
      const type = typeMap[value.type];
      if (!type) throw new Error("지원하지 않는 key event입니다.");
      const named = KEY_DEFAULTS[value.key] || {};
      const key = String(value.key || named.key || "").slice(0, 64);
      const code = String(value.code || named.code || "").slice(0, 64);
      const keyCode = boundedInteger(value.keyCode, 0, 255, named.keyCode || 0);
      if (!key) throw new Error("key 값이 필요합니다.");
      const params = {
        type, key, code,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode,
        modifiers: modifiersOf(value.modifiers),
        autoRepeat: value.autoRepeat === true,
        isKeypad: value.isKeypad === true,
      };
      const text = typeof value.text === "string" ? value.text : (type !== "keyUp" ? named.text : "");
      if (text) params.text = text.slice(0, 16);
      await client.call("Input.dispatchKeyEvent", params);
      return { ok: true };
    }
    throw new Error("지원하지 않는 mirror input입니다.");
  }

  async resize(mirrorId, viewport, sender) {
    const mirror = this.mirrorFor(mirrorId, sender);
    const prior = mirror.viewport;
    const next = normalizeViewport(viewport, prior);
    await this.ensureMirrorPage(mirror);
    mirror.viewport = next;
    try {
      await this.applyViewport(mirror);
    } catch (error) {
      mirror.viewport = prior;
      try { await this.applyViewport(mirror); } catch {}
      throw error;
    }
    this.log("mirror-resize", { mirrorId: mirror.mirrorId, width: mirror.viewport.width, height: mirror.viewport.height });
    return { ok: true };
  }

  async closeMirrorPage(mirror) {
    clearTimeout(mirror.reconnectTimer);
    mirror.reconnectTimer = null;
    const client = mirror.pageClient;
    const targetId = mirror.targetId;
    mirror.pageClient = null;
    mirror.targetId = null;
    mirror.opening = null;
    if (client) {
      try { await client.call("Page.stopScreencast"); } catch {}
      client.close();
    }
    if (targetId && this.browserClient) {
      try { await this.browserClient.call("Target.closeTarget", { targetId }); } catch {}
    }
  }

  async stop(mirrorId, sender) {
    const mirror = this.mirrorFor(mirrorId, sender);
    this.mirrors.delete(mirror.mirrorId);
    this.tabMirrors.delete(this.ownerKey(mirror.ownerId, mirror.tabKey));
    const owner = this.ownerMirrors.get(mirror.ownerId);
    if (owner) {
      owner.mirrorIds.delete(mirror.mirrorId);
      if (!owner.mirrorIds.size) this.ownerMirrors.delete(mirror.ownerId);
    }
    const closing = this.closeMirrorPage(mirror);
    this.log("mirror-stop", { mirrorId: mirror.mirrorId });
    await closing;
    if (!this.mirrors.size) await this.stopBrowser();
    return { ok: true };
  }

  async stopOwner(ownerId) {
    const owner = this.ownerMirrors.get(ownerId);
    if (!owner) return;
    this.ownerMirrors.delete(ownerId);
    const mirrors = [...owner.mirrorIds].map((id) => this.mirrors.get(id)).filter(Boolean);
    const closings = [];
    for (const mirror of mirrors) {
      this.mirrors.delete(mirror.mirrorId);
      this.tabMirrors.delete(this.ownerKey(mirror.ownerId, mirror.tabKey));
      closings.push(this.closeMirrorPage(mirror));
    }
    await Promise.all(closings);
    if (!this.mirrors.size) await this.stopBrowser();
  }

  async stopBrowser() {
    this.browserEpoch += 1;
    clearTimeout(this.restartTimer);
    clearTimeout(this.stableTimer);
    this.stopHealthMonitor();
    this.restartTimer = null;
    this.stableTimer = null;
    this.launching = null;
    this.bootstrapTargetIds.clear();
    const browserClient = this.browserClient;
    this.browserClient = null;
    if (browserClient) browserClient.close();
    this.openProcess = null;
    this.cdpPort = null;
    this.log("process-stop");
    const cleanup = this.killChromePids();
    this.cleanupTask = cleanup;
    try { await cleanup; } finally { if (this.cleanupTask === cleanup) this.cleanupTask = null; }
  }

  shutdownSync() {
    if (this.stopping) return;
    this.stopping = true;
    for (const mirror of this.mirrors.values()) {
      const client = mirror.pageClient;
      mirror.pageClient = null;
      mirror.targetId = null;
      if (client) client.close();
    }
    this.mirrors.clear();
    this.tabMirrors.clear();
    this.ownerMirrors.clear();
    this.browserEpoch += 1;
    clearTimeout(this.restartTimer);
    clearTimeout(this.stableTimer);
    this.stopHealthMonitor();
    this.restartTimer = null;
    this.stableTimer = null;
    this.launching = null;
    this.cleanupTask = null;
    this.bootstrapTargetIds.clear();
    const browserClient = this.browserClient;
    this.browserClient = null;
    if (browserClient) browserClient.close();
    this.openProcess = null;
    this.cdpPort = null;
    this.killChromeSync();
    process.removeListener("exit", this.exitCleanup);
  }
}

function createChromeMirrorBackend(options) {
  return new ChromeMirrorBackend(options);
}

function initCapability(ctx = {}) {
  if (!ctx.app || !ctx.ipcMain || typeof ctx.isTrustedSender !== "function") {
    throw new Error("Chrome mirror Electron ctx가 없습니다.");
  }
  // Chrome 경로와 상태 루트는 이 기능이 스스로 정하고, 공용 ctx 는 app·ipcMain·isTrustedSender·
  // log 만 준다. ctx 에 service 를 실으면 다른 native 기능까지 노출되고, native 앱 셸 모듈을
  // 직접 require 하면 기능 경계가 깨진다(둘 다 bin/smoke 가 막는다).
  const backend = createChromeMirrorBackend({
    app: ctx.app,
    log: ctx.log,
    error: ctx.error,
  });
  const trusted = (event) => {
    if (!ctx.isTrustedSender(event)) throw new Error("신뢰되지 않은 발신자입니다.");
    return event.sender;
  };
  const ipcResult = async (operation) => {
    try { return await operation(); }
    catch (error) { return { ok: false, error: errorText(error) }; }
  };

  ctx.ipcMain.handle("ac-mirror-start", (event, payload) =>
    ipcResult(() => backend.start(payload, trusted(event))));
  ctx.ipcMain.handle("ac-mirror-input", (event, payload) =>
    ipcResult(() => backend.input(payload && payload.mirrorId, payload && payload.event, trusted(event))));
  ctx.ipcMain.handle("ac-mirror-resize", (event, payload) =>
    ipcResult(() => backend.resize(payload && payload.mirrorId, payload && payload.viewport, trusted(event))));
  ctx.ipcMain.handle("ac-mirror-stop", (event, payload) =>
    ipcResult(() => backend.stop(payload && payload.mirrorId, trusted(event))));

  ctx.app.once("will-quit", () => backend.shutdownSync());
  // 사용자의 현재 Chrome 세션 연결은 같은 상위 개념의 별도 transport다. 전용 프로필 backend와
  // 상태를 섞지 않고, 이 capability가 IPC 수명만 함께 등록한다.
  initLiveChromeIpc(ctx);
  return backend;
}

module.exports = {
  ChromeMirrorBackend,
  CdpClient,
  createChromeMirrorBackend,
  initCapability,
  normalizeClaudeUrl,
  normalizeMirrorRequest,
  normalizeViewport,
  parsePidList,
};
