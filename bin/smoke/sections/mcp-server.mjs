// 소유 범위: bin/iris-mcp.mjs 의 stdio JSON-RPC 계약. stdout 전용, pane 복구, 루프백 고정, 도구 스키마.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사·파일 도구, sources 의 공유 소스, Node 파일·경로 API.
// 유지 조건: 검사 이름과 본문. 20-browser-contracts.mjs 를 기능별로 분리한 것이고,
//   분리하면서 본문을 바꾸지 않았고, 원본 대비 바이트 대조로 이를 강제한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부르며 sources 의 공유 상수 계약도 함께 본다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs bin/smoke/sections/mcp-server.mjs
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
  const { chooseHerdrPane } = await import("../../iris-mcp.mjs");
console.log("[2d] MCP 서버 계약");
check("stdio JSON-RPC 핸들러(initialize·tools/list·tools/call)", () =>
  ["initialize", "tools/list", "tools/call"].every((m) => mcp.includes(`"${m}"`)));
check("stdout은 JSON-RPC 전용 — 로그는 stderr", () => /process\.stderr\.write/.test(mcp) && !/console\.log/.test(mcp));
check("CLI와 같은 경로(/browser-cmd)·같은 세션 식별", () =>
  /path: "\/browser-cmd"/.test(mcp) && /HERDR_PANE_ID/.test(mcp) && /currentSession\(\)/.test(mcp));
check("MCP 환경에서 pane 값이 빠지면 호출 프로세스로 복구", () =>
  /pane\.process_info/.test(mcp) && /processAncestry\(\)/.test(mcp) && /chooseHerdrPane\(/.test(mcp));
check("프로세스 기반 pane 복구는 가장 가까운 유일 일치만 허용", () => {
  const agents = [{ pane_id: "w1:p1" }, { pane_id: "w2:p1" }];
  const infos = [
    { process_info: { shell_pid: 10, foreground_processes: [{ pid: 100 }] } },
    { process_info: { shell_pid: 20, foreground_processes: [{ pid: 200 }] } },
  ];
  return chooseHerdrPane(agents, infos, [999, 200, 100, 10]) === "w2:p1"
    && chooseHerdrPane(agents, [infos[1], infos[1]], [999, 200]) === null
    && chooseHerdrPane(agents, infos, [999, 888]) === null;
});
check("루프백 고정(새 권한을 열지 않음)", () => /host: "127\.0\.0\.1"/.test(mcp) && !/0\.0\.0\.0/.test(mcp));
check("stdin 종료 시 진행 중 호출을 잘라먹지 않음", () => /inFlight/.test(mcp) && /closing/.test(mcp));
check("모든 도구가 이름·설명·object 스키마를 가짐", () => {
  const names = [...mcp.matchAll(/name: "(browser_[a-z_]+)"/g)].map((m) => m[1]);
  return names.length >= 15 && new Set(names).size === names.length;
});

}
