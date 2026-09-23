// 모바일 에뮬레이터 기능의 진입점. 가운데 탭 종류 하나와 rail 의 기기 화면을 연결한다.
//
// 소유 범위
//   탭 종류 "emulator" 의 등록과 탭마다의 화면 수명(붙이기 · 가리기 · 닫기), 전용 창으로 분리하고
//   되돌리는 일, 세로 열(배치 영역 "emulator")로 옮기고 되돌리는 일, rail 기기 화면과 채팅 패널 머리
//   버튼에서 탭을 여는 일.
//   에뮬레이터 화면 자체는 pane.js, 기기·설정 화면은 devices-panel.js, 머리 버튼은 launch-button.js 가 소유한다.
//
// 제공 API
//   panelHtml 과 initCapability(ctx). 훅: emulator.sketchSource(보이는 앱 화면을 스케치에 준다),
//   emulator.focus(기기가 열린 탭으로 화면을 옮긴다). WS: emulator-ask 에 emulator-reply 로 답한다.
//
// 의존 대상
//   앱 셸의 탭 등록표(core/tab-views.js)·탭 저장소(center/tab-store.js)·훅(core/hooks.js), ctx 의 acHost ·
//   getSelectedSpaceId · consoleSpace · renderTabs · showActiveTab. 스케치 기능은 sketch.open 훅으로만 부른다.
//   세로 열은 core/layout-regions.js 에 등록하고, 자리와 크기는 앱 셸의 배치 엔진이 정한다.
//
// 유지 조건
//   스페이스마다 에뮬레이터 탭은 하나다. Orca 가 작업 트리마다 하나를 두고, 활성 에뮬레이터도 작업
//   트리마다 하나라서 같은 스페이스에 탭이 둘이면 서로의 스트림을 멈춘다.
//   탭 닫기와 가려짐은 앱 셸이 알려 주지 않는다(tab 훅은 뷰어 기능 이름이다). 그래서 자기 패널의
//   hidden 변화를 보고, 탭 저장소에서 자기 탭이 사라졌는지를 확인한다. 닫힌 탭의 화면을 정리하지
//   않으면 serve-sim 헬퍼와 기기가 계속 켜져 있다.
//   분리한 창은 같은 화면 모듈을 쓴다. 분리하면 탭의 화면은 dispose(세션 유지)하고 탭을 가운데 탭 띠에서
//   뺀다(스페이스 브라우저의 탭 분리와 같다). 창이 닫히면 탭을 원래 위치에 되돌리고 화면을 다시 붙인다.
//   두 곳이 동시에 같은 기기를 붙들면 Orca 규칙상 한쪽이 끊긴다.
//   세로 열도 분리와 같다. 탭을 탭 띠에서 빼고 화면을 열로 다시 붙인다. 열은 하나라서 다른 탭을 열로
//   보내면 먼저 있던 것은 탭으로 돌아간다. 배치 엔진이 꺼지면(창 폭 820px 이하) 열이 보이지 않으므로
//   탭으로 되돌린다.
//   MCP 앱 도구는 여기 열린 탭의 기기만 조작한다(server/emulator-bridge.js 가 묻는다). 에이전트가 탭을
//   열 때는 사용자가 보는 화면을 옮기지 않고 그 스페이스에 탭만 만들어 기기를 붙인다.
//
// 영향 범위
//   web/emulator-window 의 전용 창 페이지, native/electron/emulator/emulator-host.cjs 의 IPC.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs web/js/emulator/boot.js
import { callHook, hasHook, provide } from "../core/hooks.js";
import { registerTabView } from "../core/tab-views.js";
import { addTab, ensureTabSpace, getActiveTabId, getCenterSpace, getTabs, getTabSpaces, removeTab, setActiveTab, setCenterSpace } from "../center/tab-store.js";
import { notifyLayout, registerLayoutRegion } from "../core/layout-regions.js";
import { mountEmulatorPane } from "./pane.js";
import { mountDevicePanel } from "./devices-panel.js";
import { mountLaunchButton } from "./launch-button.js";

export const panelHtml = `
  <div class="emu-rail-head"><span class="emu-rail-title">모바일 에뮬레이터</span></div>
  <div class="emu-rail-body"></div>
`;

const KIND = "emulator";
const PANEL_ID = "emulatorview";
const SWEEP_MS = 2000;

let ctx = null;
let host = null;
// tabId → { tab, space, el, pane, detached, inColumn, awayIndex }
const mounted = new Map();
let column = null;       // 세로 열 요소(.app 의 자식)
let columnEntry = null;  // 지금 열에 있는 탭
let observer = null;
let sweepTimer = 0;
let devicePanel = null;

function spaceOfTab(tab) {
  for (const sp of getTabSpaces()) if (getTabs(sp).includes(tab)) return sp;
  return null;
}

function panelEl() { return document.getElementById(PANEL_ID); }

function columnShown() { return !!column && column.getClientRects().length > 0; }

function paneActions(entry) {
  if (!column) return [];
  return [entry.inColumn
    ? { label: "탭으로", title: "이 화면을 가운데 탭으로 되돌립니다", onClick: () => toTab(entry, true) }
    : { label: "세로 열로", title: "이 화면을 세로 열로 옮깁니다. 열의 자리는 레일의 레이아웃 편집에서 바꿉니다", onClick: () => toColumn(entry) }];
}

function mountPaneFor(entry) {
  const box = entry.inColumn ? column : entry.el;
  box.replaceChildren();
  entry.pane = mountEmulatorPane(box, {
    host,
    workspaceId: entry.space,
    deviceId: entry.tab.deviceId || null,
    onDeviceChange: (udid) => { entry.tab.deviceId = udid || null; },
    onRequestDetach: () => detach(entry),
    detachable: !entry.inColumn,
    actions: paneActions(entry),
    // 스케치 기능이 꺼져 있으면 훅이 없어 버튼도 두지 않는다.
    onSketch: hasHook("sketch.open") ? () => callHook("sketch.open") : undefined,
  });
}

// 이 창에서 지금 보이는 에뮬레이터 화면. 분리했거나 다른 탭·다른 rail 화면이 앞에 있으면 없다.
function visibleEntry() {
  if (!panelEl()?.hidden) {
    for (const entry of mounted.values()) {
      if (entry.pane && !entry.detached && !entry.inColumn && !entry.el.hidden) return entry;
    }
  }
  if (columnEntry && columnEntry.pane && columnShown()) return columnEntry;
  return null;
}

// 탭 띠에서 빼고 넣기. 분리 창과 세로 열이 같이 쓴다. 에뮬레이터 탭은 저장되지 않는 이 창만의 탭이라,
// 빼 둔 동안의 위치는 entry 가 갖는다.
function takeOutOfStrip(entry) {
  const list = getTabs(entry.space);
  entry.awayIndex = list.indexOf(entry.tab);
  if (removeTab(entry.space, entry.tab) && getActiveTabId(entry.space) === entry.tab.id) {
    setActiveTab(entry.space, list.length ? list[list.length - 1].id : null);
  }
}

function putBackInStrip(entry) {
  const list = ensureTabSpace(entry.space);
  if (!list.includes(entry.tab)) list.splice(Math.max(0, Math.min(entry.awayIndex ?? list.length, list.length)), 0, entry.tab);
}

function toColumn(entry) {
  if (!document.body.classList.contains("layout-on")) { ctx.showToast?.("창 폭이 좁아 세로 열을 쓸 수 없습니다"); return; }
  if (entry.inColumn || entry.detached || !mounted.has(entry.tab.id)) return;
  if (columnEntry) toTab(columnEntry, false);
  if (entry.pane) { entry.pane.dispose(); entry.pane = null; }
  takeOutOfStrip(entry);
  entry.inColumn = true;
  entry.el.hidden = true;
  columnEntry = entry;
  mountPaneFor(entry);
  ctx.renderTabs(); ctx.showActiveTab();
  notifyLayout();
  entry.pane.setVisible(true);
}

// focus 가 참이면 되돌린 탭을 앞에 보인다. 다른 탭이 열을 차지해서 밀려날 때는 보던 화면을 바꾸지 않는다.
function toTab(entry, focus) {
  if (!entry.inColumn) return;
  if (entry.pane) { entry.pane.dispose(); entry.pane = null; }
  entry.inColumn = false;
  columnEntry = null;
  column.replaceChildren();
  putBackInStrip(entry);
  mountPaneFor(entry);
  if (focus) { setCenterSpace(entry.space); setActiveTab(entry.space, entry.tab.id); }
  ctx.renderTabs(); ctx.showActiveTab();
  notifyLayout();
  entry.pane.setVisible(!entry.el.hidden && !panelEl()?.hidden);
}

// 창은 메인 프로세스(emulator-host.cjs)가 preload 를 붙여 만든다. window.open 으로 연 창에는 acHost 가 없다.
// 스페이스 브라우저의 탭 분리처럼 창이 실제로 뜬 뒤에만 탭을 가운데 탭 띠에서 뺀다.
async function detach(entry) {
  const res = await host.openWindow({ space: entry.space, tab: entry.tab.id, device: entry.tab.deviceId || null });
  if (!res || !res.ok) { ctx.showToast?.("분리 창을 열지 못했습니다"); return; }
  if (entry.detached || !mounted.has(entry.tab.id)) return;
  if (entry.pane) { entry.pane.dispose(); entry.pane = null; }
  entry.detached = true;
  entry.el.hidden = true;
  takeOutOfStrip(entry);
  ctx.renderTabs(); ctx.showActiveTab();
}

// 분리 창이 닫히면 탭을 원래 위치로 돌려놓는다.
function reattach(tabId) {
  const entry = mounted.get(tabId);
  if (!entry || !entry.detached) return;
  entry.detached = false;
  putBackInStrip(entry);
  mountPaneFor(entry);
  ctx.renderTabs(); ctx.showActiveTab();
  entry.pane.setVisible(!entry.el.hidden && !panelEl()?.hidden);
}

// 그 스페이스에서 분리해 둔 에뮬레이터. 분리한 탭은 탭 저장소에 없으므로 entry 에서 찾는다.
function detachedEntryOf(sp) {
  for (const entry of mounted.values()) if (entry.detached && entry.space === sp) return entry;
  return null;
}

// 그 스페이스의 에뮬레이터 탭. 세로 열에 있는 탭도 탭 저장소에 없으므로 따로 본다.
function emulatorTabOf(sp) {
  return getTabs(sp).find((t) => t.kind === KIND) || (columnEntry && columnEntry.space === sp ? columnEntry.tab : null);
}

function closeEntry(tabId) {
  const entry = mounted.get(tabId);
  if (!entry) return;
  mounted.delete(tabId);
  if (entry === columnEntry) { columnEntry = null; notifyLayout(); }
  if (entry.pane) entry.pane.close();
  entry.el.remove();
  if (!mounted.size) stopWatching();
}

function sweep() {
  const panelHidden = !!panelEl()?.hidden;
  for (const [tabId, entry] of mounted) {
    if (entry.detached) continue; // 분리한 탭은 탭 저장소에 없다. 창이 닫히면 되돌아온다.
    if (entry.inColumn) { if (entry.pane) entry.pane.setVisible(columnShown()); continue; }
    if (!spaceOfTab(entry.tab)) { closeEntry(tabId); continue; }
    if (entry.pane) entry.pane.setVisible(!panelHidden && !entry.el.hidden);
  }
}

function startWatching() {
  const panel = panelEl();
  if (panel && !observer) {
    observer = new MutationObserver(sweep);
    observer.observe(panel, { attributes: true, attributeFilter: ["hidden"] });
  }
  if (!sweepTimer) sweepTimer = setInterval(sweep, SWEEP_MS);
}

function stopWatching() {
  if (observer) { observer.disconnect(); observer = null; }
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = 0; }
}

function renderTab(tab) {
  const panel = panelEl();
  if (!panel) return;
  const space = spaceOfTab(tab);
  if (!space) return;
  let entry = mounted.get(tab.id);
  if (!entry) entry = mountEntry(tab, space, true);
  if (!entry) return;
  for (const other of mounted.values()) other.el.hidden = other !== entry || other.inColumn;
  sweep();
}

// 탭은 지금 가운데에 보이는 스페이스에 연다. 앱 셸의 탭 전환(screen-switch.js)도 같은 순서로 고른다.
function targetSpace() { return getCenterSpace() || ctx.consoleSpace?.() || ctx.getSelectedSpaceId?.(); }

function mountEntry(tab, space, show) {
  const panel = panelEl();
  if (!panel) return null;
  const el = document.createElement("div");
  el.className = "emu-tab-host";
  el.hidden = !show;
  panel.append(el);
  const entry = { tab, space, el, pane: null, detached: false, inColumn: false };
  mounted.set(tab.id, entry);
  mountPaneFor(entry);
  startWatching();
  return entry;
}

// 탭의 기기. 분리한 탭은 이 창에 화면이 없으므로 마지막으로 붙었던 기기를 쓴다.
function entryDevice(entry) {
  if (entry.detached) return { udid: entry.tab.deviceId || null, name: entry.tab.label || "", attached: !!entry.tab.deviceId };
  return entry.pane ? entry.pane.current() : { udid: null, name: "", attached: false };
}

function listTabs() {
  const out = [];
  for (const entry of mounted.values()) {
    const d = entryDevice(entry);
    if (d.attached && d.udid) out.push({ space: entry.space, tab: entry.tab.id, udid: d.udid, name: d.name || entry.tab.label || "" });
  }
  return out;
}

function findDevice(devices, want) {
  const w = String(want || "").trim(); if (!w) return null;
  const lw = w.toLowerCase();
  return devices.find((d) => d.udid === w) || devices.find((d) => (d.name || "") === w)
    || devices.find((d) => String(d.udid || "").toLowerCase().startsWith(lw)) || null;
}

// 에이전트 요청으로 그 스페이스의 에뮬레이터 탭을 연다(없으면 만들고, 기기를 주면 그 기기로 바꾼다).
// 사용자가 보는 탭은 바꾸지 않는다. 기기가 붙을 때까지 기다렸다가 결과를 돌려준다.
async function openForAgent(space, want, timeoutMs) {
  const sp = space || targetSpace();
  if (!sp) return { ok: false, error: "에뮬레이터 탭을 열 스페이스가 없습니다." };
  let device = null;
  if (want) {
    const res = await host.rpc("emulator.availability", {}).catch(() => null);
    const devices = (res && res.ok && res.result && res.result.devices) || [];
    device = findDevice(devices, want);
    if (!device) return { ok: false, error: `그런 기기가 없습니다: ${want}. 있는 기기: ${devices.map((d) => d.name).join(" · ") || "(없음)"}` };
    if (device.isAvailable === false) return { ok: false, error: `쓸 수 없는 기기입니다: ${device.name}` };
  }
  // 분리해 둔 에뮬레이터가 있으면 그 창이 이 스페이스의 에뮬레이터다. 탭을 새로 만들면 같은 스페이스에 둘이 된다.
  const away = detachedEntryOf(sp);
  if (away) {
    const d = entryDevice(away);
    if (!d.udid) return { ok: false, error: "이 스페이스의 에뮬레이터는 분리 창에 있고 기기가 붙어 있지 않습니다. 그 창에서 기기를 켜세요." };
    if (device && d.udid !== device.udid && d.name !== device.name) return { ok: false, error: `이 스페이스의 에뮬레이터는 분리 창에서 ${d.name || d.udid} 를 보고 있습니다. 기기를 바꾸려면 그 창에서 바꾸세요.` };
    return { ok: true, space: sp, tab: away.tab.id, udid: d.udid, name: d.name || away.tab.label || "" };
  }
  let tab = emulatorTabOf(sp);
  if (!tab) {
    tab = addTab(sp, { id: "emu-" + Date.now().toString(36), kind: KIND, label: device ? device.name : "에뮬레이터", deviceId: device ? device.udid : null });
    ctx.renderTabs();
  }
  let entry = mounted.get(tab.id);
  // 새로 붙이는 화면이면 그 뒤에 붙는 기기가 요청한 기기다. 꺼져 있던 AVD 는 이름으로 요청하고 시리얼로 붙어서
  // 값으로 대조할 수 없다.
  let fresh = !entry;
  const cur = entry ? entryDevice(entry) : null;
  if (device && !(cur && cur.attached && (cur.udid === device.udid || cur.name === device.name))) {
    tab.deviceId = device.udid; tab.label = device.name || tab.label;
    if (entry && entry.pane && !entry.detached) { entry.pane.dispose(); mountPaneFor(entry); fresh = true; if (entry.inColumn) entry.pane.setVisible(true); }
    ctx.renderTabs();
  }
  if (!entry) entry = mountEntry(tab, sp, false);
  if (!entry) return { ok: false, error: "에뮬레이터 화면을 붙일 자리가 없습니다." };
  const until = Date.now() + timeoutMs;
  for (;;) {
    const d = entryDevice(entry);
    if (d.attached && d.udid && (!device || fresh || d.udid === device.udid || d.name === device.name)) {
      return { ok: true, space: sp, tab: tab.id, udid: d.udid, name: d.name || tab.label || "" };
    }
    if (d.error && !d.loading) return { ok: false, error: d.error };
    if (!mounted.has(tab.id)) return { ok: false, error: "에뮬레이터 탭이 닫혔습니다." };
    if (Date.now() > until) return { ok: false, error: "기기가 제시간에 켜지지 않았습니다. Iris 에뮬레이터 탭을 확인하세요." };
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function onAsk(m) {
  const reply = (body) => ctx.wsSend({ type: "emulator-reply", id: m.id, ...body });
  try {
    if (m.kind === "list") { reply({ ok: true, tabs: listTabs() }); return; }
    if (m.kind === "open") { reply(await openForAgent(m.space || null, m.device || null, Math.max(5000, Number(m.wait) || 120000))); return; }
    reply({ ok: false, error: "모르는 요청: " + m.kind });
  } catch (e) { reply({ ok: false, error: String((e && e.message) || e) }); }
}

// 알림의 [그 앱으로]. 그 기기가 열린 탭으로 화면을 옮긴다. 없으면 false 를 돌려 앱 셸이 원래 동작을 한다.
function focusDevice(udid) {
  for (const entry of mounted.values()) {
    if (entryDevice(entry).udid !== udid) continue;
    if (entry.detached) { void host.openWindow({ space: entry.space, tab: entry.tab.id, device: entry.tab.deviceId || null }); return true; }
    if (entry.inColumn) return true;
    setCenterSpace(entry.space); setActiveTab(entry.space, entry.tab.id);
    ctx.renderTabs(); ctx.showActiveTab();
    return true;
  }
  // 탭에 없는 기기도 Iris 탭에 연다. false 를 돌려주면 서버가 Simulator.app 을 따로 띄운다.
  openEmulatorTab(udid ? { udid } : null);
  return true;
}

function openEmulatorTab(device) {
  const sp = targetSpace();
  if (!sp) { ctx.showToast?.("스페이스를 먼저 고르세요"); return; }
  const away = detachedEntryOf(sp);
  if (away) { void host.openWindow({ space: sp, tab: away.tab.id, device: away.tab.deviceId || null }); return; }
  let tab = emulatorTabOf(sp);
  if (!tab) {
    tab = addTab(sp, { id: "emu-" + Date.now().toString(36), kind: KIND, label: "에뮬레이터", deviceId: null });
  }
  if (device && device.udid && tab.deviceId !== device.udid) {
    tab.deviceId = device.udid;
    tab.label = device.name || tab.label;
    const entry = mounted.get(tab.id);
    if (entry && entry.pane) { entry.pane.dispose(); mountPaneFor(entry); if (entry.inColumn) entry.pane.setVisible(true); }
  }
  if (columnEntry && columnEntry.tab === tab) return;
  setCenterSpace(sp); setActiveTab(sp, tab.id);
  ctx.renderTabs(); ctx.showActiveTab();
}

// 세로 열은 처음부터 배치 영역으로 등록해 둔다. 비어 있어도 편집 모드에서 자리를 미리 정할 수 있다.
function mountColumn() {
  const app = document.querySelector(".app");
  if (!app) return;
  column = document.createElement("section");
  column.className = "emu-column";
  column.setAttribute("aria-label", "에뮬레이터 세로 열");
  app.append(column);
  registerLayoutRegion({ id: "emulator", label: "에뮬레이터", el: column, visible: () => !!columnEntry, size: 360 });
  new MutationObserver(() => {
    if (columnEntry && !document.body.classList.contains("layout-on")) toTab(columnEntry, true);
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
}

function enterRail() {
  const root = document.getElementById("emu-panel");
  const body = root && root.querySelector(".emu-rail-body");
  if (!body || devicePanel) { devicePanel?.refresh(); return; }
  devicePanel = mountDevicePanel(body, { host, onOpenDevice: openEmulatorTab });
}

export function initCapability(c) {
  ctx = c;
  host = c.acHost && c.acHost.emulator;
  if (!host) return {};
  registerTabView({ kind: KIND, panelId: PANEL_ID, render: (t) => renderTab(t) });
  host.onWindowClosed((m) => reattach(m && m.tab));
  mountColumn();
  mountLaunchButton({
    host,
    hasTab: () => { const sp = targetSpace(); return !!sp && !!emulatorTabOf(sp); },
    onOpen: (device) => openEmulatorTab(device),
  });
  // 스케치는 보이는 에뮬레이터가 있으면 브라우저 탭 대신 그 앱 화면을 찍는다.
  provide("emulator.sketchSource", () => {
    const entry = visibleEntry();
    return entry ? { shot: () => entry.pane.snapshot() } : null;
  });
  provide("emulator.focus", (udid) => focusDevice(udid));
  // ⌘⇧D 는 앱 셸(panel/touch-drag.js)이 활성 webview 가 있을 때만 스케치로 보내고, 없으면 분리 브라우저
  // 창으로 넘긴다. 에뮬레이터 화면을 보는 중이면 그보다 먼저(window 캡처 단계) 받아 스케치를 연다.
  window.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || (e.key || "").toLowerCase() !== "d") return;
    if (!visibleEntry() || !hasHook("sketch.open")) return;
    e.preventDefault(); e.stopImmediatePropagation();
    callHook("sketch.open");
  }, true);
  return { screen: { enter: enterRail }, ws: { "emulator-ask": (m) => { void onAsk(m); } } };
}
