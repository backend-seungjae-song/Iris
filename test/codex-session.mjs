import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { codexSessionFromPath, liveRolloutForTree, resolveCodexSession } from "../server/codex-session.js";
import { reportAgentSessionPath, resetAgentSessionPathsForTest } from "../server/agent-session-path.js";

function rollout(dir, uuid, mtime) {
  const file = path.join(dir, `rollout-2026-09-27T00-00-00-${uuid}.jsonl`);
  fs.writeFileSync(file, "\n");
  fs.utimesSync(file, new Date(mtime), new Date(mtime));
  return file;
}

test("finds the current Codex rollout in a child daemon without crossing pane processes", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-codex-session-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const old = rollout(dir, "11111111-1111-1111-1111-111111111111", 1_000);
  const current = rollout(dir, "22222222-2222-2222-2222-222222222222", 3_000);
  const unrelated = rollout(dir, "33333333-3333-3333-3333-333333333333", 4_000);
  const byPid = new Map([[20, [old]], [21, [current]], [30, [unrelated]]]);
  const children = new Map([
    [10, [{ pid: 20 }, { pid: 21 }]],
    [20, [{ pid: 10 }]],
    [1, [{ pid: 10 }, { pid: 30 }]],
  ]);

  assert.deepEqual(liveRolloutForTree(byPid, children, 10), {
    uuid: "22222222-2222-2222-2222-222222222222", file: current, mtime: 3_000,
  });
  assert.equal(liveRolloutForTree(byPid, children, 30)?.uuid, "33333333-3333-3333-3333-333333333333");
  assert.equal(liveRolloutForTree(byPid, children, 40), null);
});

test("공용 app-server가 여러 rollout을 열어도 pane 자손이 아니면 고르지 않는다", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-codex-daemon-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = rollout(dir, "11111111-1111-4111-8111-111111111111", 3_000);
  const second = rollout(dir, "22222222-2222-4222-8222-222222222222", 4_000);
  const byPid = new Map([[90, [first, second]]]);
  const children = new Map([[1, [{ pid: 10 }, { pid: 11 }, { pid: 90 }]]]);
  assert.equal(liveRolloutForTree(byPid, children, 10), null);
  assert.equal(liveRolloutForTree(byPid, children, 11), null);
});

test("hook이 보고한 pane별 Codex 경로를 공용 daemon 탐색보다 먼저 쓴다", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iris-codex-hook-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => resetAgentSessionPathsForTest());
  const codexHome = path.join(root, "codex");
  const sessions = path.join(codexHome, "sessions");
  const claude = path.join(root, "claude", "projects");
  const state = path.join(root, "state");
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(claude, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  t.after(() => previous === undefined ? delete process.env.CODEX_HOME : process.env.CODEX_HOME = previous);
  const uuid = "11111111-1111-4111-8111-111111111111";
  const file = rollout(sessions, uuid, 1_000);
  reportAgentSessionPath({ paneId: "w1:p1", agent: "codex", sessionId: uuid, transcriptPath: file },
    { codexRoot: sessions, claudeRoot: claude, stateDir: state });
  let inspected = false;
  const hit = await resolveCodexSession({ paneGet: async () => {
    inspected = true; return { agent: "codex", agent_session: { kind: "id", value: uuid } };
  },
    call: async () => { inspected = true; return {}; } }, "w1:p1");
  assert.deepEqual(hit, { uuid, file: fs.realpathSync(file) });
  assert.equal(inspected, true);
  assert.equal(await resolveCodexSession({ paneGet: async () => ({ agent: "codex" }),
    call: async () => ({ process_info: { foreground_processes: [] } }) }, "w1:p1"), null,
  "등록이 지워진 pane에는 이전 hook 경로를 재사용하지 않는다");
});

test("Codex 경로의 파일 id와 hook session id가 다르면 다른 pane 대화로 묶지 않는다", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iris-codex-path-mismatch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessions = path.join(root, "sessions");
  const claude = path.join(root, "claude");
  const state = path.join(root, "state");
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(claude, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  const file = rollout(sessions, "11111111-1111-4111-8111-111111111111", 1_000);
  assert.equal(codexSessionFromPath(file, "22222222-2222-4222-8222-222222222222",
    { codexRoot: sessions, claudeRoot: claude, stateDir: state }), null);
});

test("등록 ID로 닫힌 기록 파일을 찾고 이전 hook 경로를 무시한다", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iris-codex-id-"));
  const sessions = path.join(root, "sessions", "2026", "09", "29");
  fs.mkdirSync(sessions, { recursive: true });
  const before = process.env.CODEX_HOME;
  process.env.CODEX_HOME = root;
  t.after(() => {
    before === undefined ? delete process.env.CODEX_HOME : process.env.CODEX_HOME = before;
    resetAgentSessionPathsForTest();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const oldId = "11111111-1111-4111-8111-111111111111";
  const id = "22222222-2222-4222-8222-222222222222";
  const old = rollout(sessions, oldId, 2000);
  const file = rollout(sessions, id, 1000);
  reportAgentSessionPath({ paneId: "w1:p1", agent: "codex", sessionId: oldId, transcriptPath: old });
  const herdr = { paneGet: async () => ({ agent: "codex", agent_session: { kind: "id", value: id } }),
    call: async () => { throw Error("등록 ID가 있으면 다른 프로세스를 탐색하지 않는다"); } };
  assert.deepEqual(await resolveCodexSession(herdr, "w1:p1"), { uuid: id, file: fs.realpathSync(file) });
});

test("같은 ID의 기록이 둘이면 기록을 고르지 않는다", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iris-codex-duplicate-"));
  const sessions = path.join(root, "sessions");
  fs.mkdirSync(sessions);
  const before = process.env.CODEX_HOME;
  process.env.CODEX_HOME = root;
  t.after(() => {
    before === undefined ? delete process.env.CODEX_HOME : process.env.CODEX_HOME = before;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const id = "22222222-2222-4222-8222-222222222222";
  const file = rollout(sessions, id, 1000);
  fs.copyFileSync(file, path.join(sessions, `rollout-2026-09-28-${id}.jsonl`));
  assert.deepEqual(await resolveCodexSession({ paneGet: async () => ({ agent: "codex",
    agent_session: { kind: "id", value: id } }) }, "w1:p1"), { uuid: id, file: null });
});

test("resume 첫 입력 전에도 명시한 ID의 기록을 찾는다", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iris-codex-resume-"));
  fs.mkdirSync(path.join(root, "sessions"));
  const before = process.env.CODEX_HOME;
  process.env.CODEX_HOME = root;
  t.after(() => {
    before === undefined ? delete process.env.CODEX_HOME : process.env.CODEX_HOME = before;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const id = "22222222-2222-4222-8222-222222222222";
  const file = rollout(path.join(root, "sessions"), id, 1000);
  const argv = ["/bin/codex", "--no-daemon", "resume", id];
  const herdr = { paneGet: async () => ({ agent: "codex" }), call: async () => ({ process_info: {
    foreground_processes: [{ name: "codex", pid: 2147483647, argv }],
  } }) };
  assert.deepEqual(await resolveCodexSession(herdr, "w1:p1"), { uuid: id, file: fs.realpathSync(file) });
  argv.pop();
  assert.equal(await resolveCodexSession(herdr, "w1:p1"), null);
});
