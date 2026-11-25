import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createStorageLifecycle, STORAGE_FLUSH_TIMEOUT_MS } from "../native/electron/storage-lifecycle.cjs";

test("종료 flush 상한과 SIGTERM 강제 종료 여유 시간이 같은 계약을 쓴다", () => {
  const main = readFileSync(new URL("../native/electron/main.cjs", import.meta.url), "utf8");
  assert.equal(STORAGE_FLUSH_TIMEOUT_MS, 2500);
  assert.match(main, /STORAGE_FLUSH_TIMEOUT_MS \+ 500/);
});

test("main의 partition flush는 storage lifecycle이 실패를 관찰하도록 예외를 전파한다", () => {
  const main = readFileSync(new URL("../native/electron/main.cjs", import.meta.url), "utf8");
  const start = main.indexOf("flushPartition: async (partition) => {");
  const end = main.indexOf("\n  isReady:", start);
  assert.ok(start >= 0 && end > start);
  const flush = main.slice(start, end);
  assert.match(flush, /await sess\.flushStorageData\(\);\s*await sess\.cookies\.flushStore\(\);/s);
  assert.doesNotMatch(flush, /catch/);
});

test("flush가 멈춰도 종료 상한 뒤 한 번만 종료를 허용한다", async () => {
  let quitCount = 0;
  let waitMs = 0;
  const lifecycle = createStorageLifecycle({
    forEachHardened: async (visit) => visit("persist:profile"),
    flushPartition: () => new Promise(() => {}),
    isReady: () => true,
    quit: () => { quitCount += 1; },
    wait: (ms) => { waitMs = ms; return Promise.resolve(); },
    log: () => {},
  });
  const first = { preventDefault() { this.prevented = true; } };
  const second = { preventDefault() { this.prevented = true; } };
  lifecycle.handleBeforeQuit(first);
  lifecycle.handleBeforeQuit(second);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(first.prevented, true);
  assert.equal(second.prevented, true);
  assert.equal(waitMs, STORAGE_FLUSH_TIMEOUT_MS);
  assert.equal(quitCount, 1);
});
