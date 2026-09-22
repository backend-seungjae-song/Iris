import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  attachAgentLineage, readAgentLineage, watchAgentLineage, writeAgentLineage,
} from "../server/agent-lineage.js";

function fixture(t, name = "lineage") {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `iris-${name}-`));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  return { stateDir, socketPath: path.join(stateDir, "herdr.sock") };
}

function endpoint(paneId, terminalId, runtime, sessionId) {
  return { paneId, terminalId, runtime, ...(sessionId ? { sessionId } : {}) };
}

function record(options, overrides = {}) {
  return {
    version: 1,
    socketPath: options.socketPath,
    parent: endpoint("w1:p1", "term_parent", "codex", "parent-session"),
    child: endpoint("w1:p2", "term_child", "claude", "child-session"),
    createdAt: 1,
    reason: "delegated task",
    label: "inspect tests",
    ...overrides,
  };
}

function live() {
  return [
    { terminal_id: "term_parent", pane_id: "w1:p1", workspace_id: "w1", agent: "codex" },
    { terminal_id: "term_child", pane_id: "w1:p2", workspace_id: "w1", agent: "claude" },
  ];
}

function state() {
  return [
    { terminalId: "term_parent", paneId: "w1:p1", workspaceId: "w1", agent: "codex", sessionUuid: "parent-session" },
    { terminalId: "term_child", paneId: "w1:p2", workspaceId: "w1", agent: "claude", sessionUuid: "child-session" },
  ];
}

test("writes one socket-scoped receipt and retries only the same lineage identity", (t) => {
  const options = fixture(t);
  const first = record(options);
  const file = writeAgentLineage(first, options);
  assert.equal(path.basename(file), "term_child.json");
  assert.equal(readAgentLineage(options).length, 1);

  writeAgentLineage({ ...first, createdAt: 2, label: "updated label" }, options);
  assert.equal(readAgentLineage(options)[0].label, "updated label");
  assert.throws(() => writeAgentLineage({
    ...first,
    parent: endpoint("w1:p9", "term_other_parent", "codex", "other-session"),
  }, options), /conflict/);
  assert.throws(() => writeAgentLineage({
    ...first,
    parent: endpoint("w1:p1", "term_parent", "codex"),
  }, options), /conflict/);
  assert.throws(() => writeAgentLineage({
    ...first,
    child: endpoint("w1:p2", "term_child", "claude", "replacement-session"),
  }, options), /conflict/);
  assert.equal(readAgentLineage(options)[0].parent.terminalId, "term_parent");
});

test("bounded reads open only receipts for currently live child terminals", (t) => {
  const options = fixture(t);
  writeAgentLineage(record(options), options);
  writeAgentLineage(record(options, {
    child: endpoint("w1:p3", "term_old_child", "claude", "old-session"),
  }), options);
  assert.deepEqual(readAgentLineage({ ...options, terminalIds: ["term_child"] }).map((r) => r.child.terminalId), ["term_child"]);
  assert.deepEqual(readAgentLineage({ ...options, terminalIds: ["term_missing"] }), []);
});

test("stat watcher observes an immediate publish and close stops later delivery", async (t) => {
  const options = fixture(t, "lineage-watch");
  let deliveries = 0;
  let watcher;
  const delivered = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("lineage watcher did not observe publish")), 2_000);
    watcher = watchAgentLineage(() => {
      deliveries++;
      clearTimeout(timeout);
      resolve();
    }, options);
  });
  t.after(() => watcher.close());
  writeAgentLineage(record(options), options);
  await delivered;
  assert.equal(deliveries, 1);
  assert.equal(readAgentLineage(options).length, 1);
  watcher.close();
  writeAgentLineage({ ...record(options), createdAt: 2, label: "after close" }, options);
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.equal(deliveries, 1);
});

test("ignores wrong-socket and malformed receipts", (t) => {
  const options = fixture(t);
  const validFile = writeAgentLineage(record(options), options);

  const wrongSocket = { ...options, socketPath: path.join(options.stateDir, "other.sock") };
  assert.deepEqual(readAgentLineage(wrongSocket), []);

  const dir = path.dirname(writeAgentLineage({ ...record(options), createdAt: 2 }, options));
  fs.writeFileSync(path.join(dir, "broken.json"), "{broken", "utf8");
  fs.writeFileSync(path.join(dir, "wrong-name.json"), JSON.stringify(record(options)), "utf8");
  assert.equal(readAgentLineage(options).length, 1);

  fs.writeFileSync(validFile, JSON.stringify({ ...record(options), socketPath: wrongSocket.socketPath }), "utf8");
  assert.deepEqual(readAgentLineage(options), []);
});

test("attaches only a currently matching terminal, workspace, runtime, and session", (t) => {
  const options = fixture(t);
  writeAgentLineage(record(options), options);
  const current = state();
  assert.equal(attachAgentLineage(current, live(), options), current);
  assert.deepEqual(current[1], {
    terminalId: "term_child", paneId: "w1:p2", workspaceId: "w1", agent: "claude", sessionUuid: "child-session",
    parentPaneId: "w1:p1", parentSessionUuid: "parent-session", lineageReason: "delegated task", lineageLabel: "inspect tests",
  });

  const cases = [
    live().filter((a) => a.terminal_id !== "term_parent"),
    live().map((a) => a.terminal_id === "term_child" ? { ...a, workspace_id: "w2" } : a),
    live().map((a) => a.terminal_id === "term_child" ? { ...a, pane_id: "w1:p8" } : a),
    live().map((a) => a.terminal_id === "term_parent" ? { ...a, agent: "claude" } : a),
  ];
  for (const raw of cases) {
    const next = state();
    attachAgentLineage(next, raw, options);
    assert.equal(next[1].parentPaneId, null);
  }

  const reused = state();
  reused[0].sessionUuid = "replacement-session";
  attachAgentLineage(reused, live(), options);
  assert.equal(reused[1].parentPaneId, null);

  const missingParentSession = state();
  missingParentSession[0].sessionUuid = null;
  attachAgentLineage(missingParentSession, live(), options);
  assert.equal(missingParentSession[1].parentPaneId, null);

  const missingChildSession = state();
  missingChildSession[1].sessionUuid = null;
  attachAgentLineage(missingChildSession, live(), options);
  assert.equal(missingChildSession[1].parentPaneId, null);
});

test("supports nested explicit lineage and rejects cycles", (t) => {
  const options = fixture(t);
  writeAgentLineage(record(options), options);
  writeAgentLineage(record(options, {
    parent: endpoint("w1:p2", "term_child", "claude", "child-session"),
    child: endpoint("w1:p3", "term_grandchild", "codex", "grandchild-session"),
    label: "nested job",
  }), options);
  const raw = [...live(), { terminal_id: "term_grandchild", pane_id: "w1:p3", workspace_id: "w1", agent: "codex" }];
  const normalized = [...state(), { terminalId: "term_grandchild", paneId: "w1:p3", workspaceId: "w1", agent: "codex", sessionUuid: "grandchild-session" }];
  attachAgentLineage(normalized, raw, options);
  assert.equal(normalized[1].parentPaneId, "w1:p1");
  assert.equal(normalized[2].parentPaneId, "w1:p2");

  const cyclicOptions = fixture(t, "lineage-cycle");
  writeAgentLineage(record(cyclicOptions, {
    parent: endpoint("w1:p2", "term_child", "claude", "child-session"),
    child: endpoint("w1:p1", "term_parent", "codex", "parent-session"),
  }), cyclicOptions);
  writeAgentLineage(record(cyclicOptions), cyclicOptions);
  const cyclic = state();
  attachAgentLineage(cyclic, live(), cyclicOptions);
  assert.equal(cyclic[0].parentPaneId, null);
  assert.equal(cyclic[1].parentPaneId, null);
});
