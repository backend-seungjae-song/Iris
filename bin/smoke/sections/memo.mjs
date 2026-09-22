// 소유 범위: web/js/panel/memo*.js 의 편집기 생성 시점, 원문·미리보기 전환, 도크와 페이지, 메모창 높이.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사·파일 도구, sources 의 공유 소스, Node 파일·경로·모듈 API.
// 유지 조건: 검사 이름과 본문. 40-qa-evidence.mjs 를 기능별로 분리한 것이고,
//   분리하면서 본문을 바꾸지 않았고, 원본 대비 바이트 대조로 이를 강제한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부르며 sources 의 공유 상수 계약도 함께 본다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs bin/smoke/sections/memo.mjs
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
import { memoOptions } from "../editor-controls-harness.mjs";

export default async function run() {
  console.log("[메모 — 편집기·원문·미리보기·창]");
check("메모 편집기를 허공에 띄우지 않는다", () => !/document\.body\.appendChild\(memoHost\)/.test(memoPanel)
  && /if \(!placeMemoEditor\(\)\) return Promise\.resolve\(null\)/.test(memoPanel));
check("분리 브라우저·메모 창엔 중앙 메모 편집기를 만들지 않는다", () => /if \(AUX_MODE\) return Promise\.resolve\(null\)/.test(memoPanel));
// Monaco의 AMD 로더가 먼저 뜨면 뒤에 오는 UMD(xterm)가 전역 대신 AMD로 등록된다. 이 코드베이스가
// 의도적으로 피하는 문제이며, 메모 편집기를 시작 경로에서 만들면 그대로 발생한다.
// ★ TDZ: Monaco 쪽 상태는 이 파일 아래쪽에서 let으로 선언된다. 그 전에 ensureMonaco를 부르면
// "Cannot access 'monacoReady' before initialization"으로 스크립트 전체가 중단되어 창이 검게 뜬다.
// 평가 완료 플래그는 반드시 var여야 한다. let이면 이 검사 자체가 TDZ로 실패한다.
check("평가가 끝난 뒤에 편집기를 만든다", () => /var memoBootReady = false;/.test(memoPanel)
  && /if \(!memoBootReady\) return Promise\.resolve\(null\)/.test(memoPanel)
  && /memoBootReady = true;/.test(memoPanel));
check("메모 편집기는 펼쳤을 때 만든다", () => /function memoVisible\(\)/.test(memoPanel)
  && /if \(!memoVisible\(\)\) return Promise\.resolve\(null\)/.test(memoPanel)
  && /id === "panel-memo" && open\) callHook\("memo\.renderPreview"\)/.test(web));
// 앱이 마우스 모드가 아니면 우리가 보내는 휠 바이트는 스크롤이 아니라 입력이 된다.
check("메모에 원문/미리보기", () => /data-memo-md="raw"/.test(web) && /data-memo-md="preview"/.test(web)
  && /function renderMemoPreview\(\)/.test(memoPanel));
check("메모 미리보기는 파일과 같은 처리기", () => /pv\.innerHTML = mdToHtml\(text \|\| ""\)/.test(memoPanel));
check("도크와 메모 페이지가 같이 바뀐다", () => /\["#memo-slot", "#memo-preview"\], \["#mm-slot", "#mm-preview"\]/.test(memoPanel));
// 원문도 파일 쪽과 같은 편집기(Monaco·markdown)를 쓴다. ## 같은 표기에 색이 붙어야 한다.
check("메모 원문은 markdown 편집기", () => /createModel\([\s\S]{0,120}?"markdown"\)/.test(memoPanel) && /function ensureMemoEditor/.test(memoPanel));
// 같은 메모를 두 벌로 들고 있으면 내용이 어긋난다. 편집기 하나를 슬롯 사이로 옮기면
// 한쪽이 비게 된다. 도크와 메모 페이지는 동시에 화면에 있을 수 있기 때문이다.
// 그래서 글(모델)은 하나만 두고 편집기는 슬롯마다 만든다.
check("도크와 페이지가 같은 글을 나눠 본다", () => {
  return /const MEMO_SLOTS = \["memo-slot", "mm-slot"\]/.test(memoPanel)
    && /function syncMemoEditors/.test(memoPanel)
    && /monaco\.editor\.create\(host, memoOpts\(\)\)[\s\S]{0,120}?memoEds\.set\(id, \{ host, editor/.test(memoPanel)
    && /memoModel\.onDidChangeContent/.test(memoPanel)          // 변경 감지는 글에 한 번만
    && !/\$\("#mm-slot"\) \|\| \$\("#memo-slot"\)/.test(memoPanel)   // 자리 우선순위로 고르지 않는다
    && !/\bmemoEditor\b/.test(memoPanel);                        // 편집기 한 개를 가리키는 전역이 남아 있지 않다
});
// 조합 중인 한글 앞에 글자가 겹쳐 보이는 원인은 Monaco의 숨은 입력 칸이다. 커서 앞 단어를 담고
// 줄 너비만큼 넓어진 채 화면에 올라온다. 줄바꿈 설정 양쪽에서 이 칸을 최소로 줄인다.
check("메모는 조합 중 유령 글자를 만들지 않는다", () => [false, true].every((wrap) =>
  memoOptions(wrap).every((options) => options.accessibilitySupport === "off"
    && options.wordWrap === (wrap ? "on" : "off") && options.minimap.enabled === false)));
check("메모창 높이 조절", () => /id="memo-resize"/.test(web)
  && /--memo-h/.test(css("12-dock-memo")) && /ac\.memoH/.test(memoPanel));


// 분리한 메모 알림 모듈이 이전 모듈의 이름을 참조하는지 확인한다. 이 열 가지 처리에는 검사가
// 없었고, 확인 결과 전부 비워도 검사 1,190개가 모두 통과했다. 동작까지 덮지는
// 못하지만, 분리 과정에서 이름이 끊긴 경우는 여기서 걸린다.
await checkAsync("메모 알림 모듈은 자기 밖의 이름을 부르지 않는다", async () => {
  const el = () => ({ innerHTML: "", className: "", style: {}, dataset: {}, textContent: "",
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    querySelector: () => el(), querySelectorAll: () => [], addEventListener() {},
    removeEventListener() {}, appendChild() {}, remove() {}, focus() {}, closest: () => null,
    setAttribute() {}, getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 800, height: 600, top: 0, left: 0 }) });
  const saved = { window: globalThis.window, document: globalThis.document,
    raf: globalThis.requestAnimationFrame, css: globalThis.CSS,
    gcs: globalThis.getComputedStyle, ls: globalThis.localStorage };
  globalThis.window = { acHost: { openLocalMemo: async () => ({ ok: true }) } };
  globalThis.document = { createElement: el, querySelector: () => el(), querySelectorAll: () => [],
    addEventListener() {}, body: el(), documentElement: el() };
  globalThis.requestAnimationFrame = (fn) => { fn(); return 1; };
  globalThis.CSS = { escape: (x) => x };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  try {
    const { initMemoMessages } = await import(new URL("../../../web/js/panel/memo-messages.js", import.meta.url).href);
    const h = initMemoMessages({ showToast() {}, spk: (x) => x });
    const leaks = new Set();
    const hit = (name, fn) => {
      try {
        const r = fn();
        if (r && typeof r.catch === "function") r.catch((e) => { if (e instanceof ReferenceError) leaks.add(`${name}: ${e.message}`); });
      } catch (e) { if (e instanceof ReferenceError) leaks.add(`${name}: ${e.message}`); }
    };
    const cases = [
      ["MemoNotes", { notes: [] }, "handleMemoNotesMessage"],
      ["MemoNotes(오류)", { error: "안 됨" }, "handleMemoNotesMessage"],
      ["NoteCreated", { requestId: "r", note: { id: "n1" }, space: "X" }, "handleMemoNoteCreatedMessage"],
      ["NoteCreated(빈)", { requestId: "r" }, "handleMemoNoteCreatedMessage"],
      ["NoteRestored", { note: { name: "a" } }, "handleMemoNoteRestoredMessage"],
      ["NoteArchived", { date: "8/23" }, "handleMemoNoteArchivedMessage"],
      ["NoteArchived(빈)", { empty: true }, "handleMemoNoteArchivedMessage"],
      ["Conflict", { message: "x" }, "handleMemoConflictMessage"],
      ["Error", { message: "x" }, "handleMemoErrorMessage"],
      ["Archives", { archives: {} }, "handleMemoArchivesMessage"],
      ["Archived", { date: "8/23", updated: true }, "handleMemoArchivedMessage"],
      ["Archived(빈)", { empty: true }, "handleMemoArchivedMessage"],
      ["Memos", { memos: {} }, "handleMemosMessage"],
    ];
    for (const [label, msg, fn] of cases) {
      if (typeof h[fn] !== "function") { leaks.add(`${fn}: 내주지 않는다`); continue; }
      hit(label, () => h[fn](msg));
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
    if (leaks.size) throw new Error(`옛 이웃을 부른다 — ${[...leaks].join(" · ")}`);
    return true;
  } finally {
    globalThis.window = saved.window; globalThis.document = saved.document;
    globalThis.requestAnimationFrame = saved.raf; globalThis.CSS = saved.css;
    globalThis.getComputedStyle = saved.gcs; globalThis.localStorage = saved.ls;
  }
});

}
