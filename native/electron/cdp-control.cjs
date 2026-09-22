// AI→브라우저 제어(Chrome-in-Claude식). Orca 방식 이식: Electron webContents.debugger(내장 CDP)로
// 임베드 webview를 직접 조종한다. 외부 Chrome·Playwright 없이 "띄워둔 그 페이지"를 refs로 보고 조작.
//
// 경로: 터미널 AI가 `iris-browser <cmd>` 실행 → 서버(4271) POST /browser-cmd → 서버가 이 실행기(main이
// 서버에 붙인 WS)로 cdp-exec 전달(활성 브라우저 webContentsId 포함) → 여기서 CDP 실행 → 결과 반환.
// 대상 탭 wc는 서버가 렌더러의 browser-active-wc 보고로 추적한다. AC5: /browser-cmd는 로컬 전용.
const WebSocket = require("ws");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { dialog, BrowserWindow, nativeImage, webContents: electronWebContents } = require("electron");
const { buildSnapshot } = require("./snapshot-engine.cjs");
const { artifactDir } = require("../../server/artifacts-home.cjs");
const { port: acPort } = require("../../server/env.cjs");

// 찍은 화면이 쌓이는 위치. 개발 인스턴스와 설치된 앱이 같은 폴더를 쓰면 개발 회차의 증거가
// 설치된 앱 것과 섞여 증거의 출처를 구분할 수 없다. 상태 폴더는
// state-home.cjs 가, 그 안의 부산물 위치는 artifacts-home.cjs 가 정한다.
const SHOTS_DIR = artifactDir("shots");

// 사람이 읽는 문구는 고쳐질 수 있지만 서버의 재시도·복구 판단은 흔들리면 안 된다. 오류를 만든
// 자리에서 짧은 code를 함께 붙이고, 맨 아래 WS 결과 봉투가 그 값을 그대로 전달한다.
const ERROR_CODES = Object.freeze({
  STALE_REF: "stale_ref",
  NO_SNAPSHOT: "no_snapshot",
  TAB_GONE: "tab_gone",
  SESSION_DETACHED: "session_detached",
  NOT_FOUND: "not_found",
  TIMEOUT: "timeout",
  AMBIGUOUS: "ambiguous",
  WINDOW_NOT_DRAWING: "window_not_drawing",
  CDP_BLOCKED: "cdp_blocked",
});
function codedError(code, message) { const e = new Error(message); e.code = code; return e; }
function tagError(error, code) {
  if (error && typeof error === "object") { error.code = error.code || code; return error; }
  return codedError(code, String(error));
}

// ref map과 navigation/snapshot 세대는 한 불변식이므로 독립된 상태 소유 모듈 하나가 함께 관리한다.
const refRegistry = require("./cdp-ref-registry.cjs");
const { withLayout } = require("./cdp-layout.cjs");
const { createUploadController } = require("./cdp-upload.cjs");
const { createAiCausality } = require("./ai-causality.cjs");
const resultSafety = require("./cdp-result-safety.cjs");
const overlay = require("./cdp-overlay.cjs");
const { createCdpSession } = require("./cdp-session.cjs");
const { createCdpAttachPolicy } = require("./cdp-attach-policy.cjs");
const { isGoogleAuthUrl, identityOwnsDebugger } = require("./google-auth-user-agent.cjs");
const { loginHint, humanHint } = require("./cdp-hints.cjs");
const { createObservation } = require("./cdp-observation.cjs");
const observation = createObservation({
  captureHold: (wcId, on) => captureHold ? captureHold(wcId, on) : false,
  isTabShown: (wcId) => isTabShown(wcId),
  now: Date.now,
  shotsDir: SHOTS_DIR,
});
const { createHiddenViewport } = require("./cdp-hidden-viewport.cjs");
const hiddenViewport = createHiddenViewport({
  isTabShown: (wcId) => isTabShown(wcId),
  shownStateKnown: () => shownStateKnown(),
  hasExplicitDevice: (wcId) => deviceEmulation.hasExplicitDevice(wcId),
  navigationEpoch: (wcId) => refRegistry.navigationEpoch(wcId),
  now: Date.now,
  isDisabled: () => process.env.IRIS_NO_HIDDEN_VP === "1",
});
const { createDeviceEmulation } = require("./cdp-device-emulation.cjs");
const { createPageCommands } = require("./cdp-cmd-page.cjs");
const { createInputCommands } = require("./cdp-cmd-input.cjs");
const { createInspectCommands } = require("./cdp-cmd-inspect.cjs");
const { createCaptureCommands } = require("./cdp-cmd-capture.cjs");
const { createNativeCommands } = require("./cdp-cmd-native.cjs");
const { createCdpCaptureTools } = require("./cdp-capture-tools.cjs");
const { createCdpTransport } = require("./cdp-transport.cjs");
const deviceEmulation = createDeviceEmulation({
  attach: (wc) => ensureAttached(wc, { observe: false }),
  yieldToExplicitViewport: (wcId) => hiddenViewport.yieldToExplicitViewport(wcId),
  notify: (wcId, box) => { if (viewportNotify) viewportNotify(wcId, box); },
});
const commandWebContentsMods = new WeakMap();
// ── OS 네이티브 창(AX) ───────────────────────────────────────────────────────
const nativeAx = require("./cdp-native-ax.cjs");

const upload = createUploadController({
  isAbsolute: path.isAbsolute,
  existsSync: fs.existsSync,
  showOpenDialog: (owner, options) => owner ? dialog.showOpenDialog(owner, options) : dialog.showOpenDialog(options),
  windowFromWebContents: (contents) => BrowserWindow.fromWebContents(contents),
  recordUpload: (wcId, result) => observation.setLastUpload(wcId, result),
  clearChooser: (wcId) => observation.setFileChooser(wcId, null),
  aiDriving: (wcId) => aiDriving(wcId),
});

// 다운로드 저장 위치. 무장돼 있을 때만 자동 저장하고, 아니면 사람이 네이티브 창에서 고른다.
// 저장 위치는 탭 상태가 아니라 사람의 취향이라 모든 탭에 공유한다.
// main의 will-download와 같은 원시 객체를 고치지 않고 상태 소유 모듈의 의미 함수로만 만난다.
const downloadState = require("./download-state.cjs");

const cdpTransport = createCdpTransport({
  WebSocket,
  port: acPort(),
  cdpExec: (webContentsMod, wcId, cmd, args) => cdpExec(webContentsMod, wcId, cmd, args),
  codedError,
  tabGoneCode: ERROR_CODES.TAB_GONE,
  execPath: process.execPath,
  pid: process.pid,
});
const { ctlSend, setupCdpControl } = cdpTransport;

function liveWc(wcId) {
  try { const wc = electronWebContents.fromId(Number(wcId)); return wc && !wc.isDestroyed() ? wc : null; } catch { return null; }
}
// CDP 는 붙어 있는 것만으로 봇 판정 신호가 된다(Google 로그인·Cloudflare). 그래서 AI 가 그 탭을 다루는
// 동안과 세션에 묶인 상태(녹화·지목·기기 에뮬레이션·대화상자/업로드 계획)가 남아 있는 동안만 붙여 두고,
// Google 로그인 호스트에서는 어느 경우에도 붙이지 않는다. 탐색이 시작되면 목적지를 미리 알아야
// 커밋 전 틈에 들어온 명령이 로그인 페이지에 CDP 를 붙이는 일을 막을 수 있다.
const pendingNavigation = new Map(); // wcId → 진행 중인 main-frame 탐색의 목적지
function policyUrl(wcId) {
  const pending = pendingNavigation.get(Number(wcId)) || "";
  const wc = liveWc(wcId);
  let current = ""; try { current = wc ? wc.getURL() : ""; } catch {}
  // 나가는 문서와 들어오는 문서 중 하나라도 금지 호스트면 그쪽을 답한다.
  if (isGoogleAuthUrl(pending)) return pending;
  if (isGoogleAuthUrl(current)) return current;
  return pending || current;
}
const attachPolicy = createCdpAttachPolicy({
  keepers: [
    (wcId) => overlay.hasActive(wcId),
    (wcId) => deviceEmulation.hasExplicitDevice(wcId),
    (wcId) => { const plan = planFor(wcId); return plan.queue.length > 0 || !!plan.mode; },
    (wcId) => upload.armed(wcId),
  ],
  blockedUrl: isGoogleAuthUrl,
  currentUrl: policyUrl,
  detach: (wcId) => { const wc = liveWc(wcId); if (wc) detachAiSession(wc); },
});
// AI 세션만 뗀다. Google 정체성 모듈이 Firefox UA 전달용으로만 붙여 둔 debugger(소유 중, document 계약
// 없음)는 로그인 호스트에서 계속 필요하므로 둔다. 그 위에 AI 세션이 준비됐으면 함께 뗀다.
function detachAiSession(wc) {
  let attached = false; try { attached = wc.debugger.isAttached(); } catch {}
  if (!attached) return false;
  if (identityOwnsDebugger(wc) && !cdpSession.primed(wc.id)) return false;
  try { detachIdle(wc); } catch {}
  return true;
}
const cdpSession = createCdpSession({
  observation,
  hiddenViewport,
  overlay,
  refRegistry,
  upload,
  deviceEmulation,
  ctlSend: (message) => ctlSend(message),
  tagError,
  sessionDetachedCode: ERROR_CODES.SESSION_DETACHED,
  aiDriving: (wcId) => aiDriving(wcId),
  allowAttach: (wc) => attachPolicy.allowAttach(wc.id),
  attachBlockedCode: ERROR_CODES.CDP_BLOCKED,
});
const { ensureAttached, resetCdpSession, detachIdle, registerSessionPrimer,
  noteChildSession, dropChildSession, childrenOf, noteFrameOrigin, planFor } = cdpSession;
// webview-lifecycle 이 main-frame 탐색마다 부른다. url 이 null 이면 탐색이 끝난 것이다.
// 금지 호스트로 들어가는 순간 붙어 있던 CDP 를 즉시 뗀다.
function noteNavigation(wcId, url) {
  const id = Number(wcId);
  if (url == null) { pendingNavigation.delete(id); attachPolicy.reconsider(id); return false; }
  pendingNavigation.set(id, String(url));
  if (!isGoogleAuthUrl(url)) return false;
  const wc = liveWc(id);
  const detached = wc ? detachAiSession(wc) : false;
  attachPolicy.reconsider(id);
  return detached;
}
function forgetAttachPolicy(wcId) { pendingNavigation.delete(Number(wcId)); attachPolicy.forget(wcId); }
// Google 정체성 모듈이 인증 호스트를 떠나 정체성 전용 attach 의 소유를 내려놓을 때 부른다.
function reconsiderAttach(wcId) { attachPolicy.reconsider(wcId); }
const captureTools = createCdpCaptureTools({ refRegistry, fs, path, nativeImage, BrowserWindow });
const { screencastShot, waitRenderIdle, readZoom, setZoom, viewportClip,
  stitchFullPage, rectOf, pruneShots, diffPng, samePng } = captureTools;

// ref↔대상 결속 검증 후 refMap 엔트리를 돌려준다(click·fill 공유). snapshot과 같은 탭·같은 페이지
// 세대에서만 유효하며, 탭 변경·페이지 이동 시 stale ref를 거부한다.
// 조작 대상 노드 해석. snapshot ref(@e5)와 CSS 선택자를 모두 받는다. 녹화 재현 스크립트는
// snapshot 없이 바로 실행해야 하므로 선택자 경로가 필요하다. 선택자는 페이지 세대에 묶이지 않는다.
// 페이지 위에 표시를 그린다. 찍은 뒤 전부 지우므로 페이지에 남는 것은 없다.
// 번호 뱃지 + 테두리 + 설명 띠. 무엇을 보라는 것인지 한눈에 알게 하는 최소 구성이다.
const DRAW_MARKS = function (spec) {
  const old = document.getElementById("__ac_marks__"); if (old) old.remove();
  const root = document.createElement("div");
  root.id = "__ac_marks__";
  root.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;";
  let n = 0;
  for (const b of spec.boxes || []) {
    const d = document.createElement("div");
    if (b.mask) {
      d.style.cssText = `position:absolute;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;background:#111;border-radius:3px;`;
      root.appendChild(d); continue;
    }
    n++;
    const c = b.color || "#FF3B6B";
    d.style.cssText = `position:absolute;left:${b.x - 3}px;top:${b.y - 3}px;width:${b.w + 6}px;height:${b.h + 6}px;`
      + `border:3px solid ${c};border-radius:5px;box-shadow:0 0 0 3px rgba(255,255,255,.75),0 4px 14px rgba(0,0,0,.35);`;
    root.appendChild(d);
    const tag = document.createElement("div");
    tag.textContent = b.label ? n + ". " + b.label : String(n);
    tag.style.cssText = `position:absolute;left:${b.x - 3}px;top:${Math.max(0, b.y - 31)}px;background:${c};color:#fff;`
      + "font:600 13px/1.5 -apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo',sans-serif;padding:3px 9px;border-radius:5px;"
      + "white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.35);max-width:70vw;overflow:hidden;text-overflow:ellipsis;";
    root.appendChild(tag);
  }
  if (spec.caption) {
    const cap = document.createElement("div");
    cap.textContent = spec.caption;
    cap.style.cssText = "position:fixed;left:0;right:0;bottom:0;background:rgba(10,22,32,.94);color:#EAF3FA;"
      + "font:500 14px/1.5 -apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo',sans-serif;padding:11px 16px;"
      + "border-top:3px solid #FF3B6B;white-space:pre-wrap;";
    root.appendChild(cap);
  }
  document.body.appendChild(root);
  return n;
}.toString();
// 요소를 찾은 프레임까지 함께 돌려준다({ backendNodeId, sid }). sid가 null이면 최상위 문서다.
// 교차 출처 iframe은 별도 타깃이라 최상위 세션의 DOM.querySelector 로는 찾지 못한다(확인 결과:
// 다른 출처의 iframe 안 주문서 버튼이 "선택자에 맞는 요소가 없습니다"). 최상위부터 순회하고,
// 없으면 붙어 있는 자식 세션을 차례로 본다. 먼저 찾은 프레임을 쓰므로 최상위가 우선이다.
async function nodeFromArgs(send, wc, args) {
  const sel = args && args.sel ? String(args.sel) : null;
  if (!sel) { const e = refRegistry.resolveRef(wc.id, args && args.ref); return { backendNodeId: e.backendDOMNodeId, sid: e.sid || null }; }
  for (const sid of send.frames()) {
    await send.ask(sid, "DOM.enable");
    const doc = await send.ask(sid, "DOM.getDocument", { depth: 1 });
    if (!doc || !doc.root) continue;
    const q = await send.ask(sid, "DOM.querySelector", { nodeId: doc.root.nodeId, selector: sel });
    if (!q || !q.nodeId) continue;
    const d = await send.ask(sid, "DOM.describeNode", { nodeId: q.nodeId });
    if (d && d.node && d.node.backendNodeId) return { backendNodeId: d.node.backendNodeId, sid };
  }
  throw codedError(ERROR_CODES.NOT_FOUND, "선택자에 맞는 요소가 없습니다: " + sel);
}
// 모든 명령을 순차 실행한다. snapshot은 페이지 전역(window.__acCursorInteractive)을 쓰므로 동시 실행 시
// 서로 덮어써 이름·노드가 뒤섞일 수 있다. 큐로 직렬화해 그 경합을 막는다.
const cdpQueues = new Map(); // wcId → 그 탭의 직렬 큐. 탭 사이는 서로를 막지 않는다.
const CMD_TIMEOUT_MS = 25000; // 서버의 30s보다 짧게 잡는다. 이유 있는 오류가 먼저 도착하게 하기 위해서다.
// 멈춘 탭이 큐를 영구히 물고 있지 않도록 명령 단위로 끊는다. 아래 CDP 약속은 영영 안 끝날 수 있는데,
// 그건 그 탭의 사정이고 다음 명령·다른 탭이 그것을 기다릴 이유는 없다.
function withCmdTimeout(promise, wcId, cmd) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const open = observation.dialogOpen(wcId);
      reject(codedError(ERROR_CODES.TIMEOUT,
        `이 탭이 ${Math.round(CMD_TIMEOUT_MS / 1000)}초 동안 ${cmd}에 응답하지 않았습니다(wc=${wcId}).`
        + (open
          ? ` 대화상자가 떠 있어 페이지가 멈춰 있습니다(${open.type}: "${open.message}"). 사람이 닫거나 \`iris-browser dialogs ok\`로 무장한 뒤 다시 시도하세요.`
          : cmd === "screenshot" || cmd === "observe" || cmd === "diff"
            ? " 페이지가 멈춰 있거나(모달·무한 루프·resolve 안 되는 promise), 그 탭의 창이 최소화·숨김"
              + " 상태라 그리기가 멈춰 있을 수 있습니다 — 창을 띄워 달라고 사람에게 부탁하고 다시 찍으세요"
              + "(browser_ask_user). 다른 창에 그냥 가려진 것만으로는 멈추지 않습니다."
            : " 페이지가 멈춰 있을 수 있습니다(모달·무한 루프·resolve 안 되는 promise).")
        + " 다른 탭은 영향받지 않습니다."));
    }, CMD_TIMEOUT_MS);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}
// 막힌 것을 푸는 명령은 대기열에 서면 안 된다. 명령은 탭마다 한 줄로 실행되는데, 확인 창에 걸려
// 멈춘 명령 뒤에 서면 그것을 닫을 명령까지 함께 갇혀 아무것도 실행할 수 없다.
// 이 명령들은 페이지가 멈춰 있어도 실행되는 것들이다(브라우저 층 또는 OS 접근성).
const QUEUE_BYPASS = new Set(["dialog", "dialogs", "nativewin", "nativeclick", "nativekey", "handoff"]);
// CDP 없이 실행되는 명령. Google 로그인 호스트에서는 이것만 허용한다. tabs·target·newtab 은 서버가
// 처리해 여기 오지 않는다. dialog 는 CDP 로 닫는 명령이라 빠지고, dialogs(계획 무장)는 장부만 바꾼다.
const CDP_FREE_CMDS = new Set(["goto", "url", "back", "forward", "reload", "wait", "text", "screenshot",
  "login", "dialogs", "download", "nativewin", "nativekey", "nativeclick"]);
// 그림이 실제로 나와야 답이 되는 명령. 창이 그리지 않으면 이것만 실행할 수 없다.
// observe 는 여기 없다. 촬영할 때 안에서 screenshot 을 다시 부르므로 그 호출이 스스로 걸린다.
// 그래서 screenshot:false 로 부른 observe(진단 버퍼만 읽는다)는 막히지 않는다.
// diff 도 없다. 이미 찍어 둔 그림 파일 둘을 읽을 뿐이라 창이 그리지 않아도 된다.
const NEEDS_PIXELS = new Set(["screenshot"]);
// 합성된 키는 그 webview 가 그려지고 있어야 도달한다. login 은 예외로, 키를 만들어 보내지 않고
// preload IPC 로 값을 넣으므로 그림이 필요 없다.
const KEYS_NEED_PAINT = (cmd) => NEEDS_KEYS.has(cmd) && cmd !== "login";
// AI 가 지금 이 탭을 조작 중인가. 사용자가 누른 것과 AI 가 누른 것을 구분해야 하는 자리가 여럿이다.
// 팝업을 앞으로 낼지, 새 탭을 활성으로 열지, 파일 선택창·저장 창·권한 창을 띄울지가 여기에 달렸다.
// 보고 있는 탭인지로는 구분할 수 없다. 사용자가 콘솔에서 터미널을 쓰는 동안 AI 가 그 창의 활성
// 탭을 조작하는 일이 흔하기 때문이다. 판정 자체는 ai-causality.cjs 가 소유한다.
// 페이지를 건드리지 않는 명령은 인과로 세지 않는다. 이것들이 실행되는 동안에도 AI 로 분류하면,
// 그 사이 사용자가 누른 다운로드가 취소되고 파일 선택창이 빈 채로 닫힌다.
// 페이지 상태를 읽기만 하거나 우리 장부만 보는 것들이다.
const READ_ONLY_CMDS = new Set(["snapshot", "text", "url", "tabs", "shotsizes", "screenshot",
  "diff", "a11y", "locate", "expect", "picks", "app-picks", "nativewin", "observe", "history"]);
const causality = createAiCausality();
function enterAiCommand(wcId, cmd) { return READ_ONLY_CMDS.has(cmd) ? null : causality.enter(wcId); }
function leaveAiCommand(ticket) { causality.leave(ticket); }
function aiDriving(wcId) { return causality.driving(wcId); }
// 어디서든 AI 명령이 실행 중인가. 그 순간 새로 생긴 창·webview 는 그 명령이 만든 것이다.
function aiDrivingAnywhere() { return causality.anyDriving(); }
// 그 명령이 만든 창에 표식을 물려준다. 돌려주는 함수를 부를 때까지 그 wc 는 AI 로 분류된다.
function holdAiCausality(wcId) { return causality.hold(wcId); }

// 디버거 세션이 끊긴 것("target closed"·"detached")은 실패가 아니라 상태이며, 다시 붙이면 그대로
// 이어갈 수 있다. 이 오류를 그대로 내보내면 그 탭에서 이후 명령이 모두 실패한다.
const DEAD_SESSION_RE = /target closed|detached from target|not attached|session closed|no session with given id|session .*(?:not found|does not exist)/i;

async function execWithReattach(webContentsMod, wcId, cmd, args) {
  const out = await execWithReattachRaw(webContentsMod, wcId, cmd, args);
  try {
    const ms = observation.drainMoments(wcId);
    if (ms && out && typeof out === "object" && !Array.isArray(out)) { out.moments = ms.list; ms.commit(); }
  } catch {}
  return out;
}

async function execWithReattachRaw(webContentsMod, wcId, cmd, args) {
  try {
    return await cdpExecRaw(webContentsMod, wcId, cmd, args);
  } catch (e) {
    // 관문이 막은 것은 끊긴 세션이 아니다. 다시 붙여도 같은 답이므로 그대로 알린다.
    if (e && e.code === ERROR_CODES.CDP_BLOCKED) throw e;
    if (!DEAD_SESSION_RE.test(String((e && e.message) || e))) throw e;
    const wc = webContentsMod.fromId(Number(wcId));
    if (!wc || wc.isDestroyed()) throw tagError(e, ERROR_CODES.TAB_GONE);
    resetCdpSession(wc);
    return await cdpExecRaw(webContentsMod, wcId, cmd, args).catch((retryError) => {
      if (DEAD_SESSION_RE.test(String((retryError && retryError.message) || retryError)))
        throw tagError(retryError, ERROR_CODES.SESSION_DETACHED);
      throw retryError;
    });   // 한 번만 다시
  }
}
// Electron webContents 조회는 조립부에 남기고, 상태와 명령 판정은 hidden viewport 소유 모듈에 맡긴다.
function pinHiddenViewport(wc, opts) {
  try {
    if (!wc || wc.isDestroyed()) return;
    const dbg = wc.debugger;
    if (!dbg.isAttached()) return;
    hiddenViewport.pin(wc.id, (method, params) => dbg.sendCommand(method, params || {}), opts);
  } catch {}
}
// opts.onlyIfCollapsed 는 방금 붙은 게스트 자리에서 쓴다. 그 자리에는 브라우저 탭이 아닌
// webview 도 오는데, 장부는 탭만 알아서 그것을 안 보이는 탭으로 읽는다. 자세한 내용은 pin 옆 주석.
function pinHiddenViewportById(wcId, webContentsMod, opts) {
  try { const wc = webContentsMod && webContentsMod.fromId(Number(wcId)); if (wc) pinHiddenViewport(wc, opts); } catch {}
}
function clearAutoViewport(wcId, webContentsMod) {
  const id = Number(wcId);
  let send = () => Promise.resolve();
  try {
    const wc = webContentsMod && webContentsMod.fromId(id);
    if (wc && !wc.isDestroyed()) send = ensureAttached(wc, { observe: false });
  } catch {}
  return hiddenViewport.clearAutoViewport(id, send);
}
function setDefaultViewport(width, height) { hiddenViewport.setDefaultViewport(width, height); }
// 화면에서 눌러서 고르는 선택기(overlay)를 그 탭의 모든 문서에 심는다.
// 렌더러의 webview.executeJavaScript 는 최상위 프레임에서만 실행되므로, 대상이 iframe 안에
// 있는 화면에서는 눌러도 반응이 없었다. 교차 출처든 같은
// 출처든 프레임마다 별개 문서이므로, 프레임마다 각각 심어야 그 안에서 고를 수 있다.
// 새로 뜨는 문서에도 걸어 둔다. iframe 이 늦게 뜨거나 안에서 이동해도 선택 모드가 유지된다.
function injectOverlayAllFrames(wcId, key, source, on, webContentsMod) {
  const id = Number(wcId);
  const wc = webContentsMod && webContentsMod.fromId(id);
  if (!wc || wc.isDestroyed()) return false;
  const dbg = wc.debugger;
  try { ensureAttached(wc); } catch { return false; }
  const send = (method, params, sid) => sid
    ? dbg.sendCommand(method, params, sid) : dbg.sendCommand(method, params);
  const result = overlay.injectAllFrames(id, key, source, on, send, [null, ...childrenOf(id)]);
  // 녹화·지목이 꺼지면 이 탭을 붙여 둘 이유가 남았는지 다시 본다.
  if (!on) attachPolicy.reconsider(id);
  return result;
}
// 앱 창에 포커스가 없을 때 쓰는 커서 추적. 호스트가 OS 커서 좌표를 주면 그 위치에 마우스 이동을
// 한 번 보낸다. 좌표를 프레임에 직접 넘기지 않는 이유는 프레임마다 좌표계가 다르기 때문이다.
// 크로미움이 그 좌표에 맞는 프레임으로 전달하므로, iframe 안에서도 그 프레임의
// mousemove 가 제 좌표로 발생한다. 이전 경로(preload → postMessage)는 최상위 문서에만 도달해
// iframe 위에서는 하이라이트가 멈춰 있었다.
function hoverAtPoint(wcId, x, y, webContentsMod) {
  const wc = webContentsMod && webContentsMod.fromId(Number(wcId));
  if (!wc || wc.isDestroyed()) return false;
  try {
    // 관문을 지나야 한다. 지목 overlay 가 켜져 있으면 유지 조건이라 붙은 채로 있다.
    ensureAttached(wc, { observe: false });
    wc.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: Number(x) || 0, y: Number(y) || 0 }).catch(() => {});
    return true;
  } catch { return false; }
}
// 녹화가 끝났을 때 같은 타임라인에 합칠 관찰 기록. 조작만 남은 기록으로는 실패 원인을
// 되짚을 수 없다. 그 순간의 콘솔 오류·예외·실패한 요청·뜬 확인창이 함께 있어야 한 번의
// 녹화로 디버깅이 끝난다.
function diagSince(wcId, since, webContentsMod) {
  void webContentsMod;
  return observation.diagSince(wcId, since);
}
const NEEDS_KEYS = new Set(["fill", "type", "key", "login"]);
// 이 탭이 지금 화면에 그려지고 있는가. main이 렌더러 보고로 채우며, 모르면 안 보이는 쪽으로 가정한다
// (붙잡기는 보이는 탭에 걸어도 해가 없고, 반대로 빠뜨리면 입력이 조용히 사라진다).
let shownProbe = null;
function setShownProbe(fn) { shownProbe = typeof fn === "function" ? fn : null; }
// 지금 화면에 뜬 탭을 한 번이라도 보고받았는가. 받지 못했으면 어느 탭이 보이는지 모르는 것이고,
// 그 상태에서 안 보인다고 단정해 크기를 걸면 사용자가 보고 있는 탭이 잘못된 크기로 고정된다.
let shownKnownProbe = null;
function setShownKnownProbe(fn) { shownKnownProbe = typeof fn === "function" ? fn : null; }
function shownStateKnown() { try { return !!(shownKnownProbe && shownKnownProbe()); } catch { return false; } }
function isTabShown(wcId) { try { return !!(shownProbe && shownProbe(Number(wcId))); } catch { return false; } }
async function ensureQaReady(send, wc, cmd) {
  return hiddenViewport.ensureReady(send, wc.id, cmd);
}
function cdpExec(webContentsMod, wcId, cmd, args) {
  const key = Number(wcId) || 0;
  const guard = (p) => p.then((v) => resultSafety.redactSecrets(key, v));
  if (QUEUE_BYPASS.has(cmd)) return guard(withCmdTimeout(execWithReattach(webContentsMod, wcId, cmd, args), key, cmd));
  const prev = cdpQueues.get(key) || Promise.resolve();
  // 시간 초과로 호출자에게 실패를 돌려줘도, 그 명령은 페이지에서 아직 실행 중일 수 있다.
  // 그 자리에서 큐를 놓으면 다음 명령이 겹쳐 들어가고, 늦게 끝난 click·fill 이 나중에 적용돼
  // 실패로 보고한 조작이 실제로는 일어난 상태가 된다. 그래서 초과 시 그 탭의 CDP
  // 세션을 끊어 실행 중인 명령을 실제로 취소하고, 큐는 정리될 때까지 잡아 둔다.
  let underlying = null;
  const run = () => {
    underlying = guard(execWithReattach(webContentsMod, wcId, cmd, args));
    return withCmdTimeout(underlying, key, cmd).catch((e) => {
      if (/응답하지 않았습니다/.test(String(e && e.message))) {
        try { const wc = webContentsMod.fromId(key); if (wc && !wc.isDestroyed()) resetCdpSession(wc); } catch {}
      }
      throw e;
    });
  };
  const p = prev.then(run, run);     // 앞 작업 성공/실패와 무관하게 이어서 실행
  // 실행 중이던 것이 정리될 때까지 기다린다. 세션을 끊었으므로 곧 거부로 끝나지만,
  // 끝나지 않는 경우를 대비해 상한을 둔다. 큐가 영구히 잠기는 것이 더 나쁘다.
  const tail = p.then(() => {}, () => Promise.race([
    Promise.resolve(underlying).catch(() => {}),
    new Promise((r) => setTimeout(r, 3000)),
  ]));
  cdpQueues.set(key, tail);
  tail.then(() => { if (cdpQueues.get(key) === tail) cdpQueues.delete(key); }); // 탭이 사라져도 Map이 자라지 않게
  return p;
}

// 표는 상속 없는 객체 위에 세운다. 평범한 `{}` 로 두면 `Object.prototype` 의 이름이 명령으로
// 잡혀 `iris-browser toString` 이 "알 수 없는 명령" 안내 대신 "[object Object]" 를 돌려주고
// `__proto__` 는 `handler is not a function` 이 된다(재현 확인). 이전 switch 는 그 이름들을
// 전부 default 로 보냈으므로, 상속을 끊어야 안내 계약이 유지된다.
const commandHandlers = Object.assign(Object.create(null), {
  ...createPageCommands({ applyViewport: (wc, args) => deviceEmulation.apply(wc, args) }),
  ...createInputCommands({
    withLayout,
    nodeFromArgs,
    insertTextInChunks,
    isTabShown,
    run: runCdpCmd,
    webContentsMod: (wc) => commandWebContentsMods.get(wc),
  }),
  ...createInspectCommands({
    buildSnapshot,
    refRegistry,
    loginHint,
    humanHint,
    observation,
    downloadState,
    cdpExecRaw,
    webContentsMod: (wc) => commandWebContentsMods.get(wc),
    fs,
    path,
    shotsDir: SHOTS_DIR,
  }),
  ...createCaptureCommands({
    withLayout,
    rectOf,
    readZoom,
    setZoom,
    DRAW_MARKS,
    viewportClip,
    waitRenderIdle,
    captureHold: (wcId, on) => captureHold ? captureHold(wcId, on) : false,
    stitchFullPage,
    screencastShot,
    resetCdpSession,
    pruneShots,
    diffPng,
    samePng,
    deviceEmulation,
    cdpExecRaw,
    webContentsMod: (wc) => commandWebContentsMods.get(wc),
    fs,
    path,
    shotsDir: SHOTS_DIR,
  }),
  ...createNativeCommands({
    observation,
    planFor,
    ctlSend,
    upload,
    nodeFromArgs,
    downloadState,
    loginProvider: () => loginProvider,
    resultSafety,
    nativeAx,
    fs,
    path,
    os,
  }),
});

// Input.insertText 한 번에 붙여 넣기 크기의 문자열을 보내면 CDP 호출 하나가 오래 붙들려 전체 명령
// 25초 상한까지 먹는다(Orca도 64KiB로 잘라 보낸다). 바이트 상한으로 자르되 Intl.Segmenter의
// grapheme 경계를 써서 서로게이트 쌍·결합 문자·ZWJ 이모지를 반쪽으로 만들지 않는다.
const INSERT_TEXT_CHUNK_BYTES = 64 * 1024;
const graphemeSegmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
function* insertionGraphemes(text) {
  if (graphemeSegmenter) {
    for (const part of graphemeSegmenter.segment(text)) yield part.segment;
    return;
  }
  // 지금 지원 Electron에는 Segmenter가 있지만, 빠진 런타임에서도 최소한 결합 부호·variation
  // selector·피부색·ZWJ 연쇄는 앞 글자와 함께 둔다. Array.from 자체가 서로게이트 쌍은 보존한다.
  let cluster = "", previous = -1;
  for (const ch of Array.from(text)) {
    const cp = ch.codePointAt(0);
    const joinsPrevious = cluster && (/\p{Mark}/u.test(ch)
      || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef)
      || (cp >= 0x1f3fb && cp <= 0x1f3ff) || cp === 0x200d || previous === 0x200d);
    if (!joinsPrevious && cluster) { yield cluster; cluster = ""; }
    cluster += ch; previous = cp;
  }
  if (cluster) yield cluster;
}
function* insertionChunks(value, maxBytes = INSERT_TEXT_CHUNK_BYTES) {
  const text = String(value);
  if (!text) { yield ""; return; } // 빈 문자열도 기존처럼 한 번 보내 선택 영역 교체를 시도한다.
  let chunk = "", bytes = 0;
  for (const grapheme of insertionGraphemes(text)) {
    const nextBytes = Buffer.byteLength(grapheme, "utf8");
    if (chunk && bytes + nextBytes > maxBytes) { yield chunk; chunk = ""; bytes = 0; }
    chunk += grapheme; bytes += nextBytes;
  }
  if (chunk) yield chunk;
}
async function insertTextInChunks(send, value) {
  const chunks = insertionChunks(value);
  let next = chunks.next();
  while (!next.done) {
    await send("Input.insertText", { text: next.value });
    next = chunks.next();
    // CDP payload 사이에 메인 프로세스가 소켓·창 이벤트를 처리할 틈을 준다. 한 청크뿐이면 양보하지 않는다.
    if (!next.done) await new Promise((resolve) => setImmediate(resolve));
  }
}

// selector 로 찾은 요소를 CDP 없이 네이티브 입력으로 누른다. executeJavaScript(네이티브)로 중심 좌표를
// 구하고 네이티브 입력으로 누른다. 디버거를 붙이지 않아 Cloudflare/Turnstile 이 automation 으로
// 판정하지 않는다(확인 결과: 부착 시 ahrefs Turnstile 실패, 미부착 시 즉시 통과). 요소 없음·크기 0·화면 밖이면
// null 을 돌려 호출부가 CDP 경로로 내려간다. sendInputEvent 는 창의 입력 경로라 보이는 탭에서만 정확하다.
async function nativeClickSel(wc, sel, clickCount) {
  let rect;
  try {
    rect = await wc.executeJavaScript(
      `(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;`
      + `e.scrollIntoView({block:'center',inline:'center'});const r=e.getBoundingClientRect();`
      + `if(r.width<=0||r.height<=0)return null;return {x:r.left+r.width/2,y:r.top+r.height/2};})()`,
      true);
  } catch { return null; }
  if (!rect) return null;
  const x = Math.round(rect.x), y = Math.round(rect.y);
  try {
    wc.sendInputEvent({ type: "mouseMove", x: x - 4, y: y - 3 });
    wc.sendInputEvent({ type: "mouseMove", x, y });
    wc.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount });
    wc.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount });
  } catch { return null; }
  return { ok: true, at: { x, y }, via: "native" };
}

// [Cloudflare 통과 · 배경 탭] 배경 탭은 display:none 이라(18-browser.css) 네이티브 입력이 도달하지
// 않는다. 화면에 없는 위젯은 sendInputEvent 대상이 아니고 elementFromPoint 는 null 이다(확인 결과
// hidden-webview-click.cjs). 그러나 CDP 를 붙이면 그 순간 Cloudflare 가 봇으로 판정한다. 배경 탭에서
// CDP 없이 조작하는 유일한 방법이 페이지 안 `.click()` 이며, display:none 웹뷰에서도 클릭 핸들러가
// 동작한다(같은 확인: counter 0→1). 가림 판정은 할 수 없지만(숨은 탭에서는 의미도 적다) 페이지 안에서
// 숨겨진(offsetParent 없음)·비활성·0크기 요소는 걸러 오조작을 막는다. 요소를 찾지 못하면 null 을
// 돌려 아래 CDP 경로로 내려간다. 이 경로는 executeJavaScript 라 CDP 부착과 무관하게 동작한다.
async function jsClickSel(wc, sel, clickCount) {
  let r;
  try {
    r = await wc.executeJavaScript(
      `(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return {found:false};`
      + `e.scrollIntoView({block:'center',inline:'center'});const b=e.getBoundingClientRect();`
      + `if(e.offsetParent===null&&getComputedStyle(e).position!=='fixed')return {found:true,ok:false,why:'숨겨진 요소'};`
      + `if(e.disabled)return {found:true,ok:false,why:'비활성 요소'};`
      + `if(b.width<=0||b.height<=0)return {found:true,ok:false,why:'크기가 0인 요소'};`
      + `for(let i=0;i<${clickCount};i++)e.click();return {found:true,ok:true};})()`,
      true);
  } catch { return null; }
  if (!r || !r.found) return null;
  if (!r.ok) return { ok: false, error: r.why, via: "js-nocdp" };
  return { ok: true, via: "js-nocdp" };
}

async function cdpExecRaw(webContentsMod, wcId, cmd, args) {
  const wc = webContentsMod.fromId(wcId);
  if (!wc || wc.isDestroyed()) throw codedError(ERROR_CODES.TAB_GONE, "브라우저 탭을 찾을 수 없음(wc=" + wcId + ")");
  commandWebContentsMods.set(wc, webContentsMod);
  // [Cloudflare 통과] ref 없는 selector 클릭은 CDP 를 붙이지 않고 누른다. 붙이는 순간 이 탭이
  // 챌린지에서 봇으로 판정된다(확인 결과). 이미 붙어 있으면 먼저 뗀다. 그다음 탭 가시성으로 갈린다:
  //  - 보이는 탭 → 네이티브 입력(sendInputEvent, 실제 입력이라 대화형 Turnstile 체크박스까지 커버)
  //  - 배경 탭(display:none) → 페이지 안 `.click()`(네이티브 입력이 도달하지 못하는 유일 경로)
  // 성공하면 CDP 없이 끝낸다. 요소를 찾지 못하면(null) 아래 기존 CDP 경로로 내려가고, 요소는
  // 있으나 누를 수 없으면(가려짐·비활성·0크기) 그 사유를 돌려준다. 억지로 CDP 로 눌러 챌린지를 깨우지 않는다.
  if ((cmd === "click" || cmd === "dblclick") && args && args.sel && !args.ref) {
    try {
      if (wc.debugger.isAttached()) { try { detachIdle(wc); } catch {} }
      const clicks = cmd === "dblclick" ? 2 : 1;
      const r = isTabShown(wc.id)
        ? await nativeClickSel(wc, args.sel, clicks)
        : await jsClickSel(wc, args.sel, clicks);
      if (r) return { ...r, ref: args.sel };
    } catch {}
  }
  args = args || {};
  // 진단 조회. 부착 정책을 건드리지 않고 지금 상태만 답한다. 이 명령이 창을 열면 실측이 불가능하다.
  if (cmd === "cdpstate") return cdpState(wc);
  // 사람에게 넘기는 순간. AI 조작 창을 닫고 유지 조건이 없으면 CDP 를 바로 뗀다.
  if (cmd === "handoff") return handoff(wc);
  // Google 로그인 호스트(지금 문서·진행 중 탐색·이 goto 의 목적지)에서는 AI 세션을 붙이지 않는다.
  // Firefox 정체 전달용 attach 는 정체성 모듈 것이라 여기서 건드리지 않는다.
  const noCdp = attachPolicy.blocked(wc.id) || (cmd === "goto" && isGoogleAuthUrl(gotoTarget(args.url)));
  if (noCdp) {
    detachAiSession(wc);
    if (!CDP_FREE_CMDS.has(cmd)) {
      throw codedError(ERROR_CODES.CDP_BLOCKED,
        `로그인 호스트에서는 CDP 를 붙이지 않아 ${cmd} 를 실행할 수 없습니다. 쓸 수 있는 것: `
        + [...CDP_FREE_CMDS].join(" ") + ". 사람이 로그인해야 하면 browser_ask_user 로 넘기세요.");
    }
    const aiTicket = enterAiCommand(wc.id, cmd);
    try { return noteLoginResult(wc, cmd, await runWithoutCdp(wc, cmd, args)); }
    finally { leaveAiCommand(aiTicket); }
  }
  attachPolicy.touch(wc.id);
  const send = ensureAttached(wc);
  const aiTicket = enterAiCommand(wc.id, cmd);
  try { return noteLoginResult(wc, cmd, await cdpExecInner(send, wc, cmd, args, webContentsMod)); }
  finally { leaveAiCommand(aiTicket); }
}
// goto handler 와 같은 규칙으로 스킴을 붙인다. 판정만 하고 실제 이동은 handler 가 한다.
function gotoTarget(raw) {
  const url = String(raw || "");
  if (!url) return "";
  const hasScheme = /^(https?|data|about|blob|file):/i.test(url) || /^[a-z][a-z0-9+.-]*:\/\//i.test(url);
  return hasScheme ? url : "https://" + url;
}
// 저장된 로그인이 없어 사람이 해야 하는 자리다. 사람이 로그인하는 동안 CDP 를 붙여 두지 않는다.
function noteLoginResult(wc, cmd, out) {
  if (cmd === "login" && out && out.needUser) attachPolicy.release(wc.id);
  return out;
}
// attached 는 debugger 자체, aiSession 은 그 위의 AI 세션, identity 는 정체성 모듈이 소유한 attach 다.
function cdpState(wc) {
  let attached = false; try { attached = wc.debugger.isAttached(); } catch {}
  let url = ""; try { url = wc.getURL(); } catch {}
  return { ok: true, attached, aiSession: cdpSession.primed(wc.id), identity: identityOwnsDebugger(wc),
    blocked: attachPolicy.blocked(wc.id), url };
}
// 결과의 attached 는 AI 세션 기준이다. 로그인 호스트의 정체성 전용 attach 는 세지 않는다.
function handoff(wc) {
  const before = cdpSession.primed(wc.id);
  attachPolicy.release(wc.id);
  const after = cdpSession.primed(wc.id);
  return { ok: true, detached: before && !after, attached: after,
    ...(after ? { note: "녹화·지목·기기 에뮬레이션·대화상자/업로드 계획이 남아 있어 CDP 를 유지합니다." } : {}) };
}
// CDP 없이 되는 명령의 실행기. 기존 handler 중 send 를 안 쓰는 것은 그대로 재사용하고, send 를 쓰는
// wait·text·screenshot 만 Electron API 로 바꾼다. 실수로 send 를 부르면 관문 오류가 난다.
async function runWithoutCdp(wc, cmd, args) {
  if (cmd === "wait") return waitWithoutCdp(wc, args);
  if (cmd === "text") {
    const text = await wc.executeJavaScript("document.body ? document.body.innerText : ''", true).catch(() => "");
    return { text: String(text || ""), via: "nocdp" };
  }
  if (cmd === "screenshot") return screenshotWithoutCdp(wc, args);
  const blockedSend = () => Promise.reject(codedError(ERROR_CODES.CDP_BLOCKED, "이 페이지에서는 CDP 를 쓰지 않습니다."));
  blockedSend.on = () => blockedSend;
  blockedSend.frames = () => [null];
  blockedSend.ask = () => Promise.resolve(null);
  blockedSend.all = async () => [];
  return await commandHandlers[cmd](blockedSend, wc, args);
}
async function waitWithoutCdp(wc, args) {
  if (args.ms != null) {
    await new Promise((res) => setTimeout(res, Math.max(0, Number(args.ms))));
    return { ok: true, waited_ms: Number(args.ms) };
  }
  const timeout = 10000, start = Date.now();
  for (;;) {
    let loading = false; try { loading = wc.isLoading(); } catch {}
    if (!loading) return { ok: true, readyState: "complete", waited_ms: Date.now() - start, via: "nocdp" };
    if (Date.now() - start >= timeout) return { ok: true, readyState: "loading", waited_ms: timeout, note: "timeout", via: "nocdp" };
    await new Promise((res) => setTimeout(res, 150));
  }
}
async function screenshotWithoutCdp(wc, args) {
  const image = await wc.capturePage();
  const png = image.toPNG();
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  if (!args.path) pruneShots(SHOTS_DIR);
  const p = args.path ? String(args.path) : path.join(SHOTS_DIR, "shot-" + Date.now() + ".png");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, png);
  return { ok: true, path: p, url: wc.getURL(), title: wc.getTitle(), via: "capturePage", dpr: 1,
    note: "로그인 호스트라 CDP 없이 창 단위로 찍었습니다(표시·마스킹·전체 페이지 미지원)." };
}
async function cdpExecInner(send, wc, cmd, args, webContentsMod) {
  await ensureQaReady(send, wc, cmd);
  // 키보드 입력은 붙잡아야 도달한다. 화면에 없는 webview는 위젯이 입력 대상이 아니라서 CDP의 키·텍스트
  // 명령이 ok를 돌려주고도 도달하지 않는다(확인 결과: 포커스 에뮬레이션·wc.focus() 둘 다 부족).
  // 캡처와 같은 방식으로 그 순간에만 합성 대상으로 올리고 포커스를 준 뒤 되돌린다.
  // 붙잡는 이유는 둘이다. 키 입력이 도달하게 하는 것과, 조작 뒤 화면이 실제로 그려지게 하는
  // 것. 둘 다 같은 붙잡기를 쓰므로 한 번만 잡고 한 번만 놓는다.
  const wantsFrames = observation.animates(cmd);
  const wantsKeys = NEEDS_KEYS.has(cmd);
  // 그림이 실제로 있어야 하는 명령만 창 상태를 따진다. 보이는 탭이어도 그 창이 최소화·앱 숨김이면
  // 그림이 나오지 않으므로 보이는 탭인지보다 먼저 확인한다. 순서가 뒤집히면 이 검사가 우회된다.
  // 반대로 goto·reload·dialog 처럼 DOM·CDP 만으로 끝나는 명령까지 막으면 과도하다. 특히 dialog 는
  // 최소화된 창에 떠 있는 확인창을 닫는 유일한 방법이라, 막으면 그 창이 계속 멈춰 있다.
  if (paintableProbe && (KEYS_NEED_PAINT(cmd) || NEEDS_PIXELS.has(cmd))) {
    let paint = { ok: true };
    try { paint = paintableProbe(wc.id) || { ok: true }; } catch { paint = { ok: true }; }
    if (!paint.ok) {
      throw codedError(ERROR_CODES.WINDOW_NOT_DRAWING,
        `이 탭을 담은 창이 ${paint.why} 상태라 화면을 그리지 않습니다 — ${cmd} 를 보내도 도달하지 않습니다.`
        + " 창을 띄워 달라고 사람에게 부탁하고 다시 하세요(browser_ask_user).");
    }
  }
  if ((!wantsKeys && !wantsFrames) || !captureHold || isTabShown(wc.id))
    return await runCdpCmd(send, wc, cmd, args, webContentsMod);
  let held = false;
  try { held = await captureHold(wc.id, true); } catch { held = false; }
  try {
    const out = await runCdpCmd(send, wc, cmd, args, webContentsMod);
    // 조작이 시작시킨 트랜지션이 끝날 때까지만 더 붙잡는다. 정지 화면이면 곧바로 해제한다.
    if (held && wantsFrames) await observation.settleAnimations(send);
    return out;
  }
  finally { if (held) { try { await captureHold(wc.id, false); } catch {} } }
}
async function runCdpCmd(send, wc, cmd, args, webContentsMod) {
  const handler = commandHandlers[cmd];
  if (handler) return await handler(send, wc, args);
  switch (cmd) {
    // 무엇이 있는지 함께 알려 준다. 없다고 판단해 사람에게 넘기는 일이 있었다(확인 결과).
    default: throw new Error("알 수 없는 명령: " + cmd + ". 쓸 수 있는 것: snapshot text url screenshot shotsizes observe tabs "
      + "goto back forward reload viewport wait click dblclick hover fill type bulkfill key select focus clear check scroll scrollto "
      + "eval expect diff a11y locate "
      + "pdf login upload download dialog dialogs nativewin nativeclick nativekey newtab target untarget");
  }
}

// 탭 화면 크기와 기기 성격은 cdp-device-emulation.cjs 가 소유한다.

let loginProvider = null;
function setLoginProvider(fn) { loginProvider = fn; }
// AI가 크기를 바꾸면 주소줄 버튼도 함께 바뀌어야 한다. 그러지 않으면 버튼이 실제와 다른 크기를 표시한다.
let viewportNotify = null;
let captureHold = null;   // (wcId, on) => Promise: 캡처 동안만 그 webview를 합성 대상으로 한다
function setCaptureHold(fn) { captureHold = fn; }
// 그 탭을 담은 창이 지금 그림을 낼 수 있는가. 최소화·숨김이면 어떤 보정으로도 낼 수 없다
// (확인 결과: 가림 무시 스위치를 켜도 그 둘은 초당 0프레임). 창을 몰래 펼쳐서 맞추면
// 사용자 화면을 가져가므로, 조용히 빗나가는 대신 무엇이 막는지 알린다.
let paintableProbe = null;   // (wcId) => { ok, why }
function setPaintableProbe(fn) { paintableProbe = fn; }
function setViewportNotify(fn) { viewportNotify = fn; }
module.exports = { setupCdpControl, ctlSend, setLoginProvider, setViewportNotify, setCaptureHold,
  applyViewportTo: (wc, args) => deviceEmulation.apply(wc, args),
  setTouchDrag: (wc, on) => deviceEmulation.setTouchDrag(wc, on),
  forgetSecrets: resultSafety.forgetSecrets, clearAutoViewport, setShownProbe, setShownKnownProbe, setDefaultViewport,
  noteChildSession, dropChildSession, noteFrameOrigin, injectOverlayAllFrames, hoverAtPoint, diagSince,
  aiDriving, aiDrivingAnywhere, holdAiCausality,
  registerSessionPrimer, noteNavigation, forgetAttachPolicy, reconsiderAttach, pinHiddenViewportById, setPaintableProbe,
  // 앱 안에서도 실행기를 쓸 수 있게 연다(선택한 요소를 그 자리에서 잘라 찍는 데 쓴다).
  runCdp: (webContentsMod, wcId, cmd, args) => cdpExec(webContentsMod, wcId, cmd, args || {}) };
