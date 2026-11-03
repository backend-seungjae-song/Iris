import assert from "node:assert/strict";
import test from "node:test";
import { setXterm } from "../web/js/panel/terminal.js";
import { forwardEnd, forwardStart } from "../web/js/chatcopy/forward-copy.js";

// herdr 0.9 pane 오른쪽 끝 스크롤 막대(바탕 ▕, 손잡이 ▐)가 그려진 화면의 끌기 복사(2026-11-03 사용자 붙여 넣은 글)
const COLS = 40;
function fakeXterm(rows) {
  const line = (s) => ({
    getCell: (x) => (x < COLS ? { getChars: () => (s[x] === " " ? "" : s[x] || ""), getWidth: () => 1 } : undefined),
    translateToString: (trim, a = 0, b = COLS) => { const t = s.padEnd(COLS).slice(a, b); return trim ? t.replace(/\s+$/, "") : t; },
  });
  const lines = rows.map(line);
  return { cols: COLS, rows: rows.length, buffer: { active: { viewportY: 0, baseY: 0, length: lines.length, getLine: (y) => lines[y] } } };
}
// 마지막 칸이 막대. 손잡이는 가운데 두 줄
const bar = (rows, width = COLS) => rows.map((s, i) => s.padEnd(width - 1) + (i === 1 || i === 2 ? "▐" : "▕"));

function clipboard(initial) {
  const state = { value: initial };
  globalThis.window = { acHost: { readClipboard: async () => state.value } };
  state.write = async (text) => { state.value = text; return true; };
  return state;
}

async function drag(screen, from, to) {
  setXterm(fakeXterm(screen));
  const clip = clipboard("이전 클립보드");
  forwardStart();
  await forwardEnd({ from, to }, clip.write);
  return clip.value;
}

// 짧은 줄과 경로 중간에서 접힌 긴 줄이 섞인 화면
const TRACE = ["Traceback (most recent):", '  File "/opt/homebrew/Cellar/python/li', 'b/json/decoder.py", line 345', "    raise JSONDecodeError"];

test("스크롤 막대 글자는 빼고 원래 줄바꿈대로 복사", async () => {
  const out = await drag(bar(TRACE), { col: 1, row: 1 }, { col: 40, row: 4 });
  assert.equal(out, 'Traceback (most recent):\n  File "/opt/homebrew/Cellar/python/lib/json/decoder.py", line 345\n    raise JSONDecodeError');
});

test("막대 바로 앞까지 차서 접힌 줄은 지금처럼 이음", async () => {
  const rows = ["alpha beta gamma delta epsilon zeta et", "theta iota", "", ""];
  const out = await drag(bar(rows), { col: 1, row: 1 }, { col: 12, row: 2 });
  assert.equal(out, "alpha beta gamma delta epsilon zeta et theta iota");
});

test("세로선으로 나뉜 왼쪽 pane 의 막대도 뺌", async () => {
  // 첫 줄은 탭 줄. 사이드바 0~4칸, 왼쪽 pane 6~25칸(25칸이 막대), 오른쪽 pane 27칸부터
  const rows = ["Trace:", " File x", "  for:", "Err"];
  const screen = ["side │ tabs".padEnd(COLS), ...bar(rows, 20).map((s) => "side │" + s + "│" + "right".padEnd(COLS - 27))];
  const out = await drag(screen, { col: 7, row: 2 }, { col: 26, row: 5 });
  assert.equal(out, rows.join("\n"));
});
