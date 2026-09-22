// 자리를 이어받은 서버는 그 사이에 일어난 일을 덮어쓰지 않는다.
//
// 기다리는 서버가 상태를 먼저 읽고 자물쇠를 나중에 잡으면, 기다리는 동안 앞 서버에서 사용자가
// 한 일이 전부 사라진다. 이어받은 쪽은 T0 에 읽은 스냅샷을 들고 있다가 다음 변경에서
// 그 전체를 저장하기 때문이다. 파일과 로그에는 아무 이상이 남지 않는다.
// 그래서 자격을 먼저 얻고 그 다음에 읽는다. 이 검사는 그 순서가 지켜지는지를 결과로 본다.
//
// 기다림은 전부 "그 일이 실제로 일어났다"는 신호를 보고 끝낸다. 초를 세어 기다리면
// 스위트를 겹쳐 돌릴 때(다른 검사가 CPU를 점유할 때) 아직 뜨지 못한 서버를 "안 떴다"로
// 읽어 실패한다. 흔들리는 검사는 실패해도 신뢰를 잃으므로, 결함이 아니라 느림 때문에
// 결과가 갈리는 자리를 전부 신호 대기로 바꿨다.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 자물쇠를 못 잡은 서버가 내는 출력. 이 줄이 보이면 그 서버는 "기다림"에 들어간 것이다.
const WAITING = "이미 다른 Iris 서버가 이 상태 폴더를 쓰고 있습니다";

// 조건이 참이 될 때까지 기다린다. 참이 되면 곧바로 돌아오므로 빠른 기계에서는 빨리 끝나고,
// 느린 기계에서는 넉넉히 기다린다. 둘 다 같은 결론에 도달한다.
async function until(fn, { ms = 30000, step = 100, what = "조건" } = {}) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= deadline) return null;
    await sleep(step);
  }
}

function startServer(dir, port) {
  const env = { ...process.env, IRIS_PORT: String(port), IRIS_STATE_DIR: dir, IRIS_LOCK_WAIT_MS: "1000" };
  delete env.PORT;
  delete env.REMOTE;
  const child = spawn(process.execPath, [path.join(ROOT, "server", "index.js")],
    { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  child._log = "";
  child.stdout.on("data", (d) => { child._log += d; });
  child.stderr.on("data", (d) => { child._log += d; });
  return child;
}

const healthy = (port) => new Promise((r) => {
  const req = http.get({ host: "127.0.0.1", port, path: "/healthz", timeout: 500 }, (res) => {
    let b = ""; res.setEncoding("utf8");
    res.on("data", (c) => { b += c; });
    res.on("end", () => { try { r(res.statusCode === 200 ? JSON.parse(b) : null); } catch { r(null); } });
  });
  req.on("error", () => r(null));
  req.on("timeout", () => { req.destroy(); r(null); });
});

async function waitHealthy(port, ms = 30000) {
  return await until(() => healthy(port), { ms, step: 200 });
}

async function healthyPorts(ports) {
  const up = [];
  for (const p of ports) if (await healthy(p)) up.push(p);
  return up;
}

// 북마크가 디스크에 기록된 것을 보고 돌아온다. 저장은 200ms 지연 창을 거치는데, 그 창이
// 언제 닫히는지는 부하가 정한다. 초를 세는 대신 파일에 나타나는 것을 본다.
async function addBookmark(port, dir, url, title) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve, reject) => { ws.on("open", resolve); ws.on("error", reject); });
  ws.send(JSON.stringify({ type: "browser-sync", mutation: { op: "bookmark.add", space: "w1", url, title } }));
  const file = path.join(dir, "browser-state.json");
  const landed = await until(() => {
    try { return fs.readFileSync(file, "utf8").includes(url); } catch { return false; }
  }, { ms: 15000 });
  ws.close();
  return landed;
}

test("죽은 자물쇠를 여럿이 동시에 만나도 주인은 하나다", async (t) => {
  // 만료된 자물쇠를 덮어쓰고 자기 pid 를 읽어 확인하는 방식은 셋이 차례로 덮고 읽으면
  // 셋 다 성공하고, 그 셋이 같은 상태 파일을 서로 덮어쓴다.
  // 그래서 자물쇠를 얻는 경로는 link 하나뿐이고, 만료된 것은 지우고 다시 link 한다.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-deadlock-"));
  fs.writeFileSync(path.join(dir, "server.lock"), "999999");  // 살아 있지 않은 pid
  const ports = [await freePort(), await freePort(), await freePort()];
  const kids = ports.map((p) => startServer(dir, p));
  t.after(() => {
    for (const c of kids) { try { c.kill("SIGKILL"); } catch {} }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // 셋이 다 결론을 낸 시점은 하나가 뜨고 나머지 둘이 "기다림"을 출력한 때다. 초가 아니라 이
  // 사실을 기다린다. 둘 이상이 뜨면 그것이 곧 결함이므로 기다리지 않고 즉시 잡는다.
  let multiple = null;
  const settled = await until(async () => {
    const up = await healthyPorts(ports);
    if (up.length > 1) { multiple = [...up]; return true; }
    const waiting = kids.filter((c) => c._log.includes(WAITING)).length;
    return up.length === 1 && waiting === 2 ? up : false;
  }, { ms: 40000 });

  assert.equal(multiple, null,
    `자물쇠 주인이 둘 이상이다(포트 ${(multiple || []).join(", ")}) — 같은 상태 파일을 여럿이 쓴다`);
  assert.ok(settled, "40초 안에 결론이 나지 않았다:\n" + kids.map((c, i) => `[${ports[i]}]\n${c._log}`).join("\n"));

  // 결론이 난 뒤에도 뒤늦게 두 번째가 뜨지 않는지 한 번 더 본다.
  await sleep(1500);
  const again = await healthyPorts(ports);
  assert.equal(again.length, 1, `뒤늦게 두 번째 주인이 떴다(포트 ${again.join(", ")})`);

  const owner = Number(String(fs.readFileSync(path.join(dir, "server.lock"), "utf8")).trim());
  const ownerHealth = await healthy(again[0]);
  assert.equal(ownerHealth.pid, owner, "자물쇠에 적힌 pid와 실제로 뜬 서버가 달라서는 안 된다");

  // 임시 자물쇠 파일이 쌓이지 않는다. 실패한 쪽도 자기 것을 정리한다.
  const leftovers = fs.readdirSync(dir).filter((f) => /^server\.lock\./.test(f));
  assert.deepEqual(leftovers, [], `임시 자물쇠가 남았다: ${leftovers.join(", ")}`);
});

test("기다리는 서버는 그 사이 앞 서버가 저장한 것을 잃지 않는다", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-freshness-"));
  // 둘을 동시에 띄우면 어느 쪽이 자물쇠를 잡을지 정해지지 않아 이 검사가 보려는 순서가
  // 절반은 뒤집힌다. 앞 서버가 자리를 잡은 것을 보고 나서 뒤 서버를 띄운다.
  const [portA, portB] = [await freePort(), await freePort()];
  const a = startServer(dir, portA);
  let b = null;
  t.after(() => {
    for (const c of [a, b]) { try { c && c.kill("SIGKILL"); } catch {} }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const ha = await waitHealthy(portA);
  assert.ok(ha, "앞 서버가 뜨지 않았다:\n" + a._log);
  b = startServer(dir, portB);

  // b가 "기다림"에 들어간 것을 그 출력으로 확인한다. 초를 세면 느린 기계에서 아직 시작도 안 한
  // 서버를 "기다리는 중"으로 오인한다.
  assert.ok(await until(() => b._log.includes(WAITING), { ms: 30000 }),
    "두 번째 서버가 기다림에 들어가지 않았다:\n" + b._log);

  // b는 자물쇠를 못 잡아 기다리는 중이어야 한다. 뜨면 이 검사의 전제가 성립하지 않는다.
  const hb = await healthy(portB);
  assert.equal(hb, null, "두 번째 서버가 자물쇠 없이 떴다 — 상태 파일 주인이 둘이다");

  // 기다리는 동안 사용자가 앞 서버에서 북마크를 하나 만든다.
  assert.ok(await addBookmark(portA, dir, "https://during-wait.example", "기다리는 동안 만든 것"),
    "앞 서버가 저장하지 못했다");

  // 앞 서버가 내려가고 b가 자리를 이어받는다.
  a.kill("SIGTERM");
  await new Promise((r) => a.on("exit", r));
  assert.ok(await waitHealthy(portB), "이어받지 못했다:\n" + b._log);
  assert.match(b._log, /자리를 이어받았습니다/);

  // 이어받은 쪽에서 다음 변경이 일어나면 전체 상태가 다시 저장된다. 그때 앞의 것이 남아 있어야 한다.
  assert.ok(await addBookmark(portB, dir, "https://after-handover.example", "이어받은 뒤 만든 것"),
    "이어받은 쪽의 변경이 저장되지 않았다");
  const after = fs.readFileSync(path.join(dir, "browser-state.json"), "utf8");
  assert.ok(after.includes("during-wait.example"),
    "기다리는 동안 만든 북마크가 사라졌다 — 이어받은 서버가 옛 스냅샷으로 덮어썼다는 뜻");
});
