// 분리 브라우저 창의 탭바. 칩·다중 선택·그룹·우클릭 메뉴를 담당한다.
//
// 소유 범위
//   분리창이 지금 미러링 중인 스페이스, 다중 선택 집합과 범위 선택의 기준점,
//   그리고 끌기 중의 임시 순서.
//
// 제공 API
//   탭바 렌더, 선택 해제, AI 글로우 동기화, 그룹 만들기, 인라인 이름 바꾸기,
//   탭·다중·그룹·저장된그룹 네 종류의 우클릭 메뉴, 저장된 그룹 열기.
//
// 의존 대상
//   상태는 browser/state, webview 는 browser/webview 와 webview-store,
//   AI 가 쥔 탭은 browser/ai-state, Chrome 넘기기는 handoff.tabItem 훅으로 받는다,
//   순서 바꾸기는 core/reorder 에서 import 한다.
//   $·esc·cssEsc·showToast·showCtx·renderTabs·startTabRename·newBrowserTab 은
//   main 이 소유해서 init 에서 받는다.
//
// 유지 조건
//   선택은 화면 상태이므로 서버에 올리지 않는다. 두 창이 각자 다른 것을 고를 수 있어야 한다.
//   조작은 mutation 으로만 보내고 목록은 수신에서 멱등 렌더한다. 여기서 직접 고치면
//   두 창이 갈라진다.
//
// 영향 범위
//   #bm-tabs DOM 과 main 의 브라우저 창 조립부.
//   webview 는 이 모듈을 import 하지 않는다. renderBmTabs 를 main 이 주입한다.
//   그러지 않으면 webview ↔ tabs 순환이 생긴다.
//   이 API를 바꾸면 import 하는 파일도 함께 바꿔야 한다:
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs web/js/browser/tabs.js
import {
  bmActiveId, bmTabs, boundSpace, bsMutate, curBmSpace, getBrowserState,
} from "./state.js";
import { aiBusyLabels, aiHolds } from "./ai-state.js";
import { activeBrowserId, hasTabDialog, newTabId } from "./webview.js";
import { getWebview, getWebviewStatus } from "./webview-store.js";
import { isTabDirty } from "../center/tab-close.js";
import { getTabs } from "../center/tab-store.js";
import { wireReorder } from "../core/reorder.js";
import { fileKindById, isFileKindId } from "../core/file-kinds.js";
import { callHook } from "../core/hooks.js";
import { mayWriteSharedActive } from "./active-tab.js";

let $, esc, cssEsc, showToast, showCtx, renderTabs, startTabRename, newBrowserTab;
let BROWSER_MODE;
let tabstrip, browserview, closeTabs, isFileLikeKind, getPickMode;

export function initBrowserTabs(deps) {
  ({ $, esc, cssEsc, showToast, showCtx, renderTabs, startTabRename, newBrowserTab,
    tabstrip, browserview, closeTabs, isFileLikeKind, getPickMode, BROWSER_MODE } = deps);
}

// 사용자 조작은 mutation으로만 보낸다(수신은 멱등 렌더 → 무한 트리거 없음). 활성 스페이스가 콘솔에서
// 바뀌면 분리창도 그 스페이스 탭들로 재바인딩된다(다중 작업용).
const bmGroups = () => (getBrowserState().groupsBySpace && getBrowserState().groupsBySpace[boundSpace()]) || [];
const savedGroups = () => getBrowserState().savedGroups || [];
const newId = (p) => p + Date.now().toString(36) + "." + Math.floor(Math.random() * 1e6).toString(36);
// 다중 선택(크롬식): cmd/ctrl+클릭 토글, shift+클릭 범위. 선택은 화면 상태라 서버에 안 올린다.
const selTabs = new Set();
let selAnchor = null;   // shift 범위의 기준점
let bmOrder = [];       // 화면에 그려진 순서(접힌 그룹의 탭은 제외). shift 범위는 보이는 것 기준
function clearSel() { if (!selTabs.size) return false; selTabs.clear(); selAnchor = null; return true; }
// 탭 앞머리 표시: 로딩 중이면 회전자, 소리가 나면 스피커, 그 밖엔 파비콘. 크롬과 같은 위치다.
// 아이콘이 없거나 불러오지 못하면 사이트 첫 글자로 대체한다. 빈 칸이 남으면 글자만 밀려 보인다.
function tabLead(t) {
  // 그림글자는 그 뷰어가 소유한다. 새 뷰어를 추가할 때 이 줄을 함께 고치지 않기 위해서다.
  const doc = fileKindById(t.kind);
  if (doc) return `<span class="cfav cfav-txt">${doc.docIcon || "📄"}</span>`;
  const st = getWebviewStatus(t.id) || {};
  if (st.sleeping) return '<span class="csleep" title="메모리를 회수한 잠자는 탭 · 클릭하면 다시 엽니다">◌</span>';
  if (st.loading) return `<span class="cspin" title="불러오는 중"></span>`;
  if (st.audible) return `<span class="caudio" title="소리 재생 중">🔊</span>`;
  if (st.icon) return `<img class="cfav" src="${esc(st.icon)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'cfav cfav-txt',textContent:this.dataset.i||'·'}))" data-i="${esc(favLetter(t))}">`;
  return `<span class="cfav cfav-txt">${esc(favLetter(t))}</span>`;
}
function favLetter(t) {
  const status = getWebviewStatus(t.id);
  const u = (status && status.url) || t.url || "";
  try { return (new URL(u).hostname.replace(/^www\./, "")[0] || "·").toUpperCase(); } catch { return "·"; }
}
// 이너 글로우는 "지금 보고 있는 탭이 조작 중일 때만". 다른 스페이스·다른 탭에 있는데 화면이
// 빛나면 무엇이 조작되는지 알리지 못하고 항상 켜진 표시가 된다.
export function syncAiGlow() {
  const id = activeBrowserId();
  document.body.classList.toggle("ai-controlling", !!(id && aiHolds(id)));
}
function tabChip(t, act) {
  bmOrder.push(t.id);
  const st = getWebviewStatus(t.id) || {};
  const asking = hasTabDialog(t.id) ? '<span class="cask" title="이 탭이 답을 기다립니다">?</span>' : "";
  // 세션이 조작 중인 탭임을 탭 자체에 표시한다. 어느 탭을 AI 가 조작 중인지 화면에서 알 수 있어야 한다.
  // ● = 지금 이 탭을 조작 중. 끝나면 사라진다. 병렬로 여러 세션이 붙으면 개수까지 보인다
  // (고정 기준으로 판정하면 조작이 끝나도 남고, 마지막 세션 하나만 보인다).
  const busy = aiBusyLabels(t.id);
  const ai = busy.length ? `<span class="cai" title="${esc(busy.join(", "))} 세션이 지금 이 탭을 조작 중">●${busy.length > 1 ? busy.length : ""}</span>` : "";
  // 저장되지 않은 편집이 있는 docx/sheet 탭은 앞에 동그라미(markTabDirty와 같은 표시)를 낸다. 그
  // 상태(_svDirty 등)는 sbState가 아니라 로컬 탭 객체에만 있어 여기서 직접 찾아야 한다. 이 함수는
  // sbState 브로드캐스트마다 전체를 innerHTML로 새로 그리므로(그 자체에 dirty 표시가 없으면)
  // markTabDirty로 나중에 DOM에 끼워 넣어도 다음 브로드캐스트에 곧바로 지워진다.
  const local = isFileKindId(t.kind) && getTabs(boundSpace()).find((x) => x.id === t.id);
  const dirty = local && isTabDirty(local);
  const cls = [t.id === act ? "active" : "", t.group ? "in-group" : "", selTabs.has(t.id) ? "selected" : "", st.loading ? "loading" : "", busy.length ? "ai-held" : "", dirty ? "dirty" : ""].filter(Boolean).join(" ");
  return `<div class="ctab${cls ? " " + cls : ""}" draggable="true" data-tab="${esc(t.id)}" title="더블클릭: 이름 변경 · 우클릭: 메뉴 · 드래그: 순서 변경 · Ctrl/⇧+클릭: 다중 선택">${dirty ? '<span class="cdirty"></span>' : ""}${tabLead(t)}${asking}${ai}<span class="cname">${esc(t.name || t.title || "브라우저")}</span><button class="cclose" data-close="${esc(t.id)}">✕</button></div>`;
}
// 그룹 → 그 그룹의 탭 → … → 그룹 없는 탭 순으로 렌더한다. 접힌 그룹은 칩만 남고 탭이 숨는다
// (webview는 유지되므로 로그인·스크롤 상태는 그대로이고, 렌더에서만 감춘다).
export function renderBmTabs() {
  // 이 함수는 분리 브라우저 창 전용이다. 콘솔 창은 같은 #tabstrip에 파일·브라우저 탭을 renderTabs로
  // 그리는데, 여기서 덮어쓰면 파일 탭 자리에 브라우저 탭 칩이 들어간다. 그 칩에는 콘솔 쪽 클릭 연결이
  // 없어서 눌러도 아무 일이 없고 화면도 바뀌지 않는다. 브라우저 탭이 파일 쪽 탭에 생기고
  // 정상적으로 표시되지 않는다. 콘솔에서는 자기 탭바를 다시 그린다. 부르는 쪽은 "탭바 갱신"을 뜻하기 때문이다.
  if (!BROWSER_MODE) { renderTabs(); return; }
  const act = bmActiveId(), groups = bmGroups();
  // 탭 분리가 로드됐으면 두 가지를 알려 준다. 이 창이 한 탭에 묶였는가, 그리고 어느 탭이 지금
  // 다른 창으로 떨어져 나갔는가. 로드되지 않았으면 둘 다 없고 이전과 같이 전부 그린다.
  const onlyTab = callHook("detach.boundTab") || null;
  const hiddenTabs = callHook("detach.hidden") || null;
  let tabs = bmTabs();
  if (onlyTab) tabs = tabs.filter((x) => x.id === onlyTab);
  else if (hiddenTabs && hiddenTabs.size) tabs = tabs.filter((x) => !hiddenTabs.has(x.id));
  const live = new Set(tabs.map((x) => x.id));
  for (const id of [...selTabs]) if (!live.has(id)) selTabs.delete(id); // 닫힌 탭은 선택에서 정리
  bmOrder = [];
  let html = "";
  // 탭 하나짜리 창에는 그룹 띠를 그리지 않는다. 그 창은 그 탭 하나가 전부라, 원래 창의 그룹이
  // 따라오면 "빼냈는데 소속은 그대로"로 보인다.
  // 그룹은 원래 창의 정리 도구다. 옮긴 것이 아니라 감춘 것이므로 원래 창에서는 그대로 유지된다.
  if (!onlyTab) {
    for (const g of groups) {
      const mine = tabs.filter((x) => x.group === g.id);
      html += `<div class="tgroup" data-group="${esc(g.id)}" title="클릭: 접기/펴기 · 우클릭: 그룹 메뉴">${g.collapsed ? "▶" : "▼"} ${esc(g.name)} <span class="tgcount">${mine.length}</span></div>`;
      if (!g.collapsed) html += mine.map((x) => tabChip(x, act)).join("");
    }
    html += tabs.filter((x) => !x.group).map((x) => tabChip(x, act)).join("");
  } else {
    html += tabs.map((x) => tabChip(x, act)).join("");
  }
  if (onlyTab) {
    // 탭 하나짜리 창에는 추가 버튼도, 되돌리는 버튼도 두지 않는다. 되돌리는 방법은 크롬과 같다.
    // 그 탭을 다른 창의 띠로 끌어다 놓으면 붙고, 창을 닫아도 원래 위치로 돌아간다.
  } else {
    html += `<div class="ctab-add" data-add="1" title="새 탭(구글)">+</div>`;
    if (savedGroups().length) html += `<div class="ctab-add" data-saved="1" title="저장된 그룹 열기">📁</div>`;
  }
  tabstrip.innerHTML = html;
  syncAiGlow();
  // 띠의 끌기. 탭 분리가 로드됐으면 그 기능이 크롬과 같은 방식(포인터 기반)으로 연결한다.
  // 경계를 넘는 순간 창이 되고, 다른 창의 띠에 들어가는 순간 붙는다. 그 판정은 창 밖을 봐야
  // 해서 이 창이 할 수 없다.
  // 기능이 없으면 기본 방식으로 위치 이동만 한다. 끄면 분리가 없어질 뿐 재정렬은 그대로다.
  const moveTab = (id, before) => { const sp = curBmSpace(); if (sp) bsMutate({ op: "tab.move", space: sp, id, before }); };
  const wired = callHook("detach.stripReady", tabstrip, {
    tabSel: ".ctab",
    keyOf: (el) => el.dataset.tab,
    titleOf: (id) => { const t = bmTabs().find((x) => x.id === id); return (t && (t.name || t.title)) || ""; },
    spaceOf: () => curBmSpace(),
    move: moveTab,
  });
  if (!wired) wireReorder(tabstrip, ".ctab", (el) => el.dataset.tab, moveTab);
}
// 그룹을 만들고 탭들을 넣은 뒤, 그 그룹 칩의 이름을 바로 인라인 편집 상태로 연다.
// (Electron엔 window.prompt가 없으므로 이 코드베이스의 인라인 편집 방식을 따른다.)
function makeGroup(sp, ids, defaultName) {
  const gid = newId("g");
  bsMutate({ op: "group.create", space: sp, id: gid, name: (defaultName || "새 그룹").slice(0, 40) });
  for (const id of ids) bsMutate({ op: "tab.group", space: sp, id, group: gid });
  renderBmTabs();
  setTimeout(() => startInlineGroupRename(gid), 0); // 렌더 후 칩이 생기면 편집 시작
}
function startInlineGroupRename(gid) {
  const sp = boundSpace(), g = bmGroups().find((v) => v.id === gid); if (!g) return;
  const chip = tabstrip.querySelector(`.tgroup[data-group="${cssEsc(gid)}"]`); if (!chip) return;
  const holder = document.createElement("span"); chip.innerHTML = ""; chip.appendChild(holder);
  startTabRename(holder, g.name, (v) => {
    if (v !== null && v) bsMutate({ op: "group.rename", space: sp, id: gid, name: v });
    renderBmTabs();
  });
}
function startInlineTabRename(tabId) {
  const sp = boundSpace(), tb = bmTabs().find((v) => v.id === tabId); if (!tb) return;
  const nameEl = tabstrip.querySelector(`.ctab[data-tab="${cssEsc(tabId)}"] .cname`); if (!nameEl) return;
  startTabRename(nameEl, tb.name || tb.title || "", (v) => {
    if (v !== null) bsMutate({ op: "tab.rename", space: sp, id: tabId, name: v });
    renderBmTabs();
  });
}
// 탭 우클릭. 그룹 소속 관리와 이름 변경.
function openTabCtx(x, y, tabId) {
  const sp = boundSpace(), tb = bmTabs().find((v) => v.id === tabId); if (!tb) return;
  const items = [];
  items.push({ label: "새 그룹으로 묶기", act: () => makeGroup(sp, [tabId], tb.name || tb.title || "새 그룹") });
  const others = bmGroups().filter((g) => g.id !== tb.group);
  if (others.length) {
    items.push({ sep: true });
    for (const g of others) items.push({ label: `그룹 "${g.name}"에 추가`, act: () => bsMutate({ op: "tab.group", space: sp, id: tabId, group: g.id }) });
  }
  if (tb.group) items.push({ label: "그룹에서 빼기", act: () => bsMutate({ op: "tab.group", space: sp, id: tabId, group: null }) });
  items.push({ sep: true });
  items.push({ label: "이름 변경", act: () => startInlineTabRename(tabId) });
  // 이 창에서 끝낼 수 없는 것(패스키·지문, 임베드를 막는 사이트, 확장이 필요한 흐름)을 진짜 Chrome에
  // 넘긴다. 그 창은 이 탭의 프로필을 물려받고, 끝나면 로그인만 돌아온다.
  // 이 줄을 만드는 것은 넘기기 기능이다. 로드되지 않았거나 넘길 수 없는 탭이면 아무것도 오지 않는다.
  const handoffItem = callHook("handoff.tabItem", getWebview(tabId));
  if (handoffItem) items.push(handoffItem);
  const mirrorItem = callHook("mirror.tabItem", getWebview(tabId));
  if (mirrorItem) items.push(mirrorItem);
  // 탭을 자기 창으로 빼내는 줄. 이 줄을 만드는 것은 탭 분리 기능이고, 로드되지 않았으면 오지 않는다.
  const detachItem = callHook("detach.tabItem", tb, sp);
  if (detachItem) items.push(detachItem);
  items.push({ label: "탭 닫기", danger: true, act: () => bsMutate({ op: "tab.close", space: sp, id: tabId }) });
  showCtx(x, y, items);
}
// 선택된 여러 탭에 대한 일괄 동작. 대상이 "지금 선택된 것들"임을 라벨에 개수로 표시한다.
function openMultiCtx(x, y) {
  const sp = boundSpace(), ids = [...selTabs], n = ids.length;
  const items = [];
  items.push({ label: `새 그룹으로 묶기 (${n}탭)`, act: () => { makeGroup(sp, ids, "새 그룹"); clearSel(); } });
  const groups = bmGroups();
  if (groups.length) {
    items.push({ sep: true });
    for (const g of groups) items.push({ label: `그룹 "${g.name}"에 추가 (${n})`, act: () => {
      for (const id of ids) bsMutate({ op: "tab.group", space: sp, id, group: g.id });
      clearSel(); renderBmTabs();
    } });
  }
  items.push({ sep: true });
  items.push({ label: `그룹에서 빼기 (${n})`, act: () => { for (const id of ids) bsMutate({ op: "tab.group", space: sp, id, group: null }); clearSel(); renderBmTabs(); } });
  items.push({ label: "선택 해제", act: () => { clearSel(); renderBmTabs(); } });
  items.push({ sep: true });
  items.push({ label: `탭 ${n}개 닫기`, danger: true, act: () => {
    if (!confirm(`선택한 탭 ${n}개를 닫을까요?`)) return;
    for (const id of ids) bsMutate({ op: "tab.close", space: sp, id });
    clearSel(); renderBmTabs();
  } });
  showCtx(x, y, items);
}
// 그룹 칩 우클릭. 이름·저장·해제·일괄 닫기.
function openGroupCtx(x, y, gid) {
  const sp = boundSpace(), g = bmGroups().find((v) => v.id === gid); if (!g) return;
  const mine = bmTabs().filter((v) => v.group === gid);
  const items = [
    // 그룹에서 작업하다 탭을 하나 더 여는 흐름이다. 새 탭을 만들고 끌어다 넣는 두 단계를 없앤다.
    { label: "이 그룹에 새 탭", act: () => {
      if (g.collapsed) bsMutate({ op: "group.collapse", space: sp, id: gid, collapsed: false }); // 접힌 채로 만들면 안 보인다
      newBrowserTab(null, { group: gid, space: sp });
    } },
    { sep: true },
    { label: g.collapsed ? "펼치기" : "접기", act: () => bsMutate({ op: "group.collapse", space: sp, id: gid, collapsed: !g.collapsed }) },
    { label: "그룹 이름 변경", act: () => startInlineGroupRename(gid) },
    { sep: true },
    { label: `그룹 저장 (${mine.length}탭)`, disabled: !mine.length, act: () => {
      if (!mine.length) return;
      bsMutate({ op: "group.save", space: sp, id: gid, savedId: newId("s"), at: new Date().toISOString() });
      showToast(`"${g.name}" 저장됨. 📁에서 다시 열 수 있습니다.`);
    } },
    { sep: true },
    { label: "그룹만 해제 (탭 유지)", act: () => bsMutate({ op: "group.remove", space: sp, id: gid }) },
    { label: `그룹 탭 모두 닫기 (${mine.length})`, danger: true, act: () => {
      if (!confirm(`"${g.name}" 그룹의 탭 ${mine.length}개를 닫을까요?`)) return;
      for (const v of mine) bsMutate({ op: "tab.close", space: sp, id: v.id });
      bsMutate({ op: "group.remove", space: sp, id: gid });
    } },
  ];
  showCtx(x, y, items);
}
// 저장된 그룹 목록. 어느 창에서든 열 수 있다(스페이스에 종속되지 않는다).
function openSavedCtx(x, y) {
  const sp = boundSpace(), list = savedGroups();
  if (!list.length) { showToast("저장된 그룹이 없습니다."); return; }
  const items = [];
  for (const s of list) {
    items.push({ label: `📂 ${s.name} (${s.tabs.length}탭) 열기`, act: () => openSavedGroup(s, sp) });
  }
  items.push({ sep: true });
  for (const s of list) {
    items.push({ label: `✕ "${s.name}" 저장 삭제`, danger: true, act: () => { if (confirm(`저장된 그룹 "${s.name}"을 삭제할까요? (열려있는 탭은 그대로)`)) bsMutate({ op: "saved.remove", id: s.id }); } });
  }
  showCtx(x, y, items);
}
function openSavedGroup(s, sp) {
  if (!sp) return;
  const gid = newId("g");
  bsMutate({ op: "group.create", space: sp, id: gid, name: s.name });
  for (const tb of s.tabs) {
    const id = newTabId();
    bsMutate({ op: "tab.open", space: sp, id, url: tb.url, title: tb.title, profile: tb.profile ?? null });
    if (tb.name) bsMutate({ op: "tab.rename", space: sp, id, name: tb.name });
    bsMutate({ op: "tab.group", space: sp, id, group: gid });
  }
  showToast(`"${s.name}" 열림: ${s.tabs.length}탭`);
}
// 분리창 탭바 연결. 기존 최상위 `if (BROWSER_MODE) { … }` 와 같고, main 이 그 위치에서 부른다.
// 선택 상태가 이 모듈에 있으므로 그 상태를 읽고 쓰는 리스너도 여기 있어야 한다.
export function wireBrowserModeTabstrip() {
  document.body.classList.add("browser-mode");
  browserview.hidden = false;
  // 분리창 탭바 클릭(전환/닫기)은 서버 mutation만. capture로 콘솔 기본 핸들러보다 먼저.
  tabstrip.addEventListener("click", (e) => {
    const sp = boundSpace();
    if (e.target.closest("[data-saved]")) { e.stopPropagation(); const r = e.target.getBoundingClientRect(); openSavedCtx(r.left, r.bottom); return; } // 📁 저장된 그룹
    if (e.target.closest("[data-add]")) { e.stopPropagation(); newBrowserTab(); return; } // + 새 탭
    // 되돌리기는 이 창을 닫는 것과 같다. 탭은 원래 띠로 돌아온다.
    const grp = e.target.closest(".tgroup"); // 그룹 칩 클릭 = 접기/펴기
    if (grp) { e.stopPropagation(); const g = bmGroups().find((v) => v.id === grp.dataset.group); if (g) bsMutate({ op: "group.collapse", space: sp, id: g.id, collapsed: !g.collapsed }); return; }
    const close = e.target.closest(".cclose");
    if (close) {
      e.stopPropagation();
      const cid = close.dataset.close;
      // 문서 탭은 저장하지 않은 변경이 있을 수 있다. 서버 탭만 지우면 에디터 상태가 확인 없이
      // 사라진다. 도킹 창의 닫기와 같은 확인 경로(closeTabs)를 그대로 태운다.
      const localDoc = getTabs(sp).find((t) => t.id === cid && isFileLikeKind(t.kind));
      if (localDoc) { closeTabs([{ space: sp, tabId: cid }]); return; }
      bsMutate({ op: "tab.close", space: sp, id: cid }); return;
    }
    const tab = e.target.closest(".ctab");
    if (tab) {
      e.stopPropagation();
      const id = tab.dataset.tab;
      if (e.metaKey || e.ctrlKey) { // 개별 토글
        if (selTabs.has(id)) selTabs.delete(id); else { selTabs.add(id); selAnchor = id; }
        renderBmTabs(); return;
      }
      if (e.shiftKey) {            // 기준점~클릭 사이 범위(보이는 순서 기준)
        const a = bmOrder.indexOf(selAnchor ?? bmActiveId()), b = bmOrder.indexOf(id);
        if (a >= 0 && b >= 0) { for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selTabs.add(bmOrder[i]); }
        else selTabs.add(id);
        renderBmTabs(); return;
      }
      // 평범한 클릭 = 선택 해제 후 전환(기존 동작). 여기서 동기 재렌더를 하면 두 번째 클릭이
      // 새로 만들어진 노드에 떨어져 dblclick(이름 수정)이 발생하지 않으므로, 선택이 있었을 때만 그린다.
      const had = clearSel(); selAnchor = id;
      // 한 탭에 묶인 창에서는 공유 활성 탭을 옮기지 않는다. 그 창에는 칩이 하나뿐이라 옮길 곳도
      // 없고, 옮기면 원래 창이 "여기서는 감춰진 탭"으로 끌려간다.
      if (mayWriteSharedActive(callHook("detach.boundTab"))) bsMutate({ op: "tab.switch", space: sp, id });
      if (had) renderBmTabs();
    }
  }, true);
  // 빈 곳 클릭·Esc로 선택 해제.
  tabstrip.addEventListener("click", (e) => { if (!e.target.closest(".ctab") && !e.target.closest(".tgroup") && clearSel()) renderBmTabs(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && clearSel()) renderBmTabs(); });
  // 탭·그룹 우클릭 메뉴. 픽 모드 중엔 탭이 "지목" 대상이므로 메뉴를 띄우지 않는다.
  tabstrip.addEventListener("contextmenu", (e) => {
    if (getPickMode()) return;
    const grp = e.target.closest(".tgroup"), tab = e.target.closest(".ctab");
    if (!grp && !tab) return;
    e.preventDefault(); e.stopPropagation();
    if (grp) openGroupCtx(e.clientX, e.clientY, grp.dataset.group);
    else if (selTabs.size > 1 && selTabs.has(tab.dataset.tab)) openMultiCtx(e.clientX, e.clientY);
    else { if (!selTabs.has(tab.dataset.tab) && clearSel()) renderBmTabs(); openTabCtx(e.clientX, e.clientY, tab.dataset.tab); }
  }, true);
  // 탭 이름 더블클릭 → 인라인 편집 → 서버 tab.rename.
  tabstrip.addEventListener("dblclick", (e) => {
    const nameEl = e.target.closest(".cname"); const tab = e.target.closest(".ctab");
    if (!nameEl || !tab) return; e.stopPropagation();
    const sp = boundSpace(), id = tab.dataset.tab;
    const t = bmTabs().find((x) => x.id === id);
    startTabRename(nameEl, (t && t.name) || (t && t.title) || "", (v) => {
      if (v === null) { renderBmTabs(); return; }
      bsMutate({ op: "tab.rename", space: sp, id, name: v }); renderBmTabs();
    });
  }, true);
}
