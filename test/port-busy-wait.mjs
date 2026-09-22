// 포트가 이미 차 있으면 서버는 종료되지 않고 기다렸다가 비면 붙는다.
// ws가 다시 던진 EADDRINUSE 가 unhandled 'error' 로 프로세스를 종료시키면, 다시 띄우는
// 쪽이 있을 때 같은 크래시가 반복된다.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import assert from "node:assert";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE = mkdtempSync(path.join(tmpdir(), "ac-port-"));
let kid = null, squatter = null;
const stop = () => {
  try { kid && kid.kill("SIGKILL"); } catch {}
  try { squatter && squatter.close(); } catch {}
  try { rmSync(STATE, { recursive: true, force: true }); } catch {}
};
process.on("exit", stop);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log(`  · ${s}`);
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

// 다른 프로세스가 먼저 그 포트를 점유한 상태를 만든다.
const port = await new Promise((res) => {
  squatter = net.createServer();
  squatter.listen(0, "127.0.0.1", () => res(squatter.address().port));
});
step(`남의 프로그램이 127.0.0.1:${port}을 먼저 쥐었다`);

kid = spawn(process.execPath, ["server/index.js"], {
  cwd: ROOT,
  env: { ...process.env, IRIS_STATE_DIR: STATE, IRIS_PORT: String(port), PORT: "", REMOTE: "", IRIS_LOCK_WAIT_MS: "1000" },
  stdio: ["ignore", "pipe", "pipe"],
});
kid.out = "";
kid.stdout.on("data", (d) => { kid.out += d; });
kid.stderr.on("data", (d) => { kid.out += d; });
kid.alive = true;
kid.on("exit", () => { kid.alive = false; });

await sleep(6000);
assert.ok(kid.alive, "포트가 차 있다고 서버가 죽었다 — 예전의 unhandled EADDRINUSE 크래시");
const notices = kid.out.split("\n").filter((l) => l.includes("이미 다른 프로그램이 쓰고 있습니다")).length;
assert.equal(notices, 1, `기다리는 동안 같은 말을 ${notices}번 적었다 — 한 번이어야 한다`);
step("죽지 않고 한 번만 알리며 기다린다");

squatter.close(); squatter = null;
step("남의 프로그램이 자리를 비웠다");
await until(() => listening(port), 60000, "자리가 비었는데 서버가 붙지 못했다");
assert.ok(/Iris → http/.test(kid.out), "붙은 사실을 남기지 않았다");

console.log("ok  포트 대기 — 크래시 없이 한 번 알리고, 자리가 비면 스스로 붙는다");
stop();
process.exit(0);
