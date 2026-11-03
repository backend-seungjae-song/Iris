import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { herdrCall, launchContext, startHerdr } from "../bin/agent-context.mjs";

const BRIEF = "Inspect the assigned fixture and write findings to result.md. SECRET-BRIEF-TEXT";
const spec = { name: "표시 이름", agentName: "inspect", workspaceId: "w1", cwd: "/work", kind: "claude", agentArgs: ["--model", "m"], brief: BRIEF };
const tab = { tab: { tab_id: "w1:t9" }, root_pane: { pane_id: "w1:p2", terminal_id: "term_child", workspace_id: "w1" } };

// herdr 호출 가짜: 명령 이름별 응답 순서
function fakeHerdr(plan) {
  const calls = [];
  const call = async (argv) => {
    calls.push(argv);
    const key = argv[0] + " " + argv[1];
    const next = (plan[key] || []).shift();
    if (next instanceof Error) throw next;
    return next === undefined ? null : next;
  };
  return { calls, call };
}

test("셸 준비 전 agent_pane_busy 는 다시 시도해 시작", async () => {
  const busy = () => new Error("herdr agent start failed: agent_pane_busy");
  const h = fakeHerdr({ "tab create": [tab], "agent start": [busy(), busy(), null], "agent prompt": [null] });
  const slept = [];
  const out = await startHerdr(spec, {}, { call: h.call, sleep: async (ms) => slept.push(ms) });
  assert.equal(out.agent.pane_id, "w1:p2");
  assert.equal(h.calls.filter((a) => a[1] === "start").length, 3);
  assert.deepEqual(slept, [500, 500]);
  assert.equal(h.calls.some((a) => a[0] === "tab" && a[1] === "close"), false);
});

test("busy 가 끝나지 않거나 다른 오류면 탭을 닫고 실패", async () => {
  const busy = () => new Error("herdr agent start failed: agent_pane_busy");
  const h = fakeHerdr({ "tab create": [tab], "agent start": Array.from({ length: 20 }, busy) });
  await assert.rejects(startHerdr(spec, {}, { call: h.call, sleep: async () => {} }), /agent_pane_busy/);
  assert.equal(h.calls.filter((a) => a[1] === "start").length, 20);
  assert.deepEqual(h.calls.at(-1), ["tab", "close", "w1:t9"]);

  const h2 = fakeHerdr({ "tab create": [tab], "agent start": [new Error("herdr agent start failed: invalid_agent_name")] });
  await assert.rejects(startHerdr(spec, {}, { call: h2.call, sleep: async () => {} }), /invalid_agent_name/);
  assert.equal(h2.calls.filter((a) => a[1] === "start").length, 1);
  assert.deepEqual(h2.calls.at(-1), ["tab", "close", "w1:t9"]);
});

test("브리프 제출 실패면 receipt 에 떠 있는 child pane 이 남고 브리프 글은 오류에 없음", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iris-agent-context-herdr-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const briefFile = path.join(root, "brief.md");
  fs.writeFileSync(briefFile, BRIEF);
  const parent = { pane_id: "w1:p1", terminal_id: "term_parent", workspace_id: "w1", agent: "claude", agent_session: { value: "parent-session" } };
  const h = fakeHerdr({ "tab create": [tab], "agent start": [null], "agent prompt": [new Error("herdr agent prompt failed: timeout")] });
  const deps = {
    env: { HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: path.join(root, "herdr.sock"), CLAUDE_CODE_SESSION_ID: "parent-session" },
    socketPath: path.join(root, "herdr.sock"), stateDir: path.join(root, "state"), ancestors: new Set([123]),
    client: { paneGet: async () => parent, call: async () => ({ process_info: { foreground_processes: [{ pid: 123, name: "claude" }] } }) },
    start: (args) => startHerdr(args, {}, { call: h.call, sleep: async () => {} }),
    writeLineage: () => path.join(root, "lineage.json"),
  };
  const options = { id: "inspect", runtime: "claude", model: "claude-opus-5-5", effort: "high", reason: "independent-work", brief: briefFile, cwd: root };
  const error = await launchContext(options, deps).then(() => null, (e) => e);
  assert.match(String(error?.message), /created_unlinked/);
  assert.match(String(error?.message), /w1:p2/);
  const dir = path.join(root, "state", "agent-context");
  const file = fs.readdirSync(dir).flatMap((d) => fs.readdirSync(path.join(dir, d)).map((f) => path.join(dir, d, f)))[0];
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(record.status, "created_unlinked");
  assert.equal(record.child.paneId, "w1:p2");
  assert.equal(record.child.terminalId, "term_child");
  assert.equal(record.error.includes("SECRET-BRIEF-TEXT"), false);
  assert.equal(h.calls.some((a) => a[1] === "close"), false);
});

test("herdr 실패는 stderr 오류 코드로 알리고 명령 줄(브리프)은 싣지 않음", async () => {
  const runner = async () => {
    const e = new Error(`Command failed: herdr agent prompt w1:p2 ${BRIEF}\n`);
    e.code = 1;
    e.stderr = JSON.stringify({ error: { code: "agent_pane_busy", message: "busy" }, id: "cli:agent:start" });
    throw e;
  };
  const error = await herdrCall(["agent", "prompt", "w1:p2", BRIEF], {}, 1000, runner).then(() => null, (e) => e);
  assert.match(String(error?.message), /agent_pane_busy/);
  assert.equal(String(error?.message).includes("SECRET-BRIEF-TEXT"), false);
  assert.equal(await herdrCall(["tab", "list"], {}, 1000, async () => ({ stdout: JSON.stringify({ result: { ok: 1 } }) })).then((r) => r.ok), 1);
});
