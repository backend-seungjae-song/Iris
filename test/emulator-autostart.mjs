import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { sliceBetween } from "../bin/slice-anchor.mjs";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

// 창을 열거나 앱을 다시 켤 때 꺼진 기기를 켜지 않음(사용자 결정). 켜진 기기만 화면을 붙이고, 켜기는 [연결]·에이전트 요청
test("에뮬레이터 화면은 열 때 켜진 기기에만 붙는다", () => {
  const pane = read("web/js/emulator/pane.js");
  const init = sliceBetween(pane, "// 초기 진입:", "function teardownDom", "초기 진입");
  assert.match(init, /if \(row && row\.state === "Booted"\) \{ await attach\(target\); return; \}/);
  assert.equal((init.match(/attach\(/g) || []).length, 1);
});

test("에이전트가 연 탭은 connect() 로 기기를 켠다", () => {
  const boot = read("web/js/emulator/boot.js");
  const agent = sliceBetween(boot, "async function openForAgent", "async function onAsk", "에이전트 열기");
  assert.match(agent, /!entryDevice\(entry\)\.attached\) entry\.pane\.connect\(\);/);
});

// 에이전트가 연 기기는 분리 창으로(사용자 결정). 사람이 보고 있는 화면은 옮기지 않음
test("에이전트가 연 기기는 사람이 보고 있지 않으면 분리 창으로 띄운다", () => {
  const boot = read("web/js/emulator/boot.js");
  const agent = sliceBetween(boot, "async function openForAgent", "async function onAsk", "에이전트 열기");
  assert.match(agent, /const watching = entry\.inColumn \|\| entry\.inStage \|\| \(!entry\.el\.hidden && !panelEl\(\)\?\.hidden\);/);
  assert.match(agent, /if \(!entry\.detached && !watching\) await detach\(entry\);\s*return \{ ok: true/);
});

// 기기 선택 목록도 모바일 기기 목록처럼 켜진 기기를 보이고, 열 때 최신 상태를 받음(사용자 요청)
test("기기 선택 목록은 켜진 기기에 켜짐을 붙이고 열 때 목록을 다시 받는다", () => {
  const pane = read("web/js/emulator/pane.js");
  assert.match(pane, /sub: runtimeLabel\(d\.runtime\) \+ \(d\.state === "Booted" \? " · 켜짐" : ""\)/);
  assert.match(pane, /tbDeviceTrigger\.addEventListener\("pointerdown", \(\) => \{ if \(!state\.loading\) void refreshDevices\(/);
});
