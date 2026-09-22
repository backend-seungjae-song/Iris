#!/usr/bin/env node
// 공개 저장소에 들어온 변경(PR 병합 등)을 작업 저장소로 가져온다. sync-public.mjs 의 반대 방향이다.
//
// diff 를 적용하는 이유: 두 저장소는 내용은 같고 이력이 다르다(공개 이력은 정리본 커밋뿐).
// 그래서 merge 나 cherry-pick 이 아니라 "마지막으로 낸 내용과 지금 공개 내용의 차이" 만 작업
// 트리에 얹는다. 공개 작업 폴더의 HEAD 가 마지막으로 낸 내용이므로, 그 폴더에서
// `HEAD..origin/master` 의 diff 가 곧 밖에서 들어온 변경이다.
//
// 실행: node scripts/pull-public.mjs --from <공개 작업 폴더> [--dry-run]
//   가져온 변경은 커밋하지 않고 작업 트리에만 둔다. 검사(pnpm test)를 돌리고 직접 커밋한다.
//   적용이 끝나면 공개 작업 폴더를 origin/master 로 맞춰 다음 sync-public 이 그 위에 쌓이게 한다.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const die = (msg) => { console.error(msg); process.exit(1); };

const from = opt("--from");
if (!from) die("공개 작업 폴더를 주세요 — node scripts/pull-public.mjs --from <폴더> [--dry-run]");
const src = path.resolve(from);
if (!existsSync(path.join(src, ".git"))) die(`git 저장소가 아닙니다: ${src} (먼저 sync-public.mjs --to 로 만든 폴더여야 합니다)`);
const gitRaw = (args, cwd = src) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const git = (args, cwd = src) => gitRaw(args, cwd).trim();

// 커밋되지 않은 변경이 없어야 들어온 변경과 내 변경이 섞이지 않는다. 공개 폴더도 같다.
// 끝에 그 폴더를 origin 으로 되감으므로 거기 남긴 것은 지워진다.
if (git(["status", "--porcelain"], ROOT)) die("작업 저장소에 커밋 안 된 변경이 있습니다 — 먼저 정리하세요");
if (git(["status", "--porcelain"])) die(`공개 작업 폴더에 커밋 안 된 변경이 있습니다 — 먼저 정리하세요: ${src}`);

const branch = git(["branch", "--show-current"]) || "master";
execFileSync("git", ["fetch", "-q", "origin", branch], { cwd: src, stdio: "inherit" });
// 공개 폴더의 HEAD 가 origin 의 조상이어야 "HEAD..origin" 이 들어온 변경이다. 아직 push 하지 않은
// 정리본이 있으면 그 diff 는 내 변경을 되돌리는 방향이 된다.
if (spawnSync("git", ["merge-base", "--is-ancestor", "HEAD", `origin/${branch}`], { cwd: src }).status !== 0)
  die(`공개 작업 폴더에 push 하지 않은 커밋이 있습니다 — 먼저 그 폴더에서 \`git push origin ${branch}\` 하세요: ${src}`);
const range = `HEAD..origin/${branch}`;
const stat = git(["diff", "--stat", range]);
if (!stat) { console.log("공개 저장소에 새 변경이 없습니다"); process.exit(0); }
console.log(git(["log", "--format=%h %an — %s", range]));
console.log(stat);
if (flag("--dry-run")) process.exit(0);

// --3way: 같은 자리를 이미 고쳤으면 충돌 표시를 남기고 멈춘다. 조용히 덮지 않는다.
// 패치는 다듬지 않는다. 끝의 개행을 잘라내면 git 이 "corrupt patch" 로 거부한다.
const patch = gitRaw(["diff", "--binary", range]);
const applied = spawnSync("git", ["apply", "--3way", "--index"], { cwd: ROOT, input: patch, encoding: "utf8" });
if (applied.status !== 0) {
  // 작업 트리에 아무것도 안 남았으면 충돌이 아니라 패치가 적용되지 않은 것이다. 정리할 것도 없다.
  const touched = git(["status", "--porcelain"], ROOT);
  die([
    touched
      ? "적용하다 멈췄습니다 — 충돌 표시가 남은 파일을 손으로 정리하고 `git add` 한 뒤 커밋하세요."
      : "적용하지 못했습니다 — 작업 트리는 그대로입니다.",
    `공개 작업 폴더는 그대로 두었습니다${touched ? ` — 커밋을 마치면 거기서 \`git reset --hard origin/${branch}\` 로 맞추세요` : ""}: ${src}`,
    applied.stderr,
  ].join("\n"));
}
git(["reset", "-q", "--hard", `origin/${branch}`]);
console.log(`가져왔습니다 — 작업 트리에 스테이징돼 있습니다. pnpm test 뒤 커밋하세요. (${src} 는 origin/${branch} 로 맞췄습니다)`);
