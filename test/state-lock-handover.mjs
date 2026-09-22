// 상태 폴더를 점유한 서버가 있으면, 뒤에 뜬 서버는 종료되지 않고 기다렸다가 이어받는다.
// 그 자리에서 exit(1) 로 끝내면 다시 띄우는 쪽이 있을 때 거절이 반복되고, 관리되는 서버는
// 한 번도 뜨지 못한다.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import assert from "node:assert";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE = mkdtempSync(path.join(tmpdir(), "ac-lock-"));
const kids = [];
const stop = () => { for (const k of kids) { try { k.kill("SIGKILL"); } catch {} } try { rmSync(STATE, { recursive: true, force: true }); } catch {} };
process.on("exit", stop);

const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start(port) {
  const kid = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    env: { ...process.env, IRIS_STATE_DIR: STATE, IRIS_PORT: String(port), PORT: "", REMOTE: "", IRIS_LOCK_WAIT_MS: "1000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  kid.out = "";
  kid.stdout.on("data", (d) => { kid.out += d; });
  kid.stderr.on("data", (d) => { kid.out += d; });
  kid.alive = true;
  kid.on("exit", () => { kid.alive = false; });
  kids.push(kid);
  return kid;
}
const listening = (port) => new Promise((res) => {
  const s = net.connect(port, "127.0.0.1");
  s.on("connect", () => { s.destroy(); res(true); });
  s.on("error", () => res(false));
});
async function until(fn, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(300); }
  assert.fail(label);
}

const step = (s) => console.log(`  · ${s}`);
const portA = await freePort(), portB = await freePort();
step(`포트 A=${portA} B=${portB}, 상태 폴더 ${STATE}`);
const a = start(portA);
await until(() => listening(portA), 60000, "첫 서버가 뜨지 않았다");
step("첫 서버가 자리를 잡고 포트를 열었다");

const b = start(portB);
await sleep(4000);
step(`뒤 서버 상태: 살아있음=${b.alive}, 남긴 말=${JSON.stringify(b.out.trim().slice(0, 120))}`);
assert.ok(b.alive, "자리가 차 있을 때 뒤 서버가 죽었다 — 예전의 exit(1) 동작");
assert.ok(/이 상태 폴더를 쓰고 있습니다/.test(b.out), "기다리는 이유를 남기지 않았다");
assert.ok(!(await listening(portB)), "자리를 못 얻었는데 포트를 열었다");
const linesWhileWaiting = b.out.split("\n").filter((l) => l.includes("상태 폴더를 쓰고 있습니다")).length;
assert.equal(linesWhileWaiting, 1, `기다리는 동안 같은 말을 ${linesWhileWaiting}번 적었다 — 한 번이어야 한다`);

step("앞 서버에 SIGTERM — 인계를 기다린다");
a.kill("SIGTERM");
await until(() => listening(portB), 60000, "앞 서버가 내려갔는데 뒤 서버가 이어받지 못했다");
assert.ok(/자리를 이어받았습니다/.test(b.out), "이어받은 사실을 남기지 않았다");

console.log("ok  상태 폴더 자리 인계 — 기다림 1회 기록, 앞 서버 종료 시 자동 인계");
// 띄운 서버의 파이프가 이벤트 루프를 붙잡아, 단언을 다 통과하고도 프로세스가 끝나지 않는다.
// 그러면 검사가 멈춘 것처럼 보여 실패와 구별되지 않는다. 정리하고 명시적으로 끝낸다.
stop();
process.exit(0);
