import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
function requireLf(files) {
  const values = execFileSync("git", ["check-attr", "-z", "--stdin", "text", "eol"], {
    cwd: root, input: files.join("\0") + "\0", encoding: "utf8",
  }).split("\0");
  assert.equal(values.pop(), "");
  assert.equal(values.length, files.length * 6);
  for (let i = 0; i < values.length; i += 3) {
    assert.equal(values[i + 2], values[i + 1] === "eol" ? "lf" : "set", `${values[i]}: ${values[i + 1]}`);
  }
}

test("소스·셸·PowerShell·패치는 autocrlf와 무관하게 LF로 체크아웃한다", () => {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0");
  const files = tracked.filter(file => /\.(?:[cm]?js|sh|ps1|patch)$/.test(file) || file === "setup");
  for (const file of ["server/index.js", "native/electron/main.cjs", "scripts/build-vendor.mjs", "scripts/setup.sh", "scripts/setup-win.ps1", "patches/node-pty@1.1.0.patch", "setup"]) {
    assert.ok(files.includes(file), file);
  }
  requireLf(files);
});

test("줄바꿈 검사는 하위 경로의 CRLF 재정의를 감지한다", (t) => {
  const parent = path.join(root, ".working", "windows-r5");
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, "checkout-"));
  const attrs = path.join(dir, ".gitattributes");
  t.after(() => { fs.unlinkSync(attrs); fs.rmdirSync(dir); });
  const file = path.relative(root, path.join(dir, "fixture.mjs")).split(path.sep).join("/");
  fs.writeFileSync(attrs, "*.mjs text eol=crlf\n");
  assert.throws(() => requireLf([file]), /fixture\.mjs: eol/);
  fs.writeFileSync(attrs, "*.mjs text eol=lf\n");
  requireLf([file]);
});
