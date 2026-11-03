import { HerdrClient } from "./herdr.js";
import crypto from "node:crypto";

import { reportAgentSessionPath } from "./agent-session-path.js";
import { MAX_APP_TARGETS, appTargetsFor, readAppTargets, setAppTargets } from "./app-targets.js";
import { emulatorCapacity } from "./emulator-capacity.js";
import { activatePromptTargets, MAX_PROMPT_TARGET_MARKERS } from "./prompt-targets.js";
import {
  MAX_PINS,
  absorbIntoSessionGroup,
  addPin,
  broadcastAiTargets,
  cdpExecutorReady,
  closedTabsWire,
  controlOwnerOf,
  dropPin,
  ensureSessionGroup,
  getLastTab,
  grantTab,
  grantTabIdsOf,
  grantedByTabId,
  groupExists,
  groupHandleFor,
  groupTabIds,
  handleFor,
  hasProfiles,
  hasTab,
  persistGrants,
  pinsOf,
  primaryPin,
  profileNames,
  profileRefToId,
  recordClosedTab,
  removeClosedTab,
  requestCdp,
  replaceDesignatedGroups,
  replaceDesignatedTabs,
  rememberQaPane,
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
import { mutate as bsMutate, wire as bsWire, storageSpaceOfTab } from "./browser-state-owner.js";
import { qaOwner, claimQaTab, releaseQaTabIfOwner } from "./qa-ownership.js";
import { askEmulator } from "./emulator-bridge.js";
import { handleQaSessionCmd } from "./qa-journal.js";
import * as spaceKey from "./space-key.js";

// 브라우저·세션 명령 실행과 사용자 호출 대기/응답 쌍의 단일 소유 모듈.
//
// 소유 범위
//   세션 상태 명령, 탭 생성·재사용, app 명령과 ask coordinator.
//
// 제공 API
//   initBrowserCommands, runBrowserCmd/runSessionCmd, 직접 wc 실행 port,
//   pick 기록 함수와 answerUserAsk. 원시 Map·Set·timer는 노출하지 않는다.
//
// 의존 대상
//   browser-runtime·browser-state-owner·qa-journal·human-path·bulk-fill owner에 의존하고,
//   broadcast는 composition root에서 주입받으며 inbound handler나 transport를 import하지 않는다.
//
// 유지 조건
//   명령 이름, 탭 생성/재사용 조건,
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
  return pick?.pid || null;
}

export function noteAppPick(pane, pick) {
  const key = String(pane);
  const list = appPickLog.get(key) || [];
  list.push({ t: Date.now(), pick });
  while (list.length > 10) list.shift();
  appPickLog.set(key, list);
  return pick?.pid || null;
}
export function runSessionCmd(cmd, args, session, runId) {
  const qa = handleQaSessionCmd(cmd, args, session, runId);
  if (qa) return qa;
  if (cmd === "app-targets-get") {
    if (!session) return { ok: false, error: "세션을 알 수 없습니다(HERDR_PANE_ID 없음)." };
    try {
      return { ok: true, data: { session, devices: appTargetsFor(session) } };
    } catch (error) {
      return { ok: false, error: `기기 등록을 읽지 못했습니다: ${String(error?.message || error)}` };
    }
  }
  if (cmd === "app-targets-set") {
    if (!session) return { ok: false, error: "세션을 알 수 없습니다(HERDR_PANE_ID 없음)." };
    try {
      const devices = setAppTargets(session, Array.isArray(args?.devices) ? args.devices : []);
      // 등록에서 뺀 기기의 이 세션 소유 탭도 놓는다(web/js/emulator/boot.js releaseDevices)
      askEmulator("release", { owner: session, keep: devices }, 3000).catch(() => {});
      return { ok: true, data: { session, devices } };
    } catch (error) {
      return { ok: false, error: `기기 등록을 저장하지 못했습니다: ${String(error?.message || error)}` };
    }
  }
  if (cmd === "prompt-targets") {
    if (!session) return { ok: false, error: "세션을 알 수 없습니다(HERDR_PANE_ID 없음)." };
    if (args?.agentSession) reportAgentSessionPath({ paneId: session, ...args.agentSession });
    if (args?.registerOnly === true) return { ok: true, data: { activated: [], rejected: [] } };
    const markers = Array.isArray(args?.markers) ? args.markers : [];
    if (markers.length > MAX_PROMPT_TARGET_MARKERS) {
      return { ok: false, error: `지목 구분자는 한 메시지에 최대 ${MAX_PROMPT_TARGET_MARKERS}개입니다.` };
    }
    try {
      const result = activatePromptTargets({ pane: session, markers, actions: {
        maxDevices: MAX_APP_TARGETS,
        replaceGroups(records) {
          replaceDesignatedGroups(session, records.map((record) => record.target));
        },
        replaceTabs(records) {
          replaceDesignatedTabs(session, records.map((record) => record.target.tabId).filter((tabId) => hasTab(tabId) || tabExistsInState(tabId)));
        },
        addElements(records) {
          for (const record of records) if (hasTab(record.target.tabId)) grantTab(session, record.target.tabId);
          broadcastAiTargets();
        },
        replaceDevices(records) {
          const devices = records.map((record) => record.target.udid);
          setAppTargets(session, devices, { exclusive: true });
          // 이전 세션이 켠 탭에 떠 있는 기기면 그 탭도 이 세션 것이 된다. 창이 없으면 옮길 탭도 없다.
          askEmulator("reown", { devices, owner: session }, 3000).catch(() => {});
        },
      } });
      return { ok: true, data: result };
    } catch (error) {
      return { ok: false, error: `지목 등록 실패: ${String(error?.message || error)}` };
    }
  }
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
  const live = ids.filter((id) => wcOfTabId(id) && !qaOwner(id));
  if (!live.length) return null;
  const last = getLastTab(session);
  return last && live.includes(last) ? last : live[live.length - 1];
}
// 닫기는 이 세션 그룹의 탭만. 사용자가 지목해 준 탭·다른 그룹 탭은 사람 것이라 제외
function closeTabForSession(args, session) {
  if (!session) return { ok: false, error: "세션을 알 수 없습니다(HERDR_PANE_ID 없음) — 탭 닫기는 herdr pane 안에서만 가능합니다." };
  if (!args || args.tab == null || args.tab === "") return { ok: false, error: "닫을 탭 핸들(tab)을 지정하세요. browser_tabs 로 확인합니다." };
  const id = tabIdOfRef(args.tab);
  if (id == null) return { ok: false, error: `그런 탭 핸들이 없습니다: ${args.tab}.` };
  const gate = tabAllowed(session, id);
  if (!gate.ok) return { ok: false, error: gate.why };
  const space = storageSpaceOfTab(id);
  const handle = handleFor(id) || id;
  if (!space || grantedByTabId(session, id) || controlOwnerOf(space, id) !== sessionGroupId(session)) {
    return { ok: false, error: `@${handle}은(는) 이 세션 그룹의 탭이 아니라 닫지 않습니다 — 사용자가 지목해 준 탭은 사용자가 닫습니다.` };
  }
  if (!closeBrowserTab(id)) return { ok: false, error: `@${handle}을(를) 닫지 못했습니다.` };
  return { ok: true, data: { closed: handle, remaining: visibleTabsFor(session).map((t) => t.handle || t.tabId) } };
}

// 화면에서 닫을 때(handleBrowserSync)와 같은 순서: 복원 기록 → 지목·고정 회수 → 상태에서 제거. ⌘⇧T 로 되살릴 수 있음
export function closeBrowserTab(id, options = {}) {
  if (options.qaRunId && qaOwner(id) !== options.qaRunId) return false;
  const space = storageSpaceOfTab(id);
  if (!space) return false;
  const recorded = recordClosedTab(id);
  removeClosedTab(id);
  if (!bsMutate({ op: "tab.close", space, id })) return false;
  if (options.qaRunId && !releaseQaTabIfOwner(id, options.qaRunId).released) return false;
  if (recorded) broadcast(closedTabsWire());
  broadcast({ type: "browser-state", state: bsWire() });
  return true;
}

function createTabForSession(args, session, qaRunId = null) {
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
        resolve({ ok: true, data: { handle: handleFor(reuse), tabId: reuse, reused: true,
          space: sessionSpace(session), url: url || (tabMeta(reuse) || {}).url || "",
          note: `새로 만들지 않고 이 세션이 쓰던 탭 @${handleFor(reuse) || reuse}을(를) 씁니다. 두 페이지를 동시에 띄워야 하거나 다른 계정으로 열어야 하면 parallel:true를 주세요.`,
          ...(url ? { _navigate: url } : {}) } });
        setLastTab(String(session), reuse);
        return;
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
    // about:blank: QA 진입 전 크기 고정용 빈 탭에만 허용
    if (!/^(https?|file):\/\//i.test(url) && !(qaRunId && url === "about:blank")) { resolve({ ok: false, error: "http(s)·file 주소만 열 수 있습니다: " + url }); return; }
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
    if (qaRunId) claimQaTab(id, qaRunId);
    broadcast({ type: "browser-state", state: bsWire() });
    // 창은 보고 있는 활성 탭과 AI 가 최근 명령을 보낸 탭만 띄운다. 방금 만든 탭은 둘 다 아니라서
    // 사용자가 다른 스페이스를 보고 있으면 아무도 띄우지 않는다. 잠든 탭과 같은 경로로 깨운다.
    wakeSleepingTab(id);
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
export async function createQaEntry(session, url, runId) {
  const pane = await new HerdrClient().paneGet(session);
  if (pane?.pane_id !== session || !pane.workspace_id) return { ok: false, error: "실행 중인 QA 세션을 확인하지 못했습니다." };
  rememberQaPane(session, pane.workspace_id);
  // 최초 목적지 탐색 전 크기 고정: 사전 관찰 중 숨은 탭 재배치 방지
  return prepareQaEntryNavigation({
    createBlank: () => createTabForSession({ url: "about:blank", parallel: true, title: "QA" }, session, runId),
    getWc: (tabId) => wcOfTabId(tabId),
    cdp: requestCdp,
    url,
  });
}

// 최초 목적지 탐색의 선행 조건: QA 모드 적용 성공
// 페이지 크기는 바꾸지 않음. 크기 확인은 qa_viewport 로만(사용자 2026-10-29)
// QA 탭은 세션 브라우저의 그 세션 탭 그룹에 둠(사용자 2026-10-28). 사용자 포커스는 입력 때만 빌림(user-focus.cjs)
export async function prepareQaEntryNavigation({ createBlank, getWc, cdp, url }) {
  const created = await createBlank();
  if (!created?.ok) return created;
  const tabId = created.data?.tabId;
  const wc = tabId && getWc(tabId);
  if (!wc) return { ok: false, error: "QA 탭 webview를 준비하지 못했습니다." };
  const mode = await cdp("qa-mode", { enabled: true }, wc, 10000);
  if (!mode?.ok) return mode;
  const target = await cdp("goto", { url }, wc, 30000);
  if (!target?.ok) return target;
  return { ...created, data: { ...created.data, url } };
}
// 이어받을 탭 분류
// - 어디에도 없는 탭: qa_close_tab 밖에서 닫힘. 닫힌 것으로 빼고 이어받음(qa_close_tab 은 이어받은 뒤에만 가능)
// - 있는데 이 세션 그룹 밖이거나 다른 회차 소유면 거절
export function splitQaRestoreTabs(tabs, runId, { own, exists, ownerOf }) {
  const gone = tabs.filter((tab) => !own.has(tab) && !exists(tab));
  const live = tabs.filter((tab) => !gone.includes(tab));
  if (live.some((tab) => !own.has(tab))) return { ok: false, error: "복구할 탭이 이 세션 탭 그룹 밖에 있습니다." };
  if (live.some((tab) => ownerOf(tab) && ownerOf(tab) !== runId)) return { ok: false, error: "복구할 탭을 다른 QA 회차가 소유합니다." };
  return { ok: true, live, gone };
}
export async function restoreQaTabs(session, tabs, runId) {
  const pane = await new HerdrClient().paneGet(session);
  if(pane?.pane_id !== session || !pane.workspace_id) return {ok:false,error:"실행 중인 QA 세션이 없습니다."};
  // 앱 재시작 뒤 pane·스페이스 등록이 비어 있으므로 소유 탭 계산 전에 등록
  rememberQaPane(session,pane.workspace_id);
  const ownTabs = new Set(groupTabIds(sessionSpace(session),sessionGroupId(session)));
  // 재시작 직후 화면 밖 탭은 잠든 상태라 등록 전: 이 세션 그룹 탭만 깨운 뒤 판정
  await Promise.all(tabs.filter(tab=>ownTabs.has(tab) && !hasTab(tab)).map(tab=>{wakeSleepingTab(tab);return waitForTabWc(tab,12000);}));
  const split = splitQaRestoreTabs(tabs, runId, { own: ownTabs, exists: (tab) => hasTab(tab) || tabExistsInState(tab), ownerOf: qaOwner });
  if(!split.ok) return split;
  const live = split.live;
  // 앱 재시작 직후에는 창이 아직 탭을 만들지 못해 깨우기 대기가 끝날 수 있음. 실측: 같은 호출을 다시 하면 복구됨
  if(live.some(tab=>!hasTab(tab))) return {ok:false,error:"복구할 탭이 아직 열리지 않았습니다(앱 재시작 직후일 수 있음). 잠시 뒤 qa_run_resume을 다시 호출하세요."};
  for(const tab of live) if(!qaOwner(tab)) claimQaTab(tab,runId);
  publishQaTabs();
  return {ok:true,data:{tabs:live,gone:split.gone}};
}
export function notifyHostUser(args, session) { return notifyUser(args, session); }
export function progressHostUser(args, session) { return progressUser(args, session); }
export async function openQaReport(session, url) {
  // 관제 재계산이 에이전트 없는 pane의 등록을 지우므로 진입과 같이 다시 등록
  const pane = await new HerdrClient().paneGet(session);
  if (pane?.pane_id !== session || !pane.workspace_id) return { ok: false, error: "실행 중인 QA 세션을 확인하지 못했습니다." };
  rememberQaPane(session, pane.workspace_id);
  return createTabForSession({ url, parallel: true, title: "QA 보고서" }, session);
}
export async function runQaAppCommand(cmd, args, session) {
  // 기기 탭의 소유 판정과 여는 스페이스도 pane 등록 기준이라 보고서와 같이 다시 등록
  const pane = await new HerdrClient().paneGet(session);
  if (pane?.pane_id !== session || !pane.workspace_id) return { ok: false, error: "실행 중인 QA 세션을 확인하지 못했습니다." };
  rememberQaPane(session, pane.workspace_id);
  return runBrowserCmd(cmd, args, session);
}
export function publishQaTabs() { broadcast({ type: "browser-state", state: bsWire() }); }

// 세션 해석을 거치지 않고 특정 탭으로 바로 보낸다. 확인 창 자동 닫기처럼 서버가 직접 수행하는 작업에 쓴다.
export function execOnWc(cmd, args, wc) {
  return requestCdp(cmd, args, wc, 10000);
}
// 이전 화면 알림 방식의 대기 질문 장부. askUser 가 더 만들지 않음(콘솔 질문). 앱·폰의 답 수신 경로가 읽음
const pendingAsks = new Map();   // id → { resolve, timer }
const askOwner = new Map();      // id → 대기 알림과 호출의 소유자
const askGoing = new Map();      // session → id. 사용자가 이동한 호출
const askAnswers = new Map();    // id → answer. 대기 중인 호출이 없는 사이에 사용자가 누른 응답
const focusedUi = new Set();
export function setUserInterfaceFocus(ws, focused) {
  if (focused) focusedUi.add(ws);
  else focusedUi.delete(ws);
  if (!ws._noticeFocusCloseBound) {
    ws._noticeFocusCloseBound = true;
    ws.on("close", () => focusedUi.delete(ws));
  }
}
// 한 번의 호출이 대기하는 최대 시간. MCP 클라이언트가 먼저 끊으면 AI는 오류만 받으므로
// 그 전에 반환하고 다시 호출하도록 안내한다. 알림은 화면에 그대로 남는다.

export function answerUserAsk(id, answer) {
  const aid = String(id), a = String(answer || "갔음");
  const own = askOwner.get(aid);
  if (!own || own.expired || askAnswers.has(aid)) return;
  // 이동 응답은 그 세션이 사용자를 기다리는 중이라는 표시다. 호출이 잠시 끊긴 사이에 눌려도
  // 다음 호출이 이 호출을 이어받아야 알림이 두 번 뜨지 않는다.
  if (a === "갔음") { own.went = true; askGoing.set(own.session, aid); }
  const p = pendingAsks.get(aid);
  if (p) p.resolve(a);
  else if (a !== "갔음") {
    // 호출 사이에 받은 답은 다음 호출에 전달하되 화면에서는 즉시 닫는다.
    askAnswers.set(aid, a);
    if (askGoing.get(own.session) === aid) askGoing.delete(own.session);
    broadcast({ type: "ai-ask-closed", id: aid, kind: own.kind, title: own.title, text: own.text });
  }
}

export function pendingUserNotices() {
  return [...askOwner.values()].filter((item) => !item.expired && !askAnswers.has(item.id)).map((item) => ({
    type: "ai-ask", id: item.id, kind: item.kind, tabId: item.tabId, space: item.space,
    session: item.session, where: item.device ? "app" : "tab", device: item.device || undefined,
    title: item.title, text: item.text, choices: item.choices, round: item.round,
    wait: item.deadline ? Math.max(0, Math.ceil((item.deadline - Date.now()) / 1000)) : 0,
    went: item.went, items: item.items, total: item.total, irreversible: item.irreversible,
    approveLabel: item.approveLabel, denyLabel: item.denyLabel,
  }));
}
// 사람에게 묻는 요청(ask·approve)은 그 세션 콘솔에서 묻는다(사용자 2026-10-28)
// 브라우저 알림 카드·macOS 알림·폰 알림을 띄우지 않고 바로 반환. AI 가 대화에서 묻고 답을 받음
export function consoleAsk(kind, text, choices) {
  const options = choices && choices.length ? ` (선택지: ${choices.join(" / ")})` : "";
  return { console: true, answered: false, question: text, ...(choices ? { choices } : {}),
    ...(kind === "approve" ? { approved: false } : { done: false, answer: null }),
    note: `사람에게 알림을 보내지 않았습니다. 지금 이 세션 대화에서 사용자에게 직접 물으세요: "${text}"${options}. 답을 받기 전에는 이 단계를 진행하지 마세요.` };
}
const notifyRecent = new Map();
const notifyKeys = new Map();
const progressItems = new Map();
function notifyUser(args, session) {
  const level = String(args?.level || "");
  const title = String(args?.title || "").trim().slice(0, 60);
  if (!["ok", "info", "warn", "err"].includes(level) || !title) {
    return { ok: false, error: "level(ok/info/warn/err)과 title이 필요합니다." };
  }
  const skey = String(session || "");
  const device = args?.device == null ? "" : String(args.device).trim();
  const requestedTab = args?.tab == null ? "" : String(args.tab).trim();
  if (device && requestedTab) return { ok: false, error: "tab과 device는 하나만 적어 주세요." };
  const tabId = requestedTab ? tabIdOfRef(requestedTab) : null;
  if (requestedTab && !tabId) return { ok: false, error: "관련 탭을 찾을 수 없습니다." };
  if (tabId && !tabAllowed(session, tabId).ok) return { ok: false, error: "이 세션이 쓸 수 있는 탭이 아닙니다." };
  // review: 사람이 확인할 화면을 띄운 탭. 그 탭으로 가는 단추가 알림의 목적이라 탭이 꼭 필요
  const review = args?.review === true;
  if (review && !tabId) return { ok: false, error: "review 알림은 확인할 화면을 띄운 tab이 필요합니다." };
  const now = Date.now();
  const recent = (notifyRecent.get(skey) || []).filter((item) => now - item.at < 10000);
  const key = args?.key ? skey + ":" + String(args.key).slice(0, 100) : "";
  const existing = key && notifyKeys.get(key);
  if (existing) {
    broadcast({ type: "ai-notify", id: existing, level, title, body: String(args.body || "").slice(0, 300),
      detail: String(args.detail || "").slice(0, 2000), session: skey, tab: tabId, device: device || undefined,
      ...(review ? { review: true } : {}) });
    return { ok: true, data: { id: existing, shown: "merged" } };
  }
  // "외 N건"으로 합치면 탭이 빠지므로 review 는 합치지 않음
  if (recent.length >= 3 && !review) {
    const last = recent[2];
    last.extra = (last.extra || 0) + 1;
    notifyRecent.set(skey, recent);
    broadcast({ type: "ai-notify", id: last.id, level: "info", title: `외 ${last.extra}건`,
      body: title, session: skey });
    return { ok: true, data: { id: last.id, shown: "merged" } };
  }
  const id = "notify-" + crypto.randomUUID();
  recent.push({ id, at: now, extra: 0 });
  notifyRecent.set(skey, recent);
  if (key) {
    notifyKeys.set(key, id);
    while (notifyKeys.size > 200) notifyKeys.delete(notifyKeys.keys().next().value);
  }
  broadcast({ type: "ai-notify", id, level, title, body: String(args.body || "").slice(0, 300),
    detail: String(args.detail || "").slice(0, 2000), session: skey, tab: tabId, device: device || undefined,
    ...(review ? { review: true } : {}) });
  return { ok: true, data: { id, shown: (review || level === "warn" || level === "err") && focusedUi.size === 0 ? "both" : "app",
    ...(review ? { tab: handleFor(tabId) || tabId } : {}) } };
}
function progressUser(args, session) {
  const op = String(args?.op || "");
  if (op === "start") {
    const title = String(args?.title || "").trim().slice(0, 300);
    if (!title) return { ok: false, error: "title이 필요합니다." };
    if (args.p != null && (!Number.isFinite(args.p) || args.p < 0 || args.p > 1)) return { ok: false, error: "p는 0~1입니다." };
    const ttl = args.ttl == null ? 120 : Number(args.ttl);
    if (!Number.isFinite(ttl) || ttl < 1) return { ok: false, error: "ttl은 1초 이상입니다." };
    const requestedTab = args?.tab == null ? "" : String(args.tab).trim();
    const tabId = requestedTab ? tabIdOfRef(requestedTab) : null;
    if (requestedTab && !tabId) return { ok: false, error: "관련 탭을 찾을 수 없습니다." };
    if (tabId && !tabAllowed(session, tabId).ok) return { ok: false, error: "이 세션이 쓸 수 있는 탭이 아닙니다." };
    const id = "progress-" + crypto.randomUUID();
    const timer = setTimeout(() => {
      if (!progressItems.has(id)) return;
      progressItems.delete(id);
      broadcast({ type: "ai-progress", op: "end", id, result: "warn", title: "응답 없음", detail: title });
    }, ttl * 1000);
    progressItems.set(id, { session: String(session || ""), timer, ttl, tabId });
    broadcast({ type: "ai-progress", op, id, title, p: args.p, ttl, session, tab: tabId });
    return { ok: true, data: { id } };
  }
  const id = String(args?.id || "");
  const item = progressItems.get(id);
  if (!item || item.session !== String(session || "")) return { ok: true, data: { ok: false } };
  if (op === "update") {
    if (args.p != null && (!Number.isFinite(args.p) || args.p < 0 || args.p > 1)) return { ok: false, error: "p는 0~1입니다." };
    clearTimeout(item.timer);
    item.timer = setTimeout(() => {
      progressItems.delete(id);
      broadcast({ type: "ai-progress", op: "end", id, result: "warn", title: "응답 없음" });
    }, item.ttl * 1000);
    broadcast({ type: "ai-progress", op, id, title: args.title == null ? undefined : String(args.title).slice(0, 300), p: args.p, ttl: item.ttl, session });
    return { ok: true, data: { ok: true } };
  }
  if (op === "end" && ["ok", "err"].includes(args.result)) {
    clearTimeout(item.timer); progressItems.delete(id);
    broadcast({ type: "ai-progress", op, id, result: args.result,
      title: args.title == null ? undefined : String(args.title).slice(0, 300),
      detail: args.detail == null ? undefined : String(args.detail).slice(0, 2000), session });
    return { ok: true, data: { ok: true } };
  }
  return { ok: false, error: "op(start/update/end)과 end의 result(ok/err)를 확인하세요." };
}
export function runBrowserCmd(cmd, args, session, noAutoTab, runId) {
  return new Promise((resolve) => {
    if (cmd === "newtab") { createTabForSession(args, session).then(resolve); return; }
    if (cmd === "closetab") { resolve(closeTabForSession(args, session)); return; }
    // MCP 앱 도구의 대상은 Iris 에뮬레이터 탭에 열린 기기뿐이다. 어느 탭이 이 세션 스페이스의 것인지는 여기서 표시한다.
    if (cmd === "app-devices") {
      askEmulator("list", {}, 5000).then((r) => {
        if (!r || r.ok === false) { resolve(r || { ok: false, error: "응답 없음" }); return; }
        const mine = sessionSpace(session);
        // 세션 소유 탭은 그 세션만의 것이다. 같은 스페이스의 다른 세션 탭을 mine 으로 보지 않는다.
        resolve({ ok: true, data: { space: mine, tabs: (r.tabs || []).map((t) => ({ ...t, qaRun: qaOwner("device:" + (t.persistentId || t.udid)),
          mine: t.owner ? t.owner === String(session || "") : !!mine && spaceKey.sameStorageSpace(t.space, mine) })) } });
      });
      return;
    }
    // 기기 안 앱의 화면 비율. 그 기기가 열린 에뮬레이터 탭이 처리한다(Electron 쪽 device-preview.cjs)
    if (cmd === "app-viewport") {
      askEmulator("viewport", { device: String((args && args.device) || ""), op: args && args.op === "apply" ? "apply" : "list",
        preset: typeof args?.preset === "string" ? args.preset : "" }, 15000)
        .then((r) => resolve(r && r.ok ? { ok: true, data: r.data } : (r || { ok: false, error: "응답 없음" })));
      return;
    }
    if (cmd === "app-open") {
      if (args?.additional && !session) { resolve({ ok: false, error: "추가 기기는 인증된 세션에서만 열 수 있습니다." }); return; }
      let reservedDevices;
      try {
        reservedDevices = [...new Set(Object.entries(readAppTargets())
          .filter(([pane]) => args?.additional || pane !== String(session || ""))
          .flatMap(([, devices]) => devices))];
      } catch (error) {
        resolve({ ok: false, error: `등록 기기 목록을 읽지 못했습니다: ${error.message}` }); return;
      }
      const wait = Math.min(Math.max(Number(args && args.wait) || 120000, 5000), 240000);
      // 세션이 있으면 그 세션 소유 탭에 연다. 새로 켜는 기기는 이 컴퓨터의 한도 안에서만 켠다.
      const capacity = session ? emulatorCapacity() : null;
      askEmulator("open", { space: sessionSpace(session), device: (args && args.device) || null, wait,
        reservedDevices, ...(args?.additional ? { additional: true } : {}),
        owner: session || null, limit: capacity ? capacity.limit : null, diskOk: capacity ? capacity.diskOk : true }, wait + 5000)
        // 자동으로 켠 기기는 등록하지 않는다. 할당은 사람의 지목과 app_target 뿐이고, 소유 탭이 닫히면 다음 호출이 새로 켠다.
        .then((r) => resolve(r && r.ok ? { ok: true, data: r }
          : r && r.code === "capacity" ? { ...r, data: { capacity } } : (r || { ok: false, error: "응답 없음" })));
      return;
    }
    const local = runSessionCmd(cmd, args, session, runId);
    if (local) { resolve(local); return; }
    resolve({ ok: false, error: "브라우저 실행 명령은 MCP 작업 프로세스에서 처리합니다." });
  });
}
