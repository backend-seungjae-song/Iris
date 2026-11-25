import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const { createAppLifecycleLog, stallFrom } = createRequire(import.meta.url)("../native/electron/app-lifecycle-log.cjs");

function fakeApp() {
  const handlers = {};
  return { on: (name, fn) => { handlers[name] = fn; }, emit: (name, ...args) => handlers[name]?.(...args) };
}
const rows = (dir) => fs.readFileSync(path.join(dir, "app-lifecycle.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("정상 종료 없이 끝난 이전 실행을 다음 시작 때 남기고, 정상 종료하면 남기지 않는다", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-lifecycle-"));
  try {
    let clock = 1000;
    const make = (pid) => createAppLifecycleLog({ app: fakeApp(), dir, pid, version: "1", now: () => clock, setIntervalFn: () => ({ unref() {} }) });
    make(11).start();
    clock = 50000;
    make(22).start();
    let starts = rows(dir).filter((r) => r.event === "start");
    assert.equal(starts[1].previousUnclean.pid, 11);
    const third = make(22);
    third.quit("SIGTERM");
    make(33).start();
    starts = rows(dir).filter((r) => r.event === "start");
    assert.equal(starts[2].previousUnclean, undefined);
    assert.equal(rows(dir).find((r) => r.event === "quit").reason, "SIGTERM");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("앱 본체가 5초 넘게 멈췄다 돌아오면 멈춘 시간을 남긴다", () => {
  assert.equal(stallFrom(0, 1000), null);
  assert.equal(stallFrom(0, 5999), null);
  assert.equal(stallFrom(0, 300000), 299000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-lifecycle-"));
  try {
    let clock = 0;
    const log = createAppLifecycleLog({ app: fakeApp(), dir, pid: 1, now: () => clock, setIntervalFn: () => ({ unref() {} }) });
    log.start();
    clock = 1000; log.tick();
    clock = 301000; log.tick();
    const stalls = rows(dir).filter((r) => r.event === "main-stall");
    assert.deepEqual(stalls.map((r) => r.ms), [299000]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("렌더러·자식 프로세스가 끝나면 이유와 종료 코드를 남긴다", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-lifecycle-"));
  try {
    const app = fakeApp();
    createAppLifecycleLog({ app, dir, pid: 1, now: () => 0, setIntervalFn: () => ({ unref() {} }) }).start();
    app.emit("render-process-gone", {}, { id: 4, getURL: () => "http://127.0.0.1:4271/" }, { reason: "oom", exitCode: 9 });
    app.emit("child-process-gone", {}, { type: "GPU", reason: "crashed", exitCode: 5 });
    const gone = rows(dir).filter((r) => r.event.endsWith("gone"));
    assert.deepEqual(gone.map((r) => [r.event, r.reason, r.exitCode]), [["renderer-gone", "oom", 9], ["child-process-gone", "crashed", 5]]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
