// 소유 범위: 앱(시뮬레이터·에뮬레이터) 요소 선택과 CDP·파일·자격증명 경계 검사.
// 제공 API: 원래 앱 요소 선택 자리에서 한 번 호출하는 비동기 기본 run.
// 의존 대상: core의 공유 검사·파일 도구, sources의 공유 소스, Node 파일·경로·OS API.
// 유지 조건: 검사 이름·순서·문구, checkAsync의 비동기 판정, 임시 폴더 정리, full smoke 출력.
// 영향 범위: 러너가 동적 import로 이 run을 호출하며, sources의 상태·workspace 소스 계약도 함께 본다.
//   지금 목록은 이걸로 센다: node bin/importers.mjs bin/smoke/sections/34-app-pick.mjs
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { check, checkAsync, fnBody, read, readAll, require_ } from "../core.mjs";
import {
  accountsView, allCss, allServer, appPick, browserRuntime, browserStateOwner, cdpCmdCaptureSource,
  cdpCmdInputSource, cdpCmdInspectSource, cdpCmdNativeSource, cdpLayoutSource,
  cdpSessionSource, cdpTransportSource, cdpUploadSource, chromeHandoffIpcSource,
  credentialIpcSource, credentialServiceSource, css, downloadHookSource, herdrAgents,
  herdrHandlers, httpHandler, main, mainJs, memoPanel, memoStorePanel, nativeAx, pick,
  pickHost, pickModeSource, profiles, serverIndexSource, textEditor, tree, web, webviewFactory,
  workspaceHandlers, workspaceRuntime,
} from "../sources.mjs";
import { sliceBetween, sliceFrom } from "../../slice-anchor.mjs";

export default async function run() {
const srvSpace = serverIndexSource;
const cdpc = read("native/electron/cdp-control.cjs");
// ── 앱(시뮬레이터·에뮬레이터) 요소 선택 ──
// 브라우저와 같은 한 가지 행동이므로 스위치도 하나다. 앱 쪽만 따로 켜는 길을 두면 사람이 어느 쪽이
// 켜졌는지 기억해야 한다.
check("요소 선택 하나로 앱까지 켜진다", () => {
  const si = readAll("server");
  return /import \* as appPick from "\.\/app-pick\.js"/.test(si)
    && /if \(pickModeOn\) \{\s*\n\s*appPick\.start\(\{/.test(si)
    && /\} else appPick\.stop\(\);/.test(si);
});
// 선택 모드를 켜 둔 채로 두면 앱이 탭에 반응하지 않는다. 사람은 이유를 모른 채 앱이 고장 났다고 본다.
// 연결에 몇 초가 걸리므로 그 사이에 꺼졌는지 매번 다시 확인한다. 확인하지 않으면 모드가 남는다.
check("앱 선택 모드는 반드시 되돌아간다", () => {
  const ap = read("server/app-pick.js");
  return /await t\.connect\(\);\s*\n\s*if \(!on\) \{ t\.close\(\); return; \}/.test(ap)
    && /if \(!on\) \{ try \{ await t\.setSelect\(false\); \} catch \{\} t\.close\(\); return; \}/.test(ap)
    && /for \(const t of held\) \(async \(\) => \{ try \{ await t\.setSelect\(false\); \} catch \{\} t\.close\(\); \}\)\(\);/.test(ap);
});
// 앱을 찾는 경로가 하나면 한 플랫폼이 전부 제외된다. 안드로이드는 mDNS에 잡히지 않고
// 접속 주소가 터미널에만 있다. 그래서 셋을 쓴다: mDNS · adb(logcat+forward+302) · 터미널 화면.
check("앱 찾는 길이 셋이다", () => {
  const ap = read("server/app-pick.js");
  return /_dartVmService\._tcp/.test(ap) && /async function discoverAdb/.test(ap)
    && /async function discoverFromPanes/.test(ap)
    && /Promise\.all\(\[discoverMdns\(\), discoverAdb\(\), discoverFromPanes\(deps\.herdr\)\]\)/.test(ap)
    && /redirect: "manual"/.test(ap)      // 302의 location이 진짜 접속 지점이다
    && /import \{ adbPath \} from "\.\/adb-path\.js"/.test(ap)   // launchd PATH에는 adb가 없다
    && /function adbPath\(\)/.test(read("server/adb-path.js"));
});
// 앱 픽은 탭이 없다. 소스 파일:줄과 위젯 경계가 그 역할을 하고, 원본은 app_picks가 준다.
check("앱에서 고른 것이 소스까지 실려 전달된다", () => {
  const si = read("server/index.js"), commands = read("server/browser-commands.js"), mcp = read("bin/iris-mcp.mjs");
  // 앱 표면은 bin/mcp/app.mjs 가 소유한다.
  const mcpApp = read("bin/mcp/app.mjs");
  return /type: "ai-app-pick", pane: curTarget/.test(appPick)
    && /msg\.type === "ai-app-pick"/.test(si)
    && /if \(cmd === "app-picks"\)/.test(commands)
    && /name: "app_picks"/.test(mcpApp)
    && /function appPickBlock/.test(appPick)
    && /소스: \$\{where\}/.test(appPick);
});
// 상위 체인을 전부 실으면 300줄이 넘고(확인 결과 343줄) 대부분이 프레임워크 내부다. 파일이 바뀌는
// 지점만 남겨야 "어느 화면의 어느 조각"이 나온다.
// Flutter의 선택은 z 순서를 보지 않고, 해당 좌표를 포함하는 위젯을 모아 넓이순으로 고른다. 그래서
// 모달이 떠 있어도 뒤의 더 작은 위젯이 선택된다. 사용자가 보는 것은 맨 위 층이므로,
// 가장 나중에 그려진 ModalBarrier 뒤에 있는 후보만 남기고 앱 안에서 선택을 옮긴다.
check("앱 요소 선택은 맨 위 층만 집는다", () => {
  const ap = read("server/app-pick.js");
  return /const TOP_LAYER_EXPR = \[/.test(ap)
    && /\]\.join\(" "\)/.test(ap)                                  // 줄바꿈이 하나라도 있으면 컴파일이 안 된다
    && /contains\('ModalBarrier'\)/.test(ap)                       // 경계는 가장 나중에 그려진 배리어
    && /if \(bars\.contains\(o\) && i - 1 > cut\) cut = i - 1;/.test(ap)
    && /if \(k <= cut\) \{ hidden = hidden \+ 1; continue; \}/.test(ap)  // 그 앞은 뒤에 가린 것이라 뺀다
    && /const layer = layerOf\(await t\.lift\(\)\);[\s\S]{0,300}await t\.selection\(\)/.test(ap)  // 담기 전에 옮긴다
    && /layer\.state === "behind"/.test(ap)                        // 모달 바깥을 누르면 보내지 않는다
    && /this\.lift\(\)\.catch\(\(\) => \{\}\);/.test(ap);          // 한 번 탭(미리보기)도 같이 옮긴다
});
// 뒤가 잡히는 사고가 났을 때 사용자 보고에 기대지 않으려면, 픽 자체가 "가린 층이 있었는데 못
// 걸렀다"인지 "가린 층이 없었다"인지를 말해야 한다(그것이 없어 왕복이 늘었다).
check("픽은 어느 층에서 골랐는지를 함께 싣는다", () => {
  const ap = read("server/app-pick.js"), si = readAll("server");
  return /function layerOf\(lift\)/.test(ap)
    && /hidden = hidden \+ 1/.test(ap)                             // 뒤에 가려 뺀 후보를 센다
    && /layer,\s*\/\//.test(ap)                                    // 픽에 실어 보낸다
    && /layer: x\.pick\.layer \|\| null/.test(si)                  // 원본 필드로도 꺼낼 수 있다
    && /뒤에 가려진 후보 \$\{p\.layer\.hidden\}개는 뺐습니다/.test(appPick);
});
// 값만 실으면 "이 글자를 바꿔 달라"에 받는 쪽이 고른 위젯의 줄(감싼 Padding)을 연다. 값이 적힌 줄은
// 대개 그보다 아래에 있으므로, 값에 자기 위치를 함께 싣는다.
check("픽의 값은 자기 파일:줄을 달고 온다", () => {
  const ap = read("server/app-pick.js");
  return /function textsIn\(node/.test(ap)
    && /out\.push\(\{ value: v, widget: [^}]*\.\.\.locOf\(n\) \}\)/.test(ap)
    && /values: own,/.test(ap)
    && /const vat = \(v\) =>/.test(appPick)                        // 렌더도 그 줄을 찍는다
    && /JSON\.stringify\(v\.value\) \+ vat\(v\)/.test(appPick);
});
// 상세 트리는 프레임워크 체인에서 잘려 바깥쪽 위젯(카드·버튼)을 고르면 값이 하나도 안 왔다.
// 요약 트리는 프로젝트 위젯만 담고 글자 미리보기를 함께 주어, 같은 비용으로 더 넓게 확인된다.
check("값은 요약 트리에서 캔다", () => {
  const ap = read("server/app-pick.js");
  return /async summaryTree\(\)/.test(ap)
    && /getRootWidgetTree/.test(ap)
    && /isSummaryTree: "true", withPreviews: "true", fullDetails: "true"/.test(ap)
    && /groupName: "ac-pick"/.test(ap)                             // 선택과 같은 그룹이라야 id가 이어진다
    && /function locate\(root, valueId\)/.test(ap)
    && /const own = hit \? textsIn\(hit\) : detail\.texts;/.test(ap);  // 못 찾으면 옛 길로
});
check("앱 경로는 위젯 경계만 남긴다", () => {
  const ap = read("server/app-pick.js");
  return /async chainOf\(valueId\)/.test(ap)
    && /if \(!isProjectFile\(file\)\) continue;/.test(ap)
    && /if \(file === lastFile\) continue;/.test(ap)
    && /\/\[.\]pub-cache\\\//.test(ap);
});
// 고를 수 있는 표면이 겹쳐 있으면(시뮬레이터 앞, 브라우저 뒤) 맨 위 하나만 반응해야 한다.
// 커서 좌표만 보고 뿌리면 뒤에 깔린 창도 같이 하이라이트된다.
// 판정 기준은 하나다. 커서 위치에서 맨 앞인 창이 우리 창인지만 본다(CGWindowList).
// 포커스를 함께 보면 안 된다: 에뮬레이터에 포커스를 둔 채 브라우저 요소를 고르러 가면 하이라이트가
// 떴다가 곧바로 지워졌다. 포커스는 위아래와 다른 질문이다.
check("겹친 표면은 맨 위만 반응한다", () => {
  const owner = pickModeSource, wp = read("native/electron/webview-preload.cjs");
  return !/appActive/.test(owner)                             // 포커스로 막는 길이 남아 있지 않다
    && /let top = windowUnderCursor\(pt\);/.test(owner)
    && /function windowUnderCursor\(pt\)/.test(owner)
    && /CGWindowListCopyWindowInfo/.test(owner)
    && /function topmostIsOurs\(pt\)/.test(owner)
    && /const ourTopmost = topmostIsOurs\(pt\);/.test(owner)
    && /if \(top && !ourTopmost\) top = null;/.test(owner)
    && /const on = !!\(top && mine === top\);/.test(owner)
    && /wc\.send\("ac-cursor", on \? /.test(owner)
    && /: null\);/.test(owner)
    && /__orcaHover: pt \? \{ x: pt\.x, y: pt\.y, entered: !!pt\.entered \} : null/.test(wp)
    && /if \(!d\.__orcaHover\) return hideHL\(\);/.test(pickHost)
    && /if \(!pt\) \{/.test(pick);
});
// 픽 모드에서 브라우저 창은 포커스를 안 받고 첫 클릭이 그대로 콘텐츠로 간다(acceptFirstMouse).
// 그래서 시뮬레이터에서 위젯을 고르고 콘솔로 돌아오는 클릭이 다른 요소로 전송된다. 확인 결과
// 앱만 골랐는데 웹 요소가 함께 실렸다. 가려져 있다 올라온 직후의
// 첫 클릭은 창을 활성화하는 클릭으로 보고 무시한다.
check("가려져 있다 올라온 직후의 첫 클릭은 요소가 되지 않는다", () => {
  const owner = pickModeSource, wp = read("native/electron/webview-preload.cjs");
  return /let wasOurTopmost = true;/.test(owner)                      // 창별이 아니라 하나 — 묻는 건 가린 앱 유무
    && /const entered = ourTopmost && !wasOurTopmost;/.test(owner)
    && /wasOurTopmost = ourTopmost;/.test(owner)
    && /entered \? \{ x: pt\.x, y: pt\.y, entered: true \} : pt/.test(owner)
    && /entered: !!pt\.entered/.test(wp)                              // 게스트까지 실려 간다
    && /if \(x === lastX && y === lastY && !pt\.entered\) return;/.test(pick) // 제자리 클릭도 통과시킨다
    && /pt\.entered \? \{ x, y, entered: true \} : \{ x, y \}/.test(pick)
    && /if \(d\.__orcaHover\.entered\) armed = false;/.test(pickHost)
    && /if \(!armed\) \{ armed = true; return; \}/.test(pickHost)     // 삼키고 곧바로 다시 무장
    && /var armed = true;/.test(pickHost);
});
// 선택은 누르는 순간부터 바뀌고 누른 채 움직이면 계속 따라간다. 그것을 그대로 보내면 아직 고르는
// 중인 것이 채팅에 쌓이므로, 손을 뗄 때 오는 확정 신호에서만 보낸다.
check("앱 픽은 두 번 탭해야 간다", () => {
  const ap = read("server/app-pick.js");
  return /streamListen/.test(ap)
    && /ev\.extensionKind === "navigate"/.test(ap)
    && /ev\.kind === "Inspect"/.test(ap)
    && /if \(now - \(this\.lastSignalAt \|\| 0\) < SAME_TAP_MS\) return;/.test(ap)  // 한 탭이 내는 두 신호
    && /if \(now - \(this\.firstTapAt \|\| 0\) <= DOUBLE_TAP_MS\)/.test(ap)         // 둘째 탭에서만 보낸다
    && /this\.firstTapAt = 0;/.test(ap)                                            // 세 번째가 또 보내지 않게
    && /if \(t\.streamOk\) continue;/.test(ap);                                    // 폴링은 폴백으로만
});
// 위젯 경로는 "이 위젯이 어느 화면 안인가"에는 답하지만 "그 화면에 어떻게 갔는가"에는 답하지
// 못한다. 같은 화면에 진입점이 여럿이면 받는 쪽이 재현할 수 없다.
check("앱 픽은 지금 살아 있는 화면들을 함께 싣는다", () => {
  const ap = read("server/app-pick.js");
  return /screens\(root\) \{/.test(ap)
    && /\(Screen\|Page\)\$/.test(ap)                       // 프로젝트 화면만 추린다
    && /isProjectFile\(file\.replace/.test(ap)             // 패키지 내부 Navigator 는 배관이지 경로가 아니다
    && /sort\(\(a, b\) => b\.depth - a\.depth\)/.test(ap)  // 얕을수록 나중에 얹힌 것 → 뒤로 간다
    && /screens: root \? t\.screens\(root\) : \[\],/.test(ap)  // 지도를 못 받아도 픽은 간다
    && /const screens = \(p\.screens \|\| \[\]\)\.filter\(Boolean\);/.test(appPick)
    && /\(지금\)/.test(appPick)
    && /screens\.length > 1/.test(appPick);                    // 화면이 하나면 새 정보가 없어 뺀다
});
// 코드 위치만 오면 "왜 이 값이 지금 여기 나오나"를 물을 수 없다. 가리킨 것 안의 값과 옆에 붙은
// 라벨이 함께 와야 그 질문이 선다(쿠폰번호 · 9000000000162).
check("앱 픽은 지금 화면의 값을 함께 싣는다", () => {
  const ap = read("server/app-pick.js");
  return /async valuesOf\(valueId/.test(ap)
    && /getDetailsSubtree/.test(ap)
    && /const VALUE_PROP_RE =/.test(ap)
    && ap.includes("text:\\s*┤")        // 입력칸의 지금 값은 controller 안에 들어 있다
    && /function hasVisible/.test(ap)   // 아이콘 글자는 값이 아니다
    && /around = \{ name: up\.widgetRuntimeType \|\| up\.description \|\| "\?", \.\.\.locOf\(up\), items \}/.test(ap)
    // 주변은 인접 요소이지 화면 전체가 아니다. 끝까지 올라가면 화면 전체를 가져온다(255건 중 25건)
    && /step < 4/.test(ap) && /if \(items\.length > 8\) break;/.test(ap)
    && /지금 값: /.test(appPick);
});
// 값을 나열만 하면 어느 값이 코드 어디에 있는 것인지가 안 선다. 감싼 위젯을 열고 닫고 그 안의 값마다
// 자기 줄을 붙인 트리로 그린다. 그러려면 값이 자기 위치를 함께 가져와야 한다.
check("주변 값에는 자기 코드 위치가 함께 붙는다", () => {
  const ap = read("server/app-pick.js");
  return /function locOf\(n\)/.test(ap)
    && /push\(texts, "t:" \+ v, \{ value: v, widget: n\.description \|\| "\?", \.\.\.locOf\(n\) \}\)/.test(ap)
    && /around = \{ name: [^}]*\.\.\.locOf\(up\), items \}/.test(ap)  // 감싼 위젯의 자리도 함께
    && /주변: <\$\{tag\}/.test(appPick) && /`<\/\$\{tag\}>`/.test(appPick)   // 여닫는 태그가 짝으로
    // 무엇을 골랐는지 표시할 때 값이 아니라 위치로 맞춘다. 같은 글자가 여럿이면 다른 줄에 붙는다
    && /const isMine = \(x\) => vals\.some/.test(appPick)
    && /isMine\(x\) \? "  ← 고른 것" : ""/.test(appPick);
});
// 시뮬레이터를 보고 있을 때 켜고 끄게 되는데, 그 창에 포커스가 있으면 앱 안 단축키는 오지 않는다.
check("요소 선택 단축키는 앱 밖에서도 온다", () => {
  return /globalShortcut\.register\("CommandOrControl\+Shift\+E", togglePickModeGlobal\)/.test(pickModeSource)
    && /globalShortcut\.unregisterAll\(\)/.test(pickModeSource);
});
check("pick-mode 전역 단축키가 main ready 조립에 연결된다", () =>
  /const \{ createPickMode \} = require\("\.\/pick-mode\.cjs"\);/.test(main)
  && /const pickMode = createPickMode\(\{/.test(main)
  && /pickMode\.registerGlobalShortcut\(\);/.test(main));
// 창 순서 조회가 실패해도 커서 추적은 계속 동작해야 한다. 여기서 예외가 나가면 펌프가 매 틱
// 중단되어 하이라이트가 마지막 위치에 고정된다.
check("창 순서 조회는 커서 추적을 못 죽인다", () => {
  return /const \{ execFile \} = require\("node:child_process"\);/.test(main)
    && /execFile,/.test(main)
    && /function topmostIsOurs\(pt\) \{\s*\n\s*try \{/.test(pickModeSource)
    && /if \(Array\.isArray\(parsed\) && parsed\.length\) zList = parsed;/.test(pickModeSource);
});
await checkAsync("pick-mode는 실제 맨 앞인 우리 창 하나에만 좌표를 보내고 끄면 펌프를 멈춘다", async () => {
  const { createPickMode } = require_("../native/electron/pick-mode.cjs");
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const timers = [];
  globalThis.setInterval = (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; };
  globalThis.clearInterval = (timer) => { if (timer) timer.cleared = true; };
  try {
    const runCase = (frontPid) => {
      const appHandlers = new Map(), ipcOn = new Map(), ipcHandle = new Map();
      const makeContents = (id) => ({ id, sent: [], isDestroyed: () => false,
        send(_channel, payload) { this.sent.push(payload); } });
      const wc1 = makeContents(1), wc2 = makeContents(2);
      const makeWindow = (wc) => ({ webContents: wc, focusable: true, isDestroyed: () => false,
        isVisible: () => true, isMinimized: () => false, getBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
        setFocusable(value) { this.focusable = value; } });
      const w1 = makeWindow(wc1), w2 = makeWindow(wc2), byContents = new Map([[wc1, w1], [wc2, w2]]);
      const BrowserWindow = { getAllWindows: () => [w1, w2], fromWebContents: (wc) => byContents.get(wc) || null };
      createPickMode({
        app: { on: (name, fn) => appHandlers.set(name, fn) },
        screen: { getCursorScreenPoint: () => ({ x: 10, y: 10 }) },
        globalShortcut: { register() {}, unregisterAll() {} },
        BrowserWindow,
        ipcMain: { on: (name, fn) => ipcOn.set(name, fn), handle: (name, fn) => ipcHandle.set(name, fn) },
        execFile: (_file, _args, _opts, done) => done(null, JSON.stringify([[frontPid, 0, 0, 100, 100]])),
        browserWindowManager: { allBrowserWindows: () => [w1, w2], firstBrowserModeWindow: () => w2 },
        getMainWindow: () => w1,
        isTrustedSender: () => true,
        injectOverlayAllFrames() {}, hoverAtPoint() {}, diagSince: () => ({}),
        runCdp: async () => ({ ok: true }), webContents: {},
      });
      appHandlers.get("browser-window-focus")(null, w1);
      appHandlers.get("browser-window-focus")(null, w2);
      ipcOn.get("ac-pick-mode")({ sender: wc1 }, true);
      ipcOn.get("ac-pick-mode")({ sender: wc2 }, true);
      const timer = timers[timers.length - 1];
      timer.fn();
      ipcOn.get("ac-pick-mode")({ sender: wc1 }, false);
      ipcOn.get("ac-pick-mode")({ sender: wc2 }, false);
      timer.fn();
      return { wc1, wc2, timer };
    };
    const covered = runCase(process.pid + 1);
    if (covered.wc1.sent.some(Boolean) || covered.wc2.sent.some(Boolean)) throw new Error("다른 앱이 커서 자리를 덮었는데 좌표를 보냈다");
    if (!covered.timer.cleared) throw new Error("픽 해제 뒤 커서 펌프가 멈추지 않았다");
    const ours = runCase(process.pid);
    if (ours.wc1.sent.some(Boolean)) throw new Error("겹친 우리 창의 뒤쪽에도 좌표를 보냈다");
    const topPayload = ours.wc2.sent.find(Boolean);
    if (!topPayload || topPayload.x !== 10 || topPayload.y !== 10) throw new Error("겹친 우리 창의 맨 위쪽에 좌표를 보내지 않았다");
    if (!ours.timer.cleared) throw new Error("우리 창 픽 해제 뒤 커서 펌프가 멈추지 않았다");
    return true;
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});
check("사람을 부르는 길이 있다", () => {
  const si = read("server/index.js"), commands = read("server/browser-commands.js"), mcp = read("bin/iris-mcp.mjs"), cli = read("bin/iris-browser.mjs");
  return /function askUser\(args, session\)/.test(commands)
    && /if \(cmd === "ask"\)/.test(commands)
    && /type: "ai-ask"/.test(commands)
    && /msg\.type === "ai-ask-answer"/.test(si)
    && /tabAllowed\(session, tabId\)\.ok/.test(commands) // 남의 탭으로 부르지 않는다
    && /"ai-ask": dispatchWs\(handleAiAskMessage\)/.test(mainJs)
    && /browser_ask_user/.test(mcp)
    && /case "ask":/.test(cli);
});
// 알림은 우측 상단이다. 위 30px는 드래그용 타이틀바.
check("알림은 우측 상단", () => /\.noticestack \{ position:fixed; right:16px; top:38px;/.test(css("19-terminal"))
  && !/\.noticestack \{ position:fixed; right:16px; bottom:16px;/.test(allCss));
// 분리창이 콘솔에 시키는 것(요소·앱 위젯·탭·그룹·사이트)은 콘솔 하나에만 간다. 전체에 뿌리면
// 콘솔 창이 둘일 때 같은 글이 채팅에 두 번 들어간다. 콘솔마다 herdr에 따로 붙지만 붙는 세션은
// 하나라 두 창의 주입이 같은 채팅에 쌓인다.
check("분리창이 보낸 것은 콘솔 하나에만 들어간다", () => {
  return /function relayToOneConsole/.test(herdrHandlers)
    && /const consoles = ptyMgr\.clients\(\)\.filter/.test(herdrHandlers)
    && /consoles\.includes\(lastTypedConsole\) \? lastTypedConsole : consoles\[0\]/.test(herdrHandlers)
    && /if \(ws\._local\) relayToOneConsole\(\{ type: "pick-relay"/.test(srvSpace)
    && /relayToOneConsole\(\{ type: "app-pick", pick \}\)/.test(browserRuntime)
    && /if \(ws\._local\) relayToOneConsole\(\{ type: "tab-pick-relay"/.test(srvSpace)
    && /if \(ws\._local\) relayToOneConsole\(\{ type: "group-pick-relay"/.test(srvSpace)
    && /if \(ws\._local\) relayToOneConsole\(\{ type: "site-pick-relay"/.test(srvSpace)
    && !/broadcast\(\{ type: "pick-relay"/.test(allServer);
});
// 콘솔 여부는 터미널이 붙어 있는지로 판정한다. 분리 브라우저 창은 pty를 붙이지 않는다.
check("콘솔 목록은 pty가 쥐고 있다", () => {
  const p = read("server/pty.js");
  return /clients\(\) \{ return \[\.\.\.this\.sessions\.keys\(\)\]; \}/.test(p);
});
// 폴더 객체를 모르는 동안 저장된 값은 workspace_id 키 아래에 있다. 객체 키가 정해지면 그 위치는
// 더 이상 읽히지 않으므로 함께 옮겨야 한다. 옮기지 않으면 스페이스를 다시 열 때마다
// 기본 계정·탭이 초기화된 것처럼 보인다.
check("폴더 객체를 처음 알게 되면 id 열쇠에 쌓인 것을 옮긴다", () => {
  return /firstBinding && learned\.key && learned\.key !== id/.test(workspaceRuntime)
    && /if \(!hasSpaceState\(migration\.from\)\) continue;/.test(browserStateOwner)
    && /migrateSpaceState\(migration\.from, migration\.to, migration\.why, moved\)/.test(browserStateOwner)
    && /function hasSpaceState\(key\)/.test(browserStateOwner);
});
// 탭을 그룹으로 묶어두는 이유가 여럿을 함께 다루기 위해서다. 명령이 한 번에 하나만 받으면
// 그 그룹을 쓸 수 없다. 대상을 나누는 지점은 단일 대상 경로보다 위여야 한다.
// 권한 검사·그룹 흡수·오류 문구가 전부 그 아래 있어서 대상마다 똑같이 적용된다.
check("여러 탭에 한 번에 (최대 4)", () => {
  const si = readAll("server");
  return /const MAX_TARGETS = 4;/.test(si)
    && /function refList\(tab\)/.test(si)
    && /if \(targets && targets\.length !== 1\)/.test(si)
    && /targets\.map\(\(t\) => runBrowserCmd\(cmd, \{ \.\.\.\(args \|\| \{\}\), tab: t \}/.test(si)
    && /ok: okCount === per\.length,/.test(si)     // 절반만 된 것을 성공이라 부르지 않는다
    && /\[\.\.\.new Set\(arr\)\]/.test(si);        // 같은 탭을 두 번 적어도 한 번만
});
check("MCP·CLI가 대상 목록을 받는다", () => {
  const mcp = read("bin/iris-mcp.mjs"), cli = read("bin/iris-browser.mjs");
  return /type: \["string", "array"\], items: \{ type: "string" \}, maxItems: 4/.test(mcp)
    && /if \(r\.multi && Array\.isArray\(r\.targets\)\)/.test(mcp)   // 대상별로 나눠 보여준다
    && /String\(argv\[i \+ 1\]\)\.split\(","\)/.test(cli);
});
check("지목은 회수된다", () => {
  const si = readAll("server");
  return /function revokeTab\(pane, tabId\)/.test(si)
    && /for \(const pin of dropped\) if \(revokeTab\(session, pin\)\)/.test(si);
});
// 이전 번호 이름은 스페이스마다 1부터라 겹칠 수 있다. 그 이름이 둘을 가리키면 선택하지 않는다.
// 임의로 하나를 고르면 다른 세션의 탭이 움직인다. 새 난수 이름에는 이 문제가 없다.
check("같은 이름이 겹치면 고르지 않는다", () => {
  const si = readAll("server");
  return /if \(exactN > 1\) return null;/.test(si) && /exact = tabId; exactN\+\+/.test(si);
});
check("목록이 준 정체성 그대로도 받는다", () => /if \(tabReg\.has\(String\(ref\)\)\) return String\(ref\);/.test(readAll("server")));
check("숨은 탭 개수를 흘리지 않는다", () => !/hidden: tabReg\.size - visible\.length/.test(allServer));
check("한 번만 지정은 기본 대상을 안 바꾼다", () => {
  const si = read("server/browser-commands.js");
  const seg = sliceFrom(si, "// --tab은 이번 명령에만 적용된다", 200, "한 번만 지정은 기본 대상을 안 바꾼다");
  return /absorbIntoSessionGroup\(session, want\);/.test(seg) && !/setLastTab/.test(seg);
});
check("지목받은 탭 폴백은 되돌아오지 않는다", () => {
  const si = readAll("server");
  return /runBrowserCmd\(cmd, \{ \.\.\.\(args \|\| \{\}\), tab: pick \}, session, true(, runId)?\)/.test(si);
});
check("그룹 권한은 로컬 UI에서만 생긴다", () => {
  const si = read("server/browser-message-handlers.js");
  const calls = (allServer.match(/grantGroup\(/g) || []).length;
  const seg = sliceFrom(si, '"browser-group-grant"', 400, "그룹 권한은 로컬 UI에서만 생긴다");
  // 루프백만으로는 앱과 다른 로컬 프로세스를 구별할 수 없어, 앱만 아는 토큰(ws._ui)까지 요구한다.
  return calls === 2 && /if \(ws\._local && ws\._ui && msg\.pane && msg\.space && msg\.group\)/.test(seg);
});
// 접은 상태가 창을 다시 열면 초기화되어 매번 다시 접어야 했다.
check("접힘 상태가 남는다", () =>
  /const COLLAPSE_KEY = "ac\.collapsed"/.test(web)
  && /function saveCollapsed/.test(web)
  && /function setPanelOpen/.test(web)
  && /localStorage\.setItem\(panelOpenKey\(id\)/.test(web)
  && /collapsed\.dirs\.delete\(p\); requestDir\(p\); \} saveCollapsed\(\)/.test(tree)
  && /collapsed\.groups\.add\(id\); saveCollapsed\(\)/.test(herdrAgents));
// 항상 표시되는 비활성 버튼은 공간만 차지한다. 단축키 안내도 필요 없다.
check("저장 버튼은 고칠 게 있을 때만 나온다", () =>
  /const save = dirty \? `<button data-act="save" class="hot">저장<\/button>` : ""/.test(textEditor)
  && !/저장 ⌘S/.test(textEditor));
// 스페이스 전용 임시 메모다. 파일이 아니라 그 스페이스에 붙고, 스페이스끼리 섞이지 않는다.
check("스페이스마다 따로 도는 메모가 있다", () => {
  const si = read("server/memo-service.js");
  const store = read("server/memo-dock-store.js");
  return /memoDock = new MemoDockStore/.test(si)
    && /msg\.type === "memo\.set"/.test(si)
    && /memoDock\.setDocument/.test(si)
    && /baseVersion/.test(si)
    && /path\.join\(root, "memos\.json"\)/.test(store)
    && /id="panel-memo"/.test(web) && /id="memo-slot"/.test(web)
    && /function memoSpace/.test(memoStorePanel) && /if \(sp !== getMemoShownSpace\(\)\)/.test(memoPanel);
});
check("메모는 실행 도크 위에 있다", () => web.indexOf('id="panel-memo"') < web.indexOf('id="panel-run"'));
// 실행기 소켓이 바깥 변수 하나를 공유하면, close 핸들러가 그 변수를 비운 뒤 error 핸들러가
// 해제된 참조를 읽고 이전 핸들러가 새 소켓을 건드려, 서버를 재시작해도 제어가 돌아오지 않는다.
check("서버만 다시 떠도 실행기가 스스로 붙는다", () => {
  const seg = sliceFrom(cdpTransportSource, "function setupCdpControl", 5200, "서버만 다시 떠도 실행기가 스스로 붙는다");
  return /let sock;/.test(seg)                       // 소켓마다 지역 변수
    && /let done = false;/.test(seg)                 // 재연결 예약은 한 번만
    && /sock\.on\("close", again\)/.test(seg)
    && /sock\.on\("error", \(\) => \{ try \{ sock\.close\(\); \} catch \{\} again\(\); \}\)/.test(seg)
    && !/let ws = null, retry = 0;/.test(seg);
});
// 서버가 다시 뜨면 그쪽 탭 장부는 비어 있다. 이쪽이 전부 다시 말하지 않으면 열린 탭이 통째로 사라진다.
check("서버가 다시 뜨면 열린 탭을 전부 다시 알린다", () => {
  const seg = fnBody(mainJs, "handleWsOpen");
  return /for \(const tid of getWebviewIds\(\)\) reportTabWc\(getWebview\(tid\), tid\)/.test(seg)
    && /reportActiveBrowserWc\(\)/.test(seg);
});
// 명령은 탭마다 한 줄로 돈다. 막힌 명령 뒤에 서면 그걸 풀 명령까지 갇혀 영원히 못 빠져나온다.
// handoff 도 같은 부류다. 사람에게 넘기는 순간 CDP 를 떼야 하는데, 멈춘 명령 뒤에 서면 사람이 로그인하는
// 동안 CDP 가 붙은 채로 남는다.
check("막힌 것을 푸는 명령은 줄을 서지 않는다", () => {
  const seg = sliceBetween(cdpc, "const QUEUE_BYPASS", "async function cdpExecRaw", "막힌 것을 푸는 명령은 줄을 서지 않는다");
  return /QUEUE_BYPASS = new Set\(\["dialog", "dialogs", "nativewin", "nativeclick", "nativekey", "handoff"\]\)/.test(seg)
    && /if \(QUEUE_BYPASS\.has\(cmd\)\) return guard\(withCmdTimeout/.test(seg);
});
// 사람을 부르는 서버 명령은 알림을 띄우기 전에 그 탭의 CDP 를 뗀다. 유휴 창을 기다리면 사람이
// 로그인하는 동안 CDP 가 붙은 채다. 전달 실패가 호출을 막으면 안 되므로 기다리지 않는다.
// 실측 도구가 스스로 CDP 창을 열면 사람 탭의 상태를 잴 수 없다. cdpstate 는 touch 앞에서 답하고 끝난다.
check("cdpstate 는 부착 정책을 건드리지 않고 답한다", () => {
  const cdpc = read("native/electron/cdp-control.cjs");
  const raw = fnBody(cdpc, "cdpExecRaw");
  const at = raw.indexOf('if (cmd === "cdpstate") return cdpState(wc);');
  const touch = raw.indexOf("attachPolicy.touch(wc.id)");
  const state = fnBody(cdpc, "cdpState");
  return at >= 0 && touch >= 0 && at < touch
    && !/touch\(|ensureAttached|debugger\.attach/.test(state)
    && /cdpSession\.primed\(wc\.id\)/.test(state) && /identityOwnsDebugger\(wc\)/.test(state);
});
check("사람을 부르면 알림 전에 handoff 를 보낸다", () => {
  const seg = fnBody(read("server/browser-commands.js"), "askUser");
  const at = seg.indexOf('execOnWc("handoff", {}, wc).catch(() => {})');
  const notice = seg.indexOf('broadcast({ type: "ai-ask"');
  return at >= 0 && notice >= 0 && at < notice;
});
// 확인 창(alert/confirm)은 탭이 아니라 창에 붙는다. 다른 탭을 보고 있으면 관계없는 페이지 위에
// 떠서 그 창 전체를 막는다. 어느 탭이 묻는지 모르면 사람도 AI도 진행할 수 없다.
check("확인 창이 뜨면 그 탭을 알리고 그리로 데려간다", () => {
  const si = allServer;
  return /browser-dialog-open" \|\| msg\.type === "browser-dialog-closed"/.test(si)
    && /broadcast\(\{ type: "browser-dialog"/.test(si)
    // 목록만 봐도 막힌 탭이 보여야 한다
    && /확인 창 떠 있음/.test(si)
    // 자동 응답이 무장돼 있으면 사람을 부르지 않고 직접 닫는다
    && /if \(!ans\) ctlSend\(\{ type: "browser-dialog-open"/.test(cdpSessionSource)
    && /ctlSend\(\{ type: "browser-dialog-closed"/.test(cdpSessionSource)
    && /"browser-dialog": dispatchWs\(handleBrowserDialogMessage\)/.test(mainJs);
});
// 화면에 그려지지 않는 탭은 위젯이 0×0이라 좌표 입력이 전달되지 않는다. 명령은 ok로 돌아오지만
// 페이지에서는 아무 일도 일어나지 않는다. 확인 결과 mousedown조차 들어오지 않아, 실패가 성공으로 보고된다.
check("안 보이는 탭에서는 요소를 직접 눌러 준다", () => {
  const seg = sliceBetween(cdpCmdInputSource, "  async function clickTarget", "\n\n  return {", "안 보이는 탭에서는 요소를 직접 눌러 준다");
  return /withLayout\(send, async \(applied\)/.test(seg)   // 레이아웃을 씌웠다 = 안 보이는 탭이다
    // 교차 출처 프레임 안의 요소도 같은 경로를 쓴다. 그 좌표는 프레임 좌표계라 그대로 누르면 다른 위치가 눌린다.
    && /if \(applied \|\| sid\)/.test(seg)
    && /Runtime\.callFunctionOn/.test(seg)
    && /userGesture: true/.test(seg)                        // 팝업·파일선택이 막히지 않게
    && /via: "element"/.test(seg) && /via: "input"/.test(seg); // 어느 길로 갔는지 결과에 남긴다
});
// 세션을 떼면 거기 걸어 둔 것이 전부 사라진다. 다시 붙일 때 같은 목록을 다시 걸지 않으면 그 탭은
// 기능의 일부만 동작한다. 수집·확인창·파일선택·iframe이 함께 멈추는데 명령은 성공으로 돌아온다.
check("세션을 다시 붙이면 걸어 둔 것도 다시 건다", () => {
  const seg = sliceFrom(cdpSessionSource, "function resetCdpSession", 1200, "세션을 다시 붙이면 걸어 둔 것도 다시 건다");
  return /clearSessionGuards\(wc\.id\)/.test(seg) && /childSessions\.delete\(wcId\)/.test(cdpSessionSource)
    && /overlay\.resetSession\(wc\.id\)/.test(seg) && /ensureAttached\(wc\)/.test(seg);
});
// 문서 준비와 명시적 관찰을 각각 한 번만 걸어 확인창·덧그림이 중복되지 않게 한다.
check("세션 준비는 겹치지 않는다", () =>
  /if \(documentPrimed\.has\(wc\.id\)\) return send;/.test(cdpSessionSource)
  && /if \(observationPrimed\.has\(wc\.id\)\) return;/.test(cdpSessionSource)
  && /const cp = childPrimers\.get\(wcId\);/.test(cdpSessionSource)
  && /if \(!dbg \|\| !fresh\) return;/.test(cdpSessionSource));
// 포커스만 주기와 비우기만 하기를 따로 둔다. fill 은 값까지 넣어 이 두 상태를 만들 수 없다.
check("focus·clear가 fill과 별개 명령으로 있다", () =>
  /async focus\(send, wc, args\)/.test(cdpCmdInputSource) && /async clear\(send, wc, args\)/.test(cdpCmdInputSource)
  && /browser_focus/.test(read("bin/iris-mcp.mjs")) && /browser_clear/.test(read("bin/iris-mcp.mjs"))
  && /case "focus": case "clear":/.test(read("bin/iris-browser.mjs")));
// 누르기로 체크박스를 다루면 지금 상태를 모르는 채 뒤집는 것이라, 두 번 돌리면 두 번째에 풀린다.
check("체크박스는 뒤집지 않고 원하는 상태로 맞춘다", () => {
  const seg = sliceBetween(cdpCmdInputSource, "    async check(", "    async select(", "체크박스는 뒤집지 않고 원하는 상태로 맞춘다");
  return /if \(was!==want\)/.test(seg) && /aria-checked/.test(seg)
    && /라디오는 끌 수 없습니다/.test(seg);
});
// 스크린샷은 보이는 픽셀이라 스크롤 밖이 잘리고 인쇄 스타일이 안 걸린다. 증거용으로는 PDF가 맞다.
check("PDF는 인쇄 레이아웃으로 뽑는다", () => {
  const seg = sliceFrom(cdpCmdCaptureSource, "    async pdf(", 1200, "PDF는 인쇄 레이아웃으로 뽑는다");
  return /Page\.printToPDF/.test(seg) && /printBackground/.test(seg) && /preferCSSPageSize/.test(seg)
    && /browser_pdf/.test(read("bin/iris-mcp.mjs"));
});
// 파일 선택 창은 뜨는 순간 사람이 누를 때까지 전부 멈춘다. 입력칸을 직접 채우면 창 자체가 안 뜬다.
check("파일 선택은 창을 띄우지 않고 채운다", () =>
  /DOM\.setFileInputFiles/.test(cdpUploadSource) && /Page\.setInterceptFileChooserDialog/.test(cdpSessionSource));
check("올릴 파일은 실재하는 절대경로만", () => {
  const seg = sliceBetween(cdpUploadSource, "function invalidPaths", "function arm", "올릴 파일은 실재하는 절대경로만");
  return /!isAbsolute\(file\)/.test(seg) && /!existsSync\(file\)/.test(seg);
});
// 무장 없이 기본 동작을 바꾸면 사람의 평소 다운로드에서 저장 위치 선택이 사라진다.
check("다운로드 자동저장은 무장했을 때만", () => {
  const m = downloadHookSource;
  return /const downloadStatus = downloadState\.snapshot\(\)/.test(m)
    && /if \(downloadStatus\.dir\)/.test(m) && /item\.setSavePath\(dest\)/.test(m);
});
// CDP는 Chromium이 그리는 것만 본다. OS가 그린 시트는 접근성으로만 보인다.
check("OS 창은 접근성으로 본다", () => {
  const native = readAll("native");
  return /function axDescribe/.test(native) && /function axClick/.test(native)
    && /async nativewin\(\)/.test(native) && /nativeAx\.axDescribe\(\)/.test(native)
    && /async nativeclick\(_send, _wc, args\)/.test(native) && /nativeAx\.axClick\(name\)/.test(native);
});
// AppleScript 예약 속성과 겹치는 변수명은 대입이 실패한다(kind → -10006).
check("AppleScript 예약어를 피한다", () =>
  !/set kind to "window"/.test(nativeAx) && /set axKind to "window"/.test(nativeAx));
// 버튼 이름을 그대로 스크립트 문자열에 넣으므로 따옴표·역슬래시를 막는다.
check("버튼 이름 주입 차단", () => /button\.replace\(/.test(nativeAx));
check("멈춘 이유를 observe가 알려준다", () => /nativeModal/.test(cdpCmdInspectSource) && /downloadPlan:/.test(cdpCmdInspectSource));
// CDP 세션이 있는 동안에는 파일 선택창을 가로채 우리가 연다. AI 가 무장한 파일을 넣거나 AI 조작 중
// 뜬 선택창을 빈 선택으로 닫는 경로가 여기다. CDP 가 없는 사람 탭은 Electron 이 네이티브 선택창을
// 그대로 띄운다(격리 프로브: CDP 미부착 webview 게스트에 네이티브 클릭 → 시트 1개, Electron 43.2.0).
check("파일 선택은 CDP 세션에서 가로채 우리가 연다", () =>
  /Page\.setInterceptFileChooserDialog", \{ enabled: true \}\)\.catch/.test(cdpSessionSource)
  && /upload\.serveFileChooser\(chooserSend, wc, params\)/.test(cdpSessionSource)
  && /async function serveFileChooser/.test(cdpUploadSource)
  && /showOpenDialog\(owner, \{ properties \}\)/.test(cdpUploadSource));
// 명령 큐는 탭마다 하나다. 무장이 큐를 잡고 기다리면 뒤이은 click이 갇혀 선택창이 영영 안 열린다.
check("업로드 무장은 큐를 잡지 않는다", () => {
  const seg = sliceBetween(cdpCmdNativeSource, "    async upload(", "    async download(", "업로드 무장은 큐를 잡지 않는다");
  return /upload\.arm\(wc\.id, files, ms\)/.test(seg) && /armed: true/.test(seg)
    && !/while \(!buf\.fileChooser/.test(readAll("native"));
});
// 사용자가 보고 있지 않은 탭은 0×0이라 좌표 조작이 전부 헛나간다. 명령 동안만 씌우고 반드시 되돌린다.
check("레이아웃은 명령 동안만, 보이는 탭엔 손대지 않는다", () => {
  const seg = sliceBetween(cdpLayoutSource, "async function withLayout", "module.exports", "레이아웃은 명령 동안만, 보이는 탭엔 손대지 않는다");
  return /if \(!w\) \{ await send\("Emulation\.setDeviceMetricsOverride"/.test(seg)
    && /finally \{[\s\S]*clearDeviceMetricsOverride/.test(seg);
});
check("좌표 명령이 레이아웃으로 감싸져 있다", () =>
  /async function clickTarget[\s\S]*?return await withLayout/.test(cdpCmdInputSource)
  && /async hover[\s\S]*?return await withLayout/.test(cdpCmdInputSource)
  && /async screenshot\(send, wc, args\) \{ return await withLayout/.test(cdpCmdCaptureSource));
// 열림·저장 패널의 버튼은 그룹 안에 중첩돼 이름으로 지정할 수 없다. 닫을 방법이 없으면 사용자가 진행할 수 없다.
// 변수에 담은 sheet 참조로는 buttons가 조회되지 않는다. 취소·열기가 있는데 빈 배열이 돌아온다.
// 버튼 이름이 없으면 무엇을 누를지 알 수 없어 인식이 무의미해진다.
check("시트의 버튼 이름을 실제로 읽는다", () =>
  /every button of axTarg/.test(nativeAx) && !/\(buttons of axTarg\)/.test(nativeAx));
check("네이티브 창을 키로 닫을 수 있다", () => {
  const native = readAll("native");
  return /async nativekey\(_send, _wc, args\)/.test(native) && /nativeAx\.axKey\(args\.key\)/.test(native)
    && /key code \$\{code\}/.test(native) && /\? 53 : null/.test(native);
});
// eval에서 파일 선택·클립보드처럼 사용자 활성화를 요구하는 API가 동작하려면 필요하다.
check("eval은 사용자 활성화를 싣는다", () => /userGesture: true/.test(cdpCmdInspectSource));
check("임시 계측이 남아 있지 않다", () => !/FCCHK/.test(cdpc));
check("MCP에 네 도구가 노출", () => {
  const m = read("bin/iris-mcp.mjs");
  return ["browser_upload", "browser_download", "browser_native_windows", "browser_native_click", "browser_native_key"]
    .every((n) => m.includes(`name: "${n}"`));
});

  console.log("[3] 보안 불변식 — AC5/AC6");
  const srv = serverIndexSource;
check("AC5 로컬 게이트(ws._local) 존재", () => /ws\._local/.test(allServer));
check("AC6 연결 필터/Origin 검사", () => /connectionAllowed|origin/i.test(httpHandler));
check("pick relay는 로컬만", () => /pick-relay[\s\S]{0,80}ws\._local|ws\._local[\s\S]{0,80}pick-relay/.test(srv));
check("자격증명은 신뢰 렌더러만", () => /isTrustedSender/.test(credentialIpcSource) && /ac-get-creds/.test(credentialIpcSource));
// 비밀번호가 어디로 나가는지는 소스 모양으로 확인되지 않는다. 실제 저장소를 임시 폴더에 만들고
// 다섯 지점을 직접 호출한다. 목록·요약에 비밀번호가 실리는지, 정확히 한 건에만 나오는지, 파티션을
// 지우는 응답이 지우기가 끝난 뒤에 오는지, 신뢰하지 않는 발신자가 무엇을 받는지.
await checkAsync("자격증명 IPC는 비번을 목록에 싣지 않고 정확한 한 건만 주며 지운 뒤에 응답한다", async () => {
  const { createCredentialIpc } = require_("../native/electron/credential-ipc.cjs");
  const { createCredentialService } = require_("../native/electron/credential-service.cjs");
  const fsMod = require_("node:fs");
  const safe = {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from("enc:" + text),
    decryptString: (buf) => {
      const text = buf.toString("utf8");
      if (!text.startsWith("enc:")) throw new Error("깨진 암호문");
      return text.slice(4);
    },
  };
  const dir = mkdtempSync(path.join(tmpdir(), "iris-credential-ipc-"));
  try {
    const credentialService = createCredentialService({ stateDir: dir, fs: fsMod, safeStorage: safe });
    const handle = new Map();
    let trusted = true;
    const purged = [];
    let purgeDone = false;
    const ipc = createCredentialIpc({
      ipcMain: { handle: (name, fn) => handle.set(name, fn) },
      credentialService,
      isTrustedSender: () => trusted,
      // 진짜 판정은 기본 파티션도 프로필로 친다(profile-session-policy 의 PROFILE_PARTITION_RE).
      // 그 조건을 담지 않은 가짜를 쓰면 기본 파티션 예외를 지워도 검사가 통과한다.
      isProfilePartition: (partition) =>
        /^persist:acbrowser$|^persist:acprof:[A-Za-z0-9%._~!*'()-]+$/.test(String(partition || "")),
      // 지우기는 시간이 걸린다. 응답이 그 뒤에 오는지 보려면 두 경우를 모두 담은 가짜가 필요하다.
      purgePartition: async (key) => {
        purged.push(key);
        await new Promise((resolve) => setTimeout(resolve, 0));
        purgeDone = true;
      },
      basePartition: "persist:acbrowser",
    });
    for (const name of ["ac-get-creds", "ac-creds-password", "ac-creds-summary", "ac-clear-creds", "ac-purge-partition"])
      if (!handle.has(name)) throw new Error(name + " 를 안 걸었다");
    const ev = {};
    const partition = "persist:acprof:one";
    const origin = "https://shop.test";

    // setCreds 는 저장소로 전달되고, chrome-handoff 가 이 이름으로 받는다.
    if (typeof ipc.setCreds !== "function") throw new Error("setCreds 를 안 내준다");
    ipc.setCreds(partition, [
      { origin, url: origin + "/login", username: "alice", password: "비번-alice" },
      { origin, url: origin + "/login", username: "bob", password: "비번-bob" },
      { origin: "https://other.test", url: "https://other.test/", username: "alice", password: "비번-다른곳" },
    ]);
    if (credentialService.summary(partition).count !== 3) throw new Error("setCreds 가 저장소에 안 닿았다");

    // 목록·요약에는 비밀번호가 실리지 않는다.
    const listed = await handle.get("ac-get-creds")(ev, { partition, origin });
    if (listed.length !== 2) throw new Error("정확한 origin 목록이 아니다");
    if (JSON.stringify(listed).includes("비번-")) throw new Error("목록에 비번이 실렸다");
    const summary = await handle.get("ac-creds-summary")(ev, partition);
    if (summary.count !== 3) throw new Error("요약 개수가 틀렸다");
    if (JSON.stringify(summary).includes("비번-")) throw new Error("요약에 비번이 실렸다");

    // 비번은 정확한 파티션·origin·아이디 한 건에만.
    const pw = handle.get("ac-creds-password");
    if (await pw(ev, { partition, origin, username: "alice" }) !== "비번-alice") throw new Error("정확한 한 건을 못 준다");
    if (await pw(ev, { partition, origin, username: "carol" }) !== "") throw new Error("없는 아이디에 비번을 준다");
    if (await pw(ev, { partition, origin: "https://evil.test", username: "alice" }) !== "") throw new Error("다른 origin 에 비번을 준다");
    if (await pw(ev, { partition, origin: "javascript:alert(1)", username: "alice" }) !== "") throw new Error("http(s) 아닌 origin 을 통과시켰다");
    if (await pw(ev, { partition: "지어낸 파티션", origin, username: "alice" }) !== "") throw new Error("프로필 아닌 파티션에 비번을 준다");
    if (await pw(ev, { partition: "persist:acbrowser", origin, username: "alice" }) !== "") throw new Error("저장한 적 없는 파티션에 비번을 준다");

    // 파티션 지우기: 기본 파티션은 지울 수 없고, 응답은 지우기가 끝난 뒤에 온다.
    const purge = handle.get("ac-purge-partition");
    const base = await purge(ev, "persist:acbrowser");
    if (base.ok !== false || purged.length) throw new Error("기본 파티션을 지웠다");
    const bad = await purge(ev, "지어낸 파티션");
    if (bad.ok !== false || purged.length) throw new Error("프로필 아닌 파티션을 지웠다");
    const done = await purge(ev, partition);
    if (done.ok !== true || purged[0] !== partition) throw new Error("프로필 파티션을 안 지웠다");
    if (!purgeDone) throw new Error("지우기가 끝나기 전에 성공을 돌려줬다");

    // 비우기: 저장소에서 실제로 제거된다.
    const cleared = await handle.get("ac-clear-creds")(ev, partition);
    if (cleared.ok !== true || credentialService.summary(partition).count !== 0) throw new Error("비우기가 저장소에 안 닿았다");

    // 신뢰하지 않는 발신자는 다섯 지점 모두에서 아무것도 얻지 못한다.
    trusted = false;
    ipc.setCreds(partition, [{ origin, url: origin + "/login", username: "alice", password: "비번-alice" }]);
    if ((await handle.get("ac-get-creds")(ev, { partition, origin })).length) throw new Error("비신뢰 발신자에게 목록을 줬다");
    if (await pw(ev, { partition, origin, username: "alice" }) !== "") throw new Error("비신뢰 발신자에게 비번을 줬다");
    const blockedSummary = await handle.get("ac-creds-summary")(ev, partition);
    if (blockedSummary.count !== 0 || blockedSummary.accounts.length) throw new Error("비신뢰 발신자에게 요약을 줬다");
    if ((await handle.get("ac-clear-creds")(ev, partition)).ok !== false) throw new Error("비신뢰 발신자가 비웠다");
    purged.length = 0;
    if ((await purge(ev, partition)).ok !== false || purged.length) throw new Error("비신뢰 발신자가 파티션을 지웠다");
    if (credentialService.summary(partition).count !== 1) throw new Error("비신뢰 발신자의 호출이 저장소를 바꿨다");
    return true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
// 쿠키가 실패하면 비밀번호도 저장하지 않고 "가져왔다"고 적지도 않는다. 그러지 않으면 화면에는
// 실패로 보이는데 비밀번호만 남는 상태가 된다.
check("가져오기는 셋이 함께 되거나 함께 안 된다", () => {
  const head = sliceBetween(chromeHandoffIpcSource, 'ipcMain.handle("ac-import-chrome-profile"', "module.exports", "가져오기는 셋이 함께 되거나 함께 안 된다");
  const guard = head.indexOf("if (res && res.error) return res;");
  return guard >= 0 && guard < head.indexOf("setCreds") && guard < head.indexOf("noteChromeImport");
});
// 비밀번호는 쿠키와 함께 오지 않는다. 사용자가 켠 경우에만 Chrome 로그인 DB를 복호화한다.
check("비밀번호 임포트는 명시적으로 켤 때만", () =>
  /arg\.withPasswords === true/.test(chromeHandoffIpcSource)
  && /loginsSkipped = true/.test(chromeHandoffIpcSource)
  && /id="acct-with-pw"/.test(profiles + accountsView)
  && /withPasswords === true/.test(read("native/electron/preload.cjs")));
// 한 프로필에서 가져온 계정이 다른 프로필 탭과 AI 후보에까지 나타나면 프로필을 가른 의미가 없다.
check("프로필 경계를 넘는 자격증명 합침은 기본 꺼짐", () =>
  /const order = sharePartitions/.test(credentialServiceSource)
  && /: \[partition\];/.test(credentialServiceSource));
check("자격증명 partition 공유 설정이 native 조립에 존재한다", () =>
  /sharePartitions: process\.env\.IRIS_CRED_SHARE_PARTITIONS === "1"/.test(readAll("native")));
// 목록에 비밀번호를 실으면 탭이 유지되는 동안 렌더러 메모리에 남는다. 채우는 순간 하나만 꺼낸다.
check("자격증명 목록에는 비번이 실리지 않는다", () => {
  const seg = sliceBetween(credentialServiceSource, "function listForOrigin", "function passwordFor", "자격증명 목록에는 비번이 실리지 않는다");
  return /username: l\.username/.test(seg) && !/password/.test(seg);
});
check("자격증명 목록·순간 비밀번호 조회가 native에 연결된다", () => {
  const native = readAll("native");
  return /credentialService\.listForOrigin\(partition, origin\)/.test(native)
    && /ipcMain\.handle\("ac-creds-password"/.test(native)
    && /credsPassword: \(partition, origin, username\) => ipcRenderer\.invoke\("ac-creds-password"/.test(native);
});
check("자격증명 비밀번호는 고른 계정에만 요청된다", () =>
  /acHost\.credsPassword\(part, req\.origin, c\.username\)/.test(webviewFactory));
check("스페이스 생성/닫기는 로컬만(AC5)", () => {
  const handler = fnBody(workspaceHandlers, "handleSpace");
  return !!handler && /!ws\._local/.test(handler);
});

// 앱 표면을 실제로 생성한다. 소스 모양만 보는 검사는 여기서 효과가 없다. 보고서를 분리할 때
// buildReport 가 다른 구역의 readMarks 를 쓰고 있었는데 모양 검사는 모두 통과했고, 실제로
// 호출하는 검사 하나가 ReferenceError 로 잡았다. 시뮬레이터가 없어도 표면을 만들고
// 인자를 검사하는 데까지는 간다.
await checkAsync("앱 표면은 실제로 세워지고 기기 없이도 사람 말로 거절한다", async () => {
  const { createAppSurface } = await import(new URL("../../mcp/app.mjs", import.meta.url).href);
  const surface = createAppSurface({
    currentSession: async () => null, journal: async () => null, addReceipt: () => ({ id: "r1" }),
  });
  const names = surface.tools.map((t) => t.name);
  if (!names.length) throw new Error("도구가 하나도 안 세워졌다");
  for (const want of ["app_targets", "app_target", "app_snapshot", "app_tap", "app_screenshot"]) {
    if (!names.includes(want)) throw new Error(`${want} 가 없다`);
  }
  if (!names.every((n) => n.startsWith("app_"))) throw new Error("앱 도구가 아닌 것이 섞였다");
  // app: true 는 여기서 idb 를 직접 호출한다는 뜻이다. app_picks 만 서버를 거치는 예외다.
  // 그 하나가 로컬 호출로 바뀌면 사용자가 고른 원본 필드가 아니라 idb 트리가 나온다.
  const local = surface.tools.filter((t) => t.app === true).map((t) => t.name);
  const served = names.filter((n) => !local.includes(n));
  if (served.join(",") !== "app_picks") throw new Error(`서버를 거치는 앱 도구가 달라졌다: ${served.join(",") || "(없음)"}`);
  if (!surface.tools.every((t) => typeof t.run === "function")) throw new Error("run 이 없는 도구가 있다");
  // 고정은 herdr pane 안에서만 가능하다. 세션을 모르면 실패 이유를 함께 알린다.
  const pin = await surface.tools.find((t) => t.name === "app_target").run({ device: "x" });
  if (pin.ok || !/세션을 알 수 없습니다/.test(pin.error || "")) throw new Error("세션 없이 고정을 받아들인다");
  if (surface.MAX_DEVICES !== 4) throw new Error("동시 기기 상한이 4가 아니다");
  return true;
});

// 표면을 만드는 것과 도구가 동작하는 것은 다른 사실이다. 생성만 보는 검사는 모듈을 분리할 때
// 스코프 밖으로 나간 참조를 보지 못한다. simTarget·simTargetError 가 createAppSurface 의 매개변수인
// currentSession 을 모듈 스코프에서 호출하고 있었고, 도구 여덟이 전부 "currentSession is not defined"
// 로 실패했는데 검사 1299건은 모두 통과했다.
//
// 기기가 켜져 있든 없든 그 코드를 지난다. 켜져 있으면 고정 기기를 조회하고, 없으면 그 이유를
// 만들면서 같은 코드를 호출한다. 그래서 이 검사는 시뮬레이터 유무에 영향받지 않는다. 확인하는 것은
// 하나다. 사람이 읽을 수 있는 거절이나 결과 중 하나를 돌려주고, ReferenceError 로 죽지 않아야 한다.
await checkAsync("기기를 고르는 도구는 스코프 밖 참조로 죽지 않는다", async () => {
  const { createAppSurface } = await import(new URL("../../mcp/app.mjs", import.meta.url).href);
  const surface = createAppSurface({
    currentSession: async () => null, journal: async () => null, addReceipt: () => ({ id: "r1" }),
  });
  const t = surface.tools.find((x) => x.name === "app_snapshot");
  if (!t) throw new Error("app_snapshot 이 없다");
  let out;
  try { out = await t.run({}, async () => ({ ok: true })); }
  catch (e) { throw new Error(`도구가 죽었다: ${e && e.message}`); }
  if (!out || typeof out !== "object") throw new Error("응답이 객체가 아니다");
  if (!out.ok && !String(out.error || "").trim()) throw new Error("거절하면서 이유를 안 준다");
  // simTarget 을 타는 도구가 늘거나 줄면 이 검사가 덮는 범위가 조용히 바뀐다.
  const viaTarget = ["app_snapshot", "app_tap", "app_text", "app_swipe", "app_key",
    "app_screenshot", "app_expect", "app_observe"];
  const names = surface.tools.map((x) => x.name);
  const missing = viaTarget.filter((n) => !names.includes(n));
  if (missing.length) throw new Error(`기기를 고르는 도구가 사라졌다: ${missing.join(", ")}`);
  return true;
});

// 앱 도구의 대상은 Iris 에뮬레이터 탭에 열린 기기뿐이다. 켜져 있기만 한 기기를 잡으면 에이전트가
// 사용자가 보지 않는 기기에서 확인하고, 없으면 기기를 따로 켜서 진행했다(사용자 확인 결과).
// 서버 호출을 가짜로 바꿔 규칙을 실행으로 확인한다: 자기 스페이스 탭 → 없으면 탭 열기 → 탭 밖 기기는 거절.
await checkAsync("앱 도구는 Iris 에뮬레이터 탭의 기기만 대상으로 한다", async () => {
  const src = read("bin/mcp/app.mjs");
  if (/idb\(\["list-targets"/.test(src) || /adb\(\["devices"/.test(src)) throw new Error("앱 도구가 켜진 기기를 직접 훑는다 — 대상은 Iris 탭에서만 받는다");
  const { createAppSurface } = await import(new URL("../../mcp/app.mjs", import.meta.url).href);
  const calls = [];
  let tabs = [];
  const call = async (cmd, args) => {
    calls.push(cmd);
    if (cmd === "app-devices") return { ok: true, data: { tabs } };
    if (cmd === "app-open") { tabs = [{ space: "s1", tab: "t1", udid: "emulator-5554", name: "Pixel", mine: true }]; return { ok: true, data: { udid: "emulator-5554" } }; }
    return { ok: false, error: "?" };
  };
  const surface = createAppSurface({ currentSession: async () => null, journal: async () => null, addReceipt: () => ({ id: "r" }), call });
  const listed = await surface.tools.find((t) => t.name === "app_targets").run({});
  if (!listed.ok || listed.data.count !== 0) throw new Error("탭이 없는데 기기가 잡힌다");
  if ((await surface.simTarget()) !== "emulator-5554" || !calls.includes("app-open")) throw new Error("탭이 없을 때 Iris 에 탭을 열지 않는다");
  tabs = [{ space: "s2", tab: "t2", udid: "E92D2EB4-A044-461A-B685-0B6034FF0D59", name: "iPhone 16", mine: false },
    { space: "s1", tab: "t1", udid: "emulator-5554", name: "Pixel", mine: true }];
  calls.length = 0;
  if ((await surface.simTarget()) !== "emulator-5554" || calls.includes("app-open")) throw new Error("이 세션 스페이스의 탭 기기를 고르지 않는다");
  if ((await surface.simTarget("iPhone 16")) !== "E92D2EB4-A044-461A-B685-0B6034FF0D59") throw new Error("탭에 열린 다른 기기를 이름으로 못 고른다");
  if ((await surface.simTarget("iPhone SE")) !== null) throw new Error("탭 밖 기기를 대상으로 받는다");
  return true;
});

// Android 는 uiautomator 트리를 idb 요소 모양으로 바꿔 같은 도구를 쓴다. 바꾼 모양이 어긋나면
// 이름 찾기·값 판정·앱 이름·표시 기준 크기가 조용히 비므로, 기기 없이 고정 입력으로 확인한다.
await checkAsync("Android 화면 트리는 iOS 요소와 같은 모양으로 바뀐다", async () => {
  const { parseUiautomator } = await import(new URL("../../mcp/app.mjs", import.meta.url).href);
  const xml = `<?xml version='1.0' ?><hierarchy rotation="0">`
    + `<node class="android.widget.FrameLayout" package="com.ex.app" text="" content-desc="" bounds="[0,0][1080,2400]">`
    + `<node class="android.widget.EditText" text="a &amp; b" content-desc="" enabled="true" bounds="[10,20][110,70]" />`
    + `<node class="android.widget.Switch" text="" content-desc="알림" checkable="true" checked="true" bounds="[0,100][50,150]" />`
    + `<node class="android.widget.Button" text="확인" content-desc="" enabled="false" bounds="[0,200][100,260]" />`
    + `<node class="android.widget.TextView" text='say "hi" &apos;x&apos;' content-desc="" bounds="[0,300][100,360]" /></node></hierarchy>`;
  const t = parseUiautomator(xml);
  const app = t[0];
  if (app.type !== "Application" || app.AXLabel !== "com.ex.app" || app.frame.width !== 1080 || app.frame.height !== 2400)
    throw new Error(`맨 앞 Application 요소가 어긋났다: ${JSON.stringify(app)}`);
  const edit = t.find((e) => e.type === "EditText");
  if (!edit || edit.AXLabel !== "a & b" || edit.AXValue !== "a & b" || edit.frame.width !== 100 || edit.frame.height !== 50)
    throw new Error(`입력칸이 어긋났다: ${JSON.stringify(edit)}`);
  const sw = t.find((e) => e.type === "Switch");
  if (!sw || sw.AXLabel !== "알림" || sw.AXValue !== "1") throw new Error(`켜고 끄는 요소가 어긋났다: ${JSON.stringify(sw)}`);
  const btn = t.find((e) => e.type === "Button");
  if (!btn || btn.enabled !== false) throw new Error("비활성 버튼을 활성으로 읽는다");
  // 값에 " 가 있으면 그 속성은 작은따옴표로 온다(확인 결과: text='a\x60b"c&apos;d').
  if (!t.some((e) => e.AXLabel === `say "hi" 'x'`)) throw new Error("작은따옴표로 감싼 속성을 못 읽는다");
  return true;
});

// 표시 상자는 요소 frame(width·height)에서 만든다. writeMarks 는 w·h 를 읽으므로 frame 을 그대로 펼쳐
// 넘기면 상자 크기가 null 로 저장되어 보고서에 크기 없는 상자가 그려진다(확인 결과: 저장된 표시 전부 null).
await checkAsync("앱 표시 상자는 크기를 가진 채 저장된다", async () => {
  const { appMark } = await import(new URL("../../mcp/app.mjs", import.meta.url).href);
  const { writeMarks } = await import(new URL("../../mcp/report.mjs", import.meta.url).href);
  const fs = await import("node:fs");
  const dir = mkdtempSync(path.join(tmpdir(), "iris-marks-"));
  try {
    const shot = path.join(dir, "s.png");
    writeMarks(shot, [appMark({ x: 100, y: 200, width: 50, height: 100 }, "여기")], { width: 1000, height: 2000 });
    const side = fs.readdirSync(dir).find((f) => f.endsWith(".marks.json"));
    if (!side) throw new Error("표시 파일이 안 생겼다");
    const m = JSON.parse(fs.readFileSync(path.join(dir, side), "utf8")).marks[0];
    if (m.w !== 0.05 || m.h !== 0.05 || m.x !== 0.1 || m.y !== 0.1) throw new Error(`상자 비율이 어긋났다: ${JSON.stringify(m)}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  return true;
});

}
