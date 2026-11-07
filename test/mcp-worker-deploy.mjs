import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

import {
  buildExecutionGraph,
  bundleDifferences,
  claimDeploymentLock,
  classifyChanges,
  collectBundleFileRecords,
  cleanupDeployments,
  createBundleGeneration,
  createDeploymentManifest,
  prepareDeployment,
  resolveDeploymentTarget,
  verifyDeployment,
} from "../scripts/mcp-worker/index.mjs";

const root = path.resolve(import.meta.dirname, "..");
const scratch = path.join(root, ".working", "20261101-1716-mcp-app-separation", "scratch", "5");
const require = createRequire(import.meta.url);

function fixture(t, name) {
  fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, `${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(base, relative, body = relative) {
  const file = path.join(base, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

function fakeTree(t) {
  const dir = fixture(t, "graph");
  write(dir, "server/index.js", 'import "./shared.js"; import { fork } from "node:child_process"; fork(new URL("./mcp-worker/index.js", import.meta.url));\n');
  write(dir, "server/shared.js", "export const shared = true;\n");
  write(dir, "server/mcp-worker/index.js", 'import "../shared.js"; import "./only.js"; import "./launcher.js";\n');
  write(dir, "server/mcp-worker/only.js", 'export const lazy = import("./lazy.js");\n');
  write(dir, "server/mcp-worker/lazy.js", "export default 1;\n");
  write(dir, "server/mcp-worker/launcher.js", [
    'import { Worker } from "node:worker_threads";',
    'new Worker(new URL("./thread.js", import.meta.url), { workerData: { module: new URL("./loaded.js", import.meta.url) } });',
  ].join("\n"));
  write(dir, "server/mcp-worker/thread.js", 'import { workerData } from "node:worker_threads"; await import(workerData.module);\n');
  write(dir, "server/mcp-worker/loaded.js", 'export { build } from "../../bin/mcp/report.mjs";\n');
  write(dir, "server/mcp-worker/template.json", "{}\n");
  write(dir, "native/electron/main.cjs", 'require("../../server/electron-shared.cjs"); require("./capabilities.cjs");\n');
  write(dir, "native/electron/capabilities.cjs", 'module.exports = [{ module: require.resolve("./feature.cjs") }];\n');
  write(dir, "native/electron/feature.cjs", "module.exports = {};\n");
  write(dir, "native/electron/preload.cjs", 'require("./preload-helper.cjs");\n');
  write(dir, "native/electron/preload-helper.cjs", "module.exports = {};\n");
  write(dir, "server/electron-shared.cjs", "module.exports = {};\n");
  write(dir, "web/index.html", '<script type="module" src="/js/main.js"></script><link rel="stylesheet" href="/css/app.css">\n');
  write(dir, "web/js/main.js", 'import "./view.js";\n');
  write(dir, "web/js/view.js", "export default 1;\n");
  write(dir, "web/css/app.css", "body {}\n");
  write(dir, "bin/iris-mcp.mjs", 'import "../server/shared.js";\n');
  write(dir, "bin/iris-qa.mjs", "export default 1;\n");
  write(dir, "bin/mcp/report.mjs", 'export { plain } from "./report-plain.mjs";\n');
  write(dir, "bin/mcp/report-plain.mjs", "export const plain = true;\n");
  write(dir, "scripts/worker-darwin.sh", "#!/bin/sh\n");
  return dir;
}

function units() {
  return {
    electron: { entrypoints: ["native/electron/main.cjs", "native/electron/preload.cjs"] },
    server: { entrypoints: ["server/index.js"] },
    worker: {
      entrypoints: ["server/mcp-worker/index.js"],
      dynamic: {
        executables: ["bin/mcp/report.mjs"],
        platformScripts: ["scripts/worker-darwin.sh"],
        assets: ["server/mcp-worker/template.json"],
      },
    },
    renderer: { entrypoints: ["web/index.html"] },
    mcp: { entrypoints: ["bin/iris-mcp.mjs", "bin/iris-qa.mjs"] },
  };
}

function bundle(overrides = {}) {
  return {
    id: "bundle-1",
    buildId: "build-1",
    generation: "0.1.0",
    lockfileSha256: "a".repeat(64),
    nodeAbi: "127",
    electronAbi: "140",
    platform: "darwin",
    arch: "arm64",
    overridesSha256: "b".repeat(64),
    packagingSha256: "d".repeat(64),
    patches: [{ path: "patches/x.patch", sha256: "c".repeat(64) }],
    packageFiles: [],
    executionOwners: {},
    ...overrides,
  };
}

test("실행 주체 그래프는 정적·동적·스레드·자료 의존성과 근거 경로를 계산한다", (t) => {
  const sourceRoot = fakeTree(t);
  const graph = buildExecutionGraph({ root: sourceRoot, units: units() });
  const workerFiles = new Set(graph.units.worker.files);
  for (const file of [
    "server/mcp-worker/lazy.js",
    "server/mcp-worker/thread.js",
    "server/mcp-worker/loaded.js",
    "bin/mcp/report.mjs",
    "bin/mcp/report-plain.mjs",
    "scripts/worker-darwin.sh",
    "server/mcp-worker/template.json",
  ]) assert.equal(workerFiles.has(file), true, file);
  assert.deepEqual(graph.membership["server/shared.js"].map((item) => item.unit).sort(), ["mcp", "server", "worker"]);
  assert.deepEqual(graph.membership["server/mcp-worker/index.js"].map((item) => item.unit), ["worker"]);
  assert.deepEqual(graph.membership["native/electron/feature.cjs"].map((item) => item.unit), ["electron"]);
  assert.ok(graph.membership["server/mcp-worker/thread.js"][0].chain.some((edge) => edge.kind === "threadEntrypoint"));
  assert.ok(graph.membership["server/mcp-worker/loaded.js"][0].chain.some((edge) => edge.kind === "workerModule"));
});

test("작업 프로세스 전용 파일 변경은 worker 교체와 파일별 근거를 반환한다", (t) => {
  const sourceRoot = fakeTree(t);
  const result = classifyChanges({
    root: sourceRoot,
    units: units(),
    changedFiles: ["server/mcp-worker/only.js"],
    sourceBundle: bundle(),
    installedBundle: bundle(),
  });
  assert.equal(result.action, "worker-replace");
  assert.equal(result.reasons[0].file, "server/mcp-worker/only.js");
  assert.deepEqual(result.reasons[0].units, ["worker"]);
  assert.match(result.reasons[0].why, /server\/mcp-worker\/index\.js/);
});

test("공용 서버의 worker fork 진입점은 현재 저장소 그래프에서 프로세스 경계다", () => {
  const graph = buildExecutionGraph({ root });
  assert.deepEqual(graph.membership["server/mcp-worker/entry.js"].map(item => item.unit), ["worker"]);
  assert.deepEqual(graph.membership["server/mcp-worker/browser-service.js"].map(item => item.unit), ["worker"]);
  assert.ok(graph.units.server.processBoundaries.some(edge => edge.from === "server/mcp-worker/supervisor.js"
    && edge.to === "server/mcp-worker/entry.js"));
  const result = classifyChanges({
    root,
    graph,
    changedFiles: ["server/mcp-worker/browser-service.js"],
    sourceBundle: bundle(),
    installedBundle: bundle(),
  });
  assert.equal(result.action, "worker-replace");
});

test("두 실행 단위가 공유하는 파일 변경은 전체 설치로 분류한다", (t) => {
  const sourceRoot = fakeTree(t);
  const result = classifyChanges({
    root: sourceRoot,
    units: units(),
    changedFiles: ["server/shared.js"],
    sourceBundle: bundle(),
    installedBundle: bundle(),
  });
  assert.equal(result.action, "full-install");
  assert.deepEqual(result.reasons[0].units, ["mcp", "server", "worker"]);
  assert.match(result.reasons[0].why, /공유/);
});

// MCP 진입 프로세스는 저장소에서 직접 실행 · 설치 앱 없이 /mcp reconnect 로 반영됨
test("worker 와 MCP 진입 프로세스만 쓰는 파일은 worker 교체와 reconnect 로 분류한다", (t) => {
  const sourceRoot = fakeTree(t);
  write(sourceRoot, "bin/iris-qa.mjs", 'import "../server/qa-rows.js"; import "../server/qa-protocol.js";\n');
  write(sourceRoot, "server/qa-rows.js", "export const rows = true;\n");
  write(sourceRoot, "server/qa-protocol.js", "export const protocol = true;\n");
  write(sourceRoot, "server/mcp-worker/index.js", 'import "../shared.js"; import "./only.js"; import "./launcher.js"; import "../qa-rows.js";\n');
  const shared = classifyChanges({ root: sourceRoot, units: units(), changedFiles: ["server/qa-rows.js"],
    sourceBundle: bundle(), installedBundle: bundle() });
  assert.equal(shared.action, "worker-replace");
  assert.equal(shared.reconnectRequired, true);
  assert.deepEqual(shared.reasons[0].units, ["mcp", "worker"]);
  const mcpOnly = classifyChanges({ root: sourceRoot, units: units(), changedFiles: ["server/qa-protocol.js"],
    sourceBundle: bundle(), installedBundle: bundle() });
  assert.equal(mcpOnly.action, "worker-replace");
  assert.equal(mcpOnly.reconnectRequired, true);
  const withServer = classifyChanges({ root: sourceRoot, units: units(), changedFiles: ["server/qa-rows.js", "server/shared.js"],
    sourceBundle: bundle(), installedBundle: bundle() });
  assert.equal(withServer.action, "full-install");
});

test("bundle 세대가 다르면 worker 파일만 바뀌어도 전체 설치로 분류한다", (t) => {
  const sourceRoot = fakeTree(t);
  const result = classifyChanges({
    root: sourceRoot,
    units: units(),
    changedFiles: ["server/mcp-worker/only.js"],
    sourceBundle: bundle(),
    installedBundle: bundle({ electronAbi: "141" }),
  });
  assert.equal(result.action, "full-install");
  assert.deepEqual(result.bundleDifferences.map((item) => item.field), ["electronAbi"]);
});

test("bundle 세대는 lockfile·override·patch·ABI·플랫폼을 기록한다", (t) => {
  const sourceRoot = fixture(t, "bundle");
  write(sourceRoot, "package.json", JSON.stringify({
    name: "fixture",
    version: "1.2.3",
    pnpm: { overrides: { x: "2" }, patchedDependencies: { "x@2": "patches/x.patch" } },
  }));
  write(sourceRoot, "pnpm-lock.yaml", "lockfileVersion: 9\n");
  write(sourceRoot, "patches/x.patch", "patch\n");
  const generation = createBundleGeneration({
    root: sourceRoot,
    nodeAbi: "127",
    electronAbi: "140",
    platform: "darwin",
    arch: "arm64",
  });
  assert.equal(generation.generation, "1.2.3");
  assert.equal(generation.patches[0].path, "patches/x.patch");
  assert.deepEqual(bundleDifferences(generation, { ...generation, arch: "x64" }).map((item) => item.field), ["arch"]);
});

test("bundle 세대는 전체 설치마다 고유한 build id를 갖는다", (t) => {
  const sourceRoot = fixture(t, "bundle-id");
  write(sourceRoot, "package.json", JSON.stringify({ name: "fixture", version: "1.2.3" }));
  write(sourceRoot, "pnpm-lock.yaml", "lockfileVersion: 9\n");
  const first = createBundleGeneration({ root: sourceRoot, nodeAbi: "127", electronAbi: "140" });
  const second = createBundleGeneration({ root: sourceRoot, nodeAbi: "127", electronAbi: "140" });
  assert.notEqual(first.buildId, second.buildId);
  assert.notEqual(first.id, second.id);
});

test("같은 소스도 bundle 세대가 다르면 다른 배포 폴더를 쓴다", (t) => {
  const sourceRoot = fakeTree(t);
  const graph = buildExecutionGraph({ root: sourceRoot, units: units() });
  const source = { commit: "1234567890abcdef", worktreeSha256: "f".repeat(64) };
  const first = createDeploymentManifest({ sourceRoot, graph, bundle: bundle({ id: "bundle-one", buildId: "build-one" }), source });
  const second = createDeploymentManifest({ sourceRoot, graph, bundle: bundle({ id: "bundle-two", buildId: "build-two" }), source });
  assert.notEqual(first.deployId, second.deployId);
});

test("패키징 목록은 asar와 unpacked 파일의 경로와 해시를 실제 배치에서 기록한다", async (t) => {
  const packedRoot = fixture(t, "asar-source");
  const resources = fixture(t, "asar-resources");
  write(packedRoot, "native/electron/main.cjs", "module.exports = 'native';\n");
  write(packedRoot, "server/index.js", "export const server = true;\n");
  write(packedRoot, "server/mcp-worker/browser-service.js", "export const worker = true;\n");
  const asarFile = path.join(resources, "app.asar");
  const asarModule = require(require.resolve("@electron/asar", { paths: [path.dirname(require.resolve("electron-builder"))] }));
  await asarModule.createPackageWithOptions(packedRoot, asarFile, { unpackDir: "server" });
  const records = collectBundleFileRecords({ asarFile, asarModule });
  const byPath = new Map(records.map(record => [record.path, record]));
  assert.equal(byPath.get("native/electron/main.cjs").location, "asar");
  assert.equal(byPath.get("server/index.js").location, "unpacked");
  assert.equal(byPath.get("server/mcp-worker/browser-service.js").location, "unpacked");
  assert.equal(byPath.has("bin/iris-mcp.mjs"), false);
  for (const record of records) assert.match(record.sha256, /^[0-9a-f]{64}$/);
});

test("부분 복사는 최종 실행 폴더로 확정하지 않는다", (t) => {
  const sourceRoot = fakeTree(t);
  const stateDir = fixture(t, "state-partial");
  const nodeModules = path.join(fixture(t, "installed-partial"), "node_modules");
  fs.mkdirSync(nodeModules);
  const graph = buildExecutionGraph({ root: sourceRoot, units: units() });
  const manifest = createDeploymentManifest({
    sourceRoot,
    graph,
    unit: "worker",
    bundle: bundle(),
    source: { commit: "1234567890abcdef", worktreeSha256: "d".repeat(64) },
  });
  fs.unlinkSync(path.join(sourceRoot, "server/mcp-worker/only.js"));
  assert.throws(() => prepareDeployment({
    sourceRoot,
    stateDir,
    manifest,
    installedBundle: bundle(),
    installedNodeModules: nodeModules,
  }), /복사|없습니다|ENOENT/);
  assert.equal(fs.existsSync(path.join(stateDir, "mcp-worker", manifest.deployId)), false);
});

test("완성 표시가 없거나 파일 해시가 다르면 실행 폴더 사용을 거부한다", (t) => {
  const sourceRoot = fakeTree(t);
  const stateDir = fixture(t, "state-verify");
  const nodeModules = path.join(fixture(t, "installed-verify"), "node_modules");
  fs.mkdirSync(nodeModules);
  const graph = buildExecutionGraph({ root: sourceRoot, units: units() });
  const manifest = createDeploymentManifest({
    sourceRoot,
    graph,
    unit: "worker",
    bundle: bundle(),
    source: { commit: "1234567890abcdef", worktreeSha256: "e".repeat(64) },
  });
  const prepared = prepareDeployment({ sourceRoot, stateDir, manifest, installedBundle: bundle(), installedNodeModules: nodeModules });
  assert.equal(fs.lstatSync(path.join(prepared.directory, "node_modules")).isSymbolicLink(), true);
  fs.unlinkSync(path.join(prepared.directory, ".complete.json"));
  assert.throws(() => verifyDeployment(prepared.directory), /완성 표시/);
});

test("같은 상태 폴더에서는 배포 잠금을 하나만 획득한다", (t) => {
  const stateDir = fixture(t, "state-lock");
  const first = claimDeploymentLock({ stateDir, owner: "first" });
  t.after(() => first.release());
  assert.throws(() => claimDeploymentLock({ stateDir, owner: "second" }), (error) => error.code === "DEPLOYMENT_BUSY");
  first.release();
  const second = claimDeploymentLock({ stateDir, owner: "second" });
  second.release();
});

test("실행 폴더 정리는 현재·직전 정상·배포 중 폴더를 보존한다", (t) => {
  const stateDir = fixture(t, "state-clean");
  const deployRoot = path.join(stateDir, "mcp-worker");
  for (const name of ["current", "previous", "deploying", "old-a", "old-b"]) fs.mkdirSync(path.join(deployRoot, name), { recursive: true });
  fs.writeFileSync(path.join(deployRoot, "current.json"), JSON.stringify({ deployId: "current", previousDeployId: "previous" }));
  const removed = cleanupDeployments({ stateDir, inProgress: ["deploying"], keep: 0 });
  assert.deepEqual(new Set(removed), new Set(["old-a", "old-b"]));
  for (const name of ["current", "previous", "deploying"]) assert.equal(fs.existsSync(path.join(deployRoot, name)), true, name);
});

test("설치 대상은 환경변수 대신 health 응답으로 확정하고 개발 대상은 명시값을 요구한다", async () => {
  let requested;
  const target = await resolveDeploymentTarget({
    mode: "installed",
    requestHealth: async (url) => {
      requested = url;
      return { ok: true, pid: 22, mainPid: 11, port: 4271, stateDir: "/state/installed", appPath: "/Applications/Iris.app", serverRoot: "/bundle/server" };
    },
    env: { IRIS_PORT: "9999", IRIS_STATE_DIR: "/wrong", IRIS_SERVER_ROOT: "/wrong" },
  });
  assert.equal(requested, "http://127.0.0.1:4271/healthz");
  assert.deepEqual(target, {
    mode: "installed",
    healthUrl: requested,
    appPath: "/Applications/Iris.app",
    mainPid: 11,
    serverPid: 22,
    port: 4271,
    stateDir: "/state/installed",
    serverRoot: "/bundle/server",
  });
  await assert.rejects(() => resolveDeploymentTarget({ mode: "development", requestHealth: async () => ({ ok: true }) }), /명시/);
});

test("afterPack은 서명 전에 bundle 세대 파일 생성을 연결한다", () => {
  const source = fs.readFileSync(path.join(root, "scripts", "after-pack.cjs"), "utf8");
  assert.match(source, /writeBundleGeneration/);
  assert.match(source, /collectBundleFileRecords/);
  assert.match(source, /buildExecutionGraph/);
  assert.match(source, /executionOwners/);
  assert.match(source, /\.iris-bundle\.json/);
});
