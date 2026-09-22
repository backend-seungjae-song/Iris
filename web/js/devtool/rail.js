// rail: 맨왼쪽 도구 화면을 고르고 순환한다.
//
// 소유 범위
//   rail DOM/body class 전환, 버튼 클릭·키보드 순환 규칙, 어떤 도구 화면을 내려 두었는가
//   화면 목록·이름·배치·잠금은 소유하지 않는다(core/rail-items.js). 켜짐 상태도 소유하지
//   않는다(core/features.js). rail 은 그 상태를 화면에 반영한다.
//
// 제공 API
//   initRail({ browserMode, toggleSidebar, screens }): 버튼과 화면 콜백 표를 받는다. main 이 한 번 부른다.
//   railSelect(view): 이름으로 화면을 고른다.
//   cycleRail(dir): DOM에 놓인 rail 순서대로 앞뒤 화면을 고른다(내린 것은 건너뛴다).
//   railScreens() · setRailScreen(id) · applyRailVisibility(): 설정의 「편의 기능」이 쓴다.
//   켜짐 상태 자체는 제공하지 않는다. 필요한 쪽은 core/features.js 에 직접 묻는다.
//   railButtonsMarkup(items, activeId): index.html 의 rail 마크업과 표를 대조하는 기준.
//   registerScreen(id, screen): 늦게 로드된 capability 가 자기 enter/leave 를 등록하는 지점.
//
// 의존 대상
//   browserMode, sidebar 토글, 화면 이름 → { enter, leave } 콜백 표를 init 에서 주입받는다.
//   각 화면 모듈을 import 하지 않는다. 아직 main 에 남은 화면과도 순환 없이 같은 표로 다룬다.
//   화면의 정적 사실은 core/rail-items.js 에서 읽는다.
//
// 유지 조건
//   body의 *-active/util-full class가 실제 CSS 화면 선택의 정본이다. 이름과 적용 순서를 바꾸지 않는다.
//   표에 없는 이름으로는 화면을 바꾸지 않는다. 그대로 진행하면 화면이 통째로 빈다.
//   선택 화면의 enter/refresh 뒤에 다른 화면의 leave를 부른다. session graph의 폴링 종료 시점이 달려 있다.
//   내린 화면은 railSelect 가 거절한다. 버튼만 감추면 순환·딥링크로는 여전히 열려 끈 상태와 화면이 어긋난다.
//
// 영향 범위
//   main 의 화면 콜백 조립부, panel/layout.js 의 sidebar 토글, 모든 rail 화면의 enter/leave 계약,
//   devtool/settings-view.js 의 「편의 기능」 분류, web/css/02-rail.css 의 .rail-ico[hidden].

import { RAIL_ITEMS, railItemById, fullIds, lockedIds } from "../core/rail-items.js";
import { featureHidden, featureList, toggleFeature, panelFeatures } from "../core/features.js";

const RAIL_FULL = new Set(fullIds());
let browserMode = false;
let toggleSidebar = null;
let screens = {};

// 안 쓰는 도구는 내려 둘 수 있다. 목록·이름·내릴 수 없는 항목은 전부
// core/rail-items.js 가 소유하므로 여기서 다시 적지 않는다.
const RAIL_LOCKED = new Set(lockedIds());

// index.html 의 rail 버튼이 이 표와 같은 것을 말하는지 대조할 기준. 지금은 마크업을 런타임에
// 교체하지 않는다. 교체하면 앞선 초기화가 하나만 실패해도 rail 이 계속 빈 채로 남는다. 대신
// 검사가 이 결과와 index.html 을 글자로 맞춰서 둘이 갈라지는 것을 막는다.
export function railButtonsMarkup(items, activeId) {
  return (items || RAIL_ITEMS).map((f) =>
    `<button class="rail-ico${f.id === activeId ? " active" : ""}" data-rail="${f.id}" title="${f.title}">`
    + `<span class="ri"><svg viewBox="0 0 24 24" aria-hidden="true">${f.icon}</svg></span>`
    + `<span class="rl">${f.label}</span></button>`).join("\n    ");
}
// 설정 화면이 그릴 목록. 표를 그대로 읽는다. DOM 에서 읽으면 rail 이 그려지기 전에는 비어 있다.
export function railScreens() { return featureList(); }
export async function setRailScreen(id) {
  if (!await toggleFeature(id)) return false;
  applyRailVisibility();
  return true;
}
// 내린 화면은 rail 에서 사라지고, 그 화면으로 가는 길도 함께 닫힌다. 버튼만 감추면 단축키로는
// 여전히 들어갈 수 있어 끈 상태와 화면이 어긋난다.
export function applyRailVisibility() {
  const hidden = featureHidden();
  let activeGone = false;
  // rail 밖에서 영역만 갖는 기능(실행 패널 등)은 그 영역을 함께 내린다. 버튼이 없으니
  // 여기서 내리지 않으면 끈 뒤에도 빈 패널이 남아 끈 상태와 화면이 어긋난다.
  for (const f of panelFeatures()) {
    const el = document.getElementById(f.panel);
    if (el) el.hidden = hidden.has(f.id);
  }
  for (const b of document.querySelectorAll(".rail-ico[data-rail]")) {
    const off = hidden.has(b.dataset.rail) && !RAIL_LOCKED.has(b.dataset.rail);
    b.hidden = off;
    if (off && b.classList.contains("active")) activeGone = true;
  }
  if (activeGone) railSelect("workspace");
}

export function initRail(deps) {
  browserMode = !!deps.browserMode;
  toggleSidebar = deps.toggleSidebar;
  screens = deps.screens || {};
  const rail = document.querySelector("#actrail"); if (!rail || browserMode) return; // 분리 브라우저 창엔 rail 없음
  applyRailVisibility();
  rail.addEventListener("click", (e) => {
    const b = e.target.closest(".rail-ico"); if (!b) return;
    if (b.id === "rail-sidebar-toggle") { toggleSidebar(); return; } // 접기/펴기는 rail 라인 액션
    if (b.dataset.rail) railSelect(b.dataset.rail);
  });
}

// 영역(패널 element)도 그 기능이 만든다. index.html 이 여덟 영역을 항상 그리면
// 끈 기능의 마크업도 파싱되어, 끈 기능은 로드되지 않는다는 규칙이 JS 에만 적용된다.
// 셸(aside 의 id·class)은 표가 정본이고, 안에 무엇이 들어가는지만 그 기능이 소유한다.
// 영역을 붙이는 순서는 연결보다 앞이다. 소스 제어처럼 init 에서 자기 영역을 찾는 기능이 있다.
export function registerPanel(railId, html) {
  const item = railItemById(railId);
  if (!item || !item.panel) return false;
  if (document.getElementById(item.panel)) return true;   // 이미 있다(다시 켠 경우)
  const host = document.getElementById("util-resizer");
  if (!host || !host.parentNode) return false;
  const el = document.createElement("aside");
  el.className = "rail-panel " + item.panel;
  el.id = item.panel;
  el.innerHTML = html;
  host.parentNode.insertBefore(el, host);
  // 지금 그 화면을 보고 있었다면 즉시 연다.
  const cur = document.querySelector(".rail-ico.active[data-rail]");
  if (cur && cur.dataset.rail === railId) el.classList.add("is-open");
  el.hidden = featureHidden().has(railId);
  return true;
}

// 늦게 로드된 화면이 자기 영역을 등록하는 지점. capability 는 부팅 뒤에 도착하므로 initRail 시점에는
// 그 영역이 비어 있다. 도착했을 때 이미 그 화면을 보고 있으면 즉시 한 번 진입한다.
// 그렇지 않으면 먼저 누른 사용자에게 빈 화면이 남는다.
export function registerScreen(id, screen) {
  if (!id || !screen) return false;
  // 같은 화면 이름을 둘이 등록하면 나중 것이 덮어써서 먼저 것은 호출되지 않는다. 먼저 온 것을
  // 유지하고 나중 것을 거절한다. 이름이 겹친 것은 설계 오류이지 등록 순서의 문제가 아니다.
  if (screens[id] && screens[id] !== screen) {
    try { console.error("[rail] 이미 등록된 화면 이름:", id); } catch {}
    return false;
  }
  screens[id] = screen;
  const cur = document.querySelector(".rail-ico.active[data-rail]");
  if (cur && cur.dataset.rail === id) screen.enter?.();
  return true;
}

export function railSelect(view) {
  // 표에 없는 이름을 받으면 아무것도 하지 않는다. 그대로 진행하면 활성 표시와 body
  // class 를 모두 제거하고 모든 화면의 leave 를 불러 화면이 통째로 빈다. 화면을 지우거나
  // 이름을 바꾼 뒤 이전 설정이 남아 있으면 바로 이 경로로 들어온다.
  if (!railItemById(view)) return;
  if (featureHidden().has(view) && !RAIL_LOCKED.has(view)) return;   // 내린 화면으로는 가지 않는다
  document.querySelectorAll(".rail-ico").forEach((b) => b.classList.toggle("active", !!b.dataset.rail && b.dataset.rail === view));
  for (const f of RAIL_ITEMS) if (f.body) document.body.classList.toggle(f.body, view === f.id);
  // 영역은 CSS 한 줄이 정한다. 켠 것만 is-open 을 붙인다. 화면마다 나머지를 이름으로
  // 열거하면 기능을 추가할 때마다 그 목록을 모두 고쳐야 한다.
  for (const f of RAIL_ITEMS) if (f.panel) document.getElementById(f.panel)?.classList.toggle("is-open", view === f.id);
  // 파일 섹션은 전용 영역이 있는 화면이 열릴 때만 내려간다(작업 화면은 그 섹션이 본체다).
  document.body.classList.toggle("screen-open", !!railItemById(view)?.panel);
  document.body.classList.toggle("util-full", RAIL_FULL.has(view));
  screens[view]?.enter?.();
  for (const [name, screen] of Object.entries(screens)) if (name !== view) screen.leave?.();
}

// ⌘⌥↑/↓ = 맨왼쪽 rail 도구 페이지 순환(워크스페이스↔소스제어↔계정).
export function cycleRail(dir) {
  if (browserMode) return; // 분리 브라우저 창엔 rail 없음
  // 내린 화면은 순환에서도 빠진다. 보이지 않는 화면을 지나가면 눌러도 아무 변화가 없다.
  const rails = [...document.querySelectorAll(".rail-ico[data-rail]:not([hidden])")].map((b) => b.dataset.rail);
  if (rails.length < 2) return;
  const cur = document.querySelector(".rail-ico.active[data-rail]");
  let i = cur ? rails.indexOf(cur.dataset.rail) : 0; if (i < 0) i = 0;
  i = (i + dir + rails.length) % rails.length;
  railSelect(rails[i]);
}
