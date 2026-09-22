// 파일을 읽어 주는 경계는 열려 있으면 안 된다.
//
// 서버는 살아 있는 에이전트의 cwd와 스페이스 폴더만 열어 준다(`allowedRoots`). 이 경계가 새면
// 브라우저에 붙은 무엇이든 WS 한 줄로 홈 전체를 훑을 수 있다. 로컬에만 붙는다는 것은 방어가
// 아니다. 앱 안 webview도, 이 기기에 붙은 다른 프로그램도 로컬이다.
//
// 단정문이 없는 탐침은 사람이 쓰는 서버에 붙어야 해서 스위트에서 늘 건너뛰고 개수만 채운다.
// 그래서 탐침은 `scripts/probe/fs-tree.mjs` 로 옮기고, 기계가 판정할 수 있는 부분을 여기서
// 본다.
//
// herdr가 없는 검사용 서버에서는 허용 루트가 비어 있다. 그래서 여기서 보는 것은 "빈 목록일 때
// 전부 거절하는가"이다. 목록이 비었을 때 열어 버리는 것이 이 종류의 가장 흔한 실패다.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { freePort } from "./lib/net.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer(t) {
  const port = await freePort();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-fsbound-"));
  const child = spawn(process.execPath, [path.join(ROOT, "server/index.js")], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), IRIS_PORT: String(port), IRIS_STATE_DIR: stateDir, REMOTE: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  t.after(() => {
    try { child.kill("SIGKILL"); } catch {}
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  // 뜰 때까지 기다린다. 초를 세지 않고 실제로 붙을 때까지 기다린다.
  for (let i = 0; i < 150; i++) {
    const ok = await new Promise((res) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const done = (v) => { try { ws.close(); } catch {} res(v); };
      ws.on("open", () => done(true));
      ws.on("error", () => done(false));
    });
    if (ok) return { port, stateDir, log: () => log };
    await sleep(100);
  }
  throw new Error("검사용 서버가 뜨지 않았다:\n" + log);
}

// 한 번 물어보고 그 답만 받아 온다.
function ask(port, msg, wantType) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("답이 없다: " + JSON.stringify(msg))); }, 10000);
    ws.on("open", () => ws.send(JSON.stringify(msg)));
    ws.on("message", (d) => {
      let m; try { m = JSON.parse(d.toString()); } catch { return; }
      if (m.type !== wantType) return;
      clearTimeout(timer); try { ws.close(); } catch {}
      resolve(m);
    });
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

test("허용 루트가 없으면 어떤 경로도 열어 주지 않는다", async (t) => {
  const { port } = await startServer(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "iris-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "비밀.txt"), "안 보여야 한다");
  fs.writeFileSync(path.join(outside, ".숨김"), "이것도");

  for (const target of [outside, os.homedir(), "/etc", ROOT]) {
    const list = await ask(port, { type: "fs.list", path: target }, "fs");
    assert.ok(list.error, `fs.list가 ${target}를 열어 줬다 — 허용 루트가 비었는데도`);
    assert.equal(list.entries, undefined, "거절하면서 목록을 함께 주면 안 된다");

    const tree = await ask(port, { type: "fs.tree", path: target }, "tree");
    assert.ok(tree.error, `fs.tree가 ${target}를 훑어 줬다 — 허용 루트가 비었는데도`);
    assert.equal(tree.files, undefined, "거절하면서 파일 목록을 함께 주면 안 된다");
  }
});

test("경로가 아닌 값에도 죽지 않고 거절한다", async (t) => {
  const { port } = await startServer(t);
  // 원격 한 줄로 서버를 종료시킬 수 있는 자리다. path.resolve가 문자열이 아니면 던진다.
  for (const bad of [undefined, null, "", 0, 123, {}, [], true]) {
    const list = await ask(port, { type: "fs.list", path: bad }, "fs");
    assert.ok(list.error, `fs.list가 ${JSON.stringify(bad)}를 거절하지 않았다`);
    const tree = await ask(port, { type: "fs.tree", path: bad }, "tree");
    assert.ok(tree.error, `fs.tree가 ${JSON.stringify(bad)}를 거절하지 않았다`);
  }
  // 그 뒤에도 서버가 계속 동작해야 한다.
  const still = await ask(port, { type: "fs.list", path: "/etc" }, "fs");
  assert.ok(still.error, "이상한 값을 먹은 뒤 서버가 조용히 죽었다");
});
