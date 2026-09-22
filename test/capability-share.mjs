import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { capabilityDeclarations, checkBundle, createManifest } from "../bin/capability-share.mjs";

const TOOL = fileURLToPath(new URL("../bin/capability-share.mjs", import.meta.url));
const hash = (body) => createHash("sha256").update(body).digest("hex");
const git = (root, ...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const write = (root, file, body) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), body); };
const read = (root, file) => readFileSync(path.join(root, file), "utf8");
const saveManifest = (bundle, manifest) => write(bundle, "manifest.json", JSON.stringify(manifest));

test("실제 렌더러·서버 등록표에서 WS·HTTP·지면 선언을 읽는다", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  assert.ok(capabilityDeclarations(root, "usage").wsPrefixes.includes("usage."));
  assert.deepEqual(capabilityDeclarations(root, "run").httpPaths, ["/run-cmd"]);
  assert.ok(capabilityDeclarations(root, "memolab").httpPaths.includes("/memolab/*"));
  assert.ok(capabilityDeclarations(root, "memo").wsPrefixes.includes("memos"));
});

function fixture(t) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "iris-capability-share-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const author = path.join(scratch, "author"), recipient = path.join(scratch, "recipient"), bundle = path.join(scratch, "bundle");
  mkdirSync(author);
  git(author, "init", "-b", "main");
  git(author, "config", "user.name", "Fixture");
  git(author, "config", "user.email", "fixture@example.invalid");
  write(author, "package.json", JSON.stringify({ type: "module", version: "1.2.3", engines: { node: ">=20" }, dependencies: { present: "1.0.0" } }));
  write(author, "web/js/core/capabilities.js", 'throw new Error("등록표를 실행하면 안 됩니다");\nexport const CAPABILITIES = [{ id: "existing", rail: "occupied", css: ["old.css"], files: ["existing.js"], load: () => import("../existing.js") }];\n');
  write(author, "web/js/core/rail-items.js", 'export const RAIL_ITEMS = [{ id: "occupied" }, { id: "settings" }];\n');
  write(author, "server/capabilities.js", 'throw new Error("서버를 실행하면 안 됩니다");\nexport const capabilities = [{ id: "server-only", wsPrefixes: ["remote."], init(ctx) {}, handle(ws, msg) { return false; }, http: [{ method: "GET", path: "/occupied", handler() {} }, { path: "/static/", prefix: true, handler() {} }] }];\n');
  write(author, "web/js/existing.js", 'export const ws = { "existing.state": () => {} };\n');
  write(author, "web/css/old.css", ".existing {}\n");
  write(author, "old.txt", "delete this\n");
  write(author, "several.txt", Array.from({ length: 40 }, (_, i) => `line ${i}\n`).join(""));
  git(author, "add", ".");
  git(author, "commit", "-m", "fixture base");
  const base = git(author, "rev-parse", "HEAD").trim();
  git(scratch, "clone", "--no-local", author, recipient);
  write(author, "web/js/core/capabilities.js", read(author, "web/js/core/capabilities.js").replace("];", ', { id: "fresh", rail: "fresh", css: ["fresh.css"], files: ["fresh.js"], wsPrefixes: ["fresh."], routes: ["/fresh"], load: () => import("../fresh.js") }];'));
  write(author, "web/js/fresh.js", 'export const ws = { "fresh.state": () => {} };\n');
  write(author, "web/css/fresh.css", ".fresh { color: red; }\n");
  git(author, "add", "-N", "web/js/fresh.js", "web/css/fresh.css");
  return { author, recipient, bundle, base };
}

test("intent-to-add·명시 파일 해시·패치·안내문을 만들고 수신 검사는 트리와 index를 보존한다", (t) => {
  const f = fixture(t);
  const { manifest } = createManifest(f.author, { id: "fresh", base: f.base, out: f.bundle });
  assert.deepEqual(manifest.files.map((file) => [file.path, file.status]), [["web/css/fresh.css", "A"], ["web/js/core/capabilities.js", "M"], ["web/js/fresh.js", "A"]]);
  assert.equal(manifest.files.find((file) => file.path === "web/js/fresh.js").sha256, hash(read(f.author, "web/js/fresh.js")));
  assert.deepEqual(manifest.declarations, { railIds: ["fresh"], cssFiles: ["web/css/fresh.css"], wsPrefixes: ["fresh."], httpPaths: ["/fresh"] });
  assert.deepEqual(manifest.settingsKeys, []);
  assert.match(read(f.bundle, "README.md"), /git apply --reverse/);
  const before = [git(f.recipient, "status", "--porcelain"), git(f.recipient, "ls-files", "--stage"), read(f.recipient, "web/js/core/capabilities.js")];
  assert.deepEqual(checkBundle(f.recipient, f.bundle), { ok: true, errors: [], notes: [] });
  assert.deepEqual([git(f.recipient, "status", "--porcelain"), git(f.recipient, "ls-files", "--stage"), read(f.recipient, "web/js/core/capabilities.js")], before);
});

test("두 등록표·rail 표의 이름과 WS·HTTP 접두사 충돌을 항목별로 알린다", (t) => {
  const f = fixture(t);
  const { manifest } = createManifest(f.author, { id: "fresh", base: f.base, out: f.bundle });
  manifest.id = "server-only";
  manifest.declarations = { railIds: ["settings"], cssFiles: ["web/css/old.css"], wsPrefixes: ["remote.child.", "existing."], httpPaths: ["/occupied", "/static/file", "/STATIC/file", "/static"] };
  saveManifest(f.bundle, manifest);
  const result = checkBundle(f.recipient, f.bundle);
  assert.equal(result.ok, false);
  for (const marker of ["id 충돌: server-only", "railIds 충돌: settings", "cssFiles 충돌: web/css/old.css", "wsPrefixes 충돌: remote.child.", "wsPrefixes 충돌: existing.", "httpPaths 충돌: /occupied", "httpPaths 충돌: /static/file", "httpPaths 충돌: /STATIC/file", "httpPaths 충돌: /static"]) assert.ok(result.errors.some((line) => line.includes(marker)), marker);
});

test("변경된 소유 파일의 저장소·환경 설정 키를 검토 후보로 만든다", (t) => {
  const f = fixture(t);
  write(f.author, "web/js/core/capabilities.js", read(f.author, "web/js/core/capabilities.js").replace('files: ["fresh.js"]', 'files: ["fresh.js"], server: ["server/fresh.js"]'));
  write(f.author, "web/js/fresh.js", 'localStorage.getItem("fresh.theme"); sessionStorage.setItem("fresh.tab", "one"); localStorage.getItem(dynamicKey);\n');
  write(f.author, "server/fresh.js", 'const token = process.env.FRESH_TOKEN; const host = process.env["FRESH_HOST"];\n');
  write(f.author, "unrelated.js", 'process.env.UNRELATED;\n');
  git(f.author, "add", "-N", "server/fresh.js", "unrelated.js");
  const { manifest } = createManifest(f.author, { id: "fresh", base: f.base, out: f.bundle });
  assert.deepEqual(manifest.settingsKeys, ["FRESH_HOST", "FRESH_TOKEN", "fresh.tab", "fresh.theme"]);
  manifest.settingsKeys.push("manually.declared");
  saveManifest(f.bundle, manifest);
  assert.equal(checkBundle(f.recipient, f.bundle).ok, true);
});

test("manifest 선언을 지워도 패치의 실제 충돌 이름을 숨길 수 없다", (t) => {
  const f = fixture(t);
  write(f.author, "web/js/core/capabilities.js", read(f.author, "web/js/core/capabilities.js")
    .replace('rail: "fresh"', 'rail: "occupied"').replace('css: ["fresh.css"]', 'css: ["old.css"]')
    .replace('wsPrefixes: ["fresh."]', 'wsPrefixes: ["remote."]').replace('routes: ["/fresh"]', 'routes: ["/occupied"]'));
  const { manifest } = createManifest(f.author, { id: "fresh", base: f.base, out: f.bundle });
  for (const kind of Object.keys(manifest.declarations)) manifest.declarations[kind] = [];
  saveManifest(f.bundle, manifest);
  const result = checkBundle(f.recipient, f.bundle);
  assert.equal(result.ok, false);
  for (const marker of ["railIds 선언 누락: occupied", "cssFiles 선언 누락: web/css/old.css", "wsPrefixes 선언 누락: remote.", "httpPaths 선언 누락: /occupied"]) assert.ok(result.errors.some((line) => line.includes(marker)), marker);
});

test("버전·조상·의존성 불일치를 거절하고 새 의존성을 안내한다", (t) => {
  const f = fixture(t);
  const pkg = JSON.parse(read(f.author, "package.json"));
  pkg.dependencies = { present: "2.0.0", added: "3.0.0" };
  write(f.author, "package.json", JSON.stringify(pkg));
  const { manifest } = createManifest(f.author, { id: "fresh", base: f.base, out: f.bundle });
  assert.deepEqual(manifest.dependencies, { dependencies: { present: "2.0.0", added: "3.0.0" } });
  manifest.irisVersion = "99.0.0";
  manifest.node.major = 1;
  manifest.base = "0".repeat(40);
  saveManifest(f.bundle, manifest);
  const result = checkBundle(f.recipient, f.bundle);
  for (const marker of ["Iris 버전 불일치", "Node 주 버전 불일치", "의존성 충돌: present"]) assert.ok(result.errors.some((line) => line.includes(marker)), marker);
  // 기준 커밋이 이력에 없는 것은 거절 사유가 아니라 안내다. 같은 내용을 다른 sha 로 가진 저장소가 흔하다.
  assert.ok(!result.errors.some((line) => line.includes("조상")), "조상 여부로 거절하지 않는다");
  assert.match(result.notes.join("\n"), /기준 커밋 000000000000 이 이 저장소 이력에 없습니다/);
  assert.match(result.notes.join("\n"), /새 의존성: dependencies added@3.0.0/);
});

test("생성된 README 는 받는 쪽이 그것만 보고 적용·실행·끄기까지 할 수 있게 절차를 담는다", (t) => {
  const f = fixture(t);
  createManifest(f.author, { id: "fresh", base: f.base, out: f.bundle });
  const readme = read(f.bundle, "README.md");
  for (const marker of ["capability-share.mjs check", "git apply", "git add -N", "node scripts/run-tests.mjs --fast", "IRIS_PORT=", "IRIS_STATE_DIR=", "git apply --reverse", "features.json", f.base]) {
    assert.ok(readme.includes(marker), marker);
  }
});

test("같은 내용을 다른 이력으로 가진 수신 저장소에서도 check 가 통과한다", (t) => {
  const f = fixture(t);
  createManifest(f.author, { id: "fresh", base: f.base, out: f.bundle });
  const other = path.join(path.dirname(f.recipient), "other");
  cpSync(f.recipient, other, { recursive: true, filter: (src) => !src.split(path.sep).includes(".git") });
  git(other, "init", "-b", "main");
  git(other, "config", "user.name", "Other");
  git(other, "config", "user.email", "other@example.invalid");
  git(other, "add", ".");
  git(other, "commit", "-m", "same content, new history");
  const result = checkBundle(other, f.bundle);
  assert.deepEqual(result.errors, [], result.errors.join("\n"));
  assert.match(result.notes.join("\n"), /이 저장소 이력에 없습니다/);
});

test("hunk 밖이 다른 수신 파일은 적용 결과가 작성자와 달라지므로 거절한다", (t) => {
  const f = fixture(t);
  write(f.author, "several.txt", read(f.author, "several.txt").replace("line 2\n", "changed 2\n").replace("line 37\n", "changed 37\n"));
  createManifest(f.author, { id: "fresh", base: f.base, out: f.bundle });
  write(f.recipient, "several.txt", read(f.recipient, "several.txt").replace("line 20\n", "받는 쪽이 따로 고친 20\n"));
  const result = checkBundle(f.recipient, f.bundle);
  assert.ok(!result.errors.some((line) => line.includes("git apply --check")), "패치 자체는 붙는다");
  assert.ok(result.errors.some((line) => line.includes("파일 sha256 불일치: several.txt")), result.errors.join("\n"));
});

test("패치·파일 해시 변경과 명시 목록 누락을 거절한다", (t) => {
  const f = fixture(t);
  const { manifest } = createManifest(f.author, { id: "fresh", base: f.base, out: f.bundle });
  write(f.bundle, "fresh.patch", read(f.bundle, "fresh.patch").replace("color: red", "color: tan"));
  manifest.files.pop();
  saveManifest(f.bundle, manifest);
  const result = checkBundle(f.recipient, f.bundle);
  for (const marker of ["패치 sha256 불일치", "파일 sha256 불일치: web/css/fresh.css", "명시 파일 목록의 개수", "파일 목록 불일치: web/js/fresh.js"]) assert.ok(result.errors.some((line) => line.includes(marker)), marker);
});

test("수신 본문 충돌은 git apply --check에서 실패하고 파일을 바꾸지 않는다", (t) => {
  const f = fixture(t);
  createManifest(f.author, { id: "fresh", base: f.base, out: f.bundle });
  const changed = 'export const CAPABILITIES = [];\n';
  write(f.recipient, "web/js/core/capabilities.js", changed);
  const result = checkBundle(f.recipient, f.bundle);
  assert.ok(result.errors.some((line) => line.startsWith("git apply --check 실패")));
  assert.equal(read(f.recipient, "web/js/core/capabilities.js"), changed);
});

test("삭제·개행 없는 파일·여러 hunk의 결과 해시를 검증한다", (t) => {
  const f = fixture(t);
  git(f.author, "rm", "old.txt");
  write(f.author, "web/js/fresh.js", "export const value = 42;");
  write(f.author, "several.txt", read(f.author, "several.txt").replace("line 2\n", "changed 2\n").replace("line 37\n", "changed 37\n"));
  createManifest(f.author, { id: "fresh", base: f.base, out: f.bundle });
  const section = read(f.bundle, "fresh.patch").split("diff --git a/several.txt")[1].split("diff --git")[0];
  assert.equal(section.match(/^@@/gm).length, 2);
  assert.equal(checkBundle(f.recipient, f.bundle).ok, true);
});

test("작성자 절대 경로·미지원 바이너리·기존 출력 디렉터리를 거절한다", (t) => {
  const f = fixture(t);
  const privateLocation = ["", "Users", "example", "private", "project"].join("/");
  write(f.author, "web/js/fresh.js", `export const location = ${JSON.stringify(privateLocation)};\n`);
  assert.throws(() => createManifest(f.author, { id: "fresh", base: f.base, out: f.bundle }), /작성자 절대 경로/);
  write(f.author, "web/js/fresh.js", Buffer.from([0, 1, 2, 3]));
  assert.throws(() => createManifest(f.author, { id: "fresh", base: f.base, out: f.bundle }), /바이너리/);
  write(f.author, "web/js/fresh.js", "export const value = 42;\n");
  createManifest(f.author, { id: "fresh", base: f.base, out: f.bundle });
  assert.throws(() => createManifest(f.author, { id: "fresh", base: f.base, out: f.bundle }), /이미 있습니다/);
});

test("경로 순회와 동적 선언은 실행하지 않고 거절한다", (t) => {
  const f = fixture(t);
  const { manifest } = createManifest(f.author, { id: "fresh", base: f.base, out: f.bundle });
  manifest.patch.file = "../fresh.patch";
  saveManifest(f.bundle, manifest);
  assert.throws(() => checkBundle(f.recipient, f.bundle), /안전하지 않은 파일 경로/);
  write(f.recipient, "server/capabilities.js", 'export const capabilities = [{ id: resolveId() }];\n');
  assert.throws(() => checkBundle(f.recipient, f.bundle), /리터럴 선언/);
});

test("CLI 기본 출력과 check 종료 코드", (t) => {
  const f = fixture(t);
  const generated = spawnSync(process.execPath, [TOOL, "manifest", "--id", "fresh", "--base", f.base], { cwd: f.author, encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  const bundle = path.join(f.author, "capability-share-fresh");
  const checked = spawnSync(process.execPath, [TOOL, "check", bundle], { cwd: f.recipient, encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /검사 통과 \(적용하지 않음\)/);
  const manifest = JSON.parse(read(bundle, "manifest.json"));
  manifest.declarations.railIds.push("occupied");
  saveManifest(bundle, manifest);
  const rejected = spawnSync(process.execPath, [TOOL, "check", bundle], { cwd: f.recipient, encoding: "utf8" });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /railIds 충돌: occupied/);
});
