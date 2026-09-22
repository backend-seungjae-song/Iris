import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sqlite = (file, sql) => execFileSync("/usr/bin/sqlite3", [file], { input: sql, encoding: "utf8" });

test("CAS 없는 옛 전체 replace manifest는 적용하지 않고 폐기한다", (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "iris-cookie-replace-"));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const target = path.join(userData, "Partitions", "acprof_test", "Network", "Cookies");
  const staging = path.join(userData, "cookie-import-staging", "import-test", "Cookies");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(path.dirname(staging), { recursive: true });
  const schema = "CREATE TABLE cookies(host_key TEXT,name TEXT,path TEXT,value BLOB,encrypted_value BLOB,UNIQUE(host_key,name,path));";
  sqlite(target, `${schema} INSERT INTO cookies VALUES('.example.com','old-login','/','old',X''); INSERT INTO cookies VALUES('.other.test','unrelated','/','old',X'');`);
  // 실제 stageCookieRows 결과처럼 source cohort와 보존할 로컬 target-bound 행이 한 DB에 들어 있다.
  sqlite(staging, `${schema} INSERT INTO cookies VALUES('.example.com','session','/','source',X''); INSERT INTO cookies VALUES('.example.com','cf_clearance','/','local',X'');`);
  fs.writeFileSync(path.join(userData, "cookie-import-staging", "pending.json"), JSON.stringify([
    { mode: "replace", target, staging },
  ]));

  const Module = require("node:module");
  const originalLoad = Module._load;
  Module._load = function mockedLoad(request, parent, isMain) {
    if (request === "electron") return {
      app: { getPath: () => userData }, dialog: {},
      session: { fromPartition: () => { throw new Error("session before ready"); } },
    };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve("../native/electron/cookie-import.cjs")];
    require("../native/electron/cookie-import.cjs");
  } finally { Module._load = originalLoad; }

  const rows = sqlite(target, "SELECT name||'='||CAST(value AS TEXT) FROM cookies ORDER BY name;").trim().split("\n");
  assert.deepEqual(rows, ["old-login=old", "unrelated=old"]);
  assert.equal(fs.existsSync(staging), false);
  assert.equal(fs.existsSync(path.join(userData, "cookie-import-staging", "pending.json")), false);
});

test("handoff fallback은 지정 사이트 한 벌만 교체하고 다른 로그인은 보존한다", (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "iris-cookie-scoped-replace-"));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const target = path.join(userData, "Partitions", "acprof_test", "Network", "Cookies");
  const staging = path.join(userData, "cookie-import-staging", "import-test", "Cookies");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(path.dirname(staging), { recursive: true });
  const schema = "CREATE TABLE cookies(host_key TEXT,name TEXT,path TEXT,value BLOB,encrypted_value BLOB,UNIQUE(host_key,name,path));";
  sqlite(target, `${schema}
    INSERT INTO cookies VALUES('.example.com','old-login','/','old',X'');
    INSERT INTO cookies VALUES('.sub.example.com','missing-from-source','/','old',X'');
    INSERT INTO cookies VALUES('.other.test','unrelated','/','keep',X'');`);
  // stageCookieRows가 만든 것처럼 source cohort와 해당 scope의 로컬 target-bound 행만 둔다.
  sqlite(staging, `${schema}
    INSERT INTO cookies VALUES('.example.com','session','/','source',X'');
    INSERT INTO cookies VALUES('.example.com','cf_clearance','/','local',X'');
    CREATE TABLE iris_cookie_import_baseline(host_key TEXT,name TEXT,path TEXT,value BLOB,encrypted_value BLOB);
    INSERT INTO iris_cookie_import_baseline VALUES('.example.com','old-login','/','old',X'');
    INSERT INTO iris_cookie_import_baseline VALUES('.sub.example.com','missing-from-source','/','old',X'');`);
  fs.writeFileSync(path.join(userData, "cookie-import-staging", "pending.json"), JSON.stringify([
    { mode: "replace-scoped", scopes: ["example.com"], cas: true, target, staging },
  ]));

  const Module = require("node:module");
  const originalLoad = Module._load;
  Module._load = function mockedLoad(request, parent, isMain) {
    if (request === "electron") return {
      app: { getPath: () => userData }, dialog: {},
      session: { fromPartition: () => { throw new Error("session before ready"); } },
    };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve("../native/electron/cookie-import.cjs")];
    require("../native/electron/cookie-import.cjs");
  } finally { Module._load = originalLoad; }

  const rows = sqlite(target,
    "SELECT host_key||'|'||name||'='||CAST(value AS TEXT) FROM cookies ORDER BY host_key,name;").trim().split("\n");
  assert.deepEqual(rows, [
    ".example.com|cf_clearance=local",
    ".example.com|session=source",
    ".other.test|unrelated=keep",
  ]);
});

test("handoff fallback은 스테이징 뒤 바뀐 Iris 로그인을 덮지 않는다", (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "iris-cookie-scoped-cas-"));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const target = path.join(userData, "Partitions", "acprof_test", "Network", "Cookies");
  const staging = path.join(userData, "cookie-import-staging", "import-test", "Cookies");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(path.dirname(staging), { recursive: true });
  const schema = "CREATE TABLE cookies(host_key TEXT,name TEXT,path TEXT,value BLOB,encrypted_value BLOB,UNIQUE(host_key,name,path));";
  // baseline은 stageCookieRows가 복제 직후 본 상태다.
  sqlite(staging, `${schema}
    INSERT INTO cookies VALUES('.example.com','session','/','chrome',X'');
    CREATE TABLE iris_cookie_import_baseline(host_key TEXT,name TEXT,path TEXT,value BLOB,encrypted_value BLOB);
    INSERT INTO iris_cookie_import_baseline VALUES('.example.com','session','/','old-iris',X'');`);
  // 재시작 전 사용자가 Iris에서 독립 로그인해 값이 달라졌다.
  sqlite(target, `${schema}
    INSERT INTO cookies VALUES('.example.com','session','/','new-iris',X'');
    INSERT INTO cookies VALUES('.other.test','unrelated','/','keep',X'');`);
  fs.writeFileSync(path.join(userData, "cookie-import-staging", "pending.json"), JSON.stringify([
    { mode: "replace-scoped", scopes: ["example.com"], cas: true, target, staging },
  ]));

  const Module = require("node:module");
  const originalLoad = Module._load;
  Module._load = function mockedLoad(request, parent, isMain) {
    if (request === "electron") return {
      app: { getPath: () => userData }, dialog: {},
      session: { fromPartition: () => { throw new Error("session before ready"); } },
    };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve("../native/electron/cookie-import.cjs")];
    require("../native/electron/cookie-import.cjs");
  } finally { Module._load = originalLoad; }

  const rows = sqlite(target,
    "SELECT host_key||'|'||name||'='||CAST(value AS TEXT) FROM cookies ORDER BY host_key,name;").trim().split("\n");
  assert.deepEqual(rows, [
    ".example.com|session=new-iris",
    ".other.test|unrelated=keep",
  ]);
  assert.equal(fs.existsSync(staging), false, "stale staging DB를 폐기하지 않았다");
  assert.equal(fs.existsSync(path.join(userData, "cookie-import-staging", "pending.json")), false,
    "stale staging manifest를 폐기하지 않았다");
});

test("replay INSERT가 schema drift로 실패하면 앞선 DELETE도 rollback한다", (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "iris-cookie-schema-drift-"));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const target = path.join(userData, "Partitions", "acprof_test", "Network", "Cookies");
  const staging = path.join(userData, "cookie-import-staging", "import-test", "Cookies");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(path.dirname(staging), { recursive: true });
  const oldSchema = "CREATE TABLE cookies(host_key TEXT,name TEXT,path TEXT,value BLOB,encrypted_value BLOB,UNIQUE(host_key,name,path));";
  const newSchema = "CREATE TABLE cookies(host_key TEXT,name TEXT,path TEXT,value BLOB,encrypted_value BLOB,new_required INTEGER NOT NULL DEFAULT 7,UNIQUE(host_key,name,path));";
  sqlite(staging, `${oldSchema}
    INSERT INTO cookies VALUES('.example.com','session','/','chrome',X'');
    CREATE TABLE iris_cookie_import_baseline(host_key TEXT,name TEXT,path TEXT,value BLOB,encrypted_value BLOB);
    INSERT INTO iris_cookie_import_baseline VALUES('.example.com','session','/','old-iris',X'');`);
  sqlite(target, `${newSchema}
    INSERT INTO cookies(host_key,name,path,value,encrypted_value) VALUES('.example.com','session','/','old-iris',X'');`);
  fs.writeFileSync(path.join(userData, "cookie-import-staging", "pending.json"), JSON.stringify([
    { mode: "replace", cas: true, target, staging },
  ]));

  const Module = require("node:module");
  const originalLoad = Module._load;
  Module._load = function mockedLoad(request, parent, isMain) {
    if (request === "electron") return {
      app: { getPath: () => userData }, dialog: {},
      session: { fromPartition: () => { throw new Error("session before ready"); } },
    };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve("../native/electron/cookie-import.cjs")];
    require("../native/electron/cookie-import.cjs");
  } finally { Module._load = originalLoad; }

  const rows = sqlite(target, "SELECT name||'='||CAST(value AS TEXT) FROM cookies;").trim().split("\n");
  assert.deepEqual(rows, ["session=old-iris"], "INSERT 실패 전 DELETE가 커밋됐다");
  const pending = JSON.parse(fs.readFileSync(path.join(userData, "cookie-import-staging", "pending.json"), "utf8"));
  assert.equal(pending[0].attempts, 1, "실패한 재생을 성공이나 stale로 폐기했다");
  assert.equal(fs.existsSync(staging), true, "재시도할 staging을 조기에 지웠다");
});

test("pending target Cookies symlink는 외부 DB에 쓰지 않고 staging과 함께 폐기한다", (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "iris-cookie-symlink-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "iris-cookie-outside-"));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const externalDb = path.join(outside, "Chrome-Cookies");
  const target = path.join(userData, "Partitions", "acprof_test", "Network", "Cookies");
  const staging = path.join(userData, "cookie-import-staging", "import-test", "Cookies");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(path.dirname(staging), { recursive: true });
  const schema = "CREATE TABLE cookies(host_key TEXT,name TEXT,path TEXT,value BLOB,encrypted_value BLOB,UNIQUE(host_key,name,path));";
  sqlite(externalDb, `${schema} INSERT INTO cookies VALUES('.example.com','external','/','untouched',X'');`);
  fs.symlinkSync(externalDb, target);
  sqlite(staging, `${schema}
    INSERT INTO cookies VALUES('.example.com','session','/','source',X'');
    CREATE TABLE iris_cookie_import_baseline(host_key TEXT,name TEXT,path TEXT,value BLOB,encrypted_value BLOB);
    INSERT INTO iris_cookie_import_baseline VALUES('.example.com','external','/','untouched',X'');`);
  fs.writeFileSync(path.join(userData, "cookie-import-staging", "pending.json"), JSON.stringify([
    { mode: "replace", cas: true, target, staging },
  ]));

  const Module = require("node:module");
  const originalLoad = Module._load;
  Module._load = function mockedLoad(request, parent, isMain) {
    if (request === "electron") return {
      app: { getPath: () => userData }, dialog: {},
      session: { fromPartition: () => { throw new Error("session before ready"); } },
    };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve("../native/electron/cookie-import.cjs")];
    require("../native/electron/cookie-import.cjs");
  } finally { Module._load = originalLoad; }

  assert.deepEqual(sqlite(externalDb, "SELECT name||'='||CAST(value AS TEXT) FROM cookies;").trim().split("\n"),
    ["external=untouched"]);
  assert.equal(fs.existsSync(staging), false);
  assert.equal(fs.existsSync(path.join(userData, "cookie-import-staging", "pending.json")), false);
});
