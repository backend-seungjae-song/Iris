import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MAX_APP_TARGETS, readAppTargets, setAppTargets } from "../server/app-targets.js";

function fixture(t) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-app-targets-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  return { stateDir, file: path.join(stateDir, "app-targets.json") };
}

test("옛 문자열 값은 한 대 배열로 읽고 중복을 제거한다", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.file, JSON.stringify({ p1: "emulator-5554", p2: ["ios-1", "ios-1", "ios-2"] }));
  assert.deepEqual(readAppTargets({ stateDir: f.stateDir }), {
    p1: ["emulator-5554"],
    p2: ["ios-1", "ios-2"],
  });
});

test("서버 쓰기는 순서대로 중복을 제거하고 최대 수를 지켜 원자적으로 교체한다", (t) => {
  const f = fixture(t);
  assert.equal(MAX_APP_TARGETS, 4);
  setAppTargets("w1:p1", ["d1", "d2", "d1", "d3", "d4", "d5"], { stateDir: f.stateDir });
  setAppTargets("w1:p2", ["other"], { stateDir: f.stateDir });
  assert.deepEqual(readAppTargets({ stateDir: f.stateDir }), {
    "w1:p1": ["d1", "d2", "d3", "d4"],
    "w1:p2": ["other"],
  });
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(f.stateDir).some((name) => name.includes(".tmp")), false);
});

test("빈 배열은 그 pane의 등록만 지운다", (t) => {
  const f = fixture(t);
  setAppTargets("w1:p1", ["d1"], { stateDir: f.stateDir });
  setAppTargets("w1:p2", ["d2"], { stateDir: f.stateDir });
  setAppTargets("w1:p1", [], { stateDir: f.stateDir });
  assert.deepEqual(readAppTargets({ stateDir: f.stateDir }), { "w1:p2": ["d2"] });
});

test("지목 등록은 같은 기기를 다른 pane의 등록에서 지운다", (t) => {
  const f = fixture(t);
  setAppTargets("w1:p1", ["d1"], { stateDir: f.stateDir });
  setAppTargets("w1:p2", ["d1", "d2"], { stateDir: f.stateDir });
  setAppTargets("w1:p3", ["d3"], { stateDir: f.stateDir });
  setAppTargets("w1:p4", ["d1"], { stateDir: f.stateDir, exclusive: true });
  assert.deepEqual(readAppTargets({ stateDir: f.stateDir }), {
    "w1:p2": ["d2"],
    "w1:p3": ["d3"],
    "w1:p4": ["d1"],
  });
});

test("지목 경로는 기기를 배타적으로 등록한다", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const commands = fs.readFileSync(path.join(root, "server", "browser-commands.js"), "utf8");
  assert.match(commands, /replaceDevices\(records\) \{[^}]*setAppTargets\(session, devices, \{ exclusive: true \}\);/);
});

test("app-targets.json을 쓰는 주체는 서버 모듈 하나다", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const server = fs.readFileSync(path.join(root, "server", "app-targets.js"), "utf8");
  const mcp = fs.readFileSync(path.join(root, "bin", "mcp", "app.mjs"), "utf8");
  const native = fs.readFileSync(path.join(root, "native", "electron", "emulator", "emulator-host.cjs"), "utf8");
  const preload = fs.readFileSync(path.join(root, "native", "electron", "preload.cjs"), "utf8");
  assert.match(server, /app-targets\.json/);
  assert.match(server, /renameSync\(temp, file\)/);
  assert.doesNotMatch(mcp, /app-targets\.json|writeFileSync\(APP_TARGET/);
  assert.doesNotMatch(native, /app-targets\.json|ac-emulator-target-pin/);
  assert.doesNotMatch(preload, /pinTarget|ac-emulator-target-pin/);
});
