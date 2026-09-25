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

// 명령 대역. 앱 프로세스는 상태 폴더의 running 파일로 흉내 낸다. 처음에는 이전 앱이 떠 있다.
//   quit: "pass" 는 종료 요청에 앱이 내려가고 "refuse" 는 떠 있는 채로 남는다.
//   launch: "stays" 는 연 앱이 계속 뜨고 "exits" 는 열리자마자 종료된다.
//   copy: "fail" 이면 ditto 가 반쪽 번들을 남기고 실패한다.
//   server: 새 앱 서버 준비 확인(wait-installed-server.cjs)의 결과.
function harness(t, {
  codesign = "pass", open = "pass", quit = "pass", launch = "stays", copy = "pass", server = "ready",
} = {}) {
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
  fs.writeFileSync(path.join(state, "running"), "");

  let source = fs.readFileSync(installerPath, "utf8");
  const original = source;
  source = source.replace('cd "$(dirname "$0")/.."', 'cd "$IRIS_TEST_ROOT"');
  source = source.replace("APP=/Applications/Iris.app", 'APP="$IRIS_TEST_APP"');
  source = source.replace("/usr/bin/codesign --verify", "codesign --verify");
  assert.notEqual(source, original);
  assert.match(source, /APP="\$IRIS_TEST_APP"/);
  assert.match(source, /codesign --verify --deep --strict/);
  const commands = source.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  assert.doesNotMatch(commands, /\/Applications\//, "대역 실행이 실제 설치 앱 경로를 건드리면 안 된다");
  const script = path.join(dir, "install-app.sh");
  fs.writeFileSync(script, source, { mode: 0o755 });

  const backups = `$(ls "$(dirname "$IRIS_TEST_APP")" | grep -c '^Iris.app.old-' || true)`;
  executable(path.join(mocks, "node"), `
if [ "\${1:-}" = "scripts/wait-installed-server.cjs" ]; then
  echo "ready-check backups=${backups}" >> "$MOCK_LOG"
  ${server === "ready" ? "exit 0" : "exit 1"}
fi
echo "node $*" >> "$MOCK_LOG"`);
  executable(path.join(mocks, "npx"), 'echo "npx $*" >> "$MOCK_LOG"');
  executable(path.join(mocks, "codesign"), `echo "codesign $*" >> "$MOCK_LOG"\n${codesign === "pass" ? "exit 0" : "exit 41"}`);
  executable(path.join(mocks, "osascript"), `echo "quit" >> "$MOCK_LOG"\n${quit === "pass" ? '/bin/rm -f "$MOCK_STATE/running"' : ":"}`);
  executable(path.join(mocks, "sleep"), ":");
  executable(path.join(mocks, "ditto"), copy === "pass"
    ? 'echo "ditto" >> "$MOCK_LOG"\n/bin/cp -R "$1" "$2"'
    : 'echo "ditto" >> "$MOCK_LOG"\n/bin/mkdir -p "$2/Contents"\necho partial > "$2/Contents/version"\nexit 43');
  executable(path.join(mocks, "open"), `
echo "open" >> "$MOCK_LOG"
count=0
[ ! -f "$MOCK_STATE/open-count" ] || count=$(cat "$MOCK_STATE/open-count")
count=$((count + 1))
echo "$count" > "$MOCK_STATE/open-count"
${open === "fail-first" ? '[ "$count" -ne 1 ] || exit 42' : ":"}
${launch === "stays" ? 'touch "$MOCK_STATE/running"' : ":"}
`);
  executable(path.join(mocks, "pgrep"), '[ -f "$MOCK_STATE/running" ]');

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
  const running = fs.existsSync(path.join(state, "running"));
  return { app, dir, events, result, running };
}

function installedVersion(app) {
  return fs.readFileSync(path.join(app, "Contents", "version"), "utf8").trim();
}

function oldBackups(dir) {
  return fs.readdirSync(path.join(dir, "Applications")).filter((name) => name.startsWith("Iris.app.old-"));
}

const count = (events, name) => events.filter((event) => event === name).length;

test("새 bundle open 실패는 이전 bundle을 복원하고 다시 연다", (t) => {
  const h = harness(t, { open: "fail-first" });
  assert.notEqual(h.result.status, 0, h.result.stdout + h.result.stderr);
  assert.equal(installedVersion(h.app), "old");
  assert.deepEqual(oldBackups(h.dir), []);
  assert.equal(count(h.events, "open"), 2, "복원한 이전 앱도 다시 열어야 한다");
  assert.ok(h.events.indexOf("ditto") < h.events.indexOf("open"));
  assert.equal(h.running, true);
});

test("open 뒤 process가 곧바로 종료되면 이전 bundle을 복원하고 다시 연다", (t) => {
  const h = harness(t, { launch: "exits" });
  assert.notEqual(h.result.status, 0, h.result.stdout + h.result.stderr);
  assert.equal(installedVersion(h.app), "old");
  assert.deepEqual(oldBackups(h.dir), []);
  assert.equal(count(h.events, "open"), 2);
  assert.equal(h.events.some((event) => event.startsWith("ready-check")), false);
});

test("앱이 종료를 거절하면 교체하지 않고 멈춘다", (t) => {
  const h = harness(t, { quit: "refuse" });
  assert.notEqual(h.result.status, 0, h.result.stdout + h.result.stderr);
  assert.equal(installedVersion(h.app), "old");
  assert.deepEqual(oldBackups(h.dir), []);
  assert.ok(count(h.events, "quit") >= 1);
  assert.equal(h.events.includes("ditto"), false);
  assert.equal(h.events.includes("open"), false);
  assert.equal(h.running, true, "떠 있던 앱은 그대로 남는다");
});

test("복사 실패는 반쪽 번들을 치우고 이전 앱을 복원해 다시 연다", (t) => {
  const h = harness(t, { copy: "fail" });
  assert.notEqual(h.result.status, 0, h.result.stdout + h.result.stderr);
  assert.equal(installedVersion(h.app), "old");
  assert.deepEqual(oldBackups(h.dir), []);
  assert.equal(count(h.events, "open"), 1, "종료했던 이전 앱을 다시 열어야 한다");
  assert.equal(h.running, true);
});

test("새 앱의 서버가 준비되지 않으면 새 앱을 내리고 이전 앱을 복원해 다시 연다", (t) => {
  const h = harness(t, { server: "missing" });
  assert.notEqual(h.result.status, 0, h.result.stdout + h.result.stderr);
  assert.equal(installedVersion(h.app), "old");
  assert.deepEqual(oldBackups(h.dir), []);
  assert.equal(count(h.events, "quit"), 2, "이전 앱과 새 앱을 각각 종료한다");
  assert.equal(count(h.events, "open"), 2);
  assert.ok(h.events.indexOf("ready-check backups=1") > h.events.indexOf("open"));
  assert.equal(h.running, true);
});

test("새 앱과 서버가 준비된 뒤에만 백업을 지운다", (t) => {
  const h = harness(t);
  assert.equal(h.result.status, 0, h.result.stdout + h.result.stderr);
  assert.equal(installedVersion(h.app), "new");
  assert.deepEqual(oldBackups(h.dir), []);
  assert.equal(count(h.events, "open"), 1);
  const ready = h.events.indexOf("ready-check backups=1");
  assert.ok(ready > h.events.indexOf("open"), "서버 준비 확인은 실행 뒤, 백업이 남아 있을 때 한다");
  assert.ok(h.events.findIndex((event) => event.startsWith("node scripts/install-agent-context.mjs")) > ready);
  assert.equal(h.running, true);
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
