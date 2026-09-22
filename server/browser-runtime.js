import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import * as appPick from "./app-pick.js";
import {
  registerSpaceStateParticipant,
  keyOf as spKey,
  tabs as spTabs,
  groups as spGroups,
  storageSpaceOfTab,
  hasStoredTab,
  mutate as bsMutate,
  wire as bsWire,
} from "./browser-state-owner.js";
import { snapshot } from "./runtime-state.js";
import * as spaceKey from "./space-key.js";
import { stateHome } from "./state-home.cjs";

// 브라우저 실행기·탭 registry/handle·grant/target·profile/dialog·control 상태의 단일 소유자.
//
// 소유 범위
//   교체되는 CDP 실행기·profile·wire cache와 tab/wc registry, handle/grant 저장 상태,
//   pane target·pick mode·control lease·dialog ask/plan 및 그 timer.
//
// 제공 API
//   init과 registry/handle/grant/target/executor/profile/dialog의 accessor·mutation API,
//   handle/grant 지연 쓰기를 함께 끝내는 flushNow port. 원시 Map·array·object는 export하지 않는다.
//
// 의존 대상
//   runtime-state snapshot과 browser-state-owner의 read/mutate/register port, space-key/state-home,
//   app-pick primitive에 의존하며 broadcast·Herdr·console relay는 init에서 주입받는다.
//
// 유지 조건
//   wc는 즉시 실행용 핸들일 뿐 지속 정체성이 아니고, grant는 인증된 사용자 지정만 확장한다.
//   다른 프로세스의 CDP 실행기는 거절하되 같은 프로세스 재연결은 받아들이고 순서·조건·타이밍을 보존한다.
//
// 영향 범위
//   server/index.js의 browser command/HTTP dialog/WS inbound·초기 snapshot·recompute·shutdown 연결,
//   browser-state-owner의 participant migration, runtime-state workspace projection, app-pick lifecycle,
//   popup-tab-access/tab-profile-pinning/login-session-ownership/run-state-isolation/shutdown-flush와 smoke 소유 검사.

import { createDialogs } from "./browser/dialogs.js";

import { createTabHandles } from "./browser/tab-handles.js";

const IRIS_HOME = stateHome();

let broadcast;
let getHerdr;
let relayToOneConsole;
let uiToken;

export function initBrowserRuntime(deps) {
  broadcast = deps.broadcast;
  getHerdr = deps.getHerdr;
  relayToOneConsole = deps.relayToOneConsole;

  loadTabHandles();
  loadGroupHandles();
  uiToken = loadUiToken();
  loadGrants();
  registerSpaceStateParticipant("browser-runtime", spaceStateParticipant);
}

// AI→브라우저 CDP 제어: main이 붙인 실행기 WS + 렌더러가 보고한 활성 브라우저 webContentsId + 대기 요청.
// activeTabBySpace: 스페이스별 활성 브라우저 탭(정체성). 그 탭이 화면에 보이는지 판정할 때만
// 쓴다. 대상 선택은 세션 그룹이 하고 활성 탭을 따라가지 않는다.
let cdpExecutorWs = null, cdpSeq = 0;
let cdpExecutor = null;   // 현재 연결된 실행기 정보(앱 경로·pid). 중복 등록 거절과 진단에 쓴다
const activeTabBySpace = new Map();
const cdpPending = new Map();

function cdpExecutorReady() {
  return !!(cdpExecutorWs && cdpExecutorWs.readyState === 1);
}

function requestCdp(cmd, args, wc, timeoutMs) {
  return new Promise((resolve) => {
    if (!cdpExecutorReady() || !wc) { resolve({ ok: false, error: "실행기 없음" }); return; }
    const id = "cdp" + (++cdpSeq);
    const timer = setTimeout(() => { cdpPending.delete(id); resolve({ ok: false, error: `timeout(${timeoutMs / 1000}s)` }); }, timeoutMs);
    cdpPending.set(id, { resolve, timer });
    try { cdpExecutorWs.send(JSON.stringify({ type: "cdp-exec", id, cmd, args: args || {}, wc })); }
    catch (e) { clearTimeout(timer); cdpPending.delete(id); resolve({ ok: false, error: String(e.message || e) }); }
  });
}

function registerCdpExecutor(ws, msg) {
  // 실행기 자리는 하나다. 나중에 연결한 쪽이 그 자리를 가져가면 개발용 인스턴스와 설치된 앱이
  // 함께 떠 있을 때 명령이 어느 쪽으로 갔는지 알 수 없다(확인 결과: 설치된 앱에 있는 명령이
  // 알 수 없는 명령으로 반환됐다). 연결된 실행기가 있으면 새로 온 쪽을 거절하고,
  // 거절된 쪽은 자기 포트로 실행하게 한다.
  if (cdpExecutorWs && cdpExecutorWs !== ws && cdpExecutorWs.readyState === 1
      && cdpExecutor && Number(msg.pid) && cdpExecutor.pid !== Number(msg.pid)) {
    // 막으려는 것은 서로 다른 앱이 한 자리를 두고 경합하는 경우이지 재접속이 아니다. 같은
    // 프로세스가 소켓을 새로 연 것을 거절하면 앱이 실행 중인데도 아무 명령이 동작하지 않는
    // 상태가 된다.
    const mine = { app: String(msg.app || "?"), pid: Number(msg.pid) || 0 };
    try { ws.send(JSON.stringify({ type: "cdp-executor-refused",
      holder: cdpExecutor || null, newcomer: mine,
      why: "이 포트에는 이미 다른 앱이 실행기로 붙어 있습니다. 개발 인스턴스는 자기 포트로 도세요(IRIS_PORT).",
    })); } catch {}
    console.warn(`[cdp] 실행기 중복 등록 거절 — 이미 ${(cdpExecutor && cdpExecutor.app) || "?"}`
      + `(pid ${(cdpExecutor && cdpExecutor.pid) || "?"})가 붙어 있고 ${mine.app}(pid ${mine.pid})가 또 왔다`);
    return false;
  }
  cdpExecutorWs = ws;
  cdpExecutor = { app: String(msg.app || "?"), pid: Number(msg.pid) || 0, at: Date.now() };
  console.log(`[cdp] 실행기 등록 — ${cdpExecutor.app} (pid ${cdpExecutor.pid})`);
  return true;
}

function resolveCdpResult(ws, msg) {
  if (ws !== cdpExecutorWs) return false;
  const pending = cdpPending.get(msg.id);
  if (!pending) return false;
  clearTimeout(pending.timer);
  cdpPending.delete(msg.id);
  pending.resolve(msg.ok ? { ok: true, data: msg.data } : { ok: false, error: msg.error });
  return true;
}

function disconnectCdpExecutor(ws) {
  if (ws !== cdpExecutorWs) return false;
  cdpExecutorWs = null;
  cdpExecutor = null;
  tabReg.clear();
  tabIdByWc.clear();
  activeTabBySpace.clear();
  if (pickModeOn) setPickModeState(false);
  // 실행기가 사라지면 그쪽으로 보낸 명령은 응답이 오지 않는다. 그대로 두면 각각 30초 타임아웃까지
  // 대기해 앱을 재시작한 뒤에도 한동안 응답이 없는 것처럼 보인다. 즉시 사유를 붙여 종료한다.
  for (const [id, pending] of cdpPending) {
    clearTimeout(pending.timer);
    pending.resolve({ ok: false, error: "브라우저 제어기(앱) 연결이 끊겼습니다 — 앱이 다시 뜨면 재시도하세요.", sent: true });
    cdpPending.delete(id);
  }
  return true;
}
// 세션(pane)별 제어 타깃 고정. herdr가 모든 pane에 HERDR_PANE_ID를 주입하므로 iris-browser/MCP가
// 자기 pane을 공짜로 식별한다. 고정이 있으면 그 탭, 없으면 기존 동작(활성 스페이스의 활성 탭)으로
// 폴백한다. 고정을 쓰지 않는 세션은 기존과 동일하게 동작한다.
// paneId → tabId[] (탭 정체성이라 webview가 다시 만들어져도 유지된다). 여러 개를 지정할 수 있다.
// 탭을 그룹으로 묶는 이유가 여럿을 함께 다루기 위해서인데, 고정이 하나뿐이면 나머지는
// 매번 핸들을 지정해야 한다. 상한 4.
const MAX_PINS = 4;
const pinnedTabsByPane = new Map();
const pinsOf = (pane) => pinnedTabsByPane.get(String(pane)) || [];
// 지정 없는 명령이 갈 곳. 마지막으로 쓴 것이 아직 고정돼 있으면 그것, 아니면 가장 최근에 고정한 것.
// 여러 개를 지정 중이어도 지정 없는 명령을 전부에 실행하지 않는다. 클릭 하나가 네 탭에 나가면 안 된다.
function primaryPin(pane) {
  const ids = pinsOf(pane); if (!ids.length) return null;
  const last = lastTabByPane.get(String(pane));
  return last && ids.includes(last) ? last : ids[ids.length - 1];
}
function addPin(pane, tabId) {
  const key = String(pane);
  const ids = pinsOf(key).filter((x) => x !== tabId);
  ids.push(tabId);
  while (ids.length > MAX_PINS) ids.shift();   // 상한을 넘으면 가장 먼저 고정한 것부터 해제한다
  pinnedTabsByPane.set(key, ids);
  return ids;
}
function dropPin(pane, tabId) {
  const key = String(pane);
  if (tabId == null) { const had = pinsOf(key); pinnedTabsByPane.delete(key); return had; }
  const ids = pinsOf(key).filter((x) => x !== tabId);
  if (ids.length) pinnedTabsByPane.set(key, ids); else pinnedTabsByPane.delete(key);
  return pinsOf(key);
}
function wcOfTabId(tabId) { const m = tabId ? tabReg.get(tabId) : null; return m && m.wc != null ? m.wc : null; }
// 실행 중인 브라우저 탭 레지스트리. 키는 탭 정체성(tabId)이다. wc(Electron webContents id)는 서버가
// 정하는 값이 아니라 그 순간의 webContents 객체에 붙는 번호라, 같은 탭이라도 도킹 전환·프로필 변경·앱
// 재시작 때마다 새 번호를 받는다. 그래서 wc는 필드로만 두고(명령을 보낼 때 그 자리에서 쓰는
// 핸들), 대상은 항상 tabId로 지정한다. 재발급되는 숫자 대신 고유 식별자를 쓴다.
// 탭이 닫히면 그때 기록을 지운다.
const tabReg = new Map();        // tabId → { wc, space, url, title, win, dialog, ownerSpace, ownerGroup, openerTabId }

// 공유 창은 스페이스에 속하지 않는다. 사용자가 앱에서 직접 그 탭을 지목했을 때만 그 세션에 열어준다.
const SHARED_SPACE = "__shared__";

// 핸들은 server/browser/tab-handles.js 가 소유한다. 발급 규칙과 디스크 형식이 바뀌는
// 이유는 탭 레지스트리가 바뀌는 이유와 다르다.
const handles = createTabHandles({ tabReg, SHARED_SPACE });
const { newHandleHash, loadTabHandles, writeHandlesNow, persistHandles, flushHandlesNow,
  spaceSlug, tabSpaceOf, renderHandle, handleFor, loadGroupHandles, groupHandleFor } = handles;
// 대상 해석(tabIdOfRef)과 스페이스 이관은 핸들 레지스트리를 직접 조회한다. 여기서 다시
// 만들지 않고 소유자의 것을 그대로 읽는다. 사본이 생기면 한쪽만 갱신될 수 있다.
const { handleRec, legacyHandle, groupRec, HANDLE_PATH } = handles;
// 에이전트가 준 대상 지정을 탭 정체성으로 해석한다. 새 형식이 정식이고 이전 `t83`도 그대로 받는다.
// 숫자만 있는 wc는 이전 호출 호환을 위해 받는다. 현재 유효한 wc일 때만 해석되고,
// 앱이 재시작하면 같은 숫자가 다른 탭을 가리키므로 저장하지 않는다.
function tabIdOfRef(ref) {
  if (ref == null) return null;
  const s = String(ref).trim().replace(/^@/, "").toLowerCase();
  // 정체성은 끝에 붙은 난수(h)다. 앞의 스페이스 이름은 읽기 위한 부분이라 판정에 쓰지
  // 않는다. 이름이 바뀌거나 다른 스페이스와 겹쳐도 같은 값으로 해석되고, 난수만 지정해도 된다.
  const mh = s.match(/^(?:.*-)?(?:tab|group)-([a-z][0-9a-f]{5})$/) || s.match(/^([a-z][0-9a-f]{5})$/);
  if (mh) {
    const h = mh[1];
    for (const [tabId, r] of handleRec) if (r.h === h) return tabId;
    return null;
  }
  // 이전 번호 형식(`<스페이스>-tab-3`)도 계속 받는다. 그 규칙은 스페이스마다 1부터 매기는 방식이라
  // 스페이스 이름까지 맞을 때만 풀고, 그 이름이 둘 이상을 가리키면 아무것도 고르지 않는다.
  const m = s.match(/^(.*)-(tab|group)-(\d+)$/) || s.match(/^(tab|group)-(\d+)$/);
  if (m) {
    const kind = m.length === 4 ? m[2] : m[1], n = Number(m.length === 4 ? m[3] : m[2]);
    const slug = m.length === 4 ? m[1] : null;
    let exact = null, exactN = 0, aliased = [], loose = [];
    for (const [tabId, r] of handleRec) {
      if (r.kind !== kind || r.n !== n) continue;
      if (slug && spaceSlug(r.space) === slug) { exact = tabId; exactN++; }
      else if (slug && Array.isArray(r.slugs) && r.slugs.includes(slug)) aliased.push(tabId);
      loose.push(tabId);
    }
    if (exactN > 1) return null;
    return exact || (aliased.length === 1 ? aliased[0] : null) || (!slug && loose.length === 1 ? loose[0] : null);
  }
  // 목록이 반환한 정체성(tabId)도 그대로 받는다. 목록의 값을 그대로 쓸 수 없으면 안 된다.
  if (tabReg.has(String(ref))) return String(ref);
  if (/^t\d+$/.test(s)) return legacyHandle.get(s) || null;
  // 숫자만 있는 wc로는 지정할 수 없다. wc는 서버가 정하는 값이 아니라 그 순간의 webContents에 붙는
  // 번호이고 재발급된다. 받아들이면 이전 매핑이 남은 순간 다른 탭이 조작된다(확인 결과: 재시작 뒤
  // 11번으로 지정했더니 다른 탭이 이동했다). 탭은 생성부터 종료까지 tabId 하나로만 지정한다.
  return null;
}
const tabIdByWc = new Map();     // wc → tabId. 렌더러·앱이 wc로 보고해 오는 순간에만 쓰는 역인덱스
function regTab(tabId, meta) {
  const prev = tabReg.get(tabId);
  if (prev && prev.wc != null && prev.wc !== meta.wc) tabIdByWc.delete(prev.wc);
  tabReg.set(tabId, { ...(prev || {}), ...meta });
  if (meta.wc != null) tabIdByWc.set(meta.wc, tabId);
}
function unregTab(tabId) {
  const m = tabReg.get(tabId);
  if (m && m.wc != null) tabIdByWc.delete(m.wc);
  tabReg.delete(tabId);
}
function unregWc(wc) { const id = tabIdByWc.get(Number(wc)); if (id) unregTab(id); else tabIdByWc.delete(Number(wc)); }
function tabIdOfWc(wc) { return tabIdByWc.get(Number(wc)) || null; }
function metaOfWc(wc) { const id = tabIdOfWc(wc); return id ? tabReg.get(id) || null : null; }
function tabMeta(tabId) { return tabId ? tabReg.get(tabId) || null : null; }
function hasTab(tabId) { return tabReg.has(tabId); }
function tabCount() { return tabReg.size; }
function setActiveTab(space, tabId) { activeTabBySpace.set(space, tabId); }

const tabWcWaiters = new Map(); // tabId → [resolve] (렌더러가 webview를 만들고 wc를 보고할 때까지)
function waitForTabWc(tabId, ms) {
  const live = wcOfTabId(tabId);
  if (live) return Promise.resolve(live);
  return new Promise((resolve) => {
    const list = tabWcWaiters.get(tabId) || [];
    const timer = setTimeout(() => { resolve(null); }, ms);
    list.push((wc) => { clearTimeout(timer); resolve(wc); });
    tabWcWaiters.set(tabId, list);
  });
}
// 잠든 탭을 깨우도록 창에 알린다. 생성은 창이 한다. webview 는 렌더러 소유이고,
// 어느 창이 그 탭의 소유자인지도 도킹 상태에 따라 달라져 여기서 고르면 어긋난다. 서버는 알리고
// waitForTabWc 로 기다리기만 한다. 소유자가 없으면 그 대기는 시간 초과 후 null 로 끝난다.
function wakeSleepingTab(tabId) {
  if (!tabId) return false;
  broadcast({ type: "wake-tab", tabId: String(tabId) });
  return true;
}
function resolveTabWcWaiters(tabId, wc) {
  const waiters = tabId ? tabWcWaiters.get(tabId) : null;
  if (!waiters) return false;
  tabWcWaiters.delete(tabId);
  for (const resolve of waiters) { try { resolve(Number(wc)); } catch {} }
  return true;
}

let browserProfiles = [];
function setProfiles(profiles) {
  browserProfiles = profiles.filter((profile) => profile && profile.id != null)
    .map((profile) => ({ id: String(profile.id), name: String(profile.name || profile.id).slice(0, 60) })).slice(0, 50);
}
function profileRefToId(ref) {
  const value = String(ref == null ? "" : ref).trim(); if (!value) return null;
  const hit = browserProfiles.find((profile) => profile.id === value)
    || browserProfiles.find((profile) => profile.name.toLowerCase() === value.toLowerCase());
  return hit ? hit.id : null;
}
function profileNames() { return browserProfiles.map((profile) => profile.name); }
function hasProfiles() { return browserProfiles.length > 0; }
// 세션(herdr pane) → 스페이스. AI 제어를 자기 스페이스 안으로 제한한다. 고정이 없을 때 콘솔이 보고 있는
// 스페이스를 따라가면 다른 스페이스의 탭을 조작하게 된다(확인 결과: pane w3:pS에서 다른 스페이스 탭 16개가 보였다).
const spaceByPane = new Map();
const lastTabByPane = new Map(); // pane → tabId. 그룹 안에서 이 세션이 마지막으로 쓴 탭.
function sessionSpace(session) { return session ? spaceByPane.get(String(session)) || null : null; }
function replacePaneSpaces(agents) {
  spaceByPane.clear();
  for (const agent of agents) if (agent.pane_id && agent.workspace_id) spaceByPane.set(String(agent.pane_id), String(agent.workspace_id));
}
function getLastTab(pane) { return lastTabByPane.get(String(pane)) || null; }
// 사용자 지목(UI 픽)만 여기 들어온다. AI는 직접 넣을 수 없다. 키는 탭 정체성이다. 같은 지목을
// wc 집합으로도 보관하면 wc가 재발급될 때마다 옮겨야 하고, 한 번이라도 놓치면 지목이
// 사라진다. 그래서 정체성 한 벌만 둔다.
// 지목은 사용자가 앱에서 하는 동작이다. 루프백이면 앱이라는 판정으로는 앱과 임의의 로컬
// 프로세스를 구별할 수 없다. 확인 결과 임의 프로세스가 WS로 붙어 자신에게 임의의 탭을
// 지목하고 바로 조작할 수 있었다(AI가 스스로 권한을 넓히는 경로). 그래서 앱만 아는 토큰을 요구한다.
// 토큰은 파일(0600)에 있고 Electron main만 읽어 렌더러에 넘기므로 원격(폰) UI는 지목할 수 없다.
const UI_TOKEN_PATH = path.join(IRIS_HOME, "ui-token");
function loadUiToken() {
  try { const t = fs.readFileSync(UI_TOKEN_PATH, "utf8").trim(); if (t.length >= 32) return t; } catch {}
  const t = crypto.randomBytes(32).toString("hex");
  try { fs.mkdirSync(path.dirname(UI_TOKEN_PATH), { recursive: true }); fs.writeFileSync(UI_TOKEN_PATH, t, { mode: 0o600 }); } catch {}
  return t;
}
function uiTokenOk(v) {
  const a = Buffer.from(String(v || ""), "utf8"), b = Buffer.from(uiToken, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const userGrantTabs = new Map(); // pane → Set<tabId>
// 지목은 사용자가 내린 결정이므로 서버 재시작으로 사라지면 안 된다(확인 결과: 재시작 한 번에
// 지목이 사라져 명령이 세션 그룹 탭으로 돌아갔다). 정체성으로 된 것만 저장한다(wc는 저장하지 않는다).
const GRANT_PATH = path.join(IRIS_HOME, "grants.json");
let grantSaveTimer = null;
function writeGrantsNow() {
  grantSaveTimer = null;
  try {
    fs.mkdirSync(path.dirname(GRANT_PATH), { recursive: true });
    const out = { tabs: [], groups: [], adopted: [] };
    for (const [pane, s] of userGrantTabs) if (s.size) out.tabs.push([pane, [...s]]);
    for (const [pane, s] of groupGrants) if (s.size) out.groups.push([pane, [...s]]);
    for (const [pane, key] of adoptedGroup) out.adopted.push([pane, key]);
    for (const [pane, ids] of pinnedTabsByPane) for (const tabId of ids) out.pinned = (out.pinned || []).concat([[pane, tabId]]);
    // 마지막으로 쓴 탭도 저장한다. 고정과 같은 성질의 연속성이고, 없으면 서버 재시작 뒤
    // 지정 없는 명령이 같은 그룹의 다른 탭으로 옮겨간다(그룹에 탭이 둘 이상일 때).
    for (const [pane, tabId] of lastTabByPane) out.last = (out.last || []).concat([[pane, tabId]]);
    fs.writeFileSync(GRANT_PATH + ".tmp", JSON.stringify(out), { mode: 0o600 });
    fs.renameSync(GRANT_PATH + ".tmp", GRANT_PATH);
  } catch {}
}
function persistGrants() {
  clearTimeout(grantSaveTimer);
  grantSaveTimer = setTimeout(writeGrantsNow, 300);
}
// 지목·그룹 권한이 사라지면 AI가 받은 권한을 잃고 사용자가 다시 지목해야 한다.
function flushGrantsNow() {
  if (!grantSaveTimer) return false;
  clearTimeout(grantSaveTimer);
  writeGrantsNow();
  return true;
}
function grantTabIdsOf(session) { return userGrantTabs.get(String(session)) || null; }
// 닫은 탭을 복원할 값을 남긴다. 남기지 않으면 복원할 수 없다. 주소·프로필·그룹이 다음 줄에서
// 상태에서 지워지기 때문이다. 창마다 따로 관리하면 분리 창에서 닫은 탭을 콘솔에서 복원할 수
// 없으므로, 서버가 한 벌만 보관하고 모든 창에 같은 값을 보낸다.
const CLOSED_TAB_KEEP = 25;   // 복원 스택. 오래된 항목이 앞, 방금 닫은 항목이 뒤.
const CLOSED_HISTORY_MAX_ENTRIES = 512;
const CLOSED_HISTORY_MAX_URL = 32768;
const CLOSED_HISTORY_MAX_TITLE = 4096;
const CLOSED_HISTORY_MAX_PAGE_STATE = 4 * 1024 * 1024;
const CLOSED_HISTORY_MAX_TOTAL = 16 * 1024 * 1024;
const closedTabs = [];

// 렌더러가 보낸 값은 신뢰하지 않는다. pageState는 폼/스크롤 상태까지 담을 수 있어 메모리에만
// 두고, http(s) 이외 항목·자격증명이 박힌 URL·비정상 크기는 이 경계에서 버린다.
function normalizeClosedTabHistory(value) {
  if (!value || !Array.isArray(value.entries) || !value.entries.length
    || value.entries.length > CLOSED_HISTORY_MAX_ENTRIES) return null;
  const sourceIndex = Number(value.index);
  if (!Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= value.entries.length) return null;
  const entries = [];
  const sourceIndexes = [];
  let total = 0;
  for (let i = 0; i < value.entries.length; i++) {
    const source = value.entries[i];
    if (!source || typeof source !== "object" || typeof source.url !== "string"
      || !source.url || source.url.length > CLOSED_HISTORY_MAX_URL) continue;
    let parsed;
    try { parsed = new URL(source.url); } catch { continue; }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) continue;
    const title = typeof source.title === "string" ? source.title.slice(0, CLOSED_HISTORY_MAX_TITLE) : "";
    const entry = { url: parsed.href, title };
    if (source.pageState != null) {
      if (typeof source.pageState !== "string" || source.pageState.length > CLOSED_HISTORY_MAX_PAGE_STATE
        || source.pageState.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(source.pageState)) return null;
      entry.pageState = source.pageState;
    }
    total += entry.url.length + entry.title.length + (entry.pageState ? entry.pageState.length : 0);
    if (total > CLOSED_HISTORY_MAX_TOTAL) return null;
    entries.push(entry);
    sourceIndexes.push(i);
  }
  if (!entries.length) return null;
  let index = sourceIndexes.indexOf(sourceIndex);
  if (index < 0) {
    index = sourceIndexes.findLastIndex((candidate) => candidate < sourceIndex);
    if (index < 0) index = 0;
  }
  return { entries, index };
}

function recordClosedTab(tabId, rawHistory) {
  if (!tabId) return false;
  const sp = storageSpaceOfTab(tabId);
  if (!sp) return false;
  const tab = spTabs(sp).find((t) => t.id === tabId);
  if (!tab) return false;
  const navigationHistory = normalizeClosedTabHistory(rawHistory);
  // 빈 탭은 남기지 않는다. 복원할 내용이 없으면서 스택을 채워 실제로 복원할 항목을 밀어낸다.
  if (!tab.url && !tab.path && !navigationHistory) return false;
  const activeEntry = navigationHistory && navigationHistory.entries[navigationHistory.index];
  closedTabs.push({
    tabId, space: sp, url: (activeEntry && activeEntry.url) || tab.url || "",
    title: (activeEntry && activeEntry.title) || tab.title || "",
    profile: tab.profile == null ? null : tab.profile,
    group: tab.group || null, kind: tab.kind || null, path: tab.path || null,
    closedAt: Date.now(), navigationHistory,
  });
  while (closedTabs.length > CLOSED_TAB_KEEP) closedTabs.shift();
  return true;
}
function closedTabsWire() {
  // pageState는 UI 목록에 필요 없고 폼 상태를 포함할 수 있다. 일반/원격 방송에는 metadata만 싣는다.
  return { type: "closed-tabs", tabs: closedTabs.map(({ navigationHistory, ...entry }) => entry) };
}
// 복원하면 스택에서 뺀다. 빼지 않으면 같은 탭이 계속 나와 두 번 눌러도 이전 탭으로 가지 못한다.
function takeClosedTab(tabId) {
  const i = tabId ? closedTabs.findIndex((x) => x.tabId === String(tabId)) : closedTabs.length - 1;
  if (i < 0) return null;
  return closedTabs.splice(i, 1)[0];
}
function removeClosedTab(tabId) {
  for (const [pane, ids] of [...pinnedTabsByPane]) if (ids.includes(tabId)) dropPin(pane, tabId);
  unregTab(tabId);
  // 탭이 실제로 닫힌 경우이며 여기서만 지목을 회수한다. webview가 사라지는 것(앱 종료·도킹 전환)과는 다르다.
  for (const grants of userGrantTabs.values()) grants.delete(tabId);
  for (const [pane, current] of [...lastTabByPane]) if (current === tabId) { lastTabByPane.delete(pane); persistGrants(); }
  persistGrants();
}

function unregisterGoneTab(tabId, wc) {
  const popupClosed = tabId && tabReg.get(tabId)?.win === "popup";
  if (popupClosed) {
    for (const [pane, ids] of [...pinnedTabsByPane]) if (ids.includes(tabId)) dropPin(pane, tabId);
    for (const grants of userGrantTabs.values()) grants.delete(tabId);
    for (const [pane, current] of [...lastTabByPane]) if (current === tabId) lastTabByPane.delete(pane);
    persistGrants();
  }
  if (tabId) unregTab(tabId); else unregWc(wc);
  broadcastTabHandles();
  if (popupClosed) broadcastAiTargets();
  return !!popupClosed;
}
// 지목은 현재 대화에서 쓸 탭을 정하는 것이다. 한 채팅 안에서 여러 번 지목하면 그 전부가 대상이고,
// 다음 채팅에서 다시 지목하면 그때부터 새 대상이다. 그러지 않으면 지목이 계속 쌓인다.
// 채팅 경계는 창이 알려준다(사용자가 프롬프트를 제출한 순간). 요소 선택은 대상을 다시 정하는 행위가
// 아니므로 세트를 비우지 않고 이 채팅 몫으로 더하기만 한다. 그룹 권한은 어느 쪽도 건드리지 않는다.
const chatTabs = new Map();      // pane → Set<tabId>. 이번 채팅에서 연결된 탭(지목·선택 모두)
const designedThisChat = new Set(); // pane. 이번 채팅에 지목이 있었는지 여부
function noteChatTab(pane, tabId) {
  const key = String(pane);
  let s = chatTabs.get(key); if (!s) { s = new Set(); chatTabs.set(key, s); }
  s.add(tabId);
}
function designateTab(pane, tabId) {
  const key = String(pane);
  if (!designedThisChat.has(key)) {
    // 이번 채팅의 첫 지목이며 이전 채팅의 지목은 여기서 끝난다. 같은 채팅에서 고른 요소의 탭은 남긴다.
    userGrantTabs.set(key, new Set(chatTabs.get(key) || []));
    designedThisChat.add(key);
  }
  noteChatTab(key, tabId);
  grantTab(key, tabId);
}
// 그룹도 같은 규칙이다. 한 대화에서 여러 그룹을 지목하면 그 전부가 대상이고,
// 다음 대화의 첫 그룹 지목이 대상을 새로 정한다. 그러지 않으면 그룹 권한이 계속 쌓인다.
const chatGroups = new Map();       // pane → Set<"space\ngroupId">
const designedGroupsThisChat = new Set();
function designateGroup(pane, space, gid) {
  const key = String(pane), gk = String(space) + "\n" + String(gid);
  if (!designedGroupsThisChat.has(key)) {
    groupGrants.set(key, new Set(chatGroups.get(key) || []));
    designedGroupsThisChat.add(key);
  }
  let s = chatGroups.get(key); if (!s) { s = new Set(); chatGroups.set(key, s); }
  s.add(gk);
  grantGroup(key, space, gid);
}
function endChat(pane) {
  const key = String(pane);
  chatTabs.delete(key); designedThisChat.delete(key);
  chatGroups.delete(key); designedGroupsThisChat.delete(key);
}
function designatedHandles(pane) {
  const s = userGrantTabs.get(String(pane));
  return s ? [...s].filter((id) => tabReg.has(id)).map((id) => handleFor(id)) : [];
}
// 회수 경로가 없으면 지목이 계속 남는다. UI가 해제로 안내하는 동작이 실제로 회수해야 한다.
function revokeTab(pane, tabId) {
  const s = userGrantTabs.get(String(pane));
  if (s && s.delete(tabId)) { if (!s.size) userGrantTabs.delete(String(pane)); persistGrants(); return true; }
  return false;
}
function grantedByTabId(session, tabId) {
  const s = grantTabIdsOf(session);
  return !!(s && tabId && s.has(tabId));
}
// 그룹 단위 지목도 받는다. 탭을 하나씩 지정하는 방식은 그룹 단위 작업과 맞지 않는다.
const groupGrants = new Map(); // pane → Set<"space\ngroupId">
function groupGrantsOf(session) { return groupGrants.get(String(session)) || null; }
function grantTab(pane, tabId) {
  if (!tabId) return;
  const key = String(pane);
  let ts = userGrantTabs.get(key);
  if (!ts) { ts = new Set(); userGrantTabs.set(key, ts); }
  ts.add(tabId);   // 여러 탭을 차례로 지목하면 전부 쓸 수 있다(덮어쓰지 않는다)
  persistGrants();
}
function grantGroup(pane, space, gid) {
  const key = String(pane);
  let s = groupGrants.get(key);
  if (!s) { s = new Set(); groupGrants.set(key, s); }
  s.add(String(space) + "\n" + String(gid));
  persistGrants();
}
// 그룹 단위 지목은 접근 허용을 넘어 이 세션의 그룹 자체를 그 그룹으로 바꾼다. 지목 안내 문구가
// 지정 없이 이 그룹 안에서 실행된다고 알리는데, 세션 그룹이 자동 생성된 ai:<pane> 그룹으로
// 남아 있으면 지정 없는 명령이 지목한 그룹 밖으로 나간다(확인 결과:
// 지목=claude-group-9인데 tabs가 claude-group-7을 자기 그룹으로 보고).
const adoptedGroup = new Map(); // pane → "space\ngroupId"
function adoptedOf(session) {
  const v = adoptedGroup.get(String(session)); if (!v) return null;
  const i = v.indexOf("\n"); if (i < 0) return null;
  return { space: v.slice(0, i), gid: v.slice(i + 1) };
}
function adoptGroup(pane, space, gid) {
  adoptedGroup.set(String(pane), String(space) + "\n" + String(gid));
  persistGrants();
}
// 디스크에서 복원한다. 현재 없는 탭·그룹이 섞여 있어도 판정은 정체성으로 하므로 문제가 없고,
// 그 탭이 실제로 닫히면 tab.close 경로에서 걷힌다.
function loadGrants() {
  try {
    const g = JSON.parse(fs.readFileSync(GRANT_PATH, "utf8")) || {};
    for (const [pane, ids] of (g.tabs || [])) userGrantTabs.set(String(pane), new Set(ids));
    for (const [pane, keys] of (g.groups || [])) groupGrants.set(String(pane), new Set(keys));
    for (const [pane, tabId] of (g.pinned || [])) addPin(pane, tabId);
    for (const [pane, tabId] of (g.last || [])) lastTabByPane.set(String(pane), tabId);
    for (const [pane, key] of (g.adopted || [])) adoptedGroup.set(String(pane), key);
    // 채택 기록이 생기기 전에 저장된 지목분을 보정한다. Set은 삽입 순서를 유지하므로 배열의 마지막이
    // 가장 최근에 지목한 그룹이고, 이는 실제 지목 순서다. 그 그룹이 이미 삭제됐으면
    // sessionGroupId가 자동 그룹으로 돌아간다.
    let backfilled = false;
    for (const [pane, keys] of (g.groups || [])) {
      if (!adoptedGroup.has(String(pane)) && keys.length) { adoptedGroup.set(String(pane), keys[keys.length - 1]); backfilled = true; }
    }
    if (backfilled) persistGrants();   // 한 번 적어두면 다음부터는 보정이 아니라 기록을 읽는다
  } catch {}
}
function groupGranted(session, space, gid) {
  const s = groupGrantsOf(session);
  if (!s || !space || !gid) return false;
  return [...s].some((key) => {
    const i = key.indexOf("\n");
    return i >= 0 && key.slice(i + 1) === String(gid)
      && spaceKey.sameStorageSpace(key.slice(0, i), space);
  });
}
// ── 세션 그룹 ────────────────────────────────────────────────────────────────
// 세션(herdr pane)은 탭 하나가 아니라 그룹 하나를 소유한다. 그 안에서는 탭을 몇 개든 쓰고
// 그룹 밖으로는 나가지 않는다. 고정이 없을 때 그 스페이스의 활성 탭을 따라가면
// 사용자가 탭을 옮길 때마다 명령 대상도 함께 옮겨가 지목한 적 없는 탭이 조작된다.
// 그룹 id를 pane에서 결정론으로 만들면 서버가 다시 떠도 같은 그룹을 그대로 되찾는다.
// 사용자가 그룹째 지목했으면 그 그룹이 이 세션의 그룹이다. 지목한 그룹이 사라졌으면 자동 그룹으로
// 돌아가고, 그것도 없으면 아래 ensureSessionGroup이 새로 만든다.
function sessionGroupId(session) {
  if (!session) return null;
  const a = adoptedOf(session);
  if (a && spaceKey.sameStorageSpace(a.space, sessionSpace(session)) && groupExists(a.space, a.gid)) return a.gid;
  return "ai:" + String(session);
}
// 그룹 이름은 herdr에 실제로 붙은 이름을 먼저 쓴다. 지목받은 그룹은 사용자가 이름을 붙인 것이고,
// 자동 그룹만 세션 이름을 쓴다.
function sessionGroupName(session) {
  const mine = sessionSpace(session), gid = sessionGroupId(session);
  const g = mine ? spGroups(mine).find((x) => x.id === gid) : null;
  return (g && g.name) || sessionLabel(session);
}
function groupExists(space, gid) {
  return spGroups(space).some((g) => g.id === gid);
}
function groupTabIds(space, gid) {
  return spTabs(space).filter((t) => t.group === gid).map((t) => t.id);
}
function tabGroupOf(space, tabId) {
  const t = spTabs(space).find((x) => x.id === tabId);
  return t ? (t.group || null) : null;
}
function controlOwnerOf(space, tabId) {
  const t = spTabs(space).find((x) => x.id === tabId);
  // 상태에 레코드가 있는데 그룹만 없는 것은 사람 탭이라는 뜻이다. 그때 runtime provenance로
  // 폴백하면 stale한 소유권이 정상적인 그룹 없는 탭에 되살아난다.
  if (t) return t.group || null;
  return tabReg.get(tabId)?.ownerGroup || null;
}
// 그룹 이름은 herdr에서 사용자가 보는 이름을 그대로 쓴다. pane id는 읽어서 알아볼 수 없다.
function sessionLabel(session) {
  const s = (snapshot().state || []).find((x) => x.paneId === String(session));
  const base = (s && (s.tabLabel || s.agent)) || String(session);
  return String(base).slice(0, 34);
}
function ensureSessionGroup(session) {
  const space = sessionSpace(session), gid = sessionGroupId(session);
  if (!space || !gid) return null;
  if (groupExists(space, gid)) return gid;
  if (bsMutate({ op: "group.create", space, id: gid, name: sessionLabel(session) })) {
    broadcast({ type: "browser-state", state: bsWire() });
  }
  return groupExists(space, gid) ? gid : null;
}
// 명시 지정(target/--tab)으로 잡은 탭은 그 세션 그룹에 포함시킨다. 지정이 있으면 지정된
// 탭을 포함하는 그룹을 만든다. 다른 세션이나 사용자가 만든 그룹의 탭은 건드리지 않는다.
function absorbIntoSessionGroup(session, tabId) {
  const space = sessionSpace(session); if (!space || !tabId) return;
  if (!tabExistsInSpace(space, tabId)) return;
  const cur = tabGroupOf(space, tabId);
  if (cur) return;                       // 이미 어딘가에 속해 있으면 옮기지 않는다
  const gid = ensureSessionGroup(session); if (!gid) return;
  if (bsMutate({ op: "tab.group", space, id: tabId, group: gid })) {
    broadcast({ type: "browser-state", state: bsWire() });
  }
}
function tabExistsInSpace(space, tabId) {
  return spTabs(space).some((t) => t.id === tabId);
}
// 어느 스페이스에든(공유 창 포함) 살아 있는가. 사용자가 직접 지목한 탭은 세션 스페이스 경계를
// 넘을 수 있으므로(browser-target-set), 그런 탭의 보호 여부는 pane 스페이스가 아니라 존재만으로
// 판정한다. 팝업(popup:*)은 browserState엔 없고 tabReg에만 있으므로 tabReg도 함께 본다.
function tabExistsAnywhere(tabId) {
  if (tabReg.has(tabId)) return true;
  return hasStoredTab(tabId);
}
// 어느 세션이 어느 탭을 쓰는지 창에 알린다. 어느 세션이 어떤 탭을 제어 중인지
// 탭에서 보여야 한다. 그룹 이름이 세션을 나타내고, 이 신호가 그중 어느 탭인지 나타낸다.
let lastAiTargetsJson = "";
// 세션이 사용 중인 탭 전부. 창은 이 값을 보고 현재 보고 있지 않은 스페이스의 탭도 유지한다.
// 사용자가 다른 스페이스를 보는 동안에도 세션이 자기 탭을 쓸 수 있어야 한다.
function heldTabsOf(pane, space) {
  const ids = new Set();
  const gid = sessionGroupId(pane);
  if (space && gid) for (const id of groupTabIds(space, gid)) ids.add(id);
  // grant/pinned/last = 사용자가 직접 지목해 이 세션에 묶인 탭. 지목은 스페이스·공유 창 경계를
  // 넘을 수 있으므로(browser-target-set) pane 스페이스로 거르지 않는다. 거르면 다른 스페이스에서
  // AI가 실제 조작 중인 탭이 보호·유지 집합에서 빠져 스로틀·LRU 회수 대상이 된다.
  for (const id of (grantTabIdsOf(pane) || [])) ids.add(id);
  for (const id of pinsOf(pane)) ids.add(id);
  const last = lastTabByPane.get(String(pane)); if (last) ids.add(last);
  return [...ids].filter((id) => tabExistsAnywhere(id));
}
function aiTargetsSnapshot() {
  const out = [];
  const panes = new Set([...lastTabByPane.keys(), ...pinnedTabsByPane.keys(), ...userGrantTabs.keys(), ...adoptedGroup.keys()]);
  for (const pane of panes) {
    const space = spaceByPane.get(String(pane)); if (!space) continue;
    const held = heldTabsOf(pane, space);
    const tabId = lastTabByPane.get(String(pane));
    // 현재 사용 탭 표시(tabId)는 기존과 같다. 없으면 사용 중인 탭 하나를 대표로 둔다.
    const shown = tabId && tabExistsInSpace(space, tabId) ? tabId : (held[held.length - 1] || null);
    if (!shown && !held.length) continue;
    out.push({ pane, label: sessionLabel(pane), space, group: sessionGroupId(pane), tabId: shown, held });
  }
  return out;
}
function broadcastAiTargets() {
  const t = aiTargetsSnapshot(), j = JSON.stringify(t);
  if (j === lastAiTargetsJson) return;
  lastAiTargetsJson = j;
  broadcast({ type: "ai-targets", targets: t });
}
function setLastTab(pane, tabId) {
  const key = String(pane);
  if (lastTabByPane.get(key) === tabId) return;   // 같은 탭을 계속 쓰는 동안 디스크를 건드리지 않는다
  lastTabByPane.set(key, tabId); persistGrants(); broadcastAiTargets();
}
// 창에 (탭 정체성 → 핸들)을 알린다. 핸들 발급은 서버가 하지만 요소 지목 같은 문구는 창이
// 만든다. 창이 이름을 임의로 만들면 터미널에서 부를 수 없는 이름이 남으므로 발급한 이름을 전달한다.
let lastHandleMapJson = "";
function handleMap() {
  const map = {};
  for (const tabId of tabReg.keys()) { const h = handleFor(tabId); if (h) map[tabId] = h; }
  return map;
}
function broadcastTabHandles() {
  const map = handleMap();
  const j = JSON.stringify(map);
  if (j === lastHandleMapJson) return;
  lastHandleMapJson = j;
  broadcast({ type: "tab-handles", map });
}
function tabAllowed(session, tabId) {
  // 잠든 탭은 registry 에 없다(webview 를 아직 만들지 않았기 때문이다). 그래도 존재하는 탭이므로
  // 여기서 없음으로 처리하면 깨워서 쓰는 경로(runBrowserCmd 의 asleep 분기)에 도달하기 전에 실패한다.
  // 허용 판정 자체는 바뀌지 않는다. 저장된 스페이스를 대신 넣고 같은 규칙을 적용한다.
  const meta = (tabId ? tabReg.get(tabId) : null)
    || (tabId && hasStoredTab(tabId) ? { space: storageSpaceOfTab(tabId), sleeping: true } : null);
  if (!meta) return { ok: false, why: "그런 브라우저 탭이 없습니다(" + (handleFor(tabId) || tabId) + ")." };
  if (grantedByTabId(session, tabId)) return { ok: true }; // 사용자가 지목해준 탭(여러 개 가능)
  const mine = sessionSpace(session);
  if (meta.space === SHARED_SPACE) {
    return { ok: false, why: "공유 브라우저 창의 탭입니다 — 앱에서 그 탭을 직접 지목해 주셔야 이 세션이 쓸 수 있습니다(요소 선택 모드에서 탭 클릭)." };
  }
  if (!mine) return { ok: false, why: "이 세션의 스페이스를 알 수 없어(HERDR_PANE_ID 미해석) 탭을 고정할 수 없습니다." };
  if (!spaceKey.sameStorageSpace(meta.space, mine)) return { ok: false, why: `다른 스페이스(${meta.space})의 탭입니다 — 이 세션은 ${mine} 안에서만 조작합니다.` };
  // 경계는 스페이스가 아니라 그룹이다. 같은 스페이스라도 자기 그룹이 아니고 지목받지도 않았으면
  // 없는 것으로 처리한다. 선택되지 않은 그룹은 접근도, 존재 노출도 막는다.
  const g = controlOwnerOf(mine, tabId), mineG = sessionGroupId(session);
  if (g === mineG || groupGranted(session, mine, g)) return { ok: true };
  return { ok: false, why: "이 세션이 쓸 수 있는 탭이 아닙니다 — 자기 그룹의 탭이거나 사용자가 앱에서 지목해 준 것만 조작합니다." };
}
function tabIsShowing(space, tabId) {
  if (!space || !tabId) return false;
  if (activeTabBySpace.get(space) === tabId) return true;
  return (snapshot().workspaces || []).some((w) => spaceKey.sameStorageSpace(space, w.id)
    && activeTabBySpace.get(w.id) === tabId);
}
// 표시되는 것만 조작할 수 있다. 스페이스 전체를 보여주면 지목받지 않은 그룹이 드러나, 고정에
// 실패하거나 다른 세션의 탭을 조작하게 된다.
function visibleTabsFor(session) {
  const mine = sessionSpace(session);
  const mineG = sessionGroupId(session);
  // showing = 현재 그 스페이스 화면에 그려지는 탭. QA가 보이지 않는 탭을 조작했는지 확인할 수 있어야 한다.
  // wc는 내보내지 않는다. 목록에 숫자가 보이면 그것으로 지정하게 되는데 그 번호는 재발급된다.
  const live = [...tabReg.entries()].map(([tabId, m]) => { const { wc: _wc, ...rest } = m;
      return { tabId, handle: handleFor(tabId), ...rest,
        showing: tabIsShowing(m.space, tabId) }; });
  // 잠든 탭도 목록에 남긴다. 재우기는 메모리를 아끼는 기능이지 탭을 없애는 것이 아닌데, 실행 중인
  // 탭만 세면 에이전트에게는 자기 탭이 사라진 것으로 보여 쓰던 탭 대신 새 탭을 만든다. 명령이 오면
  // 깨워서 쓰므로(runBrowserCmd 의 asleep 분기) 목록에 포함하는 쪽이 실제와 맞다. 목록에만 더하고
  // 조작 경로는 그대로이며, 여기 보이는 것은 아래 필터를 통과한 탭뿐이다.
  const seen = new Set(live.map((t) => t.tabId));
  const spaces = new Set();
  if (mine) spaces.add(spKey(mine));
  for (const id of (grantTabIdsOf(session) || [])) { const sp = storageSpaceOfTab(id); if (sp) spaces.add(sp); }
  const sleeping = [];
  for (const sp of spaces) for (const t of spTabs(sp)) {
    if (!t || !t.id || seen.has(t.id)) continue;
    seen.add(t.id);
    sleeping.push({ tabId: t.id, handle: handleFor(t.id), space: sp,
      url: t.url || "", title: t.title || "", showing: false, sleeping: true });
  }
  return [...live, ...sleeping]
    .filter((t) => {
      if (grantedByTabId(session, t.tabId)) return true;
      if (!mine || !spaceKey.sameStorageSpace(t.space, mine)) return false;
      const g = controlOwnerOf(mine, t.tabId);
      return g === mineG || groupGranted(session, mine, g);
    })
    .map((t) => (mine && spaceKey.sameStorageSpace(t.space, mine)) ? { ...t, space: mine } : t);
}
function tabBrief(t) { return "@" + (t.handle || t.tabId) + " " + (t.title || t.url || "(제목 없음)") + (t.dialog ? ` [확인 창 떠 있음: ${t.dialog.kind}]` : ""); }
// 고정 탭이 사라졌을 때의 안내. 판단을 호출자(AI)에게 넘기지 않는다. 해제는 여기서 이미 끝났고,
// 남은 탭이 있으면 그 목록만, 없으면 사용자에게 확인하라는 안내를 반환한다.
function goneReply(deadTab, session) {
  const left = visibleTabsFor(session);
  const head = deadTab
    ? `고정해둔 탭 @${handleFor(deadTab) || deadTab}이(가) 닫혀서 고정을 자동 해제했습니다(탭 제거로 인한 해제 — 실패가 아닙니다).`
    : "이 세션에 고정된 탭이 없습니다.";
  const tail = left.length
    ? ` 지금 이 세션이 쓸 수 있는 탭: ${left.map(tabBrief).join(" · ")}. 어느 탭에서 이어갈지 사용자에게 확인한 뒤 \`iris-browser target @핸들\`로 고정하거나 \`--tab @핸들\`로 한 번만 지정하세요.`
    : " 이 세션이 쓸 수 있는 탭이 하나도 없습니다 — 임의로 고르지 말고, 어느 브라우저 탭을 쓸지 사용자에게 물어보세요.";
  return { ok: false, error: head + tail, data: { untargeted: !!deadTab, reason: deadTab ? "target-gone" : "no-target", goneTab: deadTab ? handleFor(deadTab) || deadTab : null, tabs: left } };
}
function tabExistsInState(tabId) {
  return hasStoredTab(tabId);
}
// 대상은 항상 탭 정체성으로 정한다. wc는 명령을 보내기 직전에 한 번 꺼내 쓰는 핸들일 뿐
// 여기서 저장하지 않는다. webview가 다시 만들어지면(도킹 전환·프로필 변경·앱 재시작) 번호가
// 무효가 되고, 그 번호를 유지하면 재발급된 같은 번호가 다른 탭을 가리킨다.
function resolveTarget(session) {
  const tabId = session ? primaryPin(session) : null;
  if (tabId) {
    if (tabReg.has(tabId)) return { tabId, pinned: true };
    // 탭은 아직 상태에 살아 있는데 webview만 안 뜬 것(앱 기동 중)이라면 고정을 버리지 않는다.
    if (tabExistsInState(tabId)) return { tabId: null, notReady: true, waitTab: tabId };
    // 실제로 사라진 탭이다. 그것만 해제하고, 다른 고정이 남아 있으면 그쪽으로 이어 간다.
    dropPin(session, tabId); persistGrants();
    const next = primaryPin(session);
    if (next && tabReg.has(next)) return { tabId: next, pinned: true };
    return { tabId: null, staleP: true, deadTab: tabId };
  }
  // 고정이 없으면 이 세션의 그룹 안에서 고른다. 그룹 밖으로는 나가지 않는다. 스페이스의 활성 탭을
  // 따라가면 사용자가 탭을 옮길 때 명령 대상까지 함께 옮겨간다.
  const mine = sessionSpace(session);
  if (mine) {
    const gid = sessionGroupId(session);
    const ids = groupExists(mine, gid) ? groupTabIds(mine, gid) : [];
    if (ids.length) {
      // 이 세션이 마지막으로 쓴 탭을 계속 쓴다. 그것이 닫혔으면 그룹의 마지막 탭.
      const last = lastTabByPane.get(String(session));
      const pick = last && ids.includes(last) ? last : ids[ids.length - 1];
      if (tabReg.has(pick)) { setLastTab(String(session), pick); return { tabId: pick, pinned: false, group: gid }; }
      return { tabId: null, notReady: true, waitTab: pick };
    }
    // 그룹이 비었거나 아직 없으면 호출자가 이 세션용 탭을 만든다.
    return { tabId: null, needTab: true, space: mine };
  }
  if (session) return { tabId: null, pinned: false, noSpace: true };
  // 세션 식별이 없는 호출은 대상을 고르지 않는다. 콘솔 창이 보고 있는 스페이스의 활성 탭으로 가면
  // 호출자가 지정한 적 없는 탭에서 명령이 실행되고, 스페이스를 옮길 때마다 대상도 함께 옮겨간다
  // (확인 결과: session=null로 url 실행 시 다른 스페이스의 탭이 응답).
  return { tabId: null, pinned: false, noSession: true };
}
let pickModeOn = false; // 요소 선택 모드. 모든 창이 공유하는 단일 상태
function getPickMode() { return pickModeOn; }
// 같은 모드가 앱에도 적용된다. 사용자에게 요소 선택은 하나의 동작이고 대상이 브라우저 탭인지
// 시뮬레이터 화면인지만 다르다. 스위치를 둘로 나누면 어느 쪽이 켜졌는지 사용자가 기억해야
// 한다. 실행 중인 앱이 없으면 앱 쪽은 아무 동작도 하지 않는다.
function setPickModeState(on) {
  pickModeOn = !!on;
  broadcast({ type: "pick-mode", on: pickModeOn });
  if (pickModeOn) {
    appPick.start({
      herdr: getHerdr(),
      // 앱에서 고른 위젯도 콘솔 한 곳으로만 보낸다. 받는 즉시 그 창이 채팅에 블록을 넣는다.
      onPick: (pick) => relayToOneConsole({ type: "app-pick", pick }),
      onNote: (message) => broadcast({ type: "app-pick-note", message }),
    });
  } else appPick.stop();
}
// AI가 브라우저를 실제로 제어하는 중임을 알리는 상태(창 테두리 보라 글로우용). 명령이 흐르는 동안 on,
// idle 3s 후 off. executor 연결(앱 실행 중에는 항상 연결)과 구분해, 명령이 실제로 오가는 동안만 표시한다.
// 어느 탭을 어느 세션이 조작 중인지 나타낸다. 창은 이 값으로 해당 탭만 강조한다.
// 두 조건을 함께 만족해야 한다.
//  · 끝나면 꺼진다: 고정한 탭은 오래 남지만 조작은 끝난다. 고정 기준으로 강조하면 계속 켜져 있다.
//  · 대기 중에는 꺼지지 않는다: 명령 사이 간격이 몇 초씩 벌어져, 유효 시간이 짧으면 연속 작업에서 표시가 깜빡인다.
// 그래서 명령마다 갱신하되 유효 기간을 넉넉히(20s) 둔다. 세션별로 따로 계산해 병렬 작업이 모두 보인다.
const CONTROL_IDLE_MS = 20000;
const controlByTab = new Map();   // tabId → Map(session → 만료 시각)
// 다른 기준을 재는 값이다. 위의 20초는 조작 중 표시라 짧아야 하고(길면 끝난 뒤에도 강조된다),
// 이 5분은 최근에 썼으니 유지한다는 뜻이라 길어야 한다. 하나로 합치면 둘 중 하나가
// 어긋난다. 보유(held) 여부가 아니라 실제로 명령이 전달됐는지로 계산한다. 고정은 세션이
// 유지되는 동안 남지만 그 탭을 다시 쓰지 않을 수도 있다.
const AI_USE_KEEP_MS = 5 * 60 * 1000;
const aiUseByTab = new Map();     // tabId → 만료 시각
// 만료 시각을 그대로 내보낸다. 창이 스스로 해제할 수 있어야 한다. 만료마다 서버가 알리는
// 구조면 알림 하나를 놓친 창은 계속 켜져 있거나 너무 일찍 꺼진다.
function aiRecentUse() {
  const now = Date.now();
  const out = [];
  for (const [tabId, until] of aiUseByTab) {
    if (until > now) out.push({ tabId, until });
    else aiUseByTab.delete(tabId);
  }
  return out;
}
function controlMessage() {
  const tabs = controlSnapshot();
  return { type: "control-active", active: tabs.length > 0, tabs, recentAi: aiRecentUse() };
}
let controlSweep = null;
function controlSnapshot() {
  const now = Date.now();
  const tabs = [];
  for (const [tabId, sessions] of controlByTab) {
    const labels = [];
    for (const [s, until] of sessions) { if (until > now) labels.push(sessionLabel(s)); }
    if (labels.length) tabs.push({ tabId, labels });
  }
  return tabs;
}
function broadcastControl() {
  broadcast(controlMessage());
}
function sweepControl() {
  const now = Date.now();
  let changed = false;
  for (const [tabId, sessions] of controlByTab) {
    for (const [s, until] of sessions) if (until <= now) { sessions.delete(s); changed = true; }
    if (!sessions.size) controlByTab.delete(tabId);
  }
  if (changed) broadcastControl();
  if (!controlByTab.size && controlSweep) { clearInterval(controlSweep); controlSweep = null; }
}
function markControl(tabId, session) {
  if (!tabId) return;
  let sessions = controlByTab.get(tabId);
  if (!sessions) { sessions = new Map(); controlByTab.set(tabId, sessions); }
  const fresh = !sessions.has(String(session));
  sessions.set(String(session), Date.now() + CONTROL_IDLE_MS);
  aiUseByTab.set(tabId, Date.now() + AI_USE_KEEP_MS);   // 실제로 명령이 전달된 탭만 기록된다
  if (fresh) broadcastControl();                        // 새로 잡힌 것만 즉시 알린다(같은 세션 반복은 기간만 연장)
  if (!controlSweep) controlSweep = setInterval(sweepControl, 1000);
}

const spaceStateParticipant = {
  backupPaths: () => [HANDLE_PATH],
  remap(map) {
    // 핸들 정체성은 그대로 두고 어느 저장 스페이스에 속하는지만 옮긴다.
    for (const record of handleRec.values()) if (map[record.space]) record.space = map[record.space];
    const nextGroupRec = new Map();
    for (const [key, record] of groupRec) {
      if (map[record.space]) record.space = map[record.space];
      const separator = key.indexOf("\n");
      nextGroupRec.set(separator < 0 ? key : record.space + key.slice(separator), record);
    }
    groupRec.clear();
    for (const [key, record] of nextGroupRec) groupRec.set(key, record);
    persistHandles();
  },
  hasSpace: (key) => [...handleRec.values()].some((record) => record.space === key)
    || [...groupRec.values()].some((record) => record.space === key),
  contributeRecovery({ addRecord }) {
    for (const record of handleRec.values()) addRecord(record);
    for (const record of groupRec.values()) addRecord(record);
  },
};

// 대화상자는 server/browser/dialogs.js 가 소유한다. broadcast 는 init 에서 결정되므로
// 값이 아니라 호출 함수로 넘긴다.
const dialogs = createDialogs({ metaOfWc, broadcast: (m) => broadcast(m) });
const { plannedAnswer, dialogPlanText, setDialogPlan, setFrameOrigins, setTabDialog,
  openDialogAsk, closeDialogAsk, answerDialogAsk } = dialogs;

function flushNow() {
  return {
    handles: flushHandlesNow(),
    grants: flushGrantsNow(),
  };
}

export {
  MAX_PINS,
  absorbIntoSessionGroup,
  addPin,
  adoptGroup,
  aiTargetsSnapshot,
  answerDialogAsk,
  broadcastAiTargets,
  broadcastTabHandles,
  cdpExecutorReady,
  closeDialogAsk,
  closedTabsWire,
  controlMessage,
  controlSnapshot,
  designateGroup,
  designateTab,
  designatedHandles,
  dialogPlanText,
  disconnectCdpExecutor,
  dropPin,
  endChat,
  ensureSessionGroup,
  flushNow,
  getLastTab,
  getPickMode,
  goneReply,
  grantTab,
  grantTabIdsOf,
  groupExists,
  groupHandleFor,
  groupTabIds,
  handleFor,
  handleMap,
  hasProfiles,
  hasTab,
  markControl,
  metaOfWc,
  noteChatTab,
  normalizeClosedTabHistory,
  openDialogAsk,
  persistGrants,
  pinsOf,
  plannedAnswer,
  primaryPin,
  profileNames,
  profileRefToId,
  recordClosedTab,
  regTab,
  registerCdpExecutor,
  removeClosedTab,
  replacePaneSpaces,
  requestCdp,
  resolveCdpResult,
  resolveTabWcWaiters,
  resolveTarget,
  revokeTab,
  sessionGroupId,
  sessionGroupName,
  sessionLabel,
  sessionSpace,
  setActiveTab,
  setDialogPlan,
  setFrameOrigins,
  setLastTab,
  setPickModeState,
  setProfiles,
  setTabDialog,
  tabAllowed,
  tabCount,
  tabExistsInState,
  tabGroupOf,
  tabIdOfRef,
  tabIdOfWc,
  tabIsShowing,
  tabMeta,
  takeClosedTab,
  uiTokenOk,
  unregisterGoneTab,
  visibleTabsFor,
  waitForTabWc,
  wakeSleepingTab,
  wcOfTabId,
};
