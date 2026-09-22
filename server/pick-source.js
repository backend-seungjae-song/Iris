// 요소 지목 → 소스 코드 위치. 화면에서 지목한 요소를 파일:라인으로 변환한다.
//
// 배경
//   지목 블록이 선택자·HTML 만 전달하면 받는 쪽이 매번 grep 을 다시 실행해야 한다. 로컬에서
//   실행되는 페이지의 코드는 정적이므로, 그 검색은 앱이 지목 시점에 한 번만 수행하면 된다.
//   프레임워크 메타데이터(React `_debugSource` · Vue `__file`)에는 의존하지 않는다. 정적 HTML
//   에는 그 값이 없고, React 19 는 `_debugSource` 를 제거했다.
//
// 소유 범위
//   주소 → 루트 폴더 판정(포트 → 리스닝 프로세스 → cwd)과 그 루트 안의 시그니처 검색.
//   블록 문구는 소유하지 않는다. 이 파일은 결과만 반환하고 문구는 web/js/browser/pick.js 가 만든다.
//
// 제공 API
//   resolvePickSource(pick) → { root, port, host, markup, style, script, sig, why }
//
// 의존 대상
//   lsof(포트→pid→cwd)와 ~/localdev/dashboard/status.json(*.test→포트). 둘 다 없으면 빈 결과를
//   반환하며, 지목 자체를 막지 않는다.
//
// 유지 조건
//   로컬 오리진만 본다. 원격 주소로는 이 파일이 아무 파일도 읽지 않는다.
//   돌려주는 것은 경로와 줄 번호뿐이고 파일 내용은 싣지 않는다.
//   실패는 전부 빈 결과이며 예외를 던지지 않는다. 소스를 찾지 못해도 지목은 막히지 않아야 한다.
//
// 영향 범위
//   server/http-handler.js 의 POST /pick-source, web/js/browser/pick.js 의 소스 줄 조립,
//   bin/smoke/sections/pick-source.mjs.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "[::1]"]);
const LOCAL_TLD = /\.(test|local|localhost)$/i;

// 검색할 파일 종류. 여기 없는 확장자는 열지 않는다. 이미지·잠금파일·빌드 산출물을 읽느라
// 응답이 늦어지지 않아야 한다.
const STYLE_EXT = new Set([".css", ".scss", ".sass", ".less", ".styl"]);
const MARKUP_EXT = new Set([".html", ".htm", ".vue", ".svelte", ".astro", ".php", ".erb", ".hbs", ".ejs", ".twig", ".liquid", ".jsx", ".tsx"]);
const SCRIPT_EXT = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".jsx", ".tsx", ".vue", ".svelte"]);
// 열지 않을 것만 지정한다. 화면을 만드는 언어는 허용 목록 밖에도 있다. 확인 결과: 파이썬
// 파일이 HTML 과 CSS 를 생성하는 화면에서는 아무것도 찾지 못했다. 허용 목록은 생산자와
// 일치하지 않게 되므로, 텍스트가 아닌 파일과 빌드 산출물만 제외한다.
const SKIP_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico", ".icns", ".svgz",
  ".mp4", ".mov", ".webm", ".mp3", ".wav", ".ogg", ".m4a", ".pdf",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".dmg", ".pkg", ".asar",
  ".node", ".wasm", ".so", ".dylib", ".dll", ".exe", ".bin", ".class", ".o", ".a",
  ".db", ".sqlite", ".sqlite3", ".lock", ".map", ".pyc", ".pyo",
]);
// 이름으로 제외하는 파일. 수동 사본과 번들 산출물은 수정해도 화면에 반영되지 않는다.
const SKIP_NAME = /(^|\.)(min\.(js|css)|bundle\.(js|css))$|\.bak(-|$)|~$|\.orig$|\.rej$|^package-lock\.json$|^pnpm-lock\.yaml$|^yarn\.lock$/;
const readable = (name) => !SKIP_EXT.has(path.extname(name).toLowerCase()) && !SKIP_NAME.test(name);

// 검색하지 않는 폴더. 빌드 산출물 안의 줄을 알려주면, 수정해도 다음 빌드에서 사라지는
// 위치를 가리키게 된다.
const SKIP_DIR = new Set([
  "node_modules", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit", ".output",
  "coverage", "vendor", "target", "__pycache__", ".venv", "venv", "tmp", ".cache",
]);

const MAX_FILES = 4000;        // 이 이상은 검색하지 않는다. 사용자가 응답을 기다리는 경로다
const MAX_BYTES = 2 * 1024 * 1024;
const LONG_LINE = 200;
const MAX_HITS = 60;           // 이보다 흔한 시그니처는 그 요소를 특정하지 못한다
const WALK_MS = 1500;

const rootCache = new Map();   // port → { root, at }
const ROOT_TTL = 30_000;       // dev 서버는 자주 다시 뜬다

function sh(cmd, args, ms = 1200) {
  return new Promise((resolve) => {
    let done = false;
    const p = execFile(cmd, args, { timeout: ms, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (done) return; done = true;
      resolve(err && !stdout ? "" : String(stdout || ""));
    });
    p.on("error", () => { if (!done) { done = true; resolve(""); } });
  });
}

// *.test 는 caddy 를 거쳐 127.0.0.1:<포트> 로 간다. 그 표는 localdev 대시보드가 파일로 적어 둔다.
function localdevPort(host) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), "localdev", "dashboard", "status.json"), "utf8"));
    const name = String(host).replace(LOCAL_TLD, "");
    const hit = (j.routes || []).find((r) => r && String(r.name) === name);
    return hit && hit.port ? Number(hit.port) : null;
  } catch { return null; }
}

// 그 포트를 리스닝 중인 프로세스의 작업 폴더. dev 서버는 대개 프로젝트 루트에서 실행되므로 이것을 루트로 본다.
async function rootForPort(port) {
  const hit = rootCache.get(port);
  if (hit && Date.now() - hit.at < ROOT_TTL) return hit.root;
  let root = null;
  const pids = (await sh("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"])).split("\n").map((s) => s.trim()).filter(Boolean);
  for (const pid of pids.slice(0, 3)) {
    const out = await sh("lsof", ["-a", "-p", pid, "-d", "cwd", "-Fn"]);
    const line = out.split("\n").find((l) => l.startsWith("n/"));
    if (!line) continue;
    const dir = line.slice(1);
    try { if (fs.statSync(dir).isDirectory()) { root = dir; break; } } catch {}
  }
  rootCache.set(port, { root, at: Date.now() });
  return root;
}

// 설치된 앱·컨테이너·dist 처럼 소스를 복사해 실행하는 경우가 있다. 그 폴더의 파일을 알려주면
// 받은 쪽이 사본을 수정하게 되고, 다음 설치에서 수정이 사라진다(확인 결과: 4271 의 지목이
// /Applications/Iris.app/…/app.asar.unpacked 를 가리켰다). 사본의 출처는 사본을 만든 쪽만
// 알 수 있으므로, 만드는 쪽이 .source-root 를 남기고 여기서는 그 값만 읽는다. 추정하지 않는다.
export function sourceRootOf(dir) {
  try {
    const named = fs.readFileSync(path.join(dir, ".source-root"), "utf8").trim().split("\n")[0].trim();
    if (!named || !path.isAbsolute(named) || named === dir) return null;
    return fs.statSync(named).isDirectory() ? named : null;
  } catch { return null; }
}

export async function rootForUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { return { root: null, local: false, why: "주소를 읽지 못함" }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { root: null, local: false, why: "웹 주소가 아님" };
  const host = u.hostname;
  const isLocal = LOCAL_HOSTS.has(host) || LOCAL_TLD.test(host);
  if (!isLocal) return { root: null, local: false, why: "원격 주소 — 이 기계에 소스가 없음" };
  let port = u.port ? Number(u.port) : null;
  if (!port && LOCAL_TLD.test(host)) port = localdevPort(host);
  if (!port) port = u.protocol === "https:" ? 443 : 80;
  const root = await rootForPort(port);
  if (!root) return { root: null, local: true, port, host, why: "그 포트를 듣는 프로세스가 없음 (서버가 이미 끝났을 수 있음)" };
  const from = sourceRootOf(root);
  return { root: from || root, copy: from ? root : null, local: true, port, host, why: null };
}

// 지목한 요소를 소스에서 찾기 위한 시그니처 목록. 앞에서부터 시도하고, 요소 하나를 특정하는
// 값이 나오면 멈춘다. 흔한 값(짧은 클래스 등)일수록 결과가 넓어지므로 순서가 정확도를 정한다.
// 지목한 조각의 HTML 에서 사람이 읽는 속성값을 뽑고, 자기 자신뿐 아니라 자식 요소도 확인한다.
// 특정에 쓸 이름은 대개 안쪽 버튼에 있다. 값이 그대로 나오는 순서로 반환하며, 흔한지 여부는
// 검색 건수로 판정한다.
export function htmlAttrValues(html) {
  const out = [];
  const re = /\b(?:title|aria-label|placeholder|alt|label)\s*=\s*"([^"]{3,60})"/g;
  let m;
  while ((m = re.exec(String(html || ""))) && out.length < 6) out.push(m[1]);
  return out;
}
export function signatures(pick) {
  const p = pick || {};
  const out = [], seen = new Set();
  const push = (kind, v) => {
    const s = String(v == null ? "" : v).trim();
    if (!s || s.length < 3 || s.includes("…") || s.includes("REDACTED")) return;
    if (seen.has(s)) return;
    seen.add(s); out.push({ kind, v: s });
  };
  const attr = (name) => {
    const a = (p.attrs || []).find((x) => typeof x === "string" && x.startsWith(name + '="'));
    return a ? a.slice(name.length + 2, -1) : null;
  };
  // 사람이 손으로 지은 id 만 쓸모가 있다. 런타임이 지어낸 것(`:r3:` · `radix-…` · 긴 숫자)은
  // 소스 어디에도 없는 글자라 검색이 늘 0건으로 끝난다.
  const generated = (s) => /^[:_]/.test(s) || /^(radix|headlessui|mui|mantine|chakra|react-aria)-/i.test(s) || /\d{5,}/.test(s);
  const rawId = p.id || attr("id");
  if (rawId && !generated(rawId)) push("id", rawId);
  push("testid", attr("data-testid") || attr("data-test") || attr("data-cy"));
  push("name", attr("name"));
  push("for", attr("for"));
  const ph = attr("placeholder"); if (ph && ph.length >= 4) push("placeholder", ph);
  // 요소 자신의 속성만으로는 검색어를 만들 수 없는 경우가 있다. 클래스 하나뿐인 요소는 그 이름이
  // 저장소에 수천 번 나와 후보에서 제외되고, 결과가 루트 폴더만 남는다.
  // 사람이 읽으라고 적은 짧은 문구(하위 버튼의 title 등)는 소스에 그대로 있고 중복이 적으므로,
  // 자기 속성만이 아니라 하위 요소의 속성값까지 수집한다.
  // 여기에 실제 문구를 예시로 적지 않는다. 적으면 그 요소를 고를 때마다 이 파일이 검색에 걸린다.
  for (const v of htmlAttrValues(p.html)) push("attr", v);
  if (p.src && p.src.component) push("component", p.src.component);
  // 클래스는 길이로 거르지 않는다. 짧은 이름이라고 흔한 것은 아니다. `srow` 는 이 저장소에서 한
  // 요소만 가리키는 이름인데, 길이 6 미만을 제외하자 그 요소의 답이 루트 폴더만 남았다.
  // 흔한 이름인지는 길이가 아니라 검색 건수로 판정하며, 그 판정은 아래 MAX_HITS 가 한다.
  for (const c of (p.cls || []).filter((c) => typeof c === "string" && c.length >= 3).slice(0, 4)) {
    if (!generated(c) && !/^(is|has|js)-/.test(c)) push("class", c);
  }
  const t = String(p.text || "").trim();
  if (t.length >= 4 && t.length <= 40) push("text", t);
  return out;
}

function bucketFor(ext, line, at) {
  if (STYLE_EXT.has(ext)) return "style";
  if (MARKUP_EXT.has(ext)) {
    const before = line.slice(0, at);
    // 시그니처 앞에 닫히지 않은 여는 태그가 있으면 그 위치는 마크업이다.
    if (/<[a-zA-Z][^<>]*$/.test(before)) return "markup";
    if (/\b(id|class|className|name|placeholder|for|data-[\w-]+)\s*=/.test(line)) return "markup";
    return SCRIPT_EXT.has(ext) ? "script" : "markup";
  }
  if (SCRIPT_EXT.has(ext)) return "script";
  // 모르는 확장자도 버리지 않는다. 버리면 파이썬이 생성하는 화면이 전부 결과에서 빠진다.
  // 줄의 내용으로 분류한다. 여는 태그나 속성 위치면 마크업, CSS 규칙 선언부면 스타일, 나머지는 동작.
  const before = line.slice(0, at);
  if (/<[a-zA-Z][^<>]*$/.test(before)) return "markup";
  if (/\b(id|class|className)\s*=\s*["'`]/.test(line)) return "markup";
  if (/^\s*[#.][\w-]/.test(line) || /[{;]\s*$/.test(line) && /^\s*[.#&]/.test(line)) return "style";
  return "script";
}

// 루트 아래를 한 번 순회하며 그 단어가 든 줄을 모은다. rg 가 없는 기기가 있어 직접 순회하되,
// 대상·크기·시간·건수에 상한을 두어 대기 시간을 제한한다.
// 이름을 찾을 때는 단어 경계를 지킨다. `cap` 을 부분문자열로 찾으면 `capability`·`capture`
// 까지 걸려 2055건이 나오고, 그 건수 때문에 흔한 이름으로 판정되어 전부 버려진다. 확인 결과
// 그 클래스를 정의하는 CSS 규칙은 149건 안에 있었다. 사람이 읽는 문구(빈칸·한글)에는
// 단어 경계를 적용하지 않는다. 그런 문구에는 단어 경계가 없다.
const IDENT = /^[A-Za-z0-9_-]+$/;
const identChar = (c) => c !== undefined && /[A-Za-z0-9_$-]/.test(c);
function findAt(line, needle, from, word) {
  for (let at = line.indexOf(needle, from); at >= 0; at = line.indexOf(needle, at + 1)) {
    if (!word) return at;
    if (!identChar(line[at - 1]) && !identChar(line[at + needle.length])) return at;
  }
  return -1;
}

// 고른 요소가 어디에 놓여 있고 무엇을 품고 있는지. 선택자의 조상 클래스와 HTML 안쪽 자식
// 클래스를 모은다. 같은 이름의 규칙이 여러 화면에 있을 때 어느 화면인지 구분하는 근거가 된다.
// 확인 결과: `.ghead` 가 두 화면에 있었고 줄 번호가 앞선 다른 화면의 규칙이 답으로 나갔다.
export function contextWords(pick) {
  const p = pick || {};
  const out = new Set();
  const own = new Set((p.cls || []).map(String));
  for (const src of [p.usel, p.selector]) {
    for (const m of String(src || "").matchAll(/\.([A-Za-z][A-Za-z0-9_-]{2,})/g)) {
      if (!own.has(m[1])) out.add(m[1]);
    }
  }
  for (const m of String(p.html || "").matchAll(/\bclass\s*=\s*"([^"]{1,120})"/g)) {
    for (const c of m[1].split(/\s+/)) if (c.length >= 3 && !own.has(c)) out.add(c);
  }
  return [...out].slice(0, 8);
}

export function scanRoot(root, needle, ctx = []) {
  const word = IDENT.test(needle);
  const hits = [];
  const started = Date.now();
  let files = 0, truncated = false;
  const stack = [root];
  while (stack.length) {
    if (files >= MAX_FILES || hits.length >= MAX_HITS || Date.now() - started > WALK_MS) { truncated = true; break; }
    const dir = stack.pop();
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const name = e.name;
      if (name.startsWith(".")) continue;
      const full = path.join(dir, name);
      if (e.isDirectory()) { if (!SKIP_DIR.has(name)) stack.push(full); continue; }
      if (!e.isFile()) continue;
      const ext = path.extname(name).toLowerCase();
      if (!readable(name)) continue;
      files++;
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.size > MAX_BYTES) continue;
      let text;
      try { text = fs.readFileSync(full, "utf8"); } catch { continue; }
      if (!text.includes(needle)) continue;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const at = findAt(lines[i], needle, 0, word);
        if (at < 0) continue;
        const bucket = bucketFor(ext, lines[i], at);
        if (!bucket) continue;
        const exact = exactness(lines[i], needle, at);
        // 이름 후보는 그 이름을 정의하는 위치만 센다. 따옴표 안, 속성값, 선택자 선두가 해당한다.
        // 언급만 한 줄까지 세면 흔한 이름이 상한을 넘어 전부 버려지고, 그 이름을 정의하는 줄도
        // 함께 빠진다(확인 결과: `.cap` 이 그랬다). 사람이 읽는 문구에는 이 문턱을 적용하지
        // 않는다. 그런 문구는 어디에 나오든 그 위치가 단서다.
        if (word && exact < 2) continue;
        let ctxHit = 0;
        for (const w of ctx) if (findAt(lines[i], w, 0, true) >= 0) ctxHit++;
        // 생성기가 만든 화면은 CSS·JS 를 한 줄에 담는다. 확인 결과 그 줄이 7413자였고
        // 그 화면의 모든 요소가 같은 줄 번호를 답으로 받아, 파일을 열고 다시 찾아야 했다.
        // 그런 줄에만 칸 번호를 붙인다. 짧은 줄에 붙이면 읽을 정보만 늘어난다.
        const col = lines[i].length > LONG_LINE ? at + 1 : null;
        hits.push({ file: path.relative(root, full), line: i + 1, col, bucket, exact, near: 0, ctx: ctxHit });
        if (hits.length >= MAX_HITS) break;
      }
      if (hits.length >= MAX_HITS) break;
    }
  }
  return { hits, truncated };
}

// 같은 단어가 여러 줄에 있으면 선언한 줄을 먼저 보여준다. 속성값으로 그대로 적힌 것이 가장
// 확실하고, 문장 중간에 우연히 포함된 것이 가장 불확실하다.
export function exactnessOf(line, needle) {
  const at = line.indexOf(needle);
  return at < 0 ? 0 : exactness(line, needle, at);
}
function exactness(line, needle, at) {
  const q = line[at - 1], qe = line[at + needle.length];
  const quoted = (q === '"' || q === "'" || q === "`") && q === qe;
  const attrHead = /\b(id|class|className|name|placeholder|for|data-[\w-]+)\s*=\s*["'`]?$/.test(line.slice(0, at));
  const selHead = /[#.]$/.test(line.slice(0, at));
  let s = 0;
  if (quoted) s += 2;
  if (attrHead) s += 3;
  if (selHead) s += 2;
  if (/^\s*[#.][\w-]/.test(line)) s += 1;   // CSS 규칙 머리
  // 주석에 이름이 나와도 그 줄이 요소를 정의하는 줄은 아니다. 확인 결과 `.cap` 의 답으로
  // CSS 주석 한 줄이 나갔고, 그 클래스를 정의하는 규칙은 다른 줄에 있었다.
  // 제외하지는 않는다. 코드에 한 줄도 없을 때는 주석이라도 단서가 된다.
  if (/^\s*(\/\/|\/\*|\*|#\s)/.test(line)) s -= 4;
  return s;
}

// 요소를 정의하는 줄이 아니라 그것을 흉내 내거나(검사 코드) 언급하는(문서·데이터) 줄이 있다.
// 확인 결과 어느 요소의 동작 답으로 검사 파일 한 줄이 나가고 정의하는 줄은 빠졌다.
// 제외하지 않고 순위만 낮춘다. 정의하는 줄이 없을 때는 이 줄이 어디를 볼지 알려 준다.
// 분류 라벨도 함께 정한다. 검사 파일을 "동작" 으로 적으면 받는 쪽이 그 줄을 요소의 동작으로
// 읽기 때문이다.
const TEST_PATH = /(^|\/)(tests?|__tests__|__mocks__|specs?|smoke|e2e|fixtures?)(\/|$)|\.(test|spec)\.[a-z]+$/i;
const WORD_PATH = /(^|\/)docs?(\/|$)/i;
const WORD_EXT = new Set([".md", ".markdown", ".mdx", ".txt", ".rst", ".log", ".csv", ".tsv", ".json", ".yml", ".yaml", ".toml"]);
export const sideline = (file) => (TEST_PATH.test(file) ? "검사"
  : (WORD_PATH.test(file) || WORD_EXT.has(path.extname(file).toLowerCase()) ? "글" : null));

const byRank = (a, b) => (a.pen || 0) - (b.pen || 0)
  || (b.exact + b.near + 2 * (b.ctx || 0)) - (a.exact + a.near + 2 * (a.ctx || 0))
  || a.file.localeCompare(b.file) || a.line - b.line;

// 주소가 이미 어느 폴더의 화면인지 말하고 있다. /board/ 를 보고 있었으면 board/ 아래에서 찾은 줄이
// 같은 이름을 가진 다른 화면보다 앞선다. 한 루트에 화면이 여럿이면 이 조건이 순위를 가른다.
function urlSegments(url) {
  try {
    const segs = new URL(String(url)).pathname.split("/").filter(Boolean);
    if (segs.length && /\.[a-z0-9]+$/i.test(segs[segs.length - 1])) segs.pop();
    return segs;
  } catch { return []; }
}
function nearness(file, segs) {
  if (!segs.length) return 0;
  const parts = file.split("/");
  let n = 0;
  for (const s of segs) if (parts.includes(s)) n += 2;
  return n;
}

export async function resolvePickSource(pick, opts = {}) {
  const empty = { root: null, copy: null, local: false, port: null, host: null, markup: [], style: [], script: [], sig: null, why: null };
  const r = await rootForUrl((pick && pick.pageUrl) || (pick && pick.url) || opts.url || "");
  if (!r.root) return { ...empty, why: r.why, local: !!r.local, port: r.port || null, host: r.host || null };
  const segs = urlSegments((pick && pick.pageUrl) || (pick && pick.url) || opts.url || "");
  const ctx = contextWords(pick);
  const sigs = signatures(pick);
  if (!sigs.length) return { ...empty, root: r.root, copy: r.copy || null, local: true, port: r.port, host: r.host, why: "소스에서 찾을 만한 이름이 요소에 없음" };
  for (const sig of sigs) {
    const { hits, truncated } = scanRoot(r.root, sig.v, ctx);
    if (!hits.length) continue;
    if (hits.length >= MAX_HITS && truncated) continue;   // 너무 흔한 말이면 다음 후보로 넘어간다
    for (const h of hits) { h.near = nearness(h.file, segs); h.side = sideline(h.file); h.pen = h.side ? 1 : 0; }
    const of = (b) => hits.filter((h) => h.bucket === b).sort(byRank);
    const markup = of("markup").slice(0, 3);
    const style = of("style").slice(0, 3);
    const script = of("script").slice(0, 3);
    if (!markup.length && !style.length && !script.length) continue;
    return { root: r.root, copy: r.copy || null, local: true, port: r.port, host: r.host, markup, style, script, sig, why: null };
  }
  return { ...empty, root: r.root, copy: r.copy || null, local: true, port: r.port, host: r.host, why: "이 폴더에서 이 요소를 못 찾음" };
}
