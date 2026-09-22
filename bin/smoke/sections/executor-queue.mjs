// 소유 범위: 실행기 큐. 한 탭이 멈춰도 다른 탭은 계속 동작한다.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사·파일 도구, sources 의 공유 소스, Node 파일·경로 API.
// 유지 조건: 검사 이름과 본문. 20-browser-contracts.mjs 를 기능별로 분리한 파일이고,
//   분리하면서 본문을 바꾸지 않았다. 원본 대비 바이트 대조가 그것을 보장한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부르며 sources 의 공유 상수 계약도 함께 본다.
//   현재 목록 확인: node bin/importers.mjs bin/smoke/sections/executor-queue.mjs
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
console.log("[2i] 실행기 큐 — 한 탭이 멈춰도 다른 탭은 산다");
const cdpC = read("native/electron/cdp-control.cjs");
// 전역 큐 하나를 공유하면 한 탭의 끝나지 않는 CDP 호출이 모든 탭의 명령을 막는다. 호출자에게는
// 서버의 30초 타임아웃으로만 보여 "전송 문제"로 오진되기 쉽다(확인 결과: @t15 wedge → 무관한 @t11 30s).
check("큐는 탭마다 따로", () =>
  /const cdpQueues = new Map\(\)/.test(cdpC) && !/let cdpQueue = Promise\.resolve\(\)/.test(cdpC)
  && /const prev = cdpQueues\.get\(key\) \|\| Promise\.resolve\(\)/.test(cdpC));
check("명령 단위 타임아웃이 서버보다 짧음", () => {
  const m = cdpC.match(/const CMD_TIMEOUT_MS = (\d+)/);
  const srvMs = (readAll("server").match(/resolve\(\{ ok: false, error: "timeout\(30s\)" \}\); \}, (\d+)\)/) || [])[1];
  return !!m && Number(m[1]) < Number(srvMs || 30000); // 이유 있는 오류가 먼저 도착해야 한다
});
check("멈춘 탭이 큐를 영구히 물지 않음", () => /withCmdTimeout\(execWithReattach\(/.test(cdpC));
// 세션이 끊긴 것은 실패가 아니라 상태이고, 다시 붙이면 이어갈 수 있다. 그대로 두면 그 탭을 쓸 수 없다.
check("끊긴 디버거 세션은 한 번 다시 붙인다", () => /const DEAD_SESSION_RE =/.test(cdpC)
  && /resetCdpSession\(wc\);\n    return await cdpExecRaw/.test(cdpC));
check("물린 캡처는 세션을 끊어준다", () => /resetCdpSession\(wc\); via = "capturePage"/.test(cdpCmdCaptureSource));
check("그리기가 끝난 뒤 찍는다", () => /async function waitRenderIdle/.test(cdpCaptureToolsSource)
  && /await waitRenderIdle\(send, args\.settle\)/.test(cdpCmdCaptureSource));
check("확대는 원래대로 되돌린다", () => /const zoom = await readZoom\(send\)/.test(cdpCmdCaptureSource)
  && /if \(zoom\.on\) await setZoom\(send, zoom\)/.test(cdpCmdCaptureSource) && /zoomRestored/.test(cdpCmdCaptureSource));
check("타임아웃 사유를 사실로 알려줌(대화상자 추적)", () =>
  /buf\.dialogOpen = item/.test(cdpObservationSource) && /function dialogOpen/.test(cdpObservationSource)
  && /Page\.javascriptDialogClosed/.test(cdpSessionSource) && /observation\.openDialog\(wc\.id/.test(cdpSessionSource)
  && /const open = observation\.dialogOpen\(wcId\)/.test(cdpC) && /다른 탭은 영향받지 않습니다/.test(cdpC));
check("큐 맵이 탭과 함께 정리됨", () => /if \(cdpQueues\.get\(key\) === tail\) cdpQueues\.delete\(key\)/.test(cdpC));

}
