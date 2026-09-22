// 소유 범위: 재현(녹화) 계약. 사용자가 누른 순서를 남기고, 값은 길이만, 비밀번호는 길이도 남기지 않는다.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사·파일 도구, sources 의 공유 소스, Node 파일·경로 API.
// 유지 조건: 검사 이름과 본문. 20-browser-contracts.mjs 를 기능별로 분리한 것이고,
//   분리하면서 본문을 바꾸지 않았고, 원본 대비 바이트 대조로 이를 강제한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부르며 sources 의 공유 상수 계약도 함께 본다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs bin/smoke/sections/record-replay.mjs
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
console.log("[2c] 재현(녹화) 계약");
check("입력값은 길이만 — 값 자체를 안 남김", () => /len: v\.length/.test(record) && !/value: v\b/.test(record));
check("시스템 대화상자 4종을 감쌈", () => ["alert", "confirm", "prompt", "print"].every((n) => record.includes(`wrapDialog('${n}'`)));
check("이탈 확인창 추적", () => /onBeforeUnload/.test(record) && /'beforeunload', onBeforeUnload/.test(record));
check("prompt 입력값은 길이만 기록", () => /'len:' \+ String\(r\)\.length/.test(record));
check("다운로드 저장창은 네이티브 경로로 추적", () => {
  return /sess\.on\("will-download"/.test(downloadHookSource) && /ac-rec-native/.test(downloadHookSource)
    && /onRecNative/.test(record);
});
check("모든 세션이 하드닝+다운로드 훅을 함께 받음", () => {
  return /function hardenSession/.test(profileSessionPolicySource)
    && /installSessionHook\(sess\)/.test(profileSessionPolicySource)
    && /installSessionHook: installDownloadHook/.test(main)
    && /function installDownloadHook\(sess\)[\s\S]{0,120}sess\.on\("will-download"/.test(downloadHookSource)
    && !/applyHardening\(session\.fromPartition/.test(main);
});
check("오디오 입력만 모든 세션의 request/check 권한 경계에서 거부", () => {
  const { isAudioInputPermission } = require_("../native/electron/browser-hardening.cjs");
  const cases = [
    ["media", { mediaTypes: ["audio"] }, true],
    ["media", { mediaTypes: ["video", "audio"] }, true],
    ["media", { mediaType: "audio" }, true],
    ["media", { mediaTypes: ["video"] }, false],
    ["media", { mediaType: "video" }, false],
    ["media", { mediaType: "unknown" }, false],
    ["media", {}, false],
    ["geolocation", { mediaTypes: ["audio"] }, false],
  ];
  return cases.every(([permission, details, denied]) => isAudioInputPermission(permission, details) === denied)
    && /sess\.setPermissionRequestHandler/.test(profileSessionPolicySource)
    && /sess\.setPermissionCheckHandler/.test(profileSessionPolicySource)
    // 물어볼 때는 막고(callback(false)), 상태를 되물을 때도 같은 답이어야 한다. 한쪽만 막으면
    // 페이지는 "허용됨"으로 읽고 마이크를 켜려다 조용히 실패한다.
    && /audioInputPermission\(permission, details\)\)\s*\{\s*callback\(false\)/.test(profileSessionPolicySource)
    && /!audioInputPermission\(permission, details\)/.test(profileSessionPolicySource);
});
check("WebAuthn은 안전한 origin이고 HID는 FIDO 장치일 때만 허용", () => {
  const { createProfileSessionPolicy, isSecureWebAuthnOrigin, isFidoHidDevice } =
    require_("../native/electron/profile-session-policy.cjs");
  const handlers = {};
  const sessionProbe = {
    setPermissionRequestHandler: (fn) => { handlers.request = fn; },
    setPermissionCheckHandler: (fn) => { handlers.check = fn; },
    setDisplayMediaRequestHandler: (fn) => { handlers.display = fn; },
    setDevicePermissionHandler: (fn) => { handlers.device = fn; },
    removeListener() {}, on() {},
  };
  const { isAudioInputPermission } = require_("../native/electron/browser-hardening.cjs");
  const policy = createProfileSessionPolicy({
    basePartition: "persist:acbrowser",
    fromPartition: () => sessionProbe,
    hardenBrowserSession: () => {}, userAgentForPartition: () => "ua",
    audioInputPermission: isAudioInputPermission,
    systemPreferences: { getMediaAccessStatus: () => "granted", askForMediaAccess: () => Promise.resolve(true) },
    platform: "linux", installSessionHook: () => {},
  });
  policy.hardenSession(sessionProbe);
  const fido = { collections: [{ usagePage: 0xf1d0 }] };
  const otherHid = { collections: [{ usagePage: 0x0001 }] };
  if (!isSecureWebAuthnOrigin("https://secure.example") || !isSecureWebAuthnOrigin("http://localhost:3000")) {
    throw new Error("HTTPS 또는 localhost WebAuthn origin을 거절한다");
  }
  if (isSecureWebAuthnOrigin("http://remote.example") || isSecureWebAuthnOrigin("file:///tmp/page.html")) {
    throw new Error("안전하지 않은 WebAuthn origin을 허용한다");
  }
  if (!isFidoHidDevice(fido) || isFidoHidDevice(otherHid)) throw new Error("FIDO HID usage page 판정이 뒤집혔다");
  if (!handlers.device({ deviceType: "hid", origin: "https://secure.example", device: fido })) {
    throw new Error("안전한 origin의 FIDO HID 장치를 거절한다");
  }
  if (handlers.device({ deviceType: "hid", origin: "https://secure.example", device: otherHid })) {
    throw new Error("FIDO 아닌 HID 장치를 허용한다");
  }
  if (handlers.device({ deviceType: "hid", origin: "http://remote.example", device: fido })) {
    throw new Error("안전하지 않은 origin의 FIDO 장치를 허용한다");
  }
  let answer;
  handlers.request(null, "media", (value) => { answer = value; }, { mediaTypes: ["audio"] });
  if (answer !== false || handlers.check(null, "media", null, { mediaTypes: ["audio"] }) !== false) {
    throw new Error("일반 오디오 입력을 request/check 경계에서 막지 않는다");
  }
  return true;
});
check("마이크 권한 상태를 페이지에서 가짜 객체로 덮지 않는다", () => {
  return !/Permissions\.prototype\.query\s*=/.test(read("native/electron/browser-hardening.cjs"))
    && !/microphone/.test(read("native/electron/webview-preload.cjs"));
});
check("이동 뒤 로딩 대기 삽입", () => /"iris-browser wait"\)/.test(record));
check("select 클릭은 명령이 아니라 주석(재생 멈춤 방지)", () => /e\.el\.tag === "select"/.test(record));
check("반복 오류는 접어서 표시", () => /const dedupe =/.test(record));
check("대화상자 자동응답 기본은 해제(사람이 처리)", () => {
  const c = cdpSessionSource;
  return /Page\.javascriptDialogOpening/.test(c) && /const ans = nextAnswer\(wc\.id\)/.test(c) && /if \(ans\) \{/.test(c);
});
check("dialogs 명령이 CLI·CDP 양쪽에 존재", () => {
  const cli = read("bin/iris-browser.mjs");
  return /async dialogs\(_send, wc, args\)/.test(cdpCmdNativeSource) && /case "dialogs"/.test(cli);
});
check("print는 자동 확인 대상에서 제외", () => /e\.kind !== "print"/.test(record));
// 단일 디바운스가 동시에 채워진 필드를 하나로 합쳐 아이디가 누락되는 회귀를 계약으로 고정한다.
check("입력 기록은 필드마다 따로 디바운스", () => /var inpPending = new Map\(\)/.test(record) && !/var inpTimer = null, inpEl = null/.test(record));
check("자동완성 UI 조작은 기록에서 제외", () => /inAutofill/.test(record) && /data-ac-autofill/.test(record) && /k: 'autofill'/.test(record));
// 자격증명 유출 방지: 스크립트가 채운 값은 기록 자체를 안 하고, 비밀번호는 길이도 안 남긴다.
check("스크립트가 채운 값은 기록 안 함", () => /ev\.isTrusted === false/.test(record));
check("비밀번호는 길이조차 미기록", () => /\{ k: 'type', el: desc\(el\), secret: true \}/.test(record) && !/"<비밀번호 \$\{e\.len\}자>"/.test(record));
check("녹화 스크립트가 사람이 누른 순서로 무장", () => /const dlgArm =/.test(record) && /iris-browser dialogs \$\{dlgPlan\.join/.test(record));
// 한 줄 주석이 뒤따르는 코드를 무효화하는 회귀(주소창·북마크·방문기록 중단)를 계약으로 고정한다.
check("did-navigate가 주소창·방문기록을 갱신", () => {
  const seg = sliceBetween(webviewFactory, 'addEventListener("did-navigate"', 'addEventListener("did-navigate-in-page"', "did-navigate가 주소창·방문기록을 갱신");
  // 주소창 갱신은 새 탭 판정을 거치지만, 세 동작이 모두 동작해야 한다는 조건은 같다.
  return /urlInput\.value = isNewTab\(e\.url, rec\)/.test(seg) && /pushHistory\(e\.url\)/.test(seg) && /syncBookmarkStar\(\)/.test(seg)
    && /addEventListener\("did-navigate-in-page", \(e\) => \{\s*if \(e\.isMainFrame === false\) return;/.test(webviewFactory);
});

}
