// 남긴 pid를 다음 실행에서 종료할 때, 그 번호의 소유자가 바뀌지 않았는지 먼저 본다.
//
// pid는 재사용된다. `run-pids.json`에 적힌 번호를 그대로 믿고 프로세스 그룹을 SIGKILL하면,
// 그 사이 번호를 물려받은 다른 프로그램이 종료된다. 종료하는 쪽은 그 pid 가 자기가 적어 둔
// 프로세스인지 먼저 확인해야 한다.
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { sliceBetween, sliceFrom } from "../bin/slice-anchor.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function reapWith(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-reap-"));
  fs.writeFileSync(path.join(dir, "run-pids.json"), JSON.stringify(entries));
  process.env.IRIS_STATE_DIR = dir;
  const mod = await import(`../server/run.js?reap=${dir}`);
  new mod.RunManager(() => {});   // 생성자가 reapOrphans를 부른다
  return dir;
}

test("번호만 같고 시작 시각이 다른 프로세스는 죽이지 않는다", async (t) => {
  // 오래 자는 프로세스를 하나 띄우고, 그 번호를 오래 전에 띄운 것으로 기록한다.
  // 시작 시각을 확인하지 않으면 이 프로세스가 종료된다.
  const victim = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
  victim.unref();
  t.after(() => { try { process.kill(victim.pid, "SIGKILL"); } catch {} });
  await sleep(300);

  const dir = await reapWith([{ pid: victim.pid, startedAt: Date.now() - 3 * 60 * 60 * 1000 }]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await sleep(300);

  let alive = true;
  try { process.kill(victim.pid, 0); } catch { alive = false; }
  assert.ok(alive, "우리가 띄운 적 없는 프로세스를 죽였다 — pid 재사용에서 남의 것을 죽인다는 뜻");
});

test("시작 시각을 확인할 수 없으면 손대지 않는다", async (t) => {
  const victim = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
  victim.unref();
  t.after(() => { try { process.kill(victim.pid, "SIGKILL"); } catch {} });
  await sleep(300);

  // startedAt이 없는 이전 형식의 기록. 확인할 수 없으면 종료하지 않는다.
  const dir = await reapWith([{ pid: victim.pid }]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await sleep(300);

  let alive = true;
  try { process.kill(victim.pid, 0); } catch { alive = false; }
  assert.ok(alive, "언제 띄웠는지 모르는 기록으로 프로세스를 죽였다");
});

test("서버는 내려가기 전에 실행 목록을 지금 상태로 남긴다", () => {
  const src = fs.readFileSync(new URL("../server/index.js", import.meta.url), "utf8");
  const fn = sliceBetween(src, "function flushPendingState()", "for (const sig of", "종료 시 상태 비우기");
  const table = fs.readFileSync(new URL("../server/capabilities.js", import.meta.url), "utf8");
  assert.ok(/for \(const persist of exitCapabilities\).*persist\(\)/.test(fn)
    && /onExit: \(callback\) => exitCapabilities.push\(callback\)/.test(src)
    && /ctx.onExit\(\(\) => ctx.runManager.persistPids\(\)\)/.test(table),
    "종료 시 실행 목록을 갱신하지 않으면 방금 내린 dev 서버 번호가 파일에 남는다");
});
