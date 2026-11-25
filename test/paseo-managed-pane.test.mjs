import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { managedPane, reserveManagedPane } from "../server/paseo-ui/managed-pane.js";

test("기존 pane과 충돌하거나 상태 파일이 손상되면 새 대화를 만들지 않는다", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iris-pane-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const build = "0.17.4-12345678";
  assert.equal(managedPane("old", root), null);
  const a = reserveManagedPane("one", "codex", build, root);
  const b = reserveManagedPane("two", "claude", build, root);
  assert.notEqual(a.socketPath, b.socketPath);
  assert.throws(() => reserveManagedPane("one", "codex", build, root));
  assert.equal(managedPane("one", root).agentId, null);
  const state = path.join(a.stateDir, "state.json");
  fs.writeFileSync(state, JSON.stringify({ paneId: "one", provider: "codex", agentId: "thread-a", workspaceId: "ws", serverId: "host" }));
  assert.equal(managedPane("one", root).agentId, "thread-a");
  assert.equal(managedPane("two", root).agentId, null);
  fs.writeFileSync(state, "{");
  assert.throws(() => managedPane("one", root));
});

test("pane 번호가 바뀌어도 같은 terminal만 원래 세션을 찾는다", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iris-pane-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const record = reserveManagedPane("original", "gemini", "0.17.4-12345678", root, "term_123");
  fs.writeFileSync(path.join(record.stateDir, "state.json"), JSON.stringify({ paneId: "original", provider: "gemini", agentId: "one" }));
  assert.equal(managedPane("new", root, "term_123").agentId, "one");
  assert.equal(managedPane("original", root, "term_456"), null);
});

test("기존 관리 세션은 저장한 릴리스의 런타임을 찾는다", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iris-release-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prev = process.env.IRIS_STATE_DIR;
  process.env.IRIS_STATE_DIR = root;
  t.after(() => { if (prev === undefined) delete process.env.IRIS_STATE_DIR; else process.env.IRIS_STATE_DIR = prev; });
  const dir = path.join(root, "paseo-ui");
  const build = "0.17.4-aaaabbbb";
  const runtime = "0.17.4-bbbbcccc";
  fs.mkdirSync(path.join(dir, "releases"), { recursive: true });
  fs.mkdirSync(path.join(dir, "builds", build), { recursive: true });
  fs.mkdirSync(path.join(dir, "runtimes", runtime), { recursive: true });
  fs.writeFileSync(path.join(dir, "current.json"), JSON.stringify({ current: { version: "0.17.4", recipe: "aaaabbbb" }, checkedAt: Date.now() }));
  fs.writeFileSync(path.join(dir, "releases", build + ".json"), JSON.stringify({ runtime }));
  fs.writeFileSync(path.join(dir, "runtimes", runtime, "providers.json"), JSON.stringify([{ id: "gemini", label: "Gemini CLI" }]));
  fs.writeFileSync(path.join(dir, "builds", build, "terminal-commands.json"), JSON.stringify(["pi"]));
  const embedded = path.join(dir, "embedded", build);
  fs.mkdirSync(embedded, { recursive: true });
  fs.writeFileSync(path.join(embedded, "providers.json"), JSON.stringify([{ id: "future-cli", label: "Future CLI" }]));
  fs.writeFileSync(path.join(embedded, "native-handoff-commands.json"), "{}");
  const { releasedRuntime, initPaseoUi, stopPaseoUi, sessionTerminalArgv, paseoUiStatus } = await import("../server/paseo-ui/index.js");
  initPaseoUi();
  t.after(stopPaseoUi);
  assert.deepEqual(sessionTerminalArgv("pi"), ["pi"]);
  assert.deepEqual(sessionTerminalArgv("codex"), ["codex"]);
  assert.deepEqual(paseoUiStatus().chatProviders, ["future-cli"]);
  assert.equal(sessionTerminalArgv("future-cli"), null);
  assert.equal(sessionTerminalArgv("unknown-provider"), null);
  assert.equal(releasedRuntime(build, root).dir, path.join(dir, "runtimes", runtime));

});

test("herdr 복원 후 새 terminal ID만 저장된 세션에 연결된다", async (t) => {
  const { bindRestoredTerminal } = await import("../server/paseo-ui/managed-binding.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iris-restore-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = reserveManagedPane("one", "codex", "0.17.4-12345678", root, "original");
  const other = reserveManagedPane("two", "codex", "0.17.4-12345678", root, "other");
  assert.throws(() => bindRestoredTerminal(first.stateDir, "other"));
  bindRestoredTerminal(first.stateDir, "restored");
  bindRestoredTerminal(first.stateDir, "restored");
  assert.throws(() => bindRestoredTerminal(other.stateDir, "restored"));
  fs.writeFileSync(path.join(first.stateDir, "state.json"), JSON.stringify({ paneId: "one", provider: "codex", terminalId: "restored", agentId: "saved" }));
  assert.equal(managedPane("one", root, "original"), null);
  assert.equal(managedPane("three", root, "restored").agentId, "saved");
});
