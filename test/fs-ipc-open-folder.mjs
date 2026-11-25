import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createFsIpc } = require("../native/electron/fs-ipc.cjs");

function setup({ trusted = true, home } = {}) {
  const opened = [];
  const handle = new Map();
  createFsIpc({
    ipcMain: { on: () => {}, handle: (name, fn) => handle.set(name, fn) },
    shell: { showItemInFolder: () => {}, trashItem: async () => {}, openPath: async (p) => { opened.push(p); return ""; } },
    fs, path,
    os: { homedir: () => home },
    isTrustedSender: () => trusted,
  });
  return { open: handle.get("ac-open-folder"), opened };
}

test("폴더 경로는 그 폴더를 창으로 열고 열었다고 답한다", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-open-folder-"));
  try {
    const sub = path.join(dir, "하위 폴더");
    fs.mkdirSync(sub);
    const file = path.join(dir, "report.md");
    fs.writeFileSync(file, "x");
    const { open, opened } = setup({ home: dir });
    assert.ok(open, "ac-open-folder 를 걸어야 함");
    assert.equal(await open({}, sub), true);
    assert.equal(await open({}, sub + "/"), true, "끝 / 가 있어도 폴더");
    assert.equal(await open({}, "~/하위 폴더"), true, "~ 를 홈으로");
    assert.deepEqual(opened, [sub, sub, sub]);
    assert.equal(await open({}, file), false, "파일은 열지 않고 아니라고 답함(호출부가 파일로 엶)");
    assert.equal(await open({}, path.join(dir, "없음")), false);
    assert.equal(await open({}, "하위 폴더"), false, "상대 경로");
    assert.equal(opened.length, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("신뢰하지 않는 발신자는 폴더를 열지 않는다", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-open-folder-"));
  try {
    const { open, opened } = setup({ trusted: false, home: dir });
    assert.equal(await open({}, dir), false);
    assert.deepEqual(opened, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
