// 소유 범위: 화면·연결의 핵심 심볼이 남아 있는가. 메모 창·webview preload·프로필 파티션·IPC 신뢰 검사.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사·파일 도구, sources 의 공유 소스, Node 파일·경로 API.
// 유지 조건: 검사 이름과 본문. 20-browser-contracts.mjs 를 기능별로 분리한 파일이고,
//   분리하면서 본문을 바꾸지 않았다. 원본 대비 바이트 대조가 그것을 보장한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부르며 sources 의 공유 상수 계약도 함께 본다.
//   현재 목록 확인: node bin/importers.mjs bin/smoke/sections/feature-wiring.mjs
import { existsSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { homedir, tmpdir } from "node:os";

import { check, checkAsync, fnBody, read, readAll, require_, ROOT, sourceFiles } from "../core.mjs";
import {
  aiTabs, allCss, allServer, allWebJs, archive, bookmarks, browserCommands, browserHandoff,
  browserMessages, browserRuntime, browserState, browserStateOwner, browserWindowManagerSource,
  cdpCaptureToolsSource, cdpCmdCaptureSource, cdpCmdNativeSource, cdpObservationSource,
  cdpSessionSource, centerTabs, chromeHandoffIpcSource, css, dock, downloadHookSource,
  fileRouting, fsIpcSource, herdrSync, httpHandler, localdev, main, mainJs, mainWindowSource,
  mcp, memoWindow, memoWindowManagerSource, pick, profileSessionPolicySource, profiles, rail,
  record, xtermWiring, terminalPanel, textEditor, touchDragPanel, web, webview,
  webviewFactory, webviewLifecycleSource, webviewStore, pickBoot,
} from "../sources.mjs";
import { sliceBetween, sliceFrom } from "../../slice-anchor.mjs";

export default async function run() {
console.log("[2] 기능 계약 — 핵심 심볼·배선이 남아 있는가");
for (const [name, re, source = web] of [
  ["터미널 PTY 입력", /type:\s*"pty\.input"/, xtermWiring],
  ["Shift+Enter 줄바꿈(\\n)", /data:\s*"\\n"/, xtermWiring],
  ["붙여넣기 xterm.paste", /xterm\.paste\(/, xtermWiring],
  ["요소선택 멱등 토글 __orcaSet", /__orcaSet/, touchDragPanel],
  ["요소선택 전달 ipc orca-pick", /"orca-pick"/, webviewFactory],
  // 이 둘은 main 의 ws 표에 있었다. 요소 지목·녹화가 상위 개념으로 분리되면서 소유자도 함께
  // 옮겨갔다. 표를 가진 위치가 그 기능의 입구다.
  ["분리창 요소 릴레이", /"pick-relay": \(m\) =>/, pickBoot],
  ["분리창 선택모드는 서버 방송을 따름", /"pick-mode": \(m\) => applyPickMode\(!!m\.on\)/, pickBoot],
  ["herdr 역동기화(focused)", /if \(!paneId \|\| paneId === getCurTarget\(\)\) return;[\s\S]*clearTimeout\(herdrSyncTimer\);[\s\S]*setTimeout\(\(\) => applyHerdrFocus\(herdrSyncPane\), 300\);[\s\S]*if \(!paneId \|\| paneId === getCurTarget\(\)\) return;[\s\S]*Date\.now\(\) - lastUserSelect < 1500[\s\S]*const a = agentByPane\(paneId\);[\s\S]*if \(!a\) return/, herdrSync],
  ["프로필 안정 id 파티션", /persist:acprof:/, webviewFactory],
  ["프로필 id 해석 함수", /function profileIdForStored/, profiles],
  ["프로필 메뉴 닫기(guest pointerdown)", /ac-guest-pointerdown/, webviewFactory],
  ["단축키 ipc 수신", /onShortcut/, dock],
  ["크롭(사이드바 가림) 계산", /detectSidebarCols|applyCropAndFit/, terminalPanel],
  ["중앙 도크 새 메모·공유 메모 진입점", /id="memo-new-window"[\s\S]*id="memo-shared-window"/],
]) check("web " + name, () => re.test(source));
check("web 별도 메모 창 편집·충돌 보존", () => /function initMemoWindow\(\)/.test(memoWindow));
check("web 메모 창 키입력 실시간 공유", () => /mwOwnsLive = true; mwLiveText = text; mwSendLive\(text\);/.test(memoWindow));
check("web 같은 로컬 메모 새 창 진입점", () =>
  /id="mw-duplicate"/.test(web) && /openLocalMemo\?\.\(\{ spaceKey: MW_SPACE, noteId: MW_NOTE/.test(memoWindow));
check("메모 창 항상 위 토글은 신뢰 IPC 브리지로 연결됨", () => {
  const preload = read("native/electron/preload.cjs");
  return /id="mw-always-on-top"/.test(web)
    && /typeof setAlwaysOnTop !== "function"[\s\S]{0,180}최신 빌드로 설치/.test(memoWindow)
    && /await setAlwaysOnTop\(!mwAlwaysOnTop\)/.test(memoWindow)
    && /setMemoAlwaysOnTop: \(enabled\) => ipcRenderer\.invoke\("ac-memo-always-on-top", !!enabled\)/.test(preload);
});

check("native webview preload 부착", () => /will-attach-webview/.test(readAll("native")));
check("webview-lifecycle anti-detection document-start 주입", () =>
  /addScriptToEvaluateOnNewDocument/.test(webviewLifecycleSource));
for (const [name, re, source = main] of [
  ["단축키 메인 가로채기", /ac-shortcut/, mainWindowSource],
  ["클립보드 IPC", /ac-clipboard-read/],
  ["chrome-handoff-ipc 쿠키 임포트 IPC", /ac-import-chrome-profile/, chromeHandoffIpcSource],
]) check(name, () => re.test(source));
check("memo-window-manager 메모 창 인스턴스 복원 소유", () =>
  /let memoWindowRecords = normalizeMemoWindowRecords\(readUiState\(\)\.memoWindows\)/.test(memoWindowManagerSource)
  && /closeMemoWindowRecord\(memoWindowRecords, instanceId/.test(memoWindowManagerSource)
  && /const snapshot = windowLayout\.snapshotWindowBounds\(w\)/.test(memoWindowManagerSource)
  && !/getNormalBounds|getDisplayMatching/.test(memoWindowManagerSource));
check("main.cjs 메모 창 인스턴스 복원 배선", () =>
  /readUiState,\n\s*writeUiState,/.test(main)
  && /isAppQuitting: \(\) => appQuitting,/.test(main));
check("browser-window-manager 분리창 세션 guard 소유", () =>
  /guardWebviewPartition\(webPreferences\)/.test(browserWindowManagerSource)
  && /webPreferences\.nodeIntegrationInSubFrames = true/.test(browserWindowManagerSource));
check("main.cjs 분리창 세션 guard 배선", () =>
  /guardWebviewPartition,\n/.test(main)
  && /basePartition: IRIS_PARTITION/.test(main));
check("profile-session-policy 프로필 파티션 화이트리스트", () => {
  const { createProfileSessionPolicy, isProfilePartition } = require_("../native/electron/profile-session-policy.cjs");
  const hardened = [];
  const sessionProbe = {
    setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDisplayMediaRequestHandler() {},
    setDevicePermissionHandler() {}, removeListener() {}, on() {},
  };
  const policy = createProfileSessionPolicy({
    basePartition: "persist:acbrowser",
    fromPartition: () => sessionProbe,
    hardenBrowserSession: (_session, ua) => hardened.push(ua),
    userAgentForPartition: (partition) => "ua:" + partition,
    audioInputPermission: () => false,
    systemPreferences: { getMediaAccessStatus: () => "granted", askForMediaAccess: () => Promise.resolve(true) },
    platform: "linux",
    installSessionHook: () => {},
  });
  if (!isProfilePartition("persist:acbrowser") || !isProfilePartition("persist:acprof:work%20one")) {
    throw new Error("알려진 profile partition을 거절한다");
  }
  // 부정 표본이 적으면 정규식을 느슨하게 바꿔도 통과한다. 공백·슬래시·상위경로·접미사는
  // 파일 경로와 세션 폴더로 이어져 각각 다른 사고가 된다.
  for (const bad of ["persist:other", "persist:acprof:", "persist:acprof:a b", "persist:acprof:a/b",
                     "persist:acprof:../x", "persist:acbrowserX", "persist:acbrowser ", "acprof:x", ""]) {
    if (isProfilePartition(bad)) throw new Error(`미지 profile partition을 허용한다: ${JSON.stringify(bad)}`);
  }
  const known = { partition: "persist:acprof:work-one" };
  policy.guardWebviewPartition(known);
  if (known.partition !== "persist:acprof:work-one" || hardened.length !== 1) {
    throw new Error("알려진 profile partition을 그대로 harden하지 않는다");
  }
  const unknown = { partition: "persist:outside" };
  policy.guardWebviewPartition(unknown);
  if (unknown.partition !== "persist:acbrowser") throw new Error("미지 partition을 base로 강제하지 않는다");
  return true;
});
// 같은 정규식을 두 벌 두면 언젠가 달라진다. cookie-import 에 한 벌이 더 있었고, 달라졌다면
// webview 는 허용되는데 UA 저장·cookie import 는 거절되는 프로필이 생긴다. 사용자에게는
// "이 프로필만 로그인이 안 붙는다"로 보인다.
check("허용 partition 형식을 정의하는 파일은 하나다", () => {
  const owners = sourceFiles("native").filter((rel) => rel.endsWith(".cjs"))
    .filter((rel) => /persist:acprof:\[A-Za-z0-9/.test(read(rel)));
  if (owners.length !== 1) throw new Error(`형식 정규식을 든 파일이 ${owners.length}개: ${owners.join(", ")}`);
  if (owners[0] !== "native/electron/profile-session-policy.cjs") {
    throw new Error(`담당 파일이 바뀌었다: ${owners[0]}`);
  }
  return true;
});
check("ipc-trust 신뢰 발신자 검사(보안)", () => {
  const { isTrustedSender } = require_("../native/electron/ipc-trust.cjs");
  const appUrl = "http://127.0.0.1:4291/app";
  if (!isTrustedSender({ senderFrame: { url: "http://127.0.0.1:4291/inside" } }, appUrl)) {
    throw new Error("같은 origin을 거절한다");
  }
  if (isTrustedSender({ senderFrame: { url: "http://127.0.0.1:4271/outside" } }, appUrl)) {
    throw new Error("다른 origin을 허용한다");
  }
  if (isTrustedSender({}, appUrl)) throw new Error("senderFrame 없는 요청을 허용한다");
  if (isTrustedSender({ senderFrame: { url: "://broken" } }, appUrl)) throw new Error("깨진 URL을 허용한다");
  return true;
});
check("메모 창 항상 위 IPC는 실제 창 상태를 적용·확인·저장함", () =>
  /ipcMain\.handle\("ac-memo-always-on-top"[\s\S]{0,900}setAlwaysOnTop\(!!enabled\)[\s\S]{0,300}isAlwaysOnTop\(\)[\s\S]{0,300}saveMemoWindowRecord\([^)]*alwaysOnTop/.test(memoWindowManagerSource));
check("공유 메모 데스크톱 전용 동작 제거", () =>
  !/ac-memo-all-workspaces|setVisibleOnAllWorkspaces/.test(readAll("native"))
  && !/mw-all|모든 데스크톱/.test(memoWindow));
check("메모 보관은 버튼 없이 단축키로만 실행", () =>
  !/id="mw-archive"/.test(web) && /ac-shortcut", "memo-archive"/.test(memoWindowManagerSource));
check("로컬 스페이스 이름은 macOS 타이틀바 오른쪽에 표시", () =>
  /class="mw-titlebar-space" id="mw-titlebar-space"/.test(web)
  && /#mw-titlebar-space"\)\.textContent = shared \? "" : \(MW_SPACE_LABEL/.test(memoWindow));
check("실시간 메모는 저장 전에 인증된 다른 창으로 중계", () => {
  const source = read("server/memo-service.js");
  return /msg\.type === "memo\.doc\.live"/.test(source)
    && /function broadcastMemoLive\(source, msg\)/.test(source)
    && /client !== source[\s\S]*client\._local && client\._ui/.test(source);
});

function createMemoWindowManagerProbe(overrides = {}) {
  const created = [], writes = [], titles = [], watched = [], ipcHandlers = new Map(), ipcListeners = new Map();
  class FakeMemoWindow {
    static getAllWindows() { return created.filter((window) => !window.destroyed); }
    constructor(options) {
      this.options = options; this.handlers = {}; this.destroyed = false; this.alwaysOnTop = !!options.alwaysOnTop;
      const webHandlers = {};
      this.webContents = {
        on: (event, handler) => { (webHandlers[event] = webHandlers[event] || []).push(handler); },
        send: () => {},
      };
      created.push(this);
    }
    on(event, handler) { (this.handlers[event] = this.handlers[event] || []).push(handler); }
    once(event, handler) { this.on(event, handler); }
    emit(event) { for (const handler of this.handlers[event] || []) handler(); }
    isDestroyed() { return this.destroyed; }
    focus() {}
    maximize() {}
    show() {}
    setFullScreen() {}
    getNormalBounds() { return { x: 10, y: 20, width: 520, height: 420 }; }
    getBounds() { return this.getNormalBounds(); }
    isMaximized() { return false; }
    isFullScreen() { return false; }
    setAlwaysOnTop(enabled) { this.alwaysOnTop = !!enabled; }
    isAlwaysOnTop() { return this.alwaysOnTop; }
    close() { this.emit("close"); this.emit("closed"); this.destroyed = true; }
  }
  const { createMemoWindowManager } = require_("../native/electron/memo-window-manager.cjs");
  let uuid = 0;
  const manager = createMemoWindowManager({
    BrowserWindow: FakeMemoWindow,
    ipcMain: {
      handle: (channel, handler) => ipcHandlers.set(channel, handler),
      on: (channel, handler) => ipcListeners.set(channel, handler),
    },
    preloadPath: "/preload.cjs",
    windowLayout: {
      isAwaiting: () => false, boundsVisible: () => true,
      // 실행 중에 모니터가 빠지는 경우를 대비한 등록. 메모 창은 자기 기록에서 위치를 읽으므로
      // 읽는 방법을 직접 넘기고, 그 호출이 유지되는지도 여기서 함께 확인한다.
      watchDisplayLoss: (window, readSaved) => { watched.push({ window, readSaved }); },
      // 실제 window-layout 은 대기 중이면 null 을 반환한다. 그 동작을 가짜에도 담아야
      // 대기 중 경로를 시험할 수 있다.
      snapshotWindowBounds: (window) => (overrides.awaiting ? null
        : { bounds: window.getNormalBounds(), maximized: false, fullscreen: false, display: { id: 1, x: 0, y: 0 } }),
      ownWindowTitle: (window, title) => { window.title = title; },
      setOwnedWindowTitle: (window, title) => { if (window) { window.title = title; titles.push(title); } },
      restoreWhenDisplayReturns: () => {}, placeSavedBounds: () => {},
      ...(overrides.windowLayout || {}),
    },
    readUiState: () => ({}), writeUiState: (patch) => writes.push(patch),
    loadUrlWithRetry: () => {}, getAppUrl: () => "http://127.0.0.1:4291",
    isTrustedSender: () => true, isAppQuitting: () => false, markAppAlive: () => {},
    randomUuid: () => `memo-${++uuid}`, log: () => {},
  });
  manager.registerMemoIpc();
  return { created, writes, titles, watched, ipcHandlers, ipcListeners, manager };
}
await checkAsync("memo-window-manager는 이름 변경 제목과 창 기록을 함께 유지한다", async () => {
  const probe = createMemoWindowManagerProbe();
  const window = probe.manager.createMemoModeWindow({ kind: "local", instanceId: "memo-a", spaceKey: "space-a", noteId: "note-a" });
  const titleHandler = probe.ipcListeners.get("ac-memo-window-title");
  if (!titleHandler) throw new Error("메모 이름 IPC가 등록되지 않았다");
  titleHandler({ sender: window.webContents }, "바뀐 이름");
  if (window.title !== "Iris — 바뀐 이름" || probe.titles.at(-1) !== "Iris — 바뀐 이름") {
    throw new Error(`창 제목이 ${JSON.stringify(window.title)}에 머문다`);
  }
  const snapshot = probe.manager.memoWindowSnapshot();
  const persisted = probe.writes.some((patch) => Array.isArray(patch.memoWindows)
    && patch.memoWindows.some((record) => record.instanceId === "memo-a"));
  if (snapshot.records.length !== 1 || !persisted) throw new Error("이름을 바꾼 창의 기록이 남지 않는다");
  return true;
});
// 메모 창은 위치를 ui-state 가 아니라 자기 기록에 들고 있어서, 실행 중 모니터가 빠지는 경우에
// 대비한 등록을 직접 해야 한다. 등록하지 않으면 만드는 코드가 있어도 호출되지 않아 기능이
// 없는 것과 같고, 모니터를 뽑았다 꽂을 때마다 메모 창만 다른 위치에 표시된다.
await checkAsync("메모 창도 모니터가 빠지는 것을 지키게 등록한다", async () => {
  const probe = createMemoWindowManagerProbe();
  probe.manager.createMemoModeWindow({ kind: "shared", instanceId: "memo-w" });
  const win = probe.created.at(-1);
  const entry = probe.watched.find((x) => x.window === win);
  if (!entry) throw new Error("등록하지 않는다 — 이 창만 안 지켜진다");
  // 등록만 하고 읽는 방법이 비어도 결과는 같다. 실제로 호출해 위치가 나오는지 확인한다.
  // 한 번도 저장된 적 없는 창은 들고 있을 위치가 없어 null 이 맞다. 저장이 한 번 실행되면
  // 그때부터 위치가 나와야 한다.
  if (entry.readSaved() !== null) throw new Error("저장 전인데 자리가 있다 — 계측기가 깨졌다");
  win.emit("close");   // 자리를 한 번 저장시킨다
  const saved = entry.readSaved();
  if (!saved || typeof saved.x !== "number" || typeof saved.width !== "number") {
    throw new Error(`읽는 법이 자리를 못 준다: ${JSON.stringify(saved)}`);
  }
  return true;
});
// 자기 모니터를 기다리는 동안에는 현재 위치가 임시다. 그것으로 원래 위치를 덮으면 모니터가
// 돌아와도 복원할 수 없다. 반면 위치와 무관한 항상 위·보기 모드는 그때도 반영돼야 한다.
// 두 성질이 한 함수 안에 있어 한쪽만 맞기 쉽다.
// 기존 probe 는 isAwaiting 을 항상 false 로 두어 이 분기를 확인하지 못했다(확인 결과:
// 가드를 지워도 통과했다).
await checkAsync("메모 창은 자기 모니터를 기다리는 동안 자리를 덮지 않고 patch 만 반영한다", async () => {
  const probe = createMemoWindowManagerProbe({ awaiting: true, windowLayout: { isAwaiting: () => true } });
  probe.manager.createMemoModeWindow({ kind: "local", instanceId: "memo-a", spaceKey: "space-a", noteId: "note-a" });
  const before = probe.manager.memoWindowSnapshot().records[0];
  const topHandler = probe.ipcHandlers.get("ac-memo-always-on-top");
  if (!topHandler) throw new Error("항상 위 IPC 가 등록되지 않았다");
  const win = probe.created.at(-1);
  await topHandler({ sender: win.webContents }, true);
  const after = probe.manager.memoWindowSnapshot().records[0];
  if (after.alwaysOnTop !== true) throw new Error("기다리는 중에 자리와 무관한 patch 를 버린다");
  if (JSON.stringify(after.bounds || null) !== JSON.stringify(before.bounds || null)) {
    throw new Error(`기다리는 중에 임시 자리를 저장한다: ${JSON.stringify(after.bounds)}`);
  }
  return true;
});
await checkAsync("memo-window-manager는 close 뒤 열림 카운트와 기록을 갱신한다", async () => {
  const probe = createMemoWindowManagerProbe();
  const first = probe.manager.createMemoModeWindow({ kind: "local", instanceId: "memo-a", spaceKey: "space-a", noteId: "note-a" });
  probe.manager.createMemoModeWindow({ kind: "local", instanceId: "memo-b", spaceKey: "space-a", noteId: "note-a" });
  if (probe.manager.memoWindowSnapshot().openCounts["space-a\nnote-a"] !== 2) throw new Error("열림 카운트가 2까지 오르지 않는다");
  first.close();
  const snapshot = probe.manager.memoWindowSnapshot();
  if (snapshot.openCounts["space-a\nnote-a"] !== 1) throw new Error(`close 뒤 열림 카운트가 ${snapshot.openCounts["space-a\nnote-a"]}`);
  if (snapshot.records.map((record) => record.instanceId).join(",") !== "memo-b") throw new Error("닫은 창 기록이 남는다");
  const latest = [...probe.writes].reverse().find((patch) => Array.isArray(patch.memoWindows));
  if (!latest || latest.memoWindows.map((record) => record.instanceId).join(",") !== "memo-b") throw new Error("close 뒤 상태 기록을 갱신하지 않는다");
  return true;
});

// 브라우저 상태 모델. 프로필 상속 의미가 오래된 사본 배포로 되돌아간 적이 있어 계약으로 고정한다.
// 표시 이름("기본")이 프로필 값으로 저장되면 안 된다는 것은 그대로다.
//
// 새 탭의 미지정 프로필 규칙은 뒤집혔다. null 로 두어 스페이스 기본을 따르게 하면 그 탭이
// 어느 세션에 있는지 저장되지 않아 기본이 바뀔 때마다 다른 파티션으로 옮겨 가고, 사용자에게는
// 이유 없는 로그아웃이 된다. 이제 여는 시점의 기본을 풀어서 적어 둔다. 실제 동작은
// test/tab-profile-pinning.mjs 가 확인한다.
}
