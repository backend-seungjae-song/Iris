import { execFileSync } from "node:child_process";
import { noteEmulatorReply } from "./emulator-bridge.js";

import {
  answerUserAsk,
  execOnWc,
  noteAppPick,
  noteBrowserPick,
} from "./browser-commands.js";
import {
  groups as spGroups,
  mutate as bsMutate,
  tabs as spTabs,
  wire as bsWire,
} from "./browser-state-owner.js";
import {
  addPin,
  adoptGroup,
  answerDialogAsk,
  broadcastAiTargets,
  broadcastTabHandles,
  designateGroup,
  designateTab,
  designatedHandles,
  dropPin,
  endChat,
  getPickMode,
  grantTab,
  groupHandleFor,
  groupTabIds,
  handleFor,
  hasTab,
  metaOfWc,
  noteChatTab,
  persistGrants,
  regTab,
  registerCdpExecutor,
  closedTabsWire,
  recordClosedTab,
  removeClosedTab,
  takeClosedTab,
  resolveCdpResult,
  resolveTabWcWaiters,
  setActiveTab,
  setDialogPlan,
  setFrameOrigins,
  setLastTab,
  setPickModeState,
  setProfiles,
  setTabDialog,
  tabCount,
  tabGroupOf,
  tabIdOfWc,
  tabIsShowing,
  tabMeta,
  uiTokenOk,
  unregisterGoneTab,
  wcOfTabId,
} from "./browser-runtime.js";

// browser-sync와 브라우저/CDP WebSocket inbound 분기의 단일 소유 모듈.
//
// 소유 범위
//   browser-state mutation gate와 pick/ask/profile/auth/grant/pick-mode/CDP/dialog/tab 등록·회수 분기.
//
// 제공 API
//   initBrowserMessageHandlers, handleBrowserSync와 exact browser message 공용 handler.
//   원시 상태 컨테이너는 노출하지 않고 모든 mutation을 각 owner 함수로 요청한다.
//
// 의존 대상
//   browser-runtime·browser-state-owner·browser-commands owner와 node child-process에 의존하며,
//   broadcast는 composition root에서 주입받고 transport나 다른 handler를 import하지 않는다.
//
// 유지 조건
//   로컬/UI gate, browser-sync 원격 차단 op, 분기 순서와 ACK/broadcast 타이밍,
//   popup owner 상속·dialog fallback·CDP executor 위조 차단·tab wc 등록/회수 조건을 보존한다.
//
// 영향 범위
//   server/index.js의 exact WebSocket dispatch와 browser-commands/browser-runtime owner,
//   web browser/pick/dialog/profile 발신자, bin/smoke.mjs browser inbound 소유·연결 검사.

let broadcast;
let broadcastLocal;

export function initBrowserMessageHandlers(deps) {
  broadcast = deps.broadcast;
  broadcastLocal = deps.broadcastLocal;
}

const REMOTE_BLOCKED_OPS = new Set(["tab.open", "tab.close", "dock", "tab.profile", "tab.rename", "tab.move", "bookmark.move",
  "profiles.set", "profile.add", "profile.rename", "profile.remove", "profile.source", "space.defaultProfile"]);
export function handleBrowserSync(ws, msg) {
  const m = msg && msg.mutation;
  if (!m || typeof m.op !== "string") return;
  if (!ws._local && REMOTE_BLOCKED_OPS.has(m.op)) {
    ws.send(JSON.stringify({ type: "control-error", message: "원격에서는 브라우저 탭 생성/도킹 불가(AC5)" }));
    return;
  }
  if (m.op === "tab.close" && m.id) {
    // 복원에 필요한 값은 여기서만 확보할 수 있다. 아래 bsMutate 가 실행되면 주소·프로필·그룹이 상태에서
    // 사라진다. 닫기는 전부 이 한 지점으로 모이므로(브라우저 탭바·센터 탭·⌃W·컨텍스트 메뉴)
    // 여기 하나만 잡으면 빠지는 경로가 없다.
    if (recordClosedTab(m.id, m.navigationHistory)) broadcast(closedTabsWire());
    removeClosedTab(m.id);
  }
  if (bsMutate(m)) broadcast({ type: "browser-state", state: bsWire() });
}

// ⌘⇧T: 방금 닫은 브라우저 탭을 복원한다. 무엇을 복원할지는 창이 정해 tabId 로 보내고
// (센터 탭과 섞여 있어 더 최근 것이 무엇인지는 창만 안다), 서버는 그 항목을 스택에서 빼고 연다.
export function handleTabReopen(ws, msg) {
  // 원격에서는 탭을 만들지 않는다. tab.open 이 REMOTE_BLOCKED_OPS 인 것과 같은 경계다.
  if (!ws._local) return;
  const entry = takeClosedTab(msg && msg.tabId ? String(msg.tabId) : null);
  if (!entry) return;
  // 원래 id 그대로 복원한다. 새 id 를 매기면 북마크·이력에서 같은 탭이 둘로 보인다.
  const mutation = { op: "tab.open", space: entry.space, id: entry.tabId, url: entry.url, title: entry.title };
  // profile 키는 있으면 값이 유효해야 하고(null 이면 tab.open 이 거부된다), 없으면 키를 뺀다.
  if (entry.profile != null) mutation.profile = entry.profile;
  if (entry.group) mutation.group = entry.group;
  if (entry.kind) { mutation.kind = entry.kind; if (entry.path) mutation.path = entry.path; }
  if (bsMutate(mutation)) {
    // pageState는 폼 상태를 포함할 수 있다. 로컬 창에만, 새 탭을 만들게 하는 state보다 먼저 보내
    // webview가 첫 URL을 탐색하기 전에 꺼내 쓸 수 있게 한다.
    if (entry.navigationHistory) broadcastLocal({
      type: "tab-reopen-history", tabId: entry.tabId, history: entry.navigationHistory,
    });
    broadcast({ type: "browser-state", state: bsWire() });
  }
  broadcast(closedTabsWire());
}

export function handleBrowserMessage(ws, msg) {
  if (msg.type === "ai-pick") {
    if (ws._local && msg.pane && msg.pick) noteBrowserPick(msg.pane, msg.tabId, msg.pick);
  }
  // 앱에서 고른 요소의 원본. 어느 세션에 붙일지는 창이 안다(사용자가 보고 있는 세션). 그래서
  // 서버가 선택을 먼저 알아도 기록은 창을 거쳐 들어온다. 브라우저 픽과 같은 순서다.
  else if (msg.type === "ai-app-pick") {
    if (ws._local && msg.pane && msg.pick) noteAppPick(msg.pane, msg.pick);
  }
  // 앱 대상 호출의 이동 처리. 시뮬레이터를 앞으로 가져오는 것까지가 가능한
  // 범위다. simctl에는 특정 기기 창만 띄우는 명령이 없고, 부팅된 기기가 그 창에 있다.
  // Android 기기(adb 시리얼, UUID 모양이 아니다)는 가져올 창이 없어 Simulator 를 열지 않고 안내만 한다.
  else if (msg.type === "focus-app") {
    if (ws._local && msg.device && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(msg.device))) {
      try { ws.send(JSON.stringify({ type: "toast", text: `Android 기기(${String(msg.device).slice(0, 40)}) 화면에서 진행하세요. 창을 앞으로 가져오지 못합니다.` })); } catch {}
    }
    else if (ws._local) {
      try { execFileSync("open", ["-a", "Simulator"], { timeout: 4000 }); }
      catch (e) { try { ws.send(JSON.stringify({ type: "toast", text: "시뮬레이터를 앞으로 못 가져왔습니다: " + String(e.message || e) })); } catch {} }
    }
  }
  else if (msg.type === "emulator-reply") {
    if (ws._local) noteEmulatorReply(msg);
  }
  else if (msg.type === "ai-ask-answer") {
    if (ws._local && msg.id) answerUserAsk(msg.id, msg.answer);
  }
  else if (msg.type === "browser-profiles") {
    if (ws._local && Array.isArray(msg.profiles)) {
      setProfiles(msg.profiles);
    }
  }
  else if (msg.type === "ui-auth") { ws._ui = !!(ws._local && uiTokenOk(msg.token)); try { ws.send(JSON.stringify({ type: "ui-auth", ok: !!ws._ui })); } catch {} }
  else if (msg.type === "chat-submitted") {
    // 사용자가 프롬프트를 제출했다 = 이 얘기가 끝났다. 다음 지목부터는 새 대상이다.
    if (ws._local && msg.pane) endChat(msg.pane);
  }
  else if (msg.type === "browser-target-set") {
    // 사용자가 앱에서 직접 지목한 것만 스페이스 경계를 넘을 수 있다(공유 창 포함). AI는 이 경로를 못 쓴다.
    // 창은 wc로 지정해 보내지만 서버는 받는 즉시 정체성으로 바꾼다. 지목은 오래 유지되는 값이라
    // 그 순간의 번호로 보관하면 앱이 재시작할 때 사라진다.
    const pickedId = msg && msg.tabId ? msg.tabId : tabIdOfWc(msg && msg.wc);
    // 요소 선택과 탭 지목은 다른 동작이다. 요소 선택은 이 탭의 특정 요소를 보라는 뜻이지
    // 앞으로 이 탭에서 작업하라는 뜻이 아니다. 둘을 같은 경로로 처리하면 요소를 고를 때마다
    // 제어 대상이 그 탭으로 넘어가고 지목 알림도 함께 붙는다. 요소 선택은
    // 쓸 수 있게 등록만 하고(권한), 고정은 사용자가 탭을 직접 지목했을 때만 한다.
    const byPick = msg && msg.via === "pick";
    if (ws._local && ws._ui && msg.pane && pickedId && hasTab(pickedId)) {
      // 권한과 대상은 다르다. 요소 선택은 권한만 부여해 그 탭을 조작할 수 있게 하지만,
      // 지정 없는 명령의 대상(lastTab)은 그대로 둔다. 여기서 lastTab까지 옮기면
      // 요소 하나를 고를 때마다 다음 무지정 명령과 화면의 사용 탭 표시가 그 탭으로 넘어간다.
      // 권한만으로도 그 탭은 held에 들어가 보호되고(heldTabsOf), 세션에 제 탭이 하나도 없으면
      // 지목받은 탭이 대상이 되므로 대상을 미리 옮길 이유가 없다.
      if (byPick) { noteChatTab(msg.pane, pickedId); grantTab(msg.pane, pickedId); broadcastAiTargets(); }
      else { designateTab(msg.pane, pickedId); addPin(msg.pane, pickedId); setLastTab(String(msg.pane), pickedId); persistGrants(); }
      // 핸들은 서버가 발급한다. 창이 아는 wc 숫자를 붙이면 터미널에서 부를 수 없는 이름이 남는다.
      // 요소 선택에는 이 알림을 보내지 않는다. 선택 블록이 이미 등록 사실과 핸들을 담고 있다.
      if (!byPick) {
        const meta = tabMeta(pickedId) || {};
        const t = spTabs(meta.space).find((x) => x.id === pickedId);
        try { ws.send(JSON.stringify({ type: "tab-granted", pane: msg.pane,
          handle: handleFor(pickedId), name: (t && t.name) || "",
          title: meta.title || "", url: meta.url || "",
          all: designatedHandles(msg.pane) })); } catch {}
      }
    }
  }
  // 그룹 단위 지목. 탭을 하나씩 지정하는 방식은 그룹 단위 작업과 맞지 않는다. 이 경로도
  // 로컬 UI 전용이다. AI는 스스로 권한을 넓힐 수 없다.
  else if (msg.type === "browser-group-grant") {
    if (ws._local && ws._ui && msg.pane && msg.space && msg.group) {
      designateGroup(msg.pane, msg.space, msg.group);
      adoptGroup(msg.pane, msg.space, msg.group); // 이제 이 그룹이 이 세션의 그룹이다
      // 그룹을 지목했는데 탭 하나에 고정하면 그룹 안에서 여러 탭을 쓸 수 없다.
      // 이전 고정을 풀고, 대신 그룹의 첫 탭에서 시작하게 둔다(고정 없이 그룹 안에서 고름).
      dropPin(msg.pane, null);
      const firstId = groupTabIds(String(msg.space), String(msg.group)).find((id) => wcOfTabId(id));
      if (firstId) setLastTab(String(msg.pane), firstId);
      persistGrants();
      broadcastAiTargets();
      // 핸들은 서버가 발급한다. 창이 임의로 만들면 실제로 부를 수 없는 이름이 붙는다.
      const g = spGroups(String(msg.space)).find((x) => x.id === String(msg.group));
      try { ws.send(JSON.stringify({ type: "group-granted", pane: msg.pane, space: msg.space, group: msg.group,
        handle: groupHandleFor(String(msg.space), String(msg.group)), label: (g && g.name) || String(msg.group),
        // 이름은 사용자가 직접 붙인 것만 보낸다. 페이지 제목은 계속 바뀌므로 이름이 아니다.
        // 안 붙였으면 빈 값으로 두고 핸들만 남긴다.
        tabs: groupTabIds(String(msg.space), String(msg.group)).map((id) => {
          const h = handleFor(id); if (!h) return null;
          const t = spTabs(String(msg.space)).find((x) => x.id === id);
          // 이름(사용자 지정)은 그대로 두고, 현재 그 탭이 무엇인지는 주소로 전달한다. 핸들만 보내면
          // 받는 쪽이 어느 탭인지 알 수 없어 목록을 한 번 더 호출하게 되므로 그 왕복을 없앤다.
          const live = tabMeta(id) || {};
          return { handle: h, name: (t && t.name) || "", url: live.url || (t && t.url) || "",
            showing: tabIsShowing(live.space, id) };
        }).filter(Boolean) })); } catch {}
    }
  }
  // 메모가 디스크에 저장됐음을 보낸 창에 알린다. 그래야 저장 상태를 실제 결과로 표시할 수 있다.
  
  // 요소 선택 모드. 창이 직접 전환하지 않고 서버에 요청하며, 전환은 이 한 곳에서만 일어난다.
  else if (msg.type === "pick-mode") {
    if (!ws._local) return;
    const want = msg.op === "toggle" ? !getPickMode() : !!msg.on;
    // 고를 대상이 없으면 켜지 않는다. 창별로 하던 안내를 이 한 곳으로 모았다.
    if (want && tabCount() === 0 && !msg.hasSheetContext && !msg.hasDocxContext) { ws.send(JSON.stringify({ type: "control-error", message: "브라우저 탭을 먼저 열어주세요." })); return; }
    setPickModeState(want);
  }
  else if (msg.type === "cdp-executor-register") {
    if (!ws._local) { /* 원격은 실행기가 될 수 없다 */ }
    else registerCdpExecutor(ws, msg);
  }
  else if (msg.type === "cdp-result") { resolveCdpResult(ws, msg); } // 실행기 소켓(로컬 등록)만 결과를 발급해 원격 WS의 위조 결과를 차단한다
  // 렌더러가 (스페이스, 활성 브라우저 탭)을 보고한다. 받는 즉시 정체성으로 변환한다. 활성 표시는
  // 오래 유지되는 값이라 wc로 두면 재발급된 번호가 다른 탭을 활성으로 만든다.
  else if (msg.type === "browser-active-wc") { if (ws._local && msg.wc && msg.space) { const id = msg.tabId || tabIdOfWc(msg.wc); if (id) setActiveTab(msg.space, id); } }
  // 탭별 wc 등록/해제. 세션 고정 대상의 생존 판정과 탭 목록의 유일한 소스다.
  // 대화상자(alert/confirm)는 창에 붙는 시트다. 다른 탭을 보고 있으면 관계없는 페이지 위에 뜨고
  // 그 창 전체가 막힌다. 어느 탭의 요청인지 알려야 사용자가 그 탭으로 이동할 수 있다.
  // AI 자동완성 로그인. 사용자가 모르는 사이에 실행되지 않도록 그때마다 알린다. 채웠으면 무엇을
  // 채웠는지, 못 했으면 왜 못 했는지(저장된 계정 없음 / 허용 안 됨)와 그 탭으로 가는 길을 준다.
  else if (msg.type === "ai-login-note") {
    const id0 = tabIdOfWc(msg.wc); const m = id0 ? tabMeta(id0) : null;
    broadcast({ type: "ai-login-note", kind: msg.kind, origin: msg.origin || "",
      username: msg.username || null, accounts: msg.accounts || null,
      wc: Number(msg.wc), tabId: id0, space: (m && m.space) || null });
  }
  // 대화상자 자동 응답 무장. 지금 alert/confirm 은 주입한 shim 이 여기로 물어보는 형태라,
  // 무장을 서버가 알아야 사람 없이 답할 수 있다(브라우저의 네이티브 창 경로는 더 이상 안 탄다).
  else if (msg.type === "browser-dialog-plan") {
    if (ws._local && msg.wc) {
      const wcN = Number(msg.wc);
      setDialogPlan(wcN, msg.plan, msg.text);
    }
  }
  else if (msg.type === "browser-frame-origins") {
    // 그 탭이 띄우고 있는 문서들의 origin. /dialog-ask 사칭 검사에서 쓴다.
    if (ws._local && msg.wc) {
      setFrameOrigins(msg.wc, msg.origins);
    }
  }
  else if (msg.type === "browser-dialog-open" || msg.type === "browser-dialog-closed") {
    if (ws._local && msg.wc) {
      const wc = Number(msg.wc);
      const open = msg.type === "browser-dialog-open";
      const m = setTabDialog(wc, open, msg.kind, msg.message);
      // 이 확인 창은 탭이 아니라 창에 붙는 시트다. 사용자가 보고 있는 탭이 아니면 관계없는 페이지
      // 위에 떠서 그 창 전체를 막는다. 그렇다고 대신 닫으면 안 된다. 무엇을 묻는지
      // 읽고 선택하는 것이 요구사항이다. 그래서 화면을 해당 탭으로 옮기고 내용을 그대로 전달한다.
      const visible = m ? tabIsShowing(m.space, tabIdOfWc(wc)) : false;
      // byAi 는 그대로 전달한다. 창은 이 값으로 커서를 가져갈지 정한다. 사용자가 눌러 뜬 창은
      // 커서를 받아야 하고, AI 조작 중에 뜬 창은 사용자가 입력 중인 위치에서 커서를 가져가면 안 된다.
      broadcast({ type: "browser-dialog", wc, open, visible, space: (m && m.space) || null,
        kind: msg.kind || "alert", message: String(msg.message || "").slice(0, 200),
        byAi: !!msg.byAi });
    }
  }
  // 앱 안에서 고른 답(네/아니오/입력)을 그 탭의 페이지에 전달한다. 큐를 우회하는 명령이라
  // 그 탭의 다른 명령이 이 질문에 막혀 있어도 답이 먼저 들어간다.
  else if (msg.type === "browser-dialog-answer") {
    if (ws._local && msg.wc) {
      const wc = Number(msg.wc);
      setTabDialog(wc, false);
      // 가로챈 질문(동기 XHR로 대기 중)이 있으면 해제한다. 페이지가 그 값을 받아 계속 진행한다.
      const served = !!answerDialogAsk(wc, msg.answer === "ok" ? "ok" : "cancel", msg.text);
      // 가로채기 이전 경로(네이티브 대화상자)가 남아 있으면 그쪽으로 답한다.
      if (!served) execOnWc("dialog", { answer: msg.answer === "ok" ? "ok" : "cancel", ...(msg.text != null ? { text: String(msg.text) } : {}) }, wc).catch(() => {});
      broadcast({ type: "browser-dialog", wc, open: false });
    }
  }
  else if (msg.type === "browser-tab-wc") {
    if (ws._local && msg.wc) {
      const wc = Number(msg.wc);
      // 같은 탭의 이전 등록은 버린다. webview를 다시 만들면 wc가 새로 발급되므로, 회수가 늦거나
      // 누락되면 유효하지 않은 wc가 목록에 남아 같은 탭이 둘로 보인다.
      // 정체성이 없는 등록은 받지 않는다. 식별할 수 없는 탭은 목록에도 대상에도 쓸 수 없다.
      if (!msg.tabId) return;
      const first = !hasTab(msg.tabId);
      const meta = { wc, url: msg.url || "", title: msg.title || "" };
      if (first) {
        // 팝업은 이동·제목 변경 때마다 다시 등록된다(코드 경로 확인). opener의 wc는
        // 그사이 다른 탭에 재발급될 수 있으므로 소유권은 첫 등록에서만 찍고, 뒤 등록은 regTab
        // 병합으로 그대로 보존한다.
        let space = msg.space || null;
        const openerTabId = msg.openerWc ? tabIdOfWc(msg.openerWc) : null;
        const opener = msg.openerWc ? metaOfWc(msg.openerWc) : null;
        if (!space && opener) space = opener.space || null;
        meta.space = space;
        meta.win = msg.win || null;
        if (openerTabId && opener) {
          meta.openerTabId = openerTabId;
          meta.ownerSpace = opener.space || null;
          const ownerGroup = opener.space ? tabGroupOf(opener.space, openerTabId) : null;
          // 그룹이 없는 사용자가 연 팝업까지 AI가 자동으로 얻으면 안 되므로, 소유 그룹이 있을 때만 상속한다.
          if (ownerGroup) meta.ownerGroup = ownerGroup;
        }
      }
      regTab(msg.tabId, meta);
      broadcastTabHandles();
      resolveTabWcWaiters(msg.tabId, msg.wc);
    }
  }
  // webview가 사라진 것은 그 탭의 실행 핸들만 없어진 것이다. 지목·고정은 정체성으로 유지하므로
  // 일반 탭은 건드리지 않는다. 팝업은 browserState의 tab.close를 타지 않아 gone이 실제 종료다.
  else if (msg.type === "browser-tab-gone") {
    if (ws._local && (msg.tabId || msg.wc)) {
      const tabId = msg.tabId || tabIdOfWc(msg.wc);
      unregisterGoneTab(tabId, msg.wc);
    }
  }
}
