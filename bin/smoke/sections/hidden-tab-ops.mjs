// 소유 범위: 보이지 않는 탭에서의 조작. 포커스 대신 세우기, 기기 흉내 되돌리기, 키보드 붙잡고 놓기, visibility registry.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사·파일 도구, sources 의 공유 소스, Node 파일·경로·모듈 API.
// 유지 조건: 검사 이름과 본문. 40-qa-evidence.mjs 를 기능별로 분리한 파일이고,
//   분리하면서 본문을 바꾸지 않았다. 원본 대비 바이트 대조가 그것을 보장한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부르며 sources 의 공유 상수 계약도 함께 본다.
//   현재 목록 확인: node bin/importers.mjs bin/smoke/sections/hidden-tab-ops.mjs
import { mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { tmpdir } from "node:os";

import {
  b4Function, check, checkAsync, read, readAll, require_, ROOT, sourceFiles,
} from "../core.mjs";
import {
  aiState, aiTabs, allServer, archive, archiveHandlers, browserCommands, browserRuntime,
  browserTabs, cdpCaptureToolsSource, cdpCmdCaptureSource, cdpCmdInputSource,
  cdpCmdInspectSource, cdpHiddenViewportSource, cdpObservationSource, cdpSessionSource,
  cdpTransportSource, centerTabs, contextMenu, css, herdrAgents, herdrHandlers, herdrState,
  httpHandler, main, mainJs, mcp, memoPanel, rail, xtermWiring, tabClose, terminalPanel,
  textEditor, web, webviewFactory, webviewThrottleSource, wsCore,
} from "../sources.mjs";
import { sliceBetween, sliceFrom } from "../../slice-anchor.mjs";

export default async function run() {
console.log("\n[10k] 안 보이는 탭도 조작 대상");
{
  const cdp = read("native/electron/cdp-control.cjs"), hiddenViewport = cdpHiddenViewportSource,
        mainH = read("native/electron/main.cjs"),
        pre = read("native/electron/preload.cjs"), srv = read("server/index.js");
  check("포커스를 대신 세워 준다", () => /Emulation\.setFocusEmulationEnabled/.test(hiddenViewport) && /focusEmulated/.test(hiddenViewport));
  check("0x0이면 화면 크기를 대신 넣는다", () => /autoViewport/.test(hiddenViewport)
    && /if \(size\.width > 0 && size\.height > 0\)/.test(hiddenViewport) && /VP_FALLBACK/.test(hiddenViewport));
  check("그 크기는 보이는 탭에서 물려받는다", () => /function setDefaultViewport/.test(hiddenViewport)
    && /acHost\.tabShown\(wc, Math\.round/.test(webviewFactory) && /setDefaultViewport\(m\.w, m\.h\)/.test(mainH));
  // 소스 모양이 아니라 실제로 실행해 확인한다. 데스크톱으로 돌아갈 때 metrics·touch·
  // mouse-to-touch·UA 중 하나라도 남으면 그 탭은 계속 모바일로 동작하고, 모양 검사는 그것을 못 본다.
  await checkAsync("기기 흉내는 되돌릴 때 전부 되돌린다", async () => {
    const { createDeviceEmulation } = require_("../native/electron/cdp-device-emulation.cjs");
    const sent = [];
    const send = async (cmd, params) => { sent.push([cmd, params]); return {}; };
    const wc = {
      id: 7, _url: "https://naver.com",
      on() {}, off() {},
      getUserAgent: () => "Mozilla/5.0 (Macintosh) Chrome/140.0.0.0 Safari/537.36",
      getURL() { return this._url; },
      reload() { this.reloaded = (this.reloaded || 0) + 1; },
      loadURL(u) { this._url = u; this.loaded = u; },
      once(ev, fn) { if (ev === "did-navigate") this._nav = fn; },
    };
    const notified = [];
    const dev = createDeviceEmulation({
      attach: () => send, yieldToExplicitViewport: () => {}, notify: (id, box) => notified.push([id, box]),
    });
    const cmds = () => sent.map(([c]) => c);
    {
      // 폰으로
      const r1 = await dev.apply(wc, { width: 390, height: 844 });
      if (r1.device !== "phone") throw new Error(`390px 가 ${r1.device} 로 잡혔다`);
      if (!dev.hasExplicitDevice(7)) throw new Error("사람이 정한 기기로 안 남는다");
      if (!dev.overrideFor(7) || dev.overrideFor(7).mobile !== true) throw new Error("헤더용 표에 모바일이 안 남는다");
      if (!cmds().includes("Emulation.setUserAgentOverride")) throw new Error("UA 를 안 바꾼다");
      wc._nav && wc._nav(null, "https://m.naver.com");   // 사이트가 전용 주소로 옮겼다
      wc._url = "https://m.naver.com";
      // 데스크톱으로 되돌리기
      sent.length = 0;
      const r2 = await dev.apply(wc, { clear: true });
      const back = cmds();
      for (const need of ["Emulation.clearDeviceMetricsOverride", "Emulation.setTouchEmulationEnabled",
                          "Emulation.setEmitTouchEventsForMouse", "Emulation.setUserAgentOverride"]) {
        if (!back.includes(need)) throw new Error(`되돌릴 때 ${need} 가 안 나갔다`);
      }
      if (r2.restoredUrl !== "https://naver.com") throw new Error(`옮겨간 주소에서 안 돌아온다 — ${r2.restoredUrl}`);
      if (dev.hasExplicitDevice(7) || dev.overrideFor(7)) throw new Error("해제했는데 표가 남는다");
      if (notified.at(-1)[1] !== null) throw new Error("해제를 UI 에 안 알린다");
      // 같은 기기를 두 번 걸어도 쌓이지 않는다
      await dev.apply(wc, { width: 390, height: 844 });
      await dev.apply(wc, { width: 390, height: 844 });
      dev.forget(7);
      if (dev.hasExplicitDevice(7) || dev.overrideFor(7)) throw new Error("forget 뒤에도 남는다");
    }
    return true;
  });

  check("사람이 정한 크기가 우선", () => /function yieldToExplicitViewport/.test(hiddenViewport)
    && /!autoViewport\.has\(id\) && !hasExplicitDevice\(id\)/.test(hiddenViewport)
    // 호출하는 위치가 크기 적용의 소유자다. cdp-control 은 그 소유자에게 이 함수를 주입한다.
    // 연결과 호출이 둘 다 있어야 실제로 되돌아간다.
    && /yieldToExplicitViewport: \(wcId\) => hiddenViewport\.yieldToExplicitViewport\(wcId\)/.test(cdp)
    && /yieldToExplicitViewport\(wc\.id\)/.test(read("native/electron/cdp-device-emulation.cjs")));
  check("보이면 대신 넣은 크기를 거둔다", () => /ac-tab-shown/.test(pre) && /clearAutoViewport\(wc, webContents\)/.test(mainH));
  check("키보드는 붙잡고 넣는다", () => /const NEEDS_KEYS = new Set/.test(cdp)
    && /const wantsKeys = NEEDS_KEYS\.has\(cmd\)/.test(cdp)
    // 붙잡는 이유가 둘(키 도달·조작 뒤 그리기)이 된 뒤로 한 조건에 합쳐 판정한다.
    && /\(!wantsKeys && !wantsFrames\) \|\| !captureHold \|\| isTabShown/.test(cdp)
    && /setShownProbe\(\(wc\) => visibilityRegistry\.isShown\(wc\)\)/.test(readAll("native")));
  // 붙잡는 동안 게스트에 포커스를 주면 놓은 뒤에도 그 탭이 키보드를 점유한다. 사용자가 앱에 친
  // 글자가 보이지 않는 탭으로 들어간다(확인 결과). 붙잡기만으로 충분하므로 포커스는 건드리지 않는다.
  // 이 앱은 사용자의 키보드를 가져오지 않는다. 그래서 입력도 OS 경로가 아니라 페이지 안에서
  // 만든다. key·fill·대량 기입이 모두 같다.
  // 대상은 자동 입력 경로이고 native 전체가 아니다. main.cjs 의 app.focus({steal:true}) 는
  // Chrome 인증을 끝낸 사용자를 앱으로 되돌리는 위치이고 사용자가 누른 결과다. 그것까지 묶으면
  // 검사가 다른 것을 판정하게 된다. CDP 쪽 파일들만 보므로 그 경로가 나뉘어도 따라간다.
  check("사용자 키보드를 뺏지 않는다", () => {
    const cdpFiles = sourceFiles("native").filter((rel) => /\/cdp-[^/]*\.cjs$/.test(rel));
    if (cdpFiles.length < 2) throw new Error(`CDP 파일을 ${cdpFiles.length}개만 찾았다 — 훑는 방식을 확인하라`);
    const src = cdpFiles.map((rel) => read(rel)).join("\n").replace(/\/\/[^\n]*/g, "");
    return !/wc\.focus\(\)|app\.focus\(|owner\.focus\(/.test(src);
  });
  check("붙잡은 키보드도 반드시 놓는다", () =>
    /finally \{ if \(held\) \{ try \{ await captureHold\(wc\.id, false\)/.test(cdp));
  check("입력은 확인하고 끝낸다", () => /via: "입력"/.test(cdpCmdInputSource) && /via: "눌러서 입력"/.test(cdpCmdInputSource)
    && /via: "값 직접 설정"/.test(cdpCmdInputSource) && /입력이 반영되지 않았습니다/.test(cdpCmdInputSource));
  check("창 파기는 visibility registry 정리를 부른다", () =>
    /sender\.once\("destroyed"[\s\S]{0,400}?visibilityRegistry\.dropHost\(_e\.sender\.id\)/.test(readAll("native")));
  check("visibility registry는 파기된 host만 지운다", () => {
    const visibility = require_("../native/electron/visibility-registry.cjs");
    visibility.dropHost("smoke-host-a");
    visibility.dropHost("smoke-host-b");
    visibility.report("smoke-host-a", "smoke-guest-a1");
    visibility.report("smoke-host-a", "smoke-guest-a2");
    visibility.report("smoke-host-b", "smoke-guest-b");
    visibility.dropHost("smoke-host-a");
    if (visibility.isShown("smoke-guest-a1") || visibility.isShown("smoke-guest-a2")) {
      throw new Error("파기된 host의 guest가 남는다");
    }
    if (!visibility.isShown("smoke-guest-b")) throw new Error("다른 host의 guest까지 지운다");
    if (!visibility.isKnown()) throw new Error("남은 host가 있는데 unknown이다");
    visibility.dropHost("smoke-host-b");
    if (visibility.isKnown()) throw new Error("host가 없는데 known이다");
    return true;
  });
  // 앱을 껐다 켜는 사이에 걸친 명령은 실패가 아니라 대기다. 탭은 정체성으로 복원된다.
  check("앱이 없는 동안은 더 오래 기다린다", () => /APP_GONE_DELAYS/.test(browserCommands)
    && /const gone = !!\(last && last\.appGone\);/.test(browserCommands)
    && /const ladder = longWait \? APP_GONE_DELAYS : RETRY_DELAYS;/.test(browserCommands));
  // 증거는 보고서에 담는다. 낱장 스크린샷이 홈 디렉터리에 쌓이지 않게 한다.
  check("스크린샷은 스스로 정리된다", () => /function pruneShots/.test(cdpCaptureToolsSource) && /SHOT_KEEP/.test(cdpCaptureToolsSource)
    && /SHOT_MAX_AGE_MS/.test(cdpCaptureToolsSource) && /pruneShots\(dir\);/.test(cdpCmdCaptureSource));
  // wc 는 재발급되는 번호다. 목록에 보이면 그것으로 지목하게 되고 다른 탭이 움직인다.
  // 재시작 뒤에도 "지정 없는 명령"이 같은 탭으로 가야 한다. 그룹에 탭이 둘 이상이면 달라진다.
  check("마지막으로 쓴 탭도 디스크에 남는다", () => /out\.last = \(out\.last \|\| \[\]\)/.test(browserRuntime)
    && /for \(const \[pane, tabId\] of \(g\.last \|\| \[\]\)\) lastTabByPane\.set/.test(browserRuntime)
    && /if \(lastTabByPane\.get\(key\) === tabId\) return;/.test(browserRuntime));
  check("목록은 wc를 내보내지 않는다", () => /const \{ wc: _wc, \.\.\.rest \} = m;/.test(browserRuntime)
    && !/args\.wc != null \? tabIdOfRef/.test(allServer));
  // did-navigate가 안 오는 이동(about:blank 등)에도 목록이 실제를 따라가야 한다.
  check("로드가 끝나면 주소·제목을 다시 보고", () => /reportTabWc\(rec, tabId\)/.test(sliceBetween(webviewFactory, 'el.addEventListener("did-stop-loading", () => {\n    if (historyToken', '\n  });', "로드가 끝나면 주소·제목을 다시 보고")));
  check("탭 목록이 보이는 탭을 알려준다", () => /showing: tabIsShowing\(m\.space, tabId\)/.test(browserRuntime)
    && /function tabIsShowing/.test(browserRuntime) && /activeTabBySpace\.get\(w\.id\) === tabId/.test(browserRuntime)
    && /spaceKey\.sameStorageSpace\(space, w\.id\)/.test(browserRuntime));
  // 재접속 직후 한 번만 보내면 그 시점엔 아직 서버 상태가 안 와서 활성 탭을 몰라 조용히 건너뛴다.
  check("보이는 탭 보고는 상태가 올 때마다", () => {
    const seg = sliceBetween(aiTabs, "function applyBrowserState", "function syncDockedTabLabels", "보이는 탭 보고는 상태가 올 때마다");
    return /syncDockedTabLabels\(\)/.test(seg) && /reportActiveBrowserWc\(\)/.test(seg);
  });
}

// [10j] 보고 있지 않은 탭도 QA 대상
// 그려지지 않는 것은 어떤 캡처 수단으로도 가져올 수 없다(확인 결과: 네 경로 모두 빈 결과).
// 그리려면 그 webview 가 합성 대상이어야 하므로, 찍는 순간에만 거의 투명하게 겹쳐 둔다. 탭은 바뀌지 않는다.
}
