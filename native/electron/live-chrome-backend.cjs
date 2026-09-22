// 사용자가 허용한 실행 중 Chrome에 붙어, Iris가 만든 page target만 미러한다.
//
// 소유 범위
//   명시적 connect/disconnect 수명, Iris가 root CDP로 직접 만든 target의 논리 ID,
//   그 target에 한정한 Page screencast와 Input 명령이다.
//
// 의존 대상
//   Chrome 144+의 chrome://inspect/#remote-debugging 동의 흐름과 Puppeteer connect({channel})다.
//   puppeteer-core는 connect()가 실제로 호출될 때만 불러온다. 테스트와 상위 capability는 connectFn을
//   주입할 수 있다.
//
// 유지 조건
//   Chrome을 실행하거나 닫지 않고, Iris 기능에서 기존 tab을 열거·노출·닫지 않으며,
//   쿠키·스토리지·user-data-dir을 읽거나 바꾸지 않는다. Puppeteer connect 자체는 target discovery와
//   필터된 tab의 debugger resume/detach를 수행한다. 연결이 끊겨도 자동 재연결하지 않는다.
//   네이티브 인증은 실제 Chrome 탭을 앞으로 보인 뒤 연결을 끊어 사용자가 Chrome 자체 UI에서 끝내게 한다.

const { randomUUID } = require("node:crypto");

const MAX_TEXT_LENGTH = 65536;
const TARGET_COMMAND_TIMEOUT_MS = 10000;
const ALLOWED_COMMANDS = new Set([
  "Page.navigate",
  "Page.getNavigationHistory",
  "Page.navigateToHistoryEntry",
  "Page.reload",
  "Page.bringToFront",
  "Page.startScreencast",
  "Page.stopScreencast",
  "Input.insertText",
  "Input.dispatchKeyEvent",
  "Input.dispatchMouseEvent",
  "Input.dispatchTouchEvent",
]);

class LiveChromeError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "LiveChromeError";
    this.code = code;
  }
}

async function defaultConnect(options) {
  const imported = await import("puppeteer-core");
  const connect = imported.connect || imported.default?.connect;
  if (typeof connect !== "function") {
    throw new LiveChromeError("connector-unavailable", "puppeteer-core의 Chrome 연결 함수를 찾지 못했습니다.");
  }
  return connect(options);
}

function targetFilter(target) {
  // 이 callback은 Puppeteer 객체 노출만 제한한다. 라이브러리 내부 discovery/auto-attach를 막지는 못한다.
  let type = "";
  try { type = String(target?.type?.() || ""); } catch {}
  return type === "browser";
}

function safeUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || "")); }
  catch { throw new LiveChromeError("unsafe-url", "Chrome 탭은 자격증명 없는 http(s) 주소만 열 수 있습니다."); }
  if (parsed.username || parsed.password || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw new LiveChromeError("unsafe-url", "Chrome 탭은 자격증명 없는 http(s) 주소만 열 수 있습니다.");
  }
  return parsed.href;
}

function normalizeOwner(value) {
  const owner = String(value || "").trim();
  if (!owner || owner.length > 256) throw new LiveChromeError("invalid-owner", "Chrome 탭 owner가 올바르지 않습니다.");
  return owner;
}

function normalizeScreencast(value) {
  const source = value && typeof value === "object" ? value : {};
  const format = source.format === "png" ? "png" : "jpeg";
  const number = (candidate, min, max, fallback) => {
    const parsed = Number(candidate);
    return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : fallback;
  };
  const result = {
    format,
    quality: number(source.quality, 0, 100, 75),
    everyNthFrame: number(source.everyNthFrame, 1, 60, 1),
    maxFramesInFlight: 1,
  };
  if (source.maxWidth != null) result.maxWidth = number(source.maxWidth, 1, 16384, 1280);
  if (source.maxHeight != null) result.maxHeight = number(source.maxHeight, 1, 16384, 900);
  return result;
}

function normalizedCommandArgs(command, value) {
  const args = value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
  if (command === "Page.navigate") return { url: safeUrl(args.url) };
  if (command === "Page.reload") return { ignoreCache: args.ignoreCache === true };
  if (command === "Page.getNavigationHistory") return {};
  if (command === "Page.navigateToHistoryEntry") {
    const entryId = Number(args.entryId);
    if (!Number.isInteger(entryId)) throw new LiveChromeError("command-failed", "Chrome 방문 기록 항목이 올바르지 않습니다.");
    return { entryId };
  }
  if (command === "Page.startScreencast") return normalizeScreencast(args);
  if (command === "Page.stopScreencast" || command === "Page.bringToFront") return {};
  if (command === "Input.insertText") {
    const text = String(args.text ?? "");
    if (text.length > MAX_TEXT_LENGTH) throw new LiveChromeError("input-too-large", "Chrome 입력이 너무 깁니다.");
    return { text };
  }
  return args;
}

function connectionFailure(error) {
  if (error instanceof LiveChromeError) {
    return { ok: false, code: error.code, message: error.message };
  }
  const message = String(error?.message || error || "").toLowerCase();
  if (/permission|denied|reject|cancel|not allowed/.test(message)) {
    return { ok: false, code: "permission-denied", message: "Chrome에서 원격 디버깅 연결을 허용해 주세요." };
  }
  if (/devtoolsactiveport|remote debugging|not running|enoent|could not find/.test(message)) {
    return {
      ok: false,
      code: "chrome-unavailable",
      message: "Chrome을 실행하고 chrome://inspect/#remote-debugging에서 원격 디버깅을 켜 주세요.",
    };
  }
  if (/another|already connected|socket.*closed|connection.*closed|conflict/.test(message)) {
    return { ok: false, code: "connection-conflict", message: "다른 디버깅 연결을 닫고 다시 시도해 주세요." };
  }
  return { ok: false, code: "connection-failed", message: "Chrome 연결을 시작하지 못했습니다." };
}

// Puppeteer Page 객체를 만들지 않고, 저장한 target ID 하나에만 직접 attach하는 작은 CDP
// tunnel을 쓴다. Target.getTargets/browser.pages는 호출하지 않는다.
class ExactTargetSession {
  constructor(root, sessionId, targetId) {
    this.root = root;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.listeners = new Map();
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.rootDetached = false;
    this.receive = (event) => this.receiveMessage(event);
    this.detached = (event) => {
      if (event?.sessionId === this.sessionId) this.fail(new LiveChromeError("target-unavailable", "Chrome 탭 연결이 끝났습니다."));
    };
    root.on?.("Target.receivedMessageFromTarget", this.receive);
    root.on?.("Target.detachedFromTarget", this.detached);
  }

  on(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(listener);
  }

  off(name, listener) { this.listeners.get(name)?.delete(listener); }

  receiveMessage(event) {
    if (!event || event.sessionId !== this.sessionId || typeof event.message !== "string") return;
    let message;
    try { message = JSON.parse(event.message); } catch { return; }
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new LiveChromeError("command-failed", String(message.error.message || "Chrome 명령이 실패했습니다.")));
      else pending.resolve(message.result || {});
      return;
    }
    if (!message.method) return;
    for (const listener of this.listeners.get(message.method) || []) {
      try { listener(message.params || {}); } catch {}
    }
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new LiveChromeError("target-unavailable", "Chrome 탭 연결이 열려 있지 않습니다."));
    const id = this.nextId++;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LiveChromeError("command-timeout", `Chrome ${method} 명령 시간이 초과됐습니다.`));
      }, TARGET_COMMAND_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
    });
    const message = JSON.stringify({ id, method, params });
    Promise.resolve(this.root.send("Target.sendMessageToTarget", { sessionId: this.sessionId, message })).catch((error) => {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new LiveChromeError("command-failed", `Chrome ${method} 명령을 보내지 못했습니다.`, { cause: error }));
    });
    return result;
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async closeTarget() {
    if (this.closed) throw new LiveChromeError("target-unavailable", "Chrome 탭 연결이 열려 있지 않습니다.");
    await this.root.send("Target.closeTarget", { targetId: this.targetId });
  }

  async detach() {
    if (this.rootDetached) return;
    this.rootDetached = true;
    if (!this.closed) this.fail(new LiveChromeError("target-unavailable", "Chrome 탭 연결을 해제했습니다."));
    this.root.off?.("Target.receivedMessageFromTarget", this.receive);
    this.root.off?.("Target.detachedFromTarget", this.detached);
    try { await this.root.send("Target.detachFromTarget", { sessionId: this.sessionId }); } catch {}
    try { await this.root.detach?.(); } catch {}
  }
}

async function attachExactTargetOnRoot(root, targetId, expectedContextId) {
  const result = await root.send("Target.getTargetInfo", { targetId });
  const info = result?.targetInfo;
  if (!info || info.targetId !== targetId || info.type !== "page" ||
      (expectedContextId && info.browserContextId && info.browserContextId !== expectedContextId)) {
    throw new LiveChromeError("target-unavailable", "이전에 만든 Chrome 탭을 찾지 못했습니다.");
  }
  const attached = await root.send("Target.attachToTarget", { targetId, flatten: false });
  if (!attached?.sessionId) throw new LiveChromeError("target-unavailable", "Chrome 탭 연결 ID를 받지 못했습니다.");
  return { session: new ExactTargetSession(root, attached.sessionId, targetId), info };
}

async function rootSession(browser) {
  let browserTarget;
  try { browserTarget = browser?.target?.(); } catch {}
  if (!browserTarget || typeof browserTarget.createCDPSession !== "function") {
    throw new LiveChromeError("target-unavailable", "Chrome browser target에 연결할 수 없습니다.");
  }
  return await browserTarget.createCDPSession();
}

async function attachExactTarget(browser, targetId, expectedContextId) {
  const root = await rootSession(browser);
  try {
    return (await attachExactTargetOnRoot(root, targetId, expectedContextId)).session;
  } catch (error) {
    try { await root.detach?.(); } catch {}
    throw error;
  }
}

async function createExactTarget(browser) {
  const root = await rootSession(browser);
  let targetId = "";
  try {
    const created = await root.send("Target.createTarget", { url: "about:blank" });
    targetId = typeof created?.targetId === "string" ? created.targetId : "";
    if (!targetId) throw new LiveChromeError("target-unavailable", "새 Chrome 탭 ID를 받지 못했습니다.");
    return await attachExactTargetOnRoot(root, targetId);
  } catch (error) {
    if (targetId) {
      try { await root.send("Target.closeTarget", { targetId }); } catch {}
    }
    try { await root.detach?.(); } catch {}
    throw error;
  }
}

class LiveChromeBackend {
  constructor({ connectFn = defaultConnect, onFrame = () => {}, onState = () => {}, idFn = randomUUID } = {}) {
    if (typeof connectFn !== "function") throw new TypeError("connectFn은 함수여야 합니다.");
    if (typeof onFrame !== "function" || typeof onState !== "function") throw new TypeError("Chrome callback은 함수여야 합니다.");
    this.connectFn = connectFn;
    this.onFrame = onFrame;
    this.onState = onState;
    this.idFn = idFn;
    this.browser = null;
    this.connectionTask = null;
    this.disconnectTask = null;
    this.connectionEpoch = 0;
    this.browserDisconnected = null;
    this.records = new Map();
    this.state = "disconnected";
  }

  emitState(state, details = {}) {
    this.state = state;
    try { this.onState({ state, ...details }); } catch {}
  }

  async connect() {
    if (this.disconnectTask) await this.disconnectTask;
    if (this.browser) return { ok: true, state: "connected", restored: 0 };
    if (this.connectionTask) return this.connectionTask;
    const epoch = ++this.connectionEpoch;
    const task = this.doConnect(epoch);
    this.connectionTask = task;
    try { return await task; }
    finally { if (this.connectionTask === task) this.connectionTask = null; }
  }

  async doConnect(epoch) {
    this.emitState("connecting");
    let browser;
    try {
      browser = await this.connectFn({
        channel: "chrome",
        defaultViewport: null,
        networkEnabled: false,
        issuesEnabled: false,
        targetFilter,
      });
      if (!browser || typeof browser.target !== "function" || typeof browser.disconnect !== "function") {
        throw new LiveChromeError("connector-incompatible", "Chrome 연결기가 필요한 API를 제공하지 않습니다.");
      }
    } catch (error) {
      if (browser && typeof browser.disconnect === "function") {
        try { await browser.disconnect(); } catch {}
      }
      const failure = connectionFailure(error);
      this.emitState("disconnected", { code: failure.code });
      return failure;
    }

    if (epoch !== this.connectionEpoch) {
      try { await browser.disconnect(); } catch {}
      const failure = { ok: false, code: "connection-cancelled", message: "Chrome 연결을 취소했습니다." };
      this.emitState("disconnected", { code: failure.code });
      return failure;
    }

    this.browser = browser;
    const observed = browser;
    this.browserDisconnected = () => this.handleUnexpectedDisconnect(observed);
    browser.on?.("disconnected", this.browserDisconnected);
    let restored = 0;
    for (const record of this.records.values()) {
      if (epoch !== this.connectionEpoch || this.browser !== browser) break;
      if (record.session) continue;
      let session;
      try {
        session = await attachExactTarget(browser, record.targetId, record.browserContextId);
        this.bindSession(record, session);
        await session.send("Page.enable");
        await session.send("Page.startScreencast", normalizeScreencast(record.screencast));
        record.screencasting = true;
        record.mode = "live";
        record.accepting = true;
        restored++;
      } catch {
        try { record.unbind?.(); } catch {}
        try { await session?.detach?.(); } catch {}
        record.session = null;
        record.unbind = null;
        record.mode = "detached";
        record.accepting = false;
        this.emitState("tab-unavailable", { id: record.id });
      }
    }
    if (epoch !== this.connectionEpoch || this.browser !== browser) {
      return { ok: false, code: "connection-cancelled", message: "Chrome 연결을 취소했습니다." };
    }
    this.emitState("connected", { restored });
    return { ok: true, state: "connected", restored };
  }

  handleUnexpectedDisconnect(browser) {
    if (this.browser !== browser) return;
    this.browser = null;
    this.browserDisconnected = null;
    for (const record of this.records.values()) {
      record.session = null;
      record.screencasting = false;
      record.accepting = false;
      if (record.mode !== "native") record.mode = "detached";
    }
    this.emitState("disconnected", { code: "connection-lost" });
  }

  safeTarget(record) { return { kind: "owned-page", id: record.id }; }

  bindSession(record, session) {
    record.session = session;
    const frame = (event) => this.consumeFrame(record, session, event);
    const navigated = (event) => {
      const value = event?.frame;
      if (!value || value.parentId) return;
      try {
        record.url = safeUrl(value.url);
        this.emitState("tab-navigated", { id: record.id, url: record.url });
      } catch {}
    };
    session.on?.("Page.screencastFrame", frame);
    session.on?.("Page.frameNavigated", navigated);
    record.unbind = () => {
      session.off?.("Page.screencastFrame", frame);
      session.off?.("Page.frameNavigated", navigated);
    };
  }

  consumeFrame(record, session, event) {
    if (!event || typeof event.data !== "string" || !Number.isInteger(event.sessionId)) return;
    const consume = record.frameQueue.then(async () => {
      try {
        if (record.session === session && record.mode === "live") {
          await this.onFrame({ id: record.id, data: event.data, metadata: event.metadata || {} });
        }
      } finally {
        try { await session.send("Page.screencastFrameAck", { sessionId: event.sessionId }); } catch {}
      }
    });
    record.frameQueue = consume.catch(() => {});
  }

  async openTab({ url, owner, screencast } = {}) {
    const wanted = safeUrl(url);
    const ownedBy = normalizeOwner(owner);
    const browser = this.browser;
    if (!browser) throw new LiveChromeError("not-connected", "Chrome에 먼저 연결해 주세요.");
    let session;
    let record;
    try {
      if (this.browser !== browser) throw new LiveChromeError("not-connected", "Chrome 연결이 끝났습니다.");
      const attached = await createExactTarget(browser);
      session = attached.session;
      const info = attached.info;
      if (this.browser !== browser) throw new LiveChromeError("not-connected", "Chrome 연결이 끝났습니다.");
      const id = String(this.idFn());
      if (!id || this.records.has(id)) throw new LiveChromeError("id-collision", "Chrome 탭 ID를 만들지 못했습니다.");
      record = {
        id,
        owner: ownedBy,
        targetId: info.targetId,
        browserContextId: info.browserContextId || "",
        url: wanted,
        session,
        unbind: null,
        mode: "live",
        accepting: true,
        screencasting: false,
        screencast: normalizeScreencast(screencast),
        serial: Promise.resolve(),
        frameQueue: Promise.resolve(),
      };
      this.records.set(id, record);
      this.bindSession(record, session);
      await session.send("Page.enable");
      await session.send("Page.startScreencast", record.screencast);
      record.screencasting = true;
      await session.send("Page.navigate", { url: wanted });
      const target = this.safeTarget(record);
      this.emitState("tab-opened", { id });
      return { ok: true, id, owner: ownedBy, target, url: record.url };
    } catch (error) {
      if (record) this.records.delete(record.id);
      try { record?.unbind?.(); } catch {}
      if (session) {
        try { await session.closeTarget(); } catch {}
        try { await session.detach(); } catch {}
      }
      throw error;
    }
  }

  owned(id) {
    const record = this.records.get(String(id || ""));
    if (!record) throw new LiveChromeError("tab-not-owned", "Iris가 만든 Chrome 탭이 아닙니다.");
    return record;
  }

  enqueue(record, operation) {
    const result = record.serial.then(operation);
    record.serial = result.catch(() => {});
    return result;
  }

  async command(id, command, args = {}) {
    const record = this.owned(id);
    if (!ALLOWED_COMMANDS.has(command)) {
      throw new LiveChromeError("command-not-allowed", "이 Chrome 명령은 허용되지 않습니다.");
    }
    if (!record.accepting || record.mode === "native") {
      throw new LiveChromeError("native-interaction", "Chrome에서 진행 중인 사용자 작업이 끝난 뒤 다시 연결해 주세요.");
    }
    const params = normalizedCommandArgs(command, args);
    return await this.enqueue(record, async () => {
      if (!record.accepting || record.mode !== "live" || !record.session) {
        throw new LiveChromeError("target-unavailable", "Chrome 탭 연결이 열려 있지 않습니다.");
      }
      const result = await record.session.send(command, params);
      if (command === "Page.startScreencast") {
        record.screencast = params;
        record.screencasting = true;
      } else if (command === "Page.stopScreencast") {
        record.screencasting = false;
      } else if (command === "Page.navigate") {
        record.url = params.url;
      }
      return result;
    });
  }

  async stopRecord(record) {
    record.accepting = false;
    await record.serial;
    if (record.session && record.screencasting) {
      try { await record.session.send("Page.stopScreencast"); } catch {}
      record.screencasting = false;
    }
  }

  async beginNativeInteraction(id) {
    const record = this.owned(id);
    if (!record.session || record.mode !== "live") throw new LiveChromeError("target-unavailable", "Chrome 탭 연결이 열려 있지 않습니다.");
    record.accepting = false;
    record.mode = "native";
    await record.serial;
    let failure;
    try {
      if (record.screencasting) {
        try { await record.session.send("Page.stopScreencast"); }
        catch (error) { failure = error; }
        record.screencasting = false;
      }
      try { await record.session.send("Page.bringToFront"); }
      catch (error) { failure ||= error; }
    } finally {
      await this.disconnect();
    }
    if (failure) throw new LiveChromeError("target-unavailable", "Chrome 탭을 앞으로 전환하지 못했습니다.", { cause: failure });
    return { ok: true, mode: "native", id: record.id, owner: record.owner, target: this.safeTarget(record) };
  }

  async closeTab(id) {
    const record = this.owned(id);
    if (!this.browser || !record.session) throw new LiveChromeError("not-connected", "Chrome에 다시 연결한 뒤 탭을 닫아 주세요.");
    await this.stopRecord(record);
    try { record.unbind?.(); } catch {}
    try {
      if (typeof record.session.closeTarget === "function") await record.session.closeTarget();
      else throw new LiveChromeError("target-unavailable", "소유한 Chrome 탭을 닫을 수 없습니다.");
    } finally {
      try { await record.session.detach?.(); } catch {}
    }
    this.records.delete(record.id);
    this.emitState("tab-closed", { id: record.id });
    return { ok: true, id: record.id };
  }

  async disconnect() {
    this.connectionEpoch++;
    if (this.disconnectTask) return this.disconnectTask;
    const pendingConnect = this.connectionTask;
    const task = (async () => {
      if (pendingConnect) {
        try { await pendingConnect; } catch {}
      }
      return this.doDisconnect();
    })();
    this.disconnectTask = task;
    try { return await task; }
    finally { if (this.disconnectTask === task) this.disconnectTask = null; }
  }

  async doDisconnect() {
    const browser = this.browser;
    if (!browser) return { ok: true, state: "disconnected" };
    this.browser = null;
    if (this.browserDisconnected) browser.off?.("disconnected", this.browserDisconnected);
    this.browserDisconnected = null;
    for (const record of this.records.values()) {
      await this.stopRecord(record);
      try { record.unbind?.(); } catch {}
      try { await record.session?.detach?.(); } catch {}
      record.session = null;
      if (record.mode !== "native") record.mode = "detached";
    }
    try { await browser.disconnect(); } catch {}
    this.emitState("disconnected");
    return { ok: true, state: "disconnected" };
  }
}

function createLiveChromeBackend(options) { return new LiveChromeBackend(options); }

module.exports = {
  ALLOWED_COMMANDS,
  LiveChromeBackend,
  LiveChromeError,
  createLiveChromeBackend,
};
