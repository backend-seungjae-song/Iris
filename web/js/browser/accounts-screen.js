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
//   web/css/06-accounts.css 의 acct-* 규칙.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs web/js/browser/accounts-screen.js

import {
  PROFILE_DEFAULT, PROFILE_DEFAULT_ID, addProfile, getProfiles, getSpaceDefaults,
  importChromeToProfile, partitionFor, profileById, profileName, removeProfileRecord,
  renameProfileRecord, setSpaceDefaultProfile, updateProfileBtn,
} from "./profiles.js";
import { accountsMarkup, accountsChromeBox } from "./accounts-view.js";
import { bsMutate, getBrowserState, isBrowserStateLoaded } from "./state.js";
import { getWebview, removeWebview } from "./webview-store.js";
import { activeBrowserId } from "./webview.js";

// 이 기능의 마크업 위치. index.html 에 두면 기능을 꺼도 바깥 요소가 파싱되므로 여기서 만든다.
// 바깥 요소(aside 의 id·class)는 rail 표가 정본이고 여기는 안쪽만 담는다.
export const panelHtml = `
  <div class="scr-bar"><span class="scr-bar-title">계정</span><button class="scr-ico" id="acct-refresh" title="새로고침">↻</button></div>
  <div class="acct-body" id="acct-body"></div>
`;

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
  const profiles = getProfiles();
  // 렌더는 accounts-view 가 담당한다. 앱을 켜지 않는 사본과 검사가 같은 함수를 부를 수 있어야
  // 배치를 두 벌로 유지하지 않는다.
  const model = {
    spaces, profiles, defaults: getSpaceDefaults(), defaultProfileId: PROFILE_DEFAULT_ID,
    creds: {}, chromeProfiles: null, withPasswords: !!($("#acct-with-pw") || {}).checked,
  };
  body.innerHTML = accountsMarkup(model);

  // 프로필별 자격증명 요약(비번 제외).
  for (const p of profiles) {
    const el = body.querySelector(`[data-creds="${cssEsc(p.id)}"]`); if (!el) continue;
    (async () => {
      try {
        const s = (window.acHost && acHost.credsSummary) ? await acHost.credsSummary(partitionFor(p.id)) : { count: 0, accounts: [] };
        el.textContent = s.count ? `저장된 로그인 ${s.count}개${s.accounts.length ? " · " + s.accounts.slice(0, 3).join(", ") : ""}` : "저장된 로그인 없음";
      } catch { el.textContent = ""; }
    })();
  }
  // 설치된 Chrome 프로필 목록.
  (async () => {
    let profs = []; try { profs = (window.acHost && acHost.listChromeProfiles) ? await acHost.listChromeProfiles() : []; } catch {}
    const box = body.querySelector("#acct-chrome"); if (!box) return;
    box.innerHTML = accountsChromeBox(profs);
  })();
}
function wireAccounts() {
  const body = $("#acct-body"); if (!body || BROWSER_MODE) return;
  $("#acct-refresh")?.addEventListener("click", acctRefresh);
  body.addEventListener("change", (e) => {
    const sel = e.target.closest("[data-space-def]");
    if (sel) { setSpaceDefaultProfile(sel.dataset.spaceDef, sel.value); showToast("스페이스 기본 계정 저장됨"); }
  });
  body.addEventListener("click", async (e) => {
    const rn = e.target.closest("[data-rename]");
    if (rn) {
      const profileId = rn.dataset.rename, current = profileById(profileId);
      const row = rn.closest("[data-prof]"), an = row && row.querySelector(".an");
      if (!an || an.querySelector(".acct-rename-in")) return; // 이미 편집중
      an.innerHTML = `<input class="acct-rename-in" value="${esc(current?.name || "")}" /><div class="asub">Enter=저장 · Esc=취소</div>`;
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
      const cid = imp.dataset.impCid, label = imp.dataset.impLabel; imp.textContent = "가져오는 중…"; imp.disabled = true;
      const withPw = !!(document.getElementById("acct-with-pw") || {}).checked;
      const res = await importChromeToProfile(cid, label, withPw);
      if (res && res.error) { imp.textContent = "실패"; showToast("가져오기 실패: " + res.error); }
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
  return { screen: { enter: acctRefresh } };
}
