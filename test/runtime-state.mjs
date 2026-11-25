import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  getGitStatusCache,
  initRuntimeState,
  noteOpened,
  requestRecompute,
  saveAllowed,
  setGitStatusCache,
} from "../server/runtime-state.js";

test("requestRecompute는 scheduleRecompute 거부를 fire-and-forget 호출에 남기지 않고 다음 요청을 받는다", async () => {
  const errors = [];
  const previousError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    initRuntimeState({ scheduleRecompute: async () => { throw new Error("recompute failed"); } });
    await assert.doesNotReject(requestRecompute());

    let runs = 0;
    initRuntimeState({ scheduleRecompute: async () => { runs++; } });
    await requestRecompute();
    assert.equal(runs, 1);
    assert.equal(errors.length, 1);
  } finally {
    console.error = previousError;
  }
});

test("requestRecompute는 계산 중 들어온 dirty 요청을 반복문으로 처리한다", async () => {
  let runs = 0;
  initRuntimeState({ scheduleRecompute: async () => {
    runs++;
    if (runs === 1) void requestRecompute();
  } });
  await requestRecompute();
  assert.equal(runs, 2);

  const source = fs.readFileSync(new URL("../server/runtime-state.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /await requestRecompute\(\)/);
});

test("계산 실패 중 새 dirty 요청이 올라오면 한 번 재시도하고 실패 반복은 멈춘다", async () => {
  let runs = 0;
  const errors = [];
  const previousError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    initRuntimeState({ scheduleRecompute: async () => {
      runs++;
      if (runs === 1) {
        void requestRecompute();
        throw new Error("first failure");
      }
      throw new Error("retry failure");
    } });
    await requestRecompute();
    assert.equal(runs, 2);
    assert.equal(errors.length, 2);
  } finally {
    console.error = previousError;
  }
});

test("runtime-state는 오래된 Git 캐시와 열어 둔 파일 권한을 prune한다", () => {
  const previousNow = Date.now;
  const opened = "/tmp/iris-runtime-state-opened.txt";
  try {
    Date.now = () => 1_000_000;
    setGitStatusCache("runtime-state-expired", { at: Date.now(), map: {} });
    noteOpened(opened);
    assert.deepEqual(getGitStatusCache("runtime-state-expired"), { at: 1_000_000, map: {} });
    assert.equal(saveAllowed(opened), true);

    Date.now = () => 1_000_000 + 31 * 60 * 1000;
    assert.equal(getGitStatusCache("runtime-state-expired"), undefined);
    assert.equal(saveAllowed(opened), false);
  } finally {
    Date.now = previousNow;
  }
});
