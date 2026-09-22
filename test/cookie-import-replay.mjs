import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");

function sqlite(file, sql) {
  return execFileSync("/usr/bin/sqlite3", [file], { input: sql, encoding: "utf8" });
}

test("CAS 없는 옛 merge replay는 최신 live 쿠키를 보존하고 폐기한다", (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "iris-cookie-replay-"));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));

  const target = path.join(userData, "Partitions", "acprof_test", "Network", "Cookies");
  const staging = path.join(userData, "cookie-import-staging", "import-test", "Cookies");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(path.dirname(staging), { recursive: true });
  const schema = "CREATE TABLE cookies(host_key TEXT,name TEXT,path TEXT,value BLOB,encrypted_value BLOB,UNIQUE(host_key,name,path));";
  sqlite(target, `${schema} INSERT INTO cookies VALUES('.example.com','renewed','/','latest',X''); INSERT INTO cookies VALUES('.example.com','failed','/','old',X'');`);
  sqlite(staging, `${schema} INSERT INTO cookies VALUES('.example.com','failed','/','imported',X'');`);
  fs.writeFileSync(path.join(userData, "cookie-import-staging", "pending.json"), JSON.stringify([
    { mode: "merge", target, staging },
  ]));

  const Module = require("node:module");
  const originalLoad = Module._load;
  let sessionCalls = 0;
  Module._load = function mockedLoad(request, parent, isMain) {
    if (request === "electron") {
      return {
        app: { getPath: () => userData },
        dialog: {},
        session: { fromPartition: () => { sessionCalls += 1; throw new Error("session before ready"); } },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve("../native/electron/cookie-import.cjs")];
    require("../native/electron/cookie-import.cjs");
  } finally {
    Module._load = originalLoad;
  }

  const rows = sqlite(target, "SELECT name||'='||CAST(value AS TEXT) FROM cookies ORDER BY name;").trim().split("\n");
  assert.deepEqual(rows, ["failed=old", "renewed=latest"]);
  assert.equal(sessionCalls, 0);
  assert.equal(fs.existsSync(staging), false);
  assert.equal(fs.existsSync(path.join(userData, "cookie-import-staging", "pending.json")), false);
});
