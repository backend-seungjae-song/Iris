import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-agent-launch-"));
const previousStateDir = process.env.IRIS_STATE_DIR;
process.env.IRIS_STATE_DIR = stateDir;

const launch = await import("../server/agent-launch.js");

after(() => {
  if (previousStateDir === undefined) delete process.env.IRIS_STATE_DIR;
  else process.env.IRIS_STATE_DIR = previousStateDir;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test("기본 argv는 새 세션과 재개 명령을 구분한다", () => {
  assert.deepEqual(launch.agentArgv("claude"), ["claude"]);
  assert.deepEqual(launch.agentArgv("claude", { resumeSession: "claude-id" }), ["claude", "--resume", "claude-id"]);
  assert.deepEqual(launch.agentArgv("codex"), ["codex"]);
  assert.deepEqual(launch.agentArgv("codex", { resumeSession: "codex-id" }), ["codex", "resume", "codex-id"]);
});

test("모르는 종류와 원형 속성 이름은 argv를 만들지 않는다", () => {
  for (const kind of ["other", "__proto__", "constructor", "toString"]) {
    assert.equal(launch.agentArgv(kind), null);
  }
});

test("shellCommand는 안전하지 않은 인자와 빈 문자열을 홑따옴표로 감싼다", () => {
  assert.equal(
    launch.shellCommand(["claude", "--resume", "plain/id-1", "two words", "a'b", "", "$HOME", "x;y"]),
    "claude --resume plain/id-1 'two words' 'a'\\''b' '' '$HOME' 'x;y'",
  );
});

test("shellCommand는 zsh 경로 치환을 막으려고 = 가 든 인자를 감싼다", () => {
  assert.equal(launch.shellCommand(["=ls", "a=b", "a==ls"]), "'=ls' 'a=b' 'a==ls'");
});

test("새 탭과 보관 복원은 같은 모양의 명령을 셸에 입력한다", async () => {
  const workspaceHandlers = await import("../server/workspace-handlers.js");
  const archive = await import("../server/archive.js");
  const archiveHandlers = await import("../server/archive-handlers.js");
  const { initRuntimeState } = await import("../server/runtime-state.js");
  initRuntimeState({ scheduleRecompute: async () => {} });

  let resolveWorkspaceWrite;
  const workspaceWrite = new Promise((resolve) => { resolveWorkspaceWrite = resolve; });
  workspaceHandlers.initWorkspaceHandlers({ herdr: {
    tabCreate: async () => ({ tab_id: "new-tab" }),
    paneList: async () => [{ tab_id: "new-tab", pane_id: "new-pane" }],
    paneRead: async () => ({ text: "$" }),
    paneSendText: async (paneId, text) => resolveWorkspaceWrite({ paneId, text }),
  } });
  workspaceHandlers.handleTab({ _local: true, send() {} }, {
    type: "tab.create", workspaceId: "workspace", launch: "claude",
  });
  const started = await workspaceWrite;

  let resolveArchiveWrite;
  const archiveWrite = new Promise((resolve) => { resolveArchiveWrite = resolve; });
  archiveHandlers.initArchiveHandlers({
    broadcast() {},
    herdr: {
      workspaceCreate: async () => ({
        workspace: { workspace_id: "restored-workspace" },
        tab: { tab_id: "restored-tab" },
        root_pane: { pane_id: "restored-pane", cwd: "/space" },
      }),
      paneSendText: async (paneId, text) => resolveArchiveWrite({ paneId, text }),
    },
  });
  archive.add({
    id: "saved-agent", kind: "agent", agent: "claude", session: "resume-123",
    cwd: "/space/nested", spaceCwd: "/space", name: "saved",
  });
  archiveHandlers.handleArchive({ _local: true, send() {} }, { type: "archive.restore", id: "saved-agent" });
  const restored = await archiveWrite;

  assert.equal(started.text, "claude\r");
  assert.equal(restored.text, "cd -- /space/nested && claude --resume resume-123\r");
  assert.equal(started.paneId, "new-pane");
  assert.equal(restored.paneId, "restored-pane");
  await new Promise((resolve) => setImmediate(resolve));
  archive.flushNow();
});
