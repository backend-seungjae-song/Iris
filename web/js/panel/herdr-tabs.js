// 채팅 머리에 붙는 herdr 탭줄.
//
// 소유 범위
//   herdr 탭 줄의 DOM 과, 탭마다 사람이 붙인 표시(고정·색)의 로컬 저장.
//
// 제공 API
//   initHerdrTabs(deps) 와 renderHerdrTabs(). 그 밖의 것은 없다.
//
// 의존 대상
//   탭 목록은 herdr 방송(herdr/state.js)이 정본이다. 여기서 목록을 따로 들지 않는다.
//   순서·이름·포커스·생성·삭제는 전부 herdr 에 명령을 보내고 다음 방송을 기다린다.
//   눌렀을 때 화면만 먼저 바꾸면 herdr 쪽이 거절했을 때 두 화면이 갈라진다.
//
// 유지 조건
//   고정과 색은 우리 쪽 표시일 뿐이다. herdr 에는 그런 개념이 없으므로 여기에만 남고,
//   고정은 herdr 순서를 바꾸지 않고 이 줄에서 앞으로 당겨 보이기만 한다.
//
// 영향 범위
//   main 의 state 수신, core/keynav 의 ⌥←→ 탭 순환과 cmd+t, panel/terminal 의 세로 crop.
//   현재 목록 확인: node bin/importers.mjs web/js/panel/herdr-tabs.js

import { getSpaces, getTabsForSpace } from "../herdr/state.js";
import { icon } from "../core/glyphs.js";
import { askText, showCtx } from "../explorer/context-menu.js";

let $, wsSend, showToast, getIsLocal, getSelectedSpaceId, onLayoutChange;
let strip = null;
let lastHeight = -1;

const META_KEY = "ac.htab.meta";
const COLORS = [
  { id: "", label: "없음", pal: "" },
  { id: "pink", label: "분홍", pal: "var(--pal-pink)" },
  { id: "sky", label: "하늘", pal: "var(--pal-sky-pop)" },
  { id: "mint", label: "민트", pal: "var(--pal-mint-pop)" },
  { id: "green", label: "연두", pal: "var(--pal-green-pop)" },
  { id: "yellow", label: "노랑", pal: "var(--pal-yellow-pop)" },
];
const colorOf = (id) => COLORS.find((c) => c.id === id)?.pal || "";

function readMeta() {
  try { return JSON.parse(localStorage.getItem(META_KEY) || "{}") || {}; } catch { return {}; }
}
function writeMeta(meta) {
  try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch {}
}
function metaOf(tabId) { return readMeta()[tabId] || {}; }
function setMeta(tabId, patch) {
  const meta = readMeta();
  const next = { ...(meta[tabId] || {}), ...patch };
  if (!next.pin && !next.color) delete meta[tabId]; else meta[tabId] = next;
  writeMeta(meta);
  renderHerdrTabs();
}

export function initHerdrTabs(deps) {
  ({ $, wsSend, showToast, getIsLocal, getSelectedSpaceId, onLayoutChange } = deps);
  strip = $("#htabs");
  if (!strip) return;
  strip.addEventListener("click", onClick);
  // 가로 줄에서 세로 휠을 돌리면 아무 일도 일어나지 않으므로, 마우스 휠도 가로로 받는다.
  strip.addEventListener("wheel", (e) => {
    const box = strip.querySelector(".htab-scroll");
    if (!box || box.scrollWidth <= box.clientWidth) return;
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!d) return;
    e.preventDefault();
    box.scrollLeft += d;
  }, { passive: false });
  strip.addEventListener("contextmenu", onContext);
  // 가운데 버튼으로 닫기: 브라우저 탭과 같은 조작.
  strip.addEventListener("auxclick", (e) => {
    if (e.button !== 1) return;
    const el = e.target.closest(".htab");
    if (el) { e.preventDefault(); closeTab(el.dataset.tab); }
  });
  renderHerdrTabs();
}

// 어느 스페이스의 탭을 보여줄지 정한다. 아직 스페이스를 고르지 않은 경우가 있는데(앱을 막 켰을
// 때), 그때 빈 목록을 그리면 줄이 통째로 표시되지 않는다.
// 고른 것이 없으면 herdr 이 지금 포커스로 표시한 탭이 있는 곳을 쓴다.
function currentSpace() {
  const sel = getSelectedSpaceId();
  if (sel && getTabsForSpace(sel).length) return sel;
  for (const w of getSpaces()) {
    const tabs = getTabsForSpace(w.id);
    if (tabs.some((t) => t.focused)) return w.id;
  }
  if (sel) return sel;
  return getSpaces().find((w) => getTabsForSpace(w.id).length)?.id || "";
}

// 고정한 것을 앞으로 당긴다. herdr 순서는 바꾸지 않는다. 그쪽 화면과 어긋나지 않게 하기 위한 것이다.
function orderedTabs(spaceId) {
  const meta = readMeta();
  return getTabsForSpace(spaceId).map((t, i) => ({ t, i }))
    .sort((a, b) => (meta[b.t.tabId]?.pin ? 1 : 0) - (meta[a.t.tabId]?.pin ? 1 : 0) || a.i - b.i)
    .map(({ t }) => t);
}

export function renderHerdrTabs() {
  if (!strip) return;
  const space = currentSpace();
  const tabs = space ? orderedTabs(space) : [];
  if (!tabs.length) { strip.hidden = true; strip.innerHTML = ""; syncLayout(); return; }
  strip.hidden = false;
  const meta = readMeta();
  const items = tabs.map((t, i) => {
    const m = meta[t.tabId] || {};
    const label = t.label || `터미널 ${t.number ?? i + 1}`;
    const tint = colorOf(m.color);
    return `<button class="htab${t.focused ? " on" : ""}${m.pin ? " pinned" : ""}" data-tab="${esc(t.tabId)}"`
      + `${tint ? ` style="--htab-tint:${tint}"` : ""} title="${esc(label)}">`
      + (m.pin ? `<span class="htab-pin">${icon("pin", 10)}</span>` : "")
      + `<span class="htab-name">${esc(label)}</span>`
      + `<span class="htab-x" data-close="${esc(t.tabId)}" title="닫기">${icon("close", 10)}</span>`
      + `</button>`;
  }).join("");
  const add = getIsLocal()
    ? `<button class="htab-add" data-add="1" title="새 탭: 눌러서 무엇을 띄울지 고릅니다">${icon("plus", 12)}</button>`
    : "";
  strip.innerHTML = `<div class="htab-scroll">${items}</div>${add}`;
  // 지금 보고 있는 탭이 밀려 나가 있으면 끌어온다. 보이지 않는 탭이 활성이면 위치를 알 수 없다.
  strip.querySelector(".htab.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  strip.querySelector(".htab-scroll")?.addEventListener("scroll", markOverflow, { passive: true });
  markOverflow();
  syncLayout();
}

// 밀려 나간 탭이 있는지 알린다. 막대를 감추면 탭이 더 있는지 알 수 없다.
// 줄 높이는 그대로 두고 탭 아래에 얇은 막대를 직접 그린다.
// 브라우저 기본 막대는 별도 공간을 차지해 줄이 그만큼 두꺼워진다.
function markOverflow() {
  const box = strip?.querySelector(".htab-scroll");
  if (!box) return;
  const over = box.scrollWidth - box.clientWidth;
  strip.classList.toggle("more-l", box.scrollLeft > 1);
  strip.classList.toggle("more-r", over > 1 && box.scrollLeft < over - 1);
  // 그림자는 스크롤 영역의 양 끝에만 그린다. 줄 끝까지 늘리면 옆의 + 버튼까지 덮는다.
  strip.style.setProperty("--htab-l", box.offsetLeft + "px");
  strip.style.setProperty("--htab-r", (strip.clientWidth - box.offsetLeft - box.clientWidth) + "px");
  let bar = strip.querySelector(".htab-bar");
  if (over <= 1) { bar?.remove(); return; }
  if (!bar) {
    bar = document.createElement("span");
    bar.className = "htab-bar";
    strip.appendChild(bar);
  }
  const w = Math.max(18, box.clientWidth * (box.clientWidth / box.scrollWidth));
  const left = box.offsetLeft + (box.scrollLeft / over) * (box.clientWidth - w);
  bar.style.width = w.toFixed(1) + "px";
  bar.style.left = left.toFixed(1) + "px";
  // 스크롤 영역의 아래 끝에 맞춰 탭을 조금 덮는다. 아래 여백으로 내리면 줄이 두꺼워 보인다.
  bar.style.bottom = (strip.clientHeight - box.offsetTop - box.clientHeight) + "px";
}

// 이 줄이 생기거나 사라지면 그만큼 터미널이 짧아지거나 길어진다. 다시 측정하지 않으면 herdr 이
// 이전 줄 수로 그려 아래가 빈다. 줄 높이가 바뀌었을 때만 알린다.
function syncLayout() {
  const h = strip.hidden ? 0 : strip.offsetHeight;
  if (h === lastHeight) return;
  lastHeight = h;
  if (onLayoutChange) requestAnimationFrame(() => onLayoutChange());
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function onClick(e) {
  const close = e.target.closest("[data-close]");
  if (close) { e.stopPropagation(); closeTab(close.dataset.close); return; }
  const add = e.target.closest("[data-add]");
  // 이 클릭이 문서까지 올라가면 "메뉴 밖을 눌렀으니 닫는다" 규칙에 스스로 걸려 방금 띄운 메뉴가
  // 즉시 사라진다. 우클릭 메뉴는 click 이 아니라 contextmenu 로 뜨기 때문에 이 함정이
  // 왼쪽 버튼으로 여는 경우에만 있다.
  if (add) { e.stopPropagation(); const r = add.getBoundingClientRect(); openCreateMenu(r.left, r.bottom + 4); return; }
  const tab = e.target.closest(".htab");
  if (tab) wsSend({ type: "tab-focus", tabId: tab.dataset.tab });
}

function closeTab(tabId) {
  if (!tabId) return;
  if (!getIsLocal()) { showToast("원격에서는 터미널 탭을 닫을 수 없습니다"); return; }
  wsSend({ type: "tab-close", tabId });
}

// 새 탭에서 무엇을 띄울지 이 메뉴에서 고른다. 탭 생성·이름 입력·명령 입력의 세 단계를
// 한 단계로 줄인다.
export function openCreateMenu(x, y, spaceId) {
  if (!getIsLocal()) { showToast("원격에서는 터미널 탭을 만들 수 없습니다"); return; }
  const space = spaceId || currentSpace();
  if (!space) { showToast("먼저 스페이스를 선택하세요"); return; }
  showCtx(x, y, createItems(space));
}

// 스페이스 메뉴도 같은 항목을 쓴다. 새 탭을 여는 경로가 둘인데 선택지가 다르면 안 된다.
export function createItems(space) {
  const make = (launch, name) => wsSend({ type: "tab.create", workspaceId: space, name, launch });
  return [
    { label: "새 탭 — Claude 세션", act: () => make("claude", "claude") },
    { label: "새 탭 — Codex 세션", act: () => make("codex", "codex") },
    { label: "새 탭 — 빈 터미널", act: () => wsSend({ type: "tab.create", workspaceId: space }) },
  ];
}

function onContext(e) {
  const el = e.target.closest(".htab");
  if (!el) return;
  e.preventDefault();
  const tabId = el.dataset.tab;
  const tabs = orderedTabs(currentSpace());
  const at = tabs.findIndex((t) => t.tabId === tabId);
  const cur = tabs[at];
  const m = metaOf(tabId);
  const local = getIsLocal();
  const closeMany = (list) => { for (const t of list) wsSend({ type: "tab-close", tabId: t.tabId }); };
  showCtx(e.clientX, e.clientY, [
    { label: "이름 바꾸기", disabled: !local, act: async () => {
      const v = await askText("탭 이름", cur?.label || "");
      if (v !== null && v !== "") wsSend({ type: "tab.rename", tabId, label: v });
    } },
    { label: m.pin ? "고정 풀기" : "고정", act: () => setMeta(tabId, { pin: !m.pin }) },
    { label: "색", swatches: COLORS.map((c) => ({
      label: c.label, color: c.pal, on: (m.color || "") === c.id,
      act: () => setMeta(tabId, { color: c.id }),
    })) },
    { sep: true },
    { label: "탭 닫기", disabled: !local, act: () => closeTab(tabId) },
    { label: "다른 탭 모두 닫기", disabled: !local || tabs.length < 2,
      act: () => closeMany(tabs.filter((t) => t.tabId !== tabId)) },
    { label: "오른쪽 탭 모두 닫기", disabled: !local || at >= tabs.length - 1,
      act: () => closeMany(tabs.slice(at + 1)) },
    { label: "왼쪽 탭 모두 닫기", disabled: !local || at <= 0,
      act: () => closeMany(tabs.slice(0, at)) },
  ]);
}
