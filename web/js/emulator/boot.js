// 모바일 에뮬레이터 기능의 진입점. 가운데 탭 종류 하나와 rail 의 기기 화면을 연결한다.
//
// 소유 범위
//   탭 종류 "emulator" 의 등록과 탭마다의 화면 수명(붙이기 · 가리기 · 닫기), 전용 창으로 분리하고
//   되돌리는 일, 세로 열(배치 영역 "emulator")로 옮기고 되돌리는 일, rail 기기 화면의 가운데 무대
//   (.emu-stage)로 옮기고 되돌리는 일, rail 기기 화면과 채팅 패널 머리 버튼에서 기기를 여는 일.
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
//   탭으로 되돌린다. 사람이 기기를 열면 열이 기본 자리다(entry.home). 엔진이 꺼져 있으면 탭으로 연다.
//   rail 기기 화면은 기기만 보인다(가운데 탭 띠·dock 은 33-emulator.css 가 내린다). 같은 기기를 두 곳에
//   동시에 붙일 수 없으므로, 그 화면에 들어가면 지금 스페이스의 화면을 열이나 탭에서 떼어 무대로 옮기고,
//   나오면 home 자리로 되돌린다. 그동안 열은 비어 있다고 알린다(visible 이 거짓).
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
// tabId → { tab, space, el, pane, detached, inColumn, inStage, home, stageFrom, awayIndex, narrowed }
// home 은 사람이 고른 자리("column" | "tab")다. 에이전트가 연 화면은 비어 있고, 무대에서 나올 때 온 자리로 간다.
// narrowed 는 배치 엔진이 꺼져서 세로 열에서 탭으로 밀려났다는 표시다. 엔진이 다시 켜지면 이 표시가 있는 화면만
// 열로 돌아간다. home 만 보면 다른 기기에 열을 내준 화면이나 사람이 탭으로 옮긴 화면까지 되돌린다.
const mounted = new Map();
let column = null;       // 세로 열 요소(.app 의 자식)
let columnEntry = null;  // 지금 열에 있는 탭
let stage = null;        // rail 기기 화면의 가운데 무대(#center 의 자식)
let stageHost = null;    // 무대 안에서 화면이 붙는 요소
let stageEmpty = null;   // 무대에 화면이 없을 때의 안내
let stageEntry = null;   // 지금 무대에 있는 탭
let inRail = false;      // rail 기기 화면을 보고 있는가
let observer = null;
let sweepTimer = 0;
let devicePanel = null;

function spaceOfTab(tab) {
  for (const sp of getTabSpaces()) if (getTabs(sp).includes(tab)) return sp;
  return null;
}

function panelEl() { return document.getElementById(PANEL_ID); }

function columnShown() { return !!column && column.getClientRects().length > 0; }

function layoutOn() { return document.body.classList.contains("layout-on"); }

// 무대에서는 자리를 옮기는 단추를 두지 않는다. 그 화면에서 나가면 home 자리로 돌아간다.
// 세로 열의 화면은 탭 띠에 없어 탭의 닫기(×)로 닫을 수 없으므로 열에 닫기 단추를 둔다.
function paneActions(entry) {
  if (!column || entry.inStage) return [];
  return entry.inColumn
    ? [{ label: "탭으로", icon: "totab", title: "이 화면을 가운데 탭으로 옮깁니다", onClick: () => { entry.home = "tab"; entry.narrowed = false; toTab(entry, true); } },
      { label: "세로 열 닫기", icon: "close", title: "세로 열 닫기", onClick: () => closeColumn(entry) }]
    : [{ label: "세로 열로", icon: "tocolumn", title: "이 화면을 세로 열로 옮깁니다. 열의 자리는 레일의 레이아웃 편집에서 바꿉니다", onClick: () => { entry.home = "column"; entry.narrowed = false; toColumn(entry); } }];
}

function mountPaneFor(entry) {
  const box = entry.inColumn ? column : entry.inStage ? stageHost : entry.el;
  box.replaceChildren();
  entry.pane = mountEmulatorPane(box, {
    host,
    workspaceId: entry.space,
    deviceId: entry.tab.deviceId || null,
    onDeviceChange: (udid) => { entry.tab.deviceId = udid || null; devicePanel?.render(); },
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
  if (stageEntry && stageEntry.pane && inRail) return stageEntry;
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
  // 열의 주인이 바뀌었으니 폭 때문에 밀려나 있던 다른 화면은 더 이상 열로 돌아갈 자리가 없다.
  for (const other of mounted.values()) other.narrowed = false;
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
  entry.narrowed = false;
  entry.el.hidden = true;
  // 무대의 화면은 이미 탭 띠 밖에 있다. 창이 닫히면 reattach 가 탭 띠에 되돌린다.
  if (entry.inStage) { entry.inStage = false; stageEntry = null; renderStage(); }
  else takeOutOfStrip(entry);
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
  if (inRail && entry.space === targetSpace() && !stageEntry) toStage(entry);
}

// 그 스페이스에서 분리해 둔 에뮬레이터. 분리한 탭은 탭 저장소에 없으므로 entry 에서 찾는다.
function detachedEntryOf(sp) {
  for (const entry of mounted.values()) if (entry.detached && entry.space === sp) return entry;
  return null;
}

// 그 스페이스의 에뮬레이터 탭. 세로 열에 있는 탭도 탭 저장소에 없으므로 따로 본다.
function emulatorTabOf(sp) {
  return getTabs(sp).find((t) => t.kind === KIND) || (columnEntry && columnEntry.space === sp ? columnEntry.tab : null)
    || (stageEntry && stageEntry.space === sp ? stageEntry.tab : null);
}

// ---- rail 기기 화면의 무대 ----
// 무대도 세로 열처럼 탭을 탭 띠에서 빼고 화면을 다시 붙인다. 온 자리(stageFrom)와 그때 앞에 보이던 탭이었는지를
// 기억해 두었다가 나갈 때 home(없으면 온 자리)으로 돌려놓는다.
function toStage(entry) {
  if (!stage || entry.inStage || entry.detached || !mounted.has(entry.tab.id)) return;
  if (stageEntry) fromStage(stageEntry);
  if (entry.pane) { entry.pane.dispose(); entry.pane = null; }
  if (entry.inColumn) {
    entry.stageFrom = "column"; entry.wasActive = false;
    entry.inColumn = false; columnEntry = null; column.replaceChildren();
  } else {
    entry.stageFrom = "tab"; entry.wasActive = getActiveTabId(entry.space) === entry.tab.id;
    takeOutOfStrip(entry);
  }
  entry.inStage = true;
  entry.el.hidden = true;
  stageEntry = entry;
  mountPaneFor(entry);
  renderStage();
  ctx.renderTabs(); ctx.showActiveTab();
  notifyLayout();
  entry.pane.setVisible(inRail);
}

function fromStage(entry) {
  if (!entry.inStage) return;
  if (entry.pane) { entry.pane.dispose(); entry.pane = null; }
  entry.inStage = false;
  stageEntry = null;
  stageHost.replaceChildren();
  renderStage();
  const want = entry.home || entry.stageFrom;
  if (want === "column" && layoutOn()) {
    if (columnEntry) toTab(columnEntry, false);
    for (const other of mounted.values()) other.narrowed = false;
    entry.inColumn = true;
    columnEntry = entry;
    mountPaneFor(entry);
    notifyLayout();
    entry.pane.setVisible(true);
    return;
  }
  putBackInStrip(entry);
  mountPaneFor(entry);
  if (entry.wasActive) setActiveTab(entry.space, entry.tab.id);
  ctx.renderTabs(); ctx.showActiveTab();
  notifyLayout();
  entry.pane.setVisible(!entry.el.hidden && !panelEl()?.hidden);
}

// 무대가 빈 채로 같은 스페이스에 붙어 있는 화면은 rail 기기 화면에 있는 동안 에이전트가 연 것이다(사람이 연
// 화면은 enterRail·openEmulatorTab 이 무대로 옮긴다). 에이전트 경로는 사용자 화면을 옮기지 않으므로 여기서
// 알리고, 사람이 [여기서 보기]를 누를 때만 무대로 옮긴다.
function renderStage() {
  if (!stageEmpty) return;
  const sp = targetSpace();
  const away = sp ? detachedEntryOf(sp) : null;
  const waiting = !stageEntry && inRail && sp ? entryOfSpace(sp) : null;
  stageEmpty.hidden = !!stageEntry;
  stageHost.hidden = !stageEntry;
  const desc = stageEmpty.querySelector(".emu-stage-desc");
  if (desc) {
    desc.textContent = away
      ? "이 스페이스의 기기 화면은 별도 창에 있습니다. 그 창을 닫으면 여기로 돌아옵니다."
      : waiting
        ? (waiting.home == null ? "이 스페이스에 에이전트가 연 기기가 있습니다." : "이 스페이스에 열린 기기 화면이 있습니다.")
        : "왼쪽 목록에서 기기를 누르면 여기에 화면이 뜹니다. 작업 화면으로 돌아가면 세로 열에 붙습니다.";
  }
  const show = stageEmpty.querySelector(".emu-stage-show");
  if (show) show.hidden = !waiting || !!away;
}

function mountStage() {
  const center = document.getElementById("center");
  if (!center) return;
  stage = document.createElement("section");
  stage.className = "emu-stage";
  stage.setAttribute("aria-label", "모바일 기기 화면");
  stageHost = document.createElement("div");
  stageHost.className = "emu-stage-host";
  stageHost.hidden = true;
  stageEmpty = document.createElement("div");
  stageEmpty.className = "emu-stage-empty";
  stageEmpty.innerHTML = '<div class="emu-stage-empty-box"><div class="emu-stage-title">여기에 띄운 기기 화면이 없습니다</div><div class="emu-stage-desc"></div>'
    + '<button type="button" class="emu-btn emu-btn-pri emu-stage-show" hidden>여기서 보기</button></div>';
  stageEmpty.querySelector(".emu-stage-show").addEventListener("click", () => {
    const sp = targetSpace();
    const entry = sp && !stageEntry ? entryOfSpace(sp) : null;
    if (entry) toStage(entry); else renderStage();
  });
  stage.append(stageHost, stageEmpty);
  center.append(stage);
  renderStage();
}

// 지금 스페이스에서 이 창에 붙어 있는 화면(분리 창 제외).
function entryOfSpace(sp) {
  for (const entry of mounted.values()) if (entry.space === sp && !entry.detached) return entry;
  return null;
}

function closeEntry(tabId) {
  const entry = mounted.get(tabId);
  if (!entry) return;
  mounted.delete(tabId);
  entry.narrowed = false;
  if (entry === columnEntry) { columnEntry = null; notifyLayout(); }
  if (entry === stageEntry) { stageEntry = null; }
  renderStage();
  if (entry.pane) entry.pane.close();
  entry.el.remove();
  if (!mounted.size) stopWatching();
}

// 세로 열의 화면을 닫는다. 탭을 닫았을 때(sweep → closeEntry)와 같이 화면과 그 화면이 켠 세션을 끄고,
// 열이 비었다고 배치 엔진에 알려 열이 사라진다.
function closeColumn(entry) {
  if (entry !== columnEntry) return;
  closeEntry(entry.tab.id);
  column.replaceChildren();
}

function sweep() {
  const panelHidden = !!panelEl()?.hidden;
  for (const [tabId, entry] of mounted) {
    if (entry.detached) continue; // 분리한 탭은 탭 저장소에 없다. 창이 닫히면 되돌아온다.
    if (entry.inColumn) { if (entry.pane) entry.pane.setVisible(columnShown()); continue; }
    if (entry.inStage) { if (entry.pane) entry.pane.setVisible(inRail); continue; } // 무대의 탭도 탭 저장소에 없다
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
  renderStage();
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
    if (entry.inColumn || entry.inStage) return true;
    setCenterSpace(entry.space); setActiveTab(entry.space, entry.tab.id);
    ctx.renderTabs(); ctx.showActiveTab();
    return true;
  }
  // 탭에 없는 기기도 Iris 탭에 연다. false 를 돌려주면 서버가 Simulator.app 을 따로 띄운다.
  openEmulatorTab(udid ? { udid } : null);
  return true;
}

// 사람이 기기를 여는 경로(rail 목록 · 채팅 머리 단추 · 알림). rail 기기 화면에서는 무대에, 그 밖에서는 home 자리에
// 연다. 처음 여는 화면의 home 은 세로 열이고, 배치 엔진이 꺼져 있으면(창 폭이 좁으면) 가운데 탭으로 연다.
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
    if (entry && entry.pane) { entry.pane.dispose(); mountPaneFor(entry); if (entry.inColumn || entry.inStage) entry.pane.setVisible(entry.inColumn || inRail); }
  }
  let entry = mounted.get(tab.id);
  if (entry && entry.home == null) entry.home = "column";
  if (inRail) {
    const created = !entry;
    if (!entry) { entry = mountEntry(tab, sp, false); if (!entry) return; entry.home = "column"; }
    toStage(entry);
    // 여기서 처음 연 화면은 좁은 창에서 탭으로 돌아갈 때 앞에 보인다(넓은 창에서는 열로 간다).
    if (created) entry.wasActive = true;
    ctx.renderTabs();
    return;
  }
  if (entry && (entry.inColumn || entry.inStage)) return;
  if ((!entry || entry.home === "column") && layoutOn()) {
    if (!entry) { entry = mountEntry(tab, sp, false); if (!entry) return; entry.home = "column"; }
    toColumn(entry);
    return;
  }
  setCenterSpace(sp); setActiveTab(sp, tab.id);
  ctx.renderTabs(); ctx.showActiveTab();
  entry = mounted.get(tab.id);
  if (entry && entry.home == null) entry.home = "column";
}

// 세로 열은 처음부터 배치 영역으로 등록해 둔다. 비어 있어도 편집 모드에서 자리를 미리 정할 수 있다.
function mountColumn() {
  const app = document.querySelector(".app");
  if (!app) return;
  column = document.createElement("section");
  column.className = "emu-column";
  column.setAttribute("aria-label", "에뮬레이터 세로 열");
  app.append(column);
  registerLayoutRegion({ id: "emulator", label: "에뮬레이터", el: column, visible: () => !!columnEntry && !inRail, size: 360 });
  // body 의 class 는 자주 바뀌므로 layout-on 이 실제로 켜지고 꺼질 때만 움직인다.
  let wasOn = layoutOn();
  new MutationObserver(() => {
    const on = layoutOn();
    if (on === wasOn) return;
    wasOn = on;
    if (!on) {
      // 표식은 창 폭 때문에 밀려난 화면에만 붙인다. 분리 브라우저·메모 창 모드로 엔진이 꺼진 것은 폭이
      // 돌아와도 다시 켜지지 않으므로 되돌릴 대상이 아니다.
      const byMode = document.body.classList.contains("browser-mode") || document.body.classList.contains("memo-mode");
      if (columnEntry) { const entry = columnEntry; toTab(entry, true); entry.narrowed = !byMode; }
      return;
    }
    for (const entry of mounted.values()) {
      if (entry.narrowed && !entry.inColumn && !entry.inStage && !entry.detached) { entry.narrowed = false; toColumn(entry); }
    }
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
}

// 지금 스페이스의 기기 화면이 보는 기기. 목록의 선택 표시에 쓴다.
function currentUdid() {
  const sp = targetSpace();
  const entry = sp ? (entryOfSpace(sp) || detachedEntryOf(sp)) : null;
  if (!entry) return null;
  return entryDevice(entry).udid || entry.tab.deviceId || null;
}

// rail 기기 화면에 들어온다. 지금 스페이스의 화면을 무대로 옮기고, 세로 열은 비어 있다고 알린다.
function enterRail() {
  const wasIn = inRail;
  inRail = true;
  const sp = targetSpace();
  if (stageEntry && stageEntry.space !== sp) fromStage(stageEntry);
  const entry = sp ? entryOfSpace(sp) : null;
  if (entry && !entry.inStage) toStage(entry);
  renderStage();
  if (!wasIn) { notifyLayout(); sweep(); }
  const root = document.getElementById("emu-panel");
  const body = root && root.querySelector(".emu-rail-body");
  if (!body || devicePanel) { devicePanel?.refresh(); return; }
  devicePanel = mountDevicePanel(body, {
    host,
    onOpenDevice: openEmulatorTab,
    headTools: root.querySelector(".emu-rail-head"),
    currentUdid,
  });
}

// rail 이 다른 화면으로 갈 때마다 부른다(들어와 있지 않았어도 부른다).
function leaveRail() {
  if (!inRail) return;
  inRail = false;
  if (stageEntry) fromStage(stageEntry);
  notifyLayout();
  sweep();
}

export function initCapability(c) {
  ctx = c;
  host = c.acHost && c.acHost.emulator;
  if (!host) return {};
  registerTabView({ kind: KIND, panelId: PANEL_ID, render: (t) => renderTab(t) });
  host.onWindowClosed((m) => reattach(m && m.tab));
  mountColumn();
  mountStage();
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
  return { screen: { enter: enterRail, leave: leaveRail }, ws: { "emulator-ask": (m) => { void onAsk(m); } } };
}
