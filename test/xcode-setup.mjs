import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { inspectXcode, switchXcode, xcodeAppPath } = require("../native/electron/emulator/xcode-setup.cjs");
const root = "/Applications";
const developer = (name) => path.join(root, name, "Contents", "Developer");
const framework = (name) => path.join(root, name, "Contents", "SharedFrameworks", "SimulatorKit.framework", "SimulatorKit");
const paths = (names, complete = names) => new Set([
  ...names.map((name) => path.join(root, name, "Contents", "MacOS", "Xcode")),
  ...complete.flatMap((name) => [path.join(developer(name), "usr", "bin", "simctl"), framework(name)]),
]);
const inspect = (names, complete, selectedDir) => {
  const found = paths(names, complete);
  return inspectXcode({ roots: [root], selectedDir, existsSync: (file) => found.has(file), readdirSync: () => names });
};

test("선택된 Xcode가 완전하면 버전 이름과 관계없이 사용한다", () => {
  assert.equal(inspect(["Xcode_27.app"], ["Xcode_27.app"], developer("Xcode_27.app")).status, "ready");
});

test("명령줄 도구가 선택됐고 Xcode가 하나면 복구 대상으로 찾는다", () => {
  const result = inspect(["Xcode-beta.app"], ["Xcode-beta.app"], "/Library/Developer/CommandLineTools");
  assert.equal(result.status, "repair");
  assert.deepEqual(result.candidates, [developer("Xcode-beta.app")]);
});

test("Xcode가 여러 개면 임의로 고르지 않는다", () => {
  assert.equal(inspect(["Xcode.app", "Xcode-beta.app"], ["Xcode.app", "Xcode-beta.app"], "").status, "choose");
});

test("설치 누락과 불완전한 설치를 구분한다", () => {
  assert.equal(inspect([], [], "").status, "missing");
  assert.equal(inspect(["Xcode.app"], [], "").status, "incomplete");
});

test("Xcode 앱 경로만 복구 명령 대상으로 받는다", () => {
  assert.equal(xcodeAppPath(developer("Xcode_27.app")), "/Applications/Xcode_27.app");
  assert.equal(xcodeAppPath(developer("Renamed.app")), "/Applications/Renamed.app");
  assert.equal(xcodeAppPath("/tmp/Developer"), null);
});

test("검증된 Xcode 경로만 별도 인자로 관리자 선택 명령에 넘긴다", async () => {
  const calls = [];
  const target = developer("Xcode' beta.app");
  const inspect = (options) => options ? { status: "ready" } : { status: "ready", selectedDir: target };
  const execFile = (file, args, options, callback) => { calls.push({ file, args, options }); callback(null); };
  assert.deepEqual(await switchXcode(target, { inspect, execFile }), { ok: true });
  assert.equal(calls[0].file, "/usr/bin/osascript");
  assert.equal(calls[0].args[2], target);
  assert.match(calls[0].args[1], /quoted form of \(item 1 of argv\)/);
  assert.equal(calls[0].options.timeout, 120000);
  assert.equal((await switchXcode("/tmp/Developer", { inspect, execFile })).ok, false);
  assert.equal(calls.length, 1);
});
