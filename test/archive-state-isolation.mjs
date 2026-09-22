import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { pathToFileURL } from "node:url";

const archiveUrl = pathToFileURL(path.resolve("server/archive.js")).href;

function writeArchive({ home, stateDir }) {
  const script = `
    const archive = await import(${JSON.stringify(archiveUrl)} + "?child=" + Date.now());
    archive.load();
    archive.add({ id: "isolated", kind: "agent" });
    await new Promise((resolve) => setTimeout(resolve, 180));
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

test("보관함은 IRIS_STATE_DIR 안에서만 읽고 쓴다", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iris-archive-state-"));
  const home = path.join(root, "home");
  const stateDir = path.join(root, "state");
  fs.mkdirSync(home);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  writeArchive({ home, stateDir });

  assert.equal(fs.existsSync(path.join(stateDir, "archives.json")), true);
  assert.equal(fs.existsSync(path.join(home, ".iris", "archives.json")), false);
});

test("IRIS_STATE_DIR가 없는 새 설치는 새 이름 폴더를 쓴다", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iris-archive-default-"));
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  writeArchive({ home, stateDir: null });

  assert.equal(fs.existsSync(path.join(home, ".iris", "archives.json")), true);
});

