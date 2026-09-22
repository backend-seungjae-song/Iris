// 브라우저 프로필. 탭별 Google 프로필의 정체성·저장·승격과 계정 제어 화면을 소유한다.
//
// 소유 범위
//   안정 profile id/표시 이름 규칙, localStorage 승격 여부, profileRecords 렌더 캐시와 프로필 메뉴 수명.
//   profileRecords는 getBrowserState().profiles를 정규화한 사본이며 상태 정본은 browser/state.js에 있다.
//
// 제공 API
//   프로필 목록·id·partition·탭/space 배정 query, 서버 스냅샷 정규화·승격·버튼/메뉴/rail 렌더 command.
//
// 의존 대상
//   browser/state·browser/webview-store·browser/webview·center/tab-store를 import한다. main이 소유하는
//   DOM/core 값과 browser-sync 전송, space key 변환, webview 생성·wc 회수·이동·공간 정렬은 init에서 받는다.
//
// 유지 조건
//   서버 상태가 계정 목록의 진실이며 렌더 캐시는 매번 정규화한다. 기본 profile id는 빈 문자열이고,
//   이름변경은 partition/id를 바꾸지 않으며 삭제는 자격증명 확인 뒤 live webview를 같은 순서로 재생성한다.
//
// 영향 범위
//   localStorage의 레거시 프로필 키, acHost의 Chrome import·자격증명·partition 삭제와 DOM 프로필 메뉴·
//   rail 계정 화면에 접근한다. 이 API를 바꾸면 import 하는 파일을 함께 확인한다:
//   grep -rl 'browser/profiles.js"' web/js

import {
  boundSpace, bsMutate, curBmSpace, getBrowserState, isBrowserStateLoaded, setBrowserProfiles,
} from "./state.js";
import { getWebview, removeWebview } from "./webview-store.js";
import { activeBrowserId, bindWebviewProfiles } from "./webview.js";
import { getCenterSpace } from "../center/tab-store.js";

let $, esc, cssEsc, BROWSER_MODE, bNote, spid;
let forgetTabWc, createWebview, navigateOn, showToast, orderedSpaces;
let getIsLocal = () => false;

export function initProfiles(deps) {
  ({ $, esc, cssEsc, BROWSER_MODE, bNote, spid,
    forgetTabWc, createWebview, navigateOn, showToast, orderedSpaces,
    getIsLocal } = deps);
  bindWebviewProfiles({ profileIdForStored, spaceDefaultProfile });
}

// ── 탭별 구글 프로필 ─────────────────────────────────────────────────────
// 프로필 정체성(id)과 표시 이름(name)을 분리한다. 파티션·Chrome cid·탭/스페이스 배정은 id만 쓰고,
// 이름변경은 name만 바꾼다. 기본 세션은 빈 id + 기존 persist:acbrowser를 유지한다.
export const PROFILE_DEFAULT = "기본";
export const PROFILE_DEFAULT_ID = "";
const PROFILE_ID_RE = /^[A-Za-z0-9%._~!*'()-]+$/;
const PROFILE_STORAGE_VERSION = "2";
let profileRecords = [];   // sbState.profiles의 렌더 캐시(정규화된 것)
function storedObject(key) { try { const o = JSON.parse(localStorage.getItem(key) || "{}"); return (o && typeof o === "object" && !Array.isArray(o)) ? o : {}; } catch { return {}; } }
function legacyProfileId(name) {
  try { const id = encodeURIComponent(String(name)); if (id && PROFILE_ID_RE.test(id)) return id; } catch {}
  // 기존 partitionFor도 처리하지 못했던 잘못된 surrogate만 안전 id로 폴백한다.
  let h = 2166136261;
  for (const ch of String(name)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return "legacy_" + (h >>> 0).toString(36);
}
// 계정 목록의 진실은 서버(browser-state)다. localStorage 는 Electron
// userData 폴더에 있어 앱 이름이 바뀌면 경로가 갈라지고, 사용자가 만든 계정이 전부 사라진다
// (확인 결과: 앱 이름 변경 시). 서버에 두면 앱 이름과 무관하게 남고,
// 콘솔 창과 분리 브라우저 창이 같은 목록을 본다.
function normalizeProfiles(records) {
  const seenIds = new Set(), seenNames = new Set(), out = [];
  for (const p of (records || [])) {
    const id = String((p && p.id) || ""), name = String((p && p.name) || "").trim();
    if (!id || !PROFILE_ID_RE.test(id) || !name || name === PROFILE_DEFAULT || seenIds.has(id) || seenNames.has(name)) continue;
    seenIds.add(id); seenNames.add(name); out.push({ id, name });
  }
  return out;
}
// 목록을 통째로 보내지 않는다. 창이 둘이면 각자 자기가 본 목록을 기준으로 보내므로, 나중 것이
// 상대의 변경을 지운다(한쪽이 계정을 더하고 다른 쪽이 이름을 바꾸면 더한 것이 사라진다).
// 그래서 더하기·이름변경·지우기를 각각 보내고, 서버가 자기 목록 위에서 그 한 가지만 수행한다.
function addProfileRecord(id, name) {
  if (!id || !name) return;
  profileRecords = normalizeProfiles([...profileRecords, { id, name }]);   // 낙관 반영
  setBrowserProfiles(profileRecords);
  bsMutate({ op: "profile.add", id, name });
}
export function renameProfileRecord(id, name) {
  if (!id || !name) return;
  profileRecords = profileRecords.map((p) => (p.id === id ? { id: p.id, name } : p));
  setBrowserProfiles(profileRecords);
  bsMutate({ op: "profile.rename", id, name });
}
export function removeProfileRecord(profileId) {
  const id = String(profileId || ""); if (!id) return;
  profileRecords = normalizeProfiles(profileRecords).filter((p) => p.id !== id);
  setBrowserProfiles(profileRecords);
  bsMutate({ op: "profile.remove", id });
}
export function ensureProfileData() {
  profileRecords = normalizeProfiles(getBrowserState().profiles);
}
// 목록 전체 저장은 여기 하나뿐이다. 옛 localStorage를 서버로 한 번 올리는 경로다. 서버가 이미 이관을
// 마쳤으면(표식 또는 목록이 있으면) 받지 않는다.
function importProfileRecords(records) {
  const next = normalizeProfiles(records);
  if (!next.length) return;
  profileRecords = next; setBrowserProfiles(next);
  bsMutate({ op: "profiles.set", profiles: next });
}
// 옛 localStorage → 서버 1회 승격. 서버가 아직 한 번도 이관하지 않았고, 옮길 것이 있을 때만 보낸다.
// "목록이 비었다"는 판단 기준이 아니다. 사용자가 계정을 전부 지운 상태도 빈 목록이라, 그것만 보고
// 올리면 지운 계정이 다음 실행에서 복원된다. 그래서 서버가 가진 표식(profilesImported)을 본다.
let profilesPromoted = false;
export function promoteLocalProfiles() {
  if (profilesPromoted) return;
  let raw = [];
  try { raw = JSON.parse(localStorage.getItem("ac.profiles") || "[]"); } catch {}
  if (!Array.isArray(raw)) raw = [];
  const records = [];
  const add = (name, requestedId) => {
    name = String(name || "").trim();
    if (!name || name === PROFILE_DEFAULT) return null;
    // 같은 id가 이미 있으면 새로 만들지 않고 병합한다. 사람이 읽는 이름이 키 이름(=id)보다 우선한다.
    // 과거 버그로 생긴 { id, name: id } 중복 레코드가 이 경로에서 자연히 정리된다.
    const reqId = String(requestedId || "");
    if (reqId) {
      const byId = records.find((p) => p.id === reqId);
      if (byId) { if (byId.name === byId.id && name !== reqId) byId.name = name; return byId; }
    }
    const byName = records.find((p) => p.name === name); if (byName) return byName;
    let id = reqId;
    if (!id || !PROFILE_ID_RE.test(id) || records.some((p) => p.id === id)) {
      do { id = "p_" + ((globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") ? globalThis.crypto.randomUUID().replace(/-/g, "") : Date.now().toString(36) + Math.random().toString(36).slice(2)); }
      while (records.some((p) => p.id === id));
    }
    const rec = { id, name }; records.push(rec); return rec;
  };
  for (const p of raw) {
    if (typeof p === "string") add(p, legacyProfileId(p));
    else if (p && typeof p === "object") add(p.name, p.id);
  }
  const refToId = (value) => {
    if (value == null || value === "" || value === PROFILE_DEFAULT) return PROFILE_DEFAULT_ID;
    const v = String(value);
    const existing = records.find((p) => p.id === v) || records.find((p) => p.name === v);
    if (existing) return existing.id;
    // 프로필 목록(ac.profiles)에 없는 참조는 프로필이 아니라 옛 맵의 잔재다. 이걸 새 프로필로
    // 승격하면 사용자가 만든 적 없는 프로필이 목록에 나타나므로, 기본값으로 처리한다.
    // 파티션 데이터 자체는 디스크에 남아 있으므로 유실이 아니며, 진짜 프로필은 ac.profiles에 있다.
    return PROFILE_DEFAULT_ID;
  };
  if (!records.length) { profilesPromoted = true; return; }   // 옮길 것이 없으므로 서버를 건드리지 않는다
  profilesPromoted = true;
  importProfileRecords(records);
  for (const [key, cid] of Object.entries(storedObject("ac.profileChromeSource"))) {
    const id = refToId(key);
    if (id && cid) bsMutate({ op: "profile.source", id, cid: String(cid) });
  }
  for (const [space, value] of Object.entries(storedObject("ac.spaceDefaultProfile"))) {
    const id = refToId(value);
    if (space && id) bsMutate({ op: "space.defaultProfile", space: spid(space), profile: id });
  }
  localStorage.setItem("ac.profileIdentityVersion", PROFILE_STORAGE_VERSION);
}
export function getProfiles() { ensureProfileData(); return [{ id: PROFILE_DEFAULT_ID, name: PROFILE_DEFAULT }, ...profileRecords.map((p) => ({ ...p }))]; }
export function profileById(id) { ensureProfileData(); return profileRecords.find((p) => p.id === String(id || "")) || null; }
export function profileName(id) { return !id ? PROFILE_DEFAULT : (profileById(id)?.name || String(id)); }
// 참조(id 또는 legacy 이름)를 안정 id로 해석만 하고, 프로필 레코드를 만들지 않는다.
// 모르는 id를 만났을 때 { id, name: id }를 저장하면 (a) 가져오기가 레코드 저장 전
// partitionFor를 호출하는 순간 이름이 id인 레코드가 먼저 생겨 중복·키 이름으로 보이고 (b) 프로필을
// 삭제해도 남은 참조가 같은 이름으로 다시 만든다(확인 결과: {"id":"p_..","name":"p_.."} 레코드).
// id는 그 자체로 정체성이므로 레코드 없이도 파티션을 만들 수 있다.
export function profileIdForStored(value) {
  if (value == null || value === "" || value === PROFILE_DEFAULT) return PROFILE_DEFAULT_ID;
  ensureProfileData();
  const v = String(value);
  const found = profileRecords.find((p) => p.id === v) || profileRecords.find((p) => p.name === v);
  if (found) return found.id;
  return PROFILE_ID_RE.test(v) ? v : legacyProfileId(v);
}
function newProfileId() {
  ensureProfileData();
  let id;
  do { id = "p_" + ((globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") ? globalThis.crypto.randomUUID().replace(/-/g, "") : Date.now().toString(36) + Math.random().toString(36).slice(2)); }
  while (profileRecords.some((p) => p.id === id));
  return id;
}
export function addProfile(name) {
  name = String(name || "").trim();
  if (!isBrowserStateLoaded()) return null;   // 목록을 못 받았으면 중복인지 알 수 없어 만들지 않는다
  if (!name || name === PROFILE_DEFAULT || getProfiles().some((p) => p.name === name)) return null;
  const rec = { id: newProfileId(), name };
  addProfileRecord(rec.id, rec.name);
  return rec;
}
export function partitionFor(profileId) {
  const id = profileIdForStored(profileId);
  if (!id) return "persist:acbrowser";
  if (!PROFILE_ID_RE.test(id)) throw new Error("잘못된 프로필 id");
  return "persist:acprof:" + id;
}
// 스페이스당 기본 프로필(구글 계정). 기기별(localStorage)이며 값은 안정 id다.
// 스페이스당 기본 계정도 서버가 든다. 전선 위에서는 살아 있는 workspace_id로 오므로 여기서는
// 그 이름 그대로 읽고, 저장 키(폴더)로 바꾸는 것은 서버가 한다.
export function getSpaceDefaults() { const state = getBrowserState(); return (state.defaultProfileBySpace && typeof state.defaultProfileBySpace === "object") ? state.defaultProfileBySpace : {}; }
export function spaceDefaultProfile(spaceId) { const id = getSpaceDefaults()[spaceId]; return (id && profileById(id)) ? id : PROFILE_DEFAULT_ID; }
export function setSpaceDefaultProfile(spaceId, profileId) {
  if (!spaceId) return;
  const id = profileIdForStored(profileId);
  bsMutate({ op: "space.defaultProfile", space: spaceId, profile: id });
}
// 서버의 기존 name 기반 tab.profile을 안정 id로 1회 승격한다. 받은 스냅샷도 먼저 정규화해
// 마이그레이션 broadcast를 기다리는 동안 옛 이름으로 새 파티션을 만들지 않는다.
export function migrateTabProfileRefs(st) {
  const byS = (st && st.tabsBySpace) || {};
  for (const [space, tabs] of Object.entries(byS)) for (const t of (Array.isArray(tabs) ? tabs : [])) {
    if (t.profile == null) continue; // null/누락은 스페이스 기본값 상속
    const before = String(t.profile);
    const id = profileIdForStored(before);
    if (before !== id) {
      t.profile = id;
      if (getIsLocal()) bsMutate({ op: "tab.profile", space, id: t.id, profile: id });
    }
  }
}
// 브라우저 탭의 profile 진실 소스 = 서버 상태(콘솔 로컬 탭 객체엔 없을 수 있음). 스페이스 간 tabId가
// 우연히 겹칠 수 있으므로 현재 스페이스를 먼저 조회해 잘못된 스페이스의 동명 탭 profile을 쓰지 않는다.
export function profileOfTab(tabId) {
  // 살아 있는 webview가 있으면 그것이 실제로 붙은 파티션이 답이다. 기본 계정을 바꿔도 이미 열린
  // 탭은 옮기지 않으므로(위 reconcile 참조), 여기서 기본값을 답하면 화면과 실제가 어긋난다.
  const live = getWebview(tabId);
  if (live && live.el && live.el.dataset && live.el.dataset.profile != null) return live.el.dataset.profile;
  const byS = getBrowserState().tabsBySpace || {};
  const cur = curBmSpace();
  // null/누락은 스페이스 기본값 상속, 빈 문자열은 명시적으로 기본 세션을 선택한 값이다.
  if (cur && Array.isArray(byS[cur])) {
    const t = byS[cur].find((x) => x.id === tabId);
    if (t) return t.profile == null ? spaceDefaultProfile(cur) : profileIdForStored(t.profile);
  }
  for (const sp of Object.keys(byS)) {
    const t = (byS[sp] || []).find((x) => x.id === tabId);
    if (t && t.profile != null) return profileIdForStored(t.profile);
  }
  return (cur && spaceDefaultProfile(cur)) || PROFILE_DEFAULT_ID;
}
// ── 구글 계정 / 프로필 상세 제어 페이지(rail 👤) ──
// 기존 Chrome 프로필 그대로 가져오기(쿠키+로그인) → 프로필별 자격증명 요약 → 스페이스 기본 계정 지정.
function profileForChromeImport(cid, label) {
  // 목록을 못 받았으면 "없다"가 아니라 "모른다"이다. 여기서 새로 만들면 이미 있는 계정을 두고
  // 빈 파티션을 하나 더 만드는 셈이라, 만들지 않고 물러난다.
  if (!isBrowserStateLoaded()) return { profile: null, isNew: false, unknown: true };
  const sources = getProfileChromeSource();
  // 과거 이름변경 버그로 같은 cid가 둘에 연결됐다면 목록의 기존(앞선) 프로필을 우선해 더 이상
  // 중복 프로필을 늘리지 않는다. 자동 병합/삭제는 세션 데이터 손실 가능성이 있어 하지 않는다.
  const linked = getProfiles().find((p) => sources[p.id] === cid);
  if (linked) return { profile: linked, isNew: false };
  // 레거시 label 프로필은 아직 다른 cid에 묶이지 않은 단 하나만 재사용한다.
  const labelHits = getProfiles().filter((p) => p.id && p.name === label && !sources[p.id]);
  if (labelHits.length === 1) return { profile: labelHits[0], isNew: false };
  const base = String(label || "Chrome 프로필").trim() || "Chrome 프로필";
  let name = base, n = 2;
  while (getProfiles().some((p) => p.name === name)) name = `${base} (${n++})`;
  return { profile: { id: newProfileId(), name }, isNew: true };
}
// 표시 이름이 사람 이름이 아니라 내부 키(id·퍼센트인코딩 잔재)처럼 보이는가.
// 과거 마이그레이션이 만든 프로필은 이름이 키였고, 그 프로필이 cid에 연결되면 가져오기 결과가
// 키 이름으로 표시된다. 이런 경우 Chrome 라벨로 교정한다.
function looksLikeProfileKey(name, id) {
  const n = String(name || "");
  if (!n) return true;
  if (/^p_[0-9a-f]{12,}$/i.test(n)) return true;   // 생성된 안정 id 형식
  if (/%[0-9A-Fa-f]{2}/.test(n)) return true;      // 퍼센트 인코딩 잔재
  // name === id만으로는 키가 아니다. 레거시 프로필은 id = encodeURIComponent(사용자가 지은 이름)이라
  // 프로필 표시 이름이 사람 이름과 같은 경우가 있다. 이걸 키로 보면 가져오기 때마다 Chrome
// 라벨로 덮어써서 사용자가 지은 이름이 사라진다. 생성된 id와 같을 때만 키로 본다.
  if (n === id && /^p_[0-9a-f]{12,}$/i.test(String(id || ""))) return true;
  return false;
}
// withPasswords는 기본 거짓이다. 쿠키를 가져오면서 저장된 비밀번호까지 복호화하지 않는다.
// 계정 화면의 체크칸을 켠 경우에만 참으로 넘어온다.
export async function importChromeToProfile(cid, label, withPasswords = false) {
  if (!window.acHost || !acHost.importChromeProfile) return { error: "가져오기 불가(네이티브 아님)" };
  const target = profileForChromeImport(cid, label);
  if (target.unknown) return { error: "계정 목록을 아직 받지 못했습니다. 잠시 뒤 다시 시도하세요." };
  // 레코드를 먼저 저장한다. 저장 전 partitionFor를 부르면 해석 경로가 이 id를 "모르는 참조"로 본다.
  if (target.isNew) addProfileRecord(target.profile.id, target.profile.name);
  const res = await acHost.importChromeProfile(cid, partitionFor(target.profile.id), withPasswords === true);
  if (!res || res.error) {
    if (target.isNew) removeProfileRecord(target.profile.id); // 실패 시 되돌림
    return res || { error: "가져오기 결과 없음" };
  }
  else if (looksLikeProfileKey(target.profile.name, target.profile.id)) {
    // 기존 프로필 재사용인데 이름이 키 형태면 사람이 읽는 Chrome 라벨로 교정(파티션·쿠키는 그대로).
    const base = String(label || "Chrome 프로필").trim() || "Chrome 프로필";
    let nm = base, n = 2;
    while (profileRecords.some((p) => p.id !== target.profile.id && p.name === nm)) nm = `${base} (${n++})`;
    renameProfileRecord(target.profile.id, nm);
    target.profile = { ...target.profile, name: nm };
  }
  setProfileChromeSource(target.profile.id, cid);
  res.profileId = target.profile.id;
  return res;
}
export function updateProfileBtn() {
  const btn = $("#wv-profile"); if (!btn) return;
  const id = activeBrowserId();
  if (!id) { btn.textContent = "👤 기본"; return; }
  btn.textContent = "👤 " + profileName(profileOfTab(id));
}
// 탭 프로필 변경: 서버 반영 + partition은 attach 후 불변이라 webview 재생성(현재 URL 유지 재로드).
function setTabProfile(tabId, profileId) {
  const sp = curBmSpace(); if (!sp || !tabId) return;
  profileId = profileIdForStored(profileId);
  bsMutate({ op: "tab.profile", space: sp, id: tabId, profile: profileId });
  const old = getWebview(tabId); const url = old ? old.url : "";
  if (old) { forgetTabWc(old, tabId); try { old.el.remove(); } catch {} removeWebview(tabId); }
  const rec = createWebview(tabId, profileId);
  if (url && url !== "about:blank") navigateOn(rec, url);
  if (activeBrowserId() === tabId) rec.el.classList.add("active");
  updateProfileBtn();
}
let profileMenuOff = null; // 열려 있는 프로필 메뉴의 리스너 해제자(어디서 닫든 함께 정리)
export function closeProfileMenu() {
  const m = $("#profile-menu"); if (m) m.remove();
  if (profileMenuOff) { const f = profileMenuOff; profileMenuOff = null; f(); }
}
export function openProfileMenu() {
  closeProfileMenu();
  const id = activeBrowserId(); if (!id) { bNote.textContent = "브라우저 탭을 먼저 열어주세요."; return; }
  const cur = profileOfTab(id);
  const menu = document.createElement("div"); menu.id = "profile-menu"; menu.className = "profile-menu";
  const list = getProfiles();
  menu.innerHTML = list.map((p) => `<div class="pm-item${p.id === cur ? " on" : ""}" data-p="${esc(p.id)}">${p.id === cur ? "✓ " : ""}${esc(p.name)}</div>`).join("")
    + `<div class="pm-sep"></div><div class="pm-head">기존 Chrome 프로필 가져오기</div><div class="pm-chrome">불러오는 중…</div>`
    + `<div class="pm-sep"></div><div class="pm-new"><input class="pm-in" placeholder="빈 프로필 이름" /><button class="pm-add">＋</button></div>`;
  // 왼쪽으로 펼친다. 버튼의 오른쪽 모서리에 메뉴의 오른쪽을 맞춘다. left로 잡으면 툴바 끝
  // 버튼에서 메뉴가 창 밖으로 밀린다.
  const btn = $("#wv-profile"); const r = btn.getBoundingClientRect();
  menu.style.right = Math.max(4, Math.round(window.innerWidth - r.right)) + "px";
  menu.style.left = "auto";
  menu.style.top = Math.round(r.bottom + 4) + "px";
  document.body.appendChild(menu);
  // 설치된 Chrome/Brave/Edge 프로필 목록을 비동기로 채운다.
  (async () => {
    let profs = [];
    try { profs = (window.acHost && acHost.listChromeProfiles) ? await acHost.listChromeProfiles() : []; } catch {}
    const box = menu.querySelector(".pm-chrome"); if (!box) return;
    box.innerHTML = profs.length
      ? profs.map((p) => `<div class="pm-item pm-import" data-cid="${esc(p.id)}" data-clabel="${esc(p.label)}">${esc(p.label)}</div>`).join("")
      : `<div class="pm-empty">설치된 Chrome 프로필 없음(macOS만 지원)</div>`;
  })();
  menu.addEventListener("click", async (e) => {
    const imp = e.target.closest(".pm-import");
    if (imp) {
      // 기존 Chrome 프로필 그대로 가져오기: 그 프로필 쿠키(로그인 세션)를 탭 파티션에 주입 후 webview 재생성.
      const label = imp.dataset.clabel, cid = imp.dataset.cid;
      imp.textContent = "가져오는 중… " + label;
      try {
        const res = await importChromeToProfile(cid, label);
        if (res && res.error) { bNote.textContent = "가져오기 실패: " + res.error; }
        else {
          bNote.textContent = `가져오기 완료: ${profileName(res.profileId)} (${(res && res.imported) || 0}개 쿠키)`;
          closeProfileMenu(); setTabProfile(id, res.profileId); return;
        }
      } catch (err) { bNote.textContent = "가져오기 오류: " + (err && err.message || err); }
      return;
    }
    const it = e.target.closest(".pm-item");
    if (it) { const p = it.dataset.p; if (p == null) return; closeProfileMenu(); if (p !== cur) setTabProfile(id, p); return; }
    if (e.target.closest(".pm-add")) {
      const v = menu.querySelector(".pm-in").value.trim(); if (!v) return;
      const p = addProfile(v); if (!p) { bNote.textContent = "이미 있는 프로필 이름입니다."; return; }
      closeProfileMenu(); setTabProfile(id, p.id); return;
    }
  });
  menu.querySelector(".pm-in").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); menu.querySelector(".pm-add").click(); } });
  // 바깥 클릭으로 닫기. webview(페이지) 안의 클릭은 호스트 document로 올라오지 않아 mousedown만으론
  // 헤더 영역을 눌러야만 닫혔다. 그래서 포커스 이탈(webview로 포커스가 넘어감)·Escape·
  // 창 크기 변경도 함께 닫기 신호로 쓴다. 파일 컨텍스트 메뉴(hideCtxMenu)와 같은 패턴이다.
  const off = () => {
    document.removeEventListener("mousedown", onDoc);
    document.removeEventListener("keydown", onEsc, true);
    window.removeEventListener("blur", onAway);
    window.removeEventListener("resize", onAway);
  };
  function onDoc(ev) { if (!ev.target.closest("#profile-menu") && ev.target.id !== "wv-profile") closeProfileMenu(); }
  function onEsc(ev) { if (ev.key === "Escape") closeProfileMenu(); }
  function onAway() { closeProfileMenu(); }
  setTimeout(() => {
    if (!$("#profile-menu")) return; // 이미 닫혔으면 등록하지 않는다
    profileMenuOff = off;            // closeProfileMenu가 어디서 불려도 리스너를 함께 해제
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc, true);
    window.addEventListener("blur", onAway);
    window.addEventListener("resize", onAway);
  }, 0);
}

// 안정 profile id → 원본 Chrome cid(browser.id + ":" + profileDir). label은 정체성에 쓰지 않는다.
export function getProfileChromeSource() { const state = getBrowserState(); return (state.profileSources && typeof state.profileSources === "object") ? state.profileSources : {}; }
function setProfileChromeSource(profileId, cid) {
  const id = profileIdForStored(profileId); if (!id) return;
  getProfileChromeSource()[id] = cid;   // 낙관 반영. 확정은 브로드캐스트로
  bsMutate({ op: "profile.source", id, cid });
}
