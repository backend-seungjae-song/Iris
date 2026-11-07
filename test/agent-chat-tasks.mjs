import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  emptyTaskIndex, readTaskOutput, scanTaskBuffer, scanTaskFile, scanTaskLine, taskList, taskStatus, taskTail, tasksDirFor,
} from "../server/agent-chat-tasks.js";

const T0 = "2026-11-07T01:00:00.000Z";
const line = (o) => JSON.stringify(o);
const bashCall = (id, cmd, desc) => line({ type: "assistant", timestamp: T0, message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: cmd, description: desc, run_in_background: true } }] } });
const monCall = (id, cmd, desc) => line({ type: "assistant", timestamp: T0, message: { content: [{ type: "tool_use", id, name: "Monitor", input: { command: cmd, description: desc, timeout_ms: 60000 } }] } });
const result = (toolUseId, tur, ts = T0) => line({ type: "user", timestamp: ts, message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: "started" }] }, toolUseResult: tur });
const notice = (id, status, ts) => line({ type: "user", timestamp: ts, message: { content: [{ type: "text", text: `[SYSTEM NOTIFICATION]\n<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n<summary>done ${id}</summary>\n</task-notification>` }] } });

function indexOf(lines) {
  const idx = emptyTaskIndex();
  for (const l of lines) scanTaskLine(idx, l);
  return idx;
}

test("백그라운드 셸·Monitor 시작과 끝 기록으로 목록과 상태를 만든다", () => {
  const idx = indexOf([
    bashCall("toolu_a", "sleep 20", "기다리기"),
    result("toolu_a", { backgroundTaskId: "bshell001" }),
    monCall("toolu_b", "tail -f x", "로그 보기"),
    result("toolu_b", { taskId: "bmon00001", timeoutMs: 60000, persistent: false }, "2026-11-07T01:00:05.000Z"),
    notice("bshell001", "completed", "2026-11-07T01:00:21.000Z"),
  ]);
  const now = Date.parse("2026-11-07T01:00:30.000Z");
  const list = taskList(idx, now);
  assert.deepEqual(list.map((t) => [t.id, t.kind, t.status, t.description]), [
    ["bmon00001", "monitor", "running", "로그 보기"],
    ["bshell001", "shell", "completed", "기다리기"],
  ]);
  assert.equal(list[1].endedAt - list[1].startedAt, 21000);
  assert.equal(list[1].summary, "done bshell001");
  // Monitor 는 끝 기록이 없어도 제한 시간이 지나면 시간 끝남
  assert.equal(taskList(idx, Date.parse("2026-11-07T01:02:00.000Z"))[0].status, "expired");
});

test("도구 결과 안의 알림 글·TaskStop·서브에이전트·이상한 id 를 바르게 다룬다", () => {
  const idx = indexOf([
    bashCall("toolu_a", "npm test", ""),
    result("toolu_a", { backgroundTaskId: "bshell002" }),
    // 기록을 grep 한 도구 결과: 끝 기록으로 세지 않음
    line({ type: "user", timestamp: T0, message: { content: [{ type: "tool_result", tool_use_id: "toolu_x", content: "<task-notification><task-id>bshell002</task-id><status>completed</status></task-notification>" }] } }),
    // 서브에이전트(Bash·Monitor 호출이 아님)
    line({ type: "user", timestamp: T0, message: { content: [{ type: "tool_result", tool_use_id: "toolu_agent" }] }, toolUseResult: { taskId: "a1234567890" } }),
    // 경로 글자가 든 id
    bashCall("toolu_c", "x", ""), result("toolu_c", { backgroundTaskId: "../etc" }),
  ]);
  assert.deepEqual([...idx.tasks.keys()], ["bshell002"]);
  assert.equal(taskStatus(idx.tasks.get("bshell002"), idx.ends.get("bshell002"), Date.now()), "running");
  scanTaskLine(idx, result("toolu_stop", { task_id: "bshell002", message: "Successfully stopped task: bshell002" }).replace('"started"', '"Successfully stopped task: bshell002"'));
  assert.equal(taskList(idx, Date.now())[0].status, "stopped");
});

test("파일을 이어 읽을 때 쓰다 만 마지막 줄은 다음에 읽는다", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-tasks-"));
  const file = path.join(dir, "s.jsonl");
  const a = `${bashCall("toolu_a", "sleep 1", "")}\n`;
  const b = result("toolu_a", { backgroundTaskId: "bshell003" });
  fs.writeFileSync(file, a + b.slice(0, 20));
  const idx = emptyTaskIndex();
  await scanTaskFile(idx, file, fs.statSync(file).size);
  assert.equal(idx.offset, Buffer.byteLength(a));
  fs.writeFileSync(file, `${a}${b}\n`);
  await scanTaskFile(idx, file, fs.statSync(file).size);
  assert.deepEqual([...idx.tasks.keys()], ["bshell003"]);
  assert.equal(scanTaskBuffer(emptyTaskIndex(), Buffer.from("no newline")), 0);
});

test("tasks 폴더는 Claude 기록 폴더 안의 세션 기록에서만 만든다", () => {
  const root = "/h/.claude/projects";
  assert.equal(tasksDirFor(`${root}/-p/abc.jsonl`, root, "/t/claude-501"), "/t/claude-501/-p/abc/tasks");
  assert.equal(tasksDirFor(`${root}/-p/abc/subagents/agent-x.jsonl`, root, "/t/claude-501"), "/t/claude-501/-p/abc/tasks");
  assert.equal(tasksDirFor("/elsewhere/-p/abc.jsonl", root, "/t"), null);
  assert.equal(tasksDirFor(`${root}/abc.jsonl`, root, "/t"), null);
});

test("출력은 일반 파일만, 글자 중간에서 자르지 않고 이어 읽는다", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-tasks-out-"));
  fs.writeFileSync(path.join(dir, "bout00001.output"), "가나다\n라마\n");   // 한 글자 3바이트
  const all = readTaskOutput(dir, "bout00001", 0);
  assert.equal(all.text, "가나다\n라마\n");
  // 끝 5바이트만: 앞 글자(라) 조각을 버림
  const tail = readTaskOutput(dir, "bout00001", null, 5);
  assert.equal(tail.text, "마\n");
  assert.equal(tail.end, all.size);
  // 4바이트 한도: 둘째 글자 조각은 다음 읽기로 넘김
  const head = readTaskOutput(dir, "bout00001", 0, 4);
  assert.equal(head.text, "가");
  assert.equal(readTaskOutput(dir, "bout00001", head.end, 100).text, "나다\n라마\n");
  assert.deepEqual(taskTail(dir, "bout00001"), { size: all.size, tail: "가나다\n라마\n", cut: false });
  // 심볼릭 링크(서브에이전트 기록)·없는 파일·이상한 id
  fs.symlinkSync(path.join(dir, "bout00001.output"), path.join(dir, "alink00001.output"));
  assert.equal(readTaskOutput(dir, "alink00001", 0), null);
  assert.equal(readTaskOutput(dir, "bnone0001", 0), null);
  assert.equal(readTaskOutput(dir, "../x", 0), null);
});
