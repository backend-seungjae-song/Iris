import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { gitStatusRich } from "../server/git-handlers.js";

// 커밋이 없는 저장소의 git status 머리 줄은 "## No commits yet on <브랜치>" 이다. 앞말을 떼지 않으면
// 소스 제어 화면의 브랜치 이름이 "No" 가 된다. 실제 git 으로 임시 저장소를 만들어 확인한다.
const g = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });

function repo(t, branch) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "iris-unborn-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  g(d, "init", "-q", "-b", branch);
  return d;
}
function commit(d) {
  fs.writeFileSync(path.join(d, "a.txt"), "a");
  g(d, "add", "a.txt");
  g(d, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", "a");
}

test("커밋이 없는 저장소에서 브랜치 이름을 읽는다", (t) => {
  const d = repo(t, "main");
  assert.match(g(d, "status", "--porcelain=v1", "--branch"), /^## No commits yet on main/);
  assert.equal(gitStatusRich(d).branch, "main");
  assert.equal(gitStatusRich(repo(t, "feat/x-1")).branch, "feat/x-1");
});

test("커밋이 없고 upstream 이 걸린 브랜치도 이름만 읽는다", (t) => {
  const up = repo(t, "main"); commit(up);
  const d = repo(t, "main");
  g(d, "remote", "add", "origin", up); g(d, "fetch", "-q", "origin");
  g(d, "checkout", "-q", "--orphan", "topic");
  g(d, "config", "branch.topic.remote", "origin"); g(d, "config", "branch.topic.merge", "refs/heads/main");
  assert.equal(gitStatusRich(d).branch, "topic");
});

test("커밋이 있는 저장소는 종전대로 읽는다", (t) => {
  const d = repo(t, "main"); commit(d);
  assert.equal(gitStatusRich(d).branch, "main");
});
