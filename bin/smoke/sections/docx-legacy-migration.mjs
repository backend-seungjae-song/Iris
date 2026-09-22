// 소유 범위: 옛 형식과 테스트 fixture 의 이관. 옛 문서를 열어도 깨지지 않는다.
// 제공 API: 이름 export runDocxBlock10Checks 와, DOCX-only 에서만 도는 기본 run.
// 의존 대상: core 의 공유 계수·옵션·파일 읽기, sources 의 소스 문자열, 90-docx-block1 의 helper.
// 유지 조건: 카드 아이디(`--docx-card=B5-T1` 로 사람이 직접 친다)와 검사 이름·문구.
//   91-docx-block5plus.mjs 에서 블록별로 분리한 파일이므로 본문을 그대로 유지한다.
// 영향 범위: 러너의 DOCX-only 분기와 90-docx-block1 의 helper 계약이 양방향으로 맞아야 한다.
//   현재 목록 확인: node bin/importers.mjs bin/smoke/sections/docx-legacy-migration.mjs
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";

import { check, DOCX_CARD, DOCX_ONLY, LIVE, read, ROOT } from "../core.mjs";
import { aiTabs, dock, docxPanel, fileRouting, httpHandler, tabClose, renderer } from "../sources.mjs";
import {
  docxAliasedConcurrentWriteProbe, docxAssert, docxB5PackageInventory, docxB5WasmInventory,
  docxConcurrentWriteProbe, docxDispatchedHandler, docxMessageBranch, docxRenderBranch,
  docxRichRoundTripProbe, docxRoundTripProbe, docxSizedWriteProbe, docxSourceFunction, docxWriteProbe,
} from "./90-docx-block1.mjs";

export async function runDocxBlock10Checks() {
  const selected = DOCX_CARD.toUpperCase();
  if (selected && !selected.startsWith("B10-")) return;
  console.log("\n[DOCX Block 10 RED] Legacy/test migration");
  const card = (id, name, fn) => { if (!selected || selected === `B10-${id}`) check(`[DOCX-B10-${id}] ${name}`, fn); };

  const renderDocxContent = docxSourceFunction(docxPanel, "renderDocxContent");
  const renderFileViewBody = docxSourceFunction(renderer, "renderFileViewBody");
  // docx 오류 화면은 renderFileViewBody 가 아니라 renderDocxPanelBody 가 그린다.
  // docx 가 docxview 패널로 옮겨가 renderFileViewBody 는 docx 를 알지 않는다.
  const renderDocxPanelBody = docxSourceFunction(docxPanel, "renderDocxPanelBody");
  const docxEditorShellHtml = docxSourceFunction(renderer, "docxEditorShellHtml");
  const renderSheetViewBody = docxSourceFunction(renderer, "renderSheetViewBody");

  card("T1", "손상된 OOXML은 새 엔진 mount 실패를 잡아 사용자 대면 오류로 수렴한다(구 docx-preview 파싱 경로 폐기 반영)", () => {
    // 구 Block 2-T12-PARSE 는 window.docx.renderAsync(docx-preview UMD)를 전제로 했으나 그
    // 렌더러가 폐기돼 검증 대상이 없다.
    //
    // 손상된 문서라고 createDocxEditor()가 throw 하지는 않는다. core 계약
    // (editor-C8oaTHr3.d.ts)은 다음과 같다.
    // `EditorSnapshot.parseError: string | null` 가 있고 EditorEvents 에 `error` 이벤트가 따로
    // 있다는 것은 파싱이 비동기이고 실패가 snapshot 상태·이벤트로만 드러난다는 뜻이다. 잘못된
    // bytes 를 줘도 createDocxEditor() 자체는 동기적으로 성공을 반환한다. 그래서
    // `editor.on("error", ...)` 가 토스트만 띄우고 t.docxError 를 설정하지 않으면 사용자는 깨진
    // 빈 편집기를 보게 된다. error 이벤트 안에서 editor.snapshot().parseError 가 있으면 동기
    // catch 와 동일하게 cleanupDocxRender + t.docxError + renderFileView 로 수렴시킨다.
    docxAssert(renderDocxContent, "renderDocxContent 함수를 찾지 못함");
    docxAssert(/createDocxEditor\s*\(/.test(renderDocxContent), "renderDocxContent가 createDocxEditor를 호출하지 않음");

    // 1) 동기 실패(잘못된 인자 등)는 여전히 try/catch 로 잡아야 한다. 회귀 가드로 유지한다.
    const tryIdx = renderDocxContent.search(/\btry\s*\{/);
    const catchIdx = renderDocxContent.search(/\}\s*catch\s*\(/);
    docxAssert(tryIdx >= 0 && catchIdx > tryIdx, "createDocxEditor 호출을 감싸는 try/catch가 없음");
    const createIdx = renderDocxContent.search(/createDocxEditor\s*\(/);
    docxAssert(createIdx > tryIdx && createIdx < catchIdx, "createDocxEditor 호출이 try 블록 밖에 있음 — 동기 생성 실패를 못 잡음");
    const catchBlock = renderDocxContent.slice(catchIdx, renderDocxContent.indexOf("\n  }", catchIdx) + 4 || catchIdx + 400);
    docxAssert(/\.docxError\s*=/.test(catchBlock) && /이 문서는 열기 어렵습니다|문서를 열기 어렵습니다/.test(catchBlock) && /\brenderFileView\s*\(/.test(catchBlock),
      "동기 catch 블록이 t.docxError 설정+오류 문구+renderFileView로 수렴하지 않음");

    // 2) 실제 손상 문서의 경로는 비동기 parseError 다. "error" 이벤트는 문서에 적혀 있을 뿐
    // 실제 손상 파일(qa-corrupt.docx, parseError:"inflate-error")에서는 발생하지 않았다.
    // 이 이벤트에만 의존하면 사용자에게 빈 편집기 셸만 남고 오류 화면이 뜨지 않는다.
    // 반드시 발생하는 "change" 이벤트 핸들러 안에서도 매번 parseError 를 확인해야 한다.
    const parseErrorCheckIdx = renderDocxContent.search(/const\s+parseError\s*=/);
    docxAssert(parseErrorCheckIdx >= 0, "renderDocxContent 안 어디에도 parseError 값을 읽는 코드가 없음");
    const parseErrorCheckBlock = renderDocxContent.slice(parseErrorCheckIdx, parseErrorCheckIdx + 500);
    docxAssert(/\.docxError\s*=/.test(parseErrorCheckBlock) && /이 문서는 열기 어렵습니다|문서를 열기 어렵습니다/.test(parseErrorCheckBlock) && /\brenderFileView\s*\(/.test(parseErrorCheckBlock),
      "parseError 확인 지점이 t.docxError 설정+오류 문구+renderFileView로 수렴하지 않음 — 토스트만 띄우면 사용자가 깨진 빈 편집기를 그대로 보게 됨");
    docxAssert(/cleanupDocxRender\s*\(\s*t\s*\)|\.destroy\s*\(\s*\)/.test(parseErrorCheckBlock),
      "parseError 분기가 실패한 editor 인스턴스를 정리하지 않음 — 죽은 editor 참조가 t.docxEditor에 남을 위험");

    const changeEventIdx = renderDocxContent.search(/editor\.on\s*\(\s*["']change["']/);
    docxAssert(changeEventIdx >= 0, "editor.on(\"change\", ...) 구독이 없음");
    const changeHandlerEnd = renderDocxContent.indexOf("}));", changeEventIdx);
    const changeHandler = renderDocxContent.slice(changeEventIdx, changeHandlerEnd > changeEventIdx ? changeHandlerEnd : changeEventIdx + 400);
    docxAssert(/parseError|docxCheckParseError\s*\(\s*\)/.test(changeHandler),
      "change 이벤트 핸들러가 parseError를 확인(직접 또는 공유 헬퍼 호출)하지 않음 — \"error\" 이벤트가 손상 파일에서 실제로는 발생하지 않으므로(T24 실측) change 경로가 유일하게 신뢰 가능한 관찰 지점이어야 함");

    docxAssert(renderDocxPanelBody && /if\s*\(\s*t\.docxError\s*\)/.test(renderDocxPanelBody) && /docx-error/.test(renderDocxPanelBody),
      "renderDocxPanelBody가 t.docxError 상태를 별도 오류 화면으로 렌더하지 않음");
    return true;
  });

  card("T2", "다른 파일 타입 렌더 경로에는 docx 셸 CSS 클래스(.gd-menu/.gd-tb)가 새어 들어가지 않는다", () => {
    // 구 Block 3-T9 를 이어받는다. .gd-menu/.gd-tb 는 Block 3 의 잔재가 아니라 Block 6 가
    // 계속 쓰는 셸 클래스다(죽은 코드는 GD_MENUS/GD_TOOLBAR 데이터 배열뿐이다). 그래서 격리
    // 검사는 여전히 유효하고 삭제가 아니라 이관 대상이었다.
    docxAssert(renderSheetViewBody, "renderSheetViewBody 함수를 찾지 못함");
    docxAssert(!/gd-menu|gd-tb/.test(renderSheetViewBody), "renderSheetViewBody(xlsx 뷰어)에 docx 셸 클래스가 새어 들어감");
    return true;
  });

  card("T3", ".docx-view-root 컨테이너와 renderDocxContent(t) 호출이 docx 렌더 경로 *안에서만* 함께 존재한다", () => {
    // 구 Block 3-T8 을 이어받되 오라클 결함을 고쳤다. docxRenderBranch 헬퍼의 정규식은 이름
    // 앞에 다른 단어 문자가 최소 1개 있어야 매치해서 "docx"로 시작하는 함수 이름
    // (docxEditorShellHtml 등)을 찾지 못하고("renderDocxContent"는 매치), 실제로 존재하는
    // .docx-view-root 를 없는 것으로 판정했다(node -e 로
    // .docx-view-root를 "사라짐"으로 오판했다(node -e로
    // /\b([A-Za-z_$][\w$]*docx[\w$]*)\s*\(/i.test("docxEditorShellHtml(") === false 확인).
    // docxRenderBranch를 거치지 않고 각 함수를 직접 추출해 대조한다.
    //
    // docxModeIdx 부터 함수 끝까지 통째로 슬라이스하면 두 호출이 뒤에 오는 sheet/text 분기에
    // 있어도 통과한다. docx 분기의 끝(다음 최상위 if 분기 시작)까지로 좁힌다.
    docxAssert(docxEditorShellHtml, "docxEditorShellHtml 함수를 찾지 못함");
    // 그 요소에는 다른 class 가 함께 붙는다(docx-view-root 뒤에 모드 class). 닫는 따옴표까지
    // 요구하면 class 를 추가할 때 실패하므로 그 이름이 있는지만 확인한다.
    docxAssert(/class="[^"]*\bdocx-view-root\b/.test(docxEditorShellHtml), ".docx-view-root 컨테이너가 docxEditorShellHtml에 없음");
    // docx 는 renderFileViewBody 의 분기가 아니라 별도 함수 renderDocxPanelBody 전체다.
    // renderFileViewBody 는 docx 를 알지 않아야 하므로, 이 카드는 renderFileViewBody 안에
    // docx 흔적이 없는지까지 확인한다.
    docxAssert(renderFileViewBody && !/t\.docxMode/.test(renderFileViewBody),
      "renderFileViewBody에 여전히 docx 분기(t.docxMode)가 남아있음 — docxview/renderDocxPanelBody로 완전히 분리되지 않음");
    docxAssert(renderDocxPanelBody, "renderDocxPanelBody 함수를 찾지 못함");
    docxAssert(/docxEditorShellHtml\s*\(\s*t\s*\)/.test(renderDocxPanelBody), "renderDocxPanelBody 안에 docxEditorShellHtml(t) 호출이 없음");
    docxAssert(/renderDocxContent\s*\(\s*t\s*\)/.test(renderDocxPanelBody), "renderDocxPanelBody 안에 renderDocxContent(t) 호출이 없음");
    return true;
  });

  card("T4", "docx 셸(.gd-menu/.gd-tb/.docx-editor-shell) CSS는 앱 전역 다크 테마 변수를 쓰지 않고 라이트 고정색만 쓴다", () => {
    // 구 Block 3-T6 를 이어받되 두 가지를 바로잡았다. (1) .gd-menu{ 규칙부터 고정 길이만큼
    // 슬라이스하면 그 창이 셸 CSS 구간을 벗어나 무관한 뷰 CSS 까지 삼키고, 거기 있는
    // var(--fg) 때문에 잘못된 실패가 난다(.gd-menu/.gd-tb 규칙 자체는 #fff/#1f1f1f 같은 라이트
    // 고정색만 쓴다). (2) Block 6 가 다크 변수를 쓰도록 바뀐 것은 아니므로 카드를 삭제하지
    // 않는다. "Google Docs 복제"라는 동기는 폐기됐지만 셸이 라이트 고정색을 쓴다는 사실은
    // 여전히 회귀 대상이다. 그래서 고정 길이 슬라이스 대신 각 선택자의 실제 규칙 블록
    // { ... }만 추출해 셸 CSS 규칙만 검사한다.
    const selectors = [".gd-menu", ".gd-tb", ".docx-editor-shell"];
    let anyFound = false;
    for (const sel of selectors) {
      const escaped = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(escaped + "(?:\\s+[^{},]+)?\\s*\\{([^}]*)\\}", "g");
      let m;
      while ((m = re.exec(renderer))) {
        anyFound = true;
        docxAssert(!/var\(--(?:bg|fg|card|sidebar|border|muted)\b/.test(m[1]),
          `${sel} 규칙이 앱 전역 다크 변수를 참조함 — 셸이 라이트 고정색을 벗어남: ${m[0].slice(0, 120)}`);
      }
    }
    docxAssert(anyFound, "docx 셸 CSS 선택자(.gd-menu/.gd-tb/.docx-editor-shell)를 하나도 찾지 못함 — 오라클 자체가 무효화됐을 위험");
    return true;
  });

  card("T5", "core.CHROME_GROUPS의 모든 컨트롤이 DOCX_SLOT_LABELS에 한글 라벨을 갖거나 명시적으로 제외된다", () => {
    // docxToolbarHtml()은 CHROME_GROUPS 전체를 순회해 컨트롤마다 라벨 텍스트를 항상 렌더한다
    // (아이콘이 있어도 라벨 span 은 별개로 항상 보인다). DOCX_SLOT_LABELS 에 없는 슬롯은
    // docxSlotLabel()의 폴백이 slotId 를 영문으로 풀어써("Insert Footnote" 등) 한글 버튼들
    // 사이에서 눈에 띄고, 22개 슬롯(script.super/sub, contentControl.*, image.properties/wrap/
    // altText, table.border*/cellFill, insert.footnote/endnote/pageNumber/...)이 한 번에 누락된
    // 적이 있다. 이 카드는 슬롯 목록을 하드코딩하지 않고 설치된 core 의 CHROME_GROUPS 를
    // 순회해 검사하므로, core 가 새 컨트롤을 추가해도 잡는다.
    const ownedDecl = renderer.match(/const DOCX_SLOT_LABELS\s*=\s*\{([\s\S]*?)\n\};/);
    docxAssert(ownedDecl, "DOCX_SLOT_LABELS 선언을 찾지 못함");
    const labeledSlots = [...ownedDecl[1].matchAll(/["']([a-zA-Z]+\.[a-zA-Z]+)["']\s*:/g)].map((m) => m[1]);
    const excludedDecl = renderer.match(/const DOCX_EXCLUDED_SLOTS\s*=\s*new Set\(\[([^\]]*)\]\)/);
    docxAssert(excludedDecl, "DOCX_EXCLUDED_SLOTS 선언을 찾지 못함");
    const excludedSlots = [...excludedDecl[1].matchAll(/["']([a-zA-Z]+\.[a-zA-Z]+)["']/g)].map((m) => m[1]);
    // 설치된 core 패키지를 자식 프로세스에서 직접 import 해 CHROME_GROUPS 를 얻는다. 이
    // import 는 dev 서버·브라우저가 필요 없어(docxRoundTripProbe 와 같은 automation 계열
    // 패턴) --live 플래그와 무관하게 항상 실행된다.
    const script = String.raw`
      const core = await import("@docx-editor.dev/core");
      const labeled = new Set(${JSON.stringify(labeledSlots)});
      const excluded = new Set(${JSON.stringify(excludedSlots)});
      const missing = [];
      for (const group of core.CHROME_GROUPS) {
        for (const control of group.controls) {
          const slotId = group.id + "." + control.id;
          if (!labeled.has(slotId) && !excluded.has(slotId)) missing.push(slotId);
        }
      }
      process.stdout.write(JSON.stringify({ groupCount: core.CHROME_GROUPS.length, missing }));
    `;
    let result;
    try {
      const raw = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8", timeout: 15000, cwd: ROOT,
      });
      result = JSON.parse(raw);
    } catch (e) {
      throw new Error("core.CHROME_GROUPS 조회 실패: " + String((e && e.stdout) || (e && e.message) || e));
    }
    docxAssert(result.groupCount > 0, "core.CHROME_GROUPS를 가져오지 못함");
    docxAssert(result.missing.length === 0,
      `DOCX_SLOT_LABELS에 없고 DOCX_EXCLUDED_SLOTS에도 없는 슬롯이 있음(영문 라벨 누출 위험): ${result.missing.join(", ")}`);
    return true;
  });
}


export default async function run() {
  await runDocxBlock10Checks();
}
