// 실제 SIGTERM 경로에서 밀린 쓰기가 보존되는가.
//
// test/shutdown-flush.mjs는 flushNow()를 직접 부른다. 그것은 함수가 도는지만 보여 준다.
// 정작 중요한 것은 앱이 서버를 함께 종료할 때이고, 그 경로는 신호 처리기·자물쇠 해제·exit(0)이
// 한 줄로 이어져 순서가 하나만 어긋나도 데이터를 잃는다. 그래서 여기서는 진짜 서버를 띄우고,
// 진짜 WS로 북마크를 넣고, 200ms 지연 창 안에서 진짜 SIGTERM을 보낸다.
//
// 앞 단계에서 "아직 디스크에 없다"를 먼저 확인한다. 그것이 false면 이 검사는 아무것도
// 증명하지 않는다. 이미 저장된 것을 다시 확인하는 것일 뿐이다.
import test from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { freePort } from "./lib/net.mjs";

const require = createRequire(import.meta.url);
const WS = require("ws");
const WebSocket = WS.WebSocket || WS;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = await freePort();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const healthy = () => new Promise((r) => {
  const req = http.get({ host: "127.0.0.1", port: PORT, path: "/healthz", timeout: 500 }, (res) => {
    res.resume(); r(res.statusCode === 200);
  });
  req.on("error", () => r(false));
  req.on("timeout", () => { req.destroy(); r(false); });
});

test("지연 창 안에서 SIGTERM을 맞아도 마지막 변경이 살아남는다", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-sigterm-"));
  const env = { ...process.env, IRIS_PORT: String(PORT), IRIS_STATE_DIR: dir };
  delete env.PORT;
  delete env.REMOTE;   // 이 검사는 루프백만 쓴다. 0.0.0.0 바인딩은 불필요한 노출이다
  const child = spawn(process.execPath, [path.join(ROOT, "server", "index.js")],
    { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  t.after(() => { try { child.kill("SIGKILL"); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });

  for (let i = 0; i < 60 && !(await healthy()); i++) await sleep(200);
  assert.ok(await healthy(), "서버가 뜨지 않았다:\n" + log);

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  await new Promise((resolve, reject) => { ws.on("open", resolve); ws.on("error", reject); });
  ws.send(JSON.stringify({
    type: "browser-sync",
    mutation: { op: "bookmark.add", space: "w1", url: "https://sigterm.example", title: "지연 창 안의 북마크" },
  }));

  await sleep(60);  // 서버가 메시지를 처리할 만큼만. 200ms 지연 창은 아직 안 끝났다.
  const file = path.join(dir, "browser-state.json");
  const onDiskBefore = fs.existsSync(file) && fs.readFileSync(file, "utf8").includes("sigterm.example");
  assert.equal(onDiskBefore, false,
    "SIGTERM 전에 이미 디스크에 있으면 이 검사는 아무것도 증명하지 않는다 — 지연 창을 못 잡은 것");

  child.kill("SIGTERM");
  await new Promise((resolve) => child.on("exit", resolve));

  const after = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  assert.ok(after.includes("sigterm.example"),
    "지연 창 안의 북마크가 사라졌다 — 앱을 끌 때마다 마지막 탭 변경을 잃는다는 뜻");
  assert.match(log, /내려가기 전에 저장했습니다/, "무엇을 저장했는지 로그에 남아야 한다");
  assert.equal(fs.existsSync(path.join(dir, "server.lock")), false,
    "flush 뒤에도 자물쇠는 풀려야 한다 — 안 풀리면 다음 서버가 기다린다");
});
