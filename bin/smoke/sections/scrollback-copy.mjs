// 소유 범위: 채팅 복붙(chatcopy)의 줄 잇기·들여쓰기 벗기기·화면 밖 드래그·조용한 휠과
//   panel/xterm-wiring 의 링크 판정.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사·파일 도구, sources 의 공유 소스, Node 파일·경로·모듈 API.
// 유지 조건: 검사 이름과 본문. 40-qa-evidence.mjs 를 기능별로 분리한 것이고,
//   분리하면서 본문을 바꾸지 않았고, 원본 대비 바이트 대조로 이를 강제한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부르며 sources 의 공유 상수 계약도 함께 본다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs bin/smoke/sections/scrollback-copy.mjs
import { mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { tmpdir } from "node:os";

import {
  b4Function, check, checkAsync, read, readAll, require_, ROOT, sourceFiles,
} from "../core.mjs";
import {
  aiState, aiTabs, allServer, archive, archiveHandlers, browserCommands, browserRuntime,
  browserTabs, cdpCaptureToolsSource, chatCopyBoot, chatCopyDrop, chatCopyEdge, chatCopyText,
  cdpCmdCaptureSource, cdpCmdInputSource,
  cdpCmdInspectSource, cdpHiddenViewportSource, cdpObservationSource, cdpSessionSource,
  cdpTransportSource, centerTabs, contextMenu, css, herdrAgents, herdrState,
  httpHandler, main, mainJs, mcp, memoPanel, rail, tabClose, terminalPanel,
  textEditor, web, webviewFactory, webviewThrottleSource, wsCore, xtermWiring,
} from "../sources.mjs";
import { sliceBetween, sliceFrom } from "../../slice-anchor.mjs";
import { memoOptions } from "../editor-controls-harness.mjs";

export default async function run() {
  console.log("[스크롤백 복사 — 접힌 줄을 사람이 읽을 글로]");
check("복사 정리는 crop과 무관", () => /function selSkip\(\)[\s\S]{0,200}?const bar = cropEnabled \?/.test(terminalPanel)
  && !/if \(!cropEnabled\) return raw;/.test(chatCopyText));
// divider 다음 pane 여백까지 빼야 복사물 앞에 빈 칸이 안 붙는다. 내용 들여쓰기와 구별하려고
// 경계에서 사라진 것이 단어 사이 공백인지 잘린 토큰인지를 가르는 규칙. 이 경로는 대체 화면
// TUI에만 도는데(edgeStart) 그런 화면은 단어 단위로 접으므로, 접히는 줄은 늘 폭을 꽉 채운다.
// 예전 기준("줄이 끝까지 찼는가" + "양쪽이 한글인가")은 그래서 산문에서 항상 참이 되어 공백을
// 삼켰다. 확인 결과 공백 없이 붙인 13곳이 전부 단어 경계였고 실제 토큰 분리는 0곳이었다.
// 토큰이 정말 잘리는 것은 한 줄에 아예 안 들어갈 때뿐이다.
check("접힌 줄을 이을 때 단어 사이 공백을 되살린다", () => {
  const src = b4Function(chatCopyText, "rowsToText");
  const stripSrc = b4Function(chatCopyText, "stripCopyIndent");
  if (!src || !stripSrc) return false;
  const join = new Function("getXterm", stripSrc + "\n" + src + "\nreturn rowsToText;")(() => ({ cols: 108 }));
  const skip = 40;                       // paneW = 108 - 1 - 40 = 67
  // 접힘은 줄이 폭에 도달했을 때만 일어난다. 짧은 줄로 측정하면 판정 자체가 실행되지 않는다.
  const cols = (t) => [...t].reduce((n, c) => {
    const x = c.codePointAt(0);
    return n + (x > 0x1100 && x < 0xd7a4 ? 2 : 1);
  }, 0);
  const fill = (tail) => { let t = ""; while (cols(t) + cols(tail) + 1 <= 66) t += "한글 "; return t + tail; };

  const a = fill("원인은"), b = fill("하필"), c = fill("대조해서");
  const longTok = "가".repeat(40);
  const d = fill("").trim() + " " + longTok;
  return (
    // 한글 산문이 폭에 걸려 접힌 경우다. 사라진 공백이 복원되어야 한다
    join([a, "내가 어제 쓴 문장이다"], skip) === a + " 내가 어제 쓴 문장이다"
    // 숫자·영문으로 이어지는 경계도 같다
    && join([b, "2행씩 굴리면 두 구분선이 맞는다"], skip) === b + " 2행씩 굴리면 두 구분선이 맞는다"
    && join([c, "rowsToText의 폭 추정을 잡는다"], skip) === c + " rowsToText의 폭 추정을 잡는다"
    // 한 줄에 담을 수 없는 토큰만 잘린 것으로 보고, 그때는 공백 없이 붙인다
    && join([d, "나".repeat(40) + " 끝"], skip) === d + "나".repeat(40) + " 끝"
    // 표 경계선은 그 자체로 완결된 줄이다. 폭을 꽉 채워도 다음 칸 내용과 붙이지 않는다
    && join(["├────────────┼──────────────────────────────────────────┤", "이전 │ 밴드 전체 51행"], skip)
      === "├────────────┼──────────────────────────────────────────┤\n이전 │ 밴드 전체 51행"
  );
});
// 접힘 판정이 실제로 접힌 지점과 같은 기준을 쓰는지 확인한다. 아래 넷은 모두 실제 사례다.
//   NFD 한글: macOS 파일 이름이 이 형태로 온다. 자모를 1칸씩 계산하면 줄이 실제보다 넓어져
//     실제 줄바꿈을 접힌 줄로 오판한다(이 프로젝트 기록 622MB 에서 자모 2,744회).
//   TUI 표시(⏺): Claude 가 새 블록을 시작하는 표시다. 앞 줄이 폭을 채웠다고 붙이면 두 블록이 한 줄이 된다.
//   둥근 상자 윗줄: 다음 행이 경계선일 때도 붙이지 않는다.
//   경로 판별: 줄에 여유가 있는데 붙이면 "aside"+"docs/x.json" 이 "asidedocs/x.json" 이 된다.
check("접힘 판정이 접힌 자리와 같은 자를 쓴다", () => {
  const src = b4Function(chatCopyText, "rowsToText");
  const stripSrc = b4Function(chatCopyText, "stripCopyIndent");
  if (!src || !stripSrc) return false;
  const join = new Function("getXterm", stripSrc + "\n" + src + "\nreturn rowsToText;")(() => ({ cols: 108 }));
  const skip = 40;                       // paneW = 108 - 1 - 40 = 67
  const nfd = "\u1112\u1161\u11ab";      // 풀어 쓴 "한": 2칸이지 4칸이 아니다
  const a = "파일 이름 " + nfd.repeat(15);
  const b = "다음 줄이다";
  const wide = "가".repeat(33);           // 66칸: 폭에 닿은 줄
  const prose = "가".repeat(27) + " aside"; // 60칸: 자리가 7칸 남았다

  return (
    // 풀어 쓴 한글을 4칸으로 세면 이 둘이 한 줄로 붙는다
    join([a, b], skip) === a + "\n" + b
    // 새 블록을 여는 표시 앞에서는 끊는다
    && join([wide, "⏺ 다음 블록"], skip) === wide + "\n⏺ 다음 블록"
    // 다음 행이 경계선이면 붙이지 않는다
    && join([wide, "──────────────"], skip) === wide + "\n──────────────"
    // 줄에 여유가 있으면 경로처럼 보여도 잘린 것이 아니라 원래 띄어쓰기가 있었다
    && join([prose, "docs/x.json 을 연다"], skip) === prose + " docs/x.json 을 연다"
  );
});
// 반례 넷이며, 모두 실제로 깨졌던 경우다.
//   고른 행이 적으면 그 최대폭은 실제 경계가 아니다. 그 값으로 "꽉 찼다"를 판정하면 띄어쓰기가 사라진다.
//   같은 두 행의 판정이 무관한 세 번째 행을 함께 골랐는지에 따라 달라져서도 안 된다.
//   ASCII 반복선은 눈금선과 잘린 토큰의 뒷부분을 구별할 방법이 없다.
//   이모지는 코드포인트가 아니라 표시 단위로 계산한다. `👩‍💻` 는 코드포인트 셋이지만 화면에서는 2칸 하나다.
check("행이 적어도 없던 띄어쓰기를 만들거나 지우지 않는다", () => {
  const src = b4Function(chatCopyText, "rowsToText");
  const stripSrc = b4Function(chatCopyText, "stripCopyIndent");
  if (!src || !stripSrc) return false;
  const mk = (cols) => new Function("getXterm", stripSrc + "\n" + src + "\nreturn rowsToText;")(() => ({ cols }));
  const a = "a".repeat(61), bb = "b".repeat(8);
  return (
    // 두 줄만 골랐다고 6칸이 경계가 되면 안 된다
    mk(11)(["abcdef", "ghijk"], 0) === "abcdef ghijk"
    // 세 번째 행을 함께 골라도 앞 두 행의 판정은 그대로여야 한다
    && mk(11)(["abcdef", "ghijk", "0123456789"], 0) === "abcdef ghijk 0123456789"
    && mk(68)([a, bb], 0) === a + " " + bb
    // 다음 행이 ASCII 반복선이면 잘린 토큰의 뒷부분일 수 있어 끊지 않는다
    && mk(11)(["abcdefghij", "---"], 0) === "abcdefghij---"
    // ⏵ 는 실제 화면에서 줄 시작 0 · 줄 중간 7 이었다. 새 줄을 여는 표시가 아니므로 안 끊는다
    && mk(11)(["123456 abc", "⏵ next"], 0) === "123456 abc ⏵ next"
    // ❯ 도 제외했다. 줄 시작 1 · 줄 중간 0 은 전역 규칙의 근거로 부족하다
    && mk(11)(["123456 abc", "❯ next"], 0) === "123456 abc ❯ next"
    // 화면에서 잰 경계를 주면 무엇을 함께 골랐는지와 무관하게 같은 판정이 나온다
    && mk(11)(["abcdef", "g"], 0, 0, 10) === mk(11)(["abcdef", "g", "0123456789"], 0, 0, 10).split(" 0123456789")[0]
  );
});
// 경계를 고른 행에서 추정하면 판정이 함께 고른 행에 따라 달라진다. 그래서 부르는 쪽이
// 화면 전체에서 실제 경계를 측정한다. 전각은 두 셀을 쓰므로 글자 수가 아니라 열 수로 계산한다.
check("접히는 경계를 화면에서 잰다", () => {
  const src = b4Function(chatCopyText, "measureWrapEdge");
  if (!src) return false;
  const scanRows = sliceBetween(chatCopyText, "const WRAP_SCAN_ROWS", "\nfunction measureWrapEdge", "훑는 행 수");
  const measure = new Function(scanRows + ";\n" + src + "\nreturn measureWrapEdge;")();
  const cols = 20;
  const mkLine = (text) => {
    const cells = [];
    for (const ch of text) { cells.push({ ch, w: ch.codePointAt(0) >= 0xac00 && ch.codePointAt(0) <= 0xd7a3 ? 2 : 1 });
      if (cells[cells.length - 1].w === 2) cells.push({ ch: "", w: 0 }); }
    while (cells.length < cols) cells.push({ ch: " ", w: 1 });
    return { length: cols, getCell: (x) => ({ getChars: () => cells[x].ch, getWidth: () => cells[x].w }),
      translateToString: (trim, s = 0) => { const t = cells.slice(s).map((c) => c.ch).join(""); return trim ? t.trimEnd() : t; } };
  };
  const buf = (lines) => ({ length: lines.length, getLine: (y) => lines[y] && mkLine(lines[y]) });
  const xterm = { cols };
  return (
    // 한글 8자 = 16열. 짧은 행만 있으면 경계로 보지 않는다(0 → 기존 추정으로 넘김)
    measure(xterm, buf(["가나다라마바사아", "짧다"]), 0, 0, 1) === 16
    && measure(xterm, buf(["짧다", "조금"]), 0, 0, 1) === 0
    // 고른 행이 짧아도 둘레의 긴 행에서 경계를 얻는다
    && measure(xterm, buf(["가나다라마바사아", "짧다", "조금"]), 0, 1, 2) === 16
  );
});
// 폭은 코드포인트가 아니라 표시 단위로 계산한다. 이어붙임(ZWJ)·피부색·국기 짝·변이 선택자는 앞
// 글자에 흡수돼 한 번만 계산된다. 따로 계산하면 `👩‍💻` 가 4칸이 되어 줄이 실제보다 넓어지고,
// 넓어진 줄은 접힌 줄로 오판돼 실제 줄바꿈이 사라진다.
check("이모지 한 덩어리를 두 칸으로 센다", () => {
  const src = b4Function(chatCopyText, "rowsToText");
  if (!src) return false;
  const head = sliceBetween(src, "const zeroW", "const paneW", "폭 계산만 떼어 본다");
  const colW = new Function(head + "\nreturn colW;")();
  const want = [["\u{1F469}\u200D\u{1F4BB}", 2], ["\u{1F44D}\u{1F3FD}", 2], ["\u{1F1F0}\u{1F1F7}", 2],
    ["\u2665\uFE0F", 2], ["\u23FA", 1], ["\u23FA\uFE0F", 2], ["1\uFE0F\u20E3", 2],
    ["\u1112\u1161\u11AB", 2], ["가나다", 6], ["abc", 3],
    // 흡수는 문맥이 맞을 때만 적용한다. 이 여섯은 한 덩어리가 아니다
    ["\u{1F469}\u200Da", 3], ["a\u200Db", 2], ["a\u{1F3FD}", 3], ["A\uFE0F", 1],
    ["\u{1F1F0}\u{1F1F7}\u{1F1FA}", 3], ["\u{1F100}", 1],
    ["\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}", 2]];
  return want.every(([t, n]) => colW(t) === n);
});
// 선택 영역이 아니라 화면 전체에서 잰다.
check("왼쪽 여백까지 걷어낸다", () => /function detectLeftGutter\(skip\)/.test(terminalPanel)
  && /return bar \+ detectLeftGutter\(bar\);/.test(terminalPanel));
// 첫 줄의 글자부터 드래그하면 그 줄의 TUI 들여쓰기는 선택 범위에서 이미 빠지지만, 후속 줄은 pane
// 시작부터 수집돼 같은 두 칸이 남는다. 공통 들여쓰기 최소값은 첫 줄 때문에 0이라 이 경우를 못 잡았다.
check("첫 선택 줄에서 이미 빠진 들여쓰기를 후속 줄에도 맞춘다", () => {
  const src = b4Function(chatCopyText, "stripCopyIndent");
  const widthSrc = b4Function(chatCopyText, "copyIndentWidth");
  if (!src || !widthSrc) return false;
  const strip = new Function(src + "\nreturn stripCopyIndent;")();
  const width = new Function(widthSrc + "\nreturn copyIndentWidth;")();
  const original = "그리고 회의 모드로 녹음 시작하면 바로 가공 및 Slack까지 전송까지 다 한 방에 알아서 하는거 아니었음?\n"
    + "+ 회의 모드로 녹음하면 내용 누락이나 끊김 없이 처리되면서 동시에 핸드폰에 업로드되는거 아니었음? 지금 아닌 것 같은데.";
  const copied = original.replace("\n+", "\n  +");
  return width("  ", 2) === 2 && width("글자", 2) === 0 && width("       ", 7) === 0
    && strip(copied, width("  ", 2)) === original
    && strip("첫 줄\n  + 둘째\n    안쪽", 2) === "첫 줄\n+ 둘째\n  안쪽"
    && strip("첫 줄\n  의도한 들여쓰기", 0) === "첫 줄\n  의도한 들여쓰기"
    && strip("중간부터\n  의도한 들여쓰기", 12) === "중간부터\n  의도한 들여쓰기"
    && strip("  공통\n    상대", 0) === "공통\n  상대";
});
// 대체 화면은 스크롤 뒤 다시 그려지므로, 나중 화면에서 시작점을 복원하면 원문을 잃는다. 누르는 순간
// xterm 화면을 로컬에 불변 보관하고 실제 휠로 이동한 화면만 같은 누적 행에 이어 붙여야 한다.
check("화면 밖 드래그는 시작 순간 텍스트를 불변 보관한다", () =>
  // 이 줄은 고전 스크립트가 실제로 로드되는지를 확인한다. 파일 이름만 검사하면
  // panel 모듈 연결과 구별되지 않으며, 그 연결은 [0.55c] 가 검사한다.
  /<script src="\/scrollback-copy\.js"><\/script>/.test(read("web/index.html"))
  && /function screenRows\(skip\)/.test(terminalPanel)
  && /virtual: \[\], view: 0, anchorIdx: row/.test(chatCopyEdge)
  && /edgeAlign\(edgeDrag, edgeCapture\(edgeDrag\), 0\)/.test(chatCopyEdge)
  && /IrisScrollbackCopy\.alignViewport/.test(chatCopyEdge));
check("스크롤 선택은 조용한 실제 휠 경로만 쓴다", () => {
  const scroll = sliceBetween(chatCopyEdge, "function edgeScroll", "function edgeMove", "스크롤 선택은 조용한 실제 휠 경로만 쓴다");
  const moveAt = chatCopyEdge.indexOf("function edgeMove");
  const move = chatCopyEdge.slice(moveAt, chatCopyEdge.indexOf("\nfunction ", moveAt + 1));
  return !/async function edgeScroll|new Promise|paneRead|setTimeout|setInterval/.test(scroll)
    && /edgeScheduleCapture\(st, dir \* lines\)/.test(scroll)
    && /terminalInner\.addEventListener\("wheel",[\s\S]*?callHook\("chatcopy\.wheel",/.test(xtermWiring)
    && /function edgeWheel\([\s\S]{0,220}?edgeScroll\(edgeDrag,/.test(chatCopyEdge)
    && !/showToast|setInterval/.test(scroll)
    && !/edgeScroll|setInterval|EDGE_PX/.test(move)
    && /function edgeRenderSelection[\s\S]*?IrisScrollbackCopy\.visibleSelection[\s\S]*?xterm\.select\(/.test(chatCopyEdge)
    && /function edgeScroll[\s\S]*?edgeAdoptSelectionAnchor\(st,[\s\S]*?getXterm\(\)\.clearSelection\(\)/.test(chatCopyEdge)
    && /function edgeAlign[\s\S]*?IrisScrollbackCopy\.alignViewport/.test(chatCopyEdge)
    && /getXterm\(\)\.write\([\s\S]*?callHook\("chatcopy\.captureAfterWrite"\)/.test(mainJs)
    && /await edgeAwaitCapture\(st\)/.test(chatCopyEdge)
    && /pane\.scroll_changed/.test(read("server/herdr.js"));
});
// 이 기능은 스크롤 중에도 복사되게 하려고 만들었다. 그래서 대조 실패를 이유로 아무것도
// 반환하지 않으면 목적과 어긋난다. 실제로 로컬 경로를 서버 경로로 교체한 변경에서 그렇게 동작해
// 복사가 사라졌다. 서버 기록이 더 완전하므로 먼저 쓰되 유일한 경로로 두지 않는다.
check("서버 기록이 어긋나도 빈손으로 끝나지 않는다", () =>
  /function localSelectionText\(st\)[\s\S]*?IrisScrollbackCopy\.pickRows/.test(chatCopyEdge)
  && /const text = localSelectionText\(st\);[\s\S]*?return \{ text, degraded \}/.test(chatCopyEdge)
  && /got\.degraded[\s\S]*?화면에서 본 만큼만/.test(chatCopyBoot)
  && /순서가 어긋났을 수 있습니다/.test(chatCopyEdge));
// 품질 저하를 알리는 것만으로 막을 수 없는 경우가 있다. 한 번에 밴드보다 많이 스크롤하면 그 사이
// 행이 그려지지 않아 누락되는데, pickRows가 누락을 빈 문자열로 바꾸므로 최종 텍스트에서 실제 빈
// 줄과 구별되지 않는다(확인 결과: 6행 건너뛰면 복사본에 빈 줄 6개). 받는 사람은 잘린 것으로
// 이해하지만 내용이 다르다. 그래서 짧은 것은 알리고, 다른 것은 막는다.
check("조용히 다른 복사는 알리지 않고 막는다", () => {
  const K = {};
  new Function(read("web/scrollback-copy.js")).call(K);
  const S = globalThis.IrisScrollbackCopy;
  if (!S || typeof S.localCopyDefect !== "function") return false;
  const ROWS = 30, BAND = 27;
  const hist = Array.from({ length: 400 }, (_, i) => `line ${String(i).padStart(3, "0")}`);
  const scr = (top) => ["HDR-A", "HDR-B", ...hist.slice(top, top + BAND), "STATUS"];
  const walk = (steps) => {
    const st = { virtual: [], view: 0, anchorIdx: 5, anchorCol: 0, initialAnchorRow: 5,
      viewportTop: 0, viewportRows: ROWS, viewportResolved: false, expectedOffset: 0,
      focusRow: 10, focusCol: 60, rows: ROWS, cols: 60, skip: 0 };
    S.alignViewport(st, scr(steps[0]), 0);
    for (let i = 1; i < steps.length; i++) S.alignViewport(st, scr(steps[i]), steps[i] - steps[i - 1]);
    return S.localCopyDefect(st, { row: 10, col: 60 });
  };
  // 길게 드래그하는 동안 스피너·토큰 수처럼 매 프레임 바뀌는 줄 때문에 한 프레임 정도는 불확실해진다.
  // 그것을 드래그 전체의 판정으로 쓰면 137행짜리 정상 복사가 전부 막힌다(확인 결과). 불확실한 구간은
  // 그때 지나간 구간뿐이고, 뒤 프레임이 같은 내용을 확정하면 추측이 아니다.
  const noisy = () => {
    const st = { virtual: [], view: 0, anchorIdx: 5, anchorCol: 0, initialAnchorRow: 5,
      viewportTop: 0, viewportRows: ROWS, viewportResolved: false, expectedOffset: 0 };
    S.alignViewport(st, scr(0), 0);
    for (let t = 3; t <= 60; t += 3) S.alignViewport(st, scr(t), 3);
    S.alignViewport(st, ["!!!끼어든", ...Array.from({ length: BAND - 1 }, (_, i) => `  잡음 ${i}`)], 3);
    for (let t = 66; t <= 150; t += 3) S.alignViewport(st, scr(t), 3);
    return st;
  };
  const nz = noisy();
  const tainted = nz.uncertainRanges || [];
  const spans = (lo, hi) => tainted.some((r) => r[0] <= hi && r[1] >= lo);

  return walk([0, 3, 6, 9, 12]) === ""      // 평범한 스크롤은 막지 않는다
    && walk([0, 1, 2, 3, 4, 5, 6]) === ""
    && walk([0, 12]) === ""                  // 겹침이 남는 큰 굴림도 온전하다
    && walk([0, 40]) !== ""                  // 겹침이 사라진 점프는 구멍이 생기므로 막는다
    // 잡음 한 프레임이 밴드 전체(51행)에 영향을 주지 않는다. 뒤 프레임이 덮은 만큼 해제된다
    && tainted.length > 0
    && tainted.reduce((n, r) => n + (r[1] - r[0] + 1), 0) < BAND
    // 불일치는 막지 않고 몇 줄인지 알린다. 누락과 달리 결과에 그대로 보여 받는 사람이
    // 확인할 수 있다. 막았을 때는 정상 본문에도 걸려(확인 결과: 47~70행이 정상) 아무것도 가져오지 못했다.
    && S.localCopyDefect({ ...nz, anchorIdx: tainted[0][0] }, { row: BAND - 1, col: 60 }) === ""
    && S.localCopyDoubt({ ...nz, anchorIdx: tainted[0][0] }, { row: BAND - 1, col: 60 }) > 0
    // 걸치지 않으면 알릴 것도 없다
    && S.localCopyDoubt({ ...nz, anchorIdx: 0, view: 0 }, { row: 1, col: 0 }) === 0
    && !spans(0, 2);                         // 잠긴 최초 화면 원문은 물들지 않는다
});
// 고정 TUI 크롬(입력줄·구분선·상태줄)은 스크롤되지 않으므로 본문 밴드 밖이다. 드래그가 그 위에서
// 시작해도 밴드 판별을 버리지 않고 앵커를 밴드 안으로 이동한다. 버리면 화면 전체가 본문으로
// 수집돼 구분선과 ❯ 입력줄이 클립보드에 포함된다(확인 결과 재현). 끝점은 이미 같은 방식으로 처리한다.
check("드래그를 크롬에서 시작해도 밴드를 버리지 않는다", () => /initialAnchorRow: row/.test(chatCopyEdge)
  && /const clamped = Math\.max\(region\.start, Math\.min\(last, raw\)\)/.test(read("web/scrollback-copy.js"))
  && !/anchorRow >= region\.start && anchorRow < region\.end/.test(read("web/scrollback-copy.js")));
check("스크롤백 있는 화면은 건드리지 않는다", () => /buffer\.active\.type !== "alternate"/.test(chatCopyEdge));
// 이어붙인 결과를 화면 몫 자동복사가 덮으면 안 된다.
check("끄는 중 자동복사 중단", () =>
  /function edgeAutoCopyBlocked\(\) \{\s*\n\s*return \(edgeDrag && edgeDrag\.scrolled\) \|\| Date\.now\(\) < edgeGuardUntil;/.test(chatCopyEdge)
  && /if \(edgeAutoCopyBlocked\(\)\) return;/.test(chatCopyBoot)
  // 앱 셸은 이벤트만 전달한다. 여기서 다시 계산하면 두 곳의 값이 갈린다.
  && /xterm\.onSelectionChange\(\(\) => callHook\("chatcopy\.selectionChanged"\)\);/.test(xtermWiring));
// 편집기 호스트를 body에 붙이면 inset:0 절대배치라 화면 전체를 덮어 앱과 브라우저 탭이 모두 가려진다.
check("마우스 모드 아니면 스크롤을 안 보낸다", () => /if \(!getAppMouseOn\(\)\) \{ blog\("edge skip"/.test(chatCopyEdge)
  && /st\.blocked = "no-mouse-mode"/.test(chatCopyEdge));
check("여백 판정은 화면 전체 기준", () => /blank < content \* 0\.9/.test(terminalPanel) && /const MAX = 6;/.test(terminalPanel));
// 화면 기준 여백 감지는 "블록만 들여쓴 경우"를 못 잡는다(TUI가 어시스턴트 글을 2칸 들여쓰면 다른
// 줄은 더 왼쪽에서 시작 → 모든 행에서 비어 있지 않다). 이어붙인 뒤 공통 들여쓰기를 뺀다.
// TUI 글머리 표시(⏺ 등)는 왼쪽 끝에 붙고 그 아래 본문은 표시 폭만큼 들여써 정렬된다. 그 들여쓰기는
// 글의 구조가 아니라 화면 정렬이다. 예전에는 표시줄이 0칸이라 공통 들여쓰기가 0이 되어 아무것도
// 안 벗겨졌고, 붙여넣으면 "표시 하나 뒤로 전부가 그 안에 든 것처럼" 읽혔다.
check("블록 공통 들여쓰기도 벗긴다", () => {
  const src = b4Function(chatCopyText, "stripCopyIndent");
  if (!src) return false;
  const strip = new Function(src + "\nreturn stripCopyIndent;")();
  return (
    // 표시줄이 섞여 있어도 본문 정렬은 벗긴다. 표시줄 자체는 이미 왼쪽 끝이라 그대로 둔다.
    strip("⏺ 첫 문장\n  이어지는 문장\n\n  다음 문단", 0)
      === "⏺ 첫 문장\n이어지는 문장\n\n다음 문단"
    // 더 깊은 들여쓰기는 상대 관계를 유지한다. 코드 블록이 평평해지면 안 된다
    && strip("⏺ 제목\n  ⎿  요약\n      코드 한 줄", 0)
      === "⏺ 제목\n⎿  요약\n    코드 한 줄"
    // 표시줄이 없으면 예전과 똑같이 공통값만 벗긴다
    && strip("  공통\n    상대", 0) === "공통\n  상대"
    && strip("첫 줄\n  의도한 들여쓰기", 0) === "첫 줄\n  의도한 들여쓰기"
  );
});

// 메모도 마크다운이므로 파일 쪽과 같은 처리기(mdToHtml)를 쓴다. 처리기를 따로 두면 같은 글이
// 두 군데서 다르게 보인다.

// ── 링크: 여러 줄에 나열될 때 · 수식키를 눌렀을 때만 ──────────────────────────
// 소스 모양이 아니라 실제 판정 함수를 부른다. 셀 공급자만 받으므로 화면 없이 실행할 수 있다.
await checkAsync("여러 줄에 나열된 링크는 줄마다 자기 링크가 된다", async () => {
  const { terminalLinkSpans } = await import(new URL("../../../web/js/panel/xterm-wiring.js", import.meta.url).href);
  const COLS = 40;
  const cellsFrom = (lines) => (ry) => {
    if (ry < 1 || ry > lines.length) return null;
    const padded = lines[ry - 1].padEnd(COLS, " ").slice(0, COLS);
    return [...padded].map((ch, i) => ({ ch, x: i + 1, endX: i + 1, y: ry }));
  };
  const texts = (lines) => lines.map((_, i) => terminalLinkSpans(cellsFrom(lines), i + 1).map((sp) => sp.text));
  const want = (name, lines, expect) => {
    const got = JSON.stringify(texts(lines));
    if (got !== JSON.stringify(expect)) throw new Error(`${name}: ${JSON.stringify(expect)} 여야 하는데 ${got}`);
  };
  // 확인된 실패: 불릿 목록에서 마지막 줄만 정상이었다.
  want("불릿 목록", ["- /Users/x/a.js", "- /Users/x/b.js", "- /Users/x/c.js"],
       [["/Users/x/a.js"], ["/Users/x/b.js"], ["/Users/x/c.js"]]);
  want("맨 경로 목록", ["/Users/x/a.js", "/Users/x/b.js", "/Users/x/c.js"],
       [["/Users/x/a.js"], ["/Users/x/b.js"], ["/Users/x/c.js"]]);
  want("URL 목록", ["https://a.example/x", "https://b.example/y"],
       [["https://a.example/x"], ["https://b.example/y"]]);
  want("한 줄에 셋", ["file:///U/a file:///U/b file:///U/c"],
       [["file:///U/a", "file:///U/b", "file:///U/c"]]);
  // 실제로 접힌 줄은 그대로 이어야 하며, 목록과 구분하는 기준은 "오른쪽 끝까지 찼는가"다.
  // 첫 줄이 정확히 COLS(40칸)를 채워야 "접힌 줄"이 된다. 실제 홈 경로는 쓰지 않는다
  // (추적 파일의 개인 흔적 검사).
  const wrapped = ["/srv/aaa/bbb/ccc/ddd/eee/fff/ggg/hhh/iii", "jjj/kkk.js"];
  const full = "/srv/aaa/bbb/ccc/ddd/eee/fff/ggg/hhh/iiijjj/kkk.js";
  want("꽉 찬 줄에서 접힘", wrapped, [[full], [full]]);
  // 오른쪽 끝을 채우지 않고 토큰 중간에서 끊는 TUI 도 있다. 코덱스가 그렇다. 폭 110칸 화면에서
  // 그 줄은 104칸에서 끝나고 `information-` 로 잘려 있었다(확인 결과). 끝을 채웠는지만
  // 보면 이 경우를 놓쳐 링크가 둘로 갈라진다.
  const cut = [".working/2026-a/reports/information-", "preservation-verification.md"];
  const joined = ".working/2026-a/reports/information-preservation-verification.md";
  want("안 찬 줄이라도 토큰 한가운데서 끊겼으면 이어진다", cut, [[joined], [joined]]);
  // 그 규칙이 목록까지 이어 붙이면 안 된다. 디렉터리 목록은 `/` 로 끝난다.
  // 끝의 `/` 는 원래 제거한다(terminalBarePathToken). 여기서 확인하는 것은 줄이 합쳐지지 않는 것이다.
  want("`/` 로 끝나는 디렉터리 목록은 따로다", ["- /Users/x/a/", "- /Users/x/b/", "- /Users/x/c/"],
       [["/Users/x/a"], ["/Users/x/b"], ["/Users/x/c"]]);
  want("번호 매긴 목록도 따로다", ["1. /Users/x/a-", "2. /Users/x/b-"],
       [["/Users/x/a-"], ["/Users/x/b-"]]);
  return true;
});

// 복사 완료를 알리는 경로다. 소스 모양이 아니라 실제 훅을 불러서 확인한다.
await checkAsync("그냥 골라 복사해도 복사됐다고 알린다", async () => {
  const term = await import(new URL("../../../web/js/panel/terminal.js", import.meta.url).href);
  const hooks = await import(new URL("../../../web/js/core/hooks.js", import.meta.url).href);
  const boot = await import(new URL("../../../web/js/chatcopy/boot.js", import.meta.url).href);
  const toasts = [];
  const prev = term.getXterm();
  term.setXterm({
    getSelection: () => "첫 줄\n둘째 줄",
    getSelectionPosition: () => null,
    onSelectionChange: () => {},
  });
  hooks.clearHooks();
  try {
    boot.initCapability({
      blog: () => {}, wsSend: () => {}, showToast: (t) => toasts.push(String(t)),
      getLastAgents: () => [], getCurTarget: () => null, wsIsOpen: () => false,
      acHost: {}, copyText: async () => true,
    });
    // 고르는 동안 선택 변경이 여러 번 발생하므로 모아서 마지막 한 번만 알린다.
    // 모으지 않으면 드래그하는 동안 알림이 계속 뜬다.
    hooks.callHook("chatcopy.selectionChanged");
    hooks.callHook("chatcopy.selectionChanged");
    hooks.callHook("chatcopy.selectionChanged");
    await new Promise((r) => setTimeout(r, 500));
  } finally {
    hooks.clearHooks();
    term.setXterm(prev);
  }
  if (toasts.length !== 1) throw new Error(`알림이 ${toasts.length}번 — 한 번이어야 한다: ${JSON.stringify(toasts)}`);
  if (!/2줄 복사됨/.test(toasts[0])) throw new Error(`알림 문구가 다르다: ${toasts[0]}`);
  return true;
});

await checkAsync("클립보드에 쓰지 못했으면 복사됐다고 알리지 않는다", async () => {
  const term = await import(new URL("../../../web/js/panel/terminal.js", import.meta.url).href);
  const hooks = await import(new URL("../../../web/js/core/hooks.js", import.meta.url).href);
  const boot = await import(new URL("../../../web/js/chatcopy/boot.js", import.meta.url).href);
  const toasts = [];
  const prev = term.getXterm();
  term.setXterm({ getSelection: () => "한 줄", getSelectionPosition: () => null, onSelectionChange: () => {} });
  hooks.clearHooks();
  try {
    boot.initCapability({
      blog: () => {}, wsSend: () => {}, showToast: (t) => toasts.push(String(t)),
      getLastAgents: () => [], getCurTarget: () => null, wsIsOpen: () => false,
      acHost: {}, copyText: async () => false,
    });
    hooks.callHook("chatcopy.selectionChanged");
    await new Promise((r) => setTimeout(r, 500));
  } finally {
    hooks.clearHooks();
    term.setXterm(prev);
  }
  if (toasts.length !== 1 || /복사됨/.test(toasts[0])) throw new Error(`실패인데 알림이 ${JSON.stringify(toasts)}`);
  return true;
});

check("수식키를 안 누르면 링크를 아예 안 내준다", () => {
  // activate 에서 막으면 밑줄이 그대로 떠 눌러도 아무 일이 없고 드래그 선택도 어긋난다.
  // 그래서 제공자 첫 줄에서 끊는다.
  const provide = sliceBetween(xtermWiring, "provideLinks(y, cb) {", "const buf = xterm.buffer.active;", "수식키 문");
  return /if \(!linkModeHeld\(\)\) \{ cb\(undefined\); return; \}/.test(provide)
    // OSC 8 은 제공자를 거치지 않으므로 같은 조건을 따로 두어야 한다.
    && /activate: \(ev, uri\) => \{ if \(!linkModeFromEvent\(ev\)\) return;/.test(xtermWiring);
});

check("수식키는 ⌘·⌃ 둘 다 받고, 창을 떠나면 풀린다", () =>
  /metaKey \|\| e\.ctrlKey/.test(xtermWiring)
  && /"keyup"[\s\S]{0,120}setLinkMode\(false\)/.test(xtermWiring)
  && /window\.addEventListener\("blur", \(\) => setLinkMode\(false\)\)/.test(xtermWiring));

// ── 메모: 자동완성 없음 ─────────────────────────────────────────────────────
check("메모 편집기에는 자동완성이 없다", () => {
  return [false, true].every((wrap) => memoOptions(wrap).every((options) => options.quickSuggestions === false
    && options.suggestOnTriggerCharacters === false
    && options.wordBasedSuggestions === "off"
    && options.acceptSuggestionOnEnter === "off"
    && options.tabCompletion === "off"
    && options.parameterHints.enabled === false));
});


// 파일을 끌어 터미널에 놓을 때의 표시다. 켜는 것보다 끄는 것이 어렵다. 터미널 위를 지나갔다가
// 다른 곳에 놓으면 터미널의 drop 도 dragleave 도 오지 않고, OS 드래그라 dragend 도 이 문서에 오지 않는다.
// 그래서 표시가 켜진 채 남아 화면이 계속 드롭을 기다리는 상태가 된 적이 있다.
await checkAsync("파일 드래그 표시는 dragover 로만 켜지고 나머지 사건은 전부 끈다", async () => {
  const mod = await import(new URL("../../../web/js/chatcopy/drop-path.js", import.meta.url).href);
  const TABLE = [
    ["터미널 위에서 끌고 있다", "dragover", true, true],
    ["터미널을 벗어났다", "dragover", false, false],
    ["여기 놓았다", "drop", true, false],
    ["다른 데 놓았다(우리 drop 은 안 오지만 문서 drop 은 온다)", "drop", false, false],
    ["드래그가 끝났다", "dragend", true, false],
    ["창 밖으로 나갔다", "dragleave", true, false],
    ["창이 포커스를 잃었다", "blur", true, false],
    ["아무 사건도 없이 조용해졌다", "watchdog", true, false],
  ];
  const wrong = [];
  for (const [name, kind, over, want] of TABLE) {
    const got = mod.fileDragHotNext(kind, over);
    if (got !== want) wrong.push(`${name}: ${got} (기대 ${want})`);
  }
  if (wrong.length) throw new Error(wrong.join(" · "));
  // 타이머는 명세가 보장하는 dragover 간격(350ms)보다 길어야 한다. 짧으면 들고만 있어도 표시가 깜빡인다.
  if (!(mod.DRAG_HOT_IDLE_MS > 350)) throw new Error("idle 이 너무 짧다: " + mod.DRAG_HOT_IDLE_MS);
  return true;
});

check("표시를 끄는 길이 여럿이고 마지막에 시계가 있다", () => {
  // 이벤트는 앱 셸이 전달하고 켜고 끄는 판단은 기능이 한다. 경로가 둘로 갈리므로 둘 다 확인한다.
  const src = [xtermWiring, chatCopyDrop, chatCopyBoot].join("\n");
  const paths = [
    /document\.addEventListener\("dragleave"[\s\S]{0,160}callHook\("chatcopy\.dragHint", "dragleave", false\)/,  // 창 밖으로
    /document\.addEventListener\("dragend"[\s\S]{0,120}callHook\("chatcopy\.dragHint", "dragend", false\)/,      // 드래그 종료
    /window\.addEventListener\("blur"[\s\S]{0,120}callHook\("chatcopy\.dragHint", "blur", false\)/,              // 포커스 상실
    /setTimeout\([\s\S]{0,80}remove\("drag-hot"\)[\s\S]{0,40}DRAG_HOT_IDLE_MS/,  // 시계
    /provide\("chatcopy\.dragHint", \(kind, overTerminal\) => setDragHot\(fileDragHotNext\(kind, overTerminal\)\)\)/,
  ];
  const dead = paths.map((re, i) => (re.test(src) ? null : i)).filter((i) => i !== null);
  if (dead.length) throw new Error("끄는 길 없음: " + dead.join(", "));
  return true;
});

check("표시를 켜고 끄는 판단이 dragleave 의 target 비교에 안 기댄다", () => {
  // 예전 방식이다. xterm 이 안에 여러 겹을 그려서 자식에서 dragleave 가 나면 target 이 안 맞고,
  // 그러면 안 꺼진다.
  return !/dragleave[\s\S]{0,120}e\.target === terminal/.test(xtermWiring + "\n" + chatCopyDrop);
});
}
