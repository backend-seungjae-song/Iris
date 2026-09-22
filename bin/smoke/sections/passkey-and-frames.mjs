// 소유 범위: 패스키(WebAuthn)와 하위 프레임. 안전한 origin 에서만 동작하고, HID 는 FIDO 장치일 때만 허용한다.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사·파일 도구, sources 의 공유 소스, Node 파일·경로 API.
// 유지 조건: 검사 이름과 본문. 20-browser-contracts.mjs 를 기능별로 분리한 것이고,
//   분리하면서 본문을 바꾸지 않았고, 원본 대비 바이트 대조로 이를 강제한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부르며 sources 의 공유 상수 계약도 함께 본다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs bin/smoke/sections/passkey-and-frames.mjs
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
console.log("[2m] 패스키·하위 프레임");
// Chrome의 패스키 대화상자는 브라우저 층이 그리는 것이라 Electron에는 없다. 요청은 대기 상태로 남고
// 화면에는 아무것도 표시되지 않는다(확인 결과: get()이 5초 넘게 무응답, isUVPAA=false). 대신 앱이 알린다.
const wvpre = read("native/electron/webview-preload.cjs");
// CSP가 엄격한 사이트는 preload가 넣는 인라인 <script>를 실행하지 않는다(확인 결과:
// signin.aws.amazon.com에서 주입이 전부 무효였다). 그래서 감지 스크립트는 CDP로 등록한다.
// addScriptToEvaluateOnNewDocument는 main world에서 실행되고 CSP의 제약을 받지 않는다.
const bhard = read("native/electron/browser-hardening.cjs");
check("감지 스크립트는 CDP로 건다(CSP 우회)", () => {
  return /WEBAUTHN_SCRIPT/.test(bhard) && /module\.exports = \{[^}]*WEBAUTHN_SCRIPT/.test(bhard)
    && /Page\.addScriptToEvaluateOnNewDocument/.test(webviewLifecycleSource) && /runImmediately: true/.test(webviewLifecycleSource)
    && !/<script/.test(sliceBetween(bhard, "const WEBAUTHN_SCRIPT", "const BOTCHECK_SCRIPT", "감지 스크립트는 CDP로 건다(CSP 우회)"));
});
check("게스트 main world에서 credentials를 감싼다", () =>
  /__acWebAuthn/.test(bhard) && /wrap\('get'\); wrap\('create'\)/.test(bhard)
  && /isUserVerifyingPlatformAuthenticatorAvailable/.test(bhard)
  && /if \(window\.__acWA\) return/.test(bhard));
// 같은 스크립트가 두 경로로 들어가면 두 번 감싸져 알림이 겹치므로, preload 쪽 주입은 제거했다.
check("preload는 중계만 하고 주입하지 않는다", () =>
  /sendToHost\("ac-webauthn"/.test(wvpre) && !/wrap\('get'\)/.test(wvpre));
check("호스트로 중계된다", () => /sendToHost\("ac-webauthn"/.test(wvpre)
  && /e\.channel === "ac-webauthn"/.test(webviewFactory) && /function webauthnNotice/.test(browserHandoff));
// 로그인 흐름은 iframe 안에서 도는 경우가 많다(AWS 등). preload가 최상위 문서에만 걸리면 못 잡는다.
check("preload가 하위 프레임에도 걸린다", () => {
  const m = readAll("native").match(/webPreferences\.nodeIntegrationInSubFrames = true;/g);
  return !!m && m.length === 3; // 콘솔 창 + 분리 브라우저 창 + 탭 분리 창 (native 전체에서 센다)
});
// 하위 프레임까지 preload가 실행되면 호스트의 el.send가 모든 프레임에 전달된다. 비밀번호는 요청한
// 프레임만 받아야 하는데, webview 태그에는 프레임 지정 전송이 없어 id 반향으로 제한한다.
check("자동완성 응답은 요청한 프레임만 받는다", () =>
  /var FRAME_ID = /.test(wvpre)
  && /payload\.frameId !== FRAME_ID \|\| payload\.password == null/.test(wvpre)
  && (webviewFactory.match(/frameId: req\.frameId/g) || []).length === 4);
// 외부로 넘기는 것은 http(s)만 허용한다. file:·커스텀 스킴을 넘기면 임의 앱 실행 통로가 된다.
check("Chrome 넘기기는 신뢰 발신자 + http(s)만", () => {
  const seg = sliceBetween(chromeHandoffIpcSource, 'ipcMain.on("ac-open-in-chrome"', 'ipcMain.on("ac-ensure-profile"', "Chrome 넘기기는 신뢰 발신자 + http(s)만");
  return /isTrustedSender\(e\)/.test(seg) && /u\.protocol !== "http:" && u\.protocol !== "https:"/.test(seg);
});
// 창 생성 함수 안에서 등록하면 창 수만큼 중복 등록돼 openExternal이 여러 번 불린다.
check("넘기기 핸들러는 모듈 최상위 1회 등록", () => {
  return (chromeHandoffIpcSource.match(/ipcMain\.on\("ac-open-in-chrome"/g) || []).length === 1
    && (main.match(/createChromeHandoffIpc\(\{/g) || []).length === 1;
});
// 세 이름이 이 순서로 등장하는지 보면, 의존을 하나 더 넘길 때 순서가 밀려 연결이 정상인데도
// 실패한다. 그래서 순서가 아니라 그 이름이 조립부에 실제로 전달되는지를 검사한다.
// 하나라도 빠지면 그 자리에서 실패한다.
const HANDOFF_DEPS = ["runChromeAuth", "cookieImport", "chromeProfileCid", "chromeImportRegistry",
  "profileSessionPolicy", "isTrustedSender", "isProfilePartition"];
check("chrome-handoff-ipc가 main 조립부에 연결된다", () => {
  if (!/const \{ createChromeHandoffIpc \} = require\("\.\/chrome-handoff-ipc\.cjs"\);/.test(main)) return false;
  const seg = sliceBetween(main, "createChromeHandoffIpc({", "\n});", "chrome-handoff-ipc가 main 조립부에 연결된다");
  return HANDOFF_DEPS.every((name) => new RegExp("(^|[\\s{,])" + name + "\\s*[,:]").test(seg));
});

// 탐색/활성화는 복구를 확인하되 실제 적용된 경우에만 화면을 다시 연다.
check("탭 전환·이동 복구는 실제 적용 결과를 확인한다", () =>
  /refreshChromeSession/.test(webviewFactory) && /refreshChromeCookies/.test(webviewFactory)
  && /result\.changed/.test(webviewFactory) && /result\.refreshed/.test(webviewFactory));

check("재수집 IPC는 신뢰 발신자 + 알려진 파티션 + http(s)만", () => {
  const seg = sliceBetween(chromeHandoffIpcSource, 'ipcMain.handle("ac-refresh-chrome-cookies"', "\n  });",
    "재수집 IPC는 신뢰 발신자 + 알려진 파티션 + http(s)만");
  return /isTrustedSender\(e\)/.test(seg)
    && /isProfilePartition\(partition\)/.test(seg)
    && /url\.protocol !== "http:" && url\.protocol !== "https:"/.test(seg)
    && /skipped: "unsupported-browser"/.test(seg)
    && /refreshFromChrome/.test(seg);
});

}
