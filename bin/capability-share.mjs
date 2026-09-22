#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// 기능 id 규칙은 상태 계약의 정본을 그대로 쓴다.
const { FEATURE_ID } = createRequire(import.meta.url)("../server/feature-state-read.cjs");

const RENDERER = "web/js/core/capabilities.js";
const SERVER = "server/capabilities.js";
const RAIL = "web/js/core/rail-items.js";
const digest = (body) => createHash("sha256").update(body).digest("hex");
const fail = (message) => { throw new Error(message); };
const git = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
const read = (root, file) => readFileSync(path.join(root, file), "utf8");
const json = (root, file) => JSON.parse(read(root, file));
const unique = (values) => [...new Set(values)].sort();

function safePath(file) {
  if (typeof file !== "string" || !file || file.startsWith("/") || file.includes("\\") || /[\x00-\x1f]/.test(file)
      || file.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git") || /^[A-Za-z]:/.test(file)) fail(`안전하지 않은 파일 경로: ${file}`);
  return file;
}

function privatePaths(patch, root) {
  if (patch.includes(root) || /\/(?:Users|home)\/[^\s/"'<>]+|[A-Za-z]:[\\/]Users[\\/]/.test(patch)) fail("패치에 작성자 절대 경로가 있습니다");
}

// 표를 import 하면 서버의 초기화 부작용까지 실행할 수 있어 선언의 리터럴만 읽는다.
function tokens(source) {
  const out = [];
  const pattern = /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|[^\s]/gy;
  let match;
  while ((match = pattern.exec(source))) {
    const raw = match[0];
    if (/^\s|^\/\//.test(raw) || raw.startsWith("/*")) continue;
    if (raw[0] === '"' || raw[0] === "'") {
      const value = raw.slice(1, -1).replace(/\\(['"\\])/g, "$1");
      out.push({ raw, value, string: true });
    } else out.push({ raw, value: raw });
  }
  return out;
}

function endOf(ts, start) {
  const closer = { "[": "]", "{": "}", "(": ")" }[ts[start]?.raw];
  if (!closer) return start;
  for (let i = start + 1; i < ts.length; i++) {
    if (ts[i].raw === closer) return i;
    if (["[", "{", "("].includes(ts[i].raw)) i = endOf(ts, i);
  }
  fail("등록표 괄호를 읽을 수 없습니다");
}

function properties(ts) {
  const props = new Map();
  for (let i = 1; i < ts.length - 1; i++) {
    if ((i === 1 || ts[i - 1].raw === ",") && ts[i + 1]?.raw === ":") {
      const key = ts[i].value;
      const start = i + 2;
      i = start;
      while (i < ts.length - 1 && ts[i].raw !== ",") {
        if (["[", "{", "("].includes(ts[i].raw)) i = endOf(ts, i);
        i++;
      }
      props.set(key, ts.slice(start, i));
      i--;
    } else if (["[", "{", "("].includes(ts[i].raw)) i = endOf(ts, i);
  }
  return props;
}

function literal(ts, label) {
  if (!ts) return undefined;
  if (ts.length === 1 && ts[0].string) return ts[0].value;
  if (ts.length === 1 && ["true", "false", "null"].includes(ts[0].raw)) return JSON.parse(ts[0].raw);
  if (ts[0]?.raw === "[" && endOf(ts, 0) === ts.length - 1) {
    const values = [];
    for (let i = 1; i < ts.length - 1; i++) {
      if (ts[i].raw === ",") continue;
      const end = endOf(ts, i);
      values.push(literal(ts.slice(i, end + 1), label));
      i = end;
    }
    return values;
  }
  fail(`${label}: 문자열·배열 리터럴 선언이 필요합니다`);
}

function table(root, file, name, overrides = new Map()) {
  const ts = tokens(overrides.has(file) ? overrides.get(file) : read(root, file));
  const at = ts.findIndex((t, i) => t.raw === name && ts[i + 1]?.raw === "=" && ts[i + 2]?.raw === "[");
  if (at < 0) fail(`${file}: ${name} 배열 선언을 찾을 수 없습니다`);
  const rows = [];
  const last = endOf(ts, at + 2);
  for (let i = at + 3; i < last; i++) {
    if (ts[i].raw === ",") continue;
    if (ts[i].raw !== "{") fail(`${file}: 행은 객체 리터럴이어야 합니다`);
    const end = endOf(ts, i);
    const props = properties(ts.slice(i, end + 1));
    const row = {};
    for (const key of ["id", "rail", "css", "routes", "files", "server", "wsPrefixes"]) {
      if (props.has(key)) row[key] = literal(props.get(key), `${file} ${key}`);
    }
    if (props.has("http")) {
      const http = props.get("http");
      if (http[0]?.raw !== "[") fail(`${file}: http 배열 리터럴이 필요합니다`);
      row.http = [];
      for (let j = 1; j < http.length - 1; j++) {
        if (http[j].raw === ",") continue;
        if (http[j].raw !== "{") fail(`${file}: http 경로 객체 리터럴이 필요합니다`);
        const finish = endOf(http, j);
        const route = properties(http.slice(j, finish + 1));
        const url = literal(route.get("path"), `${file} http.path`);
        if (!url) fail(`${file}: http.path 선언이 필요합니다`);
        row.http.push(url + (literal(route.get("prefix"), `${file} http.prefix`) === true ? "*" : ""));
        j = finish;
      }
    }
    if (typeof row.id !== "string") fail(`${file}: id 문자열 선언이 필요합니다`);
    rows.push(row);
    i = end;
  }
  return rows;
}

function registry(root, overrides = new Map()) {
  const renderer = table(root, RENDERER, "CAPABILITIES", overrides);
  const server = table(root, SERVER, "capabilities", overrides);
  const rail = table(root, RAIL, "RAIL_ITEMS", overrides);
  for (const row of renderer) {
    const inferred = [];
    for (const file of row.files || []) {
      const owned = safePath(`web/js/${file}`);
      const ts = tokens(overrides.has(owned) ? overrides.get(owned) : read(root, owned));
      for (let i = 0; i < ts.length; i++) {
        // WS 처리기 키와 전송 type 리터럴만 후보로 삼는다. 계산한 이름은 명시 선언이 필요하다.
        if ((ts[i].string && ts[i + 1]?.raw === ":") || (ts[i - 1]?.raw === ":" && ts[i - 2]?.raw === "type")) {
          const prefix = ts[i].value.match(/^([a-z][\w]*[.-])/i)?.[1];
          if (prefix) inferred.push(prefix);
        }
      }
    }
    row.wsPrefixes = unique([...(row.wsPrefixes || []), ...inferred]);
  }
  return { renderer, server, rail };
}

function declarations(rows, id) {
  const selected = [...rows.renderer, ...rows.server].filter((row) => row.id === id);
  if (!selected.length) fail(`등록표에 없는 기능 id: ${id}`);
  return {
    railIds: unique(selected.flatMap((row) => row.rail ? [row.rail] : [])),
    cssFiles: unique(selected.flatMap((row) => (row.css || []).map((css) => css.startsWith("web/") ? css : `web/css/${css}`))),
    wsPrefixes: unique(selected.flatMap((row) => row.wsPrefixes || [])),
    httpPaths: unique(selected.flatMap((row) => [...(row.routes || []), ...(row.http || [])])),
  };
}

export function capabilityDeclarations(root, id) {
  return declarations(registry(root), id);
}

function settingsKeys(root, rows, id, files) {
  const selected = [...rows.renderer, ...rows.server].filter((row) => row.id === id);
  const owned = new Set(selected.flatMap((row) => [...(row.files || []).map((file) => `web/js/${file}`), ...(row.server || [])]));
  const keys = [];
  for (const file of files.filter((entry) => entry.status !== "D" && owned.has(entry.path))) {
    const ts = tokens(read(root, file.path));
    for (let i = 0; i < ts.length; i++) {
      if (["localStorage", "sessionStorage"].includes(ts[i].raw) && ts[i + 1]?.raw === "."
          && ["getItem", "setItem"].includes(ts[i + 2]?.raw) && ts[i + 3]?.raw === "(" && ts[i + 4]?.string) keys.push(ts[i + 4].value);
      if (ts[i].raw === "process" && ts[i + 1]?.raw === "." && ts[i + 2]?.raw === "env") {
        if (ts[i + 3]?.raw === "." && /^[A-Za-z_$][\w$]*$/.test(ts[i + 4]?.raw || "")) keys.push(ts[i + 4].value);
        if (ts[i + 3]?.raw === "[" && ts[i + 4]?.string && ts[i + 5]?.raw === "]") keys.push(ts[i + 4].value);
      }
    }
  }
  return unique(keys);
}

function changes(root, base) {
  const parts = git(root, ["diff", "--name-status", "-z", "--no-renames", base, "--"]).split("\0");
  const files = [];
  for (let i = 0; i < parts.length - 1; i += 2) {
    const status = parts[i], file = safePath(parts[i + 1]);
    if (!["A", "M", "D"].includes(status)) fail(`지원하지 않는 변경: ${status} ${file}`);
    files.push({ path: file, status, sha256: status === "D" ? null : digest(readFileSync(path.join(root, file))) });
  }
  return files;
}

function sections(patch) {
  if (/^GIT binary patch$|^(?:new|old|deleted) file mode 120000$|^index .* 120000$/m.test(patch)) fail("바이너리·심볼릭 링크 패치는 지원하지 않습니다");
  return patch.split(/(?=^diff --git )/m).filter(Boolean).map((body) => {
    const header = body.match(/^diff --git a\/(.+) b\/\1\n/);
    if (!header) fail("패치 경로를 읽을 수 없습니다: rename·인용 경로는 지원하지 않습니다");
    const file = safePath(header[1]);
    const status = /^new file mode /m.test(body) ? "A" : /^deleted file mode /m.test(body) ? "D" : "M";
    if (/^(?:---|\+\+\+) /m.test(body)) {
      const expected = [`--- ${status === "A" ? "/dev/null" : `a/${file}`}`, `+++ ${status === "D" ? "/dev/null" : `b/${file}`}`];
      for (const line of body.split(/^@@/m)[0].split("\n").filter((line) => /^(---|\+\+\+) /.test(line))) if (!expected.includes(line)) fail(`패치 헤더 경로 불일치: ${file}`);
    }
    return { body, path: file, status };
  });
}

// 작업 트리나 index 에 적용하지 않고 본문에 hunk 를 대어 파일 해시를 확인한다. 만드는 쪽은 base 본문에,
// 받는 쪽은 자기 작업 트리 본문에 댄다. 그래야 hunk 밖이 달라 결과가 작성자와 달라지는 것까지 잡는다.
function resultBody(root, base, section, { fromWorktree = false } = {}) {
  const before = section.status === "A" ? ""
    : fromWorktree ? readFileSync(path.join(root, section.path), "utf8") : git(root, ["show", `${base}:${section.path}`]);
  const lines = before.match(/[^\n]*\n|[^\n]+$/g) || [];
  const output = [];
  const patchLines = section.body.split("\n");
  let cursor = 0;
  for (let i = 0; i < patchLines.length; i++) {
    const hunk = patchLines[i].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!hunk) continue;
    const start = Number(hunk[1]) - (Number(hunk[2] ?? 1) ? 1 : 0);
    if (start < cursor) fail(`겹치는 패치 hunk: ${section.path}`);
    output.push(...lines.slice(cursor, start));
    cursor = start;
    let removed = 0, added = 0;
    for (i++; i < patchLines.length; i++) {
      const line = patchLines[i];
      if (!/^[ +\-]/.test(line)) { i--; break; }
      let value = line.slice(1) + "\n";
      if (patchLines[i + 1] === "\\ No newline at end of file") { value = value.slice(0, -1); i++; }
      if (line[0] !== "+") {
        if (lines[cursor] !== value) fail(`base 본문과 패치 불일치: ${section.path}`);
        cursor++; removed++;
      }
      if (line[0] !== "-") { output.push(value); added++; }
    }
    if (removed !== Number(hunk[2] ?? 1) || added !== Number(hunk[4] ?? 1)) fail(`패치 hunk 길이 불일치: ${section.path}`);
  }
  output.push(...lines.slice(cursor));
  return output.join("");
}

export function createManifest(root, { id, base, out }) {
  if (!FEATURE_ID.test(id || "")) fail("--id 는 상태 계약이 받는 기능 이름이어야 합니다(소문자로 시작, 소문자·숫자·_·-)");
  const commit = git(root, ["rev-parse", "--verify", `${base}^{commit}`]).trim();
  if (spawnSync("git", ["merge-base", "--is-ancestor", commit, "HEAD"], { cwd: root }).status !== 0) fail("base 가 HEAD 의 조상이 아닙니다");
  const patch = git(root, ["diff", "--binary", "--full-index", "--no-renames", commit, "--"]);
  privatePaths(patch, root);
  const parts = sections(patch);
  if (!parts.length) fail("공유할 변경이 없습니다. 새 파일은 git add -N 으로 목록에 넣으세요");
  const pkg = json(root, "package.json");
  const prior = JSON.parse(git(root, ["show", `${commit}:package.json`]));
  const dependencies = {};
  for (const group of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const changed = Object.entries(pkg[group] || {}).filter(([key, value]) => prior[group]?.[key] !== value);
    if (changed.length) dependencies[group] = Object.fromEntries(changed);
  }
  const rows = registry(root), files = changes(root, commit);
  const manifest = {
    version: 1, id, base: commit, irisVersion: prior.version,
    node: { version: process.versions.node, major: Number(process.versions.node.split(".")[0]), required: pkg.engines?.node || null },
    dependencies, settingsKeys: settingsKeys(root, rows, id, files),
    files, declarations: declarations(rows, id),
    patch: { file: `${id}.patch`, sha256: digest(patch) },
  };
  for (const part of parts) {
    const file = manifest.files.find((entry) => entry.path === part.path);
    const body = resultBody(root, commit, part);
    if (!file || (part.status !== "D" && digest(body) !== file.sha256)) fail(`UTF-8 텍스트 패치로 검증할 수 없는 파일: ${part.path}`);
  }
  const destination = path.resolve(root, out || `capability-share-${id}`);
  if (existsSync(destination)) fail(`출력 경로가 이미 있습니다: ${destination}`);
  mkdirSync(destination, { recursive: true });
  writeFileSync(path.join(destination, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(path.join(destination, manifest.patch.file), patch);
  writeFileSync(path.join(destination, "README.md"), [
    `# ${id}`, "",
    "받는 쪽이 이 파일만 보고 적용·실행·끄기까지 할 수 있게 적습니다. `<보내는 쪽: …>` 은 보내기 전에 채우고, `<받는 쪽: …>` 은 받는 사람이 자기 값으로 바꿉니다.", "",
    "## 무엇인가", "", "<보내는 쪽: 이 기능이 하는 일, 화면 위치, 쓰는 외부 서비스 한 문단>", "",
    "## 지원 대상", "",
    `- 기준 커밋 ${manifest.base} · Iris ${manifest.irisVersion} · Node ${manifest.node.version} (주 버전 ${manifest.node.major})`,
    `- 새 의존성: ${Object.keys(manifest.dependencies).length ? JSON.stringify(manifest.dependencies) : "없음"}`,
    `- 사용자별 설정 키(받는 쪽이 채움): ${manifest.settingsKeys.length ? manifest.settingsKeys.join(", ") : "없음"} — <보내는 쪽: 각 키의 뜻과 채우는 곳>`, "",
    "## 적용", "", "Iris 소스 체크아웃(`pnpm install` 완료)에서:", "", "```sh",
    "node bin/capability-share.mjs check <받는 쪽: 이 디렉터리 경로>", `git apply <받는 쪽: 이 디렉터리 경로>/${id}.patch`,
    ...(manifest.files.some((f) => f.status === "A") ? [`git add -N -- ${manifest.files.filter((f) => f.status === "A").map((f) => JSON.stringify(f.path)).join(" ")}`] : []),
    ...(Object.keys(manifest.dependencies).length ? ["pnpm install"] : []),
    "node scripts/run-tests.mjs --fast", "```", "",
    "`check` 는 Iris·Node 주 버전·이름 충돌·파일 해시(적용 결과가 작성자의 파일과 같은지)·`git apply --check` 를 보고 적용하지 않습니다. 기준 커밋이 이력에 없다는 안내는 같은 내용을 다른 sha 로 가진 저장소에서 나오며, 나머지 검사가 통과하면 적용할 수 있습니다. 검사 통과는 기능이 이 환경에서 동작한다는 뜻이 아니라 코드가 작성자와 같게 들어간다는 뜻입니다.", "",
    "## 실행과 확인", "", "자기 상태 폴더·포트로 띄웁니다(설치 앱·다른 개발 서버의 것을 쓰지 않습니다). 서버·네이티브 짝이 있는 기능은 앱이 서버를 소유하도록 앱으로 띄웁니다:", "", "```sh",
    "IRIS_PORT=<받는 쪽: 빈 포트> IRIS_STATE_DIR=<받는 쪽: 자기 상태 폴더> pnpm exec electron native/electron/main.cjs", "```", "",
    "서버만 볼 때는 `IRIS_PORT=<받는 쪽: 빈 포트> IRIS_STATE_DIR=<받는 쪽: 자기 상태 폴더> node server/index.js`.", "",
    "<보내는 쪽: 어느 화면에서 무엇이 보이면 정상인지>", "",
    "## 끄기와 되돌리기", "",
    "설정 → 편의 기능에서 이 기능을 끄면 `features.json` 에 저장되고, 렌더러만 있는 기능은 다시 읽기(⌘⇧R), 서버·네이티브 짝이 있는 기능은 앱 재시작으로 빠집니다.",
    `코드를 걷어내려면 \`git apply --reverse <받는 쪽: 이 디렉터리 경로>/${id}.patch\`.`, "",
  ].join("\n") + "\n");
  return { destination, manifest };
}

export function checkBundle(root, directory) {
  const dir = path.resolve(root, directory);
  const manifest = json(dir, "manifest.json");
  const errors = [], notes = [];
  if (manifest.version !== 1 || !FEATURE_ID.test(manifest.id || "") || !/^[a-f0-9]{40,64}$/.test(manifest.base || "")) fail("지원하지 않거나 잘못된 manifest 형식입니다");
  if (!existsSync(path.join(dir, "README.md"))) errors.push("README.md 가 없습니다");
  // 같은 내용을 다른 sha 로 가진 사본(패치로 받은 저장소)이 흔하다. 조상이 아니어도 적용 가능 여부는 아래 git apply --check 가 판정한다.
  if (spawnSync("git", ["merge-base", "--is-ancestor", manifest.base, "HEAD"], { cwd: root }).status !== 0) notes.push(`기준 커밋 ${manifest.base.slice(0, 12)} 이 이 저장소 이력에 없습니다 — 같은 내용이라도 sha 가 다르면 이렇게 됩니다. 적용 가능 여부는 git apply --check 결과를 따릅니다`);
  const pkg = json(root, "package.json");
  if (pkg.version !== manifest.irisVersion) errors.push(`Iris 버전 불일치: 필요 ${manifest.irisVersion}, 현재 ${pkg.version}`);
  if (Number(process.versions.node.split(".")[0]) !== manifest.node?.major) errors.push(`Node 주 버전 불일치: 작성 ${manifest.node?.version}, 현재 ${process.versions.node}`);
  if (!Array.isArray(manifest.settingsKeys) || manifest.settingsKeys.some((key) => typeof key !== "string")) fail("settingsKeys 문자열 배열이 필요합니다");
  for (const [group, entries] of Object.entries(manifest.dependencies || {})) {
    if (!["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].includes(group) || !entries || typeof entries !== "object") fail(`잘못된 의존성 선언: ${group}`);
    for (const [name, version] of Object.entries(entries)) {
      if (typeof version !== "string") fail(`의존성 버전 문자열이 필요합니다: ${name}`);
      if (pkg[group]?.[name] && pkg[group][name] !== version) errors.push(`의존성 충돌: ${name} 필요 ${version}, 현재 ${pkg[group][name]}`);
      else if (!pkg[group]?.[name]) notes.push(`새 의존성: ${group} ${name}@${version} (적용 후 설치)`);
    }
  }
  const rows = registry(root);
  if ([...rows.renderer, ...rows.server].some((row) => row.id === manifest.id)) errors.push(`id 충돌: ${manifest.id}`);
  const occupied = {
    railIds: rows.rail.map((row) => row.id).concat(rows.renderer.map((row) => row.rail).filter(Boolean)),
    cssFiles: rows.renderer.flatMap((row) => (row.css || []).map((css) => css.startsWith("web/") ? css : `web/css/${css}`)),
    wsPrefixes: [...rows.renderer, ...rows.server].flatMap((row) => row.wsPrefixes || []),
    httpPaths: [...rows.renderer, ...rows.server].flatMap((row) => [...(row.routes || []), ...(row.http || [])]),
  };
  for (const [kind, existing] of Object.entries(occupied)) {
    const incoming = manifest.declarations?.[kind];
    if (!Array.isArray(incoming) || incoming.some((value) => typeof value !== "string" || !value)) fail(`${kind} 문자열 배열이 필요합니다`);
    for (const value of incoming) {
      const collision = existing.find((other) => kind === "wsPrefixes" ? value.startsWith(other) || other.startsWith(value)
        : kind === "httpPaths" ? httpOverlap(value, other) : value === other);
      if (collision) errors.push(`${kind} 충돌: ${value} (기존 ${collision})`);
    }
  }
  const patchFile = safePath(manifest.patch?.file);
  const patch = read(dir, patchFile);
  privatePaths(patch, root);
  if (digest(patch) !== manifest.patch.sha256) errors.push("패치 sha256 불일치");
  const parts = sections(patch);
  if (!Array.isArray(manifest.files) || !manifest.files.length) fail("명시 파일 목록이 필요합니다");
  const listed = new Map();
  for (const file of manifest.files) {
    safePath(file.path);
    if (listed.has(file.path)) fail(`중복 파일 선언: ${file.path}`);
    listed.set(file.path, file);
  }
  if (parts.length !== listed.size || new Set(parts.map((part) => part.path)).size !== parts.length) errors.push("패치와 명시 파일 목록의 개수가 다릅니다");
  const overrides = new Map();
  for (const part of parts) {
    const file = listed.get(part.path);
    if (!file || file.status !== part.status) { errors.push(`패치와 파일 목록 불일치: ${part.path}`); continue; }
    try {
      const body = resultBody(root, manifest.base, part, { fromWorktree: true });
      overrides.set(part.path, body);
      if (file.sha256 !== (part.status === "D" ? null : digest(body))) errors.push(`파일 sha256 불일치: ${part.path} — 적용 결과가 작성자의 파일과 다릅니다(hunk 밖 차이)`);
      if (part.status === "D" && body !== "") errors.push(`삭제 패치에 본문이 남습니다: ${part.path}`);
    } catch (error) { errors.push(error.message); }
  }
  try {
    const actual = declarations(registry(root, overrides), manifest.id);
    for (const [kind, values] of Object.entries(actual)) {
      for (const value of values) if (!manifest.declarations[kind].includes(value)) errors.push(`${kind} 선언 누락: ${value}`);
    }
  } catch (error) { errors.push(`패치 등록표 검증 실패: ${error.message}`); }
  const apply = spawnSync("git", ["apply", "--check", "--" , path.join(dir, patchFile)], { cwd: root, encoding: "utf8" });
  if (apply.status !== 0) errors.push(`git apply --check 실패: ${(apply.stderr || apply.error?.message || "알 수 없는 오류").trim()}`);
  return { ok: errors.length === 0, errors, notes };
}

// 정적 prefix는 서버가 대소문자 별칭과 디렉터리 자체도 소유하는 것과 같은 범위다.
function httpOverlap(left, right) {
  const covers = (prefix, url) => prefix.endsWith("*")
    && (url.toLowerCase() === prefix.slice(0, -2).toLowerCase()
      || url.toLowerCase().startsWith(prefix.slice(0, -1).toLowerCase()));
  return left === right || covers(left, right) || covers(right, left);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2);
    const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
    if (command === "manifest") {
      const options = {};
      for (let i = 0; i < args.length; i += 2) {
        if (!["--id", "--base", "--out"].includes(args[i]) || !args[i + 1]) fail("사용법: manifest --id ID --base COMMIT [--out DIR]");
        options[args[i].slice(2)] = args[i + 1];
      }
      if (!options.base) fail("--base COMMIT 이 필요합니다");
      const result = createManifest(root, options);
      console.log(`생성: ${result.destination}\n파일 ${result.manifest.files.length}개. 공유 전에 manifest.json의 파일 목록·settingsKeys·declarations를 검토하세요.`);
    } else if (command === "check" && args.length === 1) {
      const result = checkBundle(root, args[0]);
      for (const note of result.notes) console.log(note);
      for (const error of result.errors) console.error(`FAIL ${error}`);
      console.log(result.ok ? "검사 통과 (적용하지 않음)" : "검사 실패 (적용하지 않음)");
      process.exitCode = result.ok ? 0 : 1;
    } else fail("사용법: capability-share.mjs manifest --id ID --base COMMIT [--out DIR] | check DIR");
  } catch (error) {
    console.error(`FAIL ${error.message}`);
    process.exitCode = 1;
  }
}
