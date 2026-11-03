const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createTargetValidator } = require("./target-validator.cjs");
const { pruneAxNodes } = require("../ax-prune.cjs");

const BASE_COMMANDS = new Set([
  "cdp.send", "cdp.batch", "cdp.frames", "cdp.reset", "cdp.subscribe", "cdp.unsubscribe",
  "wc.info", "wc.nav", "wc.exec", "wc.input", "wc.capture", "wc.captureToFile", "wc.pdf", "wc.pdfToFile",
  "tab.state", "hold.capture", "focus.state", "focus.prepare", "focus.return", "ai.enter", "ai.leave",
  "viewport.get", "viewport.apply", "viewport.setTemporary", "viewport.restore", "obs.read", "obs.drain", "obs.clear",
  "dialog.state", "dialog.answer", "dialog.plan", "upload.arm", "download.state", "download.configure",
  "login.accounts", "login.fill", "login.input", "native.click", "native.key", "native.drag", "native.window",
  "native.windowClick", "native.windowKey", "qa.mode", "qa.anchor", "viewport.ensureReady", "viewport.qa",
  "img.render", "contextaction", "cdp.attach", "ref.record", "ref.resolve", "cdp.detachIdle", "result.redact",
  "cdp.gate", "cdp.sync", "wc.navHistory", "cdp.screencastShot", "img.stitch", "img.diff", "img.same",
  "obs.pending", "obs.since", "ax.tree",
]);

const MAX_EVENTS = 1000;
const MAX_EVENT_BYTES = 4 * 1024 * 1024;
const RETIRE_TIMEOUT_MS = 5000;

function navigationSettled(wc, timeout = 10000) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      wc.removeListener("did-navigate", done);
      wc.removeListener("did-navigate-in-page", inPage);
      wc.removeListener("did-fail-load", failed);
      resolve();
    };
    const inPage = (_event, _url, isMainFrame) => { if (isMainFrame !== false) done(); };
    const failed = (_event, _code, _description, _url, isMainFrame) => { if (isMainFrame !== false) done(); };
    const timer = setTimeout(done, timeout);
    wc.on("did-navigate", done);
    wc.on("did-navigate-in-page", inPage);
    wc.on("did-fail-load", failed);
  });
}

function createElectronRelay(deps) {
  const validator = createTargetValidator(deps);
  const retiredGenerations = new Set();
  const leftoverRecords = new Map();
  const resourceReleaseTimeoutMs = Number.isFinite(deps.resourceReleaseTimeoutMs)
    ? Math.max(1, deps.resourceReleaseTimeoutMs) : RETIRE_TIMEOUT_MS;
  const resourceVersions = new Map();
  const resourceQueues = new Map();
  const captureOwners = new Map();
  let resourceSequence = 0;
  let owner = null;

  const error = (code, message, details) => {
    const out = deps.codedError(code, message);
    if (details !== undefined) out.details = details;
    return out;
  };

  const resourceKey = (kind, id) => `${kind}:${id == null ? "app" : id}`;
  const resourceToken = (rec, kind, id) => {
    const key = resourceKey(kind, id);
    const token = { generation: rec.generation, sequence: ++resourceSequence };
    resourceVersions.set(key, token);
    return token;
  };
  const currentResource = (kind, id, token) => {
    const current = resourceVersions.get(resourceKey(kind, id));
    return !!current && !!token && current.generation === token.generation && current.sequence === token.sequence;
  };
  const newerGenerationOwnsResource = (kind, id, token) => {
    const current = resourceVersions.get(resourceKey(kind, id));
    return !!current && !!token && current.sequence !== token.sequence && current.generation !== token.generation;
  };
  const claimOlderResource = (rec, kind, id) => {
    const current = resourceVersions.get(resourceKey(kind, id));
    if (current && current.generation !== rec.generation) resourceToken(rec, kind, id);
  };
  const serializeResource = (kind, id, task) => {
    const key = resourceKey(kind, id);
    const previous = resourceQueues.get(key) || Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.then(() => {}, () => {});
    resourceQueues.set(key, tail);
    tail.finally(() => { if (resourceQueues.get(key) === tail) resourceQueues.delete(key); });
    return run;
  };
  const sameViewport = (left, right) => !!left && !!right
    && left.width === right.width && left.height === right.height && (left.dpr ?? 1) === (right.dpr ?? 1);

  function resources(generation, connection) {
    return {
      generation,
      connection,
      state: "accepting",
      active: new Set(),
      ai: new Map(),
      // commandId → { tickets, holds } · 단위가 닫힐 때 짝이 안 맞은 표식을 반환(releaseCommand)
      commandScopes: new Map(),
      holds: new Map(),
      focus: new Set(),
      viewports: new Map(),
      subscriptions: new Map(),
      bindings: new Map(),
      scripts: new Map(),
      screencasts: new Map(),
      dialogs: new Map(),
      uploads: new Map(),
      qaModes: new Map(),
      qaViewports: new Map(),
      hiddenViewports: new Map(),
      downloadArmed: false,
      nextTicket: 1,
      cleanupPromise: null,
      cleanupAgain: false,
    };
  }

  function requireOwner(workerGeneration, commandId) {
    if (!owner || owner.generation !== workerGeneration || owner.state !== "accepting") {
      throw error("STALE_WORKER", "현재 허용된 작업 프로세스 세대가 아닙니다.");
    }
    const prefix = workerGeneration + "/";
    if (typeof commandId !== "string" || !commandId.startsWith(prefix) || commandId.length === prefix.length) {
      throw error("INVALID_REQUEST", "commandId가 workerGeneration에 속하지 않습니다. lifecycle 명령은 <workerGeneration>/lifecycle/<run>/<uuid> 형식이어야 합니다.");
    }
    return owner;
  }

  function bootIdOf(workerGeneration) {
    const at = String(workerGeneration || "").lastIndexOf(":");
    return at > 0 ? workerGeneration.slice(0, at) : workerGeneration;
  }

  async function acceptGeneration(workerGeneration, connection, { takeover = false } = {}) {
    if (typeof workerGeneration !== "string" || !workerGeneration) throw error("INVALID_REQUEST", "workerGeneration이 필요합니다.");
    retryLeftovers();
    if (retiredGenerations.has(workerGeneration)) throw error("STALE_WORKER", "이미 종료된 작업 프로세스 세대입니다.");
    const connectionChanged = owner && owner.connection != null && connection != null && owner.connection !== connection;
    const bootChanged = owner && bootIdOf(owner.generation) !== bootIdOf(workerGeneration);
    if (owner && owner.generation === workerGeneration && owner.state === "accepting" && !connectionChanged) {
      if (owner.connection == null && connection != null) owner.connection = connection;
      return { accepted: true, existing: true };
    }
    const sameBootTakeover = takeover && owner && owner.generation !== workerGeneration && !bootChanged;
    if (sameBootTakeover) {
      await retireRecord(owner, { force: true });
    }
    if (owner && owner.state !== "retired" && (bootChanged || connectionChanged)) {
      await retireRecord(owner, { remember: owner.generation !== workerGeneration });
    }
    if (owner && owner.state !== "retired") throw error("BUSY", "이전 작업 프로세스 세대가 아직 종료되지 않았습니다.");
    owner = resources(workerGeneration, connection);
    return { accepted: true, workerGeneration, ...(sameBootTakeover ? { takeover: true } : {}) };
  }

  function safeValue(wcId, value) {
    try { return deps.redact(wcId, value); }
    catch { throw error("REDACTION_FAILED", "중계 결과를 안전하게 가리지 못했습니다."); }
  }

  function safeError(wcId, cause) {
    const safe = safeValue(wcId, {
      message: String((cause && cause.message) || cause),
      details: cause && cause.details,
    });
    return error((cause && cause.code) || "INTERNAL", safe.message, safe.details);
  }

  function commandSession(target, args) {
    const requested = args && args.sessionId;
    if (requested == null) return target && target.childSessionId;
    if (!deps.targetState.ownsChildSession(target.wcId, requested)) {
      throw error("STALE_TARGET", "요청한 자식 CDP 세션이 현재 탭에 속하지 않습니다.");
    }
    return requested;
  }

  function commandSender(wc, target) {
    return (method, params, sessionId) => wc.debugger.sendCommand(method, params || {}, sessionId ?? target?.childSessionId);
  }

  function resourceSet(map, key, wc, target, sessionId) {
    let entry = map.get(key);
    if (!entry || entry.debuggerGeneration !== target?.debuggerGeneration) {
      entry = { values: new Set(), tokens: new Map(), wcId: wc.id, sessionId,
        documentGeneration: target?.documentGeneration, debuggerGeneration: target?.debuggerGeneration };
      map.set(key, entry);
    }
    return entry;
  }

  function cdpResource(wcId, sessionId, method, params) {
    const sessionKey = `${wcId}\n${sessionId || ""}`;
    if ((method === "Runtime.addBinding" || method === "Runtime.removeBinding") && params?.name) {
      return { kind: "cdp-binding", id: `${sessionKey}\n${String(params.name)}` };
    }
    if (method === "Page.startScreencast" || method === "Page.stopScreencast") {
      return { kind: "cdp-screencast", id: sessionKey };
    }
    return null;
  }

  function trackCdp(rec, wc, target, method, params, result, sessionId) {
    const key = `${wc.id}\n${sessionId || ""}`;
    if (method === "Runtime.addBinding" && params?.name) {
      const name = String(params.name);
      const entry = resourceSet(rec.bindings, key, wc, target, sessionId);
      entry.values.add(name);
      entry.tokens.set(name, resourceToken(rec, "cdp-binding", `${key}\n${name}`));
    }
    if (method === "Runtime.removeBinding" && params?.name) {
      const name = String(params.name);
      resourceToken(rec, "cdp-binding", `${key}\n${name}`);
      rec.bindings.get(key)?.values.delete(name);
      rec.bindings.get(key)?.tokens.delete(name);
    }
    if (method === "Page.addScriptToEvaluateOnNewDocument" && result?.identifier) {
      resourceSet(rec.scripts, key, wc, target, sessionId).values.add(String(result.identifier));
    }
    if (method === "Page.removeScriptToEvaluateOnNewDocument" && params?.identifier) rec.scripts.get(key)?.values.delete(String(params.identifier));
    if (method === "Page.startScreencast") rec.screencasts.set(key, { wcId: wc.id, sessionId,
      documentGeneration: target?.documentGeneration, debuggerGeneration: target?.debuggerGeneration,
      token: resourceToken(rec, "cdp-screencast", key) });
    if (method === "Page.stopScreencast") {
      resourceToken(rec, "cdp-screencast", key);
      rec.screencasts.delete(key);
    }
  }

  async function sendCdp(rec, wc, target, args) {
    const method = String(args?.method || "");
    if (!method) throw error("INVALID_REQUEST", "CDP method가 필요합니다.");
    const sessionId = commandSession(target, args);
    const params = args?.params && typeof args.params === "object" ? args.params : {};
    const tracked = cdpResource(wc.id, sessionId, method, params);
    const execute = async () => {
      const result = await wc.debugger.sendCommand(method, params, sessionId);
      trackCdp(rec, wc, target, method, params, result, sessionId);
      return result;
    };
    return tracked ? serializeResource(tracked.kind, tracked.id, execute) : execute();
  }

  function inheritViewportResources(rec, wcId) {
    for (const older of leftoverRecords.values()) {
      if (older === rec || older.generation === rec.generation) continue;
      const temporary = older.viewports.get(wcId);
      if (temporary) {
        if (currentResource("temporary-viewport", wcId, temporary.token)) {
          if (!rec.viewports.has(wcId)) rec.viewports.set(wcId, {
            ...temporary,
            value: temporary.value ? { ...temporary.value } : temporary.value,
            previous: temporary.previous ? { ...temporary.previous } : temporary.previous,
            token: resourceToken(rec, "temporary-viewport", wcId),
          });
          else resourceToken(rec, "temporary-viewport", wcId);
        }
        older.viewports.delete(wcId);
      }
      const qa = older.qaViewports.get(wcId);
      if (qa) {
        if (currentResource("qa-viewport", wcId, qa.token)) {
          if (!rec.qaViewports.has(wcId)) rec.qaViewports.set(wcId, {
            ...qa,
            previous: qa.previous ? { ...qa.previous } : qa.previous,
            value: qa.value ? { ...qa.value } : qa.value,
            token: resourceToken(rec, "qa-viewport", wcId),
          });
          else resourceToken(rec, "qa-viewport", wcId);
        }
        older.qaViewports.delete(wcId);
      }
      const hidden = older.hiddenViewports.get(wcId);
      if (hidden) {
        if (currentResource("hidden-viewport", wcId, hidden)) {
          if (!rec.hiddenViewports.has(wcId)) {
            rec.hiddenViewports.set(wcId, resourceToken(rec, "hidden-viewport", wcId));
          } else resourceToken(rec, "hidden-viewport", wcId);
        }
        older.hiddenViewports.delete(wcId);
      }
    }
  }

  function subscriptionEvent(rec, sub, wcId, method, params, childSessionId) {
    if (wcId !== sub.wcId || (sub.methods.size && !sub.methods.has(method))) return;
    if (method === "Page.screencastFrame" && params?.sessionId != null) {
      const wc = deps.webContents.fromId(sub.wcId);
      try { wc?.debugger.sendCommand("Page.screencastFrameAck", { sessionId: params.sessionId }, childSessionId).catch(() => {}); } catch {}
    }
    const eventSeq = ++sub.eventSeq;
    const event = safeValue(sub.wcId, {
      workerGeneration: rec.generation,
      subscriptionId: sub.id,
      eventSeq,
      method,
      params,
      childSessionId: childSessionId || undefined,
    });
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (sub.pendingCount >= MAX_EVENTS || sub.pendingBytes + bytes > MAX_EVENT_BYTES) {
      sub.unsubscribe();
      rec.subscriptions.delete(sub.id);
      deps.emitEvent({ workerGeneration: rec.generation, subscriptionId: sub.id, eventSeq,
        error: { code: "EVENT_OVERFLOW", message: "이벤트 구독 상한을 넘었습니다." } });
      return;
    }
    sub.pendingCount++;
    sub.pendingBytes += bytes;
    let delivered = false;
    const onDelivered = (ok) => {
      if (!ok || delivered) return;
      delivered = true;
      sub.pendingCount = Math.max(0, sub.pendingCount - 1);
      sub.pendingBytes = Math.max(0, sub.pendingBytes - bytes);
    };
    const immediate = deps.emitEvent(event, onDelivered);
    if (immediate === true) onDelivered(true);
  }

  async function restoreViewportLocked(rec, wcId) {
    const entry = rec.viewports.get(wcId);
    if (!entry) return { restored: false };
    if (!currentResource("temporary-viewport", wcId, entry.token)) {
      rec.viewports.delete(wcId);
      return { restored: false, superseded: true };
    }
    const wc = deps.webContents.fromId(wcId);
    if (!wc || wc.isDestroyed?.()) { rec.viewports.delete(wcId); return { restored: false }; }
    const previous = Object.hasOwn(entry, "previous") ? entry.previous : deps.viewport.explicit(wcId);
    if (previous) {
      if (entry.previousManaged) await deps.viewport.apply(wc, previous);
      else await wc.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
        width: previous.width, height: previous.height,
        deviceScaleFactor: Number(previous.dpr) || 0, mobile: false,
      });
      const qa = rec.qaViewports.get(wcId);
      if (entry.previousManaged && qa && sameViewport(qa.value, previous)) {
        qa.revision = deps.viewport.revision?.(wcId);
      }
      rec.viewports.delete(wcId);
      return { restored: true, explicit: true };
    }
    await wc.debugger.sendCommand("Emulation.clearDeviceMetricsOverride");
    rec.viewports.delete(wcId);
    return { restored: true, explicit: false };
  }

  function restoreViewport(rec, wcId) {
    return serializeResource("viewport", wcId, () => restoreViewportLocked(rec, wcId));
  }

  function info(wc) {
    let url = "", title = "", loading = false;
    try { url = wc.getURL(); } catch {}
    try { title = wc.getTitle(); } catch {}
    try { loading = !!wc.isLoading(); } catch {}
    let zoom = 1;
    try { zoom = Number(wc.getZoomFactor?.()) || 1; } catch {}
    return {
      wcId: wc.id, url, title, loading, zoom,
      canGoBack: !!wc.canGoBack?.(), canGoForward: !!wc.canGoForward?.(),
      ...deps.targetState.generations(wc.id),
    };
  }

  async function validateLoginField(wc, { origin, field, x, y }) {
    let actualOrigin = "";
    try { actualOrigin = new URL(wc.getURL()).origin; } catch {}
    if (!origin || origin !== actualOrigin) throw error("STALE_TARGET", "로그인 origin이 현재 페이지와 다릅니다.");
    const probe = await wc.executeJavaScript(`(() => { const e = document.elementFromPoint(${x}, ${y});
      if (!e) return null; const tag = String(e.tagName || "").toUpperCase();
      return { ok: tag === "INPUT" || tag === "TEXTAREA", tag, type: String(e.type || "").toLowerCase(),
        autocomplete: String(e.autocomplete || "").toLowerCase() }; })()`, true);
    const matches = probe?.ok && (field === "password"
      ? probe.type === "password" || probe.autocomplete.includes("password")
      : probe.type !== "password");
    if (!matches) throw error("STALE_TARGET", "지정한 좌표의 로그인 필드가 요청과 다릅니다.");
  }

  // QA 로그인 계정 목록 · 옛 cdp-qa-login.cjs accountsFor 와 같은 검사·id·비밀 기억 (worker 에는 공개 필드만 나감)
  const qaLoginId = (origin, username) => crypto.createHash("sha256").update(origin + "\n" + username).digest("hex").slice(0, 24);
  async function qaLoginAccounts(wc, approved) {
    const response = await deps.loginProvider(wc, { qaAccounts: true, qaApproved: approved });
    if (response?.error || !Array.isArray(response?.accounts)) throw new Error("로그인 계정 조회 실패");
    const origin = new URL(wc.getURL()).origin;
    if (response.origin !== origin) throw new Error("로그인 계정의 출처가 다릅니다");
    const accounts = response.accounts.map((account) => ({ ...account, id: qaLoginId(origin, account.username) }));
    for (const account of accounts) deps.rememberSecret(wc.id, account.password, { allowShort: true });
    return { origin, accounts, unavailable: (response.unavailable || []).map((account) => ({ ...account, id: qaLoginId(origin, account.username) })) };
  }
  const publicQaAccount = ({ id, username, allowed, local }) => ({ id, username, allowed: allowed === true, local: local === true });

  // QA 로그인 입력 · 옛 qa-login-input 의 계정 확인과 글자 넣기 · 포커스·칸·결제 화면 판정은 worker 가 이미 함
  // 계정 목록은 login.accounts 가 이 명령 단위에 남긴 것을 씀 (옛 처리기가 한 번만 읽던 것과 같음 · 단위가 닫히면 버림)
  // check: 입력 전 값 확인(길이만 반환) · cdp/chars: 옛 qa-input 의 Input.insertText / 탭 안 char 키 전송과 같음
  async function qaLoginInput(rec, request, wc, target, args) {
    const allowed = new Set(["qa", "accountId", "origin", "field", "approved"]);
    for (const key of Object.keys(args || {})) if (!allowed.has(key)) throw error("INVALID_REQUEST", "login.input에 허용되지 않은 필드가 있습니다.");
    if (!["check", "cdp", "chars"].includes(args.qa)) throw error("INVALID_REQUEST", "login.input qa 방식이 올바르지 않습니다.");
    if (!["username", "password"].includes(args.field)) throw new Error("로그인 필드가 올바르지 않습니다");
    const approved = args.approved === true;
    const scope = commandScope(rec, request.commandId);
    const cached = scope.qaLogin;
    const { origin, accounts } = cached && cached.wcId === wc.id && cached.approved === approved
      ? cached.value : await qaLoginAccounts(wc, approved);
    if (origin !== args.origin) throw new Error("로그인 승인 후 출처가 바뀌었습니다");
    const account = accounts.find((entry) => entry.id === args.accountId);
    if (!account || (account.allowed !== true && !approved)) throw new Error("허용된 로그인 계정이 아닙니다");
    const text = args.field === "password" ? account.password : account.username;
    if (typeof text !== "string" || !text) throw new Error("로그인 입력값이 없습니다");
    if (args.qa === "check") return { ok: true, length: text.length };
    delete scope.qaLogin;
    if (new URL(wc.getURL()).origin !== origin) throw new Error("로그인 입력 전 출처가 바뀌었습니다");
    if (args.qa === "cdp") await commandSender(wc, target)("Input.insertText", { text });
    else for (const ch of Array.from(text)) wc.sendInputEvent({ type: "char", keyCode: ch });
    return { ok: true, length: text.length };
  }

  async function loginInput(wc, target, args) {
    const allowed = new Set(["accountId", "origin", "field", "x", "y", "approved"]);
    for (const key of Object.keys(args || {})) if (!allowed.has(key)) throw error("INVALID_REQUEST", "login.input에 허용되지 않은 필드가 있습니다.");
    const accountId = String(args?.accountId || "");
    const origin = String(args?.origin || "");
    const field = String(args?.field || "");
    const x = Number(args?.x), y = Number(args?.y);
    if (!accountId || !["username", "password"].includes(field) || !Number.isFinite(x) || !Number.isFinite(y)) {
      throw error("INVALID_REQUEST", "accountId, origin, field, 좌표가 필요합니다.");
    }
    await validateLoginField(wc, { origin, field, x, y });
    let inventory = null;
    const approved = args?.approved === true;
    try { inventory = await deps.loginProvider(wc, { qaAccounts: true, qaApproved: approved }); }
    catch { throw error("LOGIN_UNAVAILABLE", "로그인 정보를 가져오지 못했습니다."); }
    const account = inventory?.accounts?.find((entry) => String(entry.id || entry.accountId || entry.username) === accountId
      && (entry.allowed === true || approved));
    if (!account) throw error("NOT_FOUND", "허용된 로그인 계정을 찾지 못했습니다.");
    const value = field === "password" ? account.password : (account.username ?? accountId);
    if (value == null) throw error("NOT_FOUND", "입력할 로그인 값이 없습니다.");
    const current = validator.validate("login.input", target);
    if (current !== wc) throw error("STALE_TARGET", "로그인 대상 webContents가 바뀌었습니다.");
    await validateLoginField(wc, { origin, field, x, y });
    const finalTarget = validator.validate("login.input", target);
    let finalOrigin = "";
    try { finalOrigin = new URL(wc.getURL()).origin; } catch {}
    if (finalTarget !== wc || finalOrigin !== origin) throw error("STALE_TARGET", "입력 직전에 로그인 대상이 바뀌었습니다.");
    if (field === "password") deps.rememberSecret(wc.id, String(value), { allowShort: true });
    wc.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
    wc.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
    await wc.insertText(String(value));
    return { ok: true, accountId, origin, field };
  }

  function commandScope(rec, commandId) {
    let scope = rec.commandScopes.get(commandId);
    if (!scope) { scope = { tickets: new Set(), holds: new Map(), focus: new Set(), subscriptions: new Set() }; rec.commandScopes.set(commandId, scope); }
    return scope;
  }

  // worker 가 임시 layout 으로 표시한 cdp.send(args.temporaryLayout) 만 추적 · 크기와 무관 (worker 배포만으로 크기를 바꿀 수 있음)
  function noteLayout(rec, request, args) {
    if (args?.temporaryLayout !== true || args?.sessionId != null || request.target?.childSessionId != null) return;
    if (args.method === "Emulation.setDeviceMetricsOverride") {
      const scope = commandScope(rec, request.commandId);
      scope.layout = true;
      scope.layoutWc = request.target?.wcId;
    } else if (args.method === "Emulation.clearDeviceMetricsOverride") {
      const scope = rec.commandScopes.get(request.commandId);
      if (scope) scope.layout = false;
    }
  }

  // 덮어쓰기를 건 명령이 못 되돌렸으면 되돌림 · 사람이 정한 viewport 가 있으면 그 값으로 다시 건다
  async function releaseLayout(wc) {
    const previous = deps.viewport.current(wc.id) || deps.viewport.explicit(wc.id);
    if (previous) {
      await wc.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
        width: previous.width, height: previous.height, deviceScaleFactor: Number(previous.dpr) || 0, mobile: false });
    } else {
      await wc.debugger.sendCommand("Emulation.clearDeviceMetricsOverride");
    }
  }

  function noteHoldReleased(rec, commandId, wcId) {
    const scope = rec.commandScopes.get(commandId);
    const count = scope?.holds.get(wcId) || 0;
    if (count > 1) scope.holds.set(wcId, count - 1); else scope?.holds.delete(wcId);
  }

  // 명령 단위가 닫힐 때 그 명령이 얻고 돌려주지 못한 AI 표식·capture hold 를 반환
  // 확인 창이 막은 명령은 반환 호출이 닫힌 문 뒤라 못 나감 · 옛 처리기는 명령이 끝날 때 finally 로 반환했음
  async function releaseCommand(workerGeneration, commandId) {
    const rec = owner;
    if (!rec || rec.generation !== workerGeneration || rec.state !== "accepting") return;
    const scope = rec.commandScopes.get(commandId);
    if (!scope) return;
    rec.commandScopes.delete(commandId);
    // 빌린 사용자 포커스는 가장 먼저 반환 (QA 입력이 확인 창에 막힌 채 닫힐 때)
    for (const wcId of scope.focus) {
      const wc = deps.webContents.fromId(wcId);
      if (wc && !wc.isDestroyed?.()) { try { await deps.focus.return(wc); } catch {} }
      rec.focus.delete(wcId);
    }
    for (const id of scope.subscriptions) {
      const sub = rec.subscriptions.get(id);
      if (!sub) continue;
      try { sub.unsubscribe(); } catch {}
      rec.subscriptions.delete(id);
    }
    for (const ticket of scope.tickets) {
      if (!rec.ai.has(ticket)) continue;
      try { deps.ai.leave(rec.ai.get(ticket)); } catch {}
      rec.ai.delete(ticket);
    }
    for (const [wcId, count] of scope.holds) {
      const wc = deps.webContents.fromId(wcId);
      if (!wc || wc.isDestroyed?.()) continue;
      for (let index = 0; index < count; index++) {
        try { await runCommand(rec, { command: "hold.capture", commandId, target: { wcId }, args: { on: false } }, wc); } catch {}
      }
    }
    if (scope.layout && scope.layoutWc != null) {
      const wc = deps.webContents.fromId(scope.layoutWc);
      if (wc && !wc.isDestroyed?.()) { try { await serializeResource("viewport", wc.id, () => releaseLayout(wc)); } catch {} }
    }
    rec.commandScopes.delete(commandId);
  }

  async function runCommand(rec, request, wc) {
    const { command, target, args = {} } = request;
    const send = wc ? commandSender(wc, target) : null;
    switch (command) {
      case "cdp.send": {
        const result = await sendCdp(rec, wc, target, args);
        noteLayout(rec, request, args);
        return result;
      }
      // 접근성 트리를 엔진이 읽는 필드만 남겨 돌려줌 · cdp.send 와 같은 세션 규칙(args.sessionId 는 현재 탭의 자식 세션만)
      case "ax.tree": {
        const result = await sendCdp(rec, wc, target, { method: "Accessibility.getFullAXTree", sessionId: args.sessionId });
        return { nodes: pruneAxNodes(result?.nodes) };
      }
      // worker 처리기가 만든 최종 응답을 옛 경로처럼 메인의 비밀 가리기에 한 번 거치게 함 (execute 가 모든 결과를 가림)
      case "result.redact": return { value: args.value ?? null };
      case "cdp.batch": {
        if (!Array.isArray(args.commands) || args.commands.length > 100) throw error("INVALID_REQUEST", "CDP batch는 100개 이하 배열이어야 합니다.");
        const results = [];
        for (const item of args.commands) results.push(await sendCdp(rec, wc, target, item));
        return { results };
      }
      // 처리기가 CDP 를 쓰기 전 붙임 보장 · 옛 cdpExecRaw 의 attachPolicy.touch + ensureAttached 와 같음. 붙이며 바뀐 세대를 돌려줌
      case "cdp.attach": return deps.attach(wc, String(args.command || ""));
      // snapshot ref 기록 · 다른 옛 명령(click 등)이 메인 ref registry 를 읽음
      case "ref.record": {
        const refs = args.refs;
        if (!Array.isArray(refs) || refs.length > 20000) throw error("INVALID_REQUEST", "ref 목록은 2만 개 이하 배열이어야 합니다.");
        const map = new Map();
        for (const item of refs) {
          const [ref, entry] = Array.isArray(item) ? item : [];
          if (typeof ref !== "string" || !/^@[A-Za-z0-9]{1,16}$/.test(ref) || !entry || typeof entry !== "object"
            || !Number.isFinite(entry.backendDOMNodeId) || typeof entry.role !== "string" || typeof entry.name !== "string"
            || !(entry.sid == null || typeof entry.sid === "string") || !(entry.nth == null || Number.isFinite(entry.nth))) {
            throw error("INVALID_REQUEST", "ref 항목 형식이 올바르지 않습니다.");
          }
          map.set(ref, { backendDOMNodeId: entry.backendDOMNodeId, role: entry.role, name: entry.name,
            sid: entry.sid ?? null, nth: entry.nth ?? undefined });
        }
        deps.refs.record(wc.id, map);
        return { recorded: map.size };
      }
      // 처리기가 ref 를 풀 때 읽음 · 옛 resolveRef 와 같은 오류 문구·code (no_snapshot·stale_ref·not_found)
      case "ref.resolve": {
        const entry = deps.refs.resolve(wc.id, args.ref);
        return { backendDOMNodeId: entry.backendDOMNodeId, sid: entry.sid ?? null };
      }
      // 옛 selector 클릭 앞 단계 · 붙어 있으면 CDP 를 먼저 뗌 (Cloudflare 등 CDP 를 붙이면 봇으로 판정하는 페이지)
      case "cdp.detachIdle": {
        let attached = false;
        try { attached = !!wc.debugger.isAttached(); } catch {}
        if (attached) { try { deps.detachIdle(wc); } catch {} }
        // detach 이벤트가 비동기여도 세대가 오른 뒤의 값을 돌려줌 · worker 가 이후 호출의 token 을 바꿈
        await new Promise((resolve) => setImmediate(resolve));
        return { wasAttached: attached, ...deps.targetState.generations(wc.id) };
      }
      // 페이지·캡처 처리기 앞 단계 · 옛 cdpExecRaw 의 로그인 호스트 판정(noCdp)과 붙임을 한 번에 함
      case "cdp.gate": return deps.gate(wc, String(args.command || ""), args);
      // 처리기 도중 문서·debugger 세대가 바뀐 뒤(탐색 등) 현재 세대를 읽음 · 세대 비교만 생략
      case "cdp.sync": return deps.targetState.generations(wc.id);
      // 옛 moveHistory · 기록이 없으면 moved:false (ok 키가 있으면 응답 봉투로 오해되므로 쓰지 않음)
      case "wc.navHistory": {
        const back = String(args.dir) === "back";
        if (!back && String(args.dir) !== "forward") throw error("INVALID_REQUEST", "dir 은 back 또는 forward 여야 합니다.");
        const nh = wc.navigationHistory;
        const can = back ? (nh?.canGoBack?.() ?? wc.canGoBack?.()) : (nh?.canGoForward?.() ?? wc.canGoForward?.());
        if (!can) return { moved: false, ...deps.targetState.generations(wc.id) };
        const settled = navigationSettled(wc);
        if (back) { nh?.goBack ? nh.goBack() : wc.goBack(); } else { nh?.goForward ? nh.goForward() : wc.goForward(); }
        await settled;
        return { moved: true, url: wc.getURL(), ...deps.targetState.generations(wc.id) };
      }
      // 보이지 않는 탭의 마지막 촬영 수단 · 메인의 debugger 이벤트를 써서 메인에 남김
      case "cdp.screencastShot": {
        const ms = Math.min(15000, Math.max(100, Number(args.ms) || 4000));
        return { data: (await deps.screencastShot(wc, ms)).toString("base64") };
      }
      case "img.stitch": {
        const { tiles, W, H } = args;
        const px = args.px == null ? 1 : Number(args.px);
        if (!Array.isArray(tiles) || tiles.length < 1 || tiles.length > 41 || !tiles.every((t) => t && typeof t.d === "string" && Number.isFinite(t.y))
          || !Number.isSafeInteger(W) || !Number.isSafeInteger(H) || W < 1 || H < 1 || !(px > 0)) {
          throw error("INVALID_REQUEST", "이어 붙일 장 목록과 크기가 올바르지 않습니다.");
        }
        return { data: (await deps.stitch(tiles, W, H, px)).toString("base64") };
      }
      case "img.diff": {
        for (const key of ["before", "after", "out"]) if (typeof args[key] !== "string" || !path.isAbsolute(args[key])) throw error("INVALID_REQUEST", "img.diff 경로는 절대경로여야 합니다.");
        return deps.diff(args.before, args.after, args.out, Number(args.threshold) || 24);
      }
      case "img.same": {
        if (typeof args.prev !== "string" || !path.isAbsolute(args.prev) || typeof args.data !== "string") throw error("INVALID_REQUEST", "img.same 은 절대경로 prev 와 이미지 data 가 필요합니다.");
        return { same: !!deps.same(args.prev, Buffer.from(args.data, "base64")) };
      }
      case "cdp.frames": return { frames: deps.targetState.frames(wc.id), ...deps.targetState.generations(wc.id) };
      case "cdp.reset": return deps.targetState.reset(wc);
      case "cdp.subscribe": {
        const id = String(args.subscriptionId || "");
        if (!/^[A-Za-z0-9._:-]{1,100}$/.test(id) || rec.subscriptions.has(id)) throw error("INVALID_REQUEST", "subscriptionId가 없거나 이미 사용 중입니다.");
        const sub = { id, wcId: wc.id, methods: new Set(Array.isArray(args.methods) ? args.methods.map(String) : []),
          eventSeq: 0, pendingCount: 0, pendingBytes: 0, scoped: args.scoped === true };
        sub.unsubscribe = deps.observation.subscribeEvents((...event) => subscriptionEvent(rec, sub, ...event));
        rec.subscriptions.set(id, sub);
        // scoped: 이 명령 단위가 닫힐 때 구독을 거둠 (QA 입력 수신 기록처럼 명령 하나보다 오래 살 필요가 없는 구독)
        if (args.scoped === true) commandScope(rec, request.commandId).subscriptions.add(id);
        return { subscribed: true, subscriptionId: id };
      }
      case "cdp.unsubscribe": {
        const id = String(args.subscriptionId || "");
        const sub = rec.subscriptions.get(id);
        if (!sub || sub.wcId !== wc.id) throw error("NOT_FOUND", "구독을 찾지 못했습니다.");
        sub.unsubscribe(); rec.subscriptions.delete(id);
        for (const scope of rec.commandScopes.values()) scope.subscriptions.delete(id);
        return { unsubscribed: true, subscriptionId: id };
      }
      case "wc.info": case "tab.state": return info(wc);
      case "wc.nav": {
        const action = String(args.action || "");
        if (action === "load") { await wc.loadURL(String(args.url || "")); return info(wc); }
        if (["back", "forward", "reload"].includes(action)) {
          const settled = navigationSettled(wc);
          if (action === "back") wc.goBack();
          else if (action === "forward") wc.goForward();
          else wc.reload();
          await settled;
        }
        else if (action === "stop") wc.stop();
        else throw error("INVALID_REQUEST", "지원하지 않는 탐색 동작입니다.");
        return info(wc);
      }
      case "wc.exec": return wc.executeJavaScript(String(args.source || ""), args.userGesture === true);
      case "wc.input": {
        if (args.text != null) await wc.insertText(String(args.text));
        else if (args.event && typeof args.event === "object") wc.sendInputEvent(args.event);
        else throw error("INVALID_REQUEST", "text 또는 input event가 필요합니다.");
        return { ok: true };
      }
      case "wc.capture": case "wc.captureToFile": {
        const image = await wc.capturePage(args.rect || undefined);
        const bytes = image.toPNG();
        if (command === "wc.capture") return { data: bytes.toString("base64"), format: "png" };
        const file = String(args.path || "");
        if (!path.isAbsolute(file)) throw error("INVALID_REQUEST", "캡처 파일은 절대경로여야 합니다.");
        fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
        return { path: file, bytes: bytes.length };
      }
      case "wc.pdf": case "wc.pdfToFile": {
        const bytes = await wc.printToPDF(args.options || {});
        if (command === "wc.pdf") return { data: bytes.toString("base64"), format: "pdf" };
        const file = String(args.path || "");
        if (!path.isAbsolute(file)) throw error("INVALID_REQUEST", "PDF 파일은 절대경로여야 합니다.");
        fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
        return { path: file, bytes: bytes.length };
      }
      case "hold.capture": {
        return serializeResource("capture-hold", wc.id, async () => {
          if (rec.state !== "accepting") throw error("STALE_WORKER", "이미 종료된 작업 프로세스 세대입니다.");
          const on = args.on !== false;
          const entry = rec.holds.get(wc.id);
          if (!on && !entry) return { held: false };
          if (on) {
            const current = captureOwners.get(wc.id);
            if (!entry && current && current.generation !== rec.generation && !current.releasing
              && currentResource("capture-hold", wc.id, current.token)) {
              const token = resourceToken(rec, "capture-hold", wc.id);
              const adopted = { count: current.count, token };
              rec.holds.set(wc.id, adopted);
              captureOwners.set(wc.id, { generation: rec.generation, count: adopted.count, token, releasing: false });
              return { held: true };
            }
            const held = await deps.captureHold(wc.id, true);
            if (held) {
              const token = resourceToken(rec, "capture-hold", wc.id);
              const owned = { count: (entry?.count || 0) + 1, token };
              rec.holds.set(wc.id, owned);
              captureOwners.set(wc.id, { generation: rec.generation, count: owned.count, token, releasing: false });
              commandScope(rec, request.commandId).holds.set(wc.id, (commandScope(rec, request.commandId).holds.get(wc.id) || 0) + 1);
            }
            return { held: !!held };
          }
          const held = await deps.captureHold(wc.id, false);
          noteHoldReleased(rec, request.commandId, wc.id);
          const remaining = Math.max(0, entry.count - 1);
          const token = resourceToken(rec, "capture-hold", wc.id);
          if (remaining > 0) {
            const owned = { count: remaining, token };
            rec.holds.set(wc.id, owned);
            captureOwners.set(wc.id, { generation: rec.generation, count: remaining, token, releasing: false });
          } else {
            rec.holds.delete(wc.id);
            captureOwners.delete(wc.id);
          }
          return { held: false };
        });
      }
      case "focus.state": return deps.focus.state(wc);
      case "focus.prepare": {
        const state = await deps.focus.prepare(wc);
        if (state === "borrowed" || state === "claimed") {
          rec.focus.add(wc.id);
          commandScope(rec, request.commandId).focus.add(wc.id);
        }
        return { state };
      }
      case "focus.return": {
        const state = await deps.focus.return(wc); rec.focus.delete(wc.id);
        rec.commandScopes.get(request.commandId)?.focus.delete(wc.id);
        return { state };
      }
      case "ai.enter": {
        const actual = deps.ai.enter(wc.id);
        const ticket = `${rec.generation}/${rec.nextTicket++}`;
        rec.ai.set(ticket, actual);
        commandScope(rec, request.commandId).tickets.add(ticket);
        return { ticket };
      }
      case "ai.leave": {
        const ticket = String(args.ticket || "");
        if (!rec.ai.has(ticket)) throw error("NOT_FOUND", "AI ticket을 찾지 못했습니다.");
        deps.ai.leave(rec.ai.get(ticket)); rec.ai.delete(ticket);
        rec.commandScopes.get(request.commandId)?.tickets.delete(ticket);
        return { left: true };
      }
      case "viewport.get": return { temporary: rec.viewports.has(wc.id) ? rec.viewports.get(wc.id).value : null,
        explicit: deps.viewport.explicit(wc.id) || null, current: deps.viewport.current(wc.id) || null };
      case "viewport.apply": return serializeResource("viewport", wc.id, async () => {
        const result = await deps.viewport.apply(wc, args);
        resourceToken(rec, "temporary-viewport", wc.id);
        resourceToken(rec, "qa-viewport", wc.id);
        resourceToken(rec, "hidden-viewport", wc.id);
        return result;
      });
      case "viewport.setTemporary": {
        const width = Math.round(Number(args.width)), height = Math.round(Number(args.height)), dpr = Number(args.dpr) || 0;
        if (!(width > 0 && height > 0)) throw error("INVALID_REQUEST", "임시 viewport의 가로·세로가 필요합니다.");
        return serializeResource("viewport", wc.id, async () => {
          inheritViewportResources(rec, wc.id);
          const owned = rec.viewports.get(wc.id);
          const previous = owned && Object.hasOwn(owned, "previous")
            ? owned.previous : (deps.viewport.current(wc.id) || deps.viewport.explicit(wc.id));
          const previousManaged = owned?.previousManaged === true || rec.qaViewports.has(wc.id);
          await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile: false });
          const token = resourceToken(rec, "temporary-viewport", wc.id);
          claimOlderResource(rec, "qa-viewport", wc.id);
          claimOlderResource(rec, "hidden-viewport", wc.id);
          rec.viewports.set(wc.id, { value: { width, height, dpr }, previous: previous ? { ...previous } : previous,
            previousManaged, token });
          return { width, height, dpr };
        });
      }
      case "viewport.restore": return restoreViewport(rec, wc.id);
      case "viewport.ensureReady": {
        return serializeResource("viewport", wc.id, async () => {
          inheritViewportResources(rec, wc.id);
          const result = await deps.hiddenViewport.ensureReady(wc, String(args.command || ""), send);
          const token = resourceToken(rec, "hidden-viewport", wc.id);
          claimOlderResource(rec, "temporary-viewport", wc.id);
          claimOlderResource(rec, "qa-viewport", wc.id);
          rec.hiddenViewports.set(wc.id, token);
          return result;
        });
      }
      case "viewport.qa": {
        return serializeResource("viewport", wc.id, async () => {
          inheritViewportResources(rec, wc.id);
          const owned = rec.qaViewports.get(wc.id);
          const previous = owned ? owned.previous : deps.viewport.current(wc.id);
          const result = await deps.qaViewport(wc, args, send);
          const token = resourceToken(rec, "qa-viewport", wc.id);
          claimOlderResource(rec, "temporary-viewport", wc.id);
          claimOlderResource(rec, "hidden-viewport", wc.id);
          if (args.clear) rec.qaViewports.delete(wc.id);
          else rec.qaViewports.set(wc.id, {
            previous: previous ? { ...previous } : null,
            value: { width: result.width, height: result.height, dpr: result.dpr ?? 1 },
            revision: deps.viewport.revision?.(wc.id),
            token,
          });
          return result;
        });
      }
      case "obs.read": return deps.observation.observe(wc.id, args.level || "all", Math.min(150, Math.max(1, Number(args.limit) || 150)));
      case "obs.drain": {
        const result = deps.observation.observe(wc.id, args.level || "all", Math.min(150, Math.max(1, Number(args.limit) || 150)));
        const moments = deps.observation.drainMoments(wc.id); if (moments) { result.moments = moments.list; moments.commit(); }
        deps.observation.clearDiagnostics(wc.id); return result;
      }
      case "obs.clear": deps.observation.clearDiagnostics(wc.id); return { cleared: true };
      // QA 안정 확인의 대기 중 요청 수 · 옛 observation.pendingRequests 와 같은 값
      case "obs.pending": return { pending: deps.observation.pendingRequests(wc.id) };
      // QA 반응 관찰 종료의 since 이후 진단 · 옛 observation.diagSince 와 같은 값
      // diag 에 감싸 보냄: 응답 최상위의 moments 배열은 단위가 비운 관찰 순간으로 읽혀 처리기 응답을 덮어씀
      case "obs.since": return { diag: deps.observation.diagSince(wc.id, args.since) };
      case "dialog.state": {
        const value = deps.observation.dialogOpen(wc.id);
        return { dialog: value ? { kind: value.type, message: value.message } : null };
      }
      case "dialog.answer": {
        const value = deps.observation.dialogOpen(wc.id);
        if (!value) return { none: true };
        const accept = String(args.answer || "cancel") !== "cancel";
        await send("Page.handleJavaScriptDialog", { accept, ...(value.type === "prompt" && args.text != null ? { promptText: String(args.text) } : {}) });
        deps.observation.closeDialog(wc.id); return { answered: accept ? "ok" : "cancel", kind: value.type, message: value.message };
      }
      case "dialog.plan": {
        const plan = args.plan == null ? null : args.plan;
        const validMode = plan && (plan.mode === "ok" || plan.mode === "cancel") && Object.keys(plan).length === 1;
        const validQueue = plan && Array.isArray(plan.queue) && plan.queue.length > 0 && plan.queue.length <= 100
          && plan.queue.every((value) => value === "ok" || value === "cancel") && Object.keys(plan).length === 1;
        if (plan !== null && !validMode && !validQueue) throw error("INVALID_REQUEST", "dialog plan은 mode, queue 또는 null이어야 합니다.");
        const text = args.text == null ? null : String(args.text);
        return serializeResource("dialog-plan", wc.id, async () => {
          deps.dialogPlan.set(wc.id, plan, text);
          const token = resourceToken(rec, "dialog-plan", wc.id);
          if (plan) rec.dialogs.set(wc.id, token); else rec.dialogs.delete(wc.id);
          return { plan, text };
        });
      }
      case "upload.arm": {
        const files = Array.isArray(args.paths) ? args.paths.map(String) : [];
        if (!files.length || deps.upload.invalidPaths(files).length) throw error("INVALID_REQUEST", "업로드 파일은 존재하는 절대경로여야 합니다.");
        return serializeResource("upload", wc.id, async () => {
          deps.upload.arm(wc.id, files, Math.min(120000, Math.max(1000, Number(args.timeoutMs) || 60000)));
          rec.uploads.set(wc.id, resourceToken(rec, "upload", wc.id));
          return { armed: true, files };
        });
      }
      case "download.state": return deps.downloadState.snapshot();
      case "download.configure": {
        const raw = String(args.dir == null ? "" : args.dir).trim();
        if (!raw || raw === "off") return serializeResource("download", null, async () => {
          deps.downloadState.disarm();
          resourceToken(rec, "download", null);
          rec.downloadArmed = false;
          return { mode: "off", last: deps.downloadState.snapshot().last };
        });
        const dir = raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw;
        if (!path.isAbsolute(dir)) throw error("INVALID_REQUEST", "다운로드 폴더는 절대경로여야 합니다.");
        // 옛 download 처리기가 값으로 돌려주던 폴더 생성 실패 · worker 가 이 code 로 같은 응답을 만듦
        try { fs.mkdirSync(dir, { recursive: true }); }
        catch (cause) { throw error("INVALID_REQUEST", "폴더를 만들 수 없습니다: " + cause.message); }
        return serializeResource("download", null, async () => {
          deps.downloadState.arm(dir, args.once === true);
          const state = deps.downloadState.snapshot();
          rec.downloadArmed = { token: resourceToken(rec, "download", null), dir, once: !!state.once };
          return { mode: "armed", dir, once: !!state.once, last: state.last };
        });
      }
      case "login.accounts": {
        if (args.qa === true) {
          const value = await qaLoginAccounts(wc, args.approved === true);
          commandScope(rec, request.commandId).qaLogin = { wcId: wc.id, approved: args.approved === true, value };
          return { origin: value.origin, accounts: value.accounts.map(publicQaAccount), unavailable: value.unavailable.map(publicQaAccount) };
        }
        const inventory = await deps.loginProvider(wc, { qaAccounts: true, qaApproved: args.approved === true });
        const publicAccount = (entry) => ({ id: String(entry.id || entry.accountId || entry.username || ""),
          username: String(entry.username || ""), allowed: entry.allowed === true, local: entry.local === true });
        return { origin: String(inventory?.origin || ""), accounts: (inventory?.accounts || []).map(publicAccount),
          unavailable: (inventory?.unavailable || []).map(publicAccount) };
      }
      case "login.fill": {
        const result = await deps.loginProvider(wc, { username: args.username == null ? null : String(args.username) });
        if (result?.secret) { deps.rememberSecret(wc.id, String(result.secret), { allowShort: true }); delete result.secret; }
        // 저장된 로그인이 없어 사람이 해야 하는 자리 · 사람이 로그인하는 동안 CDP 를 붙여 두지 않음 (옛 noteLoginResult)
        if (result?.needUser) deps.releaseAttach?.(wc.id);
        return result;
      }
      case "login.input": return args && args.qa != null ? qaLoginInput(rec, request, wc, target, args) : loginInput(wc, target, args);
      case "native.click": {
        const event = { type: "mouseDown", x: Number(args.x), y: Number(args.y), button: args.button || "left", clickCount: Number(args.clickCount) || 1 };
        if (![event.x, event.y].every(Number.isFinite)) throw error("INVALID_REQUEST", "클릭 좌표가 필요합니다.");
        wc.sendInputEvent(event); wc.sendInputEvent({ ...event, type: "mouseUp" }); return { ok: true };
      }
      case "native.key": wc.sendInputEvent({ type: args.type || "keyDown", keyCode: String(args.key || ""), modifiers: args.modifiers || [] }); return { ok: true };
      case "native.drag": {
        const from = args.from || {}, to = args.to || {};
        if (![from.x, from.y, to.x, to.y].every(Number.isFinite)) throw error("INVALID_REQUEST", "드래그 시작과 끝 좌표가 필요합니다.");
        wc.sendInputEvent({ type: "mouseDown", x: from.x, y: from.y, button: "left", clickCount: 1 });
        wc.sendInputEvent({ type: "mouseMove", x: to.x, y: to.y, button: "left" });
        wc.sendInputEvent({ type: "mouseUp", x: to.x, y: to.y, button: "left", clickCount: 1 }); return { ok: true };
      }
      case "native.window": return deps.nativeAx.describe();
      case "native.windowClick": {
        const button = String(args.button || "").trim();
        if (!button) throw error("INVALID_REQUEST", "누를 네이티브 창 버튼 이름이 필요합니다.");
        return deps.nativeAx.click(button);
      }
      case "native.windowKey": return deps.nativeAx.key(args.key);
      case "qa.mode": {
        const enabled = args.enabled === true;
        return serializeResource("qa-mode", wc.id, async () => {
          const result = await deps.qaMode(wc, enabled, send);
          const token = resourceToken(rec, "qa-mode", wc.id);
          if (enabled) rec.qaModes.set(wc.id, token); else rec.qaModes.delete(wc.id);
          return result;
        });
      }
      case "qa.anchor": {
        if (!args.run || args.run !== args.runId) throw error("RUN_DENIED", "QA run 경계가 맞지 않습니다.");
        const out = await deps.qaAnchor(args); if (!out?.ok) throw error("RUN_DENIED", out?.error || "QA anchor 갱신 실패"); return out.data;
      }
      case "img.render": {
        const input = Buffer.from(String(args.data || ""), "base64");
        const output = await deps.renderImage(input, args.options || {}); return { data: output.toString("base64") };
      }
      case "contextaction": return deps.contextAction(wc, args);
      default: throw error("INVALID_REQUEST", "지원하지 않는 Electron 중계 명령입니다.");
    }
  }

  async function execute(request = {}) {
    const rec = requireOwner(request.workerGeneration, request.commandId);
    const validCallId = (typeof request.callId === "string" && request.callId.length > 0 && request.callId.length <= 100)
      || (Number.isSafeInteger(request.callId) && request.callId >= 0);
    if (!validCallId) {
      throw error("INVALID_REQUEST", "중계 하위 호출 번호가 필요합니다.");
    }
    if (!BASE_COMMANDS.has(request.command)) throw error("INVALID_REQUEST", "기본 중계 명령이 아닙니다.");
    let wc = null;
    try { wc = validator.validate(request.command, request.target); }
    catch (cause) { throw safeError(request.target?.wcId, cause); }
    const active = { wcId: wc?.id || null, promise: null };
    rec.active.add(active);
    const actual = Promise.resolve().then(() => runCommand(rec, request, wc));
    active.promise = actual;
    try {
      const result = await actual;
      if (rec.state === "retired") throw error("STALE_WORKER", "이미 종료된 작업 프로세스 세대입니다.");
      return safeValue(wc?.id, result);
    }
    catch (cause) { throw safeError(wc?.id, cause); }
    finally {
      rec.active.delete(active);
      if (rec.state === "retired") scheduleCleanup(rec);
    }
  }

  async function boundedRelease(invoke) {
    let timer = null;
    try {
      return await Promise.race([
        Promise.resolve().then(invoke),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(error("TIMEOUT", "이전 세대 자원 반환 시간이 상한을 넘었습니다.")), resourceReleaseTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function cleanup(rec) {
    const failures = [];
    const release = async (label, invoke, released) => {
      try {
        await boundedRelease(invoke);
        released();
      } catch {
        failures.push(label);
      }
    };
    for (const [id, sub] of rec.subscriptions) {
      await release(`subscription:${id}`, () => sub.unsubscribe(), () => rec.subscriptions.delete(id));
    }
    for (const [ticket, actual] of rec.ai) {
      await release(`ai:${ticket}`, () => deps.ai.leave(actual, { grace: false }), () => rec.ai.delete(ticket));
    }
    for (const [commandId, scope] of rec.commandScopes) {
      if (!scope.layout) continue;
      const wc = deps.webContents.fromId(scope.layoutWc);
      if (!wc || wc.isDestroyed?.()) { scope.layout = false; continue; }
      await release(`layout:${commandId}`, () => serializeResource("viewport", wc.id, () => releaseLayout(wc)), () => { scope.layout = false; });
    }
    for (const [wcId] of rec.holds) {
      await serializeResource("capture-hold", wcId, async () => {
        const entry = rec.holds.get(wcId);
        if (!entry) return;
        if (!currentResource("capture-hold", wcId, entry.token)) {
          rec.holds.delete(wcId);
          return;
        }
        let remaining = entry.count;
        const current = captureOwners.get(wcId);
        if (current && currentResource("capture-hold", wcId, current.token)) current.releasing = true;
        for (let index = 0; index < entry.count; index++) {
          await release(`capture-hold:${wcId}`, () => deps.captureHold(wcId, false), () => { remaining--; });
        }
        if (remaining > 0) {
          rec.holds.set(wcId, { ...entry, count: remaining });
          const owned = captureOwners.get(wcId);
          if (owned && currentResource("capture-hold", wcId, owned.token)) owned.count = remaining;
        } else {
          rec.holds.delete(wcId);
          const owned = captureOwners.get(wcId);
          if (owned && currentResource("capture-hold", wcId, owned.token)) captureOwners.delete(wcId);
        }
      });
    }
    for (const wcId of rec.focus) {
      const wc = deps.webContents.fromId(wcId);
      if (!wc || wc.isDestroyed?.()) { rec.focus.delete(wcId); continue; }
      await release(`focus:${wcId}`, () => deps.focus.return(wc), () => rec.focus.delete(wcId));
    }
    for (const wcId of [...rec.viewports.keys()]) {
      await serializeResource("viewport", wcId, async () => {
        const entry = rec.viewports.get(wcId);
        if (!entry || !currentResource("temporary-viewport", wcId, entry.token)) {
          rec.viewports.delete(wcId);
          return;
        }
        await release(`viewport:${wcId}`, () => restoreViewportLocked(rec, wcId), () => {});
      });
    }
    const currentResourceTarget = (entry) => {
      const wc = deps.webContents.fromId(Number(entry.wcId));
      if (!wc || wc.isDestroyed?.() || wc.debugger.isAttached?.() === false) return null;
      const actual = deps.targetState.generations(entry.wcId) || {};
      if (actual.debuggerGeneration !== entry.debuggerGeneration) return null;
      if (entry.sessionId && !deps.targetState.ownsChildSession(entry.wcId, entry.sessionId)) return null;
      return wc;
    };
    const cleanupCdp = async (map, method, paramName) => {
      for (const [key, entry] of map) {
        const wc = currentResourceTarget(entry);
        if (!wc) { map.delete(key); continue; }
        for (const value of [...entry.values]) {
          await release(`${method}:${entry.wcId}`,
            () => wc.debugger.sendCommand(method, { [paramName]: value }, entry.sessionId || undefined),
            () => entry.values.delete(value));
        }
        if (!entry.values.size) map.delete(key);
      }
    };
    const cleanupOwnedCdp = async (map, kind, method, paramName) => {
      for (const [key, entry] of map) {
        const wc = currentResourceTarget(entry);
        if (!wc) { map.delete(key); continue; }
        for (const value of [...entry.values]) {
          const id = `${key}\n${value}`;
          await serializeResource(kind, id, async () => {
            const token = entry.tokens.get(value);
            if (!currentResource(kind, id, token)) {
              entry.values.delete(value);
              entry.tokens.delete(value);
              return;
            }
            await release(`${method}:${entry.wcId}`,
              () => wc.debugger.sendCommand(method, { [paramName]: value }, entry.sessionId || undefined),
              () => { entry.values.delete(value); entry.tokens.delete(value); });
          });
        }
        if (!entry.values.size) map.delete(key);
      }
    };
    await cleanupOwnedCdp(rec.bindings, "cdp-binding", "Runtime.removeBinding", "name");
    await cleanupCdp(rec.scripts, "Page.removeScriptToEvaluateOnNewDocument", "identifier");
    for (const [key, stream] of rec.screencasts) {
      const wc = currentResourceTarget(stream);
      if (!wc) { rec.screencasts.delete(key); continue; }
      await serializeResource("cdp-screencast", key, async () => {
        if (!currentResource("cdp-screencast", key, stream.token)) { rec.screencasts.delete(key); return; }
        await release(`screencast:${stream.wcId}`,
          () => wc.debugger.sendCommand("Page.stopScreencast", {}, stream.sessionId),
          () => rec.screencasts.delete(key));
      });
    }
    for (const [wcId, token] of rec.dialogs) {
      await serializeResource("dialog-plan", wcId, async () => {
        if (!currentResource("dialog-plan", wcId, token)) { rec.dialogs.delete(wcId); return; }
        await release(`dialog:${wcId}`, () => deps.clearDialogPlan?.(wcId), () => rec.dialogs.delete(wcId));
      });
    }
    for (const [wcId, token] of rec.uploads) {
      await serializeResource("upload", wcId, async () => {
        if (!currentResource("upload", wcId, token)) { rec.uploads.delete(wcId); return; }
        await release(`upload:${wcId}`, () => deps.upload.forget(wcId), () => rec.uploads.delete(wcId));
      });
    }
    for (const [wcId, token] of rec.qaModes) {
      await serializeResource("qa-mode", wcId, async () => {
        if (!currentResource("qa-mode", wcId, token)) { rec.qaModes.delete(wcId); return; }
        const wc = deps.webContents.fromId(wcId);
        if (!wc || wc.isDestroyed?.()) { rec.qaModes.delete(wcId); return; }
        await release(`qa-mode:${wcId}`, () => deps.qaMode(wc, false), () => rec.qaModes.delete(wcId));
      });
    }
    for (const [wcId, owned] of rec.qaViewports) {
      await serializeResource("viewport", wcId, async () => {
        if (newerGenerationOwnsResource("qa-viewport", wcId, owned.token)) { rec.qaViewports.delete(wcId); return; }
        const wc = deps.webContents.fromId(wcId);
        if (!wc || wc.isDestroyed?.()) { rec.qaViewports.delete(wcId); return; }
        await release(`qa-viewport:${wcId}`, async () => {
          const current = deps.viewport.current(wcId);
          const unchanged = owned.revision == null
            ? sameViewport(current, owned.value)
            : owned.revision === deps.viewport.revision?.(wcId);
          if (unchanged && sameViewport(current, owned.value)) {
            if (owned.previous) await deps.viewport.apply(wc, owned.previous);
            else await deps.qaViewport(wc, { clear: true });
          } else {
            await deps.qaViewportRelease?.(wc);
          }
        }, () => rec.qaViewports.delete(wcId));
      });
    }
    for (const [wcId, token] of rec.hiddenViewports) {
      await serializeResource("viewport", wcId, async () => {
        if (newerGenerationOwnsResource("hidden-viewport", wcId, token)) { rec.hiddenViewports.delete(wcId); return; }
        const wc = deps.webContents.fromId(wcId);
        if (!wc || wc.isDestroyed?.()) { rec.hiddenViewports.delete(wcId); return; }
        await release(`hidden-viewport:${wcId}`, () => deps.hiddenViewport.release(wc), () => rec.hiddenViewports.delete(wcId));
      });
    }
    if (rec.downloadArmed) {
      await serializeResource("download", null, async () => {
        const armed = rec.downloadArmed;
        if (!armed || !currentResource("download", null, armed.token)) { rec.downloadArmed = false; return; }
        const current = deps.downloadState.snapshot();
        if (current?.dir !== armed.dir || !!current?.once !== armed.once) { rec.downloadArmed = false; return; }
        await release("download", () => deps.downloadState.disarm(), () => { rec.downloadArmed = false; });
      });
    }
    return [...new Set(failures)];
  }

  function activeLeftovers(rec) {
    return [...new Set([...rec.active].map((entry) => `active-command:${entry.wcId || "none"}`))];
  }

  function resourceLeftovers(rec) {
    const leftovers = activeLeftovers(rec);
    for (const id of rec.subscriptions.keys()) leftovers.push(`subscription:${id}`);
    for (const ticket of rec.ai.keys()) leftovers.push(`ai:${ticket}`);
    for (const wcId of rec.holds.keys()) leftovers.push(`capture-hold:${wcId}`);
    for (const wcId of rec.focus) leftovers.push(`focus:${wcId}`);
    for (const wcId of rec.viewports.keys()) leftovers.push(`viewport:${wcId}`);
    for (const entry of rec.bindings.values()) if (entry.values.size) leftovers.push(`Runtime.removeBinding:${entry.wcId}`);
    for (const entry of rec.scripts.values()) if (entry.values.size) leftovers.push(`Page.removeScriptToEvaluateOnNewDocument:${entry.wcId}`);
    for (const stream of rec.screencasts.values()) leftovers.push(`screencast:${stream.wcId}`);
    for (const wcId of rec.dialogs.keys()) leftovers.push(`dialog:${wcId}`);
    for (const wcId of rec.uploads.keys()) leftovers.push(`upload:${wcId}`);
    for (const wcId of rec.qaModes.keys()) leftovers.push(`qa-mode:${wcId}`);
    for (const wcId of rec.qaViewports.keys()) leftovers.push(`qa-viewport:${wcId}`);
    for (const wcId of rec.hiddenViewports.keys()) leftovers.push(`hidden-viewport:${wcId}`);
    if (rec.downloadArmed) leftovers.push("download");
    return [...new Set(leftovers)];
  }

  function finishCleanup(rec, failures) {
    const leftovers = resourceLeftovers(rec);
    if (failures.length || leftovers.length) leftoverRecords.set(rec.generation, rec);
    else leftoverRecords.delete(rec.generation);
  }

  function continueCleanup(rec) {
    rec.cleanupPromise = null;
    if (!rec.cleanupAgain) return;
    rec.cleanupAgain = false;
    scheduleCleanup(rec);
  }

  function scheduleCleanup(rec) {
    leftoverRecords.set(rec.generation, rec);
    if (rec.cleanupPromise) {
      rec.cleanupAgain = true;
      return;
    }
    rec.cleanupPromise = cleanup(rec)
      .then((failures) => finishCleanup(rec, failures))
      .catch(() => leftoverRecords.set(rec.generation, rec))
      .finally(() => continueCleanup(rec));
  }

  async function cleanupNow(rec) {
    while (rec.cleanupPromise) await rec.cleanupPromise;
    const promise = cleanup(rec);
    rec.cleanupPromise = promise;
    try {
      const failures = await promise;
      finishCleanup(rec, failures);
      return failures;
    } finally {
      if (rec.cleanupPromise === promise) continueCleanup(rec);
    }
  }

  function retryLeftovers() {
    for (const rec of leftoverRecords.values()) scheduleCleanup(rec);
  }

  async function retireRecord(rec, { remember = true, force = false } = {}) {
    if (rec.state === "retired") {
      const leftovers = resourceLeftovers(rec);
      if (leftovers.length) scheduleCleanup(rec);
      return { retired: true, existing: true, ...(force ? { forced: true, leftovers } : {}) };
    }
    rec.state = "retiring";
    const targets = new Set([...rec.active].map((entry) => entry.wcId).filter(Boolean));
    for (const wcId of targets) { try { deps.cancelTarget(wcId); } catch {} }
    if (force) {
      rec.state = "retired";
      if (remember) retiredGenerations.add(rec.generation);
      const leftovers = resourceLeftovers(rec);
      if (leftovers.length) scheduleCleanup(rec);
      else leftoverRecords.delete(rec.generation);
      return { retired: true, workerGeneration: rec.generation, forced: true, leftovers };
    }
    const finished = Promise.allSettled([...rec.active].map((entry) => entry.promise));
    let timer = null;
    try {
      await Promise.race([finished, new Promise((_, reject) => {
        timer = setTimeout(() => reject(error("TIMEOUT", "이전 세대 명령의 실제 종료를 확인하지 못했습니다.")), RETIRE_TIMEOUT_MS);
      })]);
    } finally { if (timer) clearTimeout(timer); }
    let failures;
    try { failures = await cleanupNow(rec); }
    catch (cause) { throw cause; }
    if (rec.state === "retired") return { retired: true, existing: true };
    if (failures.length) {
      throw error("RESOURCE_RELEASE_FAILED", "이전 작업 프로세스 세대의 자원을 모두 반환하지 못했습니다.",
        { count: failures.length, leftovers: failures });
    }
    rec.state = "retired";
    if (remember) retiredGenerations.add(rec.generation);
    owner = rec;
    const leftovers = [...new Set([...failures, ...activeLeftovers(rec)])];
    if (leftovers.length) leftoverRecords.set(rec.generation, rec);
    else leftoverRecords.delete(rec.generation);
    return { retired: true, workerGeneration: rec.generation };
  }

  async function retireGeneration(workerGeneration, { force = false } = {}) {
    retryLeftovers();
    if (!owner || owner.generation !== workerGeneration) throw error("STALE_WORKER", "종료할 작업 프로세스 세대가 아닙니다.");
    if (owner.state === "retired") {
      const rec = leftoverRecords.get(workerGeneration);
      const leftovers = rec ? resourceLeftovers(rec) : [];
      return { retired: true, existing: true, ...(force ? { forced: true, leftovers } : {}) };
    }
    return retireRecord(owner, { force });
  }

  function state() {
    return owner ? { workerGeneration: owner.generation, state: owner.state, active: owner.active.size } : { state: "absent", active: 0 };
  }

  // scoped 가 아닌 구독이 살아 있는 탭 · QA 반응 관찰이 끝나기 전에는 CDP 를 떼지 않게 부착 정책이 물음 (옛 qaReactionCommands.hasActive)
  function hasPersistentSubscription(wcId) {
    const id = Number(wcId);
    const held = (rec) => [...rec.subscriptions.values()].some((sub) => sub.wcId === id && sub.scoped !== true);
    return (owner ? held(owner) : false) || [...leftoverRecords.values()].some(held);
  }

  return { execute, acceptGeneration, retireGeneration, releaseCommand, state, hasPersistentSubscription, isBaseCommand: (command) => BASE_COMMANDS.has(command) };
}

module.exports = { createElectronRelay, BASE_COMMANDS };
