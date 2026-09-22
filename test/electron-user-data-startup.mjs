import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const mainPath = path.join(root, "native/electron/main.cjs");
const sqlite = (file, sql) => execFileSync("/usr/bin/sqlite3", [file], { input: sql, encoding: "utf8" });
const schema = "CREATE TABLE cookies(host_key TEXT,name TEXT,path TEXT,value BLOB,encrypted_value BLOB,UNIQUE(host_key,name,path));";

function stagePendingImport(userData, marker) {
  const target = path.join(userData, "Partitions", "acbrowser", "Network", "Cookies");
  const staging = path.join(userData, "cookie-import-staging", `import-${marker}`, "Cookies");
  const manifest = path.join(userData, "cookie-import-staging", "pending.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(path.dirname(staging), { recursive: true });
  sqlite(target, `${schema} INSERT INTO cookies VALUES('.example.com','live-${marker}','/','keep',X'');`);
  sqlite(staging, `${schema} INSERT INTO cookies VALUES('.example.com','live-${marker}','/','keep',X'');
    CREATE TABLE iris_cookie_import_baseline AS SELECT * FROM cookies;
    DELETE FROM cookies;
    INSERT INTO cookies VALUES('.example.com','pending-${marker}','/','new',X'');`);
  fs.writeFileSync(manifest, JSON.stringify([{
    mode: "replace-scoped", scopes: ["example.com"], cas: true, target, staging, createdAt: Date.now(), attempts: 0,
  }]));
  return { target, staging, manifest };
}

test("개발 시작은 userData를 고정한 뒤 개발 스테이징만 재생한다", (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "iris-startup-user-data-"));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

  const stateDir = path.join(sandbox, ".iris-dev");
  const productionUserData = path.join(sandbox, "Application Support", "Iris");
  const developmentUserData = path.join(sandbox, "Application Support", "Iris-dev");
  const production = stagePendingImport(productionUserData, "production");
  const development = stagePendingImport(developmentUserData, "development");

  // 실제 Electron이나 앱을 띄우지 않는다. main의 초기 require 구간만 통과시키고 window-bounds에서
  // 멈춰, cookie-import의 require 시점 재생이 어느 userData를 읽었는지만 임시 DB로 관찰한다.
  const runner = String.raw`
    const Module = require("node:module");
    const mainPath = process.argv[1];
    let userData = process.argv[2];
    const setPaths = [];
    const sessionUserData = [];
    const electron = {
      app: {
        requestSingleInstanceLock() { return true; },
        getPath(name) { if (name !== "userData") throw new Error("unexpected path: " + name); return userData; },
        setPath(name, value) { if (name !== "userData") throw new Error("unexpected path: " + name); userData = value; setPaths.push(value); },
      },
    };
    Object.defineProperty(electron, "session", {
      get() { sessionUserData.push(userData); return {}; },
    });
    const originalLoad = Module._load;
    Module._load = function(request, parent, isMain) {
      if (request === "electron") return electron;
      if (parent && parent.filename === mainPath && request === "./window-bounds.cjs") {
        throw new Error("STARTUP_IMPORTS_OBSERVED");
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    try {
      require(mainPath);
      throw new Error("main startup did not reach observation boundary");
    } catch (error) {
      if (error.message !== "STARTUP_IMPORTS_OBSERVED") throw error;
    } finally {
      Module._load = originalLoad;
    }
    process.stdout.write(JSON.stringify({ userData, setPaths, sessionUserData }));
  `;
  const child = spawnSync(process.execPath, ["-e", runner, mainPath, productionUserData], {
    env: { ...process.env, IRIS_STATE_DIR: stateDir },
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const startup = JSON.parse(child.stdout.trim().split("\n").at(-1));

  assert.deepEqual(startup.setPaths, [developmentUserData]);
  assert.equal(startup.userData, developmentUserData);
  assert.ok(startup.sessionUserData.length > 0);
  assert.ok(startup.sessionUserData.every((observed) => observed === developmentUserData));
  assert.deepEqual(sqlite(development.target, "SELECT name FROM cookies ORDER BY name;").trim().split("\n"), [
    "pending-development",
  ]);
  assert.equal(fs.existsSync(development.manifest), false);
  assert.equal(fs.existsSync(development.staging), false);

  assert.deepEqual(sqlite(production.target, "SELECT name FROM cookies ORDER BY name;").trim().split("\n"), ["live-production"]);
  assert.equal(fs.existsSync(production.manifest), true);
  assert.equal(fs.existsSync(production.staging), true);
});

test("중복 실행은 세션 접근과 스테이징 모듈 로드 전에 종료한다", () => {
  const runner = String.raw`
    const Module = require("node:module");
    const mainPath = process.argv[1];
    const effects = [];
    const electron = { app: {
      getPath: () => "/tmp/iris-test-user-data",
      requestSingleInstanceLock() { effects.push("lock-denied"); return false; },
      quit() { effects.push("quit"); },
    }};
    Object.defineProperty(electron, "session", { get() { effects.push("session"); throw Error("session-before-lock"); } });
    const original = Module._load;
    Module._load = function(request, parent, isMain) {
      if (request === "electron") return electron;
      if (request === "./cookie-import.cjs") { effects.push("cookie-import"); throw Error("replay-before-lock"); }
      return original.call(this, request, parent, isMain);
    };
    require(mainPath);
    process.stdout.write(JSON.stringify(effects));
  `;
  const result = spawnSync(process.execPath, ["-e", runner, mainPath], {cwd:root,encoding:"utf8",env:{...process.env,IRIS_STATE_DIR:"",IRIS_PORT:""}});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(result.stdout),["lock-denied","quit"]);
});
