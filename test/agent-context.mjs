import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchContext } from "../bin/agent-context.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iris-agent-context-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const brief = path.join(root, "brief.md");
  fs.writeFileSync(brief, "Inspect the assigned fixture and write findings to result.md. Read-only outside this folder.");
  const parent = { pane_id: "w1:p1", terminal_id: "term_parent", workspace_id: "w1", agent: "codex" };
  const child = { pane_id: "w1:p2", terminal_id: "term_child", workspace_id: "w1" };
  const calls = [];
  const records = [];
  const options = { id: "inspect", runtime: "codex", model: "test-model", effort: "low", reason: "independent-work", brief, cwd: root };
  const deps = {
    env: { HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: path.join(root, "herdr.sock"), CODEX_THREAD_ID: "parent-session", CODEX_SESSION_ID: "parent-session" },
    socketPath: path.join(root, "herdr.sock"), stateDir: path.join(root, "state"), ancestors: new Set([123]),
    executable: (name) => "/usr/local/bin/" + name,
    resolveSession: async () => ({uuid: "codex-child-session"}), sleep: async () => {},
    client: { paneGet: async () => parent, call: async () => ({ process_info: { foreground_processes: [{ pid: 123, name: "codex" }] } }) },
    start: async (args) => { calls.push(args); return { agent: child }; },
    writeLineage: (record) => { records.push(record); return path.join(root, "lineage.json"); },
  };
  return { root, parent, child, calls, records, options, deps };
}

test("launch binds both exact terminal identities and returns a compact receipt", async (t) => {
  const f = fixture(t);
  const result = await launchContext(f.options, f.deps);
  assert.equal(result.status, "launched");
  assert.equal(f.calls.length, 1);
  assert.equal(f.records.length, 1);
  assert.equal(f.records[0].parent.terminalId, "term_parent");
  assert.equal(f.records[0].parent.sessionId, "parent-session");
  assert.equal(f.records[0].child.terminalId, "term_child");
  assert.equal(f.records[0].child.sessionId, "codex-child-session");
  assert.equal(f.calls[0].includes("--no-focus"), true);
  assert.equal(f.calls[0].includes("--dangerously-bypass-approvals-and-sandbox"), false);
  assert.equal(JSON.stringify(result).includes("Inspect the assigned fixture"), false);
});

test("same job and inputs return the receipt without creating another child", async (t) => {
  const f = fixture(t);
  const first = await launchContext(f.options, f.deps);
  const second = await launchContext(f.options, f.deps);
  assert.equal(f.calls.length, 1);
  assert.equal(second.reused, true);
  assert.equal(second.child.paneId, first.child.paneId);
  await assert.rejects(launchContext({ ...f.options, model: "other" }, f.deps), /different inputs/);
  assert.equal(f.calls.length, 1);
});

test("preview verifies the parent but neither creates state nor launches", async (t) => {
  const f = fixture(t);
  const result = await launchContext({ ...f.options, dryRun: true }, f.deps);
  assert.equal(result.status, "preview");
  assert.equal(f.calls.length, 0);
  assert.equal(f.records.length, 0);
  assert.equal(fs.existsSync(f.deps.stateDir), false);
});

test("wrong socket, missing identity and native child context cannot launch", async (t) => {
  const f = fixture(t);
  await assert.rejects(launchContext(f.options, { ...f.deps, socketPath: "/other/herdr.sock" }), /socket/);
  await assert.rejects(launchContext(f.options, { ...f.deps, ancestors: new Set([999]) }), /does not belong/);
  await assert.rejects(launchContext(f.options, { ...f.deps, env: { ...f.deps.env, CODEX_THREAD_ID: "child-session" } }), /native subagent/);
  assert.equal(f.calls.length, 0);
});

test("uncertain creation is recorded and cannot be blindly replayed", async (t) => {
  const f = fixture(t);
  let sends = 0;
  f.deps.start = async () => { sends++; throw new Error("timeout"); };
  await assert.rejects(launchContext(f.options, f.deps), /Launch uncertain/);
  await assert.rejects(launchContext(f.options, f.deps), /Previous launch is uncertain/);
  assert.equal(sends, 1);
});

test("lineage failure retains child identity and does not create another child", async (t) => {
  const f = fixture(t);
  f.deps.writeLineage = () => { throw new Error("disk unavailable"); };
  await assert.rejects(launchContext(f.options, f.deps), /created_unlinked/);
  await assert.rejects(launchContext(f.options, f.deps), /Previous launch is created_unlinked/);
  assert.equal(f.calls.length, 1);
  const dir = path.join(f.deps.stateDir, "agent-context");
  const folder = path.join(dir, fs.readdirSync(dir)[0]);
  const receipt = JSON.parse(fs.readFileSync(path.join(folder, fs.readdirSync(folder)[0]), "utf8"));
  assert.equal(receipt.child.terminalId, "term_child");
});

test("overlapping launches with the same job id produce at most one child", async (t) => {
  const f = fixture(t);
  let release;
  f.deps.start = async () => { f.calls.push("start"); await new Promise((r) => { release = r; }); return { agent: f.child }; };
  const first = launchContext(f.options, f.deps);
  await new Promise((r) => setImmediate(r));
  await assert.rejects(launchContext(f.options, f.deps), /Previous launch is launching/);
  release();
  await first;
  assert.equal(f.calls.length, 1);
});

test("Claude launch gets its own known session id and explicit effort", async (t) => {
  const f = fixture(t);
  const result = await launchContext({ ...f.options, runtime: "claude", model: "sonnet", effort: "high" }, f.deps);
  const args = f.calls[0];
  assert.equal(args[args.indexOf("--session-id") + 1], result.child.sessionId);
  assert.equal(args[args.indexOf("--effort") + 1], "high");
  assert.equal(args.includes("--dangerously-skip-permissions"), false);
});

test("Codex identity is bound after startup and missing identity preserves the created pane", async (t) => {
  const f = fixture(t);
  let attempts = 0;
  f.deps.resolveSession = async () => { attempts++; return null; };
  await assert.rejects(launchContext(f.options, f.deps), /created_unlinked/);
  assert.equal(attempts, 8);
  assert.equal(f.calls.length, 1);
  assert.equal(f.records.length, 0);
  await assert.rejects(launchContext(f.options, f.deps), /Previous launch is created_unlinked/);
  assert.equal(f.calls.length, 1);
});

test("Claude parents use the canonical session environment and reject a mismatched live session", async (t) => {
  const f = fixture(t);
  f.parent.agent = "claude";
  f.deps.env.CLAUDE_CODE_SESSION_ID = "claude-parent-session";
  f.deps.client.call = async () => ({process_info: {foreground_processes: [{pid: 123, name: "claude"}]}});
  const result = await launchContext({...f.options, runtime: "claude", effort: "xhigh"}, f.deps);
  assert.equal(result.parent.sessionId, "claude-parent-session");
  f.parent.agent_session = {value: "another-session"};
  await assert.rejects(launchContext({...f.options, id: "different"}, f.deps), /does not match/);
  assert.equal(f.calls.length, 1);
});
