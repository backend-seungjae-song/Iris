import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(predicate, { timeout = 15_000, interval = 50 } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error("timeout waiting for condition");
}

// 앱이 띄운 서버: UI 증명 값을 파이프로만 받아 상태 폴더에 파일을 남기지 않는다
test("파이프로 받은 UI 증명 값으로만 인증하고 파일을 남기지 않는다", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-ui-token-"));
  fs.writeFileSync(path.join(stateDir, "ui-token"), "f".repeat(64), { mode: 0o600 });
  const token = "a".repeat(64);
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, "server/index.js")], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), IRIS_PORT: String(port), IRIS_STATE_DIR: stateDir, IRIS_UI_TOKEN_FD: "3" },
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  child.stdio[3].end(token);
  t.after(async () => {
    if (child.exitCode == null) child.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 1_000))]);
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  await waitFor(() => new Promise((resolve) => {
    const probe = net.connect(port, "127.0.0.1");
    probe.once("connect", () => { probe.destroy(); resolve(true); });
    probe.once("error", () => { probe.destroy(); resolve(false); });
  }));
  assert.equal(fs.existsSync(path.join(stateDir, "ui-token")), false, "이전 파일도 지움");
  const auth = async (value) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    const reply = new Promise((resolve) => ws.on("message", (raw) => { const m = JSON.parse(raw.toString()); if (m.type === "ui-auth") resolve(m.ok); }));
    ws.send(JSON.stringify({ type: "ui-auth", token: value, focused: false }));
    const ok = await reply; ws.close(); return ok;
  };
  assert.equal(await auth("f".repeat(64)), false, "예전 파일 값으로는 인증 안 됨");
  assert.equal(await auth(token), true);
});
