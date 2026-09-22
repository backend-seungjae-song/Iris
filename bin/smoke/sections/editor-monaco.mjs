// 소유 범위: 편집기. VSCode 엔진(Monaco)을 그대로 쓰고 직접 구현하지 않는다.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사·파일 도구, sources 의 공유 소스, Node 파일·경로 API.
// 유지 조건: 검사 이름과 본문. 20-browser-contracts.mjs 를 기능별로 분리한 파일이고,
//   분리하면서 본문을 바꾸지 않았다. 원본 대비 바이트 대조가 그것을 보장한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부르며 sources 의 공유 상수 계약도 함께 본다.
//   현재 목록 확인: node bin/importers.mjs bin/smoke/sections/editor-monaco.mjs
import { existsSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { homedir, tmpdir } from "node:os";

import { b4Function, check, checkAsync, fnBody, read, readAll, require_, ROOT, sourceFiles } from "../core.mjs";
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
console.log("[2l] 편집기 — VSCode 엔진(Monaco)을 그대로");
// 자작 하이라이터와 투명 textarea 겹침 대신 VSCode 가 쓰는 엔진을 사용한다.
check("Monaco가 vendor에 실재", () => ["vs/loader.js", "vs/editor/editor.main.js", "vs/editor/editor.main.css",
  "vs/base/worker/workerMain.js", "vs/base/browser/ui/codicons/codicon/codicon.ttf"]
  .every((f) => existsSync(path.join(ROOT, "web/vendor/monaco", f))));
// 로더를 정적 태그로 먼저 넣으면 define.amd 가 생겨 뒤에 오는 UMD(xterm)가 전역 대신 AMD 로
// 등록되고 터미널이 동작하지 않는다. 그래서 파일을 처음 열 때 지연 주입한다.
check("로더는 지연 주입(xterm AMD 충돌 방지)", () =>
  !/<script src="\/vendor\/monaco/.test(web)
  && /sc\.src = "\/vendor\/monaco\/vs\/loader\.js"/.test(textEditor)
  && web.includes('<script src="/vendor/xterm.js">'));
// 호스트를 DOM 에서 찾으면 파일 탭이 없을 때 null 에 붙이려다 실패한다(확인 결과: parentNode 오류).
check("편집기 호스트는 우리가 소유", () =>
  /function monacoHostEl\(\)/.test(textEditor) && /monaco\.editor\.create\(monacoHostEl\(\)/.test(textEditor)
  && !/const host = \$\("#editor-host"\)/.test(textEditor));
check("파일마다 모델·뷰상태(실행취소·커서 보존)", () =>
  /const monacoModels = new Map\(\)/.test(textEditor) && /const monacoViewState = new Map\(\)/.test(textEditor)
  && /monacoEditor\.saveViewState\(\)/.test(textEditor) && /monacoEditor\.restoreViewState\(vs\)/.test(textEditor));
check("탭을 닫으면 모델도 정리", () => /disposeFileModel\(String\(id\)\.slice\(5\)\)/.test(textEditor));
check("저장은 기존 fs.write 경로 그대로", () => {
  // 바이트 창으로 자르면 그 함수가 길어지는 날 찾던 줄이 창 밖으로 밀려 검사가 아무것도 보지
  // 못한다. 실제로 뷰어 분리로 표 저장이 훅 호출이 되면서 두 줄이 늘었다. 함수를 통째로 뗀다.
  // 보내는 위치는 하나다. saveActiveFile 이 fs.write 를 한 번 더 만들어 넘기면 그 사본에는
  // space·tabId·reason 이 빠져 main 의 보정에 의존하게 된다.
  const active = b4Function(textEditor, "saveActiveFile");
  const send = b4Function(textEditor, "sendFileSave");
  return /saveFileTab\(t, centerSpace\)/.test(active)
    && !/wsSend\(/.test(active)
    && /type: "fs\.write", path: t\.path, content: snapshot/.test(send);
});
// 저장 시점에만 막는다. 창은 읽을 때 받은 기준을 그대로 돌려보내고, 서버가 현재 디스크와
// 대조해 일치하지 않으면 거절한다. 사용자가 「덮어쓰기」를 고르면 기준 없이 다시 보낸다.
check("밖에서 바뀐 파일은 저장 시점에 막는다", () => {
  const send = b4Function(textEditor, "sendFileSave");
  const write = read("server/fs-handlers.js");
  return /message\.baselineRevision = baselineRevision/.test(send)
    && /response\.conflict/.test(send) && /askOverwrite\(/.test(send)
    // 덮어쓰기는 기준을 빼는 것이 아니라 전용 이름으로 요청한다. 기준을 잃은 창이 덮어쓰는 것을 막는다
    && /sendFileSave\(t, space, snapshot, baselineRevision, true\)/.test(send)
    && /message\.overwrite = true/.test(send)
    && /const baseline = typeof msg\.baselineRevision === "string"/.test(write)
    && /const overwrite = msg\.overwrite === true/.test(write)
    && /if \(!overwrite && baseline !== null\)/.test(write)
    && /now !== null && now !== baseline/.test(write)
    && /conflict: true/.test(write)
    // 읽지 못한 것을 없는 것으로 처리하면 대조가 성립하지 않는다
    && /if \(e && e\.code === "ENOENT"\) return null;\s*\n\s*throw e;/.test(write);
});
// 대화상자는 한 번에 하나다. 「모두 닫기」는 저장을 한꺼번에 실행하므로, 순서를 세우지 않으면
// 충돌 대화상자가 겹쳐 떠서 어느 파일에 답하는지 알 수 없다.
check("충돌 대화상자는 파일 하나씩 줄 세운다", () => {
  return /let overwriteQueue = Promise\.resolve\(\)/.test(textEditor)
    && /overwriteQueue = next\.catch/.test(textEditor);
});
// 기준을 갱신하지 않으면 방금 한 저장이 다음 저장에서 충돌로 보인다. 읽기·저장·되돌리기 모두 해당한다.
check("읽기·저장·되돌리기가 기준 revision을 옮긴다", () => {
  const main = read("web/js/main.js");
  return /revision: createHash\("sha256"\)/.test(read("server/fs-handlers.js"))
    && /t\.revision = m\.revision/.test(main)
    && /ft\.revision = m\.revision/.test(main)
    && /staged\.revision/.test(read("web/js/center/tab-close.js"));
});
// Cmd 와 Ctrl 을 맞바꾼 키보드 배치가 있으므로 저장은 어느 쪽으로 눌러도 동작해야 한다.
check("저장 단축키는 Cmd·Ctrl 둘 다", () =>
  /KeyMod\.CtrlCmd \| monaco\.KeyCode\.KeyS/.test(textEditor) && /KeyMod\.WinCtrl \| monaco\.KeyCode\.KeyS/.test(textEditor));
check("자작 하이라이터는 제거됨", () =>
  !/function highlightCode/.test(web) && !/function highlightMarkdownRaw/.test(web)
  && !/class="editor-input"/.test(web) && !/\.hl-kw \{/.test(allCss));
check("언어 표를 우리가 다시 만들지 않음", () => /monaco\.languages\.getLanguages\(\)/.test(textEditor));
check("서버가 Monaco 자원 MIME을 안다", () => {
  return /"\.ttf": "font\/ttf"/.test(httpHandler) && /"\.json": "application\/json"/.test(httpHandler);
});
check("검증 프로브가 남아 있지 않음", () => !/MONACOCHK/.test(web));

}
