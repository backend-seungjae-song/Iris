import crypto from "node:crypto";

import { bulkPolicy } from "./bulk-fill.js";
import {
  MAX_PINS,
  absorbIntoSessionGroup,
  addPin,
  answerDialogAsk,
  cdpExecutorReady,
  dropPin,
  ensureSessionGroup,
  getLastTab,
  goneReply,
  grantTabIdsOf,
  groupExists,
  groupHandleFor,
  groupTabIds,
  handleFor,
  hasProfiles,
  hasTab,
  markControl,
  persistGrants,
  pinsOf,
  primaryPin,
  profileNames,
  profileRefToId,
  requestCdp,
  resolveTarget,
  revokeTab,
  sessionGroupId,
  sessionGroupName,
  sessionLabel,
  sessionSpace,
  setLastTab,
  tabAllowed,
  tabExistsInState,
  tabIdOfRef,
  tabMeta,
  visibleTabsFor,
  waitForTabWc,
  wakeSleepingTab,
  wcOfTabId,
} from "./browser-runtime.js";
import { mutate as bsMutate, wire as bsWire } from "./browser-state-owner.js";
import { humanPathDeny } from "./human-path.js";
import { askEmulator } from "./emulator-bridge.js";
import {
  handleQaSessionCmd,
  isActCmd,
  noteRunAccepted,
  noteRunEvent,
  recordFrame,
  runFor,
  noteTrace,
  runSurfaces,
} from "./qa-journal.js";
import * as spaceKey from "./space-key.js";

// 브라우저·세션 명령 실행과 사용자 호출 대기/응답 쌍의 단일 소유 모듈.
//
// 소유 범위
//   세션 명령, 탭 생성·재사용, CDP 전송·재시도, human-path/bulk gate와 ask coordinator.
//
// 제공 API
//   initBrowserCommands, runBrowserCmd/runBrowserCmdResilient/runSessionCmd, 직접 wc 실행 port,
//   pick 기록 함수와 answerUserAsk. 원시 Map·Set·timer는 노출하지 않는다.
//
// 의존 대상
//   browser-runtime·browser-state-owner·qa-journal·human-path·bulk-fill owner에 의존하고,
//   broadcast는 composition root에서 주입받으며 inbound handler나 transport를 import하지 않는다.
//
// 유지 조건
//   명령 이름·대상 해석·재시도 순서와 sent 판정, 탭 생성/재사용 조건, human-path gate 위치,
//   browser_ask_user가 사용자가 끝낼 때까지 같은 id·session·tab 쌍을 유지하는 시간 계약.
//
// 영향 범위
//   server/index.js의 HTTP 조립과 browser-message-handlers.js의 pick/ask/dialog 응답,
//   browser-runtime·browser-state-owner·qa-journal 계약, bin/smoke.mjs 브라우저 명령 소유 검사.

let broadcast;

export function initBrowserCommands(deps) {
  broadcast = deps.broadcast;
}

const pickLog = new Map();      // pane → 최근 요소 선택 10개
const appPickLog = new Map();   // pane → 최근 앱 요소 선택 10개 (시뮬레이터·에뮬레이터)

export function noteBrowserPick(pane, tabId, pick) {
  const key = String(pane);
  const list = pickLog.get(key) || [];
  list.push({ t: Date.now(), tab: tabId ? handleFor(tabId) || tabId : null, tabId: tabId || null, pick });
  while (list.length > 10) list.shift();
  pickLog.set(key, list);
}

export function noteAppPick(pane, pick) {
  const key = String(pane);
  const list = appPickLog.get(key) || [];
  list.push({ t: Date.now(), pick });
  while (list.length > 10) list.shift();
  appPickLog.set(key, list);
}
export function runSessionCmd(cmd, args, session, runId) {
  const qa = handleQaSessionCmd(cmd, args, session, runId);
  if (qa) return qa;
  if (cmd === "picks") {
    const list = (pickLog.get(String(session)) || []).slice().reverse();
    return { ok: true, data: { count: list.length, picks: list.map((x) => ({
      // 터미널에 붙은 블록의 라벨과 같은 값이다. 여러 개를 고른 뒤 지시할 때
      // 이 이름으로 어느 블록이 어느 요소인지 맞춘다.
      pick: x.pick.pid || undefined, burst: x.pick.burst || undefined,
      at: new Date(x.t).toISOString().slice(11, 19), tab: x.tab,
      url: x.pick.url, title: x.pick.title || "", tag: x.pick.tag, text: x.pick.text || "",
      selector: x.pick.selector, altSelector: x.pick.usel && x.pick.usel !== x.pick.selector ? x.pick.usel : undefined,
      id: x.pick.id || "", cls: x.pick.cls || [], attrs: x.pick.attrs || [],
      source: x.pick.src || null, html: x.pick.html })) } };
  }
  // 앱(시뮬레이터·에뮬레이터)에서 사용자가 고른 요소. 브라우저와 분리한 이유는 탭 개념이
  // 없고 필드가 다르기 때문이다. 소스 파일·상위 위젯 체인이 선택자를 대신한다.
  if (cmd === "app-picks") {
    const list = (appPickLog.get(String(session)) || []).slice().reverse();
    return { ok: true, data: { count: list.length, picks: list.map((x) => ({
      pick: x.pick.pid || undefined, burst: x.pick.burst || undefined,
      at: new Date(x.t).toISOString().slice(11, 19),
      app: x.pick.app, widget: x.pick.widget, text: x.pick.text || "",
      file: x.pick.file, line: x.pick.line, column: x.pick.column,
      localProject: !!x.pick.local, stateful: !!x.pick.stateful,
      // 현재 화면에 표시된 값. 각 값이 파일:줄을 함께 담는다. 고른 위젯의 줄과 값이 적힌 줄은
      // 대개 달라서, 둘을 합쳐야 값의 출처와 수정할 위치를 함께 알 수 있다.
      values: x.pick.values || [], props: x.pick.props || [],
      // 어느 레이어에서 골랐는지(모달·시트가 가린 후보를 몇 개 제외했는지). 뒤의 요소가 선택된 경우를
      // 기록만 보고 구분할 수 있게 남긴다.
      layer: x.pick.layer || null,
      around: x.pick.around || null,
      chain: x.pick.chain || [], source: x.pick.kind })) } };
  }
  if (cmd === "tabs") {
    const mine = sessionSpace(session);
    const grantedList = [...(grantTabIdsOf(session) || [])].map((id) => handleFor(id) || id);
    // 표시되는 것만 조작할 수 있다. 목록에 다른 스페이스를 섞어 보여주면 고정에 실패하거나,
    // 고정된 다른 세션의 탭을 조작하게 된다.
    const visible = visibleTabsFor(session);
    return { ok: true, data: {
      tabs: visible,
      space: mine,
      pinned: session && primaryPin(session) ? handleFor(primaryPin(session)) : null,
      pinnedAll: session ? pinsOf(session).map((id) => handleFor(id)).filter(Boolean) : [],
      granted: grantedList,
      group: mine && groupExists(mine, sessionGroupId(session)) ? groupHandleFor(mine, sessionGroupId(session)) : null,
      groupName: mine && groupExists(mine, sessionGroupId(session)) ? sessionGroupName(session) : null,
      // 서로 다른 계정으로 같은 사이트를 동시에 봐야 할 때 고를 수 있는 로그인 칸.
      profiles: profileNames(),
      handleNote: "탭 지정에는 핸들(@스페이스-tab-난수)을 쓰세요 — 뒤의 난수가 그 탭의 정체성이라 그것만 적어도 됩니다. 탭이 살아 있는 한 바뀌지 않습니다.",
      scope: mine
        ? `이 세션(${session})은 자기 그룹 "${sessionGroupName(session)}" 안의 탭${grantedList.length ? ` + 지목받은 탭 ${grantedList.map((h) => "@" + h).join(" ")}` : ""}만 조작합니다. 지정 없는 명령은 그룹 밖으로 나가지 않고, 그룹이 비어 있으면 이 세션 몫의 탭을 새로 만듭니다. 앱에서 지목받은 그룹 없는 탭을 target/--tab으로 쓰면 이 세션 그룹에 들어옵니다. 남의 그룹 탭은 사용자가 앱에서 지목해 줘야 씁니다.`
        : `이 세션의 스페이스를 알 수 없습니다(${session ? "HERDR_PANE_ID 미해석" : "세션 식별자 자체가 없음"}) — 조작할 수 있는 탭이 없어 목록도 비웁니다${grantedList.length ? "(지목받은 탭 제외)" : ""}. herdr pane 안에서 실행하거나, 위임 프로세스라면 IRIS_SESSION에 부모 pane id를 넘겨주세요.`,
    } };
  }
  if (cmd === "target") {
    const ref = args && (args.tab != null ? args.tab : args.wc);   // wc는 이전 이름이고 값은 항상 핸들이다
    const wantTab = ref != null ? tabIdOfRef(ref) : null;
    if (ref != null && wantTab == null) return { ok: false, error: `그런 탭 핸들이 없습니다: ${ref}. \`iris-browser tabs\`로 확인하세요.` };
    if (wantTab == null) { // 조회
      const tabId = session ? primaryPin(session) : null;
      return { ok: true, data: { session: session || null, tabId, handle: tabId ? handleFor(tabId) : null,
        pinned: tabId ? handleFor(tabId) : null,
        pinnedAll: session ? pinsOf(session).map((id) => handleFor(id)).filter(Boolean) : [],
        tab: tabId ? tabMeta(tabId) : null,
        pending: !!tabId && !hasTab(tabId) && tabExistsInState(tabId) } };
    }
    if (!session) return { ok: false, error: "세션을 알 수 없습니다(HERDR_PANE_ID 없음) — 고정은 herdr pane 안에서만 가능합니다." };
    const gate = tabAllowed(session, wantTab);
    if (!gate.ok) return { ok: false, error: gate.why + " `iris-browser tabs`로 이 세션이 쓸 수 있는 탭을 확인하세요." };
    const pins = addPin(session, wantTab); persistGrants();
    const meta = tabMeta(wantTab);
    // 지정한 탭은 이 세션 그룹에 포함시킨다. 어느 세션이 어느 탭을 쓰는지 화면에서 보이게 한다.
    if (meta && spaceKey.sameStorageSpace(meta.space, sessionSpace(session))) {
      absorbIntoSessionGroup(session, wantTab);
      setLastTab(String(session), wantTab);
    }
    // 여러 개를 지정 중이면 그 목록을 함께 반환한다. 지정 없는 명령은 마지막으로 쓴 탭으로
    // 가고, 전부에 실행하려면 tab에 목록을 준다. 어떤 탭을 쓰는지 보이지 않으면 선택할 수 없다.
    return { ok: true, data: { session, pinned: handleFor(wantTab), handle: handleFor(wantTab), tabId: wantTab, tab: meta,
      pinnedAll: pins.map((id) => handleFor(id)).filter(Boolean),
      note: pins.length > 1 ? `이 세션이 ${pins.length}개를 들고 있습니다(최대 ${MAX_PINS}). 지정 없는 명령은 마지막으로 쓴 탭으로 가고, 전부에 돌리려면 tab에 목록을 주세요.` : undefined } };
  }
  if (cmd === "untarget") {
    // 화면에는 지목 해제로 표시한다. 고정만 풀고 지목을 남기면 그 탭은 계속 조작할 수 있다.
    let revoked = null;
    if (session) {
      // 하나를 지정하면 그것만, 없으면 들고 있던 것 전부를 놓는다.
      const one = args && (args.tab != null ? tabIdOfRef(args.tab) : null);
      const dropped = one ? (pinsOf(session).includes(one) ? [one] : []) : pinsOf(session);
      dropPin(session, one || null);
      const names = [];
      for (const pin of dropped) if (revokeTab(session, pin)) names.push(handleFor(pin) || pin);
      revoked = names.length ? names.join(", ") : null;
      persistGrants();
    }
    // 하나만 해제하면 남은 탭이 있으므로 무엇이 남았는지 함께 반환한다.
    const left = session ? pinsOf(session).map((id) => handleFor(id)).filter(Boolean) : [];
    return { ok: true, data: { session: session || null, pinned: left[left.length - 1] || null, pinnedAll: left, revoked } };
  }
  return null; // 세션 명령 아님 → CDP 경로로
}
// 탭 정체성은 겹치지 않는 난수다. 시각+순번은 창이 둘일 때 같은 밀리초에 같은 번호가 나올 수 있고,
// 번호가 섞인 정체성은 재발급될 때 다른 탭을 가리켜, 탭이 닫힐 때까지 유일하다는 조건을 만족하지 못한다.
function newTabId(prefix) { return String(prefix) + crypto.randomUUID(); }
// 새 탭 생성은 기본이 아니라 예외다. 쓸 수 있는 탭이 있으면 그것을 쓴다. 탭이 계속 늘면
// 사용자의 브라우저가 자동화 탭으로 채워지고, 어느 탭이 무엇인지 알 수 없게 된다.
// 새로 만드는 것이 맞는 경우는 네 가지뿐이고, 그 판단은 AI가 아니라 여기서 결정론적으로 한다:
//   (1) 병렬: 두 페이지가 동시에 열려 있어야 한다(parallel)
//   (2) 동시에 서로 다른 상태가 필요하다. 같은 사이트를 프론트와 어드민으로 함께 보거나,
//       같은 사이트에 서로 다른 계정으로 로그인해야 한다. 앞은 탭만 하나 더 있으면 되고(parallel),
//       뒤는 탭만 늘리면 안 된다. 같은 로그인 칸을 쓰면 쿠키가 하나라 한쪽이 로그아웃된다.
//       그래서 계정이 갈리는 경우는 반드시 프로필(=로그인 칸)까지 갈라야 한다(profile).
//   (3) 이 세션이 쓸 탭이 하나도 없다(최초 1개)
//   (4) 쓰던 탭이 죽어 되살릴 수 없다
// 사이트가 스스로 여는 팝업·새 창은 해당하지 않는다. 판단 대상이 아니라 그대로 등록된다.
// 같은 사이트인지 판정한다. 보던 페이지를 이어 가는 경우와 다른 사이트로 옮기는 경우를 구분하는 기준이다.
function hostOfUrl(u) { try { return new URL(String(u)).host; } catch { return ""; } }
function sameSiteUrl(a, b) { const x = hostOfUrl(a), y = hostOfUrl(b); return !!x && x === y; }

// 사용자가 지목한 탭은 사용자가 보고 있는 화면이다. 여기에 다른 사이트를 열면 보던 내용이
// 사라진다(확인 결과: 사용자가 열어 둔 시트가 덮였다). 목적에 따라 처리가 다르므로,
// 덮는 대신 어떤 경로인지 알린다. 탭 생성 로직과 분리한다. 그쪽은 경계를 넓히는 통로가
// 없어야 하는 코드이고, 이 함수는 반대로 경계를 지키는 판정이다.
function coverWarning(session, tabId, url) {
  if (!url) return null;
  // 세션이 만든 탭은 그 세션의 작업 탭이다. 지목 세트에 함께 있어도 여기서 막으면, 자기가 만든 탭을
  // 쓰지 못해 탭만 계속 늘어난다(확인 결과: 비교용으로 만든 탭이 막혔다).
  if (String(tabId).startsWith("browser:ai.")) return null;
  const g = grantTabIdsOf(session);
  if (!g || typeof g.has !== "function" || !g.has(tabId)) return null;
  const cur = (tabMeta(tabId) || {}).url || "";
  if (!cur || sameSiteUrl(cur, url)) return null;      // 같은 사이트 안에서 이어 가는 것은 막지 않는다
  return `이 탭 @${handleFor(tabId) || tabId}은(는) 사람이 지목해 준 화면입니다(${hostOfUrl(cur)}). 보고 있던 것을 덮지 않았습니다.\n`
    + `· 같은 흐름의 다음 단계로 넘어가는 것이면 → browser_goto (그 탭에서 이어집니다)\n`
    + `· 지금 페이지를 그대로 다시 부르려면 → browser_history {action:"reload"}\n`
    + `· 그와 무관한 페이지가 따로 필요하면 → parallel:true (새 탭이 생기고 사람 화면은 그대로)`;
}

function reusableTabFor(session) {
  const mine = sessionSpace(session); if (!mine) return null;
  const gid = sessionGroupId(session);
  const ids = groupExists(mine, gid) ? groupTabIds(mine, gid) : [];
  const live = ids.filter((id) => wcOfTabId(id));
  if (!live.length) return null;
  const last = getLastTab(session);
  return last && live.includes(last) ? last : live[live.length - 1];
}
function createTabForSession(args, session) {
  return new Promise((resolve) => {
    if (!session) { resolve({ ok: false, error: "세션을 알 수 없습니다(HERDR_PANE_ID 없음) — 탭 생성은 herdr pane 안에서만 가능합니다." }); return; }
    // 예외에 해당하지 않으면 만들지 않고 쓰던 탭을 그대로 쓴다.
    const wantParallel = !!(args && (args.parallel || args.newState));
    const wantProfile = args && args.profile != null ? String(args.profile) : null;
    if (!wantParallel && !wantProfile) {
      const reuse = reusableTabFor(session);
      if (reuse) {
        const url = args && args.url ? String(args.url) : null;
        const cover = coverWarning(session, reuse, url);
        if (cover) { resolve({ ok: false, error: cover }); return; }
        const done = (r) => resolve({ ok: true, data: { handle: handleFor(reuse), tabId: reuse, reused: true,
          space: sessionSpace(session), url: url || (tabMeta(reuse) || {}).url || "",
          note: `새로 만들지 않고 이 세션이 쓰던 탭 @${handleFor(reuse) || reuse}을(를) 씁니다. 두 페이지를 동시에 띄워야 하거나 다른 계정으로 열어야 하면 parallel:true를 주세요.`,
          ...(r && r.ok === false ? { navError: r.error } : {}) } });
        // entry: 사람 경로를 건너뛴 것이 아니라 이 주소를 열라는 요청 자체다.
        // 사람 경로 게이트가 이것을 막으면 browser_new_tab 전체가 동작하지 않는다(외부 인자에는 없는 표시).
        if (url) { runBrowserCmd("goto", { url, tab: reuse, entry: true }, session, true).then(done); return; }
        setLastTab(String(session), reuse); done(null); return;
      }
    }
    const mine = sessionSpace(session);
    if (!mine) { resolve({ ok: false, error: "이 세션의 스페이스를 알 수 없어(HERDR_PANE_ID 미해석) 탭을 만들 수 없습니다." }); return; }
    if (!cdpExecutorReady()) { resolve({ ok: false, error: "브라우저 제어기(앱)가 연결 안 됨 — Iris 앱을 실행하세요(pnpm app).", sent: false, appGone: true }); return; }
    const url = String((args && args.url) || "https://www.google.com/");
    // 보고서는 이 앱 안에서 열려야 한다. 파일 경로를 OS에 넘기면 크롬이 받아 사용자가 보는
    // 화면이 세션 밖으로 나간다. 그래서 file: 도 허용한다. 확인 결과:
    // 이 줄이 file: 을 막으면 openInIris가 조용히 실패하고(호출부가 오류를 무시한다),
    // 소스 형태 검사만 통과한 채 실제로는 열리지 않는다.
    if (!/^(https?|file):\/\//i.test(url)) { resolve({ ok: false, error: "http(s)·file 주소만 열 수 있습니다: " + url }); return; }
    const id = newTabId("browser:ai.");
    const title = String((args && args.title) || "").slice(0, 40) || ("에이전트 " + session);
    const gid = ensureSessionGroup(session); // 이 세션의 그룹. 없으면 여기서 만든다
    // 창에서 쓰는 것과 같은 mutation을 쓴다. 별도 생성 경로를 만들면 상태가 갈린다.
    let profileId;
    if (wantProfile) {
      profileId = profileRefToId(wantProfile);
      // 기본 칸의 id 는 빈 문자열이다(web/js/browser/profiles.js 의 PROFILE_DEFAULT_ID). 찾은 것과
      // 못 찾은 것을 참/거짓으로 구분하면 기본 칸이 없는 것으로 판정된다. 목록에는 있는 이름인데
      // 지정하면 거부된다. 못 찾은 경우만 null 이므로 그것으로 구분한다.
      if (profileId === null) { resolve({ ok: false, error: `그런 로그인 칸(프로필)이 없습니다: ${wantProfile}.` + (hasProfiles() ? ` 있는 것: ${profileNames().join(" · ")}. 새 계정용 칸은 앱에서 만들어 로그인해 주세요(비밀번호는 사람만 넣습니다).` : " 앱에서 프로필을 먼저 만들어 주세요.") }); return; }
    }
    if (!bsMutate({ op: "tab.open", space: mine, id, url, title, background: true, ai: true, group: gid || undefined,
      // 지정이 있으면 그대로 넘긴다. 기본 칸은 빈 문자열이라 참/거짓으로 거르면 키가
      // 빠지고 스페이스 기본 칸으로 열린다. 기본을 선택해도 다른 칸이 열린다
      // (확인 결과). 상태 계층은 빈 문자열을 기본으로 올바르게 읽는다(profileIdFromMutation).
      ...(profileId != null ? { profile: profileId } : {}) })) {
      resolve({ ok: false, error: "탭 상태 반영 실패(space=" + mine + ")." }); return;
    }
    broadcast({ type: "browser-state", state: bsWire() });
    waitForTabWc(id, 12000).then((wc) => {
      if (!wc) {
        resolve({ ok: false, error: "탭은 만들었지만 브라우저 창이 그것을 띄우지 못했습니다 — 앱에서 이 스페이스의 브라우저를 열어 주세요. (탭 id " + id + ")",
          data: { tabId: id, space: mine } });
        return;
      }
      // 고정 대신 마지막으로 쓴 탭으로 둔다. 그래야 같은 그룹에서 탭을 더 만들어 오가도
      // 자연스럽게 따라오고, 그 탭이 닫혀도 그룹의 다른 탭으로 이어진다(고정이면 거기서 끊긴다).
      setLastTab(String(session), id);
      const h = handleFor(id);
      const gname = gid ? sessionLabel(session) : null;
      resolve({ ok: true, data: { handle: h, tabId: id, space: mine, url, group: gid || null,
        note: `이 세션 그룹${gname ? ` "${gname}"` : ""} 안에 탭 @${h}를 만들었습니다(스페이스 ${mine}). 이후 명령은 지정 없이 이 탭에서 실행되고, 탭을 더 만들면 그것도 같은 그룹에 들어갑니다. 한 번만 다른 탭을 쓸 땐 --tab @핸들.` } });
    });
  });
}
// 세션 해석을 거치지 않고 특정 탭으로 바로 보낸다. 확인 창 자동 닫기처럼 서버가 직접 수행하는 작업에 쓴다.
export function execOnWc(cmd, args, wc) {
  return requestCdp(cmd, args, wc, 10000);
}
// 일시적 단절(앱 재시작·절전 복귀·tailnet 불안정)은 곧 복구된다. 한 번 실패로 끝내지 않고 간격을 두고
// 다섯 번까지 재시도한다. 다만 전송 후 응답이 없는 경우는 이미 실행됐을 수 있으므로 반복해도
// 안전한 읽기 명령만 재시도한다. 클릭·입력을 다시 보내면 두 번 실행된다.
const RETRY_DELAYS = [700, 1200, 2000, 3000];       // 최초 1회 + 재시도 4회 = 5회
// 앱 자체가 종료된 경우에만 쓰는 긴 재시도 간격(합 60초). 재시작·업데이트 시간을 견딘다.
const APP_GONE_DELAYS = [500, 1000, 1500, 2000, 3000, 4000, 5000, 6000, 8000, 10000, 10000, 9000];
const READONLY_CMDS = new Set(["url", "text", "snapshot", "screenshot", "observe", "tabs", "console", "network", "history", "locate"]);
// 전송 사실은 문자열로 판별하지 않는다. 페이지가 던진 예외 메시지에 같은 말이 들어 있으면
// 미전송으로 오판해 이미 발생한 부수효과를 반복 실행한다. 서버가 직접 만든
// 응답에 sent 플래그를 달아 구조로 판별한다(sent:false = 미전송, true = 전송 후 응답 없음).
const SENT_UNKNOWN_RE = /timeout\(30s\)/;   // 플래그가 없는 이전 경로 보완
export async function runBrowserCmdResilient(cmd, args, session, runId) {
  // 보내기 전에 먼저 기록한다. 이 줄이 있어야 전송 후 응답이 없는 구간이 로그에 남는다.
  const callId = noteRunAccepted(cmd, args, session, runId);
  // 조작은 직전·직후 화면을 남긴다. 회차가 열려 있을 때만 남기며, 회차 밖의 단발 조작까지 찍으면
  // 사용하지 않는 이미지가 쌓인다.
  const recRun = isActCmd(cmd) ? runFor(session, runId) : null;
  const shoot = (a) => runBrowserCmd("screenshot", a, session, false, runId);
  if (recRun) { try { await recordFrame(recRun, args && args.tab, "before", shoot); } catch {} }
  let last = null, tries = 0, step = 0, longWait = false;
  for (let i = 0; ; i++) {
    last = await runBrowserCmd(cmd, args, session, false, runId);
    tries = i + 1;
    noteTrace(cmd, args, session, last);
    if (last && last.ok) {
      const out = i ? { ...last, data: { ...(last.data || {}), retried: i } } : last;
      noteRunEvent(callId, cmd, args, session, out, tries, runId);
      // 조작으로 시작된 렌더링이 끝난 뒤의 화면. 촬영이 실패해도 조작 결과는 그대로 반환한다.
      // 기록 실패가 이미 실행된 조작을 무효로 만들지 않는다.
      if (recRun) { try { await recordFrame(recRun, args && args.tab, "after", shoot); } catch {} }
      return out;
    }
    const why = String((last && last.error) || "");
    const notSent = last && last.sent === false;
    const sentUnknown = (last && last.sent === true) || SENT_UNKNOWN_RE.test(why);
    const retryable = notSent || (sentUnknown && READONLY_CMDS.has(cmd));
    // 앱이 종료된 동안은 더 길게 기다린다. 이 명령은 아직 전송되지 않았으므로 무엇을 다시 보내도
    // 안전하고, 앱은 곧 복구된다(재시작 확인 결과 1.9초). 여기서 중단하면 앱 재시작에 걸친
    // 작업이 전부 실패한다. 탭은 정체성으로 복원되므로 기다렸다가 이어 가면 된다.
    // 앱이 종료됐을 때만 긴 간격을 쓴다. 대기 이유가 바뀌면 재시도 횟수도 그 기준으로 다시 계산한다.
    // 그러지 않으면 앱이 복구된 직후(탭 복원 대기)에 남은 횟수가 없어 즉시 중단된다.
    const gone = !!(last && last.appGone);
    if (gone !== longWait) { longWait = gone; step = 0; }
    const ladder = longWait ? APP_GONE_DELAYS : RETRY_DELAYS;
    if (!retryable || step >= ladder.length) break;
    await new Promise((r) => setTimeout(r, ladder[step++]));
  }
  // 재시도해도 실패하면 시도 횟수까지 함께 알린다. 단순 실패와 대기 후에도 복구되지 않은 경우는 다르다.
  if (last && !last.ok && tries > 1) last = { ...last, error: `${last.error} (${tries}회 시도)` };
  // 실패도 기록한다. 실패를 빼면 로그와 그로부터 만든 보고서가 실제 결과를 반영하지 못한다.
  noteRunEvent(callId, cmd, args, session, last, tries, runId);
  return last;
}
// AI가 대신할 수 없는 단계(결제·본인확인·캡차·약관 동의)에서 사용자를 호출한다. 화면을 가져오지 않는다.
// 호출하고 그 탭으로 가는 경로를 제공한 뒤, 사용자가 이동했는지만 반환한다. 완료 여부는 페이지를 보고 판단한다.
const pendingAsks = new Map();   // id → { resolve, timer }
let askSeq = 0;
const askOwner = new Map();      // id → { session, tabId } 호출의 소유자
const askGoing = new Map();      // session → id. 사용자가 이동까지 응답했으나 끝나지 않은 호출
const askAnswers = new Map();    // id → answer. 대기 중인 호출이 없는 사이에 사용자가 누른 응답
// 한 번의 호출이 대기하는 최대 시간. MCP 클라이언트가 먼저 끊으면 AI는 오류만 받으므로
// 그 전에 반환하고 다시 호출하도록 안내한다. 알림은 화면에 그대로 남는다.
const ASK_CALL_MAX_MS = 240000;

export function answerUserAsk(id, answer) {
  const aid = String(id), a = String(answer || "갔음");
  const own = askOwner.get(aid);
  // 이동 응답은 그 세션이 사용자를 기다리는 중이라는 표시다. 호출이 잠시 끊긴 사이에 눌려도
  // 다음 호출이 이 호출을 이어받아야 알림이 두 번 뜨지 않는다.
  if (a === "갔음" && own) askGoing.set(own.session, aid);
  const p = pendingAsks.get(aid);
  if (p) p.resolve(a);
  else { askAnswers.set(aid, a); while (askAnswers.size > 20) askAnswers.delete(askAnswers.keys().next().value); }
}
// 받침이 있으면 "을", 없으면 "를". 선택한 답을 그대로 문장에 넣으면 "승인를"이 되므로
// 조사를 맞춘다.
function 을를(word) {
  const last = String(word || "").trim().slice(-1);
  const c = last.charCodeAt(0);
  if (!(c >= 0xac00 && c <= 0xd7a3)) return "를";   // 한글이 아니면 기본형
  return (c - 0xac00) % 28 ? "을" : "를";
}
function askNote(answer, going, where) {
  const 자리 = where === "app" ? "그 앱" : "그 탭";
  if (answer === "다 했음") return "사람이 끝났다고 했습니다. 화면을 다시 확인하고 이어서 진행하세요.";
  if (answer === "못 했음") return "사람이 못 하겠다고 했습니다. 무엇이 막혔는지 화면에서 확인하고 사용자에게 알리세요.";
  if (answer === "나중에") return "사람이 지금은 안 하겠다고 했습니다. 이 단계는 사람 없이 넘어갈 수 없습니다.";
  if (answer === "갔음") return `사람이 ${자리}으로 갔습니다.`;
  // 호출한 쪽이 만든 답은 서버가 의미를 알 수 없으므로 선택한 값을 그대로 전달한다.
  if (answer) return `사람이 "${answer}"${을를(answer)} 골랐습니다. 그 뜻대로 이어서 진행하세요.`;
  if (going) return `사람이 ${자리}으로 갔지만 아직 끝났다는 답이 없습니다. 화면을 확인하고, 아직이면 같은 인자로 이 도구를 다시 불러 계속 기다리세요`
    + "(알림은 다시 뜨지 않고 그 부름을 이어받습니다). 여기서 턴을 끝내지 마세요.";
  return "사람이 아직 응답하지 않았습니다. 화면을 확인하고, 필요하면 같은 인자로 다시 불러 기다리세요. 여기서 턴을 끝내지 마세요.";
}
// 호출 전에 AI가 채울 수 있는데 비어 있는 칸이 남았는지 화면에서 확인한다. 사용자 호출은
// 마지막 수단이어야 한다. 배송지·받는 사람처럼 AI가 채울 수 있는 칸을 남겨 두고 호출하면
// 사용자가 AI의 몫까지 하게 된다. 비밀 칸(비밀번호·카드·인증번호)은 사용자 몫이라 세지 않는다.
const UNFILLED_PROBE = `(() => {
  const vis = (e) => e && e.offsetParent !== null && e.getClientRects().length;
  const secret = (e) => {
    const s = ((e.type || "") + " " + (e.name || "") + " " + (e.id || "") + " " + (e.autocomplete || "")).toLowerCase();
    return /password|cc-|card|cvc|cvv|expiry|one-time|otp|captcha|보안|카드/.test(s);
  };
  const labelOf = (e) => {
    let t = "";
    if (e.id) { const l = document.querySelector('label[for="' + CSS.escape(e.id) + '"]'); if (l) t = l.textContent; }
    if (!t) { const l = e.closest("label"); if (l) t = (l.textContent || "").replace(e.textContent || "", ""); }
    if (!t) t = e.getAttribute("aria-label") || e.placeholder || e.name || e.id || "";
    return String(t).replace(/\\s+/g, " ").replace(/[*:·\\s]+$/, "").trim().slice(0, 24);
  };
  const req = (e) => {
    if (e.required || e.getAttribute("aria-required") === "true") return true;
    const box = e.closest("label, .form-group, .field, li, tr, div");
    return !!(box && /필수|required|\\*/.test((box.textContent || "").slice(0, 120)));
  };
  const out = { required: [], optional: [] };
  const els = [...document.querySelectorAll("input, textarea, select")].filter(vis)
    .filter((e) => !e.disabled && !e.readOnly && !secret(e))
    .filter((e) => !/^(submit|button|image|reset|file|hidden|checkbox|radio)$/i.test(e.type || ""));
  for (const e of els) {
    const empty = e.tagName === "SELECT"
      ? (!e.value || e.selectedIndex <= 0)
      : !String(e.value || "").trim();
    if (!empty) continue;
    const name = labelOf(e); if (!name) continue;
    (req(e) ? out.required : out.optional).push(name);
  }
  out.required = [...new Set(out.required)].slice(0, 8);
  out.optional = [...new Set(out.optional)].slice(0, 8);
  return out;
})()`;
function unfilledOn(wc) {
  if (!wc) return Promise.resolve(null);
  return execOnWc("eval", { expression: UNFILLED_PROBE }, wc)
    .then((r) => (r && r.ok && r.data && r.data.value) || null)
    .catch(() => null);
}
function askUser(args, session) {
  return new Promise((resolve) => {
    const skey = String(session || "");
    const w = args && args.wait != null && args.wait !== "" ? Number(args.wait) : 180;   // 0은 대기하지 않음
    const waitMs = Math.min(ASK_CALL_MAX_MS, Math.max(0, Math.min(600, Number.isFinite(w) ? w : 180)) * 1000);
    const deadline = Date.now() + waitMs;   // 이 호출의 대기 종료 시각. 단계가 넘어가도 연장되지 않는다.
    // 호출한 쪽이 선택지를 정했으면 첫 번째가 긍정이다. "예/아니오"에서 예가 앞에 오는 것과 같다.
    // 어느 것이 진행인지 서버가 추정하지 않고 호출한 쪽이 순서로 지정한다.
    const choices = Array.isArray(args && args.choices)
      ? args.choices.map((c) => String(c).trim()).filter(Boolean).slice(0, 4) : null;
    // 대상이 앱인지 탭인지는 settle도 읽는다. 이어받기 경로(이동까지 응답한 호출을 다시 기다리는
    // 위치)는 아래 본문을 건너뛰고 settle로 가므로, 선언이 그 뒤에 있으면 서버가 종료된다
    // (확인 결과 server.log: ReferenceError: Cannot access 'askDevice' before initialization).
    const askDevice = args && args.device != null ? String(args.device).trim() : "";
    const settle = (id, answer, going, tabId) => {
      pendingAsks.delete(id);
      if (answer !== null) { askGoing.delete(skey); askOwner.delete(id); }
      resolve({ ok: true, data: { answered: answer !== null,
        done: answer === "다 했음" || !!(choices && choices.length && answer === choices[0]),
        answer: answer || (going ? "간 뒤 응답 없음" : "응답 없음"),
        tab: tabId ? handleFor(tabId) || tabId : null,
        ...(askDevice ? { device: askDevice } : {}),
        note: askNote(answer, going, askDevice ? "app" : "tab") } });
    };
    // 사용자가 응답할 때까지 대기한다. 이동 응답은 시작 신호일 뿐이라 여기서 반환하지 않는다.
    // 반환하면 AI가 사용자가 작업을 마치기 전에 턴을 끝낸다.
    const waitOn = (id, tabId, going) => {
      const buffered = askAnswers.get(id);
      if (buffered !== undefined) {
        askAnswers.delete(id);
        if (buffered === "갔음") { waitOn(id, tabId, true); return; }
        settle(id, buffered, going, tabId); return;
      }
      const ms = Math.max(0, deadline - Date.now());
      if (!ms) { settle(id, null, going, tabId); return; }
      pendingAsks.set(id, { timer: setTimeout(() => settle(id, null, going, tabId), ms), resolve: (a) => {
        const p = pendingAsks.get(id); if (p) clearTimeout(p.timer);
        if (a === "갔음") { waitOn(id, tabId, true); return; }
        settle(id, a, going, tabId);
      } });
    };
    // 사용자가 이미 이동까지 응답한 호출이 남아 있으면 다시 호출하지 않는다. 알림을 다시 띄우면
    // 사용자가 같은 작업을 두 번 요청받는다. 그 호출을 이어서 기다린다.
    const cont = askGoing.get(skey);
    if (cont && (askOwner.has(cont) || askAnswers.has(cont))) {
      const own = askOwner.get(cont) || {};
      waitOn(cont, own.tabId || null, true);
      return;
    }
    const text = String((args && args.message) || "").trim().slice(0, 300);
    if (!text) { resolve({ ok: false, error: "무엇을 해달라는 것인지 한 줄로 적어 주세요(message)." }); return; }
    // 대상은 탭만이 아니다. iOS 시뮬레이터 앱도 사용자가 직접 조작해야 하는 대상이다.
    // device가 오면 탭 폴백을 쓰지 않는다. 폴백을 쓰면 앱을 안내하면서 다른 탭으로 이동시킨다.
    const ref = args && args.tab != null ? tabIdOfRef(args.tab) : null;
    const tabId = askDevice && !ref ? null
      : (ref || (session ? (resolveTarget(session).tabId || primaryPin(session)) : null));
    if (tabId && !tabAllowed(session, tabId).ok) { resolve({ ok: false, error: "이 세션이 쓸 수 있는 탭이 아닙니다." }); return; }
    const meta = tabId ? tabMeta(tabId) || {} : {};
    const id = "ask" + (++askSeq);
    const ready = !!(args && args.ready);
    const proceed = (unfilled) => {
      askOwner.set(id, { session: skey, tabId });
      // 사람에게 넘기는 순간 그 탭의 CDP 를 뗀다. 유휴 창(30초)을 기다리면 사람이 로그인하는
      // 동안 CDP 가 붙어 있다. 실패해도 호출은 계속한다.
      if (wc) execOnWc("handoff", {}, wc).catch(() => {});
      broadcast({ type: "ai-ask", id, tabId, space: meta.space || null, session: session || null,
        where: askDevice ? "app" : "tab", device: askDevice || undefined,
        choices: choices && choices.length ? choices : undefined,
        title: String((args && args.title) || "").slice(0, 60) || undefined,
        text: text + (unfilled && unfilled.length ? `\n(AI가 못 채운 칸: ${unfilled.join(" · ")})` : "") });
    if (!waitMs) {
      resolve({ ok: true, data: { answered: false, done: false, answer: "안 기다림", tab: tabId ? handleFor(tabId) || tabId : null,
        note: "불렀습니다. 응답은 기다리지 않았습니다 — 사람이 갔는지는 화면으로 확인하세요." } }); return; }
      waitOn(id, tabId, false);
    };
    // 채울 수 있는 칸이 남았으면 호출하지 않고 반환한다. 값을 모르면 사용자에게 값을 물어보고
    // AI가 채운다. 탭을 넘기는 것은 사용자만 할 수 있는 작업에만 쓴다.
    const wc = tabId ? wcOfTabId(tabId) : null;
    // 빈 칸 계산은 웹 폼을 대상으로 하는 검사다. 앱 대상에는 셀 항목이 없으므로 그대로 호출한다.
    if (askDevice && !tabId) { proceed([]); return; }
    unfilledOn(wc).then((u) => {
      const left = (u && u.required) || [];
      if (left.length && !ready) {
        resolve({ ok: false, error: `아직 네가 채울 수 있는 칸이 남았습니다: ${left.join(" · ")}`
          + `${u.optional && u.optional.length ? ` (선택 칸도 비어 있음: ${u.optional.join(" · ")})` : ""}. `
          + `사람을 부르기 전에 채우세요. 값을 모르면 탭을 넘기지 말고 사용자에게 그 값을 물어본 뒤 직접 채우면 됩니다. `
          + `이 화면에서 사람만 할 수 있는 부분(비밀번호·카드·인증번호·본인확인)만 남았다면 ready:true로 다시 부르세요.`,
          data: { unfilled: left, optional: (u && u.optional) || [] } });
        return;
      }
      proceed(left);
    });
  });
}
// 여러 탭을 한 번에. 그룹으로 탭을 묶어 두는 이유가 여럿을 함께 다루기 위해서인데, 명령이 한
// 번에 하나만 받으면 그 묶음을 쓸 수가 없다. 대상 목록은 배열로도, 쉼표로도
// 받는다. 상한을 두는 이유는 동시에 네 화면까지가 결과를 확인할 수 있는 범위이기 때문이다.
const MAX_TARGETS = 4;
function refList(tab) {
  if (tab == null) return null;
  const arr = (Array.isArray(tab) ? tab : String(tab).split(","))
    .map((s) => String(s).trim()).filter(Boolean);
  return [...new Set(arr)];   // 같은 탭을 두 번 적어도 두 번 돌리지 않는다
}
export function runBrowserCmd(cmd, args, session, noAutoTab, runId) {
  return new Promise((resolve) => {
    // 대상이 여럿이면 하나씩 처리하는 기존 경로를 반복해서 사용한다. 권한 검사·그룹 편입·오류
    // 문구가 모두 그 경로에 있어, 여기서 나눠 실행하면 대상마다 동일하게 적용된다.
    const targets = args && args.tab != null ? refList(args.tab) : null;
    if (targets && targets.length !== 1) {
      if (!targets.length) { resolve({ ok: false, error: "대상 탭이 비어 있습니다." }); return; }
      if (targets.length > MAX_TARGETS) {
        resolve({ ok: false, error: `한 번에 최대 ${MAX_TARGETS}개까지 조작합니다(요청 ${targets.length}개).` });
        return;
      }
      Promise.all(targets.map((t) => runBrowserCmd(cmd, { ...(args || {}), tab: t }, session, noAutoTab, runId)))
        .then((rs) => {
          const per = targets.map((t, i) => ({ tab: t, ...(rs[i] || { ok: false, error: "결과 없음" }) }));
          const okCount = per.filter((r) => r.ok).length;
          resolve({
            ok: okCount === per.length,          // 하나라도 실패하면 전체 실패. 절반만 성공한 것을 성공으로 보고하지 않는다
            multi: true, count: per.length, okCount,
            error: okCount === per.length ? undefined
              : per.filter((r) => !r.ok).map((r) => `${r.tab}: ${r.error || "실패"}`).join(" / "),
            targets: per,
          });
        });
      return;
    }
    if (targets) args = { ...(args || {}), tab: targets[0] };   // 쉼표 하나짜리도 정규화해 아래로 넘긴다
    if (cmd === "newtab") { createTabForSession(args, session).then(resolve); return; }
    if (cmd === "ask") { askUser(args, session).then(resolve); return; }
    // MCP 앱 도구의 대상은 Iris 에뮬레이터 탭에 열린 기기뿐이다. 어느 탭이 이 세션 스페이스의 것인지는 여기서 표시한다.
    if (cmd === "app-devices") {
      askEmulator("list", {}, 5000).then((r) => {
        if (!r || r.ok === false) { resolve(r || { ok: false, error: "응답 없음" }); return; }
        const mine = sessionSpace(session);
        resolve({ ok: true, data: { space: mine, tabs: (r.tabs || []).map((t) => ({ ...t, mine: !!mine && spaceKey.sameStorageSpace(t.space, mine) })) } });
      });
      return;
    }
    if (cmd === "app-open") {
      const wait = Math.min(Math.max(Number(args && args.wait) || 120000, 5000), 240000);
      askEmulator("open", { space: sessionSpace(session), device: (args && args.device) || null, wait }, wait + 5000)
        .then((r) => resolve(r && r.ok ? { ok: true, data: r } : (r || { ok: false, error: "응답 없음" })));
      return;
    }
    const local = runSessionCmd(cmd, args, session, runId);
    if (local) { resolve(local); return; }
    if (!cdpExecutorReady()) { resolve({ ok: false, error: "브라우저 제어기(앱)가 연결 안 됨 — Iris 앱을 실행하세요(pnpm app).", sent: false, appGone: true }); return; }
    // --tab 이 오면 그 명령만 그 탭에서 실행한다. 여러 탭을 지목받았을 때 고정을 계속 갈아끼우지 않아도 된다.
    const want = args && args.tab != null ? tabIdOfRef(args.tab) : null;
    if (args && args.tab != null && want == null) {
      const r = goneReply(null, session);
      resolve({ ...r, error: `그런 탭 핸들이 없습니다: ${args.tab}.` + r.error.replace(/^이 세션에 고정된 탭이 없습니다\./, "") });
      return;
    }
    if (want != null) {
      const gate = tabAllowed(session, want);
      if (!gate.ok) {
        // 지정한 탭이 사라진 경우는 실패가 아니라 상태 변화이므로 남은 탭을 함께 반환한다.
        if (!hasTab(want)) { const r = goneReply(null, session); resolve({ ...r, error: `지정한 탭 @${handleFor(want) || want}이(가) 없습니다(닫혔거나 다른 창).` + r.error.replace(/^이 세션에 고정된 탭이 없습니다\./, "") }); return; }
        resolve({ ok: false, error: gate.why });
        return;
      }
      // 명시적으로 지정한 탭은 이 세션 그룹에 포함시킨다(같은 스페이스·그룹 밖일 때만). 그래야 다음 명령부터
      // 지정 없이도 여기로 오고, 어느 탭이 이 세션 것인지 화면에서도 보인다.
      const wmeta = tabMeta(want);
      // --tab은 이번 명령에만 적용된다. 여기서 기본 대상까지 바꾸면 다음 무지정 명령의 대상이 바뀐다.
      if (wmeta && spaceKey.sameStorageSpace(wmeta.space, sessionSpace(session))) absorbIntoSessionGroup(session, want);
    }
    const tg = want != null ? { tabId: want, pinned: false, adhoc: true } : resolveTarget(session);
    // 잠든 탭이면 깨워서 쓴다. 재우기는 메모리를 아끼기 위한 기능인데, 잠들었다는 이유로 명령을
    // 실패시키면 자동화가 중단된다. 잠든 탭은 상태에는 있지만 wc 가 없는 형태로 보인다. 지목 경로면
    // tg.tabId 로, 고정·그룹 경로면 tg.waitTab 으로 온다(resolveTarget 이 wc 없는 탭을 notReady 로
    // 내린다). 깨운 뒤에는 대상 지정을 그대로 둔 채 다시 실행한다. args 를 수정하면 --tab 의 이번
    // 명령 한정 의미가 바뀐다. noAutoTab 이 재진입 표시라 이 분기는 한 번만 실행된다.
    const asleep = noAutoTab || tg.staleP || tg.needTab
      ? null
      : (tg.tabId && !wcOfTabId(tg.tabId) ? tg.tabId : (tg.notReady ? tg.waitTab : null));
    if (asleep && tabExistsInState(asleep)) {
      wakeSleepingTab(asleep);
      waitForTabWc(asleep, 12000).then(() => { runBrowserCmd(cmd, args, session, true, runId).then(resolve); });
      return;
    }
    // 여기서 한 번만 정체성을 실행 핸들로 변환한다. 이 아래로만 wc가 전달된다.
    const wc = tg.tabId ? wcOfTabId(tg.tabId) : null;
    if (!wc) {
      if (tg.staleP) { resolve(goneReply(tg.deadTab, session)); return; }
      // 이 세션이 아직 쓸 탭이 없다 → 사용자가 보고 있는 탭을 빼앗지 않고 자기 그룹에 하나 만든다.
      // 탭 지정이 없으면 그룹과 탭을 새로 만든다. 지목받은 탭이 있으면 그것부터 감싼다.
      if (tg.needTab) {
        const granted = [...(grantTabIdsOf(session) || [])]
          .filter((id) => spaceKey.sameStorageSpace((tabMeta(id) || {}).space, tg.space));
        if (granted.length) {
          // 지목받은 탭은 그 자체로 허용된다. 그룹 편입은 부수적이고(다른 그룹에 있으면
          // 편입되지 않는다), 편입됐다고 가정하고 처음부터 다시 호출하면 같은 분기로 되돌아와
          // 요청이 끝나지 않는다. 편입은 시도하되 대상은 여기서 확정한다.
          for (const id of granted) absorbIntoSessionGroup(session, id);
          const pick = granted[granted.length - 1];
          setLastTab(String(session), pick);
          // 대상을 명시해 다시 실행한다. 명시 경로는 이 분기로 되돌아오지 않으므로 재귀가 끝난다.
          runBrowserCmd(cmd, { ...(args || {}), tab: pick }, session, true, runId).then(resolve);
          return;
        }
        if (noAutoTab) { // 방금 만들었는데도 또 비어 있다면 만들기를 반복하지 않는다
          resolve({ ok: false, error: "이 세션 몫의 탭을 만들었지만 브라우저가 아직 띄우지 못했습니다 — 잠시 뒤 다시 시도하세요.", sent: false });
          return;
        }
        createTabForSession({}, session).then((r) => {
          if (!r.ok) { resolve(r); return; }
          runBrowserCmd(cmd, args, session, true, runId).then((r2) => {
            resolve(r2.ok ? { ...r2, data: { ...(r2.data || {}), createdTab: r.data.handle, note: r.data.note } } : r2);
          });
        });
        return;
      }
      if (tg.notReady) { resolve({ ok: false, sent: false, error: "고정한 탭이 아직 브라우저에 뜨지 않았습니다(앱 기동 중일 수 있음) — 고정은 그대로 두었습니다. 잠시 뒤 다시 시도하세요.", data: { tab: handleFor(tg.waitTab) || tg.waitTab, pending: true } }); return; }
      resolve({ ok: false, error: tg.noSession
        ? "세션 식별자가 없어(HERDR_PANE_ID·IRIS_SESSION 둘 다 없음) 어느 탭을 쓸지 정할 수 없습니다. 임의로 고르지 않습니다 — herdr pane 안에서 실행하거나, 위임 프로세스라면 IRIS_SESSION에 부모 pane id(예: w3:pS)를 넘겨주세요."
        : tg.noSpace
        ? "이 세션의 스페이스를 알 수 없어 조작할 탭을 정할 수 없습니다 — 앱에서 탭을 지목해 고정해 주세요."
        : tg.sharedBlocked
        ? "공유 브라우저 창은 지목 없이 쓰지 않습니다 — 앱에서 그 탭을 직접 지목해 주세요."
        : tg.space
        ? `스페이스 ${tg.space}에 열린 브라우저 탭이 없습니다 — 이 스페이스에서 브라우저를 열거나 탭을 지목해 고정하세요.`
        : "제어할 브라우저 탭이 없습니다 — 앱에서 브라우저를 열거나, 탭을 지목해 고정하세요(`iris-browser tabs`)." });
      return;
    }
    // 가로챈 질문(페이지가 동기 XHR로 답을 기다리는 중)이 있으면 CDP로 가지 않고 여기서 푼다.
    if (cmd === "dialog") {
      const ans = args && args.answer === "ok" ? "ok" : "cancel";
      const answered = answerDialogAsk(wc, ans, args && args.text);
      if (answered) {
        resolve({ ok: true, data: { answered: ans, ...answered, via: "intercepted" } });
        return;
      }
    }
    // 사람 경로 게이트는 실행기로 나가기 직전 한 곳에서만 확인한다. 모든 명령이 이 지점을 지난다.
    // sent 필드를 붙이지 않는다: 붙이면 재시도 사다리가 같은 거부를 네 번 더 굴린다.
    const denied = humanPathDeny(cmd, args, (tabMeta(tg.tabId) || {}).url || "");
    if (denied) { resolve({ ok: false, error: denied }); return; }
    // 대량 기입은 여기서 한 번 더 거른다. 로컬이면 그대로 보내고, 원격이면 사용자가
    // 승인한 것만 보낸다. 기준은 되돌릴 수 있는지이고 개수가 아니다.
    if (cmd === "bulkfill") {
      const surfaces = runSurfaces(session, runId);
      const pol = bulkPolicy({
        url: (tabMeta(tg.tabId) || {}).url || "",
        values: (args && args.values) || [],
        where: (args && args.where) || "",
        surfaces,
        approved: !!(args && args.approved),
        allowFormula: !!(args && args.allowFormula),
      });
      if (pol.mode !== "free") {
        resolve({ ok: false, error: pol.reason, need: pol.mode, cap: pol.cap });
        return;
      }
    }
    markControl(tg.tabId, session); // 이 탭을 이 세션이 조작 중임을 표시해 해당 탭만 강조한다
    requestCdp(cmd, args, wc, 30000).then(resolve);
  });
}
