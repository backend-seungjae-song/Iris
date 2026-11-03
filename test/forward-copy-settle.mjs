import assert from "node:assert/strict";
import test from "node:test";
import { setXterm } from "../web/js/panel/terminal.js";
import { forwardEnd, forwardStart } from "../web/js/chatcopy/forward-copy.js";

// 앱(herdr·Claude Code)에 넘긴 끌기 복사의 보완. 화면은 가짜 xterm, 클립보드는 시간에 따라 앱이 쓰는 값
const COLS = 40;
function fakeXterm(rows) {
  const line = (s) => ({
    getCell: (x) => (x < COLS ? { getChars: () => s[x] || "", getWidth: () => 1 } : undefined),
    translateToString: (trim, a = 0, b = COLS) => { const t = s.padEnd(COLS).slice(a, b); return trim ? t.replace(/\s+$/, "") : t; },
  });
  const lines = rows.map(line);
  return { cols: COLS, rows: rows.length, buffer: { active: { viewportY: 0, baseY: 0, length: lines.length, getLine: (y) => lines[y] } } };
}
// 첫 줄이 다음 단어가 안 들어가 접힌 화면. 접힌 자리 끝에 채움 공백 2칸
const ROW0 = "alpha beta gamma delta epsilon zeta et";
const SCREEN = [ROW0, "theta iota kappa", "x".repeat(COLS - 1)];
const RAW = ROW0 + "\ntheta iota kappa";
const CLEAN = ROW0 + " theta iota kappa";
const FROM = { col: 1, row: 1 }, TO = { col: 16, row: 2 };

function clipboard(initial) {
  const state = { value: initial, writes: [] };
  globalThis.window = { acHost: { readClipboard: async () => state.value } };
  state.write = async (text) => { state.value = text; state.writes.push(text); return true; };
  state.appWritesAt = (ms, text) => setTimeout(() => { state.value = text; }, ms);
  return state;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function drag(clip) {
  setXterm(fakeXterm(SCREEN));
  forwardStart();
  return forwardEnd({ from: FROM, to: TO }, clip.write);
}

test("앱이 복사하지 않으면 정리한 글을 씀", async () => {
  const clip = clipboard("이전 클립보드");
  assert.equal(await drag(clip), CLEAN);
  assert.equal(clip.value, CLEAN);
});

test("앱이 0.4초 뒤에 화면 줄 그대로 써도 최종 클립보드는 정리한 글", async () => {
  const clip = clipboard("이전 클립보드");
  clip.appWritesAt(700, RAW);
  await drag(clip);
  await wait(1200);
  assert.equal(clip.value, CLEAN);
});

test("앱이 정리한 글을 쓴 뒤 더 늦게 화면 줄로 덮어도 다시 정리한 글로", async () => {
  const clip = clipboard("이전 클립보드");
  clip.appWritesAt(1900, RAW);
  await drag(clip);
  await wait(1700);
  assert.equal(clip.value, CLEAN);
});

test("접힌 자리 채움 공백을 줄 중간에 남긴 앱 복사는 정리한 글로 바꿈", async () => {
  const clip = clipboard("이전 클립보드");
  clip.appWritesAt(50, ROW0 + "  theta iota kappa");
  assert.equal(await drag(clip), CLEAN);
  assert.equal(clip.value, CLEAN);
});

test("앱이 글자를 다르게 정리했거나 앞 들여쓰기만 다르면 그대로 둠", async () => {
  for (const own of ["alpha beta gamma delta epsilon zeta et theta", "  " + CLEAN]) {
    const clip = clipboard("이전 클립보드");
    clip.appWritesAt(50, own);
    assert.equal(await drag(clip), null);
    await wait(100);
    assert.equal(clip.value, own);
  }
});

// herdr 가 끌기 뒤 빈 글을 클립보드에 써서 끌기 복사가 전부 빈 값이 됐음(2026-10-31 00:11 클립보드 변경 기록)
test("앱이 빈 글을 쓰면 정리한 글로 바꿈", async () => {
  const clip = clipboard("이전 클립보드");
  clip.appWritesAt(100, "");
  assert.equal(await drag(clip), CLEAN);
  assert.equal(clip.value, CLEAN);
});

test("정리한 글을 쓴 뒤 앱이 늦게 빈 글로 덮어도 다시 정리한 글로", async () => {
  const clip = clipboard("이전 클립보드");
  clip.appWritesAt(1900, "");
  await drag(clip);
  await wait(1700);
  assert.equal(clip.value, CLEAN);
});
