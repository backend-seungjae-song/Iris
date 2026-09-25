// rail 🔑 화면. AI 자동완성 로그인 허용 목록을 찾고 묶어 관리한다.
//
// 소유 범위
//   로그인 허용 목록 캐시, 검색어·필터·Chrome 가져오기 출처와 rail 화면의 DOM 연결.
//
// 제공 API
//   initAutofillAllowlist와 rail 진입·외부 허용 변경 뒤 다시 그리는 afRefresh.
//
// 의존 대상
//   브라우저 탭 상태는 browser/state, Chrome 프로필 연결은 browser/profiles,
//   계정 화면 전환은 devtool/rail에서 import 한다. $·esc는 main이 소유해서 init에서 받는다.
//   로그인 목록·출처·허용 변경은 preload가 노출한 acHost 계약에 기대한다.
//
// 유지 조건
//   비밀번호 값은 읽거나 표시하지 않는다. 열려 있는 사이트와 전체 저장 목록을 나눠 보여 주고,
//   목록 새로고침·검색 중 재렌더·전체 잠금·개별 토글의 조건과 순서를 바꾸지 않는다.
//
// 영향 범위
//   browser/{state,profiles}, devtool/rail, native preload의 aiLoginList·aiLoginSources·aiLoginSet,
//   main의 rail 진입과 webview 허용 변경 뒤 refresh 호출, #af-body/#af-refresh DOM·관련 CSS.
//   이 모듈의 export나 init 계약을 바꾸면 import 하는 main.js도 함께 바뀌어야 한다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs web/js/browser/autofill-allowlist.js

import { railSelect } from "../devtool/rail.js";
import { featureHidden } from "../core/features.js";
import { getProfileChromeSource } from "./profiles.js";
import { getBrowserState } from "./state.js";
import { provide } from "../core/hooks.js";

// 이 기능의 마크업 위치. index.html 에 두면 기능을 꺼도 바깥 요소가 파싱되므로 여기서 만든다.
// 바깥 요소(aside 의 id·class)는 rail 표가 정본이고 여기는 안쪽만 담는다.
export const panelHtml = `
  <div class="af-head"><h1>AI 자동완성 로그인</h1><span class="af-sum" id="af-sum"></span><span class="af-sp"></span><button class="af-ib" id="af-refresh" title="새로고침"><svg class="i" viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg></button></div>
  <div class="af-body" id="af-body"></div>
`;

let $, esc;
let afList = [], afQuery = "", afFilter = "all", afSources = null;
// 오른쪽 상세에 보이는 사이트. "open|<origin>" 또는 "all|<origin>" 이다. 같은 사이트가 두 목록에
// 모두 있을 수 있어, 누른 줄만 선택으로 표시하려고 어느 목록인지도 함께 둔다.
let afPick = null;

const AF_ICON = {
  search: '<svg class="i" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4-4"/></svg>',
  warn: '<svg class="i" viewBox="0 0 24 24"><path d="M12 4 2.5 20h19z"/><path d="M12 10v4M12 17h.01"/></svg>',
  arrow: '<svg class="i" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  globe: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
  user: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/></svg>',
  lock: '<svg class="i" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  key: '<svg class="i" viewBox="0 0 24 24"><circle cx="15.5" cy="8.5" r="4.5"/><path d="M12.3 11.7 4 20"/><path d="M6.5 17.5 9 20"/></svg>',
};

export function initAutofillAllowlist(deps) {
  ({ $, esc } = deps);
  wireAutofillAllowlist();
}

function afHost(origin) { try { return new URL(origin).host; } catch { return origin; } }

// 지금 열려 있는 탭들의 사이트. 모든 스페이스의 탭을 본다. 관리는 이 창 하나에서 한다.
function afOpenOrigins() {
  const out = new Set();
  const m = getBrowserState().tabsBySpace || {};
  for (const sp of Object.keys(m)) for (const t of (m[sp] || [])) {
    try { const u = new URL(t.url || ""); if (/^https?:$/.test(u.protocol)) out.add(u.origin); } catch {}
  }
  return out;
}

// 브라우저 코어가 이 모듈을 import 하면 로그인 화면을 끈 사람에게도 로드된다. 이름만 등록해 둔다.
provide("autofill.refresh", (reload) => afRefresh(reload));

export async function afRefresh(reload) {
  const body = $("#af-body"); if (!body) return;
  if (reload !== false || !afList.length) {
    afList = (window.acHost && acHost.aiLoginList) ? await acHost.aiLoginList() : [];
    // 창이 들고 있는 (우리 프로필 → Chrome 프로필) 연결을 함께 넘긴다. 기록이 생기기 전에 가져온
    // 프로필도 "이미 가져옴"으로 판정된다. 이 값은 표시 판정에만 쓰이고 임포트를 일으키지 않는다.
    try { afSources = (window.acHost && acHost.aiLoginSources) ? await acHost.aiLoginSources(getProfileChromeSource()) : null; } catch { afSources = null; }
  }
  const sum = $("#af-sum");
  const canGoAcct = !featureHidden().has("accounts");
  if (!afList.length) {
    if (sum) sum.innerHTML = "";
    body.innerHTML = `<div class="af-empty">
      <div class="af-empty-ic">${AF_ICON.key}</div>
      <h2>저장된 로그인이 없습니다</h2>
      <p>계정 화면에서 Chrome 프로필의 로그인을 가져오면 여기에 사이트와 아이디가 나타납니다. 그다음 AI 가 채워도 되는 계정만 골라 허용합니다.</p>
      ${canGoAcct ? `<button class="af-btn" data-goacct="1">${AF_ICON.user}계정 화면에서 가져오기</button>` : ""}
    </div>`;
    return;
  }
  const on = afList.filter((x) => x.allowed).length;
  if (sum) sum.innerHTML = `<b>${on}</b>/${afList.length}개 계정에 AI 로그인 허용`;
  // 사이트로 묶는다. 한 사이트에 계정이 여럿인 경우가 흔한데 평평하면 같은 이름이 계속 반복된다.
  const groupOf = (rows) => {
    const m = new Map();
    for (const x of rows) { if (!m.has(x.origin)) m.set(x.origin, []); m.get(x.origin).push(x); }
    return [...m.entries()].sort((a, b) => {
      const ao = a[1].some((x) => x.allowed) ? 0 : 1, bo = b[1].some((x) => x.allowed) ? 0 : 1;
      return ao - bo || afHost(a[0]).localeCompare(afHost(b[0])); // 열어둔 사이트가 위로
    });
  };
  // ① 지금 열려 있는 사이트. 당장 조작할 대상이 맨 위에 있어야 한다.
  const openOrigins = afOpenOrigins();
  const openRows = afList.filter((x) => openOrigins.has(x.origin));
  const openSites = groupOf(openRows);
  const openNoCred = [...openOrigins].filter((o) => !afList.some((x) => x.origin === o));
  // ② 저장된 것 전부. 검색·필터로 관리한다.
  const q = afQuery.trim().toLowerCase();
  const allRows = afList.filter((x) => {
    if (q && !(String(x.origin).toLowerCase().includes(q) || String(x.username || "").toLowerCase().includes(q))) return false;
    if (afFilter === "on" && !x.allowed) return false;
    if (afFilter === "off" && x.allowed) return false;
    return true;
  });
  const allSites = groupOf(allRows);
  // 고른 사이트가 없거나 사라졌으면 열린 사이트 첫째, 없으면 전체 목록 첫째를 보인다.
  const exists = (key) => {
    if (!key) return false;
    const [from, origin] = [key.slice(0, key.indexOf("|")), key.slice(key.indexOf("|") + 1)];
    return (from === "open" ? openSites : allSites).some(([o]) => o === origin);
  };
  if (!exists(afPick)) {
    afPick = openSites.length ? "open|" + openSites[0][0] : allSites.length ? "all|" + allSites[0][0] : null;
  }
  const pickOrigin = afPick ? afPick.slice(afPick.indexOf("|") + 1) : null;
  const siteRow = (from, origin, accts) => {
    const n = accts.filter((x) => x.allowed).length;
    const key = from + "|" + origin;
    return `<button class="af-row${afPick === key ? " on" : ""}" data-af-site="${esc(key)}" title="${esc(origin)}">
      <span class="af-dot${n ? " on" : ""}"></span><span class="af-h">${esc(afHost(origin))}</span><span class="af-end">${n}/${accts.length}</span>
    </button>`;
  };
  const seg = (v, label) => `<button class="${afFilter === v ? "on" : ""}" role="tab" aria-selected="${afFilter === v}" data-filter="${v}">${label}</button>`;
  const src = afSources || {};
  const gap = (src.missing || []).length;
  // 오른쪽 상세. 고른 사이트의 모든 계정을 보인다(검색·필터는 왼쪽 목록에만 적용).
  const pickAccts = pickOrigin ? afList.filter((x) => x.origin === pickOrigin) : [];
  const pickOn = pickAccts.filter((x) => x.allowed).length;
  const detail = pickOrigin ? `
      <div class="af-dh">
        <div class="af-dh-main">
          <div class="af-dh-t">${esc(afHost(pickOrigin))}${openOrigins.has(pickOrigin) ? `<span class="af-badge-open">${AF_ICON.globe}지금 열려 있음</span>` : ""}</div>
          <div class="af-dh-sub">${esc(pickOrigin)}</div>
        </div>
        <div class="af-dh-acts"><span class="af-dh-n">${pickOn}/${pickAccts.length} 허용</span></div>
      </div>
      <div class="af-dsec">
        <h3>이 사이트의 계정</h3>
        ${pickAccts.map((x) => `<div class="af-acc${x.allowed ? " on" : ""}">
          <span class="af-acc-ic">${AF_ICON.user}</span>
          <span class="af-u">${esc(x.username || "(아이디 없음)")}</span>
          <span class="af-st">${x.allowed ? "AI 로그인 허용" : "잠김"}</span>
          <button class="af-sw${x.allowed ? " on" : ""}" role="switch" aria-checked="${x.allowed ? "true" : "false"}"
            aria-label="${esc(x.username || "(아이디 없음)")} AI 로그인 허용"
            data-o="${esc(x.origin)}" data-u="${esc(x.username || "")}" data-on="${x.allowed ? 1 : 0}"><i></i></button>
        </div>`).join("")}
      </div>` : `<p class="af-none">조건에 맞는 사이트가 없습니다.</p>`;
  body.innerHTML = `
    <div class="af-split">
    <nav class="af-nav">
      <div class="af-navtools">
        <label class="af-search">${AF_ICON.search}<input class="af-inp" id="af-q" placeholder="주소 또는 아이디 검색" value="${esc(afQuery)}" /></label>
        <div class="af-seg" role="tablist">${seg("all", "전체")}${seg("on", "허용됨")}${seg("off", "잠김")}</div>
      </div>
      <div class="af-sec af-sec-open">
        <div class="af-sec-h"><h3>지금 열려 있는 사이트</h3><span class="af-n">${openSites.length}</span></div>
        ${openSites.length ? `<div class="af-list">${openSites.map(([o, a]) => siteRow("open", o, a)).join("")}</div>`
          : `<div class="af-note">열린 탭 중 저장된 로그인이 있는 사이트가 없습니다.</div>`}
        ${openNoCred.length ? `<div class="af-note af-nocred" title="${esc(openNoCred.map(afHost).join(" · "))}"><span class="af-clamp">로그인 없이 열린 사이트 <span class="af-mono">${openNoCred.map((o) => esc(afHost(o))).join(" · ")}</span></span></div>` : ""}
      </div>
      <div class="af-sec af-sec-all">
        <div class="af-sec-h"><h3>저장된 로그인 전체</h3><span class="af-n">${allSites.length}곳 · ${allRows.length}계정</span></div>
        ${allSites.length ? `<div class="af-list">${allSites.map(([o, a]) => siteRow("all", o, a)).join("")}</div>`
          : `<div class="af-note">조건에 맞는 계정이 없습니다.</div>`}
      </div>
    </nav>
    <section class="af-detail">
      ${gap ? `<div class="af-warn">${AF_ICON.warn}<span>아직 안 가져온 Chrome 계정 ${gap}개: <b>${esc((src.missing || []).map((m) => m.account || m.label).join(" · "))}</b>. 그 계정에 저장된 로그인은 여기 없습니다.</span>
        ${canGoAcct ? `<button class="af-btn" data-goacct="1">계정 페이지에서 가져오기${AF_ICON.arrow}</button>` : ""}</div>` : ""}
      ${detail}
      <div class="af-foot">
        <p class="af-why">허용한 것만 <code>iris-browser login</code> 으로 채울 수 있습니다. 비밀번호 값은 AI 에게 전달되지 않고, 그 탭의 명령 결과에서도 가려집니다.</p>
        ${on ? `<button class="af-btn af-btn-danger" data-lockall="1">${AF_ICON.lock}허용한 계정 전체 잠금 (${on})</button>` : ""}
      </div>
    </section>
    </div>`;
  const qbox = $("#af-q");
  if (qbox) {
    qbox.addEventListener("input", () => { afQuery = qbox.value; afRefresh(false); queueMicrotask(() => { const n = $("#af-q"); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }); });
  }
}

function wireAutofillAllowlist() {
  const body = $("#af-body"); if (!body) return;
  body.addEventListener("click", async (e) => {
    // 거르기·사이트 고르기·계정 화면 이동은 화면 안의 일이라 네이티브 연결 없이도 동작한다.
    const f = e.target.closest("[data-filter]");
    if (f) { afFilter = f.dataset.filter; afRefresh(false); return; }
    if (e.target.closest("[data-goacct]")) { railSelect("accounts"); return; }
    const site = e.target.closest("[data-af-site]");
    if (site) { afPick = site.dataset.afSite; afRefresh(false); return; }
    if (!window.acHost || !acHost.aiLoginSet) return;
    if (e.target.closest("[data-lockall]")) {
      if (!confirm("허용해둔 계정을 전부 잠급니다. 계속할까요?")) return;
      for (const x of afList.filter((v) => v.allowed)) await acHost.aiLoginSet(x.origin, x.username, false);
      afRefresh(); return;
    }
    const b = e.target.closest(".af-sw"); if (!b) return;
    await acHost.aiLoginSet(b.dataset.o, b.dataset.u, b.dataset.on !== "1");
    afRefresh();
  });
  const r = $("#af-refresh"); if (r) r.addEventListener("click", afRefresh);
}

// 이 기능의 연결. 표에는 선언만 두고 연결 방법은 각 기능이 가진다.
export function initCapability(ctx) {
  initAutofillAllowlist({ $: ctx.$, esc: ctx.esc });
  return { screen: { enter: afRefresh } };
}
