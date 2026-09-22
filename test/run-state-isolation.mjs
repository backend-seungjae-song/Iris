import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { pathToFileURL } from "node:url";

const runUrl = pathToFileURL(path.resolve("server/run.js")).href;

function initializeRunManager({ home, stateDir }) {
  const script = `
    const { RunManager } = await import(${JSON.stringify(runUrl)} + "?child=" + Date.now());
    new RunManager();
  `;
  const env = { ...process.env, HOME: home };
  if (stateDir) env.IRIS_STATE_DIR = stateDir;
  else delete env.IRIS_STATE_DIR;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test("실행 프로세스 장부는 IRIS_STATE_DIR 안에서만 읽고 쓴다", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iris-run-state-"));
  const home = path.join(root, "home");
  const stateDir = path.join(root, "state");
  fs.mkdirSync(home);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  initializeRunManager({ home, stateDir });

  assert.equal(fs.existsSync(path.join(stateDir, "run-pids.json")), true);
  assert.equal(fs.existsSync(path.join(home, ".iris", "run-pids.json")), false);
});

test("IRIS_STATE_DIR가 없는 새 설치는 새 이름 폴더를 쓴다", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iris-run-default-"));
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  initializeRunManager({ home, stateDir: null });

  assert.equal(fs.existsSync(path.join(home, ".iris", "run-pids.json")), true);
});

