// 터미널에서 고른 글자를 읽을 수 있는 글로 되돌린다. 가짜 줄바꿈과 가짜 들여쓰기를 제거한다.
//
// 소유 범위
//   접힌 줄 잇기(가짜 줄바꿈 판정), 블록 공통 들여쓰기 벗기기, 첫 줄 들여쓰기 폭 판정,
//   그리고 xterm 선택 범위를 그 규칙으로 정리한다.
//
// 제공 API
//   alignFirstRow · copyIndentWidth · rowsToText · cropAwareSelection.
//
// 의존 대상
//   panel/terminal 의 xterm·selSkip·detectOrigin 접근자와 web/scrollback-copy.js 의 terminalContentRow.
//   그 classic script 는 index.html 이 이 모듈보다 먼저 싣는다.
//
// 유지 조건
//   열화·구멍을 조용히 완전본처럼 복사하지 않는다.
//   이 셋은 export 문으로 따로 내보낸다. 선언 앞에 export 를 붙이면 검사가 함수 원문만 떼어
//   Node 에서 그대로 돌리는 경로가 깨진다(bin/smoke 의 b4Function).
//
// 영향 범위
//   chatcopy/boot 의 자동 복사와 chatcopy/edge-drag 의 최종 텍스트 조립.
//   현재 목록 확인: node bin/importers.mjs web/js/chatcopy/copy-text.js
import { detectOrigin, getXterm, selSkip } from "../panel/terminal.js";

// pane 왼쪽의 짧은 빈 접두부만 블록 들여쓰기로 인정한다. 실제 글자 중간에서 시작한 선택은 0이다.
// 입력창의 `❯ `, 답변 첫 줄의 `⏺ ` 처럼 표시 하나와 공백으로 시작하는 줄도 다음 줄들이 그 폭만큼
// 들여 그려진다. 표시 뒤부터 고르면 첫 줄에는 들여쓰기가 없고 다음 줄에만 두 칸이 남는다.
function copyIndentWidth(prefix, inset) {
  const width = Number.isFinite(inset) ? Math.floor(inset) : 0;
  if (width <= 0 || width > 6) return 0;
  const text = String(prefix || "");
  return [...text].length === width && /^[❯>⏺⎿✻✽✶●○◦▪▸►·]?[ \u00a0]+$/u.test(text) ? width : 0;
}
// 드래그 시작점은 표시와 글자 사이 공백에 떨어지기 쉽다. 그러면 첫 행이 공백으로 시작하고 앞부분에는
// 표시만 남아 들여쓰기로 인정되지 않는다. 선택이 줄 앞 여백(표시·공백뿐인 자리)에서 시작했을 때만
// 첫 행의 앞 공백을 앞부분으로 옮긴다. 줄 중간에서 시작한 선택은 그대로 둔다.
function alignFirstRow(rows, prefix, inset) {
  const first = String(rows[0] ?? "");
  const lead = first.length - first.replace(/^ +/, "").length;
  if (!lead || !INDENT_PREFIX.test(String(prefix || ""))) return { rows, prefix, inset };
  return { rows: [first.slice(lead), ...rows.slice(1)], prefix: prefix + " ".repeat(lead), inset: inset + lead };
}
// Claude Code 는 입력창 표시 뒤에 줄바꿈 없는 공백(U+00A0)을 둔다.
const INDENT_PREFIX = /^[❯>⏺⎿✻✽✶●○◦▪▸►·]?[ \u00a0]*$/u;

// 선택 첫 줄에서 이미 잘린 블록 들여쓰기를 후속 논리 줄에도 맞춘다. pane 왼쪽 6칸 안에서
// 시작한 선택만 대상으로 삼아, 줄 중간부터 고른 범위나 후속 줄의 독립적인 들여쓰기는 건드리지 않는다.
// TUI가 글머리 기호로 여는 블록. 표시는 왼쪽 끝에 붙고 그 아래 본문은 기호 폭만큼 들여써
// 정렬된다. 그 들여쓰기는 글의 구조가 아니라 화면 정렬이다. 그런데 표시줄만 0칸이라
// 공통 들여쓰기가 0이 되어 아무것도 제거되지 않고, 결과가 "표시 하나 뒤로 전부가 그 안에 든
// 것처럼" 읽힌다. 그래서 공통값을 계산할 때 표시줄은 제외하고, 제거는 모든 줄에 적용한다.
function stripCopyIndent(text, firstInset = 0) {
  const blockMark = (ln) => /^[⏺⎿✻✽✶●○◦▪▸►·]\s/u.test(ln);
  const lines = text.split("\n");
  const indentOf = (ln) => ln.length - ln.replace(/^ +/, "").length;
  const body = lines.filter((ln) => ln.trim() && !blockMark(ln));
  let common = Infinity;
  for (const ln of (body.length ? body : lines)) {
    if (!ln.trim()) continue;
    common = Math.min(common, indentOf(ln));
    if (!common) break;
  }
  // 표시줄은 이미 왼쪽 끝이라 더 줄일 것이 없다. 나머지만 같은 폭으로 당긴다.
  if (common > 0 && common !== Infinity)
    return lines.map((ln) => (blockMark(ln) ? ln : ln.slice(common))).join("\n");

  const inset = Number.isFinite(firstInset) ? Math.floor(firstInset) : 0;
  if (inset <= 0 || inset > 6 || lines.length < 2) return text;
  let following = Infinity;
  for (let i = 1; i < lines.length; i++) {
    const ln = lines[i]; if (!ln.trim()) continue;
    following = Math.min(following, ln.length - ln.replace(/^ +/, "").length);
    if (!following) break;
  }
  const clipped = Math.min(inset, following);
  if (!(clipped > 0) || clipped === Infinity) return text;
  return [lines[0], ...lines.slice(1).map((ln) => ln.slice(clipped))].join("\n");
}
// 행 배열 → 최종 텍스트(가짜 줄바꿈 이어붙이기 + 블록 공통 들여쓰기 제거).
function rowsToText(rows, skip, firstInset = 0, paneEdge = 0, firstLead = 0) {
  const xterm = getXterm();
  const pathCh = /[\w./@+%~-]/;
  // 가짜 줄바꿈(터미널 폭) vs 진짜 줄바꿈 구별. 핵심 신호: 터미널은 "다음 단어가 남은 폭에 안
  // 들어갈 때" 강제로 줄을 넘긴다. 그래서 (현재 줄 컬럼폭 + 다음 줄 첫 단어 컬럼폭 + 1) > paneW 이면
  // 다음 단어가 안 들어가서 넘어간 것 = 가짜 줄바꿈(이어붙임). 그 조건이 아니면 = 진짜 줄바꿈(유지).
  // 한글 등 전각 문자는 터미널에서 2칸을 차지하므로 글자 수가 아니라 컬럼폭으로 계산한다.
  // 폭 0 인 글자. 함께 계산하면 줄이 실제보다 넓어지고, 접힌 줄로 오판해 진짜 줄바꿈이 사라진다.
  // 가장 자주 걸리는 것은 NFD 로 분해된 한글 자모다. macOS 파일 이름이 그 형태로 온다. 자모를
  // 1칸씩 계산하면 "한" 이 2칸이 아니라 4칸이 된다(확인 결과: 이 프로젝트 기록 622MB 에서 2,744회).
  const zeroW = (c) => c < 0x20 || (c >= 0x7f && c <= 0x9f) || (c >= 0x0300 && c <= 0x036f) ||
    (c >= 0x0483 && c <= 0x0489) || (c >= 0x1160 && c <= 0x11ff) || (c >= 0x1ab0 && c <= 0x1aff) ||
    (c >= 0x1dc0 && c <= 0x1dff) || (c >= 0x200b && c <= 0x200f) ||
    (c >= 0x2060 && c <= 0x2064) || (c >= 0x20d0 && c <= 0x20ef) || (c >= 0x302a && c <= 0x302f) ||
    (c >= 0x3099 && c <= 0x309a) || (c >= 0xfe00 && c <= 0xfe0f) || (c >= 0xfe20 && c <= 0xfe2f) ||
    c === 0xfeff || (c >= 0xd7b0 && c <= 0xd7c6) || (c >= 0xd7cb && c <= 0xd7fb) ||
    (c >= 0xe0001 && c <= 0xe007f) || (c >= 0xe0100 && c <= 0xe01ef);
  // 이모지는 2칸이다. Claude Code(Ink/string-width)와 Codex(ratatui/unicode-width)도 같게 계산한다.
  // 다만 한 덩어리로 계산한다. `👩‍💻` 는 코드포인트 셋이지만 화면에서는 2칸 하나다. 코드포인트마다
  // 더하면 4칸이 되어 줄이 실제보다 넓어지고, 넓어진 줄은 접힌 줄로 오판된다.
  // 이음쇠(ZWJ)·피부색·국기 짝·변이 선택자(VS16)를 앞 글자에 흡수시켜 한 번만 계산한다.
  // TUI 자신의 표시(⏺ ⎿ ✻ ⏵)는 단독이면 1칸이다. VS16 이 붙으면 아래 규칙이 2칸으로 올린다.
  const emojiW = (c) => (c >= 0x1f300 && c <= 0x1faff) || c === 0x1f004 || c === 0x1f0cf ||
    c === 0x1f18e || (c >= 0x1f191 && c <= 0x1f19a) || (c >= 0x1f201 && c <= 0x1f202) ||
    c === 0x1f21a || c === 0x1f22f || (c >= 0x1f232 && c <= 0x1f23a) ||
    (c >= 0x1f250 && c <= 0x1f251) || (c >= 0x231a && c <= 0x231b) ||
    (c >= 0x23e9 && c <= 0x23ec) || c === 0x23f0 || c === 0x23f3 || (c >= 0x25fd && c <= 0x25fe) ||
    (c >= 0x2614 && c <= 0x2615) || (c >= 0x2648 && c <= 0x2653) || c === 0x267f || c === 0x2693 ||
    c === 0x26a1 || (c >= 0x26aa && c <= 0x26ab) || (c >= 0x26bd && c <= 0x26be) ||
    (c >= 0x26c4 && c <= 0x26c5) || c === 0x26ce || c === 0x26d4 || c === 0x26ea ||
    (c >= 0x26f2 && c <= 0x26f3) || c === 0x26f5 || c === 0x26fa || c === 0x26fd || c === 0x2705 ||
    (c >= 0x270a && c <= 0x270b) || c === 0x2728 || c === 0x274c || c === 0x274e ||
    (c >= 0x2753 && c <= 0x2755) || c === 0x2757 || (c >= 0x2795 && c <= 0x2797) || c === 0x27b0 ||
    c === 0x27bf || (c >= 0x2b1b && c <= 0x2b1c) || c === 0x2b50 || c === 0x2b55;
  const wideW = (c) => (c >= 0x1100 && c <= 0x115F) || c === 0x2329 || c === 0x232A ||
    (c >= 0x2E80 && c <= 0xA4CF) || (c >= 0xAC00 && c <= 0xD7A3) || (c >= 0xF900 && c <= 0xFAFF) ||
    (c >= 0xFE10 && c <= 0xFE19) || (c >= 0xFE30 && c <= 0xFE6F) || (c >= 0xFF00 && c <= 0xFF60) ||
    (c >= 0xFFE0 && c <= 0xFFE6) || (c >= 0x20000 && c <= 0x3FFFD) || emojiW(c);
  // 변이 선택자(VS16)는 아무 글자나 2칸으로 올리지 않는다. 이모지가 될 수 있는 글자에만 붙는다.
  // 'A' + VS16 은 여전히 1칸이다.
  const vsBase = (c) => c === 0xa9 || c === 0xae || c === 0x203c || c === 0x2049 || c === 0x2122 ||
    c === 0x2139 || (c >= 0x2194 && c <= 0x21aa) || (c >= 0x231a && c <= 0x23fa) || c === 0x24c2 ||
    (c >= 0x25aa && c <= 0x25fe) || (c >= 0x2600 && c <= 0x27bf) || (c >= 0x2934 && c <= 0x2935) ||
    (c >= 0x2b00 && c <= 0x2b55) || c === 0x3030 || c === 0x303d || c === 0x3297 || c === 0x3299 ||
    (c >= 0x1f000 && c <= 0x1faff);
  const pict = (c) => (c >= 0x1f000 && c <= 0x1faff) || (c >= 0x2600 && c <= 0x27bf) ||
    (c >= 0x2190 && c <= 0x2b55) || c === 0xa9 || c === 0xae;
  const colW = (str) => {
    const cp = []; for (const ch of str) cp.push(ch.codePointAt(0));
    const RI = (c) => c >= 0x1f1e6 && c <= 0x1f1ff;
    let w = 0, i = 0;
    while (i < cp.length) {
      const c = cp[i];
      if (zeroW(c)) { i += 1; continue; }
      // 국기는 지역 표시 문자 둘이 한 덩어리다. 홀수로 남은 하나는 그냥 1칸이다.
      if (RI(c)) {
        if (RI(cp[i + 1])) { w += 2; i += 2; } else { w += 1; i += 1; }
        continue;
      }
      let cw = wideW(c) ? 2 : 1;
      const base = c;
      i += 1;
      if (cp[i] === 0xfe0f) { if (vsBase(base)) cw = 2; i += 1; }
      // 키캡(`1️⃣`)은 숫자·#·* 에 감싸는 부호가 붙은 한 덩어리이고 2칸으로 표시된다
      if (cp[i] === 0x20e3 && (base === 0x23 || base === 0x2a || (base >= 0x30 && base <= 0x39))) cw = 2;
      for (;;) {
        // 피부색은 사람 모양 뒤에만 붙는다
        if (pict(base) && cp[i] >= 0x1f3fb && cp[i] <= 0x1f3ff) { i += 1; continue; }
        // 이음쇠는 그림문자끼리만 잇는다. 뒤가 평범한 글자면 흡수하지 않는다
        if (cp[i] === 0x200d && pict(cp[i + 1])) {
          i += 2;
          if (cp[i] === 0xfe0f) i += 1;
          if (cp[i] >= 0x1f3fb && cp[i] <= 0x1f3ff) i += 1;
          continue;
        }
        break;
      }
      w += cw;
    }
    return w;
  };
  const paneW = xterm.cols - 1 - skip; // 사이드바·우측 테두리 제외한 content 폭(컬럼, 패딩만큼 과대추정 가능)
  // 측정한 wrap 경계: 감긴 행들은 pane 오른쪽 끝까지 찼으므로 선택 내 행 최대 컬럼폭이 실제 wrap 폭에
  // 가깝다(패딩 추정 오차 제거 → 긴 한 줄 중간에 줄바꿈 새는 것 방지). 단 전부 짧은 진짜 줄바꿈만
  // 있으면(최대폭이 paneW에 못 미침) 실제 경계가 아니므로 paneW를 써서 과결합을 막는다.
  // 경계를 고른 행들에서만 추정하면 같은 두 행의 판정이 함께 고른 범위에 따라 달라진다.
  // (반례: ["abcdef","g"] 는 이어붙지만, 뒤에 "0123456789" 를 함께 고르면 이어붙지 않는다.)
  // 그래서 부르는 쪽이 화면 전체에서 측정한 경계를 준다. 없으면 고른 행으로 추정한다.
  const measured = Number.isFinite(paneEdge) && paneEdge > 0 ? Math.floor(paneEdge) : 0;
  let maxCW = measured;
  if (!maxCW) for (const r of rows) { const w = colW(r); if (w > maxCW) maxCW = w; }
  // 경계에 2칸 여유(margin): 전각(한글) 문자는 오른쪽에 1칸만 남으면 못 들어가 실제 wrap이 추정 경계보다
  // 1~2칸 일찍 일어나고, 우측 패딩 추정 오차도 있다. 합이 경계와 같아 탈락하는 실제
  // wrap(확인 결과: sum=69 vs edge=69)을 이어붙이도록 2칸 낮춘다. 짧은 진짜 줄바꿈은 합이 훨씬 작아 무영향.
  const edgeW = (maxCW >= paneW - 6) ? maxCW : paneW;
  const wrapEdge = edgeW - 2;
  // 폭은 pane 왼쪽 끝부터 잰 원래 행의 폭이다. 이어 붙이면서 다음 행의 들여쓰기를 제거하고, 첫 행은
  // 선택 시작 앞(firstLead 칸)이 빠져 있다. 빠진 글자로 재면 행이 실제보다 좁아져, 경계까지 찬 행이
  // "공간이 남았다"로 읽히고 잘린 토큰 사이에 공백이 들어간다.
  const widths = rows.map((r, i) => colW(r) + (i === 0 ? Math.max(0, firstLead | 0) : 0));
  let out = "";
  for (let i = 0; i < rows.length; i++) {
    out += rows[i];
    if (i >= rows.length - 1) continue;
    const cur = rows[i], next = rows[i + 1];
    const nextStripped = next.replace(/^\s+/, "");
    const nextWord = (nextStripped.match(/^\S+/) || [""])[0];
    // 목록·표·도구 트리는 화면 폭과 무관하게 새 논리 행이다. 앞 행이 우연히 pane 끝까지 차도
    // 가짜 wrap으로 합치면 두 항목이 한 줄이 된다.
    // 표시 목록은 실제 화면에서 측정한 것만 넣는다. 확인 결과(터미널 행 560개) 줄 시작 대 줄 중간 비율은
    // ⏺ 15:0 · ⎿ 8:0 · ✻ 8:1 · ※ 6:0 만 넣는다. ⏵ 는 0:7 이라 빼고,
    // ❯ 는 1:0 이라 전역 규칙으로 삼기에는 근거가 부족해 제외한다.
    // · 도 제외한다. 산문에서 구분 기호로 쓰여, 그 앞에서 접힌 줄이 새 항목으로
    // 오판된다(확인 결과: 이 저장소 문서 1,030줄 중 3곳).
    const structuralLine = /^(?:[-+*•]\s+|\d+[.)]\s+|\|\s*|[│└├╭╰┏┗┣┃]\s*|[⏺⎿✻✽✶※]\s)/u.test(nextStripped);
    // 표 경계선·구분선은 그 자체로 완결된 줄이다. 폭을 꽉 채우니 접힌 줄처럼 보이지만 접힌 것이
    // 아니다. 이어붙이면 표 한 줄이 다음 칸 내용과 한 덩어리가 된다(확인 결과: ├──┼──┤ 뒤에 표 본문
    // 행이 이어붙었다).
    const rulerish = (ln) =>
      /^[\s─━┄┈╌┼╬┬┴├┤┌┐└┘│═╦╩╠╣╔╗╚╝╭╮╯╰┏┓┗┛┣┫┳┻╋┃┆┊▔▁=_-]+$/u.test(ln)
      && /[─━═┄┈╌┼╬┬┴├┤┌┐└┘╭╮╯╰┏┓┗┛┣┫┳┻╋▔▁]/u.test(ln);
    // 다음 행이 경계선일 때도 붙이지 않는다. 앞 행만 보면 산문 뒤에 상자 윗줄이 이어붙는다.
    // ASCII 반복선(`---`)은 눈금으로 보지 않는다. 잘린 토큰의 뒷조각과 구별할 길이 없다
    // ("abcdefghij" + "---" 은 `abcdefghij---` 한 토큰이 잘린 것일 수 있다).
    const rulerLine = rulerish(cur) || rulerish(next);
    const wrapped = cur.trim() !== "" && next.trim() !== "" &&
      !structuralLine && !rulerLine && (widths[i] + colW(nextWord) + 1) > wrapEdge; // 다음 단어가 안 들어감 → 가짜 줄바꿈
    if (!wrapped) { out += "\n"; continue; } // 진짜 줄바꿈 유지
    // 이어 붙일 때도 두 경우를 나눈다. pane의 남은 셀보다 다음 글자가 넓으면 토큰 자체가 잘린 것이라
    // 공백이 없고, 글자는 들어가지만 다음 단어 전체가 못 들어간 것이면 원래 단어 경계 공백을 복원한다.
    const curWidth = widths[i];
    // 여기서 정할 것은 하나다. 경계에서 사라진 것이 단어 사이 공백인지, 토큰이 통째로 잘린 것인지다.
    // 이 경로는 대체 화면 TUI에서만 실행된다(edgeStart). 그런 화면은 단어 단위로 줄을 넘긴다. 다음 단어가
    // 남은 폭에 안 들어가면 단어째로 넘기고, 그때 단어 사이 공백이 사라진다. 토큰이 정말 잘리는
    // 것은 그 토큰이 한 줄에 들어가지 않을 때뿐이다. 그 길이로 구분한다.
    //
    // "줄이 끝까지 찼는가"(splitAtCellEdge)와 "양쪽이 한글인가"(hangulSplit)로는 가를 수 없다.
    // 단어 단위로 줄을 넘기는 화면에서는 접히는 줄이 늘 끝까지 차 있어 둘 다 산문에서 항상 참이 되고,
    // 그 결과 공백이 사라진다. 확인 결과: 공백 없이 붙은 13곳이 전부 단어 경계였고 토큰 분리는
    // 0곳이었다("…원인은"+"내가…", "…추측은 그"+"순간의…").
    const lastTok = (cur.match(/\S+$/) || [""])[0];
    const pathToken = /[./@~%]/.test(lastTok + nextWord)
      && pathCh.test(cur.slice(-1)) && pathCh.test(nextStripped[0] || "");
    // 토큰이 잘린 것으로 보려면 둘 다여야 한다.
    //  (1) 줄에 다음 글자 한 칸도 남지 않았다. 공간이 남았는데 채우지 않았다면 단어째로 넘긴 것이다.
    //  (2) 그 토큰이 한 줄에 들어가지 않는다. 들어갔다면 줄을 넘기는 쪽이 통째로 넘겼을 것이다.
    // (1)만 보면 산문이 늘 걸리고(접히는 줄은 늘 꽉 차 있다), (2)만 보면 짧은 두 단어가
    // 폭을 살짝 넘길 때 붙어버린다.
    const firstWidth = colW(Array.from(nextStripped)[0] || " ");
    // 기준 폭을 고를 때 근거의 출처를 구분한다. 화면에서 측정한 경계는 그대로 쓴다. 고른 행들의 최대폭은
    // 쓰지 않는다. 행이 적으면 실제 경계보다 훨씬 좁게 잡히고("abcdef"+"ghijk" 두 줄이면 6칸이
    // 경계가 된다) 그러면 짧은 줄이 "꽉 찼다"로 읽혀 단어 사이 띄어쓰기가 사라진다. 그때는
    // 공간이 남았음을 확인해야 하므로 상한인 paneW 로 계산한다.
    const tokenEdge = measured || paneW;
    const atCellEdge = (tokenEdge - curWidth) < Math.max(1, firstWidth);
    const tokenTooLong = colW(lastTok) + colW(nextWord) > tokenEdge;
    // 경로처럼 보이는 것도 줄이 꽉 찼을 때만 잘린 것이다. 공간이 남았으면 단어째로 넘긴 것이므로
    // 띄어쓰기가 있었다. 이 조건 없이 두면 "aside"+"docs/x.json" 이 "asidedocs/x.json" 이 된다
    // (확인 결과: 접힌 위치 446곳 중 8곳에서 띄어쓰기가 사라졌고, 이 조건을 두면 0곳이다).
    const midToken = atCellEdge && (pathToken || tokenTooLong);
    rows[i + 1] = nextStripped;
    if (!midToken) out += " ";
  }
  out = out.replace(/[ \n]+$/, "");
  return stripCopyIndent(out, firstInset);
}

// 화면이 실제로 어디서 접히는지 측정한다. 고른 행이 아니라 주변까지 훑어서, 판정이 "무엇을
// 골랐는가"에 흔들리지 않게 한다. 행은 접힐 때 오른쪽 끝까지 차므로, 여러 행의 최대 폭이
// 실제 경계에 아래에서 수렴한다. 훑은 폭이 pane 추정보다 훨씬 좁으면(=화면이 거의 비었으면)
// 0을 돌려 pane 추정을 쓰게 한다.
// herdr 이 화면 맨 위에 그리는 탭 줄(좁은 창에서는 두 줄 머리)은 pane 내용이 아니다. 탭이 많으면
// 이 줄이 pane 끝까지 차서, 한 칸 좁게 접히는 본문이 "공간이 남았다"로 읽히고 잘린 토큰 사이에
// 공백이 들어간다. 그래서 훑는 범위에서 뺀다.
const WRAP_SCAN_ROWS = 200;
// 가로 구분선은 구역의 경계다. Claude Code 입력창은 위아래 구분선 사이에 있고 본문보다 1~2칸 좁게
// 접힌다. 구분선 너머 본문까지 재면 입력창의 꽉 찬 줄이 "공간이 남았다"로 읽혀 공백이 들어간다.
const isRuleRow = (line, skip) => /^[─━═]{10,}$/u.test((line?.translateToString(true, skip) || "").trim());
function measureWrapEdge(xterm, buf, skip, startY, endY, headerRows = 0) {
  let from = startY, to = endY;
  while (from - 1 >= Math.max(0, startY - WRAP_SCAN_ROWS) && !isRuleRow(buf.getLine(from - 1), skip)) from--;
  while (to + 1 <= Math.min(buf.length - 1, endY + WRAP_SCAN_ROWS) && !isRuleRow(buf.getLine(to + 1), skip)) to++;
  const spare = buf.getNullCell ? buf.getNullCell() : undefined;
  const base = buf.baseY || 0, headerEnd = base + headerRows;
  let max = 0;
  for (let y = from; y <= to; y++) {
    if (y >= base && y < headerEnd) continue;
    const line = buf.getLine(y); if (!line || isRuleRow(line, skip)) continue;
    for (let x = line.length - 1; x >= skip; x--) {
      const cell = spare ? line.getCell(x, spare) || spare : line.getCell(x);
      if (!cell) continue;
      const ch = cell.getChars();
      if (!ch || ch === " ") continue;
      // 전각은 셀 둘을 차지한다. 끝 열은 시작 열 + 폭 - 1 이다.
      const end = x + Math.max(1, cell.getWidth()) - 1;
      if (end - skip + 1 > max) max = end - skip + 1;
      break;
    }
  }
  const paneW = xterm.cols - 1 - skip;
  return max >= paneW - 6 ? max : 0;
}

// 복사 정리. 패딩·테두리와 가짜 줄바꿈을 제거하고 crop 이면 가려진 열도 뺀다.
// 정리 함수는 이 모듈이 통째로 소유한다. panel/terminal 이 함수를 갖고 등록만 받으면 기능을
// 꺼도 앱 셸에 빈 슬롯이 남고, 그 슬롯을 호출하면 undefined 가 된다.
function cropAwareSelection() {
  const xterm = getXterm();
  const raw = xterm.getSelection();
  if (!raw) return raw;
  let pos;
  try { pos = xterm.getSelectionPosition(); } catch { return raw; }
  if (!pos) return raw;
  if (!pos.start || !pos.end) return raw;
  const skip = selSkip();
  const buf = xterm.buffer.active;
  const rows = [];
  for (let y = pos.start.y; y <= pos.end.y; y++) {
    const line = buf.getLine(y); if (!line) { rows.push(""); continue; }
    let cS = (y === pos.start.y) ? pos.start.x : 0;
    let cE = (y === pos.end.y) ? pos.end.x : xterm.cols;
    cS = Math.max(cS, skip);
    if (cE <= cS) { rows.push(""); continue; }
    rows.push(window.IrisScrollbackCopy.terminalContentRow(line.translateToString(true, cS, cE)));
  }
  const firstLine = buf.getLine(pos.start.y);
  const first = alignFirstRow(rows, firstLine ? firstLine.translateToString(false, skip, pos.start.x) : "",
    Math.max(0, pos.start.x - skip));
  const out = rowsToText(first.rows, skip, copyIndentWidth(first.prefix, first.inset),
    measureWrapEdge(xterm, buf, skip, pos.start.y, pos.end.y, detectOrigin()?.rows ?? 0), first.inset);
  return out.trim() ? out : raw;
}

export { alignFirstRow, copyIndentWidth, rowsToText, cropAwareSelection };
