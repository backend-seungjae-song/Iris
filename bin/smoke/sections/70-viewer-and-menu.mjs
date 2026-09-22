// 소유 범위: 사람 경로 게이트·CSV/TSV·뷰어·시트부터 [메뉴] 실제 연결까지의 사용자 표면 계약.
// 제공 API: 원래 사람 경로 게이트 자리에서 한 번 호출하는 비동기 기본 run.
// 의존 대상: core의 공유 검사·파일 도구, sources의 뷰어·시트·메뉴 소스, slice-anchor와 Node 경로 API.
// 유지 조건: 검사 이름·순서·문구, 실제 메뉴 비의존 가짜 주입, full smoke 출력.
// 영향 범위: 러너가 50 두 흐름 섹션 뒤·80 RED 블록 섹션 앞에서 이 run을 호출한다.
//   지금 목록은 이걸로 센다: node bin/importers.mjs bin/smoke/sections/70-viewer-and-menu.mjs
import path from "node:path";

import { b4Function, check, checkAsync, fnBody, read, readAll, require_, ROOT } from "../core.mjs";
import {
  allCss, centerTabs, css, fileRouting, mcp, pick, serverIndexSource as srv,
  sheetActions, sheetConditional, sheetEdit, sheetEvents, sheetFormula, sheetModel,
  sheetRender, sheetTabState, textEditor, viewerBoot, viewerKinds, web, webview,
} from "../sources.mjs";
import { sliceBetween, sliceFrom } from "../../slice-anchor.mjs";

export default async function run() {
// ── 사람 경로 게이트 ─────────────────────────────────────────────────────────
// 규칙은 문서에 있지만(qa-run "밟지 않은 경로는 확인된 것이 아니다"), 문서만으로는 주소로
// 건너뛰고 JS로 조작한 뒤 확인됐다고 적는 것을 막지 못한다.
// 그래서 여기서는 판정 함수를 실제로 실행한다. 소스에 해당 문자열이 있는지가 아니라, 그 입력이
// 실제로 거부되는지를 확인한다.
console.log("[2q] 사람 경로 게이트 — 확인은 사람이 밟는 길로만");
{
  const { humanPathDeny } = await import(path.join(ROOT, "server/human-path.js"));
  const deny = (cmd, args, url) => humanPathDeny(cmd, args, url);

  check("같은 사이트 안을 주소로 건너뛰면 거부", () =>
    !!deny("goto", { url: "https://shop.com/cart" }, "https://shop.com/product/12"));
  check("거부 문구가 무엇을 대신 하라는지 말한다", () => {
    const why = deny("goto", { url: "https://shop.com/cart" }, "https://shop.com/product/12") || "";
    return why.includes("browser_click") && why.includes("browser_snapshot") && why.includes("reason");
  });
  check("포트·스킴이 다르면 다른 사이트로 본다", () =>
    !deny("goto", { url: "https://shop.com/cart" }, "https://shop.com:8443/product")
    && !deny("goto", { url: "https://shop.com/a" }, "http://shop.com/b"));
  check("다른 사이트로 넘어가는 것은 통과", () =>
    !deny("goto", { url: "https://other.com/x" }, "https://shop.com/product/12"));
  check("빈 탭에서의 첫 진입은 통과", () =>
    !deny("goto", { url: "https://shop.com/cart" }, "about:blank") && !deny("goto", { url: "https://shop.com" }, ""));
  check("reason을 적으면 통과", () =>
    !deny("goto", { url: "https://shop.com/cart", reason: "결제 완료 복귀 주소 자체가 확인 대상" }, "https://shop.com/product/12"));
  check("browser_new_tab의 진입 주소(entry)는 막지 않는다", () =>
    !deny("goto", { url: "https://shop.com/cart", entry: true }, "https://shop.com/product/12"));

  // eval은 읽는 도구다. 조작에는 우회 인자가 없다.
  for (const [label, expr] of [
    ["클릭", "document.querySelector('#buy').click()"],
    ["값 주입", "document.querySelector('#qty').value = 3"],
    ["체크", "el.checked = true"],
    ["폼 제출", "document.forms[0].submit()"],
    ["주소 이동", "location.href = '/cart'"],
    ["주소 대입", "location = '/cart'"],
    ["새로고침", "location.reload()"],
    ["히스토리", "history.pushState({}, '', '/cart')"],
    ["새 창", "window.open('/cart')"],
    ["이벤트 발사", "el.dispatchEvent(new Event('input'))"],
    ["DOM 주입", "document.body.innerHTML = ''"],
    ["속성 설정", "el.setAttribute('disabled', '')"],
    ["포커스", "document.querySelector('input').focus()"],
    // 이름을 하나씩 적어 막으면 적지 않은 이름은 통과한다(예: document.title).
    ["제목 바꾸기", "document.title = 'x'"],
    ["스타일 주입", "el.style.display = 'none'"],
    ["이미지 주소 바꾸기", "img.src = '/other.png'"],
    ["클래스 조작", "el.classList.add('active')"],
    ["노드 제거", "document.querySelector('.modal').remove()"],
    ["노드 삽입", "document.body.appendChild(el)"],
    ["보이는 곳으로 스크롤", "el.scrollIntoView()"],
  ]) check(`eval ${label} 거부`, () => !!deny("eval", { expression: expr }));

  for (const [label, expr] of [
    ["개수 세기", "document.querySelectorAll('.item').length"],
    ["값 읽기", "document.querySelector('#qty').value"],
    ["텍스트 읽기", "document.body.innerText.slice(0, 100)"],
    ["비교식", "el.checked === true"],
    ["주소 읽기", "location.href"],
    ["상태 시드", "localStorage.setItem('seen', '1')"],
    // 거부 범위가 읽기까지 포함하면 확인할 방법이 없어진다. 대입이 아닌 식은 모두 통과해야 한다.
    ["일치 비교", "document.title === '장바구니'"],
    ["화살표 함수", "[...document.querySelectorAll('a')].map((x) => x.href)"],
    ["구조 분해", "const { top } = el.getBoundingClientRect(); top"],
    ["스타일 읽기", "getComputedStyle(el).display"],
    ["보이는지 판정", "el.getBoundingClientRect().height > 0"],
  ]) check(`eval ${label} 통과`, () => !deny("eval", { expression: expr }));

  check("게이트는 명령 경로 한 곳에서만 불린다", () => {
    const src = read("server/browser-commands.js");
    return (src.match(/humanPathDeny\(/g) || []).length === 1
      && /import \{ humanPathDeny \} from "\.\/human-path\.js"/.test(src);
  });
  // 거부 결과에 sent 필드가 붙으면 재시도 단계가 같은 거부를 네 번 더 반복한다.
  check("거부는 재시도 사다리를 타지 않는다", () =>
    /const denied = humanPathDeny\([\s\S]{0,120}?\n\s*if \(denied\) \{ resolve\(\{ ok: false, error: denied \}\); return; \}/.test(read("server/browser-commands.js")));
  // 눌러서 이동한 것과 주소로 건너뛴 것을 기록에서 구별하지 못하면 우회가 드러나지 않는다.
  check("건너뛴 이동은 회차 장부·트레이스에 남는다", () => {
    const src = readAll("server");
    return /skipped_human_path: a\.reason/.test(src) && /주소로 건너뜀/.test(src);
  });
  check("goto의 reason이 MCP·CLI 양쪽에서 서버까지 간다", () =>
    /reason: String\(a\.reason\)/.test(read("bin/iris-mcp.mjs"))
    && /if \(skipReason\) args\.reason = skipReason/.test(read("bin/iris-browser.mjs")));
  // 계획 러너도 같은 게이트를 지난다. 되돌리기(reset)만 준비라서 통과하되 이유가 장부에 남는다.
  check("계획의 goto도 게이트를 지나고, reset만 이유를 달고 통과", () => {
    const plan = read("bin/qa-plan.mjs");
    return /a\.reason \? String\(a\.reason\) : null/.test(plan)
      && /reason: "시나리오 격리 되돌리기\(reset\)"/.test(plan);
  });
}

// ── 표 뷰어(엑셀·CSV) ──────────────────────────────────────────────────────
// 엑셀 파일을 Finder로 넘기지 않고 표 뷰어로 연다. 막는 위치가 둘이므로 둘 다 검사한다.
console.log("\n[표 뷰어] 엑셀·CSV를 표로 연다");
{
  const srv = read("server/index.js");
  const sheetHandlers = read("server/sheet-handlers.js");
  const sheet = read("server/sheet.js");
  check("엑셀은 '못 여는 것' 목록에서 빠져 있다", () =>
    !/xls\[xm\]\?/.test(fileRouting) && /\|xls\|/.test(fileRouting));
  // 확장자와 읽는 방법은 각 뷰어가 가지고, 앱 셸은 등록표에 물어 그 종류가 준 메시지를 그대로
  // 보낸다. 양쪽을 다 확인해야 묻기만 하고 아무도 등록하지 않은 상태를 검출한다.
  check("표 파일은 sheet.read로 받는다", () =>
    /const SHEET_RE = \/\\\.\(xlsx\|xlsm\|csv\|tsv\|tab\)\$\/i/.test(viewerKinds)
    && /id: "sheet"[\s\S]*?read: \(path\) => \(\{ type: "sheet\.read", path \}\)/.test(viewerKinds)
    && /function requestFileContent\(path\)/.test(centerTabs)
    && /const kind = fileKindOf\(path, tab\);[\s\S]{0,200}kind\.read\(path, tab\)/.test(centerTabs));
  check("여는 길이 둘이어도 같은 탭을 만든다", () =>
    /function makeFileTab\(path\)/.test(centerTabs)
    && ((centerTabs + fileRouting).match(/addTab\(sp, makeFileTab\(path\)\); requestFileContent\(path\)/g) || []).length >= 2);
  check("서버가 sheet.read를 받는다", () =>
    /msg\.type === "sheet\.read"/.test(srv) && /export async function handleSheetRead/.test(sheetHandlers));
  check("읽기 경계·크기 상한이 파일 읽기와 같다", () =>
    /!ws\._local && !fsPathAllowed\(p\)[\s\S]{0,200}type: "sheet"/.test(sheetHandlers)
    && /st\.size > 20 \* 1024 \* 1024[\s\S]{0,120}type: "sheet"/.test(sheetHandlers));
  check("수식 값은 cell.result에서 받는다", () =>
    /cell\.type === ExcelJS\.ValueType\.Formula/.test(sheet) && /cell\.result !== undefined/.test(sheet));
  check("서식은 모아서 번호로 싣는다", () =>
    /class StylePool/.test(sheet) && /si \? \[text, si\] : \[text\]/.test(sheet));
  check("CSV는 따옴표 안의 쉼표·줄바꿈을 지킨다", () =>
    /if \(text\[i \+ 1\] === '"'\) \{ field \+= '"'; i\+\+; \}/.test(sheet)
    && /if \(ch === sep\) \{ row\.push\(field\)/.test(sheet));
  check("폰트 이름을 큰따옴표로 감싸지 않는다", () =>       // 감싸면 style 속성이 끊겨 색·테두리가 통째로 사라진다
    !/font-family:" \+ JSON\.stringify/.test(sheetModel) && /font-family:'/.test(sheetModel));
  check("서식 문자열에 큰따옴표가 남지 않는다", () =>
    /return p\.join\(";"\)\.replace\(\/"\/g, "'"\)/.test(sheetModel));
  check("고정 열은 따로 조각으로 그린다", () =>          // 붙임(sticky) 한 장이면 고정 열이 화면보다 넓을 때 볼 방법이 없다
    ["sv-pc", "sv-pt", "sv-pl", "sv-pb"].every((id) => sheetRender.includes(`svPaneHtml(t, sh, "${id}"`))
    && !/\.sv-pl \{[^}]*overflow-x:auto/.test(allCss)
    && /const svPane = \(id\) => document\.getElementById\(id\)/.test(sheetRender));
  // 아래 둘은 구글 시트를 직접 측정해 얻은 값이다. 고정 조각에 자체 스크롤을 붙이지 않고
  // 넘치면 자른다. 중첩 스크롤바를 두면 실제 동작과 일치하지 않는다.
  check("고정 조각에는 자체 스크롤이 없다", () =>
    /const leftW = Math\.min\(frozenW \+ divX, availW\)/.test(sheetRender)
    && !/const SV_MIN_BODY/.test(sheetRender)
    && /\.sv-p \{[^}]*overflow:hidden/.test(css("13-sheet-view")));
  check("고정 행이 창보다 높으면 잘라 앉힌다", () =>
    /const SV_KEEP = 15/.test(sheetRender) && /function svFitTop\(\)/.test(sheetRender)
    && /gridTemplateRows = topH \+ "px 1fr 13px"/.test(sheetRender));
  // 스크롤바 배치는 구글 시트를 창 1000px에서 측정해 그대로 옮긴 값이다.
  // 가로 = 높이 13, 행 머리/고정 열 다음부터 격자 오른쪽 끝까지, 맨 아래.
  // 세로 = 폭 13, 오른쪽 끝, 고정 행 아래 띠에서만. 여백 띠 12px(#f9f9f9 / 1px #c4c7c5).
  check("스크롤바는 격자 밖에 따로 붙는다", () =>
    /<div class="sv-sby" id="sv-sby">/.test(sheetRender) && /id="sv-sbx"/.test(sheetRender)
    && /grid-template-columns:\$\{Math\.round\(leftW\)\}px 1fr 13px/.test(sheetRender)
    && /\.sv-shim \{ background:#f9f9f9; \}/.test(css("13-sheet-view"))
    && /\.sv-shim-b \{ border-top:1px solid #c4c7c5; \}/.test(css("13-sheet-view")));
  check("채움 막대 크기가 곧 전체 내용 크기", () =>
    /width:1px;height:\$\{allH\}px/.test(sheetRender) && /height:1px;width:\$\{allW\}px/.test(sheetRender));
  check("바깥 띠가 기준이고 조각은 따라간다", () =>
    /const x = sx \? sx\.scrollLeft : 0, y = sy \? sy\.scrollTop : 0;/.test(sheetRender)
    && /pb\.scrollLeft = x; if \(pt\) pt\.scrollLeft = x;/.test(sheetRender)
    && !/\.sv-pb \{ overflow:auto/.test(allCss));
  check("어느 조각 위에서 굴려도 가로·세로 다 간다", () =>
    /const pass = \(el\) => el && el\.addEventListener\("wheel"/.test(sheetRender)
    && /if \(sy\) sy\.scrollTop \+= e\.deltaY;\s*\n\s*if \(sx\) sx\.scrollLeft \+= e\.deltaX;/.test(sheetRender)
    && /pass\(pl\); pass\(pt\); pass\(pb\); pass\(svPane\("sv-pc"\)\);/.test(sheetRender));
  check("원본이 고정한 열은 하나도 빼지 않는다", () =>   // 화면 폭에 맞춰 줄이면 고정돼야 할 칸이 함께 스크롤된다
    !/budget/.test(sliceBetween(sheetRender, "function svFrozen", "function svColW", "원본이 고정한 열은 하나도 빼지 않는다") + sliceFrom(sheetRender, "function svColW", 200, "원본이 고정한 열은 하나도 빼지 않는다"))
    && /n: sh\.freeze \? Math\.min\(sh\.freeze\.x \|\| 0, sh\.colsCount\) : 0/.test(sheetRender));
  check("조각마다 너비를 고정한다", () =>                // 너비를 지정하지 않으면 열이 좁아져 글자가 세로로 쌓인다
    /function svPaneW\(sh, c1, c2, withRh\)/.test(sheetRender) && /<table class="sv-t" style="width:\$\{w\}px/.test(sheetRender));
  check("조각끼리 줄 높이를 맞춘다", () =>                // 맞추지 않으면 고정 열과 본문의 행 위치가 한 칸씩 밀린다
    /function svSyncRows\(\)/.test(sheetRender) && /Math\.max\(ra\[i\]\.offsetHeight, rb\[i\]\.offsetHeight\)/.test(sheetRender));
  check("표는 흰 종이 위에 그린다", () =>                // 원본 배경색은 흰 종이를 전제로 고른 색이다
    /\.sv-t \{[^}]*background:#fff/.test(css("13-sheet-view"))
    && /\.sv-t \{[^}]*color:#000/.test(css("13-sheet-view")));
  check("csv는 원문으로 돌아갈 수 있다", () =>
    /const SHEET_TEXT_RE = \/\\\.\(csv\|tsv\|tab\)\$\/i/.test(viewerKinds)
    && /textForm: \(path\) => SHEET_TEXT_RE\.test\(path\)/.test(viewerKinds)
    && /textForm\?\.\(t\.path\)/.test(textEditor)
    && /data-sv="text"/.test(textEditor) && /data-sv="table"/.test(textEditor));
  check("큰 표는 나눠 그린다", () => /const SV_CHUNK = 300/.test(sheetModel) && /t\._svShown \+ SV_CHUNK/.test(sheetEdit));
  // 보기 전용이라도 사람이 표에서 하는 일은 다 돼야 한다.
  check("키보드로 옮겨 다닌다", () =>
    /ArrowUp: \[-1, 0\]/.test(sheetEvents) && /e\.key === "Tab"/.test(sheetEvents) && /e\.key === "Enter"/.test(sheetEvents)
    && /e\.key === "PageDown"/.test(sheetEvents) && /e\.key === "Home"/.test(sheetEvents));
  check("범위를 고르고 통째로 복사한다", () =>
    /function svRangeText\(t\)/.test(sheetEdit) && /row\.join\("\\t"\)/.test(sheetEdit) && /out\.join\("\\n"\)/.test(sheetEdit)
    && /fileview\.addEventListener\("mouseover"/.test(sheetEdit));
  check("행·열 머리로 통째 고른다", () =>
    /e\.target\.closest\("th\.sv-ch"\)/.test(sheetEvents) && /e\.target\.closest\("th\.sv-rh"\)/.test(sheetEvents)
    && /e\.target\.closest\("\.sv-corner"\)/.test(sheetEvents));
  check("찾기가 있다", () => /function svFind\(t, q, back\)/.test(sheetActions) && /data-sv="find-next"/.test(sheetRender));
  check("크게·작게가 있다", () => /function svZoom\(t, d\)/.test(sheetActions) && /data-sv="zoom-reset"/.test(sheetRender));
  check("고른 것을 아래에서 요약한다", () => /id="sv-stat"/.test(sheetRender) && /값 있는 칸/.test(sheetEdit));
  check("병합된 칸도 넘나든다", () => /function svAnchorOf\(t, r, c\)/.test(sheetModel) && /hidden\.set\(r \+ ","/.test(sheetModel));
  check("고정 경계가 선으로 보인다", () =>
    /\.sv-t td\.sv-fc-last, \.sv-t th\.sv-fc-last \{ border-right:2px solid/.test(css("13-sheet-view"))
    && /\.sv-pc, \.sv-pt \{ border-bottom:1px solid/.test(css("13-sheet-view")));
  check("잘라 보냈으면 잘랐다고 말한다", () => /const MAX_CELLS = 60000/.test(sheet) && /sh\.cut \?/.test(sheetRender));

  // 편집 기능. 보기 전용 표는 읽는 것 외에 할 수 있는 동작이 없다.
  // 도구 모음·메뉴는 구글 시트 화면에서 수집한 목록을 기준으로 쓰되, 로컬 단일
  // 사용자 앱에 실체가 없는 계정·클라우드 전용 항목(댓글·입력도구·더보기·공유·데이터 커넥터
  // 등)은 제외한다. 아직 만들지 않은 로컬 기능(차트·피봇 등)과는 구분한다.
  check("도구 모음은 구글 시트에서 긁은 순서 그대로(계정 전용 껍데기 제외)", () => {
    const want = ["실행취소 (⌘Z)", "재실행 (⌘Y)", "인쇄 (⌘P)", "서식 복사", "서식 붙여넣기",
      "통화 형식", "퍼센트 형식", "소수점 이하 자릿수 감소", "소수점 이하 자릿수 증가", "서식 더보기",
      "글꼴", "글꼴 크기 작게 (⌘⇧,)", "글꼴 크기", "글꼴 크기 크게 (⌘⇧.)",
      "굵게 (⌘B)", "기울임 (⌘I)", "취소선 (⌘⇧X)", "텍스트 색상", "채우기 색상", "테두리",
      "셀 병합", "병합 유형 선택", "가로 맞춤", "세로 맞춤", "텍스트 줄바꿈", "텍스트 회전",
      "링크 삽입 (⌘K)", "차트 삽입", "필터 삭제", "필터 보기", "함수",
      "시트 오른쪽에서 왼쪽으로", "셀 왼쪽에서 오른쪽으로", "셀 오른쪽에서 왼쪽으로",
      "접근성", "메뉴 숨기기 (Ctrl+⇧F)"];
    const block = sliceBetween(sheetModel, "const GS_TOOLBAR = [", "const GS_FONTS", "도구 모음은 구글 시트에서 긁은 순서 그대로(계정 전용 껍데기 제외)");
    let at = -1;
    for (const w of want) { const i = block.indexOf('"' + w + '"'); if (i <= at) return false; at = i; }
    return !['"댓글 삽입', '"입력 도구', '"더보기"'].some((w) => block.includes(w));
  });
  check("메뉴 바도 긁은 그대로(계정 전용 껍데기 제외)", () => {
    const block = sliceBetween(sheetModel, "const GS_MENUS = [", "const GS_TOOLBAR", "메뉴 바도 긁은 그대로(계정 전용 껍데기 제외)");
    const hasAll = ["파일", "수정", "보기", "삽입", "서식", "데이터"].every((n) => block.includes('n: "' + n + '"'))
      && block.includes('["찾기 및 바꾸기", "⌘⇧H"]')
      && block.includes('["서식 지우기", "⌘\\\\"]')
      && block.includes('["최적화 문제 풀이", ""]');
    const noneOfShells = !["데이터 커넥터", "공유\"", "이메일\"", "Drive에 바로가기 추가",
      "버전 기록", "오프라인 사용 설정", "보안 제한사항", "\"댓글\"", "사전 빌드된 테이블",
      "그림 이모티콘", "스마트 칩", "데이터 분석", "그룹화 보기 만들기", "필터 보기 만들기",
      "필터 보기로 저장", "시트 및 범위 보호"].some((w) => block.includes(w));
    return hasAll && noneOfShells;
  });
  check("아직 안 옮긴 것은 그렇다고 말한다", () =>   // 아무 반응이 없으면 고장으로 보인다
    sheetActions.includes('showToast("아직 안 옮긴 기능입니다: "'));
  check("색·테두리·숫자 서식은 목록에서 고른다", () =>
    /function svMenuAt\(anchor, html, onPick\)/.test(sheetActions) && /const GS_COLORS = \[/.test(sheetModel)
    && /function svBorder\(t, kind\)/.test(sheetActions) && /const GS_NUMFMT = \[/.test(sheetModel));
  check("셀 병합이 있다", () => /function svMerge\(t, kind\)/.test(sheetActions) && /t\._svMergeEdit/.test(sheetActions));
  check("칸을 그 자리에서 고친다", () =>
    /function svEdit\(t, r, c, seed\)/.test(sheetEdit) && sheetEdit.includes('ta.className = "sv-ed"') && sheetEvents.includes("F2"));
  check("수식 입력줄이 있다", () =>
    /id="sv-fxin"/.test(sheetRender) && /id="sv-name"/.test(sheetRender) && /class="gs-fxi">fx</.test(sheetRender));
  // 아래 값들은 구글 시트 화면의 computed style을 그대로 옮긴 것이다.
  check("값에 따라 칸 색이 바뀐다(조건부 서식)", () =>
    sheet.includes("function readCF(ws)") && sheet.includes("ws.conditionalFormattings")
    && sheetConditional.includes("function svCF(t, sh, r, c, text)")
    && sheetConditional.includes("function svCFHit(rule, v, t, si, r, c)"));
  check("조건부 서식은 원래 서식 위에 얹는다", () =>
    sheetRender.includes("const over = svCF(t, sh, r, c, text);")
    && sheetRender.includes("const st = over ? Object.assign({}, base, over) : base;"));
  check("조건부 서식은 고친 뒤에도 다시 칠한다", () =>
    sheetEdit.includes("const want = svStyle(over ? Object.assign({}, base, over) : base,"));
  check("규칙은 우선순위 순으로 본다", () =>
    sheetConditional.includes("g.rules.slice().sort((x, y) => (x.p || 0) - (y.p || 0))"));
  check("도구 모음 생김새가 구글 시트 실측값", () =>
    // border-radius:24px는 두지 않는다. 도구 바 자체의 라운드는 빼고 버튼에만 남긴다.
    // 버튼 개별 라운드(.gs-tb button)는 측정값을 그대로 유지한다.
    css("14-sheet-edit").includes("height:40px; margin:6px 16px 8px;")
    && css("14-sheet-edit").includes("background:#f0f4f9; overflow-x:auto;")
    && !/\.gs-tb\s*\{[^}]*border-radius/.test(allCss));
  // .gd-menu 배경은 나머지 gd- 규칙과 함께 14-sheet-edit.css 에 둔다. 19-terminal.css 에 남아
  // 있으면 문서 도구 바 색을 수정할 때 터미널 스타일 파일을 열어야 한다. 측정값 자체는
  // 바뀌지 않았다.
  check("메뉴 바·글꼴도 실측값", () =>
    css("14-sheet-edit").includes("height:33px; padding:0 12px; background:#fff;")
    && !css("19-terminal").includes(".gd-menu")
    && css("14-sheet-edit").includes("font-family:Roboto, RobotoDraft, Helvetica, Arial, sans-serif; font-size:13px;")
    && css("14-sheet-edit").includes("padding:2px 7px; border-radius:4px;"));
  check("격자 배경·시트 탭도 실측값", () =>
    css("15-docx").includes(".sv-grid { background:#f8fafd; }")
    && css("16-sheet-overlay").includes(".gs .sv-foot { height:39px;")
    && css("16-sheet-overlay").includes(".gs .sv-tab.on { background:#dde3ea;"));
  // 격자의 색·크기는 구글 시트 화면을 픽셀 단위로 측정해 옮겼다. 캡처가 Display P3라
  // 측정값을 sRGB로 변환했고, 변환은 이미 아는 색 세 개(#f0f4f9·#d3e3fd·#1f3864)로 검증했다.
  check("격자선·머리글이 구글 시트 실측값", () =>
    css("13-sheet-view").includes("border-right:1px solid #c4c7c5; border-bottom:1px solid #c4c7c5;")
    && css("13-sheet-view").includes("background:#fff; color:#444746; height:24px;")
    && css("13-sheet-view").includes("background:#fff; color:#444746;\n               font-weight:400; font-size:11px;"));
  check("행 높이는 21px", () =>
    css("13-sheet-view").includes("height:21px; box-sizing:border-box;")
    && sheetRender.includes("allH += (sh.row[r - 1] || 21)"));
  check("고른 자리 색도 실측값", () =>
    css("13-sheet-view").includes("outline:2px solid #3370eb;")
    && css("13-sheet-view").includes("background:#d3e3fd; color:#041e49;")
    && css("13-sheet-view").includes("rgba(51,112,235,.108)")
    && css("16-sheet-overlay").includes("rgba(51,112,235,.108)"));
  check("고른 범위는 통째로 두른다", () =>
    sheetEdit.includes("function svRangeBox(t)") && sheetEdit.includes('box.className = "sv-rng"')
    && css("16-sheet-overlay").includes(".sv-rng { position:absolute; z-index:1; border:2px solid #3370eb;"));
  check("여럿을 고르면 활성 칸도 덮인다", () =>
    sheetEdit.includes('if (!one) { const a = svCellEl(t._svSel.r1, t._svSel.c1); if (a) a.classList.add("sv-in"); }'));
  check("채우기 손잡이는 지름 8px 동그라미", () =>
    /\.sv-fill \{[^}]*width:8px; height:8px; background:#0b57d0;/.test(css("16-sheet-overlay"))
    && /\.sv-fill \{[^}]*border-radius:50%;/.test(css("16-sheet-overlay"))
    && sheetEdit.includes("er.right - hr.left - 5"));
  check("고정 경계는 4px 띠", () =>
    sheetRender.includes("const SV_FZDIV = 4;")
    && css("13-sheet-view").includes(".sv-fzx .sv-pl, .sv-fzx .sv-pc { border-right:4px solid #c7c7c7; }")
    && css("13-sheet-view").includes(".sv-fzy .sv-pc, .sv-fzy .sv-pt { border-bottom:4px solid #c7c7c7; }")
    && sheetRender.includes("const natural = tbl.offsetHeight + divY;"));
  check("글자 크기는 포인트를 픽셀로 바꿔 쓴다", () =>   // 변환하지 않으면 줄 높이에 비해 글자가 작다
    sheetModel.includes("Math.round(st.fs * 4 / 3 * 10) / 10"));
  check("드롭다운 화살표는 늘 보인다", () =>
    css("16-sheet-overlay").includes(".sv-t td.sv-dv::after")
    && css("16-sheet-overlay").includes("border-top:5px solid #444746;"));
  check("되돌리기는 커서가 어디 있든 듣는다", () =>
    sheetEvents.includes("if ((e.metaKey || e.ctrlKey) && /^[zyZYsS]$/.test(e.key))"));
  check("⌘로 여러 덩어리를 고른다", () =>
    sheetEdit.includes("function svAllRanges(t)") && sheetEvents.includes("t._svRanges = (t._svRanges || []).concat")
    && sheetEdit.includes("function svEachCell(t, fn)"));
  check("⇧로 늘릴 때 글자가 끌리지 않는다", () =>   // 안 막으면 표가 아니라 글자가 선택된다
    sheetEvents.includes("e.preventDefault();\n    const addRange = (e.metaKey || e.ctrlKey) && t._svSel;"));
  check("서식·지우기는 고른 덩어리 전부에", () =>
    sheetEdit.includes("svEachCell(t, (r, c) => {\n    const key = r + \",\" + c;")
    && sheetEvents.includes('svEachCell(t, (r, c) => { if (svSrcAt(sh, r, c) !== "") ch.push({ r, c, src: "" }); });'));
  check("고친 값이 칸에 보인다", () =>            // src에만 넣으면 파일엔 들어가고 화면은 빈칸이다
    sheetEdit.includes("function svPut(t, sh, r, c, raw)") && sheetEdit.includes("svPut(t, sh, ch.r, ch.c, after);"));
  check("드래그로 연속 채우기", () =>
    sheetEdit.includes("function svFillHandle(t)") && css("16-sheet-overlay").includes(".sv-fill { position:absolute")
    && sheetEdit.includes("function svFill(t, to)") && sheetEdit.includes("svFillDrag") && sheetEdit.includes("td.sv-pre"));
  check("채울 때 수·글자·수식을 이어 간다", () =>
    sheetEdit.includes("function svNext(seed, i, dr, dc)") && sheetEdit.includes("function svShift(f, dr, dc)")
    && sheetEdit.includes("function svTail(sv)"));
  check("아래로·오른쪽으로 채우기 단축키", () =>
    sheetEdit.includes("function svFillFrom(t, dir)") && sheetEvents.includes('svFillFrom(t, "down")')
    && sheetEvents.includes('svFillFrom(t, "right")'));
  check("고친 것은 되돌릴 수 있다", () =>
    /function svUndo\(t, redo\)/.test(sheetEdit) && /t\._svUndo/.test(sheetEdit) && /t\._svRedo/.test(sheetEdit));
  check("지우기·잘라내기·붙여넣기가 된다", () =>
    /addEventListener\("paste"/.test(sheetEvents) && /addEventListener\("cut"/.test(sheetEvents) && /"Backspace"/.test(sheetEvents));
  check("고를 값이 정해진 칸은 목록에서 고른다", () =>
    /function listOf\(cell\)/.test(sheet) && /function svPick\(t, r, c\)/.test(sheetEdit) && sheetEdit.includes('className = "sv-pick"'));
  check("수식은 그 자리에서 다시 계산한다", () =>
    /function svRecalc\(t\)/.test(sheetFormula) && /const SV_FN = \{/.test(sheetFormula) && /COUNTIF:/.test(sheetFormula));
  check("수식은 계산해 둔 결과까지 적는다", () =>
    /e\.result = v/.test(sheetEdit) && /\{ formula: f, result \}/.test(sheet));
  check("저장은 사람이 누를 때만 한다", () =>
    /function svSave\(t\)/.test(sheetEdit) && !/autosave/i.test(sheetEdit));
  // 이 함수가 다루는 칸이 모두 표의 것이라 앱 셸이 아니라 시트 쪽에 둔다.
  check("밖에서 바뀌어도 내 고침을 덮지 않는다", () => {
    const apply = b4Function(sheetTabState, "svApplyResponseData");
    const response = fnBody(viewerBoot, "handleSheetMessage");
    return /if\s*\(\s*isTabDirty\(t\)\s*\)\s*return false/.test(apply)
      && /if\s*\(\s*!svApplyResponseData\(t, m\.data\)\s*\)/.test(response);
  });
  check("바뀐 칸은 저장 전까지 표시가 남는다", () =>
    /\.sv-t td\.sv-dirty/.test(css("16-sheet-overlay")) && /t\._svDirty/.test(viewerBoot));
  check("고쳐 쓰기는 원본을 열어 그 칸만 간다", () => {
    const write = sliceFrom(sheet, "export async function writeWorkbook", sheet.length, "고쳐 쓰기는 원본을 열어 그 칸만 간다");
    const loader = sliceBetween(sheet, "async function loadWorkbook", "export async function readWorkbook", "고쳐 쓰기는 원본을 열어 그 칸만 간다");
    return /const wb = await loadWorkbook\(filePath\)/.test(write)
      && /await workbook\.xlsx\.readFile\(filePath\)/.test(loader)
      && /cell\.value = coerce\(e\.v, e\.result\)/.test(write);
  });
  check("서식을 바꾸면 파일에도 들어간다", () =>
    /function applyStyle\(cell, s\)/.test(sheet) && /e\.style = cur && cur\[1\]/.test(sheetEdit));
  check("열 폭·행 높이도 파일에 남는다", () =>
    /class="sv-cgrip"/.test(sheetRender) && /ws\.getColumn\(e\.layout\.i\)\.width/.test(sheet));
  // 원격은 전부 막고, 로컬은 스페이스 폴더 안이거나 이 앱에서 열어 본 파일에만 쓴다.
  // 뷰어로 연 파일은 저장할 수 있어야 하기 때문이다.
  check("표 쓰기는 로컬 + 스페이스 안이거나 열어 본 파일만", () =>
    /원격에서는 저장 불가/.test(sliceFrom(sheetHandlers, "export async function handleSheetWrite", sheetHandlers.length, "표 쓰기는 로컬 + 스페이스 안이거나 열어 본 파일만"))
    && /saveAllowed\(p\)/.test(sliceFrom(sheetHandlers, "export async function handleSheetWrite", sheetHandlers.length, "표 쓰기는 로컬 + 스페이스 안이거나 열어 본 파일만")));}

// ── 탭을 덮지 않는다 ────────────────────────────────────────────────────────
// 사용자가 지정한 탭에 다른 사이트를 로드하면 보던 화면이 안내 없이 사라진다.
console.log("\n[탭] 사람이 보던 화면을 덮지 않는다");
{
  const srv = read("server/browser-commands.js");
  const hp = read("server/human-path.js");
  const mcp = read("bin/iris-mcp.mjs");
  check("지목받은 탭에 다른 사이트를 싣지 않는다", () =>
    /function coverWarning\(session, tabId, url\)/.test(srv)
    && /!g\.has\(tabId\)/.test(srv) && /sameSiteUrl\(cur, url\)/.test(srv)
    && /const cover = coverWarning\(session, reuse, url\);/.test(srv));
  check("내가 만든 탭은 내가 쓴다", () =>            // 직접 만든 탭까지 막으면 탭 수만 늘어난다
    /String\(tabId\)\.startsWith\("browser:ai\."\)/.test(srv));
  check("덮는 대신 어느 길인지 말해 준다", () =>
    /browser_goto \(그 탭에서 이어집니다\)/.test(srv)
    && /browser_history \{action:"reload"\}/.test(srv)
    && /parallel:true/.test(srv));
  check("탭 만드는 자리에는 경계를 넓히는 통로가 없다", () => {   // 판정은 바깥에 두고 이 자리에는 두지 않는다
    const seg = sliceBetween(srv, "function createTabForSession", "function runBrowserCmd", "탭 만드는 자리에는 경계를 넓히는 통로가 없다");
    return !/grantTab/.test(seg);
  });
  check("같은 사이트 판정이 있다", () => /function sameSiteUrl\(a, b\)/.test(srv) && /function hostOfUrl\(u\)/.test(srv));
  check("같은 주소면 새로고침 길을 알려준다", () =>
    /const same = String\(currentUrl \|\| ""\)\.split\("#"\)\[0\]/.test(hp)
    && /browser_history \{action:"reload"\}/.test(hp));
  check("새로고침 도구가 그 이름으로 찾아진다", () =>
    /desc: "뒤로·앞으로·새로고침\(리로드·refresh·F5·⌘R\)/.test(mcp));
  check("new_tab은 새로고침에 쓰지 말라고 적혀 있다", () =>
    /새로고침에는 쓰지 않는다/.test(mcp) && /browser_history \{action:\\"reload\\"\}/.test(mcp));
}

// ── 화면 배경 ──────────────────────────────────────────────────────────────
console.log("\n[배경] 페이지는 흰 종이에서 시작한다");
check("webview 기본 배경이 흰색", () =>
  /\.wv-wrap webview \{[^}]*background:#fff/.test(css("18-browser")));

// ── 앱 메뉴 ────────────────────────────────────────────────────────────────
console.log("\n[메뉴] 화면을 다시 불러올 수 있다");
const menuSource = read("native/electron/menu.cjs");
check("보기 메뉴에 새로고침이 있다", () =>
  /role: "reload", label: "새로고침", accelerator: "Cmd\+R"/.test(menuSource)
  && /role: "forceReload"/.test(menuSource));
// 라벨만 있고 동작이 연결되지 않은 항목은 눌러도 아무 일이 없다. 그리고 "앱 새로고침" 에 가속기를
// 두면 앱 전역에서 먼저 발화해 브라우저 창의 페이지 강제 리로드(⌘⇧R)를 가로챈다.
// 소스 모양 검사로는 둘 다 확인할 수 없어, 메뉴를 실제로 만들어 항목을 호출한다.
await checkAsync("메뉴 항목은 라벨만 있지 않고, 앱 새로고침에는 가속기가 없다", async () => {
  const { createMenu } = require_("../native/electron/menu.cjs");
  let built = null;
  const imported = [];
  const reloaded = [];
  const menu = createMenu({
    Menu: { setApplicationMenu: () => {}, buildFromTemplate: (t) => { built = t; return t; } },
    BrowserWindow: { getFocusedWindow: () => null },
    dialog: { showMessageBox: async () => ({ response: 0 }) },
    platform: "darwin",
    getMainWindow: () => ({ loadURL: (u) => { reloaded.push(u); } }),
    appUrl: "http://127.0.0.1:4291",
    isBrowserModeWindow: () => false, isMemoWindow: () => false,
    allBrowserWindows: () => [], allMemoWindows: () => [],
    cookieImport: {
      importCookiesFromFile: async () => { imported.push("file"); return { canceled: true }; },
      listChromeProfiles: () => { imported.push("chrome"); return []; },
      importCookiesFromChrome: async () => ({ imported: 0, total: 0, skipped: 0, domains: [] }),
    },
  });
  const template = menu.build();
  if (!built || built !== template) throw new Error("메뉴를 실제로 만들지 않는다");
  const items = [];
  const walk = (nodes) => { for (const n of nodes || []) { items.push(n); walk(n.submenu); } };
  walk(template);
  // click 도 role 도 없는 항목은 눌러도 아무 일이 없다(구분선 제외).
  const dead = items.filter((n) => n.type !== "separator" && !n.role && !n.click && !n.submenu)
    .map((n) => n.label);
  if (dead.length) throw new Error(`눌러도 아무 일 없는 항목: ${dead.join(", ")}`);
  const appReload = items.find((n) => n.label === "앱 새로고침");
  if (!appReload) throw new Error("앱 새로고침 항목이 없다");
  if (appReload.accelerator) throw new Error(`앱 새로고침에 가속기가 붙었다: ${appReload.accelerator}`);
  appReload.click();
  if (reloaded.length !== 1) throw new Error("앱 새로고침이 메인 창을 다시 부르지 않는다");
  // 가져오기 두 항목이 각각 다른 흐름을 부른다.
  for (const label of ["쿠키 가져오기: Chrome에서…", "쿠키 가져오기: JSON 파일…"]) {
    const item = items.find((n) => n.label === label);
    if (!item || !item.click) throw new Error(`${label} 배선이 없다`);
    await item.click();
  }
  if (imported.join(",") !== "chrome,file") throw new Error(`가져오기 배선이 어긋난다: ${imported.join(",")}`);
  return true;
});

}
