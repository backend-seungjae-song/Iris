import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// iOS 앱 도구가 ~/.local/bin/idb 하나만 실행하면 pip --user·Homebrew Python 으로 설치한 idb 를 못 찾는다.
const { idbPath, IDB_MISSING } = await import("../bin/mcp/idb-path.mjs");

function fakeHome(rel) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "iris-idb-"));
  if (rel) { const p = path.join(home, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, "#!/bin/sh\n", { mode: 0o755 }); }
  return home;
}

test("pip --user 로 설치한 idb(~/Library/Python/<버전>/bin)를 찾는다", () => {
  const home = fakeHome("Library/Python/3.12/bin/idb");
  assert.equal(idbPath({ HOME: home, PATH: "" }), path.join(home, "Library/Python/3.12/bin/idb"));
});

test("PATH 에 있는 idb 를 찾는다", () => {
  const home = fakeHome("tools/bin/idb");
  assert.equal(idbPath({ HOME: path.join(home, "none"), PATH: `/nonexistent:${path.join(home, "tools/bin")}` }), path.join(home, "tools/bin/idb"));
});

test("IRIS_IDB 가 가장 먼저다", () => {
  const home = fakeHome(".local/bin/idb");
  const own = path.join(fakeHome("x/idb"), "x/idb");
  assert.equal(idbPath({ HOME: home, PATH: "", IRIS_IDB: own }), own);
});

test("앱 도구는 고정 경로 대신 idbPath 를 쓰고, 없으면 설치 안내를 돌려준다", () => {
  const src = fs.readFileSync(new URL("../bin/mcp/app.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /"\.local", "bin", "idb"/);
  assert.match(src, /const bin = idbPath\(\);\s*\n\s*if \(!bin\) \{ resolve\(\{ ok: false, out: "", err: IDB_MISSING \}\)/);
  assert.match(IDB_MISSING, /pipx install fb-idb/);
});
