// 기기 메모리·배터리 감시의 판정: 2026-10-19 13:50 실측값(18GB, 스왑 13GB, next dev 3.9GB)이 심각으로 나오는가
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const g = require("../native/electron/resource-guard.cjs");

const TOP = `Processes: 989 total
PID    MEM    POWER
61318  3944M  0.0
14993  1583M+ 0.0
PID    MEM    POWER
61318  3944M  12.5
14993  1583M+ 3.1
42534  435M   24.3
1      12K    0.0
`;

test("top 두 표본 중 마지막 표만 읽고 단위를 MB로 바꾼다", () => {
  assert.deepEqual(g.parseTop(TOP), [
    { pid: 61318, mb: 3944, power: 12.5 }, { pid: 14993, mb: 1583, power: 3.1 }, { pid: 42534, mb: 435, power: 24.3 }, { pid: 1, mb: 0, power: 0 }]);
});

test("스왑·배터리 출력을 읽는다", () => {
  assert.deepEqual(g.parseSwap("total = 14336.00M  used = 13104.81M  free = 1231.19M  (encrypted)"), { totalMB: 14336, usedMB: 13105 });
  assert.deepEqual(g.parseBattery("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t4%; discharging; 0:10 remaining present: true"), { pct: 4, onBattery: true });
  assert.deepEqual(g.parseBattery("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t9%; charging;"), { pct: 9, onBattery: false });
  assert.equal(g.parseBattery(""), null);
});

test("개발 서버와 묶음 이름을 가린다", () => {
  assert.ok(g.isDevServer("next-server (v16.2.1) "));
  assert.ok(g.isDevServer("node /x/node_modules/.bin/../next/dist/bin/next dev -p 3002"));
  assert.ok(g.isDevServer("node /x/node_modules/vite/bin/vite.js --port 5173"));
  assert.ok(!g.isDevServer("/Applications/Iris.app/Contents/MacOS/Iris --disable-sigusr1 server/index.js"));
  assert.ok(!g.isDevServer("node /Users/you/Projects/Personal/iris/bin/iris-qa.mjs"));
  assert.equal(g.groupOf("/Applications/Iris.app/Contents/Frameworks/Iris Helper (Renderer).app/x"), "Iris");
  assert.equal(g.groupOf("/usr/local/bin/foo --bar"), "foo");
});

test("배터리로 도는 마지막 구간의 시간당 감소율", () => {
  const t0 = 0, m = 60000;
  const h = [{ t: t0, battery: { pct: 50, onBattery: false } }, { t: t0 + m, battery: { pct: 50, onBattery: true } }, { t: t0 + 31 * m, battery: { pct: 40, onBattery: true } }];
  assert.equal(g.drainPerHour(h, t0 + 31 * m), 20);
  assert.equal(g.drainPerHour(h.slice(0, 2), t0 + m), null, "10분 미만은 계산하지 않음");
});

const base = { memMB: 18432, swap: { totalMB: 14336, usedMB: 1000 }, pressure: 1, battery: { pct: 80, onBattery: false }, drain: null, processes: [{ pid: 1, mb: 8000, dev: false }] };

test("평소에는 normal 이고 탭을 재우지 않는다", () => {
  const r = g.decideResourceAction(base);
  assert.equal(r.level, "normal"); assert.equal(r.discardTabs, false); assert.deepEqual(r.reasons, []);
});

test("13:50 실측값은 심각이고 상한 넘은 개발 서버를 이름으로 알린다", () => {
  const r = g.decideResourceAction({ ...base, swap: { totalMB: 14336, usedMB: 13105 }, pressure: 2,
    processes: [{ pid: 61318, mb: 3944, dev: true }, { pid: 2, mb: 30000, dev: false }] });
  assert.equal(r.level, "critical"); assert.equal(r.discardTabs, true);
  assert.ok(r.reasons.includes("스왑 13105MB/14336MB"));
  assert.ok(r.reasons.some((x) => /상한 넘은 개발 서버 61318 3\.9GB/.test(x)));
  assert.deepEqual(r.overCap.map((p) => p.pid), [61318]);
});

test("배터리로 돌 때 8% 이하면 심각, 20% 이하·시간당 25% 이상 감소면 경고", () => {
  assert.equal(g.decideResourceAction({ ...base, battery: { pct: 4, onBattery: true } }).level, "critical");
  assert.equal(g.decideResourceAction({ ...base, battery: { pct: 4, onBattery: false } }).level, "normal", "충전 중이면 배터리로 판정하지 않음");
  assert.equal(g.decideResourceAction({ ...base, battery: { pct: 18, onBattery: true } }).level, "warn");
  assert.equal(g.decideResourceAction({ ...base, battery: { pct: 70, onBattery: true }, drain: 37 }).level, "warn");
});

test("경고가 먼저 나와도 뒤의 심각 이유가 단계를 올린다", () => {
  const r = g.decideResourceAction({ ...base, pressure: 2, swap: { totalMB: 100, usedMB: 90 } });
  assert.equal(r.level, "critical");
});

test("감시는 기록하고, 심각하면 탭 재우기와 알림을 15분에 한 번 보낸다", async () => {
  const files = new Map(), notes = [], discards = [];
  const fs = { mkdirSync() {}, statSync() { return { size: 0 }; }, renameSync() {}, appendFileSync(f, s) { files.set(f, (files.get(f) || "") + s); } };
  const outputs = { "/usr/bin/top": TOP, "/bin/ps": "61318 next-server (v16.2.1)\n14993 /Applications/Iris.app/Contents/MacOS/Iris\n",
    "/usr/sbin/sysctl": "total = 14336.00M  used = 13104.81M  free = 1231.19M", "/usr/bin/pmset": "Now drawing from 'AC Power'\n x\t50%; charging;" };
  let t = 1_000_000;
  const guard = g.createResourceGuard({ dir: "/d", fs, platform: "darwin", memMB: 18432, now: () => t,
    exec: (cmd, args, cb) => cb(cmd === "/usr/sbin/sysctl" && args[1] === "kern.memorystatus_vm_pressure_level" ? "2" : outputs[cmd]),
    notify: (n) => notes.push(n), discardTabs: () => discards.push(t) });
  const r = await guard.sample();
  assert.equal(r.level, "critical");
  t += 60000; await guard.sample();
  assert.equal(discards.length, 2, "심각한 동안 매번 재움");
  assert.equal(notes.length, 1, "알림은 15분에 한 번");
  const rows = files.get("/d/resource.jsonl").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.length, 2); assert.equal(rows[0].level, "critical"); assert.ok(rows[0].byMemory[0].startsWith("next dev"));
});
