import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const installerPath = path.join(root, "scripts", "install-app.sh");

function executable(file, body) {
  fs.writeFileSync(file, `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o755 });
}

function harness(t, { codesign = "pass", open = "pass", processState = "present" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-install-recovery-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fixtureRoot = path.join(dir, "repo");
  const app = path.join(dir, "Applications", "Iris.app");
  const built = path.join(fixtureRoot, "dist", "mac-arm64", "Iris.app");
  const mocks = path.join(dir, "bin");
  const state = path.join(dir, "state");
  const log = path.join(dir, "events.log");
  fs.mkdirSync(path.join(app, "Contents"), { recursive: true });
  fs.mkdirSync(path.join(built, "Contents"), { recursive: true });
  fs.mkdirSync(mocks, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(app, "Contents", "version"), "old\n");
  fs.writeFileSync(path.join(built, "Contents", "version"), "new\n");

  let source = fs.readFileSync(installerPath, "utf8");
  const original = source;
  source = source.replace('cd "$(dirname "$0")/.."', 'cd "$IRIS_TEST_ROOT"');
  source = source.replace("APP=/Applications/Iris.app", 'APP="$IRIS_TEST_APP"');
  source = source.replace("/usr/bin/codesign --verify", "codesign --verify");
  assert.notEqual(source, original);
  assert.match(source, /APP="\$IRIS_TEST_APP"/);
  assert.match(source, /codesign --verify --deep --strict/);
  const script = path.join(dir, "install-app.sh");
  fs.writeFileSync(script, source, { mode: 0o755 });

  executable(path.join(mocks, "node"), 'echo "node $*" >> "$MOCK_LOG"');
  executable(path.join(mocks, "npx"), 'echo "npx $*" >> "$MOCK_LOG"');
  executable(path.join(mocks, "codesign"), `echo "codesign $*" >> "$MOCK_LOG"\n${codesign === "pass" ? "exit 0" : "exit 41"}`);
  executable(path.join(mocks, "osascript"), 'echo "quit" >> "$MOCK_LOG"');
  executable(path.join(mocks, "sleep"), ":");
  executable(path.join(mocks, "ditto"), 'echo "ditto" >> "$MOCK_LOG"\n/bin/cp -R "$1" "$2"');
  executable(path.join(mocks, "open"), `
echo "open" >> "$MOCK_LOG"
count=0
[ ! -f "$MOCK_STATE/open-count" ] || count=$(cat "$MOCK_STATE/open-count")
count=$((count + 1))
echo "$count" > "$MOCK_STATE/open-count"
touch "$MOCK_STATE/opened"
${open === "fail-first" ? '[ "$count" -ne 1 ] || exit 42' : ":"}
`);
  executable(path.join(mocks, "pgrep"), processState === "present"
    ? '[ -f "$MOCK_STATE/opened" ]'
    : "exit 1");

  const result = spawnSync("/bin/bash", [script], {
    cwd: fixtureRoot,
    env: {
      ...process.env,
      PATH: `${mocks}:${process.env.PATH}`,
      IRIS_TEST_ROOT: fixtureRoot,
      IRIS_TEST_APP: app,
      MOCK_LOG: log,
      MOCK_STATE: state,
    },
    encoding: "utf8",
  });
  const events = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
  return { app, dir, events, result };
}

function installedVersion(app) {
  return fs.readFileSync(path.join(app, "Contents", "version"), "utf8").trim();
}

function oldBackups(dir) {
  return fs.readdirSync(path.join(dir, "Applications")).filter((name) => name.startsWith("Iris.app.old-"));
}

test("새 bundle open 실패는 이전 bundle을 복원한다", (t) => {
  const h = harness(t, { open: "fail-first" });
  assert.notEqual(h.result.status, 0, h.result.stdout + h.result.stderr);
  assert.equal(installedVersion(h.app), "old");
  assert.deepEqual(oldBackups(h.dir), []);
  assert.equal(h.events.filter((event) => event === "open").length, 2, "복원한 이전 앱도 다시 열어야 한다");
  assert.ok(h.events.indexOf("ditto") < h.events.indexOf("open"));
});

test("open 뒤 process가 뜨지 않으면 이전 bundle을 복원한다", (t) => {
  const h = harness(t, { processState: "missing" });
  assert.notEqual(h.result.status, 0, h.result.stdout + h.result.stderr);
  assert.equal(installedVersion(h.app), "old");
  assert.deepEqual(oldBackups(h.dir), []);
  assert.equal(h.events.filter((event) => event === "open").length, 2);
});

test("서명 검증 실패는 실행 중인 앱을 종료하거나 교체하지 않는다", (t) => {
  const h = harness(t, { codesign: "fail" });
  assert.equal(h.result.status, 41, h.result.stdout + h.result.stderr);
  assert.equal(installedVersion(h.app), "old");
  assert.deepEqual(oldBackups(h.dir), []);
  assert.ok(h.events.some((event) => event.startsWith("codesign --verify --deep --strict")));
  assert.equal(h.events.includes("quit"), false);
  assert.equal(h.events.includes("ditto"), false);
  assert.equal(h.events.includes("open"), false);
});

test("source-root marker는 서명 전 afterPack만 소유한다", () => {
  const installer = fs.readFileSync(installerPath, "utf8");
  const afterPack = fs.readFileSync(path.join(root, "scripts", "after-pack.cjs"), "utf8");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.doesNotMatch(installer, /\.source-root/);
  assert.match(afterPack, /fs\.writeFileSync\(path\.join\(resources, "\.source-root"\)/);
  assert.equal(pkg.build.afterPack, "scripts/after-pack.cjs");
});
