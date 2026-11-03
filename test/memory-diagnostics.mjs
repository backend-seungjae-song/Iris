import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startMemoryDiagnostics } from "../server/memory-diagnostics.js";

const settle = async (done) => {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  await new Promise((resolve) => setTimeout(resolve, 50));
};

test("서버 RSS 가 상한을 넘으면 6시간에 한 번 프로파일을 저장하고 최근 8개만 남긴다", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-memory-diag-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const before = process.listeners("SIGUSR2");
  t.after(() => { for (const l of process.listeners("SIGUSR2")) if (!before.includes(l)) process.removeListener("SIGUSR2", l); });
  for (let i = 0; i < 10; i++) {
    const old = path.join(dir, `server-${i}-request.heapprofile`);
    fs.writeFileSync(old, "{}");
    fs.utimesSync(old, new Date(1000 + i), new Date(1000 + i));
  }
  let rss = 150;
  let clock = 0;
  const diag = startMemoryDiagnostics({ dir, log: () => {}, setIntervalFn: () => ({ unref() {} }),
    sampleFn: () => ({ rss }), nowMs: () => clock, setTimeoutFn: (fn) => setImmediate(fn) });
  assert.equal(fs.readdirSync(dir).filter((f) => f.includes("-auto")).length, 0);

  const autos = () => fs.readdirSync(dir).filter((f) => f.endsWith("-auto.heapprofile"));
  rss = 700;
  diag.sample();
  await settle(() => autos().length >= 1);
  assert.equal(autos().length, 1);
  assert.ok(fs.readdirSync(dir).some((f) => f.endsWith("-auto.cpuprofile")));
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith(".heapprofile")).length, 8);
  assert.ok(!fs.existsSync(path.join(dir, "server-0-request.heapprofile")), "가장 오래된 파일을 남긴다");

  clock += 3600000;
  diag.sample();
  await settle(() => autos().length >= 2);
  assert.equal(autos().length, 1, "6시간 안에 다시 프로파일한다");

  clock += 6 * 3600000;
  diag.sample();
  await settle(() => autos().length >= 2);
  assert.equal(autos().length, 2);
  assert.equal(fs.readFileSync(path.join(dir, "server-memory.jsonl"), "utf8").trim().split("\n").length, 4);
});
