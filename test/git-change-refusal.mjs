// stage·되돌리기를 git 이 거절하면(index.lock 이 남은 경우 등) 그 문구를 화면에 보낸다.
// 보내지 않으면 목록이 그대로라 사용자는 버튼이 동작하지 않는 것으로 본다.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { handleGit } from "../server/git-handlers.js";
import { initRuntimeState, replace } from "../server/runtime-state.js";

initRuntimeState({ scheduleRecompute: () => {} });

const g = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });

function repo(t) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "iris-git-refuse-")));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  g(d, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(d, "a.txt"), "1\n");
  g(d, "add", ".");
  g(d, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", "a");
  fs.writeFileSync(path.join(d, "a.txt"), "2\n");
  replace({ allowedRoots: [d] });
  return d;
}

const send = (msg) => { const got = []; handleGit({ _local: true, send: (v) => got.push(JSON.parse(v)) }, msg); return got; };

for (const [op, extra] of [["stage", { paths: ["a.txt"] }], ["stageAll", {}]]) {
  test(`${op} 거절 문구를 git-error 로 보낸다`, (t) => {
    const d = repo(t);
    fs.writeFileSync(path.join(d, ".git", "index.lock"), "");
    const got = send({ type: `git.${op}`, path: d, ...extra });
    const err = got.find((m) => m.type === "git-error");
    assert.ok(err, JSON.stringify(got.map((m) => m.type)));
    assert.equal(err.op, op);
    assert.match(err.error, /index\.lock/);
    assert.ok(got.some((m) => m.type === "git-status"), "상태 회신은 그대로");
  });
}

test("성공하면 git-error 를 보내지 않는다", (t) => {
  const d = repo(t);
  const got = send({ type: "git.stage", path: d, paths: ["a.txt"] });
  assert.equal(got.some((m) => m.type === "git-error"), false);
  assert.deepEqual(got.find((m) => m.type === "git-status").staged.map((f) => f.rel), ["a.txt"]);
});
