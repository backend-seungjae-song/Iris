import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createTailscaleSetup } from "../server/remote/tailscale-setup.js";

const CLI = "/opt/homebrew/bin/tailscale";

function accessFor(paths) {
  return async (candidate) => {
    if (!paths.includes(candidate)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
  };
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { child.killed = true; };
  return child;
}

test("CLI가 없으면 Homebrew 유무로 설치 가능 여부를 알린다", async () => {
  const withBrew = createTailscaleSetup({ findExecutable: async () => { throw new Error("none"); },
    access: accessFor(["/opt/homebrew/bin/brew"]), username: "me" });
  assert.deepEqual(await withBrew.status(), { busy: null, loginPending: false, error: null, phase: "not-installed", canInstall: true });
  const withoutBrew = createTailscaleSetup({ findExecutable: async () => { throw new Error("none"); },
    access: accessFor([]), username: "me" });
  assert.equal((await withoutBrew.status()).canInstall, false);
});

test("서비스 연결 실패는 꺼짐, 실행 중이면 주소와 tailnet을 돌려준다", async () => {
  let reply = null;
  const setup = createTailscaleSetup({
    findExecutable: async () => CLI,
    username: "me",
    execFile: async (file, args) => {
      assert.equal(file, CLI);
      assert.deepEqual(args, ["status", "--json"]);
      if (!reply) throw new Error("failed to connect to local Tailscale service");
      return { stdout: JSON.stringify(reply) };
    },
  });
  assert.equal((await setup.status()).phase, "daemon-off");
  reply = { BackendState: "NeedsLogin" };
  assert.equal((await setup.status()).phase, "needs-login");
  reply = { BackendState: "Running", Self: { TailscaleIPs: ["fd7a::1", "100.64.0.2"] }, CurrentTailnet: { Name: "me@example.com" },
    Peer: { a: { OS: "android", HostName: "galaxy", Online: true }, b: { OS: "linux", HostName: "server", Online: true } } };
  const running = await setup.status();
  assert.deepEqual(running.phones, [{ name: "galaxy", online: true }]);
  assert.equal(running.phase, "running");
  assert.equal(running.address, "100.64.0.2");
  assert.equal(running.tailnet, "me@example.com");
});

test("서비스 켜기는 관리자 암호 창으로 데몬 설치와 operator 설정만 실행한다", async () => {
  const calls = [];
  const setup = createTailscaleSetup({
    findExecutable: async () => CLI,
    access: accessFor(["/opt/homebrew/bin/tailscaled"]),
    username: "tester",
    execFile: async (file, args) => { calls.push([file, args]); return { stdout: "" }; },
  });
  assert.deepEqual(await setup.start(), { ok: true });
  assert.equal(calls.length, 1);
  const [file, args] = calls[0];
  assert.equal(file, "/usr/bin/osascript");
  assert.equal(args[0], "-e");
  assert.match(args[1], /^do shell script ".*" with administrator privileges$/s);
  assert.match(args[1], /'\/opt\/homebrew\/bin\/tailscaled' install-system-daemon/);
  assert.match(args[1], /set --operator='tester'/);
});

test("서비스 켜기는 취소와 잘못된 사용자 이름을 실행 없이 구분한다", async () => {
  const cancelled = createTailscaleSetup({
    findExecutable: async () => CLI,
    access: accessFor(["/opt/homebrew/bin/tailscaled"]),
    username: "tester",
    execFile: async () => { throw Object.assign(new Error("failed"), { stderr: "execution error: User canceled. (-128)" }); },
  });
  assert.deepEqual(await cancelled.start(), { ok: false, error: "tailscale-start-cancelled" });
  assert.equal((await cancelled.status().catch(() => ({}))).error, "tailscale-start-cancelled");

  let ran = false;
  const invalid = createTailscaleSetup({
    findExecutable: async () => CLI,
    access: accessFor(["/opt/homebrew/bin/tailscaled"]),
    username: "a'; rm -rf ~",
    execFile: async () => { ran = true; return { stdout: "" }; },
  });
  assert.deepEqual(await invalid.start(), { ok: false, error: "tailscale-start-failed" });
  assert.equal(ran, false);
});

test("연결은 tailscale up 을 한 번만 띄우고 로그인 주소는 상태로 전달한다", async () => {
  const executed = [];
  const child = fakeChild();
  let spawned = 0;
  let authUrl = null;
  const setup = createTailscaleSetup({
    findExecutable: async () => CLI,
    username: "me",
    spawn: (file, args) => { spawned += 1; assert.equal(file, CLI); assert.deepEqual(args, ["up", "--json"]); return child; },
    execFile: async (file, args) => {
      executed.push([file, args]);
      return { stdout: JSON.stringify({ BackendState: "NeedsLogin", AuthURL: authUrl }) };
    },
  });
  const pending = setup.connect();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await pending, { ok: true });
  assert.equal((await setup.status()).authUrl, null);
  authUrl = "https://login.tailscale.com/a/abc123";
  child.stdout.emit("data", JSON.stringify({ AuthURL: authUrl }));
  const waiting = await setup.status();
  assert.equal(waiting.authUrl, authUrl);
  assert.equal(waiting.loginPending, true);
  assert.deepEqual(await setup.connect(), { ok: true });
  assert.equal(spawned, 1);
  assert.equal(executed.some(([file]) => file === "/usr/bin/open"), false);
  authUrl = "javascript:alert(1)";
  assert.equal((await setup.status()).authUrl, null);
  setup.close();
  assert.equal(child.killed, true);

  const denied = fakeChild();
  const other = createTailscaleSetup({ findExecutable: async () => CLI, username: "me", spawn: () => denied,
    execFile: async () => ({ stdout: "" }) });
  const result = other.connect();
  await new Promise((resolve) => setImmediate(resolve));
  denied.stderr.emit("data", "Access denied: prefs write access denied");
  denied.emit("exit", 1);
  assert.deepEqual(await result, { ok: false, error: "tailscale-operator-required" });
});

test("작업 중 다른 작업은 거부한다", async () => {
  let release;
  const setup = createTailscaleSetup({
    findExecutable: async () => { throw new Error("none"); },
    access: accessFor(["/opt/homebrew/bin/brew"]),
    username: "me",
    execFile: () => new Promise((resolve) => { release = resolve; }),
  });
  const installing = setup.install();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await setup.start(), { ok: false, error: "tailscale-busy" });
  release({ stdout: "" });
  assert.deepEqual(await installing, { ok: true });
});
