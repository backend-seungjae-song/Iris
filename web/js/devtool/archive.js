// 보관함: 보관한 스페이스와 세션을 묶어 찾고 복원하거나 삭제한다.
//
// 소유 범위
//   archives, arTailOpen, arQuery, arOpen, arBusy, arFocusSearch 와 보관함 전체 렌더·입력 상태.
//   archive-* WebSocket 메시지 적용과 보관함 DOM 배선.
//
// 제공 API
//   initArchive(deps): DOM·전송·알림과 복원된 스페이스 선택 setter를 받는다. capability 부팅이 부른다.
//   "archive.spaceItem" 이름: 스페이스를 보관하는 우클릭 항목. 앱 셸의 두 메뉴가 이 이름으로 받아 간다.
//   enterArchive(): 화면에 들어올 때 목록을 요청하고 현재 상태를 그린다.
//   handleArchiveMessage(message): archive-* 메시지를 처리했으면 true를 돌려준다.
//
// 의존 대상
//   $, esc, wsSend, showToast, setPendingSpaceFocus 와 보관 항목에 필요한 것들(getIsLocal·
//   getLastAgents·askConfirm)을 init 에서 주입받는다.
//   archive 저장·복원 자체와 진행 순서는 서버가 소유하고, 여기서는 서버가 준 목록만 그린다.
//
// 유지 조건
//   그룹은 workspace id가 아니라 폴더 기준이고 기본은 접힌 상태이며, 검색에 걸린 세션은 펼쳐 보여야 한다.
//   복원 중에는 중복 클릭을 막고, 삭제는 확인을 거치며, 검색은 마지막 화면 내용까지 본다.
//
// 영향 범위
//   core/capabilities.js 의 등록과 서버의 archive-* 메시지 계약, 그리고 이 이름으로 보관 항목을
//   받아 가는 explorer/context-menu.js · herdr/agents.js.

import { provide } from "../core/hooks.js";

// 이 기능의 영역. index.html 이 이 마크업을 항상 그리면 기능을 꺼도
// 셸이 파싱되므로 여기서 만든다. 셸(aside 의 id·class)은 rail 표가 정본이고 여기는 안쪽만 담는다.
export const panelHtml = `
  <div class="scr-bar"><span class="scr-bar-title">보관함</span><button class="scr-ico" id="ar-refresh" title="새로고침">↻</button></div>
  <div class="scr-body" id="ar-body"></div>
`;

let archives = [];
let arTailOpen = new Set();
let arQuery = "";
let arOpen = new Set();   // 펼쳐 둔 스페이스. 기본은 접힘이라 "펼친 것"만 들고 있으면 된다.
let arBusy = null;        // 여러 개를 하나씩 복원하는 중. 진행 위치를 화면에 남긴다
let arFocusSearch = false;
let dom = null;
let escapeHtml = null;
let send = null;
let showToast = null;
let setPendingSpaceFocus = null;
let getIsLocal = () => true;
let getLastAgents = () => [];
let askConfirm = async () => false;

export function initArchive(deps) {
  // 스페이스 보관은 보관 기능의 조작이다. 앱 셸의 우클릭 메뉴가 이 이름으로 받아 가고, 보관을 끄면
  // 채우는 쪽이 없어 항목이 등록되지 않는다. 화면만 사라지고 동작은 남는 상태를 막는다.
  provide("archive.spaceItem", (id, name) => ({
    label: "이 스페이스 접기(보관)", disabled: !getIsLocal(), act: async () => {
      const mine = (getLastAgents() || []).filter((a) => a.workspaceId === id);
      const keep = mine.filter((a) => a.sessionUuid);
      const lost = mine.length - keep.length;
      const warn = lost ? `\n세션 id가 없는 ${lost}개는 기록되지 않고 함께 닫힙니다.` : "";
      if (!(await askConfirm(`"${name}"을(를) 접을까요?\n세션 ${keep.length}개의 되살릴 열쇠와 마지막 화면을 저장한 뒤 실제로 닫습니다.${warn}`))) return;
      send({ type: "archive.space", workspaceId: id });
    },
  }));
  getIsLocal = deps.getIsLocal || getIsLocal;
  getLastAgents = deps.getLastAgents || getLastAgents;
  askConfirm = deps.askConfirm || askConfirm;
  dom = deps.$;
  escapeHtml = deps.esc;
  send = deps.wsSend;
  showToast = deps.showToast;
  setPendingSpaceFocus = deps.setPendingSpaceFocus;
  dom("#ar-body")?.addEventListener("click", (e) => {
    const tog = e.target.closest("[data-ar-toggle]");
    if (tog && !e.target.closest("button")) {
      const id = tog.dataset.arToggle;
      arOpen.has(id) ? arOpen.delete(id) : arOpen.add(id);
      arRender(); return;
    }
    const more = e.target.closest("[data-ar-more]");
    if (more) { const id = more.dataset.arMore; arTailOpen.has(id) ? arTailOpen.delete(id) : arTailOpen.add(id); arRender(); return; }
    // 복원 중에는 다시 누르지 못하게 막는다. 목록이 그 사이 줄어들어 두 번째 요청이 다른 항목을 가리킨다.
    if (arBusy && e.target.closest("[data-ar-restore-space],[data-ar-restore]")) { showToast("아직 되살리는 중입니다."); return; }
    const resSpace = e.target.closest("[data-ar-restore-space]");
    if (resSpace) { send({ type: "archive.restore", spaceCwd: resSpace.dataset.arRestoreSpace }); showToast("되살리는 중…"); return; }
    const forgetSpace = e.target.closest("[data-ar-forget-space]");
    if (forgetSpace) {
      const cwd = forgetSpace.dataset.arForgetSpace;
      const n = archives.filter((x) => (x.kind === "space" ? x.cwd : x.spaceCwd) === cwd).length;
      if (!confirm(`이 스페이스의 보관 항목 ${n}개를 전부 지울까요?\n세션 자체는 남지만 여기서 되살릴 수는 없게 됩니다.`)) return;
      send({ type: "archive.forgetSpace", spaceCwd: cwd });
      return;
    }
    const res = e.target.closest("[data-ar-restore]");
    if (res) { send({ type: "archive.restore", id: res.dataset.arRestore }); showToast("되살리는 중…"); return; }
    const forget = e.target.closest("[data-ar-forget]");
    if (forget) {
      const it = archives.find((x) => x.id === forget.dataset.arForget);
      const nm = it ? (it.label || it.name || it.agent || "이 항목") : "이 항목";
      if (!confirm(`"${nm}"을(를) 보관함에서 지울까요?\n세션 자체는 남지만 여기서 되살릴 수는 없게 됩니다.`)) return;
      send({ type: "archive.forget", id: forget.dataset.arForget });
    }
  });
  dom("#ar-refresh")?.addEventListener("click", () => send({ type: "archive.list" }));
  dom("#ar-body")?.addEventListener("input", (e) => {
    if (e.target.id !== "ar-q") return;
    arQuery = e.target.value; arFocusSearch = true; arRender();
  });
}

export function enterArchive() {
  send({ type: "archive.list" });
  arRender();
}

function arWhen(ts) {
  const d = new Date(ts), now = Date.now(), diff = now - ts;
  if (diff < 3600e3) return Math.max(1, Math.round(diff / 60e3)) + "분 전";
  if (diff < 86400e3) return Math.round(diff / 3600e3) + "시간 전";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
// 검색은 이름·스페이스·폴더뿐 아니라 마지막 화면 내용까지 본다. 무엇을 하던
// 세션인지는 이름보다 그 화면에 남아 있는 경우가 많다.
function arMatch(e, q) {
  if (!q) return { hit: true, inTail: false };
  const head = [e.label, e.name, e.agent, e.spaceLabel, e.cwd, e.spaceCwd].filter(Boolean).join(" ").toLowerCase();
  if (head.includes(q)) return { hit: true, inTail: false };
  if (e.tail && e.tail.toLowerCase().includes(q)) return { hit: true, inTail: true };
  return { hit: false, inTail: false };
}
// 검색어가 화면 안에서만 걸렸을 때는 그 줄들을 보여준다. 어디에 걸렸는지 보이지 않으면 결과를 확인할 수 없다.
function arTailView(e, q, inTail, open) {
  if (!e.tail) return "";
  let text = e.tail;
  if (q && inTail && !open) {
    const lines = e.tail.split("\n");
    const idx = lines.findIndex((l) => l.toLowerCase().includes(q));
    if (idx >= 0) text = lines.slice(Math.max(0, idx - 1), idx + 3).join("\n");
  }
  let html = escapeHtml(text);
  if (q) {
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    html = html.replace(re, (m) => `<mark>${m}</mark>`);
  }
  return `<div class="ar-tail${open ? " full" : ""}">${html}</div>`;
}
function arCard(e, q, inTail, isKid) {
  const isSpace = e.kind === "space";
  const name = isSpace ? (e.label || "(이름 없음)") : (e.name || e.agent || "(이름 없음)");
  const where = isSpace ? (e.cwd || "") : (isKid ? (e.cwd || "") : [e.spaceLabel, e.cwd].filter(Boolean).join(" · "));
  const open = arTailOpen.has(e.id);
  const tail = isSpace ? "" : arTailView(e, q, inTail, open);
  const noTail = !isSpace && !e.tail ? `<div class="ar-meta">마지막 화면을 읽지 못했습니다.</div>` : "";
  return `<div class="ar-h">
      <span class="ar-kind">${isSpace ? "스페이스" : escapeHtml(e.agent || "세션")}</span>
      <span class="ar-name">${escapeHtml(name)}</span>
      <span class="ar-when">${escapeHtml(arWhen(e.at))}</span>
    </div>
    ${where ? `<div class="ar-meta">${escapeHtml(where)}</div>` : ""}
    ${tail}${noTail}
    <div class="ar-acts">
      <button class="primary" data-ar-restore="${escapeHtml(e.id)}">되살리기</button>
      ${tail ? `<button data-ar-more="${escapeHtml(e.id)}">${open ? "접기" : "더 보기"}</button>` : ""}
      <button class="danger sp" data-ar-forget="${escapeHtml(e.id)}">잊기</button>
    </div>`;
}
function arRender() {
  const body = dom("#ar-body"); if (!body) return;
  const q = arQuery.trim().toLowerCase();
  const searchBar = `<div class="ar-search">
      <input type="search" id="ar-q" placeholder="이름·폴더·마지막 화면 내용으로 찾기" value="${escapeHtml(arQuery)}" />
      <span class="ar-count" id="ar-count"></span>
    </div>` + (arBusy ? `<div class="ar-busy">
      <span class="scr-spin"></span>
      <span>되살리는 중 ${arBusy.done + 1}/${arBusy.total} — ${escapeHtml(arBusy.name || "")}</span>
      <span class="ar-busy-bar"><i style="width:${Math.round((arBusy.done / arBusy.total) * 100)}%"></i></span>
    </div>` : "");
  if (!archives.length) {
    body.innerHTML = `<div class="ar-empty">접어둔 것이 없습니다.<br>
      에이전트나 스페이스를 우클릭해 <b>접기</b>를 고르면, 세션 복원에 필요한 정보와 마지막 화면을 저장한 뒤
      실제로 닫아 메모리를 놓습니다.</div>`;
    return;
  }
  // 그룹은 폴더로 잡는다. 스페이스를 통째로 보관했든 세션만 따로 보관했든, 같은 스페이스 것이면
  // 한 그룹으로 보이고 그 단위로 관리된다. 스페이스 항목이 없으면 머리글을 만든다.
  const keyOf = (p) => (p ? String(p).replace(/\/+$/, "") : "");
  const groups = new Map();   // 폴더 → { cwd, label, head, kids, at }
  const loose = [];           // 어느 스페이스 것인지 알 수 없는 세션
  for (const e of archives) {
    const cwd = keyOf(e.kind === "space" ? e.cwd : e.spaceCwd);
    if (!cwd) { loose.push(e); continue; }
    if (!groups.has(cwd)) groups.set(cwd, { cwd, label: null, head: null, kids: [], at: 0 });
    const g = groups.get(cwd);
    g.at = Math.max(g.at, e.at || 0);
    if (e.kind === "space") { g.head = e; g.label = g.label || e.label; }
    else { g.kids.push(e); g.label = g.label || e.spaceLabel; }
  }

  const m = new Map(archives.map((e) => [e.id, arMatch(e, q)]));
  const groupHit = (g) => !q
    || (g.label || "").toLowerCase().includes(q) || g.cwd.toLowerCase().includes(q)
    || (g.head && m.get(g.head.id).hit) || g.kids.some((k) => m.get(k.id).hit);

  let shown = 0;
  const html = [...groups.values()].sort((a, b) => b.at - a.at).map((g) => {
    if (!groupHit(g)) return "";
    const kidsShown = q ? g.kids.filter((k) => m.get(k.id).hit) : g.kids;
    // 기본은 접힌 상태다. 스페이스 하나에 세션이 여럿이라 다 펼쳐두면 목록이 길어진다.
    // 다만 검색 중에는 펼친다. 걸린 세션이 접힌 채로 숨으면 결과를 볼 수 없다.
    const open = arOpen.has(g.cwd) || (!!q && kidsShown.length > 0);
    shown += 1 + (open ? kidsShown.length : 0);
    const name = g.label || g.cwd.split("/").pop() || g.cwd;
    const state = g.head ? "스페이스째 접힘" : "스페이스는 열려 있음";
    return `<div class="ar-group">
      <div class="ar-h" data-ar-toggle="${escapeHtml(g.cwd)}">
        <span class="ar-caret${open ? " open" : ""}">▶</span>
        <span class="ar-kind">스페이스</span>
        <span class="ar-name">${escapeHtml(name)}</span>
        <span class="ar-n">세션 ${g.kids.length}개 · ${escapeHtml(state)}</span>
        <span class="ar-when">${escapeHtml(arWhen(g.at))}</span>
      </div>
      <div class="ar-meta">${escapeHtml(g.cwd)}</div>
      <div class="ar-acts">
        <button class="primary" data-ar-restore-space="${escapeHtml(g.cwd)}">되살리기${g.kids.length ? ` (세션 ${g.kids.length}개 포함)` : ""}</button>
        <button class="danger sp" data-ar-forget-space="${escapeHtml(g.cwd)}">전부 잊기</button>
      </div>
      ${open && kidsShown.length
        ? `<div class="ar-kids">` + kidsShown.map((k) => `<div class="ar-item">${arCard(k, q, m.get(k.id).inTail, true)}</div>`).join("") + `</div>`
        : ""}
    </div>`;
  }).join("") + loose.filter((e) => m.get(e.id).hit).map((e) => {
    shown++; return `<div class="ar-item">${arCard(e, q, m.get(e.id).inTail, false)}</div>`;
  }).join("");

  body.innerHTML = searchBar + (html
    ? `<div class="ar-list">${html}</div>`
    : `<div class="ar-empty">"${escapeHtml(arQuery)}"에 걸리는 항목이 없습니다.</div>`);
  const cnt = dom("#ar-count");
  if (cnt) cnt.textContent = q ? `${shown} / ${archives.length}` : `${archives.length}개`;
  const inp = dom("#ar-q");
  if (inp && arFocusSearch) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); arFocusSearch = false; }
}

export function handleArchiveMessage(m) {
  if (m.type === "archives") {
    archives = Array.isArray(m.items) ? m.items : [];
    arRender();
  } else if (m.type === "archive-error") {
    showToast(m.message || "보관 조작 실패");
  } else if (m.type === "archive-note") {
    showToast(m.message);
  } else if (m.type === "archive-progress") {
    arBusy = { cwd: m.spaceCwd, done: m.done, total: m.total, name: m.name };
    arRender();
  } else if (m.type === "archive-restored") {
    arBusy = null;
    // 복원한 스페이스로 들어간다. 복원의 목적이 그 스페이스에서 작업을 이어가는 것이다.
    if (m.workspaceId) setPendingSpaceFocus(m.workspaceId);
    showToast(m.note || "되살렸습니다.");
  } else return false;
  return true;
}

// 이 기능의 연결. 표에는 선언만 남고, 연결 방법은 각 기능이 소유한다.
export function initCapability(ctx) {
  initArchive({
    $: ctx.$, esc: ctx.esc, wsSend: ctx.wsSend, showToast: ctx.showToast,
    setPendingSpaceFocus: ctx.setPendingSpaceFocus,
    getIsLocal: ctx.getIsLocal, getLastAgents: ctx.getLastAgents, askConfirm: ctx.askConfirm,
  });
  // 보관함이 받는 서버 메시지는 보관함이 소유한다. 앱 셸 표에 남겨 두면 기능을 꺼도 로드된다.
  const on = handleArchiveMessage;
  return {
    screen: { enter: enterArchive },
    ws: { "archives": on, "archive-error": on, "archive-note": on, "archive-progress": on, "archive-restored": on },
  };
}
