// 작업 화면 배치 엔진. 배치 트리(layout-tree.js)를 계산해 영역 요소의 위치·크기로 적용하고, 경계 끌기와
// 편집 모드(영역 옮기기)를 다룬다.
//
// 소유 범위
//   영역 목록(앱 셸 영역 + 등록표의 기능 영역), 저장("ac.layout"), 경계 막대, 편집 화면(덮개 · 놓을 자리 ·
//   위쪽 막대), 켜고 끄는 조건.
//
// 제공 API
//   initLayoutEngine({ $ }): main 이 한 번 부른다. 레일의 #rail-layout-edit 버튼을 연결한다.
//
// 의존 대상
//   core/layout-tree.js(계산) · core/layout-regions.js(기능 영역) · core/drag-shield.js(끌기 덮개).
//   index.html 의 .app · #actrail · #sidebar · #panel-* · #center · #right, body 의 class(sidebar-collapsed ·
//   util-full · browser-mode · memo-mode), .rail-panel.is-open, #right.collapsed, .panel.collapsed.
//
// 유지 조건
//   영역 요소를 DOM 에서 옮기지 않는다. 위치와 크기만 인라인으로 준다. 브라우저 webview 는 부모가 바뀌면
//   다시 읽힐 수 있고, 터미널·파일 트리도 자기 자리를 전제로 한다. #sidebar 는 display:contents 로 두어
//   세 칸이 .app 기준으로 놓인다.
//   도구 화면은 이름으로 세지 않는다. 지금 열린 .rail-panel 하나가 tools 영역이다.
//   창 폭 820px 이하, 분리 브라우저 창, 메모 창에서는 끈다. 그때는 인라인 값을 모두 걷고 기존 CSS 가 맡는다.
//
// 영향 범위
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs web/js/core/layout-engine.js

import { beginDrag } from "./drag-shield.js";
import { computeLayout, defaultTree, leafIds, moveRegion, normalizeTree, setKidSize } from "./layout-tree.js";
import { layoutRegions, onLayoutChange } from "./layout-regions.js";
import { RAIL_ITEMS } from "./rail-items.js";

const KEY = "ac.layout";
const NARROW = 820;
const LABEL = { explorer: "탐색기", spaces: "Spaces · Agents", tools: "도구 화면", center: "가운데 탭", chat: "채팅" };

let $ = null;
let app = null;
let tree = null;
let on = false;
let editing = null;      // { snapshot, pick: Map }
let raf = 0;
let last = null;         // 마지막 계산 결과
const touched = new Set();
let splitEls = [];
let editEls = [];

const bodyCls = () => document.body.classList;
const openTool = () => document.querySelector(".rail-panel.is-open");

// ---- 영역 ----

function headPx(panel) {
  const h = panel && panel.querySelector(".panel-head");
  return (h && h.offsetHeight) || 30;
}

// 앱 머리(.sidebar-head)는 탐색기와 Spaces · Agents 중 위에 놓인 칸의 맨 위에 붙는다. 순서를 바꿔도 머리가
// 사이드바 맨 위에 남게 하려고 칸마다 따로 두지 않고 relayout 이 고른다.
const HEAD_HOSTS = ["explorer", "spaces"];
let headHost = null;

function sidebarPanel(id, panelSel) {
  const hosts = () => headHost === id;
  const headH = () => ($(".sidebar-head").offsetHeight || 38);
  return {
    els: () => (hosts() ? [$(".sidebar-head"), $(panelSel)] : [$(panelSel)]),
    visible: () => !bodyCls().contains("sidebar-collapsed"),
    collapsedPx: () => ($(panelSel).classList.contains("collapsed") ? (hosts() ? headH() : 0) + headPx($(panelSel)) + 1 : null),
    place: (r) => {
      const panel = $(panelSel);
      if (!hosts()) { setRect(panel, r); return; }
      const head = $(".sidebar-head");
      // 머리는 높이를 주지 않는다. 주면 다음 계산에서 그 값을 다시 읽어 머리가 칸을 다 차지한다.
      setRect(head, { x: r.x, y: r.y, w: r.w, h: null });
      const hh = headH();
      setRect(panel, { x: r.x, y: r.y + hh, w: r.w, h: Math.max(0, r.h - hh) });
    },
  };
}

// 자리를 받은 두 칸 가운데 가장 위(같으면 왼쪽)에 있는 칸. 겹친 자리의 뒤쪽이라 자리가 없으면 고르지 않는다.
function topHost(rects) {
  let best = null;
  for (const id of HEAD_HOSTS) {
    const r = rects[id];
    if (r && (!best || r.y < best.r.y || (r.y === best.r.y && r.x < best.r.x))) best = { id, r };
  }
  return best ? best.id : null;
}

function shellRegion(id) {
  const leftHidden = () => bodyCls().contains("sidebar-collapsed");
  switch (id) {
    case "explorer": return sidebarPanel("explorer", "#panel-explorer");
    case "spaces": return sidebarPanel("spaces", "#panel-spaces");
    case "tools": return {
      els: () => { const t = openTool(); return t ? [t] : []; },
      visible: () => !leftHidden() && !!openTool(),
    };
    case "center": return { els: () => [$("#center")], visible: () => !bodyCls().contains("util-full") };
    case "chat": return { els: () => [$("#right")], visible: () => !$("#right").classList.contains("collapsed") };
  }
  return null;
}

function regionOf(id) {
  const shell = shellRegion(id);
  if (shell) return { id, label: LABEL[id], ...shell };
  const def = layoutRegions().find((r) => r.id === id);
  if (!def) return null;
  return { id, label: def.label || id, els: () => (def.el ? [def.el] : []), visible: () => !!(def.visible && def.visible()) };
}

function labelOf(id) { const r = regionOf(id); return (r && r.label) || id; }

// ---- 저장 ----

function num(key) { const v = parseFloat(localStorage.getItem(key) || ""); return Number.isFinite(v) && v > 0 ? v : null; }

// 첫 실행 때는 옛 조절 막대가 저장한 폭·높이로 기본 배치를 만든다. 사용자가 맞춰 둔 크기가 바뀌지 않게.
function migratedDefault() {
  const toolW = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i) || "";
    const m = /^ac\.utilW\.(.+)$/.exec(k);
    if (m && m[1] !== "sidebar") { const v = num(k); if (v) toolW[m[1]] = v; }
  }
  const fileTreeH = num("ac.fileTreeH");
  return defaultTree({
    sidebarW: num("ac.utilW.sidebar") ?? undefined,
    chatW: num("ac.rightW") ?? undefined,
    explorerH: fileTreeH ? fileTreeH + 70 : undefined,
    toolW,
  });
}

function registered() { return layoutRegions().map((r) => ({ id: r.id, size: r.size })); }

function load() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) || "null"); } catch {}
  tree = normalizeTree(saved && saved.v === 1 ? saved.tree : null, { registered: registered(), fallback: migratedDefault() });
}

function save() { try { localStorage.setItem(KEY, JSON.stringify({ v: 1, tree })); } catch {} }

// ---- 적용 ----

function setRect(el, r) {
  if (!el) return;
  touched.add(el);
  el.classList.add("lay-region");
  el.classList.remove("lay-off");
  el.style.left = r.x + "px"; el.style.top = r.y + "px";
  el.style.width = r.w + "px"; el.style.height = r.h == null ? "" : r.h + "px";
}

function hide(el) { if (!el) return; touched.add(el); el.classList.add("lay-region", "lay-off"); }

function shouldBeOn() {
  return window.innerWidth > NARROW && !bodyCls().contains("browser-mode") && !bodyCls().contains("memo-mode");
}

function turnOff() {
  if (!on) return;
  on = false;
  if (editing) exitEdit(false);
  bodyCls().remove("layout-on");
  for (const el of touched) {
    el.classList.remove("lay-region", "lay-off");
    el.style.left = el.style.top = el.style.width = el.style.height = "";
  }
  touched.clear();
  clearSplits();
}

function box() {
  const rail = $("#actrail");
  const railW = rail && rail.offsetParent !== null ? rail.offsetWidth : 0;
  const padTop = parseFloat(getComputedStyle(app).paddingTop) || 0;
  return { x: railW, y: padTop, w: Math.max(0, app.clientWidth - railW), h: Math.max(0, app.clientHeight - padTop) };
}

function schedule() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; relayout(); }); }

function relayout() {
  if (!shouldBeOn()) { turnOff(); return; }
  if (!on) { on = true; bodyCls().add("layout-on"); }
  const ids = leafIds(tree);
  const regions = new Map(ids.map((id) => [id, regionOf(id)]).filter(([, r]) => r));
  const realVisible = (id) => { const r = regions.get(id); return !!(r && r.visible()); };
  const tool = openTool();
  const ctx = {
    visible: editing ? (id) => regions.has(id) : realVisible,
    prefer: editing ? realVisible : null,
    pick: editing ? editing.pick : null,
    toolKey: tool && realVisible("tools") ? "tools:" + tool.id : null,
    toolBaseW: (tool && RAIL_ITEMS.find((it) => it.panel === tool.id)?.width) || null,
    collapsedPx: (id) => { const r = regions.get(id); return r && r.collapsedPx ? r.collapsedPx() : null; },
  };
  // 머리를 얹는 칸에 따라 접힌 높이가 달라지므로, 고른 칸이 바뀌면 한 번 더 계산한다.
  last = computeLayout(tree, box(), ctx);
  const host = topHost(last.rects);
  if (host !== headHost) { headHost = host; last = computeLayout(tree, box(), ctx); }
  last.realVisible = realVisible;
  const placed = new Set();
  for (const [id, r] of regions) {
    const rect = last.rects[id];
    if (rect && realVisible(id)) {
      if (r.place) r.place(rect); else for (const el of r.els()) setRect(el, rect);
      for (const el of r.els()) placed.add(el);
    }
  }
  // 이번에 자리를 받지 못한 영역 요소는 숨긴다(겹친 자리의 뒤쪽, 보이지 않는 영역).
  for (const [, r] of regions) for (const el of r.els()) if (!placed.has(el)) hide(el);
  for (const el of touched) if (!placed.has(el) && !el.classList.contains("lay-off")) hide(el);
  const head = $(".sidebar-head");
  if (head && !placed.has(head)) hide(head);
  drawSplits();
  if (editing) drawEdit();
}

// ---- 경계 막대 ----

function clearSplits() { for (const el of splitEls) el.remove(); splitEls = []; }

function drawSplits() {
  clearSplits();
  for (const s of last.splits) {
    const el = document.createElement("div");
    el.className = "lay-split " + (s.dir === "row" ? "lay-split-col" : "lay-split-row");
    Object.assign(el.style, { left: s.rect.x + "px", top: s.rect.y + "px", width: s.rect.w + "px", height: s.rect.h + "px" });
    el.title = "드래그해서 크기 조절";
    el.addEventListener("mousedown", (e) => startResize(e, s));
    app.appendChild(el);
    splitEls.push(el);
  }
}

function startResize(e, s) {
  if (e.button !== 0) return;
  e.preventDefault();
  const start = s.dir === "row" ? e.clientX : e.clientY;
  const base = tree;
  beginDrag({
    cursor: s.dir === "row" ? "col-resize" : "row-resize",
    onMove: (ev) => {
      const d = (s.dir === "row" ? ev.clientX : ev.clientY) - start;
      const px = Math.max(60, Math.min(s.max, s.start + s.sign * d));
      tree = setKidSize(base, s.path, s.index, s.key, px);
      relayout();
    },
    onEnd: () => { if (!editing) save(); },
  });
}

// ---- 편집 모드 ----

function toggleEdit() { if (editing) exitEdit(true); else enterEdit(); }

function enterEdit() {
  if (!on) return;
  editing = { snapshot: tree, pick: new Map() };
  bodyCls().add("layout-editing");
  document.addEventListener("keydown", onEditKey, true);
  relayout();
}

function exitEdit(keep) {
  if (!editing) return;
  if (!keep) tree = editing.snapshot;
  editing = null;
  bodyCls().remove("layout-editing");
  document.removeEventListener("keydown", onEditKey, true);
  for (const el of editEls) el.remove();
  editEls = [];
  if (keep) save();
  schedule();
}

function onEditKey(e) {
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); exitEdit(false); }
}

function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

function drawEdit() {
  for (const n of editEls) n.remove();
  editEls = [];
  const add = (n) => { app.appendChild(n); editEls.push(n); return n; };

  const bar = el("div", "lay-bar");
  bar.append(el("span", "lay-bar-text", "배치 편집: 영역 이름을 끌어 다른 영역의 위·아래·왼쪽·오른쪽에 놓으면 그쪽으로 나뉘고, 가운데에 놓으면 같은 자리에 겹칩니다."));
  const btn = (label, fn, cls) => { const b = el("button", "lay-btn" + (cls ? " " + cls : ""), label); b.type = "button"; b.addEventListener("click", fn); return b; };
  bar.append(
    btn("기본 배치로", () => { tree = normalizeTree(migratedDefault(), { registered: registered() }); editing.pick = new Map(); relayout(); }),
    btn("취소", () => exitEdit(false)),
    btn("완료", () => exitEdit(true), "lay-btn-primary"),
  );
  add(bar);

  for (const [id, r] of Object.entries(last.rects)) {
    const ov = el("div", "lay-ov");
    Object.assign(ov.style, { left: r.x + "px", top: r.y + "px", width: r.w + "px", height: r.h + "px" });
    const name = el("div", "lay-ov-name", labelOf(id));
    name.title = "끌어서 옮기기";
    name.addEventListener("mousedown", (e) => startMove(e, id));
    ov.append(name);
    if (!last.realVisible(id)) ov.append(el("div", "lay-ov-empty", "지금 비어 있음"));
    add(ov);
  }
  // 겹친 자리: 편집 중에 어느 쪽을 보일지 고른다. 고른 쪽의 이름을 끌면 그 영역을 옮긴다.
  for (const st of last.stacks) {
    const box = el("div", "lay-stack");
    Object.assign(box.style, { left: st.rect.x + 8 + "px", top: st.rect.y + 40 + "px" });
    box.append(el("span", "lay-stack-title", "겹친 자리"));
    st.members.forEach((ids, i) => {
      const b = btn(ids.map(labelOf).join(" · "), () => { editing.pick.set(st.path.join("."), i); relayout(); }, i === st.pick ? "on" : "");
      box.append(b);
    });
    add(box);
  }
}

function zoneAt(r, x, y) {
  const fx = (x - r.x) / r.w, fy = (y - r.y) / r.h;
  const edge = Math.min(fx, 1 - fx, fy, 1 - fy);
  if (edge > 0.25) return "stack";
  if (edge === fx) return "left";
  if (edge === 1 - fx) return "right";
  if (edge === fy) return "top";
  return "bottom";
}

function zoneRect(r, zone) {
  if (zone === "left") return { ...r, w: r.w / 2 };
  if (zone === "right") return { ...r, x: r.x + r.w / 2, w: r.w / 2 };
  if (zone === "top") return { ...r, h: r.h / 2 };
  if (zone === "bottom") return { ...r, y: r.y + r.h / 2, h: r.h / 2 };
  return { x: r.x + 12, y: r.y + 12, w: r.w - 24, h: r.h - 24 };
}

function startMove(e, id) {
  if (e.button !== 0) return;
  e.preventDefault();
  const origin = app.getBoundingClientRect();
  const drop = el("div", "lay-drop");
  drop.hidden = true;
  app.appendChild(drop);
  let target = null;
  beginDrag({
    cursor: "grabbing",
    onMove: (ev) => {
      const x = ev.clientX - origin.left, y = ev.clientY - origin.top;
      target = null;
      for (const [tid, r] of Object.entries(last.rects)) {
        if (tid === id || x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) continue;
        target = { id: tid, zone: zoneAt(r, x, y), rect: r };
        break;
      }
      drop.hidden = !target;
      if (target) {
        const z = zoneRect(target.rect, target.zone);
        Object.assign(drop.style, { left: z.x + "px", top: z.y + "px", width: z.w + "px", height: z.h + "px" });
        drop.textContent = target.zone === "stack" ? labelOf(target.id) + "에 겹치기" : "";
      }
    },
    onEnd: () => {
      drop.remove();
      if (!target) return;
      const r = target.rect;
      const half = target.zone === "left" || target.zone === "right" ? r.w / 2 : r.h / 2;
      tree = moveRegion(tree, id, target.id, target.zone, Math.round(half));
      editing.pick = new Map();
      relayout();
    },
  });
}

// ---- 시작 ----

export function initLayoutEngine(deps) {
  $ = deps.$;
  app = document.querySelector(".app");
  if (!app) return;
  load();
  new ResizeObserver(schedule).observe(app);
  window.addEventListener("resize", schedule);
  // 엔진이 스스로 다는 class(lay-* · layout-*)와 막대·덮개 요소는 감시에서 뺀다. 빼지 않으면 적용할 때마다
  // 다시 계산이 예약된다.
  const own = (t) => t.startsWith("lay-") || t.startsWith("layout-");
  const norm = (v) => String(v || "").split(/\s+/).filter((t) => t && !own(t)).sort().join(" ");
  const classChanged = (r) => norm(r.oldValue) !== norm(r.target.getAttribute("class"));
  new MutationObserver((recs) => { if (recs.some(classChanged)) schedule(); })
    .observe(document.body, { attributes: true, attributeFilter: ["class"], attributeOldValue: true });
  // 도구 화면 열림, 칸 접기, 채팅 접기는 요소의 class 로 드러난다. 가운데 탭의 잦은 class 변화는 거른다.
  const watched = (t) => t.classList && (t.classList.contains("rail-panel") || t.classList.contains("panel") || t.id === "right");
  new MutationObserver((recs) => { if (recs.some((r) => watched(r.target) && classChanged(r))) schedule(); })
    .observe(app, { attributes: true, attributeFilter: ["class"], attributeOldValue: true, subtree: true });
  // 기능이 늦게 붙이는 도구 화면·기능 영역은 .app 의 자식이 늘어나는 것으로 드러난다.
  const foreign = (n) => !(n.classList && [...n.classList].some(own));
  new MutationObserver((recs) => {
    if (recs.some((r) => [...r.addedNodes, ...r.removedNodes].some(foreign))) schedule();
  }).observe(app, { childList: true });
  onLayoutChange(() => {
    const before = JSON.stringify(tree);
    tree = normalizeTree(tree, { registered: registered(), fallback: migratedDefault() });
    if (JSON.stringify(tree) !== before) save();
    schedule();
  });
  const editBtn = document.getElementById("rail-layout-edit");
  if (editBtn) editBtn.addEventListener("click", toggleEdit);
  relayout();
}
