import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultBase, gitBranchRefs } from "../server/git-handlers.js";

// 소스 제어 "Base 대비" 기본값. 팀 develop 에서 딴 기능 브랜치를 main 과 비교하면 팀원 커밋까지 섞여
// 내 변경이 묻힘. 실제 git 임시 저장소로 확인
const g = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
let n = 0;
function commit(d, who) {
  fs.writeFileSync(path.join(d, `f${++n}.txt`), String(n));
  g(d, "add", "-A");
  g(d, "-c", `user.name=${who}`, "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", `c${n}`);
}
function repo(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "iris-base-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  g(d, "init", "-q", "-b", "main");
  commit(d, "team");
  return d;
}
const base = (d) => defaultBase(d, gitBranchRefs(d));

test("develop 에서 딴 기능 브랜치는 develop 과 비교(팀원이 develop 에 올린 커밋 제외)", (t) => {
  const d = repo(t);
  g(d, "checkout", "-q", "-b", "develop"); commit(d, "teammate"); commit(d, "teammate");
  g(d, "checkout", "-q", "-b", "feat/daily-quest"); commit(d, "me");
  assert.equal(base(d), "develop");
  assert.equal(g(d, "rev-list", "--count", `${base(d)}..HEAD`).trim(), "1");
});

test("main 에서 딴 브랜치는 main, develop 자신은 main, 같은 지점이면 앞 후보", (t) => {
  const d = repo(t);
  g(d, "branch", "develop");
  g(d, "checkout", "-q", "-b", "feat/x"); commit(d, "me");
  assert.equal(base(d), "main"); // develop 과 main 이 같은 지점 → 앞 후보 main
  g(d, "checkout", "-q", "develop"); commit(d, "teammate");
  assert.equal(base(d), "main");
  g(d, "checkout", "-q", "main"); commit(d, "teammate");
  g(d, "checkout", "-q", "-b", "fix/y"); commit(d, "me");
  assert.equal(base(d), "main");
});

test("다른 후보가 없는 main 위에서는 자기 원격(origin/main)과 비교", (t) => {
  const up = repo(t);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "iris-base-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  g(d, "clone", "-q", up, ".");
  commit(d, "me");
  assert.equal(base(d), "origin/main");
});

// 사람이 고른 Base 는 레포·브랜치마다 저장(다른 브랜치는 자동 기본값)
test("소스 제어가 고른 Base 를 레포·브랜치 열쇠로 저장하고 요청한다", () => {
  const sc = fs.readFileSync(new URL("../web/js/devtool/source-control.js", import.meta.url), "utf8");
  assert.match(sc, /const scBaseKey = \(root\) => root \+ "\\n" \+ \(scRepos\.get\(root\)\?\.branch \|\| ""\);/);
  assert.match(sc, /base: scBase\.get\(scBaseKey\(root\)\) \|\| ""/);
  assert.match(sc, /scBase\.set\(scBaseKey\(root\), v\)/);
});

// 소스 제어 레포 머리: 상위 폴더 이름 대신 그 브랜치가 갈라져 나온 Base 를 보임(사용자 결정)
test("상태 응답에 Base 가 실리고, 레포 머리는 상위 폴더 대신 Base 를 보인다", async (t) => {
  const { gitStatusRich } = await import("../server/git-handlers.js");
  const d = repo(t);
  g(d, "checkout", "-q", "-b", "develop"); commit(d, "teammate");
  g(d, "checkout", "-q", "-b", "feat/z"); commit(d, "me");
  assert.equal(gitStatusRich(d).base, "develop");
  const sc = fs.readFileSync(new URL("../web/js/devtool/source-control.js", import.meta.url), "utf8");
  assert.doesNotMatch(sc, /sc-repo-where|labels/);
  assert.match(sc, /<span class="sc-repo-base"/);
  assert.match(sc, /const scBaseOf = \(root\) => scBase\.get\(scBaseKey\(root\)\) \|\| scRepos\.get\(root\)\?\.base \|\| "";/);
});
