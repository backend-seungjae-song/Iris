// 스테이지한 이름 바꿈은 옛 경로를 함께 넘겨야 diff 가 이름 바뀜으로 짝짓는다. 새 경로만이면 통째 추가로 보인다.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { gitStatusRich, handleGit } from "../server/git-handlers.js";
import { initRuntimeState, replace } from "../server/runtime-state.js";

initRuntimeState({ scheduleRecompute: () => {} });
const g = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });

function repo(t) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "iris-rename-")));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  g(d, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(d, "old.txt"), Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") + "\n");
  g(d, "add", ".");
  g(d, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", "a");
  g(d, "mv", "old.txt", "new.txt");
  replace({ allowedRoots: [d] });
  return d;
}

test("상태의 스테이지 이름 바꿈에 옛 경로가 있다", (t) => {
  const d = repo(t);
  assert.deepEqual(gitStatusRich(d).staged.map((f) => [f.code, f.rel, f.oldRel]), [["R", "new.txt", "old.txt"]]);
});

test("옛 경로를 받은 스테이지 diff 는 이름 바뀜으로 나온다", (t) => {
  const d = repo(t);
  const got = [];
  handleGit({ _local: true, send: (v) => got.push(JSON.parse(v)) }, { type: "git.diff", path: d, file: path.join(d, "new.txt"), staged: true, oldRel: "old.txt" });
  assert.match(got[0].patch, /rename from old\.txt/);
  assert.doesNotMatch(got[0].patch, /^\+line 0$/m);
});
