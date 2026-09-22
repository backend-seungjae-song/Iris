#!/usr/bin/env node
// 이 파일을 import 하는 파일을 센다.
//
// 계약 헤더의 "영향 범위"가 적어 두는 목록의 정본 조사 도구다. grep 으로 세면 두 곳에서
// 결과가 틀린다. 헤더 자기 문자열에 걸려 자기 파일을 결과에 넣고, 파일 이름이 같은 모듈이
// 둘이면(browser/state.js 와 herdr/state.js, browser/tabs.js 와 center/tabs.js) 남의 소비자까지
// 함께 센다. 그래서 import 절만 보고 경로를 실제로 해석한다.
//
// 사용 방법: node bin/importers.mjs web/js/herdr/state.js
//           (server/*.js · native/electron/*.cjs · bin/*.mjs 도 같은 형태)
//
// native 는 CJS 라 import 절이 아니라 require 로 받는다. 같은 폴더에 파일이 스물 몇 개라
// grep 은 여기서 특히 부정확하다. 헤더 자기 문자열이 그대로 걸려 자기 파일이
// 소비자 목록에 들어간다.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const target = process.argv[2];
if (!target) {
  console.error("쓰는 법: node bin/importers.mjs <파일경로>");
  process.exit(2);
}
const want = path.posix.normalize(path.relative(ROOT, path.resolve(target)).split(path.sep).join("/"));

// 창·서버·네이티브·bin을 함께 훑는다. 한쪽만 보면 없는 소비자를 "없음"으로 답해
// 헤더가 사실과 달라진다.
const files = [];
for (const root of ["web/js", "server", "native/electron", "bin"]) {
  (function walk(rel) {
    for (const entry of readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const next = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(next);
      else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) files.push(next);
    }
  })(root);
}

const out = [];
for (const rel of files) {
  if (rel === want) continue;              // 자기 자신은 소비자가 아니다
  const dir = rel.slice(0, rel.lastIndexOf("/"));
  const text = readFileSync(path.join(ROOT, rel), "utf8");
  // ESM 의 정적·동적 import와 CJS 의 require 를 함께 본다. 한쪽만 보면 native 소비자나
  // 순서 보존 때문에 await import()를 쓰는 smoke 섹션이 통째로 "없음" 이 된다.
  const specs = [
    ...text.matchAll(/from\s+"(\.[^"]+)"/g),
    ...text.matchAll(/\bimport\("(\.[^"]+)"\)/g),
    ...text.matchAll(/require\("(\.[^"]+)"\)/g),
  ];
  for (const m of specs) {
    if (path.posix.normalize(`${dir}/${m[1]}`) === want) { out.push(rel); break; }
  }
}
out.sort();
console.log(out.length ? out.join("\n") : "(없음)");
