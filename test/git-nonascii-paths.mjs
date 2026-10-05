import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { handleFs } from "../server/fs-handlers.js";
import { gitStatusRich } from "../server/git-handlers.js";
import { replace } from "../server/runtime-state.js";

// git 은 기본 설정에서 한글 같은 비ASCII 경로를 "\353\254\270..." 처럼 따옴표와 8진수로 감싸 출력한다.
// 그 문자열을 경로로 쓰면 소스 제어 목록에 깨진 이름이 나오고 stage·되돌리기·diff 가 그 파일을 찾지 못한다.
const g = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });

function repo(t) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "iris-nonascii-")));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  g(d, "init", "-q", "-b", "main");
  for (const [name, body] of [["문서.txt", "원본\n"], ["옛 이름.txt", "x\n"]]) fs.writeFileSync(path.join(d, name), body);
  g(d, "add", ".");
  g(d, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", "a");
  fs.appendFileSync(path.join(d, "문서.txt"), "수정\n");
  fs.writeFileSync(path.join(d, "새 메모.txt"), "새\n");
  g(d, "mv", "옛 이름.txt", "새 이름.txt");
  return d;
}

test("소스 제어 목록은 한글 경로를 그대로 돌려준다", (t) => {
  const d = repo(t);
  assert.match(g(d, "status", "--porcelain"), /"\\3/); // 이 기기의 git 이 실제로 경로를 감싸는지 먼저 확인
  const r = gitStatusRich(d);
  assert.deepEqual(r.staged.map((f) => [f.code, f.rel]), [["R", "새 이름.txt"]]);
  assert.deepEqual(r.changes.map((f) => [f.code, f.rel]).sort(), [["M", "문서.txt"], ["U", "새 메모.txt"]]);
  for (const f of [...r.staged, ...r.changes]) assert.ok(fs.existsSync(f.abs), f.abs);
});

test("탐색기 변경 표시도 한글 경로에 붙는다", (t) => {
  const d = repo(t);
  replace({ allowedRoots: [d] });
  let reply = null;
  handleFs({ send: (s) => { reply = JSON.parse(s); } }, { type: "fs.list", path: d });
  assert.deepEqual(reply.git, {
    [path.join(d, "문서.txt")]: "M",
    [path.join(d, "새 메모.txt")]: "U",
    [path.join(d, "새 이름.txt")]: "M",
  });
});
