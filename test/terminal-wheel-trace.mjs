import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {
  countTerminalInput, createTerminalInputTrace, formatTerminalInputLine,
} from "../server/terminal-input-trace.js";

// 휠 이동량 누적: 브라우저 모듈이라 함수 본문만 꺼내 실행
const source = fs.readFileSync("web/js/panel/xterm-wiring.js", "utf8");
const match = source.match(/const WHEEL_IDLE_MS = \d+;\nexport function wheelStep\([^)]*\) \{[\s\S]*?\n\}/);
assert.ok(match, "wheelStep 이 있어야 한다");
const context = {};
vm.runInNewContext(`${match[0].replace("export ", "")}\nthis.wheelStep = wheelStep;`, context);
const { wheelStep } = context;

// 연속 스크롤: 30px 마다 한 줄, 나머지는 이어서 쌓임
let s = wheelStep(0, -20, 16);
assert.equal(s.lines, 0);
s = wheelStep(s.rest, -20, 16);
assert.deepEqual({ lines: s.lines, dir: s.dir, rest: s.rest }, { lines: 1, dir: -1, rest: -10 });

// 오래 쉬었다 온 작은 움직임은 이전 나머지와 합치지 않음
assert.equal(wheelStep(-29, -5, 60_000).lines, 0, "몇 분 전 나머지에 더해 한 줄을 보내면 안 된다");
assert.equal(wheelStep(-29, -5, 16).lines, 1, "이어지는 스크롤은 나머지를 이어 쓴다");
assert.equal(wheelStep(-29, -5, 0).lines, 1, "같은 시각에 온 이벤트도 이어 쓴다");

// 방향이 바뀌면 남은 양을 버림
assert.equal(wheelStep(-29, 20, 16).lines, 0);

// 한 이벤트 최대 6줄
assert.equal(wheelStep(0, 600, 16).lines, 6);

// 터미널 입력 세기
assert.deepEqual(countTerminalInput("\x1b[<64;10;5M\x1b[<64;10;5M\x1b[<65;1;1M"), { wheelUp: 2, wheelDown: 1, focusIn: 0, focusOut: 0 });
assert.deepEqual(countTerminalInput("\x1b[I\x1b[O\x1b[O"), { wheelUp: 0, wheelDown: 0, focusIn: 1, focusOut: 2 });
assert.deepEqual(countTerminalInput("\x1b[<68;3;3M"), { wheelUp: 1, wheelDown: 0, focusIn: 0, focusOut: 0 }, "수식키가 붙은 휠도 휠이다");
assert.deepEqual(countTerminalInput("\x1b[<0;3;3M\x1b[<0;3;3m"), { wheelUp: 0, wheelDown: 0, focusIn: 0, focusOut: 0 }, "클릭은 세지 않는다");
assert.deepEqual(countTerminalInput("hello\r"), { wheelUp: 0, wheelDown: 0, focusIn: 0, focusOut: 0 });
assert.deepEqual(countTerminalInput("\x1b[A\x1b[B"), { wheelUp: 0, wheelDown: 0, focusIn: 0, focusOut: 0 }, "방향키는 포커스 보고가 아니다");

// 기록기: 1초 동안 모아 한 줄, 휠·포커스가 아닌 입력은 기록하지 않음
const lines = [];
const timers = [];
let labelCalls = 0;
const note = createTerminalInputTrace({ log: (l) => lines.push(l), now: () => Date.UTC(2026, 9, 21, 2, 5, 18), setTimer: (fn) => { timers.push(fn); return null; } });
const label = () => { labelCalls++; return "console pane=w3M:p36"; };
note(label, "abc");
assert.equal(labelCalls, 0, "키 입력마다 출처를 계산하지 않는다");
note(label, "\x1b[<64;1;1M");
note(label, "\x1b[<64;1;1M\x1b[<64;1;1M");
note(label, "\x1b[O");
assert.equal(timers.length, 1);
timers[0]();
assert.deepEqual(lines, ["[term-input] 2026-10-21T02:05:18.000Z console pane=w3M:p36 wheelUp=3 focusOut=1"]);
assert.equal(formatTerminalInputLine(0, "x", { wheelUp: 0, wheelDown: 1, focusIn: 0, focusOut: 0 }), "[term-input] 1970-01-01T00:00:00.000Z x wheelDown=1");

console.log("terminal wheel trace tests passed");
