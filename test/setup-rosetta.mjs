// setup 1단계. Rosetta 로 연 터미널에서는 Apple Silicon 맥도 uname -m 이 x86_64 라
// "Apple Silicon 이 필요합니다" 로 멈추면 사용자가 고칠 방법을 모른다.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

function runCheck(translated) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "iris-setup-rosetta-"));
  fs.writeFileSync(path.join(bin, "uname"), '#!/bin/sh\n[ "$1" = "-m" ] && { echo x86_64; exit 0; }\nexec /usr/bin/uname "$@"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "sysctl"), `#!/bin/sh\n[ "$2" = "sysctl.proc_translated" ] && { echo ${translated}; exit 0; }\nexec /usr/sbin/sysctl "$@"\n`, { mode: 0o755 });
  const r = spawnSync("bash", [path.join(root, "scripts", "setup.sh"), "--check"], {
    cwd: root, encoding: "utf8", input: "", timeout: 30000,
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin:/usr/sbin` },
  });
  fs.rmSync(bin, { recursive: true, force: true });
  return r;
}

test("Rosetta 터미널이면 그 사실과 끄는 방법을 알린다", { skip: process.platform !== "darwin" }, () => {
  const r = runCheck(1);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Rosetta/);
  assert.doesNotMatch(r.stdout, /Apple Silicon\(M1 이상\) 맥이 필요합니다/);
});

test("인텔 맥이면 그대로 Apple Silicon 이 필요하다고 알린다", { skip: process.platform !== "darwin" }, () => {
  const r = runCheck(0);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Apple Silicon\(M1 이상\) 맥이 필요합니다/);
});
