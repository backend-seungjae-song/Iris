#!/usr/bin/env node
// web/vendor를 의존성에서 그대로 만들어 낸다.
//
// 배경: 화면은 /vendor/xterm.js·xterm.css·addon-fit.js·jszip.min.js·monaco/vs 를 직접
// 불러 쓰는데, 이 파일들은 저장소에 없다(.gitignore). 그래서 clone만 하면 편집기와 터미널이
// 404가 된다. 손으로 받아다 넣으면 지금 들어 있는 것이 어느 버전인지 확인할 수 없어서,
// 의존성에서 그대로 만들어 내는 이 스크립트로 대신한다.
//
// 지금 들어 있는 것과 같은 것을 만든다는 근거(확인 결과): 저장소의 xterm.js·xterm.css·
// addon-fit.js는 @xterm/xterm@6.0.0·@xterm/addon-fit@0.11.0의 파일과 바이트 단위로 같고,
// jszip.min.js는 node_modules/jszip/dist의 것과 같다. 그래서 이 스크립트는 새 버전을 들이지 않는다.
//
// 실행: pnpm build:vendor   (pnpm install 뒤 prepare로도 자동 실행)
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = path.join(ROOT, "web", "vendor");

// pkg 안의 상대 경로로 원본을 찾는다. require.resolve는 package.json exports에 막힐 수 있어
// 패키지 루트를 먼저 구한 뒤 파일 경로를 잇는다.
function pkgRoot(name) {
  const marker = require_.resolve(`${name}/package.json`, { paths: [ROOT] });
  return path.dirname(marker);
}

const FILES = [
  ["@xterm/xterm", "lib/xterm.js", "xterm.js"],
  ["@xterm/xterm", "css/xterm.css", "xterm.css"],
  ["@xterm/addon-fit", "lib/addon-fit.js", "addon-fit.js"],
  ["jszip", "dist/jszip.min.js", "jszip.min.js"],
];
const DIRS = [
  ["monaco-editor", "min/vs", path.join("monaco", "vs")],
];

let copied = 0;
mkdirSync(VENDOR, { recursive: true });
for (const [pkg, from, to] of FILES) {
  const src = path.join(pkgRoot(pkg), from);
  if (!existsSync(src)) throw new Error(`원본이 없습니다: ${pkg}/${from} — pnpm install 먼저`);
  const dst = path.join(VENDOR, to);
  copyFileSync(src, dst);
  if (statSync(dst).size !== statSync(src).size) throw new Error(`복사가 어긋났습니다: ${to}`);
  copied++;
  console.log(`  ${to.padEnd(18)} ← ${pkg}/${from}`);
}
for (const [pkg, from, to] of DIRS) {
  const src = path.join(pkgRoot(pkg), from);
  if (!existsSync(src)) throw new Error(`원본이 없습니다: ${pkg}/${from} — pnpm install 먼저`);
  const dst = path.join(VENDOR, to);
  rmSync(dst, { recursive: true, force: true });
  cpSync(src, dst, { recursive: true });
  copied++;
  console.log(`  ${to.padEnd(18)} ← ${pkg}/${from} (폴더)`);
}

// 화면이 부르는 것과 만든 것이 일치하지 않으면 그대로 404가 된다. 여기서 먼저 잡는다.
const web = readFileSync(path.join(ROOT, "web", "index.html"), "utf8");
const wanted = [...web.matchAll(/["'(]\/vendor\/([A-Za-z0-9._\/-]+)/g)].map((m) => m[1]);
const missing = [...new Set(wanted)].filter((rel) => !existsSync(path.join(VENDOR, rel)));
if (missing.length) throw new Error(`화면이 부르는데 없는 vendor 파일: ${missing.join(", ")}`);

console.log(`vendor ${copied}건 준비 완료 — 화면이 부르는 ${new Set(wanted).size}개 경로 모두 존재`);
