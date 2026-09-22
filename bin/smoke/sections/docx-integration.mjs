// 소유 범위: 통합 검증. 요구사항 커버리지와 round-trip 무결성.
// 제공 API: 이름 export runDocxBlock11Checks 와, DOCX-only 에서만 도는 기본 run.
// 의존 대상: core 의 공유 계수·옵션·파일 읽기, sources 의 소스 문자열, 90-docx-block1 의 helper.
// 유지 조건: 카드 아이디(`--docx-card=B5-T1` 로 사람이 직접 친다)와 검사 이름·문구.
//   91-docx-block5plus.mjs 에서 블록별로 분리한 파일이므로 본문을 그대로 유지한다.
// 영향 범위: 러너의 DOCX-only 분기와 90-docx-block1 의 helper 계약이 양방향으로 맞아야 한다.
//   현재 목록 확인: node bin/importers.mjs bin/smoke/sections/docx-integration.mjs
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";

import {
  cannotMeasure, check, DOCX_CARD, DOCX_ONLY, LIVE, read, ROOT,
} from "../core.mjs";
import { aiTabs, capabilitySource, css, dock, docxPanel, fileRouting, httpHandler, tabClose, renderer } from "../sources.mjs";
import {
  docxAliasedConcurrentWriteProbe, docxAssert, docxB5PackageInventory, docxB5WasmInventory, docxConcurrentWriteProbe, docxDispatchedHandler, docxHookedFunction, docxMessageBranch, docxRenderBranch, docxRichRoundTripProbe, docxRoundTripProbe, docxSizedWriteProbe, docxSourceFunction, docxWriteProbe,
} from "./90-docx-block1.mjs";

export async function runDocxBlock11Checks() {
  // kind 지식은 등록표(core/file-kinds.js · core/tab-views.js)에 있다. 새 뷰어를 추가하는
  // 사람이 앱 셸 파일을 열지 않게 하기 위해서다. 그래서 소스에 박힌 문자열이 아니라 등록표가
  // 답하는지를 확인한다.
  const fkm11 = await import(new URL("../../../web/js/core/file-kinds.js", import.meta.url).href);
  const { registerViewerKinds: reg11 } = await import(new URL("../../../web/js/viewer/kinds.js", import.meta.url).href);
  fkm11.clearFileKinds();
  reg11();
  const docxSpec11 = fkm11.fileKindOf("a.docx");
  // 탭 화면 등록은 그 기능의 initCapability 안에서 일어나 검사가 직접 호출하기엔 무겁다.
  // 대신 기능이 적어 둔 등록 구문을 읽는다. 기능 파일 목록은 등록표에서 파생한다.
  const { CAPABILITIES: CAPS11 } = await import(new URL("../../../web/js/core/capabilities.js", import.meta.url).href);
  const capSrc11 = CAPS11.flatMap((c) => (c.files || []).map((f) => read("web/js/" + f))).join("\n");
  if (capSrc11.length < 5000) cannotMeasure(`기능 소스를 못 읽었다: ${capSrc11.length} 글자`);
  const docxReg11 = capSrc11.match(/registerTabView\(\{[^}]*kind:\s*"docx"[^}]*\}\)/);
  const selected = DOCX_CARD.toUpperCase();
  if (selected && !selected.startsWith("B11-")) return;
  console.log("\n[DOCX Block 11 RED] 통합 검증 — 요구사항 커버리지 + round-trip 무결성");
  const card = (id, name, fn) => { if (!selected || selected === `B11-${id}`) check(`[DOCX-B11-${id}] ${name}`, fn); };

  // T1/T2 는 같은 파이프라인 실행 결과를 공유한다(자식 프로세스 1회). automation 편집이
  // 결정적이라 캐시해도 되고, 각 카드는 그 결과의 서로 다른 계약을 검사한다.
  let probeResult = null;
  const probe = () => (probeResult ||= docxRoundTripProbe());

  card("T1", "실제 편집기 엔진(automation host)으로 편집→save한 뒤 재열람하면 건드리지 않은 문단은 텍스트 수준에서 보존된다", () => {
    // 유효한 ZIP 인지만으로는 보존을 증명하지 못한다. @docx-editor.dev/core 의 서버 자동화
    // API(createServerAutomationHost)로 문서를 열고 5개 문단 중 1개(인덱스 1)만 insertText 로
    // 편집한 뒤 save()로 새 바이트를 얻고, 그 바이트를 fresh host 로 다시 열어 문단 텍스트를
    // 비교한다. 편집하지 않은 문단은 저장 전후 텍스트가 같아야 한다. sha256 은 문서 전체가
    // 재직렬화되어 달라지므로 바이트 동일은 이 엔진에서 성립하지 않고, 의미 수준 보존이
    // 판정 기준이다.
    const r = probe();
    docxAssert(!r._error, "automation round-trip probe 실행 실패: " + r._error);
    docxAssert(r.textsBeforeMatchesFixture === true, "최초 로드 시점부터 파서가 문단을 누락·재정렬함(fixture 원문과 불일치) — 이후 before/after 비교가 무의미해짐");
    docxAssert(r.editOk === true, "automation insertText 명령이 실패함");
    docxAssert(r.paraCountMatches === true, "저장→재열람 후 문단 개수가 달라짐(구조 손상)");
    docxAssert(r.untouchedPreserved === true, "편집하지 않은 문단(plain/서식/정렬 포함) 중 저장 전후 텍스트가 달라진 것이 있음");
    docxAssert(r.editedChanged === true, "편집 대상 문단이 실제로는 바뀌지 않음(테스트 자체가 무효 — positive control 실패)");
    docxAssert(r.originalVsEditedDiffer === true, "편집 전후 바이트가 완전히 동일함(save()가 실제로 재직렬화하지 않음 — 테스트 무효화 위험)");
    return true;
  });

  card("T2", "automation 편집 결과가 server/docx.js의 writeDocxRaw→readDocxRaw를 실제로 통과해도 무결성이 유지된다", () => {
    // T1 이 엔진 자체의 보존을 확인한다면, 이 카드는 Block 9(원자적 쓰기)·Block 7(revision
    // 프로토콜)이 그 편집 결과 바이트를 정확히 저장·재전송하는지 확인한다. 소스 패턴 매칭이
    // 아니라 실제 fs 임시파일에 writeDocxRaw 를 호출하고 readDocxRaw 로 되읽는다.
    const r = probe();
    docxAssert(!r._error, "automation round-trip probe 실행 실패: " + r._error);
    docxAssert(r.writeRevisionMatches === true, "writeDocxRaw 반환 revision이 저장된 바이트의 sha256과 다름");
    docxAssert(r.readRevisionMatches === true, "readDocxRaw가 돌려준 revision이 방금 쓴 바이트의 sha256과 다름");
    docxAssert(r.readBytesMatchWritten === true, "readDocxRaw로 재읽은 바이트가 writeDocxRaw에 준 바이트와 다름(원자적 쓰기 경로에서 손상)");
    return true;
  });

  card("T3", "편집 스코프 9개 카테고리 전부가 web/index.html에 구현 흔적을 남긴다(요구사항-코드 완전성 가드)", () => {
    // req/requirements.md(.working/ 아래, .gitignore:7 로 무시)를 직접 읽어 대조하지 않는다.
    // 그 워크스페이스는 세션이 끝나면 사라져 깨끗한 checkout·CI 에는 파일이 없고, 그러면 이
    // 카드가 항상 실패한다. 커밋되는 테스트가 gitignore 대상 파일에 의존해서는 안 된다
    // (workspace.md: `.working/` 은 세션 국지적 산출물).
    // 키워드 목록도 "실행취소/재실행"·"찾기·바꾸기"를 둘로 쪼개 개수만 맞추면, 정작
    // "텍스트"·"서식" 카테고리를 검사하지 않게 된다.
    //
    // 그래서 외부 req 파일에 의존하지 않고, 확정된 9개 카테고리(텍스트/서식/실행취소
    // 재실행/찾기바꾸기/목록/표/이미지/링크/모드전환, req/requirements.md:58-60)를 9개 항목으로
    // 나열해 각각 web/index.html(Block 6)의 구현 흔적을 대조한다. 개별 카테고리의 동작 검증은
    // Block 6 의 카드(T1~T18 부근, 특히 floor check 와 찾기바꾸기 전용 카드)가 이미 수행한다.
    // 이 카드는 9개 전부가 소스에 흔적을 남기는지만 하나로 모아 확인한다.
    const categoryToSourceHint = {
      텍스트: /["']text\.bold["']|["']text\.italic["']/,
      서식: /["']alignment\.center["']|["']paragraph\.format["']/,
      실행취소재실행: /["']history\.undo["']|["']history\.redo["']/,
      찾기바꾸기: /\.findMatches\s*\(/,
      목록: /["']list\.bullet["']|insertListParagraph/,
      표: /["']table\.insert["']/,
      이미지: /["']image\.insert["']/,
      링크: /["']text\.link["']|setHyperlink/,
      모드전환: /["']review\.editingMode["']/,
    };
    docxAssert(Object.keys(categoryToSourceHint).length === 9, "카테고리 목록 자체가 9개가 아님(가드 정의 오류)");
    for (const [category, re] of Object.entries(categoryToSourceHint)) {
      docxAssert(re.test(renderer), `확정된 카테고리 "${category}"에 대응하는 구현 흔적을 web/index.html에서 찾지 못함`);
    }
    return true;
  });

  card("T4", "복합 fixture(서식·표·목록·이미지·hyperlink)에서 sentinel 문단만 편집해도 나머지 요소는 각자의 표현 수준에서 보존된다", () => {
    // T1 은 getText()만 보므로 bold/italic/정렬 같은 run·paragraph 속성이 사라져도, 표·목록·
    // 이미지·hyperlink 가 fixture 에 없어 관련 손상을 탐지하지 못한다. core 직렬화기는 파싱된
    // 모든 XML part 를 재작성하므로(원본 binary part 만 복사) 표·drawing·numbering.xml·rels
    // 전부가 독립적인 손상 표면이다.
    //
    // 그래서 표(2셀)·불릿 목록(2항목)·이미지(media part)·외부 hyperlink·bold/italic/가운데
    // 정렬 문단이 모두 있는 fixture 를 만들어 sentinel 문단 하나만 편집·저장·재열람하고, 각
    // 요소를 표현에 맞는 방법으로 확인한다. bold/italic/정렬은 getFont/getParagraphFormat 으로
    // 서식 속성을 조회하고, 표·목록·hyperlink 텍스트는 getText 로 보고, 이미지는 media part 의
    // sha256 을 대조한다(자동화 API 가 drawing 을 노출하지 않아 JSZip 으로 zip 내부를 연다).
    // numbering.xml·rels 도 같은 방식으로 원문과 대조한다.
    const r = docxRichRoundTripProbe();
    docxAssert(!r._error, "복합 fixture round-trip probe 실행 실패: " + r._error);
    docxAssert(r.paraCountMatches === true, "저장→재열람 후 문단(표 셀 포함) 개수가 달라짐(구조 손상)");
    docxAssert(r.sentinelEditApplied === true, "sentinel 문단이 실제로는 편집되지 않음(positive control 실패 — 테스트 자체가 무효)");
    docxAssert(r.boldPreserved === true, "편집 안 한 문단의 bold 서식이 저장 전후 보존되지 않음");
    docxAssert(r.italicPreserved === true, "편집 안 한 문단의 italic 서식이 저장 전후 보존되지 않음");
    docxAssert(r.alignmentPreserved === true, "편집 안 한 문단의 가운데 정렬이 저장 전후 보존되지 않음");
    docxAssert(r.tableCellsPreserved === true, "편집 안 한 표의 셀 텍스트가 저장 전후 보존되지 않음");
    docxAssert(r.bulletTextsPreserved === true, "편집 안 한 불릿 목록 항목 텍스트가 저장 전후 보존되지 않음");
    docxAssert(r.mediaNamesMatch === true, "저장 전후 media part 목록(이름)이 달라짐");
    docxAssert(r.mediaHashesMatch === true, "편집 안 한 이미지의 media part sha256이 저장 전후 달라짐(이미지 손상)");
    docxAssert(r.numberingPreserved === true, "word/numbering.xml이 저장 전후 바뀜(목록 정의 손상)");
    docxAssert(r.hyperlinkRelPreservedBefore === true && r.hyperlinkRelPreservedAfter === true,
      "hyperlink relationship(word/_rels/document.xml.rels)의 대상 URL이 저장 전후 사라짐");
    docxAssert(r.hyperlinkTextPreserved === true, "hyperlink 텍스트가 저장 전후 보존되지 않음");
    // req/requirements.md:161-162가 명시하는 대표 fixture 구성요소(머리글/바닥글/페이지 번호)를
    // getFurniture(자동화 API)로 header/footer 본문 텍스트를 직접 조회해 보존을 확인한다.
    docxAssert(r.headerPreserved === true, "머리글(header) 텍스트가 저장 전후 보존되지 않음");
    docxAssert(r.footerPreserved === true, "바닥글(footer)의 페이지 번호 필드가 저장 전후 보존되지 않음");
    return true;
  });

  // T5(9개 카테고리를 vendored 브라우저 편집기로 하나씩 실행해 editor.save()→docx.write→
  // 재열람까지 사용자 경로로 검증하는 acceptance matrix)는 DOM·브라우저 엔진 조작이 핵심이라
  // code_test 로 할 수 없다. verify_method: browser_test 로 Feature Validation/Browser Test
  // 단계에 이연한다(키워드 검사로 대체하지 않는다). 카드 정의는 다음과 같다.
  // fixture(T4와 동일한 복합 문서)를 Iris 로 열고 텍스트 입력→굵게/기울임 토글→표 삽입→이미지
  // 삽입→불릿 목록 토글→hyperlink 삽입→실행취소/재실행→찾기·바꾸기→편집/보기 모드 전환까지 9개
  // 행을 순서대로 조작한 뒤 저장하고, 탭을 닫았다 다시 열어 각 행의 결과가 화면에 반영돼
  // 있는지 확인한다.

  // T6~T9는 3개 MISSED(댓글 UI 노출, 확대/축소 미배선, 인쇄 부재)와 1개 PARTIAL(file.save 버튼이
  // core의 enabled 판정에 막혀 실제 저장 핸들러에 도달 못함)에 대한 수정을 회귀 방지로 고정한다.

  card("T6", "댓글(review.comments)은 core 그룹에 실재해도 렌더되지도, 클릭해도 dispatch되지 않는다(제외 대상)", () => {
    // 댓글·추적변경·제안모드는 제외한다. CHROME_GROUPS 를 필터 없이 렌더하면 review.comments
    // 버튼이 노출·동작한다(설치된 core 의 review 그룹이 comments 와 editingMode 를 함께 노출).
    // DOCX_EXCLUDED_SLOTS 로 렌더링 단계에서 걸러내는지 검사한다.
    const docxToolbarHtml = docxSourceFunction(renderer, "docxToolbarHtml");
    docxAssert(docxToolbarHtml, "docxToolbarHtml 함수를 찾지 못함");
    docxAssert(/DOCX_EXCLUDED_SLOTS/.test(docxToolbarHtml), "docxToolbarHtml이 DOCX_EXCLUDED_SLOTS로 컨트롤을 거르지 않음");
    const excludedDecl = renderer.match(/const DOCX_EXCLUDED_SLOTS\s*=\s*new Set\(\[([^\]]*)\]\)/);
    docxAssert(excludedDecl, "DOCX_EXCLUDED_SLOTS 선언을 찾지 못함");
    docxAssert(/review\.comments/.test(excludedDecl[1]), "DOCX_EXCLUDED_SLOTS에 review.comments가 없음 — 댓글이 여전히 노출될 위험");
    return true;
  });

  card("T7", "확대/축소(zoom.level)는 editor.setZoom()을 호출하고, 버튼이 실제로 클릭 가능하다(core는 zoom.level을 disabled로 보고함 — enabled 강제 우회 필요)", () => {
    // setZoom()/getZoom() 호출 코드만 추가하면 부족하다. 설치된 core 는 zoom.level 을
    // {enabled:false, disabledReason: "not wired to an editor command"}로 보고하고,
    // docxRefreshChrome 이 file.save 만 enabled 를 강제하면 zoom.level 은 disabled 로 렌더된다.
    // 그러면 툴바 클릭 가드가 disabled 버튼에서 반환해 setZoom 분기에 도달하지 못한다.
    // setZoom() 문자열 존재만 검사하면 도달 가능성을 보지 못해 잘못된 통과가 된다.
    const docxRunSpecialChromeSlot = docxSourceFunction(renderer, "docxRunSpecialChromeSlot");
    docxAssert(docxRunSpecialChromeSlot, "docxRunSpecialChromeSlot 함수를 찾지 못함");
    docxAssert(/slotId\s*===\s*["']zoom\.level["']/.test(docxRunSpecialChromeSlot), "zoom.level 특수 처리 분기가 없음");
    docxAssert(/\.setZoom\s*\(/.test(docxRunSpecialChromeSlot), "zoom.level 분기가 editor.setZoom()을 호출하지 않음");
    const ownedDecl = renderer.match(/const DOCX_IRIS_OWNED_ENABLED_SLOTS\s*=\s*new Set\(\[([^\]]*)\]\)/);
    docxAssert(ownedDecl, "DOCX_IRIS_OWNED_ENABLED_SLOTS 선언을 찾지 못함");
    docxAssert(/zoom\.level/.test(ownedDecl[1]), "DOCX_IRIS_OWNED_ENABLED_SLOTS에 zoom.level이 없음 — 버튼이 core의 disabled 판정에 막혀 클릭 불가할 위험");
    const docxRefreshChrome = docxSourceFunction(renderer, "docxRefreshChrome");
    docxAssert(docxRefreshChrome && /\.getZoom\s*\(\s*\)/.test(docxRefreshChrome), "docxRefreshChrome이 editor.getZoom()으로 현재 배율을 표시하지 않음(값 표시가 core 일반 체계로 안 채워짐)");
    docxAssert(/DOCX_IRIS_OWNED_ENABLED_SLOTS\.has\(slotId\)\s*\?\s*true\s*:\s*state\.enabled/.test(docxRefreshChrome),
      "docxRefreshChrome의 enabled 계산이 DOCX_IRIS_OWNED_ENABLED_SLOTS를 쓰지 않음 — zoom.level이 core의 disabled 판정에 막혀 클릭 가드를 못 넘을 위험");
    return true;
  });

  card("T8", "저장(file.save) 버튼은 core의 자체 enabled 판정에 막히지 않고 항상 클릭 가능하다 — 저장은 core가 아니라 Iris가 소유한다", () => {
    // file.save 의 core state.kind 는 "save"(core 내부 저장 개념)라 toolbarCommandState 가
    // disabled 로 판정하면, 클릭 핸들러가 docxRunSpecialChromeSlot(실제 docxSaveTab 호출)에
    // 도달하기 전에 반환해 화면의 저장 버튼이 동작하지 않는다. Ctrl/Cmd+S 단축키는 별도
    // 경로라 영향을 받지 않아 이 결함이 스모크에 드러나지 않는다.
    const ownedDecl = renderer.match(/const DOCX_IRIS_OWNED_ENABLED_SLOTS\s*=\s*new Set\(\[([^\]]*)\]\)/);
    docxAssert(ownedDecl, "DOCX_IRIS_OWNED_ENABLED_SLOTS 선언을 찾지 못함");
    docxAssert(/file\.save/.test(ownedDecl[1]), "DOCX_IRIS_OWNED_ENABLED_SLOTS에 file.save가 없음");
    const docxRefreshChrome = docxSourceFunction(renderer, "docxRefreshChrome");
    docxAssert(docxRefreshChrome, "docxRefreshChrome 함수를 찾지 못함");
    docxAssert(/DOCX_IRIS_OWNED_ENABLED_SLOTS\.has\(slotId\)\s*\?\s*true\s*:\s*state\.enabled/.test(docxRefreshChrome),
      "docxRefreshChrome이 file.save를 core enabled 판정과 무관하게 항상 true로 처리하지 않음");
    const docxOpenMenu = docxSourceFunction(renderer, "docxOpenMenu");
    docxAssert(docxOpenMenu && /DOCX_IRIS_OWNED_ENABLED_SLOTS\.has\(slotId\)\s*\?\s*true\s*:\s*state\.enabled/.test(docxOpenMenu),
      "docxOpenMenu(파일 메뉴)도 file.save를 core enabled 판정과 무관하게 항상 true로 처리해야 함(툴바만 고치면 메뉴 경로가 여전히 막힘)");
    return true;
  });

  card("T9", "인쇄 진입점이 실제로 존재하고 window.print()를 호출한다(core는 인쇄 컨트롤을 전혀 제공하지 않음)", () => {
    // CHROME_GROUPS/CHROME_MENUS 어디에도 print 계열 슬롯이 없어 Iris 가 직접 진입점을
    // 만든다. sheet 뷰어의 기존 방식(svToolbar 의 case "print": window.print())을 그대로
    // 따른다.
    docxAssert(/DOCX_PRINT_SLOT\s*=\s*["']iris\.print["']/.test(renderer), "DOCX_PRINT_SLOT 선언을 찾지 못함");
    const docxOpenMenu = docxSourceFunction(renderer, "docxOpenMenu");
    docxAssert(docxOpenMenu, "docxOpenMenu 함수를 찾지 못함");
    docxAssert(/slotId\s*===\s*DOCX_PRINT_SLOT[\s\S]{0,60}window\.print\s*\(\s*\)/.test(docxOpenMenu),
      "docxOpenMenu가 인쇄 슬롯 클릭 시 window.print()를 호출하지 않음");
    const docxMenuEntriesForMenu = docxSourceFunction(renderer, "docxMenuEntriesForMenu");
    docxAssert(docxMenuEntriesForMenu && /DOCX_PRINT_SLOT/.test(docxMenuEntriesForMenu),
      "file 메뉴 엔트리 목록에 인쇄 항목이 실제로 추가되지 않음");
    return true;
  });

  card("T10", "링크 삽입(text.link) 버튼은 core의 자체 enabled 판정에 막히지 않고 항상 클릭 가능하다 — 하이퍼링크 진입은 core 명령 체계가 아니라 Iris의 docxShowLinkEditor가 소유한다", () => {
    // core 의 toolbarCommandState 는 text.link 를 항상 disabledReason:"not wired to an editor
    // command"로 보고한다(core 의 하이퍼링크 진입은 onRequestHyperlink 콜백/Ctrl+K 전용이고
    // runToolbarCommand 대상이 아니다). zoom.level/file.save 용으로 만든 공유 우회
    // DOCX_IRIS_OWNED_ENABLED_SLOTS 에 text.link 를 넣지 않으면 링크 버튼이 실사용 경로에서
    // 계속 비활성 상태가 된다.
    const ownedDecl = renderer.match(/const DOCX_IRIS_OWNED_ENABLED_SLOTS\s*=\s*new Set\(\[([^\]]*)\]\)/);
    docxAssert(ownedDecl, "DOCX_IRIS_OWNED_ENABLED_SLOTS 선언을 찾지 못함");
    docxAssert(/text\.link/.test(ownedDecl[1]), "DOCX_IRIS_OWNED_ENABLED_SLOTS에 text.link가 없음 — 링크 버튼이 core의 disabled 판정에 막혀 클릭 불가할 위험");
    const docxRefreshChrome = docxSourceFunction(renderer, "docxRefreshChrome");
    docxAssert(docxRefreshChrome && /DOCX_IRIS_OWNED_ENABLED_SLOTS\.has\(slotId\)\s*\?\s*true\s*:\s*state\.enabled/.test(docxRefreshChrome),
      "docxRefreshChrome의 enabled 계산이 DOCX_IRIS_OWNED_ENABLED_SLOTS를 쓰지 않음 — text.link가 core의 disabled 판정에 막혀 클릭 가드를 못 넘을 위험");
    return true;
  });

  card("T11", "docx 편집기 마운트 직후 editor.focus()를 호출한다 — 안 부르면 사용자가 처음 입력하기 전까지 캐럿(깜빡이는 커서)이 안 보인다", () => {
    // 확인 결과: 새로 연 문서는 클릭해도 캐럿이 보이지 않고 첫 글자를 입력해야 나타난다.
    // createDocxEditor() 직후 focus()를 부르지 않아 core 의 캐럿 오버레이가 그려지지 않는다.
    // core 의 focus()는 InteractionOutcome 을 반환하는 API 라(레이아웃이 끝나지 않으면
    // ok:false, code:"pendingLayout") 1회 호출로는 부족하고 재시도가 필요하다.
    const renderDocxContent = docxSourceFunction(docxPanel, "renderDocxContent");
    docxAssert(renderDocxContent, "renderDocxContent 함수를 찾지 못함");
    // 재시도를 도우미 함수로 묶으면서 호출 대상 이름이 editor 가 아니라 ed 가 됐다. 이름이
    // 아니라 동작을 검사한다. 결과를 보고 pendingLayout 이면 다음 프레임에 다시 호출한다.
    const focusAt = renderDocxContent.search(/\.focus\(\)/);
    docxAssert(focusAt >= 0, "renderDocxContent 안에 focus() 호출이 없음 — 마운트 직후 캐럿이 안 보일 위험");
    docxAssert(/\.ok\b/.test(renderDocxContent.slice(focusAt, focusAt + 200)),
      "focus() 결과를 안 본다 — 레이아웃 미완료로 실패해도 그냥 지나갈 위험");
    docxAssert(/pendingLayout/.test(renderDocxContent),
      "focus() 실패(pendingLayout) 재시도 로직이 없음 — 첫 시도가 레이아웃 미완료로 실패하면 캐럿이 계속 안 보일 위험");
    docxAssert(/requestAnimationFrame/.test(renderDocxContent),
      "다음 프레임에 다시 거는 자리가 없음 — 한 번 실패하면 그대로 끝난다");
    // 새로 만드는 경로와 돌아와 다시 붙이는 경로 둘 다 확인해야 한다. 붙이는 쪽에만 없으면
    // 탭을 오갈 때마다 캐럿이 보이지 않는다.
    const retryName = renderDocxContent.match(/const\s+([A-Za-z_$][\w$]*)\s*=\s*\([^)]*\)\s*=>\s*\{[\s\S]{0,200}?\.focus\(\)/);
    docxAssert(retryName, "focus 재시도를 묶은 도우미를 찾지 못함");
    const calls = [...renderDocxContent.matchAll(new RegExp(`\\b${retryName[1]}\\s*\\(`, "g"))].length;
    docxAssert(calls >= 3, `focus 재시도를 ${calls - 1} 곳에서만 건다 — 새로 만드는 길과 다시 붙이는 길 둘 다여야 한다`);
    return true;
  });

  card("T12", "docx 편집기 셸은 fileview 가장자리에 꽉 붙지 않고 여백+테두리로 경계가 있다(라운드는 없음)", () => {
    // 확인 결과: .docx-editor-shell 이 fileview 에 inset:0 으로 채워져 양옆 여백이 없었다.
    // browserview(.browserview{padding:8px})와 같은 간격을 준다. 라운드는 버튼에만 두므로
    // radius 는 넣지 않는다.
    const docxSheet = css("14-sheet-edit");
    const shellRule = docxSheet.match(/\.docx-editor-shell\s*\{[^}]*\}/);
    docxAssert(shellRule, ".docx-editor-shell CSS 규칙을 찾지 못함");
    docxAssert(/margin\s*:\s*8px/.test(shellRule[0]), ".docx-editor-shell에 margin이 없음 — fileview 가장자리에 꽉 붙어 경계가 안 보일 위험");
    docxAssert(/border\s*:\s*1px solid/.test(shellRule[0]), ".docx-editor-shell에 border가 없음 — 좌우 경계선이 안 보일 위험");
    docxAssert(!/border-radius/.test(shellRule[0]), ".docx-editor-shell에 border-radius가 있음 — 모서리 라운드는 제외 대상이다");
    return true;
  });

  card("T13", "실행취소로 원본과 완전히 같은 내용이 되면(revision은 안 줄어도) dirty가 해시 비교로 정확히 꺼진다", () => {
    // 확인 결과: 수정을 모두 되돌려도 계속 수정된 것으로 취급됐다. core 의 revision 은
    // 단조증가 카운터라 실행취소로 원본과 바이트가 같아져도 줄지 않는다. mount 시점 로드
    // bytes 와 저장 성공 시 저장 bytes 를 SHA-256 으로 기준선(docxSavedHash) 삼고, 타이핑이 멎은
    // 뒤(디바운스) 현재 내용을 다시 export 해 같은 해시인지 비교한다. 비교 결과가 지금 이
    // revision 에 대한 것일 때만(docxHashCheckedRevision 일치) dirty 를 끄는 데 쓴다. 그 사이 새
    // 편집이 있었으면 오래된 일치 판정이 새 편집을 가리므로 무시한다.
    // 이 판정은 앱 셸에서 분리됐다. 앱 셸의 isTabDirty 는 글자 편집만 알고, 그 밖은 이름
    // 하나로 뷰어에게 질의한다(viewer.tabDirty). 연결을 양쪽에서 확인한다.
    const frameDirty = docxSourceFunction(renderer, "isTabDirty");
    docxAssert(frameDirty && /callHook\(\s*["']viewer\.tabDirty["']/.test(frameDirty),
      "틀이 저장 안 한 편집을 뷰어에게 묻지 않음 — 뷰어의 칸 이름을 틀이 다시 알게 됐다");
    const docxDirty = docxHookedFunction(capabilitySource("viewer"), "viewer.tabDirty", "docx");
    docxAssert(docxDirty, "viewer.tabDirty 를 채우는 쪽에서 문서 판정을 찾지 못함");
    // 지역 이름(fast·hashFresh)은 구현 자유다. 검사하는 것은 셋이다. 되돌려도 줄지 않는
    // revision 으로 먼저 걸러내고, 해시 판정을 지금 이 revision 에 묶고, 마지막 결합에서 해시가
    // fast path 를 덮는다. 결합하지 않으면 변수만 계산하고 쓰지 않는 것과 같다.
    docxAssert(/getDocumentHandle\(\)\.revision\s*!==/.test(docxDirty),
      "되돌려도 안 줄어드는 revision 비교(fast path)가 없음");
    docxAssert(/docxHashCheckedRevision\s*===[\s\S]{0,80}?getDocumentHandle\(\)\.revision/.test(docxDirty),
      "해시 판정이 '지금 이 revision'에 대한 것인지 확인하지 않음 — 새 편집 이후에도 오래된 '일치' 판정으로 dirty가 잘못 꺼질 위험");
    docxAssert(/return[^;]*&&\s*!\([^;]*docxHashMatchesSaved[^;]*\)/.test(docxDirty),
      "마지막 결합이 해시 결과로 fast path 를 덮지 않음 — 실행취소로 원본과 같아져도 dirty가 안 꺼질 위험");
    const scheduleFn = docxSourceFunction(renderer, "docxScheduleHashRecheck");
    docxAssert(scheduleFn, "docxScheduleHashRecheck 함수를 찾지 못함 — 재확인이 스케줄되지 않음");
    docxAssert(/setTimeout/.test(scheduleFn), "docxScheduleHashRecheck가 디바운스(setTimeout) 없이 매번 즉시 실행됨 — 큰 문서에서 타이핑마다 export 비용이 붙어 버벅일 위험");
    const changeHandlerIdx = renderer.indexOf('editor.on("change"');
    docxAssert(changeHandlerIdx !== -1, 'editor.on("change", ...) 등록 지점을 찾지 못함');
    const changeHandlerSlice = renderer.slice(changeHandlerIdx, changeHandlerIdx + 500);
    docxAssert(/docxScheduleHashRecheck\(t, editor\)/.test(changeHandlerSlice),
      "change 핸들러가 docxScheduleHashRecheck를 호출하지 않음 — 편집할 때마다 재확인이 예약되지 않아 실행취소 후에도 dirty가 안 꺼질 위험");
    const saveTab = docxSourceFunction(renderer, "docxSaveTab");
    docxAssert(saveTab && /t\.docxSavedHash\s*=\s*await hashPromise/.test(saveTab),
      "docxSaveTab이 저장 성공 시 docxSavedHash 기준선을 갱신하지 않음 — 저장 이후의 실행취소 비교 기준이 옛 파일 그대로 남아있을 위험");
    return true;
  });

  card("T14", "docx/sheet 상단 도구 바 자체는 라운드가 없다(개별 버튼 라운드는 유지)", () => {
    // 도구 바 둘 다 라운드를 빼고 버튼만 남긴다. .gd-tb/.gs-tb 컨테이너 자체가 24px pill
    // 라운드였다. 버튼 각각의 라운드(.gd-tb button/.gs-tb button)는 그대로 둔다.
    const docxSheet = css("14-sheet-edit");
    const gdTbRule = docxSheet.match(/\.gd-tb\s*\{[^}]*\}/);
    docxAssert(gdTbRule, ".gd-tb CSS 규칙을 찾지 못함");
    docxAssert(!/border-radius/.test(gdTbRule[0]), ".gd-tb 컨테이너에 여전히 border-radius가 있음 — 상단 도구 바 자체가 둥글게 보일 위험");
    const gsTbRule = docxSheet.match(/\.gs-tb\s*\{[^}]*\}/);
    docxAssert(gsTbRule, ".gs-tb CSS 규칙을 찾지 못함");
    docxAssert(!/border-radius/.test(gsTbRule[0]), ".gs-tb 컨테이너에 여전히 border-radius가 있음 — 상단 도구 바 자체가 둥글게 보일 위험");
    docxAssert(/\.gd-tb button\s*\{[^}]*border-radius/.test(docxSheet), ".gd-tb button 개별 라운드가 사라짐 — 버튼 라운드는 유지한다");
    docxAssert(/\.gs-tb button\s*\{[^}]*border-radius/.test(docxSheet), ".gs-tb button 개별 라운드가 사라짐 — 버튼 라운드는 유지한다");
    return true;
  });

  card("T15", "아이콘 없는 텍스트 전용 도구 버튼도 라벨 앞에 공백 텍스트 노드가 안 남는다(중앙 정렬 어긋남 방지)", () => {
    // 확인 결과: docxToolbarHtml 의 버튼 템플릿이 여는 태그 뒤에 줄바꿈과 들여쓰기를 두어,
    // 아이콘이 없는 컨트롤(docxControlIcon 이 빈 문자열)에서 그 공백이 라벨 앞 텍스트 노드로
    // 남아 중앙 정렬이 어긋났다.
    const toolbarFn = docxSourceFunction(renderer, "docxToolbarHtml");
    docxAssert(toolbarFn, "docxToolbarHtml 함수를 찾지 못함");
    // 아이콘 값이 변수로 바뀌면서 그 자리의 문자열도 바뀌었다(docxControlIcon(control) → icon).
    // 검사 대상은 무엇을 끼우는가가 아니라 그 양 끝에 공백이 없는가다. 공백이 텍스트 노드로
    // 남으면 중앙 정렬이 어긋난다.
    const buttons = [...toolbarFn.matchAll(/<button[\s\S]{0,1500}?<\/button>/g)].map((m) => m[0]);
    docxAssert(buttons.length, "도구 바 버튼 템플릿을 찾지 못함");
    for (const btn of buttons) {
      const open = btn.match(/^<button[^>]*>/);
      docxAssert(open && /\$\{$/.test(btn.slice(0, open[0].length + 2)),
        "버튼 여는 태그 '>' 바로 뒤가 값이 아니다 — 줄바꿈·들여쓰기가 라벨 앞 공백 텍스트 노드로 남는다");
      docxAssert(/\}<\/button>$/.test(btn),
        "버튼 닫는 태그 앞이 값이 아니다 — 그 공백이 마지막 자식 텍스트 노드로 남는다");
    }
    return true;
  });

  card("T16", "docx 탭은 kind:\"docx\"로 만들어지고 docxview 패널에 그려진다(fileview 아님) — 스페이스 브라우저 탭처럼", () => {
    // 확인 결과: kind 를 "file"로 둔 채 시각적 프레이밍만 바꾸면 스페이스 브라우저가 아니라
    // 뷰어에 뜬다. kind 자체를 "docx"로 분리하고 렌더 패널도 fileview 가 아니라 새 docxview 로
    // 옮긴다.
    // 화면은 HTML 스켈레톤이 아니라 기능이 뜰 때 만든다. 로드되지 않은 기능의 화면은 없다.
    docxAssert(/ensureTabViewPane\(\{ panelId: "docxview" \}\)/.test(read("web/js/viewer/boot.js")), "docx 기능이 docxview 화면을 만들지 않음");
    const makeFileTab = docxSourceFunction(renderer, "makeFileTab");
    docxAssert(makeFileTab && /fileKindOf\s*\(/.test(makeFileTab),
      "makeFileTab 이 종류를 등록표에 묻지 않음 — 틀이 확장자를 알게 되면 새 뷰어마다 이 파일을 연다");
    docxAssert(makeFileTab && /tabKind/.test(makeFileTab),
      "makeFileTab 이 표가 준 tabKind 를 안 씀");
    docxAssert(docxSpec11 && docxSpec11.tabKind === "docx",
      "등록표가 .docx 에 kind \"docx\" 를 안 줌 — 여전히 kind:\"file\"이면 fileview로 감");
    const renderDocxPanelBody = docxSourceFunction(docxPanel, "renderDocxPanelBody");
    docxAssert(renderDocxPanelBody, "renderDocxPanelBody 함수가 없음 — docx 전용 렌더 경로가 분리되지 않음");
    docxAssert(/docxview\.innerHTML/.test(renderDocxPanelBody), "renderDocxPanelBody가 docxview가 아닌 다른 곳에 씀");
    const renderFileViewBody = docxSourceFunction(renderer, "renderFileViewBody");
    docxAssert(renderFileViewBody && !/t\.docxMode/.test(renderFileViewBody),
      "renderFileViewBody에 여전히 docx 분기가 남아있음 — docx가 fileview로도 렌더될 위험(이중 렌더/불일치)");
    return true;
  });

  card("T17", "탭 전환(showActiveTab)이 kind:\"docx\"일 때 docxview를 보이고 renderDocxPanelBody를 부른다", () => {
    const showActiveTab = docxSourceFunction(renderer, "showActiveTab");
    docxAssert(showActiveTab, "showActiveTab 함수를 찾지 못함");
    // 앱 셸은 종류 이름을 알지 않고, 등록된 화면을 돌며 자기 종류일 때만 보이고 자기 render 를
    // 호출한다. 그래서 앱 셸이 표를 순회하는지와 표가 docx 에 화면과 렌더 함수를 주는지를 본다.
    docxAssert(/ensureTabViewPane\(view\)/.test(showActiveTab) && /hidden\s*=\s*!\(t\s*&&\s*t\.kind\s*===\s*view\.kind\)/.test(showActiveTab),
      "탭 전환이 등록된 화면을 돌며 켜고 끄지 않음 — 탭을 눌러도 안 뜨거나 이전 화면이 남을 위험");
    docxAssert(/view\.render\s*\(/.test(showActiveTab.replace(/\n/g, " ")),
      "탭 전환이 그 종류의 그리는 함수를 부르지 않음");
    docxAssert(docxReg11, "docx 종류를 아무도 등록표에 등록하지 않음");
    docxAssert(/panelId:\s*"docxview"/.test(docxReg11[0]), "docx 등록이 docxview 화면을 안 가리킴");
    docxAssert(/render:/.test(docxReg11[0]), "docx 등록에 그리는 함수가 없음");
    return true;
  });

  card("T18", "docx.read/docx.write 서버 응답이 탭을 찾는 경로(tabIoOwner)와 저장(saveActiveFile)·외부변경(dir-changed)·재타겟(retargetFileTabs) 경로가 kind:\"docx\"도 file과 동일하게 처리한다", () => {
    // kind 를 "file"에서 "docx"로 분리할 때 가장 위험한 지점이다. 이 경로들을 고치지 않으면
    // "열리는데 저장 응답을 못 찾음"·"외부 변경 감지 안 됨"·"Cmd+S가 아무 반응 없음"이 된다.
    docxAssert(/const isFileLikeKind\s*=\s*\(k\)\s*=>\s*k\s*===\s*"file"\s*\|\|\s*isFileLikeTabKind\(k\)/.test(renderer),
      "file 처럼 다루는 종류를 틀이 손으로 세고 있음 — 그 판단은 등록표의 것이다");
    docxAssert(docxReg11 && /fileLike:\s*true/.test(docxReg11[0]),
      "docx 등록이 file 처럼 다루라고 밝히지 않음 — docx.read/write 응답이 탭을 못 찾을 위험");
    docxAssert(/\.find\(\(x\) => isFileLikeKind\(x\.kind\) && x\.path === path\)/.test(renderer),
      "WS 응답 라우팅(tabIoOwner류)이 isFileLikeKind를 쓰지 않음 — docx.read/write 응답이 탭을 못 찾을 위험");
    const saveActiveFile = docxSourceFunction(renderer, "saveActiveFile");
    docxAssert(saveActiveFile && /isFileLikeKind\(t\.kind\)/.test(saveActiveFile),
      "saveActiveFile이 isFileLikeKind를 안 씀 — docx 탭에서 Cmd+S/저장 버튼이 아무 반응 없을 위험");
    const syncWatchDirs = docxSourceFunction(renderer, "syncWatchDirs");
    docxAssert(syncWatchDirs && /isFileLikeKind\(t\.kind\)/.test(syncWatchDirs),
      "syncWatchDirs가 isFileLikeKind를 안 씀 — docx 파일의 외부 변경 감시가 안 걸릴 위험");
    const retargetFileTabs = docxSourceFunction(renderer, "retargetFileTabs");
    docxAssert(retargetFileTabs && /isFileLikeKind\(t\.kind\)/.test(retargetFileTabs),
      "retargetFileTabs가 isFileLikeKind를 안 씀 — docx 파일이 밖에서 이름바뀜/이동돼도 탭이 안 따라갈 위험");
    docxAssert(/if \(!isFileLikeKind\(ft\.kind\) \|\| !ft\.path \|\| chSeen\.has\(ft\.path\)\) continue;/.test(renderer),
      'dir-changed WS 핸들러가 isFileLikeKind를 안 씀 — docx 파일이 밖에서 바뀌어도 배너/재로드가 안 걸릴 위험');
    return true;
  });

  card("T19", "docx 클릭·키보드 핸들러(찾기·바꾸기·링크·모드전환·메뉴)가 docxview에도 붙는다 — fileview에만 델리게이트돼 있으면 docx로 옮긴 뒤 전부 무반응이 된다", () => {
    docxAssert(/function fileviewClickHandler\(e\) \{/.test(renderer), "fileviewClickHandler가 이름 붙은 함수로 분리되지 않음");
    docxAssert(/fileview\.addEventListener\("click", fileviewClickHandler\)/.test(renderer), "fileview에 fileviewClickHandler가 안 붙음");
    docxAssert(/docxview\.addEventListener\("click", fileviewClickHandler\)/.test(renderer), "docxview에 fileviewClickHandler가 안 붙음 — docx 패널 안 클릭(찾기/바꾸기·링크·모드전환·메뉴)이 전부 무반응일 위험");
    docxAssert(/function fileviewKeydownHandler\(e\) \{/.test(renderer), "fileviewKeydownHandler가 이름 붙은 함수로 분리되지 않음");
    docxAssert(/docxview\.addEventListener\("keydown", fileviewKeydownHandler\)/.test(renderer), "docxview에 fileviewKeydownHandler가 안 붙음 — 메뉴 키보드 탐색이 docx 패널에서 무반응일 위험");
    // 앱 셸에도 같은 이름의 글자 탭 핸들러가 있다. 렌더러 전체에서 이름으로 찾으면 첫 번째인
    // 앱 셸 것을 집어 뷰어 계약을 앱 셸 함수로 검사하게 된다. 이 모듈 집합만 본다.
    const clickHandler = docxSourceFunction(capabilitySource("viewer"), "fileviewClickHandler");
    docxAssert(clickHandler && /isFileLikeKind\(t\.kind\)/.test(clickHandler),
      "fileviewClickHandler의 최상단 가드가 isFileLikeKind를 안 씀 — kind가 \"docx\"인 탭에서 이 핸들러가 즉시 return할 위험");
    return true;
  });

  card("T20", "docxRefreshChrome의 모드전환 버튼 on/off 토글이 docxview를 대상으로 한다(fileview 아님)", () => {
    const refreshFn = docxSourceFunction(renderer, "docxRefreshChrome");
    docxAssert(refreshFn, "docxRefreshChrome 함수를 찾지 못함");
    docxAssert(/docxview\.querySelectorAll\("\[data-docx-act='mode-edit'\]"\)/.test(refreshFn)
      && /docxview\.querySelectorAll\("\[data-docx-act='mode-view'\]"\)/.test(refreshFn),
      "docxRefreshChrome이 여전히 fileview에서 모드전환 버튼을 찾음 — docxview로 옮긴 뒤 편집/보기 버튼의 on 표시가 안 바뀔 위험");
    return true;
  });
}


export default async function run() {
  await runDocxBlock11Checks();
}
