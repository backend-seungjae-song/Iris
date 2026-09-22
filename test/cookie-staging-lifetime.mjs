// 스테이징 쿠키 DB는 오래 남지 않는다.
// 그 파일은 복호화된 쿠키 값을 평문으로 들고 있고(sqlite3가 ATTACH로 읽어야 해서 암호화할 수 없다),
// 재생이 실패한 항목이 계속 남으면 실행할 때마다 재시도하면서 평문이 디스크에 머문다.
// 그래서 하루가 지나거나 세 번 실패하면 버린다.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sqlite = (file, sql) => execFileSync("/usr/bin/sqlite3", [file], { input: sql, encoding: "utf8" });
const SCHEMA = "CREATE TABLE cookies(host_key TEXT,name TEXT,path TEXT,value BLOB,encrypted_value BLOB,UNIQUE(host_key,name,path));";

function loadWithUserData(userData) {
  const Module = require("node:module");
  const originalLoad = Module._load;
  Module._load = function mockedLoad(request, parent, isMain) {
    if (request === "electron") return { app: { getPath: () => userData }, dialog: {}, session: { fromPartition: () => { throw new Error("session before ready"); } } };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve("../native/electron/cookie-import.cjs")];
    require("../native/electron/cookie-import.cjs");
  } finally { Module._load = originalLoad; }
}

function makeCase(t, { stagingSql, createdAt, attempts }) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "iris-staging-"));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const target = path.join(userData, "Partitions", "acprof_test", "Network", "Cookies");
  const staging = path.join(userData, "cookie-import-staging", "import-test", "Cookies");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(path.dirname(staging), { recursive: true });
  sqlite(target, `${SCHEMA} INSERT INTO cookies VALUES('.example.com','live','/','keep',X'');`);
  sqlite(staging, stagingSql);
  const entry = { mode: "replace", cas: true, target, staging };
  if (createdAt != null) entry.createdAt = createdAt;
  if (attempts != null) entry.attempts = attempts;
  fs.writeFileSync(path.join(userData, "cookie-import-staging", "pending.json"), JSON.stringify([entry]));
  const manifest = path.join(userData, "cookie-import-staging", "pending.json");
  return { userData, target, staging, manifest };
}

test("하루가 지난 스테이징은 재생하지 않고 버린다", (t) => {
  const c = makeCase(t, {
    stagingSql: `${SCHEMA} INSERT INTO cookies VALUES('.example.com','stale','/','old',X'');`,
    createdAt: Date.now() - 25 * 60 * 60 * 1000,
  });
  loadWithUserData(c.userData);
  assert.equal(fs.existsSync(c.staging), false, "만료된 평문 스테이징이 남았다");
  assert.equal(fs.existsSync(c.manifest), false, "만료 항목이 manifest에 남았다");
  const rows = sqlite(c.target, "SELECT name FROM cookies;").trim().split("\n");
  assert.deepEqual(rows, ["live"], "만료된 항목을 대상 DB에 병합했다");
});

test("세 번 실패하면 스테이징을 버린다", (t) => {
  // cookies 테이블이 없는 DB. replay의 INSERT가 실패한다.
  const c = makeCase(t, { stagingSql: "CREATE TABLE other(x TEXT);", createdAt: Date.now(), attempts: 0 });
  loadWithUserData(c.userData);
  let entries = JSON.parse(fs.readFileSync(c.manifest, "utf8"));
  assert.equal(entries[0].attempts, 1, "첫 실패가 세어지지 않았다");
  loadWithUserData(c.userData);
  entries = JSON.parse(fs.readFileSync(c.manifest, "utf8"));
  assert.equal(entries[0].attempts, 2, "두 번째 실패가 세어지지 않았다");
  loadWithUserData(c.userData);
  assert.equal(fs.existsSync(c.manifest), false, "세 번 실패했는데 항목이 남았다");
  assert.equal(fs.existsSync(c.staging), false, "세 번 실패했는데 평문 스테이징이 남았다");
});
