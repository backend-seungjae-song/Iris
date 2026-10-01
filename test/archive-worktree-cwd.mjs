import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "iris-archive-worktree-"));
process.env.IRIS_STATE_DIR = path.join(root, "state");
const archive = await import("../server/archive.js");
const { initArchiveHandlers, handleArchive } = await import("../server/archive-handlers.js");
const { initRuntimeState, replace } = await import("../server/runtime-state.js");
test.after(() => { archive.flushNow(); fs.rmSync(root, { recursive: true, force: true }); });

function fixture({ live = false, paneList, paneSendText } = {}) {
  for (const item of archive.list()) archive.remove(item.id);
  archive.flushNow();
  const base = path.join(root, "base"), cwd = path.join(root, "work tree ' $(false)");
  fs.mkdirSync(base, { recursive: true }); fs.mkdirSync(cwd, { recursive: true });
  const calls = [], messages = [];
  let completed;
  initRuntimeState({ scheduleRecompute: async () => completed?.() });
  replace({ state: [], workspaces: live ? [{ id: "live", folder: base }] : [], tabs: {} });
  initArchiveHandlers({ broadcast() {}, herdr: {
    paneList: paneList || (async () => [{ pane_id: "old-pane", tab_id: "old-tab", cwd }]),
    workspaceClose: async (id) => calls.push(["close", id]),
    workspaceCreate: async (options) => { calls.push(["workspace", options]); return {
      workspace: { workspace_id: "restored" }, tab: { tab_id: "spare-tab" }, root_pane: { pane_id: "spare-pane", cwd: base },
    }; },
    tabCreate: async (id) => { calls.push(["tab", id]); return { tab: { tab_id: "new-tab" }, root_pane: { pane_id: "new-pane", cwd: base } }; },
    tabRename: async (...args) => calls.push(["rename", ...args]),
    paneSendText: async (...args) => { calls.push(["send", ...args]); if (paneSendText) await paneSendText(...args); },
  } });
  const ws = { _local: true, send: (message) => { const parsed = JSON.parse(message); messages.push(parsed); if (["archive-restored", "archive-error"].includes(parsed.type)) completed?.(); } };
  const dispatch = (msg) => new Promise((resolve) => { completed = resolve; handleArchive(ws, msg); });
  return { base, cwd, calls, messages, dispatch };
}

test("스페이스 보관과 복원은 워크트리 터미널의 폴더를 유지한다", async () => {
  const f = fixture();
  replace({ workspaces: [{ id: "old", folder: f.base, label: "project" }], tabs: { old: [{ tabId: "old-tab", label: "work terminal" }] } });
  await f.dispatch({ type: "archive.space", workspaceId: "old" });
  const head = archive.list().find((entry) => entry.kind === "space");
  assert.equal(head.tabs[0].cwd, f.cwd);
  replace({ workspaces: [], tabs: {} });
  await f.dispatch({ type: "archive.restore", id: head.id });
  const send = f.calls.find((call) => call[0] === "send");
  assert.equal(send?.[1], "spare-pane");
  assert.equal(execFileSync("/bin/zsh", ["-c", send[2].trim() + " && pwd -P"], { encoding: "utf8" }).trim(), fs.realpathSync(f.cwd));
  assert.equal(f.calls.filter((call) => call[0] === "tab").length, 0);
  assert.equal(archive.list().length, 0);
});

test("열린 스페이스로 복원할 때 새 탭도 저장한 워크트리 폴더로 이동한다", async () => {
  const f = fixture({ live: true });
  archive.add(archive.spaceEntry("project", f.base, [], [{ label: "work terminal", entry: null, cwd: f.cwd }]));
  await f.dispatch({ type: "archive.restore", spaceCwd: f.base });
  assert.deepEqual(f.calls.find((call) => call[0] === "tab"), ["tab", "live"]);
  const send = f.calls.find((call) => call[0] === "send");
  assert.equal(send?.[1], "new-pane");
  assert.equal(execFileSync("/bin/zsh", ["-c", send[2].trim() + " && pwd -P"], { encoding: "utf8" }).trim(), fs.realpathSync(f.cwd));
});

test("폴더가 없는 기존 탭 보관 기록은 기본 스페이스 폴더에서 복원한다", async () => {
  const f = fixture();
  archive.add(archive.spaceEntry("project", f.base, [], [{ label: "legacy", entry: null }]));
  await f.dispatch({ type: "archive.restore", spaceCwd: f.base });
  assert.equal(f.messages.at(-1)?.type, "archive-restored");
  assert.equal(f.calls.some((call) => call[0] === "send"), false);
});

test("복원할 터미널 폴더가 잘못됐거나 없어지면 보관 기록을 유지하고 생성 전에 거부한다", async () => {
  for (const cwd of ["", "relative", root + "/missing", root + "\ncommand", 123]) {
    const f = fixture();
    const head = archive.add(archive.spaceEntry("project", f.base, [], [{ label: "invalid", entry: null, cwd }]));
    await f.dispatch({ type: "archive.restore", id: head.id });
    assert.equal(f.messages.at(-1)?.type, "archive-error");
    assert.equal(f.calls.length, 0);
    assert.ok(archive.get(head.id));
  }
});

test("터미널 폴더를 읽지 못하면 스페이스를 닫거나 불완전한 보관 기록을 만들지 않는다", async () => {
  for (const paneList of [async () => null, async () => [], async () => { throw new Error("pane unavailable"); }]) {
    const f = fixture({ paneList });
    replace({ workspaces: [{ id: "old", folder: f.base }], tabs: { old: [{ tabId: "old-tab", label: "work terminal" }] } });
    await f.dispatch({ type: "archive.space", workspaceId: "old" });
    assert.equal(f.messages.at(-1)?.type, "archive-error");
    assert.equal(f.calls.length, 0);
    assert.equal(archive.list().length, 0);
  }
});

test("에이전트 복원은 같은 대화 id와 원래 워크트리 폴더를 사용한다", async () => {
  const f = fixture();
  const head = archive.add(archive.agentEntry({ agent: "claude", sessionUuid: "saved-session", cwd: f.cwd, tabLabel: "work agent" }, "project", f.base));
  await f.dispatch({ type: "archive.restore", id: head.id });
  const send = f.calls.find((call) => call[0] === "send");
  assert.equal(send?.[1], "spare-pane");
  assert.match(send[2], /'claude' '--resume' 'saved-session'\r$/);
  const cd = send[2].slice(0, send[2].indexOf(" && "));
  assert.equal(execFileSync("/bin/zsh", ["-c", cd + " && pwd -P"], { encoding: "utf8" }).trim(), fs.realpathSync(f.cwd));
  assert.equal(archive.get(head.id), null);
});

test("폴더 이동 실패 항목은 남기고 재시도할 때 성공한 탭은 다시 만들지 않는다", async () => {
  let sends = 0, fail = true;
  const f = fixture({ paneSendText: async () => { if (++sends === 2 && fail) throw new Error("send failed"); } });
  const head = archive.add(archive.spaceEntry("project", f.base, [], [
    { label: "first", entry: null, cwd: f.cwd }, { label: "second", entry: null, cwd: f.cwd },
  ]));
  await f.dispatch({ type: "archive.restore", id: head.id });
  assert.ok(f.messages.some((message) => message.type === "archive-error" && /send failed/.test(message.message)));
  assert.deepEqual(archive.get(head.id).tabs, [{ label: "second", entry: null, cwd: f.cwd }]);
  archive.load();
  assert.deepEqual(archive.get(head.id).tabs, [{ label: "second", entry: null, cwd: f.cwd }]);
  fail = false; f.calls.length = 0;
  replace({ workspaces: [{ id: "restored", folder: f.base }] });
  await f.dispatch({ type: "archive.restore", id: head.id });
  assert.deepEqual(f.calls.filter((call) => call[0] === "rename"), [["rename", "new-tab", "second"]]);
  assert.equal(f.calls.filter((call) => call[0] === "send").length, 1);
  assert.equal(archive.get(head.id), null);
});

test("복원 진행 저장에 실패하면 오류를 알리고 같은 앱의 재시도에서 완료 탭을 제외한다", async () => {
  const f = fixture();
  const head = archive.add(archive.spaceEntry("project", f.base, [], [
    { label: "first", entry: null, cwd: f.cwd }, { label: "second", entry: null, cwd: f.cwd },
  ]));
  archive.flushNow();
  const rename = fs.renameSync;
  try {
    fs.renameSync = () => { throw new Error("disk unavailable"); };
    await f.dispatch({ type: "archive.restore", id: head.id });
  } finally { fs.renameSync = rename; }
  assert.equal(f.messages.at(-1).type, "archive-error");
  assert.match(f.messages.at(-1).message, /복원 상태를 저장하지 못했습니다/);
  assert.deepEqual(archive.get(head.id).tabs.map((tab) => tab.label), ["second"]);
  f.calls.length = 0;
  replace({ workspaces: [{ id: "restored", folder: f.base }] });
  await f.dispatch({ type: "archive.restore", id: head.id });
  assert.deepEqual(f.calls.filter((call) => call[0] === "rename"), [["rename", "new-tab", "second"]]);
  assert.equal(archive.get(head.id), null);
});

test("세션 하나를 복원해도 같은 보관 스페이스의 터미널 폴더 기록은 남는다", async () => {
  const f = fixture();
  const agent = archive.add(archive.agentEntry({ agent: "claude", sessionUuid: "saved-session", cwd: f.cwd }, "project", f.base));
  const plain = { label: "work terminal", entry: null, cwd: f.cwd };
  const head = archive.add(archive.spaceEntry("project", f.base, [agent.id], [{ label: "work agent", entry: agent.id }, plain]));
  await f.dispatch({ type: "archive.restore", id: agent.id });
  assert.equal(archive.get(agent.id), null);
  assert.deepEqual(archive.get(head.id).tabs, [plain]);
  assert.deepEqual(archive.get(head.id).agents, []);
  archive.load();
  assert.deepEqual(archive.get(head.id).tabs, [plain]);
  f.calls.length = 0;
  replace({ workspaces: [{ id: "restored", folder: f.base }] });
  await f.dispatch({ type: "archive.restore", id: head.id });
  assert.equal(f.calls.filter((call) => call[0] === "send").length, 1);
  assert.doesNotMatch(f.calls.find((call) => call[0] === "send")[2], /--resume/);
  assert.equal(archive.get(head.id), null);
});

test("세션 하나의 복원 명령이 실패하면 스페이스 보관 기록과 세션을 남긴다", async () => {
  const f = fixture({ paneSendText: async () => { throw new Error("send failed"); } });
  const agent = archive.add(archive.agentEntry({ agent: "claude", sessionUuid: "saved-session", cwd: f.cwd }, "project", f.base));
  const tabs = [{ label: "work agent", entry: agent.id }, { label: "work terminal", entry: null, cwd: f.cwd }];
  const head = archive.add(archive.spaceEntry("project", f.base, [agent.id], tabs));
  await f.dispatch({ type: "archive.restore", id: agent.id });
  assert.equal(f.messages.at(-1).type, "archive-error");
  assert.ok(archive.get(agent.id));
  assert.deepEqual(archive.get(head.id).tabs, tabs);
});
