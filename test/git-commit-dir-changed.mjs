// 커밋·stage 는 작업 파일을 바꾸지 않는다. 저장소 루트를 보는 창에 다시 목록을 받으라고 알리지 않으면
// 탐색기의 M·U 표시가 그 폴더의 다른 변경 전까지 남는다.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "iris-git-watch-")));
process.env.IRIS_STATE_DIR = path.join(root, "state");
const { handleFsWatch } = await import("../server/fs-handlers.js");
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const git = (repo, ...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });

test("저장소 루트를 보는 창은 커밋 뒤 dir-changed 를 받는다", async () => {
  const repo = path.join(root, "repo"); fs.mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "t@example.com"); git(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "a.txt"), "1\n"); git(repo, "add", "a.txt"); git(repo, "commit", "-qm", "a");
  fs.writeFileSync(path.join(repo, "a.txt"), "2\n");
  const got = [];
  const ws = { _local: true, readyState: 1, send(v) { got.push(JSON.parse(v)); } };
  handleFsWatch(ws, { dirs: [repo] });
  try {
    await new Promise((r) => setTimeout(r, 300)); got.length = 0;
    git(repo, "commit", "-qam", "b");
    const deadline = Date.now() + 3000;
    while (!got.some((m) => m.type === "dir-changed" && m.dir === repo) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const msg = got.find((m) => m.type === "dir-changed" && m.dir === repo);
    assert.ok(msg, "커밋 뒤 루트 목록 갱신 알림이 없다");
    // 열린 파일을 모두 다시 읽지 않도록 이름을 비우지 않는다.
    assert.deepEqual(msg.names, [".git"]);
  } finally {
    handleFsWatch(ws, { dirs: [] });
  }
});
