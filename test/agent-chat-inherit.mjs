import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { inheritPick, importPickedSession, importCodexToClaude, readInheritanceHistory, resumeFromPick } from "../server/agent-chat-inherit.js";
import { handleAgentChat, initAgentChat, stopAgentChat } from "../server/agent-chat.js";

const sourceId = "9ccaac07-beac-453a-9e16-67e8bcda6a01";
const targetId = "dc1ab0c3-9597-4af7-b5b9-ba43549584e5";
const importedId = "57cdb36e-a7c4-459b-af4a-423a4d54349b";
const picked = `⟦Iris⟧ 세션 선택 · 원본
주소: herdr pane w1:p2
종류: claude
폴더: /wrong/path
세션: ${sourceId}
⟦/Iris⟧`;

test("세션 지목 칩 앞뒤의 /inherit를 해석", () => {
  const selection = { paneId: "w1:p2", sessionId: sourceId };
  assert.deepEqual(inheritPick(`/inherit\n${picked}`), selection);
  assert.deepEqual(inheritPick(`${picked}\n\n/inherit`), selection);
  assert.equal(inheritPick(`작업을 확인해 줘\n${picked}`), null);
  assert.throws(() => inheritPick("/inherit"), /하나/);
  assert.throws(() => inheritPick(`/inherit\n${picked}\n${picked}`), /하나/);
  assert.equal(inheritPick(picked.replace("⟦/Iris⟧", "/inherit\n⟦/Iris⟧")), null);
});

for (const [sourceKind, destKind] of [["claude", "codex"], ["codex", "claude"]]) {
  test(`${sourceKind} → ${destKind}: 지목한 원본을 명령을 받은 pane에서 재개`, async () => {
    const events = [];
    const pick = inheritPick(`/inherit\n${picked}`);
    const current = (paneId) => paneId === "w1:p2"
      ? { paneId, kind: sourceKind, sessionId: sourceId, cwd: "/workspace", file: "/verified/source.jsonl", terminalId: "source" }
      : { paneId, kind: destKind, sessionId: targetId, cwd: "/workspace", terminalId: "dest", idle: true };
    const deps = {
      current,
      importSession: async (source, target) => {
        events.push(["import", source.kind, source.file, target.kind, target.cwd]);
        return importedId;
      },
      resume: async (target, id) => events.push(["resume", target.paneId, id]),
    };
    await resumeFromPick("w1:p1", pick, deps);
    assert.deepEqual(events, [
      ["import", sourceKind, "/verified/source.jsonl", destKind, "/workspace"],
      ["resume", "w1:p1", importedId],
    ]);
    const stalePick = { ...pick, sessionId: targetId };
    await assert.rejects(() => resumeFromPick("w1:p1", stalePick, deps), /바뀌/);
    assert.equal(events.length, 2);
    const changed = { ...deps, importSession: async () => {
      deps.current = (paneId) => ({ ...current(paneId), terminalId: "replaced" });
      return importedId;
    }};
    changed.current = (paneId) => deps.current(paneId);
    await assert.rejects(() => resumeFromPick("w1:p1", pick, changed), /바뀌/);
    assert.equal(events.length, 2);
  });
}

test("Codex 기록을 별도 Claude 대화로 변환하고 원본과 내부 지침을 분리", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-session-inherit-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "rollout.jsonl");
  const timestamp = "2026-11-20T05:00:00Z";
  const msg = (role, text) => ({ type: "message", role, content: [{ type: "input_text", text }] });
  const rows = [
    { type: "session_meta", payload: { id: sourceId, cwd: root } },
    ...[
      msg("developer", "PRIVATE_TEST_INSTRUCTION"),
      msg("user", "<environment_context>RUNTIME_ONLY</environment_context>\nContinue issue A"),
      { type: "function_call", name: "exec_command", arguments: '{"cmd":"test"}', call_id: "call-1" },
      { type: "function_call_output", output: "one check passed", call_id: "call-1" },
      msg("assistant", "Issue A is ready"),
    ].map((payload) => ({ type: "response_item", timestamp, payload })),
  ];
  const source = rows.map(JSON.stringify).join("\n") + '\n{"partial":';
  await fs.writeFile(file, source);
  const { id, transcript } = await importCodexToClaude({ file, sessionId: sourceId }, root, {
    projects: path.join(root, "claude-projects"),
  });
  assert.notEqual(id, sourceId);
  const converted = await fs.readFile(transcript, "utf8");
  assert.match(converted, /Continue issue A/);
  assert.match(converted, /Issue A is ready/);
  assert.match(converted, /exec_command/);
  assert.match(converted, /one check passed/);
  assert.doesNotMatch(converted, /PRIVATE_TEST_INSTRUCTION|RUNTIME_ONLY/);
  const entries = converted.trim().split("\n").map(JSON.parse);
  for (const [i, entry] of entries.entries()) {
    assert.equal(entry.sessionId, id);
    assert.equal(entry.parentUuid, entries[i - 1]?.uuid ?? null);
  }
  assert.equal((await fs.stat(transcript)).mode & 0o777, 0o600);
  assert.equal(await fs.readFile(file, "utf8"), source);
});

test("대화 보내기에서 /inherit를 가로채고 같은 pane에 /resume만 제출", { timeout: 4000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-session-send-"));
  const previous = { CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  const codexHome = path.join(root, "codex");
  const claudeHome = path.join(root, "claude");
  process.env.CODEX_HOME = codexHome;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  t.after(async () => {
    stopAgentChat();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const rolloutDir = path.join(codexHome, "sessions", "2026", "11", "20");
  const claudeSessions = path.join(claudeHome, "sessions");
  await fs.mkdir(rolloutDir, { recursive: true });
  await fs.mkdir(claudeSessions, { recursive: true });
  await fs.writeFile(path.join(claudeSessions, "499.json"), JSON.stringify({ sessionId: targetId }));
  const timestamp = "2026-11-20T00:00:00Z";
  const row = { type: "response_item", timestamp, payload: { type: "message", role: "user", content: [{ text: "selected dialogue" }] } };
  const meta = { type: "session_meta", timestamp, payload: { id: sourceId, cwd: root } };
  await fs.writeFile(path.join(rolloutDir, `rollout-2026-11-20T00-00-00-${sourceId}.jsonl`), [meta, row].map(JSON.stringify).join("\n") + "\n");

  const calls = [];
  const emptyClaude = await fs.readFile(new URL("./fixtures/terminal-draft/claude-empty.ansi", import.meta.url), "utf8");
  initAgentChat({
    paseoUi: false,
    herdr: {
      paneGet: async (paneId) => paneId === "w1:p1"
        ? { agent: "claude", terminal_id: "target", cwd: root, agent_status: "idle" }
        : { agent: "codex", terminal_id: "source", cwd: root, agent_session: { kind: "id", value: sourceId } },
      call: async () => ({ foreground_process_group_id: 499 }),
      paneRead: async () => ({ text: calls.length === 0 ? emptyClaude
        : `─────────────────────────────────────────────────────\n❯ ${calls[0][1]}\n─────────────────────────────────────────────────────` }),
      paneSendText: async (paneId, text) => calls.push([paneId, text]),
    },
  });
  const replies = new Map();
  const ws = { _local: true, readyState: 1, send(raw) {
    const message = JSON.parse(raw);
    if (message.type === "agentchat.sent") replies.get(message.id)?.(message);
  } };
  handleAgentChat(ws, { type: "agentchat.open", key: "current", paneId: "w1:p1" });
  const send = (id, text) => {
    const reply = new Promise((resolve) => replies.set(id, resolve));
    handleAgentChat(ws, { type: "agentchat.send", key: "current", id, text });
    return reply;
  };
  const invalid = await send("bad", `/inherit\n${picked.replace(sourceId, targetId)}`);
  assert.equal(invalid.ok, false);
  assert.deepEqual(calls, []);

  const valid = await send("ok", `${picked}\n\n/inherit`);
  assert.equal(valid.ok, true, valid.reason);
  assert.deepEqual(calls.map(([paneId]) => paneId), ["w1:p1", "w1:p1"]);
  assert.match(calls[0][1], /^\/resume [a-f0-9-]{36}$/);
  assert.equal(calls[1][1], "\r");
  const [project] = await fs.readdir(path.join(claudeHome, "projects"));
  const id = calls[0][1].slice("/resume ".length);
  const history = await fs.readFile(path.join(claudeHome, "projects", project, `${id}.jsonl`), "utf8");
  assert.match(history, /selected dialogue/);
  assert.doesNotMatch(history, /inherit|wrong\/path/);
});

test("긴 기록은 두 방향 모두 최근 대화와 기존 압축 요약만 제한된 크기로 전달", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-inherit-long-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ts = "2026-11-24T00:00:00Z";
  for (const kind of ["claude", "codex"]) {
    const message = (role, text) => kind === "claude"
      ? { type: role, timestamp: ts, sessionId: sourceId, message: { role, content: text } }
      : { type: "response_item", timestamp: ts, payload: { type: "message", role, content: [{ text }] } };
    const summary = kind === "claude"
      ? { ...message("user", "EXISTING_SUMMARY"), isCompactSummary: true, isVisibleInTranscriptOnly: true }
      : { type: "compacted", timestamp: ts, payload: { message: "EXISTING_SUMMARY" } };
    const tool = kind === "claude"
      ? { ...message("user", ""), message: { role: "user", content: [{ type: "tool_result", content: "가".repeat(200_000) }] } }
      : { type: "response_item", timestamp: ts, payload: { type: "function_call_output", output: "가".repeat(200_000) } };
    const source = path.join(root, `${kind}.jsonl`);
    const rows = [
      { type: "session_meta", payload: { id: sourceId } },
      message("user", "OLD_HISTORY"),
      summary,
      ...Array.from({ length: 180 }, (_, i) => message("assistant", `Padded reply ${i} ${"a".repeat(700)}`)),
      message("user", "LATEST_REQUEST"),
      tool,
      message("assistant", "LATEST_REPLY"),
    ];
    await fs.writeFile(source, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const history = await readInheritanceHistory({ kind, file: source, sessionId: sourceId });
    const transferred = JSON.stringify(history);
    assert.ok(Buffer.byteLength(transferred) < 70 * 1024);
    assert.ok(history.length <= 98);
    assert.match(transferred, /EXISTING_SUMMARY/);
    assert.match(transferred, /LATEST_REQUEST/);
    assert.match(transferred, /LATEST_REPLY/);
    assert.doesNotMatch(transferred, /OLD_HISTORY/);
    assert.doesNotMatch(transferred, /\uFFFD/);
  }
});

test("읽을 수 있는 요약이 없고 최신 요청 뒤에 출력이 많아도 요청을 보존", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-inherit-fallback-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "source.jsonl");
  const rows = [
    { type: "session_meta", payload: { id: sourceId } },
    { type: "response_item", payload: { type: "message", role: "user", content: "LAST_USER" } },
    { type: "compacted", payload: { message: "", replacement_history: [{ type: "compaction", encrypted_content: "OPAQUE" }] } },
    ...Array.from({ length: 150 }, (_, i) => ({ type: "response_item", payload: {
      type: "function_call_output", output: `tool output ${i} ${"가".repeat(2500)} END_${i}`,
    } })),
  ];
  await fs.writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const history = await readInheritanceHistory({ kind: "codex", file, sessionId: sourceId });
  assert.equal(history[0].text, "LAST_USER");
  assert.match(history.at(-1).text, /END_149$/);
  assert.ok(Buffer.byteLength(history.at(-1).text) <= 2048);
  assert.ok(Buffer.byteLength(JSON.stringify(history)) < 50 * 1024);
  assert.doesNotMatch(JSON.stringify(history), /OPAQUE/);
});

test("to-codex의 셸 및 Node 실행 형식을 보존한다", { skip: process.platform === "win32" }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-inherit-cli-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const previousPath = process.env.PATH;
  const previousClaude = process.env.CLAUDE_CONFIG_DIR;
  t.after(() => {
    process.env.PATH = previousPath;
    if (previousClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaude;
  });
  process.env.PATH = root + path.delimiter + previousPath;
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  const source = { kind: "claude", cwd: root, file: path.join(root, "source.jsonl"), sessionId: sourceId };
  await fs.writeFile(source.file, JSON.stringify({ type: "user", sessionId: sourceId, message: { content: "fixture" } }));
  const script = path.join(root, "to-codex");
  const answer = JSON.stringify({ threadId: importedId });
  for (const code of [
    "#!/bin/sh\nprintf '%s' '" + answer + "'",
    "#!/usr/bin/env node\nif (process.env.ELECTRON_RUN_AS_NODE !== '1') process.exit(3); console.log('" + answer + "');",
  ]) {
    await fs.writeFile(script, code, { mode: 0o700 });
    assert.equal(await importPickedSession(source, { cwd: root, kind: "codex" }), importedId);
  }
});
