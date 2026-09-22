// 선택한 macOS 창의 저장·전역 단축키·IPC·실행 순서를 한곳에서 맡는다.
//
// 소유 범위
//   window-switcher 전용 상태 파일과 백업, 방향별 전역 단축키, 순차 step 큐, 생존 확인과 시작 재결합 timer.
//
// 제공 API
//   createSwitcherHost(deps) 하나를 제공한다. 만들어진 API는 ready/quit 수명, 단일 IPC dispatcher,
//   keymap 변경 훅과 복제한 status 접근자이며 원시 상태·queue·timer는 제공하지 않는다.
//
// 의존 대상
//   Electron을 require하지 않는다. switcher-core·window-catalog·window-icons·window-media·fs·globalShortcut·shell·신뢰 판정과
//   stateHome(기본값은 server/state-home.cjs 정본)을 주입받으며,
//   process 생존 probe, timer, 창 broadcast를 main.cjs에서 받는다. 기본 단축키는 main-window의 DEFAULT_RELAY다.
//
// 유지 조건
//   상태 경로는 stateHome 아래 전용 파일 하나뿐이고, core의 저장·재결합 판정을 다시 만들지 않는다.
//   단축키는 선택이 있을 때 자기 가속기만 등록·해제하며, step은 최대 8개를 한 번씩 순서대로 실행한다.
//   목록 변화 방송은 목록 전체 대신 단조 증가 revision만 싣고, 아이콘·그림은 media 직접 응답에만 싣는다.
//
// 영향 범위
//   공급자는 main.cjs의 Electron 배선과 main-window 기본표, switcher-core·window-catalog·state-home이다.
//   소비자는 preload의 ac-window-switcher IPC, B4 설정 화면, B5 keymap 표와 모든 Iris 창의 상태 표시다.
//   현재 목록 확인: node bin/importers.mjs native/electron/switcher-host.cjs

const PICK_MODE_ACCELERATOR = "CommandOrControl+Shift+E";
const PERMISSIONS_URLS = Object.freeze({
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
});
const QUEUE_LIMIT = 8;
const STEP_LOG_LIMIT = 10;
// 전환이 아무 창도 못 냈을 때 스스로 목록을 다시 읽는 최소 간격.
// 고른 창이 정말 다 닫힌 경우에는 다시 읽어도 소용이 없으므로, 누를 때마다 훑지 않는다.
const SELF_HEAL_MIN_MS = 5000;
const SWITCH_BLOCK_REASONS = new Set([
  "desktop-unknown",
  "desktop-switch-failed",
  "window-out-of-reach",
  "raise-did-not-land",
]);
// Electron Accelerator의 Available key codes 정본만 KeyboardEvent.key 이름으로 옮긴다: https://www.electronjs.org/docs/latest/api/accelerator
const ACCELERATOR_KEY_NAMES = Object.freeze({
  " ": "Space",
  Escape: "Escape",
  Enter: "Return",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Tab: "Tab",
});
const ACCELERATOR_PUNCTUATION = new Set(["-", "=", "[", "]", "\\", ";", "'", ",", ".", "/"]);

// 상태 폴더의 정본은 하나다. 주입을 받지만 기본값도 그 정본에서 가져온다. 경로를 직접 조합하거나
// 다른 곳에서 받아 오면 개발 환경이 설치 앱의 파일을 쓰게 되어 계정·탭이 지워질 수 있다.
const { stateHome: canonicalStateHome } = require("../../server/state-home.cjs");

function createSwitcherHost({
  core, catalog, iconRunner, mediaRunner, fs, path, stateHome = canonicalStateHome, globalShortcut, defaultRelay, killProbe,
  raiseOwnWindow, ownPid,
  isTrustedSender, isTrustedMediaSender, expectedAppUrl, broadcast, shell,
  setTimeout, clearTimeout, setInterval, clearInterval,
  now = () => Date.now(),
}) {
  if (!core || !catalog || !iconRunner || !mediaRunner) {
    throw new TypeError("switcher core와 catalog와 media runner 주입이 필요하다");
  }
  if (!fs || !path || typeof stateHome !== "function") throw new TypeError("상태 파일 경계 주입이 필요하다");
  if (!globalShortcut || typeof isTrustedSender !== "function" || typeof isTrustedMediaSender !== "function") {
    throw new TypeError("Electron adapter 주입이 필요하다");
  }

  const stateFile = path.join(stateHome(), "window-switcher.json");
  // 앱 내부에서만 아는 사실을 밖에서 확인할 수 있게 기록한다. 이 기록이 없으면 동작하지 않을 때
  // 원인을 짚을 근거가 없어 추측으로 고치게 된다. 선택 목록과 달리 이 파일은
  // 유실돼도 되는 기록이라 실패를 무시한다.
  const diagFile = path.join(stateHome(), "window-switcher-diag.json");
  const backupFile = stateFile + ".bak";
  const keymapFile = path.join(stateHome(), "keymap.json");
  const timers = [];
  const stepLog = [];
  let liveTimer = null;
  let ready = false;
  let stopped = false;
  let restartOpen = true;
  let restartBase = null;
  let restartWindows = [];
  let currentWindows = [];
  let rows = [];
  let lastGoodText = null;
  let bindings = null;
  let registeredAccelerators = { next: null, prev: null };
  let stepRunning = false;
  let stepQueue = [];
  let executionEpoch = 0;
  let mediaGeneration = 0;
  const iconCache = new Map();
  const thumbCache = new Map();

  const status = {
    permission: false,
    titleLookupMs: 0,
    pickedMode: false,
    registered: { next: false, prev: false },
    registerError: {},
    accelerators: { next: null, prev: null },
    listRevision: 0,
  };

  function canonicalText(value) {
    return JSON.stringify(core.serialize(value), null, 2) + "\n";
  }

  function readCandidate(file) {
    const raw = String(fs.readFileSync(file, "utf8"));
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.version !== 1 || !Array.isArray(parsed.picked)) {
      throw new Error("window-switcher 상태 모양이 아니다");
    }
    const value = core.deserialize(parsed);
    return { value, text: canonicalText(value) };
  }

  function loadState() {
    for (const file of [stateFile, backupFile]) {
      try {
        const loaded = readCandidate(file);
        lastGoodText = loaded.text;
        return loaded.value;
      } catch {}
    }
    return core.deserialize({ version: 1, picked: [], cursor: null });
  }

  let state = loadState();
  restartBase = state;
  status.pickedMode = state.picked.length > 0;
  rows = core.reconcile({ state, windows: [], phase: "session" }).rows;

  function persist() {
    const nextText = canonicalText(state);
    const previousText = lastGoodText;
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile + ".tmp", nextText, "utf8");
      fs.renameSync(stateFile + ".tmp", stateFile);
      lastGoodText = nextText;
      if (previousText !== null) {
        try {
          fs.writeFileSync(backupFile + ".tmp", previousText, "utf8");
          fs.renameSync(backupFile + ".tmp", backupFile);
        } catch {}
      }
      return true;
    } catch {
      return false;
    }
  }

  function publicStatus() {
    const out = {
      permission: status.permission,
      titleLookupMs: status.titleLookupMs,
      pickedMode: status.pickedMode,
      registered: { ...status.registered },
      registerError: { ...status.registerError },
      accelerators: { ...status.accelerators },
      listRevision: status.listRevision,
    };
    if (status.conflict) out.conflict = status.conflict;
    if (Number.isInteger(status.droppedOnRestart)) out.droppedOnRestart = status.droppedOnRestart;
    // 마지막 전환의 경과. 동작하지 않을 때 원인을 짚는 근거다.
    if (status.lastStep) out.lastStep = { ...status.lastStep };
    return out;
  }

  function broadcastPayload() {
    return {
      pickedMode: status.pickedMode,
      registered: { ...status.registered },
      registerError: { ...status.registerError },
      accelerators: { ...status.accelerators },
      conflict: status.conflict || null,
      listRevision: status.listRevision,
    };
  }

  let lastBroadcast = JSON.stringify(broadcastPayload());
  function broadcastIfChanged() {
    const payload = broadcastPayload();
    const signature = JSON.stringify(payload);
    if (signature === lastBroadcast) return;
    lastBroadcast = signature;
    try { if (typeof broadcast === "function") broadcast(payload); } catch {}
  }

  function normalizeBinding(source) {
    if (!source || typeof source !== "object" || Array.isArray(source)) return null;
    const binding = { mod: !!source.mod, alt: !!source.alt, shift: !!source.shift };
    if (typeof source.code === "string" && source.code) binding.code = source.code;
    else if (typeof source.key === "string" && source.key) binding.key = source.key;
    else return null;
    return binding;
  }

  function readBindings() {
    let overrides = {};
    try {
      const parsed = JSON.parse(String(fs.readFileSync(keymapFile, "utf8")));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) overrides = parsed;
    } catch {}
    const defaultNext = normalizeBinding(defaultRelay && defaultRelay["screen-toggle"]);
    const overrideNext = normalizeBinding(overrides["screen-toggle"]);
    const next = overrideNext || defaultNext;
    const explicitBack = normalizeBinding(overrides["screen-toggle-back"])
      || normalizeBinding(defaultRelay && defaultRelay["screen-toggle-back"]);
    // B5 전에는 back 항목이 없으므로 next의 modifier를 그대로 물리고 Shift만 더한다.
    const prev = explicitBack || (next ? { ...next, shift: true } : { alt: true, shift: true, code: "Tab" });
    return { next, prev };
  }

  function acceleratorKey(binding) {
    const raw = binding && (binding.code || binding.key);
    if (typeof raw !== "string" || !raw) return null;
    if (Object.prototype.hasOwnProperty.call(ACCELERATOR_KEY_NAMES, raw)) return ACCELERATOR_KEY_NAMES[raw];
    if (ACCELERATOR_PUNCTUATION.has(raw)) return raw;
    let match = raw.match(/^Digit([0-9])$/);
    if (match) return match[1];
    match = raw.match(/^Key([A-Za-z])$/);
    if (match) return match[1].toUpperCase();
    if (/^[A-Za-z]$/.test(raw)) return raw.toUpperCase();
    if (/^[0-9]$/.test(raw)) return raw;
    if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(raw)) return raw;
    return null;
  }

  function acceleratorFor(binding) {
    if (!binding) return null;
    const key = acceleratorKey(binding);
    if (!key) return null;
    const parts = [];
    if (binding.mod) parts.push("CommandOrControl");
    if (binding.alt) parts.push("Alt");
    if (binding.shift) parts.push("Shift");
    parts.push(key);
    return parts.join("+");
  }

  function unregisterDirection(dir) {
    const accelerator = registeredAccelerators[dir];
    if (accelerator) {
      try { globalShortcut.unregister(accelerator); } catch {}
    }
    registeredAccelerators[dir] = null;
    status.registered[dir] = false;
  }

  function registerDirection(dir, accelerator) {
    if (!accelerator) {
      status.registerError[dir] = "unsupported";
      return;
    }
    try {
      const ok = globalShortcut.register(accelerator, () => { void requestStep(dir === "next" ? 1 : -1); });
      status.registered[dir] = ok === true;
      if (ok === true) registeredAccelerators[dir] = accelerator;
      else status.registerError[dir] = "register-failed";
    } catch {
      status.registered[dir] = false;
      status.registerError[dir] = "register-error";
    }
  }

  function syncRegistration({ reload = false, force = false } = {}) {
    if (!bindings || reload) bindings = readBindings();
    const accelerators = {
      next: acceleratorFor(bindings.next),
      prev: acceleratorFor(bindings.prev),
    };
    status.accelerators = accelerators;

    if (force) {
      unregisterDirection("next");
      unregisterDirection("prev");
    } else {
      for (const dir of ["next", "prev"]) {
        if (registeredAccelerators[dir] && registeredAccelerators[dir] !== accelerators[dir]) unregisterDirection(dir);
      }
    }
    status.registerError = {};
    delete status.conflict;

    if (!ready || stopped || !status.pickedMode) {
      unregisterDirection("next");
      unregisterDirection("prev");
      writeDiag();
      broadcastIfChanged();
      return;
    }

    const internalNext = accelerators.next === PICK_MODE_ACCELERATOR;
    const internalPrev = accelerators.prev === PICK_MODE_ACCELERATOR;
    const same = accelerators.next && accelerators.next === accelerators.prev;
    if (internalNext || internalPrev) status.conflict = "internal:pick-mode";
    else if (same) status.conflict = "same-accelerator";

    const allowed = {
      next: !!accelerators.next && !internalNext,
      prev: !!accelerators.prev && !internalPrev && !same,
    };
    for (const dir of ["next", "prev"]) {
      if (!accelerators[dir]) status.registerError[dir] = "unsupported";
      if (!allowed[dir] || status.registered[dir]) continue;
      registerDirection(dir, accelerators[dir]);
    }
    writeDiag();
    broadcastIfChanged();
  }

  function sameState(left, right) {
    return JSON.stringify(core.serialize(left)) === JSON.stringify(core.serialize(right));
  }

  function clearQueuedSteps() {
    const queued = stepQueue;
    stepQueue = [];
    for (const item of queued) item.resolve({ raised: null, status: publicStatus() });
  }

  function cancelRunningSteps() {
    executionEpoch += 1;
    clearQueuedSteps();
    try { catalog.cancel(); } catch {}
  }

  function setState(next, { save = true, updateRestartBase = true } = {}) {
    const hadPicked = state.picked.length > 0;
    const changed = !sameState(state, next);
    const blockedIdentities = rowIdentities(rows.filter((row) => row.switchBlocked === true));
    state = next;
    status.pickedMode = state.picked.length > 0;
    rows = core.reconcile({ state, windows: currentWindows, phase: "session" }).rows;
    if (blockedIdentities.size) {
      rows = rows.map((row) => rowMatchesIdentities(row, blockedIdentities)
        ? { ...row, switchBlocked: true } : row);
    }
    if (restartOpen && updateRestartBase) restartBase = state;
    if (save && changed) persist();
    syncRegistration();
    if (hadPicked && !status.pickedMode) cancelRunningSteps();
    pruneIconCache();
    pruneThumbCache();
    return changed;
  }

  function mediaAppKeys() {
    const keys = [];
    const seen = new Set();
    const add = (item) => {
      const appKey = item && typeof item.appKey === "string" ? item.appKey : "";
      if (!appKey || seen.has(appKey)) return;
      seen.add(appKey);
      keys.push(appKey);
    };
    for (const item of currentWindows) add(item);
    for (const row of rows) {
      if (row && row.picked && row.visible === false) add(row);
    }
    return keys;
  }

  function pruneIconCache(appKeys = mediaAppKeys()) {
    const keep = new Set(appKeys);
    for (const appKey of iconCache.keys()) {
      if (!keep.has(appKey)) iconCache.delete(appKey);
    }
    return appKeys;
  }

  function cachedIcons(appKeys) {
    const icons = {};
    for (const appKey of appKeys) {
      if (iconCache.has(appKey)) icons[appKey] = iconCache.get(appKey);
    }
    return icons;
  }

  function mediaCacheKey(item) {
    if (!item || !Number.isInteger(item.pid) || typeof item.pidStart !== "string"
        || !Number.isInteger(item.cgId)) return "";
    return [item.pid, item.pidStart, item.cgId].join("\u001f");
  }

  function mediaTargets() {
    return currentWindows.filter((item) => mediaCacheKey(item));
  }

  function pruneThumbCache(targets = mediaTargets()) {
    const keep = new Set(targets.map((item) => mediaCacheKey(item)));
    for (const key of thumbCache.keys()) {
      if (!keep.has(key)) thumbCache.delete(key);
    }
    return targets;
  }

  function cachedThumbs(targets) {
    const thumbs = {};
    for (const target of targets) {
      const key = mediaCacheKey(target);
      if (key && thumbCache.has(key)) thumbs[target.id] = thumbCache.get(key);
    }
    return thumbs;
  }

  function mediaWindows() {
    const windows = currentWindows.slice();
    const ids = new Set(currentWindows.filter((item) => item && item.id != null).map((item) => String(item.id)));
    for (const row of rows) {
      if (!row || !row.picked || row.visible !== false) continue;
      if (row.id != null && ids.has(String(row.id))) continue;
      windows.push(row);
    }
    return windows;
  }

  function thumbMissing(permission, thumbs, resultMissing) {
    const byId = new Map();
    for (const item of Array.isArray(resultMissing) ? resultMissing : []) {
      if (item && item.id != null) byId.set(String(item.id), item);
    }
    const missing = [];
    for (const item of mediaWindows()) {
      if (item && item.id != null) {
        if (typeof thumbs[item.id] === "string") continue;
        const found = byId.get(String(item.id));
        missing.push(found ? { ...found } : {
          id: item.id,
          reason: permission === "granted" ? "not-found" : "permission",
        });
      } else if (item && typeof item.appKey === "string" && item.appKey) {
        missing.push({ appKey: item.appKey, reason: permission === "granted" ? "not-found" : "permission" });
      }
    }
    return missing;
  }

  async function refreshMedia() {
    const generation = ++mediaGeneration;
    try { iconRunner.cancel(); } catch {}
    const appKeys = pruneIconCache();
    const targets = pruneThumbCache();
    const iconFailure = () => ({
      icons: {}, missing: appKeys.map((appKey) => ({ appKey, reason: "exec" })),
    });
    let iconPromise;
    try {
      iconPromise = appKeys.length ? Promise.resolve(iconRunner.icons({ appKeys })) : Promise.resolve(iconFailure());
    } catch {
      iconPromise = Promise.resolve(iconFailure());
    }
    iconPromise = iconPromise.catch(iconFailure);
    const thumbFailure = () => {
      let permission = "unknown";
      try { permission = mediaRunner.permission(); } catch {}
      return {
        permission,
        thumbs: {},
        missing: targets.map((item) => ({ id: item.id, reason: "capture-failed" })),
        elapsedMs: 0,
      };
    };
    let thumbPromise;
    try { thumbPromise = Promise.resolve(mediaRunner.thumbnails({ targets })); }
    catch { thumbPromise = Promise.resolve(thumbFailure()); }
    thumbPromise = thumbPromise.catch(thumbFailure);
    const [iconResult, thumbResult] = await Promise.all([iconPromise, thumbPromise]);
    if (generation === mediaGeneration) {
      for (const appKey of appKeys) {
        const icon = iconResult && iconResult.icons && iconResult.icons[appKey];
        if (typeof icon === "string") iconCache.set(appKey, icon);
      }
    }
    const permission = thumbResult && typeof thumbResult.permission === "string"
      ? thumbResult.permission : "unknown";
    if (permission !== "granted") {
      thumbCache.clear();
    } else {
      const currentKeys = new Set(mediaTargets().map((item) => mediaCacheKey(item)));
      for (const target of targets) {
        const key = mediaCacheKey(target);
        const thumb = thumbResult && thumbResult.thumbs && thumbResult.thumbs[target.id];
        if (key && currentKeys.has(key) && typeof thumb === "string") thumbCache.set(key, thumb);
      }
    }
    const iconMissing = generation === mediaGeneration && iconResult && Array.isArray(iconResult.missing)
      ? iconResult.missing.map((item) => ({ ...item }))
      : [];
    const thumbs = permission === "granted" ? cachedThumbs(targets) : {};
    return {
      permission,
      icons: cachedIcons(appKeys),
      thumbs,
      missing: iconMissing.concat(thumbMissing(permission, thumbs, thumbResult && thumbResult.missing)),
      elapsedMs: Number.isFinite(Number(thumbResult && thumbResult.elapsedMs))
        ? Math.max(0, Number(thumbResult.elapsedMs)) : 0,
    };
  }

  function probeAlive(item) {
    if (!Number.isInteger(item.pid) || item.pid <= 0) return false;
    let result;
    try { result = killProbe(item.pid, 0); }
    catch { return false; }
    if (result === false || (result && typeof result === "object" && result.alive === false)) return false;
    const probedStart = typeof result === "string" ? result
      : result && typeof result.pidStart === "string" ? result.pidStart : "";
    if (item.pidStart && probedStart && item.pidStart !== probedStart) return false;
    const observed = currentWindows.find((candidate) => candidate.pid === item.pid && candidate.pidStart);
    if (item.pidStart && observed && observed.pidStart !== item.pidStart) return false;
    return true;
  }

  function pruneDead() {
    if (restartOpen || state.picked.length === 0) return 0;
    const alive = {};
    for (const item of state.picked) {
      alive[String(item.pid) + "|" + String(item.pidStart)] = probeAlive(item);
    }
    const pruned = core.pruneDeadProcesses({ state, alive });
    if (pruned.removed) {
      status.listRevision += 1;
      setState(pruned.state);
    }
    return pruned.removed;
  }

  function markMissingRows(missingIds) {
    if (!Array.isArray(missingIds) || missingIds.length === 0) return false;
    const missing = new Set(missingIds
      .filter((item) => !(item && typeof item === "object" && SWITCH_BLOCK_REASONS.has(item.reason)))
      .map((item) => item && typeof item === "object" ? item.id : item));
    if (!missing.size) return false;
    let changed = false;
    rows = rows.map((row) => {
      const matches = missing.has(row.id) || missing.has(row.cgId) || missing.has(row.pickKey);
      if (!matches || row.visible === false) return row;
      changed = true;
      return { ...row, visible: false };
    });
    if (changed) {
      status.listRevision += 1;
      broadcastIfChanged();
    }
    return changed;
  }

  function rowIdentities(source) {
    const identities = new Set();
    for (const row of source) {
      for (const value of [row && row.id, row && row.cgId, row && row.pickKey]) {
        if (value !== null && value !== undefined) identities.add(value);
      }
    }
    return identities;
  }

  function rowMatchesIdentities(row, identities) {
    return [row && row.id, row && row.cgId, row && row.pickKey]
      .some((value) => value !== null && value !== undefined && identities.has(value));
  }

  function markSwitchBlockedRows(missingIds) {
    if (!Array.isArray(missingIds) || missingIds.length === 0) return false;
    const blocked = new Set(missingIds
      .filter((item) => item && typeof item === "object" && SWITCH_BLOCK_REASONS.has(item.reason))
      .map((item) => item.id)
      .filter((id) => id !== null && id !== undefined));
    if (!blocked.size) return false;
    let changed = false;
    rows = rows.map((row) => {
      if (!rowMatchesIdentities(row, blocked) || row.switchBlocked === true) return row;
      changed = true;
      return { ...row, switchBlocked: true };
    });
    if (changed) {
      status.listRevision += 1;
      broadcastIfChanged();
    }
    return changed;
  }

  function clearSwitchBlockedRows(id) {
    const target = id === undefined ? null : new Set([id]);
    let changed = false;
    rows = rows.map((row) => {
      if (row.switchBlocked !== true || (target && !rowMatchesIdentities(row, target))) return row;
      const next = { ...row };
      delete next.switchBlocked;
      changed = true;
      return next;
    });
    if (changed) {
      status.listRevision += 1;
      broadcastIfChanged();
    }
    return changed;
  }

  function rememberRestartWindows(windows) {
    const byIdentity = new Map();
    for (const item of restartWindows.concat(windows)) {
      const identity = item.cgId != null ? "cg:" + item.cgId
        : ["pid", item.pid, item.pidStart, item.matchApp, item.matchTitle, item.bounds].join("|");
      byIdentity.set(identity, item);
    }
    restartWindows = [...byIdentity.values()];
  }

  function titleText(value, limit) {
    return Array.from(value == null ? "" : String(value)).slice(0, limit).join("");
  }

  function titleDisplay(value) {
    return titleText(titleText(value, 400).replace(/[\u0000-\u001f\u007f]/g, ""), 200);
  }

  function omitUnreadableCgWindows(windows) {
    const canReadCgTitles = windows.some((item) => item && item.reachable === "cg" && item.matchTitle !== "");
    if (!canReadCgTitles) return windows;
    return windows.filter((item) => !item || item.reachable !== "cg" || item.matchTitle !== "");
  }

  function titlelessCgIds(windows) {
    const ids = [];
    const seen = new Set();
    for (const item of windows) {
      if (!item || item.reachable !== "cg" || item.matchTitle !== "" || !Number.isInteger(item.cgId)
          || seen.has(item.cgId)) continue;
      seen.add(item.cgId);
      ids.push(item.cgId);
    }
    return ids;
  }

  async function completeCgTitles(windows, ids) {
    let result;
    try {
      result = await mediaRunner.titles({ ids });
    } catch {
      return omitUnreadableCgWindows(windows);
    }
    try {
      status.titleLookupMs = Number.isFinite(Number(result && result.elapsedMs))
        ? Math.max(0, Number(result.elapsedMs)) : 0;
      if (!result || result.ok !== true || !result.titles || typeof result.titles !== "object") {
        return omitUnreadableCgWindows(windows);
      }

      const completed = windows.map((item) => {
        if (!item || item.reachable !== "cg" || item.matchTitle !== "" || !Number.isInteger(item.cgId)) return item;
        const matchTitle = titleText(result.titles[String(item.cgId)], 400);
        if (!matchTitle) return item;
        return { ...item, matchTitle, displayTitle: titleDisplay(matchTitle) };
      });
      return omitUnreadableCgWindows(completed);
    } catch {
      status.titleLookupMs = 0;
      return omitUnreadableCgWindows(windows);
    }
  }

  async function enumerate({ finalRestart = false } = {}) {
    clearSwitchBlockedRows();
    pruneDead();
    status.titleLookupMs = 0;
    const result = await catalog.enumerate();
    if (result.ok) {
      status.permission = true;
      const ids = titlelessCgIds(result.windows);
      currentWindows = ids.length
        ? await completeCgTitles(result.windows, ids)
        : omitUnreadableCgWindows(result.windows);
      // 같은 pid가 다른 시작 시각으로 돌아온 경우 core가 cgId로 붙이기 전에 다른 프로세스로 걷는다.
      pruneDead();
      if (restartOpen) rememberRestartWindows(currentWindows);
    } else if (result.reason === "permission") {
      status.permission = false;
    }

    if (restartOpen && finalRestart) {
      const reconciled = core.reconcile({ state: restartBase, windows: restartWindows, phase: "restart" });
      restartOpen = false;
      status.droppedOnRestart = reconciled.dropped;
      setState(reconciled.state, { updateRestartBase: false });
    } else if (result.ok && !restartOpen) {
      const reconciled = core.reconcile({ state, windows: currentWindows, phase: "session" });
      setState(reconciled.state, { updateRestartBase: false });
    } else {
      rows = core.reconcile({ state, windows: currentWindows, phase: "session" }).rows;
    }
    return result;
  }

  function targetInput() {
    const targets = state.picked.map((item) => ({
      ...item,
      id: Number.isInteger(item.id) ? item.id : Number.isInteger(item.cgId) ? item.cgId : item.pickKey,
    }));
    return {
      ordered: targets.map((item) => item.id),
      cursor: state.cursor,
      targets,
    };
  }

  // 마지막 전환의 경과를 기록한다. 사용자에게도 보이고, 동작하지 않을 때 원인을 짚는 근거가 된다.
  function noteStep(entry) {
    status.lastStep = { at: new Date().toISOString(), ...entry };
    // 한 번만 남기면 여러 번 누른 뒤에는 마지막 것만 보여, 실패한 시도가 기록에서 사라진다.
    stepLog.push(status.lastStep);
    while (stepLog.length > STEP_LOG_LIMIT) stepLog.shift();
    writeDiag();
  }

  function writeDiag() {
    try {
      fs.writeFileSync(diagFile, JSON.stringify({
        at: new Date().toISOString(),
        ownPid: ownPid == null ? null : ownPid,
        pickedMode: status.pickedMode,
        pickedCount: state.picked.length,
        accelerators: status.accelerators,
        registered: status.registered,
        registerError: status.registerError,
        conflict: status.conflict || null,
        lastStep: status.lastStep || null,
        steps: stepLog.slice(),
        rows: rows.map((row) => ({
          id: row.id, cgId: row.cgId, app: row.matchApp, title: row.matchTitle,
          picked: row.picked === true, reachable: row.reachable,
          onScreen: row.onScreen === true, visible: row.visible !== false,
          switchBlocked: row.switchBlocked === true, pid: row.pid,
        })),
      }, null, 2));
    } catch {}
  }

  // 선택한 창을 하나도 찾지 못했는지 판정한다.
  //
  // 찾았지만 전환하지 못한 경우와 구분해야 한다. 전환하지 못한 경우(다른 데스크톱으로 넘어가지
  // 못하는 등)는 그 창의 문제라 목록을 다시 읽어도 같고, 그 사실은 행에 표시해 사용자에게 보여 준다.
  // 찾지 못한 경우는 보관 중인 창 정보가 이전 상태라는 뜻이므로 다시 읽으면 해결된다.
  // 스크립트가 둘을 구분해 돌려준다. 전환 실패는 reason 이 붙은 객체, 찾지 못한 것은 id 값이다.
  function nothingMatched(result) {
    if (!result || result.ok !== true) return false;
    if (result.raised != null || result.own != null) return false;
    const missing = Array.isArray(result.missing) ? result.missing : [];
    if (!missing.length) return false;
    return missing.every((item) => !(item && typeof item === "object" && item.reason));
  }

  // 목록을 다시 읽는 일을 설정 화면만 할 수 있었다.
  //
  // 선택한 창은 앱을 재시작해도 남지만, 그 안의 pid·cgId·위치는 이전 상태다. 시작 직후
  // 3초·8초에 한 번씩 다시 읽어 재결합하는데, 그때 앱 창이 아직 뜨지 않았으면 재결합하지 못한다.
  // 그 뒤로는 다시 읽는 경로가 없어(enumerate 는 설정 화면이 호출할 때만 실행된다) 단축키를
  // 눌러도 아무 일이 일어나지 않는다. 사용자에게는 재시작하면 기능이 꺼져 있고 설정 창전환을
  // 한 번 열어야 켜지는 것으로 보인다. 설정 화면이 하던 그 동작을 전환 경로가 직접 한다.
  //
  // 선택한 창이 없으면 아무것도 하지 않는다. 그 상태가 이 기능의 꺼짐이다.
  let lastSelfHealAt = -Infinity;   // 아직 읽은 적이 없다. 첫 시도는 최소 간격에 걸리지 않는다
  function maySelfHeal() {
    return now() - lastSelfHealAt >= SELF_HEAL_MIN_MS;
  }

  async function executeStep(dir, epoch) {
    pruneDead();
    if (!state.picked.length || epoch !== executionEpoch) {
      noteStep({ dir, how: "시작 못 함", failed: state.picked.length ? "다른 전환이 끼어들었다" : "고른 창이 없다" });
      return { raised: null, status: publicStatus() };
    }
    let result = await catalog.step({ ...targetInput(), dir, ownPid });
    if (epoch !== executionEpoch || !state.picked.length) return { raised: null, status: publicStatus() };
    if (nothingMatched(result) && maySelfHeal()) {
      lastSelfHealAt = now();
      noteStep({ dir, how: "목록 다시 읽기", failed: "고른 창을 하나도 못 찾았다" });
      await enumerate();
      if (epoch !== executionEpoch || !state.picked.length) return { raised: null, status: publicStatus() };
      result = await catalog.step({ ...targetInput(), dir, ownPid });
      if (epoch !== executionEpoch || !state.picked.length) return { raised: null, status: publicStatus() };
    }
    if (result.ok) {
      status.permission = true;
      // 이 앱의 자기 창은 스크립트가 알려 주기만 하고 올리는 것은 앱이 한다.
      if (result.own != null && typeof raiseOwnWindow === "function" && raiseOwnWindow(
        state.picked.find((item) => item.cgId === result.own || item.id === result.own) || { id: result.own })) {
        setState({ ...state, cursor: result.own });
        clearSwitchBlockedRows(result.own);
        noteStep({ dir, target: result.own, how: "own-window", front: result.front });
        return { raised: result.own, status: publicStatus() };
      }
      if (result.own != null) {
        noteStep({ dir, target: result.own, how: "own-window", front: result.front, failed: "앱이 그 창을 못 찾았다" });
        return { raised: null, status: publicStatus() };
      }
      noteStep({ dir, target: result.raised, how: "osascript", front: result.front,
        failed: result.raised == null ? ((result.missing || []).map((m) => (m && m.reason) || m).join(",") || "없음") : undefined });
      if (result.raised != null) setState({ ...state, cursor: result.raised });
      markMissingRows(result.missing);
      markSwitchBlockedRows(result.missing);
      if (result.raised != null) clearSwitchBlockedRows(result.raised);
      return { raised: result.raised == null ? null : result.raised, status: publicStatus() };
    }
    if (result.reason === "permission") status.permission = false;
    noteStep({ dir, how: "osascript", failed: result.reason || "알 수 없음" });
    return { raised: null, status: publicStatus() };
  }

  function pumpSteps() {
    if (stepRunning || !stepQueue.length) return;
    const item = stepQueue.shift();
    stepRunning = true;
    const epoch = executionEpoch;
    Promise.resolve(executeStep(item.dir, epoch))
      .then(item.resolve, () => item.resolve({ raised: null, status: publicStatus() }))
      .finally(() => {
        stepRunning = false;
        if (status.pickedMode) pumpSteps();
        else clearQueuedSteps();
      });
  }

  function requestStep(dir) {
    return new Promise((resolve) => {
      if (stepRunning && stepQueue.length >= QUEUE_LIMIT) {
        resolve({ raised: null, status: publicStatus() });
        return;
      }
      stepQueue.push({ dir, resolve });
      pumpSteps();
    });
  }

  function response() {
    return {
      windows: rows.map((item) => ({ ...item })),
      picked: state.picked.map((item) => ({ ...item })),
      status: publicStatus(),
    };
  }

  async function handle(event, payload) {
    if (!isTrustedSender(event, expectedAppUrl)) return { error: "untrusted" };
    const arg = payload && typeof payload === "object" ? payload : {};
    if (arg.op === "status") return { status: publicStatus() };
    if (arg.op === "open-permissions") {
      const kind = arg.kind == null ? "accessibility" : arg.kind;
      if (!Object.prototype.hasOwnProperty.call(PERMISSIONS_URLS, kind)) return { error: "bad-kind" };
      try { await shell.openExternal(PERMISSIONS_URLS[kind]); } catch {}
      return { ok: true };
    }
    if (arg.op === "media") {
      if (!isTrustedMediaSender(event)) return { error: "untrusted" };
      return refreshMedia();
    }
    if (arg.op === "step") {
      if (arg.dir !== 1 && arg.dir !== -1) return { error: "bad-dir" };
      return requestStep(arg.dir);
    }
    if (arg.op === "move") {
      if (arg.dir !== 1 && arg.dir !== -1) return { error: "bad-dir" };
      const next = core.movePicked({ state, id: arg.id, pickKey: arg.key, dir: arg.dir });
      if (next !== state && setState(next)) {
        status.listRevision += 1;
        broadcastIfChanged();
      }
      return response();
    }
    if (arg.op === "list") {
      pruneDead();
      if (arg.refresh) await enumerate();
      return response();
    }
    if (arg.op === "pick") {
      const candidate = currentWindows.find((item) => item.id === arg.id);
      if (!candidate) return { error: "unknown-window" };
      setState(core.pick({ state, window: candidate }));
      return response();
    }
    if (arg.op === "unpick") {
      if (typeof arg.pickKey === "string") {
        if (!state.picked.some((item) => item.pickKey === arg.pickKey)) return { error: "unknown-window" };
        setState(core.unpick({ state, pickKey: arg.pickKey }));
        return response();
      }
      if (!currentWindows.some((item) => item.id === arg.id)) return { error: "unknown-window" };
      setState(core.unpick({ state, id: arg.id }));
      return response();
    }
    return { error: "bad-op" };
  }

  function schedule(fn, ms) {
    const timer = setTimeout(() => { void Promise.resolve(fn()).catch(() => {}); }, ms);
    if (timer && typeof timer.unref === "function") timer.unref();
    timers.push(timer);
  }

  function start() {
    if (ready || stopped) return;
    ready = true;
    syncRegistration({ reload: true });
    liveTimer = setInterval(() => { try { pruneDead(); } catch {} }, 1500);
    if (liveTimer && typeof liveTimer.unref === "function") liveTimer.unref();
    schedule(() => enumerate(), 3000);
    schedule(() => enumerate({ finalRestart: true }), 8000);
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    ready = false;
    for (const timer of timers) { try { clearTimeout(timer); } catch {} }
    if (liveTimer) { try { clearInterval(liveTimer); } catch {} liveTimer = null; }
    cancelRunningSteps();
    mediaGeneration += 1;
    try { iconRunner.cancel(); } catch {}
    unregisterDirection("next");
    unregisterDirection("prev");
    broadcastIfChanged();
  }

  function keymapChanged() {
    if (stopped) return;
    syncRegistration({ reload: true, force: true });
  }

  return { start, stop, handle, keymapChanged, getStatus: publicStatus };
}

module.exports = { createSwitcherHost };
