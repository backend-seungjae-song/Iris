import assert from "node:assert/strict";
import test from "node:test";
import { setXterm } from "../web/js/panel/terminal.js";
import { forwardEnd, forwardStart } from "../web/js/chatcopy/forward-copy.js";

// Claude Code 수정 내용 표시: 줄 번호 뒤 글을 화면 폭에서 글자 단위로 접어 그림. 앱 복사는 줄 번호·표시를 빼고
// 접힌 자리마다 줄을 나눔(2026-11-03 사용자 붙여 넣은 글)
const COLS = 44, GUTTER = 6, CW = 36;
const wide = (ch) => /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u.test(ch);

// 칸 단위 화면 줄. 쓴 칸만 글자(공백 포함), 안 쓴 칸은 빈 글자
function cellsOf(s) {
  const cells = [];
  for (const ch of s) { cells.push({ ch, w: wide(ch) ? 2 : 1 }); if (wide(ch)) cells.push({ ch: "", w: 0 }); }
  return cells;
}
function fakeXterm(rows) {
  const line = (s) => {
    const cells = cellsOf(s);
    return {
      getCell: (x) => (x < COLS ? { getChars: () => cells[x]?.ch ?? "", getWidth: () => cells[x]?.w ?? 1 } : undefined),
      translateToString: (trim, a = 0, b = COLS) => {
        let t = ""; for (let x = a; x < b; x++) t += x < cells.length ? cells[x].ch : " ";
        return trim ? t.replace(/\s+$/, "") : t;
      },
    };
  };
  const lines = rows.map(line);
  return { cols: COLS, rows: rows.length, buffer: { active: { viewportY: 0, baseY: 0, length: lines.length, getLine: (y) => lines[y] } } };
}

// 한 줄을 CW 칸에서 글자 단위로 접음. 넓은 글자가 안 들어가면 다음 줄로
function wrap(text) {
  const out = []; let cur = "", w = 0;
  for (const ch of text) {
    const cw = wide(ch) ? 2 : 1;
    if (w + cw > CW) { out.push(cur); cur = ""; w = 0; }
    cur += ch; w += cw;
  }
  out.push(cur);
  return out;
}
// 수정 내용 표시 화면과 앱 복사 결과
function diffView(lines) {
  const screen = [], copied = [];
  lines.forEach((text, i) => wrap(text).forEach((part, j) => {
    screen.push((j === 0 ? String(10 + i).padStart(4) + " +" : " ".repeat(GUTTER - 1) + "+") + part);
    copied.push(part.replace(/\s+$/, ""));
  }));
  return { screen, copied: copied.join("\n") };
}

function clipboard(initial) {
  const state = { value: initial };
  globalThis.window = { acHost: { readClipboard: async () => state.value } };
  state.write = async (text) => { state.value = text; return true; };
  return state;
}

async function dragWithAppCopy(screen, appText) {
  setXterm(fakeXterm(screen));
  const clip = clipboard("이전 클립보드");
  forwardStart();
  setTimeout(() => { clip.value = appText; }, 100);
  await forwardEnd({ from: { col: 1, row: 1 }, to: { col: COLS, row: screen.length } }, clip.write);
  return clip.value;
}

const LINES = [
  "원문: 아예 복사 제대로 안되는 문제는 어느정도 해결된 것처럼 보이나 저건 고쳐야지.",
  "짧은 줄",
  "설치본 forward-copy.js 가 HEAD 와 같음(cmp), 서버 4271 healthz 200 확인.",
  "  들여 쓴 줄은 그대로",
];

test("앱이 접힌 자리마다 나눈 복사는 원래 줄로 이음", async () => {
  const { screen, copied } = diffView(LINES);
  assert.notEqual(copied.split("\n").length, LINES.length);
  assert.equal(await dragWithAppCopy(screen, copied), LINES.join("\n"));
});

test("접히는 열까지 차지 않은 줄은 잇지 않음", async () => {
  const lines = ["첫 줄", "둘째 줄", "셋째 줄"];
  const { screen, copied } = diffView(lines);
  assert.equal(await dragWithAppCopy(screen, copied), copied);
});

