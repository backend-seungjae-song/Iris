#!/usr/bin/env node
// 공개용 정리본을 새 폴더로 뜬다.
//
// 복사하는 이유: 이 저장소의 이력에는 개인 경로·회사 이름·실제 인증값이 남아 있다.
// 공개는 되돌릴 수 없으므로(포크·캐시·검색 인덱스), 이력을 세탁하는 대신 현재 트리만 옮긴다.
// 옮기는 대상은 git이 추적하는 파일뿐이다. .working·상태 폴더·빌드 산출물은 들어오지 않는다.
//
// 번들 ID 치환은 없다. 작성자 트리와 공개본이 같은 `app.iris.console` 을 쓰므로 바꿔야 할 값이
// 없다. 자격증명은 번들 ID 가 아니라 제품 이름 "Iris" 에 묶인다. Keychain 항목이
// `svce="Iris Safe Storage"` 다.
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, existsSync, readdirSync, copyFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanLine, scanPath, SKIP, TRACES_LOADED, PRIVATE_LIST_PATH } from "./private-traces.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 아는 단어 목록은 git 이 모르는 파일이라 공개본에 포함되지 않는다. 검사·내보내기 도구 자체는
// 나간다. 받은 쪽도 자기 흔적을 걸러 다시 낼 수 있어야 한다. CLAUDE.md 도 넣는다. 이 저장소를
// 고칠 때의 필수 규칙(앱 다운타임·환경 분리·서버 재시작)이 거기에만 있고, 그것을 모르면
// 데이터가 사라질 수 있다. smoke 도 그 존재를 검사한다.
const SHAPE_ONLY = process.argv.includes("--shape-only");

function die(msg) {
  console.error("중단: " + msg);
  process.exit(1);
}

const destArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
const dest = path.resolve(destArg || "");
if (!destArg) die("낼 곳을 주세요 — node scripts/export-public.mjs <대상폴더> [--shape-only]");
// 목록이 없는 채로 내면 아는 단어는 하나도 안 걸러진다. 작성자 트리에서 목록 파일이 사라진
// 것을 모르고 내는 사고를 막으려고, 없으면 명시적으로 모양 검사만 하겠다고 말해야 낸다.
if (!TRACES_LOADED && !SHAPE_ONLY) die(`아는 낱말 목록(${PRIVATE_LIST_PATH})이 없습니다 — 모양 검사만으로 내려면 --shape-only`);
if (dest === ROOT || dest.startsWith(ROOT + path.sep)) die("저장소 안으로는 내지 않습니다 — 밖의 새 폴더를 주세요");
if (existsSync(dest) && readdirSync(dest).length) die(`${dest} 가 비어 있지 않습니다 — 덮어쓰지 않습니다`);

// 공개본은 이력이 아니라 지금 작업 트리를 옮긴다. 그래서 커밋하지 않은 작업이 있으면 미완성
// 코드가 그대로 포함되고, 미추적 파일은 아예 포함되지 않는다. 작성자 쪽에는 증상이 없고 받는
// 사람에게만 없다. 미추적 파일을 require 하는 코드가 그대로 나가면 공개본은 그 자리에서
// 실패하는데, 같은 시점의 HEAD 는 정상이다. 결함은 코드가 아니라 내보낸 시점에 있다.
//
// 그래서 커밋되지 않은 변경이 없을 때만 낸다. 우회 스위치는 두지 않는다. 되돌릴 수 없는
// 동작이라 우회 비용이 싸면 안 된다. 막히면 할 일은 커밋 하나다.
const status = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" })
  .split("\n").filter(Boolean);
if (status.length) {
  const dirty = status.filter((l) => !l.startsWith("??"));
  const untracked = status.filter((l) => l.startsWith("??"));
  console.error("작업 트리가 깨끗하지 않아 공개본을 내지 않습니다 — 공개본은 지금 트리를 그대로 옮깁니다.");
  if (dirty.length) console.error(`  커밋 안 된 변경 ${dirty.length}개: ${dirty.slice(0, 6).map((l) => l.slice(3)).join(", ")}${dirty.length > 6 ? " …" : ""}`);
  if (untracked.length) console.error(`  git 이 모르는 파일 ${untracked.length}개(공개본에 아예 안 실립니다): ${untracked.map((l) => l.slice(3)).join(", ")}`);
  process.exit(1);
}

const files = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
if (!files.length) die("추적 파일이 없습니다");

// 옮기기 전에 먼저 본다. 절반 복사해 놓고 실패하면 무엇이 나갔는지 알기 어렵다.
const leftover = [];
for (const f of files) {
  // 이름을 SKIP 보다 먼저 본다. SKIP 은 "바이트를 훑어도 뜻이 없다"는 뜻이지 "이름도 안
  // 본다"가 아니다. `<회사이름>-icon.png` 는 내용을 안 읽어도 이름만으로 흔적이다.
  const nameWhy = scanPath(f);
  if (nameWhy.length) leftover.push(`${f} [파일 이름 · ${nameWhy.join(", ")}]`);
  if (SKIP.test(f)) continue;
  let text;
  try { text = readFileSync(path.join(ROOT, f), "utf8"); } catch { continue; }
  text.split("\n").forEach((line, i) => {
    const why = scanLine(line);
    if (why.length) leftover.push(`${f}:${i + 1} [${why.join(", ")}]: ${line.trim().slice(0, 80)}`);
  });
}
if (leftover.length) {
  console.error("개인 흔적이 남아 있습니다 — 공개본을 내지 않습니다:");
  for (const l of leftover.slice(0, 20)) console.error("  " + l);
  if (leftover.length > 20) console.error(`  ... 외 ${leftover.length - 20}곳`);
  process.exit(1);
}

let copied = 0;
for (const f of files) {
  const src = path.join(ROOT, f);
  const out = path.join(dest, f);
  mkdirSync(path.dirname(out), { recursive: true });
  copyFileSync(src, out);
  copied++;
}

// 낸 뒤에 다시 본다. 위 검사는 원본을 봤고, 이번엔 실제로 나간 바이트를 본다.
const after = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    const rel = path.relative(dest, p).split(path.sep).join("/");
    if (scanPath(rel).length) { after.push(rel + " (파일 이름)"); continue; }
    if (SKIP.test(rel)) continue;
    if (statSync(p).size > 8 * 1024 * 1024) continue;
    const text = readFileSync(p, "utf8");
    if (text.split("\n").some((line) => scanLine(line).length)) after.push(rel);
  }
})(dest);
if (after.length) die("낸 트리에 흔적이 남았습니다: " + after.join(", "));

console.log(`공개본을 냈습니다 — ${dest}`);
console.log(`  파일 ${copied}개`);
if (!TRACES_LOADED) console.log(`  note 아는 낱말 목록이 없어 모양 검사만 했다 (${PRIVATE_LIST_PATH})`);
console.log("  다음: 그 폴더에서 git init → pnpm install → pnpm test 로 스스로 서는지 확인하세요.");
