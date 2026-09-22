#!/usr/bin/env node
// 이 저장소의 결정론적 검사를 한 번에 돌린다. smoke 와 test/의 오프라인 검사가 대상이다.
//
// 살아 있는 서버·앱·herdr가 있어야만 도는 검사는 뺀다. 그것들은 사람이 앱을 띄운 자리에서
// 확인하는 몫이고(점검표), CI에서는 언제나 실패한다. 무엇을 왜 뺐는지는 아래 목록이 정본이다.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 건너뛰는 검사는 두지 않는다.
//
// 건너뛰는 항목은 스위트가 실제로 검사한 개수를 부풀린다. 단정문이 없는 탐침은 검사가
// 아니므로 scripts/probe/ 로 옮겼고, 자기 서버를 띄우는 자족 검사는 목록에서 뺐다.
// 지금은 이 목록의 모든 항목이 실제로 실행된다.
// 다시 무언가를 건너뛰어야 한다면, 그 이유가 여기 적힐 만한 것인지 먼저 확인한다.
const LIVE_ONLY = {};
const SLOW = new Set(["state-lock-handover.mjs", "port-busy-wait.mjs", "shutdown-flush-live.mjs"]);  // 서버를 띄웠다 내린다
const only = process.argv.includes("--fast") ? (f) => !SLOW.has(f) : () => true;

const run = (label, cmd, args) => {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "pipe", encoding: "utf8" });
  const ms = Date.now() - t0;
  const ok = r.status === 0;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(34)} ${(ms / 1000).toFixed(1)}s`);
  if (!ok) console.log(reason(r.stdout + r.stderr));
  // 통과해도 건너뛴 것(기기에만 있는 목록 파일 등)은 통과 뒤에 가리지 않는다.
  else for (const line of String(r.stdout).split("\n")) if (/^\s+note\s/.test(line)) console.log(line);
  return ok;
};

// 실패했을 때 무엇이 왜 깨졌는지 보이게 한다.
//
// 마지막 몇 줄만 찍으면 node --test 의 TAP 는 끝이 개수 요약이라 "# fail 1"만 나오고
// 이유가 나오지 않는다. 검사를 처음 돌리는 사람이 실패를 받고도 어디를 볼지 모른다.
// 그래서 꼬리가 아니라 실패한 줄을 찾아 그 줄과 딸린 블록을 찍는다.
const reason = (out) => {
  const lines = out.split("\n");
  const hits = [];
  for (let i = 0; i < lines.length && hits.length < 30; i++) {
    // "못 잰 것"도 함께 모은다. 계측기가 답을 못 낸 것은 위반과 다른 사실이지만, 어디를
    // 볼지 모르는 채로 실패를 받지 않게 하는 것이 목적이라 둘 다 필요하다.
    // \b 를 쓰지 않는다. \b 는 \w 와 그 아닌 문자의 경계인데 한글은 \w 가 아니라 "것" 뒤에
    // 경계가 생기지 않는다(\b 를 붙이면 한 줄도 걸리지 않는다). 뒤 공백으로 좁혀
    // 이름이 따라오는 줄만 잡는다.
    if (!/^\s*(?:not ok\b|FAIL\b|못 잰 것 )/.test(lines[i])) continue;
    const indent = lines[i].search(/\S/);
    // smoke 는 이유를 실패 줄 앞에 더 깊이 들여써서 둔다. 그것도 함께 모은다.
    const before = [];
    for (let j = i - 1; j >= 0 && before.length < 6; j--) {
      if (lines[j].trim() === "" || lines[j].search(/\S/) <= indent) break;
      before.unshift(lines[j]);
    }
    hits.push(...before, lines[i]);
    // TAP 는 실패 줄 다음에 들여쓴 YAML 블록으로 기댓값·실제값을 붙인다. 그것까지 포함한다.
    // 빈 줄에서 끊지 않는다. assert 의 기댓값·실제값 diff 는 그 사이에 빈 줄을 둔다.
    // 블록이 끝나는 자리는 "빈 줄"이 아니라 "덜 들여쓴 내용이 있는 줄"이다.
    let held = [];
    for (let j = i + 1; j < lines.length && hits.length < 30; j++) {
      if (lines[j].trim() === "") { held.push(lines[j]); continue; }
      if (lines[j].search(/\S/) <= indent) break;
      hits.push(...held, lines[j]);
      held = [];
      i = j;
    }
  }
  // 실패 줄을 못 찾는 형태(크래시·문법 오류 등)면 꼬리가 유일한 단서다.
  const body = hits.length ? hits : lines.slice(-12);
  return body.map((l) => "       " + l).join("\n");
};

let failed = 0;
console.log("smoke");
if (!run("bin/smoke.mjs", process.execPath, ["bin/smoke.mjs"])) failed++;

// 기능 그래프 게이트. smoke 가 "이 파일이 이렇게 생겼는가"를 본다면 이쪽은 "누가 누구를
// 부르는가"를 본다. 아무도 안 부르는 파일, 아무도 안 쓰는 export, 받아 오는데 안 나오는
// 이름, 문서가 가리키는 없는 경로를 본다. 손으로 부를 때만 돌면 쉽게 빠뜨린다.
console.log("\n기능 그래프");
if (!run("bin/graph.mjs --check", process.execPath, ["bin/graph.mjs", "--check"])) failed++;

// 공개용 위생. 아는 단어 목록(git 밖)이 없으면 모양 검사만 돌고 그 사실을 note 로 찍는다.
console.log("\n공개용 위생");
if (!run("bin/check-public-hygiene.mjs", process.execPath, ["bin/check-public-hygiene.mjs"])) failed++;

console.log("\n오프라인 테스트");
for (const f of readdirSync(path.join(ROOT, "test")).filter((f) => f.endsWith(".mjs")).sort()) {
  if (LIVE_ONLY[f]) { console.log(`  건너뜀 ${f.padEnd(34)} ${LIVE_ONLY[f]}`); continue; }
  if (!only(f)) { console.log(`  건너뜀 ${f.padEnd(34)} --fast`); continue; }
  if (!run(f, process.execPath, ["--test", path.join("test", f)])) failed++;
}

console.log(failed ? `\n실패 ${failed}건` : "\n전부 통과");
process.exit(failed ? 1 : 0);
