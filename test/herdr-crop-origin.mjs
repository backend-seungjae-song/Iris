// 채팅 칸이 herdr 화면에서 가릴 칸과 줄을 버퍼에서 제대로 읽는가.
//
// 화면은 herdr 0.7.3 이 실제로 그린 것을 옮겼다. 사이드바 폭은 사용자가 끌면 바뀌고, 창이 좁으면
// herdr 이 사이드바를 접고 위에 두 줄 머리를 그린다. 이전 판정은 세로줄이 가장 많은 열을 골라
// 좁은 모드의 pane 테두리(0열)를 사이드바로 읽었고, 읽지 못하면 37칸을 가려 내용을 잘랐다.
import assert from "node:assert/strict";
import test from "node:test";
import { detectOrigin, sidebarCols, setXterm } from "../web/js/panel/terminal.js";

function fakeXterm(lines) {
  const cols = Math.max(...lines.map((l) => [...l].length));
  const rows = lines.map((l) => [...l.padEnd(cols)]);
  const line = (cells) => ({
    getCell: (x) => (x < cells.length ? { getChars: () => (cells[x] === " " ? "" : cells[x]) } : undefined),
    translateToString: (trim, start = 0, end = cells.length) => {
      const s = cells.slice(start, end).join("");
      return trim ? s.replace(/\s+$/, "") : s;
    },
  });
  return { cols, rows: rows.length, buffer: { active: { baseY: 0, getLine: (y) => (rows[y] ? line(rows[y]) : undefined) } } };
}

// 사이드바 32칸, pane 하나. 아래쪽 네 줄은 herdr 업데이트 알림 창이 경계선을 덮고 있다.
const SIDEBAR_WITH_NOTICE = [
  " spaces                        │ 1       +                                                ",
  "                               │➜  scratchpad %                                           ",
  " · scratchpad                  │➜  scratchpad                                             ",
  "                               │                                                          ",
  "                               │                                                          ",
  "                               │                                                          ",
  " new                     ● menu│                                                          ",
  "───────────────────────────────│                                                          ",
  " agents                 grouped│                                                          ",
  "                               │                                                          ",
  "                        ┌────────────────────────────────────────────────────────────────┐",
  "                        │● v0.9.1 available                                              │",
  "                        │  detach, run `herdr update`, then follow its restart guidance  │",
  "                        └────────────────────────────────────────────────────────────────┘",
];

// 사이드바 32칸, pane 을 좌우로 나눠 pane 마다 테두리가 있다.
const SIDEBAR_SPLIT = [
  " spaces                        │ 1       +                                                ",
  "                               │┌───────────────────────────┐┌───────────────────────────┐",
  " · scratchpad                  ││➜  scratchpad %            ││➜  scratchpad              │",
  "                               ││                           ││                           │",
  "                               ││     ➜ ➜  scratchpad %     ││                           │",
  " new                     ● menu││                           ││                           │",
  "───────────────────────────────││➜  scratchpad              ││                           │",
  " agents                 grouped││                           ││                           │",
  "                               ││                           ││                           │",
  "                               ││                           ││                           │",
  "                               ││                           ││                           │",
  "                              «│└───────────────────────────┘└───────────────────────────┘",
];

// 창이 좁아 사이드바를 접은 모드. 위 두 줄이 머리이고 pane 은 0열 2행에서 시작한다.
const COLLAPSED_SPLIT = [
  " · scratchpad                               tab 1 │         ",
  " no agents                                        │ switch  ",
  "┌────────────────────────────┐┌────────────────────────────┐",
  "│➜  scratchpad %             ││➜  scratchpad               │",
  "│                            ││                            │",
  "│   ➜ ➜  scratchpad %        ││                            │",
  "│                       ➜  s ││                            │",
  "│➜  scratchpad               ││                            │",
  "│                            ││                            │",
  "└────────────────────────────┘└────────────────────────────┘",
];

// 사이드바를 토글해 4칸짜리 좁은 사이드바만 남은 모드.
const COMPACT_SIDEBAR = [
  "1 ·│ 1       +                                                                            ",
  "   │┌─────────────────────────────────────────┐┌─────────────────────────────────────────┐",
  "   ││➜  scratchpad %                          ││➜  scratchpad                            │",
  "   ││                 ➜ ➜  scratchpad %       ││                                         │",
  "───││➜  scratchpad                            ││                                         │",
  "   ││                                         ││                                         │",
  "   ││                                         ││                                         │",
  " » │└─────────────────────────────────────────┘└─────────────────────────────────────────┘",
];

test("알림 창이 경계선 일부를 덮어도 사이드바 폭을 읽는다", () => {
  setXterm(fakeXterm(SIDEBAR_WITH_NOTICE));
  assert.deepEqual(detectOrigin(), { cols: 32, rows: 1 });
});

test("pane 테두리를 사이드바 경계선으로 읽지 않는다", () => {
  setXterm(fakeXterm(SIDEBAR_SPLIT));
  assert.deepEqual(detectOrigin(), { cols: 32, rows: 1 });
});

test("사이드바를 접은 모드에서는 왼쪽을 가리지 않고 머리 두 줄을 가린다", () => {
  setXterm(fakeXterm(COLLAPSED_SPLIT));
  assert.deepEqual(detectOrigin(), { cols: 0, rows: 2 });
  assert.equal(sidebarCols(), 0);
});

test("좁은 사이드바도 그 폭만큼 읽는다", () => {
  setXterm(fakeXterm(COMPACT_SIDEBAR));
  assert.deepEqual(detectOrigin(), { cols: 4, rows: 1 });
});

test("herdr 화면이 아니면 판정하지 않고, 가리는 폭을 지어내지 않는다", () => {
  setXterm(fakeXterm(["➜  ~ %", "", "", ""]));
  assert.equal(detectOrigin(), null);
  assert.equal(sidebarCols(), 0);
});
