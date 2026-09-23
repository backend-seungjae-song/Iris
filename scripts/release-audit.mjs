#!/usr/bin/env node
// 공개 배포 전 전수 검사. 한 번에 다 돌고 한 줄로 판정한다.
//
// 한곳에 모으는 이유: 손으로 훑는 배포 검사는 훑는 사람의 기억이 곧 범위가 되어 회차마다
// 보는 항목이 달라진다. 회사 도메인이 픽스처로 들어온 것, 단어 목록이 갈라진 것, 문서가
// 없는 파일을 담당자로 적은 것이 그렇게 빠져나갈 수 있다.
//
// 여기서 도는 것은 전부 다른 데서도 도는 것이다. 이 파일이 하는 일은 빠뜨리지 않는 것뿐이다.
//
// 실행 방법: node scripts/release-audit.mjs [--full]
//   기본     저장소 안에서 끝나는 검사(빠르다)
//   --full   공개본을 실제로 새 폴더에 내고 그 안에서 install → test 까지 돌린다(느리다)
//
// TODO(검사 후보. 도구나 시간 비용이 커서 아직 넣지 않았고, 필요해질 때 하나씩 추가한다):
//   - 이미지·vendor 파일의 EXIF·메타데이터에 이름·기기·위치가 없는지
//   - THIRD-PARTY 고지와 실제 번들 바이트(web/vendor·docx 번들)의 대응
//   - 캐시 없는 빈 환경(네트워크 분리)에서 `pnpm install --frozen-lockfile` 이 성립하는지
//   - setup.sh 가 부르는 외부 설치 스크립트의 해시 고정
//   - 공개본에서 앱을 실제로 빌드·기동해 첫 화면까지 뜨는지
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TRACES_LOADED } from "./private-traces.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FULL = process.argv.includes("--full");

let fail = 0;
const ok = (n, d) => console.log(`  ok   ${n}${d ? ` — ${d}` : ""}`);
const bad = (n, d) => { fail++; console.log(`  FAIL ${n}${d ? ` — ${d}` : ""}`); };

function run(cmd, args, opts = {}) {
  try {
    return { ok: true, out: execFileSync(cmd, args, { cwd: opts.cwd || ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    return { ok: false, out: String(e.stdout || "") + String(e.stderr || "") };
  }
}

const tail = (out, n = 2) => out.trim().split("\n").filter(Boolean).slice(-n).join(" / ").slice(0, 160);

console.log("[1] 저장소 상태");
// 다른 작업이 섞인 채로 낸 공개본은 미완성 코드를 그대로 싣는다. 커밋되지 않은 변경이 있으면 알린다.
const dirty = run("git", ["status", "--porcelain"]).out.split("\n").filter(Boolean);
const tracked = dirty.filter((l) => !l.startsWith("??"));
const untracked = dirty.filter((l) => l.startsWith("??"));
if (!tracked.length) ok("커밋 안 된 변경이 없다");
else bad("커밋 안 된 변경이 없다", `${tracked.length}개 — 공개본은 작업 트리를 그대로 옮긴다`);
// 미추적 파일은 공개본에 포함되지 않는다. 작성자 쪽에는 증상이 없고 받는 사람에게만 없다.
if (!untracked.length) ok("git 이 모르는 파일이 없다");
else bad("git 이 모르는 파일이 없다", untracked.map((l) => l.slice(3)).join(", "));
// 심링크는 복사되는 순간 링크가 가리키던 파일의 내용이 된다. 작성자 기기의 다른 파일이 공개본에 포함된다.
const symlinks = run("git", ["ls-files", "-s"]).out.split("\n").filter((l) => l.startsWith("120000")).map((l) => l.split("\t")[1]);
if (!symlinks.length) ok("추적 파일에 심링크가 없다");
else bad("추적 파일에 심링크가 없다", symlinks.join(", "));
// 받는 사람이 처음 여는 것은 package.json 이다. 라이선스 필드가 LICENSE 와 다르거나 출처가 없으면
// 안내가 일치하지 않는다. repository 는 공개 주소가 정해져야 채울 수 있다.
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const licenseHead = readFileSync(path.join(ROOT, "LICENSE"), "utf8").slice(0, 200);
if (pkg.license === "Apache-2.0" && /Apache License\s+Version 2\.0/.test(licenseHead)) ok("package.json 의 license 가 LICENSE 와 같다");
else bad("package.json 의 license 가 LICENSE 와 같다", `license=${pkg.license}`);
const repoUrl = typeof pkg.repository === "string" ? pkg.repository : pkg.repository && pkg.repository.url;
if (typeof repoUrl === "string" && /^(?:https?:\/\/|git@|git\+)\S+|^(?:(?:github|gitlab|bitbucket):)?[\w.-]+\/[\w.-]+$/.test(repoUrl)) ok("package.json 에 repository 가 있다");
else bad("package.json 에 repository 가 있다", "공개 저장소 주소가 정해지면 채운다");

console.log("\n[2] 기능 그래프 — 낡은 코드와 낡은 문서");
const graph = run(process.execPath, ["bin/graph.mjs", "--check"]);
for (const line of graph.out.split("\n")) {
  if (/^\s{2}(ok|FAIL|note)\s/.test(line)) {
    if (line.includes("FAIL")) fail++;
    console.log(line);
  }
}
// 문서의 상대 링크가 없는 파일을 가리키면 받은 사람이 빈 곳을 누른다. graph 의 문서 검사는
// 코드 경로만 보므로 링크는 여기서 본다.
const deadLinks = [];
for (const md of run("git", ["ls-files", "*.md"]).out.split("\n").filter(Boolean)) {
  const text = readFileSync(path.join(ROOT, md), "utf8");
  // 인라인 `[x](대상 "제목")`, 꺾쇠 `[x](<대상>)`, 참조형 `[x]: 대상` 을 다 본다.
  const targets = [
    ...[...text.matchAll(/\]\((?:<([^>]+)>|([^)\s]+))(?:\s+"[^"]*")?\)/g)].map((m) => m[1] || m[2]),
    ...[...text.matchAll(/^\s{0,3}\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/gm)].map((m) => m[1] || m[2]),
  ];
  for (const raw of targets) {
    const target = raw.split("#")[0];
    if (!target || /^(?:https?:|mailto:|file:)/.test(target)) continue;
    if (!existsSync(path.resolve(ROOT, path.dirname(md), target))) deadLinks.push(`${md} → ${raw}`);
  }
}
if (!deadLinks.length) ok("문서의 상대 링크가 실재한다");
else bad("문서의 상대 링크가 실재한다", deadLinks.slice(0, 4).join(", "));

console.log("\n[3] 개인 정보");
const hyg = run(process.execPath, ["bin/check-public-hygiene.mjs"]);
if (hyg.ok) ok("추적 파일에 개인·회사 흔적이 없다");
else bad("추적 파일에 개인·회사 흔적이 없다", tail(hyg.out, 4));
// 아는 단어 목록은 git 밖이라 없을 수 있다. 없으면 위 통과는 모양 검사만의 통과이므로 그
// 사실을 여기서도 보인다(작성자 트리에서 note 가 뜨면 목록 파일이 사라진 것이다).
for (const line of hyg.out.split("\n")) if (/^\s+note\s/.test(line)) console.log(line);
// 공개 화면에 자리표시자가 남아 있으면 받는 사람이 그대로 입력하게 된다. 주소가 정해져야 채워지는
// 값이므로, 채우기 전에는 낼 수 없게 막는다.
const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
const placeholders = [...readme.matchAll(/<[가-힣A-Za-z_-]+>/g)].map((m) => m[0]);
if (!placeholders.length) ok("README 에 자리표시자가 없다");
else bad("README 에 자리표시자가 없다", [...new Set(placeholders)].join(", "));

console.log("\n[4] 계약 검사와 오프라인 테스트");
const smoke = run(process.execPath, ["bin/smoke.mjs"]);
const verdict = (smoke.out.match(/결과: .*/g) || []).pop() || "결과를 못 읽음";
if (smoke.ok) ok("smoke", verdict);
else bad("smoke", `${verdict} / ${smoke.out.split("\n").filter((l) => l.includes("FAIL")).slice(0, 3).join(" / ").slice(0, 200)}`);
// smoke 안에서 건너뛴 것(기기에만 있는 목록 파일 등)은 통과 뒤에 가려진다. 그 note 를 여기서도 보인다.
for (const line of smoke.out.split("\n")) if (/^\s+note\s/.test(line)) console.log(line);
const tests = run(process.execPath, ["scripts/run-tests.mjs"]);
if (tests.ok) ok("오프라인 테스트");
else bad("오프라인 테스트", tail(tests.out, 3));

console.log("\n[5] 라이선스 고지");
// LICENSE·NOTICE·THIRD-PARTY 는 배포 의무다. 없으면 배포 자체가 성립하지 않는다.
for (const f of ["LICENSE", "NOTICE", "THIRD-PARTY.md", "README.md", "SECURITY.md", "CONTRIBUTING.md", "web/fonts/OFL.txt", "web/vendor/docx-editor-core.NOTICE.md", "web/vendor/orca-emulator-pane.NOTICE.md"]) {
  if (existsSync(path.join(ROOT, f))) ok(`${f} 가 있다`);
  else bad(`${f} 가 있다`);
}
// docx 고지의 버전 대조는 DOCX 블록 카드라 기본 smoke 에서 돌지 않는다. 고지는 배포 의무이므로
// 그 카드 하나만 여기서 따로 돌린다.
const docxNotice = run(process.execPath, ["bin/smoke.mjs", "--docx-only", "--docx-card=B5-T5"]);
if (docxNotice.ok) ok("docx 고지가 실제 번들의 패키지·버전과 맞는다");
else bad("docx 고지가 실제 번들의 패키지·버전과 맞는다", docxNotice.out.split("\n").filter((l) => l.includes("FAIL")).join(" / ").slice(0, 200));

if (!FULL) {
  console.log(`\n${fail ? `결과: ${fail} fail` : "결과: 전부 통과"}  (공개본 독립 기동까지 보려면 --full)`);
  process.exit(fail ? 1 : 0);
}

console.log("\n[6] 공개본이 스스로 서는가");
// 여기서만 알 수 있는 것이 있다. 개인 트리에는 있는데 공개본에는 없는 파일, 개인 트리의
// node_modules 덕분에 통과하던 검사. 그래서 새 폴더에서 install 부터 다시 한다.
const dest = mkdtempSync(path.join(tmpdir(), "iris-public-"));
rmSync(dest, { recursive: true, force: true });
// 아는 단어 목록이 없으면 내보내기는 모양 검사만으로 내겠다는 표시(--shape-only)를 요구한다.
// 공개본에는 목록이 없으므로 그 안에서 --full 을 돌리려면 여기서 그 표시를 대신 주고 note 로 밝힌다.
const exportArgs = ["scripts/export-public.mjs", dest];
if (!TRACES_LOADED) { exportArgs.push("--shape-only"); console.log("  note 아는 낱말 목록이 없어 모양 검사만으로 낸다(--shape-only)"); }
const exported = run(process.execPath, exportArgs);
if (!exported.ok && /작업 트리가 깨끗하지 않아/.test(exported.out)) {
  // [1] 이 같은 사실을 이미 실패로 보고했다. 여기서 또 세면 한 원인이 두 번 집계된다.
  console.log("  note 작업 트리가 깨끗하지 않아 공개본 시험을 건너뜁니다 — [1] 을 먼저 해소하세요");
} else if (!exported.ok) {
  bad("공개본을 낸다", tail(exported.out, 3));
} else {
  ok("공개본을 낸다", (exported.out.match(/파일 \d+개/) || [""])[0]);
  // 공개본 안의 git 에는 사용자 설정이 없다. 검사가 "커밋되지 않은 변경" 으로 실패하지 않게
  // 이름 없는 신원으로 한 번 커밋해, 받는 사람이 clone 한 상태와 같게 만든다.
  const gitIdentity = { GIT_AUTHOR_NAME: "iris", GIT_AUTHOR_EMAIL: "iris@localhost", GIT_COMMITTER_NAME: "iris", GIT_COMMITTER_EMAIL: "iris@localhost" };
  const step = (label, cmd) => {
    try {
      execSync(cmd, { cwd: dest, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...gitIdentity } });
      ok(label);
    } catch (e) {
      bad(label, tail(String(e.stdout || "") + String(e.stderr || ""), 3));
    }
  };
  step("git init", "git init -q && git add -A && git commit -q -m init");
  // 잠금 파일을 고쳐 쓰는 설치는 실패로 본다. 다른 pnpm 버전이 형식을 바꾸면 여기서 드러나야 한다.
  step("pnpm install", "pnpm install --silent --frozen-lockfile");
  step("pnpm test", "pnpm test");
  step("./setup --check", "./setup --check");
  // 받는 사람도 같은 전수 검사를 돌릴 수 있어야 한다. 검사 도구가 공개본에서 성립하는지는
  // 여기서만 알 수 있다. 아는 단어 목록이 없으므로 그 안의 위생은 모양 검사만 한다.
  step("pnpm release-audit (공개본 안에서)", "pnpm release-audit");
  console.log(`  note 낸 폴더: ${dest}`);
}

console.log(`\n${fail ? `결과: ${fail} fail` : "결과: 전부 통과"}`);
process.exit(fail ? 1 : 0);
