import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const { cookieKey, cookieFingerprint } = require("../native/electron/cookie-sync-policy.cjs");

function cookie(name, value, domain = ".example.com") {
  return { name, value, domain, path: "/", secure: true, httpOnly: true, sameSite: "unspecified" };
}

function loadImporter(before, { failOnce, rawStore = false } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "iris-cookie-atomic-"));
  const jar = new Map(before.map((item) => [cookieKey(item), item]));
  let failed = false;
  const listeners = {};
  let getCount = 0;
  const onGet = new Map();
  const cookies = {
    get: async () => {
      getCount += 1;
      const result = [...jar.values()];
      const callback = onGet.get(getCount); onGet.delete(getCount);
      if (callback) callback();
      return result;
    },
    set: async (details) => {
      if (details.name === failOnce && !failed) { failed = true; throw new Error("set rejected"); }
      const item = { ...details, domain: details.domain || new URL(details.url).hostname };
      delete item.url;
      jar.set(cookieKey(item), item);
    },
    remove: async (url, name) => {
      const host = new URL(url).hostname;
      for (const [key, item] of jar) if (item.name === name && item.domain.replace(/^\./, "") === host) jar.delete(key);
    },
    flushStore: async () => {},
  };
  const webRequest = {};
  for (const name of ["onBeforeRequest", "onHeadersReceived", "onCompleted", "onErrorOccurred"]) {
    webRequest[name] = (_filter, listener) => { listeners[name] = listener; };
  }
  const storagePath = rawStore ? path.join(userData, "Partitions", "acprof_test") : null;
  let cookiesPath = null;
  if (storagePath) {
    cookiesPath = path.join(storagePath, "Network", "Cookies");
    fs.mkdirSync(path.dirname(cookiesPath), { recursive: true });
    const schema = "CREATE TABLE cookies(host_key TEXT,name TEXT,path TEXT,value BLOB,encrypted_value BLOB,UNIQUE(host_key,name,path));";
    const rows = before.map((item) => `INSERT INTO cookies VALUES('${item.domain.replace(/'/g, "''")}','${item.name.replace(/'/g, "''")}','/','${item.value.replace(/'/g, "''")}',X'');`).join("");
    execFileSync("/usr/bin/sqlite3", [cookiesPath], { input: schema + rows });
  }
  const sess = { cookies, webRequest, storagePath };
  const reload = () => {
    const originalLoad = Module._load;
    Module._load = function mockedLoad(request, parent, isMain) {
      if (request === "electron") return {
        app: { getPath: () => userData }, dialog: {}, session: { fromPartition: () => sess },
      };
      return originalLoad.call(this, request, parent, isMain);
    };
    try {
      delete require.cache[require.resolve("../native/electron/cookie-import.cjs")];
      return require("../native/electron/cookie-import.cjs");
    } finally { Module._load = originalLoad; }
  };
  const importer = reload();
  return { importer, jar, userData, cookiesPath,
    setOnGet: (callback) => { onGet.set(getCount + 1, callback); },
    setOnGetAt: (index, callback) => { onGet.set(index, callback); },
    reload,
    cleanup: () => fs.rmSync(userData, { recursive: true, force: true }) };
}

test("handoff live cohort rolls back every cookie when one set fails", async (t) => {
  const h = loadImporter([cookie("SID", "old"), cookie("legacy", "keep")], { failOnce: "HSID" });
  t.after(h.cleanup);
  const result = await h.importer.putCookies("persist:acprof:test", [cookie("SID", "new"), cookie("HSID", "new")]);
  assert.equal(result.live, 0);
  assert.deepEqual([...h.jar.values()].map((item) => [item.name, item.value]).sort(), [
    ["SID", "old"], ["legacy", "keep"],
  ]);
});

test("handoff replacement keeps local Cloudflare and Google integrity cookies", async (t) => {
  const h = loadImporter([
    cookie("SID", "old", ".google.com"),
    cookie("SIDCC", "local", ".google.com"),
    cookie("cf_clearance", "local"),
    cookie("legacy", "remove"),
  ]);
  t.after(h.cleanup);
  const result = await h.importer.putCookies("persist:acprof:test", [
    cookie("SID", "new", ".google.com"), cookie("session", "new"),
  ]);
  assert.equal(result.live, 2);
  assert.deepEqual([...h.jar.values()].map((item) => [item.name, item.value]).sort(), [
    ["SID", "new"], ["SIDCC", "local"], ["cf_clearance", "local"], ["session", "new"],
  ]);
});

test("handoff source 연결이 바뀌면 snapshot 안에서 재검사하고 쓰지 않는다", async (t) => {
  const h = loadImporter([cookie("SID", "old"), cookie("legacy", "keep")]);
  t.after(h.cleanup);
  const result = await h.importer.putCookies("persist:acprof:test", [cookie("SID", "new")], {
    isCurrent: () => false,
  });
  assert.equal(result.error, "source-link-changed");
  assert.equal(result.rolledBack, true);
  assert.deepEqual([...h.jar.values()].map((item) => [item.name, item.value]).sort(), [
    ["SID", "old"], ["legacy", "keep"],
  ]);
});

test("handoff 대기 중 Iris target 로그인이 바뀌면 snapshot 안에서 재검사하고 쓰지 않는다", async (t) => {
  const h = loadImporter([cookie("SID", "new-iris"), cookie("legacy", "keep")]);
  t.after(h.cleanup);
  const result = await h.importer.putCookies("persist:acprof:test", [cookie("SID", "chrome")], {
    expectedTargetFingerprint: "handoff-started-before-this-login",
  });
  assert.equal(result.error, "target-changed");
  assert.equal(result.rolledBack, true);
  assert.deepEqual([...h.jar.values()].map((item) => [item.name, item.value]).sort(), [
    ["SID", "new-iris"], ["legacy", "keep"],
  ]);
});

test("handoff raw fallback stages the whole scoped cohort after rolling live changes back", async (t) => {
  const before = [cookie("SID", "old"), cookie("legacy", "keep"), cookie("cf_clearance", "local")];
  const h = loadImporter(before, { failOnce: "HSID", rawStore: true });
  t.after(h.cleanup);
  const raw = (item) => ({ ...item, rawValue: Buffer.from(item.value), sourceRow: {
    host_key: item.domain, name: item.name, path: item.path, value: "", encrypted_value: Buffer.alloc(0),
  } });
  const result = await h.importer.putCookies("persist:acprof:test", [
    raw(cookie("SID", "new")), raw(cookie("HSID", "new")),
  ]);
  assert.equal(result.live, 0);
  assert.equal(result.staged, 2);
  assert.deepEqual([...h.jar.values()].map((item) => [item.name, item.value]).sort(), [
    ["SID", "old"], ["cf_clearance", "local"], ["legacy", "keep"],
  ]);
  const pending = JSON.parse(fs.readFileSync(path.join(h.userData, "cookie-import-staging", "pending.json"), "utf8"));
  assert.equal(pending.length, 1);
  assert.equal(pending[0].mode, "replace-scoped");
  assert.deepEqual(pending[0].scopes, ["example.com"]);
  assert.equal(pending[0].cas, true);
  const names = execFileSync("/usr/bin/sqlite3", [pending[0].staging], {
    input: "SELECT name FROM cookies ORDER BY name;", encoding: "utf8",
  }).trim().split("\n");
  assert.deepEqual(names, ["HSID", "SID", "cf_clearance"]);
  const baselineNames = execFileSync("/usr/bin/sqlite3", [pending[0].staging], {
    input: "SELECT name FROM iris_cookie_import_baseline ORDER BY name;", encoding: "utf8",
  }).trim().split("\n");
  assert.deepEqual(baselineNames, ["SID", "cf_clearance", "legacy"]);
});

test("handoff rollback과 staging 사이에 바뀐 target은 새 baseline으로 정당화하지 않는다", async (t) => {
  const before = [cookie("SID", "old"), cookie("legacy", "keep")];
  const h = loadImporter(before, { failOnce: "HSID", rawStore: true });
  t.after(h.cleanup);
  const raw = (item) => ({ ...item, rawValue: Buffer.from(item.value), sourceRow: {
    host_key: item.domain, name: item.name, path: item.path, value: "", encrypted_value: Buffer.alloc(0),
  } });
  // live snapshot의 before/current/restored 조회 다음, staging helper의 첫 target gate가 결과를
  // 반환한 직후 독립 Iris 로그인이 들어오는 경합을 재현한다.
  h.setOnGetAt(4, () => {
    h.jar.set(cookieKey(cookie("SID", "new-iris")), cookie("SID", "new-iris"));
    execFileSync("/usr/bin/sqlite3", [h.cookiesPath], {
      input: "UPDATE cookies SET value='new-iris' WHERE name='SID';",
    });
  });
  const result = await h.importer.putCookies("persist:acprof:test", [
    raw(cookie("SID", "chrome")), raw(cookie("HSID", "chrome")),
  ], { expectedTargetFingerprint: cookieFingerprint(before) });
  assert.equal(result.staged, 0);
  assert.equal(result.error, "cookie-transfer-failed");
  assert.equal(h.jar.get(cookieKey(cookie("SID", "x"))).value, "new-iris");
  assert.equal(fs.existsSync(path.join(h.userData, "cookie-import-staging", "pending.json")), false);
});

test("자동 refresh는 transfer 대기 중 회전한 Chrome source의 옛 snapshot을 적용하지 않는다", async (t) => {
  const h = loadImporter([cookie("session", "iris-old")]);
  t.after(h.cleanup);
  const source = path.join(h.userData, "Chrome Cookies");
  const schema = `CREATE TABLE cookies(
    host_key TEXT,name TEXT,path TEXT,value BLOB,encrypted_value BLOB,
    is_secure INTEGER,is_httponly INTEGER,samesite INTEGER,expires_utc INTEGER,
    UNIQUE(host_key,name,path));`;
  execFileSync("/usr/bin/sqlite3", [source], { input: `${schema}
    INSERT INTO cookies VALUES('.example.com','session','/','chrome-a',X'',1,1,0,0);` });
  h.setOnGet(() => execFileSync("/usr/bin/sqlite3", [source], {
    input: "UPDATE cookies SET value='chrome-b' WHERE name='session';",
  }));
  const result = await h.importer.refreshFromChrome({
    dbPath: source, profile: "Default", browser: { id: "chrome", service: "Chrome Safe Storage", account: "Chrome" },
  }, "persist:acprof:test", (domain) => String(domain).replace(/^\./, "") === "example.com", {
    base: "example.com", recovering: true,
  });
  assert.equal(result.changed, 0);
  assert.equal(result.skipped, "source-changed");
  assert.deepEqual([...h.jar.values()].map((item) => [item.name, item.value]), [["session", "iris-old"]]);
});

test("자동 refresh live 적용 실패는 최신 raw cohort 전체를 scoped CAS staging한다", async (t) => {
  const h = loadImporter([cookie("session", "iris-old")], { failOnce: "session", rawStore: true });
  t.after(h.cleanup);
  const source = path.join(h.userData, "Chrome Cookies");
  const schema = `CREATE TABLE cookies(
    host_key TEXT,name TEXT,path TEXT,value BLOB,encrypted_value BLOB,
    is_secure INTEGER,is_httponly INTEGER,samesite INTEGER,expires_utc INTEGER,
    UNIQUE(host_key,name,path));`;
  execFileSync("/usr/bin/sqlite3", [source], { input: `${schema}
    INSERT INTO cookies VALUES('.example.com','session','/','chrome-new',X'',1,1,0,0);` });
  const result = await h.importer.refreshFromChrome({
    dbPath: source, profile: "Default", browser: { id: "chrome", service: "Chrome Safe Storage", account: "Chrome" },
  }, "persist:acprof:test", (domain) => String(domain).replace(/^\./, "") === "example.com", {
    base: "example.com", recovering: true,
  });
  assert.deepEqual({ changed: result.changed, live: result.live, staged: result.staged, reason: result.reason },
    { changed: 0, live: 0, staged: 1, reason: "staged" });
  assert.deepEqual([...h.jar.values()].map((item) => [item.name, item.value]), [["session", "iris-old"]]);
  const pending = JSON.parse(fs.readFileSync(path.join(h.userData, "cookie-import-staging", "pending.json"), "utf8"));
  assert.equal(pending[0].mode, "replace-scoped");
  assert.equal(pending[0].cas, true);
  assert.deepEqual(pending[0].scopes, ["example.com"]);
});

test("자동 staged A를 재생한 뒤 Chrome source B가 오면 provenance가 다음 refresh를 허용한다", async (t) => {
  const h = loadImporter([cookie("session", "iris-old")], { failOnce: "session", rawStore: true });
  t.after(h.cleanup);
  const source = path.join(h.userData, "Chrome Cookies");
  const schema = `CREATE TABLE cookies(
    host_key TEXT,name TEXT,path TEXT,value BLOB,encrypted_value BLOB,
    is_secure INTEGER,is_httponly INTEGER,samesite INTEGER,expires_utc INTEGER,
    UNIQUE(host_key,name,path));`;
  execFileSync("/usr/bin/sqlite3", [source], { input: `${schema}
    INSERT INTO cookies VALUES('.example.com','session','/','chrome-a',X'',1,1,0,0);` });
  const entry = {
    dbPath: source, profile: "Default", browser: { id: "chrome", service: "Chrome Safe Storage", account: "Chrome" },
  };
  const inScope = (domain) => String(domain).replace(/^\./, "") === "example.com";
  const staged = await h.importer.refreshFromChrome(entry, "persist:acprof:test", inScope, {
    base: "example.com", recovering: true,
  });
  assert.equal(staged.staged, 1);

  // 새 프로세스의 module-load replay를 같은 격리 DB에서 수행하고 mock jar도 그 결과로 다시 연다.
  const importerAfterReplay = h.reload();
  const replayed = execFileSync("/usr/bin/sqlite3", [h.cookiesPath], {
    input: "SELECT CAST(value AS TEXT) FROM cookies WHERE name='session';", encoding: "utf8",
  }).trim();
  assert.equal(replayed, "chrome-a");
  h.jar.set(cookieKey(cookie("session", "chrome-a")), cookie("session", "chrome-a"));
  execFileSync("/usr/bin/sqlite3", [source], {
    input: "UPDATE cookies SET value='chrome-b' WHERE name='session';",
  });

  const refreshed = await importerAfterReplay.refreshFromChrome(entry, "persist:acprof:test", inScope, {
    base: "example.com", recovering: false,
  });
  assert.equal(refreshed.changed, 1);
  assert.equal(h.jar.get(cookieKey(cookie("session", "x"))).value, "chrome-b");
});
