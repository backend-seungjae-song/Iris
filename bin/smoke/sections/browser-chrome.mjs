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
