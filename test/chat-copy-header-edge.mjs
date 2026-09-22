// herdr 탭 줄이 pane 끝까지 차 있을 때도 잘린 토큰 사이에 공백을 넣지 않는가.
//
// 복사 정리는 주변 줄의 최대 폭으로 본문이 접히는 경계를 잰다. 그 범위에 herdr 탭 줄이 들어가면
// 탭이 많을 때 경계가 한 칸 넓게 잡혀, 경계까지 찬 줄이 "공간이 남았다"로 읽힌다.
// 확인 결과: 67칸에서 접힌 코드 줄이 `…'.xterm-screen').ge tBoundingClientRect()` 로 복사됐다.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { setXterm } from "../web/js/panel/terminal.js";
import { cropAwareSelection } from "../web/js/chatcopy/copy-text.js";

const context = { globalThis: {} };
vm.runInNewContext(fs.readFileSync("web/scrollback-copy.js", "utf8"), context);
globalThis.window = { IrisScrollbackCopy: context.globalThis.IrisScrollbackCopy };

const SIDEBAR = 40;
const PANE = 69;
const side = (text, last = "│") => text.padEnd(SIDEBAR - 1).slice(0, SIDEBAR - 1) + last;
const CODE = "(async()=>{const m=await import('/js/panel/terminal.js');const x=m.getXterm(),t=m.getTerminal(),i=m.getTerminalInner();const b=t.getBoundingClientRect(),s=t.querySelector('.xterm-screen').getBoundingClientRect();return [b,s]})()";

// Claude Code 가 67칸에서 접은 모양 그대로다. 셋째 줄은 긴 토큰을 경계에서 자른다.
const PANE_ROWS = [
  " Memo     Notes-Draft       Sandbox    layout-fit    copy-edge     x",
  "  (async()=>{const m=await import('/js/panel/terminal.js');const",
  "  x=m.getXterm(),t=m.getTerminal(),i=m.getTerminalInner();const",
  "  b=t.getBoundingClientRect(),s=t.querySelector('.xterm-screen').ge",
  "  tBoundingClientRect();return [b,s]})()",
  "",
  "─".repeat(67),
  "❯",
  "─".repeat(67),
];

// 한글은 xterm 처럼 두 셀을 쓴다. 앞 셀에 글자, 뒤 셀은 폭 0 이다.
const isWide = (ch) => { const c = ch.codePointAt(0); return (c >= 0xac00 && c <= 0xd7a3) || (c >= 0x3130 && c <= 0x318f); };
function fakeXterm(paneRows, selection, pane = PANE) {
  const cols = SIDEBAR + pane;
  const lines = paneRows.map((row, y) => {
    const cells = [];
    for (const ch of side(y === 0 ? " spaces" : "") + row) {
      cells.push({ ch, w: isWide(ch) ? 2 : 1 });
      if (isWide(ch)) cells.push({ ch: "", w: 0 });
    }
    while (cells.length < cols) cells.push({ ch: " ", w: 1 });
    return cells.slice(0, cols);
  });
  const line = (cells) => ({
    length: cells.length,
    getCell: (x) => (x < cells.length ? { getChars: () => (cells[x].ch === " " ? "" : cells[x].ch), getWidth: () => cells[x].w } : undefined),
    translateToString: (trim, start = 0, end = cells.length) => {
      const s = cells.slice(start, end).map((c) => c.ch).join("");
      return trim ? s.replace(/[ ]+$/, "") : s;
    },
  });
  return {
    cols, rows: lines.length,
    buffer: { active: { baseY: 0, length: lines.length, getLine: (y) => (lines[y] ? line(lines[y]) : undefined) } },
    getSelection: () => "raw",
    getSelectionPosition: () => selection,
  };
}

test("탭 줄이 pane 끝까지 차 있어도 경계에서 잘린 토큰을 공백 없이 잇는다", () => {
  assert.equal([...PANE_ROWS[0]].length, 68);
  assert.equal([...PANE_ROWS[3]].length, 67);
  setXterm(fakeXterm(PANE_ROWS, { start: { x: SIDEBAR, y: 1 }, end: { x: SIDEBAR + PANE, y: 4 } }));
  assert.equal(cropAwareSelection(), CODE);
});

test("탭 줄은 접히는 경계를 재는 데 쓰지 않는다", () => {
  // 잘린 두 줄만 고르면 들여쓰기 문제는 끼어들지 않는다. 남는 원인은 탭 줄 폭뿐이다.
  setXterm(fakeXterm(PANE_ROWS, { start: { x: SIDEBAR + 2, y: 3 }, end: { x: SIDEBAR + PANE, y: 4 } }));
  assert.equal(cropAwareSelection(), "b=t.getBoundingClientRect(),s=t.querySelector('.xterm-screen').getBoundingClientRect();return [b,s]})()");
});

test("입력창에 여러 줄로 쓴 글은 줄바꿈을 두고 둘째 줄부터의 들여쓰기만 걷는다", () => {
  const rows = [
    PANE_ROWS[0], "", "─".repeat(67),
    "❯ ㅇㅁㄴㅇㅁ",
    "  ㄴㅇㅁㅇㅁㄴㅁㅇㅁㅇ",
    "  ㄴㅇㅁㅇ핼로",
    "─".repeat(67),
  ];
  setXterm(fakeXterm(rows, { start: { x: SIDEBAR + 2, y: 3 }, end: { x: SIDEBAR + PANE, y: 5 } }));
  assert.equal(cropAwareSelection(), "ㅇㅁㄴㅇㅁ\nㄴㅇㅁㅇㅁㄴㅁㅇㅁㅇ\nㄴㅇㅁㅇ핼로");
});

test("입력창 표시와 글자 사이 공백에서 드래그를 시작해도 둘째 줄부터의 들여쓰기를 걷는다", () => {
  const rows = [PANE_ROWS[0], "", "─".repeat(67), "❯ ㅇㄴㅁ", "  ㅇㄴㅁ", "  ㅇ", "─".repeat(67)];
  setXterm(fakeXterm(rows, { start: { x: SIDEBAR + 1, y: 3 }, end: { x: SIDEBAR + PANE, y: 5 } }));
  assert.equal(cropAwareSelection(), "ㅇㄴㅁ\nㅇㄴㅁ\nㅇ");
});

test("줄 중간에서 시작한 선택은 앞 공백을 옮기지 않는다", () => {
  const rows = [PANE_ROWS[0], "", "  key:   value", "  next line", ""];
  setXterm(fakeXterm(rows, { start: { x: SIDEBAR + 6, y: 2 }, end: { x: SIDEBAR + PANE, y: 3 } }));
  // 이 결과는 바꾸기 전과 같다. 줄 중간 선택에는 앞 공백 옮기기가 걸리지 않는다.
  assert.equal(cropAwareSelection(), "  value\nnext line");
});

// 아래 둘은 실제 화면에서 받은 값이다(pane 68칸). 입력창 표시 뒤 칸은 U+00A0 이고, 입력창은 본문보다
// 좁게 접혀 첫 줄이 64칸에서 넘어갔다.
const LIVE_PANE = 68;
const INPUT_BOX = (lines) => [
  " 1  Memo", "",
  // 본문은 66칸까지 찬다. 입력창 첫 줄(64칸)보다 넓다.
  "⏺ " + "x".repeat(64),
  "",
  "─".repeat(66), ...lines, "─".repeat(66),
  "  ⏵⏵ auto mode on",
];

test("입력창 표시 뒤 칸이 줄바꿈 없는 공백이어도 둘째 줄부터의 들여쓰기를 걷는다", () => {
  const rows = INPUT_BOX(["❯\u00a0ㅇㄴㅁ", "  ㅇㄴㅁ", "  ㅇ"]);
  setXterm(fakeXterm(rows, { start: { x: SIDEBAR + 2, y: 5 }, end: { x: SIDEBAR + LIVE_PANE, y: 7 } }, LIVE_PANE));
  assert.equal(cropAwareSelection(), "ㅇㄴㅁ\nㅇㄴㅁ\nㅇ");
});

test("입력창에서 한 줄로 쓴 긴 글이 넘어간 자리에 공백을 넣지 않는다", () => {
  const rows = INPUT_BOX(["❯\u00a0" + "ㅇ".repeat(31), "  " + "ㅇ".repeat(16)]);
  setXterm(fakeXterm(rows, { start: { x: SIDEBAR + 2, y: 5 }, end: { x: SIDEBAR + 2 + 32, y: 6 } }, LIVE_PANE));
  assert.equal(cropAwareSelection(), "ㅇ".repeat(47));
});
