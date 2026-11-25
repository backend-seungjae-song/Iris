import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const integration = fileURLToPath(new URL("../scripts/templates/terminal-agents.zsh", import.meta.url));

test("셸 설정을 다시 읽어도 기존 CLI 함수의 인수와 종료 상태가 유지된다", {
  skip: process.platform !== "darwin",
}, () => {
  for (const name of ["codex", "claude", "agy"]) {
    const child = spawnSync("/bin/zsh", ["-fc", `
      functions[$2]='print -r -- "$#" "$1"; return 17'
      source "$1"
      source "$1"
      "$2" "argument with spaces"
    `, "zsh", integration, name], { encoding: "utf8" });
    assert.equal(child.stdout.trim(), "1 argument with spaces", name);
    assert.equal(child.status, 17, name);
  }
});
