#!/usr/bin/env node
// 작업 저장소의 지금 트리를 공개 저장소 작업 폴더에 한 커밋으로 옮긴다.
//
// 따로 있는 이유: 고치는 일은 작업 저장소에서 하고, 공개 저장소에는 그 결과만 간다. 공개
// 이력은 "언제 무엇을 했는가"가 아니라 "무엇이 바뀌었는가"만 담는다. 그래서 커밋은 회차마다
// 하나이고, 시각은 지정한 값 또는 한국 시간 기준 공개 시각 규칙을 따른다.
// 내보내기 자체(추적 파일만, 흔적 검사)는 export-public.mjs 가 하고, 여기서는 그 결과를 공개
// 작업 폴더에 덮고 커밋한다.
//
// 실행: node scripts/sync-public.mjs --to <공개 작업 폴더> [--date <ISO 시각>] [--message <한 줄>]
//                                  [--push] [--force] [--shape-only]
//   --to       공개 저장소의 로컬 폴더. git 저장소가 아니면 여기서 만든다(원격은 package.json 의 repository).
//   --date     작성자·커미터 시각. 생략하면 한국 시간 09~19시에는 당일 00시, 그 밖에는 실제 시각.
//   --push     커밋 뒤 origin 의 현재 브랜치로 push 한다. 원격 이력을 버리고 덮을 때만 --force 를 함께 준다.
//   --shape-only  export-public.mjs 에 그대로 넘긴다(아는 단어 목록이 없을 때).
//
// 작성자 이름·메일은 공개 작업 폴더의 git 설정(user.name/user.email)에서 읽는다. 이 파일에는
// 누구의 이름도 적지 않는다. 없으면 멈추고 어디에 설정할지 알려 준다.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { publicCommitDate } from "./public-commit-date.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const die = (msg) => { console.error(msg); process.exit(1); };

const to = opt("--to");
if (!to) die("공개 작업 폴더를 주세요 — node scripts/sync-public.mjs --to <폴더> [--date <ISO>] [--push]");
const dest = path.resolve(to);
if (dest === ROOT || dest.startsWith(ROOT + path.sep)) die("작업 저장소 안은 공개 작업 폴더가 될 수 없습니다");

const git = (args, cwd = dest, input) => execFileSync("git", args, { cwd, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] }).trim();

const date = opt("--date") || publicCommitDate();
if (Number.isNaN(Date.parse(date))) die(`--date 를 읽을 수 없습니다: ${date}`);

// 1. 정리본을 낸다. 흔적 검사와 커밋되지 않은 변경이 없어야 한다는 조건은 export-public.mjs 가 강제한다.
const staged = mkdtempSync(path.join(tmpdir(), "iris-sync-"));
rmSync(staged, { recursive: true, force: true });
const exp = spawnSync(process.execPath, ["scripts/export-public.mjs", staged, ...(flag("--shape-only") ? ["--shape-only"] : [])], { cwd: ROOT, encoding: "utf8" });
if (exp.status !== 0) die((exp.stdout + exp.stderr).trim() || "정리본을 내지 못했습니다");

// 2. 공개 작업 폴더를 준비한다. 없으면 만들고, 원격은 package.json 의 repository 를 쓴다.
if (!existsSync(path.join(dest, ".git"))) {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const raw = typeof pkg.repository === "string" ? pkg.repository : pkg.repository && pkg.repository.url;
  if (!raw) die("package.json 에 repository 가 없어 원격을 정할 수 없습니다");
  const url = String(raw).replace(/^git\+/, "");
  execFileSync("git", ["init", "-q", "-b", "master", dest], { encoding: "utf8" });
  git(["remote", "add", "origin", url]);
  console.log(`공개 작업 폴더를 만들었습니다: ${dest} (origin ${url})`);
}
const ident = (key) => { try { return git(["config", "--get", key]); } catch { return ""; } };
if (!ident("user.name") || !ident("user.email")) {
  die(`공개 작업 폴더에 작성자 설정이 없습니다 — 이 폴더에서만 쓸 이름·메일을 정하세요:\n  git -C ${dest} config user.name <이름>\n  git -C ${dest} config user.email <메일>`);
}

// 3. 추적 파일을 전부 정리본으로 바꾼다. .git 만 남기고 지운 뒤 통째로 복사한다. 지운 파일이
//    공개본에서도 지워지려면 덮어쓰기가 아니라 교체여야 한다.
for (const name of readdirSync(dest)) {
  if (name === ".git") continue;
  rmSync(path.join(dest, name), { recursive: true, force: true });
}
cpSync(staged, dest, { recursive: true });
rmSync(staged, { recursive: true, force: true });
git(["add", "-A"]);
const changed = git(["diff", "--cached", "--stat"]);
if (!changed) { console.log("공개본과 다른 것이 없습니다 — 커밋하지 않습니다"); process.exit(0); }

// 4. 한 커밋. 시각은 정한 값 하나로 작성자·커미터 둘 다 맞춘다.
const message = opt("--message") || "공개본 갱신";
execFileSync("git", ["commit", "-q", "-m", message], {
  cwd: dest, encoding: "utf8",
  env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
});
console.log(git(["log", "-1", "--format=%h %ad %an <%ae> — %s", "--date=iso"]));
console.log(changed.split("\n").pop());

// 5. push 는 시켰을 때만. --force 는 원격 이력을 버리는 첫 회차에만 쓴다.
if (flag("--push")) {
  const branch = git(["branch", "--show-current"]);
  execFileSync("git", ["push", ...(flag("--force") ? ["--force"] : []), "-u", "origin", branch], { cwd: dest, stdio: "inherit" });
}
