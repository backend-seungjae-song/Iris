// 보관함: 보관한 스페이스와 세션을 묶어 찾고 복원하거나 삭제한다.
//
// 소유 범위
//   archives, arTailOpen, arQuery, arSel, arBusy 와 보관함 전체 렌더·입력 상태.
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
//   그룹은 workspace id가 아니라 폴더 기준이다. 왼쪽 목록에는 스페이스만 두고, 고른 스페이스의 세션은
//   오른쪽 상세에 보인다. 검색 중에는 걸린 세션만 상세에 남기고 걸린 글자를 표시한다.
//   복원 중에는 중복 클릭을 막고, 삭제는 확인을 거치며, 검색은 마지막 화면 내용까지 본다.
//
// 영향 범위
//   core/capabilities.js 의 등록과 서버의 archive-* 메시지 계약, 그리고 이 이름으로 보관 항목을
//   받아 가는 explorer/context-menu.js · herdr/agents.js.

import { provide } from "../core/hooks.js";

// 이 기능의 영역. index.html 이 이 마크업을 항상 그리면 기능을 꺼도
// 셸이 파싱되므로 여기서 만든다. 셸(aside 의 id·class)은 rail 표가 정본이고 여기는 안쪽만 담는다.
export const panelHtml = `
  <div class="ar-split" id="ar-body">
    <div class="ar-side">
      <div class="ar-bar"><h2 class="ar-bar-title">보관함</h2><span class="ar-count" id="ar-count"></span><span class="ar-sp"></span>
        <button type="button" class="ar-ib" id="ar-refresh" title="새로고침"><svg class="i" viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg></button></div>
      <div class="ar-sbar"><label class="ar-search"><svg class="i" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg><input type="search" id="ar-q" placeholder="이름·폴더·마지막 화면 내용으로 찾기" /></label></div>
      <div id="ar-busy"></div>
      <div class="ar-list" id="ar-list"></div>
    </div>
    <div class="ar-detail" id="ar-detail"></div>
  </div>
`;

let archives = [];
let arTailOpen = new Set();
let arQuery = "";
// 고른 묶음. 스페이스는 폴더 경로, 스페이스를 모르는 세션은 "id:" + 항목 id 다.
// 비어 있거나 목록에서 사라졌으면 맨 위 묶음을 고른다.
let arSel = null;
let arBusy = null;        // 여러 개를 하나씩 복원하는 중. 진행 위치를 화면에 남긴다
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
    const pick = e.target.closest("[data-ar-pick]");
    if (pick) { arSel = pick.dataset.arPick; arRender(); return; }
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
  dom("#ar-q")?.addEventListener("input", (e) => { arQuery = e.target.value; arRender(); });
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
// 접힌 미리보기는 세 줄만 보이므로 걸린 줄을 첫 줄로 두고, 그 줄도 적중 앞 AR_CTX 글자에서 자른다.
// 앞 줄이나 긴 앞문맥이 세 줄을 채우면 적중이 가려진다.
const AR_CTX = 40;
// 원문에서 일치 구간을 찾아 조각마다 이스케이프한다. 이스케이프한 뒤에 찾으면 &lt; 같은 엔티티 안까지 걸린다.
function arMarked(text, re) {
  if (!re) return escapeHtml(text);
  let html = "", last = 0;
  for (const m of text.matchAll(re)) {
    html += escapeHtml(text.slice(last, m.index)) + `<mark>${escapeHtml(m[0])}</mark>`;
    last = m.index + m[0].length;
  }
  return html + escapeHtml(text.slice(last));
}
export function arTailView(e, q, inTail, open) {
  if (!e.tail) return "";
  const re = q ? new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi") : null;
  let text = e.tail;
  if (re && inTail && !open) {
    const lines = e.tail.split("\n");
    const idx = lines.findIndex((l) => l.toLowerCase().includes(q));
    if (idx >= 0) {
      const line = lines[idx];
      const at = Math.max(0, line.search(re));
      let cut = Math.max(0, at - AR_CTX);
      if (cut && /[\udc00-\udfff]/.test(line[cut])) cut--; // 서로게이트 쌍을 가르지 않는다
      text = [(cut ? "…" : "") + line.slice(cut), ...lines.slice(idx + 1, idx + 3)].join("\n");
    }
  }
  return `<div class="ar-tail${open ? " full" : ""}">${arMarked(text, re)}</div>`;
}
const AR_MISS = `<div class="ar-tail miss">마지막 화면을 읽지 못했습니다.</div>`;
function arCard(e, q, inTail, groupCwd) {
  const name = e.name || e.agent || "(이름 없음)";
  const id = escapeHtml(e.id);
  const open = arTailOpen.has(e.id);
  const tail = arTailView(e, q, inTail, open);
  // 세션이 스페이스와 다른 폴더에서 돌았으면 그 폴더를 적는다. 같으면 상세 머리의 경로와 겹친다.
  const cwd = keyOf(e.cwd);
  const where = cwd && cwd !== groupCwd ? `<div class="ar-path">${escapeHtml(cwd)}</div>` : "";
  return `<div class="ar-sess">
      <div class="ar-sess-h">
        <span class="ar-kind">${escapeHtml(e.agent || "세션")}</span>
        <span class="ar-name">${escapeHtml(name)}</span>
        <span class="ar-sp"></span>
        <span class="ar-when">${escapeHtml(arWhen(e.at))}</span>
      </div>
      ${where}${tail || AR_MISS}
      <div class="ar-acts">
        <button type="button" class="ar-btn ar-btn-sm ar-btn-txt" data-ar-restore="${id}">되살리기</button>
        ${tail ? `<button type="button" class="ar-btn ar-btn-sm ar-btn-txt" data-ar-more="${id}">${open ? "접기" : "더 보기"}</button>` : ""}
        <span class="ar-sp"></span>
        <button type="button" class="ar-btn ar-btn-sm ar-btn-txt ar-btn-dz" data-ar-forget="${id}">잊기</button>
      </div>
    </div>`;
}
const keyOf = (p) => (p ? String(p).replace(/\/+$/, "") : "");
function arSpaceState(g) {
  return g.head ? { cls: "shut", short: "스페이스째 접힘", long: "스페이스째 접힘" }
    : { cls: "open", short: "열려 있음", long: "스페이스는 열려 있음" };
}
// 고른 스페이스의 상세. 되살리기는 머리에 한 번만 두고, 세션별 조작은 각 세션 아래에 둔다.
function arGroupDetail(g, q, m) {
  const name = g.label || g.cwd.split("/").pop() || g.cwd;
  const st = arSpaceState(g);
  const cwd = escapeHtml(g.cwd);
  const hits = q ? g.kids.filter((k) => m.get(k.id).hit) : g.kids;
  // 이름이나 폴더로 걸린 스페이스는 걸린 세션이 없어도 세션을 전부 보여 준다.
  const kids = hits.length ? hits : g.kids;
  return `<div class="ar-dh">
      <div class="ar-dh-t"><h3 class="ar-dh-name">${escapeHtml(name)}</h3><span class="ar-st ${st.cls}">${st.long}</span></div>
      <div class="ar-dh-meta"><span class="ar-path">${cwd}</span><span class="ar-when">${escapeHtml(arWhen(g.at))}</span></div>
      <div class="ar-dh-acts">
        <button type="button" class="ar-btn ar-btn-pri" data-ar-restore-space="${cwd}">되살리기${g.kids.length ? ` (세션 ${g.kids.length}개 포함)` : ""}</button>
        <span class="ar-sp"></span>
        <button type="button" class="ar-btn ar-btn-txt ar-btn-dz" data-ar-forget-space="${cwd}">전부 잊기</button>
      </div>
    </div>
    <div class="ar-kids">${kids.length
      ? kids.map((k) => arCard(k, q, m.get(k.id).inTail, g.cwd)).join("")
      : `<div class="ar-none">이 스페이스에서 따로 보관한 세션이 없습니다.</div>`}</div>`;
}
// 스페이스를 알 수 없는 세션의 상세. 되살리기·잊기는 머리에 두고 몸에는 마지막 화면만 둔다.
function arLooseDetail(e, q, m) {
  const id = escapeHtml(e.id);
  const open = arTailOpen.has(e.id);
  const tail = arTailView(e, q, m.get(e.id).inTail, open);
  const where = [e.spaceLabel, e.cwd].filter(Boolean).join(" · ");
  return `<div class="ar-dh">
      <div class="ar-dh-t"><span class="ar-kind">${escapeHtml(e.agent || "세션")}</span><h3 class="ar-dh-name">${escapeHtml(e.name || e.agent || "(이름 없음)")}</h3><span class="ar-st">스페이스를 알 수 없는 세션</span></div>
      <div class="ar-dh-meta">${where ? `<span class="ar-path">${escapeHtml(where)}</span>` : ""}<span class="ar-when">${escapeHtml(arWhen(e.at))}</span></div>
      <div class="ar-dh-acts">
        <button type="button" class="ar-btn ar-btn-pri" data-ar-restore="${id}">되살리기</button>
        <span class="ar-sp"></span>
        <button type="button" class="ar-btn ar-btn-txt ar-btn-dz" data-ar-forget="${id}">잊기</button>
      </div>
    </div>
    <div class="ar-kids"><div class="ar-sess">
      ${tail || AR_MISS}
      ${tail ? `<div class="ar-acts"><button type="button" class="ar-btn ar-btn-sm ar-btn-txt" data-ar-more="${id}">${open ? "접기" : "더 보기"}</button></div>` : ""}
    </div></div>`;
}
function arRender() {
  const list = dom("#ar-list"), detail = dom("#ar-detail"); if (!list || !detail) return;
  const q = arQuery.trim().toLowerCase();
  const busy = dom("#ar-busy");
  if (busy) busy.innerHTML = arBusy ? `<div class="ar-busy">
      <span class="ar-spin"></span>
      <span class="ar-busy-t">되살리는 중 ${arBusy.done + 1}/${arBusy.total} — ${escapeHtml(arBusy.name || "")}</span>
      <span class="ar-busy-bar"><i style="width:${Math.round((arBusy.done / arBusy.total) * 100)}%"></i></span>
    </div>` : "";
  const cnt = dom("#ar-count");
  if (!archives.length) {
    if (cnt) cnt.textContent = "";
    list.innerHTML = "";
    detail.innerHTML = `<div class="ar-empty">
      <h3 class="ar-dh-name">접어둔 것이 없습니다</h3>
      <p class="ar-empty-desc">에이전트나 스페이스를 우클릭해 접기를 고르면, 세션 복원에 필요한 정보와 마지막 화면을 저장한 뒤
      실제로 닫아 메모리를 놓습니다.</p></div>`;
    return;
  }
  // 그룹은 폴더로 잡는다. 스페이스를 통째로 보관했든 세션만 따로 보관했든, 같은 스페이스 것이면
  // 한 그룹으로 보이고 그 단위로 관리된다. 스페이스 항목이 없으면 머리글을 만든다.
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

  const rows = [
    ...[...groups.values()].sort((a, b) => b.at - a.at).filter(groupHit).map((g) => ({ key: g.cwd, g })),
    ...loose.filter((e) => m.get(e.id).hit).map((e) => ({ key: "id:" + e.id, e })),
  ];
  if (!rows.some((r) => r.key === arSel)) arSel = rows[0]?.key ?? null;

  list.innerHTML = rows.length ? rows.map((r) => {
    const on = r.key === arSel;
    const head = `<button type="button" class="ar-group${on ? " on" : ""}" data-ar-pick="${escapeHtml(r.key)}" aria-pressed="${on}">`;
    if (r.g) {
      const g = r.g, st = arSpaceState(g);
      const name = g.label || g.cwd.split("/").pop() || g.cwd;
      return `${head}
        <span class="ar-l1"><span class="ar-name">${escapeHtml(name)}</span><span class="ar-when">${escapeHtml(arWhen(g.at))}</span></span>
        <span class="ar-l2"><span class="ar-st ${st.cls}">${st.short}</span><span class="ar-cnt">세션 ${g.kids.length}</span></span>
      </button>`;
    }
    const e = r.e;
    return `${head}
        <span class="ar-l1"><span class="ar-kind">${escapeHtml(e.agent || "세션")}</span><span class="ar-name">${escapeHtml(e.name || e.agent || "(이름 없음)")}</span><span class="ar-when">${escapeHtml(arWhen(e.at))}</span></span>
        <span class="ar-l2"><span>스페이스를 알 수 없는 세션</span></span>
      </button>`;
  }).join("") : `<div class="ar-none">"${escapeHtml(arQuery)}"에 걸리는 항목이 없습니다.</div>`;

  const sel = rows.find((r) => r.key === arSel);
  detail.innerHTML = !sel ? "" : sel.g ? arGroupDetail(sel.g, q, m) : arLooseDetail(sel.e, q, m);
  if (cnt) cnt.textContent = q ? `${archives.filter((e) => m.get(e.id).hit).length} / ${archives.length}` : String(archives.length);
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
