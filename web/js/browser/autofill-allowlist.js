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
  <div class="scr-bar"><span class="scr-bar-title">AI 자동완성 로그인</span><button class="scr-ico" id="af-refresh" title="새로고침">↻</button></div>
  <div class="scr-body" id="af-body"></div>
`;

let $, esc;
let afList = [], afQuery = "", afFilter = "all", afSources = null;

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
  if (!afList.length) {
    body.innerHTML = `<div class="scr-empty"><b>저장된 로그인이 없습니다.</b><br>[👤 계정]에서 Chrome 프로필의 로그인을 가져오면 여기에 사이트와 아이디가 나타납니다.</div>`;
    return;
  }
  const on = afList.filter((x) => x.allowed).length;
  // 사이트로 묶는다. 한 사이트에 계정이 여럿인 경우가 흔한데 평평하면 같은 이름이 계속 반복된다.
  const groupOf = (rows) => {
    const m = new Map();
    for (const x of rows) { if (!m.has(x.origin)) m.set(x.origin, []); m.get(x.origin).push(x); }
    return [...m.entries()].sort((a, b) => {
      const ao = a[1].some((x) => x.allowed) ? 0 : 1, bo = b[1].some((x) => x.allowed) ? 0 : 1;
      return ao - bo || afHost(a[0]).localeCompare(afHost(b[0])); // 열어둔 사이트가 위로
    });
  };
  const card = (origin, accts) => {
    const anyOn = accts.some((x) => x.allowed);
    return `<section class="af-site${anyOn ? " open" : ""}">
      <header class="af-site-h">
        <span class="af-dot"></span>
        <span class="af-site-n" title="${esc(origin)}">${esc(afHost(origin))}</span>
        <span class="af-site-c">${accts.filter((x) => x.allowed).length}/${accts.length}</span>
      </header>
      ${accts.map((x) => `<div class="af-row">
        <span class="af-u">${esc(x.username || "(아이디 없음)")}</span>
        <button class="af-sw${x.allowed ? " on" : ""}" role="switch" aria-checked="${x.allowed ? "true" : "false"}"
          data-o="${esc(x.origin)}" data-u="${esc(x.username || "")}" data-on="${x.allowed ? 1 : 0}"><i></i></button>
      </div>`).join("")}
    </section>`;
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
  const chip = (v, label) => `<button class="scr-chip${afFilter === v ? " on" : ""}" data-filter="${v}">${label}</button>`;
  const src = afSources || {};
  const gap = (src.missing || []).length;
  body.innerHTML = `
    <div class="scr-head">
      <div class="scr-sum"><b>${on}</b><span>/${afList.length}개 계정에 AI 로그인 허용</span></div>
      <div class="scr-why">허용한 것만 <code>iris-browser login</code>으로 채울 수 있습니다. 비밀번호 값은 AI에게 전달되지 않고, 그 탭의 명령 결과에서도 가려집니다.</div>
      ${gap ? `<div class="scr-warn">아직 안 가져온 Chrome 계정 ${gap}개: ${esc((src.missing || []).map((m) => m.account || m.label).join(" · "))}.
        그 계정에 저장된 로그인은 여기 없습니다.
        ${featureHidden().has("accounts") ? "" : `<button class="scr-chip" data-goacct="1">계정 페이지에서 가져오기</button>`}</div>` : ""}
    </div>
    <div class="scr-sec">
      <div class="scr-sec-h">지금 열려 있는 사이트<span class="scr-sec-c">${openSites.length}</span></div>
      ${openSites.length ? `<div class="af-grid">${openSites.map(([o, a]) => card(o, a)).join("")}</div>`
        : `<div class="scr-empty">열린 탭 중 저장된 로그인이 있는 사이트가 없습니다.</div>`}
      ${openNoCred.length ? `<div class="af-note-min">저장된 로그인이 없는 열린 사이트: ${openNoCred.map((o) => esc(afHost(o))).join(" · ")}</div>` : ""}
    </div>
    <div class="scr-sec">
      <div class="scr-sec-h">저장된 로그인 전체<span class="scr-sec-c">${afList.length}</span>
        <div class="scr-tools">
          <input id="af-q" class="scr-search" placeholder="주소 또는 아이디 검색" value="${esc(afQuery)}" />
          ${chip("all", "전체")}${chip("on", "허용됨")}${chip("off", "잠김")}
          ${on ? `<button class="scr-chip danger" data-lockall="1">전체 잠금</button>` : ""}
        </div>
      </div>
      ${allSites.length ? `<div class="af-grid">${allSites.map(([o, a]) => card(o, a)).join("")}</div>`
        : `<div class="scr-empty">조건에 맞는 계정이 없습니다.</div>`}
    </div>`;
  const qbox = $("#af-q");
  if (qbox) {
    qbox.addEventListener("input", () => { afQuery = qbox.value; afRefresh(false); queueMicrotask(() => { const n = $("#af-q"); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }); });
  }
}

function wireAutofillAllowlist() {
  const body = $("#af-body"); if (!body) return;
  body.addEventListener("click", async (e) => {
    if (!window.acHost || !acHost.aiLoginSet) return;
    const f = e.target.closest("[data-filter]");
    if (f) { afFilter = f.dataset.filter; afRefresh(false); return; }
    if (e.target.closest("[data-goacct]")) { railSelect("accounts"); return; }
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
