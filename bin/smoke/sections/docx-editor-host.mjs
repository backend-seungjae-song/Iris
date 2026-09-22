// 소유 범위: 편집기 호스트와 UI. 편집기가 어디에 붙고 무엇을 그리는가.
// 제공 API: 이름 export runDocxBlock6Checks 와, DOCX-only 에서만 도는 기본 run.
// 의존 대상: core 의 공유 계수·옵션·파일 읽기, sources 의 소스 문자열, 90-docx-block1 의 helper.
// 유지 조건: 카드 아이디(`--docx-card=B5-T1` 로 사람이 직접 친다)와 검사 이름·문구.
//   91-docx-block5plus.mjs 에서 블록별로 분리한 파일이므로 본문을 그대로 유지한다.
// 영향 범위: 러너의 DOCX-only 분기와 90-docx-block1 의 helper 계약이 양방향으로 맞아야 한다.
//   현재 목록 확인: node bin/importers.mjs bin/smoke/sections/docx-editor-host.mjs
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";

import { check, checkAsync, DOCX_CARD, DOCX_ONLY, LIVE, read, ROOT } from "../core.mjs";
import { aiTabs, capabilitySource, dock, docxPanel, fileRouting, httpHandler, renderer, tabClose } from "../sources.mjs";
import {
  docxAliasedConcurrentWriteProbe, docxAssert, docxB5PackageInventory, docxB5WasmInventory, docxCodeOnly, docxConcurrentWriteProbe, docxDispatchedHandler, docxMessageBranch, docxRenderBranch, docxRichRoundTripProbe, docxRoundTripProbe, docxSizedWriteProbe, docxSourceFunction, docxWriteProbe,
} from "./90-docx-block1.mjs";

export async function runDocxBlock6Checks() {
  const selected = DOCX_CARD.toUpperCase();
  if (selected && !selected.startsWith("B6-")) return;
  console.log("\n[DOCX Block 6 RED] Editor host/UI");
  const card = (id, name, fn) => { if (!selected || selected === `B6-${id}`) check(`[DOCX-B6-${id}] ${name}`, fn); };

  const render = docxSourceFunction(renderer, "renderFileViewBody");
  const docxBranch = docxRenderBranch(docxPanel, render) || render;
  const cleanup = docxSourceFunction(docxPanel, "cleanupDocxRender");

  card("T1", "툴바는 CHROME_GROUPS.controls를, 메뉴바는 CHROME_MENUS.entries를 각각 순회해 그린다", () => {
    // core 는 toolbar(CHROME_GROUPS)와 menu bar(CHROME_MENUS)를 별도 데이터로 정의한다.
    // CHROME_GROUPS 순회만 확인하면 group.controls 순회·CHROME_MENUS 존재·재귀 kind 분기
    // (item/submenu/separator)가 증명되지 않으므로 셋을 함께 확인한다.
    docxAssert(/__docxEditorCore\.CHROME_GROUPS|DocxEditorCore\.CHROME_GROUPS/.test(renderer),
      "CHROME_GROUPS가 core 모듈(window.__docxEditorCore)에서 온 게 아님 — 정본은 core여야 한다");
    docxAssert(/CHROME_GROUPS[\s\S]{0,300}\.(?:map|forEach|flatMap)\s*\([\s\S]{0,300}?\.controls\b/.test(renderer)
      || /\.controls[\s\S]{0,300}\.(?:map|forEach|flatMap)\s*\(/.test(renderer),
      "CHROME_GROUPS의 각 group.controls를 순회하는 코드가 없음 — group만 순회하고 controls는 안 그릴 수 있음");
    docxAssert(/__docxEditorCore\.CHROME_MENUS|DocxEditorCore\.CHROME_MENUS/.test(renderer),
      "CHROME_MENUS가 core 모듈에서 참조되지 않음 — 메뉴바 자체가 없을 수 있음");
    docxAssert(/\.entries[\s\S]{0,300}\.(?:map|forEach|flatMap)\s*\(/.test(renderer),
      "CHROME_MENUS의 각 menu.entries를 순회하는 코드가 없음");
    docxAssert(/\.kind\s*===?\s*["']submenu["']|\.kind\s*===?\s*["']separator["']/.test(renderer),
      "ChromeMenuEntry의 kind(item/submenu/separator) 분기가 없음 — 재귀 메뉴 구조를 평평하게 잘못 그릴 수 있음");
    return true;
  });

  // 분리한 패널이 이전 모듈의 심볼을 참조하는지 확인한다. 브라우저 모듈이라 실행으로 확인할
  // 수 없고, 소스 모양 검사는 이름이 어느 파일에 있든 통과한다. 없는 export 를 import 하면
  // 적재가 실패하고, 이전 모듈의 심볼을 참조하면 ReferenceError 로 드러난다.
  if (!selected || selected === "B6-T0") await checkAsync("[DOCX-B6-T0] docx 패널 모듈은 자기 밖의 이름을 부르지 않는다", async () => {
    const el = () => ({
      innerHTML: "", className: "", style: {}, dataset: {}, textContent: "",
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      querySelector: () => el(), querySelectorAll: () => [], addEventListener() {},
      removeEventListener() {}, appendChild() {}, remove() {}, focus() {}, scrollTo() {},
      closest: () => null, setAttribute() {}, getAttribute: () => null,
      getBoundingClientRect: () => ({ width: 800, height: 600, top: 0, left: 0 }),
    });
    const saved = { window: globalThis.window, document: globalThis.document,
      raf: globalThis.requestAnimationFrame, css: globalThis.CSS, gcs: globalThis.getComputedStyle };
    globalThis.window = { __docxEditorCoreReady: Promise.resolve({ createDocxEditor: () => { throw new Error("엔진 없음"); } }) };
    globalThis.document = { createElement: el, querySelector: () => el(), querySelectorAll: () => [],
      addEventListener() {}, body: el(), documentElement: el() };
    globalThis.requestAnimationFrame = (fn) => { fn(); return 1; };
    globalThis.CSS = { escape: (x) => x };
    globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
    try {
      const { initDocxPanel } = await import(new URL("../../../web/js/docx/panel.js", import.meta.url).href);
      const panel = initDocxPanel({ docxview: el(), esc: (x) => String(x ?? ""),
        filePathBarHtml: () => "", showToast() {} });
      const leaks = new Set();
      const tab = () => ({ docxMode: true, label: "a.docx", path: "/x/a.docx", docxGeneration: 1,
        docxRenderToken: 7, docxEditor: null, docxChromeCleanups: [() => {}], docxData: new Uint8Array([1, 2]) });
      const hit = (name, fn) => {
        try {
          const r = fn();
          if (r && typeof r.catch === "function") r.catch((e) => { if (e instanceof ReferenceError) leaks.add(`${name}: ${e.message}`); });
        } catch (e) { if (e instanceof ReferenceError) leaks.add(`${name}: ${e.message}`); }
      };
      hit("cleanupDocxRender(빈)", () => panel.cleanupDocxRender(null));
      hit("cleanupDocxRender", () => panel.cleanupDocxRender(tab()));
      hit("cleanupDocxRender(편집기)", () => panel.cleanupDocxRender({ ...tab(), docxEditor: { destroy() {} } }));
      hit("renderDocxPanelBody(오류)", () => panel.renderDocxPanelBody({ ...tab(), docxError: "안 열림" }, 7));
      hit("renderDocxPanelBody(불러오는 중)", () => panel.renderDocxPanelBody({ ...tab(), docxData: null }, 7));
      hit("renderDocxPanelBody", () => panel.renderDocxPanelBody(tab(), 7));
      hit("renderDocxContent", () => panel.renderDocxContent(tab()));
      await new Promise((resolve) => setTimeout(resolve, 80));
      docxAssert(!leaks.size, `옛 이웃을 부른다 — ${[...leaks].join(" · ")}`);
      return true;
    } finally {
      globalThis.window = saved.window; globalThis.document = saved.document;
      globalThis.requestAnimationFrame = saved.raf; globalThis.CSS = saved.css;
      globalThis.getComputedStyle = saved.gcs;
    }
  });

  card("T2", "toolbarCommandState 결과가 DOM에 반영되고, 클릭은 runToolbarCommand로 dispatch한다", () => {
    // runToolbarCommand 자체가 core 내부에서 can→exec를 이미 수행한다(d.ts: "Run a
    // toolbar control: can first, then exec only if it said yes"). 별도 toolbarCommandState
    // 선호출을 요구할 근거가 없다. 올바른 계약은 state 가 disabled/active/value 등 DOM 표시를
    // 지배하고, 클릭은 runToolbarCommand 로만 dispatch 하는 것이다.
    // 도구 바 연결은 panel.js 에서 editor.js 로 분리됐다. 모듈 집합 전체를 보되 주석은
    // 제외한다. panel.js 의 주석이 toolbarCommandState 를 설명해 먼저 걸리기 때문이다.
    // 첫 번째 위치로 검사하지 않는다. 호출 위치가 셋이라 순서가 바뀌면 다른 곳을 검사한다.
    // 위치마다 확인하고, 하나라도 계약을 지키면 통과시킨다.
    const src = docxCodeOnly(capabilitySource("viewer"));
    const states = [...src.matchAll(/toolbarCommandState\s*\(/g)].map((m) => m.index);
    docxAssert(states.length, "toolbarCommandState 호출이 없음(활성/비활성/값 표시 판정 누락)");
    docxAssert(states.some((at) => {
      const ctx = src.slice(at, at + 500);
      return /\.enabled\b/.test(ctx) && (/\.active\b/.test(ctx) || /\.value\b/.test(ctx));
    }), "toolbarCommandState 반환값(enabled/active/value)을 실제로 읽어 쓰는 자리가 없음");
    // 연결 위치는 도구 바와 메뉴 둘이다. 하나만 있으면 다른 한쪽 클릭이 동작하지 않는다.
    // "하나라도 있으면 통과"로 검사하면 한쪽을 지워도 통과한다(변이로 확인).
    const runs = [...src.matchAll(/runToolbarCommand\s*\(/g)].map((m) => m.index);
    docxAssert(runs.length >= 2, `runToolbarCommand 로 태우는 자리를 ${runs.length} 곳만 셌다 — 도구 바와 메뉴 둘 다여야 한다`);
    // 위치마다 클릭 문맥을 요구하지는 않는다. 하나는 특수 슬롯 도우미 안에서 호출된다.
    // 한쪽 삭제는 위의 개수 검사로 잡히므로 여기서는 클릭 경로의 연결 여부만 확인한다.
    docxAssert(runs.some((at) => {
      const before = src.slice(Math.max(0, at - 1500), at);
      return /addEventListener\s*\(\s*["']click["']/.test(before) || /\bonclick\b/.test(before) || /=>\s*\{[\s\S]{0,200}$/.test(before);
    }), "runToolbarCommand를 클릭 핸들러 문맥에서 부르는 자리가 없음");
    return true;
  });

  card("T3", "round 5 편집 스코프 카테고리별 대표 슬롯이 최소 배선 흔적을 남긴다(floor check)", () => {
    // 설치된 core 2.2.0 의 ChromeSlotId 는 54개다(index-gvw4VGE9.d.ts 확인).
    // 이 카드는 완전한 연결 증명이 아니라 카테고리 전체가 빠지지 않았는지 보는 floor 검사이고,
    // 실제 연결 증명은 T1/T2 가 맡는다.
    const representativeSlots = {
      텍스트: "text.bold", 서식: "alignment.center", 표: "table.insert", 이미지: "image.insert",
      목록: "list.bullet", 링크: "text.link", 실행취소재실행: "history.undo", 모드전환: "review.editingMode",
    };
    for (const [category, slot] of Object.entries(representativeSlots)) {
      docxAssert(renderer.includes(`"${slot}"`) || renderer.includes(`'${slot}'`),
        `카테고리 "${category}"의 대표 슬롯 "${slot}"이 소스 어디에도 없음(카테고리 전체 누락 조기 발견용)`);
    }
    return true;
  });

  card("T4", "찾기바꾸기는 findMatches→selectMatch→surface.type()로 구현된다(exec replaceMatch/replaceAllMatches 아님)", () => {
    // editor.exec({type:'replaceMatch'|'replaceAllMatches'})는 core d.ts 에 선언돼 있지만
    // 설치된 core 2.2.0 의 "tree editor" 구현체가 처리하지 않아({ok:false, code:"unsupported"})
    // 클릭하면 검색·강조는 되고 치환만 동작하지 않는다. 콘솔 오류도 없어 문자열 존재 검사로는
    // 잡히지 않는다. 대신 활성 선택 영역을 실제로 치환·삭제하는 editor.surface.type(text)를
    // 요구한다(FINDME 개수 변화와 화면 반영으로 확인).
    docxAssert(/\.findMatches\s*\(/.test(renderer), "editor.findMatches 호출이 없음");
    docxAssert(/\.selectMatch\s*\(/.test(renderer), "editor.selectMatch 호출이 없음");
    docxAssert(!/\.exec\s*\(\s*\{\s*type\s*:\s*["'](replaceMatch|replaceAllMatches)["']/.test(renderer),
      "editor.exec({type:'replaceMatch'|'replaceAllMatches', ...})가 여전히 쓰이고 있음 — 설치된 core가 지원하지 않는 커맨드로 되돌아간 위험(치환이 조용히 무동작해짐)");
    const replaceMatchFn = docxSourceFunction(renderer, "docxReplaceMatch");
    docxAssert(replaceMatchFn && /\.selectMatch\s*\(\s*match\s*\)/.test(replaceMatchFn) && /\.surface\.type\s*\(/.test(replaceMatchFn),
      "docxReplaceMatch가 selectMatch 후 editor.surface.type()으로 치환하지 않음");
    const replaceAllFn = docxSourceFunction(renderer, "docxReplaceAllMatches");
    docxAssert(replaceAllFn && /\.selectMatch\s*\(/.test(replaceAllFn) && /\.surface\.type\s*\(/.test(replaceAllFn),
      "docxReplaceAllMatches가 selectMatch 후 editor.surface.type()으로 치환하지 않음");
    return true;
  });

  card("T5", "편집↔보기 전환은 getEditingMode/setEditingMode('editing'|'viewing')로 런타임에 동작한다", () => {
    // DocxEditorConfig.mode 는 생성 시점의 opening mode 이고 런타임 토글 API 가 아니다.
    // 런타임 전환은 Editor.getEditingMode()/setEditingMode(mode)이고 값도 'edit'/'view'가
    // 아니라 DocumentEditingMode = 'editing'|'suggesting'|'viewing' 이다
    // (editor-C8oaTHr3.d.ts 확인). config 리터럴 두 개만으로 통과시키면 런타임 API 가 없어도
    // 통과하는 잘못된 검사가 된다.
    docxAssert(/\.setEditingMode\s*\(/.test(renderer), "editor.setEditingMode 호출이 없음 — 런타임 모드 전환 API 미사용");
    docxAssert(/\.getEditingMode\s*\(/.test(renderer), "editor.getEditingMode 호출이 없음 — 현재 모드를 읽어 UI에 반영하지 않음");
    docxAssert(/setEditingMode\s*\(\s*["']viewing["']/.test(renderer), "setEditingMode('viewing') 호출이 없음 — 보기 모드로 전환하는 경로 누락");
    docxAssert(/setEditingMode\s*\(\s*["']editing["']/.test(renderer), "setEditingMode('editing') 호출이 없음 — 편집 모드로 되돌아가는 경로 누락");
    return true;
  });

  card("T6", "하이퍼링크 콜백은 activation.link.href만 openInSpaceBrowser로 위임하고 onRequest는 navigation하지 않는다", () => {
    docxAssert(/setHyperlinkChrome\s*\(/.test(docxPanel), "setHyperlinkChrome 등록이 없음 — 엔진 하이퍼링크 제스처를 가로챌 수 없음");
    const chromeAt = docxPanel.search(/setHyperlinkChrome\s*\(/);
    const handlerBody = docxPanel.slice(chromeAt, chromeAt + 1800);
    docxAssert(/onPopover\s*[:(]/.test(handlerBody), "onPopover 핸들러가 setHyperlinkChrome 인자에 없음");
    docxAssert(/onRequest\s*[:(]/.test(handlerBody), "onRequest 핸들러가 setHyperlinkChrome 인자에 없음");
    const onPopoverAt = handlerBody.search(/onPopover\s*[:(]/);
    const popoverBody = handlerBody.slice(onPopoverAt, onPopoverAt + 500);
    docxAssert(/activation\.link\??\.href/.test(popoverBody), "onPopover가 activation.link.href를 쓰지 않음(freshness/provenance 없이 임의 URL을 열 위험)");
    docxAssert(/openInSpaceBrowser\s*\(/.test(popoverBody), "onPopover 콜백이 openInSpaceBrowser로 위임하지 않음");
    const onRequestAt = handlerBody.search(/onRequest\s*[:(]/);
    const requestBody = handlerBody.slice(onRequestAt, onRequestAt + 500);
    docxAssert(!/openInSpaceBrowser\s*\(/.test(requestBody), "onRequest(⌘K 편집 요청)가 openInSpaceBrowser를 호출함 — 편집 요청과 링크 열기가 혼동됨");
    docxAssert(!/window\.open\s*\(|(?:window\.)?location\.href\s*=/.test(handlerBody), "하이퍼링크 콜백이 직접 브라우저 navigation API를 호출함");
    return true;
  });

  card("T7", "__docxEditorCoreReady await 직후 editor 생성 전에 owner/generation을 재확인한다", () => {
    // await/then 존재만으로는 "A가 대기하는 동안 B로 전환됐는데 A가 뒤늦게 마운트"되는 경합을
    // 막지 못한다. await 뒤에 generation/token/owner 를 다시 확인해야 한다.
    // 주석은 제외하고 본다. 생성 위치 앞에 긴 주석이 있으면 1500 글자 창이 주석으로 찬다.
    const panelSrc = docxCodeOnly(capabilitySource("viewer"));
    docxAssert(/createDocxEditor\s*\(/.test(panelSrc), "createDocxEditor 호출이 없음");
    const createAt = panelSrc.search(/createDocxEditor\s*\(/);
    const waitAt = panelSrc.lastIndexOf("__docxEditorCoreReady", createAt);
    docxAssert(waitAt >= 0 && waitAt < createAt, "createDocxEditor 호출 앞에 __docxEditorCoreReady 대기가 없음");
    // 이름이 있는지가 아니라 다시 비교하는지를 검사한다. 함수 앞에서 세대를 담는 줄
    // (const docxGeneration = t.docxGeneration)만으로 통과시키면, 재확인을 지워도 통과하는
    // 잘못된 검사가 된다(변이로 확인).
    // 검사 창은 좁게 잡아 대기 직후만 본다. 넓게 잡으면 뒤의 다른 가드(캐럿 재시도 도우미의
    // 소유 확인 등)가 대신 걸려서 재확인을 지워도 통과한다(변이로 확인).
    const afterWait = panelSrc.slice(waitAt, Math.min(createAt, waitAt + 300));
    docxAssert(/docxGeneration\s*!==|docxRenderToken\s*!==|!==\s*getRenderedFileOwner|!==\s*getRenderedFileToken/.test(afterWait),
      "await 직후 generation/owner/token을 다시 대보지 않음 — 대기 중 다른 탭으로 전환돼도 뒤늦게 마운트될 위험");
    return true;
  });

  card("T8", "cleanupDocxRender가 editor 참조를 먼저 비운 뒤 정확히 한 번 destroy한다", () => {
    // cleanupDocxRender(t) 는 withFileViewTransition·removeTabsNow 경유·재렌더 전 세 지점에서
    // 모두 호출되는 유일한 idempotent 정리 지점이다. 그래서 editor.destroy()는 removeTabsNow 가
    // 아니라 이 함수 안에 있어야 모든 호출 경로에서 정리가 보장된다. docxRenderCancel 과 같이
    // null 을 먼저 넣고 호출하는 방식을 editor 참조에도 적용해 재호출 시 이중 destroy 를 막는다.
    docxAssert(!!cleanup, "cleanupDocxRender 함수를 찾지 못함(Block 2 선례 함수가 사라졌거나 이름이 바뀜)");
    docxAssert(/\.destroy\s*\(\s*\)/.test(cleanup), "cleanupDocxRender 안에 editor.destroy() 호출이 없음 — 이 함수 밖(removeTabsNow 등)에만 있으면 다른 호출 경로가 누수됨");
    const destroyAt = cleanup.search(/\.destroy\s*\(\s*\)/);
    const before = cleanup.slice(0, destroyAt);
    docxAssert(/=\s*null\s*;/.test(before), "destroy 호출 전에 editor 참조를 null로 비우지 않음 — 재호출 시 이중 destroy 위험(기존 docxRenderCancel 관용구 미준수)");
    return true;
  });

  card("T9", "다른 파일 타입 렌더 경로에는 이 블록의 명령 배선이 등장하지 않는다", () => {
    // "if (t.sheetMode)" 문자열을 못 찾으면 indexOf 가 -1 을 반환해 slice(-1)이 되고 사실상
    // 자동 통과한다. 그래서 찾은 인덱스를 먼저 확인한다.
    // 표 분기는 앱 셸의 renderFileViewBody 에서 분리됐다. 앱 셸은 viewer.renderBody 하나를
    // 호출하고 그린 쪽이 참을 반환한다. 그래서 격리가 두 겹이다. (1) 앱 셸의 렌더 경로는 표도
    // 문서도 모른다. (2) 표를 그리는 함수에 문서 명령 연결이 없다. 두 번째는 렌더러 전체가
    // 아니라 해당 모듈 집합만 봐야 이름 중복에 걸리지 않는다.
    docxAssert(/callHook\(\s*["']viewer\.renderBody["']/.test(render),
      "틀의 렌더 경로가 뷰어에게 이름으로 묻지 않음 — 화면 종류를 틀이 다시 알게 됐다");
    docxAssert(!/sheetMode|docxMode/.test(render),
      "틀의 렌더 경로가 뷰어의 칸 이름을 다시 안다 — 뷰어를 끄면 아무도 안 그리는 자리가 생긴다");
    const sheetBody = docxSourceFunction(capabilitySource("viewer"), "renderSheetViewBody");
    docxAssert(sheetBody.length > 200, `표 그리는 함수를 못 찾았다(${sheetBody.length} 글자) — 격리 검사 자체가 무효`);
    docxAssert(!/runToolbarCommand|toolbarCommandState|CHROME_GROUPS|CHROME_MENUS/.test(sheetBody),
      "sheet 렌더 분기에 docx 편집 UI 배선이 새어 들어감 — 파일타입 격리 위반");
    return true;
  });

  card("T10", "docx.read의 base64 응답이 Uint8Array/ArrayBuffer로 변환된 뒤에만 core에 전달된다", () => {
    // DocumentSource 는 ArrayBuffer | Uint8Array | DocumentHandle 뿐이고(editor-C8oaTHr3.d.ts
    // 확인) 문자열(base64)이나 Blob 은 허용되지 않는다. server/docx.js 의 docx.read 는 base64
    // 문자열을 반환하므로 브리지에서 디코드해야 조용한 실패를 막는다.
    docxAssert(/atob\s*\(/.test(docxPanel) && /Uint8Array/.test(docxPanel),
      "atob→Uint8Array 변환 코드가 없음 — base64 문자열을 그대로 core에 넘기면 DocumentSource 타입 계약 위반");
    const createAt = docxPanel.search(/createDocxEditor\s*\(|\.load\s*\(/);
    docxAssert(createAt >= 0, "createDocxEditor 또는 editor.load 호출이 없음");
    return true;
  });

  card("T14", "같은 탭 재로드는 기존 editor를 재사용하거나 정리 후 정확히 하나만 새로 만든다", () => {
    // 재시도/재로드 시 cleanup 없이 새 instance를 또 만들면 이중 mount·이중 destroy·
    // stale hyperlink handler 위험이 있다. editor.load(bytes) 재사용 또는 cleanupDocxRender→
    // createDocxEditor 순서 중 하나가 소스에 있어야 한다.
    const hasReuse = /\.load\s*\(/.test(docxPanel);
    const cleanupAt = docxPanel.search(/cleanupDocxRender\s*\(/);
    const createAt = docxPanel.search(/createDocxEditor\s*\(/);
    const hasCleanupThenCreate = cleanupAt >= 0 && createAt >= 0 && cleanupAt < createAt;
    docxAssert(hasReuse || hasCleanupThenCreate,
      "editor.load() 재사용도, cleanupDocxRender→createDocxEditor 순서도 없음 — 재로드 시 인스턴스가 중복 생성될 위험");
    return true;
  });

  // 확인 결과: "image.insert"/"table.insert" 문자열이 있어도 둘 다 runToolbarCommand(editor,
  // slotId)로 값 없이 dispatch 되어 "not wired to an editor command"가 돌아온다. 슬롯 문자열
  // 존재는 실제 동작을 증명하지 못한다.
  // core d.ts 확인: insertImage 는 executeImageCommand(editor, {type:'insertImage', data,
  // mime, widthPoints, heightPoints, ...})로 부르는 비동기 API 이고 runToolbarCommand 경로가
  // 아니다. 표 삽입도 generic runToolbarCommand 로는 트리거할 수 없는 별도 API 다.
  //
  // canInsertTable/insertTable 은 Editor 최상위가 아니라 editor.surface(PaginatedSurface)에
  // 선언돼 있다(index-gvw4VGE9.d.ts:2065/2070). editor.canInsertTable 을 부르면 브라우저에서
  // TypeError 가 난다. `editor.insertTable(` 과 `editor.surface.insertTable(` 을 모두 통과시키는
  // 정규식은 이 차이를 잡지 못하므로, 아래 오라클은 surface 경유를 강제한다.
  card("T15", "이미지 삽입 클릭이 실제로 executeImageCommand(editor,{type:'insertImage',...})를 호출한다", () => {
    docxAssert(/\.executeImageCommand\s*\(/.test(renderer), "executeImageCommand 호출이 없음 — image.insert가 여전히 generic runToolbarCommand로만 dispatch되고 있을 위험");
    const execAt = renderer.search(/\.executeImageCommand\s*\(/);
    const context = renderer.slice(Math.max(0, execAt - 800), execAt + 400);
    docxAssert(/type\s*:\s*["']insertImage["']/.test(context), "executeImageCommand 호출에 type:'insertImage' 커맨드 쉐이프가 없음");
    docxAssert(/\bdata\s*:/.test(context) && /\bmime\s*:/.test(context) && /widthPoints/.test(context) && /heightPoints/.test(context),
      "insertImage 커맨드에 data/mime/widthPoints/heightPoints 필드가 없음 — core 계약(editor-C8oaTHr3.d.ts)이 요구하는 최소 필드");
    docxAssert(/<input[^>]*type=["']file["']/.test(renderer) || /createElement\s*\(\s*["']input["']\s*\)/.test(renderer),
      "파일 선택 UI(file input)가 없음 — 이미지 바이트를 어디서 얻는지 불명");
    return true;
  });

  card("T16", "표 삽입 클릭이 rows/cols를 물어 editor.surface.insertTable(rows, cols)를 호출한다(surface 경유 — editor 최상위엔 없음)", () => {
    docxAssert(/\.surface\.insertTable\s*\(/.test(renderer), "editor.surface.insertTable(rows, cols) 호출이 없음 — insertTable/canInsertTable은 PaginatedSurface(editor.surface)에만 선언되어 있어 editor 최상위 호출은 런타임 TypeError가 남(Browser Test 확인)");
    docxAssert(/\.surface\.canInsertTable\s*\(/.test(renderer), "editor.surface.canInsertTable(rows, cols) 호출이 없음");
    const insertAt = renderer.search(/\.surface\.insertTable\s*\(/);
    const call = renderer.slice(insertAt, insertAt + 70);
    docxAssert(/insertTable\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*[A-Za-z_$][\w$]*\s*\)/.test(call), "insertTable 호출에 rows/cols 두 인자가 없음(하드코딩 없이 실제 값 전달 필요)");
    return true;
  });

  card("T17", "text.link 툴바 클릭은 링크 편집 바(docxShowLinkEditor)를 연다(generic dispatch 아님)", () => {
    docxAssert(!!docxSourceFunction(renderer, "docxShowLinkEditor") || /function\s+docxShowLinkEditor\s*\(/.test(renderer),
      "docxShowLinkEditor 함수가 없음(onRequest가 여는 링크 바 자체가 사라졌을 위험)");
    const wireToolbar = docxSourceFunction(renderer, "docxWireToolbar");
    const openMenu = docxSourceFunction(renderer, "docxOpenMenu");
    docxAssert(/text\.link[\s\S]{0,300}docxShowLinkEditor|docxShowLinkEditor[\s\S]{0,50}text\.link/.test(wireToolbar + openMenu)
      || /["']text\.link["'][\s\S]{0,400}docxShowLinkEditor/.test(renderer),
      "text.link 클릭이 docxShowLinkEditor를 호출하지 않음 — 툴바 링크 버튼이 generic runToolbarCommand로만 가서 죽어 있을 위험");
    return true;
  });
}


export default async function run() {
  await runDocxBlock6Checks();
}
