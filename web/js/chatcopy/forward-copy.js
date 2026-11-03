// 앱에 넘긴 끌기 복사의 보완.
//
// 소유 범위
//   왼쪽 끌기를 pane 앱(herdr·Claude Code·Codex)에 넘긴 뒤, 앱이 복사하지 않았거나 화면 줄을
//   그대로 복사했을 때만 같은 범위를 화면 칸에서 읽어 정리한 글로 클립보드를 바꾼다.
//   앱이 정리해 복사한 결과(겉에 뜬 표시를 뺀 것 등)는 건드리지 않는다.
//
// 제공 API
//   forwardStart() · forwardEnd({ from, to }, write). 좌표는 화면 기준 1부터 센 셀.
//
// 유지 조건
//   정리 규칙은 칸 폭과 위치만 쓴다. 앱이 그리는 표시 글자 목록에 기대면 앱 화면이 바뀔 때마다
//   고쳐야 한다. 쓰는 규칙은 둘이다. 다음 단어가 남은 폭에 들어가지 않아 넘어간 줄은 잇고,
//   이어지는 줄의 앞 공백(첫 줄 글자 위치까지)은 뺀다.
//
// 영향 범위
//   chatcopy/boot 의 chatcopy.forwardStart·forwardEnd. 부르는 곳은 panel/xterm-wiring 의 왼쪽 끌기 전달.
import { detectOrigin, getXterm } from "../panel/terminal.js";

// 앱이 클립보드에 쓰기까지 기다리는 시간. Claude Code 는 pbcopy 를 띄워 쓰므로 바로 바뀌지 않음
const APP_COPY_WAIT_MS = 400;
// 가장 넓은 줄이 pane 폭보다 이만큼 이상 좁으면 접힌 줄이 없는 화면으로 판정
const NO_WRAP_SLACK = 8;
// 넓은 글자(한글)는 오른쪽에 1칸만 남으면 다음 줄로 넘어가고, 앱은 오른쪽 여백을 1~2칸 둠
const WRAP_MARGIN = 2;
const SCAN_ROWS = 40;

const VBAR = /[│┃║╎╏┆┇┊┋]/u;
// herdr 0.9 스크롤 막대(바탕 ▕, 손잡이 ▐). 블록 글자 범위 전체로 판정
const BLOCK = /^[\u2580-\u259F]$/u;
const BOX_ONLY = /^[\s─-╿]+$/u;

const readClipboard = async () => {
  const read = window.acHost?.readClipboard;
  if (typeof read !== "function") return null;
  try { const text = await read(); return typeof text === "string" ? text : null; } catch { return null; }
};

let before = null;

export function forwardStart() {
  before = readClipboard();
}

// 누른 자리가 속한 pane 의 왼쪽·오른쪽 끝 칸. herdr 가 pane 사이에 그리는 세로선으로 찾음
function paneBounds(line, col, cols) {
  let left = 0, right = cols - 1;
  for (let x = col; x >= 0; x--) if (VBAR.test(line.getCell(x)?.getChars() || "")) { left = x + 1; break; }
  for (let x = col; x < cols; x++) if (VBAR.test(line.getCell(x)?.getChars() || "")) { right = x - 1; break; }
  return { left, right };
}

// right 칸이 스크롤 막대인지. 고른 줄마다 그 칸이 블록 글자일 때만. 막대는 pane 의 모든 줄에 그려짐
function scrollbarAt(buf, y0, y1, right) {
  for (let y = y0; y <= y1; y++) if (!BLOCK.test(buf.getLine(y)?.getCell(right)?.getChars() || "")) return false;
  return true;
}

// [a, b] 칸의 글. b 가 넓은 글자의 첫 칸이면 둘째 칸까지 포함
function cellsText(line, a, b) {
  if (b < a) return "";
  const end = (line.getCell(b)?.getWidth() === 2) ? b + 2 : b + 1;
  return line.translateToString(false, a, end);
}

// [left, right] 안에서 글자가 있는 마지막 칸의 끝 열. 없으면 -1
function contentEnd(line, left, right) {
  for (let x = right; x >= left; x--) {
    const cell = line.getCell(x); if (!cell) continue;
    const ch = cell.getChars();
    if (ch && ch !== " ") return x + Math.max(1, cell.getWidth()) - 1;
  }
  return -1;
}

const lead = (s) => s.length - s.replace(/^ +/, "").length;

// 끌어 고른 범위를 정리한 글로. 칸 폭과 위치만 사용
function selectionText(from, to) {
  const xterm = getXterm();
  const buf = xterm.buffer.active;
  let a = { col: from.col - 1, y: buf.viewportY + from.row - 1 };
  let b = { col: to.col - 1, y: buf.viewportY + to.row - 1 };
  if (b.y < a.y || (b.y === a.y && b.col < a.col)) [a, b] = [b, a];
  const firstLine = buf.getLine(a.y); if (!firstLine) return null;
  const a0y = a.y;
  let { left, right } = paneBounds(firstLine, a.col, xterm.cols);
  if (VBAR.test(firstLine.getCell(a.col)?.getChars() || "")) return null; // pane 경계선 끌기(크기 조절)
  // 막대를 글자로 읽으면 줄마다 끝까지 찬 것으로 보여 모든 줄을 접힌 줄로 이음(2026-11-03)
  if (right > left && scrollbarAt(buf, a.y, b.y, right)) right -= 1;

  const rows = [], ends = [];
  for (let y = a.y; y <= b.y; y++) {
    const line = buf.getLine(y);
    if (!line) { rows.push(""); ends.push(-1); continue; }
    const s = y === a.y ? Math.max(a.col, left) : left;
    const e = y === b.y ? Math.min(b.col, right) : right;
    rows.push(cellsText(line, s, e).replace(/\s+$/, ""));
    ends.push(contentEnd(line, left, right));
  }
  const raw = rows.join("\n");
  const screenRows = rows.slice(), screenEnds = ends.slice();
  // 끌기가 넘어 들어간 위·아래 경계선(선만 그린 줄)은 정리 글에서 제외
  while (rows.length > 1 && BOX_ONLY.test(rows[0])) { rows.shift(); ends.shift(); a = { col: left, y: a.y + 1 }; }
  while (rows.length > 1 && BOX_ONLY.test(rows[rows.length - 1])) { rows.pop(); ends.pop(); }

  // 화면이 실제로 접히는 열. 주변 줄의 가장 긴 끝으로 잼. 선만 그린 줄(구역 경계)은 pane 끝까지 차므로 제외
  let edge = -1;
  for (let y = Math.max(0, a.y - SCAN_ROWS); y <= Math.min(buf.length - 1, b.y + SCAN_ROWS); y++) {
    const line = buf.getLine(y); if (!line) continue;
    if (BOX_ONLY.test(line.translateToString(true, left, right + 1))) continue;
    edge = Math.max(edge, contentEnd(line, left, right));
  }
  const wraps = edge >= 0 && (right - edge) < NO_WRAP_SLACK;

  // 첫 줄 글자가 시작하는 열. 이어지는 줄은 이 열에 맞춰 들여 그려짐
  let firstRow = rows[0] || "";
  let inset = (Math.max(a.col, left) - left) + lead(firstRow);
  const cellWidth = (str) => { let w = 0; for (const ch of str) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u.test(ch) ? 2 : 1; return w; };

  const following = rows.slice(1).filter((r) => r.trim());
  const common = following.length ? Math.min(...following.map(lead)) : 0;
  // 선택이 줄 앞 표시에서 시작함. 들여쓰기 폭 안이 글자·숫자가 아닌 기호 하나와 공백뿐이면 앱 표시로 보고 뺌
  if (inset === 0 && common > 0 && /^[^\p{L}\p{N}\s]\s+$/u.test(firstRow.slice(0, common))) {
    firstRow = firstRow.slice(common);
    inset = common;
  }
  let out = firstRow.replace(/^ +/, "");
  const strip = Math.min(inset, common);
  for (let i = 0; i < rows.length - 1; i++) {
    const cur = rows[i], next = rows[i + 1];
    const nextBody = next.replace(/^ +/, "");
    const nextWord = (nextBody.match(/^\S+/) || [""])[0];
    const width = ends[i] - left + 1;
    const span = edge - left + 1;
    const wrapped = wraps && cur.trim() !== "" && nextBody !== ""
      && width + 1 + cellWidth(nextWord) > span - WRAP_MARGIN;
    if (!wrapped) { out += "\n" + next.slice(Math.min(strip, lead(next))); continue; }
    // 줄 끝에 빈칸이 없고 잘린 토큰이 한 줄보다 길면 토큰 중간에서 잘린 것이라 공백 없이 이음
    const lastTok = (cur.match(/\S+$/) || [""])[0];
    const midToken = (span - width) < 1 && cellWidth(lastTok) + cellWidth(nextWord) > span;
    out += (midToken ? "" : " ") + nextBody;
  }
  // 앱 복사 글을 이을 때 쓰는 화면 줄. 접히는 열 바로 뒤 칸에 공백을 썼는지(접힌 자리의 공백)
  const screen = wraps ? {
    edge,
    rows: screenRows.map((text, i) => ({ text, end: screenEnds[i],
      spaceAfter: buf.getLine(a0y + i)?.getCell(screenEnds[i] + 1)?.getChars() === " " })),
  } : null;
  return { raw, text: out.replace(/\s+$/, ""), screen };
}

const squash = (s) => String(s || "").replace(/\s+/g, "");
const lineCount = (s) => String(s || "").split("\n").length;
const trimLines = (s) => String(s || "").split("\n").map((ln) => ln.replace(/\s+$/, "")).join("\n").replace(/\n+$/, "");
const MID_GAP = /\S {2,}\S/;

// 앱 복사 결과를 정리한 글로 바꿀지. 앱이 복사하지 않았거나, 화면 줄을 글자 그대로 복사했거나(직접 넣은 줄바꿈 뒤
// 들여쓰기 포함), 같은 글을 접힌 줄 그대로 나눴거나, 접힌 자리의 채움 공백을 줄 중간에 남긴 채 이었을 때.
// 앞 들여쓰기만 다른 경우는 앱이 코드 들여쓰기를 맞게 정리한 것일 수 있어 그대로 둠
// - 빈 글: 글자가 있는 범위를 끌었는데 앱이 빈 글을 씀(2026-10-31 클립보드 기록)
function shouldReplace(prev, now, sel) {
  if (now === null || now === sel.text) return false;
  if (now === prev || !now.trim() || trimLines(now) === trimLines(sel.raw)) return true;
  if (squash(now) !== squash(sel.raw)) return false;
  return lineCount(now) > lineCount(sel.text) || (MID_GAP.test(now) && !MID_GAP.test(sel.text));
}

// 클립보드가 prev 에서 바뀔 때까지 기다림. 앱(herdr·Claude Code)은 손을 뗀 뒤 pbcopy 등으로 쓰므로
// 바뀌는 시점이 정해져 있지 않음. 상한까지 안 바뀌면 마지막 값
async function waitForChange(read, prev, { timeoutMs, stepMs, sleep }) {
  let now = await read();
  for (let waited = 0; now !== null && now === prev && waited < timeoutMs; waited += stepMs) {
    await sleep(stepMs);
    now = await read();
  }
  return now;
}

const tail = (s) => s.replace(/\s+$/, "").slice(-12);
const head = (s) => s.replace(/^\s+/, "").slice(0, 12);

// 앱이 화면에서 접힌 자리마다 줄을 나눠 복사한 글을 원래 줄로 이음(Claude Code 수정 내용 표시).
// 앱 글의 줄마다 화면 줄을 찾아, 그 줄이 접히는 열까지 찼고 바로 아래 줄로 이어질 때만 이음.
// 앱은 접힌 자리 끝 공백을 지우므로 화면 칸에 공백이 있었으면 공백 하나를 되살림
function joinAppWraps(text, screen) {
  if (typeof text !== "string" || !screen) return text;
  const lines = text.split("\n");
  const rows = screen.rows;
  let out = lines[0], r = 0;
  for (let i = 0; i < lines.length - 1; i++) {
    const cur = lines[i], next = lines[i + 1];
    let k = -1;
    if (cur.trim() && next.trim()) {
      for (let y = r; y < rows.length - 1; y++) {
        const at = rows[y + 1].text.indexOf(head(next));
        if (at >= 0 && rows[y].text.replace(/\s+$/, "").endsWith(tail(cur))) {
          // 다음 화면 줄의 글 앞에 글자·숫자(줄 번호 등)가 있으면 새 줄
          if (!/[\p{L}\p{N}]/u.test(rows[y + 1].text.slice(0, at))) k = y;
          break;
        }
      }
    }
    if (k < 0) { out += "\n" + next; continue; }
    r = k + 1;
    const row = rows[k];
    if (row.end < screen.edge - 1) { out += "\n" + next; continue; }
    const gap = !/^\s/.test(next) && /\S$/.test(cur) && row.spaceAfter ? " " : "";
    out += gap + next;
  }
  return out;
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TIMING = { firstWaitMs: APP_COPY_WAIT_MS, timeoutMs: 1500, stepMs: 100, lateMs: 1500, sleep: realSleep };

// 앱 복사 결과(클립보드 읽기 read)를 보고 정리한 글 sel.text 를 쓸지 정하고 씀. 정리한 글을 쓴 뒤
// 앱이 늦게 화면 그대로의 글로 덮으면 한 번 더 바꿈. 바꿨으면 그 글을 돌려줌
async function settleForwardCopy({ prev, sel, read, write, timing = TIMING }) {
  await timing.sleep(timing.firstWaitMs);
  const now = await waitForChange(read, prev, { ...timing, timeoutMs: timing.timeoutMs - timing.firstWaitMs });
  if (!shouldReplace(prev, now, sel)) {
    // 앱이 정리해 복사했어도 접힌 줄을 나눴으면 이음
    const joined = now === prev ? now : joinAppWraps(now, sel.screen);
    if (joined === now || !(await write(joined))) return null;
    return joined;
  }
  if (!(await write(sel.text))) return null;
  // 늦게 온 앱 복사 감시. 기다리지 않고 돌려줌. 화면과 다른 글이 오면 사람이 새로 복사한 것이라 멈춤
  timing.late = (async () => {
    for (let waited = 0; waited < timing.lateMs; waited += timing.stepMs) {
      await timing.sleep(timing.stepMs);
      const later = await read();
      if (later === null || later === sel.text) continue;
      if (!later.trim() || squash(later) === squash(sel.raw)) await write(sel.text);
      return;
    }
  })().catch(() => {});
  return sel.text;
}

// 손을 뗀 뒤 앱의 복사 결과를 보고 필요할 때만 정리한 글로 바꿈. 바꿨으면 그 글을 돌려줌
export async function forwardEnd({ from, to } = {}, write) {
  const was = before; before = null;
  if (!from || !to || (from.col === to.col && from.row === to.row)) return null;
  const origin = detectOrigin();
  if (origin && (from.row <= origin.rows || from.col <= origin.cols)) return null; // herdr 탭 줄·사이드바
  let sel;
  try { sel = selectionText(from, to); } catch { return null; }
  if (!sel || !sel.text.trim()) return null;
  const prev = await was;
  if (prev === null) return null; // 클립보드를 읽을 수 없으면 앱이 복사했는지 알 수 없음
  return settleForwardCopy({ prev, sel, read: readClipboard, write });
}

export { settleForwardCopy, shouldReplace };
