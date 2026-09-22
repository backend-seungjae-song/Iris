// 소유 범위: 스페이스 격리 계약. 세션(pane)→스페이스 해석과 자기 그룹 밖으로 나가지 않는 대상 선택.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사·파일 도구, sources 의 공유 소스, Node 파일·경로 API.
// 유지 조건: 검사 이름과 본문. 20-browser-contracts.mjs 를 기능별로 분리한 것이고,
//   분리하면서 본문을 바꾸지 않았고, 원본 대비 바이트 대조로 이를 강제한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부르며 sources 의 공유 상수 계약도 함께 본다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs bin/smoke/sections/space-isolation.mjs
import { existsSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { homedir, tmpdir } from "node:os";

import { check, checkAsync, fnBody, read, readAll, require_, ROOT, sourceFiles } from "../core.mjs";
import {
  aiTabs, allCss, allServer, allWebJs, archive, bookmarks, browserCommands, browserHandoff,
  browserMessages, browserHandles, browserRuntime, browserState, browserStateOwner, browserWindowManagerSource,
  cdpCaptureToolsSource, cdpCmdCaptureSource, cdpCmdNativeSource, cdpObservationSource,
  cdpSessionSource, centerTabs, chromeHandoffIpcSource, css, dock, downloadHookSource,
  fileRouting, fsIpcSource, herdrSync, httpHandler, localdev, main, mainJs, mainWindowSource,
  mcp, memoWindow, memoWindowManagerSource, pick, profileSessionPolicySource, profiles, rail,
  record, xtermWiring, terminalPanel, textEditor, touchDragPanel, web, webview,
  webviewFactory, webviewLifecycleSource, webviewStore,
} from "../sources.mjs";
import { sliceBetween, sliceFrom } from "../../slice-anchor.mjs";

export default async function run() {
console.log("[2e] 스페이스 격리 계약");
// AI 제어가 자기 스페이스를 넘지 않는 것이 핵심 불변식이다. 확인 결과 pane w3:pS가 다른 스페이스 탭 16개와
// 공유 창 탭 3개를 모두 조회·조작할 수 있었다. 그 상태로 돌아가지 않도록 계약으로 강제한다.
check("세션(pane)→스페이스 해석이 존재", () => /const spaceByPane = new Map\(\)/.test(browserRuntime) && /agent\.pane_id && agent\.workspace_id/.test(browserRuntime));
// 고정이 없을 때 "그 스페이스의 활성 탭"을 고르면, 스페이스 안이더라도 사용자가 보고 있는
// 탭을 따라가 지목한 적 없는 탭이 조작된다. 그래서 경계는 스페이스가 아니라 그룹이다.
check("고정 전 대상도 자기 그룹 안에서만", () => {
  const seg = sliceFrom(browserRuntime, "function resolveTarget", 1600, "고정 전 대상도 자기 그룹 안에서만");
  return /sessionSpace\(session\)/.test(seg)
    && /sessionGroupId\(session\)/.test(seg)
    && /groupTabIds\(mine, gid\)/.test(seg)
    && !/activeWcBySpace\.get\(mine\)/.test(seg);
});
check("공유 창은 지목 없이 접근 불가", () => /meta\.space === SHARED_SPACE/.test(browserRuntime) && /if \(grantedByTabId\(session, tabId\)\) return \{ ok: true \}/.test(browserRuntime));
check("사용자 지목(UI 픽)만 경계를 넘는 통로", () => {
  const seg = sliceFrom(browserMessages, '"browser-target-set"', 1400, "사용자 지목(UI 픽)만 경계를 넘는 통로");
  // 지목 기록은 이 로컬 경로에서만 일어나야 한다. AI 명령 경로에 grantTab이 있으면 스스로 권한을 만든다.
  const grantCalls = (allServer.match(/grantTab\(/g) || []).length;
  // 정의 1 + designateTab 안 1 + 선택 경로 1. designateTab도 이 로컬 경로에서만 불린다.
  const designCalls = (allServer.match(/designateTab\(/g) || []).length;
  return /grantTab\(/.test(seg) && /ws\._local/.test(seg) && grantCalls === 3
    && designCalls === 2 && /designateTab\(msg\.pane/.test(seg);
});
check("tabs 목록도 그룹으로 걸러짐", () => {
  const seg = sliceBetween(browserRuntime, "function visibleTabsFor", "function tabBrief", "tabs 목록도 그룹으로 걸러짐");
  // "공유만 아니면 전부"로 완화되면 안 된다. 그것이 다른 스페이스 탭 14개가 모두 보이던 원인이다.
  // 이제 스페이스도 충분치 않다: 세션을 모르거나 그 그룹이 아니면 지목받은 것 말고는 안 보인다.
  return /spaceKey\.sameStorageSpace\(t\.space, mine\)/.test(seg) && !/t\.space !== SHARED_SPACE/.test(seg)
    && /grantedByTabId\(session, t\.tabId\)/.test(seg) && /const visible = visibleTabsFor\(session\)/.test(browserCommands);
});
check("같은 프로젝트의 runtime workspace를 MCP 경계에서 임의로 하나만 고르지 않음", () => {
  const allowed = sliceBetween(browserRuntime, "function tabAllowed", "function visibleTabsFor", "같은 프로젝트의 runtime workspace를 MCP 경계에서 임의로 하나만 고르지 않음");
  return /spaceKey\.sameStorageSpace\(meta\.space, mine\)/.test(allowed)
    && /controlOwnerOf\(mine, tabId\)/.test(allowed)
    && /spaceKey\.sameStorageSpace\(a\.space, sessionSpace\(session\)\)/.test(browserRuntime)
    && /spaceKey\.sameStorageSpace\(meta\.space, sessionSpace\(session\)\)/.test(browserCommands)
    && /spaceKey\.sameStorageSpace\(wmeta\.space, sessionSpace\(session\)\)/.test(browserCommands)
    && /spaceKey\.sameStorageSpace\(\(tabMeta\(id\) \|\| \{\}\)\.space, tg\.space\)/.test(browserCommands)
    && /function groupGranted[\s\S]{0,500}spaceKey\.sameStorageSpace/.test(browserRuntime);
});
check("사람이 고른 runtime workspace는 같은 프로젝트의 첫 항목으로 되돌아가지 않음", () =>
  /let lastActiveWorkspaceId = null/.test(browserStateOwner)
  && /const runtimeChanged = mutation\?\.op === "space\.active"/.test(browserStateOwner)
  && /return runtimeChanged \|\| persistedChanged/.test(browserStateOwner)
  && /idOfKey\(out\.activeSpace,[^)]*lastActiveWorkspaceId\)/s.test(browserStateOwner));
// 세션 식별자가 없는 호출자(herdr pane 밖에서 실행된 MCP)는 이전에 콘솔 창이 보고 있는
// 스페이스의 활성 탭을 받았다. 그래서 지정한 적 없는 탭에서 명령이 실행되고, 스페이스를 옮기면
// 대상도 따라 옮겨갔다. 이제는 아무 탭도 고르지 않는다.
check("세션을 모르면 대상을 고르지 않는다", () => {
  const seg = sliceBetween(browserRuntime, "function resolveTarget", "let pickModeOn", "세션을 모르면 대상을 고르지 않는다");
  return /noSession: true/.test(seg) && !/browserState\.get\(\)\.activeSpace/.test(seg)
    && !/activeWcBySpace\.get\(sp\)/.test(seg);
});
check("거부 사유가 무엇을 하면 풀리는지까지 말해준다", () =>
  /tg\.noSession/.test(browserCommands) && /IRIS_SESSION/.test(browserCommands));
// wc 번호는 회수 후 다른 탭에 재발급된다. 그래서 고정은 wc를 보관하지 않고 식별자만 남긴다.
// 명령을 보내기 직전에 한 번 핸들로 변환한다. 식별자는 재발급되지 않는다.
check("고정은 정체성만 들고 있다", () =>
  /const tabId = session \? primaryPin\(session\) : null;/.test(browserRuntime)
  && /if \(tabReg\.has\(tabId\)\) return \{ tabId, pinned: true \}/.test(browserRuntime)
  && !/targetByPane/.test(allServer));
// 핸들이 메모리 순번이면 서버가 재시작할 때 @t2가 다른 탭을 가리킨다(확인 결과).
check("핸들은 서버 재시작을 견딘다", () =>
  /tab-handles\.json/.test(browserHandles) && /function persistHandles/.test(browserHandles)
  && /for \(const \[tabId, r\] of saved\.recs \|\| \[\]\)/.test(browserHandles)
  && /persistHandles\(\);/.test(sliceFrom(browserHandles, "function handleFor", browserRuntime.length, "핸들은 서버 재시작을 견딘다")));
// 지목은 여러 개 누적돼야 한다. Map<pane,tabId>로 두면 두 번째 지목이 첫 번째를 덮어쓴다.
check("사용자 지목은 누적(여러 탭 동시 사용)", () => /ts\.add\(tabId\)/.test(browserRuntime) && /function grantedByTabId/.test(browserRuntime));
check("명령마다 대상 탭 지정 가능(--tab)", () => {
  const cli = read("bin/iris-browser.mjs"), mcp = read("bin/iris-mcp.mjs");
  return /args\.tab != null \? tabIdOfRef\(args\.tab\)/.test(browserCommands) && /"--tab"/.test(cli) && /TAB_PARAM/.test(mcp);
});
check("--tab도 같은 경계 검사를 통과해야 함", () => {
  const seg = sliceFrom(browserCommands, "const want = args && args.tab", 400, "--tab도 같은 경계 검사를 통과해야 함");
  return /tabAllowed\(session, want\)/.test(seg);
});
check("탭이 닫히면 지목도 정리", () => /for \(const grants of userGrantTabs\.values\(\)\) grants\.delete\(tabId\)/.test(browserRuntime));

}
