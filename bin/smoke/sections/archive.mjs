// 소유 범위: server/archive.js 와 web/js/devtool/archive.js 의 되살리기·잊기·그룹·검색·선택.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사·파일 도구, sources 의 공유 소스, Node 파일·경로·모듈 API.
// 유지 조건: 검사 이름과 본문. 40-qa-evidence.mjs 를 기능별로 나눈 것이므로,
//   나누는 동안 본문을 변경하지 않았다. 원본 대비 바이트 대조로 이를 검사한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부르며 sources 의 공유 상수 계약도 함께 본다.
//   지금 목록은 이걸로 센다: node bin/importers.mjs bin/smoke/sections/archive.mjs
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
  console.log("[보관함 — 접어둔 세션을 되살린다]");
check("되살리기·잊기 버튼", () => /data-ar-restore/.test(archive) && /data-ar-forget/.test(archive));
// 스페이스 되살리기는 그 그룹의 세션까지 포함한다. 세션 되살리기는 스페이스가 접혀 있으면 함께 살리고 그 세션만 되살린다.
check("스페이스는 묶음째 되살린다", () => /data-ar-restore-space/.test(archive) && /restoreSpaceGroup/.test(archiveHandlers));
check("세션 하나는 스페이스를 확보한 뒤 그것만", () => /ensureSpace\(e\.spaceCwd \|\| e\.cwd/.test(archiveHandlers) && /reviveAgent\(space\.wsId, space, e\)/.test(archiveHandlers));
// claude 기동이 비동기여서 순차 호출만으로는 부족하다. 간격이 없으면 세션이 한꺼번에 올라온다.
check("여러 개는 텀을 두고 하나씩", () => /REVIVE_GAP_MS/.test(archiveHandlers) && /setTimeout\(r, REVIVE_GAP_MS\)/.test(archiveHandlers));
// tabId 는 탭을 옮겨도 바뀌지 않으므로, id 로 정렬하면 순서를 바꿔도 화면이 원래 배치를 유지한다.
check("에이전트 목록은 실제 탭 순서를 따른다", () => /getTabsForSpace\(id\)\.map\(\(t, i\) => \[t\.tabId, i\]\)/.test(herdrState));
check("진행 상황을 화면에 보낸다", () => /archive-progress/.test(archiveHandlers) && /archive-progress/.test(archive) && /ar-busy/.test(archive));
check("살아난 것부터 목록에서 빠진다", () => /broadcastArchives\(\);\s*\/\/ 복원된 항목부터/.test(archiveHandlers));
check("되살리는 중 중복 클릭 차단", () => /arBusy && e\.target\.closest/.test(archive));
check("잊기는 확인을 거친다", () => /archive\.forget/.test(archive) && /보관함에서 지울까요/.test(archive));
// 평평한 목록은 세션이 어느 스페이스에 속하는지 보여주지 못한다. 그룹으로 묶는 것이 이 화면의 핵심이다.
// 스페이스 전체가 접혔든 세션만 접혔든 같은 스페이스면 한 그룹이므로, 폴더 경로를 그룹 기준으로 쓴다.
check("묶음은 폴더 기준", () => /ar-group/.test(archive) && /ar-kids/.test(archive) && /groups\.set\(cwd/.test(archive));
check("검색이 마지막 화면 내용까지 본다", () => /e\.tail && e\.tail\.toLowerCase\(\)\.includes\(q\)/.test(archive));
check("걸린 자리를 표시한다", () => /<mark>/.test(archive) && /arTailView/.test(archive));
check("미리보기는 기본 세 줄", () => /\.ar-tail \{[^}]*-webkit-line-clamp:3/.test(css("04-archive")));
// 같은 조작이 위치마다 문구나 판정이 다르면 사실상 두 기능이 된다. 한 곳에서 만들어 두 곳이 공유한다.
// 정의는 소유 모듈에 있고 호출 위치는 main 에도 있으므로, 개수는 둘을 합쳐 집계한다.
// 스페이스 접기는 보관 기능의 조작이다. 앱 셸에서 만들면 보관을 꺼도 그 조작이 남아, 끈 기능이
// 화면에서만 사라진다. 그래서 보관이 그 항목을 만들고 앱 셸의 두 위치가 이름으로 받아 간다.
// 소스 형태가 아니라 실제로 연결해 항목을 받아 확인한다. 항목의 문구와 그 항목이 보내는 메시지까지 본다.
await checkAsync("스페이스 접기는 보관 기능이 만든다", async () => {
  const sent = [];
  const prevDoc = globalThis.document;
  globalThis.document = { getElementById: () => null, querySelectorAll: () => [], querySelector: () => null };
  let item;
  try {
    const hooks = await import(new URL("../../../web/js/core/hooks.js", import.meta.url).href);
    const mod = await import(new URL("../../../web/js/devtool/archive.js", import.meta.url).href);
    hooks.clearHooks?.();
    mod.initArchive({
      $: () => null, esc: (t) => t, wsSend: (m) => sent.push(m), showToast() {},
      setPendingSpaceFocus() {}, getIsLocal: () => true,
      getLastAgents: () => [{ workspaceId: "w9", sessionUuid: "u1" }, { workspaceId: "w9" }],
      askConfirm: async () => true,
    });
    item = hooks.callHook("archive.spaceItem", "w9", "일하는 곳");
    if (!item) throw new Error("보관이 접기 항목을 안 내준다");
    if (!/접기/.test(item.label)) throw new Error("항목 문구가 접기가 아니다: " + item.label);
    await item.act();
  } finally { globalThis.document = prevDoc; }
  if (sent.length !== 1 || sent[0].type !== "archive.space" || sent[0].workspaceId !== "w9") {
    throw new Error("접기가 서버에 보내는 것이 다르다: " + JSON.stringify(sent));
  }
  return true;
});
// 보관을 끄면 그 슬롯에 아무 항목도 오지 않는다. 그때 우클릭 메뉴에서 예외가 나면 보관을 끈
// 사용자는 스페이스 우클릭 전체를 잃는다. 빈 항목을 거르는 규칙을 직접 호출해 확인한다.
await checkAsync("빈 항목이 와도 우클릭 메뉴가 뜬다", async () => {
  const src = read("web/js/explorer/context-menu.js");
  const m = /export function ctxItems\(raw\) \{[\s\S]*?\}\n/.exec(src);
  if (!m) throw new Error("거르는 규칙을 못 찾았다");
  const ctxItems = new Function(m[0].replace("export ", "") + "; return ctxItems;")();
  const out = ctxItems([null, { label: "닫기" }, undefined, { sep: true }]);
  if (out.length !== 2) throw new Error("빈 자리를 안 걸렀다: " + JSON.stringify(out));
  if (ctxItems(null).length !== 0 || ctxItems(undefined).length !== 0) throw new Error("목록이 아예 없을 때 터진다");
  return true;
});
// 스페이스 줄과 그 아래 터미널 탭 추가 줄은 같은 스페이스를 가리킨다. 선택지가 위치마다 다르면
// 어느 쪽이 정본인지 알 수 없으므로, 두 위치가 한 목록(spaceCtxItems)을 함께 쓰고
// 접기 항목은 그 목록에 한 번만 둔다.
check("접기 항목을 받아 가는 자리는 둘", () =>
  /export function spaceCtxItems\([\s\S]{0,900}callHook\("archive\.spaceItem"/.test(contextMenu)
  && /closest\("\.space-row"\)[\s\S]{0,400}spaceCtxItems\(row\.dataset\.space\)/.test(contextMenu)
  && /closest\("\.agent-add-row"\)[\s\S]{0,300}spaceCtxItems\(/.test(herdrAgents));
// 왼쪽 목록은 스페이스만 두고, 고른 스페이스의 세션은 오른쪽 상세에 보인다. 검색 중에는 걸린 세션만
// 상세에 남는다. 걸린 세션이 다른 세션 사이에 섞이면 검색 결과를 확인할 수 없다.
check("고른 스페이스의 세션이 상세에 선다", () => /data-ar-pick/.test(archive)
  && /const pick = e\.target\.closest\("\[data-ar-pick\]"\);\s*if \(pick\) \{ arSel = pick\.dataset\.arPick; arRender\(\)/.test(archive)
  && /detail\.innerHTML = !sel \? "" : sel\.g \? arGroupDetail\(sel\.g, q, m\)/.test(archive));
check("검색 중에는 걸린 세션만 상세에 남는다", () => /const hits = q \? g\.kids\.filter\(\(k\) => m\.get\(k\.id\)\.hit\) : g\.kids;/.test(archive));


// 복사 정리는 crop 설정과 무관하게 항상 실행한다. crop 이 꺼졌을 때 원문을 그대로 반환하면
// 패딩 공백과 불필요한 줄바꿈이 그대로 복사된다.
}
