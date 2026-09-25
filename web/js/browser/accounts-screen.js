// 계정 화면. rail 의 사람 아이콘으로 연다. 프로필을 만들고 이름을 바꾸고 지우고, Chrome 에서 가져온다.
//
// 소유 범위
//   이 화면의 렌더와 listener, 그리고 화면에서 시작되는 동작(가져오기·이름변경·삭제).
//
// 제공 API
//   initAccountsScreen(deps) · acctRefresh().
//
// 의존 대상
//   프로필 레코드와 파티션 해석은 browser/profiles.js 가 소유하므로 여기서 다시 적지 않는다.
//   그림은 browser/accounts-view.js 가 그린다. $·esc·cssEsc·showToast·orderedSpaces 는 init 에서 받는다.
//
// 분리 이유
//   이 화면은 꺼 둘 수 있는 기능이고 profiles.js 는 브라우저가 늘 쓰는 코어다. 한 파일에 있으면
//   계정 화면을 끈 사람에게도 이 코드가 실리고, 브라우저를 고치는 사람과 계정 화면을 고치는
//   사람이 같은 파일을 수정하게 된다. 기능마다 병렬로 수정할 수 있는 구조를 유지한다.
//
// 유지 조건
//   삭제는 자격증명을 먼저 지우고, 실패하면 프로필을 남긴다. 순서를 바꾸면 "로그인 포함 삭제"가
//   거짓이 된다.
//   가져오기의 비밀번호 포함은 화면의 체크칸이 켜졌을 때만이다. 기본은 거짓이다.
//
// 영향 범위
//   browser/profiles.js 의 레코드 연산, browser/accounts-view.js 의 렌더, core/capabilities.js 의 연결,
//   browser/ai-tabs.js 가 서버 상태를 받을 때 부르는 accounts.stateChanged,
//   web/css/06-accounts.css 의 acct-* 규칙.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs web/js/browser/accounts-screen.js

import {
  PROFILE_DEFAULT, PROFILE_DEFAULT_ID, addProfile, getProfiles, getSpaceDefaults,
  importChromeToProfile, partitionFor, profileById, profileForChromeImport, profileIdForStored, profileName,
  removeProfileRecord, renameProfileRecord, setSpaceDefaultProfile, updateProfileBtn,
} from "./profiles.js";
import { accountsMarkup, accountsChromeBox, accountsCredsLine, accountsHeadSum, accountsUsedBy, accountsUsedHtml } from "./accounts-view.js";
import { provide } from "../core/hooks.js";
import { createDropdown } from "../core/dropdown.js";
import { bsMutate, getBrowserState, isBrowserStateLoaded } from "./state.js";
import { getWebview, removeWebview } from "./webview-store.js";
import { activeBrowserId } from "./webview.js";

// 이 기능의 마크업 위치. index.html 에 두면 기능을 꺼도 바깥 요소가 파싱되므로 여기서 만든다.
// 바깥 요소(aside 의 id·class)는 rail 표가 정본이고 여기는 안쪽만 담는다.
export const panelHtml = `
  <div class="acct-head"><h1>구글 계정</h1><span class="acct-sum" id="acct-sum"></span><span class="acct-sp"></span><button class="acct-ib" id="acct-refresh" title="새로고침" aria-label="새로고침"><svg class="i" viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg></button></div>
  <div class="acct-body" id="acct-body"></div>
`;
// 스페이스 기본 계정 드롭다운. 다시 그릴 때마다 새로 만들므로 이전 것은 닫고 떼어 낸다.
let acctDropdowns = [];
// 마지막으로 그린 스페이스 목록과 스페이스별 드롭다운. 서버 상태가 오면 이것으로 칩과 선택값만 맞춘다.
let acctSpaces = [];
const acctDdBySpace = new Map();
// 드롭다운 모듈은 값을 바꿀 때마다 목록을 다시 그리므로, 고른 항목의 체크 표시는 그 뒤에 매번 단다.
// 모듈은 고른 직후에 목록을 다시 그리지 않아서, 여기서 setValue 를 부르지 않으면 체크가 옛 항목에 남는다.
const ACCT_TICK = '<span class="acct-ck"><svg class="i" viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg></span>';
function acctSetDd(dd, v) {
  dd.setValue(v);
  dd.el.querySelector('.cc-dd-item[aria-selected="true"]')?.insertAdjacentHTML("beforeend", ACCT_TICK);
}

// 저장을 보냈지만 아직 서버 상태로 확인하지 못한 스페이스 기본 계정. 서버 상태가 그 값으로 오면
// 저장됐다고 알리고, 제한 시간 안에 오지 않으면 저장하지 못했다고 알린다.
let acctDefPending = null;   // { space, id, timer }
const ACCT_DEF_CONFIRM_MS = 5000;

let $, esc, cssEsc, BROWSER_MODE, showToast, orderedSpaces;
let forgetTabWc, createWebview, navigateOn;

export function initAccountsScreen(deps) {
  ({ $, esc, cssEsc, BROWSER_MODE, showToast, orderedSpaces,
     forgetTabWc, createWebview, navigateOn } = deps);
  wireAccounts();
}

// 이름변경은 라벨만 바꾼다. id/partition/cid/creds/space/tab 참조와 live webview는 모두 그대로다.
async function renameProfile(profileId, newName) {
  const current = profileById(profileId);
  newName = (newName || "").trim();
  if (!current || !newName || newName === current.name) { acctRefresh(); return; }
  if (newName === PROFILE_DEFAULT) { showToast("기본 프로필 이름은 바꿀 수 없습니다"); acctRefresh(); return; }
  if (getProfiles().some((p) => p.id !== profileId && p.name === newName)) { showToast("이미 있는 프로필 이름입니다"); acctRefresh(); return; }
  const oldName = current.name;
  renameProfileRecord(profileId, newName);
  updateProfileBtn(); acctRefresh(); showToast(`프로필 이름 변경: ${oldName} → ${newName}`);
}
// 프로필 삭제. 저장된 로그인(자격증명)까지 함께 삭제한다. 이 프로필을 쓰던 탭·스페이스
// 기본값은 기본 프로필로 되돌린다(파티션 불변이라 webview 재생성).
async function deleteProfile(profileId) {
  const name = profileName(profileId);
  if (!profileId) { showToast("기본 프로필은 삭제할 수 없습니다"); acctRefresh(); return; }
  // 1) 저장된 로그인(자격증명)을 먼저 삭제한다. 실패하면 프로필도 지우지 않고 알린다.
  try {
    if (!(window.acHost && acHost.clearCreds)) throw new Error("자격증명 삭제 불가(로컬 앱에서만)");
    const result = await acHost.clearCreds(partitionFor(profileId));
    if (!(result && result.ok)) throw new Error((result && result.error) || "자격증명 삭제 실패");
  } catch (e) { showToast("로그인 삭제 실패. 프로필 삭제 취소: " + (e && e.message || e)); acctRefresh(); return; }
  // 2) 프로필 목록·Chrome 소스 매핑·스페이스 기본값 정리.
  // 삭제는 전용 연산으로 보낸다. 목록 전체 저장으로 보내면 마지막 하나를 지울 때 빈 목록이 되고,
  // 서버는 빈 목록을 (부팅 경합으로 보고) 거부하므로 지워지지 않는다. 크롬 연결·스페이스 기본값
  // 정리도 서버가 같은 연산 안에서 함께 한다.
  removeProfileRecord(profileId);
  // 3) 이 프로필을 쓰던 탭 → 기본 프로필로 재배정 + webview 재생성(격리 유지).
  const byS = getBrowserState().tabsBySpace || {};
  for (const sp of Object.keys(byS)) for (const t of (byS[sp] || [])) if (t.profile === profileId) {
    bsMutate({ op: "tab.profile", space: sp, id: t.id, profile: PROFILE_DEFAULT_ID });
    const rec = getWebview(t.id);
    if (rec) { const url = rec.url; forgetTabWc(rec, t.id); try { rec.el.remove(); } catch {} removeWebview(t.id); const nr = createWebview(t.id, PROFILE_DEFAULT_ID); if (url && url !== "about:blank") navigateOn(nr, url); if (activeBrowserId() === t.id) nr.el.classList.add("active"); }
  }
  // 4) 그 파티션의 저장소를 실제로 비운다. 여기까지 수행해야 "로그인 포함 삭제"가 성립한다.
  // 3)에서 그 파티션을 쓰던 webview 를 먼저 없앴으므로 지금 비우는 것이 안전하다. 쿠키·localStorage·
  // 캐시가 남아 있으면 같은 이름으로 다시 만든 프로필에서 이전 로그인이 그대로 복원된다.
  let purged = true;
  try {
    if (window.acHost && acHost.purgePartition) {
      const r = await acHost.purgePartition(partitionFor(profileId));
      purged = !!(r && r.ok);
    } else purged = false;
  } catch { purged = false; }
  updateProfileBtn(); acctRefresh();
  showToast(purged ? `프로필 삭제됨: ${name} (로그인 포함)`
    : `프로필 삭제됨: ${name}. 다만 저장소를 비우지 못했습니다(앱 재시작 후 다시 시도)`);
}
export function acctRefresh() {
  const body = $("#acct-body"); if (!body) return;
  // 공유 브라우저 창도 자기 탭을 가진 하나의 스페이스다(?space=__shared__). herdr 스페이스 목록엔
  // 들어 있지 않아 기본 계정이 빠지므로, 목록 끝에 직접 추가한다.
  const spaces = [...orderedSpaces(), { id: "__shared__", label: "공유 브라우저" }];
  acctSpaces = spaces;
  const profiles = getProfiles();
  // 렌더는 accounts-view 가 담당한다. 앱을 켜지 않는 사본과 검사가 같은 함수를 부를 수 있어야
  // 배치를 두 벌로 유지하지 않는다.
  const model = {
    spaces, profiles, defaults: getSpaceDefaults(), defaultProfileId: PROFILE_DEFAULT_ID,
    creds: {}, chromeProfiles: null, withPasswords: !!($("#acct-with-pw") || {}).checked,
  };
  for (const d of acctDropdowns) d.destroy();
  acctDropdowns = [];
  acctDdBySpace.clear();
  body.innerHTML = accountsMarkup(model);
  const sum = $("#acct-sum");
  if (sum) sum.innerHTML = accountsHeadSum(profiles.length, 0);

  // 네이티브 select 자리를 드롭다운으로 채운다. 고르면 그 자리에서 change 를 내므로 아래
  // wireAccounts 의 change 처리(data-space-def·value)가 select 때와 같이 받는다.
  const items = profiles.map((p) => ({ value: p.id, label: p.name }));
  for (const holder of body.querySelectorAll("[data-space-def]")) {
    holder.value = holder.dataset.value;
    const dd = createDropdown({
      items, value: holder.dataset.value, ariaLabel: `${holder.dataset.label} 기본 계정`,
      onChange: (v) => { holder.value = v; acctSetDd(dd, v); holder.dispatchEvent(new Event("change", { bubbles: true })); },
    });
    acctSetDd(dd, holder.dataset.value);
    holder.appendChild(dd.el);
    acctDropdowns.push(dd);
    acctDdBySpace.set(holder.dataset.spaceDef, { dd, holder });
  }

  // 프로필별 자격증명 요약(비번 제외). 모두 도착하면 머리 막대에 합계를 붙인다.
  const counts = profiles.map((p) => (async () => {
    const el = body.querySelector(`[data-creds="${cssEsc(p.id)}"]`);
    const nEl = body.querySelector(`[data-creds-n="${cssEsc(p.id)}"]`);
    try {
      const s = (window.acHost && acHost.credsSummary) ? await acHost.credsSummary(partitionFor(p.id)) : { count: 0, accounts: [] };
      const line = accountsCredsLine(s);
      if (el) { el.textContent = line.text; el.classList.toggle("none", line.none); }
      if (nEl) nEl.textContent = s.count ? String(s.count) : "";
      return s.count || 0;
    } catch { if (el) el.textContent = ""; return 0; }
  })());
  Promise.all(counts).then((ns) => {
    const s2 = $("#acct-sum"); if (s2 && body.isConnected) s2.innerHTML = accountsHeadSum(profiles.length, ns.reduce((a, n) => a + n, 0));
  });
  // 설치된 Chrome 프로필 목록. 가져가면 들어갈 프로필을 함께 보인다. 판정은 가져오기와 같은 함수다.
  (async () => {
    let profs = []; try { profs = (window.acHost && acHost.listChromeProfiles) ? await acHost.listChromeProfiles() : []; } catch {}
    const box = body.querySelector("#acct-chrome"); if (!box) return;
    const withTarget = profs.map((cp) => {
      let target = null;
      try {
        const t = profileForChromeImport(cp.id, cp.label);
        if (t && t.profile) target = { name: t.profile.name, isNew: !!t.isNew };
      } catch {}
      return { ...cp, target };
    });
    box.innerHTML = accountsChromeBox(withTarget);
    const n = body.querySelector("#acct-chrome-n"); if (n) n.textContent = String(profs.length);
  })();
}
// 서버가 보낸 브라우저 상태(스페이스 기본 계정의 정본)에 맞춰 "쓰는 스페이스" 칩과 드롭다운 값만 고친다.
// 화면 전체를 다시 그리면 이름 편집 칸·드롭다운의 포커스가 사라지므로 바뀐 칸만 손댄다.
// 기본 계정을 바꾼 창도 저장 요청만 보내고 여기서 반영하므로, 서버가 거절하거나 다른 창이 바꾼 값도 그대로 보인다.
function acctSaveSpaceDefault(space, value) {
  const id = profileIdForStored(value);
  if (acctDefPending) clearTimeout(acctDefPending.timer);
  acctDefPending = null;
  if ((getSpaceDefaults()[space] || PROFILE_DEFAULT_ID) === id) { showToast("스페이스 기본 계정 저장됨"); return; }
  const pend = { space, id, timer: null };
  pend.timer = setTimeout(() => {
    if (acctDefPending !== pend) return;
    acctDefPending = null;
    showToast("스페이스 기본 계정을 저장하지 못했습니다");
    acctApplyServerState();   // 선택 값을 서버에 있는 값으로 되돌린다
  }, ACCT_DEF_CONFIRM_MS);
  acctDefPending = pend;
  setSpaceDefaultProfile(space, value);
}
function acctApplyServerState() {
  const defaults = getSpaceDefaults();
  if (acctDefPending && (defaults[acctDefPending.space] || PROFILE_DEFAULT_ID) === acctDefPending.id) {
    clearTimeout(acctDefPending.timer);
    acctDefPending = null;
    showToast("스페이스 기본 계정 저장됨");
  }
  const body = $("#acct-body"); if (!body || !body.isConnected || !acctSpaces.length) return;
  const usedBy = accountsUsedBy(acctSpaces, defaults, PROFILE_DEFAULT_ID);
  for (const tile of body.querySelectorAll(".acct-tile[data-prof]")) {
    const used = tile.querySelector(".acct-used"); if (!used) continue;
    const html = accountsUsedHtml(usedBy.get(tile.dataset.prof));
    if (used.innerHTML !== html) used.innerHTML = html;
  }
  for (const s of acctSpaces) {
    const ent = acctDdBySpace.get(s.id); if (!ent) continue;
    const v = defaults[s.id] || PROFILE_DEFAULT_ID;
    if (ent.holder.value === v) continue;
    // 저장 확인을 기다리는 스페이스는 사용자가 고른 값을 그대로 둔다. 그 사이 다른 변경으로 온 상태에는
    // 아직 옛 값이 들어 있다.
    if (acctDefPending && acctDefPending.space === s.id) continue;
    // 사용자가 목록을 연 채 고르는 중이면 건드리지 않는다. 고르고 나면 다음 상태 수신이 맞춘다.
    if (ent.dd.el.querySelector('[aria-expanded="true"]')) continue;
    ent.holder.value = v; ent.holder.dataset.value = v;
    acctSetDd(ent.dd, v);
  }
}
function wireAccounts() {
  const body = $("#acct-body"); if (!body || BROWSER_MODE) return;
  $("#acct-refresh")?.addEventListener("click", acctRefresh);
  body.addEventListener("change", (e) => {
    const sel = e.target.closest("[data-space-def]");
    if (sel) acctSaveSpaceDefault(sel.dataset.spaceDef, sel.value);
  });
  body.addEventListener("click", async (e) => {
    const rn = e.target.closest("[data-rename]");
    if (rn) {
      const profileId = rn.dataset.rename, current = profileById(profileId);
      const row = rn.closest("[data-prof]"), an = row && row.querySelector(".an");
      if (!an || an.querySelector(".acct-rename-in")) return; // 이미 편집중
      an.classList.add("acct-editing");
      an.innerHTML = `<input class="acct-inp acct-rename-in" value="${esc(current?.name || "")}" /><span class="acct-hint">Enter=저장 · Esc=취소</span>`;
      const inp = an.querySelector(".acct-rename-in"); inp.focus(); inp.select();
      inp.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); renameProfile(profileId, inp.value); } else if (ev.key === "Escape") { ev.preventDefault(); acctRefresh(); } });
      inp.addEventListener("blur", () => setTimeout(() => { if (document.body.contains(inp)) acctRefresh(); }, 150));
      return;
    }
    const del = e.target.closest("[data-del-prof]");
    if (del) { const id = del.dataset.delProf, name = profileName(id); if (confirm(`"${name}" 프로필을 삭제할까요?\n저장된 로그인(자격증명)도 함께 삭제되고, 이 프로필을 쓰던 탭은 기본 프로필로 되돌아갑니다.`)) { await deleteProfile(id); } return; }
    const add = e.target.closest("#acct-new-add");
    if (add) { const inp = $("#acct-new-name"); const v = (inp.value || "").trim(); if (v) { if (!addProfile(v)) showToast("이미 있는 프로필 이름입니다"); else inp.value = ""; acctRefresh(); } return; }
    const imp = e.target.closest("[data-imp-cid]");
    if (imp) {
      const cid = imp.dataset.impCid, label = imp.dataset.impLabel; imp.innerHTML = '<span class="acct-spin"></span>가져오는 중…'; imp.disabled = true;
      const withPw = !!(document.getElementById("acct-with-pw") || {}).checked;
      const res = await importChromeToProfile(cid, label, withPw);
      if (res && res.error) { imp.textContent = "실패"; imp.classList.add("acct-btn-danger"); showToast("가져오기 실패: " + res.error); }
      // 바로 넣지 못한 쿠키는 다음 실행 때 한 번 적용을 시도할 뿐이고, 그사이 로그인 상태가 바뀌면 버려진다.
      else if (res && !res.live && res.staged) {
        imp.textContent = "미완료";
        showToast(`가져오기 미완료: ${label} 쿠키 ${res.staged}개를 바로 넣지 못했습니다. 앱을 다시 시작하면 한 번 더 적용을 시도합니다.`);
      } else {
        // 비밀번호를 가져오지 않은 것은 실패가 아니라 선택이므로, 화면에 그대로 구분해 표시한다.
        const pw = res && res.loginsSkipped ? "로그인 미포함" : `로그인 ${(res && res.logins) || 0}`;
        showToast(`가져오기 완료: ${label} (쿠키 ${(res && res.imported) || 0}, ${pw})`); acctRefresh();
      }
      return;
    }
  });
  body.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.id === "acct-new-name") { e.preventDefault(); $("#acct-new-add").click(); } });
}

// 이 기능의 연결. 표에는 선언만 두고 연결 방법은 각 기능이 가지므로, 기능을
// 고칠 때 공용 표를 수정하지 않는다.
export function initCapability(ctx) {
  initAccountsScreen({
    $: ctx.$, esc: ctx.esc, cssEsc: ctx.cssEsc, BROWSER_MODE: ctx.browserMode,
    showToast: ctx.showToast, orderedSpaces: ctx.orderedSpaces,
    forgetTabWc: ctx.forgetTabWc, createWebview: ctx.createWebview, navigateOn: ctx.navigateOn,
  });
  provide("accounts.stateChanged", acctApplyServerState);
  return { screen: { enter: acctRefresh } };
}
