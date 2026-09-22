// 시트 모델: 좌표·병합·스타일·메뉴 상수와 원본 셀 접근을 맡는다.
//
// 소유 범위
//   시트의 A1 좌표 변환, 병합 지도, 셀 스타일 직렬화, Google Sheets형 메뉴·도구 상수,
//   현재 sheet/style/source 조회 헬퍼.
//
// 제공 API
//   initSheetModel(): 기존 선언 위치를 보존하는 초기화 경계. 런타임 의존성과 부작용은 없다.
//   SV_ROW_H, SV_CHUNK, colName, parseA1, mergeMap, svAnchorOf, svStyle,
//   GS_*·SV_MENU_SUBLIST 상수, svSheet, svStyles, svStyleAt, svSrcAt.
//
// 의존 대상
//   없음. main이나 다른 sheet 모듈을 import하지 않는다.
//
// 유지 조건
//   A1 좌표는 1부터 시작하고, 병합된 숨은 칸은 대표 칸 좌표를 보존한다.
//   수식 칸의 svSrcAt은 계산 결과가 아니라 사람이 입력한 원문을 돌려준다.
//   메뉴·도구 이름과 순서는 Google Sheets 에서 확인한 값을 그대로 유지한다.
//
// 영향 범위
//   sheet/formula.js, sheet/conditional.js, main의 시트 렌더·편집·저장·메뉴·이벤트 전역.
//
// 옮긴 선언에는 최상위 부작용이 없지만, main 의 기존 시작점은 같은 위치에 남긴다.
export function initSheetModel() {}

// 원본에 걸린 고정(freeze)도 그대로 붙여, 오른쪽·아래로 밀어도 머리와 항목 칸이 따라다닌다.
export const SV_ROW_H = 24;     // 기본 행 높이(px)
export const SV_CHUNK = 300;    // 한 번에 그리는 줄 수. 만 줄을 한 번에 그리면 창이 그동안 멈춘다.

export function colName(n) { let s = ""; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - 1 - m) / 26; } return s; }
export function parseA1(ref) {
  const m = /^\$?([A-Z]+)\$?(\d+)$/.exec(String(ref).toUpperCase()); if (!m) return null;
  let c = 0; for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
  return { r: +m[2], c };
}
// "A1:R1" 목록 → 시작 칸에는 몇 칸을 먹는지, 가려진 칸에는 가려졌다는 표시.
export function mergeMap(merges) {
  // hidden은 가려졌다는 사실뿐 아니라 어느 칸에 병합됐는지까지 갖는다. 키보드로 이동할 때
  // 가려진 위치를 짚으면 그 위치를 대표하는 칸으로 옮겨야 하기 때문이다.
  const anchor = new Map(), hidden = new Map();
  for (const ref of merges || []) {
    const [a, b] = String(ref).split(":"); const s = parseA1(a), e = parseA1(b || a);
    if (!s || !e) continue;
    const r1 = Math.min(s.r, e.r), r2 = Math.max(s.r, e.r), c1 = Math.min(s.c, e.c), c2 = Math.max(s.c, e.c);
    anchor.set(r1 + "," + c1, { rs: r2 - r1 + 1, cs: c2 - c1 + 1 });
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) if (r !== r1 || c !== c1) hidden.set(r + "," + c, [r1, c1]);
  }
  return { anchor, hidden };
}
// 가려진 위치를 짚으면 그 위치를 대표하는 칸으로 옮긴다.
export function svAnchorOf(t, r, c) { const h = t._svMerge && t._svMerge.hidden.get(r + "," + c); return h ? { r: h[0], c: h[1] } : { r, c }; }
export function svStyle(st, isNum) {
  if (!st) return isNum ? "text-align:right" : "";
  const p = [];
  if (st.b) p.push("font-weight:700");
  if (st.i) p.push("font-style:italic");
  if (st.u || st.st) p.push("text-decoration:" + [st.u ? "underline" : "", st.st ? "line-through" : ""].filter(Boolean).join(" "));
  // 엑셀·구글 시트의 글자 크기는 포인트다. 행 높이는 이미 포인트를 픽셀로 바꿔 싣고 있으므로
  // (server/sheet.js: 높이 × 1.34) 글자만 포인트를 픽셀 수처럼 쓰면 줄 높이에 비해 작아진다.
  // 같은 96dpi 환산(1pt = 4/3px)을 쓴다.
  if (st.fs) p.push("font-size:" + Math.max(8, Math.min(120, Math.round(st.fs * 4 / 3 * 10) / 10)) + "px");
  // 폰트 이름은 작은따옴표로 감싼다. 큰따옴표를 쓰면 style="…" 속성이 거기서 끊겨, 뒤에 오는
  // 색·배경·테두리가 통째로 사라진다(확인 결과: 굵기·크기만 남고 나머지가 유실).
  if (st.ff) p.push("font-family:'" + String(st.ff).replace(/['"\\]/g, "") + "',var(--ui-font),sans-serif");
  if (st.c) p.push("color:" + st.c);
  if (st.bg) p.push("background:" + st.bg);
  // 정렬을 지정하지 않은 칸은 엑셀 기본을 따른다. 숫자는 오른쪽, 글자는 왼쪽이다.
  p.push("text-align:" + (st.ha === "center" ? "center" : st.ha === "right" ? "right" : st.ha ? "left" : (isNum ? "right" : "left")));
  if (st.va) p.push("vertical-align:" + (st.va === "middle" ? "middle" : st.va === "bottom" ? "bottom" : "top"));
  if (st.wrap) p.push("white-space:pre-wrap");
  if (st.ind) p.push("padding-left:" + (4 + st.ind * 8) + "px");
  // "텍스트 회전" 툴바 버튼(svToolbar case "rotate")은 이미 st.rot을 저장하지만 여기서 렌더링을
  // 하지 않으면 실제로 회전이 적용되지 않는다(docx의 "enabled but not
  // wired" 패턴과 같은 유형). 각도는 엑셀·구글시트 관례(양수=반시계 위쪽)라 CSS rotate()의
  // 시계방향 부호와 반대로 뒤집는다. GS_ROTATE의 255("세로로 쌓기")는 각도가 아니라 세로쓰기
  // 모드를 가리키는 별도 sentinel이라 회전이 아니라 writing-mode로 렌더링한다.
  if (st.rot === 255) p.push("writing-mode:vertical-rl;text-orientation:upright");
  else if (st.rot) p.push("transform:rotate(" + (-st.rot) + "deg);transform-origin:center");
  // "셀 왼쪽/오른쪽에서" 툴바 버튼(ltr-cell/rtl-cell)이 쓰는 셀 단위 텍스트 방향.
  if (st.dir) p.push("direction:" + st.dir);
  if (st.bl) p.push("border-left:" + st.bl);
  if (st.br) p.push("border-right:" + st.br);
  if (st.bt) p.push("border-top:" + st.bt);
  if (st.bb) p.push("border-bottom:" + st.bb);
  // 마지막 안전장치. 어떤 값에 큰따옴표가 섞여도 style 속성이 먼저 닫히지 않게 한다.
  return p.join(";").replace(/"/g, "'");
}

// ── 구글 시트에서 그대로 뽑아 온 메뉴·도구 모음 ─────────────────────────────
// 실행 중인 구글 시트 화면에서 전수로 수집했다(도구 모음은 aria-label, 메뉴는
// .goog-menuitem). 이름·순서·단축키 표기를 바꾸지 않는다. 바꾸면 더 이상
// 구글 시트가 아니다. 하위 메뉴가 있는 항목은 sub로 표시한다(구글 시트의 ►와 같다).
export const GS_MENUS = [
  { k: "file", n: "파일", items: [
    ["새 문서", "", 1], ["열기", "⌘O"], ["가져오기", ""], ["사본 만들기", ""],
    ["이름 바꾸기", ""], ["이동", ""], ["휴지통으로 이동", ""],
    ["세부정보", ""], ["설정", ""], ["인쇄", "⌘P"],
  ] },
  { k: "edit", n: "수정", items: [
    ["실행취소", "⌘Z"], ["재실행", "⌘Y"], ["잘라내기", "⌘X"], ["복사", "⌘C"], ["붙여넣기", "⌘V"],
    ["선택하여 붙여넣기", "", 1], ["이동", "", 1], ["삭제", "", 1], ["찾기 및 바꾸기", "⌘⇧H"],
  ] },
  { k: "view", n: "보기", items: [
    ["표시", "", 1], ["고정", "", 1], ["그룹", "", 1], ["숨겨진 시트", "", 1],
    ["확대/축소", "", 1], ["전체 화면", ""],
  ] },
  { k: "insert", n: "삽입", items: [
    ["셀", "", 1], ["행", "", 1], ["열", "", 1], ["시트", "⇧F11"], ["표 생성", ""],
    ["차트", ""], ["피봇 테이블", ""], ["이미지", "", 1], ["그림", ""],
    ["함수", "", 1], ["링크", "⌘K"], ["체크박스", ""], ["드롭다운", ""],
    ["메모", "⇧F2"],
  ] },
  { k: "format", n: "서식", items: [
    ["테마", ""], ["숫자", "", 1], ["텍스트", "", 1], ["정렬", "", 1], ["줄바꿈", "", 1],
    ["회전", "", 1], ["글꼴 크기", "", 1], ["셀 병합", "", 1],
    ["표로 변환", "⌘⌥T"], ["조건부 서식", ""], ["교차 색상", ""], ["서식 지우기", "⌘\\"],
  ] },
  { k: "data", n: "데이터", items: [
    ["최적화 문제 풀이", ""], ["시트 정렬", "", 1], ["범위 정렬", "", 1],
    ["필터 삭제", ""], ["슬라이서 추가", ""], ["이름이 지정된 범위", ""],
    ["이름이 지정된 함수", ""], ["범위 임의로 섞기", ""], ["열 통계", ""], ["데이터 확인", ""],
    ["데이터 정리", "", 1], ["텍스트를 열로 분할", ""], ["데이터 추출", ""],
  ] },
];

// GS_MENUS의 세 번째 값(▸ 표시)이 붙은 항목 중 실제로 목록을 여는 것만 담는다. 나머지
// (새 문서·이동·셀 병합·그룹·데이터 정리 등)는 ▸가 붙어 있어도 대화상자나 단일 동작이라 목록이
// 없다(구글 시트 화면을 그대로 옮긴 결과라 이 앱의 실제 동작과 다른 항목이 섞여 있다).
// 여기 있는 라벨만 docx처럼 팝업 안 아코디언으로 펼치고, 나머지는 눌러야 여는 방식이다.
export const SV_MENU_SUBLIST = new Set(["선택하여 붙여넣기", "삭제", "표시", "고정", "숨겨진 시트",
  "확대/축소", "셀", "행", "열", "함수", "숫자", "텍스트", "정렬", "줄바꿈", "회전", "글꼴 크기",
  "시트 정렬", "범위 정렬"]);

// 도구 모음: 구글 시트에 뜨는 순서 그대로. [동작키, 라벨(그대로), 화면에 그릴 글자]
// "|"는 구글 시트의 구분선 위치다.
export const GS_TOOLBAR = [
  ["undo", "실행취소 (⌘Z)", "↺"],
  ["redo", "재실행 (⌘Y)", "↻"],
  ["print", "인쇄 (⌘P)", "⎙"],
  ["painter", "서식 복사", "🖌"],
  ["painter-paste", "서식 붙여넣기", "🖍"],
  "|",
  ["nf-won", "통화 형식", "₩"],
  ["nf-pct", "퍼센트 형식", "%"],
  ["nf-dec-", "소수점 이하 자릿수 감소", ".0"],
  ["nf-dec+", "소수점 이하 자릿수 증가", ".00"],
  ["nf-more", "서식 더보기", "123"],
  "|",
  ["font", "글꼴", ""],
  ["fs-", "글꼴 크기 작게 (⌘⇧,)", "−"],
  ["fs", "글꼴 크기", ""],
  ["fs+", "글꼴 크기 크게 (⌘⇧.)", "＋"],
  "|",
  ["fmt-bold", "굵게 (⌘B)", "B"],
  ["fmt-ital", "기울임 (⌘I)", "I"],
  ["fmt-strk", "취소선 (⌘⇧X)", "S"],
  ["color-text", "텍스트 색상", "A"],
  ["color-fill", "채우기 색상", "▨"],
  ["border", "테두리", "⊞"],
  "|",
  ["merge", "셀 병합", "⇹"],
  ["merge-kind", "병합 유형 선택", "▾"],
  ["align-h", "가로 맞춤", "≡"],
  ["align-v", "세로 맞춤", "⇕"],
  ["wrap", "텍스트 줄바꿈", "⏎"],
  ["rotate", "텍스트 회전", "⤢"],
  "|",
  ["link", "링크 삽입 (⌘K)", "🔗"],
  ["chart", "차트 삽입", "📊"],
  ["filter-clear", "필터 삭제", "⌦"],
  ["filter-view", "필터 보기", "▽"],
  ["fn", "함수", "Σ"],
  "|",
  ["rtl-sheet", "시트 오른쪽에서 왼쪽으로", "⇄"],
  ["ltr-cell", "셀 왼쪽에서 오른쪽으로", "⇥"],
  ["rtl-cell", "셀 오른쪽에서 왼쪽으로", "⇤"],
  ["a11y", "접근성", "♿"],
  ["hide-menu", "메뉴 숨기기 (Ctrl+⇧F)", "⌃"],
];

export const GS_FONTS = ["Arial", "나눔고딕", "맑은 고딕", "Roboto", "Times New Roman", "Courier New", "Verdana", "Georgia"];
export const GS_SIZES = [6, 7, 8, 9, 10, 11, 12, 14, 18, 24, 36];
// 구글 시트 팔레트 첫 줄·표준색.
export const GS_COLORS = ["#000000", "#434343", "#666666", "#999999", "#b7b7b7", "#cccccc", "#d9d9d9", "#efefef", "#f3f3f3", "#ffffff",
  "#980000", "#ff0000", "#ff9900", "#ffff00", "#00ff00", "#00ffff", "#4a86e8", "#0000ff", "#9900ff", "#ff00ff",
  "#e6b8af", "#f4cccc", "#fce5cd", "#fff2cc", "#d9ead3", "#d0e0e3", "#c9daf8", "#cfe2f3", "#d9d2e9", "#ead1dc"];
export const GS_NUMFMT = [
  ["자동", ""], ["일반 텍스트", "@"], ["숫자", "#,##0.00"], ["퍼센트", "0.00%"],
  ["과학", "0.00E+00"], ["회계", "_(₩* #,##0.00_)"], ["재무", "#,##0.00;(#,##0.00)"],
  ["통화", "₩#,##0.00"], ["통화(반올림)", "₩#,##0"], ["날짜", "yyyy-mm-dd"],
  ["시간", "hh:mm:ss"], ["날짜 시간", "yyyy-mm-dd hh:mm:ss"], ["기간", "[h]:mm:ss"],
];
export const GS_ALIGN_H = [["왼쪽", "left"], ["가운데", "center"], ["오른쪽", "right"]];
export const GS_ALIGN_V = [["위쪽", "top"], ["가운데", "middle"], ["아래쪽", "bottom"]];
export const GS_WRAP = [["넘치기", 0], ["줄바꿈", 1], ["자르기", 2]];
export const GS_ROTATE = [["없음", 0], ["위로 기울이기", 45], ["아래로 기울이기", -45], ["세로로 쌓기", 255], ["위로 회전", 90], ["아래로 회전", -90]];
export const GS_BORDERS = [["모두", "all"], ["안쪽", "inner"], ["바깥쪽", "outer"], ["가로", "h"], ["세로", "v"],
  ["위", "top"], ["아래", "bottom"], ["왼쪽", "left"], ["오른쪽", "right"], ["없음", "none"]];


export function svSheet(t) { const d = t.sheet; return d && d.sheets[Math.min(t.sheetIdx || 0, d.sheets.length - 1)]; }
export function svStyles(t) { return (t.sheet && t.sheet.styles) || []; }
export function svStyleAt(t, sh, r, c) { const v = sh.cells[r + "," + c]; return v && v[1] ? svStyles(t)[v[1] - 1] : null; }

// 사용자가 그 칸에 입력한 값. 수식 칸은 결과가 아니라 수식을 돌려준다. 편집에는 그 값이 필요하다.
export function svSrcAt(sh, r, c) {
  const k = r + "," + c;
  if (sh.src && sh.src[k] != null) return String(sh.src[k]);
  const v = sh.cells[k];
  return v ? String(v[0]) : "";
}
