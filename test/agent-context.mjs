import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { extractPromptTargetMarkers, launchContext, submitPromptTargets } from "../bin/agent-context.mjs";

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
  assert.equal(f.calls[0].includes("--no-daemon"), true);
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

test("prompt-targets는 지원하는 구분자를 순서대로 한 번씩 찾고 없으면 빈 목록으로 조용히 알린다", async () => {
  const tab = "@work-tab-a12345~nonce_123";
  const group = "@work-group-b12345~nonce_234";
  const device = "@device:emulator-5554~nonce_456";
  assert.deepEqual(extractPromptTargetMarkers(`앞 ${tab} ${group} ${device} ${tab} @bad~nonce_789 @work-tab-c12345~short`),
    [tab, group, device]);
  const calls = [];
  const env = { HERDR_PANE_ID: "w1:p1" };
  const output = await submitPromptTargets({ prompt: "구분자 없음" }, { env, ownsPane: async () => true, call: async (markers, pane) => {
    calls.push([markers, pane]);
    return { ok: true, data: { activated: [], rejected: [] } };
  } });
  assert.equal(output, "");
  assert.deepEqual(calls, [[[], "w1:p1"]]);
  const failed = await submitPromptTargets({ prompt: "구분자 없음" }, { env, ownsPane: async () => true, call: async () => { throw new Error("ECONNREFUSED"); } });
  assert.equal(failed, "");
});

test("prompt-targets는 64개 뒤의 구분자를 버리지 않고 상한 초과를 서버가 원자적으로 거절하게 한다", () => {
  const markers = Array.from({ length: 257 }, (_, index) => `@device:device-${index}~${String(index).padStart(8, "0")}`);
  assert.equal(extractPromptTargetMarkers(markers.join(" ")).length, 257);
});

test("prompt-targets CLI는 구분자가 없고 서버가 꺼져 있어도 출력 없이 exit 0", () => {
  const result = spawnSync(process.execPath, [path.resolve("bin/agent-context.mjs"), "prompt-targets"], {
    cwd: path.resolve("."), encoding: "utf8", input: JSON.stringify({ prompt: "일반 프롬프트" }),
    env: { ...process.env, HERDR_PANE_ID: "w1:p1", IRIS_PORT: "65534" }, timeout: 2000,
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("prompt-targets는 활성화 요약과 여러 기기 안내를 nonce 없이 돌려준다", async () => {
  const markers = ["@work-tab-a12345~nonce_123", "@device:d1~nonce_456", "@device:d2~nonce_789"];
  const output = await submitPromptTargets({ prompt: markers.join(" ") }, {
    env: { HERDR_PANE_ID: "w1:p1" }, ownsPane: async () => true,
    call: async () => ({ ok: true, data: { activated: [
      { kind: "tab", ref: "@work-tab-a12345", target: { tabId: "t1" } },
      { kind: "device", ref: "@device:d1", label: "Pixel", target: { udid: "d1" } },
      { kind: "device", ref: "@device:d2", label: "iPhone", target: { udid: "d2" } },
    ], rejected: [] } }),
  });
  assert.match(output, /지목 등록: 탭 @work-tab-a12345/);
  assert.match(output, /등록 기기가 2대라/);
  assert.doesNotMatch(output, /nonce_/);
});

test("세션 hook은 검증된 Codex 기록 경로를 pane과 Herdr에 함께 보고한다", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iris-agent-session-hook-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexRoot = path.join(root, "codex", "sessions");
  const claudeRoot = path.join(root, "claude", "projects");
  const stateDir = path.join(root, "state");
  fs.mkdirSync(codexRoot, { recursive: true });
  fs.mkdirSync(claudeRoot, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const uuid = "11111111-1111-4111-8111-111111111111";
  const file = path.join(codexRoot, `rollout-2026-09-28T00-00-00-${uuid}.jsonl`);
  fs.writeFileSync(file, "{}\n");
  const realFile = fs.realpathSync(file);
  const calls = [];
  const reports = [];
  const output = await submitPromptTargets({ session_id: uuid, transcript_path: file,
    hook_event_name: "SessionStart", source: "resume" }, {
    runtime: "codex", env: { HERDR_PANE_ID: "w1:p1" }, ownsPane: async () => true,
    pathOptions: { codexRoot, claudeRoot, stateDir },
    reportHerdr: async (session, hook) => reports.push([session, hook.source]),
    call: async (markers, pane, session) => { calls.push([markers, pane, session]); return { ok: true, data: {} }; },
  });
  assert.equal(output, "");
  assert.deepEqual(reports, [[{ paneId: "w1:p1", agent: "codex", sessionId: uuid, transcriptPath: realFile }, "resume"]]);
  assert.deepEqual(calls, [[[], "w1:p1", { paneId: "w1:p1", agent: "codex", sessionId: uuid, transcriptPath: realFile }]]);
});

test("공용 Codex 데몬이 물려받은 다른 pane 번호로는 기록 경로를 보고하지 않는다", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iris-agent-session-hook-daemon-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexRoot = path.join(root, "codex", "sessions");
  fs.mkdirSync(codexRoot, { recursive: true });
  const uuid = "22222222-2222-4222-8222-222222222222";
  const file = path.join(codexRoot, `rollout-2026-09-28T00-00-00-${uuid}.jsonl`);
  fs.writeFileSync(file, "{}\n");
  const reports = [];
  const calls = [];
  const client = { agentList: async () => [{ pane_id: "w9:p9", agent: "codex" }] };
  await submitPromptTargets({ session_id: uuid, transcript_path: file }, {
    runtime: "codex", env: { HERDR_PANE_ID: "w1:p1" }, ownsPane: async () => false, client,
    pathOptions: { codexRoot, claudeRoot: path.join(root, "claude"), stateDir: path.join(root, "state") },
    reportHerdr: async (session) => reports.push(session),
    call: async (_markers, pane, session) => { calls.push([pane, session]); return { ok: true, data: {} }; } });
  assert.deepEqual(reports, []);
  assert.deepEqual(calls, []);
});

test("세션 hook은 허용 루트 밖 경로를 제외하고 서브에이전트는 등록하지 않는다", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iris-agent-session-hook-boundary-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexRoot = path.join(root, "codex", "sessions");
  const outside = path.join(root, "outside.jsonl");
  fs.mkdirSync(codexRoot, { recursive: true });
  fs.writeFileSync(outside, "{}\n");
  const reports = [];
  const calls = [];
  for (const hook of [
    { session_id: "session", transcript_path: outside },
    { session_id: "session", transcript_path: path.join(codexRoot, "missing.jsonl"), agent_id: "child" },
  ]) {
    await submitPromptTargets(hook, { runtime: "codex", env: { HERDR_PANE_ID: "w1:p1" }, ownsPane: async () => true,
      pathOptions: { codexRoot, claudeRoot: path.join(root, "claude"), stateDir: path.join(root, "state") },
      reportHerdr: async (session) => reports.push(session),
      call: async (_markers, _pane, session) => { calls.push(session); return { ok: true, data: {} }; } });
  }
  assert.deepEqual(reports, [{ paneId: "w1:p1", agent: "codex", sessionId: "session" }]);
  assert.deepEqual(calls, [null]);
});

test("prompt-targets CLI는 서버가 꺼져도 한 줄을 출력하고 exit 0", () => {
  const marker = "@work-tab-a12345~nonce_123";
  const result = spawnSync(process.execPath, [path.resolve("bin/agent-context.mjs"), "prompt-targets"], {
    cwd: path.resolve("."), encoding: "utf8", input: JSON.stringify({ prompt: marker }),
    env: { ...process.env, HERDR_PANE_ID: "w1:p1", IRIS_PORT: "65534" }, timeout: 4000,
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout.trim(), /^지목 등록 실패: /);
  assert.equal(result.stdout.trim().split("\n").length, 1);
});

for (const runtime of ["codex", "claude"]) {
  test(`${runtime}: 기록 파일이 없는 새 대화와 재개 대화를 각각의 pane에 등록한다`, async () => {
    const reports = [];
    await Promise.all(Array.from({ length: 12 }, (_, i) => submitPromptTargets({
      session_id: `session-${i}`, hook_event_name: "SessionStart", source: i % 2 ? "resume" : "startup",
      transcript_path: `/not-created-yet/session-${i}.jsonl`,
    }, {
      runtime, env: { HERDR_PANE_ID: `w1:p${i}` }, ownsPane: async () => true,
      reportHerdr: async (session) => reports.push(session), call: async () => ({ ok: true }),
    })));
    assert.equal(reports.length, 12);
    for (let i = 0; i < 12; i++) assert.deepEqual(reports.find(r => r.sessionId === `session-${i}`), {
      paneId: `w1:p${i}`, agent: runtime, sessionId: `session-${i}`,
    });
  });

  test(`${runtime}: 오래된 환경변수가 있으면 등록된 현재 대화의 pane으로 지목과 기록을 보낸다`, async () => {
    const calls = [];
    const reports = [];
    await submitPromptTargets({ session_id: "current", prompt: "@work-tab-a12345~nonce_123" }, {
      runtime, env: { HERDR_PANE_ID: "w1:old" }, ownsPane: async () => false,
      client: { agentList: async () => [{ pane_id: "w2:current", agent: runtime, agent_session: { value: "current" } }] },
      reportHerdr: async (session) => reports.push(session),
      call: async (_markers, pane) => { calls.push(pane); return { ok: true }; },
    });
    assert.deepEqual(calls, ["w2:current"]);
    assert.equal(reports[0].paneId, "w2:current");
  });
}

test("등록 hook은 큰 첨부 데이터가 있어도 입력 JSON을 잘라 버리지 않는다", () => {
  const result = spawnSync(process.execPath, [path.resolve("bin/agent-context.mjs"), "prompt-targets"], {
    encoding: "utf8", input: JSON.stringify({ hook_event_name: "SessionStart", image: "A".repeat(2_000_000) }),
    env: { ...process.env, HERDR_PANE_ID: "", IRIS_SESSION: "" }, timeout: 3000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("공유 daemon의 등록 없는 재개 대화는 현재 resume ID로 등록과 지목을 복구한다", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const reports = [], calls = [];
  const client = {
    agentList: async () => [{ pane_id: "w2:resume", agent: "codex" }],
    call: async () => ({ process_info: { foreground_processes: [{ argv: ["codex", "resume", id] }] } }),
  };
  const deps = { runtime: "codex", env: {}, client,
    reportHerdr: async (session) => reports.push(session),
    call: async (_markers, pane) => { calls.push(pane); return { ok: true }; } };
  await submitPromptTargets({ session_id: id, prompt: "@work-tab-a12345~nonce_123" }, deps);
  assert.deepEqual(calls, ["w2:resume"]);
  assert.equal(reports[0].sessionId, id);
  const output = await submitPromptTargets({ session_id: "22222222-2222-4222-8222-222222222222", prompt: "@work-tab-a12345~nonce_123" }, deps);
  assert.match(output, /paneを|pane을 확인하지 못/);
  assert.equal(reports.length, 1);
});

test("core 환경 정책이 pane 변수를 제외해도 로컬 Codex의 프로세스로 새 대화를 등록한다", async () => {
  const reports = [];
  await submitPromptTargets({ session_id: "new-thread" }, {
    runtime: "codex", env: {}, ancestry: async () => [300, 200, 100],
    client: { agentList: async () => [{ agent: "codex", pane_id: "owned" }],
      call: async () => ({ process_info: { shell_pid: 100 } }) },
    reportHerdr: async (session) => reports.push(session), call: async () => ({ ok: true }),
  });
  assert.equal(reports[0]?.paneId, "owned");
  assert.equal(reports[0]?.sessionId, "new-thread");
});

test("SessionStart는 등록만 하고 UserPromptSubmit만 지목을 적용한다", async () => {
  const modes = [];
  const deps = { runtime: "codex", env: { HERDR_PANE_ID: "owned" }, ownsPane: async () => true,
    reportHerdr: async () => {}, call: async (_markers, _pane, _session, options) => { modes.push(options.registerOnly); return { ok: true }; } };
  await submitPromptTargets({ session_id: "thread", hook_event_name: "SessionStart" }, deps);
  await submitPromptTargets({ session_id: "thread", hook_event_name: "UserPromptSubmit", prompt: "" }, deps);
  assert.deepEqual(modes, [true, false]);
});
