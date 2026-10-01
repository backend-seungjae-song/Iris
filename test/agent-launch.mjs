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
  assert.deepEqual(launch.agentArgv("codex"), ["codex", "--no-daemon"]);
  assert.deepEqual(launch.agentArgv("codex", { resumeSession: "codex-id" }), ["codex", "--no-daemon", "resume", "codex-id"]);
});

test("모르는 종류와 원형 속성 이름은 argv를 만들지 않는다", () => {
  for (const kind of ["other", "__proto__", "constructor", "toString"]) {
    assert.equal(launch.agentArgv(kind), null);
  }
});

test("공급자 인자는 두 에이전트의 새 세션과 재개 명령에 똑같이 붙는다", () => {
  const calls = [];
  const extra = ["--shared", "value with space"];
  const unregister = launch.registerLaunchOptions((kind, options) => {
    calls.push([kind, options]);
    return extra;
  });

  try {
    for (const kind of ["claude", "codex"]) {
      const fresh = launch.agentArgv(kind);
      const resumed = launch.agentArgv(kind, { resumeSession: `${kind}-session` });
      assert.deepEqual(fresh.slice(-extra.length), extra);
      assert.deepEqual(resumed.slice(-extra.length), extra);
      assert.equal(resumed.includes(`${kind}-session`), true);
    }
    assert.deepEqual(calls, [
      ["claude", { resumeSession: undefined }],
      ["claude", { resumeSession: "claude-session" }],
      ["codex", { resumeSession: undefined }],
      ["codex", { resumeSession: "codex-session" }],
    ]);
  } finally {
    unregister();
  }

  assert.deepEqual(launch.agentArgv("claude"), ["claude"]);
  assert.deepEqual(launch.agentArgv("codex", { resumeSession: "kept" }), ["codex", "--no-daemon", "resume", "kept"]);
});

test("공급자 예외와 문자열 배열이 아닌 반환값은 기본 실행을 막지 않는다", () => {
  const unregisterThrow = launch.registerLaunchOptions(() => { throw new Error("실패"); });
  const unregisterScalar = launch.registerLaunchOptions(() => "--wrong");
  const unregisterMixed = launch.registerLaunchOptions(() => ["--ok", 1]);
  const unregisterGood = launch.registerLaunchOptions(() => ["--kept"]);
  try {
    assert.deepEqual(launch.agentArgv("claude"), ["claude", "--kept"]);
  } finally {
    unregisterThrow();
    unregisterScalar();
    unregisterMixed();
    unregisterGood();
  }
});

test("해제 함수는 해당 공급자를 제거하며 여러 번 불러도 안전하다", () => {
  const unregister = launch.registerLaunchOptions(() => ["--temporary"]);
  try {
    assert.deepEqual(launch.agentArgv("codex"), ["codex", "--no-daemon", "--temporary"]);
    unregister();
    unregister();
    assert.deepEqual(launch.agentArgv("codex"), ["codex", "--no-daemon"]);
  } finally {
    unregister();
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

test("새 탭과 보관 복원은 같은 공급자 인자를 셸에 입력한다", async () => {
  const workspaceHandlers = await import("../server/workspace-handlers.js");
  const archive = await import("../server/archive.js");
  const archiveHandlers = await import("../server/archive-handlers.js");
  const { initRuntimeState } = await import("../server/runtime-state.js");
  const extra = ["--shared-flag", "two words", "$HOME"];
  const unregister = launch.registerLaunchOptions(() => extra);
  initRuntimeState({ scheduleRecompute: async () => {} });

  try {
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

    const optionCommand = launch.shellCommand(extra);
    assert.equal(started.text, `claude ${optionCommand}\r`);
    // 복원은 실행 파일까지 인용(셸 별칭 미적용)
    const quoteAll = (argv) => argv.map((arg) => `'${arg.replaceAll("'", `'\\''`)}'`).join(" ");
    assert.equal(restored.text, `cd '/space/nested' && ${quoteAll(["claude", "--resume", "resume-123", ...extra])}\r`);
    assert.equal(started.paneId, "new-pane");
    assert.equal(restored.paneId, "restored-pane");
    assert.match(restored.text, /resume-123/);
    assert.match(restored.text, /^cd '\/space\/nested' && /);
    await new Promise((resolve) => setImmediate(resolve));
    archive.flushNow();
  } finally {
    unregister();
  }
});
