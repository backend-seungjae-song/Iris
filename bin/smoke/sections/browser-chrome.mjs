// 소유 범위: 분리 창 탭바·조작 중 글로우·자동완성 차단·단일 인스턴스 잠금·편집기 호스트 부착.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사·파일 도구, sources 의 공유 소스, Node 파일·경로·모듈 API.
// 유지 조건: 검사 이름과 본문. 40-qa-evidence.mjs 를 기능별로 나눈 것이므로,
//   나누는 동안 본문을 변경하지 않았다. 원본 대비 바이트 대조로 이를 검사한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부르며 sources 의 공유 상수 계약도 함께 본다.
//   지금 목록은 이걸로 센다: node bin/importers.mjs bin/smoke/sections/browser-chrome.mjs
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
console.log("[10d] 콘솔 탭바·알림·AI 글로우");
// renderBmTabs 가 콘솔 창의 #tabstrip 을 덮어쓰면 파일 탭 위치에 브라우저 탭 칩이 렌더된다.
// 그 칩에는 콘솔 쪽 클릭 핸들러가 없어 눌러도 동작하지 않는다.
check("브라우저 탭바는 분리 창 전용", () => /function renderBmTabs\(\)\s*\{[\s\S]{0,600}?if \(!BROWSER_MODE\) \{ renderTabs\(\); return; \}/.test(browserTabs));
// 반대 방향. 표 저장 응답처럼 분리 창에서도 renderTabs 를 부르는 곳이 있다. 그대로 그리면 브라우저 탭 칩이 사라진다.
// 스페이스를 고르기 전에 연 탭은 "_" 아래 저장된다. 그 키를 접은 스페이스로 보면 탭을 만들자마자 재운다.
check("스페이스를 고르기 전에 연 브라우저 탭은 접은 스페이스 탭으로 재우지 않는다", () => {
  const src = read("web/js/browser/webview.js");
  const at = src.indexOf("export function isLiveSpaceKey(");
  const body = src.slice(at, src.indexOf("\n}\n", at) + 3).replace(/^export /, "");
  const live = new Function("getSpaces", `${body}; return isLiveSpaceKey;`)(() => [{ id: "w1" }]);
  const consoleSpace = /export function consoleSpace\(\) \{ return getCenterSpace\(\) \|\| getSelectedSpaceId\(\) \|\| "_"; \}/.test(read("web/js/center/file-routing.js"));
  return consoleSpace && live("_") && live("__shared__") && live("w1") && !live("/some/folder");
});
// 분리 상태에서 탭 없는 창만 열면 주소창 입력이 "브라우저 탭을 먼저 열어주세요"로 끝난다.
check("브라우저 탭 열기는 분리 상태에서도 탭이 없으면 하나 만든다", () => {
  const src = read("web/js/center/file-routing.js");
  const at = src.indexOf("export function openBrowser(");
  const body = src.slice(at, src.indexOf("\n}\n", at) + 3).replace(/^export /, "");
  const run = (docked, tabs) => {
    const calls = [];
    new Function("consoleSpace", "setCenterSpace", "getBrowserState", "bsMutate", "acHost", "newBrowserTab", "window", "$",
      `${body}; openBrowser();`)(
      () => "_", () => {}, () => ({ docked, tabsBySpace: { _: tabs } }), () => {},
      { openBrowser: () => calls.push("window") }, () => calls.push("tab"), { innerWidth: 1400 }, () => null);
    return calls.join(",");
  };
  return run(false, []) === "window,tab" && run(false, [{ id: "t1" }]) === "window" && run(true, []) === "tab" && run(true, [{ id: "t1" }]) === "";
});
// 그룹은 서버 상태가 돌아온 뒤에 생기고 그룹 만들기·탭 넣기가 상태를 따로 보낸다. 바로 열거나 그룹만 생긴
// 렌더에서 열면 칩이 없거나 다음 렌더가 입력칸을 덮어써 이름을 입력할 수 없다.
check("새 그룹 이름 편집은 탭까지 그룹에 들어간 렌더에서 연다", () => {
  const src = read("web/js/browser/tabs.js");
  const make = sliceBetween(src, "function makeGroup(", "function startInlineGroupRename(");
  const render = sliceBetween(src, "export function renderBmTabs(", "function makeGroup(");
  return !/setTimeout\(\(\) => startInlineGroupRename/.test(make) && /pendingGroupRename = \{ gid, ids \}/.test(make)
    && /pend\.ids\.every\(\(id\) => bmTabs\(\)\.some\(\(t\) => t\.id === id && t\.group === pend\.gid\)\)\) \{\s*pendingGroupRename = null; startInlineGroupRename\(pend\.gid\);/.test(render);
});
// 빈 가운데 화면은 메인 창에만 보이고, 메인 창의 ⌘T 는 터미널 탭을 만든다. 그 키를 브라우저 버튼 옆에 적으면
// 안내대로 눌러도 브라우저 탭이 열리지 않는다.
check("빈 가운데 화면의 브라우저 버튼에 터미널 탭 키를 적지 않는다", () => {
  const html = read("web/index.html");
  const btn = (html.match(/<button[^>]*data-empty-act="browser"[\s\S]*?<\/button>/) || [""])[0];
  const mainNewTab = /BROWSER_MODE \? newBrowserTab\(\) : newHerdrTab\(\)/.test(read("web/js/core/keynav.js"));
  return btn !== "" && mainNewTab && !/data-empty-key="new-tab"/.test(btn);
});
// 1180 창에 도킹하면 가운데가 456px 이라 도구 묶음(약 270px)이 주소칸을 0 으로 밀었다.
check("좁은 가운데에서도 주소칸은 최소 폭을 지키고 도구 묶음이 다음 줄로 내려간다", () => {
  const src = read("web/css/18-browser.css");
  const bar = (src.match(/^\.urlbar \{[^}]*\}/m) || [""])[0];
  const wrap = (src.match(/^\.url-wrap \{[^}]*\}/m) || [""])[0];
  const min = Number((wrap.match(/min-width:(\d+)px/) || [])[1] || 0);
  return /flex-wrap:wrap/.test(bar) && min >= 120;
});
check("콘솔 탭바 그리기는 분리 창에서 브라우저 탭바로 넘긴다", () => /export function renderTabs\(\)\s*\{[\s\S]{0,300}?if \(BROWSER_MODE\) \{ renderBmTabs\(\); return; \}/.test(read("web/js/center/tabs.js")));
// 알림의 "그 탭으로"는 스페이스로 이동한 뒤 그 스페이스의 브라우저 탭을 연다.
check("그 탭으로는 스페이스부터", () => /function gotoTabById[\s\S]{0,900}?focusSpace\(sp\)/.test(web)
  && /op: "tab\.switch", space: sp, id: tabId/.test(web));
check("분리돼 있으면 그 창에서 전환", () => /getBrowserState\(\)\.docked === false[\s\S]{0,200}?acHost\.openBrowser/.test(web));
// 파일 탭 우클릭은 트리와 같은 메뉴를 써야 한다. 메뉴를 두 벌 만들면 한쪽만 갱신되어 서로 달라진다.
check("파일 탭 우클릭 = 트리 메뉴 재사용", () => /function openFileCtx\(x, y, absPath, isDir, extra\)/.test(contextMenu)
  && /openFileCtx\(e\.clientX, e\.clientY, t\.path, false, extra\)/.test(tabClose));
check("탭바 우클릭에 닫기 계열", () => /label: "다른 탭 모두 닫기"/.test(tabClose) && /label: "모두 닫기"/.test(tabClose)
  && /function closeAllTabs\(\)/.test(tabClose));
// 함수의 존재만 검사하면 실제 동작을 확인하지 못한다. 메뉴가 같은 처리를 그 자리에서
// 중복 구현하면 이 경고가 한 번도 뜨지 않아도 검사는 통과한다.
// 그래서 메뉴가 그 함수를 호출하는지까지 검사한다.
check("모두 닫기는 미저장 편집을 먼저 알린다", () => /저장하지 않은 편집이 \$\{dirty\.length\}개/.test(tabClose)
  && /label: "모두 닫기", danger: true, act: \(\) => closeAllTabs\(\)/.test(tabClose));
// 글로우는 명령 순간이 아니라 탭을 점유하는 동안 계속 켜진다. 이너 글로우는 그 탭을 보고 있을 때만 켠다.
// 글로우와 ● 표시 기준은 점유 탭이 아니라 조작 중 여부다. 점유는 오래 유지되지만 조작은 끝난다.
// 명령 순간만 켜면 깜박이고, 점유를 기준으로 하면 조작이 끝나도 꺼지지 않는다. 서버가 탭별·세션별로 내려준다.
check("글로우는 조작 중인 탭만", () => /let aiBusyTabs = new Map\(\)/.test(aiState)
  && /setAiBusyTabs\(new Map\(\(m\.tabs \|\| \[\]\)\.map/.test(mainJs) && /busy\.length \? " ai-held"/.test(centerTabs));
check("병렬 세션이 다 보인다", () => /export function aiBusyLabels\(tabId\)/.test(aiState)
  && /●\$\{busy\.length > 1 \? busy\.length : ""\}/.test(centerTabs));
check("이너 글로우는 그 탭에 있을 때만", () => /function syncAiGlow\(\)[\s\S]{0,200}?classList\.toggle\("ai-controlling", !!\(id && aiHolds\(id\)\)\)/.test(browserTabs));
check("control-active는 세기만 올린다", () => /classList\.toggle\("ai-busy", !!m\.active\)/.test(web));
// 글로우 클래스를 보안 판정에 재사용하면 차단 여부가 지금 보고 있는 화면에 따라 달라진다.
check("자동완성 차단은 탭 단위이고 화면 표시와 분리", () =>
  /function autofillBlocked\(tabId\) \{[\s\S]{0,160}getAiBusyTabs\(\)\.has\(tabId\)/.test(webviewFactory)
  && /classList\.contains\("ai-busy"\)/.test(webviewFactory));

// [10e] 앱은 하나만
// 두 번 실행하면 앱 두 개가 각각 직전 창을 복원해 창이 두 배로 늘어난다. 그중 하나는 서버
// 상태를 받지 못해 빈 창으로 남는다. 두 번째 실행은 기존 창을 앞으로 가져오기만 한다.
console.log("\n[10e] 앱은 하나만");
check("단일 인스턴스 잠금", () => /if \(!app\.requestSingleInstanceLock\(\)\) \{ app\.quit\(\); return; \}/.test(main));
check("두 번째 실행은 창을 앞으로", () => /app\.on\("second-instance"[\s\S]{0,260}?w\.focus\(\)/.test(main));

// [10f] 편집기 호스트가 화면을 덮지 않는다
// inset:0 절대배치 요소를 body 에 붙여 두면 창 전체를 덮는다. 파일 뷰로 옮기는 경로를 거치지
// 않고 메모가 Monaco 를 먼저 로드하면 그 요소가 body 에 남아 화면을 가린다.
console.log("\n[10f] 편집기 호스트가 화면을 덮지 않는다");
check("파일 편집기 호스트는 body에 안 붙는다", () => /monacoHost\.id = "editor-host";[\s\S]{0,400}?\n  \}\n  return monacoHost;/.test(textEditor)
  && !/monacoHost\.id = "editor-host";[\s\S]{0,400}?document\.body\.appendChild\(monacoHost\)/.test(textEditor));
check("라이브러리 로드와 파일 편집기 생성 분리", () => /function ensureMonacoLib\(\)/.test(textEditor)
  && /monacoReady = ensureMonacoLib\(\)\.then/.test(textEditor));
check("메모는 라이브러리만 부른다", () => /memoEdReady = ensureMonacoLib\(\)\.then/.test(memoPanel));

// [10g] 연결이 조용히 죽지 않는다
// 소켓은 절전·Wi-Fi 전환·tailnet 불안정으로 half-open 이 된다. close 가 오지 않으면 재연결이 실행되지 않고,
// 끊긴 소켓의 send 는 오류 없이 성공해 명령이 유실된다. OS keepalive(약 2시간)는 너무 늦다.
}
