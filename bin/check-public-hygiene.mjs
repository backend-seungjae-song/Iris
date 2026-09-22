#!/usr/bin/env node
// 공개용 위생 검사. 추적 파일에 개인·회사 흔적이 남았는지 확인한다.
//
// 판정은 scripts/private-traces.mjs 하나가 한다(내보내기도 같은 것을 쓴다). 확인할 단어 목록은
// git 밖 파일이라 없을 수 있고, 그때는 모양 검사(메일·홈 경로·허용 밖 호스트·사설 작업 폴더)만
// 실행한다. 그 사실을 note 로 남겨 통과가 무엇을 뜻하는지 드러낸다.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanLine, scanPath, SKIP, TRACES_LOADED, PRIVATE_LIST_PATH } from "../scripts/private-traces.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const files = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
let fail = 0;

const hits = [];
for (const f of files) {
  // 이름을 먼저 본다. SKIP 은 내용을 읽지 않는다는 뜻이고, 이름 검사까지 건너뛰지는 않는다.
  const nameWhy = scanPath(f);
  if (nameWhy.length) hits.push(`${f} [파일 이름 · ${nameWhy.join(", ")}]`);
  if (SKIP.test(f)) continue;
  let text;
  try { text = readFileSync(path.join(ROOT, f), "utf8"); } catch { continue; }
  text.split("\n").forEach((line, i) => {
    const why = scanLine(line);
    if (!why.length) return;
    hits.push(`${f}:${i + 1} [${why.join(", ")}]: ${line.trim().slice(0, 80)}`);
  });
}

if (hits.length) {
  fail++;
  console.log(`  FAIL 추적 파일에 개인·회사 흔적이 없다 — ${hits.length}곳`);
  for (const h of hits.slice(0, 12)) console.log("       " + h);
  if (hits.length > 12) console.log(`       ... 외 ${hits.length - 12}곳`);
} else {
  console.log("  ok   추적 파일에 개인·회사 흔적이 없다");
}
if (!TRACES_LOADED) console.log(`  note 아는 낱말 목록(${PRIVATE_LIST_PATH})이 없어 모양 검사만 했다`);

process.exit(fail ? 1 : 0);
