// 임시 Git 저장소에서 Worktree 생성·삭제 경계와 중복 요청을 검증한다.
// 소유 범위: worktrees.* 서버 계약의 격리된 회귀 검사.
// 제공 API: node --test test/worktrees.mjs.
// 의존 대상: OS 임시 폴더와 설치된 Git.
// 유지 조건: 실제 사용자 저장소와 상태 폴더를 수정하지 않는다.
// 영향 범위: server/worktree-handlers.js.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createWorktreeFromCommand, handleWorktrees, initWorktrees, performWorktreeRequest } from "../server/worktree-handlers.js";
import { createWorktree } from "../bin/agent-context.mjs";
import { replace } from "../server/runtime-state.js";

function git(cwd, ...args) { return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim(); }
async function fixture(t, repoName = "project") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-worktrees-test-"));
  const previousStateDir = process.env.IRIS_STATE_DIR;
  process.env.IRIS_STATE_DIR = path.join(dir, "state");
  initWorktrees({ herdr: { paneList: async () => [] } });
  t.after(() => {
    if (previousStateDir === undefined) delete process.env.IRIS_STATE_DIR;
    else process.env.IRIS_STATE_DIR = previousStateDir;
    fs.rmSync(dir, { recursive: true, force: true });
    replace({ workspaces: [], state: [], allowedRoots: [] });
  });
  const repo = path.join(dir, repoName); fs.mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Test"); git(repo, "config", "user.email", "test@example.test");
  fs.writeFileSync(path.join(repo, "README.md"), "start\n");
  git(repo, "add", "README.md"); git(repo, "commit", "-m", "initial");
  replace({ workspaces: [{ id: "space-1", folder: repo }], state: [], allowedRoots: [repo] });
  return { dir, repo, message: { spaceId: "space-1", repo } };
}

test("creates a real worktree, lists it, and removes it without deleting its branch", async (t) => {
  const { repo, message } = await fixture(t);
  const made = await performWorktreeRequest({ type: "worktrees.create", ...message, name: "review", branch: "feat/review", base: "main" });
  assert.equal(made.primary, fs.realpathSync(repo));
  assert.equal(fs.existsSync(path.join(made.path, "README.md")), true);
  assert.equal(git(made.path, "branch", "--show-current"), "feat/review");
  const listed = await performWorktreeRequest({ type: "worktrees.list", ...message });
  assert.equal(listed.entries.find((entry) => entry.path === made.path)?.managed, true);
  await performWorktreeRequest({ type: "worktrees.remove", ...message, path: made.path });
  assert.equal(fs.existsSync(made.path), false);
  assert.match(git(repo, "branch", "--list", "feat/review"), /feat\/review/);
});

test("목록은 한글·공백·탭이 포함된 저장소 경로를 그대로 보존한다", async (t) => {
  const { repo, message } = await fixture(t, "프로젝트 코드\troot");
  const listed = await performWorktreeRequest({ type: "worktrees.list", ...message });
  assert.equal(listed.primary, fs.realpathSync(repo));
  assert.equal(listed.entries[0].path, fs.realpathSync(repo));
});

test("refuses dirty and open worktrees", async (t) => {
  const { repo, message } = await fixture(t);
  const made = await performWorktreeRequest({ type: "worktrees.create", ...message, name: "review", branch: "feat/review", base: "main" });
  fs.writeFileSync(path.join(made.path, "untracked.txt"), "keep");
  await assert.rejects(performWorktreeRequest({ type: "worktrees.remove", ...message, path: made.path }), { code: "DIRTY" });
  fs.unlinkSync(path.join(made.path, "untracked.txt"));
  replace({ workspaces: [{ id: "space-1", folder: repo }, { id: "space-2", folder: made.path }] });
  await assert.rejects(performWorktreeRequest({ type: "worktrees.remove", ...message, path: made.path }), { code: "ACTIVE" });
  replace({ workspaces: [{ id: "space-1", folder: repo }], state: [{ cwd: made.path }] });
  await assert.rejects(performWorktreeRequest({ type: "worktrees.remove", ...message, path: made.path }), { code: "ACTIVE" });
});


test("refuses ignored untracked files before removal", async (t) => {
  const { message } = await fixture(t);
  const made = await performWorktreeRequest({ type: "worktrees.create", ...message, name: "review", branch: "feat/review", base: "main" });
  fs.writeFileSync(path.join(made.path, ".gitignore"), "secret.env\n");
  git(made.path, "add", ".gitignore");
  git(made.path, "commit", "-m", "ignore secret");
  fs.writeFileSync(path.join(made.path, "secret.env"), "keep");
  await assert.rejects(performWorktreeRequest({ type: "worktrees.remove", ...message, path: made.path }), { code: "DIRTY" });
  assert.equal(fs.existsSync(path.join(made.path, "secret.env")), true);
});

test("refuses remote mutations, path escape, and primary deletion", async (t) => {
  const { repo, message } = await fixture(t);
  await assert.rejects(performWorktreeRequest({ type: "worktrees.create", ...message, name: "../escape", branch: "feat/escape", base: "main" }), { code: "NAME" });
  await assert.rejects(performWorktreeRequest({ type: "worktrees.remove", ...message, path: repo }), { code: "PATH" });
  await assert.rejects(performWorktreeRequest({ type: "worktrees.create", ...message, name: "review", branch: "feat/review", base: "main" }, false), { code: "LOCAL_ONLY" });
});

test("serializes simultaneous changes to one repository", async (t) => {
  const { message } = await fixture(t);
  const outcomes = await Promise.allSettled([
    performWorktreeRequest({ type: "worktrees.create", ...message, name: "one", branch: "feat/one", base: "main" }),
    performWorktreeRequest({ type: "worktrees.create", ...message, name: "two", branch: "feat/two", base: "main" }),
  ]);
  assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(outcomes.find((result) => result.status === "rejected")?.reason.code, "BUSY");
});


test("repeated request ID executes one create and replays its receipt", async (t) => {
  const { repo, message } = await fixture(t);
  let finish;
  const first = new Promise((resolve) => { finish = resolve; });
  const sent = [];
  const ws = { _local: true, send(body) { const result = JSON.parse(body); sent.push(result); finish(result); } };
  const request = { type: "worktrees.create", requestId: "same-request", ...message, name: "review", branch: "feat/review", base: "main" };
  assert.equal(handleWorktrees(ws, request), true);
  assert.equal(handleWorktrees(ws, request), true);
  const result = await first;
  assert.equal(result.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(handleWorktrees(ws, request), true);
  assert.deepEqual(sent[1], result);
  assert.equal(git(repo, "worktree", "list", "--porcelain").match(/worktree /g)?.length, 2);
});

test("does not claim an external worktree in the managed directory", async (t) => {
  const { repo, message } = await fixture(t);
  const listed = await performWorktreeRequest({ type: "worktrees.list", ...message });
  const external = path.join(path.dirname(listed.primary), path.basename(listed.primary) + "-worktrees", "external");
  fs.mkdirSync(path.dirname(external), { recursive: true });
  git(repo, "worktree", "add", "-b", "feat/external", "--", external, "main");
  const current = await performWorktreeRequest({ type: "worktrees.list", ...message });
  assert.equal(current.entries.find((entry) => entry.path === external)?.managed, false);
  await assert.rejects(performWorktreeRequest({ type: "worktrees.remove", ...message, path: external }), { code: "PATH" });
  assert.equal(fs.existsSync(external), true);
});

test("refuses deletion when a live terminal uses the worktree or pane query fails", async (t) => {
  const { message } = await fixture(t);
  const made = await performWorktreeRequest({ type: "worktrees.create", ...message, name: "review", branch: "feat/review", base: "main" });
  initWorktrees({ herdr: { paneList: async () => [{ cwd: made.path }] } });
  await assert.rejects(performWorktreeRequest({ type: "worktrees.remove", ...message, path: made.path }), { code: "ACTIVE" });
  initWorktrees({ herdr: { paneList: async () => { throw new Error("unavailable"); } } });
  await assert.rejects(performWorktreeRequest({ type: "worktrees.remove", ...message, path: made.path }), { code: "SESSIONS" });
  assert.equal(fs.existsSync(made.path), true);
});

test("목록은 worktree 마다 그 폴더를 쓰는 스페이스·에이전트·터미널을 싣는다", async (t) => {
  const { repo, message } = await fixture(t);
  const made = await performWorktreeRequest({ type: "worktrees.create", ...message, name: "review", branch: "feat/review", base: "main" });
  const empty = await performWorktreeRequest({ type: "worktrees.list", ...message });
  assert.deepEqual(empty.entries.find((entry) => entry.path === made.path).users, []);
  assert.equal("users" in empty.entries[0], false, "기본 저장소 행은 스페이스 행이 이미 보여 준다");

  fs.mkdirSync(path.join(made.path, "src"));
  replace({
    workspaces: [{ id: "space-1", folder: repo }, { id: "space-2", label: "review", folder: made.path }],
    state: [
      { agent: "claude", status: "working", workspaceId: "space-1", paneId: "p1", tabLabel: "리뷰", cwd: path.join(made.path, "src") },
      { agent: "codex", status: "idle", workspaceId: "space-1", paneId: "p2", cwd: repo },
    ],
  });
  initWorktrees({ herdr: { paneList: async () => [
    { pane_id: "p1", workspace_id: "space-1", cwd: made.path },
    { pane_id: "p3", workspace_id: "space-1", cwd: made.path },
    { pane_id: "p4", workspace_id: "space-1", cwd: repo },
  ] } });
  // 에이전트 cwd 가 어긋나도 그 pane 이 안에 있으면 이름 없는 터미널이 아니라 그 에이전트로 적는다.
  replace({ workspaces: [{ id: "space-1", folder: repo }], state: [{ agent: "codex", status: "idle", workspaceId: "space-1", paneId: "p3", cwd: "/nonexistent" }] });
  const byPane = await performWorktreeRequest({ type: "worktrees.list", ...message });
  assert.deepEqual(byPane.entries.find((entry) => entry.path === made.path).users.map((user) => [user.kind, user.paneId]),
    [["agent", "p3"], ["pane", "p1"]]);
  replace({
    workspaces: [{ id: "space-1", folder: repo }, { id: "space-2", label: "review", folder: made.path }],
    state: [
      { agent: "claude", status: "working", workspaceId: "space-1", paneId: "p1", tabLabel: "리뷰", cwd: path.join(made.path, "src") },
      { agent: "codex", status: "idle", workspaceId: "space-1", paneId: "p2", cwd: repo },
    ],
  });
  const listed = await performWorktreeRequest({ type: "worktrees.list", ...message });
  assert.deepEqual(listed.entries.find((entry) => entry.path === made.path).users, [
    { kind: "space", workspaceId: "space-2", label: "review" },
    { kind: "agent", workspaceId: "space-1", paneId: "p1", agent: "claude", status: "working", label: "리뷰" },
    { kind: "pane", workspaceId: "space-1", paneId: "p3" },
  ]);

  initWorktrees({ herdr: { paneList: async () => { throw new Error("unavailable"); } } });
  const unknown = await performWorktreeRequest({ type: "worktrees.list", ...message });
  assert.equal(unknown.entries.find((entry) => entry.path === made.path).users, null, "모르면 비어 있다고 적지 않는다");
});

test("same request ID with a changed payload is rejected", async (t) => {
  const { message } = await fixture(t);
  const sent = [];
  let done;
  const complete = new Promise((resolve) => { done = resolve; });
  const ws = { _local: true, send(body) { const value = JSON.parse(body); sent.push(value); if (value.ok) done(); } };
  const base = { type: "worktrees.create", requestId: "fixed-id", ...message, name: "one", branch: "feat/one", base: "main" };
  handleWorktrees(ws, base);
  handleWorktrees(ws, { ...base, name: "two", branch: "feat/two" });
  await complete;
  assert.equal(sent.find((item) => item.code === "REQUEST_CONFLICT")?.ok, false);
  const listed = await performWorktreeRequest({ type: "worktrees.list", ...message });
  assert.equal(listed.entries.filter((entry) => !entry.primary).length, 1);
});

// 만든 세션 기록과 실행 중 판정. herdr 와 프로세스 표는 대역
function fakeHerdr(panes, shells = {}) {
  return { paneList: async () => panes, call: async (method, params) => {
    assert.equal(method, "pane.process_info");
    return { process_info: { pane_id: params.pane_id, shell_pid: shells[params.pane_id] } };
  } };
}
const MAKER = { pane_id: "w1:p1", terminal_id: "term_a", workspace_id: "w1", cwd: "/", agent: "claude", agent_session: { value: "chat-1" } };
const listOf = async (message, target) => (await performWorktreeRequest({ type: "worktrees.list", ...message })).entries.find((entry) => entry.path === target);

test("명령으로 만든 worktree 는 만든 세션이 기록되고, 그 세션이 끝나면 끝남으로 실린다", async (t) => {
  const { repo, message } = await fixture(t);
  replace({ workspaces: [{ id: "space-1", folder: repo }], state: [{ agent: "claude", status: "working", workspaceId: "w1", paneId: "w1:p1", tabLabel: "리뷰", cwd: repo }] });
  const session = { paneId: "w1:p1", terminalId: "term_a", workspaceId: "w1", agent: "claude", sessionId: "chat-1", label: "옛 이름" };
  const made = await createWorktreeFromCommand({ repo, name: "cmd", branch: "feat/cmd", base: "main", session });
  assert.equal(made.recorded, true);
  initWorktrees({ herdr: fakeHerdr([MAKER], { "w1:p1": 999999 }), processes: { list: async () => [], cwds: async () => new Map() } });
  const alive = await listOf(message, made.path);
  assert.deepEqual(alive.creator.session, { paneId: "w1:p1", workspaceId: "w1", agent: "claude", alive: true, label: "리뷰", status: "working" });
  assert.equal(alive.creator.source, "command");
  assert.equal(alive.managed, true, "명령으로 만든 worktree 도 만든 세션 기록으로 Iris 에서 삭제할 수 있다");

  initWorktrees({ herdr: fakeHerdr([]) });
  assert.equal((await listOf(message, made.path)).creator.session.alive, false, "pane 이 없으면 끝남");
  assert.equal((await listOf(message, made.path)).creator.session.label, "옛 이름", "끝난 세션은 기록한 이름");
  initWorktrees({ herdr: fakeHerdr([{ ...MAKER, terminal_id: "term_b" }], { "w1:p1": 999999 }), processes: { list: async () => [], cwds: async () => new Map() } });
  assert.equal((await listOf(message, made.path)).creator.session.alive, false, "같은 pane id 의 다른 터미널은 끝남");
  initWorktrees({ herdr: fakeHerdr([{ ...MAKER, agent_session: { value: "chat-2" } }], { "w1:p1": 999999 }), processes: { list: async () => [], cwds: async () => new Map() } });
  assert.equal((await listOf(message, made.path)).creator.session.alive, false, "다른 대화로 바뀌면 끝남");
  initWorktrees({ herdr: { paneList: async () => { throw new Error("unavailable"); } } });
  assert.equal((await listOf(message, made.path)).creator.session.alive, null, "pane 을 못 읽으면 모름");
});

test("git 으로 직접 만든 worktree 는 만든 세션 모름, 같은 경로에 다시 만든 폴더는 이전 기록을 쓰지 않는다", async (t) => {
  const { repo, message } = await fixture(t);
  const external = path.join(path.dirname(fs.realpathSync(repo)), "project-worktrees", "direct");
  git(repo, "worktree", "add", "-b", "feat/direct", "--", external, "main");
  assert.equal((await listOf(message, external)).creator, null);

  const made = await createWorktreeFromCommand({ repo, name: "again", branch: "feat/again", base: "main", session: null });
  assert.deepEqual((await listOf(message, made.path)).creator.session, null);
  git(repo, "worktree", "remove", "--", made.path);
  git(repo, "worktree", "add", "-b", "feat/again-2", "--", made.path, "main");
  assert.equal((await listOf(message, made.path)).creator, null, "폴더 식별값이 다르면 기록을 인정하지 않는다");
  assert.equal((await listOf(message, made.path)).managed, false, "다시 만든 폴더는 삭제 대상이 아니다");
});

test("명령으로 만든 worktree 를 Iris 에서 삭제하면 만든 세션 기록도 지운다", async (t) => {
  const { repo, message } = await fixture(t);
  initWorktrees({ herdr: fakeHerdr([]), processes: { list: async () => [], cwds: async () => new Map() } });
  const made = await createWorktreeFromCommand({ repo, name: "gone", branch: "feat/gone", base: "main", session: null });
  assert.equal((await listOf(message, made.path)).managed, true);
  await performWorktreeRequest({ type: "worktrees.remove", ...message, path: made.path });
  assert.equal(fs.existsSync(made.path), false);
  assert.equal(git(repo, "branch", "--list", "feat/gone").trim(), "feat/gone", "브랜치는 남는다");
});

test("Iris 에서 만든 worktree 는 Iris 에서 만듦이고, 자동 실행한 세션은 그 스페이스의 에이전트 pane 만 기록한다", async (t) => {
  const { repo, message } = await fixture(t);
  const made = await performWorktreeRequest({ type: "worktrees.create", ...message, name: "ui", branch: "feat/ui", base: "main" });
  assert.deepEqual((await listOf(message, made.path)).creator.session, null);
  assert.equal((await listOf(message, made.path)).creator.source, "iris");
  replace({ workspaces: [{ id: "space-1", folder: repo }, { id: "w2", folder: made.path }], state: [] });
  const launchedMsg = { type: "worktrees.launched", spaceId: "w2", repo: made.path, path: made.path };
  initWorktrees({ herdr: fakeHerdr([{ pane_id: "w1:p9", terminal_id: "term_x", workspace_id: "w1", cwd: repo, agent: "codex" }]) });
  await assert.rejects(performWorktreeRequest({ ...launchedMsg, paneId: "w1:p9" }), { code: "PANE" }, "다른 스페이스의 pane 은 받지 않는다");
  const launched = { pane_id: "w2:p1", terminal_id: "term_l", workspace_id: "w2", cwd: made.path, agent: "codex" };
  initWorktrees({ herdr: fakeHerdr([launched], { "w2:p1": 999999 }), processes: { list: async () => [], cwds: async () => new Map() } });
  await performWorktreeRequest({ ...launchedMsg, paneId: "w2:p1" });
  const bound = (await listOf(message, made.path)).creator;
  assert.equal(bound.source, "iris");
  assert.equal(bound.session.paneId, "w2:p1");
  assert.equal(bound.session.alive, true);
});

test("실행 중: pane 셸의 자손 프로세스가 worktree 안을 cwd 로 두면 실행 중이고 삭제를 거부한다", async (t) => {
  const { repo, message } = await fixture(t);
  const made = await performWorktreeRequest({ type: "worktrees.create", ...message, name: "run", branch: "feat/run", base: "main" });
  fs.mkdirSync(path.join(made.path, "src"));
  const inside = path.join(fs.realpathSync(made.path), "src");
  replace({ workspaces: [{ id: "space-1", folder: repo }], state: [{ agent: "claude", status: "working", workspaceId: "w1", paneId: "w1:p1", tabLabel: "구현", cwd: repo }] });
  // pane 셸 100 → claude 101 → bash 102(worktree 안). 다른 pane 셸 200 의 자식 201 은 저장소 루트
  const table = [{ pid: 100, ppid: 1 }, { pid: 101, ppid: 100 }, { pid: 102, ppid: 101 }, { pid: 200, ppid: 1 }, { pid: 201, ppid: 200 }, { pid: 300, ppid: 1 }];
  const cwdOf = new Map([[100, repo], [101, repo], [102, inside], [200, repo], [201, repo], [300, inside]]);
  let scans = 0;
  const processes = { list: async () => { scans++; return table; }, cwds: async (pids) => new Map(pids.filter((pid) => cwdOf.has(pid)).map((pid) => [pid, cwdOf.get(pid)])) };
  const panes = [{ ...MAKER, cwd: repo }, { pane_id: "w1:p2", terminal_id: "term_c", workspace_id: "w1", cwd: repo }];
  initWorktrees({ herdr: fakeHerdr(panes, { "w1:p1": 100, "w1:p2": 200 }), processes });
  const entry = await listOf(message, made.path);
  assert.deepEqual(entry.running, [{ kind: "agent", workspaceId: "w1", paneId: "w1:p1", agent: "claude", status: "working", label: "구현" }],
    "pane 밖 프로세스(300)는 세지 않는다");
  assert.deepEqual(entry.users, [], "pane cwd 는 밖이라 이 폴더에서 작업은 아니다");
  await listOf(message, made.path);
  assert.equal(scans, 1, "잠깐 사이의 목록 요청은 한 번의 조사를 함께 쓴다");
  await assert.rejects(performWorktreeRequest({ type: "worktrees.remove", ...message, path: made.path }), { code: "ACTIVE" });
  assert.equal(scans, 2, "삭제는 새로 조사한다");
  assert.equal(fs.existsSync(made.path), true);

  cwdOf.set(102, repo);
  initWorktrees({ herdr: fakeHerdr(panes, { "w1:p1": 100, "w1:p2": 200 }), processes });
  assert.deepEqual((await listOf(message, made.path)).running, []);
  initWorktrees({ herdr: fakeHerdr(panes, { "w1:p1": 100 }), processes });
  assert.equal((await listOf(message, made.path)).running, null, "셸 pid 를 못 읽은 pane 이 있으면 모름");
  await assert.rejects(performWorktreeRequest({ type: "worktrees.remove", ...message, path: made.path }), { code: "SESSIONS" });
  initWorktrees({ herdr: fakeHerdr(panes, { "w1:p1": 100, "w1:p2": 200 }), processes });
  await performWorktreeRequest({ type: "worktrees.remove", ...message, path: made.path });
  assert.equal(fs.existsSync(made.path), false);
});

test("폴더가 지워진 스페이스는 FOLDER 로 알린다", async (t) => {
  const { dir, message } = await fixture(t);
  const gone = path.join(dir, "gone");
  fs.mkdirSync(gone);
  replace({ workspaces: [{ id: "space-gone", folder: gone }] });
  fs.rmdirSync(gone);
  await assert.rejects(performWorktreeRequest({ type: "worktrees.list", spaceId: "space-gone", repo: gone }), { code: "FOLDER" });
  replace({ workspaces: [{ id: "space-1", folder: message.repo }] });
});

test("목록 change 는 기준 브랜치 대비 커밋·작업 트리 변경과 마지막 커밋 시각을 구분한다", async (t) => {
  const { dir, repo, message } = await fixture(t);
  const dirty = path.join(dir, "dirty");
  git(repo, "worktree", "add", "-b", "feat/dirty", "--", dirty, "main");
  const dirtyPath = fs.realpathSync(dirty);
  fs.writeFileSync(path.join(dirty, "README.md"), "changed\nmore\n");
  fs.writeFileSync(path.join(dirty, "committed.txt"), "one\n");
  git(dirty, "add", "README.md", "committed.txt");
  git(dirty, "commit", "-m", "dirty branch commit");
  fs.appendFileSync(path.join(dirty, "README.md"), "working\n");
  fs.writeFileSync(path.join(dirty, "untracked.txt"), "draft\n");

  const clean = path.join(dir, "clean");
  git(repo, "worktree", "add", "-b", "feat/clean", "--", clean, "main");
  const cleanPath = fs.realpathSync(clean);
  const listed = await performWorktreeRequest({ type: "worktrees.list", ...message });
  assert.deepEqual(listed.entries.find((entry) => entry.path === dirtyPath).change, {
    base: "main", ahead: 1, added: 4, deleted: 1, uncommitted: 2,
    lastCommitAt: git(dirty, "log", "-1", "--format=%cI", "HEAD"),
  });
  assert.deepEqual(listed.entries.find((entry) => entry.path === cleanPath).change, {
    base: "main", ahead: 0, added: 0, deleted: 0, uncommitted: 0,
    lastCommitAt: git(clean, "log", "-1", "--format=%cI", "HEAD"),
  });
  assert.equal("change" in listed.entries[0], false, "기본 저장소 항목에는 change 를 붙이지 않는다");
});

test("worktree Git 상태 하나라도 읽지 못하면 change 는 null 이다", async (t) => {
  const { dir, repo, message } = await fixture(t);
  const broken = path.join(dir, "broken");
  git(repo, "worktree", "add", "-b", "feat/broken", "--", broken, "main");
  const brokenPath = fs.realpathSync(broken);
  const worktreeGit = git(broken, "rev-parse", "--git-dir");
  fs.writeFileSync(path.join(worktreeGit, "HEAD"), "ref: refs/heads/does-not-exist\n");
  const listed = await performWorktreeRequest({ type: "worktrees.list", ...message });
  assert.equal(listed.entries.find((entry) => entry.path === brokenPath).change, null);
});

test("기본 저장소가 분리 HEAD이면 비교 기준이 없어 change 는 null 이다", async (t) => {
  const { dir, repo, message } = await fixture(t);
  const detached = path.join(dir, "detached-base");
  git(repo, "worktree", "add", "-b", "feat/detached-base", "--", detached, "main");
  git(repo, "checkout", "--detach");
  const listed = await performWorktreeRequest({ type: "worktrees.list", ...message });
  assert.equal(listed.entries.find((entry) => entry.path === fs.realpathSync(detached)).change, null);
});

test("worktree 명령은 부른 pane 이 이 프로세스의 조상일 때만 만든 세션으로 기록한다", async (t) => {
  const { dir, repo, message } = await fixture(t);
  const socketPath = path.join(dir, "herdr.sock");
  const pane = { pane_id: "w1:p1", terminal_id: "term_a", workspace_id: "w1", tab_id: "w1:t1", agent: "claude", agent_session: { value: "chat-1" } };
  const client = { paneGet: async () => pane, call: async () => ({ process_info: { shell_pid: 4242 } }), tabList: async () => [{ tab_id: "w1:t1", label: "작업" }] };
  const env = { HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: socketPath };
  const made = await createWorktree({ repo, name: "cli" }, { env, socketPath, client, ancestors: new Set([4242]) });
  assert.deepEqual(made.creator, { paneId: "w1:p1", workspaceId: "w1", agent: "claude" });
  assert.equal(made.branch, "feat/cli");
  assert.equal(made.base, "main", "기준은 지금 브랜치");
  const listed = await listOf(message, made.path);
  assert.equal(listed.creator.session.label, "작업");

  const other = await createWorktree({ repo, name: "cli2" }, { env, socketPath, client, ancestors: new Set([1]) });
  assert.equal(other.creator, null, "조상이 아닌 pane 은 기록하지 않는다");
  const mismatch = await createWorktree({ repo, name: "cli3" }, { env, socketPath: path.join(dir, "other.sock"), client, ancestors: new Set([4242]) });
  assert.equal(mismatch.creator, null, "다른 herdr 세션의 pane 은 기록하지 않는다");
  const outside = await createWorktree({ repo, name: "cli4" }, { env: {}, socketPath, client, ancestors: new Set([4242]) });
  assert.equal(outside.creator, null);
  assert.equal((await listOf(message, outside.path)).creator.source, "command");
});

test("상위 폴더에서 시작한 idle 세션을 작업 기록의 워크트리에 연결한다", async (t) => {
  const { dir, repo } = await fixture(t);
  const folder = fs.realpathSync(dir), task = path.join(folder, '.working', 'onboarding');
  const target = path.join(task, 'worktrees', 'admin');
  fs.mkdirSync(path.dirname(target), { recursive:true });
  git(repo, 'worktree', 'add', '-b', 'feat/onboarding', target);
  const sessionUuid = '01a0e930-e112-74e2-888c-c3f5be9bbfa6';
  const taskFile = path.join(task, 'Task.md');
  const record = (status, sid = sessionUuid) => fs.writeFileSync(taskFile,
    `# 온보딩\n## owner_runtime\ncodex\n## session_id\n${sid}\n## status\n${status}\n`);
  record('in_progress');
  replace({ workspaces:[{ id:'space-1', folder }], state:[{ paneId:'pane-onboarding', workspaceId:'space-1',
    agent:'codex', status:'idle', cwd:folder, sessionUuid, tabLabel:'Onboarding-Dev' }], allowedRoots:[folder] });
  initWorktrees({ herdr:{ paneList:async () => [{ pane_id:'pane-onboarding', workspace_id:'space-1', cwd:folder }] } });
  const list = () => performWorktreeRequest({ type:'worktrees.list', spaceId:'space-1', repo:folder });
  const entry = async () => (await list()).repositories.flatMap(r => r.entries).find(e => e.path === target);
  assert.equal((await entry()).taskUsers[0].paneId, 'pane-onboarding');
  assert.deepEqual((await entry()).users, []);
  record('in_progress', '01a0e930-e112-74e2-888c-c3f5be9bbfa7');
  assert.deepEqual((await entry()).taskUsers, []);
  record('complete'); assert.equal((await entry()).taskUsers[0].paneId, 'pane-onboarding');
  record('in_progress'); replace({ state:[] }); assert.deepEqual((await entry()).taskUsers, []);
});

async function collectionFixture(t) {
  const { dir, repo } = await fixture(t, "admin");
  const folder = fs.realpathSync(dir), client = path.join(folder, "client");
  fs.mkdirSync(client);
  git(client, "init", "-b", "trunk");
  git(client, "config", "user.name", "Test"); git(client, "config", "user.email", "test@example.test");
  fs.writeFileSync(path.join(client, "README.md"), "client\n");
  git(client, "add", "README.md"); git(client, "commit", "-m", "initial");
  replace({ workspaces: [{ id: "space-1", folder }], state: [], allowedRoots: [folder] });
  return { folder, repos: [fs.realpathSync(repo), client], message: { spaceId: "space-1", repo: folder } };
}
const collectionCreate = (message, name = "review") => ({ type: "worktrees.create", ...message, name, branch: `feat/${name}`, base: "" });

test("스페이스의 모든 저장소를 하나의 작업 폴더에 만들고 중복된 linked worktree는 한 번 처리한다", async (t) => {
  const { folder, repos, message } = await collectionFixture(t);
  git(repos[0], "worktree", "add", "-b", "prior", "--", path.join(folder, "admin-prior"), "main");
  const made = await performWorktreeRequest(collectionCreate(message));
  const task = path.join(folder, ".working", "review");
  assert.equal(made.path, task); assert.equal(made.spaceCwd, task); assert.equal(made.repo, folder);
  assert.deepEqual(made.entries, []); assert.equal(made.repositories.length, 2);
  for (const repo of repos) {
    const target = path.join(task, "worktrees", path.basename(repo));
    assert.equal(git(target, "branch", "--show-current"), "feat/review");
    assert.equal(fs.readFileSync(path.join(target, "README.md"), "utf8"), path.basename(repo) === "client" ? "client\n" : "start\n");
    assert.equal(made.repositories.find((r) => r.primary === repo).entries.find((e) => e.path === target).managed, true);
  }
  await performWorktreeRequest({ type: "worktrees.remove", ...message, repo: repos[0], path: path.join(task, "worktrees", "admin") });
  assert.equal(fs.existsSync(path.join(task, "worktrees", "client")), true);
});

test("collection 사전검증 충돌은 어느 저장소에도 브랜치나 폴더를 만들지 않는다", async (t) => {
  const { folder, repos, message } = await collectionFixture(t);
  git(repos[1], "branch", "feat/review");
  await assert.rejects(performWorktreeRequest(collectionCreate(message)), { code: "BRANCH" });
  assert.equal(git(repos[0], "branch", "--list", "feat/review"), "");
  assert.equal(fs.existsSync(path.join(folder, ".working")), false);
  await assert.rejects(performWorktreeRequest({ ...collectionCreate(message, "bad-base"), base: "main" }), { code: "BASE" });
  assert.equal(git(repos[0], "branch", "--list", "feat/bad-base"), "");
});

test("collection 생성은 외부 요청과 심볼릭 링크 작업 폴더를 거절한다", async (t) => {
  const { folder, repos, message } = await collectionFixture(t);
  await assert.rejects(performWorktreeRequest({ ...collectionCreate(message), repo: os.tmpdir() }), { code: "REPO" });
  await assert.rejects(performWorktreeRequest(collectionCreate(message), false), { code: "LOCAL_ONLY" });
  fs.symlinkSync(os.tmpdir(), path.join(folder, ".working"));
  await assert.rejects(performWorktreeRequest(collectionCreate(message)), { code: "PATH" });
  assert.equal(git(repos[0], "branch", "--list", "feat/review"), "");
  fs.unlinkSync(path.join(folder, ".working"));
  fs.mkdirSync(path.join(folder, ".working"));
  fs.symlinkSync(os.tmpdir(), path.join(folder, ".working", "review"));
  await assert.rejects(performWorktreeRequest(collectionCreate(message)), { code: "EXISTS" });
});

test("collection 요청과 같은 하위 저장소의 쓰기는 동시에 실행하지 않는다", async (t) => {
  const { repos, message } = await collectionFixture(t);
  const outcomes = await Promise.allSettled([
    performWorktreeRequest(collectionCreate(message)),
    performWorktreeRequest({ type: "worktrees.create", ...message, repo: repos[0], name: "single", branch: "feat/single", base: "main" }),
  ]);
  assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(outcomes.find((result) => result.status === "rejected")?.reason.code, "BUSY");
});

test("collection 런타임 실패 영수증은 이미 생성된 경로를 보존하고 모두 보고한다", async (t) => {
  const { folder, repos, message } = await collectionFixture(t);
  const hook = path.join(repos[1], ".git", "hooks", "post-checkout");
  fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const result = await new Promise((resolve) => handleWorktrees({ _local: true, send: (body) => resolve(JSON.parse(body)) },
    { ...collectionCreate(message), requestId: "partial" }));
  const expected = repos.map((repo) => path.join(folder, ".working", "review", "worktrees", path.basename(repo)));
  assert.equal(result.ok, false); assert.equal(result.code, "GIT");
  assert.deepEqual(result.createdPaths, expected); assert.equal(result.failedRepo, repos[1]);
  for (const target of expected) assert.equal(fs.existsSync(path.join(target, "README.md")), true);
  assert.equal(git(repos[0], "branch", "--list", "feat/review", "--format=%(refname:short)"), "feat/review");
});

test("collection에서 작업 폴더로 실행한 에이전트를 모든 저장소의 만든 세션에 연결한다", async (t) => {
  const { repos, message } = await collectionFixture(t);
  const made = await performWorktreeRequest(collectionCreate(message));
  const pane = { pane_id: "space-1:p1", terminal_id: "term-collection", workspace_id: "space-1", cwd: made.spaceCwd, agent: "codex" };
  initWorktrees({ herdr: fakeHerdr([pane], { [pane.pane_id]: 999999 }), processes: { list: async () => [], cwds: async () => new Map() } });
  await assert.rejects(performWorktreeRequest({ type: "worktrees.launched", ...message, path: path.dirname(made.path), paneId: pane.pane_id }), { code: "PATH" });
  await performWorktreeRequest({ type: "worktrees.launched", ...message, path: made.path, paneId: pane.pane_id });
  const listed = await performWorktreeRequest({ type: "worktrees.list", ...message });
  for (const repo of repos) {
    const entry = listed.repositories.find((r) => r.primary === repo).entries.find((e) => e.branch === "feat/review");
    assert.equal(entry.creator.session.paneId, pane.pane_id); assert.equal(entry.creator.session.alive, true);
  }
});

test("보관 후 재개한 만든 세션은 같은 대화 UUID의 현재 pane에 연결한다", async (t) => {
  const { repo, message } = await fixture(t);
  const sessionId = "01a0e930-e112-74e2-888c-c3f5be9bbfa6";
  const made = await createWorktreeFromCommand({ repo, name: "resumed", branch: "feat/resumed", base: "main",
    session: { paneId: "old-pane", terminalId: "old-terminal", workspaceId: "space-1", agent: "codex", sessionId } });
  const pane = { pane_id: "new-pane", terminal_id: "new-terminal", workspace_id: "space-1", agent: "codex", cwd: made.path, agent_session: { value: sessionId } };
  replace({ state: [{ paneId: pane.pane_id, workspaceId: "space-1", agent: "codex", sessionUuid: sessionId, status: "idle", tabLabel: "재개" }] });
  initWorktrees({ herdr: fakeHerdr([pane], { [pane.pane_id]: 999999 }), processes: { list: async () => [], cwds: async () => new Map() } });
  const resumed = (await listOf(message, made.path)).creator.session;
  assert.equal(resumed.alive, true); assert.equal(resumed.paneId, "new-pane"); assert.equal(resumed.label, "재개");
  initWorktrees({ herdr: fakeHerdr([{ ...pane, agent_session: { value: "01a0e930-e112-74e2-888c-c3f5be9bbfa7" } }]) });
  assert.equal((await listOf(message, made.path)).creator.session.alive, false, "이전 snapshot UUID만 같고 현재 대화가 다르면 연결하지 않는다");
  replace({ state: [{ paneId: pane.pane_id, workspaceId: "space-1", agent: "claude", sessionUuid: sessionId }] });
  initWorktrees({ herdr: fakeHerdr([{ ...pane, agent: "claude" }]) });
  assert.equal((await listOf(message, made.path)).creator.session.alive, false, "다른 runtime에는 연결하지 않는다");
  replace({ state: [{ paneId: "old-pane", workspaceId: "space-1", agent: "codex", sessionUuid: "01a0e930-e112-74e2-888c-c3f5be9bbfa7" }] });
  initWorktrees({ herdr: fakeHerdr([{ ...pane, pane_id: "old-pane", terminal_id: "old-terminal", agent_session: undefined }]) });
  assert.equal((await listOf(message, made.path)).creator.session.alive, false, "기존 pane도 snapshot 대화 UUID가 다르면 연결하지 않는다");
});
