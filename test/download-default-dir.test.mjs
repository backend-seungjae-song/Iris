import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createDownloadHook } = require("../native/electron/download-hook.cjs");

// 사람이 시작한 내려받기마다 저장 창이 떠서 이름을 정해야 했음(사용자 2026-10-29). 다운로드 폴더에 바로 저장

function harness({ dir = "", ai = false, existing = [] } = {}) {
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), "iris-dl-"));
  for (const name of existing) fs.writeFileSync(path.join(downloads, name), "x");
  const notices = [];
  const host = { isDestroyed: () => false, send: (ch, payload) => notices.push([ch, payload]) };
  const sess = new EventEmitter();
  const hook = createDownloadHook({
    fs, path, allWindows: () => [],
    downloadState: { snapshot: () => ({ dir }), claim() {}, complete() {} },
    aiDriving: () => ai,
    downloadsDir: () => downloads,
  });
  hook.installDownloadHook(sess);
  const start = (url, filename) => {
    const item = Object.assign(new EventEmitter(), {
      savePath: "", cancelled: false,
      getURL: () => url, getFilename: () => filename, getTotalBytes: () => 1,
      setSavePath(p) { this.savePath = p; }, getSavePath() { return this.savePath; },
      cancel() { this.cancelled = true; },
    });
    sess.emit("will-download", {}, item, { id: 3, isDestroyed: () => false, hostWebContents: host });
    return item;
  };
  return { hook, start, downloads, notices };
}

test("사람이 시작한 내려받기는 저장 창 없이 다운로드 폴더에 저장", () => {
  const { start, downloads, notices } = harness({ existing: ["report.pdf"] });
  const item = start("https://example.com/report.pdf", "report.pdf");
  assert.equal(item.savePath, path.join(downloads, "report (1).pdf"), "같은 이름 파일은 덮어쓰지 않음");
  item.emit("done", {}, "completed");
  assert.ok(notices.some(([ch, p]) => ch === "ac-native-notice" && p.text.includes("report (1).pdf")), "저장 위치를 알림");
});

test("「다른 이름으로 저장」은 저장 창을 그대로 띄움", () => {
  const { hook, start } = harness();
  hook.noteExplicitSave("https://example.com/cat.png");
  assert.equal(start("https://example.com/cat.png", "cat.png").savePath, "");
});

test("저장 위치를 정한 자동화 내려받기는 그 위치에 저장", () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "iris-dl-set-"));
  const { start } = harness({ dir: target, ai: true });
  assert.equal(start("https://example.com/a.csv", "a.csv").savePath, path.join(target, "a.csv"));
});
