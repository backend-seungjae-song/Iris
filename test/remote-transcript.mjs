import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTranscriptService } from "../server/remote/transcript.js";

const AGENT = "a".repeat(32);

function line(value) { return `${JSON.stringify(value)}\n`; }

function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iris-remote-transcript-"));
  const claude = path.join(root, "claude");
  const state = path.join(root, "state");
  fs.mkdirSync(path.join(claude, "projects"), { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claude;
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const file = path.join(claude, "projects", "session.jsonl");
  fs.writeFileSync(file, line({ type: "user", uuid: "u1", timestamp: "2026-09-27T00:00:00Z",
    message: { content: "첫 질문" } }) + line({ type: "assistant", uuid: "a1", timestamp: "2026-09-27T00:00:01Z",
    message: { content: [{ type: "text", text: "첫 답" }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/private/x" } }] } }));
  const source = { paneId: "private-pane", transcriptFile: file };
  const agents = { resolve: (ref) => ref === AGENT ? { ref, kind: "claude", source } : null };
  let random = 1;
  const timers = [];
  const service = createTranscriptService({ agents, stateDir: state, randomBytes: (size) => Buffer.alloc(size, random++),
    setTimer(fn, delay) { const timer = { fn, delay, unref() {} }; timers.push(timer); return timer; },
    clearTimer(timer) { timer.cleared = true; } });
  t.after(() => service.close());
  return { file, service, timers };
}

test("대화 페이지는 최신순 Item만 내보내고 커서는 연결별 불투명 값이다", (t) => {
  const { service } = harness(t);
  const page = service.page("conn-1", AGENT);
  assert.equal(page.ok, true);
  assert.deepEqual(page.items.map((item) => [item.role, item.text, item.tool]), [
    ["tool", '{"file_path":"[Mac 경로]"}', "Read"],
    ["assistant", "첫 답", undefined],
    ["user", "첫 질문", undefined],
  ]);
  assert.equal(Buffer.byteLength(JSON.stringify(page.items)) <= 48 * 1024, true);
  const encoded = JSON.stringify(page);
  assert.equal(encoded.includes("private-pane"), false);
  assert.equal(encoded.includes("session.jsonl"), false);
  assert.deepEqual(service.page("conn-1", "f".repeat(32)), { ok: false, error: "forbidden" });
});

test("transcript.watch는 새 완성 줄을 1초 폴링으로 append한다", async (t) => {
  const { file, service, timers } = harness(t);
  const sent = [];
  assert.deepEqual(service.watch("conn", AGENT, (value) => sent.push(value)), { ok: true });
  assert.equal(timers[0].delay, 1000);
  assert.deepEqual(service.watch("conn", AGENT, (value) => sent.push(value)), { ok: true });
  assert.equal(timers[0].cleared, true, "새 watch가 이전 polling을 정리한다");
  fs.appendFileSync(file, line({ type: "assistant", uuid: "a2", timestamp: "2026-09-27T00:00:02Z",
    message: { content: "새 답" } }));
  await timers[1].fn();
  assert.deepEqual(sent, [{ type: "transcript.append", agent: AGENT,
    items: [{ role: "assistant", text: "새 답", at: Date.parse("2026-09-27T00:00:02Z") }] }]);
  service.closeConnection("conn");
});

test("대화 페이지는 50개씩 나누고 커서를 다른 연결에서 받지 않는다", (t) => {
  const { file, service } = harness(t);
  for (let index = 0; index < 60; index++) fs.appendFileSync(file, line({ type: "user", uuid: `u${index + 2}`,
    message: { content: `질문 ${index}` } }));
  const first = service.page("conn-1", AGENT);
  assert.equal(first.items.length, 50);
  assert.match(first.before, /^[0-9a-f]{32}$/);
  assert.deepEqual(service.page("conn-2", AGENT, first.before), { ok: false, error: "invalid-request" });
  const second = service.page("conn-1", AGENT, first.before);
  assert.equal(second.items.length, 13);
  assert.equal(second.before, null);
});

test("끝나지 않은 2MiB 초과 줄은 페이지에 넣지 않는다", (t) => {
  const { file, service } = harness(t);
  fs.writeFileSync(file, "x".repeat((2 * 1024 * 1024) + 1));
  const originalRead = fs.readSync;
  let bytes = 0;
  fs.readSync = (...args) => {
    const read = originalRead(...args);
    bytes += read;
    return read;
  };
  try {
    assert.deepEqual(service.page("conn", AGENT), { ok: true, items: [], before: null });
  } finally {
    fs.readSync = originalRead;
  }
  assert.equal(bytes <= 2 * 1024 * 1024, true, `읽은 바이트: ${bytes}`);
});
