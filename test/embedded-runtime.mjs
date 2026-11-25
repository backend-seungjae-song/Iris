import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFile, spawn } from "node:child_process";
import { access, appendFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createEmbeddedRuntime } from "../server/paseo-ui/embedded-runtime.mjs";
import { createSharedEmbeddedRuntime } from "../server/paseo-ui/embedded-worker.mjs";
import { createEmbeddedTimeline } from "../server/paseo-ui/embedded-timeline.mjs";
import { nativeHandoffArgs, nativeHandoffCommands } from "../server/paseo-ui/native-commands.mjs";
import { readRuntimeHandoff, recoverStaleEmbeddedHandoff, reserveRuntimeHandoff, returnEmbeddedHandoff, startEmbeddedHandoff } from "../server/paseo-ui/embedded-handoff.mjs";

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), "iris-embedded-paseo-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function waitFor(check) {
  for (let i = 0; i < 200; i++) {
    const value = await check();
    if (value) return value;
    await delay(10);
  }
  throw new Error("Expected Paseo state did not arrive");
}

test("committed timeline keeps rows and sequence order when opened again", async (t) => {
  const dir = await scratch(t);
  async function write(file, value) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify(value));
    await rename(`${file}.tmp`, file);
  }
  const first = createEmbeddedTimeline(dir, write);
  const earlier = { seq: 8, item: { type: "user_message", text: "hello" } };
  const later = { seq: 11, item: { type: "assistant_message", text: "initial" } };
  const updated = { ...later, item: { ...later.item, text: "changed" } };
  await Promise.all([first.bulkInsert("session", [later, earlier]), first.updateCommittedRow("session", updated)]);

  const reopened = createEmbeddedTimeline(dir, write);
  assert.deepEqual(await reopened.getCommittedRows("session"), [earlier, updated]);
  assert.equal(await reopened.getLatestCommittedSeq("session"), 11);
  assert.equal(await reopened.getLastAssistantMessage("session"), "changed");
  assert.deepEqual(await reopened.getLastItem("session"), updated.item);
  await reopened.deleteAgent("session");
  assert.deepEqual(await reopened.getCommittedRows("session"), []);
});

const runtimeFixture = process.env.PASEO_EMBEDDED_TEST_RUNTIME;
test("native-first reserves the selected UUID without loading the provider runtime", async (t) => {
  const cwd = await scratch(t);
  const stateDir = join(cwd, "state");
  const instance = createEmbeddedRuntime({ runtime: join(cwd, "absent-runtime"), stateDir });
  t.after(() => instance.close());
  const identity = { agentId: "11111111-1111-4111-8111-111111111111", provider: "gemini", cwd };
  const pane = { terminalId: "terminal", paneId: "pane" };
  const reserved = instance.prepareNativeFirst(identity, pane);
  const chat = assert.rejects(instance.ensureAgent(identity), /터미널 대화를 종료/);
  const owner = await reserved;
  await chat;
  assert.equal(owner.nativeFirst, true);
  assert.equal(await instance.canDispose(), true);
  assert.equal(owner.sessionId, identity.agentId);
  assert.equal((await readRuntimeHandoff(stateDir, identity.agentId)).phase, "reserved");
  await assert.rejects(instance.prepareNativeFirst(identity, pane), { code: "EEXIST" });
  await instance.abortTerminalRelease(identity.agentId, owner.token);
  assert.equal(await readRuntimeHandoff(stateDir, identity.agentId), null);
  const project = join(stateDir, "agents", "existing-project", "workspace");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, identity.agentId + ".json"), JSON.stringify({ id: identity.agentId }));
  await assert.rejects(instance.prepareNativeFirst(identity, pane), /이미 시작한/);
});

async function ptyShell(t, cwd, paneId = "pane", terminalId = "terminal") {
  const shell = spawn("/bin/sh", [], { cwd, stdio: ["pipe", "ignore", "ignore"] });
  t.after(() => shell.kill());
  const psDir = join(cwd, "bin");
  await mkdir(psDir, { recursive: true });
  await writeFile(join(psDir, "ps"), `#!/bin/sh
case "$*" in
  *"-t"*) printf ' ${shell.pid}\\n' ;;
  *"-p"*) printf ' ${shell.pid} fixture-tty\\n' ;;
esac
`, { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${psDir}${process.platform === "win32" ? ";" : ":"}${previousPath || ""}`;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
  const tty = "fixture-tty";
  const pane = { pane_id: paneId, terminal_id: terminalId, cwd };
  const processInfo = { shell_pid: shell.pid, foreground_process_group_id: shell.pid,
    foreground_processes: [{ pid: shell.pid, cwd }], tty };
  return {
    pane,
    processInfo,
    herdr: {
      async paneGet(id) { assert.equal(id, paneId); return pane; },
      async call(method, args) {
        assert.equal(args.pane_id, paneId);
        if (method === "pane.process_info") return { process_info: processInfo };
        if (method === "pane.send_input") return undefined;
        throw new Error(`unexpected ${method}`);
      },
    },
  };
}

test("handoff send failure rolls back a reserved owner while the original shell is still alive", async (t) => {
  const cwd = await scratch(t);
  const { pane, herdr: baseHerdr } = await ptyShell(t, cwd);
  let sent = 0;
  const herdr = {
    ...baseHerdr,
    async call(method, args) {
      if (method === "pane.send_input" && args.keys?.includes("Enter") && ++sent === 1) {
        const error = new Error("send failed");
        error.delivery = "not-delivered";
        throw error;
      }
      return baseHerdr.call(method, args);
    },
  };
  const agentId = "22222222-2222-4222-8222-222222222222";
  const record = { agentId, provider: "claude", terminalId: pane.terminal_id, cwd };
  const commandsPath = join(cwd, "commands.json");
  await writeFile(commandsPath, JSON.stringify({ claude: { resume: ["claude", "--resume", "{sessionId}"] } }));
  let owner;
  const runtime = {
    async describeHandle() { return { provider: "claude", sessionId: "session-id", persistenceId: "persisted", empty: false }; },
    async releaseForTerminal() {
      owner = await reserveRuntimeHandoff(cwd, agentId, { terminalId: pane.terminal_id, paneId: pane.pane_id,
        sessionId: "session-id", persistenceId: "persisted", empty: false });
      return owner;
    },
    async abortTerminalRelease(id, token) {
      assert.equal(id, agentId);
      assert.equal(token, owner.token);
      await import("node:fs/promises").then(({ unlink }) => unlink(owner.file));
    },
  };

  await assert.rejects(startEmbeddedHandoff({ runtime, record, paneId: pane.pane_id, herdr, commandsPath }), /send failed/);
  assert.equal(await readRuntimeHandoff(cwd, agentId), null);
});

test("a freshly dispatched handoff is not reclaimed before the native CLI can start", async (t) => {
  const cwd = await scratch(t);
  const previousStateDir = process.env.IRIS_STATE_DIR;
  process.env.IRIS_STATE_DIR = cwd;
  t.after(() => {
    if (previousStateDir === undefined) delete process.env.IRIS_STATE_DIR;
    else process.env.IRIS_STATE_DIR = previousStateDir;
  });
  const { pane, herdr } = await ptyShell(t, cwd);
  const agentId = "33333333-3333-4333-8333-333333333333";
  const record = { agentId, provider: "claude", terminalId: pane.terminal_id, cwd, build: "1.0.0-aaaaaaaaaaaa" };
  const handoffDir = join(cwd, "paseo-ui", "sessions", record.build);
  const owner = await reserveRuntimeHandoff(handoffDir, agentId, { terminalId: pane.terminal_id, paneId: pane.pane_id,
    sessionId: "session-id", persistenceId: "persisted", empty: false });
  await writeFile(owner.file, JSON.stringify({ ...owner, phase: "dispatched", dispatchedAt: Date.now() }));
  let aborted = 0;
  const runtime = { async abortTerminalRelease() { aborted++; } };

  assert.equal(await recoverStaleEmbeddedHandoff({ runtime, record, paneId: pane.pane_id, herdr }), false);
  assert.equal(aborted, 0);
  assert.equal((await readRuntimeHandoff(handoffDir, agentId)).phase, "dispatched");
});

test("stale dispatched handoff becomes exited so terminal history can be returned", async (t) => {
  const cwd = await scratch(t);
  const previousStateDir = process.env.IRIS_STATE_DIR;
  process.env.IRIS_STATE_DIR = cwd;
  t.after(() => {
    if (previousStateDir === undefined) delete process.env.IRIS_STATE_DIR;
    else process.env.IRIS_STATE_DIR = previousStateDir;
  });
  const { pane, herdr } = await ptyShell(t, cwd);
  const agentId = "33333333-3333-4333-8333-333333333333";
  const record = { agentId, provider: "claude", terminalId: pane.terminal_id, cwd, build: "1.0.0-aaaaaaaaaaaa" };
  const handoffDir = join(cwd, "paseo-ui", "sessions", record.build);
  const owner = await reserveRuntimeHandoff(handoffDir, agentId, { terminalId: pane.terminal_id, paneId: pane.pane_id,
    sessionId: "session-id", persistenceId: "persisted", empty: false });
  await writeFile(owner.file, JSON.stringify({ ...owner, phase: "dispatched", dispatchedAt: Date.now() - 10_000 }));
  let aborted = 0;
  const runtime = { async abortTerminalRelease(id, token) {
    assert.equal(id, agentId);
    assert.equal(token, owner.token);
    aborted++;
    throw new Error("a completed native CLI must not be aborted");
  } };

  assert.equal(await recoverStaleEmbeddedHandoff({ runtime, record, paneId: pane.pane_id, herdr }), true);
  assert.equal(aborted, 0);
  assert.equal((await readRuntimeHandoff(handoffDir, agentId)).phase, "exited");
});

test("a handoff whose pane disappeared is cleared instead of remaining dispatched", async (t) => {
  const cwd = await scratch(t);
  const previousStateDir = process.env.IRIS_STATE_DIR;
  process.env.IRIS_STATE_DIR = cwd;
  t.after(() => {
    if (previousStateDir === undefined) delete process.env.IRIS_STATE_DIR;
    else process.env.IRIS_STATE_DIR = previousStateDir;
  });
  const pane = { pane_id: "pane", terminal_id: "terminal" };
  const agentId = "55555555-5555-4555-8555-555555555555";
  const record = { agentId, provider: "claude", terminalId: pane.terminal_id, cwd, build: "1.0.0-aaaaaaaaaaaa" };
  const handoffDir = join(cwd, "paseo-ui", "sessions", record.build);
  const owner = await reserveRuntimeHandoff(handoffDir, agentId, { terminalId: pane.terminal_id, paneId: pane.pane_id,
    sessionId: "session-id", persistenceId: "persisted", empty: false });
  await writeFile(owner.file, JSON.stringify({ ...owner, phase: "dispatched", dispatchedAt: Date.now() - 10_000 }));
  let aborted = 0;
  const herdr = { async paneGet() { throw Object.assign(new Error("pane disappeared"), { code: "NOT_FOUND" }); } };
  const runtime = { async abortTerminalRelease(id, token) {
    assert.equal(id, agentId);
    assert.equal(token, owner.token);
    aborted++;
    await import("node:fs/promises").then(({ unlink }) => unlink(owner.file));
  } };

  assert.equal(await recoverStaleEmbeddedHandoff({ runtime, record, paneId: pane.pane_id, herdr }), true);
  assert.equal(aborted, 1);
  assert.equal(await readRuntimeHandoff(handoffDir, agentId), null);

  // Older records predate the shell startup handshake
  await writeFile(owner.file, JSON.stringify({ ...owner, phase: "dispatched" }));
  assert.equal(await recoverStaleEmbeddedHandoff({ runtime, record, paneId: pane.pane_id, herdr }), true);
  assert.equal((await readRuntimeHandoff(handoffDir, agentId))?.phase, "exited");
  assert.equal(aborted, 1);
});

test("a transient pane lookup failure does not reclaim a dispatched handoff", async (t) => {
  const cwd = await scratch(t);
  const previousStateDir = process.env.IRIS_STATE_DIR;
  process.env.IRIS_STATE_DIR = cwd;
  t.after(() => {
    if (previousStateDir === undefined) delete process.env.IRIS_STATE_DIR;
    else process.env.IRIS_STATE_DIR = previousStateDir;
  });
  const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const record = { agentId, provider: "claude", terminalId: "terminal", cwd, build: "1.0.0-aaaaaaaaaaaa" };
  const handoffDir = join(cwd, "paseo-ui", "sessions", record.build);
  const owner = await reserveRuntimeHandoff(handoffDir, agentId, { terminalId: record.terminalId, paneId: "pane",
    sessionId: "session-id", persistenceId: "persisted", empty: false });
  await writeFile(owner.file, JSON.stringify({ ...owner, phase: "dispatched", dispatchedAt: Date.now() - 10_000 }));
  const herdr = {
    async paneGet() { throw Object.assign(new Error("temporary socket error"), { code: "ENOENT" }); },
    async paneList() { throw Object.assign(new Error("temporary socket error"), { code: "ENOENT" }); },
  };
  const runtime = { async abortTerminalRelease() { throw new Error("transient failure must not abort"); } };

  assert.equal(await recoverStaleEmbeddedHandoff({ runtime, record, paneId: "pane", herdr }), false);
  assert.equal((await readRuntimeHandoff(handoffDir, agentId)).phase, "dispatched");
});

test("a running handoff can return after the pane disappears or changes directory", async (t) => {
  const previousStateDir = process.env.IRIS_STATE_DIR;
  t.after(() => {
    if (previousStateDir === undefined) delete process.env.IRIS_STATE_DIR;
    else process.env.IRIS_STATE_DIR = previousStateDir;
  });
  for (const mode of ["gone", "cwd"]) {
    const cwd = await scratch(t);
    process.env.IRIS_STATE_DIR = cwd;
    const other = join(cwd, "other");
    await mkdir(other);
    const agentId = mode === "gone" ? "77777777-7777-4777-8777-777777777777" : "88888888-8888-4888-8888-888888888888";
    const record = { agentId, provider: "claude", terminalId: "terminal", cwd, build: "1.0.0-aaaaaaaaaaaa" };
    const handoffDir = join(cwd, "paseo-ui", "sessions", record.build);
    const owner = await reserveRuntimeHandoff(handoffDir, agentId, { terminalId: record.terminalId, paneId: "pane",
      sessionId: "session-id", persistenceId: "persisted", empty: false });
    await writeFile(owner.file, JSON.stringify({ ...owner, phase: "running", startedAt: Date.now() - 10_000 }));
    const fixture = mode === "cwd" ? await ptyShell(t, cwd) : null;
    const processInfo = fixture ? { ...fixture.processInfo, foreground_processes: [{ pid: fixture.processInfo.shell_pid, cwd: other }] } : null;
    const herdr = mode === "gone" ? { async paneGet() { throw Object.assign(new Error("pane disappeared"), { code: "NOT_FOUND" }); } } : {
      async paneGet() { return { pane_id: "pane", terminal_id: "terminal" }; },
      async call() { return { process_info: processInfo }; },
    };
    let returned = 0;
    const runtime = { async returnFromTerminal(id, current, verify) {
      assert.equal(id, agentId);
      assert.equal(current.token, owner.token);
      await verify();
      returned++;
      await import("node:fs/promises").then(({ unlink }) => unlink(owner.file));
    } };

    assert.equal(await recoverStaleEmbeddedHandoff({ runtime, record, paneId: "pane", herdr }), true);
    assert.equal((await readRuntimeHandoff(handoffDir, agentId)).phase, "exited");
    assert.equal(await returnEmbeddedHandoff({ runtime, record, paneId: "pane", herdr }), true);
    assert.equal(returned, 1);
    assert.equal(await readRuntimeHandoff(handoffDir, agentId), null);
  }
});

test("a terminal command delivered after recovery is rejected before its child starts", async (t) => {
  const cwd = await scratch(t);
  const previousStateDir = process.env.IRIS_STATE_DIR;
  process.env.IRIS_STATE_DIR = cwd;
  t.after(() => {
    if (previousStateDir === undefined) delete process.env.IRIS_STATE_DIR;
    else process.env.IRIS_STATE_DIR = previousStateDir;
  });
  const { pane, herdr: baseHerdr } = await ptyShell(t, cwd);
  const agentId = "99999999-9999-4999-8999-999999999999";
  const record = { agentId, provider: "claude", terminalId: pane.terminal_id, cwd, build: "1.0.0-aaaaaaaaaaaa" };
  const marker = join(cwd, "late-command-ran");
  const commandsPath = join(cwd, "commands.json");
  await writeFile(commandsPath, JSON.stringify({ claude: { resume: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], 'ran')", marker, "{sessionId}"] } }));
  let command;
  let owner;
  const runtime = {
    async describeHandle() { return { provider: "claude", sessionId: "session-id", persistenceId: "persisted", empty: false }; },
    async releaseForTerminal() {
      owner = await reserveRuntimeHandoff(join(cwd, "paseo-ui", "sessions", record.build), agentId, { terminalId: pane.terminal_id, paneId: pane.pane_id,
        sessionId: "session-id", persistenceId: "persisted", empty: false });
      return owner;
    },
  };
  const herdr = { ...baseHerdr, async call(method, args) {
    if (method === "pane.send_input" && args.keys?.includes("Enter")) { command = args.text; return undefined; }
    return baseHerdr.call(method, args);
  } };
  await startEmbeddedHandoff({ runtime, record, paneId: pane.pane_id, herdr, commandsPath });
  await writeFile(owner.file, JSON.stringify({ ...owner, phase: "dispatched", dispatchedAt: Date.now() - 10_000 }));
  assert.equal(await recoverStaleEmbeddedHandoff({ runtime: { async abortTerminalRelease() { throw new Error("must not abort"); } }, record, paneId: pane.pane_id, herdr: baseHerdr }), true);
  const promptMarker = join(cwd, "shell-remained-alive");
  const shell = spawn("/bin/sh", [], { cwd, stdio: ["pipe", "ignore", "ignore"] });
  t.after(() => shell.kill());
  shell.stdin.write(`${command}\nprintf done > '${promptMarker}'\n`);
  for (let attempt = 0; attempt < 100 && !await access(promptMarker).then(() => true, () => false); attempt++) await delay(10);
  assert.equal(await access(marker).then(() => true, () => false), false);
  assert.equal(await access(promptMarker).then(() => true, () => false), true);
  assert.equal(shell.exitCode, null);
  assert.equal((await readRuntimeHandoff(join(cwd, "paseo-ui", "sessions", record.build), agentId)).phase, "exited");
});

test("normal terminal completion records exited without closing the interactive shell", async (t) => {
  const cwd = await scratch(t);
  const previousStateDir = process.env.IRIS_STATE_DIR;
  process.env.IRIS_STATE_DIR = cwd;
  t.after(() => {
    if (previousStateDir === undefined) delete process.env.IRIS_STATE_DIR;
    else process.env.IRIS_STATE_DIR = previousStateDir;
  });
  const { pane, herdr: baseHerdr } = await ptyShell(t, cwd);
  const agentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const record = { agentId, provider: "claude", terminalId: pane.terminal_id, cwd, build: "1.0.0-aaaaaaaaaaaa" };
  const marker = join(cwd, "native-command-ran");
  const promptMarker = join(cwd, "shell-remained-alive");
  const commandsPath = join(cwd, "commands.json");
  await writeFile(commandsPath, JSON.stringify({ claude: { resume: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], 'ran')", marker, "{sessionId}"] } }));
  let command;
  let owner;
  const runtime = {
    async describeHandle() { return { provider: "claude", sessionId: "session-id", persistenceId: "persisted", empty: false }; },
    async releaseForTerminal() {
      owner = await reserveRuntimeHandoff(join(cwd, "paseo-ui", "sessions", record.build), agentId, { terminalId: pane.terminal_id,
        paneId: pane.pane_id, sessionId: "session-id", persistenceId: "persisted", empty: false });
      return owner;
    },
  };
  const herdr = { ...baseHerdr, async call(method, args) {
    if (method === "pane.send_input" && args.keys?.includes("Enter")) { command = args.text; return undefined; }
    return baseHerdr.call(method, args);
  } };
  await startEmbeddedHandoff({ runtime, record, paneId: pane.pane_id, herdr, commandsPath });
  const shell = spawn("/bin/sh", [], { cwd, stdio: ["pipe", "ignore", "ignore"] });
  t.after(() => shell.kill());
  shell.stdin.write(`${command}\nprintf done > '${promptMarker}'\n`);
  for (let attempt = 0; attempt < 150 && !await access(marker).then(() => true, () => false); attempt++) await delay(10);
  assert.equal(await access(marker).then(() => true, () => false), true);
  for (let attempt = 0; attempt < 150; attempt++) {
    const recordExited = (await readRuntimeHandoff(join(cwd, "paseo-ui", "sessions", record.build), agentId))?.phase === "exited";
    if (recordExited && await access(promptMarker).then(() => true, () => false)) break;
    await delay(10);
  }
  assert.equal((await readRuntimeHandoff(join(cwd, "paseo-ui", "sessions", record.build), agentId)).phase, "exited");
  assert.equal(await access(promptMarker).then(() => true, () => false), true);
  assert.equal(shell.exitCode, null);
  assert.equal(owner.token.length > 0, true);
});

test("an ambiguous pane send rejection keeps the handoff guarded against late delivery", async (t) => {
  const cwd = await scratch(t);
  const { pane, herdr: baseHerdr } = await ptyShell(t, cwd);
  const agentId = "66666666-6666-4666-8666-666666666666";
  const record = { agentId, provider: "claude", terminalId: pane.terminal_id, cwd };
  const commandsPath = join(cwd, "commands.json");
  await writeFile(commandsPath, JSON.stringify({ claude: { resume: ["claude", "--resume", "{sessionId}"] } }));
  let owner;
  const runtime = {
    async describeHandle() { return { provider: "claude", sessionId: "session-id", persistenceId: "persisted", empty: false }; },
    async releaseForTerminal() {
      owner = await reserveRuntimeHandoff(cwd, agentId, { terminalId: pane.terminal_id, paneId: pane.pane_id,
        sessionId: "session-id", persistenceId: "persisted", empty: false });
      return owner;
    },
    async abortTerminalRelease() { throw new Error("ambiguous delivery must not be revoked"); },
  };
  const herdr = {
    ...baseHerdr,
    async call(method, args) {
      if (method === "pane.send_input" && args.keys?.includes("Enter")) throw new Error("transport closed after write");
      return baseHerdr.call(method, args);
    },
  };

  await assert.rejects(startEmbeddedHandoff({ runtime, record, paneId: pane.pane_id, herdr, commandsPath }), /transport closed/);
  const handoff = await readRuntimeHandoff(cwd, agentId);
  assert.equal(handoff.phase, "dispatched");
  assert.match(handoff.dispatchedAt.toString(), /^\d+$/);
});

test("native launches retain original templates and the Gemini catalog CLI version", () => {
  const commands = nativeHandoffCommands({ claude: ["claude", "--resume", "{sessionId}"] }, {
    gemini: { command: ["npx", "-y", "@google/gemini-cli@0.65.0", "--acp"] },
  }, { antigravity: "antigravity-provider" });
  assert.deepEqual(nativeHandoffArgs("gemini", "id-a", false, commands), ["npx", "-y", "@google/gemini-cli@0.65.0", "--resume", "id-a"]);
  assert.deepEqual(nativeHandoffArgs("claude", "id-b", true, commands), ["claude", "--session-id", "id-b"]);
  assert.deepEqual(nativeHandoffArgs("antigravity", "id-c", false, commands), ["agy", "--conversation", "id-c"]);
  assert.equal(nativeHandoffArgs("antigravity", "id-c", true, commands), null);
  assert.equal(nativeHandoffCommands({}, { gemini: { command: ["npx", "-y", "@google/gemini-cli@latest", "--acp"] } }).gemini, undefined);
});

test("유휴 worker 종료가 응답하지 않아도 다음 호출은 새 worker로 재개", async (t) => {
  const workers = [];
  const workerFactory = () => {
    const worker = new EventEmitter();
    worker.terminated = false;
    worker.postMessage = ({ id, method }) => {
      if (method === "close" && workers.length === 1) return;
      queueMicrotask(() => worker.emit("message", { id, value: method === "canDispose" }));
    };
    worker.terminate = async () => {
      worker.terminated = true;
      worker.emit("exit", 0);
    };
    workers.push(worker);
    return worker;
  };
  const runtime = createSharedEmbeddedRuntime({ runtime: "/tmp/unused-paseo-runtime", stateDir: "/tmp/unused-paseo-state" }, { workerFactory, idleMs: 5 });
  t.after(() => runtime.close());

  await runtime.ensureAgent("44444444-4444-4444-8444-444444444444");
  for (let i = 0; i < 400 && !workers[0]?.terminated; i++) await delay(10);
  assert.equal(workers[0]?.terminated, true);
  await runtime.ensureAgent("44444444-4444-4444-8444-444444444444");
  assert.equal(workers.length, 2);
});

test("original ACP session streams, waits for permission and reopens its persisted transcript", { skip: !runtimeFixture }, async (t) => {
  const dir = await scratch(t);
  const runtime = join(dir, "runtime");
  const stateDir = join(dir, "state");
  const fixture = join(dir, "fixture.mjs");
  const invocations = join(dir, "invocations.txt");
  const history = join(dir, "native-history.json");
  const environment = join(dir, "environment.json");
  await mkdir(runtime);
  await appendFile(invocations, "");
  await Promise.all([
    symlink(join(resolve(runtimeFixture), "node_modules"), join(runtime, "node_modules"), "junction"),
    symlink(join(resolve(runtimeFixture), "embedded-providers.mjs"), join(runtime, "embedded-providers.mjs")),
    writeFile(fixture, ACP_FIXTURE),
  ]);
  await writeFile(join(runtime, "provider-overrides.json"), JSON.stringify({
    gemini: { extends: "acp", label: "Iris ACP test", command: [process.execPath, fixture, invocations, history, environment] },
  }));

  const identity = { agentId: "11111111-1111-4111-8111-111111111111", provider: "gemini", cwd: dir, workspaceId: "workspace-id",
    env: { HERDR_PANE_ID: "test-pane", IRIS_HERDR_SESSION: "test-session", IRIS_EMBEDDED_FIXTURE_UNTRUSTED: "discarded" } };
  const first = createEmbeddedRuntime({ runtime, stateDir });
  t.after(() => first.close());
  const observed = [];
  const unsubscribe = first.subscribe(identity.agentId, (event) => observed.push(event));
  await Promise.all([first.ensureAgent(identity), first.ensureAgent(identity)]);
  assert.equal(await first.canDispose(), false);
  const openedSessions = async () => (await readFile(invocations, "utf8")).split("\n")
    .filter((entry) => entry === "interactive" || entry === "load");
  assert.deepEqual(await openedSessions(), ["interactive"]);
  await assert.rejects(first.ensureAgent({ ...identity, workspaceId: "other" }), /일치하지 않습니다/);
  await first.setSetting(identity.agentId, "config", { modeId: "review" });
  assert.ok((await readFile(invocations, "utf8")).split("\n").includes("mode:review"));
  await assert.rejects(first.setSetting(identity.agentId, "config", { modeId: 42 }));
  await first.sendMessage(identity.agentId, "hello");
  const permission = await waitFor(async () => (await first.snapshot(identity.agentId)).permissions[0]);
  assert.deepEqual(JSON.parse(await readFile(environment, "utf8")), { pane: "test-pane", session: "test-session" });
  const beforeReply = await first.getTimeline(identity.agentId);
  assert.ok(beforeReply.some((item) => item.type === "assistant_message" && item.text.includes("hello")));
  assert.equal(await first.release(identity.agentId), false);
  const pendingHandle = await first.describeHandle(identity.agentId);
  await assert.rejects(first.releaseForTerminal(identity.agentId, pendingHandle), /응답 또는 질문이 끝난 뒤/);
  await first.respondToPermission(identity.agentId, permission.id, { behavior: "allow", selectedActionId: "allow" });
  await waitFor(() => observed.some((event) => event.event?.type === "turn_completed"));
  await waitFor(async () => (await first.snapshot(identity.agentId)).status === "idle");
  unsubscribe();
  await waitFor(() => first.release(identity.agentId));
  assert.equal(await first.canDispose(), true);
  assert.equal((await first.snapshot(identity.agentId)).status, "closed");
  await first.close();

  const second = createEmbeddedRuntime({ runtime, stateDir });
  t.after(() => second.close());
  const restored = await second.snapshot(identity.agentId);
  assert.equal(restored.status, "closed");
  assert.ok(restored.timeline.some((item) => item.type === "assistant_message" && item.text.includes("selected allow")));
  assert.deepEqual(restored.permissions, []);
  assert.deepEqual(await openedSessions(), ["interactive"]);
  await second.ensureAgent(identity);
  assert.deepEqual(await openedSessions(), ["interactive", "load"]);
  assert.deepEqual((await second.snapshot(identity.agentId)).timeline, restored.timeline);

  const handle = await second.describeHandle(identity.agentId);
  const owner = await waitFor(async () => {
    try { return await second.releaseForTerminal(identity.agentId, { ...handle, terminalId: "test-terminal" }); }
    catch (error) { if (/실행 상태가 변경|응답 또는 질문이 끝난 뒤/.test(error.message)) return null; throw error; }
  });
  await assert.rejects(second.sendMessage(identity.agentId, "must not run"), /터미널 대화를 종료/);
  await assert.rejects(second.ensureAgent(identity), /터미널 대화를 종료/);
  await writeFile(owner.file, JSON.stringify({ ...owner, phase: "dispatched" }));
  await writeFile(history, JSON.stringify(["hello", "previous reply", "native only", "native reply"]));
  const handoff = fileURLToPath(new URL("../server/paseo-ui/embedded-handoff.mjs", import.meta.url));
  await promisify(execFile)(process.execPath, [handoff, "--terminal-exited", owner.file, owner.token]);
  await second.returnFromTerminal(identity.agentId, owner, async () => true);
  const merged = await second.getTimeline(identity.agentId);
  assert.deepEqual(merged.filter((item) => item.type === "user_message").map(({ text }) => text), ["hello", "native only"]);
  assert.ok(merged.some((item) => item.type === "assistant_message" && item.text.includes("native reply")));
  await second.ensureAgent(identity);
  assert.equal((await second.describeHandle(identity.agentId)).sessionId, handle.sessionId);
  assert.deepEqual(await second.getTimeline(identity.agentId), merged);
});

const ACP_FIXTURE = String.raw`
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const receipt = process.argv[2];
const history = process.argv[3];
const environment = process.argv[4];
const sessionId = "fixture-session";
const input = createInterface({ input: process.stdin });
const write = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
const update = (value) => write({ method: "session/update", params: { sessionId, update: value } });
const chunk = (text) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
let promptId;
input.on("line", (line) => {
  const { method, id, params, result } = JSON.parse(line);
  if (method === "initialize") write({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  else if (method === "session/new") {
    appendFileSync(receipt, process.env.HERDR_PANE_ID === "test-pane" ? "interactive\n" : "probe\n");
    write({ id, result: { sessionId, modes: { currentModeId: "normal", availableModes: [
      { id: "normal", name: "Normal" }, { id: "review", name: "Review" }
    ] } } });
  } else if (method === "session/set_mode") {
    appendFileSync(receipt, "mode:" + params.modeId + "\n");
    write({ id, result: {} });
  } else if (method === "session/load") {
    if (params.sessionId !== sessionId) throw new Error("Wrong persisted provider session");
    appendFileSync(receipt, "load\n");
    if (existsSync(history)) {
      update({sessionUpdate:"user_message_chunk",content:{type:"text",text:"<session_context>\nThis is the Gemini CLI. We are setting up the context for our chat.\nThe test fixture workspace.\n</session_context>"}});
      const turns = JSON.parse(readFileSync(history, "utf8"));
      for (let index = 0; index < turns.length; index++) {
        update({ sessionUpdate: index % 2 === 0 ? "user_message_chunk" : "agent_message_chunk", content: { type: "text", text: turns[index] } });
      }
    }
    write({ id, result: {} });
  } else if (method === "session/prompt") {
    promptId = id;
    writeFileSync(environment, JSON.stringify({ pane: process.env.HERDR_PANE_ID,
      session: process.env.IRIS_HERDR_SESSION, untrusted: process.env.IRIS_EMBEDDED_FIXTURE_UNTRUSTED }));
    chunk(params.prompt[0].text + ". ");
    const toolCall = { toolCallId: "tool", title: "Read fixture", kind: "read", status: "pending" };
    update({ sessionUpdate: "tool_call", ...toolCall });
    write({ id: "permission", method: "session/request_permission", params: { sessionId, toolCall,
      options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }] } });
  } else if (!method && id === "permission") {
    update({ sessionUpdate: "tool_call_update", toolCallId: "tool", status: "completed" });
    chunk(result.outcome.outcome + " " + result.outcome.optionId);
    write({ id: promptId, result: { stopReason: "end_turn" } });
  }
});
`;
