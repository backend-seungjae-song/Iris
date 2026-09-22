#!/usr/bin/env node
// 이 저장소의 코드가 실제로 무엇에서 무엇으로 이어지는지 한 번만 센다.
//
// 배경: 도달성 검사가 세 곳에 따로 있었다(web/js · server · native/.cjs).
// 셋이 각자 그래프를 다시 걸었고, 각자 다른 것을 놓쳤다. `.cjs` 만 세는 바람에
// native/electron 의 `.js` 는 아무도 안 봤고, bin·scripts·test 는 애초에 셈 밖이었다.
// 규칙이 여러 곳에 있으면 반드시 갈라지고, 갈라진 쪽이 약한 쪽이 된다. 약한 쪽이 곧
// 우회되는 지점이 된다(공개 흔적 목록에서 겪은 문제다).
//
// 진입점은 직접 적지 않는다. 실제로 실행되는 곳에서 읽어 온다. package.json 의 scripts,
// html 의 script·import, 셸 스크립트의 `node X`, 코드가 경로 문자열로 띄우는 자식 프로세스,
// 러너가 폴더를 훑어 실행하는 것. 직접 적은 목록은 항목이 늘 때 최신 상태를 잃는다.
//
// 그래도 남는 경우가 있다. 사람만 부르는 도구(CLI·조사기)는 부르는 코드가 없다. 그런 파일은
// docs/entrypoints.md 가 소유한다. 그 문서가 정본이고, 문서와 실물이 어긋나면 검사가 막는다.
// 셔뱅만으로 통과시키지 않는 이유가 여기 있다. 셔뱅은 누구나 붙일 수 있어 게이트가 되지 못한다.
//
// 사용 방법:
//   node bin/graph.mjs                 사람이 읽는 요약
//   node bin/graph.mjs --json          기계가 읽는 전체 그래프
//   node bin/graph.mjs --orphans       진입점에서 안 닿는 파일만
//   node bin/graph.mjs --importers <f> 그 파일을 부르는 파일
//   node bin/graph.mjs --why <f>       진입점에서 그 파일까지의 경로 하나
//   node bin/graph.mjs --entries       진입점과 그 근거
//   node bin/graph.mjs --dead-exports  아무도 안 부르는 export
//   node bin/graph.mjs --check        게이트. 고아·오래된 문서·죽은 export 를 판정한다
//   node bin/graph.mjs --doc-drift    문서가 대는데 실물이 없는 경로
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 한 번 읽은 파일은 다시 안 읽는다. 게이트가 같은 파일을 여러 검사에서 훑는데, 매번 디스크로
// 가고 매번 주석을 다시 벗기면 저장소 크기에 비례해 비용이 커진다(확인 결과: 훑기 57초).
// 게이트는 한 번 실행하고 끝나는 프로세스라 캐시가 오래될 일이 없다.
const readCache = new Map();
const read = (rel) => {
  let v = readCache.get(rel);
  if (v === undefined) { v = readFileSync(path.join(ROOT, rel), "utf8"); readCache.set(rel, v); }
  return v;
};
const norm = (p) => path.posix.normalize(p);

// ─── 셈에 넣는 자리 ─────────────────────────────────────────────────────────
//
// 여기 없는 폴더는 그래프가 아예 모르므로 고아도 안 보인다. 그래서 이 목록이 저장소의 실제
// 코드 폴더를 다 덮는지 smoke 가 따로 검사한다. 직접 적은 목록이 오래되는 것을 막는 방법이다.
// `web/js` 가 아니라 `web` 이다. `web/js` 만 세면 index.html 이 <script src> 로 싣는
// web/scrollback-copy.js · web/memo-snapshot-state.js 두 파일이 그래프에 들어오지 않는다.
// 고아여도 보이지 않고, 지워도 어떤 검사도 실패하지 않는다(확인 결과).
const CODE_ROOTS = ["web", "server", "native/electron", "bin", "scripts", "test"];
const CODE_EXT = /\.(?:js|mjs|cjs|sh)$/;

// 저장소 맨 위에 있는 셸 진입 파일. 확장자가 없어서 규칙으로는 안 잡힌다.
const ROOT_SHELL = ["setup"];

// 코드지만 이 그래프의 대상이 아닌 것. 의존성에서 만들어 내는 vendor 와 node_modules.
const NOT_OURS = /^web\/vendor\/|(^|\/)node_modules\//;

// 진입점 정본 문서. 사람만 부르는 도구는 여기에 적혀 있어야 살아 있는 것으로 본다.
export const ENTRY_DOC = "docs/entrypoints.md";

function walk(rel, out, want) {
  const abs = path.join(ROOT, rel);
  if (!existsSync(abs)) return out;
  for (const e of readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const next = `${rel}/${e.name}`;
    if (NOT_OURS.test(next)) continue;
    if (e.isDirectory()) walk(next, out, want);
    else if (want.test(e.name)) out.push(next);
  }
  return out;
}

export function codeFiles() {
  const out = [];
  for (const r of CODE_ROOTS) walk(r, out, CODE_EXT);
  for (const r of ROOT_SHELL) if (existsSync(path.join(ROOT, r))) out.push(r);
  return [...new Set(out)].sort();
}

// CODE_ROOTS 가 저장소의 실제 코드 폴더를 다 덮는가. 안 덮으면 그 폴더는 그래프가 아예 모르므로
// 고아가 있어도 보이지 않는다. 직접 적은 목록이 오래되는 지점이 여기다. git 이 아는 파일과 대조한다.
export function rootsCoverage() {
  let tracked;
  try {
    tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  } catch { return { ok: true, missing: [], skipped: "git 을 못 불러 판정하지 않음" }; }
  // 목록이 비면 뺄 것이 없어 "다 덮는다"가 된다. 이 검사가 지키는 것은 직접 적은 CODE_ROOTS 가
  // 실제 코드 폴더를 다 덮는가이고, 목록이 비면 그 질문 자체가 사라진다. 판정 불가가 아니라 실패다.
  if (tracked.length < 50) return { missing: [], unmeasured: `git 이 아는 파일이 ${tracked.length}개뿐 — 이 목록으로는 아무것도 못 지킨다` };
  const covered = new Set(codeFiles());
  const missing = tracked.filter((f) => CODE_EXT.test(f) && !NOT_OURS.test(f) && !covered.has(f));
  return { ok: missing.length === 0, missing };
}

function htmlFiles() {
  return walk("web", [], /\.html$/).sort();
}

// ─── 간선 ───────────────────────────────────────────────────────────────────
//
// 한 형태만 보면 그 형태를 안 쓰는 영역이 통째로 "아무도 안 부름"이 된다.
// 정적 from 만 보면 capability 모듈이 전부 고아로 보이고(동적 import 로만 로드된다),
// require 를 안 보면 native 소비자가 전부 보이지 않는다.
//
// 부르는 방식은 import 만이 아니다. 자식 프로세스로 띄우는 것도, 셸이 `node X` 로 부르는 것도
// 실행이다. 그것을 안 세면 run-tests 가 띄우는 위생 검사와 install-app.sh 가 부르는
// check-shipped 가 전부 고아로 잡힌다(확인 결과).
// 따옴표는 두 종류다. 큰따옴표만 보면 이 저장소의 11개 파일이 간선 없이 지나가고,
// web/memolab/app.js 가 세 모듈을 부르는데도 그 셋이 "아무도 안 부름"으로 잡힌다(확인 결과
//). 여는 따옴표와 닫는 따옴표를 각각 문자 하나로 받는다. 짝이 맞지 않는 형태는
// 애초에 파싱되지 않는 코드라 여기서 가려낼 것이 없다.
const IMPORT_PATTERNS = [
  /from\s+["'](\.[^"']+)["']/g,                                    // ESM 정적
  /\bimport\(\s*["'](\.[^"']+)["']\s*\)/g,                         // ESM 동적
  /\brequire\(\s*["'](\.[^"']+)["']\s*\)/g,                        // CJS
  /\brequire\.resolve\(\s*["'](\.[^"']+)["']\s*\)/g,               // 가리키기만 하는 참조이며 기능 표가 이 형태로 경계를 적는다
  /new URL\(\s*["'](\.[^"']+)["']\s*,\s*import\.meta\.url\s*\)/g,  // URL 로 받아 쓰는 자리
  /path\.join\(\s*__dirname\s*,\s*["'](\.?\/?[^"']+\.(?:js|mjs|cjs))["']\s*\)/g,  // preload 처럼 경로로 실리는 것
];

// 자식 프로세스로 띄우는 곳. 경로가 글자로 나온다고 해서 부르는 것은 아니다. 주석이
// `node bin/importers.mjs <파일>` 이라고 적어 두거나 검사가 `read("bin/qa-plan.mjs")` 로
// 본문만 읽는 경우가 그렇다. 그것까지 간선으로 세면 고아 판정이 통째로 무의미해진다
// (확인 결과: 그 규칙으로는 server/index.js 가 bin/smoke.mjs 를 "부르는" 것이 됐다).
// 그래서 실행을 뜻하는 단어가 같은 줄에 있을 때만 센다.
const SPAWN_WORD = /\b(?:execFileSync|execFile|spawnSync|spawn|execSync|execPath|fork)\b|["']node["']|["']electron["']/;
const REPO_PATH = /((?:web|server|native\/electron|bin|scripts|test)\/[A-Za-z0-9_./-]+\.(?:js|mjs|cjs|sh))/g;

// 셸에서는 실행을 뜻하는 단어가 그 줄에 있을 때만 실행이다. `echo scripts/x.sh` 는 부르는 것이 아니다.
// 경로 앞에 셸 확장이 붙기도 한다(`exec bash "$(dirname "$0")/scripts/setup.sh"`). 그래서
// 경로를 통째로 잡으려 들지 않고, 그 줄에서 저장소 경로만 따로 집는다.
const SH_RUN_WORD = /(?:^|[;&|(]|\bthen\b|\belse\b|\bdo\b|\brun\b|\bexec\b|\|\|)\s*(?:sudo\s+)?(?:node|electron|bash|sh)\s/;

// 주석은 코드가 아니다. 지우고 나서 센다. 주석 처리한 import 가 유효한 간선으로 잡히는
// 것도 같은 결함이다.
const stripCache = new Map();
function stripComments(src, isShell) {
  const key = (isShell ? "s" : "j") + src.length + "\u0000" + src.slice(0, 64);
  const hit = stripCache.get(key);
  if (hit !== undefined && hit.src === src) return hit.out;
  const out = stripCommentsRaw(src, isShell);
  stripCache.set(key, { src, out });
  return out;
}

function stripCommentsRaw(src, isShell) {
  if (isShell) return src.split("\n").map((l) => l.replace(/(^|\s)#.*$/, "$1")).join("\n");
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n").map((l) => {
      // 문자열 안의 "//" 를 주석으로 오인하지 않게, 따옴표 밖의 것만 자른다.
      let q = null, esc = false;
      for (let i = 0; i < l.length; i++) {
        const c = l[i];
        if (esc) { esc = false; continue; }
        if (c === "\\") { esc = true; continue; }
        if (q) { if (c === q) q = null; continue; }
        if (c === '"' || c === "'" || c === "`") { q = c; continue; }
        if (c === "/" && l[i + 1] === "/") return l.slice(0, i);
      }
      return l;
    }).join("\n");
}

function resolveSpec(fromRel, spec, known) {
  const dir = fromRel.includes("/") ? fromRel.slice(0, fromRel.lastIndexOf("/")) : ".";
  const base = norm(`${dir}/${spec}`);
  if (known.has(base)) return base;
  for (const ext of [".js", ".mjs", ".cjs"]) if (known.has(base + ext)) return base + ext;
  for (const ext of [".js", ".mjs", ".cjs"]) if (known.has(`${base}/index${ext}`)) return `${base}/index${ext}`;
  return null;
}

export function edgesOf(rel, known, raw = read(rel)) {
  const out = new Set();
  const isShell = rel.endsWith(".sh") || !rel.includes(".");
  const src = stripComments(raw, isShell);
  const take = (t) => { if (t && t !== rel && known.has(t)) out.add(t); };

  if (!isShell) {
    for (const re of IMPORT_PATTERNS) {
      for (const m of src.matchAll(re)) {
        take(resolveSpec(rel, m[1].startsWith(".") ? m[1] : `./${m[1]}`, known));
      }
    }
    // 자식 프로세스는 인자가 다음 줄로 넘어가는 일이 흔하다. 실행 단어가 있는 줄과 그다음
    // 두 줄까지를 한 범위로 본다.
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!SPAWN_WORD.test(lines[i])) continue;
      const win = lines.slice(i, i + 3).join(" ");
      for (const m of win.matchAll(REPO_PATH)) take(norm(m[1]));
    }
  } else {
    for (const line of src.split("\n")) {
      if (!SH_RUN_WORD.test(line)) continue;
      for (const m of line.matchAll(REPO_PATH)) take(norm(m[1]));
    }
  }
  return [...out].sort();
}

// ─── 진입점 ─────────────────────────────────────────────────────────────────

export function entryPoints(known) {
  const why = new Map();
  const add = (rel, reason) => { if (rel && known.has(rel) && !why.has(rel)) why.set(rel, reason); };

  // 1) package.json 이 직접 실행하는 것. 앱·서버 진입도 여기서 나오며 직접 적지 않는다.
  const pkg = JSON.parse(read("package.json"));
  if (typeof pkg.build?.afterPack === "string") {
    add(norm(pkg.build.afterPack.replace(/^\.\//, "")), "package.json build.afterPack");
  }
  for (const [name, body] of Object.entries(pkg.scripts || {})) {
    // 스크립트는 셸 한 줄이다. 단어로 끊어 실제 파일인 것만 센다.
    for (const w of String(body).split(/\s+/)) if (known.has(norm(w))) add(norm(w), `pnpm ${name}`);
  }
  const binField = pkg.bin;
  if (typeof binField === "string") add(norm(binField.replace(/^\.\//, "")), "package.json bin");
  else for (const [name, p] of Object.entries(binField || {})) add(norm(String(p).replace(/^\.\//, "")), `bin: ${name}`);

  // 2) html 이 싣는 것. index.html 하나만 보면 다른 화면의 스크립트가 전부 고아다.
  for (const html of htmlFiles()) {
    const dir = html.slice(0, html.lastIndexOf("/"));
    const src = read(html);
    for (const m of src.matchAll(/<script[^>]*\bsrc="([^"]+)"|\bimport\(\s*"([^"]+)"\s*\)|from\s+"([^"]+)"/g)) {
      const spec = m[1] || m[2] || m[3];
      if (!spec || /^https?:|^\/\//.test(spec)) continue;
      add(spec.startsWith("/") ? norm(`web${spec}`) : norm(`${dir}/${spec}`), `${html}`);
    }
  }

  // 3) 러너가 폴더를 훑어 도는 것. 러너가 무엇을 고르는지는 그 코드가 정하므로 거기서 읽는다.
  if (known.has("scripts/run-tests.mjs") && /\btest\b/.test(read("scripts/run-tests.mjs"))) {
    for (const rel of known) {
      if (rel.startsWith("test/") && rel.endsWith(".mjs") && !rel.startsWith("test/lib/")) add(rel, "테스트 러너");
    }
  }
  if (known.has("bin/smoke.mjs") && /sections/.test(read("bin/smoke.mjs"))) {
    for (const rel of known) {
      if (rel.startsWith("bin/smoke/sections/") && rel.endsWith(".mjs")) add(rel, "smoke 러너");
    }
  }

  return why;
}

// ─── 사람만 부르는 것: 문서가 소유한다 ────────────────────────────────────
//
// 표의 첫 칸이 경로다. 그 줄이 있어야 살아 있는 것으로 보고, 없으면 고아다.
export function declaredEntries() {
  if (!existsSync(path.join(ROOT, ENTRY_DOC))) return new Map();
  const out = new Map();
  for (const line of read(ENTRY_DOC).split("\n")) {
    const m = /^\|\s*`([^`]+)`\s*\|\s*([^|]*?)\s*\|/.exec(line);
    if (m) out.set(norm(m[1]), m[2].trim());
  }
  return out;
}

// ─── 내보낸 이름 ────────────────────────────────────────────────────────────
//
// 파일이 살아 있어도 그 안의 함수는 죽을 수 있다. 오래된 코드는 대부분 이 모양이다.
// 파일 단위 도달성은 통과하는데 아무도 안 부르는 export 가 그 안에 남아 있다.
//
// 판정은 보수적으로 한다. 소비자 본문에 그 이름이 단어로 한 번이라도 나오면 쓰는 것으로 센다
// (`import * as ns` 뒤의 `ns.foo`, 구조분해, 문자열 키 접근을 다 놓치지 않기 위해서다).
// 그래서 여기서 "안 쓴다"고 나온 것은 거의 확실히 안 쓰는 것이다. 반대로 실제 죽은 것을
// 일부 놓칠 수는 있다. 게이트에서는 이 방향의 오차가 옳다.
const EXPORT_PATTERNS = [
  /export\s+(?:async\s+)?function\s+\*?\s*([A-Za-z_$][\w$]*)/g,
  /export\s+class\s+([A-Za-z_$][\w$]*)/g,
  /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
];

// 선언은 문자열 안에 있지 않다. 검사 코드가 `/export function attachWs/` 같은 정규식으로
// 남의 선언을 확인하는데, 그것을 그 파일 자신의 export 로 세면 검사 파일마다 없는 export 가
// 무더기로 생긴다(확인 결과: 31건 중 16건이 이 오인이었다). importers.mjs 가 적어 둔
// "헤더 자기 문자열에 걸린다"와 같은 함정이다. 그래서 문자열·정규식 안은 비우고 센다.
function stripLiterals(src) {
  let out = "", i = 0, prev = "";
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c; i++;
      while (i < src.length && src[i] !== q) { if (src[i] === "\\") i++; i++; }
      i++; out += q + q; prev = q; continue;
    }
    // 정규식 리터럴은 나눗셈과 모양이 같다. 앞이 값이 올 수 없는 자리일 때만 정규식으로 본다.
    // 앞 글자 하나만 보면 `return /.../` 를 놓치고, 그 형태가 이 저장소의 검사 코드다.
    // `=>` 뒤도 값이 오는 위치다. 이 저장소의 검사는 대부분 `() => /.../` 모양이라
    // `>` 를 빠뜨리면 그 형태를 통째로 놓친다(확인 결과).
    //
    // 이 판정은 `/` 를 만났을 때만 필요하다. 글자마다 out 전체를 훑어 뒤 공백을
    // 지우면 out 이 파일 크기까지 자라므로 비용이 크기의 제곱이 된다(확인 결과:
    // 92KB 파일 하나에 7초, 저장소 전체 훑기 113초). 앞 글자는 prev 가 이미 갖고 있고
    // 단어 판정에 필요한 것은 끝 몇 자뿐이며 가장 긴 단어가 여섯 자이므로 끝만 잘라 본다.
    if (c === "/") {
      const tail = out.slice(-40).replace(/\s+$/, "");
      const regexOk = !prev || /[(,=:[!&|?{};+\-*%~^>]/.test(prev)
        || /\b(?:return|typeof|case|in|of|do|else|void|delete|await|yield|new)$/.test(tail);
      if (regexOk) {
      let j = i + 1, cls = false, ok = false;
      while (j < src.length) {
        const d = src[j];
        if (d === "\\") { j += 2; continue; }
        if (d === "[") cls = true;
        else if (d === "]") cls = false;
        else if (d === "/" && !cls) { ok = true; break; }
        else if (d === "\n") break;
        j++;
      }
      if (ok) { i = j + 1; while (i < src.length && /[dgimsuvy]/.test(src[i])) i++; out += "//"; prev = "/"; continue; }
      }
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

// 내보내는 이름을 뽑는 일이 이 게이트에서 제일 비싸다. 문자열·주석을 한 글자씩 벗기는 훑기라
// 파일 크기에 비례하고, 여러 검사가 같은 파일을 다시 묻는다(확인 결과: 336개 파일 전체 훑기가
// 게이트 시간의 대부분이었다). 한 번 뽑으면 그대로 쓴다. 게이트는 한 번 실행하고 끝나는
// 프로세스라 원본이 바뀌는 일이 없고, 그래도 넘겨받은 원본이 다르면 다시 뽑는다.
const exportsCache = new Map();
export function exportsOf(rel, raw = read(rel)) {
  const hit = exportsCache.get(rel);
  if (hit && hit.raw === raw) return hit.names;
  const names = exportsOfRaw(rel, raw);
  exportsCache.set(rel, { raw, names });
  return names;
}

function exportsOfRaw(rel, raw) {
  const src = stripLiterals(stripComments(raw, rel.endsWith(".sh") || !rel.includes(".")));
  const out = new Set();
  for (const re of EXPORT_PATTERNS) for (const m of src.matchAll(re)) out.add(m[1]);
  // export { a, b as c } 에서 밖으로 보이는 이름은 as 뒤쪽이다.
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const seg = part.trim();
      if (!seg) continue;
      const as = /(?:\S+)\s+as\s+([A-Za-z_$][\w$]*)/.exec(seg);
      const name = as ? as[1] : seg;
      if (/^[A-Za-z_$][\w$]*$/.test(name) && name !== "default") out.add(name);
    }
  }
  // CJS 는 module.exports 로 낸다.
  for (const m of src.matchAll(/(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/g)) out.add(m[1]);
  for (const m of src.matchAll(/module\.exports\s*=\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const seg = part.trim();
      const name = /^([A-Za-z_$][\w$]*)\s*(?::|$)/.exec(seg);
      if (name) out.add(name[1]);
    }
  }
  return [...out].sort();
}

// 러너가 폴더를 훑어 동적으로 부르는 파일은 소비자가 코드에 없다. 그런 파일의 export 는
// 러너가 무엇을 부르는지로 판정한다. smoke 섹션의 default run 이 그 경우다.
const DYNAMIC_CONSUMED = [
  { when: (rel) => rel.startsWith("bin/smoke/sections/"), names: ["default", "run"] },
  { when: (rel) => rel.startsWith("test/"), names: ["default", "run"] },
];

// 부르는 쪽이 import 로 이름을 받지 않는 경우가 있다. 동적으로 실은 모듈에 대고
// `mod.initCapability(ctx)` 처럼 약속된 이름을 치는 자리다(`web/js/core/capability-boot.js:36`).
// 그런 호출은 역방향 간선에 안 잡히므로, 저장소 전체에서 "멤버로 접근된 이름"을 한 번 모아
// 두고 그것도 쓰임으로 센다. 게이트에서는 이 방향(놓치는 쪽)의 오차가 옳다.
function memberNamesUsed(g) {
  const out = new Set();
  for (const rel of g.files) {
    if (rel.endsWith(".sh") || !rel.includes(".")) continue;
    const src = stripComments(read(rel), false);
    for (const m of src.matchAll(/\.([A-Za-z_$][\w$]*)\s*[.(\[=,;)}\]]/g)) out.add(m[1]);
    for (const m of src.matchAll(/\[\s*"([A-Za-z_$][\w$]*)"\s*\]/g)) out.add(m[1]);
  }
  return out;
}

export function deadExports(g) {
  const out = [];
  const members = memberNamesUsed(g);
  for (const rel of g.files) {
    if (rel.endsWith(".sh") || !rel.includes(".")) continue;
    const names = exportsOf(rel);
    if (!names.length) continue;
    const users = g.reverse.get(rel) || [];
    // 소비자 본문을 한 번만 읽어 둔다.
    const bodies = users.map((u) => stripComments(read(u), false));
    const dyn = DYNAMIC_CONSUMED.find((d) => d.when(rel));
    for (const name of names) {
      if (dyn && dyn.names.includes(name)) continue;
      if (members.has(name)) continue;
      const word = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
      if (bodies.some((b) => word.test(b))) continue;
      out.push({ file: rel, name, users: users.length });
    }
  }
  return out;
}

// ─── 받아 오는 이름이 실제로 나오는가 ────────────────────────────────────────
//
// ESM 은 없는 이름을 import 하면 그 자리에서 실패한다. CommonJS 는 실패하지 않는다. 구조분해가
// undefined 를 담고, 그 이름을 부르는 순간에 오류가 난다. 최상위에서 부르면 앱이 뜨자마자
// 죽고, 어쩌다 부르는 자리면 그날까지 아무도 모른다.
//
// 확인 결과: native/electron/main.cjs 가 cdp-control.cjs 에서 aiDriving ·
// aiDrivingAnywhere · holdAiCausality · setPaintableProbe 넷을 받는데 그 파일은 넷 다
// 안 내보냈다. setPaintableProbe 는 최상위에서 불리므로, 새로 받은 체크아웃에서 앱이 켜지자마자
// 실패한다. 문법 검사도 테스트도 스모크도 이것을 잡지 못했다. 검사가 없었기 때문이다.
const CJS_DESTRUCTURE = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*"([^"]+)"\s*\)/g;

export function requireMismatches(g) {
  const out = [];
  for (const rel of g.files) {
    if (!rel.endsWith(".cjs")) continue;
    const src = stripComments(read(rel), false);
    for (const m of src.matchAll(CJS_DESTRUCTURE)) {
      const spec = m[2];
      if (!spec.startsWith(".")) continue;              // 패키지는 이 저장소가 아니다
      const dir = rel.slice(0, rel.lastIndexOf("/"));
      const target = path.posix.normalize(path.posix.join(dir, spec));
      let raw;
      try { raw = read(target); } catch { continue; }   // 없는 파일은 다른 검사가 본다
      // 내보내는 모양을 못 읽으면 판정하지 않는다. 모호한 경우를 막으면 고칠 수 없는 실패가 된다.
      if (/Object\.assign\(\s*module\.exports/.test(raw)) continue;
      if (/module\.exports\s*=\s*[A-Za-z_$]/.test(raw)) continue;   // 다른 것을 통째로 내보냄
      const have = new Set(exportsOf(target, raw));
      if (!have.size) continue;
      for (const part of m[1].split(",")) {
        const name = /^([A-Za-z_$][\w$]*)/.exec(part.trim());
        if (name && !have.has(name[1])) out.push({ file: rel, name: name[1], from: target });
      }
    }
  }
  return out;
}

// ─── 문서가 대는 경로 ───────────────────────────────────────────────────────
//
// 문서가 오래되는 가장 흔한 모양은 지워진 파일을 계속 가리키는 것이다. 확인 결과:
// docs/chrome-auth-handoff.md 의 「손대는 곳」 표가 이 저장소에 있었던 적도 없는 모듈 둘을
// 담당자로 적고 있었고, 심지어 test/login-session-ownership.mjs 는 그중 하나를 import 하지
// 말라고 막고 있었다. 어떤 검사도 실패하지 않았다. 검사가 없었기 때문이다.
//
// 확장자를 셀 때 순서가 중요하다. `js` 를 `json` 보다 먼저 두면 `iris-screens.json` 이
// `iris-screens.js` 로 잘려 없는 파일이 된다.
const DOC_PATH_RE = /((?:web|server|native\/electron|bin|scripts|test|docs)\/[A-Za-z0-9_./-]+\.(?:mjs|cjs|json|html|css|md|sh|js))(?![A-Za-z0-9_.-])/g;

// 문서에는 "이렇게 만들면 된다"는 예시 경로가 나온다. 예시는 실물이 없는 것이 정상이다.
// 예시 표시가 붙은 블록은 검사하지 않는다. 표시가 없으면 검사하므로 예시에는 표시를 달아야 한다.
const DOC_EXAMPLE = /^(?:\s*(?:예시|보기|가정)|.*—\s*예시)/;

// 가리키는 데가 없는 문서. 코드 쪽에는 「진입점에서 안 닿는 파일이 없다」가 있는데 문서 쪽에는
// 없었다. 새 문서를 만들고 아무 곳에서도 연결하지 않으면 읽히지 않은 채로 계속 오래된다.
// 나중에 누가 찾아내면 그 안의 사실이 언제부터 틀렸는지 알 방법이 없다.
//
// 관례상 스스로 진입점인 것들이 있다. README 는 저장소의 첫 화면이고 LICENSE·NOTICE·SECURITY·
// CONTRIBUTING 은 GitHub 이 자기 자리에 띄운다. CLAUDE.md 는 도구가 규약으로 집는다.
// 이 목록은 "안 걸려 있어도 읽힌다"가 성립하는 것만 담는다. 늘리면 그만큼 이 검사의 범위가 줄어든다.
const DOC_ENTRIES = new Set([
  "README.md", "LICENSE", "NOTICE", "SECURITY.md", "CONTRIBUTING.md",
  "THIRD-PARTY.md", "DESIGN.md", "CLAUDE.md",
]);
// 이식해 온 것에 딸려 온 고지. 우리가 거는 것이 아니라 그 코드와 함께 있어야 하는 파일이다.
const DOC_VENDOR = /(^|\/)vendor\//;

export function orphanDocs() {
  let docs, code;
  try {
    docs = execFileSync("git", ["ls-files", "*.md", "NOTICE"], { cwd: ROOT, encoding: "utf8" })
      .split("\n").filter(Boolean).filter((f) => !f.startsWith(".working/"));
    code = execFileSync("git", ["ls-files", "*.js", "*.mjs", "*.cjs", "*.json", "*.yml", "*.sh"],
      { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  } catch { return { bad: [], unmeasured: "git 을 못 불러 판정하지 않음" }; }
  // 목록이 비면 고아도 0이 된다. 없는 것이 아니라 못 센 것이다.
  if (docs.length < 5) return { bad: [], unmeasured: `git 이 아는 문서가 ${docs.length}개뿐 — 이 목록으로는 아무것도 못 지킨다` };

  // 다른 문서와 코드를 한 말뭉치로 놓고 이름이 불리는지 본다. 자기 자신은 뺀다. 문서가 자기
  // 이름을 적는 것은 가리켜진 것이 아니다.
  const bodies = [...docs, ...code].map((f) => {
    try { return { f, body: read(f) }; } catch { return null; }
  }).filter(Boolean);
  const bad = [];
  for (const d of docs) {
    if (DOC_ENTRIES.has(d) || DOC_VENDOR.test(d)) continue;
    const base = d.slice(d.lastIndexOf("/") + 1);
    if (!bodies.some((o) => o.f !== d && (o.body.includes(d) || o.body.includes(base)))) bad.push(d);
  }
  return { bad };
}

// .gitignore 가 그 파일 하나를 이름 그대로 올린 경우만 "없는 것이 정상" 이다. 사람마다 두는
// 로컬 파일을 문서가 안내할 수 있어야 하고, 받은 트리에는 그 파일이 없다. 폴더 패턴(`deep/`)에
// 걸린다는 이유로 면제하면 그 아래 아무 경로나 적어도 통과하므로, 패턴이 경로와 같을 때만 면제한다.
function gitIgnored(rel) {
  try {
    const out = execFileSync("git", ["check-ignore", "-v", "--no-index", rel], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const pattern = (out.split("\t")[0] || "").split(":").slice(2).join(":").trim();
    return pattern === rel;
  } catch { return false; }
}

export function docPathDrift() {
  let docs;
  try {
    // NOTICE 도 본다. 확장자가 없어서 `*.md` 에 안 걸렸는데, 그 안에 이식해 온 파일 넷이
    // 이름으로 적혀 있다. 법적 귀속을 밝히는 문서이므로, 그중 하나가 이름이 바뀌면 고지가
    // 다른 것을 가리키게 된다. 다른 문서보다 덜 중요하지 않다.
    docs = execFileSync("git", ["ls-files", "*.md", "NOTICE"], { cwd: ROOT, encoding: "utf8" })
      .split("\n").filter(Boolean);
  } catch { return { ok: true, bad: [], skipped: "git 을 못 불러 판정하지 않음" }; }
  // 목록이 비면 훑을 것이 없어 통과한다. 아무것도 보지 않으면서 "다 실재한다"고 말하는 상태다.
  // 이건 skipped 가 아니라 실패다. 판정을 못 한 것과 판정할 것이 없어진 것은 다르다.
  if (docs.length < 5) return { bad: [], unmeasured: `git 이 아는 문서가 ${docs.length}개뿐 — 이 목록으로는 아무것도 못 지킨다` };
  const bad = [];
  for (const d of docs) {
    const lines = read(d).split("\n");
    let inExample = false;
    lines.forEach((line, i) => {
      if (DOC_EXAMPLE.test(line)) { inExample = true; return; }
      // 예시 표시 다음에는 빈 줄을 하나 두고 들여쓴 블록이 오는 것이 이 저장소 문서의 형식이다.
      // 빈 줄에서 끊으면 그 블록을 덮지 못하므로, 들여쓰기가 끝나는 지점에서 끊는다.
      if (!line.trim()) return;
      if (inExample && /^\s/.test(line)) return;
      inExample = false;
      for (const m of line.matchAll(DOC_PATH_RE)) {
        if (existsSync(path.join(ROOT, m[1])) || gitIgnored(m[1])) continue;
        bad.push(`${d}:${i + 1}: ${m[1]}`);
      }
    });
  }
  return { ok: bad.length === 0, bad };
}

// ─── 지면 이름 ──────────────────────────────────────────────────────────────

// 스타일시트를 기능마다 나누면 이름도 같이 옮겨 가고, 그때 한쪽만 옮겨지는 문제가 생긴다.
// CSS 는 새 이름으로 갔는데 그 이름을 부르던 JS 는 옛 이름 그대로 남는 식이다.
// 그러면 그 화면의 머리·구획·칩·빈 상태가 스타일 없이 그려지는데, 파일은 그대로 있고
// import 도 다 걸려 있어서 고아 검사도 죽은 export 검사도 아무것도 잡지 못한다.
// 확인 결과: 오래된 사본이 올라가 두 파일이 되돌려졌고, 그 뒤로 열한 개
// 이름이 스타일 없이 나갔다. 어느 검사도 잡지 못했다.
//
// 셋이 동시에 성립할 때만 지적한다. 불확실하면 통과시킨다.
//   1. JS·HTML 이 문자 그대로 적은 class 이름. 값으로 조립되는 이름은 보지 않는다
//   2. 그 이름을 web/css 도, 안에 박힌 <style> 도 정의하지 않는다
//   3. 접두사만 다르고 뒤가 같은 이름을 스타일시트가 정의하고 있다
// 셋째만으로는 우연히 걸린다(bmk-t 와 sv-t 처럼). 그래서 한 접두사에서 여럿이 *같은*
// 다른 접두사로 나란히 짝을 가질 때만 개명으로 본다.
const RENAME_FAMILY_MIN = 3;

// `${...}` 안쪽은 이름이 아니라 값이다. 중첩까지 제거한다.
function stripInterp(s) {
  let out = "", depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "$" && s[i + 1] === "{") { depth++; i++; continue; }
    if (depth) { if (s[i] === "{") depth++; else if (s[i] === "}") depth--; continue; }
    out += s[i];
  }
  return out;
}

const CLASS_ATTR = /class=\\?["`]([^"`<>]*)\\?["`]/g;
const CSS_NAME = /\.([a-zA-Z][a-zA-Z0-9_-]*)/g;
const INLINE_STYLE = /<style[^>]*>([\s\S]*?)<\/style>/g;
const CLASS_NAME = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

// walk 이 web/vendor 는 이미 제외한다. 이식해 온 스타일시트는 이 저장소의 규약이 아니다.
function webFiles(want) {
  return walk("web", [], want);
}

export function halfMovedClassNames() {
  const markup = webFiles(/\.(?:js|html)$/);
  const sheets = webFiles(/\.css$/);
  // 목록이 비면 위반도 0이 된다. 없는 것이 아니라 못 센 것이다.
  if (sheets.length < 5 || markup.length < 20)
    return { bad: [], unmeasured: `지면 ${sheets.length}개 · 화면 파일 ${markup.length}개 — 이 목록으로는 아무것도 못 지킨다` };

  let css = sheets.map((f) => read(f)).join("\n");
  for (const f of markup) for (const m of read(f).matchAll(INLINE_STYLE)) css += m[1];

  const defined = new Set();
  for (const m of css.matchAll(CSS_NAME)) defined.add(m[1]);
  if (defined.size < 50)
    return { bad: [], unmeasured: `지면이 정의한 이름이 ${defined.size}개뿐 — 이 목록으로는 아무것도 못 지킨다` };

  const used = new Map();
  for (const f of markup) {
    for (const m of read(f).matchAll(CLASS_ATTR)) {
      for (const c of stripInterp(m[1]).split(/\s+/)) {
        if (!CLASS_NAME.test(c)) continue;
        (used.get(c) || used.set(c, new Set()).get(c)).add(f);
      }
    }
  }
  if (used.size < 50)
    return { bad: [], unmeasured: `글자로 박힌 이름이 ${used.size}개뿐 — 이 목록으로는 아무것도 못 지킨다` };

  const tail = (n) => { const i = n.indexOf("-"); return i < 1 ? null : n.slice(i + 1); };
  const head = (n) => n.slice(0, n.indexOf("-"));
  const byTail = new Map();
  for (const d of defined) {
    const t = tail(d);
    if (t) (byTail.get(t) || byTail.set(t, []).get(t)).push(d);
  }

  // (옛 접두사 → 새 접두사) 쌍마다 몇 개가 나란히 서는지 센다
  const pairs = new Map();
  for (const [name, where] of used) {
    if (defined.has(name)) continue;
    const t = tail(name);
    if (!t) continue;
    for (const twin of (byTail.get(t) || [])) {
      if (twin === name) continue;
      const key = `${head(name)} → ${head(twin)}`;
      (pairs.get(key) || pairs.set(key, []).get(key)).push({ name, where: [...where] });
    }
  }

  // 한 접두사에서 여러 쌍이 나오면 가장 많이 걸린 것만 남긴다. 같은 문제를 여러 번 적지 않는다.
  const strongest = new Map();
  for (const [key, list] of pairs) {
    if (list.length < RENAME_FAMILY_MIN) continue;
    const from = key.slice(0, key.indexOf(" "));
    const prev = strongest.get(from);
    if (!prev || list.length > prev.list.length) strongest.set(from, { key, list });
  }

  const bad = [...strongest.values()].map(({ key, list }) => ({
    pair: key,
    names: [...new Set(list.map((x) => x.name))].sort(),
    where: [...new Set(list.flatMap((x) => x.where))].sort(),
  })).sort((a, b) => a.pair.localeCompare(b.pair));
  return { bad };
}

// ─── 그래프 ─────────────────────────────────────────────────────────────────

export function buildGraph() {
  const files = codeFiles();
  const known = new Set(files);
  const edges = new Map();
  for (const rel of files) edges.set(rel, edgesOf(rel, known));

  const reverse = new Map(files.map((f) => [f, []]));
  for (const [from, tos] of edges) for (const to of tos) reverse.get(to).push(from);
  for (const list of reverse.values()) list.sort();

  const derived = entryPoints(known);
  const declared = declaredEntries();

  // 문서가 적어 둔 줄 중 실물이 없는 것. 문서가 오래됐다는 뜻이다.
  const declaredMissing = [...declared.keys()].filter((f) => !known.has(f));

  const entryWhy = new Map(derived);
  for (const [f, note] of declared) if (known.has(f)) if (!entryWhy.has(f)) entryWhy.set(f, `${ENTRY_DOC}: ${note || "사람이 부름"}`);

  // 넓이 우선으로, 제품 진입점부터 먼저 걷는다. 깊이 우선에 검사 진입점이 앞에 서면
  // `--why` 가 제품 경로 대신 테스트 경로를 보여 주고, 읽는 사람이 "이건 테스트에서만
  // 쓰네" 라고 잘못 읽는다(확인 결과: native/electron/window-media.cjs 가 그랬다.
  // main.cjs 가 실제로 require 하는데도 test 경로가 나왔다).
  const isCheckEntry = (rel) => rel.startsWith("test/") || rel.startsWith("bin/smoke/");
  const queue = [...entryWhy.keys()].sort((a, b) => (isCheckEntry(a) - isCheckEntry(b)) || (a < b ? -1 : 1));
  const seen = new Set(queue);
  const parent = new Map();
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i];
    for (const t of edges.get(cur) || []) {
      if (!seen.has(t)) { seen.add(t); parent.set(t, cur); queue.push(t); }
    }
  }

  // 코드가 이미 부르고 있는데 문서가 "사람이 부른다"고 또 적어 둔 줄은 오래된 것이다.
  // 그대로 두면 이 줄이 그 파일의 실제 고아화를 가린다.
  const declaredRedundant = [...declared.keys()].filter((f) => known.has(f) && derived.has(f));

  const orphans = files.filter((f) => !seen.has(f));
  return {
    files, edges, reverse, entries: [...entryWhy.keys()].sort(), entryWhy,
    derived, declared, declaredMissing, declaredRedundant,
    reached: seen, orphans, parent,
  };
}

export function pathTo(g, rel) {
  const out = [rel];
  let cur = rel;
  while (g.parent.has(cur)) { cur = g.parent.get(cur); out.push(cur); }
  return out.reverse();
}

// ─── 명령줄 ─────────────────────────────────────────────────────────────────

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const g = buildGraph();
  const arg = process.argv[2] || "";
  const relOf = (a) => norm(path.relative(ROOT, path.resolve(a || "")).split(path.sep).join("/"));

  if (arg === "--check") {
    // 게이트. 여기서 실패하면 오래된 코드나 오래된 문서가 저장소에 있다는 뜻이다.
    //
    // 판정 용어는 smoke 와 같은 곳에서 온다. 여기서 ok/bad 를 따로 만들면
    // 두 reporter 가 같은 사실을 다른 말로 내고, 못 잰 것을 통과로
    // 내게 된다. `if (cov.skipped) ok(...)` 는 "git 을 못 불러 판정하지 않음"을 통과로
    // 센다. 못 잰 것 하나에 위반 0건은 통과가 아니라 판정 없음이다.
    //
    // 계수기가 core 의 모듈 수준에 있어서 캐시를 우회해 호출된다. 이 프로세스만의 계수기를 갖는다.
    const core = await import(pathToFileURL(path.join(ROOT, "bin/smoke/core.mjs")).href
      + "?graph=" + process.pid);
    const { check, cannotMeasure, summary } = core;

    check("코드 폴더를 다 센다", () => {
      const cov = rootsCoverage();
      if (cov.unmeasured) cannotMeasure(cov.unmeasured);
      if (cov.skipped) cannotMeasure(cov.skipped);
      if (cov.missing.length) {
        throw new Error(`셈 밖에 있는 코드: ${cov.missing.slice(0, 6).join(", ")}${cov.missing.length > 6 ? ` 외 ${cov.missing.length - 6}개` : ""}`);
      }
      return true;
    });

    check("진입점에서 안 닿는 파일이 없다", () => {
      if (g.orphans.length) throw new Error(`${g.orphans.length}개 — ${g.orphans.slice(0, 6).join(", ")}`);
      return true;
    });

    check(`${ENTRY_DOC} 의 줄에 실물이 다 있다`, () => {
      if (g.declaredMissing.length) throw new Error(`없는 것: ${g.declaredMissing.join(", ")}`);
      return true;
    });

    check(`${ENTRY_DOC} 에 군더더기 줄이 없다`, () => {
      if (g.declaredRedundant.length) throw new Error(`코드가 이미 부른다: ${g.declaredRedundant.join(", ")}`);
      return true;
    });

    check("문서가 대는 코드 경로가 실재한다", () => {
      const drift = docPathDrift();
      if (drift.unmeasured) cannotMeasure(drift.unmeasured);
      if (drift.skipped) cannotMeasure(drift.skipped);
      if (drift.bad.length) throw new Error(`${drift.bad.length}곳 — ${drift.bad.slice(0, 4).join(" / ")}`);
      return true;
    });

    check("가리키는 데가 없는 문서가 없다", () => {
      const orphan = orphanDocs();
      if (orphan.unmeasured) cannotMeasure(orphan.unmeasured);
      if (orphan.bad.length) throw new Error(`${orphan.bad.length}개 — ${orphan.bad.join(", ")}`);
      return true;
    });

    check("화면이 부르는 지면 이름이 옮기다 만 채로 남아 있지 않다", () => {
      const moved = halfMovedClassNames();
      if (moved.unmeasured) cannotMeasure(moved.unmeasured);
      if (moved.bad.length) {
        throw new Error(moved.bad.map((b) =>
          `${b.pair} ${b.names.length}개 (${b.names.slice(0, 4).join(" ")}${b.names.length > 4 ? " …" : ""}) — ${b.where.join(" ")}`).join(" / "));
      }
      return true;
    });

    check("require 로 받아 오는 이름을 그 파일이 실제로 내보낸다", () => {
      const missing = requireMismatches(g);
      if (missing.length) {
        throw new Error(`${missing.length}개 — ${missing.slice(0, 5).map((d) => `${d.file} 이 ${d.from} 에서 ${d.name}`).join(" / ")}${missing.length > 5 ? " …" : ""}`);
      }
      return true;
    });

    const dead = deadExports(g);
    const gone = dead.filter((d) => (read(d.file).match(new RegExp(`\\b${d.name}\\b`, "g")) || []).length <= 1);
    check("정의만 있고 아무도 안 부르는 export 가 없다", () => {
      if (gone.length) throw new Error(`${gone.length}개 — ${gone.slice(0, 4).map((d) => `${d.file}:${d.name}`).join(", ")}${gone.length > 4 ? " …" : ""}`);
      return true;
    });

    // 자기 파일 안에서만 쓰는데 export 로 열어 둔 것. 지금은 세기만 한다. 한 번에 닫으면
    // 작업 중인 다른 파일까지 건드리게 되고, 그 수를 줄이는 것은 별도 작업이다.
    console.log(`  note 자기 파일 안에서만 쓰는데 export 로 열린 이름 ${dead.length - gone.length}개 (node bin/graph.mjs --dead-exports)`);

    process.exit(summary());
  } else if (arg === "--json") {
    console.log(JSON.stringify({
      files: g.files,
      entries: Object.fromEntries([...g.entryWhy].sort()),
      edges: Object.fromEntries([...g.edges]),
      orphans: g.orphans,
      declaredMissing: g.declaredMissing,
      declaredRedundant: g.declaredRedundant,
    }, null, 2));
  } else if (arg === "--orphans") {
    for (const o of g.orphans) console.log(o);
    process.exit(g.orphans.length ? 1 : 0);
  } else if (arg === "--dead-exports") {
    const dead = deadExports(g);
    for (const d of dead) console.log(`${d.file}: ${d.name}   (소비자 ${d.users}개)`);
    console.log(`\n아무도 안 쓰는 export ${dead.length}개`);
    process.exit(dead.length ? 1 : 0);
  } else if (arg === "--doc-drift") {
    const drift = docPathDrift();
    for (const b of drift.bad) console.log(b);
    if (drift.skipped || drift.unmeasured) console.log(`판정하지 않음 — ${drift.skipped || drift.unmeasured}`);
    else if (drift.bad.length) console.log(`\n실물이 없는 경로 ${drift.bad.length}곳`);
    else console.log("문서가 대는 경로가 다 실재한다");
    process.exit(drift.bad.length ? 1 : 0);
  } else if (arg === "--entries") {
    for (const [f, r] of [...g.entryWhy].sort()) console.log(`${f}\n    ${r}`);
  } else if (arg === "--importers") {
    const t = relOf(process.argv[3]);
    const list = g.reverse.get(t);
    if (!list) { console.error(`그래프가 모르는 파일: ${t}`); process.exit(2); }
    console.log(list.length ? list.join("\n") : "(없음)");
  } else if (arg === "--why") {
    const t = relOf(process.argv[3]);
    if (!g.reached.has(t)) { console.log(`진입점에서 안 닿음: ${t}`); process.exit(1); }
    const chain = pathTo(g, t);
    console.log(chain.map((c, i) => `${"  ".repeat(i)}${i ? "└ " : ""}${c}${i ? "" : `   (${g.entryWhy.get(c) || "진입점"})`}`).join("\n"));
  } else {
    const edgeCount = [...g.edges.values()].reduce((n, v) => n + v.length, 0);
    console.log(`파일 ${g.files.length}개 · 간선 ${edgeCount}개 · 진입점 ${g.entries.length}개`);
    console.log(`닿는 파일 ${g.reached.size}개 · 고아 ${g.orphans.length}개`);
    if (g.orphans.length) {
      console.log("\n진입점에서 안 닿는 파일:");
      for (const o of g.orphans) console.log("  " + o);
    }
    if (g.declaredMissing.length) {
      console.log(`\n${ENTRY_DOC} 가 적어 뒀지만 실물이 없는 것:`);
      for (const f of g.declaredMissing) console.log("  " + f);
    }
    if (g.declaredRedundant.length) {
      console.log(`\n코드가 이미 부르는데 ${ENTRY_DOC} 가 또 적어 둔 것 (그 줄은 낡았다):`);
      for (const f of g.declaredRedundant) console.log("  " + f);
    }
  }
}
