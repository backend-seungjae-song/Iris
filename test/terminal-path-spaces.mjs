import assert from "node:assert/strict";
import test from "node:test";
import { terminalLinkSpans } from "../web/js/panel/xterm-wiring.js";

globalThis.window = { acHost: { platform: "darwin" }, innerWidth: 1200 };

// 전각 글자는 두 칸. 실제 xterm 셀 공급자와 같은 x·endX
const wide = (ch) => /[ᄀ-ᇿ　-鿿가-힯＀-￯]/u.test(ch);
const rowCells = (s, y, cols) => {
  const out = []; let col = 0;
  for (const ch of s) { const w = wide(ch) ? 2 : 1; out.push({ ch, x: col + 1, endX: col + w, y }); col += w; }
  while (col < cols) { out.push({ ch: " ", x: col + 1, endX: col + 1, y }); col++; }
  return out;
};
const spans = (lines, cols = 80) => {
  const rows = lines.map((l, i) => rowCells(l, i + 1, cols));
  return lines.map((_, i) => terminalLinkSpans((ry) => rows[ry - 1] || null, i + 1).map((sp) => sp.text));
};

test("괄호로 감싼 경로는 공백이 있어도 닫는 괄호까지 링크", () => {
  const p = "/Users/you/Downloads/죽어-24회 50회.mp3";
  assert.deepEqual(spans([`• “죽어!” 음성 듣기 · MP3 (${p})`]), [[p]]);
});

test("줄이 넘어간 괄호 경로도 전체가 링크", () => {
  const p = "/Users/you/Downloads/죽어-24회 50회.mp3";
  const head = `• 음성 듣기 · MP3 (${p}`;
  // 첫 줄이 오른쪽 끝까지 차게 폭을 맞춤
  const cut = head.indexOf("50회") + 2;
  const first = head.slice(0, cut), rest = "  " + head.slice(cut) + ")";
  const cols = rowCells(first, 1, 0).at(-1).endX;
  assert.deepEqual(spans([first, rest], cols), [[p], [p]]);
});

test("따옴표·백틱으로 감싼 경로와 마크다운 링크 대상도 공백 허용", () => {
  assert.deepEqual(spans(["`/Users/you/a b.md` 열기"]), [["/Users/you/a b.md"]]);
  assert.deepEqual(spans(["\"/Users/you/a b.md\""]), [["/Users/you/a b.md"]]);
  assert.deepEqual(spans(["[음성](/Users/you/Downloads/a b.mp3)"]), [["/Users/you/Downloads/a b.mp3"]]);
});

test("괄호 안 나열·뒤에 붙은 설명은 지금처럼 경로만", () => {
  assert.deepEqual(spans(["(/Users/x/a.js, /Users/x/b.js)"]), [["/Users/x/a.js", "/Users/x/b.js"]]);
  assert.deepEqual(spans(["(/Users/x/a.js /Users/x/b.js)"]), [["/Users/x/a.js", "/Users/x/b.js"]]);
  assert.deepEqual(spans(["(/Users/x/a.js 참고)"]), [["/Users/x/a.js"]]);
  assert.deepEqual(spans(["(/Users/x/a.js)"]), [["/Users/x/a.js"]]);
});
