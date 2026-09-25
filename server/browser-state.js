// 브라우저 공유 상태. 콘솔 창과 분리(detached) 브라우저 창이 탭·북마크·활성 스페이스를 공유하는
// 단일 소스다. 두 창이 각자 상태를 가지면 동기화가 서로를 계속 유발하므로, 서버가 단일 상태를 보관하고
// mutation을 받아 반영한 뒤 전체에 broadcast한다. 클라이언트는 받은 상태를 렌더링만 하고,
// 사용자 행동 외 예외는 레거시 profile 이름→안정 id 1회 변환뿐이다(동일 id mutation은 멱등).
//
// 라이브 webview는 창 사이 이동이 불가능하고 세션(persist:acbrowser)은 공유되므로, 브라우저의 정체성은
// 탭 URL 목록과 활성 스페이스라는 가벼운 상태로 충분하다. 무거운 webview 인스턴스는 창별로
// 그 상태로부터 다시 만든다(도킹/분리 전환 시 재생성).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stateHome } from "./state-home.cjs";

// 상태 폴더는 한 곳에서 정한다. 여기서만 경로를 다시 조합하면 개발 환경(`IRIS_STATE_DIR=~/.iris-dev`)이
// 설치된 앱의 상태 파일을 그대로 쓴다. 두 서버가 같은 파일에 각자의 상태를 번갈아 써서 사용자가
// 쌓아둔 데이터가 사라진다(확인 결과: 종료되지 않은 서버 프로세스가 계정·기록을 계속 덮어썼다).
const DATA_DIR = stateHome();
const STATE_PATH = path.join(DATA_DIR, "browser-state.json");
const PROFILE_ID_RE = /^[A-Za-z0-9%._~!*'()-]+$/;

function emptyState() {
  return {
    bookmarksBySpace: {}, // { [space]: [항목…] } 스페이스마다 따로 보관한다(요구사항: 스페이스별 북마크). 화면에서는 세션 북마크
    // 모든 스페이스에서 보이는 공통 북마크. 편의 기능이 꺼져 있으면 화면에 나오지 않을 뿐 지우지 않는다.
    // 항목은 북마크 {url, title} 이거나 폴더 {folder, title, items:[{url, title}]} 다. 폴더는 한 단계뿐이다.
    bookmarksCommon: [],
    tabsBySpace: {},      // { [space]: [{id, url, title, profile}] } (profile=null: 스페이스 기본 상속, "": 기본 세션, 그 외: 안정 id)
    activeBySpace: {},    // { [space]: tabId }
    activeSpace: null,    // 콘솔이 현재 포커스한 스페이스(분리 창의 미러 타깃)
    docked: false,        // 브라우저가 콘솔 센터에 도킹됐는지(기본 false = 분리형)
    // 탭 그룹(폴더): 실행 중인 탭을 이름으로 묶고 접는다. 탭의 group 필드가 소속을 가리킨다.
    groupsBySpace: {},    // { [space]: [{id, name, collapsed}] }
    // 저장된 그룹: 탭 조합의 스냅샷. 스페이스에 매이지 않아 어느 창에서든 열 수 있다.
    savedGroups: [],      // [{id, name, savedAt, tabs:[{url,title,name,profile}]}]
    // 계정(로그인 칸)과 주소창 기록. 창의 localStorage에 두면 그 위치가 Electron의
    // userData 폴더라, 앱 이름이 바뀔 때 폴더가 바뀌어 사용자가 만든 계정 목록과 기록이
    // 빈 상태로 시작한다. 여기에 저장하면
    // 앱 이름과 무관한 위치에 남고, 스페이스별 항목은 북마크와 같은 폴더 키를 쓴다.
    profiles: [],              // [{id, name}] 전역이며 어느 스페이스에서나 같은 칸을 고른다
    profilesImported: false,   // 이전 localStorage를 한 번 이관했는지 여부. 삭제한 계정이 복구되는 것을 막는 표시다
                               // (목록이 비었다는 사실만으로는 이관 전과 사용자가 모두 지운 뒤를 구별할 수 없다)
    profileSources: {},        // { [profileId]: chromeCid } 전역
    defaultProfileBySpace: {}, // { [space]: profileId }
    urlHistoryBySpace: {},     // { [space]: [url…] } 최신순 최대 URL_HISTORY_MAX
  };
}

const URL_HISTORY_MAX = 60;

let state = emptyState();
let saveTimer = null;

export function load() {
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    state = Object.assign(emptyState(), parsed);
    // 방어: 필드 타입 정규화
    if (!state.bookmarksBySpace || typeof state.bookmarksBySpace !== "object") state.bookmarksBySpace = {};
    if (!Array.isArray(state.bookmarksCommon)) state.bookmarksCommon = [];
    for (const list of [state.bookmarksCommon, ...Object.values(state.bookmarksBySpace)]) {
      if (Array.isArray(list)) for (const x of list) if (isFolder(x) && !Array.isArray(x.items)) x.items = [];
    }
    if (!state.tabsBySpace || typeof state.tabsBySpace !== "object") state.tabsBySpace = {};
    if (!state.activeBySpace || typeof state.activeBySpace !== "object") state.activeBySpace = {};
    if (!state.groupsBySpace || typeof state.groupsBySpace !== "object") state.groupsBySpace = {};
    if (!Array.isArray(state.savedGroups)) state.savedGroups = [];
    if (!Array.isArray(state.profiles)) state.profiles = [];
    state.profilesImported = !!state.profilesImported || state.profiles.length > 0;
    if (!state.profileSources || typeof state.profileSources !== "object") state.profileSources = {};
    if (!state.defaultProfileBySpace || typeof state.defaultProfileBySpace !== "object") state.defaultProfileBySpace = {};
    if (!state.urlHistoryBySpace || typeof state.urlHistoryBySpace !== "object") state.urlHistoryBySpace = {};
    // 이름 기반 스킴의 기본 라벨은 안정 기본 id("")로 바로 승격한다. 다른 레거시 이름은 프로필
    // 목록을 가진 로컬 렌더러가 encodeURIComponent(name) id로 바꿔 tab.profile mutation으로 되쓴다.
    let profileMigrated = false;
    for (const tabs of Object.values(state.tabsBySpace)) {
      if (!Array.isArray(tabs)) continue;
      for (const tab of tabs) {
        if (tab && tab.profile === "기본") { tab.profile = ""; profileMigrated = true; }
      }
    }
    // 계정이 지정되지 않은 탭에 현재 사용 중인 계정을 기록한다. 1회성 처리다.
    //
    // `profile: null`은 스페이스 기본을 따른다는 뜻이라, 그 탭이 어느 세션에 속하는지가
    // 저장되지 않는다. 기본이 바뀌면 그 탭들은 다음에 열릴 때 다른 파티션에 붙어
    // 사용자에게는 이유 없는 로그아웃으로 보인다. 현재 값을 기록하면 이후 기본이 바뀌어도 그대로 남고,
    // 바뀐 기본은 새로 여는 탭부터 적용된다. 기본 계정의 의미가 그것이다.
    //
    // 기록하는 값은 현재 그 탭이 실제로 쓰고 있는 계정이라, 이 이관 자체는 동작을 바꾸지 않는다.
    for (const [sp, tabs] of Object.entries(state.tabsBySpace)) {
      if (!Array.isArray(tabs)) continue;
      for (const tab of tabs) {
        if (!tab || tab.profile != null) continue;
        tab.profile = resolveSpaceDefault(sp);
        profileMigrated = true;
      }
    }
    // 레거시 전역 bookmarks → 스페이스별로 마이그레이션(activeSpace 버킷, 없으면 __legacy__). 1회성.
    if (Array.isArray(parsed.bookmarks) && parsed.bookmarks.length) {
      const bucket = state.activeSpace || "__legacy__";
      if (!Array.isArray(state.bookmarksBySpace[bucket])) state.bookmarksBySpace[bucket] = [];
      for (const b of parsed.bookmarks) if (b && b.url && !state.bookmarksBySpace[bucket].some((x) => x.url === b.url)) state.bookmarksBySpace[bucket].push({ url: String(b.url), title: String(b.title || b.url).slice(0, 60) });
    }
    delete state.bookmarks; // 레거시 필드 제거(이후 bookmarksBySpace만 진실)
    if (profileMigrated) persist();
  } catch { state = emptyState(); }
  return state;
}

// 그 스페이스의 기본 계정을 해석한다. 렌더러의 `spaceDefaultProfile`과 같은 규칙이다.
// 가리키는 계정이 목록에 없으면 기본 세션("")이다. 없는 것을 가리킨 채로 두면 그 참조가
// 파티션 이름이 되어 아무도 로그인한 적 없는 빈 세션이 생긴다.
function resolveSpaceDefault(sp) {
  const id = (state.defaultProfileBySpace || {})[sp];
  if (!id) return "";
  return (state.profiles || []).some((p) => p && p.id === id) ? id : "";
}

function writeNow() {
  saveTimer = null;
  // 임시 파일에 쓰고 옮긴다. 쓰는 도중 종료되면 불완전한 파일이 남고, 그 파일은 다음 시작에서
  // 파싱에 실패해 빈 상태로 취급된다(=사용자가 쌓아둔 탭·북마크가 통째로 사라진다).
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_PATH + ".tmp", JSON.stringify(state));
    fs.renameSync(STATE_PATH + ".tmp", STATE_PATH);
  } catch {}
}
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(writeNow, 200);
}
// 종료 전에 밀린 쓰기를 끝낸다. 200ms 지연은 평소에는 안전한 병합이지만, 그 사이에 종료 신호가
// 오면 마지막 탭 이동·북마크가 저장되지 않는다. 앱이 서버를 관리하므로
// SIGTERM은 예외가 아니라 일반적인 경로이고, 앱을 끌 때마다 이 구간을 지난다.
export function flushNow() {
  if (!saveTimer) return false;
  clearTimeout(saveTimer);
  writeNow();
  return true;
}

export function get() { return state; }

// 이 키 아래에 사용자 데이터가 있는지 확인한다. 키를 옮겨도 되는지 판단할 때 쓴다. 이미 데이터가
// 쌓인 스페이스의 키를 바꾸면 그 스페이스의 탭·북마크를 잃는다.
export function hasSpace(key) {
  if (!key) return false;
  return !!((state.tabsBySpace[key] || []).length
    || (state.bookmarksBySpace[key] || []).length
    || (state.groupsBySpace[key] || []).length
    || (state.urlHistoryBySpace[key] || []).length
    || state.defaultProfileBySpace[key]);
}

// ── 스페이스 키 이관 ────────────────────────────────────────────────
// map: { 이전 키(workspace_id) → 새 키(폴더 실경로) }. 필요한 이유는 server/space-key.js 머리말에 있다.
// 한 폴더에 이전 키가 여럿 붙는 경우가 있어(한 폴더에 w8·w16 두 키) 덮어쓰기가 아니라
// 병합한다. 이관 때문에 사용자 데이터를 잃으면 안 된다.
// preferSource: 옮겨오는 쪽(이전 키)이 더 최근일 때 켠다. 키를 뒤늦게 바로잡는 경우가 그렇다.
// 잘못된 키 아래에서 사용자가 방금까지 작업했고, 올바른 키에는 그 이전 데이터가 있다. 이때
// 목적지를 우선하면 방금 쓰던 기록·기본 계정이 뒤로 밀리거나 60개 제한에 잘려 사라진다.
export function remapSpaces(map, { preferSource = false } = {}) {
  const pairs = Object.entries(map || {}).filter(([from, to]) => from && to && from !== to);
  if (!pairs.length) return false;
  let changed = false;
  const moveOne = (bucket, merge) => {
    const m = state[bucket]; if (!m || typeof m !== "object") return;
    for (const [from, to] of pairs) {
      if (!Object.prototype.hasOwnProperty.call(m, from)) continue;
      const src = m[from];
      delete m[from];
      m[to] = Object.prototype.hasOwnProperty.call(m, to) ? merge(m[to], src) : src;
      changed = true;
    }
  };
  // 탭: 이어 붙이되 같은 id는 하나만 남긴다. 현재 보고 있는 대상이 앞, 복원한 것이 뒤다.
  moveOne("tabsBySpace", (dst, src) => {
    const out = Array.isArray(dst) ? dst.slice() : [];
    const seen = new Set(out.map((t) => t && t.id));
    for (const t of Array.isArray(src) ? src : []) if (t && !seen.has(t.id)) { out.push(t); seen.add(t.id); }
    return out;
  });
  // 북마크: url 기준 합집합. 폴더는 id 가 같으면 안의 북마크를 합친다. 폴더 안의 url 도 목록 전체에서
  // 하나만 남긴다. 폴더에는 url 이 없어서 url 로만 거르면 두 번째 폴더부터 모두 버려진다.
  moveOne("bookmarksBySpace", (dst, src) => {
    const out = Array.isArray(dst) ? dst.slice() : [];
    for (const b of Array.isArray(src) ? src : []) {
      if (!b) continue;
      if (isFolder(b)) {
        const items = (Array.isArray(b.items) ? b.items : []).filter((x) => x && !findBm(out, x.url));
        const same = findFolder(out, b.folder);
        if (same) same.items = [...same.items, ...items]; else out.push({ ...b, items });
      } else if (!findBm(out, b.url)) out.push(b);
    }
    return out;
  });
  // 그룹: id 기준 합집합. 이름이 다르면 현재 사용 중인 이름을 남긴다.
  moveOne("groupsBySpace", (dst, src) => {
    const out = Array.isArray(dst) ? dst.slice() : [];
    const seen = new Set(out.map((g) => g && g.id));
    for (const g of Array.isArray(src) ? src : []) if (g && !seen.has(g.id)) { out.push(g); seen.add(g.id); }
    return out;
  });
  // 주소창 기록: 최신순을 지키며 이어 붙인다. 더 최근인 쪽이 앞이다.
  moveOne("urlHistoryBySpace", (dst, src) => {
    const [first, second] = preferSource ? [src, dst] : [dst, src];
    const out = Array.isArray(first) ? first.slice() : [];
    const seen = new Set(out);
    for (const u of Array.isArray(second) ? second : []) if (u && !seen.has(u)) { out.push(u); seen.add(u); }
    return out.slice(0, URL_HISTORY_MAX);
  });
  // 활성 탭과 스페이스 기본 계정은 각각 하나뿐이므로 더 최근인 쪽을 남긴다.
  moveOne("activeBySpace", (dst, src) => (preferSource && src ? src : dst));
  moveOne("defaultProfileBySpace", (dst, src) => (preferSource && src ? src : dst));
  if (state.activeSpace) {
    const hit = pairs.find(([from]) => from === state.activeSpace);
    if (hit) { state.activeSpace = hit[1]; changed = true; }
  }
  // 병합으로 사라진 탭을 가리키던 활성 탭은 그 스페이스의 마지막 탭으로 되돌린다.
  for (const [, to] of pairs) {
    const tabs = state.tabsBySpace[to] || [];
    const act = state.activeBySpace[to];
    if (act && !tabs.some((t) => t.id === act)) {
      state.activeBySpace[to] = tabs.length ? tabs[tabs.length - 1].id : null;
      changed = true;
    }
  }
  if (changed) persist();
  return changed;
}

function ensureSpace(sp) {
  if (!sp) return null;
  if (!Array.isArray(state.tabsBySpace[sp])) state.tabsBySpace[sp] = [];
  return state.tabsBySpace[sp];
}
function ensureGroups(sp) {
  if (!sp) return null;
  if (!Array.isArray(state.groupsBySpace[sp])) state.groupsBySpace[sp] = [];
  return state.groupsBySpace[sp];
}

function ensureBmSpace(sp) {
  if (!sp) return null;
  if (!Array.isArray(state.bookmarksBySpace[sp])) state.bookmarksBySpace[sp] = [];
  return state.bookmarksBySpace[sp];
}

// 북마크 목록 하나. 세션 목록(스페이스별)과 공통 목록이 같은 모양이라 조작도 같은 코드가 한다.
function bmList(scope, sp) {
  return scope === "common" ? state.bookmarksCommon : ensureBmSpace(sp);
}
function isFolder(x) { return !!(x && x.folder); }
function findFolder(list, id) { return id ? list.find((x) => isFolder(x) && x.folder === String(id)) || null : null; }
// url 은 폴더 안까지 합쳐 한 목록에 하나만 둔다. 별표가 url 하나로 추가·삭제를 정하기 때문이다.
function findBm(list, url) {
  if (!url) return null;
  const top = list.findIndex((x) => !isFolder(x) && x.url === url);
  if (top >= 0) return { arr: list, i: top };
  for (const f of list) {
    if (!isFolder(f)) continue;
    const i = f.items.findIndex((x) => x.url === url);
    if (i >= 0) return { arr: f.items, i };
  }
  return null;
}

function ensureHistory(sp) {
  if (!sp) return null;
  if (!Array.isArray(state.urlHistoryBySpace[sp])) state.urlHistoryBySpace[sp] = [];
  return state.urlHistoryBySpace[sp];
}

function profileIdFromMutation(value) {
  if (value == null || value === "" || value === "기본") return "";
  const id = String(value);
  return PROFILE_ID_RE.test(id) ? id : null;
}

// mutation 적용. 반환: 실제로 상태가 바뀌었으면 true(→ caller가 broadcast).
export function mutate(m) {
  if (!m || typeof m.op !== "string") return false;
  const sp = m.space;
  switch (m.op) {
    // 북마크 조작은 scope 로 목록을 고른다. "common" 이면 공통 목록, 없으면 그 스페이스의 세션 목록이다.
    case "bookmark.add": {
      const bm = bmList(m.scope, sp); if (!bm || !m.url) return false;
      if (findBm(bm, m.url)) return false;
      const f = findFolder(bm, m.folder); if (m.folder && !f) return false;
      (f ? f.items : bm).push({ url: String(m.url), title: String(m.title || m.url).slice(0, 60) });
      break;
    }
    case "bookmark.remove": {
      const bm = bmList(m.scope, sp); if (!bm) return false;
      const at = findBm(bm, m.url); if (!at) return false;
      at.arr.splice(at.i, 1);
      break;
    }
    case "bookmark.edit": {
      const bm = bmList(m.scope, sp); if (!bm || !m.url) return false;
      const at = findBm(bm, m.url); if (!at) return false;
      const b = at.arr[at.i];
      let changed = false;
      if (m.newUrl != null && String(m.newUrl) && b.url !== String(m.newUrl)) {
        if (findBm(bm, String(m.newUrl))) return false; // 중복 URL 금지
        b.url = String(m.newUrl); changed = true;
      }
      if (m.title != null) { const t = String(m.title).slice(0, 60); if (b.title !== t) { b.title = t; changed = true; } }
      if (!changed) return false;
      break;
    }
    case "tab.open": {
      const tabs = ensureSpace(sp); if (!tabs || !m.id) return false;
      if (tabs.some((t) => t.id === m.id)) return false;
      // 계정을 지정하지 않은 새 탭은 여는 시점의 스페이스 기본을 상속해 기록한다. null로 남기면
      // 나중에 기본이 바뀔 때 이 탭이 다른 세션으로 옮겨 간다. 위 이관과 같은 이유다.
      let profile = resolveSpaceDefault(sp);
      if (Object.prototype.hasOwnProperty.call(m, "profile")) {
        profile = profileIdFromMutation(m.profile); if (profile == null) return false;
      }
      // ai: 세션(에이전트)이 작업용으로 연 탭. 이 표시가 붙은 탭은 창이 보고 있지 않은
      // 스페이스여도 렌더러가 즉시 webview를 만든다. 그래야 병렬 작업 중에도 계속 조작할 수 있다.
      const tab = { id: String(m.id), url: String(m.url || ""), title: String(m.title || ""), profile };
      if (m.ai) tab.ai = true;
      // 문서 탭(docx/sheet)은 webview가 없다. 이 스페이스의 브라우저가 있는 창이 자체 에디터로
      // 렌더링하며, PDF/HTML처럼 그 자리에 표시된다. url은 비워 둔다.
      if (m.kind === "docx" || m.kind === "sheet") { tab.kind = m.kind; if (m.path) tab.path = String(m.path); }
      // 세션이 여는 탭은 그 세션의 그룹 안에서 생성한다. 이후 tab.group으로 옮기면 잠시 그룹 밖에
      // 있는 구간이 생기고, 그 사이 렌더러가 그룹 없는 탭으로 그린다.
      if (m.group && (ensureGroups(sp) || []).some((g) => g.id === String(m.group))) tab.group = String(m.group);
      tabs.push(tab);
      // background: 사용자가 보고 있는 탭을 빼앗지 않는다(에이전트가 연 탭·게스트의 백그라운드 링크).
      if (!m.background) state.activeBySpace[sp] = m.id;
      break;
    }
    // 순서는 사용자가 정한다. 드래그로 옮긴 위치를 서버가 저장해야 창을 다시 열어도 유지된다.
    // 인덱스 대신 "어느 탭 앞"으로 지정한다. 그 사이 다른 탭이 열리고 닫혀도 의도가 안 어긋난다.
    case "tab.move": {
      const tabs = ensureSpace(sp); if (!tabs || !m.id) return false;
      const from = tabs.findIndex((t) => t.id === m.id); if (from < 0) return false;
      const [moved] = tabs.splice(from, 1);
      const before = m.before ? tabs.findIndex((t) => t.id === m.before) : -1;
      if (before < 0) tabs.push(moved); else tabs.splice(before, 0, moved);
      if (tabs.findIndex((t) => t.id === m.id) === from && before < 0) return false; // 제자리
      break;
    }
    // 옮길 것은 url(북마크) 또는 folder(폴더)다. 갈 곳은 toScope 목록(없으면 같은 목록)의 맨 위 단계에서
    // before(url)·beforeFolder 앞이고, 둘 다 없으면 맨 끝이다. into 가 있으면 그 폴더의 끝으로 들어간다.
    case "bookmark.move": {
      const src = bmList(m.scope, sp); if (!src) return false;
      const dst = Object.prototype.hasOwnProperty.call(m, "toScope") ? bmList(m.toScope, sp) : src;
      if (!dst) return false;
      const snap = JSON.stringify([src, dst]);
      let from = null;
      if (m.folder) { const i = src.findIndex((x) => isFolder(x) && x.folder === String(m.folder)); if (i >= 0) from = { arr: src, i }; }
      else from = findBm(src, m.url);
      if (!from) return false;
      const moved = from.arr[from.i];
      // 다른 목록으로 옮길 때 그쪽에 같은 주소나 같은 폴더가 있으면 거절한다. 합치면 한쪽 제목이 사라진다.
      if (dst !== src && ((isFolder(moved) ? moved.items.map((x) => x.url) : [moved.url]).some((u) => findBm(dst, u))
        || (isFolder(moved) && findFolder(dst, moved.folder)))) return false;
      const into = m.into ? findFolder(dst, m.into) : null;
      if (m.into && (!into || isFolder(moved))) return false; // 폴더 안에 폴더는 두지 않는다
      from.arr.splice(from.i, 1);
      if (into) into.items.push(moved);
      else {
        const before = m.beforeFolder ? dst.findIndex((x) => isFolder(x) && x.folder === String(m.beforeFolder))
          : m.before ? dst.findIndex((x) => !isFolder(x) && x.url === m.before) : -1;
        if (before < 0) dst.push(moved); else dst.splice(before, 0, moved);
      }
      if (JSON.stringify([src, dst]) === snap) return false;
      break;
    }
    case "bookmark.folder.add": {
      const bm = bmList(m.scope, sp); if (!bm || !m.folder) return false;
      const id = String(m.folder).slice(0, 40); if (findFolder(bm, id)) return false;
      bm.push({ folder: id, title: String(m.title || "새 폴더").slice(0, 60).trim() || "새 폴더", items: [] });
      break;
    }
    case "bookmark.folder.rename": {
      const bm = bmList(m.scope, sp); if (!bm) return false;
      const f = findFolder(bm, m.folder); if (!f) return false;
      const t = String(m.title || "").slice(0, 60).trim(); if (!t || f.title === t) return false;
      f.title = t;
      break;
    }
    // 폴더만 없애고 안의 북마크는 폴더가 있던 자리에 꺼내 둔다. 폴더 삭제로 북마크를 잃지 않게 한다.
    case "bookmark.folder.remove": {
      const bm = bmList(m.scope, sp); if (!bm) return false;
      const i = bm.findIndex((x) => isFolder(x) && x.folder === String(m.folder)); if (i < 0) return false;
      const [f] = bm.splice(i, 1);
      bm.splice(i, 0, ...f.items);
      break;
    }
    case "tab.profile": {
      const tabs = ensureSpace(sp); if (!tabs || !m.id) return false;
      const t = tabs.find((x) => x.id === m.id); if (!t) return false;
      const p = profileIdFromMutation(m.profile); if (p == null) return false;
      if (t.profile === p) return false;
      t.profile = p;
      break;
    }
    case "tab.rename": {
      const tabs = ensureSpace(sp); if (!tabs || !m.id) return false;
      const t = tabs.find((x) => x.id === m.id); if (!t) return false;
      const nm = (m.name == null ? "" : String(m.name)).slice(0, 60).trim();
      if ((t.name || "") === nm) return false;
      if (nm) t.name = nm; else delete t.name; // 빈 이름 = 커스텀 해제(자동 제목 복귀)
      break;
    }
    case "tab.close": {
      const tabs = ensureSpace(sp); if (!tabs || !m.id) return false;
      const idx = tabs.findIndex((t) => t.id === m.id);
      if (idx < 0) return false;
      tabs.splice(idx, 1);
      if (state.activeBySpace[sp] === m.id) state.activeBySpace[sp] = tabs.length ? tabs[tabs.length - 1].id : null;
      break;
    }
    case "tab.switch": {
      const tabs = ensureSpace(sp); if (!tabs || !m.id) return false;
      if (!tabs.some((t) => t.id === m.id)) return false;
      if (state.activeBySpace[sp] === m.id) return false;
      state.activeBySpace[sp] = m.id;
      break;
    }
    case "tab.navigate": {
      const tabs = ensureSpace(sp); if (!tabs || !m.id) return false;
      const t = tabs.find((x) => x.id === m.id); if (!t) return false;
      let changed = false; // 무변경이면 false → 브로드캐스트 churn 방지(에코 루프 억제)
      if (m.url != null && t.url !== String(m.url)) { t.url = String(m.url); changed = true; }
      if (m.title != null) { const tt = String(m.title).slice(0, 120); if (t.title !== tt) { t.title = tt; changed = true; } }
      if (!changed) return false;
      break;
    }
    // ── 탭 그룹(폴더) ──────────────────────────────────────────────
    // 그룹은 스페이스별이다(탭이 스페이스별이므로). 저장된 그룹만 전역이라 어느 창에서든 연다.
    case "group.create": {
      const gs = ensureGroups(sp); if (!gs || !m.id) return false;
      if (gs.some((g) => g.id === m.id)) return false;
      gs.push({ id: String(m.id), name: String(m.name || "새 그룹").slice(0, 40), collapsed: false });
      break;
    }
    case "group.rename": {
      const gs = ensureGroups(sp); if (!gs || !m.id) return false;
      const g = gs.find((x) => x.id === m.id); if (!g) return false;
      const nm = String(m.name || "").slice(0, 40).trim(); if (!nm || g.name === nm) return false;
      g.name = nm;
      break;
    }
    case "group.collapse": {
      const gs = ensureGroups(sp); if (!gs || !m.id) return false;
      const g = gs.find((x) => x.id === m.id); if (!g) return false;
      const c = !!m.collapsed; if (g.collapsed === c) return false;
      g.collapsed = c;
      break;
    }
    case "group.remove": { // 그룹만 해제하고 탭은 닫지 않는다
      const gs = ensureGroups(sp); if (!gs || !m.id) return false;
      const before = gs.length;
      state.groupsBySpace[sp] = gs.filter((g) => g.id !== m.id);
      if (state.groupsBySpace[sp].length === before) return false;
      for (const tb of ensureSpace(sp) || []) if (tb.group === m.id) delete tb.group;
      break;
    }
    case "tab.group": { // 탭의 그룹 소속 지정(null이면 그룹 밖으로)
      const tabs = ensureSpace(sp); if (!tabs || !m.id) return false;
      const tb = tabs.find((x) => x.id === m.id); if (!tb) return false;
      const g = m.group == null || m.group === "" ? null : String(m.group);
      if (g && !(ensureGroups(sp) || []).some((x) => x.id === g)) return false;
      if ((tb.group || null) === g) return false;
      if (g) tb.group = g; else delete tb.group;
      break;
    }
    case "group.save": { // 실행 중인 그룹을 저장된 그룹 스냅샷으로 만든다
      const gs = ensureGroups(sp); if (!gs || !m.id || !m.savedId) return false;
      const g = gs.find((x) => x.id === m.id); if (!g) return false;
      const tabs = (ensureSpace(sp) || []).filter((x) => x.group === m.id)
        .map((x) => ({ url: x.url || "", title: x.title || "", name: x.name || "", profile: x.profile ?? null }));
      if (!tabs.length) return false;
      state.savedGroups = state.savedGroups.filter((s) => s.name !== g.name); // 같은 이름은 갱신
      state.savedGroups.push({ id: String(m.savedId), name: g.name, savedAt: m.at || null, tabs });
      break;
    }
    case "saved.remove": {
      const before = state.savedGroups.length;
      state.savedGroups = state.savedGroups.filter((s) => s.id !== m.id);
      if (state.savedGroups.length === before) return false;
      break;
    }
    case "saved.rename": {
      const s = state.savedGroups.find((x) => x.id === m.id); if (!s) return false;
      const nm = String(m.name || "").slice(0, 40).trim(); if (!nm || s.name === nm) return false;
      s.name = nm;
      break;
    }
    case "space.active": {
      // 레거시 북마크가 activeSpace 미상일 때 __legacy__ 버킷에 보관됐다면, 사용자가 처음 방문한 실제
      // 스페이스(북마크 없는 곳)로 옮겨 UI에서 접근 가능하게 한다(리뷰 지적: __legacy__ 접근 불가).
      let migrated = false;
      const legacy = state.bookmarksBySpace && state.bookmarksBySpace.__legacy__;
      // 원격 창의 전환은 열람이라 북마크 소속을 정하지 않는다(원격 전환이면 서버 핸들러가 skipLegacyMigrate 를 붙인다).
      if (m.space && !m.skipLegacyMigrate && Array.isArray(legacy) && legacy.length && !(state.bookmarksBySpace[m.space] && state.bookmarksBySpace[m.space].length)) {
        state.bookmarksBySpace[m.space] = legacy.slice();
        delete state.bookmarksBySpace.__legacy__;
        migrated = true;
      }
      if (state.activeSpace === m.space) { if (migrated) { persist(); return true; } return false; }
      state.activeSpace = m.space || null;
      break;
    }
    // ── 계정(로그인 칸) ────────────────────────────────────────────
    // 목록은 전체를 받는다. 창이 이미 전체 저장 모델이고, 추가·이름변경·삭제가 한 연산으로
    // 끝나 두 창 사이에서 순서가 엇갈릴 여지가 없다. 다만 빈 목록은 받지 않는다: 창이 아직
    // 서버 상태를 받기 전에 보내는 부팅 정규화가 사용자가 쌓아둔 계정을 통째로 지울 수 있다.
    // 마지막 하나를 지우는 것은 profile.remove가 맡는다(의도가 분명한 연산).
    // 하나씩 더하고 고치는 연산이 기본이다. 목록 통째 저장은 창이 둘일 때 서로의 변경을 지운다:
    // 두 창이 [A]를 보고 있다가 한쪽이 B를 더해 [A,B]를, 다른 쪽이 A의 이름만 바꿔 [A']를 보내면
    // 나중 것이 B를 지운다. 통째 저장은 옛 localStorage를 한 번 올리는 자리에만 남긴다.
    case "profile.add": {
      const id = String(m.id || ""), name = String(m.name || "").trim();
      if (!id || !PROFILE_ID_RE.test(id) || !name || name === "기본") return false;
      if (state.profiles.some((p) => p.id === id || p.name === name)) return false;
      state.profiles.push({ id, name });
      break;
    }
    case "profile.rename": {
      const id = String(m.id || ""), name = String(m.name || "").trim();
      if (!id || !name) return false;
      const p = state.profiles.find((x) => x.id === id); if (!p || p.name === name) return false;
      if (state.profiles.some((x) => x.id !== id && x.name === name)) return false;   // 같은 이름 둘 금지
      p.name = name;
      break;
    }
    // 이전 localStorage를 서버로 올리는 1회 이관 전용이다. 이미 목록이 있으면 받지 않는다.
    // 서버가 비었다는 사실만으로는 이관 전인지 사용자가 모두 지운 뒤인지 구별할 수 없으므로, 표시를 함께 남겨
    // 지운 계정이 다음 실행에서 되살아나지 않게 한다.
    case "profiles.set": {
      if (state.profilesImported || state.profiles.length) return false;
      if (!Array.isArray(m.profiles) || !m.profiles.length) return false;
      const seenId = new Set(), seenName = new Set(), next = [];
      for (const p of m.profiles) {
        const id = String((p && p.id) || ""), name = String((p && p.name) || "").trim();
        if (!id || !PROFILE_ID_RE.test(id) || !name) continue;
        if (seenId.has(id) || seenName.has(name)) continue;
        seenId.add(id); seenName.add(name); next.push({ id, name });
      }
      if (!next.length) return false;
      state.profiles = next;
      state.profilesImported = true;
      break;
    }
    case "profile.remove": {
      const id = String(m.id || ""); if (!id) return false;
      const before = state.profiles.length;
      state.profiles = state.profiles.filter((p) => p.id !== id);
      if (state.profiles.length === before) return false;
      state.profilesImported = true;   // 삭제한 항목이 다음 실행에서 이전 저장분으로 복구되지 않게 한다
      delete state.profileSources[id];
      // 이 칸을 기본으로 쓰던 스페이스는 기본 세션으로 되돌린다. 없는 칸을 가리키면 그 스페이스의
      // 새 탭이 어느 계정으로 열릴지 정해지지 않는다.
      for (const [sp, pid] of Object.entries(state.defaultProfileBySpace)) if (pid === id) delete state.defaultProfileBySpace[sp];
      break;
    }
    case "profile.source": {
      const id = profileIdFromMutation(m.id); if (id == null || !id) return false;
      const cid = m.cid == null ? null : String(m.cid);
      if (cid === null) { if (!(id in state.profileSources)) return false; delete state.profileSources[id]; break; }
      if (state.profileSources[id] === cid) return false;
      state.profileSources[id] = cid;
      break;
    }
    case "space.defaultProfile": {
      if (!sp) return false;
      const id = profileIdFromMutation(m.profile); if (id == null) return false;
      const cur = state.defaultProfileBySpace[sp] || "";
      if (cur === id) return false;
      if (!id) delete state.defaultProfileBySpace[sp]; else state.defaultProfileBySpace[sp] = id;
      break;
    }
    // ── 주소창 기록 ────────────────────────────────────────────────
    case "history.push": {
      const h = ensureHistory(sp); if (!h) return false;
      const url = String(m.url || ""); if (!url || url === "about:blank") return false;
      if (h[0] === url) return false;
      state.urlHistoryBySpace[sp] = [url, ...h.filter((x) => x !== url)].slice(0, URL_HISTORY_MAX);
      break;
    }
    case "history.remove": {
      const h = ensureHistory(sp); if (!h) return false;
      const before = h.length;
      state.urlHistoryBySpace[sp] = h.filter((x) => x !== m.url);
      if (state.urlHistoryBySpace[sp].length === before) return false;
      break;
    }
    case "dock": {
      const v = !!m.docked;
      if (state.docked === v) return false;
      state.docked = v;
      break;
    }
    default: return false;
  }
  persist();
  return true;
}
