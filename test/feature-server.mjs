import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once, EventEmitter } from "node:events";
import net from "node:net";
import { WebSocket } from "ws";
import { createHttpHandler } from "../server/http-handler.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = fs.mkdtempSync(path.join(os.tmpdir(), "iris-feature-server-"));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));
// 빈 포트를 잡았다 놓고 그 번호를 쓴다(state-lock-handover.mjs 와 같은 방식).
const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn) {
  for (let n = 0; n < 160; n++) { const value = await fn(); if (value) return value; await pause(25); }
  throw new Error("서버 관측 시간 초과");
}

for (const hidden of [["usage"], [], ["usage", "run", "memolab", "memo"], ["sourcecontrol"], ["archive"]]) {
  test(`T1 실제 서버: hidden=${JSON.stringify(hidden)}`, { timeout: 15000 }, async (t) => {
    const home = fs.mkdtempSync(path.join(base, "feature-server-"));
    const on = !hidden.includes("usage");
    const runOn = !hidden.includes("run"), memolabOn = !hidden.includes("memolab");
    fs.writeFileSync(path.join(home, "features.json"), JSON.stringify({ version: 1, revision: 7, hidden }));
    fs.writeFileSync(path.join(home, "preserve.txt"), "기존 사용자 자료");
    const priorUsage = JSON.stringify({ prefs: { display: "remaining" }, snapshot: { providers: [], updatedAt: 123 } });
    fs.writeFileSync(path.join(home, "usage.json"), priorUsage);
    const probe = path.join(home, "probe.cjs");
    // 수집기 내부는 그대로 실행하고 OS 비밀 저장소·외부 네트워크 경계만 대역으로 받는다.
    fs.writeFileSync(probe, `
      const cp = require("node:child_process");
      const { syncBuiltinESMExports } = require("node:module");
      const exec = cp.execFile;
      cp.execFile = function(command, ...args) {
        if (command === "security") {
          process.stdout.write("PROBE keychain\\n");
          queueMicrotask(() => args.at(-1)(new Error("isolated keychain"), ""));
          return { kill() {} };
        }
        return exec.call(this, command, ...args);
      };
      syncBuiltinESMExports();
      global.fetch = async () => { process.stdout.write("PROBE external\\n"); throw new Error("isolated network"); };
      const interval = global.setInterval;
      global.setInterval = (fn, ms, ...args) => {
        const usage = new Error().stack.includes("usage-handlers.js");
        if (usage) process.stdout.write("PROBE usage timer " + ms + "\\n");
        return interval(() => { if (usage) process.stdout.write("PROBE usage tick\\n"); fn(...args); }, usage ? 40 : ms);
      };
    `);
    const port = await freePort();
    const child = spawn(process.execPath, ["--require", probe, "server/index.js"], {
      cwd: root, env: { ...process.env, HOME: home, IRIS_STATE_DIR: home, IRIS_PORT: String(port), HOST: "127.0.0.1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    t.after(async () => {
      if (child.exitCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
      fs.writeFileSync(path.join(home, "server.log"), output);
    });
    const url = `http://127.0.0.1:${port}`;
    await until(async () => {
      if (child.exitCode !== null) throw new Error(output);
      try { const res = await fetch(url + "/healthz"); const value = await res.json(); return value.pid === child.pid; } catch { return false; }
    });
    const ws = new WebSocket(url.replace("http", "ws"));
    const messages = [];
    ws.on("message", (raw) => messages.push(JSON.parse(raw)));
    await once(ws, "open");
    t.after(() => ws.terminate());
    await until(() => messages.some((m) => m.type === "memo-archives"));
    await pause(150);
    assert.equal(messages.some((m) => m.type === "usage.state"), on, "접속 사용량 방송");
    assert.equal(output.includes("PROBE usage timer 300000"), on, "usage 초기화 타이머");
    assert.equal(output.includes("PROBE usage tick"), on, "usage 타이머 실제 발화");
    assert.equal(output.includes("PROBE keychain"), on, "Keychain 호출 시도");
    if (!on) assert.equal(output.includes("PROBE external"), false);
    messages.length = 0;
    ws.send(JSON.stringify({ type: "usage.get" }));
    const response = await until(() => messages.find((m) => m.type === "usage.state" || m.type === "control-error"));
    assert.equal(response.type, on ? "usage.state" : "control-error");
    if (!on) assert.match(response.message, /모르는 메시지: usage.get/);
    // 켜진 기능은 그 기능의 실제 응답(허용되지 않은 경로라도 git-error 로 답한다)을 기다린다.
    for (const [id, type, replies] of [["sourcecontrol", "git.status", ["git-status", "git-error"]], ["archive", "archive.list", ["archives"]]]) {
      messages.length = 0;
      ws.send(JSON.stringify({ type, path: home }));
      const answer = await until(() => messages.find((m) => replies.includes(m.type) || m.type === "control-error"));
      if (hidden.includes(id)) { assert.equal(answer.type, "control-error", type); assert.match(answer.message, new RegExp("모르는 메시지: " + type)); }
      else {
        assert.ok(replies.includes(answer.type), `${type} → ${answer.type}`);
        if (id === "archive") assert.ok(Array.isArray(answer.items), "archives 는 items 배열을 든다");
        else assert.equal(answer.path, home, "git 응답은 요청한 경로를 든다");
      }
    }
    const run = await fetch(url + "/run-cmd", { method: "POST", body: JSON.stringify({ cmd: "status", path: home }) });
    assert.equal(run.status, runOn ? 200 : 404);
    for (const route of ["/memolab-state", "/memolab-ui", "/memolab/", "/memolab/index.html", "/memolab%2findex.html"]) {
      assert.equal((await fetch(url + route)).status, memolabOn ? 200 : 404, route);
    }
    assert.equal((await fetch(url + "/MeMoLaB/index.html")).status, memolabOn && fs.existsSync(path.join(root, "web/MeMoLaB/index.html")) ? 200 : 404, "파일시스템 대소문자 별칭");
    const feature = await (await fetch(url + "/features")).json();
    assert.deepEqual(feature, { exists: true, revision: 7, hidden, shown: [], local: true });
    const update = await fetch(url + "/features", { method: "PUT", body: JSON.stringify({ baseRevision: 7, hidden: ["archive"] }) });
    assert.equal(update.status, 200);
    const conflict = await fetch(url + "/features", { method: "PUT", body: JSON.stringify({ baseRevision: 7, hidden: [] }) });
    assert.equal(conflict.status, 409);
    assert.deepEqual((await conflict.json()).hidden, ["archive"]);
    assert.equal((await fetch(url + "/run-cmd", { method: "POST", body: "{}" })).status, runOn ? 200 : 404, "저장은 실행 중 조립을 바꾸지 않는다");
    assert.equal(fs.readFileSync(path.join(home, "preserve.txt"), "utf8"), "기존 사용자 자료");
    if (!on) assert.equal(fs.readFileSync(path.join(home, "usage.json"), "utf8"), priorUsage, "꺼진 사용량 데이터 보존");
    t.diagnostic(`timer/keychain/broadcast ${on ? "관측" : "0"}; HTTP run ${runOn ? 200 : 404}/memolab ${memolabOn ? 200 : 404}; memo 연결 정상; ${home}/server.log`);
  });
}

test("기능 id 규칙은 경계값에서 갈린다", async () => {
  const { createRequire } = await import("node:module");
  const { FEATURE_ID } = createRequire(import.meta.url)("../server/feature-state-read.cjs");
  for (const ok of ["a", "usage", "lab-hello_2", "a" + "b".repeat(99)]) assert.ok(FEATURE_ID.test(ok), ok);
  for (const bad of ["", "A", "1a", " a", "a b", "a.b", "한글", "a" + "b".repeat(100)]) assert.ok(!FEATURE_ID.test(bad), JSON.stringify(bad));
});

test("shown 이 없는 옛 features.json 은 빈 목록으로 읽고, 형식이 틀린 shown 은 파손으로 본다", async () => {
  const { createRequire } = await import("node:module");
  const { readFeatureState } = createRequire(import.meta.url)("../server/feature-state-read.cjs");
  const home = fs.mkdtempSync(path.join(base, "feature-read-"));
  const write = (value) => fs.writeFileSync(path.join(home, "features.json"), JSON.stringify(value));
  write({ version: 1, revision: 3, hidden: ["usage"] });
  assert.deepEqual(readFeatureState(home), { exists: true, revision: 3, hidden: ["usage"], shown: [] });
  write({ version: 1, revision: 3, hidden: [], shown: ["desklayout"] });
  assert.deepEqual(readFeatureState(home).shown, ["desklayout"]);
  for (const shown of ["desklayout", [1], null]) {
    write({ version: 1, revision: 3, hidden: [], shown });
    assert.equal(readFeatureState(home).exists, false, JSON.stringify(shown));
  }
  fs.rmSync(home, { recursive: true, force: true });
});

test("상태 HTTP 계약: 원격 읽기·쓰기 거절, Origin 거절, 잘못된 입력과 CAS", async () => {
  const home = fs.mkdtempSync(path.join(base, "feature-http-"));
  const previous = process.env.IRIS_STATE_DIR;
  process.env.IRIS_STATE_DIR = home;
  function request(method, body, ip = "127.0.0.1", origin) {
    return new Promise((resolve) => {
      const req = new EventEmitter();
      Object.assign(req, { method, url: "/features", headers: origin ? { origin } : {}, socket: { remoteAddress: ip } });
      const res = { writeHead(status) { this.status = status; return this; }, end(value) { resolve({ status: this.status, value }); } };
      createHttpHandler({ irisHome: home })(req, res);
      if (body !== undefined) req.emit("data", typeof body === "string" ? body : JSON.stringify(body));
      req.emit("end");
    });
  }
  try {
    assert.equal((await request("GET", undefined, "100.64.0.2")).status, 200);
    assert.equal(JSON.parse((await request("GET", undefined, "100.64.0.2")).value).local, false);
    assert.equal((await request("PUT", { hidden: [], baseRevision: 0 }, "100.64.0.2")).status, 403);
    assert.equal((await request("GET", undefined, "127.0.0.1", "https://evil.invalid")).status, 403);
    for (const body of ["{", null, { hidden: [3], baseRevision: 0 }, { hidden: [], baseRevision: -1 },
      { hidden: [], shown: "desklayout", baseRevision: 0 }, { hidden: [], shown: ["Bad"], baseRevision: 0 }]) {
      assert.equal((await request("PUT", body)).status, 400);
    }
    assert.equal((await request("PUT", { hidden: ["usage"], shown: ["desklayout"], baseRevision: 0 })).status, 200);
    assert.equal((await request("PUT", { hidden: [], baseRevision: 0 })).status, 409);
    // shown 을 보내지 않는 옛 요청은 사용자가 켠 기본 꺼짐 기능을 지우지 않는다.
    assert.deepEqual(JSON.parse((await request("PUT", { hidden: [], baseRevision: 1 })).value).shown, ["desklayout"]);
    assert.deepEqual(JSON.parse((await request("PUT", { hidden: [], shown: [], baseRevision: 2 })).value).shown, []);
    assert.deepEqual(fs.readdirSync(home), ["features.json"]);
  } finally {
    if (previous === undefined) delete process.env.IRIS_STATE_DIR; else process.env.IRIS_STATE_DIR = previous;
  }
});
