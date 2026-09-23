// 창 레이아웃(desklayout)의 진입점. 단축키·화면 변화 감지·15분 타이머·로그인 판정·잠금 감지·
// 알림·로그인 항목 등록을 여기서 연결하고, 저장·복원은 store.cjs·mac.cjs·geometry.cjs를 부른다.
//
// 소유 범위
//   initCapability(ctx)와 createHost(ctx). Electron 이벤트(단축키·화면·전원)를 받아 저장·복원 흐름을 조립한다.
//
// 제공 API
//   initCapability(ctx). 네이티브 기능 표(capabilities.cjs)가 호출하는 진입점.
//   createHost(ctx)는 검사·개발 확인용으로 함께 내보낸다.
//
// 의존 대상
//   ctx: app · screen · BrowserWindow · ipcMain · stateDir · isTrustedSender · log · error
//   (main.cjs가 준다). ctx에 없는 globalShortcut · powerMonitor · Notification은
//   require("electron")으로 직접 가져온다(emulator-host.cjs의 dialog와 같은 전례).
//
// 유지 조건
//   개발 실행(app.isPackaged === false)에서는 단축키·로그인 항목·자동 저장 타이머·자동 복원을
//   하지 않는다. 두 Iris가 같은 창을 동시에 움직이면 상태 소유자가 둘인 것과 같은 사고가 된다.
//   개발 확인은 IPC(ac-desklayout-save-now · ac-desklayout-restore-now)로 직접 부른다.
//   자동 복원(모니터 수 변경·로그인)은 위치·크기만 적용하고 데스크톱을 넘기지 않는다.
//   단축키 복원(ctrl+alt+R)만 데스크톱까지 되돌린다.
//   알림에 적는 수는 실제로 성공한 것만 센다.
//   이 기능은 기본 꺼짐(optIn)이라 사용자가 설정에서 켠 뒤에만 로드된다. 끌 때는 ac-desklayout-disable 로
//   단축키·타이머·감지를 내리고, 로그인 항목은 이 기능이 켠 경우(desk-layouts/login-item.json)에만 끈다.
//
// 영향 범위
//   store.cjs(저장본 읽기·쓰기)·mac.cjs(실제 창 조작)·geometry.cjs(짝짓기·좌표 계산)를 모두 묶는다.
//   현재 목록 확인: node bin/importers.mjs native/electron/desk-layout/host.cjs

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createStore } = require("./store.cjs");
const { createMac } = require("./mac.cjs");
const {
  monitorSlots, matchMonitorSlots, rectToRatio, ratioToRect, computeEdges, pinEdges, pairAppWindows,
} = require("./geometry.cjs");

const AUTO_SAVE_INTERVAL_MS = 15 * 60 * 1000;
const DISPLAY_CHANGE_DEBOUNCE_MS = 3000;
const PENDING_RESTORE_WINDOW_MS = 10 * 60 * 1000;
const PENDING_POLL_MS = 5000;
const LOGIN_WAIT_LIMIT_MS = 90 * 1000;
const LOGIN_POLL_MS = 2000;
const LOGIN_RETRY_DELAY_MS = 15 * 1000;
const LOGIN_START_DELAY_MS = 5000;
const SHORTCUT_ACCELS = { save: "Control+Alt+S", restore: "Control+Alt+R" };
const MOVE_BUDGET_SECONDS = 60;
const CONSECUTIVE_SAVE_FAILURE_ALERT = 3;
const IN_PLACE_TOLERANCE_PX = 2;

// 옛 init.lua의 SKIP_RELAUNCH에 개발용 Electron을 더했다. 옛 apps.json에 들어 있었고, 다시 띄우면 빈 Electron 창이 뜬다.
const SKIP_RELAUNCH_BUNDLES = new Set([
  "com.github.Electron",
  "com.apple.finder",
  "org.hammerspoon.Hammerspoon",
  "com.apple.ActivityMonitor",
  "com.anthropic.claudefordesktop",
  "com.runningwithcrayons.Alfred",
  "com.raycast.macos",
]);

const FAILURE_WORDS = {
  "window-not-found": "창을 찾지 못함",
  "frame-did-not-land": "크기 조정 거부",
  "no-safe-grab-point": "잡을 곳 없음",
  "desktop-switch-failed": "데스크톱 전환 실패",
  "window-did-not-follow": "창이 따라오지 않음",
  "window-gone": "창이 사라짐",
  "desktop-missing": "그 데스크톱이 없음",
  "time-budget": "시간 초과",
};

function displaysNow(screen) {
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().map((d) => ({
    id: d.id, primary: d.id === primary.id, bounds: d.bounds, workArea: d.workArea, label: d.label || "",
  }));
}

function displayContaining(displays, rect) {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  return displays.find((d) => cx >= d.bounds.x && cx < d.bounds.x + d.bounds.width
    && cy >= d.bounds.y && cy < d.bounds.y + d.bounds.height)
    || displays.find((d) => d.primary) || displays[0];
}

function near(a, b, tol) {
  return a && b && Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol
    && Math.abs(a.width - b.width) <= tol && Math.abs(a.height - b.height) <= tol;
}

function groupByBundle(list) {
  const map = new Map();
  for (const w of list) {
    if (!map.has(w.bundle)) map.set(w.bundle, []);
    map.get(w.bundle).push(w);
  }
  return map;
}

function label(entry) {
  const name = entry.current.appName || entry.current.bundle;
  const title = (entry.current.title || "").slice(0, 30);
  return title ? `${name}(${title})` : name;
}

function createHost(ctx) {
  const store = createStore({ fs: require("node:fs"), path: require("node:path"), stateDir: ctx.stateDir });
  const mac = ctx.mac || createMac({ execFile });
  const selfPid = ctx.selfPid || process.pid;
  const displayDebounceMs = ctx.displayDebounceMs ?? DISPLAY_CHANGE_DEBOUNCE_MS;   // 검사는 짧게 준다

  const state = {
    locked: false,
    monitorChangedAt: null,
    restoreEndedAt: null,
    // 네이티브 기능은 앱 준비 전에 부팅되고 screen 은 준비 뒤에만 읽을 수 있어, 여기서 읽지 않고 시작할 때 채운다.
    lastMonitorCount: 0,
    consecutiveSaveFailures: 0,
    pending: null,
    pendingTimer: null,
    displayDebounceTimer: null,
    autoSaveTimer: null,
    busy: false,
  };

  function notify(message) {
    if (ctx.notify) { ctx.notify(message); return; }
    try {
      const { Notification } = require("electron");
      if (Notification.isSupported()) new Notification({ title: "창 레이아웃", body: message }).show();
    } catch (e) { ctx.error && ctx.error("[desklayout] 알림 실패", e); }
  }

  // Iris 자신의 창: CG 창 번호 → BrowserWindow. getMediaSourceId()는 "window:<CGWindowID>:0" 이다.
  function ownWindowsByCgId() {
    const map = new Map();
    for (const win of (ctx.BrowserWindow ? ctx.BrowserWindow.getAllWindows() : [])) {
      try {
        if (win.isDestroyed()) continue;
        const m = /^window:(\d+):/.exec(win.getMediaSourceId());
        if (m) map.set(Number(m[1]), win);
      } catch {}
    }
    return map;
  }

  // 지금 창 목록. live 는 복원 계산에 쓰는 원본(전역 px), records 는 저장 형식.
  async function collect() {
    const listed = await mac.listWindows();
    if (!listed.ok) return { ok: false, reason: listed.reason, detail: listed.detail };
    const displays = displaysNow(ctx.screen);
    const slots = monitorSlots(displays);
    const slotById = new Map(slots.map((s) => [s.id, s.slot]));
    const own = ownWindowsByCgId();
    const live = [];
    for (const w of listed.windows) {
      const isOwn = w.pid === selfPid;
      const bw = isOwn ? own.get(w.cgId) : null;
      if (isOwn && (!bw || !bw.isVisible() || bw.isMinimized())) continue;
      const display = displayContaining(displays, w.rect);
      live.push({
        ...w,
        own: isOwn,
        winId: bw ? bw.id : null,
        title: w.title || (bw ? bw.getTitle() : ""),
        displayId: display.id,
        slot: slotById.get(display.id) || "main",
      });
    }
    const records = live.map((w) => {
      const area = displays.find((d) => d.id === w.displayId).workArea;
      return {
        bundle: w.bundle, appName: w.appName, pid: w.pid, cgId: w.cgId, title: w.title, slot: w.slot,
        rect: rectToRatio(w.rect, area), edges: computeEdges(w.rect, area), desktop: w.desktop, own: w.own,
      };
    });
    const monitors = slots.map((s) => {
      const d = displays.find((x) => x.id === s.id);
      return { id: s.id, slot: s.slot, label: d.label, bounds: d.bounds, workArea: d.workArea };
    });
    return { ok: true, locked: !!listed.locked, live, records, displays, slots, monitors, desktops: listed.desktops || [] };
  }

  // ── 저장 ────────────────────────────────────────────────────────────────
  async function saveNow(trigger) {
    // 사람이 저장한 배치가 기준이 되므로, 옛 저장본 자리로 옮기려던 보류 목록은 버린다(설계 5.3).
    if (trigger === "shortcut") await settlePending();
    if (state.busy) return { saved: false, reason: "busy" };
    try {
      const c = await collect();
      if (!c.ok) throw new Error(`창 목록 실패: ${c.reason}`);
      const decision = store.shouldSkipAutoSave({
        trigger,
        windowCount: c.records.length,
        locked: state.locked || c.locked,
        monitorChangedAt: state.monitorChangedAt,
        restoreEndedAt: state.restoreEndedAt,
      });
      state.consecutiveSaveFailures = 0;
      if (decision.skip) {
        if (trigger === "shortcut") notify(c.locked ? "잠금 화면에서는 저장하지 않습니다" : "저장할 창이 없습니다");
        return { saved: false, reason: decision.reason };
      }
      const monitorCount = c.displays.length;
      const result = store.writeLayout(monitorCount, { windows: c.records, monitors: c.monitors }, { force: trigger === "shortcut" });
      if (result.written) await saveApps();
      if (trigger === "shortcut") notify(`저장했습니다: 모니터 ${monitorCount}대, 창 ${c.records.length}개`);
      return { saved: !!result.written, reason: result.reason, monitorCount, windows: c.records.length };
    } catch (e) {
      state.consecutiveSaveFailures += 1;
      ctx.error && ctx.error("[desklayout] 저장 실패", e);
      if (state.consecutiveSaveFailures === CONSECUTIVE_SAVE_FAILURE_ALERT) notify("레이아웃 저장이 계속 실패하고 있습니다.");
      if (trigger === "shortcut") notify(`저장하지 못했습니다: ${e.message}`);
      return { saved: false, reason: "error" };
    }
  }

  async function saveApps() {
    const running = await mac.runningBundleIds();
    if (!running.ok) return;
    const selfBundle = ctx.selfBundle || "app.iris.console";
    const apps = running.regular.filter((b) => !SKIP_RELAUNCH_BUNDLES.has(b) && b !== selfBundle).map((bundle) => ({ bundle }));
    store.writeApps({ apps });
  }

  // ── 복원 계산 ────────────────────────────────────────────────────────────
  // 저장본과 지금 창을 짝짓고 각 창의 목표 사각형을 정한다.
  function planEntries(layout, c) {
    const savedMonitors = (layout.monitors || []).filter((m) => m && m.slot).map((m) => ({ id: m.id, slot: m.slot }));
    // 모니터 목록이 없는 저장본(창 기록에만 자리가 있는 경우)도 짝지을 수 있게 창의 자리를 보탠다.
    for (const w of layout.windows || []) {
      if (w.slot && !savedMonitors.some((m) => m.slot === w.slot)) savedMonitors.push({ id: `slot:${w.slot}`, slot: w.slot });
    }
    const slotMap = matchMonitorSlots(savedMonitors, c.slots);
    const primary = c.displays.find((d) => d.primary) || c.displays[0];
    const currentByBundle = groupByBundle(c.live);
    const entries = [];
    const missing = [];
    for (const [bundle, savedList] of groupByBundle(layout.windows || [])) {
      const { pairs, unmatchedSaved } = pairAppWindows(savedList, currentByBundle.get(bundle) || []);
      missing.push(...unmatchedSaved);
      for (const { saved, current } of pairs) {
        const display = c.displays.find((d) => d.id === slotMap.get(saved.slot)) || primary;
        const area = display.workArea;
        const to = pinEdges(ratioToRect(saved.rect, area), area, saved.edges);
        entries.push({
          key: `${current.pid}:${current.cgId}`, saved, current, to,
          inPlace: near(current.rect, to, IN_PLACE_TOLERANCE_PX),
          desktopOk: !saved.desktop || saved.desktop === current.desktop,
        });
      }
    }
    return { entries, missing };
  }

  function applyOwn(entry) {
    const win = ctx.BrowserWindow && ctx.BrowserWindow.fromId(entry.current.winId);
    if (!win || win.isDestroyed()) return { ok: false, reason: "window-not-found" };
    win.setBounds(entry.to);
    return near(win.getBounds(), entry.to, IN_PLACE_TOLERANCE_PX) ? { ok: true } : { ok: false, reason: "frame-did-not-land" };
  }

  // 지금 데스크톱에서 닿는 창에 위치·크기를 적용한다. 다른 데스크톱의 창은 돌려준다.
  async function applyReachable(entries) {
    const outcome = new Map();
    const foreign = [];
    const elsewhere = [];
    for (const e of entries) {
      if (e.inPlace) { outcome.set(e.key, { ok: true }); continue; }
      if (e.current.own) { outcome.set(e.key, applyOwn(e)); continue; }
      if (e.current.onCurrent) foreign.push(e); else elsewhere.push(e);
    }
    if (foreign.length) {
      const res = await mac.applyWindows(foreign.map((e) => ({ pid: e.current.pid, cgId: e.current.cgId, from: e.current.rect, to: e.to })));
      foreign.forEach((e, i) => {
        const r = res.ok ? res.results[i] : { ok: false, reason: res.reason };
        outcome.set(e.key, { ok: !!(r && r.ok), reason: r && r.reason });
      });
    }
    return { outcome, elsewhere };
  }

  // ── 자동 복원: 위치·크기만 ─────────────────────────────────────────────
  function stopPending() {
    if (state.pendingTimer) clearInterval(state.pendingTimer);
    state.pendingTimer = null;
    state.pending = null;
  }

  // 보류 확인은 5초마다 창 목록을 읽는다. 그 도중에 단축키가 들어오면 창 목록 호출이 겹쳐 거짓 실패가 나므로,
  // 보류를 멈추고 돌고 있던 확인이 끝나길 기다린다.
  async function settlePending() {
    stopPending();
    if (state.pendingRun) { try { await state.pendingRun; } catch {} }
  }

  // 다른 데스크톱에 있던 창은 사용자가 그 데스크톱으로 가서 창이 보이게 되면 그때 맞춘다(10분 동안).
  function startPending(layout, keys) {
    stopPending();
    if (!keys.size) return;
    state.pending = { deadline: Date.now() + PENDING_RESTORE_WINDOW_MS, layout, keys };
    state.pendingTimer = setInterval(() => {
      const p = state.pending;
      if (!p || Date.now() > p.deadline) { stopPending(); return; }
      if (state.busy || state.locked || state.pendingRun) return;
      state.pendingRun = (async () => {
        const c = await collect();
        if (!c.ok || c.locked || state.pending !== p) return;
        const { entries } = planEntries(p.layout, c);
        const ready = entries.filter((e) => p.keys.has(e.key) && e.current.onCurrent);
        if (!ready.length) return;
        const { outcome } = await applyReachable(ready);
        for (const e of ready) if (outcome.get(e.key) && outcome.get(e.key).ok) p.keys.delete(e.key);
        if (!p.keys.size && state.pending === p) stopPending();
      })().catch((e) => { ctx.error && ctx.error("[desklayout] 보류 창 맞춤 실패", e); })
        .finally(() => { state.pendingRun = null; });
    }, PENDING_POLL_MS);
  }

  async function restoreAuto(reason) {
    if (state.busy) return { restored: false, reason: "busy" };
    const layout = ctx.screen && store.readLayout(ctx.screen.getAllDisplays().length);
    if (!layout) return { restored: false, reason: "no-layout" };
    state.busy = true;
    try {
      const c = await collect();
      if (!c.ok) return { restored: false, reason: c.reason };
      if (c.locked || state.locked) return { restored: false, reason: "locked" };
      const { entries } = planEntries(layout.latest, c);
      const { outcome, elsewhere } = await applyReachable(entries);
      startPending(layout.latest, new Set(elsewhere.map((e) => e.key)));
      const placed = [...outcome.values()].filter((o) => o.ok).length;
      ctx.log && ctx.log(`[desklayout] 자동 복원(${reason}): 맞춤 ${placed}, 보류 ${elsewhere.length}`);
      return { restored: true, reason, placed, pending: elsewhere.length };
    } finally {
      state.restoreEndedAt = Date.now();
      state.busy = false;
    }
  }

  // ── 단축키 복원: 데스크톱까지 ───────────────────────────────────────────
  async function restoreWithDesktops() {
    await settlePending();
    if (state.busy) return { restored: false, reason: "busy" };
    const count = ctx.screen.getAllDisplays().length;
    const layout = store.readLayout(count);
    if (!layout) { notify(`모니터 ${count}대 레이아웃이 아직 없습니다`); return { restored: false, reason: "no-layout" }; }
    state.busy = true;
    try {
      const c = await collect();
      if (!c.ok) { notify(`복원하지 못했습니다: 창 목록 실패(${c.reason})`); return { restored: false, reason: c.reason }; }
      const { entries, missing } = planEntries(layout.latest, c);
      const { outcome, elsewhere } = await applyReachable(entries);

      // 모니터마다 데스크톱이 따로면 ctrl+화살표가 어느 모니터를 넘기는지 정할 수 없어 데스크톱 이동은 하지 않는다.
      const shared = c.desktops.length === 1;
      const order = shared ? c.desktops[0].order : [];
      const needVisit = entries.filter((e) => shared && (!e.desktopOk || elsewhere.includes(e)));
      const skippedDesktop = shared ? [] : entries.filter((e) => !e.desktopOk);

      let moved = 0;
      if (needVisit.length) {
        const visits = new Map();
        for (const e of needVisit) {
          const target = e.desktopOk ? null : e.saved.desktop;
          if (target && target > order.length) { outcome.set(e.key, { ok: false, reason: "desktop-missing" }); continue; }
          const at = e.current.desktop;
          if (!visits.has(at)) visits.set(at, []);
          // 지금 데스크톱의 창은 applyReachable 이 이미 to 로 옮겼다. 옛 사각형으로 찾으면 창을 못 찾는다.
          const framed = outcome.get(e.key);
          const from = framed && framed.ok && !e.current.own ? e.to : e.current.rect;
          visits.get(at).push({
            key: e.key, pid: e.current.pid, cgId: e.current.cgId, own: e.current.own,
            from, to: e.to, target,
          });
        }
        const here = order.indexOf(c.desktops[0].current) + 1;
        const plan = [...visits.entries()]
          .sort(([a], [b]) => (a === here ? -1 : b === here ? 1 : a - b))
          .map(([index, items]) => ({ index, items }));
        if (plan.length) {
          notify("창을 옮기는 중입니다. 끝날 때까지 마우스와 키보드를 쓰지 마세요.");
          const res = await mac.restoreAcrossDesktops({ order, visits: plan, budgetSeconds: MOVE_BUDGET_SECONDS });
          for (const v of plan) {
            for (const it of v.items) {
              const r = res.ok ? res.results[it.key] : { ok: false, reason: res.reason };
              // Iris 자기 창은 위치를 앞에서 setBounds로 맞췄으므로 그 결과도 함께 본다.
              const framedOwn = it.own ? outcome.get(it.key) : null;
              const ok = !!(r && r.ok) && (!framedOwn || framedOwn.ok);
              outcome.set(it.key, { ok, reason: ok ? null : ((r && r.reason) || (framedOwn && framedOwn.reason)) });
              if (ok && r.movedTo) moved += 1;
            }
          }
        }
      }

      const failed = entries.filter((e) => outcome.get(e.key) && !outcome.get(e.key).ok);
      const placed = entries.filter((e) => outcome.get(e.key) && outcome.get(e.key).ok).length;
      const lines = [`제자리 ${placed}개 · 데스크톱 이동 ${moved}개`];
      if (failed.length) {
        lines.push(`옮기지 못한 창: ${failed.map((e) => `${label(e)} ${FAILURE_WORDS[outcome.get(e.key).reason] || outcome.get(e.key).reason || ""}`.trim()).join(", ")}`);
      }
      if (skippedDesktop.length) lines.push(`모니터별 데스크톱 설정이라 데스크톱 이동은 하지 않았습니다(${skippedDesktop.length}개)`);
      if (missing.length) lines.push(`실행 중이 아닌 창 ${missing.length}개`);
      notify(lines.join("\n"));
      return { restored: true, placed, moved, failed: failed.length, missing: missing.length };
    } finally {
      state.restoreEndedAt = Date.now();
      state.busy = false;
    }
  }

  // ── 로그인 복원 ─────────────────────────────────────────────────────────

  // 로그인 항목으로 열렸을 때만 로그인 복원을 한다. 부팅 기준으로만 보면 로그아웃 후 로그인은 놓치고,
  // 기능을 처음 켜거나 Iris 를 늦게 켤 때 앱을 다시 띄우고 창을 옮겼다(실측: 부팅 9/16, 복원 9/23 03:14).
  function openedAtLogin() {
    try { return !!(ctx.app && ctx.app.getLoginItemSettings().wasOpenedAtLogin); } catch { return false; }
  }

  function relaunch(bundleId) {
    return new Promise((resolve) => execFile("open", ["-b", bundleId], () => resolve()));
  }

  // 다시 띄운 앱의 창만 센다. 재실행하지 않는 앱(Finder 등)의 창까지 기다리면 늘 시간 초과가 난다.
  async function waitForRelaunchedWindows(layout, launched) {
    const expected = new Map();
    for (const w of (layout && layout.windows) || []) {
      if (launched.has(w.bundle)) expected.set(w.bundle, (expected.get(w.bundle) || 0) + 1);
    }
    if (!expected.size) return true;
    const deadline = Date.now() + LOGIN_WAIT_LIMIT_MS;
    while (Date.now() < deadline) {
      const listed = await mac.listWindows();
      if (listed.ok) {
        const have = new Map();
        for (const w of listed.windows) have.set(w.bundle, (have.get(w.bundle) || 0) + 1);
        if ([...expected].every(([b, n]) => (have.get(b) || 0) >= n)) return true;
      }
      await new Promise((r) => setTimeout(r, LOGIN_POLL_MS));
    }
    return false;
  }

  async function loginRestore() {
    const appsFile = store.readApps();
    const bundles = new Set(((appsFile && appsFile.apps) || []).map((a) => a.bundle).filter(Boolean));
    const running = await mac.runningBundleIds();
    const runningSet = new Set(running.ok ? running.bundles : []);
    const launched = new Set();
    for (const bundle of bundles) {
      if (SKIP_RELAUNCH_BUNDLES.has(bundle) || runningSet.has(bundle)) continue;
      await relaunch(bundle);
      launched.add(bundle);
    }
    const layout = store.readLayout(ctx.screen.getAllDisplays().length);
    const filled = await waitForRelaunchedWindows(layout && layout.latest, launched);
    await restoreAuto("login");
    if (launched.size || !filled) {
      await new Promise((r) => setTimeout(r, LOGIN_RETRY_DELAY_MS));
      await restoreAuto("login-retry");
    }
    return { launched: [...launched], filled };
  }

  // ── 화면 변화 ───────────────────────────────────────────────────────────
  function onDisplaysChanged() {
    if (state.displayDebounceTimer) clearTimeout(state.displayDebounceTimer);
    state.displayDebounceTimer = setTimeout(async () => {
      const count = ctx.screen.getAllDisplays().length;
      if (count === state.lastMonitorCount) return; // 해상도만 바뀐 경우는 복원하지 않는다
      state.monitorChangedAt = Date.now();
      let r;
      try { r = await restoreAuto("display-change"); } catch (e) { ctx.error && ctx.error("[desklayout] 모니터 변경 복원 실패", e); }
      // 잠금 중이거나 다른 복원과 겹쳐 못 했으면 수를 확정하지 않는다. 잠금 해제나 다음 시도에서 다시 복원한다.
      if (r && (r.reason === "locked" || r.reason === "busy")) {
        if (r.reason === "busy") state.displayDebounceTimer = setTimeout(onDisplaysChanged, displayDebounceMs);
        return;
      }
      state.lastMonitorCount = count;
    }, displayDebounceMs);
  }

  return {
    saveNow, restoreAuto, restoreWithDesktops, loginRestore, openedAtLogin, onDisplaysChanged,
    collect, planEntries, stopPending,
    importLegacy: () => store.importFromWsSnap({ wsSnapDir: path.join(os.homedir(), ".ws-snap") }),
    state,
  };
}

// 로그인 항목을 이 기능이 켰는지 기록한다. 사용자가 원래 켜 둔 것은 기능을 꺼도 그대로 둔다.
function loginItemRecordPath(stateDir) { return path.join(stateDir, "desk-layouts", "login-item.json"); }

function claimLoginItem(ctx) {
  const record = loginItemRecordPath(ctx.stateDir);
  if (ctx.app.getLoginItemSettings().openAtLogin) return;   // 이미 켜져 있다. 이 기능이 켠 것이면 기록이 남아 있다
  ctx.app.setLoginItemSettings({ openAtLogin: true });
  fs.mkdirSync(path.dirname(record), { recursive: true });
  fs.writeFileSync(record, JSON.stringify({ version: 1, turnedOnAt: new Date().toISOString() }) + "\n");
}

function releaseLoginItem(ctx) {
  const record = loginItemRecordPath(ctx.stateDir);
  if (!fs.existsSync(record)) return "untouched";
  ctx.app.setLoginItemSettings({ openAtLogin: false });
  fs.rmSync(record, { force: true });
  return "off";
}

function initCapability(ctx) {
  const packaged = ctx.app && ctx.app.isPackaged === true;
  const host = createHost(ctx);
  // 켜진 동안 등록한 것을 되돌리는 함수. 개발 실행은 아무것도 등록하지 않으므로 되돌릴 것도 없다.
  let teardown = () => ({ ok: true, loginItem: "untouched" });

  // 개발 확인용 IPC. 신뢰된 발신자만 받는다.
  ctx.ipcMain.handle("ac-desklayout-save-now", async (e) => {
    if (!ctx.isTrustedSender(e)) return { ok: false, error: "신뢰되지 않은 발신자" };
    return { ok: true, result: await host.saveNow("shortcut") };
  });
  ctx.ipcMain.handle("ac-desklayout-restore-now", async (e) => {
    if (!ctx.isTrustedSender(e)) return { ok: false, error: "신뢰되지 않은 발신자" };
    return { ok: true, result: await host.restoreAuto("manual") };
  });
  ctx.ipcMain.handle("ac-desklayout-disable", (e) => {
    if (!ctx.isTrustedSender(e)) return { ok: false, error: "신뢰되지 않은 발신자" };
    try { return teardown(); } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
  });

  // 개발 실행은 여기서 멈춘다. 단축키·로그인 항목·자동 저장·자동 복원은 설치 앱에서만 켠다.
  if (!packaged) return;
  // 이 함수는 앱 준비 전에 불린다. screen·globalShortcut·Notification 은 준비 뒤에만 쓸 수 있다(실측: 준비 전에
  // screen 을 읽어 예외가 났고 기능 전체가 조용히 빠졌다).
  ctx.app.whenReady()
    .then(() => { teardown = startPackaged(ctx, host); })
    .catch((e) => {
      ctx.error && ctx.error("[desklayout] 시작 실패", e);
      // 로그인 항목을 켠 뒤에 실패했을 수 있다. 끌 때 기록에 따라 되돌린다.
      teardown = () => ({ ok: true, loginItem: releaseLoginItem(ctx) });
    });
}

// 설치 앱에서 켜진 뒤 앱 준비가 끝나면 부른다. 등록한 것을 되돌리는 함수를 돌려준다.
function startPackaged(ctx, host) {
  host.state.lastMonitorCount = ctx.screen.getAllDisplays().length;
  const importResult = host.importLegacy();
  if (importResult.imported) ctx.log && ctx.log("[desklayout] 옛 ~/.ws-snap 저장본을 가져왔다", importResult.monitorCounts);

  const { globalShortcut, powerMonitor, Notification, systemPreferences } = require("electron");
  // 다른 앱의 창을 읽고 옮기려면 손쉬운 사용 권한이 필요하다. 없으면 알리고 시스템 요청 창을 띄운다.
  if (!systemPreferences.isTrustedAccessibilityClient(false)) {
    if (Notification.isSupported()) {
      new Notification({ title: "창 레이아웃", body: "창을 옮기려면 손쉬운 사용 권한이 필요합니다. 시스템 설정에서 Iris 를 허용해 주세요." }).show();
    }
    systemPreferences.isTrustedAccessibilityClient(true);
  }
  const saveOk = globalShortcut.register(SHORTCUT_ACCELS.save, () => { host.saveNow("shortcut"); });
  const restoreOk = globalShortcut.register(SHORTCUT_ACCELS.restore, () => { host.restoreWithDesktops(); });
  if ((!saveOk || !restoreOk) && Notification.isSupported()) {
    new Notification({ title: "창 레이아웃", body: "단축키(ctrl+alt+S/R) 등록에 실패했습니다. 다른 앱이 이미 쓰고 있을 수 있습니다." }).show();
  }
  const lock = () => { host.state.locked = true; };
  // 잠금 중에 모니터 수가 바뀌었으면 그때 못 한 복원을 지금 한다.
  const unlock = () => {
    host.state.locked = false;
    if (ctx.screen.getAllDisplays().length !== host.state.lastMonitorCount) host.onDisplaysChanged();
  };
  const power = [["lock-screen", lock], ["unlock-screen", unlock], ["suspend", lock], ["resume", unlock]];
  for (const [name, fn] of power) powerMonitor.on(name, fn);
  const displayEvents = ["display-added", "display-removed", "display-metrics-changed"];
  for (const name of displayEvents) ctx.screen.on(name, host.onDisplaysChanged);

  host.state.autoSaveTimer = setInterval(() => { host.saveNow("auto"); }, AUTO_SAVE_INTERVAL_MS);

  try { claimLoginItem(ctx); } catch (e) { ctx.error && ctx.error("[desklayout] 로그인 항목 등록 실패", e); }

  let loginTimer = null;
  if (host.openedAtLogin()) {
    // 로그인 직후 다른 초기화와 겹치지 않도록 잠깐 늦춘다.
    loginTimer = setTimeout(() => { host.loginRestore(); }, LOGIN_START_DELAY_MS);
  }

  const stopRunning = () => {
    try { globalShortcut.unregister(SHORTCUT_ACCELS.save); globalShortcut.unregister(SHORTCUT_ACCELS.restore); } catch {}
    clearInterval(host.state.autoSaveTimer);
    clearTimeout(loginTimer);
    clearTimeout(host.state.displayDebounceTimer);
    host.stopPending();
  };
  ctx.app.once("will-quit", () => { try { stopRunning(); } catch {} });
  let released = false;
  return () => {
    if (released) return { ok: true, loginItem: "untouched" };
    released = true;
    stopRunning();
    for (const [name, fn] of power) powerMonitor.removeListener(name, fn);
    for (const name of displayEvents) ctx.screen.removeListener(name, host.onDisplaysChanged);
    return { ok: true, loginItem: releaseLoginItem(ctx) };
  };
}

module.exports = { initCapability, createHost, SKIP_RELAUNCH_BUNDLES };
