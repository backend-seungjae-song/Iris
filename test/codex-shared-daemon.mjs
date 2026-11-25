import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, stat, writeFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { discoverSharedCodexForPane, sharedCodexPane, startSharedCodex, reapSharedCodex } from "../server/paseo-ui/codex-shared-daemon.mjs";

const oldStateDir = process.env.IRIS_STATE_DIR;
const oldCodexHome = process.env.CODEX_HOME;

function statePaths(stateDir) {
  const dir = path.join(stateDir, "paseo-ui", "codex-native");
  return { dir, owner: id => path.join(dir, `${id}.pid`) };
}

function threadId(last) { return ["00000000", "0000", "7000", "8000", last.repeat(12)].join("-"); }

async function fakeCodexServer(socketPath, threads, calls) {
  const server = createHttpServer();
  const endpoint = new WebSocketServer({ server });
  endpoint.on("connection", ws => ws.on("message", raw => {
    const message = JSON.parse(raw);
    if (!message.id) return;
    calls.push(message);
    let result = {};
    if (message.method === "thread/loaded/list") result = { data: threads.map(thread => thread.id), nextCursor: null };
    if (message.method === "thread/read") result = { thread: threads.find(thread => thread.id === message.params.threadId) };
    ws.send(JSON.stringify({ id: message.id, result }));
  }));
  server.listen(socketPath);
  await once(server, "listening");
  return async () => {
    for (const ws of endpoint.clients) ws.terminate();
    endpoint.close();
    await new Promise(resolve => server.close(resolve));
  };
}

test.after(() => {
  if (oldStateDir === undefined) delete process.env.IRIS_STATE_DIR;
  else process.env.IRIS_STATE_DIR = oldStateDir;
  if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = oldCodexHome;
});

test("ordinary native Codex binds the exact loaded thread on its default control socket", async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "iris-codex-discovery-"));
  const codexHomeDir = path.join(tmpdir(), `c${process.pid}`);
  const cwd = await mkdtemp(path.join(tmpdir(), "iris-codex-cwd-"));
  const otherCwd = await mkdtemp(path.join(tmpdir(), "iris-codex-other-"));
  t.after(() => Promise.all([rm(stateDir, { recursive: true, force: true }), rm(codexHomeDir, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true }), rm(otherCwd, { recursive: true, force: true })]));
  process.env.IRIS_STATE_DIR = stateDir;
  process.env.CODEX_HOME = codexHomeDir;
  const socketPath = path.join(codexHomeDir, "app-server-control", "app-server-control.sock");
  const right = threadId("2");
  const wrong = threadId("1");
  const threads = [{ id: wrong, cwd, status: { type: "idle" } }, { id: right, cwd, status: { type: "idle" } }];
  const calls = [];
  await mkdir(path.dirname(socketPath), { recursive: true });
  const closeServer = await fakeCodexServer(socketPath, threads, calls);
  t.after(async () => { await closeServer(); await rm(socketPath, { force: true }); });

  const terminalId = "native-terminal";
  const binding = await discoverSharedCodexForPane({ terminalId, cwd, paneId: "workspace:pane", workspaceId: "workspace",
    threadId: right, processInfo: { process_info: { foreground_processes: [{ name: "codex", argv: ["codex", "resume", right] }] } } });

  assert.equal(binding.threadId, right);
  assert.equal(binding.cwd, await realpath(cwd));
  assert.equal(binding.terminalId, terminalId);
  assert.equal(binding.socketPath, socketPath);
  assert.deepEqual(calls.filter(call => call.method === "thread/read").map(call => call.params), [{ threadId: right, includeTurns: false }]);
  const terminalHash = createHash("sha256").update(JSON.stringify(terminalId)).digest("hex").slice(0, 24);
  assert.deepEqual(JSON.parse(await readFile(path.join(statePaths(stateDir).dir, `${terminalHash}.json`), "utf8")), {
    terminalId, id: null, socketPath, ownerManaged: false, threadId: right, cwd: await realpath(cwd), paneId: "workspace:pane", workspaceId: "workspace", boundAt: binding.boundAt,
  });
  const bindingFile = path.join(statePaths(stateDir).dir, `${terminalHash}.json`);
  const firstStat = await stat(bindingFile);
  await delay(20);
  await discoverSharedCodexForPane({ terminalId, cwd, paneId: "workspace:pane", workspaceId: "workspace",
    threadId: right, processInfo: { process_info: { foreground_processes: [{ name: "codex", argv: ["codex", "resume", right] }] } } });
  assert.equal((await stat(bindingFile)).mtimeMs, firstStat.mtimeMs);
  await reapSharedCodex();
  assert.equal(await access(path.join(statePaths(stateDir).dir, `${terminalHash}.json`)).then(() => true, () => false), true);
  assert.notEqual(binding.threadId, wrong);
  const explicit = await discoverSharedCodexForPane({ terminalId, cwd, threadId: right,
    rawTitle: right, processInfo: { foreground_processes: [{ name: "codex", argv: ["codex", "--remote", "unix://" + socketPath] }] } });
  assert.equal(explicit?.threadId, right);
  threads.length = 0;
  const diagnostic = {};
  const local = await discoverSharedCodexForPane({ terminalId, cwd, threadId: right, diagnostic,
    rawTitle: "Clarify task | iris", processInfo: { foreground_processes: [{ name: "codex", argv: ["codex", "-c", "shell_environment_policy.set.HERDR_ENV=1"] }] } });
  assert.equal(local, null);
  assert.equal(diagnostic.status, "not-loaded");

});

test("private pane socket matches its reported thread and rejects a link to a different server", async t => {
  const dir = path.join("/tmp", `codex-pane-${process.getuid()}-${randomBytes(4).toString("hex")}`);
  await mkdir(dir, { mode: 0o700 });
  const state = await mkdtemp(path.join(tmpdir(), "iris-pane-test-"));
  const previous = process.env.IRIS_STATE_DIR;
  process.env.IRIS_STATE_DIR = state;
  t.after(async () => {
    if (previous === undefined) delete process.env.IRIS_STATE_DIR;
    else process.env.IRIS_STATE_DIR = previous;
    await Promise.all([rm(dir, { recursive: true, force: true }), rm(state, { recursive: true, force: true })]);
  });
  const socket = path.join(dir, "control.sock");
  const one = threadId("1"), two = threadId("2");
  const threads = [{ id: one, cwd: dir }, { id: two, cwd: dir }];
  const input = { terminalId: "selected", cwd: dir, threadId: two, rawTitle: "Clarify task | iris",
    processInfo: { foreground_processes: [{ name: "codex", argv: ["codex", "--remote", "unix://" + socket] }] } };
  const close = await fakeCodexServer(socket, threads, []);
  try { assert.equal((await discoverSharedCodexForPane(input))?.threadId, two); }
  finally { await close(); }
  const other = path.join(dir, "other.sock");
  const closeOther = await fakeCodexServer(other, threads, []);
  try {
    await symlink(other, socket);
    assert.equal(await discoverSharedCodexForPane(input), null);
    assert.equal(await sharedCodexPane("selected"), null);
  } finally { await closeOther(); }
});

test("native title wins over a stale pane id and title-less inherited ids stay ambiguous", async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "iris-codex-title-conflict-"));
  const codexHomeDir = path.join(tmpdir(), `c${process.pid}`);
  const cwd = await mkdtemp(path.join(tmpdir(), "iris-codex-title-cwd-"));
  t.after(() => Promise.all([rm(stateDir, { recursive: true, force: true }), rm(codexHomeDir, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })]));
  process.env.IRIS_STATE_DIR = stateDir;
  process.env.CODEX_HOME = codexHomeDir;
  const socketPath = path.join(codexHomeDir, "app-server-control", "app-server-control.sock");
  const threadA = threadId("5");
  const threadB = threadId("6");
  await mkdir(path.dirname(socketPath), { recursive: true });
  const closeServer = await fakeCodexServer(socketPath, [{ id: threadA, cwd }, { id: threadB, cwd }], []);
  t.after(async () => { await closeServer(); await rm(socketPath, { force: true }); });

  const paneA = await discoverSharedCodexForPane({ terminalId: "w1:p2", cwd, threadId: threadB,
    rawTitle: `${threadA.slice(0, 29)}... Codex`, processInfo: { process_info: { foreground_processes: [{ name: "codex", argv: ["codex", "resume", threadB] }] } } });
  const paneB = await discoverSharedCodexForPane({ terminalId: "w1:p3", cwd,
    rawTitle: `${threadB.slice(0, 29)}... Codex`, processInfo: { process_info: { foreground_processes: [{ name: "codex", argv: ["codex"] }] } } });
  const inherited = await discoverSharedCodexForPane({ terminalId: "w1:p4", cwd, threadId: threadA,
    processInfo: { process_info: { foreground_processes: [{ name: "codex", argv: ["codex"] }] } } });

  assert.equal(paneA.threadId, threadA);
  assert.equal(paneB.threadId, threadB);
  assert.equal(inherited, null);
});

test("native Codex discovery refuses an ambiguous loaded set and cwd mismatch", async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "iris-codex-discovery-"));
  const codexHomeDir = path.join(tmpdir(), `c${process.pid}`);
  const cwd = await mkdtemp(path.join(tmpdir(), "iris-codex-cwd-"));
  const otherCwd = await mkdtemp(path.join(tmpdir(), "iris-codex-other-"));
  t.after(() => Promise.all([rm(stateDir, { recursive: true, force: true }), rm(codexHomeDir, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true }), rm(otherCwd, { recursive: true, force: true })]));
  process.env.IRIS_STATE_DIR = stateDir;
  process.env.CODEX_HOME = codexHomeDir;
  const socketPath = path.join(codexHomeDir, "app-server-control", "app-server-control.sock");
  const first = threadId("3");
  const second = threadId("4");
  await mkdir(path.dirname(socketPath), { recursive: true });
  const closeServer = await fakeCodexServer(socketPath, [{ id: first, cwd }, { id: second, cwd }], []);
  t.after(async () => { await closeServer(); await rm(socketPath, { force: true }); });

  const result = await discoverSharedCodexForPane({ terminalId: "ambiguous-terminal", cwd,
    processInfo: { process_info: { foreground_processes: [{ argv0: "codex", argv: ["codex"] }] } } });
  assert.equal(result, null);
  const mismatch = await discoverSharedCodexForPane({ terminalId: "mismatch-terminal", cwd: otherCwd, threadId: first,
    processInfo: { process_info: { foreground_processes: [{ argv0: "codex", argv: ["codex", "resume", first] }] } } });
  assert.equal(mismatch, null);
  const noDaemon = await discoverSharedCodexForPane({ terminalId: "no-daemon-terminal", cwd, threadId: first,
    processInfo: { process_info: { foreground_processes: [{ argv0: "codex", argv: ["codex", "--no-daemon", "resume", first] }] } } });
  assert.equal(noDaemon, null);
});

test("native discovery preserves legacy fallback for no-daemon and an unavailable shared socket", async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "iris-codex-fallback-"));
  const codexHomeDir = path.join(tmpdir(), `c${process.pid}`);
  const cwd = await mkdtemp(path.join(tmpdir(), "iris-codex-fallback-cwd-"));
  t.after(() => Promise.all([rm(stateDir, { recursive: true, force: true }), rm(codexHomeDir, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })]));
  process.env.IRIS_STATE_DIR = stateDir;
  process.env.CODEX_HOME = codexHomeDir;
  const thread = threadId("7");
  const noDaemonDiagnostic = {};
  assert.equal(await discoverSharedCodexForPane({ terminalId: "no-daemon-fallback", cwd, threadId: thread,
    processInfo: { process_info: { foreground_processes: [{ name: "codex", argv: ["codex", "--no-daemon", "resume", thread] }] } }, diagnostic: noDaemonDiagnostic }), null);
  assert.equal(noDaemonDiagnostic.status, "no-daemon");

  const unavailableDiagnostic = {};
  assert.equal(await discoverSharedCodexForPane({ terminalId: "unavailable-fallback", cwd, threadId: thread,
    processInfo: { process_info: { foreground_processes: [{ name: "codex", argv: ["codex", "resume", thread] }] } }, diagnostic: unavailableDiagnostic }), null);
  assert.equal(unavailableDiagnostic.status, "transport-unavailable");

  const terminalId = "legacy-binding";
  const terminalHash = createHash("sha256").update(JSON.stringify(terminalId)).digest("hex").slice(0, 24);
  await mkdir(statePaths(stateDir).dir, { recursive: true });
  await writeFile(path.join(statePaths(stateDir).dir, `${terminalHash}.json`), JSON.stringify({ terminalId, id: null,
    socketPath: path.join(codexHomeDir, "app-server-control", "app-server-control.sock"), threadId: thread, cwd }));
  assert.equal((await sharedCodexPane(terminalId)).threadId, thread);
});

test("Codex 준비 시간 초과는 detached daemon과 선기록 PID를 함께 정리한다", async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "iris-codex-daemon-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  process.env.IRIS_STATE_DIR = stateDir;
  const id = "aaaaaaaaaaaaaaaaaaaaaaaa";
  const socketPath = path.join(tmpdir(), `iris-codex-test-${process.pid}-${Date.now()}.sock`);
  const command = path.join(stateDir, "never-ready.sh");
  await writeFile(command, "#!/bin/sh\nexec /bin/sleep 60\n", { mode: 0o700 });
  const { dir, owner } = statePaths(stateDir);

  await assert.rejects(startSharedCodex(socketPath, stateDir, id, command, { timeoutMs: 50 }), /연결할 수 없습니다/);
  assert.equal(await stat(owner(id)).then(() => true, error => error.code !== "ENOENT"), false);
  await assert.rejects(stat(socketPath), { code: "ENOENT" });
  assert.deepEqual(await readdir(dir), []);
});

test("죽은 Codex daemon의 socket, PID, lease를 함께 회수한다", async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "iris-codex-reap-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  process.env.IRIS_STATE_DIR = stateDir;
  const id = randomBytes(12).toString("hex");
  const socketDir = path.join("/tmp", `iris-codex-${process.getuid()}`);
  const socketPath = path.join(socketDir, `${id}.sock`);
  const endpoint = createServer();
  endpoint.on("connection", socket => socket.destroy());
  t.after(() => endpoint.listening ? new Promise(resolve => endpoint.close(() => resolve())) : undefined);
  await mkdir(socketDir, { recursive: true, mode: 0o700 });
  endpoint.listen(socketPath);
  await once(endpoint, "listening");
  const socketInfo = await stat(socketPath);
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10)"], { stdio: "ignore" });
  await once(child, "exit");

  const { dir, owner } = statePaths(stateDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(owner(id), JSON.stringify({ id, pid: child.pid, dev: socketInfo.dev, ino: socketInfo.ino, token: "old-owner" }));
  await writeFile(path.join(dir, "owned.json"), JSON.stringify({ id, ownerToken: "old-owner", launchedAt: Date.now() - 60_000 }));
  await writeFile(path.join(dir, "qa-target.json"), JSON.stringify({ id, target: "qa" }));
  await reapSharedCodex();

  assert.equal(await stat(socketPath).then(() => true, error => error.code !== "ENOENT"), false);
  assert.equal(await stat(owner(id)).then(() => true, error => error.code !== "ENOENT"), false);
  assert.deepEqual(await readdir(dir), ["qa-target.json"]);
});

test("Codex 준비 시간 초과는 stale socket도 함께 제거한다", async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "iris-codex-timeout-socket-"));
  const previousStateDir = process.env.IRIS_STATE_DIR;
  process.env.IRIS_STATE_DIR = stateDir;
  t.after(async () => {
    if (previousStateDir === undefined) delete process.env.IRIS_STATE_DIR;
    else process.env.IRIS_STATE_DIR = previousStateDir;
    await rm(stateDir, { recursive: true, force: true });
  });
  const id = "abcdefabcdefabcdefabcdef";
  const socketPath = path.join("/tmp", `iris-codex-${process.getuid()}`, `${id}.sock`);
  await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  await writeFile(socketPath, "stale");
  const command = path.join(stateDir, "hold.sh");
  await writeFile(command, "#!/bin/sh\nsleep 30\n", { mode: 0o700 });

  await assert.rejects(startSharedCodex(socketPath, stateDir, id, command, { timeoutMs: 50 }), /연결할 수 없습니다/);
  assert.equal(await access(socketPath).then(() => true, () => false), false);
});

test("시작 중 교체된 socket과 owner 기록은 timeout 정리에서 보존한다", async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "iris-codex-replacement-"));
  const previousStateDir = process.env.IRIS_STATE_DIR;
  process.env.IRIS_STATE_DIR = stateDir;
  t.after(async () => {
    if (previousStateDir === undefined) delete process.env.IRIS_STATE_DIR;
    else process.env.IRIS_STATE_DIR = previousStateDir;
    await rm(stateDir, { recursive: true, force: true });
  });
  const id = "dddddddddddddddddddddddd";
  const socketPath = path.join("/tmp", `iris-codex-${process.getuid()}`, `${id}.sock`);
  await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  await writeFile(socketPath, "initial");
  const marker = path.join(stateDir, "started");
  const command = "/bin/sh";
  await writeFile(path.join(stateDir, "app-server"), `#!/bin/sh
printf started > '${marker}'
exec /bin/sleep 60
`, { mode: 0o700 });
  const { owner } = statePaths(stateDir);
  const start = startSharedCodex(socketPath, stateDir, id, command, { timeoutMs: 1_000 });
  for (let attempt = 0; attempt < 100 && !await access(marker).then(() => true, () => false); attempt++) await delay(10);
  const original = JSON.parse(await readFile(owner(id), "utf8"));
  await rm(socketPath);
  await writeFile(socketPath, "replacement");
  await writeFile(owner(id), JSON.stringify({ id, pid: original.pid, token: "replacement-token" }));

  await assert.rejects(start, /연결할 수 없습니다/);
  assert.equal(await readFile(socketPath, "utf8"), "replacement");
  assert.equal(JSON.parse(await readFile(owner(id), "utf8")).token, "replacement-token");
});

test("owner 기록이 없는 Codex lease를 회수한다", async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "iris-codex-orphan-lease-"));
  const previousStateDir = process.env.IRIS_STATE_DIR;
  process.env.IRIS_STATE_DIR = stateDir;
  t.after(async () => {
    if (previousStateDir === undefined) delete process.env.IRIS_STATE_DIR;
    else process.env.IRIS_STATE_DIR = previousStateDir;
    await rm(stateDir, { recursive: true, force: true });
  });
  const id = "bbbbbbbbbbbbbbbbbbbbbbbb";
  const { dir } = statePaths(stateDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lease = path.join(dir, `${id}.json`);
  await writeFile(lease, JSON.stringify({ id, ownerToken: "old-token", launchedAt: Date.now() - 60_000 }));

  await reapSharedCodex();
  assert.equal(await access(lease).then(() => true, () => false), false);
});

test("토큰이 다르거나 없는 stale lease도 owner와 함께 회수한다", async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "iris-codex-stale-lease-"));
  const previousStateDir = process.env.IRIS_STATE_DIR;
  process.env.IRIS_STATE_DIR = stateDir;
  t.after(async () => {
    if (previousStateDir === undefined) delete process.env.IRIS_STATE_DIR;
    else process.env.IRIS_STATE_DIR = previousStateDir;
    await rm(stateDir, { recursive: true, force: true });
  });
  const id = "cccccccccccccccccccccccc";
  const { dir, owner: ownerPath } = statePaths(stateDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(ownerPath(id), JSON.stringify({ id, pid: 999999999, token: "owner-token" }));
  const stale = { id, launchedAt: Date.now() - 60_000 };
  const mismatched = path.join(dir, `${id}.json`);
  const withoutToken = path.join(dir, `${id}-extra.json`);
  await writeFile(mismatched, JSON.stringify({ ...stale, ownerToken: "other-token" }));
  await writeFile(withoutToken, JSON.stringify(stale));

  await reapSharedCodex();
  assert.equal(await access(mismatched).then(() => true, () => false), false);
  assert.equal(await access(withoutToken).then(() => true, () => false), false);
  assert.equal(await access(ownerPath(id)).then(() => true, () => false), false);
});

test("start waits for an active reap and keeps the new owner separate from the old owner", async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "iris-codex-race-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  process.env.IRIS_STATE_DIR = stateDir;
  const id = "cccccccccccccccccccccccc";
  const socketDir = path.join("/tmp", `iris-codex-${process.getuid()}`);
  const socketPath = path.join(socketDir, `${id}.sock`);
  const endpoint = createServer();
  endpoint.on("connection", socket => socket.destroy());
  t.after(() => endpoint.listening ? new Promise(resolve => endpoint.close(() => resolve())) : undefined);
  await mkdir(socketDir, { recursive: true, mode: 0o700 });
  await rm(socketPath, { force: true });
  endpoint.listen(socketPath);
  await once(endpoint, "listening");
  const socketInfo = await stat(socketPath);
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10)"], { stdio: "ignore" });
  await once(child, "exit");

  const { dir, owner } = statePaths(stateDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(owner(id), JSON.stringify({ id, pid: child.pid, dev: socketInfo.dev, ino: socketInfo.ino, token: "old-owner" }));
  await writeFile(path.join(dir, "qa-target.json"), JSON.stringify({ id, target: "qa" }));
  const psDir = path.join(stateDir, "bin");
  await mkdir(psDir, { recursive: true });
  const inspecting = path.join(stateDir, "inspecting");
  await writeFile(path.join(psDir, "ps"), `#!/bin/sh\ntouch '${inspecting}'\n/bin/sleep 0.25\nexec /bin/ps "$@"\n`, { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${psDir}:${previousPath || ""}`;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });

  const marker = path.join(stateDir, "started");
  const command = "/bin/sh";
  await writeFile(path.join(stateDir, "app-server"), `#!/bin/sh
printf started > '${marker}'
exec /bin/sleep 60
`, { mode: 0o700 });
  const reap = reapSharedCodex();
  for (let i = 0; i < 500 && !await access(inspecting).then(() => true, () => false); i++) await delay(10);
  await access(inspecting);
  const start = startSharedCodex(socketPath, stateDir, id, command, { timeoutMs: 1_000 });
  await delay(50);
  assert.equal(await access(marker).then(() => true, () => false), false);
  await Promise.race([reap, delay(1_500).then(() => { throw new Error("reap did not finish"); })]);
  await assert.rejects(Promise.race([start, delay(1_500).then(() => { throw new Error("start did not finish"); })]), /연결할 수 없습니다/);
  await new Promise(resolve => endpoint.close(() => resolve()));
  for (let attempt = 0; attempt < 150 && !await access(marker).then(() => true, () => false); attempt++) await delay(10);
  assert.equal(await readFile(marker, "utf8"), "started");
  assert.equal(await access(owner(id)).then(() => true, () => false), false);
  assert.equal(await access(path.join(dir, "qa-target.json")).then(() => true, () => false), true);
});
