import { cellWidth } from "./cell-width.js";

// 터미널 입력줄에 쓰다 만 글(Claude Code ❯ 칸·Codex › 칸). 화면 ANSI 원문에서 꺼냄
// - 흐림(SGR 2) 글자는 빈 입력줄의 안내 글이라 뺌(Codex "Ask Codex to do anything")
// - 화면에서는 접힘과 줄바꿈이 같아 보임 → 앞 줄에 다음 낱말이 들어갈 칸이 없었으면 접힘으로 봄
// - 접는 폭: Claude Code 는 터미널 폭 − 2, Codex 는 − 1(실제 화면에서 잰 값)

const RULE = /^─{8,}\s*$/;
// Claude Code 는 ❯ 뒤에 줄바꿈 없는 공백(U+00A0)을 씀
// 붙여 넣은 덩어리·이미지 자리. 화면에는 이름만 있어 내용을 못 읽음
const PASTED = /\[(?:Pasted (?:text|Content)[^\]]*|Image #\d+)\]/;

// 이스케이프를 지우고 흐림 글자도 뺀 글
export function undimmed(line) {
  const re = /\x1b\[([0-9;:?]*)([ -/]*[@-~])|\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b[@-_]/g;
  let out = "";
  let dim = false;
  let last = 0;
  let m;
  while ((m = re.exec(line))) {
    if (!dim) out += line.slice(last, m.index);
    last = re.lastIndex;
    if (m[2] !== "m") continue;
    const ps = m[1] === "" ? [0] : m[1].split(/[;:]/).map(Number);
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (p === 0 || p === 22) dim = false;
      else if (p === 2) dim = true;
      else if (p === 38 || p === 48 || p === 58) i += ps[i + 1] === 5 ? 2 : ps[i + 1] === 2 ? 4 : 0;
    }
  }
  if (!dim) out += line.slice(last);
  return out;
}
const plain = (line) => line.replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b[@-_]/g, "");

// 화면 줄들 → 입력 칸의 줄(앞 표시·들여쓰기 뺀 것)과 접는 폭. 입력 칸이 안 보이면 null
function claudeBox(lines) {
  for (let i = lines.length - 1; i > 0; i--) {
    const text = undimmed(lines[i]);
    if (!/^❯(?:[ \u00a0]|$)/.test(text) || !RULE.test(plain(lines[i - 1]))) continue;
    const end = lines.findIndex((l, j) => j > i && RULE.test(plain(l)));
    if (end < 0) return null;
    const rows = lines.slice(i, end).map((l, k) => undimmed(l).replace(k === 0 ? /^❯[ \u00a0]?/ : /^[ \u00a0]{1,2}/, "").trimEnd());
    return { rows, limit: cellWidth(plain(lines[end]).trimEnd()) - 2 };
  }
  return null;
}
function codexBox(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const text = undimmed(lines[i]);
    if (!/^›(?:[ \u00a0]|$)/.test(text)) continue;
    let end = lines.findIndex((l, j) => j > i && !plain(l).trim());
    if (end < 0) end = lines.length;
    const rows = lines.slice(i, end).map((l, k) => undimmed(l).replace(k === 0 ? /^›[ \u00a0]?/ : /^[ \u00a0]{1,2}/, "").trimEnd());
    // 입력 줄은 배경색 공백으로 터미널 폭까지 채워짐
    return { rows, limit: cellWidth(plain(lines[i])) - 1 };
  }
  return null;
}

// 화면 줄 사이를 이음. 접힌 곳은 낱말 사이 공백 하나(낱말 단위 접힘) 또는 없음(글자 단위 접힘)
export function joinRows(rows, limit) {
  let text = rows[0] ?? "";
  for (let k = 1; k < rows.length; k++) {
    const prev = 2 + cellWidth(rows[k - 1]);
    const word = rows[k].match(/^\S+/)?.[0] ?? "";
    // 다음 줄 전체가 공백 없이 꽉 찼으면 그 낱말은 한 줄보다 긺(조각만 보임)
    const wordWidth = word === rows[k] && 2 + cellWidth(word) >= limit ? Infinity : cellWidth(word);
    // 글자 단위 접힘은 한 줄보다 긴 낱말에서만 생김 → 공백 없는 꽉 찬 줄
    if (limit > 0 && prev >= limit && !/\s/.test(rows[k - 1])) text += rows[k];
    // 빈 줄에도 안 들어가는 낱말이면 접힘이 아님(접혔으면 앞 줄을 채움)
    else if (limit > 0 && word && prev + 1 + wordWidth > limit && 2 + wordWidth <= limit) text += ` ${rows[k]}`;
    else text += `\n${rows[k]}`;
  }
  return text;
}

// { text, lines, pasted, cut } | null(입력 칸이 안 보임: 질문 화면 등)
// - cut: 입력 칸이 화면 절반 이상이면 위쪽이 스크롤로 가려졌을 수 있음(Codex 30줄 붙여넣기에서 뒤 20줄만 보임)
export function terminalDraft(screen, kind) {
  const lines = String(screen || "").replace(/\n$/, "").split(/\r?\n/);
  const box = kind === "codex" ? codexBox(lines) : claudeBox(lines);
  if (!box) return null;
  const text = joinRows(box.rows, box.limit).replace(/\s+$/, "");
  return { text, lines: box.rows.length, pasted: PASTED.test(text), cut: box.rows.length >= Math.max(4, Math.floor(lines.length / 2)) };
}

// 입력 칸 전부 지우는 키. Ctrl+K 로 커서 뒤(줄바꿈 포함), Ctrl+U 로 커서 앞
// - 한 번은 커서 줄만 지움. 남은 줄이 다음 글과 함께 보내지던 결함
// - 화면 줄 수를 모르면 넉넉히
export function clearKeys(lines) {
  const n = Number.isSafeInteger(lines) && lines > 0 ? 2 * lines + 2 : 16;
  return "\x0b".repeat(n) + "\x15".repeat(n);
}
