// setup 6단계의 등록 판정. 조회 줄이 가리키는 파일이 실제로 있는지 확인한다.
//
// 소스 모양 검사(smoke)로는 "마지막 인자를 절대 경로일 때만 믿는다" 를 검사할 수 없다. 상대 경로를
// 믿으면 지금 폴더의 bin/iris-mcp.mjs 와 우연히 맞아 유효하지 않은 등록이 통과한다. 그래서 함수를
// 그대로 떼어 bash 로 돌린다.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const setupSh = fs.readFileSync(path.join(root, "scripts", "setup.sh"), "utf8");
const fn = setupSh.match(/^mcp_file_exists\(\) \{\n[\s\S]*?^\}\n/m)?.[0];

function judge(cwd, arg) {
  const r = spawnSync("bash", ["-c", `${fn}\nmcp_file_exists "$1"`, "_", arg], { cwd, encoding: "utf8" });
  return r.status === 0;
}

test("등록 판정은 절대 경로의 파일만 믿는다", (t) => {
  assert.ok(fn, "setup.sh 에서 mcp_file_exists 를 찾지 못했다");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-setup-judge-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const real = path.join(dir, "Iris checkout", "bin", "iris-mcp.mjs");   // 경로에 공백
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, "");
  // 지금 폴더에도 같은 상대 경로가 있다. 상대 경로를 믿으면 여기에 걸린다.
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "bin", "iris-mcp.mjs"), "");

  assert.equal(judge(dir, real), true, "공백이 든 절대 경로 하나");
  assert.equal(judge(dir, `--no-warnings ${path.join(dir, "bin", "iris-mcp.mjs")}`), true, "node 옵션 뒤의 절대 경로");
  assert.equal(judge(dir, "/nonexistent/checkout/bin/iris-mcp.mjs"), false, "없는 절대 경로");
  assert.equal(judge(dir, "--no-warnings /missing/Iris bin/iris-mcp.mjs"), false, "잘린 상대 경로는 지금 폴더의 파일과 맞아도 거짓");
  assert.equal(judge(dir, "bin/iris-mcp.mjs"), false, "상대 경로만 있어도 거짓");
});
