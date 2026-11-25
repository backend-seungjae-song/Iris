import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseHostPs, watchHost, HELPER_CAP_MB } from "../server/host-watch.js";
import { startMemoryDiagnostics } from "../server/memory-diagnostics.js";

const PS = [
  "  101  150000   3.0 S    /Applications/Iris.app/Contents/MacOS/Iris",
  "  202 3600000   0.0 R    /tmp/iris-fixture-home/Library/Application Support/Iris/serve-sim-runtime/0.1.0/bin/serve-sim-bin 76EDA0E3 --port 3100",
  "  303   20000   0.0 S    /tmp/iris-fixture-home/Library/Application Support/Iris/serve-sim-runtime/0.1.0/bin/serve-sim-bin AAAA --port 3101",
  "  404   90000   1.0 S    node server/index.js",
].join("\n");
const SWAP = "total = 11264.00M  used = 10630.00M  free = 634.00M  (encrypted)";

test("앱 본체와 iOS 화면 도우미의 메모리·상태를 읽는다", () => {
  const { main, helpers } = parseHostPs(PS, 101);
  assert.deepEqual(main, { pid: 101, rssMB: 146, cpu: 3, state: "S" });
  assert.deepEqual(helpers.map((h) => [h.pid, h.rssMB, h.device]), [[202, 3516, "76EDA0E3"], [303, 20, "AAAA"]]);
});

test("상한을 넘은 도우미만 종료하고 그 결과를 남긴다", () => {
  const killed = [];
  const exec = (cmd) => (cmd.endsWith("ps") ? PS : SWAP);
  const out = watchHost({ mainPid: 101, exec, kill: (pid, sig) => killed.push([pid, sig]) });
  assert.deepEqual(killed, [[202, "SIGTERM"]]);
  assert.equal(out.killedHelpers[0].result, "terminated");
  assert.ok(out.killedHelpers[0].rssMB > HELPER_CAP_MB);
  assert.deepEqual(out.swap, { totalMB: 11264, usedMB: 10630 });
});

test("ps 가 실패해도 기록은 남고 아무것도 종료하지 않는다", () => {
  const killed = [];
  const out = watchHost({ mainPid: 101, exec: () => { throw new Error("timeout"); }, kill: (pid) => killed.push(pid) });
  assert.match(out.error, /^ps: timeout/);
  assert.deepEqual(killed, []);
});

test("서버 1분 기록에 호스트 상태가 들어가고 도우미 종료를 로그로 알린다", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-host-watch-"));
  try {
    const logs = [];
    startMemoryDiagnostics({ dir, log: (m) => logs.push(m), setIntervalFn: () => ({ unref() {} }), sampleFn: () => ({ rss: 100 }),
      hostFn: () => ({ main: { pid: 1 }, killedHelpers: [{ name: "serve-sim", pid: 202, rssMB: 3516, result: "terminated" }] }) });
    const row = JSON.parse(fs.readFileSync(path.join(dir, "server-memory.jsonl"), "utf8").trim());
    assert.equal(row.host.main.pid, 1);
    assert.equal(row.host.killedHelpers[0].pid, 202);
    assert.ok(logs.some((m) => m.includes("serve-sim 202 3516MB")));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
