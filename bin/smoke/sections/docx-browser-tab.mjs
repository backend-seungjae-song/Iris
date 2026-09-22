// 소유 범위: docx·sheet 를 뷰어가 아니라 스페이스 브라우저 탭으로 여는 이관.
// 제공 API: 이름 export runDocxBlock12Checks 와, DOCX-only 에서만 도는 기본 run.
// 의존 대상: core 의 공유 계수·옵션·파일 읽기, sources 의 소스 문자열, 90-docx-block1 의 helper.
// 유지 조건: 카드 아이디(`--docx-card=B5-T1` 로 사람이 직접 친다)와 검사 이름·문구.
//   91-docx-block5plus.mjs 에서 블록별로 분리한 파일이므로 본문을 그대로 유지한다.
// 영향 범위: 러너의 DOCX-only 분기와 90-docx-block1 의 helper 계약이 양방향으로 맞아야 한다.
//   현재 목록 확인: node bin/importers.mjs bin/smoke/sections/docx-browser-tab.mjs
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";

import { check, DOCX_CARD, DOCX_ONLY, LIVE, read, ROOT } from "../core.mjs";
import { aiTabs, browserTabs, dock, fileRouting, httpHandler, renderer, tabClose } from "../sources.mjs";
import {
  docxAliasedConcurrentWriteProbe, docxAssert, docxB5PackageInventory, docxB5WasmInventory,
  docxConcurrentWriteProbe, docxDispatchedHandler, docxMessageBranch, docxRenderBranch,
  docxCodeOnly, docxRichRoundTripProbe, docxRoundTripProbe, docxSizedWriteProbe, docxSourceFunction, docxWriteProbe,
} from "./90-docx-block1.mjs";

export async function runDocxBlock12Checks() {
  const selected = DOCX_CARD.toUpperCase();
  if (selected && !selected.startsWith("B12-")) return;
  console.log("\n[DOCX Block 12 RED] 스페이스 브라우저 이관 — docx/sheet가 뷰어가 아니라 브라우저 탭으로");
  const card = (id, name, fn) => { if (!selected || selected === `B12-${id}`) check(`[DOCX-B12-${id}] ${name}`, fn); };

  card("T1", "openFile은 docx/sheet를 openDocInSpaceBrowser로 돌리고, 로컬 탭 생성은 openFileLocal이 그대로 맡는다", () => {
    const openFileFn = docxSourceFunction(fileRouting, "openFile");
    docxAssert(openFileFn, "openFile 함수를 찾지 못함");
    // 어떤 확장자가 문서·표인지는 이 파일이 알지 않고 등록표에 질의한다.
    // 그 질의가 뷰어 경로로 바로 이어지는지 검사한다.
    const askAt = openFileFn.search(/fileKindOf\s*\(\s*path\s*\)/);
    docxAssert(askAt >= 0, "openFile이 종류를 등록표에 묻지 않음");
    const afterAsk = openFileFn.slice(askAt, askAt + 200);
    docxAssert(/openDocInSpaceBrowser\(path\);\s*return;/.test(afterAsk),
      "등록표가 맡는 파일을 openDocInSpaceBrowser로 돌리지 않음 — PDF/HTML(WEB_DOC_RE)처럼 그 자리로 안 감");
    const localFn = docxSourceFunction(fileRouting, "openFileLocal");
    docxAssert(localFn && /\.find\(/.test(localFn) && /requestFileContent\(path\)/.test(localFn),
      "openFileLocal에 옛 openFile의 로컬 탭 생성 로직이 없음");
    return true;
  });

  card("T2", "openDocInSpaceBrowser는 도킹이면 로컬로, 분리면 sbState.tab.open(kind+path)으로 보낸다", () => {
    const fn = docxSourceFunction(fileRouting, "openDocInSpaceBrowser");
    docxAssert(fn, "openDocInSpaceBrowser 함수를 찾지 못함");
    docxAssert(/if \(!BROWSER_MODE && state\.docked\) \{ openFileLocal\(path\); return; \}/.test(fn),
      "도킹 상태(이 창 자체가 브라우저 자리)에서 openFileLocal로 안 감 — 도킹 시 문서가 아예 안 열릴 위험");
    docxAssert(/acHost\.openBrowser/.test(fn), "분리 상태에서 브라우저 창을 띄우는 시도가 없음");
    docxAssert(/op\s*:\s*["']tab\.open["']/.test(fn) && /kind/.test(fn) && /path/.test(fn),
      "tab.open mutation에 kind/path가 안 실림 — 받는 쪽(reconcileDocTabs)이 문서 탭인지 못 가림");
    docxAssert(/op\s*:\s*["']tab\.switch["']/.test(fn), "이미 열린 문서를 다시 열 때 새 탭 대신 기존 탭으로 전환하는 dedupe가 없음");
    return true;
  });

  card("T3", "서버 tab.open mutation이 kind/path를 저장한다(docx/sheet 탭엔 url이 없다)", () => {
    const bstateLocal = read("server/browser-state.js");
    const mutateFn = docxSourceFunction(bstateLocal, "mutate") || bstateLocal;
    docxAssert(/if \(m\.kind === "docx" \|\| m\.kind === "sheet"\) \{ tab\.kind = m\.kind; if \(m\.path\) tab\.path = String\(m\.path\); \}/.test(mutateFn),
      "server/browser-state.js의 tab.open이 kind/path를 저장하지 않음 — 문서 탭이 서버 재시작·다른 창 재연결 후 사라짐");
    return true;
  });

  card("T4", "reconcileDocTabs는 BROWSER_MODE 전용이고 applyBrowserState가 매 상태 갱신마다 부른다", () => {
    const fn = docxSourceFunction(dock, "reconcileDocTabs");
    docxAssert(fn, "reconcileDocTabs 함수를 찾지 못함");
    docxAssert(/if \(!BROWSER_MODE\) return;/.test(fn), "reconcileDocTabs가 BROWSER_MODE 가드로 시작하지 않음 — 도킹 창에서도 잘못 돌 위험");
    // 앱 셸은 종류 이름을 갖지 않고, 어느 것이 문서인지는 등록표가 답한다.
    // 이름이 코드에 박혀 있기를 요구하면 현재 계약(앱 셸은 종류 이름을 모른다)과 어긋난다.
    // 그래서 등록표에 질의하는지만 확인한다. 그 표가 docx·sheet 에 참을 반환하는지는
    // tool-screens 의 "가운데 탭은 확장자를 모른다"가 직접 호출해 검사한다.
    docxAssert(/isFileKindId\(\s*t\.kind\s*\)/.test(fn), "sbState 탭을 등록표로 거르지 않음 — 브라우저 webview 탭까지 로컬 문서 탭으로 잘못 만들 위험");
    const applyFn = docxSourceFunction(aiTabs, "applyBrowserState");
    docxAssert(applyFn && /reconcileBrowserMode\(\);[^\n]*\n\s*reconcileDocTabs\(\);/.test(applyFn),
      "applyBrowserState가 reconcileBrowserMode 다음에 reconcileDocTabs를 안 부름 — 상태가 와도 문서 탭이 안 만들어짐");
    return true;
  });

  // 목록에서 사라진 문서 탭을 정리하는 위치. 앱 셸이 t.docxMode·t.docxEditor·t._svEd 를
  // 직접 읽어 "저장 안 한 문서는 유지한다"를 판정하면, 뷰어의 필드가 늘 때마다 브라우저
  // 도킹 파일이 함께 바뀌고 뷰어를 끈 경우의 동작도 달라진다. 지금은 뷰어에게 질의해
  // "아직 내리지 말라"는 답만 받는다.
  card("T4b", "사라진 문서 탭을 걷을 때 틀이 뷰어의 칸을 읽지 않고 뷰어에게 묻는다", () => {
    const fn = docxSourceFunction(dock, "reconcileDocTabs");
    docxAssert(fn, "reconcileDocTabs 함수를 찾지 못함");
    const code = docxCodeOnly(fn);
    for (const name of ["docxMode", "docxEditor", "docxDirty", "_svEd"]) {
      docxAssert(!new RegExp(`\\bt\\.${name}\\b`).test(code),
        `reconcileDocTabs가 뷰어의 칸 t.${name} 을 직접 읽는다 — 뷰어를 고치는 사람이 이 파일을 함께 열어야 한다`);
    }
    // 질의만 하고 답을 쓰지 않으면 저장하지 않은 문서가 그대로 닫힌다.
    docxAssert(/if\s*\(\s*callHook\(\s*"viewer\.dropUnlistedTab"\s*,\s*t\s*\)\s*\)\s*continue;/.test(code),
      "뷰어가 붙든 탭을 건너뛰지 않는다 — true 를 받고도 removeTab 까지 간다");
    // 그 이름을 실제로 채우는 쪽이 있어야 한다. 아무도 채우지 않으면 undefined 가 와서
    // 저장하지 않은 문서가 사라진다. 훅이 빈 이름에 아무 경고도 내지 않기 때문이다.
    const boot = read("web/js/viewer/boot.js");
    docxAssert(/provide\(\s*"viewer\.dropUnlistedTab"/.test(boot),
      "viewer.dropUnlistedTab 을 아무도 채우지 않는다");
    return true;
  });

  card("T5", "reconcileBrowserMode의 webview 생성 루프는 문서 탭(kind:docx/sheet)을 건너뛴다", () => {
    const fn = docxSourceFunction(dock, "reconcileBrowserMode");
    docxAssert(fn, "reconcileBrowserMode 함수를 찾지 못함");
    // 같은 이유로 이름이 아니라 등록표에 질의하는지를 확인한다.
    docxAssert(/if \(isFileKindId\(t\.kind\)\) continue;/.test(fn),
      "reconcileBrowserMode가 문서 탭에도 createWebview를 시도할 위험 — 빈 webview가 하나 더 생김");
    return true;
  });

  card("T6", "removeTabsNow는 분리창에서 문서 탭을 지울 때 서버에도 tab.close를 보내고, 도킹 전용 렌더 함수 대신 분리창 경로를 쓴다", () => {
    const fn = docxSourceFunction(tabClose, "removeTabsNow");
    docxAssert(fn, "removeTabsNow 함수를 찾지 못함");
    docxAssert(/String\(current\.id\)\.startsWith\("browser:"\) \|\| \(BROWSER_MODE && isFileLikeKind\(current\.kind\)\)/.test(fn),
      "분리창에서 문서 탭을 로컬로만 지움 — 다음 상태 브로드캐스트에 그대로 되살아날 위험");
    docxAssert(/if \(BROWSER_MODE\) \{ renderBmTabs\(\); reconcileDocTabs\(\); \}/.test(fn),
      "분리창 닫기 뒤처리가 renderBmTabs/reconcileDocTabs를 안 씀 — 도킹 전용 renderTabs가 분리창 탭바를 잘못 그릴 위험");
    docxAssert(/else \{ renderTabs\(\); showActiveTab\(\); persistFileTabs\(\); \}/.test(fn),
      "도킹 경로에서 persistFileTabs 호출이 분리 분기 밖으로 안 빠짐 — 분리창이 도킹창의 파일탭 저장분을 덮어쓸 위험");
    return true;
  });

  card("T7", "persistFileTabs/restoreFileTabs는 docx/sheet를 localStorage에 담지 않는다(두 창이 한 키를 마지막-쓰기로 덮어씀)", () => {
    // 무엇을 담지 않는가의 판정도 앱 셸에서 분리됐다. 앱 셸은 "지금 뷰어가 그리는 탭인가"만
    // 질의하고(viewer.presentsTab) 뷰어가 답한다. 앱 셸은 sheetMode 같은 필드 이름을 모른다.
    const persistFn = docxSourceFunction(renderer, "persistFileTabs");
    docxAssert(persistFn && /t\.kind === "file"/.test(persistFn),
      "persistFileTabs가 글자 탭만 담는 조건을 잃음");
    docxAssert(persistFn && /callHook\(\s*["']viewer\.presentsTab["']/.test(persistFn),
      "persistFileTabs가 뷰어가 그리는 탭인지 묻지 않음 — 문서 탭까지 담아 분리창이 도킹창의 저장분을 덮어쓸 위험");
    docxAssert(persistFn && !/sheetMode|docxMode/.test(docxCodeOnly(persistFn)),
      "persistFileTabs가 뷰어의 칸 이름을 다시 안다 — 뷰어를 끄면 그 판정이 틀린다");
    const restoreFn = docxSourceFunction(renderer, "restoreFileTabs");
    docxAssert(restoreFn && /fileKindOf\(path\)\)\s*continue;/.test(restoreFn),
      "restoreFileTabs가 옛 저장분의 문서·표 경로를 걸러내지 않음 — 재시작 후 문서 탭이 뷰어 쪽에 되살아날 위험");
    return true;
  });

  card("T8", "분리창 탭바에서 문서 탭 닫기는 dirty 확인(closeTabs) 경로를 타고, 인터넷 탭 닫기는 그대로 즉시 처리한다", () => {
    // 탭 목록 raw 객체(tabsBySpace)는 질의 뒤로 감췄다. 검사 대상은 순서다. 로컬 문서 탭인지
    // 먼저 질의하고, 맞으면 확인 경로(closeTabs)로 가고, 아닐 때만 서버 탭을 지운다.
    const closeAt = browserTabs.indexOf(".cclose");
    docxAssert(closeAt >= 0, "분리창 탭바의 닫기 버튼 처리를 찾지 못함");
    const handler = browserTabs.slice(closeAt, closeAt + 900);
    const lookAt = handler.search(/\.find\([\s\S]{0,80}?isFileLikeKind\(/);
    docxAssert(lookAt >= 0, "분리창 닫기 클릭 핸들러가 로컬 문서 탭 여부를 안 가림");
    const routeAt = handler.search(/closeTabs\(/);
    const serverAt = handler.search(/op:\s*["']tab\.close["']/);
    docxAssert(routeAt > lookAt, "문서 탭인지 묻기 전에 closeTabs 로 보낸다");
    docxAssert(serverAt > routeAt, "서버 탭 지우기가 확인 경로보다 먼저 온다 — 저장 안 한 편집이 확인 없이 사라질 위험");
    docxAssert(/return;/.test(handler.slice(routeAt, serverAt)), "확인 경로로 보낸 뒤 빠져나오지 않는다 — 서버 탭까지 함께 지운다");
    return true;
  });

  card("T9", "reconcileDocTabs는 활성 탭이 실제로 안 바뀌었으면 다시 그리지 않는다 — 무관한 브로드캐스트마다 에디터를 새로 마운트해 본문이 영원히 안 뜨는 것을 막는다", () => {
    const fn = docxSourceFunction(dock, "reconcileDocTabs");
    docxAssert(fn, "reconcileDocTabs 함수를 찾지 못함");
    // 지금 그리는 탭의 소유자는 질의로 확인한다(getRenderedFileOwner). 검사 대상은 이름이
    // 아니라 다시 그리기 직전에 그 질의가 호출되는가다.
    const drawAt = fn.search(/withFileViewTransition\(\s*activeTab/);
    docxAssert(drawAt >= 0, "reconcileDocTabs 가 활성 탭을 다시 그리는 자리를 찾지 못함");
    docxAssert(/renderedFileOwner[\s\S]{0,40}?!==|!==[\s\S]{0,40}?renderedFileOwner/i.test(fn.slice(Math.max(0, drawAt - 200), drawAt)),
      "reconcileDocTabs가 renderedFileOwner로 재렌더 여부를 안 가림 — 무관한 sbState 브로드캐스트마다 withFileViewTransition을 다시 불러 진행 중이던 WASM 에디터 마운트를 계속 취소시킬 위험(실기: 메뉴/툴바는 뜨는데 본문이 계속 백지)");
    return true;
  });

  card("T10", "openDocInSpaceBrowser는 문서 탭을 태우기 전에 이 스페이스를 sbState.activeSpace로 맞춘다 — 안 하면 분리창이 다른 스페이스를 보고 있어 방금 연 문서가 그 창에 안 보인다", () => {
    const fn = docxSourceFunction(fileRouting, "openDocInSpaceBrowser");
    docxAssert(fn, "openDocInSpaceBrowser 함수를 찾지 못함");
    const spaceActiveAt = fn.indexOf('op: "space.active"');
    const tabOpenAt = fn.indexOf('op: "tab.open"');
    docxAssert(spaceActiveAt >= 0, "openDocInSpaceBrowser가 space.active를 안 보냄 — 분리창의 boundSpace()가 엉뚱한 스페이스를 볼 위험(실기: \"탭은 뜨는데 흰 화면에 주소도 비어있음\")");
    docxAssert(tabOpenAt < 0 || spaceActiveAt < tabOpenAt, "space.active가 tab.open보다 늦게 감 — 분리창이 tab.open을 받는 시점에 아직 다른 스페이스를 보고 있을 위험");
    return true;
  });
}


export default async function run() {
  await runDocxBlock12Checks();
}
