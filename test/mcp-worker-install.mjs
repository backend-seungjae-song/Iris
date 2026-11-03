import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createBundleGeneration } from "../scripts/mcp-worker/index.mjs";
import { deployWorkerPlan, planAppInstall, recoverWorkerPlan } from "../scripts/mcp-worker/install.mjs";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const workerReply = async () => ({ ok: true, data: { tabs: [] } });

function write(base, relative, body = relative) {
  const file = path.join(base, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

test("worker 교체 API가 없는 기존 설치 앱은 첫 실행에서 전체 설치로 분류한다", async () => {
  const unavailable = await planAppInstall({ sourceRoot: root,
    resolveTarget: async () => { throw new Error("healthz에 appPath 없음"); } });
  assert.equal(unavailable.action, "full-install");
  assert.match(unavailable.reason, /worker 교체 장치가 없음/);

  const legacyHealth = await planAppInstall({ sourceRoot: root,
    resolveTarget: async () => ({ appPath: null, mainPid: null, serverPid: 10 }) });
  assert.equal(legacyHealth.action, "full-install");
  assert.match(legacyHealth.reason, /worker 교체 식별값이 없음/);
});

test("--full은 worker 변경 여부를 읽기 전에 전체 설치로 확정한다", async () => {
  let called = false;
  const plan = await planAppInstall({ sourceRoot: root, forceFull: true,
    resolveTarget: async () => { called = true; throw new Error("호출하면 안 됨"); } });
  assert.deepEqual(plan, { action: "full-install", reason: "--full" });
  assert.equal(called, false);
});

test("실제 electron-builder package 변환 결과는 변경 없음과 worker 교체를 구분한다", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "iris-worker-package-transform-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const sourceRoot = path.join(base, "source");
  const installedRoot = path.join(base, "installed");
  const stateDir = path.join(base, "state");
  const packageJson = {
    name: "fixture",
    version: "1.0.0",
    scripts: { test: "node --test" },
    devDependencies: { "electron-builder": "26.15.3" },
    build: { files: ["server/**/*", "web/**/*", "package.json"], asarUnpack: ["server/**"] },
  };
  write(sourceRoot, "package.json", JSON.stringify(packageJson));
  write(sourceRoot, "pnpm-lock.yaml", "lockfileVersion: 9\n");
  const workerBody = "export const worker = true;\n";
  write(sourceRoot, "server/mcp-worker/entry.js", workerBody);
  write(installedRoot, "server/mcp-worker/entry.js", workerBody);
  const builderRequire = createRequire(require.resolve("electron-builder"));
  const { createTransformer } = builderRequire("app-builder-lib/out/fileTransformer.js");
  const transformedPackage = await createTransformer(sourceRoot, packageJson.build, undefined, null)(
    path.join(sourceRoot, "package.json"));
  assert.equal(typeof transformedPackage, "string");
  const packageFiles = [
    ["package.json", transformedPackage, "asar"],
    ["server/mcp-worker/entry.js", workerBody, "unpacked"],
  ].map(([relative, body, location]) => ({ path: relative, location, size: Buffer.byteLength(body), sha256: sha256(body) }));
  const bundle = createBundleGeneration({ root: sourceRoot, buildId: "installed", packageFiles,
    nodeAbi: "127", electronAbi: "140", platform: "darwin", arch: "arm64" });
  write(installedRoot, ".iris-bundle.json", JSON.stringify(bundle));
  const target = { appPath: path.join(base, "Iris.app"), mainPid: 1, serverPid: 2, stateDir,
    serverRoot: installedRoot, healthUrl: "http://127.0.0.1:1/healthz" };
  const options = { sourceRoot, resolveTarget: async () => target,
    readHealth: async () => ({ worker: { deployId: `bundle:${bundle.id}`, accepting: true } }),
    requestWorker: workerReply };

  write(sourceRoot, "web/.DS_Store", "finder metadata");
  write(sourceRoot, "server/.entry.js.swp", "vim swap");
  assert.equal((await planAppInstall(options)).action, "none");
  write(sourceRoot, "server/mcp-worker/entry.js", "export const worker = false;\n");
  const changed = await planAppInstall(options);
  assert.equal(changed.action, "worker-replace");
  assert.deepEqual(changed.changedFiles, ["server/mcp-worker/entry.js"]);
});

test("build.files 디렉터리 glob은 같은 접두사의 루트 파일을 포함하지 않는다", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "iris-worker-glob-boundary-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const sourceRoot = path.join(base, "source");
  const installedRoot = path.join(base, "installed");
  const stateDir = path.join(base, "state");
  write(sourceRoot, "package.json", JSON.stringify({ name: "fixture", version: "1.0.0",
    build: { files: ["server/**/*"] } }));
  write(sourceRoot, "pnpm-lock.yaml", "lockfileVersion: 9\n");
  const workerBody = "export const worker = true;\n";
  write(sourceRoot, "server/mcp-worker/entry.js", workerBody);
  write(sourceRoot, "server.log", "runtime output\n");
  write(installedRoot, "server/mcp-worker/entry.js", workerBody);
  const bundle = createBundleGeneration({ root: sourceRoot, buildId: "installed", packageFiles: [{
    path: "server/mcp-worker/entry.js", location: "unpacked", size: Buffer.byteLength(workerBody), sha256: sha256(workerBody),
  }], nodeAbi: "127", electronAbi: "140", platform: "darwin", arch: "arm64" });
  write(installedRoot, ".iris-bundle.json", JSON.stringify(bundle));
  const target = { appPath: path.join(base, "Iris.app"), mainPid: 1, serverPid: 2, stateDir,
    serverRoot: installedRoot, healthUrl: "http://127.0.0.1:1/healthz" };

  const plan = await planAppInstall({ sourceRoot, resolveTarget: async () => target,
    readHealth: async () => ({ worker: { deployId: `bundle:${bundle.id}`, accepting: true } }),
    requestWorker: workerReply });

  assert.equal(plan.action, "none");
});

test("실제 설치 배치의 전체 설치 직후에는 변경 없음이고 worker 수정만 교체한다", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "iris-worker-install-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const sourceRoot = path.join(base, "source");
  const installedRoot = path.join(base, "Iris.app", "Contents", "Resources", "app.asar.unpacked");
  const stateDir = path.join(base, "state");
  const sources = new Map([
    ["native/electron/main.cjs", "module.exports = true;\n"],
    ["server/index.js", "export const server = true;\n"],
    ["server/mcp-worker/entry.js", "import './browser-service.js';\n"],
    ["server/mcp-worker/browser-service.js", "export const browser = true;\n"],
  ]);
  write(sourceRoot, "package.json", JSON.stringify({ name: "fixture", version: "1.0.0", build: {
    files: ["native/**/*", "server/**/*"], asarUnpack: ["server/**"],
  } }));
  write(sourceRoot, "pnpm-lock.yaml", "lockfileVersion: 9\n");
  write(sourceRoot, "bin/iris-mcp.mjs", "export const sourceOnly = true;\n");
  for (const [relative, body] of sources) write(sourceRoot, relative, body);
  for (const relative of [...sources.keys()].filter(file => file.startsWith("server/"))) {
    write(installedRoot, relative, sources.get(relative));
  }
  const packageFiles = [...sources].map(([relative, body]) => ({
    path: relative,
    location: relative.startsWith("native/") ? "asar" : "unpacked",
    size: Buffer.byteLength(body),
    sha256: sha256(body),
  }));
  const bundle = createBundleGeneration({ root: sourceRoot, buildId: "full-install-1", packageFiles,
    nodeAbi: "127", electronAbi: "140", platform: "darwin", arch: "arm64" });
  write(installedRoot, ".iris-bundle.json", JSON.stringify(bundle));
  const target = { appPath: path.join(base, "Iris.app"), mainPid: 11, serverPid: 22, stateDir,
    serverRoot: installedRoot, healthUrl: "http://127.0.0.1:1/healthz" };
  const options = { sourceRoot, resolveTarget: async () => target,
    readHealth: async () => ({ ok: true, worker: { deployId: `bundle:${bundle.id}`, accepting: true } }),
    requestWorker: workerReply };
  const unchanged = await planAppInstall(options);
  assert.equal(unchanged.action, "none");

  write(sourceRoot, "server/mcp-worker/browser-service.js", "export const browser = 'changed';\n");
  const changed = await planAppInstall(options);
  assert.equal(changed.action, "worker-replace");
  assert.deepEqual(changed.changedFiles, ["server/mcp-worker/browser-service.js"]);
  fs.mkdirSync(path.join(installedRoot, "node_modules"));
  const activationBodies = [];
  let probes = 0;
  const deployed = await deployWorkerPlan(changed, { sourceRoot,
    activate: async (_url, body) => { activationBodies.push(body); return { ok: true, worker: { pid: 33 } }; },
    requestWorker: async () => {
      probes += 1;
      if (probes === 1) throw Object.assign(new Error("fixture worker response timeout"), { code: "TIMEOUT" });
      return { ok: true, data: { tabs: [] } };
    },
    readHealth: async () => ({ mainPid: 11, pid: 22, worker: { accepting: true } }),
  });
  assert.equal(deployed.result.ok, true);
  assert.equal(probes, 2);
  assert.deepEqual(activationBodies.map(body => body.recover === true), [false, true]);

  const timeoutActivations = [];
  const timeoutPlan = { ...changed, target: { ...changed.target, stateDir: path.join(base, "timeout-state") } };
  const recovered = await deployWorkerPlan(timeoutPlan, { sourceRoot,
    activate: async (_url, body) => {
      timeoutActivations.push(body);
      if (timeoutActivations.length === 1) throw Object.assign(new Error("worker.drain 응답 시간이 초과됐습니다."), { code: "TIMEOUT" });
      return { ok: true, worker: { pid: 34 } };
    },
    requestWorker: async () => ({ ok: true, data: { tabs: [] } }),
    readHealth: async () => ({ mainPid: 11, pid: 22, worker: { accepting: true } }),
  });
  assert.equal(recovered.result.ok, true);
  assert.deepEqual(timeoutActivations.map(body => body.recover === true), [false, true]);

  for (const initialError of [
    Object.assign(new Error("fixture resource release failure"), { code: "RESOURCE_RELEASE_FAILED" }),
    new Error("worker 활성화 응답 시간이 초과됐습니다."),
  ]) {
    const failureState = path.join(base, `failure-state-${initialError.code || "http"}`);
    const failurePlan = { ...changed, target: { ...changed.target, stateDir: failureState } };
    const failureActivations = [];
    let recoveredState = false;
    const afterFailure = await deployWorkerPlan(failurePlan, { sourceRoot,
      activate: async (_url, body) => {
        failureActivations.push(body);
        if (failureActivations.length === 1) throw initialError;
        recoveredState = true;
        return { ok: true, worker: { pid: 35 } };
      },
      requestWorker: async () => {
        if (!recoveredState) throw Object.assign(new Error("fixture worker unavailable"), { code: "TIMEOUT" });
        return { ok: true, data: { tabs: [] } };
      },
      readHealth: async () => ({ mainPid: 11, pid: 22, worker: { accepting: recoveredState } }),
    });
    assert.equal(afterFailure.result.ok, true);
    assert.deepEqual(failureActivations.map(body => body.recover === true), [false, true]);
  }
});

test("변경 파일이 없어도 lockfile bundle 차이는 전체 설치로 분류한다", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "iris-worker-lockfile-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const sourceRoot = path.join(base, "source");
  const installedRoot = path.join(base, "installed");
  const stateDir = path.join(base, "state");
  write(sourceRoot, "package.json", JSON.stringify({ name: "fixture", version: "1.0.0", build: { files: ["server/**/*"] } }));
  write(sourceRoot, "pnpm-lock.yaml", "lockfileVersion: 9\nsource: true\n");
  write(sourceRoot, "server/mcp-worker/entry.js", "export const worker = true;\n");
  write(installedRoot, "server/mcp-worker/entry.js", "export const worker = true;\n");
  const body = "export const worker = true;\n";
  const bundle = createBundleGeneration({ root: sourceRoot, buildId: "installed", packageFiles: [{
    path: "server/mcp-worker/entry.js", location: "unpacked", size: Buffer.byteLength(body), sha256: sha256(body),
  }], nodeAbi: "127", electronAbi: "140", platform: "darwin", arch: "arm64" });
  bundle.lockfileSha256 = "0".repeat(64);
  bundle.id = sha256(JSON.stringify(bundle));
  write(installedRoot, ".iris-bundle.json", JSON.stringify(bundle));
  const target = { appPath: path.join(base, "Iris.app"), mainPid: 1, serverPid: 2, stateDir,
    serverRoot: installedRoot, healthUrl: "http://127.0.0.1:1/healthz" };

  const plan = await planAppInstall({ sourceRoot, resolveTarget: async () => target,
    readHealth: async () => ({ worker: { deployId: `bundle:${bundle.id}`, accepting: true } }) });

  assert.equal(plan.action, "full-install");
  assert.ok(plan.bundleDifferences.some(item => item.field === "lockfileSha256"));
});

test("build.files 실행 파일이 그래프 밖에서 바뀌면 전체 설치로 분류한다", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "iris-worker-packaged-bin-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const sourceRoot = path.join(base, "source");
  const installedRoot = path.join(base, "installed");
  const stateDir = path.join(base, "state");
  write(sourceRoot, "package.json", JSON.stringify({ name: "fixture", version: "1.0.0", build: {
    files: ["server/**/*", "bin/agent-context.mjs"],
  } }));
  write(sourceRoot, "pnpm-lock.yaml", "lockfileVersion: 9\n");
  write(sourceRoot, "server/mcp-worker/entry.js", "export const worker = true;\n");
  write(sourceRoot, "bin/agent-context.mjs", "export const changed = true;\n");
  write(installedRoot, "server/mcp-worker/entry.js", "export const worker = true;\n");
  const records = [
    ["server/mcp-worker/entry.js", "export const worker = true;\n"],
    ["bin/agent-context.mjs", "export const changed = false;\n"],
  ].map(([relative, body]) => ({ path: relative, location: "unpacked", size: Buffer.byteLength(body), sha256: sha256(body) }));
  const bundle = createBundleGeneration({ root: sourceRoot, buildId: "installed", packageFiles: records,
    nodeAbi: "127", electronAbi: "140", platform: "darwin", arch: "arm64" });
  write(installedRoot, ".iris-bundle.json", JSON.stringify(bundle));
  const target = { appPath: path.join(base, "Iris.app"), mainPid: 1, serverPid: 2, stateDir,
    serverRoot: installedRoot, healthUrl: "http://127.0.0.1:1/healthz" };

  const plan = await planAppInstall({ sourceRoot, resolveTarget: async () => target,
    readHealth: async () => ({ worker: { deployId: `bundle:${bundle.id}`, accepting: true } }) });

  assert.equal(plan.action, "full-install");
  assert.deepEqual(plan.changedFiles, ["bin/agent-context.mjs"]);
});

test("저장소에서만 실행하는 설치 도구 변경은 전체 설치로 분류하지 않는다", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "iris-worker-repository-tools-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const sourceRoot = path.join(base, "source");
  const installedRoot = path.join(base, "installed");
  const stateDir = path.join(base, "state");
  write(sourceRoot, "package.json", JSON.stringify({ name: "fixture", version: "1.0.0", build: {
    files: ["server/**/*", "scripts/mcp-worker/**/*"],
  } }));
  write(sourceRoot, "pnpm-lock.yaml", "lockfileVersion: 9\n");
  const files = new Map([
    ["server/mcp-worker/entry.js", "export const worker = true;\n"],
    ["scripts/mcp-worker/install.mjs", "export const source = 'install';\n"],
    ["scripts/mcp-worker/graph.mjs", "export const source = 'graph';\n"],
    ["scripts/mcp-worker/index.mjs", "export const source = 'index';\n"],
  ]);
  for (const [relative, body] of files) {
    write(sourceRoot, relative, body);
    write(installedRoot, relative, relative.startsWith("scripts/") ? `${body}// installed\n` : body);
  }
  const records = [...files].map(([relative, body]) => {
    const installed = relative.startsWith("scripts/") ? `${body}// installed\n` : body;
    return { path: relative, location: "unpacked", size: Buffer.byteLength(installed), sha256: sha256(installed) };
  });
  const bundle = createBundleGeneration({ root: sourceRoot, buildId: "installed", packageFiles: records,
    nodeAbi: "127", electronAbi: "140", platform: "darwin", arch: "arm64" });
  write(installedRoot, ".iris-bundle.json", JSON.stringify(bundle));
  const target = { appPath: path.join(base, "Iris.app"), mainPid: 1, serverPid: 2, stateDir,
    serverRoot: installedRoot, healthUrl: "http://127.0.0.1:1/healthz" };

  const plan = await planAppInstall({ sourceRoot, resolveTarget: async () => target,
    readHealth: async () => ({ worker: { deployId: `bundle:${bundle.id}`, accepting: true } }),
    requestWorker: workerReply });

  assert.equal(plan.action, "none");
});

test("설치 bundle의 파일 소속으로 worker 이름 변경과 공유 파일 삭제를 구분한다", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "iris-worker-installed-owners-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const sourceRoot = path.join(base, "source");
  const installedRoot = path.join(base, "installed");
  const stateDir = path.join(base, "state");
  const current = new Map([
    ["server/index.js", "import './shared.js';\n"],
    ["server/shared.js", "export const shared = true;\n"],
    ["server/mcp-worker/entry.js", "import './new-worker.js'; import '../shared.js';\n"],
    ["server/mcp-worker/new-worker.js", "export const worker = true;\n"],
  ]);
  const installed = new Map([
    ["server/index.js", current.get("server/index.js")],
    ["server/shared.js", current.get("server/shared.js")],
    ["server/mcp-worker/entry.js", "import './old-worker.js'; import '../shared.js';\n"],
    ["server/mcp-worker/old-worker.js", current.get("server/mcp-worker/new-worker.js")],
  ]);
  write(sourceRoot, "package.json", JSON.stringify({ name: "fixture", version: "1.0.0", build: {
    files: ["server/**/*"], asarUnpack: ["server/**"],
  } }));
  write(sourceRoot, "pnpm-lock.yaml", "lockfileVersion: 9\n");
  for (const [relative, body] of current) write(sourceRoot, relative, body);
  for (const [relative, body] of installed) write(installedRoot, relative, body);
  const records = [...installed].map(([relative, body]) => ({
    path: relative,
    location: "unpacked",
    size: Buffer.byteLength(body),
    sha256: sha256(body),
  }));
  const executionOwners = {
    "server/index.js": ["server"],
    "server/shared.js": ["server", "worker"],
    "server/mcp-worker/entry.js": ["worker"],
    "server/mcp-worker/old-worker.js": ["worker"],
  };
  const bundle = createBundleGeneration({ root: sourceRoot, buildId: "installed", packageFiles: records,
    executionOwners, nodeAbi: "127", electronAbi: "140", platform: "darwin", arch: "arm64" });
  assert.deepEqual(bundle.executionOwners, executionOwners);
  write(installedRoot, ".iris-bundle.json", JSON.stringify(bundle));
  const target = { appPath: path.join(base, "Iris.app"), mainPid: 1, serverPid: 2, stateDir,
    serverRoot: installedRoot, healthUrl: "http://127.0.0.1:1/healthz" };
  const options = { sourceRoot, resolveTarget: async () => target,
    readHealth: async () => ({ worker: { deployId: `bundle:${bundle.id}`, accepting: true } }),
    requestWorker: workerReply };

  const renamed = await planAppInstall(options);
  assert.equal(renamed.action, "worker-replace");
  assert.equal(renamed.reasons.find(reason => reason.file === "server/mcp-worker/old-worker.js")?.units.join(","), "worker");

  fs.unlinkSync(path.join(sourceRoot, "server", "shared.js"));
  const deletedShared = await planAppInstall(options);
  assert.equal(deletedShared.action, "full-install");
  assert.deepEqual(deletedShared.reasons.find(reason => reason.file === "server/shared.js")?.units, ["server", "worker"]);
});

test("health worker와 current.json이 다르면 실제 실행 배포를 설치 기준으로 쓴다", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "iris-worker-health-current-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const sourceRoot = path.join(base, "source");
  const installedRoot = path.join(base, "installed");
  const stateDir = path.join(base, "state");
  write(sourceRoot, "package.json", JSON.stringify({ name: "fixture", version: "1.0.0", build: { files: ["server/**/*"] } }));
  write(sourceRoot, "pnpm-lock.yaml", "lockfileVersion: 9\n");
  const body = "export const worker = true;\n";
  write(sourceRoot, "server/mcp-worker/entry.js", body);
  write(installedRoot, "server/mcp-worker/entry.js", body);
  const bundle = createBundleGeneration({ root: sourceRoot, buildId: "installed", packageFiles: [{
    path: "server/mcp-worker/entry.js", location: "unpacked", size: Buffer.byteLength(body), sha256: sha256(body),
  }], nodeAbi: "127", electronAbi: "140", platform: "darwin", arch: "arm64" });
  write(installedRoot, ".iris-bundle.json", JSON.stringify(bundle));
  write(stateDir, "mcp-worker/current.json", JSON.stringify({ schemaVersion: 1, bundleId: bundle.id, deployId: "invalid-pointer" }));
  const target = { appPath: path.join(base, "Iris.app"), mainPid: 1, serverPid: 2, stateDir,
    serverRoot: installedRoot, healthUrl: "http://127.0.0.1:1/healthz" };

  const plan = await planAppInstall({ sourceRoot, resolveTarget: async () => target,
    readHealth: async () => ({ worker: { deployId: `bundle:${bundle.id}`, accepting: true } }),
    requestWorker: workerReply });

  assert.equal(plan.action, "none");
  assert.equal(plan.previousDeployId, `bundle:${bundle.id}`);
});

test("worker가 접수 중이 아니면 변경 파일이 없어도 recover 계획을 만든다", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "iris-worker-recover-plan-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const sourceRoot = path.join(base, "source");
  const installedRoot = path.join(base, "installed");
  const stateDir = path.join(base, "state");
  write(sourceRoot, "package.json", JSON.stringify({ name: "fixture", version: "1.0.0", build: { files: ["server/**/*"] } }));
  write(sourceRoot, "pnpm-lock.yaml", "lockfileVersion: 9\n");
  const body = "export const worker = true;\n";
  write(sourceRoot, "server/mcp-worker/entry.js", body);
  write(installedRoot, "server/mcp-worker/entry.js", body);
  const bundle = createBundleGeneration({ root: sourceRoot, buildId: "installed", packageFiles: [{
    path: "server/mcp-worker/entry.js", location: "unpacked", size: Buffer.byteLength(body), sha256: sha256(body),
  }], nodeAbi: "127", electronAbi: "140", platform: "darwin", arch: "arm64" });
  write(installedRoot, ".iris-bundle.json", JSON.stringify(bundle));
  const target = { appPath: path.join(base, "Iris.app"), mainPid: 1, serverPid: 2, stateDir,
    serverRoot: installedRoot, healthUrl: "http://127.0.0.1:1/healthz" };

  const plan = await planAppInstall({ sourceRoot, resolveTarget: async () => target,
    readHealth: async () => ({ worker: { deployId: `bundle:${bundle.id}`, accepting: false, state: "failed" } }) });

  assert.equal(plan.action, "worker-recover");

  const forced = await planAppInstall({ sourceRoot, forceRecover: true, resolveTarget: async () => target,
    readHealth: async () => ({ worker: { deployId: `bundle:${bundle.id}`, accepting: true } }) });
  assert.equal(forced.action, "worker-recover");

  const unresponsive = await planAppInstall({ sourceRoot, resolveTarget: async () => target,
    readHealth: async () => ({ worker: { deployId: `bundle:${bundle.id}`, accepting: true } }),
    requestWorker: async () => { throw Object.assign(new Error("fixture no response"), { code: "TIMEOUT" }); } });
  assert.equal(unresponsive.action, "worker-recover");

  let activations = 0;
  let probes = 0;
  const recovered = await recoverWorkerPlan(plan, {
    activate: async () => { activations += 1; return { ok: true, worker: { pid: 3 } }; },
    readHealth: async () => ({ mainPid: 1, pid: 2, worker: { accepting: true } }),
    requestWorker: async () => {
      probes += 1;
      if (probes === 1) throw Object.assign(new Error("fixture no response"), { code: "TIMEOUT" });
      return { ok: true, data: { tabs: [] } };
    },
  });
  assert.equal(recovered.result.ok, true);
  assert.equal(activations, 2);
  assert.equal(probes, 2);
});

test("전체 설치 판정은 --full 없이는 거부 문구를 돌려주고, 그 밖의 판정은 막지 않는다", async () => {
  const { fullInstallRefusal } = await import("../scripts/mcp-worker/install.mjs");
  const plan = { action: "full-install", reasons: [{ file: "web/js/main.js", units: ["renderer"] }] };
  const refusal = fullInstallRefusal(plan);
  assert.match(refusal, /실행하지 않았습니다/);
  assert.match(refusal, /web\/js\/main\.js \(renderer\)/);
  assert.match(refusal, /pnpm install:app --full/);
  assert.match(fullInstallRefusal({ action: "full-install", reason: "설치 bundle 기준을 읽지 못함" }), /설치 bundle 기준을 읽지 못함/);
  assert.equal(fullInstallRefusal(plan, { full: true }), null);
  for (const action of ["worker-replace", "worker-recover", "none"]) assert.equal(fullInstallRefusal({ action }), null);
});

test("설치 명령은 전체 설치 판정이면 앱 종료 스크립트를 부르기 전에 거부한다", () => {
  const source = fs.readFileSync(path.join(root, "scripts/install-app.mjs"), "utf8");
  const refuse = source.indexOf("fullInstallRefusal(plan");
  const spawn = source.indexOf("spawnSync(");
  assert.ok(refuse > 0 && spawn > refuse, "거부 판단이 install-app.sh 실행보다 먼저");
  assert.match(source, /full: args\.includes\("--full"\)/);
});
