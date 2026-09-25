// Iris 서버. herdr 관제와 조종(채팅·요소 선택), 원격(폰) 접속을 담당한다.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { stateHome } from "./state-home.cjs";
import { readHiddenSync } from "./feature-state-read.cjs";
import { createCapabilityHost } from "./capabilities.js";

// 상태 폴더. 개발 인스턴스와 설치된 앱이 같은 폴더를 쓰면 개발 회차의 QA 장부·매크로·탭
// 기록이 설치된 앱의 것과 섞여, 각 기록이 어느 환경의 것인지 구분할 수 없다.
// 어디인지는 state-home.cjs 한 곳이 정한다.
const IRIS_HOME = stateHome();
import { WebSocketServer } from "ws";
import { initWsTransport, attachWs, broadcast, broadcastLocal, startHeartbeat } from "./ws-transport.js";
import { HerdrClient } from "./herdr.js";
import { PtyManager } from "./pty.js";
import {
  handleQaSessionCmd,
  noteRunAccepted,
  noteRunEvent,
  noteTrace,
  runSurfaces,
} from "./qa-journal.js";
import * as archive from "./archive.js";
import { handleArtifacts, initArtifactsHandlers } from "./artifacts-handlers.js";
import { humanPathDeny } from "./human-path.js";
import { bulkPolicy } from "./bulk-fill.js";
import * as spaceKey from "./space-key.js";
import { handleSheetRead, handleSheetWrite } from "./sheet-handlers.js";
import { handleDocxRead, handleDocxWrite } from "./docx-handlers.js";
import {
  closeFsClient,
  handleFs,
  handleFsOp,
  handleFsRead,
  handleFsTree,
  handleFsWatch,
  handleFsWrite,
} from "./fs-handlers.js";
import { port as acPort } from "./env.cjs";
import {
  initRuntimeState,
  snapshot,
  isPathAllowed as fsPathAllowed,
  replace,
  requestRecompute as recompute,
} from "./runtime-state.js";
import {
  initBrowserStateOwner,
  tabs as spTabs,
  groups as spGroups,
  mutate as bsMutate,
  wire as bsWire,
  spaceKeysWire,
  migrateSpaceKeys,
  publishProjectionIfChanged,
  flushNow as flushBrowserStateNow,
} from "./browser-state-owner.js";
import {
  flushNow as flushMemoNow,
} from "./memo-service.js";
import {
  initBrowserRuntime,
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
  designateGroup,
  designateTab,
  designatedHandles,
  dialogPlanText,
  disconnectCdpExecutor,
  dropPin,
  endChat,
  ensureSessionGroup,
  flushNow as flushBrowserRuntimeNow,
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
  openDialogAsk,
  persistGrants,
  pinsOf,
  plannedAnswer,
  primaryPin,
  profileNames,
  profileRefToId,
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
  uiTokenOk,
  unregisterGoneTab,
  visibleTabsFor,
  waitForTabWc,
  wcOfTabId,
} from "./browser-runtime.js";
import {
  buildSpaceRecoveryEvidence,
  buildWorkspaceSnapshot,
  initWorkspaceRuntime,
  startWorkspaceRuntime,
} from "./workspace-runtime.js";
import {
  answerUserAsk,
  execOnWc,
  initBrowserCommands,
  noteAppPick,
  noteBrowserPick,
  runBrowserCmdResilient,
} from "./browser-commands.js";
import {
  handleBrowserMessage,
  handleBrowserSync,
  handleTabReopen,
  initBrowserMessageHandlers,
} from "./browser-message-handlers.js";
import {
  HOST,
  PORT,
  REMOTE,
  connectionAllowed,
  createHttpHandler,
  hardenHeaderParsing,
  isLoopbackRequest,
  selfTailscaleIps,
} from "./http-handler.js";
import { initKeymapStore, keymapWire, resetKeymap, setKeymapOverride } from "./keymap-store.js";
import { handleSpace, handleTab, initWorkspaceHandlers } from "./workspace-handlers.js";
import {
  closeHerdrClient,
  handleControl,
  handleFocus,
  handlePty,
  handleTabClose,
  handlePaneClose,
  handleTabFocus,
  initHerdrHandlers,
  relayToOneConsole,
} from "./herdr-handlers.js";

// ── 상태 폴더의 단일 소유자 ─────────────────────────────────────────
// 포트가 겹쳐도 바인딩이 항상 충돌하지는 않는다. 하나가 `0.0.0.0`, 하나가 `127.0.0.1`이면 둘 다
// 실행된다. 그러면 서버가 둘이고, 둘 다 같은 상태 파일에 자기 상태를 쓴다. 나중에 실행된 쪽이
// 사용자의 최신 상태를 갖고 있어도 먼저 실행된 쪽이 오래된 상태로 덮어쓴다(확인 결과: 종료되지
// 않은 서버 프로세스가 복원해 둔 계정·검색 기록·탭을 반복해서 지웠다). 그래서 파일을 쓰는 권한은
// 하나여야 하고, 그 권한은 포트가 아니라 상태 폴더에 건다.
//
// 이 블록은 상태를 읽는 코드보다 먼저 와야 한다. 뒤에 두면
// 기다리는 서버가 T0의 상태를 이미 메모리에 담은 채 기다린다. 그 사이 앞 서버에서 사용자가
// 탭을 옮기고 북마크를 더하면 그것은 디스크에 저장되지만, 자리를 이어받은 쪽은 다시 읽지
// 않는다. 그 뒤 첫 변경에서 T0 스냅샷 전체가 저장되어 그 사이의 일이 통째로 사라진다.
// 권한을 먼저 얻고 그다음에 읽으면 그 구간이 생기지 않는다.
const LOCK_PATH = path.join(IRIS_HOME, "server.lock");

// 반환: null=획득 / 숫자=그 pid가 보유 / -1=알 수 없음(그래도 대기한다)
//
// 잠금을 얻는 방법은 link 하나뿐이다. 유효하지 않은 잠금을 만나도 삭제 후 다시 link 한다.
// 삭제는 여럿이 시도해도 되지만 link는 하나만 성공하기 때문이다. 유효하지 않은 잠금을
// rename으로 덮고 자기 pid를 읽어 확인하면, 여러 프로세스가 차례로 덮고 읽어 모두 자기 값을 읽고
// 모두 성공한다. 그러면 여러 서버가 같은 상태 파일을 쓴다.
// 그 pid가 정말 이 서버인가. pid는 재사용되므로 번호만으로는 알 수 없다.
function pidIsThisServer(pid) {
  if (!pid) return false;
  try {
    const cmd = execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim();
    return cmd.includes("server/index.js");
  } catch { return false; }
}

function claimStateDir(attempt = 0) {
  try { fs.mkdirSync(IRIS_HOME, { recursive: true }); } catch {}
  // 내용이 다 담긴 파일을 만들어 두고 link로 건다. link는 이미 있으면 EEXIST로 실패하므로
  // 자리를 차지하는 것과 누구인지 적는 것이 한 동작이 된다.
  //
  // 만든 뒤에 쓰는 방식(openSync "wx" → writeSync)으로는 부족하다. 그 사이 파일이 비어 있고,
  // 그때 다른 서버가 읽으면 pid가 0으로 보여 유효하지 않은 잠금으로 판단하고 가져간다.
  // 확인 결과: 서버 둘을 동시에 실행하면 둘 다 잠금을 획득했다고 판단했다.
  const tmp = `${LOCK_PATH}.${process.pid}`;
  const dropTmp = () => { try { fs.unlinkSync(tmp); } catch {} };
  try { fs.writeFileSync(tmp, String(process.pid)); } catch { dropTmp(); return -1; }
  try {
    fs.linkSync(tmp, LOCK_PATH);
    dropTmp();
    return null;
  } catch (e) {
    if (!e || e.code !== "EEXIST") {
      // 잠금을 걸지 못한 경우다(권한·I/O). 여기서 획득으로 처리하면 서버 둘이 같은 파일을
      // 쓰게 되므로, 알 수 없을 때는 획득하지 못한 것으로 처리한다.
      dropTmp();
      return -1;
    }
  }
  let prev = 0;
  try { prev = Number(String(fs.readFileSync(LOCK_PATH, "utf8")).trim()); } catch { dropTmp(); return -1; }
  if (prev === process.pid) { dropTmp(); return null; }
  if (prev) {
    // pid만 보면 안 된다. pid는 재사용되므로, 잠금을 남기고 종료된 뒤 그 번호를 다른 프로그램이
    // 사용하면 서버가 계속 실행되지 못한다(launchd가 KeepAlive로 반복 실행한다). 그 번호가
    // 실제로 이 서버인지까지 확인하고, 아니면 유효하지 않은 잠금으로 보고 가져온다.
    if (pidIsThisServer(prev)) { dropTmp(); return prev; }
  }
  // 유효하지 않은 잠금은 제거하고 처음부터 다시 건다. 제거 권한은 하나에게만 준다.
  dropTmp();
  if (attempt >= 3) return -1;   // 계속 실패하면 대기한다. 강제로 가져오지 않는다
  if (!reapDeadLock(prev)) return -1;   // 치우지 못했으면 기다린다
  return claimStateDir(attempt + 1);
}

// 유효하지 않은 잠금을 제거할 권한은 한 번에 하나에게만 준다.
//
// 단순히 unlink로 제거하면 A와 B가 같은 무효 잠금을 읽는 상황이 생긴다. A가 먼저 제거하고
// 자기 잠금을 걸어 소유자가 되는데, B는 여전히 무효로 알고 있어 다음 unlink로
// A의 유효한 잠금을 지운다. 그 뒤 자기 잠금을 걸어 둘 다 소유자가 되고, 두 서버가 같은 상태
// 파일에 서로의 상태를 쓴다. 이 블록이 막으려는 상황이 그것이다.
// (확인 결과: 검사에서 고정 4초 대기를 제거하고 결과를 촘촘히 관찰하자 재현됐다.)
//
// 배타 파일로 제거 권한을 하나로 제한하면 이 구간이 닫힌다. 권한을 가진 하나만 unlink 하고,
// 나머지는 link가 EEXIST로 막혀 그동안 아무도 잠금을 걸 수 없다. 권한을 얻은 뒤에도
// 그 잠금이 여전히 무효인지 다시 확인한다.
function reapDeadLock(deadPid) {
  const reap = `${LOCK_PATH}.reap`;
  let fd = null;
  try {
    fd = fs.openSync(reap, "wx");
  } catch (e) {
    if (!e || e.code !== "EEXIST") return false;
    // 제거하던 프로세스가 종료돼 표시 파일만 남았을 수 있다. 그 소유자가 살아 있지 않으면 제거하고,
    // 이번에는 제거하지 않는다. 다음 시도에서 다시 경쟁한다.
    let owner = 0;
    try { owner = Number(String(fs.readFileSync(reap, "utf8")).trim()); } catch {}
    if (!owner || !pidIsThisServer(owner)) { try { fs.unlinkSync(reap); } catch {} }
    return false;
  }
  try {
    try { fs.writeSync(fd, String(process.pid)); } catch {}
    try { fs.closeSync(fd); } catch {}
    fd = null;
    // 표시 파일을 얻는 사이에 다른 프로세스가 새 잠금을 걸었다면 제거 대상이 아니다.
    let now = 0;
    try { now = Number(String(fs.readFileSync(LOCK_PATH, "utf8")).trim()); }
    catch { return true; }   // 이미 없으면 다른 프로세스가 제거한 것이므로 다시 시도한다
    if (now !== deadPid) return false;
    try { fs.unlinkSync(LOCK_PATH); } catch { return false; }
    return true;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(reap); } catch {}
  }
}
// 잠금이 이미 잡혀 있으면 종료하지 않고 대기한다. 여기서 exit(1) 하면 launchd가
// KeepAlive로 10초마다 다시 실행해 같은 거절이 반복된다(확인 결과: 실행 6,957회,
// server.log 18,175줄 중 13,675줄이 같은 두 문장이었고 그동안 관리 대상 서버는 실행되지 못했다.
// 잠금을 쥔 것은 먼저 실행된 고아 프로세스였고, 이후 모든 수정이 반영되지 않았다).
// 대기하면 로그가 쌓이지 않고 재시작 반복이 멈추며,
// 앞 서버가 종료되는 즉시 수동 조작 없이 잠금을 이어받는다.
const LOCK_WAIT_MS = Math.max(1000, Number(process.env.IRIS_LOCK_WAIT_MS || 5000));
let lockHolder = claimStateDir();
if (lockHolder) {
  const who = lockHolder === -1 ? "알 수 없음" : `pid ${lockHolder}`;
  console.error(`이미 다른 Iris 서버가 이 상태 폴더를 쓰고 있습니다(${who}, ${IRIS_HOME}).`);
  console.error(`둘이 같이 뜨면 서로의 상태를 덮어씁니다 — 그쪽이 내려가면 이어받습니다. 여기서 기다리며, 같은 말을 다시 적지 않습니다.`);
  const waitStart = Date.now();
  while (lockHolder) {
    await new Promise((r) => setTimeout(r, LOCK_WAIT_MS));
    lockHolder = claimStateDir();
  }
  console.log(`앞 서버가 내려가 자리를 이어받았습니다(${Math.round((Date.now() - waitStart) / 1000)}초 기다림).`);
}

// 잠금을 얻은 뒤에 읽는다. 순서가 바뀌면 대기 중인 서버가 T0 스냅샷을 유지한 채 기다리다가
// 자리를 이어받은 뒤 그 사이의 변경을 덮는다. 두 모듈 다 import 시점에는 아무것도 읽지 않는다.
spaceKey.load();     // 스페이스↔폴더 결속 키. 다른 상태가 이 키를 주소로 쓰므로 먼저 로드한다.
initBrowserStateOwner({
  broadcast: (message) => broadcast(message),
  getRecoveryEvidence: (workspaces) => buildSpaceRecoveryEvidence(workspaces),
}); // 브라우저 공유 상태는 lock 획득 뒤에 복원한다

const shutdownCapabilities = [], exitCapabilities = [];
const capabilityContext = {
  broadcast: (message) => broadcast(message),
  broadcastLocal: (message) => broadcastLocal(message),
  visitClients: (visitor) => { for (const client of wss.clients) visitor(client); },
  onShutdown: (callback) => shutdownCapabilities.push(callback),
  onExit: (callback) => exitCapabilities.push(callback),
};
const capabilityHost = createCapabilityHost(readHiddenSync(IRIS_HOME), capabilityContext);
capabilityHost.init(true); // 스페이스 키 이관 참여자는 저장소 초기화 위치에 둔다.

initBrowserRuntime({
  broadcast: (message) => broadcast(message),
  getHerdr: () => herdr,
  relayToOneConsole: (message) => relayToOneConsole(message),
});

initBrowserCommands({ broadcast: (message) => broadcast(message) });
initBrowserMessageHandlers({
  broadcast: (message) => broadcast(message),
  broadcastLocal: (message) => broadcastLocal(message),
});

const server = hardenHeaderParsing(http.createServer(createHttpHandler({
  irisHome: IRIS_HOME,
  capabilityHost,
})));


// WS 업그레이드도 같은 IP 필터를 통과해야 한다(AC6).
const wss = new WebSocketServer({ server, verifyClient: (info) => connectionAllowed(info.req) });
const HB_MS = 10000;
// AC5: 로컬(루프백) 연결만 터미널 탭 생성 등 셸 관련 동작 허용. 원격(tailnet 폰)은 제외.
initWsTransport({
  wss,
  heartbeatMs: HB_MS,
  isLocalRequest: isLoopbackRequest,
});
const herdr = new HerdrClient();
// 실제 터미널: node-pty로 herdr session attach를 그대로 사용한다(재구현이 아니다).
const ptyMgr = new PtyManager();
initHerdrHandlers({ herdr, ptyManager: ptyMgr, broadcastLocal: (message) => broadcastLocal(message) });

initRuntimeState({ scheduleRecompute: recomputeNow });
initWorkspaceRuntime({
  herdr,
  requestRecompute: recompute,
  broadcast: (message) => broadcast(message),
});

// 관제 상태 재계산. 파일 I/O가 있으므로 직렬화해 동시 재계산을 막는다.
async function recomputeNow() {
  try {
    const next = await buildWorkspaceSnapshot();
    const migration = migrateSpaceKeys(next.workspaces, next.migrations);
    replacePaneSpaces(next.agents);
    // 허용 루트 갱신. 실행 중인 에이전트의 cwd와 스페이스가 속한 폴더를 사용한다.
    // 에이전트 cwd 만 쓰면, 터미널이 안 떠 있는 스페이스의 파일은 열리는데 저장이 막힌다(읽기는
    // 로컬에 한해 바깥까지 열려 있어 여는 것은 되기 때문이다. 사용자에게는 저장만 되지 않는 상태로
    // 보인다). 스페이스의 폴더는 에이전트와 무관하게 그 스페이스가 유지되는 동안 고정된 값이라,
    // 스페이스 경계를 정하는 데는 이 값이 맞다.
    replace({ state: next.state, workspaces: next.workspaces, tabs: next.tabs, allowedRoots: next.allowedRoots });
    const runtime = snapshot();
    broadcast({ type: "state", agents: runtime.state, workspaces: runtime.workspaces, tabs: runtime.tabs, ts: Date.now() });
    // 스페이스가 생기거나 사라지면 저장분을 내보내는 투영(폴더 키 → workspace_id)이 통째로 달라진다.
    // 다시 보내지 않으면 창이 이전 투영을 유지해, 복원한 스페이스가 자기 탭·북마크·메모를 찾지 못한다
    // (확인 결과: 보관 후 복원한 직후 탭이 0개로 표시됐다). 스페이스 구성이 바뀐 회차에만 보낸다.
    publishProjectionIfChanged(migration);
    // pane→space 매핑 재구성으로 ai-targets 산출이 바뀔 수 있다(예: 지목이 첫 recompute보다 먼저 들어와
    // 초기 스냅샷이 빈 배열로 확정된 경우). state만 방송하면 렌더러의 authoritative held가 빈 채로
    // 굳어 보호가 풀리므로, 스페이스 매핑이 갱신될 때마다 ai-targets도 다시 방송한다(변경 시에만 전송).
    broadcastAiTargets();
  } catch (e) {
    broadcast({ type: "error", message: String(e.message || e) });
  }
}

capabilityContext.herdr = herdr;
capabilityHost.init(false);
initWorkspaceHandlers({ herdr });
initKeymapStore();   // 파일이 없거나 손상됐으면 빈 표를 쓴다. 단축키 때문에 앱이 시작하지 못하면 안 된다
// 부산물을 전용 폴더로 모은다. 이전 경로에 남은 파일을 옮기는 작업이라 시작할 때 한 번만 실행한다.
initArtifactsHandlers();
// herdr push 이벤트 → 상태 재계산. 폴링이 아니라 이벤트 구동.
startWorkspaceRuntime();

// 브라우저 공유 상태 mutation. 콘솔·분리창이 사용자 행동에서만 보낸다. 서버가 단일 소스에 반영하고
// 바뀌면 전체에 broadcast → 클라이언트는 멱등 렌더(수신으로 새 mutation 안 만듦 → 무한루프 없음).
// AC5: 원격(폰)은 탭 생성·도킹 등 생성/구조 변경 금지. 열람(초기 스냅샷·broadcast)만 허용.
// 계정(로그인 칸)을 만들고 지우고 스페이스 기본값을 바꾸는 것은 어느 로그인으로 사이트를 볼지
// 선택하는 일이라 폰·원격에서 수행하지 않는다. tab.profile을 막는 것과 같은 이유다.

// 연결 상태 확인(하트비트). 주기와 판정은 ws-transport 가 소유한다.
startHeartbeat();

// 연결 하나의 수신·전달·종료 시 정리를 세 콜백으로 구성한다.
attachWs({
  // 새 클라이언트에는 즉시 현재 상태를 보낸다.
  initialState: (ws) => {
    // caps는 이 연결의 권한(로컬=셸/탭생성 허용, 원격=제외)을 결정론적으로 전달한다.
    // state 브로드캐스트는 local을 담지 않으므로, 권한 판정은 이 전용 메시지가 정본이다.
    // 홈 경로도 함께 보낸다. 터미널에 출력되는 산출물 경로는 `~/Downloads/…` 형태가 흔한데, 창은 홈이
    // 어디인지 몰라 그 경로를 해석하지 못해 열기·Finder 보기가 모두 실패한다.
    // 홈 경로는 같은 기기의 서버가 알고 있으므로 창이 추정하지 않게 한다.
    ws.send(JSON.stringify({ type: "caps", local: ws._local, home: os.homedir() }));
    // 창이 자기 저장분(파일 탭·기본 프로필·순서)을 같은 키로 옮기는 데 쓴다. 창은 첫 state에서
    // 파일 탭을 복원하므로 그보다 먼저 보낸다. 이관이 끝난 뒤 붙은 창도 이 표만 있으면 스스로 옮긴다.
    ws.send(JSON.stringify(spaceKeysWire()));
    const runtime = snapshot();
    ws.send(JSON.stringify({ type: "state", agents: runtime.state, workspaces: runtime.workspaces, tabs: runtime.tabs, ts: Date.now(), local: ws._local }));
    ws.send(JSON.stringify(keymapWire())); // 사용자가 변경한 단축키. 창이 이 값으로 판정한다
    ws.send(JSON.stringify(closedTabsWire())); // 복원 스택. 새로 연 창도 앞서 닫힌 탭을 복원할 수 있게 한다
    ws.send(JSON.stringify(controlMessage())); // 재접속 시 조작 상태 + 최근 AI 사용 동기(둘을 한 메시지로 묶어 어긋나지 않게)
    ws.send(JSON.stringify({ type: "ai-targets", targets: aiTargetsSnapshot() })); // 어느 세션이 어느 탭을 쓰는지
    // 창이 요소 지목 문구에 쓸 이름. 연결 직후 한 번 보내고 이후에는 등록·해제 때 갱신한다.
    try { ws.send(JSON.stringify({ type: "tab-handles", map: handleMap() })); } catch {}
    ws.send(JSON.stringify({ type: "pick-mode", on: getPickMode() })); // 뒤늦게 뜬 창도 같은 위상으로 시작
    // 브라우저 공유 상태 초기 스냅샷(북마크·스페이스별 탭·활성 스페이스·도킹). 이후 변경은 broadcast.
    ws.send(JSON.stringify({ type: "browser-state", state: bsWire() }));
    // 구독 사용량 스냅샷과 표시 설정. 나중에 연 창도 상태바를 채운 상태로 시작한다.
    capabilityHost.onConnect(ws);
  },
  dispatch: (ws, msg) => {
    if (msg.type === "read" || msg.type === "send") handleControl(ws, msg);
    else if (msg.type === "focus") handleFocus(ws, msg);
    else if (msg.type === "tab-focus") handleTabFocus(ws, msg);
    else if (msg.type === "tab-close") handleTabClose(ws, msg);
    else if (msg.type === "pane-close") handlePaneClose(ws, msg);
    else if (msg.type === "tab-reopen") handleTabReopen(ws, msg);
    else if (msg.type === "keymap-set") { if (ws._local && setKeymapOverride(msg.id, msg.binding)) broadcast(keymapWire()); }
    else if (msg.type === "keymap-reset") { if (ws._local && resetKeymap(msg.id || null)) broadcast(keymapWire()); }
    else if (msg.type.startsWith("pty.")) handlePty(ws, msg);
    else if (msg.type === "browser-sync") handleBrowserSync(ws, msg);
    else if (msg.type === "pick-relay") { if (ws._local) relayToOneConsole({ type: "pick-relay", pick: msg.pick }); } // 분리창 요소 pick → 콘솔 터미널 하나로(로컬만)
    // 탭 지목(B3): 분리창에서 고른 탭을 콘솔로 relay → 콘솔이 자기 curTarget(pane)과 묶어 고정을 요청한다.
    // 이 세 가지도 받은 콘솔이 채팅에 내용을 넣거나 권한을 열어, 콘솔이 여럿이면 두 번 실행된다.
    // 스케치: 분리 창에는 터미널이 없어 결과를 콘솔로 보내고, 여는 신호는 콘솔에서 분리 창으로 보낸다.
    else if (msg.type === "sketch-relay") { if (ws._local) relayToOneConsole({ type: "sketch-relay", sketch: msg.sketch }); }
    else if (msg.type === "sketch-open-relay") { if (ws._local) broadcast({ type: "sketch-open-relay" }); }
    else if (msg.type === "tab-pick-relay") { if (ws._local) relayToOneConsole({ type: "tab-pick-relay", tab: msg.tab }); }
    else if (msg.type === "group-pick-relay") { if (ws._local) relayToOneConsole({ type: "group-pick-relay", group: msg.group }); }
    else if (msg.type === "site-pick-relay") { if (ws._local) relayToOneConsole({ type: "site-pick-relay", site: msg.site }); }
    else if (capabilityHost.handle(ws, msg)) {}
    // 녹화(재현) 릴레이: 분리 창에는 터미널이 없어 결과를 콘솔로 보내고, 토글은 콘솔에서 분리 창으로 보낸다.
    else if (msg.type === "rec-relay") { if (ws._local) broadcast({ type: "rec-relay", text: msg.text }); }
    else if (msg.type === "rec-toggle-relay") { if (ws._local) broadcast({ type: "rec-toggle-relay" }); }
    // 세션(pane)의 제어 대상 고정. UI에서 탭을 지목했을 때 쓰며 CLI의 `target`과 같은 상태를 쓴다.
    // 앱 UI임을 증명한다. 이 증명 없이는 지목(권한 확대) 메시지를 받지 않는다.
    // 어떤 로그인 칸(프로필)이 있는지 전달한다. 이름만 오고 쿠키·비밀 값은 전달하지 않는다.
    // 사람이 부름에 답했다(그 탭으로 갔다 / 나중에).
    // 사용자가 고른 요소의 원본. 사람이 읽는 블록은 터미널로 가고, 필드는 여기 남아 도구로 조회한다.
    else if (msg.type === "ai-pick"
      || msg.type === "ai-app-pick"
      || msg.type === "focus-app"
      || msg.type === "emulator-reply"
      || msg.type === "ai-ask-answer"
      || msg.type === "browser-profiles"
      || msg.type === "ui-auth"
      || msg.type === "chat-submitted"
      || msg.type === "browser-target-set"
      || msg.type === "browser-group-grant"
      || msg.type === "pick-mode"
      || msg.type === "cdp-executor-register"
      || msg.type === "cdp-result"
      || msg.type === "browser-active-wc"
      || msg.type === "ai-login-note"
      || msg.type === "browser-dialog-plan"
      || msg.type === "browser-frame-origins"
      || msg.type === "browser-dialog-open"
      || msg.type === "browser-dialog-closed"
      || msg.type === "browser-dialog-answer"
      || msg.type === "browser-tab-wc"
      || msg.type === "browser-tab-gone") handleBrowserMessage(ws, msg);
    else if (msg.type === "fs.list") handleFs(ws, msg);
    else if (msg.type === "fs.read") handleFsRead(ws, msg);
    else if (msg.type === "docx.read") handleDocxRead(ws, msg);
    else if (msg.type === "docx.write") handleDocxWrite(ws, msg);
    else if (msg.type === "sheet.read") handleSheetRead(ws, msg);
    else if (msg.type === "sheet.write") handleSheetWrite(ws, msg);
    else if (msg.type === "fs.watch") handleFsWatch(ws, msg);
    else if (msg.type === "fs.tree") handleFsTree(ws, msg);
    else if (msg.type === "fs.write") handleFsWrite(ws, msg);
    else if (msg.type === "fs.op") handleFsOp(ws, msg);
    else if (msg.type === "tab.create" || msg.type === "tab.rename" || msg.type === "tab.move") handleTab(ws, msg);
    else if (msg.type === "space.create" || msg.type === "space.close") handleSpace(ws, msg);
    else if (msg.type.startsWith("artifacts.")) handleArtifacts(ws, msg);
    else ws.send(JSON.stringify({ type: "control-error", message: "모르는 메시지: " + msg.type }));
  },
  // 연결 종료 시 PTY detach(좀비 herdr 클라이언트 방지, 세션은 persistent 유지).
  onClose: (ws) => {
    closeHerdrClient(ws);
    closeFsClient(ws); // 감시 중이던 폴더 해제. 해제하지 않으면 창을 닫아도 watcher가 남는다
    // 앱(CDP 실행기)이 끊기면 그 앱의 webContents는 모두 무효이므로 탭 레지스트리와 세션 고정을 비운다.
    // 강제 종료 시에는 렌더러의 browser-tab-gone이 오지 않으므로 여기가 유일한 정리 지점이다.
    // 앱이 끊기면 webview는 모두 사라지지만 탭 자체는 상태에 남으므로, wc 결속만 버리고 탭 정체성 고정은
    // 유지해, 앱이 다시 뜨면 같은 탭에 자동으로 다시 붙는다(resolveTarget의 재결합).
    // wc 기반 값만 버린다. 번호는 앱이 다시 실행되면 다른 탭에 재발급되므로 유지하면 안 된다.
    // 탭 정체성으로 된 것(고정·지목·그룹 권한)은 남긴다. 그래야 사용자가 지목해 준 것이 재시작
    // 한 번에 사라지지 않는다(확인 결과: 지목한 탭 대신 세션 그룹 탭으로 명령이 갔다).
    disconnectCdpExecutor(ws);
  },
});

// 서버 종료 시 Chrome 인스턴스도 정리.
// 이력 수집기는 자식 프로세스라 부모가 종료할 때 함께 종료하지 않으면 남는다. 앱이 꺼진 뒤에도
// 디스크를 계속 읽으며 사용되지 않는 캐시를 쓴다.
process.on("SIGINT", () => { for (const stop of shutdownCapabilities) { try { stop(); } catch {} } process.exit(0); });
process.on("SIGTERM", () => { for (const stop of shutdownCapabilities) { try { stop(); } catch {} } process.exit(0); });

// transcript는 파일이라 herdr 이벤트에 안 잡히는 서브에이전트 변화가 있다.
// 안전망으로 주기적 재계산(느슨한 폴백, push가 주 경로).
setInterval(recompute, 4000);

// 종료 전에 밀린 쓰기를 끝낸다. 탭·북마크(200ms)·스페이스 키(200ms)·보관(120ms)은
// 잦은 변경을 합치려고 지연을 두는데, 그 사이에 종료 신호가 오면 마지막 변경이 저장되지 않는다.
// 앱이 서버를 관리하므로 앱을 끌 때마다 SIGTERM이 오고, 이 구간을 매번 지난다.
function flushPendingState() {
  const flushed = [];
  try { if (flushBrowserStateNow()) flushed.push("탭·북마크"); } catch {}
  try { if (spaceKey.flushNow()) flushed.push("스페이스 열쇠"); } catch {}
  try { if (archive.flushNow()) flushed.push("보관"); } catch {}
  try {
    const runtime = flushBrowserRuntimeNow();
    if (runtime.handles) flushed.push("탭 핸들");
    if (runtime.grants) flushed.push("지목·권한");
  } catch {}
  try { if (flushMemoNow()) flushed.push("메모 보관"); } catch {}
  // 실행 중인 dev 서버 목록도 현재 상태로 저장한다. 방금 stopAll()로 종료한 항목이 남아 있으면
  // 다음 실행의 orphan 정리가 그 번호를 종료하려 하고, 그 사이 번호가 재사용됐으면 다른
  // 프로세스 그룹이 종료된다(run.js가 시작 시각까지 대조하지만, 남기지 않는 것이 낫다).
  for (const persist of exitCapabilities) { try { persist(); } catch {} }
  if (flushed.length) console.log(`내려가기 전에 저장했습니다 — ${flushed.join(", ")}`);
}
for (const sig of ["exit", "SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    flushPendingState();
    try { if (Number(String(fs.readFileSync(LOCK_PATH, "utf8")).trim()) === process.pid) fs.unlinkSync(LOCK_PATH); } catch {}
    if (sig !== "exit") process.exit(0);
  });
}

// 포트가 이미 사용 중이면 종료하지 않고 대기한다. 잠금과 같은 이유로, 여기서 종료하면 launchd가
// 10초마다 다시 실행해 같은 오류가 반복된다(확인 결과: server.log에 EADDRINUSE로
// 인한 unhandled 'error' 종료 62회. 포트를 사용 중인 것은 이 앱이 아니라, 터미널에 설정된
// PORT=4271을 상속한 다른 개발 서버였다).
// 바인딩 실패는 ws가 http 서버를 감싸고 있어 WebSocketServer의 unhandled 'error'로 발생하므로
// 여기서 처리한다.
let listenNotified = false;
// ws는 감싼 http 서버의 'error'를 자기 인스턴스로 다시 던진다. 리스너가 없으면
// Node가 unhandled 'error'로 프로세스를 종료한다. 로그의 종료 62회가 이 경로였다.
wss.on("error", () => {});
server.on("error", (e) => {
  if (e && e.code === "EADDRINUSE") {
    if (!listenNotified) {
      listenNotified = true;
      console.error(`${HOST}:${PORT}을 이미 다른 프로그램이 쓰고 있습니다. 그 자리가 비면 붙습니다 — 여기서 기다리며, 같은 말을 다시 적지 않습니다.`);
      console.error(`  누가 쓰는지: lsof -nP -iTCP:${PORT} -sTCP:LISTEN`);
    }
    setTimeout(() => { try { server.listen(PORT, HOST); } catch {} }, LOCK_WAIT_MS);
    return;
  }
  console.error("서버 오류:", e && e.message ? e.message : e);
});
server.listen(PORT, HOST, () => {
  console.log(`Iris → http://127.0.0.1:${PORT}`);
  if (REMOTE) {
    const ts = selfTailscaleIps()[0];
    if (ts) console.log(`  폰 접속(tailnet): http://${ts}:${PORT}`);
    else console.log(`  원격 모드 ON — Tailscale 미탐지. 'sudo tailscale up' 후 tailnet IP로 접속됩니다.`);
    console.log(`  접속 허용: localhost + Tailscale(100.64/10)만. 그 외 원격 IP는 403(AC6).`);
  }
});
