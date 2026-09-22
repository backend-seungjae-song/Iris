// 소유 범위: server/browser-state.js 의 상태 모델 계약. 무엇이 저장되고 무엇이 저장되지 않는가.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사·파일 도구, sources 의 공유 소스, Node 파일·경로 API.
// 유지 조건: 검사 이름과 본문. 20-browser-contracts.mjs 를 기능별로 나눈 것이므로
//   본문은 그대로 유지하며, 원본 대비 바이트 대조가 이를 강제한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부르며 sources 의 공유 상수 계약도 함께 본다.
//   지금 목록은 이걸로 센다: node bin/importers.mjs bin/smoke/sections/browser-state-model.mjs
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
console.log("[2b] 브라우저 상태 모델 계약");
const bstate = read("server/browser-state.js");
check("탭 프로필은 안정 id로 정규화", () => /function profileIdFromMutation/.test(bstate));
check("미지정 새 탭은 그때의 스페이스 기본을 풀어서 적는다", () =>
  /let profile = resolveSpaceDefault\(sp\);/.test(bstate)
  && /function resolveSpaceDefault\(sp\)/.test(bstate)
  // 목록에 없는 계정을 가리키는 기본값은 기본 세션으로 둔다. 그 참조를 그대로 적으면 빈 파티션이 생긴다.
  && /\(state\.profiles \|\| \[\]\)\.some\(\(p\) => p && p\.id === id\) \? id : ""/.test(bstate));
check("이미 있던 탭도 불러올 때 한 번 적어 준다", () =>
  /if \(!tab \|\| tab\.profile != null\) continue;/.test(bstate)
  && /tab\.profile = resolveSpaceDefault\(sp\);/.test(bstate));
check("표시 이름을 프로필 값으로 저장하지 않음", () => !/m\.profile \|\| "기본"/.test(bstate));
check("탭 그룹(폴더) op 존재", () => /case "group\.create"/.test(bstate) && /case "tab\.group"/.test(bstate));
check("저장된 그룹 op 존재", () => /case "group\.save"/.test(bstate) && /savedGroups/.test(bstate));

}
