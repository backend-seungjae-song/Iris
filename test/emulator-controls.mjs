import test from "node:test";
import assert from "node:assert/strict";
import { sliceBetween } from "../bin/slice-anchor.mjs";
import { returnPlace, phoneControls, pickSurface, pickTargetAt, PICK_PASS, createKeyboardQueue } from "../web/js/emulator/controls.js";

test("분리 전 자리와 배치 엔진 상태에 따라 복귀한다", () => {
  assert.equal(returnPlace("column", true), "column");
  assert.equal(returnPlace("column", false), "tab");
  assert.equal(returnPlace("strip", true), "tab");
  assert.equal(returnPlace("stage", true), "stage");
});

test("플랫폼별로 지원하는 폰 조작만 보인다", () => {
  assert.deepEqual(phoneControls("Android"), ["back", "home", "recents", "rotate", "volume_down", "volume_up", "lock", "lang"]);
  assert.deepEqual(phoneControls("iOS"), ["home", "rotate", "lang"]);
  assert.deepEqual(phoneControls(null), []);
});

test("에뮬레이터 화면 안은 호스트 기기 지정 대상이 아니다", () => {
  for (const place of ["tab", "column", "stage", "window"]) {
    assert.equal(pickSurface(place, false), true);
    assert.equal(pickSurface(place, true), false);
  }
  assert.equal(pickSurface("browser", false), false);
});

test("탭·세로 열·무대의 기기와 선택 표시 요소를 판정한다", () => {
  const tabEl = { dataset: { tab: "emu-1" } };
  const tabHit = { closest: (selector) => selector === ".ctab" ? tabEl : null };
  const columnHit = { closest: () => null };
  const stageHit = { closest: () => null };
  const screenHit = { closest: (selector) => selector.includes(".emu-screen-surface") ? {} : null };
  // 실제 DOM 과 같은 판정: 툴바 안 button 이면 PICK_PASS 에 걸림
  const toolbarButton = { closest: (selector) => selector === PICK_PASS ? {} : selector === ".ctab" ? tabEl : null };
  const column = { contains: (el) => el === columnHit };
  const stage = { contains: (el) => el === stageHit };
  const entry = { tab: { id: "emu-1" }, el: { contains: () => false }, detached: false, inColumn: false, inStage: false };
  assert.deepEqual(pickTargetAt(tabHit, [entry], column, stage), { entry, el: tabEl, where: "tab" });
  entry.inColumn = true;
  assert.deepEqual(pickTargetAt(columnHit, [entry], column, stage), { entry, el: column, where: "column" });
  entry.inColumn = false; entry.inStage = true;
  assert.deepEqual(pickTargetAt(stageHit, [entry], column, stage), { entry, el: stage, where: "stage" });
  assert.equal(pickTargetAt(screenHit, [entry], column, stage), null);
  assert.equal(pickTargetAt(toolbarButton, [entry], column, stage), null, "툴바 단추(요소 선택 끄기)는 지정으로 가로채지 않음");
  entry.detached = true;
  assert.equal(pickTargetAt(tabHit, [entry], column, stage), null);
});

test("에뮬레이터 툴바 아이콘은 서로 다른 모양이다", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../web/js/emulator/pane.js", import.meta.url), "utf8");
  const block = sliceBetween(src, "const TB_ICON = {", "\n};", "툴바 아이콘 표");
  const icons = [...block.matchAll(/\n\s+(\w+): TB_SVG\('([^']*)'\)/g)].map(([, name, svg]) => [name, svg]);
  assert.ok(icons.length >= 10, `아이콘 표를 읽음(${icons.length}개)`);
  const seen = new Map();
  for (const [name, svg] of icons) {
    assert.ok(!seen.has(svg), `${name} 아이콘이 ${seen.get(svg)} 와 같음`);
    seen.set(svg, name);
  }
});

test("한/영 전환 대기열은 누른 순서대로 키와 전환을 보내고 전환 뒤 기다린다", async () => {
  const log = [];
  let release1, release2;
  let t = 0;
  const q = createKeyboardQueue({ sendFrame: (f) => log.push(f.usage), delay: async (ms) => { log.push("wait" + ms); t += ms; }, now: () => t, settleMs: 1100 });
  assert.equal(q.enqueueFrames([{ usage: 1 }]), false); // 전환 전에는 바로 보냄
  q.enqueueSwitch(new Promise((r) => { release1 = r; }));
  assert.equal(q.enqueueFrames([{ usage: 10 }]), true);
  q.enqueueSwitch(new Promise((r) => { release2 = r; }));
  assert.equal(q.enqueueFrames([{ usage: 20 }]), true);
  release2({ frames: [{ usage: 224 }] }); // 두 번째 응답이 먼저 와도 순서 유지
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(log, []);
  release1({ frames: [{ usage: 224 }] });
  await q.idle();
  // 두 번째 전환은 첫 전환 시각(0)에서 2500ms 뒤: 0+40+1100+4+120=1264 → 1236 더 기다림
  assert.deepEqual(log, [224, "wait40", "wait1100", 10, "wait4", "wait120", "wait1236", 224, "wait40", "wait1100", 20, "wait4", "wait120"]);
  assert.equal(q.enqueueFrames([{ usage: 30 }]), false);
});

test("전환이 실패하면 기다리지 않고 남은 키를 보내고, 비우면 남은 키를 버린다", async () => {
  const log = [];
  let t = 0;
  const q = createKeyboardQueue({ sendFrame: (f) => log.push(f.usage), delay: async (ms) => { log.push("wait" + ms); t += ms; }, now: () => t, settleMs: 1100 });
  q.enqueueSwitch(Promise.resolve(null));
  q.enqueueFrames([{ usage: 10 }]);
  await q.idle();
  assert.deepEqual(log, [10, "wait4", "wait120"]);
  let release;
  q.enqueueSwitch(new Promise((r) => { release = r; }));
  q.enqueueFrames([{ usage: 20 }]);
  q.clear();
  release({ frames: [{ usage: 224 }] });
  await q.idle();
  assert.deepEqual(log, [10, "wait4", "wait120"]);
  assert.equal(q.enqueueFrames([{ usage: 30 }]), false);
});

test("비운 뒤 새로 누른 전환과 키는 이어서 보낸다", async () => {
  const log = [];
  let t = 0;
  const q = createKeyboardQueue({ sendFrame: (f) => log.push(f.usage), delay: async (ms) => { log.push("wait" + ms); t += ms; }, now: () => t, settleMs: 1100 });
  let release;
  q.enqueueSwitch(new Promise((r) => { release = r; }));
  q.clear();
  q.enqueueSwitch(Promise.resolve({ frames: [{ usage: 224 }] }));
  q.enqueueFrames([{ usage: 10 }]);
  release({ frames: [{ usage: 99 }] });
  await q.idle();
  assert.deepEqual(log, [224, "wait40", "wait1100", 10, "wait4", "wait120"]);
});
