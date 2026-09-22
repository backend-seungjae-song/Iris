// 소유 범위: 가려진 창의 렌더 유지, 캡처 순간의 붙잡기·놓기, clip 측정.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사·파일 도구, sources 의 공유 소스, Node 파일·경로·모듈 API.
// 유지 조건: 검사 이름과 본문. 40-qa-evidence.mjs 를 기능별로 분리한 것이며,
//   분리 과정에서 본문을 수정하지 않았다. 원본 대비 바이트 대조가 이를 보장한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부르며 sources 의 공유 상수 계약도 함께 확인한다.
//   지금 목록은 이걸로 센다: node bin/importers.mjs bin/smoke/sections/background-tab.mjs
import { mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { tmpdir } from "node:os";

import {
  b4Function, check, checkAsync, read, readAll, require_, ROOT, sourceFiles,
} from "../core.mjs";
import {
  aiState, aiTabs, allServer, archive, archiveHandlers, browserCommands, browserRuntime,
  browserTabs, browserWindowManagerSource, cdpCaptureToolsSource, cdpCmdCaptureSource, cdpCmdInputSource,
  downloadHookSource,
  cdpCmdInspectSource, cdpHiddenViewportSource, cdpObservationSource, cdpSessionSource,
  cdpTransportSource, centerTabs, contextMenu, css, herdrAgents, herdrHandlers, herdrState,
  httpHandler, main, mainJs, mcp, memoPanel, rail, xtermWiring, tabClose, terminalPanel,
  textEditor, web, webview as webviewSource, webviewFactory, webviewLifecycleSource, webviewThrottleSource, wsCore,
} from "../sources.mjs";
import { sliceBetween, sliceFrom } from "../../slice-anchor.mjs";

export default async function run() {
console.log("\n[10j] 보고 있지 않은 탭도 QA 대상");
{
  const cdp = read("native/electron/cdp-control.cjs"), capture = cdpCmdCaptureSource,
        mainH = read("native/electron/main.cjs"),
        pre = read("native/electron/preload.cjs");
  // 문자열이 파일에 있는지만 확인하면, 이 스위치들이 IRIS_NO_THROTTLE_OPT 안에 들어가 있어도
  // 통과한다. 기본 실행에서 꺼진 채로 남으면 가려진 창을 캡처하지 못하고, 창을 앞으로 올려
  // 보완하면 사용자 포커스를 빼앗는다. 롤백 블록을 제외한 범위에 스위치가
  // 있는지까지 확인한다.
  check("가려진 창도 계속 그린다(롤백 스위치 밖)", () => {
    const rollback = sliceBetween(mainH, "if (NO_THROTTLE_OPT) {", "\n}", "main.cjs 롤백 스위치");
    return /appendSwitch\("disable-backgrounding-occluded-windows"\)/.test(mainH)
      && /CalculateNativeWinOcclusion/.test(mainH)
      && !/disable-backgrounding-occluded-windows/.test(rollback)
      && !/CalculateNativeWinOcclusion/.test(rollback);
  });
  // 캡처하려고 창을 앞으로 올리지 않는다. 올리는 API 는 되돌리는 짝이 없어서, 한 번 올리면
  // 사용자가 보던 화면 위에 그대로 남는다.
  check("찍을 때 창을 앞으로 올리지 않는다", () => {
    const hold = sliceBetween(mainH, "setCaptureHold(async (wcId, on) => {", "\n});", "setCaptureHold");
    return !/moveTop\(\)/.test(hold) && !/showInactive\(\)/.test(hold)
      && !/\.focus\(\)/.test(hold) && !/\.restore\(\)/.test(hold)
      && /host\.send\("ac-capture-hold"/.test(hold);
  });
  // AI 때문에 실행되는 경로에서는 창을 앞으로 내지 않는다. 앞으로 내면 사용자가 다른 앱에서 치던
  // 키 입력을 가져가고 보던 화면을 덮는다. 창이 있기만 하면 탭은 표시된다.
  check("AI 탭 때문에 여는 분리 창은 뒤에서 열린다", () => {
    const ask = sliceBetween(aiTabs, "if (!BROWSER_MODE && getBrowserState().docked === false)", "\n  }", "ai-tabs 분리창 요청");
    if (!/acHost\.openBrowser\(\{ background: true \}\)/.test(ask)) return false;
    const create = sliceBetween(browserWindowManagerSource, "function createBrowserModeWindow(shared, opts)", "\n    windowLayout.ownWindowTitle", "createBrowserModeWindow");
    return /const background = !!\(opts && opts\.background\)/.test(create)
      && /if \(!background\) \{ raiseWindow\(w\); w\.focus\(\); \}/.test(create)   // 이미 있는 창도 앞으로 안 낸다
      && /if \(background\) sinkWindow\(bw\);/.test(create)   // 띄우기 전에 내린다
      && /bw\.showInactive\(\)/.test(create)
      && /if \(bwFs && !background\)/.test(create);          // 풀스크린은 그 자체가 앞으로 나오는 동작
  });
  // 사용자가 눌러서 뜬 창과 AI 가 조작해서 뜬 창을 구분하는 근거는 인과다. 실제 구분은 browser-ui.mjs 의
  // "AI 가 밟아서 뜬 팝업·새 탭은 앞으로 안 나온다" 가 실행해서 확인한다. 여기서는 그 근거가
  // "보고 있는 탭인가" 로 되돌아가지 않는지만 지킨다. 그 판정은 사용자가 터미널을 입력하는 동안
  // AI 가 활성 탭을 조작하는 흔한 경우까지 사용자 행동으로 판정하기 때문이다.
  // 인과 판정은 시계를 주입해 경계에서 직접 실행해 확인한다. 소스에 분기가 있는지로는 "오래 도는 명령이
  // 도는 도중에 거짓이 된다" 같은 조건을 확인할 수 없어, 시각 하나로만 판정하는 구현도 그대로 통과한다.
  check("AI 인과 판정은 도는 개수로 정해진다", () => {
    const { createAiCausality } = require_("../native/electron/ai-causality.cjs");
    let t = 1000;
    const c = createAiCausality({ now: () => t, graceMs: 600 });
    const long = c.enter(5);
    t += 100000;                                   // 100초 도는 명령
    if (!c.driving(5)) throw new Error("오래 도는 명령이 도는 도중에 거짓이 된다");
    c.leave(long);
    if (!c.driving(5)) throw new Error("끝난 직후 유예가 없다 — 그때 뜬 팝업을 사람 것으로 본다");
    t += 599;
    if (!c.driving(5)) throw new Error("유예가 599ms 전에 끊긴다");
    t += 2;
    if (c.driving(5)) throw new Error("601ms 뒤에도 참이다 — 사람이 누른 것을 AI 것으로 본다");
    const outer = c.enter(7), inner = c.enter(7);  // fill 안에서 click 이 다시 들어오는 경우
    c.leave(inner);
    if (!c.driving(7)) throw new Error("안쪽이 끝났다고 바깥 명령까지 끝난 것으로 본다");
    c.leave(outer); t += 1000;
    if (c.driving(7)) throw new Error("둘 다 끝나고 유예가 지났는데 참이다");
    if (c.driving(9)) throw new Error("만진 적 없는 탭이 참이다 — 탭 경계가 샌다");
    for (let i = 0; i < 200; i++) c.leave(c.enter(1000 + i));
    t += 5000;
    if (c.driving(1001)) throw new Error("지난 표식이 안 걷힌다");
    return true;
  });
  // 팝업이 다시 여는 팝업은 webview 가 아니라 창이라서 상위 정책이 적용되지 않는다. 정책이 없는 창은
  // 항상 앞으로 뜨므로, 부모와 같은 규칙을 그 자리에서 적용한다.
  check("팝업이 또 여는 팝업에도 같은 규칙이 붙는다", () => {
    const body = sliceBetween(webviewLifecycleSource, "cwc.setWindowOpenHandler", "const popupId = ", "자식 팝업 정책");
    return /aiDriving \? !!aiDriving\(cwc\.id\) : false/.test(body)
      && /byAi \? \{ \.\.\.SAFE_POPUP_WINDOW_OPTIONS, show: false \} : SAFE_POPUP_WINDOW_OPTIONS/.test(body)
      && /return \{ action: "deny" \}/.test(body);
  });
  // 페이지를 변경하지 않는 명령은 인과로 집계하지 않는다. 집계하면 그 사이 사용자가 누른 다운로드가
  // 취소되고 파일 선택창이 빈 채로 닫힌다. 화면만 읽었는데 사용자 행동을 AI 것으로 판정하는 셈이다.
  check("읽기만 하는 명령은 인과로 세지 않는다", () => {
    const body = sliceBetween(cdp, "const READ_ONLY_CMDS", "const causality =", "READ_ONLY_CMDS");
    for (const cmd of ["snapshot", "text", "url", "screenshot", "diff", "observe", "tabs"]) {
      if (!new RegExp('"' + cmd + '"').test(body)) throw new Error(cmd + " 이 읽기 목록에 없다");
    }
    for (const cmd of ["click", "fill", "type", "key", "goto", "select"]) {
      if (new RegExp('"' + cmd + '"').test(body)) throw new Error(cmd + " 은 페이지를 건드리는데 읽기로 샜다");
    }
    return /function enterAiCommand\(wcId, cmd\) \{ return READ_ONLY_CMDS\.has\(cmd\) \? null : causality\.enter\(wcId\); \}/.test(cdp)
      && /const aiTicket = enterAiCommand\(wc\.id, cmd\);/.test(cdp);
  });
  check("팝업 판정 근거가 인과다", () =>
    /const toFront = aiDriving \? !aiDriving\(openerWcId\) : true;/.test(webviewLifecycleSource)
    && !/isShown/.test(webviewLifecycleSource)
    // 숨긴 채로 만든 창은 표시하는 경로가 있어야 한다. 팝업과 그 팝업이 다시 여는 창 모두.
    && /presentPopup\(wc\.id, childWin\)/.test(webviewLifecycleSource)
    && /cwc\.on\("did-create-window", \(grandWin\) => presentPopup\(cwc\.id, grandWin\)\)/.test(webviewLifecycleSource));
  // showInactive 는 창을 뒤에 두지 않는다. 확인 결과 그렇게 띄운 창이 다른 앱의 활성 창 위에
  // 표시됐다. 같은 앱 안이면 직전 맨 위 창을 다시 올려 되돌릴 수 있지만, 다른 앱이 앞일 때는 되돌릴
  // 대상이 없다. 가능한 방법은 층위를 한 칸 내리는 것으로, 확인 결과 다른 앱 활성 창 아래에 놓인 채
  // 초당 120프레임을 그렸다. 사용자가 부르면 되돌아와야 하므로 그 경로도 함께 확인한다.
  check("뒤에 세우는 창은 층위를 내린다", () => {
    const create = sliceBetween(browserWindowManagerSource, "function sinkWindow(win)",
      "\n  // 사용자가 그 창을 부르면", "sinkWindow");
    if (!/setAlwaysOnTop\(true, "normal", -1\)/.test(create)) return false;
    if (!/win\.on\("focus", \(\) => \{ try \{ if \(!aiDrivingAnywhere\(\)\) win\.setAlwaysOnTop\(false\); \} catch \{\} \}\);/.test(create)) {
      throw new Error("내린 창이 되돌아올 길이 없다 — 한 번 내리면 영영 뒤에 남는다");
    }
    const raise = sliceBetween(browserWindowManagerSource, "function raiseWindow(win)",
      "\n  function createBrowserModeWindow", "raiseWindow");
    // 뒤에 세우느라 건너뛴 풀스크린은 사용자가 그 창을 부를 때 적용해야 한다. 적용하지 않으면
    // 저장된 풀스크린이 false 로 덮여 사라진다.
    if (!/pendingFullscreen\.has\(win\)/.test(raise) || !/win\.setFullScreen\(true\)/.test(raise)) {
      throw new Error("건너뛴 풀스크린을 되돌리는 자리가 없다");
    }
    return /setAlwaysOnTop\(false\)/.test(raise)
      && /else if \(bwFs && background\) pendingFullscreen\.add\(bw\);/.test(browserWindowManagerSource)
      && /win\.setAlwaysOnTop\(true, "normal", -1\);/.test(webviewLifecycleSource)
      && /if \(!\(aiDrivingAnywhere && aiDrivingAnywhere\(\)\)\) win\.setAlwaysOnTop\(false\);/
        .test(webviewLifecycleSource);
  });
  // AI 가 파일 입력칸을 조작하면 OS 파일 선택창이 그 창에 시트로 붙어 창 전체를 막는다. 올릴 파일을
  // 정하지 않은 채 연 것이라 사용자가 답할 내용도 없으므로, 빈 선택으로 닫고 무엇을 해야 하는지 남긴다.
  // 초점을 받았다고 사용자가 부른 것은 아니다. 페이지가 스스로 window.focus() 를 부르면 AI 가 조작하는
  // 도중에 내려 둔 창이 앞으로 올라오므로, 사용자가 부르는 경로(⌥2·🌐)는 raiseWindow 가 따로 처리한다.
  check("내린 창은 사람이 부를 때만 올라온다", () =>
    /function anyDriving\(\)/.test(read("native/electron/ai-causality.cjs"))
    && /function aiDrivingAnywhere\(\) \{ return causality\.anyDriving\(\); \}/.test(cdp));
  // AI 가 연 창·탭에는 자기 wc 로 명령이 들어오지 않는다. 인과를 물려주지 않으면 그 창이 로드 중에
  // 시작하는 내려받기·권한 요청이 사용자 것으로 분류돼 OS 창이 뜬다.
  check("AI 가 연 창·탭은 인과를 물려받는다", () => {
    const { createAiCausality } = require_("../native/electron/ai-causality.cjs");
    let t = 0;
    const c = createAiCausality({ now: () => t, graceMs: 600 });
    const release = c.hold(42);
    t += 100000;
    if (!c.driving(42)) throw new Error("물려준 표식이 로드 중에 풀린다");
    release(); t += 1000;
    if (c.driving(42)) throw new Error("놓았는데도 계속 AI 로 본다");
    release();                                    // 두 번 놓아도 개수가 음수가 되지 않는다
    if (c.driving(42)) throw new Error("짝이 안 맞는 놓기가 표식을 되살린다");
    if (!/function inheritCausality\(childWc, win\)/.test(webviewLifecycleSource)) return false;
    return /if \(!toFront\) \{ try \{ inheritCausality\(win\.webContents, win\); \} catch \{\} \}/.test(webviewLifecycleSource)
      && /if \(aiDrivingAnywhere && aiDrivingAnywhere\(\)\) inheritCausality\(wc, null\);/.test(webviewLifecycleSource)
      && /childWc\.once\("did-stop-loading", end\)/.test(webviewLifecycleSource)
      && /const INHERIT_MAX_MS = 20000;/.test(webviewLifecycleSource);   // 끝나지 않는 페이지가 표식을 유지하지 않도록
  });
  // 확인창은 호스트에서 그 페이지 안 입력칸의 커서를 볼 수 없으므로 인과로 구분한다.
  // AI 가 조작하다 뜬 창은 커서를 가져가지 않는다. 표식이 네 곳을 거쳐 오므로 한 곳만 빠져도 동작하지 않는다.
  check("AI 가 밟아서 뜬 확인창은 커서를 안 가져간다", () => {
    const relay = [
      [/byAi: !!\(aiDriving && aiDriving\(wc\.id\)\)/, read("native/electron/cdp-session.cjs"), "main 이 안 실어 보낸다"],
      [/byAi: !!msg\.byAi/, read("server/browser-message-handlers.js"), "서버가 중계하다 떨어뜨린다"],
      [/byAi: !!m\.byAi/, mainJs, "창이 받아서 안 넘긴다"],
      [/if \(!d\.byAi && !typingElsewhere\(id\)\)/, webviewSource, "확인창이 그 표식을 안 본다"],
    ];
    for (const [re, src, why] of relay) if (!re.test(src)) throw new Error(why);
    return true;
  });
  await checkAsync("AI 가 연 파일 선택창은 OS 창을 안 띄운다", async () => {
    const { createUploadController } = require_("../native/electron/cdp-upload.cjs");
    const run = async (byAi) => {
      let opened = 0; const notes = []; const setFiles = [];
      const up = createUploadController({
        isAbsolute: () => true, existsSync: () => true,
        showOpenDialog: async () => { opened++; return { canceled: false, filePaths: ["/tmp/a.png"] }; },
        windowFromWebContents: () => ({}), recordUpload: (_id, r) => notes.push(r),
        clearChooser: () => {}, aiDriving: () => byAi,
      });
      const send = async (cmd, args) => { if (cmd === "DOM.setFileInputFiles") setFiles.push(args.files); };
      await up.serveFileChooser(send, { id: 9, hostWebContents: null }, { backendNodeId: 1, mode: "selectSingle" });
      return { opened, notes, setFiles };
    };
    const human = await run(false), ai = await run(true);
    if (human.opened !== 1) throw new Error("사람이 누른 파일칸에서 선택창이 안 뜬다");
    if (ai.opened !== 0) throw new Error("AI 가 밟았는데 OS 선택창이 뜬다");
    if (!ai.setFiles.length || ai.setFiles[0].length !== 0) throw new Error("AI 경로가 선택창을 빈 채로 안 닫는다");
    if (!ai.notes.some((n) => n && /browser_upload/.test(String(n.error || "")))) {
      throw new Error("무엇을 해야 하는지 장부에 안 남긴다");
    }
    return true;
  });
  // 확인창은 사용자가 입력하던 위치에서 커서를 가져가면 안 된다. 사용자가 눌러 뜬 창은 커서가 그 탭에 있어
  // 그대로 통과하고, AI 가 조작해 뜬 창은 터미널·입력칸에 있는 커서를 건드리지 않는다.
  check("확인창은 치고 있는 커서를 가져가지 않는다", () => {
    const body = sliceBetween(webviewSource, "export function renderTabDialog", "function answerTabDialog",
      "renderTabDialog");
    return /if \(!d\.byAi && !typingElsewhere\(id\)\) \{/.test(body)
      && /function typingElsewhere/.test(webviewSource)
      && /INPUT\|TEXTAREA\|SELECT/.test(webviewSource);
  });
  // 최소화·숨김은 가림 무시 스위치로도 해제되지 않는다(확인 결과 초당 0프레임). 창을 펼쳐서
  // 맞추면 사용자 화면을 가져가므로, 빗나간 채 통과하지 않도록 무엇이 막는지 알린다.
  check("최소화·앱 숨김 창은 조용히 빗나가지 않는다", () => {
    if (!/WINDOW_NOT_DRAWING: "window_not_drawing"/.test(cdp)) return false;
    if (!/browser_ask_user/.test(cdp)) return false;
    // 그림이 있어야 답이 되는 명령만 막는다. goto·reload·dialog 까지 막으면 최소화된 창에 떠 있는
    // 확인창을 닫을 길이 사라진다.
    if (!/const NEEDS_PIXELS = new Set\(\["screenshot"\]\);/.test(cdp)) return false;
    if (!/if \(paintableProbe && \(KEYS_NEED_PAINT\(cmd\) \|\| NEEDS_PIXELS\.has\(cmd\)\)\)/.test(cdp)) return false;
    // diff·observe(screenshot:false)·login 은 그림 없이 되는 일이라 막지 않는다.
    if (/NEEDS_PIXELS = new Set\(\[[^\]]*"(diff|observe)"/.test(cdp)) {
      throw new Error("그림 없이 되는 명령까지 막는다");
    }
    if (!/cmd !== "login"/.test(cdp)) throw new Error("login 은 키를 만들어 보내지 않는데 그림을 요구한다");
    // 판정이 "보이는 탭인가" 뒤에 있으면 최소화된 창의 보이는 탭에서 검사가 우회된다.
    const body = sliceBetween(cdp, "async function cdpExecInner", "\nasync function runCdpCmd", "cdpExecInner");
    if (body.indexOf("paintableProbe") > body.indexOf("isTabShown(wc.id)")) {
      throw new Error("창 상태 판정이 '보이는 탭인가' 뒤에 있다 — 최소화된 창에서 샌다");
    }
    return /win\.isMinimized\(\)\) return \{ ok: false, why: "최소화" \}/.test(mainH)
      && /app\.isHidden\(\)\) return \{ ok: false, why: "앱 숨김\(⌘H\)" \}/.test(mainH)
      && /BrowserWindow\.fromWebContents\(guest\)/.test(mainH);   // 팝업은 host 가 없다
  });
  // 저장 위치를 정하지 않은 채 AI 가 시작한 내려받기는 OS 저장 창을 띄우지 않는다. 그렇다고 임의 위치에
  // 저장하지도 않는다. 어디에 남길지는 무장이 정한다.
  check("무장 없는 AI 내려받기는 저장 창 대신 취소된다", () => {
    const hook = sliceBetween(downloadHookSource, "sess.on(\"will-download\"",
      "// 어느 탭에서 받은 것인지", "will-download");
    return /aiDriving\(wc\.id\)\) \{/.test(hook)
      && /noteBlockedDownload\(wc, item\);/.test(hook) && /item\.cancel\(\);/.test(hook)
      && /if \(downloadStatus\.dir\) \{/.test(hook)
      && /function blocked\(info\)/.test(read("native/electron/download-state.cjs"));
  });
  // 카메라는 처음 요청할 때 macOS 권한 창이 뜬다. AI 가 조작해서 발생한 요청이면 묻지 않고 거절한다.
  check("AI 가 밟은 카메라 요청은 권한 창을 안 띄운다", () =>
    /if \(_wc && !_wc\.isDestroyed\(\) && aiDriving\(_wc\.id\)\) \{ callback\(false\); return; \}/
      .test(read("native/electron/profile-session-policy.cjs")));
  // 전체화면·포인터 잠금은 허용하는 순간 화면과 커서 전체를 내주므로, 사용자가 눌렀을 때만 허용한다.
  check("AI 가 밟은 전체화면·포인터 잠금은 안 준다", () => {
    const src = read("native/electron/profile-session-policy.cjs");
    return /const SCREEN_TAKING = new Set\(\["fullscreen", "pointerLock"\]\);/.test(src)
      && /if \(SCREEN_TAKING\.has\(permission\) && _wc && !_wc\.isDestroyed\(\) && aiDriving\(_wc\.id\)\) \{ callback\(false\); return; \}/.test(src);
  });
  // 알림 없이 취소되면 사용자에게는 "버튼이 안 먹는다"로만 보이므로, 한 줄이라도 알린다.
  check("취소한 내려받기는 사람에게도 알린다", () =>
    /host\.send\("ac-native-notice"/.test(downloadHookSource)
    && /onNativeNotice/.test(read("native/electron/preload.cjs"))
    && /acHost\?\.onNativeNotice\?\.\(\(m\) => \{ if \(m && m\.text\) showToast/.test(mainJs));
  check("캡처 순간에만 붙잡는다", () => /setCaptureHold\(async \(wcId, on\)/.test(mainH)
    && /ac-capture-hold/.test(pre) && /onCaptureHold\?\.\(/.test(web) && /opacity:0\.01/.test(web));
  check("붙잡은 것은 반드시 놓는다", () => /finally \{\n            if \(held\) \{ try \{ await captureHold\(wc\.id, false\)/.test(capture)
    && /delete el\.dataset\.acHeld/.test(web));
  check("빠른 길은 그대로", () => /"cdp-capture-slow"\);\n          png = Buffer/.test(capture));
  // 붙잡기로 크기가 바뀌므로 clip 은 캡처 직전에 측정한다. 미리 측정하면 같은 화면이 2×2로 반복된다.
  check("clip은 찍기 직전에 잰다", () => /const mkArgs = async \(\)/.test(capture) && !/shotArgs/.test(capture));
  // "전체를 그려라"와 "여기를 잘라라"는 별개로 동작한다. full 인데 자를 범위를 뷰포트로 주면 첫 화면만
  // 나오거나 같은 화면이 반복된다(확인 결과 12004px 페이지가 1076px 한 장). 배율을 올려도 같다.
  check("전체를 찍으면 전체가 나온다", () =>
    /async function stitchFullPage/.test(cdpCaptureToolsSource) && /async function composeTiles/.test(cdpCaptureToolsSource)
    && /Page\.getLayoutMetrics/.test(cdpCaptureToolsSource)
    && /scrollTo\(0, \$\{y\}\)[\s\S]{0,200}?requestAnimationFrame/.test(cdpCaptureToolsSource)   // 옮긴 화면이 그려진 뒤 찍는다
    && /position: "fixed"|p === "fixed"/.test(cdpCaptureToolsSource)                 // 두 번째 장부터 고정 요소를 감춘다
    && /scrollTo\(0, \$\{back\}\)/.test(cdpCaptureToolsSource)                    // 보던 위치로 되돌린다
    && /via = "stitch"/.test(capture)
    && !/captureBeyondViewport:/.test(cdpCaptureToolsSource));                       // 크롬에 위임하는 방식은 쓰지 않는다(주석 언급은 무관)

  // [CDP 는 AI 조작·녹화 중에만] 붙어 있는 것 자체가 봇 판정 신호다(Cloudflare·Google 로그인).
  // 그래서 수명주기는 붙이지 않고 탐색만 정책에 알리며, 붙일지는 cdp-control 의 부착 정책이 정한다.
  // 동작 자체는 test/webview-lifecycle.mjs·test/cdp-attach-policy.mjs 가 실행으로 판정한다.
  // 여기서는 되살아나면 안 되는 옛 경로(생성 시 attach·탐색 재부착·CF 전용 판정)가 없는지만 본다.
  check("수명주기는 CDP 를 스스로 붙이지 않고 탐색을 부착 정책에 알린다", () => {
    if (/dbg\.attach\(/.test(webviewLifecycleSource)) throw new Error("생성 시 attach 가 되살아났다");
    if (/primeSession\(wc\)|ensureAttachedWc/.test(webviewLifecycleSource)) throw new Error("탐색 재부착이 되살아났다");
    if (/usesCloudflareChallenge|scheduleIdleDetach/.test(webviewLifecycleSource)) throw new Error("CF 전용 판정이 남아 있다(일반 유휴 detach 에 흡수됨)");
    if (!/wc\.on\("did-start-navigation"[\s\S]{0,120}noteNavigation\(wc\.id, url\)/.test(webviewLifecycleSource)) throw new Error("탐색 시작을 정책에 알리지 않는다");
    if (!/wc\.on\("will-redirect"[\s\S]{0,160}noteNavigation\(wc\.id, url\)/.test(webviewLifecycleSource)) throw new Error("리다이렉트를 정책에 알리지 않는다(OAuth 진입을 놓친다)");
    if (!/wc\.on\("did-stop-loading", \(\) => \{ try \{ noteNavigation\(wc\.id, null\)/.test(webviewLifecycleSource)) throw new Error("탐색 종료를 지우지 않는다");
    // cdp-control 쪽 배선: 명령마다 창을 미루고, 로그인 호스트에서는 CDP 없는 부분집합만 허용한다.
    const control = read("native/electron/cdp-control.cjs");
    if (!/attachPolicy\.touch\(wc\.id\);\s*const send = ensureAttached\(wc\);/.test(control)) throw new Error("명령이 조작 창을 미루지 않는다");
    if (!/allowAttach: \(wc\) => attachPolicy\.allowAttach\(wc\.id\)/.test(control)) throw new Error("세션 관문이 정책을 안 본다");
    if (!/if \(e && e\.code === ERROR_CODES\.CDP_BLOCKED\) throw e;/.test(control)) throw new Error("관문 오류를 재부착으로 재시도한다");
    if (!/if \(cmd === "handoff"\) return handoff\(wc\);/.test(control)) throw new Error("사람에게 넘기는 handoff 가 없다");
    // 로그인 호스트에서 떼는 것은 AI 세션이다. Firefox 정체 전달용 attach(정체성 모듈 소유, document 계약 없음)까지
    // 떼면 로그인 화면이 Chrome 정체로 돌아간다. 정책 detach·탐색 진입·noCdp 분기 셋이 모두 같은 함수를 거친다.
    if (!/if \(identityOwnsDebugger\(wc\) && !cdpSession\.primed\(wc\.id\)\) return false;/.test(control)) throw new Error("정체성 전용 attach 를 구분하지 않는다");
    if (!/detach: \(wcId\) => \{ const wc = liveWc\(wcId\); if \(wc\) detachAiSession\(wc\); \}/.test(control)) throw new Error("정책 detach 가 AI 세션만 떼지 않는다");
    if (!/const detached = wc \? detachAiSession\(wc\) : false;/.test(control)) throw new Error("탐색 진입 detach 가 AI 세션만 떼지 않는다");
    if (!/if \(noCdp\) \{\s*detachAiSession\(wc\);/.test(control)) throw new Error("noCdp 분기가 AI 세션만 떼지 않는다");
    const identity = read("native/electron/google-auth-user-agent.cjs");
    if (!/setImmediate\(\(\) => \{\s*if \(state\.disposed \|\| canSendOverCdp\(wc\)\) return;/.test(identity)) throw new Error("외부 detach 뒤 정체성 재부착이 없다");
    return true;
  });
}

}
