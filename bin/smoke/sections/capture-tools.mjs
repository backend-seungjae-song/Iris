// 소유 범위: 안 보이는 탭 폴백·배율 캡처·픽셀 비교·크기별 촬영·접근성 점검, 조작 기록에 값을 담지 않는 규칙.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사·파일 도구, sources 의 공유 소스, Node 파일·경로·모듈 API.
// 유지 조건: 검사 이름과 본문. 40-qa-evidence.mjs 를 기능별로 분리한 파일이므로,
//   본문은 원본과 바이트 단위로 같아야 한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부르며 sources 의 공유 상수 계약도 함께 본다.
//   지금 목록은 이걸로 센다: node bin/importers.mjs bin/smoke/sections/capture-tools.mjs
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
console.log("\n[10i] QA 도구 다섯");
{
  const cdp = read("native/electron/cdp-control.cjs"), inspect = cdpCmdInspectSource, capture = cdpCmdCaptureSource,
        mcp = read("bin/iris-mcp.mjs"), srv = read("server/index.js");
  check("안 보이는 탭 3단 폴백", () => /fromSurface: false/.test(capture) && /cdp-nosurface-slow/.test(capture)
    && /via = "capturePage"/.test(capture));
  check("배율 캡처(zoom 꼼수 불필요)", () => /const dpr = Math\.max\(1, Math\.min\(3/.test(capture)
    && /async function viewportClip/.test(cdpCaptureToolsSource) && /dpr: \{ type: "number"/.test(mcp));
  check("보호된 배경 탭만 계속 돈다", () => /function setReason/.test(webviewThrottleSource)
    && /contents\.setBackgroundThrottling\(!\(reasons && reasons\.size\)\)/.test(webviewThrottleSource)
    && /setThrottleReason\(guest, "capture", true\)/.test(main));
  check("판정과 증거는 같은 순간", () => /async expect\(send, wc, args\)/.test(inspect) && /name: "browser_expect"/.test(mcp)
    && /cdpExecRaw\(webContentsMod\(wc\), wc\.id, "screenshot"/.test(inspect));
  check("픽셀 비교", () => /function diffPng/.test(cdpCaptureToolsSource) && /nativeImage\.createFromBitmap/.test(cdpCaptureToolsSource)
    && /name: "browser_diff"/.test(mcp));
  check("크기별 촬영 후 원복", () => /async shotsizes\(_send, wc, args\)/.test(capture)
    && /deviceEmulation\.apply\(wc, \{ clear: true \}\)/.test(capture)   // 다른 탭의 크기를 바꾼 채로 끝내지 않는다
    && /name: "browser_shot_sizes"/.test(mcp));
  check("접근성 점검", () => /async a11y\(send\)/.test(inspect) && /라벨 없는 입력칸/.test(inspect) && /name: "browser_a11y_check"/.test(mcp));
  check("조작 기록은 값을 안 담는다", () => {
    const qaJournal = read("server/qa-journal.js");
    return /function noteTrace/.test(qaJournal) && /자 입력/.test(qaJournal)
      && !/text: String\(a\.text\)[^)]*\)\s*\}\);\s*\/\/ trace/.test(qaJournal) && /name: "browser_trace"/.test(mcp);
  });
}

// [10k] 안 보이는 탭도 "조작" 대상
// 캡처만 되는 것으로는 부족하다. 사람이 다른 탭을 보고 있으면 그 webview 는 (1) 문서 포커스를 잃어 키·텍스트
// 입력이 버려지고 (2) 뷰포트가 0x0 이라 반응형 레이아웃이 깨진다. 두 경우 모두 ok 를 반환하면서 실제로는
// 아무 일도 하지 않는다(확인 결과: fill 이 ok 인데 값이 비고, key 가 ok 인데 keydown 이 없음).
}
