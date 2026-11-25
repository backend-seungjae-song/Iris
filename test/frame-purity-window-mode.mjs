import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("메모 창 모드를 허용해도 같은 셸 파일의 메모 기능 참조는 검출한다", t => {
  const root = mkdtempSync(path.join(tmpdir(), "iris-frame-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "web/js/core"), { recursive: true });
  mkdirSync(path.join(root, "bin"));
  cpSync(new URL("../bin/frame-purity.mjs", import.meta.url), path.join(root, "bin/frame-purity.mjs"));
  writeFileSync(path.join(root, "web/index.html"), "");
  writeFileSync(path.join(root, "web/js/core/capabilities.js"), 'export const capabilities = [{ id: "memo" }];');
  const modes = 'const MEMO_MODE = APP_PARAMS.get("mode") === "memo";\nconst WINDOW_MODE = BROWSER_MODE ? "browser" : (MEMO_MODE ? "memo" : "main");';
  const run = source => {
    writeFileSync(path.join(root, "web/js/main.js"), source);
    return spawnSync(process.execPath, ["bin/frame-purity.mjs", "--check"], { cwd: root }).status;
  };
  assert.equal(run(modes), 0);
  assert.equal(run(modes + '\nloadFeature("memo");'), 1);
});
