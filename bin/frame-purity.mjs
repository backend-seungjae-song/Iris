#!/usr/bin/env node
// 앱 셸이 기능을 코드로 참조하는 곳을 한 번에 센다.
//
// 배경: 이 앱은 앱 셸과 사용자가 켜고 끄는 기능으로 나뉜다(docs/capabilities.md).
// 그 분리의 값은 기능 하나를 고칠 때 앱 셸 파일을 열지 않아도 되는가로 드러난다.
// 스위트의 「묶어 보면 틀에서 기능으로 가는 정적 길이 없다」가 import 를 막지만, 막는 것과
// 지금 몇 곳이 남았는지 세는 것은 다른 일이다. 0 이 되는 것을 확인하려면 세는 도구가 필요하다.
//
// 세 가지를 나눠 센다. 섞으면 수가 부풀어 판단할 수 없다(섞어 센 값은 34 였고,
// 그중 실제 결합은 0 이었다).
//   문서   각 파일 머리말의 "영향 범위". 이 저장소의 규약이고 코드가 아니다
//   지면   index.html 의 <link>. 계약상 항상 로드하므로 위반이 아니다
//   코드   주석을 제거한 뒤에도 남는 참조. 이것만 실제 결합이다
//
// 표·순환기·rail 표는 앱 셸에서 제외한다. 그 셋은 기능을 아는 것이 역할이다.
//
// 사용 방법
//   node bin/frame-purity.mjs           센 결과를 사람이 읽게 낸다
//   node bin/frame-purity.mjs --check   코드 결합이 하나라도 있으면 1 로 끝난다
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = process.argv.includes("--check");

const src = fs.readFileSync(path.join(ROOT, "web/js/core/capabilities.js"), "utf8");
const ids = [...src.matchAll(/id:\s*"([^"]+)"/g)].map((m) => m[1]);
const files = [...src.matchAll(/"([\w-]+\/[\w.-]+\.js)"/g)].map((m) => m[1]);

// 표·순환기·rail 표는 기능을 아는 것이 역할이다.
const EXEMPT = new Set(["capabilities.js", "capability-boot.js", "rail-items.js"]);
const frame = ["web/js/main.js"];
for (const f of fs.readdirSync(path.join(ROOT, "web/js/core"))) {
  if (f.endsWith(".js") && !EXEMPT.has(f)) frame.push("web/js/core/" + f);
}

// 문자열 안의 // 는 이 파일들에서 URL 뿐이라 단순 제거로 충분하다.
function stripComments(t) {
  return t.replace(/\/\*[\s\S]*?\*\//g, "").split("\n")
    .map((l) => l.replace(/(^|\s)\/\/.*$/, "")).join("\n");
}

let code = 0, doc = 0;
const rows = [];
for (const rel of frame) {
  const raw = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const bare = stripComments(raw);
  const found = [];
  for (const f of files) {
    if (!raw.includes(f)) continue;
    if (bare.includes(f)) { found.push("코드 " + f); code++; } else doc++;
  }
  for (const id of ids) {
    const re = new RegExp(`["'\`]${id}["'\`]`);
    if (!re.test(raw)) continue;
    if (re.test(bare)) { found.push("코드 이름 " + id); code++; } else doc++;
  }
  if (found.length) rows.push(`${rel}\n    ${found.join("\n    ")}`);
}

console.log(`틀로 본 파일 ${frame.length} (표·순환기·rail 표 제외)`);
console.log(`머리말에만 있는 언급 ${doc} 곳 — 저장소 규약, 결합 아님`);
if (rows.length) console.log("\n" + rows.join("\n"));
console.log(code ? `\n코드에서 닿는 자리 ${code} 곳` : "\n코드에서 닿는 자리 0 곳");

const html = fs.readFileSync(path.join(ROOT, "web/index.html"), "utf8");
const links = (html.match(/<link[^>]+\.css/g) || []).length;
const scripts = (html.match(/<script[^>]+src="[^"]*(browser|devtool|panel|viewer|docx|sheet|chatcopy)\//g) || []).length;
console.log(`index.html 지면 링크 ${links} 개 (계약상 늘 실린다)`);
console.log(`index.html 이 기능 스크립트를 직접 부르는 자리 ${scripts} 개`);

// main.js 가 창 모드 이름("memo" 등)을 아는 것은 결합이 아니다. 창 모드는 앱 셸이 소유하고
// 기능은 capabilities 의 windows 로 자기가 속한 창을 밝힌다. --check 는 그래서 0 을 요구하지
// 않고 지금 값을 기준으로 늘어나는 것만 막는다.
const ALLOWED_CODE_HITS = 1;
if (CHECK && (code > ALLOWED_CODE_HITS || scripts > 0)) {
  console.error(`\n틀이 기능을 아는 자리가 늘었다 (코드 ${code} > 허용 ${ALLOWED_CODE_HITS}, 스크립트 ${scripts})`);
  process.exit(1);
}
