// 소유 범위: 고정 탭 사망 · 요소 선택 단일화 · 로컬 데브 · 터미널 링크.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사·파일 도구, sources 의 공유 소스, Node 파일·경로 API.
// 유지 조건: 검사 이름과 본문. 20-browser-contracts.mjs 를 기능별로 분리한 것이고,
//   분리하면서 본문을 바꾸지 않았고, 원본 대비 바이트 대조로 이를 강제한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부르며 sources 의 공유 상수 계약도 함께 본다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs bin/smoke/sections/tab-death-and-links.mjs
import { existsSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { homedir, tmpdir } from "node:os";

import { check, checkAsync, fnBody, read, readAll, require_, ROOT, sourceFiles } from "../core.mjs";
import {
  aiTabs, allCss, allServer, allWebJs, archive, bookmarks, browserCommands, browserHandoff, browserMessages, browserRuntime, browserState, browserStateOwner, browserWindowManagerSource, cdpCaptureToolsSource, cdpCmdCaptureSource, cdpCmdNativeSource, cdpObservationSource, cdpSessionSource, centerTabs, chromeHandoffIpcSource, css, dock, downloadHookSource, fileRouting, fsIpcSource, herdrSync, httpHandler, localdev, main, mainJs, mainWindowSource, mcp, memoWindow, memoWindowManagerSource, pick, profileSessionPolicySource, profiles, rail, record, screenMarkup, terminalPanel, textEditor, touchDragPanel, web, webview, webviewFactory, webviewLifecycleSource, webviewStore, xtermWiring,
} from "../sources.mjs";
import { sliceBetween, sliceFrom } from "../../slice-anchor.mjs";

export default async function run() {
console.log("[2g] 고정 탭 사망 · 요소 선택 단일화 · 로컬 데브 · 터미널 링크");
const srvG = read("server/index.js");
// 고정 탭이 닫히면 AI가 판단할 여지를 남기지 않는다. 해제는 서버가 하고, 남은 탭을 함께 반환한다.
check("고정 탭 사망은 자동 해제 + 사유 전달", () => {
  const seg = sliceBetween(browserRuntime, "function goneReply", "function resolveTarget", "고정 탭 사망은 자동 해제 + 사유 전달");
  return /탭 제거로 인한 해제/.test(seg) && /reason: deadTab \? "target-gone"/.test(seg) && /untargeted:/.test(seg);
});
check("해제 후 남은 탭만 돌려줌(없으면 사용자에게)", () => {
  const seg = sliceBetween(browserRuntime, "function goneReply", "function resolveTarget", "해제 후 남은 탭만 돌려줌(없으면 사용자에게)");
  return /left\.map\(tabBrief\)/.test(seg) && /사용자에게 물어보세요/.test(seg);
});
check("목록과 안내가 같은 가시성 정의를 씀", () => {
  // 두 곳이 갈리면 "목록엔 있는데 못 쓰는 탭"이 생긴다.
  const n = (allServer.match(/visibleTabsFor\(/g) || []).length;
  return /function visibleTabsFor/.test(browserRuntime) && n === 3; // 정의 + tabs 명령 + goneReply
});
check("--tab 이 죽은 탭이어도 남은 탭 안내", () => /if \(!hasTab\(want\)\) \{ const r = goneReply/.test(browserCommands));
// 요소 선택 모드가 창마다 갈려 상태가 어긋나던 문제는, 상태를 서버 한 곳으로 옮겨 막는다.
// 요소를 고르는 것과 탭을 지목하는 것은 다른 행위다. 같은 경로로 처리하면 요소를 고를 때마다
// 제어 대상이 그 탭으로 넘어가고 지목 알림이 한 벌 더 붙는다.
// 지목은 한 대화 안에서만 누적된다. 그렇지 않으면 이전 지목까지 따라와 대상이 늘어나고,
// 두 번째 알림이 첫 번째와 모순된다("이 탭에서 실행됩니다"가 둘 다 참일 수 없다).
check("지목은 한 얘기 안에서만 쌓인다", () =>
  /const chatTabs = new Map\(\)/.test(browserRuntime) && /const designedThisChat = new Set\(\)/.test(browserRuntime)
  && /function designateTab/.test(browserRuntime)
  && /userGrantTabs\.set\(key, new Set\(chatTabs\.get\(key\) \|\| \[\]\)\)/.test(browserRuntime)  // 첫 지목에서 지난 것 정리
  && /msg\.type === "chat-submitted"/.test(browserMessages) && /endChat\(msg\.pane\)/.test(browserMessages)
  && /wsSend\(\{ type: "chat-submitted", pane: curTarget \}\)/.test(xtermWiring)         // 제출이 경계다
  && !/groupGrants\.delete/.test(sliceBetween(browserRuntime, "function designateTab", "function endChat", "지목은 한 얘기 안에서만 쌓인다")));  // 그룹 권한은 안 건드린다
check("그룹 지목도 한 얘기 안에서만 쌓인다", () =>
  /function designateGroup/.test(browserRuntime)
  && /groupGrants\.set\(key, new Set\(chatGroups\.get\(key\) \|\| \[\]\)\)/.test(browserRuntime)
  && /designateGroup\(msg\.pane, msg\.space, msg\.group\)/.test(browserMessages)
  && /chatGroups\.delete\(key\); designedGroupsThisChat\.delete\(key\)/.test(browserRuntime));  // 제출로 함께 닫힌다
check("요소 선택은 탭을 넘겨받지 않는다", () =>
  /const byPick = msg && msg\.via === "pick"/.test(browserMessages)
  && /else \{ designateTab\(msg\.pane, pickedId\); addPin\(msg\.pane, pickedId\)/.test(browserMessages)  // 고정·지목은 직접 지목했을 때만
  && /if \(byPick\) \{ noteChatTab\(msg\.pane, pickedId\); grantTab/.test(browserMessages)      // 선택은 권한만 더한다
  && /if \(!byPick\) \{[\s\S]{0,400}?type: "tab-granted"/.test(browserMessages)  // 지목 알림도 그때만
  && /via: "pick"/.test(pick));                             // 선택 경로가 스스로 그렇게 밝힌다
check("요소 선택 상태의 진실 소스는 서버 하나", () =>
  /let pickModeOn = false/.test(browserRuntime) && /function setPickModeState/.test(browserRuntime)
  && /broadcast\(\{ type: "pick-mode", on: pickModeOn \}\)/.test(browserRuntime));
check("창은 스스로 뒤집지 않고 요청만 함", () => {
  const flips = (pick.match(/pickMode = !pickMode|setPickMode\(!pickMode\)/g) || []).length;
  return flips === 0 && /function togglePickMode\(\) \{ wsSend\(\{ type: "pick-mode", op: "toggle" \}\)/.test(pick)
    && !/pick-toggle-relay/.test(pick) && !/pick-toggle-relay/.test(srvG);
});
check("모든 창이 방송 하나를 그대로 적용", () =>
  // 그 소유자는 main 에서 요소 지목·녹화 모듈로 분리됐다.
  /"pick-mode": \(m\) => applyPickMode\(!!m\.on\)/.test(read("web/js/browser/pick-boot.js"))
  && /type: "pick-mode", on: getPickMode\(\) \}\)\); \/\/ 뒤늦게/.test(srvG));
check("끌 때 비활성 탭도 함께 해제", () => /for \(const id of getWebviewIds\(\)\)[\s\S]{0,120}setOrca\(rec\.el, pickMode\)/.test(pick));
// 로컬 데브는 사용자의 기존 시스템을 감싸기만 하고, 별도 대시보드를 만들지 않는다.
check("로컬 데브는 rail 메뉴 + 원본 임베드", () =>
  // 패널 외곽(class="rail-panel ld-panel")은 rail 이 표를 보고 그린다. 여기서는 그
  // 기능이 패널 내부를 구성하는지만 검사한다. 외곽은 tool-screens 가 한 곳에서 검사한다.
  /data-rail="localdev"/.test(web) && /id="ld-err"/.test(screenMarkup)
  && /const LD_URL = "http:\/\/localdev\.test\/"/.test(localdev));
check("localdev 원본 주소로 띄움(Origin 고정 때문)", () => {
  // 컨트롤 서버가 ALLOWED_ORIGIN=http://localdev.test 라 127.0.0.1:4599로 띄우면 조작 버튼이 403.
  const seg = sliceFrom(localdev, "async function ldEnsure", 1400, "localdev 원본 주소로 띄움(Origin 고정 때문)");
  return /createElement\("webview"\)/.test(seg) && /setAttribute\("src", LD_URL\)/.test(seg) && !/4599/.test(localdev);
});
check("로컬 데브 상태 UI를 우리가 재구현하지 않음", () =>
  !/ld-route|ldRoutes|api\/state/.test(web + localdev)); // 목록·시작·정지는 전부 원본 대시보드 몫
// 채팅 링크: xterm 기본 동작은 confirm 팝업 뒤 외부 브라우저로 여는 것이다.
check("터미널 링크는 확인 팝업 없이 스페이스 탭에서", () =>
  /activate: \(ev, uri\) => \{[^}]*openTerminalLink\(uri, ev\)/.test(xtermWiring)
  && /function openTerminalLink/.test(fileRouting) && /function openInSpaceBrowser/.test(fileRouting));
// 채팅의 md 링크는 화면에 `[라벨](url)` 로 표시되지 않는다. Claude Code가 OSC 8로 변환해 표시되는 글자는
// 라벨뿐이고 URL은 이스케이프 안에 있다(확인 결과: 화면 텍스트 "Task.md", 셀 urlId 유지). 그리고 xterm은
// 이 옵션 없이는 http(s)가 아닌 OSC 8 링크를 링크로 내주지 않아 클릭 자체가 성립하지 않는다.
// 이 옵션을 제거하면 링크 전체가 동작하지 않으므로 계약으로 강제한다.
check("file: OSC 8 링크가 링크로 성립함(allowNonHttpProtocols)", () => {
  const seg = sliceFrom(xtermWiring, "linkHandler: {", 400, "file: OSC 8 링크가 링크로 성립함(allowNonHttpProtocols)");
  const vendor = read("web/vendor/xterm.js");
  // vendor가 이 옵션으로 분기하는지도 함께 확인한다. 옵션 이름이 바뀌면 계약이 무의미해진다.
  return /allowNonHttpProtocols: true/.test(seg) && /allowNonHttpProtocols/.test(vendor)
    && /\["http:","https:"\]\.includes/.test(vendor);
});
check("OSC 8 링크도 ⌘⇧ = Finder 규칙을 따름", () => {
  const seg = sliceFrom(fileRouting, "function openTerminalLink", fileRouting.length, "OSC 8 링크도 ⌘⇧ = Finder 규칙을 따름");
  return /if \(wantsReveal\(ev\)\)/.test(seg);
});
// 두 파일만 확인하면 세 번째 파일에 남은 프로브를 놓치므로, 존재 검사는 전부를 대상으로 한다.
check("진단 프로브가 남아 있지 않음", () => !/TERMDUMP/.test(web + allWebJs));
check("HTML·SVG·PDF는 에디터가 아니라 브라우저로", () => {
  // 절대 경로 클릭이 에디터로만 열리고 cwd 경계 밖에서는 반응하지 않던 문제를 막는다.
  const seg = sliceFrom(fileRouting, "function openTerminalPath", 1600, "HTML·SVG·PDF는 에디터가 아니라 브라우저로");
  return /const WEB_DOC_RE = /.test(fileRouting)
    && /if \(WEB_DOC_RE\.test\(p\)\) \{ openInSpaceBrowser\(fileUrlOf\(p\)\); return; \}/.test(seg)
    && seg.indexOf("WEB_DOC_RE.test(p)") < seg.indexOf("const roots"); // 경계 검사보다 앞에 와야 한다
});
check("file: 링크도 문서면 브라우저·아니면 에디터", () => {
  const seg = sliceFrom(fileRouting, "function openTerminalLink", fileRouting.length, "file: 링크도 문서면 브라우저·아니면 에디터");
  return /file:/.test(seg) && /openTerminalPath\(p\)/.test(seg) && /if \(!p\.startsWith\("\/"\)\) return/.test(seg);
});

}
