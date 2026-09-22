// 소유 범위: 서버·렌더러·실행기의 hb/ping, 침묵 시 자기 절단, 읽기 명령만 재시도.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사·파일 도구, sources 의 공유 소스, Node 파일·경로·모듈 API.
// 유지 조건: 검사 이름과 본문. 40-qa-evidence.mjs 를 기능별로 분리한 것이고,
//   분리하면서 본문을 바꾸지 않았고, 원본 대비 바이트 대조로 이를 강제한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부르며 sources 의 공유 상수 계약도 함께 본다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs bin/smoke/sections/ws-liveness.mjs
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
console.log("\n[10g] 연결이 조용히 죽지 않는다");
check("서버가 hb와 ping을 보낸다", () => {
  const t = read("server/ws-transport.js"); // 하트비트를 담당하는 계층은 전송 계층이다
  return /type: "hb"/.test(t) && /ws\.ping\(\)/.test(t) && /ws\._alive === false.*terminate/s.test(t);
});
check("렌더러는 침묵하면 스스로 끊는다", () => /socket\._lastMsg = Date\.now\(\)/.test(wsCore)
  && /Date\.now\(\) - socket\._lastMsg > 25000/.test(wsCore) && /"hb": dispatchWs\(ignoreWsMessage\)/.test(mainJs));
check("실행기도 침묵하면 스스로 끊는다", () => {
  return /now\(\) - lastMsg > 25000/.test(cdpTransportSource) && /sock\.terminate\(\)/.test(cdpTransportSource);
});
check("실행기가 끊기면 대기 명령을 즉시 깨운다", () => {
  const at = browserRuntime.indexOf("function disconnectCdpExecutor");
  return /for \(const \[id, pending\] of cdpPending\)/.test(browserRuntime.slice(at, at + 1200));
});
// 일시적 단절은 곧 복구되므로 한 번 실패로 끝내지 않는다. 단, 이미 전송한 명령을 다시 보내면 두 번 실행된다.
check("실패는 텀을 두고 5회까지 다시 시도", () => /const RETRY_DELAYS = \[700, 1200, 2000, 3000\]/.test(browserCommands)
  && /runBrowserCmdResilient\(String\(j\.cmd/.test(httpHandler));
check("보낸 뒤 답 없는 것은 읽기 명령만 재시도", () => /const READONLY_CMDS = new Set\(/.test(browserCommands)
  && /const retryable = notSent \|\| \(sentUnknown && READONLY_CMDS\.has\(cmd\)\);/.test(browserCommands));

// [10h] 스크린샷은 증거가 된다
// 폴더에 흩어진 PNG는 사용자가 열어보지 않는다. 확인할 위치에 표시를 얹고 한 장으로 묶어야 판단에 쓸 수 있다.
}
