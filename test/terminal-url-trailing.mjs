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
const urls = (line) => terminalLinkSpans((ry) => (ry === 1 ? rowCells(line, 1, 120) : null), 1)
  .filter((sp) => sp.kind === "url").map((sp) => sp.text);

// 2026-11-06 사용자 붙여 넣은 글. 누르면 /devtools/%EC%9E%85%EB%8B%88%EB%8B%A4. 로 이동했음
test("주소 바로 뒤 '입니다.'는 주소가 아님", () => {
  assert.deepEqual(urls("디버거 연결: DevTools 주소는 http://127.0.0.1:59420/hnzjeoZWZOY=/devtools/입니다."),
    ["http://127.0.0.1:59420/hnzjeoZWZOY=/devtools/"]);
});

test("주소 뒤 조사와 문장 끝 마침표는 뺌", () => {
  assert.deepEqual(urls("https://example.com/a.html에서 확인"), ["https://example.com/a.html"]);
  assert.deepEqual(urls("https://example.com/docs를 열어"), ["https://example.com/docs"]);
  assert.deepEqual(urls("자세한 내용은 https://example.com/a?b=1."), ["https://example.com/a?b=1"]);
});

test("한글 경로와 끝 등호는 주소에 남김", () => {
  assert.deepEqual(urls("https://example.com/wiki/서울"), ["https://example.com/wiki/서울"]);
  assert.deepEqual(urls("https://example.com/wiki/한국어 문서"), ["https://example.com/wiki/한국어"]);
  assert.deepEqual(urls("http://127.0.0.1:59420/hnzjeoZWZOY="), ["http://127.0.0.1:59420/hnzjeoZWZOY="]);
});
