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
//   emulator.focus(기기가 열린 탭으로 화면을 옮긴다), emulator.designate(기기 대기 지정을 만든다).
//   WS: emulator-ask 에 답하고 emulator.target-pending-result를 받아 채팅 입력에 구분자를 붙인다.
//
// 의존 대상
//   앱 셸의 탭 등록표(core/tab-views.js)·탭 저장소(center/tab-store.js)·훅(core/hooks.js), ctx 의 acHost ·
//   getSelectedSpaceId · consoleSpace · renderTabs · showActiveTab. 스케치 기능은 sketch.open 훅으로만 부른다.
//   세로 열은 core/layout-regions.js 에 등록하고, 자리와 크기는 앱 셸의 배치 엔진이 정한다.
//
// 유지 조건
//   탭마다 실행 키를 유지한다. 내부 배치는 같은 pane DOM을 옮기며 전원을 바꾸지 않는다.
//   외부 창 이동은 dispose로 화면만 정리한다. 명시적인 닫기만 close로 기기를 종료한다.
//   내부 기기는 열마다 탭으로 묶고 선택한 pane만 보인다. 자리 기록은 기기별로 보존한다.
//
// 영향 범위
//   web/emulator-window 의 전용 창 페이지, native/electron/emulator/emulator-host.cjs 의 IPC.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs web/js/emulator/boot.js
import { callHook, hasHook, provide } from "../core/hooks.js";
import { registerTabView } from "../core/tab-views.js";
import { addTab, ensureTabSpace, getActiveTabId, getCenterSpace, getTabs, getTabSpaces, removeTab, setActiveTab, setCenterSpace } from "../center/tab-store.js";
import { notifyLayout, registerLayoutRegion } from "../core/layout-regions.js";
import { noticeBlock } from "../panel/xterm-wiring.js";
import { mountEmulatorPane } from "./pane.js";
import { returnPlace, pickTargetAt } from "./controls.js";
import { PLACES_KEY, mergePlaces, parsePlaces, placeRecord, restoreDevice, restoreTarget } from "./places.js";
import { mountDevicePanel } from "./devices-panel.js";
import { bootAllowed, chooseAgentDevice } from "./agent-device.js";
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
const groups = new Map();
let columnEntry = null;  // 지금 열에 있는 탭
let stage = null;        // rail 기기 화면의 가운데 무대(#center 의 자식)
let stageHost = null;    // 무대 안에서 화면이 붙는 요소
let stageEmpty = null;   // 무대에 화면이 없을 때의 안내
let stageEntry = null;   // 지금 무대에 있는 탭
let inRail = false;      // rail 기기 화면을 보고 있는가
let observer = null;
let sweepTimer = 0;
let devicePanel = null;
const pendingDesignations = new Map();
// 자리 기록(places.js). pendingPlaces 는 스페이스가 아직 안 보여 복원 못 한 기록, quitting 은 앱 종료 중(저장 중지)
let pendingPlaces = [];
let quitting = false;
let lastSavedPlaces = "";
const agentReservations = new Set();
const agentOpenRequests = new Map();
let agentAllocationTail = Promise.resolve();

function spaceOfTab(tab) {
  for (const sp of getTabSpaces()) if (getTabs(sp).includes(tab)) return sp;
  return null;
}

function panelEl() { return document.getElementById(PANEL_ID); }


function layoutOn() { return document.body.classList.contains("layout-on"); }

// 내부 화면은 같은 조작으로 열 분리·모으기·닫기를 제공한다.
function paneActions(entry) {
  return [
    { label: "새 세로 열", icon: "tocolumn", title: "새 세로 열로 분리", onClick: () => {
      entry.group = entry.tab.id;
      entry.home = "column";
      if (inRail) toStage(entry); else toColumn(entry);
      renderGroups();
    } },
    { label: "탭으로 모으기", icon: "totab", title: "기본 열의 탭으로 모으기", onClick: () => {
      entry.group = "emulator";
      entry.home = "column";
      if (inRail) toStage(entry); else toColumn(entry);
      renderGroups();
    } },
    { label: "닫기", icon: "close", title: "이 기기 화면 닫기", onClick: () => {
      removeTab(entry.space, entry.tab);
      closeEntry(entry.tab.id);
      ctx.renderTabs(); ctx.showActiveTab();
    } },
  ];
}

function mountPaneFor(entry) {
  if (!entry.tools) entry.tools = document.createElement("div");
  entry.tools.className = "emu-group-tools";
  entry.pane = mountEmulatorPane(entry.el, {
    host, workspaceId: emuKey(entry), deviceId: entry.tab.deviceKey || entry.tab.deviceId || null,
    headerHost: entry.tools, fixedDevice: true,
    onDeviceChange: (udid) => { entry.tab.deviceId = udid || null; devicePanel?.render(); renderGroups(); },
    onRequestDetach: () => detach(entry), detachable: true, actions: paneActions(entry),
    onSketch: hasHook("sketch.open") ? () => callHook("sketch.open") : undefined,
    onPick: hasHook("pick.toggle") ? () => callHook("pick.toggle") : undefined,
    pickOn: () => !!callHook("pick.mode"),
    onRecord: hasHook("record.set") ? () => toggleRecord() : undefined,
    recordOn: () => !!callHook("record.on"),
  });
  renderGroups();
}

function ensureGroup(id = "emulator") {
  if (groups.has(id)) return groups.get(id);
  const el = id === "emulator" && column ? column : document.createElement("section");
  el.className = "emu-column";
  el.setAttribute("aria-label", "에뮬레이터 세로 열");
  if (!el.parentNode) document.querySelector(".app").append(el);
  const rail = document.createElement("section");
  rail.className = "emu-group";
  stageHost?.append(rail);
  const head = document.createElement("div");
  head.className = "emu-group-head tabbar-row";
  const tabs = document.createElement("div");
  tabs.className = "emu-group-tabs tabstrip";
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "에뮬레이터");
  const body = document.createElement("div");
  body.className = "emu-group-body";
  head.append(tabs); el.append(head, body);
  const group = { id, el, rail, head, tabs, body, active: null };
  groups.set(id, group);
  registerLayoutRegion({ id, label: "에뮬레이터", el, visible: () => !inRail && [...mounted.values()].some(e => e.inColumn && (e.group || "emulator") === id), size: 360 });
  return group;
}

function selectGroup(entry) {
  const group = ensureGroup(entry.group);
  const focused = group.tabs.contains(document.activeElement);
  group.active = entry.tab.id;
  renderGroups();
  if (focused) group.tabs.querySelector('[aria-selected="true"]')?.focus();
  savePlaces();
}

function renderGroups() {
  if (!column || !stageHost) return;
  for (const entry of mounted.values()) if (entry.inColumn || entry.inStage) ensureGroup(entry.group);
  for (const group of groups.values()) {
    const entries = [...mounted.values()].filter(e => !e.detached && (e.group || "emulator") === group.id &&
      (inRail ? e.inStage : e.inColumn));
    const selected = entries.find(e => e.tab.id === group.active) || entries[0];
    group.active = selected?.tab.id || group.active;
    group.rail.hidden = !inRail || !entries.length;
    const parent = inRail ? group.rail : group.el;
    if (group.head.parentNode !== parent) parent.append(group.head, group.body);
    group.tabs.replaceChildren();
    group.head.querySelectorAll(".emu-group-tools").forEach(el => el.remove());
    for (const entry of entries) {
      const tab = document.createElement("button");
      tab.type = "button"; tab.className = "ctab" + (entry === selected ? " active" : "");
      tab.dataset.tab = entry.tab.id;
      tab.id = "emu-group-tab-" + entry.tab.id;
      entry.el.setAttribute("aria-labelledby", tab.id);
      const label = document.createElement("span");
      label.className = "cname";
      label.textContent = entry.tab.label || "에뮬레이터";
      tab.title = label.textContent;
      tab.append(label);
      tab.setAttribute("role", "tab"); tab.setAttribute("aria-selected", String(entry === selected));
      tab.setAttribute("aria-controls", entry.el.id);
      tab.tabIndex = entry === selected ? 0 : -1;
      tab.addEventListener("click", () => selectGroup(entry));
      tab.addEventListener("keydown", event => {
        const i = entries.indexOf(entry);
        const n = event.key === "ArrowRight" ? (i + 1) % entries.length : event.key === "ArrowLeft" ? (i + entries.length - 1) % entries.length : event.key === "Home" ? 0 : event.key === "End" ? entries.length - 1 : -1;
        if (n < 0) return;
        event.preventDefault(); selectGroup(entries[n]);
        group.tabs.children[n]?.focus();
      });
      group.tabs.append(tab);
      if (entry.el.parentNode !== group.body) group.body.append(entry.el);
      entry.el.hidden = entry !== selected;
      entry.pane?.setVisible(entry === selected);
    }
    if (selected?.tools) group.head.append(selected.tools);
  }
  for (const entry of mounted.values()) {
    if (entry.detached || entry.inColumn || entry.inStage) continue;
    if (entry.el.parentNode !== panelEl()) panelEl()?.append(entry.el);
    if (entry.tools && entry.tools.parentNode !== entry.el) entry.el.prepend(entry.tools);
  }
  columnEntry = [...mounted.values()].find(e => e.inColumn && !e.el.hidden) || null;
  stageEntry = [...mounted.values()].find(e => e.inStage && !e.el.hidden) || null;
  renderStage();
  notifyLayout();
}

// 이 창에서 지금 보이는 에뮬레이터 화면. 분리했거나 다른 탭·다른 rail 화면이 앞에 있으면 없다.
function visibleEntry() {
  if (!panelEl()?.hidden) {
    for (const entry of mounted.values()) {
      if (entry.pane && !entry.detached && !entry.inColumn && !entry.el.hidden) return entry;
    }
  }
  if (columnEntry && columnEntry.pane && !inRail && layoutOn()) return columnEntry;
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
  if (!layoutOn()) { toTab(entry, true); entry.narrowed = true; return; }
  if (entry.detached || !mounted.has(entry.tab.id)) return;
  if (!entry.inColumn && !entry.inStage) takeOutOfStrip(entry);
  entry.inStage = false; entry.inColumn = true;
  entry.group ||= "emulator";
  ensureGroup(entry.group).active = entry.tab.id;
  renderGroups();
  ctx.renderTabs(); ctx.showActiveTab();
}

function toTab(entry, focus) {
  if (entry.detached) return;
  entry.inColumn = false; entry.inStage = false;
  putBackInStrip(entry);
  renderGroups();
  if (focus) { setCenterSpace(entry.space); setActiveTab(entry.space, entry.tab.id); }
  ctx.renderTabs(); ctx.showActiveTab();
}

// 창은 메인 프로세스(emulator-host.cjs)가 preload 를 붙여 만든다. window.open 으로 연 창에는 acHost 가 없다.
// 스페이스 브라우저의 탭 분리처럼 창이 실제로 뜬 뒤에만 탭을 가운데 탭 띠에서 뺀다.
// restore: 앱 재시작 복원({ home, bounds, connect }). 창 위치와 기기 켜기는 복원 때만
async function detach(entry, restore = null) {
  if (entry.moving || entry.detached) return;
  entry.moving = true;
  const home = restore ? restore.home : entry.inColumn ? "column" : entry.inStage ? "stage" : "strip";
  const res = await host.openWindow({ space: emuKey(entry), tab: entry.tab.id, device: entry.tab.deviceKey || entry.tab.deviceId || null,
    pickAvailable: hasHook("pick.toggle"), recordAvailable: hasHook("record.set"),
    pickOn: !!callHook("pick.mode"), recordOn: !!callHook("record.on"),
    bounds: restore ? restore.bounds : null, connect: restore ? !!restore.connect : !!entry.pane?.current().loading }).catch(() => null);
  entry.moving = false;
  if (!res || !res.ok) {
    ctx.showToast?.("분리 창을 열지 못했습니다", { level: "err" });
    // 복원 실패: 탭 띠에 넣어 둔 탭에 화면 붙이기
    if (restore && mounted.has(entry.tab.id) && !entry.pane && !entry.detached) {
      mountPaneFor(entry);
      if (restore.connect) { entry.booting = true; entry.pane.connect(); }
      ctx.renderTabs(); ctx.showActiveTab();
    }
    return;
  }
  if (!mounted.has(entry.tab.id)) { await host.closeWindow({ tab: entry.tab.id }); return; }
  if (entry.detached) return;
  if (!restore) entry.running = !!(entry.pane && entry.pane.current().attached);
  if (entry.pane) { entry.pane.dispose(); entry.pane = null; }
  entry.detached = true;
  entry.detachHome = home;
  entry.narrowed = false;
  entry.el.hidden = true;
  if (!entry.inStage && !entry.inColumn) takeOutOfStrip(entry);
  entry.inStage = false; entry.inColumn = false;
  entry.el.remove(); entry.tools?.remove();
  renderGroups();
  ctx.renderTabs(); ctx.showActiveTab();
  savePlaces();
}

// 분리 창이 닫히면 탭을 원래 위치로 돌려놓는다.
function reattach(tabId) {
  const entry = mounted.get(tabId);
  if (!entry || !entry.detached) return;
  entry.detached = false;
  const place = returnPlace(entry.detachHome, layoutOn());
  entry.detachHome = null;
  putBackInStrip(entry);
  mountPaneFor(entry);
  ctx.renderTabs(); ctx.showActiveTab();
  entry.pane.setVisible(!entry.el.hidden && !panelEl()?.hidden);
  if ((place === "stage" || inRail && entry.space === targetSpace()) && inRail) toStage(entry);
  else if (place === "column") toColumn(entry);
  else { entry.el.hidden = false; setCenterSpace(entry.space); setActiveTab(entry.space, entry.tab.id); ctx.renderTabs(); ctx.showActiveTab(); }
  savePlaces();
}

// 그 스페이스에서 분리해 둔 에뮬레이터. 분리한 탭은 탭 저장소에 없으므로 entry 에서 찾는다.
function detachedEntryOf(sp) {
  for (const entry of mounted.values()) if (entry.detached && entry.space === sp && !entry.tab.owner) return entry;
  return null;
}

// 에이전트 세션(pane)이 켠 자기 에뮬레이터. 스페이스 공용 탭과 따로 두어 같은 스페이스의 세션끼리 기기를 뺏지 않는다.
// 지목으로 소유가 옮겨 가면 탭은 원래 스페이스에 남으므로 스페이스로 거르지 않는다. 둘이면 기기가 붙은 탭
function ownerEntryOf(owner) {
  let first = null;
  for (const entry of mounted.values()) {
    if (entry.tab.owner !== owner) continue;
    if (entryDevice(entry).attached) return entry;
    first = first || entry;
  }
  return first;
}

// 번들은 worktree 값마다 기기 하나만 붙이므로 모든 탭에 독립된 값을 넘긴다.
// 소유가 옮겨 가도 값이 바뀌지 않고, 재시작 복원 때도 같은 탭 id 로 같은 값이 나온다.
function emuKey(entry) {
  return `iris:emulator:${entry.tab.id}`;
}

// 다른 탭이 쥔 기기. 붙는 중인 탭은 아직 붙지 않았어도 고른 기기(tab.deviceId)를 쥐고 있다.
// Android 는 켜기 전 AVD 이름, 붙은 뒤 시리얼이라 붙은 기기는 이름도 넣는다.
function devicesHeldBy(except, reuseIdle = false) {
  const held = new Set(agentReservations);
  for (const entry of mounted.values()) {
    if (entry === except) continue;
    const d = entryDevice(entry);
    if (reuseIdle && !entry.tab.owner && !d.attached && !d.loading && !entry.moving) continue;
    const id = d.attached ? d.udid : entry.tab.deviceId;
    if (id) held.add(id);
    if (entry.tab.deviceKey) held.add(entry.tab.deviceKey);
    if (d.attached && d.name && /^emulator-\d+$/.test(d.udid || "")) held.add(d.name);
  }
  return held;
}

// 사용자가 기기를 다른 세션에 지목하면 그 기기를 띄운 세션 소유 탭도 그 세션 것이 된다.
// 이전 세션이 다시 기기를 찾을 때 이 탭을 자기 것으로 보고 기기를 바꾸지 않게 한다.
function reownDevices(devices, owner) {
  const want = new Set(devices || []);
  let moved = 0;
  for (const entry of mounted.values()) {
    if (entry.tab.owner === owner) continue;
    const d = entryDevice(entry);
    if ((d.udid && want.has(d.udid)) || (entry.tab.deviceId && want.has(entry.tab.deviceId)) || (entry.tab.deviceKey && want.has(`avd:${entry.tab.deviceKey}`))) {
      entry.tab.owner = owner;
      moved++;
    }
  }
  if (moved) savePlaces();
  return moved;
}

// 그 스페이스의 에뮬레이터 탭. 세로 열에 있는 탭도 탭 저장소에 없으므로 따로 본다.
function emulatorTabOf(sp) {
  return [...mounted.values()].find(e => e.space === sp && !e.tab.owner && !e.detached)?.tab
    || getTabs(sp).find(t => t.kind === KIND && !t.owner);
}

function toStage(entry) {
  if (!stage || entry.detached || !mounted.has(entry.tab.id)) return;
  if (!entry.inStage) {
    entry.stageFrom = entry.inColumn ? "column" : "tab";
    entry.wasActive = getActiveTabId(entry.space) === entry.tab.id;
    if (!entry.inColumn) takeOutOfStrip(entry);
  }
  entry.inColumn = false; entry.inStage = true;
  entry.group ||= "emulator";
  ensureGroup(entry.group).active = entry.tab.id;
  renderGroups();
  ctx.renderTabs(); ctx.showActiveTab();
}

function fromStage(entry) {
  if (!entry.inStage) return;
  if ((entry.home || entry.stageFrom) === "column" && layoutOn()) toColumn(entry);
  else toTab(entry, entry.wasActive);
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
  for (const group of groups.values()) stageHost.append(group.rail);
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
  for (const entry of mounted.values()) if (entry.space === sp && !entry.detached && (!entry.tab.owner || entry.home != null)) return entry;
  return null;
}

function closeEntry(tabId) {
  const entry = mounted.get(tabId);
  if (!entry) return;
  mounted.delete(tabId);
  entry.narrowed = false;

  if (entry.pane) entry.pane.close();
  entry.el.remove(); entry.tools?.remove();
  renderGroups();
  if (!mounted.size) stopWatching();
  savePlaces();
}

function sweep() {
  const panelHidden = !!panelEl()?.hidden;
  for (const [tabId, entry] of mounted) {
    if (entry.detached) continue; // 분리한 탭은 탭 저장소에 없다. 창이 닫히면 되돌아온다.
    if (entry.inColumn) { if (entry.pane) entry.pane.setVisible(!entry.el.hidden && !inRail && layoutOn()); continue; }
    if (entry.inStage) { if (entry.pane) entry.pane.setVisible(inRail && !entry.el.hidden); continue; } // 무대의 탭도 탭 저장소에 없다
    if (!spaceOfTab(entry.tab)) { closeEntry(tabId); continue; }
    if (entry.pane) entry.pane.setVisible(!panelHidden && !entry.el.hidden);
  }
  savePlaces();
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
  for (const other of mounted.values()) if (!other.inColumn && !other.inStage) other.el.hidden = other !== entry;
  sweep();
}

// 탭은 지금 가운데에 보이는 스페이스에 연다. 앱 셸의 탭 전환(screen-switch.js)도 같은 순서로 고른다.
function targetSpace() { return getCenterSpace() || ctx.consoleSpace?.() || ctx.getSelectedSpaceId?.(); }

function mountEntry(tab, space, show) {
  const panel = panelEl();
  if (!panel) return null;
  const el = document.createElement("div");
  el.className = "emu-tab-host";
  el.id = "pane-" + tab.id;
  el.setAttribute("role", "tabpanel");
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
  if (entry.detached) return { udid: entry.tab.deviceId || null, name: entry.tab.label || "", attached: !!entry.running };
  const current = entry.pane ? entry.pane.current() : { udid: null, name: "", attached: false };
  if (current.loading && entry.running) return { ...current, udid: entry.tab.deviceId, name: entry.tab.label, attached: true };
  if (current.attached) entry.running = true;
  else if (!current.loading) entry.running = false;
  return current;
}

function persistentDeviceId(entry, udid) {
  const key = entry.tab.deviceKey;
  return /^emulator-\d+$/.test(udid || "") && key && !/^emulator-\d+$/.test(key) ? key : null;
}

function listTabs() {
  const out = [];
  for (const entry of mounted.values()) {
    const d = entryDevice(entry);
    if (d.attached && d.udid) out.push({ space: entry.space, tab: entry.tab.id, udid: d.udid, name: d.name || entry.tab.label || "", owner: entry.tab.owner || null, persistentId: persistentDeviceId(entry, d.udid) });
  }
  return out;
}

function findDevice(devices, want) {
  const w = String(want || "").trim(); if (!w) return null;
  const lw = w.toLowerCase();
  const exact = devices.find(d => d.udid === w);
  if (exact) return exact;
  const named = devices.filter(d => (d.name || "") === w);
  if (named.length) return named.length === 1 ? named[0] : null;
  const prefixed = devices.filter(d => String(d.udid || "").toLowerCase().startsWith(lw));
  return prefixed.length === 1 ? prefixed[0] : null;
}

// 에이전트 요청으로 그 스페이스의 에뮬레이터 탭을 연다(없으면 만들고, 기기를 주면 그 기기로 바꾼다).
// 사용자가 보는 탭은 바꾸지 않는다. 기기가 붙을 때까지 기다렸다가 결과를 돌려준다.
function openForAgent(space, want, timeoutMs, options = {}) {
  const key = options.owner && !options.additional && !want ? options.owner : null;
  if (key && agentOpenRequests.has(key)) return agentOpenRequests.get(key);
  const request = openForAgentRequest(space, want, timeoutMs, options).finally(() => {
    if (key) agentOpenRequests.delete(key);
  });
  if (key) agentOpenRequests.set(key, request);
  return request;
}

function capacityFailure(gate, limit) {
  return { ok: false, code: "capacity", running: gate.running,
    error: gate.reason === "disk" ? "디스크 여유가 부족해 기기를 추가하거나 켜지 않습니다."
      : `동시에 켤 수 있는 기기 수(${limit}대)에 닿았습니다.` };
}

async function openAllocatedForAgent(sp, owner, own, want, timeoutMs, { additional, limit, diskOk, reservedDevices = [] }) {
  let unlock;
  const prior = agentAllocationTail;
  agentAllocationTail = new Promise(resolve => { unlock = resolve; });
  let device;
  await prior;
  try {
    const res = await host.rpc("emulator.availability", {});
    if (!res?.ok) return { ok: false, error: res?.error?.message || "기기 목록을 확인하지 못했습니다." };
    const devices = res.result?.devices || [];
    let source;
    if (want) {
      source = findDevice(devices, want);
      if (!source) return { ok: false, error: "원본 기기를 하나로 확인할 수 없습니다. 정확한 기기 ID를 지정하세요." };
    } else {
      const settings = await host.getSettings();
      if (!settings?.ok) return { ok: false, error: settings?.error || "기본 기기 설정을 읽지 못했습니다." };
      const preferred = (!additional && own?.tab.deviceKey) || settings.settings?.mobileEmulatorDefaultDeviceUdid || null;
      source = chooseAgentDevice({ devices, preferred });
      if (!source && preferred) return { ok: false, error: "저장된 기기를 실행할 수 없습니다. 기기 설정을 확인하세요." };
      if (!source) {
        const gate = bootAllowed({ devices, device: { state: "Shutdown" }, limit, diskOk, booting: bootingCount(devices) });
        if (!gate.ok) return capacityFailure(gate, limit);
        const result = await host.ensureDefaultDevice();
        if (!result?.ok) return { ok: false, error: result?.error || "기본 기기를 준비하지 못했습니다." };
        source = result.device;
        devices.push(source);
      }
    }
    if (source.isAvailable === false || source.runnable === false) return { ok: false, error: "원본 기기를 실행할 수 없습니다." };
    const busy = devicesHeldBy(additional ? null : own, true);
    for (const id of reservedDevices) busy.add(String(id).startsWith("avd:") ? String(id).slice(4) : id);
    if (additional && want) { busy.add(source.udid); if (source.persistentId) busy.add(source.persistentId); }
    device = chooseAgentDevice({ devices, preferred: source.udid, inUse: busy });
    const gate = bootAllowed({ devices, device: device || { state: "Shutdown" }, limit, diskOk, booting: bootingCount(devices) });
    if (!gate.ok) return capacityFailure(gate, limit);
    if (!device) {
      if (source.canDuplicate === false || !host.createDevice) return { ok: false, error: "같은 기종의 기기를 추가할 수 없습니다. 설치 도구를 확인하세요." };
      const result = await host.createDevice({ platform: source.runtime === "Android" ? "android" : "ios", sourceDevice: source.persistentId || source.udid, sourceName: source.name });
      if (!result?.ok) return { ok: false, error: result?.error || "같은 기종의 기기를 추가하지 못했습니다." };
      device = result.device;
      if (!device?.udid || busy.has(device.udid)) return { ok: false, error: "추가한 기기의 독립 ID를 확인하지 못했습니다." };
    }
    agentReservations.add(device.udid);
  } finally { unlock(); }
  try {
    const idle = findDeviceEntry(device);
    const entry = idle && !idle.tab.owner && !entryDevice(idle).attached ? idle : additional ? null : own;
    const claimed = entry && !entry.tab.owner;
    if (claimed) entry.tab.owner = owner;
    let connected = false;
    try {
      const result = await openOwnedForAgent(entry?.space || sp, owner, entry, device, !additional, timeoutMs, additional);
      connected = result.ok;
      return result;
    } finally {
      if (!connected && claimed && entry.tab.owner === owner) {
        await entry.pane?.stop();
        entry.tab.owner = null;
        savePlaces();
      }
    }
  } finally { agentReservations.delete(device.udid); }
}

async function openForAgentRequest(space, want, timeoutMs, { owner = null, limit = null, diskOk = true, additional = false, reservedDevices = [] } = {}) {
  const sp = space || targetSpace();
  if (!sp) return { ok: false, error: "에뮬레이터 탭을 열 스페이스가 없습니다." };
  if (additional && !owner) return { ok: false, error: "추가 기기를 열 세션이 없습니다." };
  const own = owner ? ownerEntryOf(owner) : null;
  if (owner && (additional || !want && !(own && entryDevice(own).attached))) {
    return openAllocatedForAgent(sp, owner, own, want, timeoutMs, { additional, limit, diskOk, reservedDevices });
  }
  let device = null;
  if (!owner && !want && !emulatorTabOf(sp) && !detachedEntryOf(sp)) {
    const result = await host.ensureDefaultDevice();
    if (!result?.ok) return { ok: false, error: result?.error || "기본 기기를 준비하지 못했습니다" };
    device = result.device;
  }
  // 세션 소유 탭에 이미 붙은 기기는 목록을 다시 받지 않고 그대로 쓴다.
  if (want) {
    const res = await host.rpc("emulator.availability", {}).catch(() => null);
    const devices = (res && res.ok && res.result && res.result.devices) || [];
    device = findDevice(devices, want);
    if (!device) return { ok: false, error: `기기를 하나로 확인할 수 없습니다: ${want}. 기기 ID로 지정하세요.` };
    if (device.isAvailable === false || device.runnable === false) return { ok: false, error: `쓸 수 없는 기기입니다: ${device.name}` };
    if (owner) {
      const gate = bootAllowed({ devices, device, limit, diskOk, booting: bootingCount(devices) });
      if (!gate.ok) {
        return { ok: false, code: "capacity", running: gate.running,
          error: gate.reason === "disk"
            ? `디스크 여유가 부족해 기기를 더 켜지 않습니다(켜진 기기 ${gate.running}대).`
            : `이 컴퓨터에서 동시에 켤 수 있는 기기 수(${limit}대)에 닿았습니다(켜진 기기 ${gate.running}대). 끝난 세션의 기기를 이 세션에 지목하세요.` };
      }
    }
  }
  const existing = device ? findDeviceEntry(device) : null;
  if (existing && existing !== own) {
    const current = entryDevice(existing);
    if (current.attached) return { ok: true, space: existing.space, tab: existing.tab.id, udid: current.udid, name: current.name, owner: existing.tab.owner || null };
    if (existing.detached) return { ok: false, error: "지정한 기기는 외부 창에서 꺼져 있습니다. 그 창에서 켜세요." };
    return waitAgentDevice(existing.space, existing.tab, existing, device, timeoutMs);
  }
  if (owner) return openOwnedForAgent(sp, owner, own, device, !want, timeoutMs);
  // 기기를 지정하지 않은 요청은 이 스페이스에 이미 열린 화면을 재사용한다.
  const away = device ? findDeviceEntry(device) : detachedEntryOf(sp);
  if (away?.detached) {
    const d = entryDevice(away);
    if (!d.udid) return { ok: false, error: "이 스페이스의 에뮬레이터는 분리 창에 있고 기기가 붙어 있지 않습니다. 그 창에서 기기를 켜세요." };
    if (device && !matchesDevice(d, device)) return { ok: false, error: `이 스페이스의 에뮬레이터는 분리 창에서 ${d.name || d.udid} 를 보고 있습니다. 기기를 바꾸려면 그 창에서 바꾸세요.` };
    return { ok: true, space: sp, tab: away.tab.id, udid: d.udid, name: d.name || away.tab.label || "" };
  }
  let tab = device ? findDeviceEntry(device)?.tab : emulatorTabOf(sp);
  if (!tab) {
    tab = addTab(sp, { id: "emu-" + Date.now().toString(36), kind: KIND, label: device ? device.name : "에뮬레이터", deviceId: device ? device.udid : null, deviceKey: device?.persistentId || device?.udid || null });
    ctx.renderTabs();
  }
  let entry = mounted.get(tab.id);
  const cur = entry ? entryDevice(entry) : null;
  if (device && !(cur && cur.attached && matchesDevice(cur, device))) {
    if (entry) entry.running = false;
    tab.deviceId = device.udid; tab.deviceKey = device.persistentId || device.udid; tab.label = device.name || tab.label;
    if (entry && entry.pane && !entry.detached) { entry.pane.dispose(); mountPaneFor(entry); if (entry.inColumn) entry.pane.setVisible(true); }
    ctx.renderTabs();
  }
  if (!entry) entry = mountEntry(tab, sp, false);
  if (!entry) return { ok: false, error: "에뮬레이터 화면을 붙일 자리가 없습니다." };
  renderStage();
  return waitAgentDevice(sp, tab, entry, device, timeoutMs);
}

// 에이전트가 켜는 중인 탭. 아직 목록에 Booted 로 안 잡힌 기기도 켜진 기기 수에 넣는다.
const agentBooting = new Map();   // tab.id → 켜는 기기 udid

function bootingCount(devices) {
  let n = 0;
  for (const udid of new Set([...agentBooting.values(), ...agentReservations])) {
    const row = devices.find((d) => d.udid === udid || d.name === udid);
    if (!row || row.state !== "Booted") n++;
  }
  return n;
}

// 세션 소유 탭. 없으면 만들고, 분리 창에 있으면 그 창의 기기를 쓴다.
// auto: 기기를 이쪽에서 골랐다. 같은 세션의 겹친 요청이 먼저 탭을 만들었으면 그 탭을 쓴다.
async function openOwnedForAgent(sp, owner, entry, device, auto, timeoutMs, additional = false) {
  const now = additional ? null : ownerEntryOf(owner);
  if (now && now !== entry) { entry = now; if (auto) device = null; }
  if (entry && entry.detached) {
    const d = entryDevice(entry);
    if (!device || matchesDevice(d, device)) {
      if (!entry.running) return { ok: false, error: "이 세션의 에뮬레이터 분리 창에서 기기가 꺼져 있습니다. 그 창에서 켜거나, 창을 닫으면 다음 호출에서 다시 켭니다." };
      if (d.udid) return { ok: true, space: sp, tab: entry.tab.id, udid: d.udid, name: d.name || entry.tab.label || "", owner };
    }
    return { ok: false, error: "이 세션의 에뮬레이터는 분리 창에 있습니다. 기기를 바꾸려면 그 창에서 바꾸세요." };
  }
  const createdTab = !entry;
  let tab = entry ? entry.tab : null;
  if (!tab) {
    tab = addTab(sp, { id: "emu-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), kind: KIND,
      label: device ? device.name : "에뮬레이터", deviceId: device ? device.udid : null, deviceKey: device?.persistentId || device?.udid || null, owner });
    ctx.renderTabs();
  }
  const cur = entry ? entryDevice(entry) : null;
  if (device && entry && !(cur && cur.attached && matchesDevice(cur, device))) {
    if (entry) entry.running = false;
    tab.deviceId = device.udid; tab.deviceKey = device.persistentId || device.udid; tab.label = device.name || tab.label;
    if (entry.pane) { entry.pane.dispose(); mountPaneFor(entry); if (entry.inColumn) entry.pane.setVisible(true); }
    ctx.renderTabs();
  }
  if (!entry) entry = mountEntry(tab, sp, false);
  if (!entry) return { ok: false, error: "에뮬레이터 화면을 붙일 자리가 없습니다." };
  renderStage();
  if (device && !entryDevice(entry).attached) agentBooting.set(tab.id, device.udid);
  try {
    const r = await waitAgentDevice(sp, tab, entry, device, timeoutMs);
    if (!r.ok && createdTab) {
      removeTab(sp, tab);
      closeEntry(tab.id);
      ctx.renderTabs();
    }
    return r.ok ? { ...r, owner } : r;
  } finally { agentBooting.delete(tab.id); }
}

async function waitAgentDevice(sp, tab, entry, device, timeoutMs) {
  // 화면은 열 때 꺼진 기기를 켜지 않음. 에이전트가 요청한 기기는 여기서 켬
  if (entry.pane && !entry.detached && !entryDevice(entry).attached) entry.pane.connect();
  const until = Date.now() + timeoutMs;
  for (;;) {
    const d = entryDevice(entry);
    if (d.attached && d.udid && (!device || matchesDevice(d, device))) {
      // 에이전트가 연 기기는 분리 창으로 띄움(사용자 결정). 사람이 이미 보고 있는 화면(세로 열·무대·보이는 탭)은 옮기지 않음
      const watching = entry.inColumn || entry.inStage || (!entry.el.hidden && !panelEl()?.hidden);
      if (!entry.detached && !watching) await detach(entry);
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
    if (m.kind === "reown") { reply({ ok: true, moved: m.owner ? reownDevices(m.devices, String(m.owner)) : 0 }); return; }
    if (m.kind === "open") {
      reply(await openForAgent(m.space || null, m.device || null, Math.max(5000, Number(m.wait) || 120000),
        { owner: m.owner || null, limit: Number.isInteger(m.limit) ? m.limit : null, diskOk: m.diskOk !== false, additional: m.additional === true, reservedDevices: Array.isArray(m.reservedDevices) ? m.reservedDevices : [] }));
      return;
    }
    reply({ ok: false, error: "모르는 요청: " + m.kind });
  } catch (e) { reply({ ok: false, error: String((e && e.message) || e) }); }
}

// 알림의 [그 앱으로]. 그 기기가 열린 탭으로 화면을 옮긴다. 없으면 false 를 돌려 앱 셸이 원래 동작을 한다.
function focusDevice(udid) {
  for (const entry of mounted.values()) {
    if (entryDevice(entry).udid !== udid) continue;
    if (entry.detached) { void host.openWindow({ space: emuKey(entry), tab: entry.tab.id, device: entry.tab.deviceKey || entry.tab.deviceId || null }); return true; }
    if (entry.inColumn || entry.inStage) { selectGroup(entry); return true; }
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
function matchesDevice(current, device) {
  return current.udid === device.udid || (device.runtime === "Android" && /^emulator-\d+$/.test(current.udid || "") && current.name === device.name);
}

function findDeviceEntry(device) {
  if (!device?.udid) return null;
  return [...mounted.values()].find(e => e.tab.deviceId === device.udid || e.tab.deviceKey === device.udid || e.tab.deviceKey === device.persistentId && !!device.persistentId || entryDevice(e).udid === device.udid ||
    (device.runtime === "Android" && entryDevice(e).name === device.name));
}

function openEmulatorTab(device) {
  const sp = targetSpace();
  if (!sp) { ctx.showToast?.("스페이스를 먼저 고르세요", { level: "warn" }); return null; }
  let entry = findDeviceEntry(device);
  if (!device) entry = [...mounted.values()].find(e => e.space === sp && !e.tab.owner) || null;
  if (entry?.detached) {
    void host.openWindow({ space: emuKey(entry), tab: entry.tab.id, device: entry.tab.deviceId });
    return entry;
  }
  if (!entry) {
    const tab = addTab(sp, { id: "emu-" + crypto.randomUUID(), kind: KIND,
      label: device?.name || "에뮬레이터", deviceId: device?.udid || null, deviceKey: device?.persistentId || device?.udid || null });
    entry = mountEntry(tab, sp, false);
    if (!entry) return null;
    entry.home = "column";
  }
  if (inRail) toStage(entry);
  else if (layoutOn()) toColumn(entry);
  else toTab(entry, true);
  return entry;
}

async function startDevice(device) {
  const entry = openEmulatorTab(device);
  if (!entry) return;
  if (entry.detached) {
    const result = await host.openWindow({ space: emuKey(entry), tab: entry.tab.id, device: entry.tab.deviceKey || entry.tab.deviceId, connect: true });
    if (!result?.ok) throw new Error(result?.error || "기기를 켜지 못했습니다");
  } else {
    const result = await entry.pane?.connect();
    if (result?.ok === false) throw new Error(result.error || "기기를 켜지 못했습니다");
  }
}

async function moveDevice(device, location) {
  const entry = findDeviceEntry(device) || openEmulatorTab(device);
  if (!entry) return;
  entry.group = location === "split" ? entry.tab.id : "emulator";
  entry.home = "column";
  if (location === "external") { await detach(entry); return; }
  if (entry.detached) {
    entry.detachHome = inRail ? "stage" : "column";
    await host.closeWindow({ tab: entry.tab.id });
    return;
  }
  if (inRail) toStage(entry); else toColumn(entry);
  savePlaces();
}

function deviceLocation(udid) {
  const entry = findDeviceEntry({ udid });
  return !entry ? null : entry.detached ? "external" : entry.group && entry.group !== "emulator" ? "split" : "column";
}

async function stopDevice(device) {
  const entry = findDeviceEntry(device);
  if (entry?.pane) {
    const result = await entry.pane.stop();
    if (result?.ok === false) throw new Error(result.error || "기기를 끄지 못했습니다");
    entry.running = false;
  }
  else {
    const result = await host.rpc("emulator.shutdown", { device: device.udid, ...(entry ? { worktree: emuKey(entry) } : {}) });
    if (!result?.ok) throw new Error(result?.error || "기기를 끄지 못했습니다");
    if (entry) entry.running = false;
  }
  savePlaces();
}

function mountColumn() {
  if (!document.querySelector(".app")) return;
  column = ensureGroup("emulator").el;
  let wasOn = layoutOn();
  new MutationObserver(() => {
    const on = layoutOn();
    if (on === wasOn) return;
    wasOn = on;
    const selected = new Map([...groups].map(([id, group]) => [id, group.active]));
    const byMode = document.body.classList.contains("browser-mode") || document.body.classList.contains("memo-mode");
    for (const entry of mounted.values()) {
      if (!on && entry.inColumn) { toTab(entry, false); entry.narrowed = !byMode; }
      else if (on && entry.narrowed && !entry.detached && !entry.inStage) { entry.narrowed = false; toColumn(entry); }
    }
    for (const [id, active] of selected) groups.get(id).active = active;
    renderGroups();
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
}

// 지금 스페이스의 기기 화면이 보는 기기. 목록의 선택 표시에 쓴다.
function currentUdid() {
  const sp = targetSpace();
  const entry = sp ? (stageEntry?.space === sp ? stageEntry : columnEntry?.space === sp ? columnEntry : entryOfSpace(sp) || detachedEntryOf(sp)) : null;
  if (!entry) return null;
  return entryDevice(entry).udid || entry.tab.deviceId || null;
}

function pickTarget(el) {
  const hit = pickTargetAt(el, [...mounted.values()], column, stageHost);
  if (!hit) return null;
  const { entry, where } = hit;
  const device = entryDevice(entry);
  return { el: hit.el,
    space: entry.space, tab: entry.tab.id, udid: device.udid || entry.tab.deviceId || null,
    platform: entry.pane?.platform?.() || null, where };
}

async function designateDevice(tabId, pickedDevice = null) {
  const entry = mounted.get(tabId);
  const pane = ctx.getCurTarget?.();
  const device = entry ? entryDevice(entry) : null;
  const udid = entry && (entry.detached ? entry.running && pickedDevice : device.attached && device.udid);
  if (!pane) { ctx.showToast?.("먼저 에이전트 세션을 선택하세요", { level: "warn" }); return "먼저 에이전트 세션을 선택하세요"; }
  if (!udid) { ctx.showToast?.("먼저 기기에 연결하세요", { level: "warn" }); return "먼저 기기에 연결하세요"; }

  const request = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingDesignations.delete(request);
      ctx.showToast?.("기기 지목 준비가 시간 안에 끝나지 않았습니다", { level: "warn" });
      resolve("기기 지목 준비가 시간 안에 끝나지 않았습니다");
    }, 5000);
    pendingDesignations.set(request, { resolve, timer, pane });
    ctx.wsSend?.({ type: "emulator.target-pending", request, pane, udid, persistentId: persistentDeviceId(entry, udid),
      name: device?.name || entry.tab.label || udid, platform: entry.pane?.platform?.() || "" });
  });
}

function finishDeviceDesignation(message) {
  const pending = pendingDesignations.get(message?.request);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingDesignations.delete(message.request);
  if (!message.ok || !message.delimiter) {
    const detail = String(message.error || "알 수 없는 오류");
    ctx.showToast?.("기기 지목을 준비하지 못했습니다", { level: "err", detail });
    pending.resolve(`기기 지목 준비 실패: ${detail}`);
    return;
  }
  if (ctx.getCurTarget?.() !== pending.pane) {
    const text = "세션이 바뀌어 기기 지정을 입력하지 않았습니다. 지정할 세션에서 다시 선택하세요.";
    ctx.showToast?.(text, { level: "warn" });
    pending.resolve(text);
    return;
  }
  const name = message.name || message.udid;
  const block = noticeBlock("에뮬레이터 지목", [
    `등록 구분자: ${message.delimiter}`,
    `기기: ${name} (${message.udid})`,
    message.platform ? `플랫폼: ${message.platform}` : null,
    "이 메시지를 보내면 이 세션의 앱 기본 대상으로 등록됩니다.",
  ]);
  ctx.wsSend?.({ type: "pty.input", data: "\x1b[200~" + block + "\x1b[201~" });
  const text = `채팅 입력에 기기 추가: ${name}. 보내면 이 세션 대상으로 등록됩니다.`;
  ctx.showToast?.(text, { level: "ok" });
  pending.resolve(text);
}

function toggleRecord() {
  if (!callHook("record.on") && !callHook("record.hasTarget")) {
    ctx.showToast?.("기록할 브라우저 탭을 먼저 열어주세요", { level: "warn" });
    return "기록할 브라우저 탭을 먼저 열어주세요";
  }
  callHook("record.set", !callHook("record.on"));
  return callHook("record.on") ? "활성 브라우저 탭 기록 중" : "기록 종료";
}

// rail 기기 화면에 들어온다. 지금 스페이스의 화면을 무대로 옮기고, 세로 열은 비어 있다고 알린다.
function enterRail() {
  const selected = new Map([...groups].map(([id, group]) => [id, group.active]));
  const wasIn = inRail;
  inRail = true;
  const sp = targetSpace();
  for (const entry of mounted.values()) {
    if (entry.inStage && entry.space !== sp) fromStage(entry);
    if (entry.space === sp && !entry.detached && (!entry.tab.owner || entry.home != null)) toStage(entry);
  }
  for (const [id, active] of selected) groups.get(id).active = active;
  renderGroups();
  if (!wasIn) { notifyLayout(); sweep(); }
  const root = document.getElementById("emu-panel");
  const body = root && root.querySelector(".emu-rail-body");
  if (!body || devicePanel) { devicePanel?.refresh(); return; }
  devicePanel = mountDevicePanel(body, {
    host,
    onOpenDevice: startDevice,
    onMoveDevice: moveDevice, onStopDevice: stopDevice, deviceLocation,
    headTools: root.querySelector(".emu-rail-head"),
    currentUdid,
  });
}

// rail 이 다른 화면으로 갈 때마다 부른다(들어와 있지 않았어도 부른다).
function leaveRail() {
  if (!inRail) return;
  const selected = new Map([...groups].map(([id, group]) => [id, group.active]));
  inRail = false;
  for (const entry of mounted.values()) if (entry.inStage) fromStage(entry);
  for (const [id, active] of selected) groups.get(id).active = active;
  renderGroups();
  notifyLayout();
  sweep();
}

// ---- 자리 기록: 앱 재시작 때 있던 자리에 다시 열기 ----
// 켜짐: 본 창 화면은 지금 붙어 있는가, 분리 창은 창이 보고한 값. 복원으로 켜는 중(booting)도 켜짐
function entryRunning(entry, d) {
  if (entry.detached) return !!entry.running;
  if (entry.booting) {
    if (d.attached || d.error) entry.booting = false;
    else return true;
  }
  return !!d.attached;
}

function savePlaces() {
  if (quitting) return;
  const current = [];
  for (const entry of mounted.values()) {
    const d = entryDevice(entry);
    const away = entry.detached || entry.inColumn || entry.inStage;
    current.push(placeRecord(entry, {
      key: ctx.spk ? ctx.spk(entry.space) : entry.space,
      index: away ? (entry.awayIndex ?? -1) : getTabs(entry.space).indexOf(entry.tab),
      active: entry.inColumn || entry.inStage ? groups.get(entry.group || "emulator")?.active === entry.tab.id : !away && getActiveTabId(entry.space) === entry.tab.id,
      running: entryRunning(entry, d),
      name: d.name || entry.tab.label || "",
    }));
  }
  const text = JSON.stringify(mergePlaces(current, pendingPlaces));
  if (text === lastSavedPlaces) return;
  lastSavedPlaces = text;
  try { localStorage.setItem(PLACES_KEY, text); } catch {}
}

function restoreOne(rec, sp) {
  // 이미 열린 같은 기기는 유지하고 나머지는 각각 복원한다.
  const taken = rec.deviceId ? findDeviceEntry({ udid: restoreDevice(rec) }) : null;
  if (mounted.has(rec.id) || taken || !panelEl()) return;
  const { place, narrowed } = restoreTarget(rec, layoutOn());
  const tab = { id: rec.id, kind: KIND, label: rec.label || "에뮬레이터", deviceId: restoreDevice(rec), deviceKey: rec.deviceKey || restoreDevice(rec) };
  if (rec.owner) tab.owner = rec.owner;
  const list = ensureTabSpace(sp);
  list.splice(rec.index >= 0 ? Math.min(rec.index, list.length) : list.length, 0, tab);
  if (place === "detached") {
    // 본 창에는 화면을 붙이지 않고 바로 분리 창으로
    const el = document.createElement("div");
    el.className = "emu-tab-host";
    el.hidden = true;
    panelEl().append(el);
    const entry = { tab, space: sp, el, pane: null, detached: false, inColumn: false, home: rec.home, group: rec.group, running: rec.running };
    mounted.set(tab.id, entry);
    startWatching();
    void detach(entry, { home: rec.detachHome || "strip", bounds: rec.bounds, connect: rec.running });
    return;
  }
  const entry = mountEntry(tab, sp, false);
  if (!entry) return;
  entry.home = rec.home;
  entry.group = rec.group || "emulator";
  entry.stageFrom = rec.stageFrom;
  entry.narrowed = narrowed;
  if (place === "column") toColumn(entry);
  if (inRail && sp === targetSpace()) toStage(entry);
  else if (place === "strip" && rec.active) setActiveTab(sp, tab.id);
  // 종료 때 켜져 있던 기기만 켜기. 꺼 둔 기기는 화면만
  if (rec.running) { entry.booting = true; entry.pane.connect(); }
  ctx.renderTabs(); ctx.showActiveTab();
}

function restorePlaces() {
  const spaces = ctx.getSpaces?.() || [];
  if (!spaces.length) return;
  const keyOf = (id) => (ctx.spk ? ctx.spk(id) : id);
  const left = [];
  const found = [];
  for (const rec of pendingPlaces) {
    const space = spaces.find((sp) => keyOf(sp.id) === rec.key);
    if (space) found.push([rec, space.id]); else left.push(rec);
  }
  if (!found.length) return;
  pendingPlaces = left;
  for (const [rec, sp] of found) restoreOne(rec, sp);
  for (const [rec] of found) if (rec.active) {
    const entry = mounted.get(rec.id);
    if (entry && (entry.inColumn || entry.inStage)) ensureGroup(entry.group).active = entry.tab.id;
  }
  renderGroups();
  savePlaces();
}

// 스페이스 목록과 폴더 열쇠는 서버 연결 뒤에 옴. 1초마다 60초까지 확인, 그래도 못 찾은 기록은 저장 때 합쳐 보존
function startRestore() {
  try { pendingPlaces = parsePlaces(localStorage.getItem(PLACES_KEY)); } catch { pendingPlaces = []; }
  if (!pendingPlaces.length) return;
  const until = Date.now() + 60000;
  const timer = setInterval(() => {
    restorePlaces();
    if (!pendingPlaces.length || Date.now() > until) clearInterval(timer);
  }, 1000);
}

export function initCapability(c) {
  ctx = c;
  host = c.acHost && c.acHost.emulator;
  if (!host) return {};
  registerTabView({ kind: KIND, panelId: PANEL_ID, render: (t) => renderTab(t) });
  // 앱 종료 때 닫히는 분리 창은 되돌리지 않음(분리 창 자리 기록 유지)
  host.onWindowClosed((m) => { if (!quitting && !(m && m.quitting)) reattach(m && m.tab); });
  host.onQuitting?.(() => { quitting = true; });
  host.onWindowBounds?.((m) => {
    const entry = mounted.get(m && m.tab);
    if (entry && entry.detached && m.bounds) { entry.bounds = m.bounds; savePlaces(); }
  });
  mountColumn();
  mountStage();
  mountLaunchButton({
    host,
    hasTab: () => { const sp = targetSpace(); return !!sp && [...mounted.values()].some(entry => entry.space === sp); },
    onOpen: async (device) => {
      try {
        if (!device) {
          const result = await host.ensureDefaultDevice();
          if (!result?.ok) throw new Error(result?.error || "기본 기기를 준비하지 못했습니다");
          device = result.device;
        }
        await startDevice(device);
      } catch (error) { ctx.showToast?.(String(error.message || error), { level: "err" }); }
    },
  });
  // 스케치는 보이는 에뮬레이터가 있으면 브라우저 탭 대신 그 앱 화면을 찍는다.
  provide("emulator.sketchSource", () => {
    const entry = visibleEntry();
    return entry ? { shot: () => entry.pane.snapshot() } : null;
  });
  provide("emulator.focus", (udid) => focusDevice(udid));
  provide("emulator.pickTarget", pickTarget);
  provide("emulator.designate", (target) => { if (target?.tab) void designateDevice(target.tab); });
  provide("emulator.hasPickContext", () => mounted.size > 0);
  provide("emulator.pickMode", (on) => host.setPickState(!!on));
  provide("emulator.recordMode", (on) => host.setRecordState(!!on));
  host.setPickState(!!callHook("pick.mode"));
  host.setRecordState(!!callHook("record.on"));
  host.onControlRequest((m) => {
    const entry = mounted.get(m?.tab);
    if (!entry?.detached) return;
    if (m.action === "pick") callHook("pick.toggle");
    else if (m.action === "record") host.reportControl({ tab: m.tab, message: toggleRecord() });
    else if (m.action === "device") { entry.tab.deviceId = m.device || null; savePlaces(); }
    else if (m.action === "running") { entry.running = !!m.on; savePlaces(); }
    else if (m.action === "target") void designateDevice(m.tab, m.device)
      .then((message) => host.reportControl({ tab: m.tab, message }))
      .catch(() => host.reportControl({ tab: m.tab, message: "기기 지정에 실패했습니다" }));
  });
  // ⌘⇧D 는 앱 셸(panel/touch-drag.js)이 활성 webview 가 있을 때만 스케치로 보내고, 없으면 분리 브라우저
  // 창으로 넘긴다. 에뮬레이터 화면을 보는 중이면 그보다 먼저(window 캡처 단계) 받아 스케치를 연다.
  startRestore();
  window.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || (e.key || "").toLowerCase() !== "d") return;
    if (!visibleEntry() || !hasHook("sketch.open")) return;
    e.preventDefault(); e.stopImmediatePropagation();
    callHook("sketch.open");
  }, true);
  return { screen: { enter: enterRail, leave: leaveRail }, ws: {
    "emulator-ask": (m) => { void onAsk(m); },
    "emulator.target-pending-result": finishDeviceDesignation,
  } };
}
