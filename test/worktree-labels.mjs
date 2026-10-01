import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { handleWorktrees, initWorktrees, performWorktreeRequest } from "../server/worktree-handlers.js";
import { replace } from "../server/runtime-state.js";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "iris-worktree-labels-")));
  const previous = process.env.IRIS_STATE_DIR;
  const state = path.join(root, "state");
  process.env.IRIS_STATE_DIR = state;
  initWorktrees({ herdr: { paneList: async () => [] } });
  t.after(() => {
    if (previous === undefined) delete process.env.IRIS_STATE_DIR;
    else process.env.IRIS_STATE_DIR = previous;
    replace({ workspaces: [], state: [], allowedRoots: [] });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const repo = path.join(root, "project");
  fs.mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.test");
  fs.writeFileSync(path.join(repo, "README.md"), "start\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "initial");
  const external = path.join(root, "외부 작업");
  git(repo, "worktree", "add", "-b", "review", "--", external, "main");
  replace({ workspaces: [{ id: "space", folder: repo }], state: [], allowedRoots: [repo] });
  const message = { spaceId: "space", repo };
  return { root, state, repo, external, message };
}
const list = (message) => performWorktreeRequest({ type: "worktrees.list", ...message });
const rename = (message, target, label) => performWorktreeRequest({ type: "worktrees.rename", ...message, path: target, label });
const renameGroup = (message, target, groupPath, label) => performWorktreeRequest({ type: "worktrees.rename", ...message, path: target, groupPath, label });
const entry = (result, target) => result.entries.find((item) => item.path === target);
const labelFile = (state, target) => path.join(state, "worktree-labels", createHash("sha256").update(target).digest("hex") + ".json");

test("기본 저장소와 외부 워크트리의 표시 이름을 저장하고 새 서버에서도 읽는다", async (t) => {
  const { state, repo, external, message } = fixture(t);
  assert.equal(entry(await list(message), repo).label, null);
  assert.equal(entry(await list(message), external).label, null);
  fs.mkdirSync(state);
  const unrelated = path.join(state, "worktree-ownership.json");
  const original = '{"version":1,"entries":[]}\n';
  fs.writeFileSync(unrelated, original);
  const changed = await rename(message, external, "  리뷰 작업  ");
  assert.equal(changed.path, external);
  assert.equal(changed.label, "리뷰 작업");
  assert.equal(entry(changed, external).label, "리뷰 작업");
  assert.equal(entry(changed, external).managed, false);
  await rename(message, repo, "기본 작업");
  assert.equal(fs.readFileSync(unrelated, "utf8"), original);
  const script = `
    import { performWorktreeRequest, initWorktrees } from './server/worktree-handlers.js';
    import { replace } from './server/runtime-state.js';
    const message = JSON.parse(process.argv[1]);
    replace({ workspaces: [{ id: 'space', folder: message.repo }], state: [], allowedRoots: [message.repo] });
    initWorktrees({ herdr: { paneList: async () => [] } });
    console.log(JSON.stringify(await performWorktreeRequest({ type: 'worktrees.list', ...message })));
  `;
  const restarted = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(message)], { encoding: "utf8" }));
  assert.equal(entry(restarted, repo).label, "기본 작업");
  assert.equal(entry(restarted, external).label, "리뷰 작업");
  assert.equal(git(external, "branch", "--show-current"), "review");
});

test("빈 이름은 기본 이름으로 되돌리고 120자까지 저장한다", async (t) => {
  const { state, external, message } = fixture(t);
  const label = "가".repeat(120);
  assert.equal((await rename(message, external, `  ${label}  `)).label, label);
  const cleared = await rename(message, external, " \n\t ");
  assert.equal(cleared.label, null);
  assert.equal(entry(cleared, external).label, null);
  assert.equal(fs.existsSync(labelFile(state, external)), false);
  assert.equal((await rename(message, external, "")).label, null);
});

test("잘못된 입력·저장소 경계·원격 요청은 상태 파일을 만들지 않는다", async (t) => {
  const { root, state, repo, external, message } = fixture(t);
  for (const label of [undefined, null, 12, {}, "x".repeat(121)]) {
    await assert.rejects(rename(message, external, label), { code: "LABEL" });
  }
  for (const target of [undefined, 12, "relative", repo + "/README.md", root, root + "/missing"]) {
    await assert.rejects(rename(message, target, "이름"), { code: "PATH" });
  }
  await assert.rejects(rename({ ...message, repo: external }, external, "이름"), { code: "REPO" });
  await assert.rejects(rename({ ...message, spaceId: "missing" }, external, "이름"), { code: "SPACE" });
  await assert.rejects(performWorktreeRequest({ type: "worktrees.rename", ...message, path: external, label: "이름" }, false), { code: "LOCAL_ONLY" });
  assert.equal(fs.existsSync(state), false);
});

test("같은 경로에 새로 만든 워크트리에는 이전 표시 이름을 적용하지 않는다", async (t) => {
  const { root, external, repo, message } = fixture(t);
  await rename(message, external, "이전 이름");
  const moved = path.join(root, "previous");
  // 이전 폴더를 남겨 두어 파일 시스템이 같은 inode를 재사용하지 못하게 한다.
  git(repo, "worktree", "move", "--", external, moved);
  git(repo, "worktree", "add", "-b", "replacement", "--", external, "main");
  const current = await list(message);
  assert.equal(entry(current, external).label, null);
  assert.equal(entry(current, moved).label, null);
  assert.equal((await rename(message, external, "새 이름")).label, "새 이름");
});

test("서로 다른 상태 폴더의 표시 이름은 독립적으로 저장한다", async (t) => {
  const { root, state, external, message } = fixture(t);
  await rename(message, external, "첫 환경");
  const otherState = path.join(root, "other-state");
  process.env.IRIS_STATE_DIR = otherState;
  assert.equal(entry(await list(message), external).label, null);
  await rename(message, external, "둘째 환경");
  process.env.IRIS_STATE_DIR = state;
  assert.equal(entry(await list(message), external).label, "첫 환경");
  process.env.IRIS_STATE_DIR = otherState;
  assert.equal(entry(await list(message), external).label, "둘째 환경");
});

test("손상되거나 읽을 수 없는 이름 기록은 오류를 반환하고 보존한다", async (t) => {
  const { state, external, message } = fixture(t);
  await rename(message, external, "저장 이름");
  const file = labelFile(state, external);
  for (const invalid of ["{broken", JSON.stringify({ version: 2 }), JSON.stringify({ version: 1, path: external, dev: "1", ino: "1", label: " x " })]) {
    fs.writeFileSync(file, invalid);
    await assert.rejects(list(message), { code: "STATE" });
    await assert.rejects(rename(message, external, "새 이름"), { code: "STATE" });
    await assert.rejects(rename(message, external, ""), { code: "STATE" });
    assert.equal(fs.readFileSync(file, "utf8"), invalid);
  }
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  await assert.rejects(list(message), { code: "STATE" });
  await assert.rejects(rename(message, external, "새 이름"), { code: "STATE" });
  assert.equal(fs.statSync(file).isDirectory(), true);
});

test("원자 교체가 실패하면 기존 이름을 남기고 임시 파일을 정리한다", async (t) => {
  const { state, external, message } = fixture(t);
  await rename(message, external, "저장 이름");
  const file = labelFile(state, external), original = fs.readFileSync(file, "utf8");
  const originalRename = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (target === file) throw Object.assign(new Error("blocked write"), { code: "EACCES" });
    return originalRename(source, target);
  };
  try { await assert.rejects(rename(message, external, "새 이름"), { code: "STATE" }); }
  finally { fs.renameSync = originalRename; }
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)]);
  assert.equal(entry(await list(message), external).label, "저장 이름");
});

test("이름이 다른 중복 요청은 충돌하며 같은 요청은 저장 결과를 다시 반환한다", async (t) => {
  const { external, message } = fixture(t);
  let finish;
  const completed = new Promise((resolve) => { finish = resolve; });
  const sent = [];
  const ws = { _local: true, send(body) { const result = JSON.parse(body); sent.push(result); if (result.ok) finish(result); } };
  const request = { type: "worktrees.rename", requestId: "rename-1", ...message, path: external, label: "리뷰" };
  assert.equal(handleWorktrees(ws, request), true);
  handleWorktrees(ws, { ...request, label: "다른 이름" });
  const result = await completed;
  assert.equal(sent.find((item) => item.code === "REQUEST_CONFLICT")?.ok, false);
  assert.equal(result.label, "리뷰");
  assert.equal(result.op, "worktrees.rename");
  handleWorktrees(ws, request);
  assert.deepEqual(sent.at(-1), result);
  assert.equal(entry(await list(message), external).label, "리뷰");
});

test("저장소와 저장소 모음 목록은 한 번 읽은 터미널 정보를 함께 반환한다", async (t) => {
  const { root, repo, external, message } = fixture(t);
  let calls = 0;
  const panes = [{ pane_id: "pane", workspace_id: "space", tab_id: "tab", cwd: external, label: "터미널" },
    { pane_id: "task-pane", workspace_id: "space", tab_id: "task-tab", cwd: root }];
  initWorktrees({ herdr: { paneList: async () => { calls++; return panes; } } });
  const expected = [{ paneId: "pane", workspaceId: "space", tabId: "tab", cwd: external, label: "터미널" },
    { paneId: "task-pane", workspaceId: "space", tabId: "task-tab", cwd: root }];
  assert.deepEqual((await list(message)).panes, expected);
  assert.equal(calls, 1);
  replace({ workspaces: [{ id: "space", folder: root }] });
  const collection = await list({ ...message, repo: root });
  assert.deepEqual(collection.panes, expected);
  assert.equal(calls, 2);
  assert.ok(collection.repositories.some((item) => item.repo === repo));
  initWorktrees({ herdr: { paneList: async () => { throw new Error("unavailable"); } } });
  assert.equal((await list({ ...message, repo: root })).panes, null);
  initWorktrees({ herdr: { paneList: async () => [{ pane_id: "unknown" }] } });
  assert.equal((await list(message)).panes, null);
});

test("작업 그룹 이름은 구성원 선택·삭제와 무관하며 개별 이름과 따로 초기화한다", async (t) => {
  const { root, repo, external, message } = fixture(t);
  const group = path.join(root, ".working", "task");
  const first = path.join(group, "worktrees", "first"), second = path.join(group, "worktrees", "second");
  fs.mkdirSync(path.dirname(first), { recursive: true });
  git(repo, "worktree", "move", "--", external, first);
  git(repo, "worktree", "add", "-b", "second", "--", second, "main");
  await rename(message, first, "첫 작업");
  await rename(message, second, "둘째 작업");
  const changed = await renameGroup(message, first, group, " 공통 작업 ");
  assert.equal(changed.groupPath, group);
  assert.equal(changed.label, "공통 작업");
  assert.equal(entry(changed, first).label, "첫 작업");
  assert.equal(entry(changed, second).label, "둘째 작업");
  assert.equal(entry(changed, first).groupLabel, "공통 작업");
  assert.equal(entry(changed, second).groupLabel, "공통 작업");
  await renameGroup(message, second, group, "새 공통 작업");
  git(repo, "worktree", "remove", "--", first);
  assert.equal(entry(await list(message), second).groupLabel, "새 공통 작업");
  const cleared = await renameGroup(message, second, group, "");
  assert.equal(entry(cleared, second).groupLabel, null);
  assert.equal(entry(cleared, second).label, "둘째 작업");
});

test("직접 배치한 작업 그룹도 지원하며 관련 없는 상위 폴더는 허용하지 않는다", async (t) => {
  const { root, state, repo, external, message } = fixture(t);
  const group = path.join(root, ".working", "direct-task"), target = path.join(group, "repo");
  fs.mkdirSync(group, { recursive: true });
  git(repo, "worktree", "move", "--", external, target);
  for (const invalid of [null, 12, "relative", root, path.dirname(group), repo, target]) {
    await assert.rejects(renameGroup(message, target, invalid, "그룹"), { code: "PATH" });
  }
  // 일반 외부 워크트리의 부모는 작업 그룹이 아니다.
  await assert.rejects(renameGroup(message, repo, root, "그룹"), { code: "PATH" });
  assert.equal(fs.existsSync(state), false);
  const changed = await renameGroup(message, target, group, "직접 작업");
  assert.equal(entry(changed, target).groupLabel, "직접 작업");
  assert.equal(entry(changed, target).label, null);
});

test("저장소 모음의 그룹 이름은 기본 저장소 이름과 독립적이다", async (t) => {
  const { root, state, repo, external, message } = fixture(t);
  const other = path.join(root, "other-repo");
  git(root, "clone", "--", repo, other);
  replace({ workspaces: [{ id: "space", folder: root }] });
  await rename(message, repo, "개별 저장소");
  await renameGroup(message, repo, root, "저장소 모음");
  const collection = await list({ ...message, repo: root });
  assert.equal(collection.label, "저장소 모음");
  assert.equal(entry(collection.repositories.find((item) => item.repo === repo), repo).label, "개별 저장소");
  assert.equal(entry(collection.repositories.find((item) => item.repo === repo), repo).groupLabel, null);
  await renameGroup({ ...message, repo: other }, other, root, "둘째로 수정");
  assert.equal((await list({ ...message, repo: root })).label, "둘째로 수정");
  await assert.rejects(renameGroup(message, external, root, "외부"), { code: "PATH" });
  await assert.rejects(renameGroup(message, repo, path.dirname(root), "상위"), { code: "PATH" });
  assert.equal(fs.existsSync(labelFile(state, path.dirname(root))), false);
  await renameGroup(message, repo, root, "");
  const cleared = await list({ ...message, repo: root });
  assert.equal(cleared.label, null);
  assert.equal(entry(cleared.repositories.find((item) => item.repo === repo), repo).label, "개별 저장소");
});

test("같은 경로에 다시 만든 그룹 폴더에는 이전 그룹 이름을 적용하지 않는다", async (t) => {
  const { root, repo, external, message } = fixture(t);
  const group = path.join(root, ".working", "task"), target = path.join(group, "repo");
  const outside = path.join(root, "temporary-worktree");
  fs.mkdirSync(group, { recursive: true });
  git(repo, "worktree", "move", "--", external, target);
  await renameGroup(message, target, group, "이전 그룹");
  await rename(message, target, "개별 작업");
  git(repo, "worktree", "move", "--", target, outside);
  fs.renameSync(group, group + "-previous");
  fs.mkdirSync(group);
  git(repo, "worktree", "move", "--", outside, target);
  const current = await list(message);
  assert.equal(entry(current, target).groupLabel, null);
  assert.equal(entry(current, target).label, "개별 작업");
});
