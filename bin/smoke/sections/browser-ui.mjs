// 소유 범위: 브라우저 UI 계약. 탭 프로필 정규화, 그룹(폴더) op, 대화상자 감싸기, 다운로드 저장창.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사·파일 도구, sources 의 공유 소스, Node 파일·경로 API.
// 유지 조건: 검사 이름과 본문. 20-browser-contracts.mjs 를 기능별로 나눈 것이고,
//   나누는 동안 본문을 수정하지 않았으며, 원본 대비 바이트 대조가 이를 보장한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 호출하며 sources 의 공유 상수 계약도 함께 확인한다.
//   지금 목록은 이걸로 센다: node bin/importers.mjs bin/smoke/sections/browser-ui.mjs
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
  webviewFactory, webviewLifecycleSource, webviewStore,
} from "../sources.mjs";
import { sliceBetween, sliceFrom } from "../../slice-anchor.mjs";

export default async function run() {
console.log("[2f] 브라우저 UI 계약");
function createBrowserWindowManagerProbe() {
  const created = [], writes = [], loads = [];
  class FakeBrowserWindow {
    constructor(options) {
      this.options = options; this.handlers = {}; this.destroyed = false; this.focused = 0;
      const webHandlers = {};
      this.webContents = {
        on: (event, handler) => { (webHandlers[event] = webHandlers[event] || []).push(handler); },
        setWindowOpenHandler: (handler) => { this.openHandler = handler; },
      };
      created.push(this);
    }
    on(event, handler) { (this.handlers[event] = this.handlers[event] || []).push(handler); }
    once(event, handler) { this.on(event, handler); }
    emit(event) { for (const handler of this.handlers[event] || []) handler(); }
    isDestroyed() { return this.destroyed; }
    focus() { this.focused++; }
    maximize() {}
    show() {}
    setFullScreen() {}
    setFocusable() {}
    close() { this.emit("closed"); this.destroyed = true; }
  }
  const { createBrowserWindowManager } = require_("../native/electron/browser-window-manager.cjs");
  const manager = createBrowserWindowManager({
    BrowserWindow: FakeBrowserWindow,
    preloadPath: "/preload.cjs", webviewPreloadPath: "/webview-preload.cjs",
    audioDiagEnabled: false,
    windowLayout: {
      applySavedBounds: () => null, ownWindowTitle: () => {}, boundsVisible: () => true,
      restoreWhenDisplayReturns: () => {}, placeSavedBounds: () => {}, trackWindowBounds: () => {},
    },
    writeUiState: (patch) => writes.push(patch), guardWebviewPartition: () => {},
    pinHiddenViewportById: () => {}, webContents: {}, shell: { openExternal: () => {} },
    loadUrlWithRetry: (_window, url) => loads.push(url), getAppUrl: () => "http://127.0.0.1:4291",
    noThrottleOpt: false, isPickActive: () => false, isAppQuitting: () => false,
    markAppAlive: () => {}, log: () => {},
  });
  return { created, writes, loads, manager };
}
await checkAsync("browser-window-manager는 같은 shared 창을 한 벌만 기록한다", async () => {
  const probe = createBrowserWindowManagerProbe();
  const first = probe.manager.createBrowserModeWindow(true);
  const second = probe.manager.createBrowserModeWindow(true);
  if (first !== second || probe.created.length !== 1 || probe.manager.allBrowserWindows().length !== 1) {
    throw new Error(`같은 shared 창이 ${probe.created.length}벌·기록 ${probe.manager.allBrowserWindows().length}건`);
  }
  const opened = probe.writes.filter((patch) => patch.sharedOpen === true);
  if (opened.length !== 1 || first.focused !== 1) throw new Error(`열림 기록 ${opened.length}건·focus ${first.focused}번`);
  return true;
});
await checkAsync("browser-window-manager는 마지막 일반 창 close를 기록한다", async () => {
  const probe = createBrowserWindowManagerProbe();
  const window = probe.manager.createBrowserModeWindow(false);
  probe.writes.length = 0;
  window.close();
  if (probe.manager.allBrowserWindows().length !== 0) throw new Error("닫은 브라우저 창이 registry에 남는다");
  if (!probe.writes.some((patch) => patch.browserOpen === false)) throw new Error("닫힘 뒤 browserOpen: false를 쓰지 않는다");
  return true;
});

function createWebviewLifecycleProbe() {
  const appHandlers = {}, wcHandlers = {}, debuggerHandlers = {};
  const commands = [], sent = [], primers = {}, attaches = [];
  const childSessions = new Set();
  let openHandler = null;
  const debugger_ = {
    isAttached: () => false,
    attach: (v) => { attaches.push(v); },
    on: (event, handler) => { debuggerHandlers[event] = handler; },
    sendCommand: (method, params, sessionId) => {
      commands.push({ method, params, sessionId });
      return Promise.resolve();
    },
  };
  const host = { isDestroyed: () => false, send: (channel, payload) => sent.push({ channel, payload }) };
  const wc = {
    id: 41,
    debugger: debugger_,
    hostWebContents: host,
    getType: () => "webview",
    setBackgroundThrottling: () => {},
    isDestroyed: () => false,
    once: (event, handler) => { (wcHandlers[event] = wcHandlers[event] || []).push(handler); },
    on: (event, handler) => { (wcHandlers[event] = wcHandlers[event] || []).push(handler); },
    setWindowOpenHandler: (handler) => { openHandler = handler; },
  };
  const { createWebviewLifecycle } = require_("../native/electron/webview-lifecycle.cjs");
  createWebviewLifecycle({
    app: { on: (event, handler) => { appHandlers[event] = handler; } },
    noThrottleOpt: false,
    getAppUrl: () => "http://127.0.0.1:4291",
    clearThrottleState: () => {},
    forgetSecrets: () => {},
    dialogScript: (id, port) => `dialog:${id}:${port}`,
    webAuthnScript: "webauthn",
    botcheckScript: "botcheck",
    openerScript: "opener",
    registerSessionPrimer: (_id, parent, child) => { primers.parent = parent; primers.child = child; },
    noteFrameOrigin: () => {},
    dropChildSession: () => {},
    noteChildSession: (_id, sid, dbg) => {
      if (childSessions.has(sid)) return;
      childSessions.add(sid);
      primers.child(dbg, sid);
    },
    randomUuid: () => "uuid-1",
    registerPopup: () => {},
    unregisterPopup: () => {},
    setThrottleReason: () => {},
    reconcilePopupThrottling: () => {},
    ctlSend: () => {},
  });
  if (typeof appHandlers["web-contents-created"] !== "function") throw new Error("web-contents-created 훅이 등록되지 않았다");
  appHandlers["web-contents-created"](null, wc);
  if (typeof openHandler !== "function") throw new Error("window open handler가 등록되지 않았다");
  // cdp-session 이 첫 부착 때 실행하는 primer 를 대신 실행한다. 생성 시점에는 실행되지 않아야 한다.
  const prime = () => primers.parent(wc, debugger_);
  return { commands, attaches, debuggerHandlers, openHandler, sent, wc, prime };
}
// 게스트의 "새 탭으로 열기"는 disposition으로 구분해 우리 탭으로 보낸다. 그러지 않으면 흰 화면의 별도 Electron 창으로 열린다.
await checkAsync("webview lifecycle은 탭 disposition과 new-window를 가른다", async () => {
  const probe = createWebviewLifecycleProbe();
  const foreground = probe.openHandler({ url: "https://example.com/fg", disposition: "foreground-tab" });
  const background = probe.openHandler({ url: "https://example.com/bg", disposition: "background-tab" });
  const popup = probe.openHandler({ url: "https://login.example.com/", disposition: "new-window" });
  if (foreground.action !== "deny" || background.action !== "deny") throw new Error("탭 disposition을 Electron 창으로 허용한다");
  if (probe.sent.length !== 2 || probe.sent.some((item) => item.channel !== "ac-open-tab")) throw new Error(`탭 경로 전송이 ${probe.sent.length}건`);
  if (probe.sent[0].payload.background !== false || probe.sent[1].payload.background !== true) throw new Error("foreground/background 구분을 잃었다");
  if (probe.sent.some((item) => item.payload.openerWc !== 41)) throw new Error("부모 webContents 프로필 정체성을 넘기지 않는다");
  if (popup.action !== "allow" || !popup.overrideBrowserWindowOptions) throw new Error("new-window 팝업을 허용하지 않는다");
  return true;
});
await checkAsync("webview lifecycle은 자식 타깃에 스크립트 한 벌만 심는다", async () => {
  const probe = createWebviewLifecycleProbe();
  // 탭 생성만으로는 CDP 를 붙이지도, CDP 명령을 보내지도 않는다. 붙어 있는 것 자체가 봇 판정 신호다.
  if (probe.attaches.length !== 0 || probe.commands.length !== 0) {
    throw new Error(`생성 시점에 attach ${probe.attaches.length}회·CDP 명령 ${probe.commands.length}건`);
  }
  probe.prime();
  const parentScripts = probe.commands.filter((item) => !item.sessionId && item.method === "Page.addScriptToEvaluateOnNewDocument");
  if (parentScripts.length !== 4 || parentScripts.some((item) => item.params.runImmediately !== true)) {
    throw new Error(`부모 document-start 주입이 ${parentScripts.length}벌`);
  }
  if (!parentScripts.some((item) => item.params.source === "opener")) throw new Error("window.open 표식이 부모 문서에 빠졌다");
  if (!probe.commands.some((item) => !item.sessionId && item.method === "Target.setAutoAttach")
      || !probe.commands.some((item) => !item.sessionId && item.method === "Page.enable")) {
    throw new Error("탭 생성 순간 자식 타깃·프레임 목록을 열지 않는다");
  }
  const attached = { sessionId: "child-1", targetInfo: { type: "iframe" } };
  probe.debuggerHandlers.message(null, "Target.attachedToTarget", attached);
  probe.debuggerHandlers.message(null, "Target.attachedToTarget", attached);
  await Promise.resolve();
  const child = probe.commands.filter((item) => item.sessionId === "child-1");
  const childScripts = child.filter((item) => item.method === "Page.addScriptToEvaluateOnNewDocument");
  if (child.length !== 4 || childScripts.length !== 3 || childScripts.some((item) => item.params.runImmediately !== true)) {
    throw new Error(`같은 자식 타깃에 명령 ${child.length}건·스크립트 ${childScripts.length}벌`);
  }
  if (!childScripts.some((item) => item.params.source === "webauthn")) throw new Error("자식 프레임 WebAuthn 알림이 빠졌다");
  if (!childScripts.some((item) => item.params.source === "opener")) throw new Error("교차 출처 iframe 의 window.open 표식이 빠졌다");
  if (!child.some((item) => item.method === "Target.setAutoAttach")) throw new Error("중첩 자식 자동 부착이 없다");
  return true;
});
check("새 탭 요청은 창이 아니라 우리 탭으로", () => {
  const pre = read("native/electron/preload.cjs");
  return /disposition === "foreground-tab" \|\| disposition === "background-tab"/.test(webviewLifecycleSource)
    && /"ac-open-tab"/.test(webviewLifecycleSource) && /onOpenTab/.test(pre) && /acHost\.onOpenTab/.test(web);
});
check("파생 탭은 opener의 space·group·profile을 한 번에 상속", () => {
  // 끝 기준점을 이웃 함수 이름에 걸면 그 함수가 다른 파일로 옮겨갈 때 검사가 깨진다.
  // cleanupDocxRender 와 표 뷰어 조립이 각각 다른 파일로 옮겨가며 그렇게 깨졌으므로,
  // 끝 기준점은 앱 셸에 남는 것으로 잡는다. 텍스트 편집기 조립은 가운데 탭 자체라
  // 기능으로 분리될 수 없다.
  const open = sliceBetween(mainJs, "function newBrowserTab", "initTextEditor({", "파생 탭은 opener의 space·group·profile을 한 번에 상속");
  return /openerSpace = spaceOfTabId\(hit\)/.test(open)
    && /openerGroup = owner && owner\.group/.test(open)
    && /background: m\.background, profile, space: openerSpace, group: openerGroup/.test(open)
    && /if \(opts && opts\.group\) mut\.group = opts\.group;\s*bsMutate\(mut\)/.test(open)
    && !/bsMutate\(\{ op: "tab\.group"[^}]*opts\.group/.test(open);
});
check("OAuth 팝업 경로는 살아 있음", () => /overrideBrowserWindowOptions: popupByAi \? \{ \.\.\.SAFE_POPUP_WINDOW_OPTIONS, show: false \} : SAFE_POPUP_WINDOW_OPTIONS/
  .test(webviewLifecycleSource));
// 위 셋은 문자열이 있는지만 확인한다. 어느 disposition 이 어디로 가는지는 실제로 실행해야
// 알 수 있다. "새 탭으로 열기" 가 팝업 창으로 가면 사용자는 흰 화면만 있는 창을 받고,
// OAuth 팝업이 탭으로 가면 opener 가 끊겨 로그인이 끝나지 않는다. 새 탭은 부모와 같은
// 프로필이어야 하며, openerWc 를 전달하지 않으면 로그인돼 있던 사이트가 로그아웃으로 열린다.
check("새 탭은 탭으로, 팝업만 창으로 — 그리고 프로필을 물고 간다", () => {
  const { createWebviewLifecycle } = require_("../native/electron/webview-lifecycle.cjs");
  let onCreated = null;
  const fakeApp = { on: (ev, fn) => { if (ev === "web-contents-created") onCreated = fn; } };
  createWebviewLifecycle({
    app: fakeApp, noThrottleOpt: false, getAppUrl: () => "http://127.0.0.1:4291",
    clearThrottleState: () => {}, forgetSecrets: () => {}, dialogScript: () => "",
    webAuthnScript: "", botcheckScript: "",
    registerSessionPrimer: () => {}, primeSession: () => {}, noteFrameOrigin: () => {},
    dropChildSession: () => {}, noteChildSession: () => {}, randomUuid: () => "u1",
    registerPopup: () => {}, unregisterPopup: () => {}, setThrottleReason: () => {},
    reconcilePopupThrottling: () => {}, ctlSend: () => {},
  });
  if (!onCreated) throw new Error("web-contents-created 를 안 듣는다");
  let openHandler = null;
  const sent = [];
  const wc = {
    id: 7, getType: () => "webview", isDestroyed: () => false,
    on: () => {}, once: () => {}, session: { on: () => {}, setPermissionRequestHandler: () => {} },
    setBackgroundThrottling: () => {},
    setWindowOpenHandler: (fn) => { openHandler = fn; },
    hostWebContents: { isDestroyed: () => false, send: (ch, m) => sent.push([ch, m]) },
    debugger: { isAttached: () => false, attach: () => { throw new Error("no cdp"); }, on: () => {} },
  };
  try { onCreated({}, wc); } catch (e) { throw new Error("웹뷰 생성 훅이 던진다: " + e.message); }
  if (!openHandler) throw new Error("창 열기 정책을 안 건다");

  const tab = openHandler({ url: "https://a.example/x", disposition: "foreground-tab" });
  if (tab.action !== "deny") throw new Error("새 탭을 창으로 연다");
  if (sent.length !== 1 || sent[0][0] !== "ac-open-tab") throw new Error("탭 경로로 안 보낸다");
  if (sent[0][1].openerWc !== 7) throw new Error("새 탭이 부모 프로필을 안 물고 간다");
  if (sent[0][1].background !== false) throw new Error("foreground 를 background 로 연다");

  const bg = openHandler({ url: "https://a.example/y", disposition: "background-tab" });
  if (bg.action !== "deny" || sent.length !== 2 || sent[1][1].background !== true) {
    throw new Error("background-tab 이 뒤로 안 열린다");
  }
  const popup = openHandler({ url: "https://auth.example/o", disposition: "new-window" });
  if (popup.action !== "allow" || !popup.overrideBrowserWindowOptions) {
    throw new Error("OAuth 팝업을 창으로 안 연다");
  }
  const file = openHandler({ url: "file:///etc/passwd", disposition: "new-window" });
  if (file.action !== "deny") throw new Error("http(s) 아닌 주소를 연다");
  // 결제·본인인증 모듈은 빈 창을 이름과 함께 열고 폼을 그 창으로 제출한다. 막으면 사이트가 null 을 받는다.
  const blank = openHandler({ url: "about:blank", disposition: "new-window" });
  if (blank.action !== "allow") throw new Error("스크립트가 연 빈 팝업 창을 막는다");
  const blankTab = openHandler({ url: "about:blank", disposition: "foreground-tab" });
  if (blankTab.action !== "deny") throw new Error("빈 새 탭 요청을 창으로 연다");
  if (sent.length !== 2) throw new Error("팝업·차단 경로가 탭으로 샌다");
  return true;
});
// 크기 없는 window.open(url) 은 target=_blank 링크와 같은 foreground-tab 요청으로 와서 탭으로 열리고,
// 사이트는 null 을 받아 "팝업 차단" 알림을 띄운다. 표식 스크립트를 실제로 실행해 스크립트 호출만
// 팝업(new-window)으로 분류되게 표식을 붙이는지, 반환값을 버리는 호출은 그대로 두는지 확인한다.
check("스크립트 window.open 은 팝업 표식을 달고 noopener·_self 는 그대로", () => {
  const { OPENER_SCRIPT } = require_("../native/electron/browser-hardening.cjs");
  const calls = [];
  const win = { open: function (u, t, f) { calls.push([u, t, f]); return "handle"; } };
  new Function("window", OPENER_SCRIPT)(win);
  if (win.open("https://pay.example/", undefined, undefined) !== "handle") throw new Error("원래 반환값을 돌려주지 않는다");
  win.open("", "payWin");
  win.open("https://a.example/", "x", "width=400");
  win.open("https://a.example/", "_blank", "noopener");
  win.open("https://a.example/", "_self");
  const want = [
    ["https://pay.example/", undefined, "iris-opener"],
    ["", "payWin", "iris-opener"],
    ["https://a.example/", "x", "width=400,iris-opener"],
    ["https://a.example/", "_blank", "noopener"],
    ["https://a.example/", "_self", undefined],
  ];
  const got = JSON.stringify(calls), exp = JSON.stringify(want);
  if (got !== exp) throw new Error(`표식 결과 ${got}`);
  new Function("window", OPENER_SCRIPT)(win);   // 두 번 주입돼도 표식은 한 번만 붙는다
  calls.length = 0; win.open("https://a.example/");
  if (calls[0][2] !== "iris-opener") throw new Error(`두 번 주입 뒤 표식 ${calls[0][2]}`);
  return true;
});
check("window.open 표식은 실제 웹뷰 훅과 사람 탭 주입에 연결된다", () => {
  const main = read("native/electron/main.cjs");
  return /openerScript: OPENER_SCRIPT,/.test(main)
    && /for \(const src of \[webAuthnScript, botcheckScript, dlgSrc, openerScript\]\)/.test(webviewLifecycleSource);
});
// 사람이 누른 경우와 AI 가 조작한 경우는 결과가 달라야 한다. 소스에 분기가 있는지가 아니라
// 두 경우를 실제로 실행해 확인한다. AI 가 연 팝업은 보이지 않게 만들어져야 하고, 새 탭은
// 배경으로 열려야 한다. 그러지 않으면 사용자가 입력하던 포커스와 보고 있던 화면이 바뀐다.
check("AI 가 밟아서 뜬 팝업·새 탭은 앞으로 안 나온다", () => {
  const { createWebviewLifecycle } = require_("../native/electron/webview-lifecycle.cjs");
  const run = (byAi) => {
    let onCreated = null;
    createWebviewLifecycle({
      app: { on: (ev, fn) => { if (ev === "web-contents-created") onCreated = fn; } },
      noThrottleOpt: false, getAppUrl: () => "http://127.0.0.1:4291",
      clearThrottleState: () => {}, forgetSecrets: () => {}, dialogScript: () => "",
      webAuthnScript: "", botcheckScript: "",
      registerSessionPrimer: () => {}, primeSession: () => {}, noteFrameOrigin: () => {},
      dropChildSession: () => {}, noteChildSession: () => {}, randomUuid: () => "u1",
      registerPopup: () => {}, unregisterPopup: () => {}, setThrottleReason: () => {},
      reconcilePopupThrottling: () => {}, ctlSend: () => {},
      aiDriving: () => byAi, topWindowNow: () => null,
    });
    let openHandler = null;
    const sent = [];
    onCreated({}, {
      id: 7, getType: () => "webview", isDestroyed: () => false,
      on: () => {}, once: () => {}, session: { on: () => {}, setPermissionRequestHandler: () => {} },
      setBackgroundThrottling: () => {},
      setWindowOpenHandler: (fn) => { openHandler = fn; },
      hostWebContents: { isDestroyed: () => false, send: (ch, m) => sent.push([ch, m]) },
      debugger: { isAttached: () => false, attach: () => { throw new Error("no cdp"); }, on: () => {} },
    });
    openHandler({ url: "https://a.example/x", disposition: "foreground-tab" });
    const popup = openHandler({ url: "https://auth.example/o", disposition: "new-window" });
    return { tabBackground: sent[0][1].background, popupShow: popup.overrideBrowserWindowOptions.show };
  };
  const human = run(false), ai = run(true);
  if (human.tabBackground !== false) throw new Error("사람이 연 새 탭이 뒤로 간다");
  if (human.popupShow !== true) throw new Error("사람이 연 팝업이 안 뜬다");
  if (ai.tabBackground !== true) throw new Error("AI 가 연 새 탭이 앞으로 나온다");
  if (ai.popupShow !== false) throw new Error("AI 가 연 팝업이 떴다가 내려간다 — 만들 때부터 안 보여야 한다");
  return true;
});
check("빈 새 탭은 주소창을 잡고 전체 선택(붙여넣기 한 번)", () => /urlInput\.focus\(\); urlInput\.select\(\)/.test(web));
// datalist는 화살표 이동 표시·Esc 복귀를 제어할 수 없어 직접 구현했다. 되돌아가면 두 동작이 사라진다.
check("주소창 제안은 직접 구현(datalist 아님)", () => !/id="url-history"/.test(web) && /id="url-sug"/.test(web) && /export function moveSug/.test(bookmarks));
check("Esc는 원래 입력으로 복귀", () => /urlInput\.value = sugTyped; closeSug\(\)/.test(bookmarks));
// 목록은 주소창 "입력칸"에 붙어야 한다. .urlbar 전체를 기준으로 두면 버튼 폭까지 포함해 왼쪽 끝이
// 창 끝에서 시작한다. 입력칸만 감싼 래퍼가 기준 박스여야 한다.
check("제안 목록의 위치 기준이 입력칸(창 끝 아님)", () => {
  // 형식이 아니라 관계를 확인한다. 입력칸과 제안 목록이 같은 래퍼 안에 있고, 그 래퍼가 기준 박스여야 한다.
  const wrap = sliceBetween(web, '<div class="url-wrap">', '<div class="ub-tools">', "제안 목록의 위치 기준이 입력칸(창 끝 아님)");
  return /id="url"/.test(wrap) && /id="url-sug"/.test(wrap)
    && /\.url-wrap \{[^}]*position:relative/.test(css("18-browser"))
    && !/\.urlbar \{[^}]*position:relative/.test(allCss);
});
// about:blank를 거치면 이동이 늦게 끝나 그 시점의 did-navigate가 주소창을 덮어쓰고 붙여넣은 주소가 사라진다.
check("새 탭은 곧바로 목적지를 연다", () => /const historyFallbackUrl = initialUrl \|\|/.test(webviewFactory)
  && /el\.setAttribute\("src", historyToken \? historyStage\.src : historyFallbackUrl\)/.test(webviewFactory));
// 새 탭은 구글이 제공하는 화면을 그대로 쓰고, 직접 만든 대체 페이지는 두지 않는다.
check("새 탭 기본 페이지가 구글 원본", () =>
  /const DEFAULT_URL = "https:\/\/www\.google\.com\/"/.test(web) && !existsSync(path.join(ROOT, "web/newtab.html")));
check("새 탭에선 주소창이 비어 보임(크롬처럼)", () => {
  const n = (allWebJs.match(/isNewTab\(/g) || []).length;
  return /const isNewTab = \(u, rec\)/.test(web) && n === 4; // did-navigate·in-page·탭전환 2곳
});
// 방금 연 탭만 주소창이 비어 있다. 사용자가 직접 google.com에 가면 주소가 보여야 하므로 첫 이동인지로 구분한다.
check("직접 방문한 구글은 주소가 보임", () =>
  /rec\.navs = \(rec\.navs \|\| 0\) \+ 1/.test(webviewFactory) && /\(rec\.navs \|\| 0\) <= 1/.test(web));
check("주소창 편집 중이면 이동이 덮어쓰지 않음", () => {
  const n = (webviewFactory.match(/document\.activeElement !== urlInput/g) || []).length;
  return n >= 2; // did-navigate · did-navigate-in-page 두 경로 모두
});

}
