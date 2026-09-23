// 소유 범위: [2n]·[2n2] Chrome 인증 넘겨주기와 [2o] 전역 단축키 우선순위 검사.
// 제공 API: 원래 [2n] 자리에서 한 번 호출하는 비동기 기본 run.
// 의존 대상: core의 공유 검사·파일 도구, sources의 공유 소스, Node 파일·경로·OS API.
// 유지 조건: 검사 이름·순서·문구, 실제 프로필·자격증명 비접촉, 임시 폴더 정리, full smoke 출력.
// 영향 범위: 러너가 동적 import로 이 run을 호출하며, sources의 workspaceRuntime 계약도 함께 본다.
//   지금 목록은 이걸로 센다: node bin/importers.mjs bin/smoke/sections/30-chrome-auth.mjs
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { check, checkAsync, read, readAll, require_, ROOT } from "../core.mjs";
import {
  accountsScreen, allCss, allWebJs, audioDiagnosticsSource, bookmarks, browserHandoff, browserTabs, browserWindowManagerSource, cdpHiddenViewportSource, centerTabs, certificateTrustSource, chromeHandoffIpcSource, chromeImportRegistrySource, credentialIpcSource, css, downloadHookSource, keynav, main, mainJs, pick, pickHost, pickModeSource, profileSessionPolicySource, profiles, reorder, textEditor, web, webview, webviewFactory, webviewLifecycleSource, webviewStore, workspaceRuntime,
} from "../sources.mjs";
import { sliceBetween, sliceFrom } from "../../slice-anchor.mjs";

export default async function run() {
console.log("[2n] 인증 넘겨주기 — 연결된 실제 Chrome 계정 프로필");
const cauth = read("native/electron/chrome-auth.cjs");
const cookieImporter = read("native/electron/cookie-import.cjs");
const realHandoff = sliceBetween(cauth, "async function runProfileHandoff", "async function runChromeAuth", "실 프로필에는 원격 디버깅과 별도 user-data-dir를 붙이지 않는다");
const authEntry = sliceBetween(cauth, "async function runChromeAuth", "module.exports", "연결된 Chrome·Brave·Edge 프로필만 인증 창으로 연다");
check("설계 근거 문서가 있다", () => existsSync(path.join(ROOT, "docs/chrome-auth-handoff.md")));
check("실 프로필에는 원격 디버깅과 별도 user-data-dir를 붙이지 않는다", () =>
  /--profile-directory=/.test(realHandoff) && /--new-window/.test(realHandoff)
  && !/--remote-debugging|--user-data-dir/.test(realHandoff));
check("연결된 Chrome·Brave·Edge 프로필만 인증 창으로 연다", () =>
  /BROWSER_APPS/.test(realHandoff) && /listChromeProfiles\(\).*runProfileHandoff/s.test(authEntry)
  && /연결된 Chrome 계정이 없습니다/.test(authEntry));
const authMod = require_(path.join(ROOT, "native/electron/chrome-auth.cjs"));
const osaProbe = await authMod.osaRun("return 42");
check("인증 헬퍼 프로브가 실제로 실행된다", () => osaProbe === "42");
check("쿠키 범위가 등록 가능 도메인으로 한정된다", () =>
  authMod.baseDomain("ap-southeast-2.signin.aws.amazon.com") === "amazon.com"
  && authMod.baseDomain("www.naver.co.kr") === "naver.co.kr"
  && authMod.inScope(".signin.aws.amazon.com", "amazon.com") === true
  && authMod.inScope("evil-amazon.com", "amazon.com") === false
  && authMod.inScope("notamazon.com", "amazon.com") === false
  && authMod.baseDomain("alice.github.io") === "alice.github.io"
  && authMod.inScope("bob.github.io", "alice.github.io") === false
  && authMod.baseDomain("tenant.appspot.com") === "tenant.appspot.com");
check("실 프로필에서 현재 사이트 범위 쿠키만 가져와 Iris 상태를 교체한다", () =>
  /readDecryptedCookies\(entry, inTargetScope\)/.test(realHandoff)
  && !/session\.cookies\.remove/.test(realHandoff)
  && /stableReads >= 2/.test(realHandoff)
  && /signature !== before/.test(realHandoff)
  && /if \(!isCurrent\(\)\)/.test(realHandoff)
  && /expectedTargetFingerprint = cookieFingerprint/.test(realHandoff)
  && /cookieImport\.putCookies\(partition, cookies, \{[\s\S]{0,120}isCurrent, sourceIsCurrent, expectedTargetFingerprint/.test(realHandoff));
check("명시적 Chrome 가져오기는 Orca의 스테이징·콜드스타트 재생 경로를 쓴다", () =>
  /stageCookieRows/.test(cookieImporter)
  && /applyPendingCookieImports/.test(cookieImporter)
  && /registerPendingCookieImport/.test(cookieImporter)
  && /replayStagedCookieDatabase/.test(cookieImporter)
  && /DELETE FROM cookies;/.test(cookieImporter)
  && /replaceCookieSnapshot/.test(cookieImporter)
  && !/clearStorageData\(\{ storages: \["cookies"\] \}\)/.test(cookieImporter));
check("웹뷰 생성은 Chrome 쿠키를 자동 재가져오지 않는다", () => {
  const create = sliceFrom(webviewFactory, "function createWebview", 1200, "웹뷰 생성은 Chrome 쿠키를 자동 재가져오지 않는다");
  return !/maybeAutoImportProfile|importChromeProfile/.test(create) && !/lastAutoImport/.test(allWebJs);
});
check("가져온 UA의 출처 기록과 실행 엔진 정체성을 분리한다", () =>
  /persistPartitionUserAgent\(partition, userAgent\)/.test(cookieImporter)
  && /applyHardening\(sess\)/.test(cookieImporter)
  && /applyBrowserUserAgentToPartition\(partition, sourceBrowser\)/.test(chromeHandoffIpcSource));
check("main은 파티션별 UA를 관리하는 모듈에 실제 함수를 연결한다", () =>
  /cookieImport\.userAgentForPartition\(partition\)/.test(main)
  && /createChromeHandoffIpc\(\{[\s\S]{0,300}\n\s*cookieImport,\n/.test(main)
  && /rememberBrowserUserAgent\(imported\.partition, imported\.browser\)/.test(main));
// "로그인 포함 삭제"라고 적어 놓고 파티션의 쿠키·localStorage·캐시를 디스크에 남기면 그 문구가
// 거짓이 된다. 같은 이름으로 다시 만들면 id 가 같아 이전 로그인이 그대로 복원된다.
check("프로필을 지우면 그 파티션의 저장소도 비운다", () => {
  const seg = sliceBetween(profileSessionPolicySource, "async function purgePartition", "async function forEachHardened", "프로필을 지우면 그 파티션의 저장소도 비운다");
  return /clearStorageData\(\)/.test(seg) && /clearCache\(\)/.test(seg)
    && /forget\(partition\)/.test(seg)
    && /ipcMain\.handle\("ac-purge-partition"/.test(credentialIpcSource)
    && /acHost\.purgePartition\(partitionFor\(profileId\)\)/.test(accountsScreen);
});
// 붙는 시점에 "실제로 있는 프로필만" 통과시키는 목록 게이트는 두지 않는다. 그 목록은 렌더러가
// 알려 줘야 하는데 서버 상태가 오기 전에는 비어 있어, 그 시점에 붙는 프로필 탭이 전부 막힌다.
// 삭제한 프로필이 복원되는 것은 위 purgePartition 이 막는다.
check("파티션 통과 여부를 렌더러 목록에 맡기지 않는다", () =>
  !/knownPartitions/.test(readAll("native")) && !/knownPartitions/.test(web));
// 광고·위젯 iframe 하나가 실패해도 탭 전체가 "로드 실패"로 보였다. 그 문구는 사람을 엉뚱한 데로 보낸다.
check("로드 실패는 주 문서만, 인증서는 따로, 새 이동에 걷힌다", () => {
  const seg = sliceFrom(webviewFactory, 'addEventListener("did-fail-load"', 1200, "로드 실패는 주 문서만, 인증서는 따로, 새 이동에 걷힌다");
  return /e\.isMainFrame === false\) return/.test(seg)
    && /errorCode <= -200 && e\.errorCode > -300/.test(seg)
    && /인증서 문제로 열지 못했습니다/.test(seg)
    && /removeLoadFailure\(tabId\)/.test(webviewFactory)
    && /export function removeLoadFailure\(tabId\) \{\s*delete lastLoadFail\[tabId\];/.test(webviewStore);
});
// 상자만 그리면 겹친 요소 중 지금 잡힌 것이 버튼인지 감싼 상자인지 누르기 전에 알 수 없다.
check("요소 선택은 무엇이 잡혔는지 라벨로 알려준다", () => {
  const seg = sliceFrom(pickHost, "const ORCA_INJECT", pickHost.length, "요소 선택은 무엇이 잡혔는지 라벨로 알려준다");
  return /var labelOf = function/.test(seg) && /LB\.textContent = labelOf\(el\)/.test(seg)
    && /LB\.style\.display = 'none'/.test(seg);
});
// 나중에 따로 찍으면 스크롤·펼침 상태가 이미 달라져 "그때 그것"이 아니다.
check("고른 요소의 그림을 그 자리에서 찍는다", () =>
  /acHost\.pickShot\(shotRec\.wc, sel\)/.test(pick)
  && /요소 그림: \$\{p\.shot\}/.test(pick)
  && /ipcMain\.handle\("ac-pick-shot"/.test(pickModeSource)
  && /runCdp\(webContents, wcId, "screenshot", \{ element: sel \}\)/.test(pickModeSource));
// 보이지 않는 탭은 위젯이 0×0이라 페이지가 자기 폭을 0으로 읽는다. 폭으로 기기를 판별하는
// 사이트는 이를 모바일로 인식한다. Chrome의 배경 탭은 크기를 유지하므로 발생하지 않는다.
check("안 보이는 탭도 사람이 보는 창 크기를 갖는다", () => {
  const c = cdpHiddenViewportSource, wiring = read("native/electron/cdp-control.cjs");
  return /if \(isTabShown\(id\) \|\| hasExplicitDevice\(id\)\) return false/.test(c)
    && /Emulation\.setDeviceMetricsOverride/.test(c) && /mobile: false/.test(c)
    // 화면에 붙은 뒤에만 적용한다. 탭이 생성되는 순간에 적용하면 그릴 표면이 없어 Electron 이
    // SIGSEGV 로 종료된다. 어느 탭이 보이는지 모르는 동안에는 적용하지 않는다.
    // 그 상태에서 적용하면 사용자가 보고 있는 탭이 잘못된 크기로 고정된다.
    && /if \(!shownStateKnown\(\)\) return false/.test(c)
    && /did-attach-webview[\s\S]{0,220}pinHiddenViewportById\(guest\.id/.test(browserWindowManagerSource)
    && (wiring.match(/hiddenViewport\.pin\(/g) || []).length === 1
    && /if \(before && before !== wc\) pinHiddenViewportById\(before, webContents\);/.test(main); // 화면에서 내려갈 때
});
check("browser-window-manager 숨은 viewport가 main CDP에 배선됨", () => {
  const assembly = sliceBetween(main, "const browserWindowManager = createBrowserWindowManager", "const memoWindowManager = createMemoWindowManager", "브라우저 창 관리자 조립");
  return /pinHiddenViewportById,/.test(assembly) && /webContents,/.test(assembly);
});
// 쓰기 경계를 "살아 있는 에이전트의 cwd" 로만 잡으면, 터미널이 안 떠 있는 스페이스의 파일은
// 열리는데 저장만 막힌다(읽기는 로컬에 한해 밖까지 열려 있다). 스페이스 폴더도 경계에 넣는다.
check("뷰어로 연 파일은 저장되고, 열지 않은 경로는 그대로 막는다", () => {
  const runtimeState = read("server/runtime-state.js"), fsHandlers = read("server/fs-handlers.js");
  return /workspaces\.map\(\(w\) => w\.folder\)/.test(workspaceRuntime)   // 스페이스 폴더도 경계에 든다
    && /function saveAllowed\(p\) \{ return isPathAllowed\(p\) \|\| wasOpenedHere\(p\); \}/.test(runtimeState)
    && /if \(ws\._local\) noteOpened\(p\);/.test(fsHandlers)              // 연 사실을 남기는 쪽은 읽기다
    && /if \(!p \|\| !saveAllowed\(p\)/.test(fsHandlers)                 // 쓰기는 그 사실을 본다
    && /openedForEdit\.size > OPENED_MAX/.test(runtimeState)              // 무한히 쌓지 않는다
    && /done\(\{ error: saveDeniedMsg\(p\) \}\)/.test(fsHandlers)
    && /원격에서는 저장 불가/.test(fsHandlers);                            // 원격은 여전히 통째로 막는다
});
// 파일 이름은 서버가 정해 보내는 값이다. 그대로 쓰면 저장 자체가 실패하고, 사람에게는 "안 됐다"로만
// 보인다. 저장 위치도 미리 선점해야 한다. 존재 여부만 보고 정하면 같은 이름 둘이 같은 위치를 고른다.
check("내려받는 파일의 이름을 다듬고 자리를 미리 잡는다", () => {
  const seg = sliceBetween(downloadHookSource, "function safeDownloadName", "function installDownloadHook", "내려받는 파일의 이름을 다듬고 자리를 미리 잡는다");
  return /\[\\x00-\\x1f\\x7f\]/.test(seg)          // 제어문자
    && /\[\. \]\+\$/.test(seg)                        // 끝의 점·공백
    && /WIN_RESERVED/.test(seg)                        // Windows 예약 이름
    && /reservedPaths\.has\(p\)/.test(seg)             // 자리 선점
    && /reservedPaths\.delete\(dest\)/.test(downloadHookSource);  // 끝나면 놓아 준다
});
// 이름 정규화 규칙과 위치 선점 규칙은 소스 모양으로 확인되지 않으므로 실제로 실행한다.
// 페이지가 준 이름이 폴더 밖으로 나가는지, 같은 이름 둘이 한 위치를 겹쳐 잡는지,
// 무장하지 않았을 때 저장 경로를 정해 버리는지는 실행해야 판정된다.
check("내려받기 훅은 이름을 씻고 자리를 겹치지 않게 잡고 무장했을 때만 정해 준다", () => {
  const { createDownloadHook } = require_("../native/electron/download-hook.cjs");
  const fsMod = require_("node:fs");
  const pathMod = require_("node:path");
  const dir = mkdtempSync(path.join(tmpdir(), "iris-download-hook-"));
  try {
    let armed = { dir };
    const claimed = [], completed = [];
    const downloadState = {
      snapshot: () => armed,
      claim: (dest) => claimed.push(dest),
      complete: (dest, state) => completed.push([dest, state]),
    };
    const winSent = [];
    // 종료된 창을 앞에 둔다. 뒤에 두면 가드를 지워도 살아 있는 창이 먼저 받아 검사가 통과한다.
    // 종료된 창의 throw 는 바깥 catch 가 삼키기 때문이다.
    const windows = [
      { isDestroyed: () => true, webContents: { send: () => { throw new Error("죽은 창에 보냈다"); } } },
      { isDestroyed: () => false, webContents: { send: (ch, ev) => winSent.push([ch, ev]) } },
    ];
    const hook = createDownloadHook({
      fs: fsMod, path: pathMod, downloadState,
      allWindows: () => windows, now: () => 12345,
    });

    // 페이지가 준 이름은 검증한다. 경로 이탈, 숨김 파일, Windows 가 거부하는 이름을 막는다.
    if (hook.safeDownloadName("../../etc/passwd") !== "_.._etc_passwd") throw new Error("상위 경로가 남았다");
    if (/[/\\]/.test(hook.safeDownloadName("a/b\\c.txt"))) throw new Error("경로 구분자가 남았다");
    if (hook.safeDownloadName("보\u0007고\u0000서.txt") !== "보고서.txt") throw new Error("제어문자가 남았다");
    if (hook.safeDownloadName('a<b>c:d"e|f?g*h.txt') !== "a_b_c_d_e_f_g_h.txt") throw new Error("다른 OS에서 못 쓰는 글자가 남았다");
    if (hook.safeDownloadName(".hidden.txt")[0] === ".") throw new Error("앞의 점이 남아 숨김이 된다");
    if (hook.safeDownloadName("보고서.txt ") !== "보고서.txt") throw new Error("끝의 공백이 남았다");
    if (hook.safeDownloadName("con.txt") !== "_con.txt") throw new Error("Windows 예약 이름을 안 피했다");
    if (hook.safeDownloadName("") !== "download") throw new Error("빈 이름이 빈 채로 나왔다");
    const longName = hook.safeDownloadName("가".repeat(300) + ".txt");
    if (Buffer.byteLength(longName, "utf8") > 200) throw new Error("바이트 상한을 넘겼다");
    if (!longName.endsWith(".txt")) throw new Error("확장자를 잃었다");
    if (path.dirname(path.resolve(dir, hook.safeDownloadName("../../etc/passwd"))) !== path.resolve(dir))
      throw new Error("씻은 이름이 폴더 밖을 가리킨다");

    // 저장 위치는 미리 선점한다. 아직 파일이 없어도 이미 선점된 위치는 다시 주지 않는다.
    fsMod.writeFileSync(path.join(dir, "note.txt"), "먼저 있던 파일");
    const first = hook.reserveDownloadPath(dir, "note.txt");
    if (first !== path.join(dir, "note (1).txt")) throw new Error("있는 파일을 덮는 자리를 골랐다");
    const second = hook.reserveDownloadPath(dir, "note.txt");
    if (second === first) throw new Error("아직 없는 같은 자리를 둘에게 줬다");

    // 무장 상태에서는 저장 위치를 정해 원장에 등록하고, 끝나면 그 위치를 해제한다.
    const doneHandlers = [];
    const saved = [];
    const item = {
      getFilename: () => "note.txt",
      getURL: () => "https://example.test/note.txt",
      getTotalBytes: () => 11,
      setSavePath: (p) => saved.push(p),
      once: (name, fn) => { if (name === "done") doneHandlers.push(fn); },
    };
    const listeners = [];
    hook.installDownloadHook({ on: (name, fn) => { if (name === "will-download") listeners.push(fn); } });
    if (listeners.length !== 1) throw new Error("will-download 를 안 걸었다");
    const guest = { id: 9, isDestroyed: () => false, hostWebContents: null };
    listeners[0](null, item, guest);
    if (saved.length !== 1 || saved[0] === first || saved[0] === second)
      throw new Error("저장 자리를 정하지 않았거나 이미 잡힌 자리를 다시 줬다");
    if (claimed[0] !== saved[0]) throw new Error("정한 자리를 장부에 안 걸었다");
    // 호스트가 없는 게스트는 살아 있는 모든 창으로 전달되고, 종료된 창은 건너뛴다.
    if (winSent.length !== 1 || winSent[0][0] !== "ac-rec-native" || winSent[0][1].wc !== 9)
      throw new Error("어느 탭에서 받았는지 못 실었다");
    for (const fn of doneHandlers) fn(null, "completed");
    if (completed[0][1] !== "completed") throw new Error("끝난 것을 장부에 안 알렸다");
    const reused = hook.reserveDownloadPath(dir, "note.txt");
    if (reused !== saved[0]) throw new Error("끝난 자리를 놓아 주지 않았다");

    // hostWebContents 가 있는 게스트는 그 호스트로만 간다.
    const hostSent = [];
    winSent.length = 0;
    listeners[0](null, item, { id: 4, isDestroyed: () => false,
      hostWebContents: { isDestroyed: () => false, send: (ch, ev) => hostSent.push([ch, ev]) } });
    if (hostSent.length !== 1 || winSent.length) throw new Error("호스트가 있는데 모든 창에 뿌렸다");

    // 무장하지 않았으면 저장 위치를 정하지 않는다. 네이티브 저장 창은 사용자가 직접 본다.
    armed = { dir: null };
    saved.length = 0; claimed.length = 0;
    listeners[0](null, item, guest);
    if (saved.length || claimed.length) throw new Error("무장하지 않았는데 자리를 정했다");
    return true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
// 자체서명 인증서를 자동으로 신뢰하지 않고 사용자가 승인한다. 범위는 로컬 주소의 발급처 불명
// 오류 하나로 좁힌다. 만료·이름 불일치까지 물으면 사용자가 습관적으로 승인하게 된다.
check("로컬 인증서는 사람에게 묻고, 그 범위 밖은 그대로 거절", () => {
  return /isLocalCertHost\(host\)/.test(certificateTrustSource)
    && /ERR_CERT_AUTHORITY_INVALID/.test(certificateTrustSource)
    && /askHuman\(/.test(certificateTrustSource)
    && /noplan=1/.test(certificateTrustSource) // 확인창 자동응답 무장이 인증서까지 대신 답하면 안 된다
    && /certDecisions\.set\(key, ok\)/.test(certificateTrustSource);
});
check("인증서 신뢰 서비스가 네이티브 조립부에 연결된다", () => {
  const native = readAll("native");
  return /const certificateTrust = createCertificateTrust\(\{ appUrl: \(\) => APP_URL, fetchImpl: fetch \}\)/.test(native)
    && /certificateTrust\.installCertificateTrust\(app\)/.test(native);
});
// Chrome은 자기가 마지막에 쓰던 모니터에 창을 연다. 인증 창은 요청한 앱 창의 화면에 둔다.
check("인증 창을 보고 있는 화면에 놓는다", () => {
  return /set bounds of window id/.test(realHandoff)
    && /getDisplayMatching\(ow\.getBounds\(\)\)/.test(chromeHandoffIpcSource);
});
check("빈 프로필 Chrome 프로세스와 Dock 중복을 만드는 실행 경로가 없다", () =>
  !/--user-data-dir|isolated-v2|Target\.createTarget|remote-debugging/.test(realHandoff + authEntry));
check("인증 URL은 프로세스 argv가 아니라 식별된 Chrome 창에만 전달한다", () => {
  const launch = sliceFrom(realHandoff, "spawn(browser.bin", 320, "인증 URL은 프로세스 argv가 아니라 식별된 Chrome 창에만 전달한다");
  return /"about:blank"/.test(launch) && !/target\.href/.test(launch)
    && /set URL of active tab of window id/.test(realHandoff);
});
// 공유 브라우저 창도 자기 탭을 가진 스페이스다. herdr 스페이스 목록에 없어서 기본 계정 설정이
// 빠져 있었다. 계정 관리에 그 항목이 있어야 한다.
check("계정 관리에 공유 브라우저 기본 계정이 있다", () =>
  /id: "__shared__", label: "공유 브라우저"/.test(accountsScreen));
// 순서는 사람이 정한 것이라 창을 다시 열어도 남아야 한다 = 서버 상태여야 한다.
check("탭·북마크 순서를 드래그로 바꾸고 서버가 기억한다", () => {
  const bs = read("server/browser-state.js");
  return /case "tab\.move"/.test(bs) && /case "bookmark\.move"/.test(bs)
    // 인덱스가 아니라 "어느 항목 앞"으로 지정한다(그 사이 목록이 바뀌어도 의도가 안 어긋난다)
    && /m\.before \? tabs\.findIndex/.test(bs)
    && /export function wireReorder/.test(reorder)
    && /op: "tab\.move"/.test(browserTabs) && /op: "bookmark\.move"/.test(bookmarks)
    // 원격(폰)은 다른 쓰기 op와 같은 취급
    && /"tab\.move", "bookmark\.move"/.test(readAll("server"));
});
// 탭에 아이콘·상태가 없으면 탭이 많을 때 글자만 보고 골라야 한다(Chrome도 같은 영역을 쓴다).
check("탭에 파비콘·불러오는 중·소리 표시가 붙는다", () =>
  /page-favicon-updated/.test(webviewFactory) && /did-start-loading/.test(webviewFactory) && /media-started-playing/.test(webviewFactory)
  && /function tabLead/.test(browserTabs)
  // 이동을 시작할 때 이전 아이콘을 지운다. 지우지 않으면 다른 사이트 아이콘이 남는다
  && /did-start-navigation.*setTabStatus\(tabId, \{ icon: "" \}\)/s.test(webviewFactory));
// AudioService 누수 A/B는 평상시 Chromium 경로를 바꾸면 안 된다. 유효한 env 값만 ready 전에 스위치를 붙인다.
check("AudioService A/B 스위치는 env 유효값에서만 ready 전에 적용된다", () => {
  return /new Set\(\["input", "output", "both"\]\)/.test(audioDiagnosticsSource)
    && /AUDIO_TEST_MODES\.has\(env\.IRIS_AUDIO_TEST\)/.test(audioDiagnosticsSource)
    && /testMode === "input" \|\| testMode === "both"/.test(audioDiagnosticsSource)
    && /appendSwitch\("disable-audio-input"\)/.test(audioDiagnosticsSource)
    && /testMode === "output" \|\| testMode === "both"/.test(audioDiagnosticsSource)
    && /appendSwitch\("disable-audio-output"\)/.test(audioDiagnosticsSource);
});
check("AudioService A/B 스위치 조립은 ready 앞에 있다", () => {
  const beforeReady = sliceBetween(main, "const NO_THROTTLE_OPT", "app.whenReady()", "AudioService A/B 스위치 조립은 ready 앞에 있다");
  return /audioDiagnostics\.applyTestSwitches\(app\.commandLine\)/.test(beforeReady);
});
check("AudioService 계측은 env-gated이고 증가·종료 사건만 기록한다", () => {
  return /env\.IRIS_AUDIO_DIAG === "1" \|\| !!testMode/.test(audioDiagnosticsSource)
    && /app\.getAppMetrics\(\)/.test(audioDiagnosticsSource)
    && /details\.type !== "Utility"/.test(audioDiagnosticsSource) && /\/audio\/i/.test(audioDiagnosticsSource)
    && /workingSetSize > previous/.test(audioDiagnosticsSource)
    && /setIntervalFn\(sampleAudioServiceMemory, AUDIO_DIAG_INTERVAL_MS\)/.test(audioDiagnosticsSource)
    && /app\.on\("child-process-gone"/.test(audioDiagnosticsSource) && /audio-service-gone/.test(audioDiagnosticsSource);
});
check("AudioService 진단 플래그가 네이티브 경계를 잇는다", () => {
  const native = readAll("native");
  return /AUDIO_DIAG_ENABLED \? \{ additionalArguments: \["--ac-audio-diag"\]/.test(native)
    && /process\.argv\.includes\("--ac-audio-diag"\)/.test(native);
});
check("미디어 사건은 tabId·wcId·origin으로 AudioService 표본과 상관 가능하다", () =>
  /audioMediaEvent\(event, tabId, el\.getWebContentsId\(\)\)/.test(webviewFactory)
  && /ipcMain\.on\("ac-audio-media-event"/.test(main)
  && /guest\.hostWebContents !== e\.sender/.test(main)
  && /audioDiagLog\("media-" \+ event, \{ tabId, wcId, origin \}\)/.test(main));
// 밖에서 바뀐 파일이 화면에 반영 안 되면 낡은 내용을 붙들고 편집하게 된다.
check("밖에서 바뀐 파일을 감시한다", () => {
  const owner = read("server/fs-handlers.js"), entry = read("server/index.js");
  return /export function handleFsWatch/.test(owner)
    // 파일이 아니라 폴더를 감시한다. 편집기의 "임시파일+rename" 저장에서는 파일 watcher가 끊긴다
    && /fs\.watch\(dir, \{ persistent: false \}\)/.test(owner)
    && !/fs\.watch\(p,/.test(owner)
    // 한 번의 저장이 이벤트를 여러 개 내므로 묶어서 한 번만 처리한다
    && /setTimeout\(\(\) => \{[\s\S]{0,400}dir-changed/.test(owner)
    // 연결이 끊기면 watcher도 놓는다
    && /export function closeFsClient\(ws\) \{ unwatchAll\(ws\); \}/.test(owner)
    && /closeFsClient\(ws\)/.test(entry);
});
// 외부 변경을 화면에 반영하는 규칙은 VSCode 와 같다. 편집이 없으면 그대로 교체하고,
// 편집이 있으면 사용자의 편집을 유지하며 묻지 않는다. 편집 중에 「디스크 내용으로 / 내 편집
// 유지」 띠를 띄우면 저장해도 사라지지 않아 이미 해소된 충돌을 계속 묻고, 「내 편집 유지」는
// 아무 동작도 하지 않았다. 묻는 시점은 저장 한 곳으로 모았다.
check("편집 중이면 덮지 않고, 묻지도 않는다", () => {
  const seg = sliceBetween(centerTabs, "function applyExternalChange", "function persistFileTabs", "편집 중이면 덮지 않고, 묻지도 않는다");
  return /if \(isTabDirty\(t\)\) return;/.test(seg)
    // 커서·되돌리기를 지키며 갈아끼운다(setValue로 통째로 갈면 커서가 튄다)
    && /applyExternalTextToModel\(/.test(seg)
    && /pushEditOperations/.test(textEditor)
    // 선택을 묻던 UI 자체가 없어야 한다. 남겨 두면 같은 방식으로 되돌아간다
    && !/t\.diskContent\s*=/.test(centerTabs)
    && !/data-act="take-disk"/.test(textEditor) && !/data-act="keep-mine"/.test(textEditor);
});
// 주소줄: Enter로 이동하므로 "이동" 버튼은 없앴다. 핸들러가 남으면 시작할 때 null에 접근해 터진다.
check("이동 버튼과 그 핸들러가 함께 사라졌다", () =>
  !/url-go/.test(web) && !/>이동</.test(web) && /if \(k === "Enter"/.test(bookmarks));
// 버튼 열 개가 나란히 있으면 어디를 볼지 알기 어렵다. 이동·주소·도구 세 그룹으로 나눈다.
check("주소줄이 세 덩어리로 나뉜다", () =>
  /class="ub-nav"/.test(web) && /class="ub-tools"/.test(web) && /class="ub-sep"/.test(web));
// 별표는 주소칸 안에 있어야 바깥 버튼이 하나 줄어든다(Chrome과 같은 위치).
check("북마크 별표가 주소칸 안에 있다", () => {
  const wrap = sliceBetween(web, '<div class="url-wrap">', '<div class="ub-tools">', "북마크 별표가 주소칸 안에 있다");
  return /id="wv-bookmark"/.test(wrap) && /ico in-url/.test(wrap);
});
// macOS 기본 스크롤바는 얇고 멈추면 사라져 "더 있는지"가 안 보인다. 앱 전체에 한 규칙으로 둔다.
check("스크롤바가 앱 전체에 눈에 띄게 그려진다", () => {
  const has = /::-webkit-scrollbar \{ width:12px; height:12px; \}/.test(css("01-base"))
    && /::-webkit-scrollbar-thumb \{/.test(css("01-base"));
  // 표준 속성을 함께 쓰면 Chromium이 그쪽만 적용하고 위 규칙을 무시하므로 섞어 쓰지 않는다.
  const noStandard = !/scrollbar-width\s*:/.test(allCss) && !/scrollbar-color\s*:/.test(allCss);
  // 여백(투명 테두리)이 넓으면 트랙만 굵고 손잡이는 되레 얇아진다. 12px 트랙에 3px가 상한.
  const thumb = /border:3px solid transparent; background-clip:padding-box/.test(css("01-base"));
  // Monaco는 스크롤바를 직접 그려 CSS가 적용되지 않으므로, 같은 굵기·세기를 옵션과 테마로 맞춘다.
  const mono = /verticalScrollbarSize: 12/.test(textEditor) && /scrollbarSlider\.background/.test(textEditor);
  return has && noStandard && thumb && mono;
});
// 프로필 버튼은 툴바 오른쪽 끝에 있어 left로 잡으면 메뉴가 창 밖으로 밀리므로 왼쪽으로 펼친다.
check("계정 메뉴가 왼쪽으로 펼쳐지고 글은 오른쪽 정렬", () =>
  /menu\.style\.right = Math\.max\(4, Math\.round\(window\.innerWidth - r\.right\)\)/.test(profiles)
  && /menu\.style\.left = "auto"/.test(profiles)
  && /\.profile-menu \{ text-align:right; \}/.test(css("17-editor-bar"))
  // 이름을 치는 칸까지 오른쪽으로 밀면 커서를 못 찾는다
  && /\.pm-in \{[^}]*text-align:left/.test(css("17-editor-bar")));
// 팝업(window.open)은 별도 창이라 렌더러가 알지 못한다. 등록하지 않으면 tabs에 나오지 않아
// 조작할 수 없고, 등록 폼·결제·OAuth 동의처럼 팝업으로만 뜨는 화면이 전부 제외된다.
// 탭 정체성은 태어나서 닫힐 때까지 겹치지 않는 하나여야 한다. 시각+순번은 창이 둘일 때 같은
// 밀리초에 겹칠 수 있고, 번호가 섞인 정체성은 재발급될 때 남의 탭을 가리킨다.
check("탭 정체성은 겹치지 않는 난수", () => {
  const si = read("server/browser-commands.js"), nativeH = readAll("native");
  return /function newTabId\(prefix\) \{ return String\(prefix\) \+ crypto\.randomUUID\(\); \}/.test(si)
    && /const id = newTabId\("browser:ai\."\);/.test(si)
    && /return "browser:" \+ crypto\.randomUUID\(\);/.test(webview)
    && !/Date\.now\(\) \+ "\." \+ \(\+\+browserSeq\)/.test(webview)
    && !/"browser:ai\." \+ Date\.now\(\)/.test(si)
    && /crypto\.randomUUID/.test(nativeH);
});
check("팝업 창도 조종 대상으로 등록된다", () => {
  const m = webviewLifecycleSource, s = read("server/browser-message-handlers.js");
  // 정체성에 번호를 넣지 않는다. wc는 재발급되어 이전 지목이 다른 팝업을 가리키게 된다.
  return /const popupId = "popup:" \+ randomUuid\(\);/.test(m) && /randomUuid: \(\) => crypto\.randomUUID\(\)/.test(main)
    && /tabId: popupId,/.test(m)
    && !/tabId: "popup:" \+ cwc\.id/.test(m)
    && /win: "popup", openerWc/.test(m)
    // 닫히면 목록에서 빠져야 한다. 그러지 않으면 없는 대상이 남아 명령이 전달되지 않는다
    && /browser-tab-gone", wc: cwc\.id/.test(m)
    // 이것은 등록·첫 provenance의 소스 모양만 본다. 실제 목록 노출·세션 격리는
    // test/popup-tab-access.mjs가 /browser-cmd 응답으로 이어서 본다.
    && /const first = !hasTab\(msg\.tabId\)/.test(s)
    && /const openerTabId = msg\.openerWc \? tabIdOfWc\(msg\.openerWc\) : null/.test(s)
    && /if \(ownerGroup\) meta\.ownerGroup = ownerGroup/.test(s);
});
// 스킴이 있는 주소에 https를 덧붙이면 "https://file///…"가 된다.
check("newtab이 스킴 있는 주소를 그대로 연다", () =>
  /\/\^\[a-z\]\[a-z0-9\+\.-\]\*:\/i\.test\(rs\[0\]\)/.test(read("bin/iris-browser.mjs")));
check("모든 열린 Iris 프로필의 원본 DOM·쿠키 저장소를 함께 flush한다", () =>
  /profileSessionPolicy\.forEachHardened/.test(main)
  && /sess\.flushStorageData\(\)/.test(main)
  && /sess\.cookies\.flushStore\(\)/.test(main)
  && !/sessionCookieStore|createSessionCookieStore/.test(main));
check("Chrome import 장부는 partition의 최신 연결을 고른다", () => {
  return /Object\.values\(chromeImports \|\| \{\}\)/.test(chromeImportRegistrySource)
    && /Number\(b\.at \|\| 0\) - Number\(a\.at \|\| 0\)/.test(chromeImportRegistrySource)
});
check("인증 IPC는 파티션의 최신 Chrome 연결 장부를 우선한다", () => {
  const handler = sliceBetween(chromeHandoffIpcSource, 'ipcMain.handle("ac-chrome-auth"', 'ipcMain.on("ac-open-in-chrome"', "인증 IPC는 파티션의 최신 Chrome 연결 장부를 우선한다");
  return /chromeImportRegistry\.latestForPartition\(partition\)/.test(handler)
    && /chromeCid: chromeProfileCid/.test(handler);
});
check("렌더러의 Chrome 프로필 식별자는 허용 브라우저·프로필 형식만 통과한다", () =>
  /\^\(chrome\|brave\|edge\):\(\?:Default\|Profile \\d\+\)\$/.test(chromeHandoffIpcSource));
// 상태가 이미 오염된 경우를 계측기가 판정하지 못하면 같은 문제를 반복한다.
check("오염된 Chrome을 탐지한다", () => {
  const bad = "8236 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-pipe --no-first-run";
  const clean = "1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const pred = (l) => /Google Chrome\.app\/Contents\/MacOS\/Google Chrome/.test(l)
    && /--remote-debugging-(pipe|port)/.test(l);
  return typeof authMod.findPoisonedChrome === "function" && pred(bad) && !pred(clean)
    && /findPoisonedChrome\(\)/.test(read("native/electron/main.cjs"));
});
// 파티션 이름이 경로가 되므로 ROOT를 벗어나면 남의 디렉터리를 프로필로 쓴다.
// 링크로 열린 새 탭이 프로필을 물려받지 않으면 같은 사이트인데 로그아웃 상태로 열린다. 확인 결과
// AWS 콘솔은 서비스를 새 탭으로 열어 탭마다 세션이 갈렸다. opener의 정체가 렌더러까지 도달해야 한다.
check("페이지가 연 새 탭은 연 탭의 프로필로 뜬다", () =>
  // 링크로 연 탭 = 연 탭 기준(opener 정체가 렌더러까지 도달해야 한다)
  /openerWc: wc\.id/.test(webviewLifecycleSource)
  && /getWebviewEntries\(\)\.find\(\(\[, rec\]\) => rec && rec\.wc === m\.openerWc\)/.test(web)
  && /if \(hit\) \{[\s\S]{0,500}?profile = profileOfTab\(hit\)/.test(web)
  // 저장값이 비어 스페이스 기본값을 따르는 중이어도 *표시되는* 값을 물려준다(profileOfTab이 그 값이다)
  && /if \(inherit !== undefined\) mut\.profile = inherit;/.test(web));
check("인증 헬퍼는 프로필 파일을 복사·수정하지 않는다", () =>
  !/copyFileSync|writeFileSync\([^\n]*profile|rmSync\([^\n]*profile|renameSync\([^\n]*profile/.test(cauth));
check("쿠키 DB replay manifest는 Iris partition·staging 실제 경로만 허용한다", () =>
  /function validPendingEntry/.test(cookieImporter)
  && /realpathSync\(partitions\)/.test(cookieImporter)
  && /realpathSync\(stagingRoot\(\)\)/.test(cookieImporter)
  && /isWithin\(realPartitions, realTargetParent\)/.test(cookieImporter)
  && /isWithin\(realStagingRoot, realStaging\)/.test(cookieImporter));
check("IPC는 신뢰 발신자 + 알려진 파티션만", () => {
  const seg = sliceBetween(chromeHandoffIpcSource, 'ipcMain.handle("ac-chrome-auth"', 'ipcMain.on("ac-open-in-chrome"', "IPC는 신뢰 발신자 + 알려진 파티션만");
  return /isTrustedSender\(e\)/.test(seg) && /isProfilePartition\(partition\)/.test(seg);
});
await checkAsync("chrome-handoff-ipc는 비신뢰 요청을 막고 성공한 가져오기만 UA 복원 장부에 남긴다", async () => {
  const { createChromeHandoffIpc } = require_("../native/electron/chrome-handoff-ipc.cjs");
  const on = new Map(), handles = new Map(), events = [];
  let trusted = false, authOk = false, importError = true;
  const owner = { isDestroyed: () => false, show: () => events.push("show"), focus: () => events.push("window-focus") };
  const sender = { isDestroyed: () => false, send: () => events.push("stage") };
  const entry = { id: "chrome:Default", label: "Chrome Default", account: "person@example.test", browser: { id: "chrome" } };
  createChromeHandoffIpc({
    app: { focus: (opts) => events.push(opts && opts.steal ? "app-focus-steal" : "app-focus") },
    BrowserWindow: { fromWebContents: () => owner },
    screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1600, height: 1000 } }),
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1600, height: 1000 } }) },
    ipcMain: { on: (name, fn) => on.set(name, fn), handle: (name, fn) => handles.set(name, fn) },
    shell: { openExternal: () => events.push("external") },
    session: { fromPartition: (partition) => ({ partition }) },
    isTrustedSender: () => trusted,
    isProfilePartition: (partition) => partition === "persist:acprof:one",
    runChromeAuth: async () => ({ ok: authOk }),
    cookieImport: {
      listChromeProfiles: () => [entry],
      importCookiesFromChrome: async () => { events.push(importError ? "import-failed" : "import-ok"); return importError ? { error: "실패" } : { imported: 1 }; },
      applyBrowserUserAgentToPartition: () => events.push("ua-applied"),
    },
    chromeProfileCid: (row) => row.id,
    chromeImportRegistry: { latestForPartition: () => ({ cid: "chrome:Default" }) },
    profileSessionPolicy: { ensureHardened: () => events.push("hardened") },
    passwordImport: { listLoginsFromChrome: () => ({ logins: [] }) },
    setCreds: () => events.push("creds"),
    noteChromeImport: () => events.push("ua-ledger"),
  });
  const untrustedAuth = await handles.get("ac-chrome-auth")({ sender }, { partition: "persist:acprof:one", url: "https://example.test" });
  const untrustedImport = await handles.get("ac-import-chrome-profile")({ sender }, { id: entry.id, partition: "persist:acprof:one" });
  on.get("ac-open-in-chrome")({ sender }, "https://example.test");
  if (untrustedAuth.ok !== false || !/신뢰/.test(untrustedAuth.error || "") || !/신뢰/.test(untrustedImport.error || "")) throw new Error("비신뢰 요청을 거절하지 않았다");
  if (events.length) throw new Error("비신뢰 요청이 외부 효과를 냈다");
  trusted = true;
  await handles.get("ac-chrome-auth")({ sender }, { partition: "persist:acprof:one", url: "https://example.test" });
  if (events.includes("ua-applied") || events.includes("app-focus-steal")) throw new Error("실패한 인증 뒤 UA 또는 앱 focus를 적용했다");
  authOk = true;
  await handles.get("ac-chrome-auth")({ sender }, { partition: "persist:acprof:one", url: "https://example.test" });
  if (!events.includes("ua-applied") || !events.includes("app-focus-steal")) throw new Error("성공한 인증 뒤 UA와 앱 focus를 적용하지 않았다");
  await handles.get("ac-import-chrome-profile")({ sender }, { id: entry.id, partition: "persist:acprof:one" });
  if (events.includes("ua-ledger")) throw new Error("실패한 가져오기를 UA 복원 장부에 남겼다");
  importError = false;
  await handles.get("ac-import-chrome-profile")({ sender }, { id: entry.id, partition: "persist:acprof:one" });
  if (events.filter((x) => x === "ua-ledger").length !== 1) throw new Error("성공한 가져오기를 UA 복원 장부에 정확히 한 번 남기지 않았다");
  return true;
});
// AI가 조작 중일 때 세션을 옮기면 자동 수집 통로가 되므로, 비밀번호 전달과 같은 규칙을 적용한다.
// 조작 중 판정은 탭 단위다. 창 전체로 판정하면 다른 탭에서 AI가 동작할 때 이 탭의 로그인 창까지
// 열리지 않는다.
check("AI 조작 중에는 넘기지 않는다", () => /if \(autofillBlocked\(rec && rec\.tabId\)\) \{ txt\.textContent = "이 탭을 AI가 조작하는 중/.test(browserHandoff));
check("끝나면 그 탭을 새로고침한다", () =>
  /rec\.el\.reload\(\)/.test(browserHandoff) && /host\.chromeAuth\(chk\.url, chk\.partition, chk\.src, fields\)/.test(browserHandoff));
// 계정 칩 옆 버튼으로 현재 페이지를 임시 창에 띄운다. 자동 감지만으로는 필요한 시점을 놓친다.
// 첫 탭의 계정이 그 스페이스에 복제되면 기본 계정을 바꿔도 새 탭이 이전 계정으로 열려 설정이
// 적용되지 않는다. 확인 결과 Acme 기본이 Acme-Personal인데 탭 4개가 이전 기본을 쓰고 있었다.
// 페이지가 스스로 연 탭(opts.profile)만 연 탭의 세션을 잇는다.
check("새 탭은 스페이스 기본 계정으로 뜬다", () => {
  const seg = sliceFrom(web, "function newBrowserTab", 1800, "새 탭은 스페이스 기본 계정으로 뜬다");
  return /const spDef = getSpaceDefaults\(\)\[sp\]/.test(seg)
    && /opts && opts\.profile !== undefined[\s\S]{0,120}\(spDef && profileById\(spDef\)\) \? spDef : undefined/.test(seg)
    // 현재 보고 있는 탭을 물려받지 않는다. 그것이 계정 복제의 원인이다.
    && !/profileOfTab\(activeBrowserId\(\)\)/.test(seg);
});
// 사용자가 직접 호출하는 경로는 탭 우클릭 하나다. 주소줄 버튼은 그 위치에 스케치가 들어가면서
// 제거했다. 없음을 검사하므로 그 버튼이 다시 생기면 여기서 걸린다.
check("임시 창은 탭 우클릭으로만 부른다", () =>
  !/id="wv-handoff"/.test(web) && !/#wv-handoff/.test(mainJs)
  && /provide\("handoff\.tabItem"/.test(browserHandoff)
  && /callHook\("handoff\.tabItem"/.test(browserTabs));
// 사람이 방금 친 값을 다시 치게 하지 않는다. 걷는 쪽과 넣는 쪽이 같은 기준(id→name→type별 순번)을
// 써야 칸이 맞는다. 순번은 빈 칸까지 세어야 양쪽이 어긋나지 않는다.
check("지금 친 값을 걷어 임시 창에 넣는다", () => {
  const capIdx = browserHandoff.indexOf("const CAPTURE_JS");
  if (capIdx < 0) return false;
  const cap = browserHandoff.slice(capIdx, capIdx + 900);
  return /cnt\[t\]=i\+1;\s*\n\s*if\(SKIP\.indexOf\(t\)>=0\) return;/.test(cap)   // 빈 칸도 세고 나서 거른다
    && /"checkbox","radio"/.test(cap)                                            // 켜짐 상태는 안 옮긴다
    && /function fillJs\(fields, wantOrigin\)/.test(cauth)
    && /getElementById\(f\.id\)/.test(cauth) && /els\[i\]\.name===f\.name/.test(cauth) && /same\[f\.tidx\]/.test(cauth)
    // 프레임워크가 알아채게 네이티브 setter + 이벤트. el.value= 만 하면 React는 빈 칸으로 안다.
    && /d\.set\.call\(el,f\.value\)/.test(cauth) && /new Event\("input",\{bubbles:true\}\)/.test(cauth);
});
// 값에 비밀번호가 섞인다. 로그로 새지 않고, 양은 막아둔다.
check("입력값은 한도를 두고 로그로 안 샌다", () =>
  /MAX_FIELDS = 40/.test(cauth) && /MAX_FIELD_LEN = 4096/.test(cauth)
  && /function sanitizeFields/.test(cauth)
  && /stage\("filling", \{ filled: fill(Res)?\.filled, requested: fill(Res)?\.requested, why: fill(Res)?\.why \}\)/.test(cauth)
  && !/stage\("filling", \{ fields/.test(cauth) && !/stage\("filling", fill\)/.test(cauth));
// 못 옮겼으면 그렇다고 말한다. 조용히 빈 칸으로 두면 사람은 값이 갔다고 믿고 넘어간다.
check("값을 못 옮기면 사람에게 말한다", () =>
  /const short = fields\.length && \(r\.filled \|\| 0\) < fields\.length/.test(browserHandoff)
  && /입력값 \$\{fields\.length\}칸 중/.test(browserHandoff));
check("값을 채운 뒤에도 우리가 연 창의 실제 존재 여부로 종료를 판정한다", () =>
  /fillOverAppleScript/.test(realHandoff)
  && /const current = await windowIds\(browser\)/.test(realHandoff)
  && /!current\.includes\(windowId\)/.test(realHandoff));
check("입력값은 AppleScript stdin으로만 전달되고 로그·argv에 실리지 않는다", () =>
  /Buffer\.from\(fillJs\(fields, wantOrigin\)/.test(cauth)
  && /spawn\("\/usr\/bin\/osascript", \["-"\]/.test(cauth)
  && /child\.stdin\.end\(script\)/.test(cauth)
  && !/logLine\("filling", \{ fields/.test(cauth));
// 사람이 안 눌렀는데 방금 친 비번이 Chrome 창으로 실려가면 안 된다.
// 순서는 "창을 닫으면 그때 가져오기"다. 쿠키가 바뀌었다고, 다른 origin으로
// 이동했다고 먼저 종료하면 로그인 도중에 창이 닫힌다. OAuth는 처음부터 다른 origin을 쓴다.
// 종료 신호는 사용자가 그 창을 닫는 것 하나뿐이다. 조건부가 아니라 유일한 경로여야 하므로,
// 자동으로 닫고 가져오는 기능은 두지 않는다.
// 안 될 때 볼 것이 있어야 한다. 이 흐름은 화면 밖에서 벌어지고 앱 stdout은 어디에도 안 남는다.
// 글자만 바뀌면 멈춘 것처럼 보인다. 특히 창을 닫고 디스크에 쓰이길 기다리는 몇 초가 그렇다.
check("가져오는 동안 도는 표시가 있다", () =>
  /stage\("harvesting"/.test(cauth)
  && /harvesting: "쿠키 가져오는 중…"/.test(browserHandoff)
  && /animation:scr-spin/.test(css("22-handoff"))   // 레이아웃은 그 기능의 CSS 가 갖는다
  && /handoffBarEl\.__spin\.style\.display = HANDOFF_SPIN_OFF\.has\(s\.stage\) \? "none" : ""/.test(browserHandoff)
  // 사용자를 기다리는 동안에는 동작하지 않는다. 진행 중인 작업이 아니다.
  && /const HANDOFF_SPIN_OFF = new Set\(\["waiting"\]\)/.test(browserHandoff));
check("임시 창 흐름은 기록을 남긴다", () =>
  /const LOG_PATH = path\.join\(STATE_HOME, "chrome-auth\.log"\)/.test(cauth)
  && /function logLine\(name, extra\)/.test(cauth) && /logLine\(name, extra\);/.test(cauth)
  // 값은 남기지 않는다. 비밀번호가 섞일 수 있다.
  && !/logLine\("filling", \{ fields/.test(cauth));
check("우리가 연 실 Chrome 창만 ID로 추적한다", () =>
  /const wasOpen = await windowIds\(browser\)/.test(realHandoff)
  && /fresh = current\.filter\(\(id\) => !wasOpen\.includes\(id\)\)/.test(realHandoff)
  && !/window 1/.test(realHandoff));
// 가져올 것이 없는데 "쿠키 0개 가져왔습니다"라고 하면 성공처럼 읽힌다.
check("가져올 쿠키가 없으면 없다고 말한다", () =>
  /가져올 쿠키가 없습니다/.test(cauth) && !/\{ ok: 0 \}/.test(cauth));
check("임시 창은 사람이 닫아야만 끝난다", () =>
  !/close window id|Browser\.close/.test(cauth)
  && /!current\.includes\(windowId\)/.test(realHandoff)
  && /Date\.now\(\) < deadline/.test(realHandoff));
// 창을 잘못 집으면 남의 사이트에 비밀번호를 친다. 넣기 직전에 그 창이 아직 그 사이트인지 본다.
// 밖에서 주소를 묻고 그 다음에 넣으면 그 사이 탭이 바뀔 수 있다(TOCTOU). 페이지 안에서 본다.
check("값은 그 페이지가 그 사이트일 때만 넣는다", () =>
  /if\(location\.origin!==\$\{JSON\.stringify\(String\(wantOrigin \|\| ""\)\)\}\) return -2;/.test(cauth)
  && /if \(count === -2\) return \{ filled: 0, requested: fields\.length, why: "wrong-page" \}/.test(cauth)
  // 이름이 같아도 종류가 다르면 채우지 않는다. 같은 이름의 숨은 칸에 비밀번호가 들어간다.
  && /els\[i\]\.name===f\.name&&\(!f\.type\|\|ty\(els\[i\]\)===f\.type\)/.test(cauth));
check("연결된 프로필을 목록에서 정확한 cid로 다시 확인한다", () =>
  /listChromeProfiles\(\)\.find\(\(profile\) => chromeCid\(profile\) === chromeSource\)/.test(authEntry));
check("연결 없는 탭은 빈 Chrome으로 폴백하지 않고 명시적으로 중단한다", () =>
  /if \(!chromeSource \|\| !cookieImport/.test(authEntry)
  && !/--user-data-dir|runIsolatedChromeAuth/.test(cauth));
// 바로 여는 모드는 처음에 버튼을 붙이지 않는다. 실패했을 때 다시 누를 버튼이 없으면 진행할 수 없다.
check("실패하면 다시 누를 자리가 생긴다", () =>
  /const offerRetry = \(label\)/.test(browserHandoff) && /if \(!go\.isConnected\) bar\.insertBefore\(go, x\)/.test(browserHandoff));
// 수집한 주소와 여는 주소가 다르면 값을 버린다. 그 사이 이동했다면 다른 페이지의 입력값이다.
check("주소와 값을 같은 시점에 걷는다", () =>
  /return \{url:String\(location\.href\|\|""\),fields:out\.slice\(0,40\)\}/.test(browserHandoff)
  && /const fields = sameOrigin \? snap\.fields : \[\]/.test(browserHandoff));
check("실 프로필 수확 뒤 DOM·쿠키 저장소를 즉시 flush한다", () =>
  /session\.flushStorageData\(\)/.test(realHandoff) && /session\.cookies\.flushStore\(\)/.test(realHandoff));
check("자동으로 열린 창에는 입력값을 안 싣는다", () =>
  /const snap = auto \? \{ url: "", fields: \[\] \} : await captureFields\(rec\)/.test(browserHandoff));
// 패스키는 트리거 하나일 뿐이고, 임베드를 막는 사이트나 확장이 필요한 흐름도 같은 경로로 온다.
// 직접 호출할 방법이 없으면 감지되지 않는 경우에 아무것도 할 수 없다.
check("넘겨주기는 어느 탭에서든 손으로 부를 수 있다", () =>
  /function handoffToChrome\(rec, reason, auto, now\)/.test(browserHandoff)
  // 우클릭 메뉴의 그 항목은 이 기능이 만든다. 앱 셸은 이름만 호출하고 빈 항목을 걸러낸다.
  && /provide\("handoff\.tabItem", \(rec\) => \(handoffCheck\(rec\)\.ok \? \{/.test(browserHandoff)
  && /label: "Chrome에서 이어서 진행"/.test(browserHandoff)
  && /const handoffItem = callHook\("handoff\.tabItem", getWebview\(tabId\)\);/.test(browserTabs)
  && /if \(handoffItem\) items\.push\(handoffItem\);/.test(browserTabs));
// 패스키는 누르게 하지 않는다. 지문 인증을 띄울 수 없는 것이 확정이라 물어볼 것이 없다.
// 감지는 알림만 한다. 스스로 창을 띄우고 닫으면 사용자가 모르는 사이 세션이 바뀌므로,
// 자동 처리는 두지 않는다. 창을 여는 결정은 사용자가 알림 막대의 "Chrome에서 열기"로 한다.
check("패스키 감지는 알리기만 하고 창을 안 연다", () => {
  const seg = sliceBetween(browserHandoff, "function webauthnNotice", "function botCheckNotice", "패스키 감지는 알리기만 하고 창을 안 연다");
  const hint = sliceBetween(browserHandoff, "function handoffHint", "export function webauthnNotice", "패스키 감지는 알리기만 하고 창을 안 연다");
  return /handoffHint\(rec,/.test(seg) && !/handoffToChrome\(/.test(seg)
    // 넘길 수 있는 탭이면 누를 버튼이 있는 막대를 띄운다. auto·now 를 넘기면 누르기 전에 창이 열린다.
    && /if \(handoffCheck\(rec\)\.ok\) \{ handoffToChrome\(rec, [^,()]+(\([^)]*\))?[^,()]*\); return; \}/.test(hint)
    && !/🪟/.test(browserHandoff)
    && /if \(auto \|\| now\) run\(\);/.test(browserHandoff) && /if \(!auto && !now\) bar\.appendChild\(go\);/.test(browserHandoff);
});
// 보고 있지 않은 탭이 막대를 띄우면 갑자기 튀어나온 것으로 보인다.
check("안 보이는 탭은 조용하다", () =>
  /if \(!rec \|\| !rec\.el \|\| !rec\.el\.classList\.contains\("active"\)\) return;/.test(browserHandoff)
  && /Date\.now\(\) - last < 30000/.test(browserHandoff) && /const handoffRecent = new WeakMap\(\)/.test(browserHandoff));
// 넘길 수 없는 조건은 한곳에서 판정한다. 트리거마다 따로 검사하면 기준이 갈린다.
check("넘길 수 있는지 판정이 한곳", () => {
  const seg = sliceBetween(browserHandoff, "function handoffCheck", "function handoffToChrome", "넘길 수 있는지 판정이 한곳");
  return /http\(s\) 페이지만/.test(seg) && /return \{ ok: true, url, partition, src \}/.test(seg)
    && (browserHandoff.match(/function handoffCheck/g) || []).length === 1;
});

console.log("[2n2] 사람 확인(Turnstile) — 통과시키려 들지 않고 Chrome으로 넘긴다");
// 확인 결과: 같은 IP·같은 시각에 실제 Chrome은 통과하는데 이 창은 위장 스크립트를 끄거나
// CDP 부착을 끄더라도 항상 "확인 실패"였다. Electron 런타임 자체가 걸리므로 더 가리는 방향으로
// 가지 않고, 실패를 감지해 패스키와 같은 넘겨주기 경로로 보낸다.
{
  const vm = require_("node:vm");
  const { BOTCHECK_SCRIPT } = require_(path.join(ROOT, "native/electron/browser-hardening.cjs"));
  // 문자열 검사는 스크립트가 동작하지 않아도 통과하므로 실제로 실행한다.
  const runBotcheck = ({ code, top = true, calls = 1 }) => {
    const posted = [];
    const ctx = { JSON, Object, RegExp, String, Error };
    ctx.window = ctx;
    ctx.top = top ? ctx : { other: 1 };
    ctx.location = { host: "example.com" };
    ctx.postMessage = (m) => posted.push(m);
    ctx.setInterval = () => 0;
    ctx.clearInterval = () => {};
    ctx.document = {
      readyState: "complete",
      addEventListener() {},
      querySelectorAll: (sel) => (/data-error-callback/.test(sel) ? [{ getAttribute: () => "onErr" }] : []),
    };
    vm.createContext(ctx);
    vm.runInContext(BOTCHECK_SCRIPT, ctx);
    // 페이지가 나중에 콜백을 대입해도 래핑되어야 한다. 그러지 않으면 감지가 누락된다.
    ctx.onErr = function () {};
    for (let i = 0; i < calls; i++) ctx.onErr(code);
    return posted;
  };
  // 환경 때문에 못 넘는 실패(6xxxxx·3xxxxx)만 사람을 부른다.
  check("환경 실패 코드면 넘겨주기를 부른다", () => {
    const p = runBotcheck({ code: "600010" });
    return p.length === 1 && p[0].__acBotCheck.code === "600010"
      && p[0].__acBotCheck.kind === "turnstile" && p[0].__acBotCheck.host === "example.com";
  });
  // sitekey·도메인 설정 오류는 Chrome에서도 같이 실패하므로, 사용자를 부르지 않는다.
  check("사이트 설정 오류(1xxxxx)에는 안 부른다", () => runBotcheck({ code: "110200" }).length === 0);
  // 재시도하는 위젯이 창을 쏟아내면 안 된다. 한 문서에 한 번.
  check("여러 번 실패해도 한 번만 부른다", () => runBotcheck({ code: "600010", calls: 4 }).length === 1);
  // 하위 프레임(광고·분석)의 실패까지 사람을 부르지 않으려면 어느 프레임인지 실어 보내야 한다.
  check("최상위 문서인지 함께 알린다", () =>
    runBotcheck({ code: "600010", top: true })[0].__acBotCheck.top === true
    && runBotcheck({ code: "600010", top: false })[0].__acBotCheck.top === false);
  // 위젯 자체는 절대 건드리지 않는다. 접근자를 걸었더니 api.js가 window.turnstile을 대입하지
  // 않고 체크박스가 표시되지 않았다. 감지 때문에 로그인이 막힌다.
  check("Cloudflare 위젯 객체는 건드리지 않는다", () => {
    const ctx = { JSON, Object, RegExp, String, Error };
    ctx.window = ctx; ctx.top = ctx;
    ctx.location = { host: "example.com" };
    ctx.postMessage = () => {};
    ctx.setInterval = () => 0; ctx.clearInterval = () => {};
    ctx.document = { readyState: "complete", addEventListener() {}, querySelectorAll: () => [] };
    vm.createContext(ctx);
    vm.runInContext(BOTCHECK_SCRIPT, ctx);
    // 주입 뒤에도 turnstile 속성은 비어 있어야 한다. 접근자도 걸려 있으면 안 된다.
    const d = Object.getOwnPropertyDescriptor(ctx, "turnstile");
    return d === undefined && !/window,\s*['"]turnstile['"]/.test(BOTCHECK_SCRIPT);
  });
  // 배선: 감지 → preload → 호스트 UI → 넘겨주기. 한 칸만 끊겨도 아무 일도 안 일어난다.
  check("감지가 넘겨주기까지 이어진다", () => {
    const wp = read("native/electron/webview-preload.cjs");
    return /botcheckScript, runImmediately: true/.test(webviewLifecycleSource) // 문서보다 먼저·CSP 무관
      && /__acBotCheck.*sendToHost\("ac-botcheck"/.test(wp)
      && /e\.channel === "ac-botcheck"/.test(webviewFactory)
      && /function botCheckNotice/.test(browserHandoff)
      && /botCheckNotice[\s\S]{0,900}handoffHint/.test(browserHandoff);
  });
  // 하위 프레임 실패로 Chrome 창이 튀어나오면 사람이 하려던 일과 무관한 방해가 된다.
  check("하위 프레임 실패로는 넘기지 않는다", () => {
    // 파일 끝까지 검사하면 뒤에 있는 등록 코드(initCapability)의 handoffToChrome 까지 세어 잘못된 실패가 된다.
    const seg = sliceBetween(browserHandoff, "function botCheckNotice", "export function initCapability", "하위 프레임 실패로는 넘기지 않는다");
    return /if \(!m\.top\) return;/.test(seg)
      // 창은 열지 않고 알림만 낸다.
      && /handoffHint\(rec,/.test(seg) && !/handoffToChrome\(/.test(seg);
  });
}

console.log("[2o] 단축키 우선순위 — 콘솔 전역 이동이 편집기보다 앞선다");
// 편집기(Monaco)는 ⌥⇧+화살표를 줄 복사·선택 확장에 쓰면서 전파를 끊는다. 버블 단계 핸들러는
// 편집기에 포커스가 있으면 호출되지 않으므로, 캡처 단계에서 먼저 처리한다.
check("⌥⇧+화살표는 캡처 단계에서 잡는다", () => {
  const i = keynav.indexOf("// ⌥⇧+화살표는 캡처 단계에서 먼저 처리한다");
  if (i < 0) return false;
  const end = keynav.indexOf("// F12 = 브라우저 탭 개발자 도구", i);
  const seg = end > i ? keynav.slice(i, end) : "";
  return /addEventListener\("keydown"[\s\S]*?\}, true\);/.test(seg)
    && /e\.stopPropagation\(\)/.test(seg)
    && /cycleSpace\(/.test(seg) && /cycleCenterTab\(/.test(seg);
});
// 같은 조합을 두 곳에서 처리하면 한쪽만 고쳤을 때 동작이 갈리므로, 소유자는 하나여야 한다.
check("⌥⇧ 처리는 한 곳에만", () => (keynav.match(/else if \(e\.shiftKey\) cycleSpace/g) || []).length === 0);
// ⌥ 단독(에이전트·탭 이동)은 편집기의 단어 이동을 뺏지 않도록 버블에 남긴다.
check("⌥ 단독은 캡처로 올리지 않는다", () => {
  const i = keynav.indexOf("// ⌥ 단독·⌘⌥ 조합");
  return i > 0 && !/\}, true\);/.test(keynav.slice(i, i + 700));
});

}
