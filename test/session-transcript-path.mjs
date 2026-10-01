import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { agentSessionPathFor, reportAgentSessionPath, resetAgentSessionPathsForTest,
  validateAgentSessionPath } from "../server/agent-session-path.js";
import { runSessionCmd } from "../server/browser-commands.js";
import { buildMonitorState, indexProjects } from "../server/join.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iris-session-path-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => resetAgentSessionPathsForTest());
  const claudeHome = path.join(root, "claude");
  const projects = path.join(claudeHome, "projects");
  const project = path.join(projects, "-repo");
  const codexRoot = path.join(root, "codex", "sessions");
  const state = path.join(root, "state");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(codexRoot, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  return { root, claudeHome, projects, project, codexRoot, state,
    options: { claudeRoot: projects, codexRoot, stateDir: state } };
}

test("분기한 Claude의 hook id를 파일 끝의 session_id가 유일한 실제 기록에 연결한다", (t) => {
  const f = fixture(t);
  const hookId = "2f228987-0bf3-4c75-9213-40063259b3de";
  const fileId = "b998c615-968f-4fba-b2bc-79706aff9dc2";
  const file = path.join(f.project, `${fileId}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ sessionId: fileId, type: "user" })}\n${JSON.stringify({ sessionId: fileId, session_id: hookId, type: "assistant" })}\n`);
  assert.equal(indexProjects(f.projects).get(hookId)?.file, fs.realpathSync(file));
});

test("같은 Claude hook id를 가진 파일이 둘이면 어느 파일도 고르지 않는다", (t) => {
  const f = fixture(t);
  const hookId = "2f228987-0bf3-4c75-9213-40063259b3de";
  for (const fileId of ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]) {
    fs.writeFileSync(path.join(f.project, `${fileId}.jsonl`), `${JSON.stringify({ sessionId: fileId, session_id: hookId })}\n`);
  }
  assert.equal(indexProjects(f.projects).get(hookId), undefined);
});

test("hook 경로가 있으면 Claude 파일명과 session id가 달라도 그 pane의 경로를 우선한다", (t) => {
  const f = fixture(t);
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = f.claudeHome;
  t.after(() => previous === undefined ? delete process.env.CLAUDE_CONFIG_DIR : process.env.CLAUDE_CONFIG_DIR = previous);
  const hookId = "2f228987-0bf3-4c75-9213-40063259b3de";
  const file = path.join(f.project, "b998c615-968f-4fba-b2bc-79706aff9dc2.jsonl");
  fs.writeFileSync(file, `${JSON.stringify({ session_id: hookId })}\n`);
  const registered = runSessionCmd("prompt-targets", { markers: [], agentSession: {
    agent: "claude", sessionId: hookId, transcriptPath: file,
  } }, "w1:p1");
  assert.equal(registered.ok, true);
  const [state] = buildMonitorState([{ pane_id: "w1:p1", workspace_id: "w1", terminal_id: "t1",
    agent: "claude", agent_status: "idle", agent_session: { kind: "id", value: hookId } }]);
  assert.equal(state.sessionUuid, hookId);
  assert.equal(state.transcriptFile, fs.realpathSync(file));
});

test("실제 파일과 허용 루트와 상태 폴더를 모두 확인한다", (t) => {
  const f = fixture(t);
  const allowed = path.join(f.project, "allowed.jsonl");
  const outside = path.join(f.root, "outside.jsonl");
  const stateFile = path.join(f.state, "state.jsonl");
  fs.writeFileSync(allowed, "{}\n");
  fs.writeFileSync(outside, "{}\n");
  fs.writeFileSync(stateFile, "{}\n");
  const escaped = path.join(f.project, "escaped.jsonl");
  fs.symlinkSync(outside, escaped);
  assert.equal(validateAgentSessionPath("claude", allowed, f.options), fs.realpathSync(allowed));
  assert.equal(validateAgentSessionPath("claude", outside, f.options), null);
  assert.equal(validateAgentSessionPath("claude", escaped, f.options), null);
  assert.equal(validateAgentSessionPath("claude", path.join(f.project, "missing.jsonl"), f.options), null);
  assert.equal(validateAgentSessionPath("claude", stateFile, { ...f.options, claudeRoot: f.root }), null);
  assert.equal(reportAgentSessionPath({ paneId: "w1:p1", agent: "claude", sessionId: "id", transcriptPath: outside }, f.options), null);
  assert.equal(agentSessionPathFor("w1:p1", "claude", f.options), null);
});

test("허용 루트 안의 다른 세션 파일은 pane에 등록하지 않는다", (t) => {
  const f = fixture(t);
  const claudeFile = path.join(f.project, "11111111-1111-4111-8111-111111111111.jsonl");
  const codexFile = path.join(f.codexRoot, "rollout-2026-09-28T00-00-00-22222222-2222-4222-8222-222222222222.jsonl");
  fs.writeFileSync(claudeFile, `${JSON.stringify({ session_id: "11111111-1111-4111-8111-111111111111" })}\n`);
  fs.writeFileSync(codexFile, "{}\n");
  assert.ok(reportAgentSessionPath({ paneId: "w1:p1", agent: "claude",
    sessionId: "11111111-1111-4111-8111-111111111111", transcriptPath: claudeFile }, f.options));
  assert.equal(reportAgentSessionPath({ paneId: "w1:p1", agent: "claude",
    sessionId: "33333333-3333-4333-8333-333333333333", transcriptPath: claudeFile }, f.options), null);
  assert.equal(reportAgentSessionPath({ paneId: "w1:p2", agent: "codex",
    sessionId: "44444444-4444-4444-8444-444444444444", transcriptPath: codexFile }, f.options), null);
  assert.equal(agentSessionPathFor("w1:p1", "claude", f.options), null);
  assert.equal(agentSessionPathFor("w1:p2", "codex", f.options), null);
});
