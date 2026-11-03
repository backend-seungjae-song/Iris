import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";

import {
  buildExecutionGraph,
  bundleDifferences,
  classifyChanges,
  cleanupDeployments,
  createBundleGeneration,
  createDeploymentManifest,
  prepareDeployment,
  readBundleGeneration,
  requestHealthJson,
  resolveDeploymentTarget,
} from "./index.mjs";
import { sha256 } from "./util.mjs";

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder"));
const { createTransformer } = builderRequire("app-builder-lib/out/fileTransformer.js");
const { FileMatcher, excludedExts, excludedNames } = builderRequire("app-builder-lib/out/fileMatcher.js");
const REPOSITORY_INSTALL_FILES = new Set([
  "scripts/mcp-worker/install.mjs",
  "scripts/mcp-worker/graph.mjs",
  "scripts/mcp-worker/index.mjs",
]);

function sameFile(left, right) {
  try { return fs.readFileSync(left).equals(fs.readFileSync(right)); }
  catch { return false; }
}

function buildFileIncluded(relative, patterns) {
  let included = false;
  for (const raw of patterns || []) {
    const negated = String(raw).startsWith("!");
    const pattern = String(raw).replace(/^!/, "").replaceAll("\\", "/");
    const prefix = pattern.endsWith("/**/*") ? pattern.slice(0, -4)
      : pattern.endsWith("/**") ? pattern.slice(0, -2) : null;
    if (relative === pattern || (prefix && relative.startsWith(prefix))) included = !negated;
  }
  return included;
}

function sameRecord(file, record) {
  try {
    const bytes = fs.readFileSync(file);
    return bytes.length === record.size && sha256(bytes) === record.sha256;
  } catch { return false; }
}

function sameBytes(bytes, record) {
  return bytes.length === record.size && sha256(bytes) === record.sha256;
}

function projectExecutionFile(relative) {
  return ["native/", "server/", "web/", "scripts/mcp-worker/", "bin/mcp/"].some(prefix => relative.startsWith(prefix));
}

function packageFileFilter(sourceRoot, packageJson) {
  const matcher = new FileMatcher(sourceRoot, sourceRoot, value => value, packageJson.build?.files || []);
  matcher.addPattern(`!**/*.{${excludedExts}${packageJson.build?.includePdb === true ? "" : ",pdb"}}`);
  matcher.addPattern("!**/._*");
  matcher.addPattern("!**/electron-builder.{yaml,yml,json,json5,toml,ts}");
  matcher.addPattern(`!**/{${excludedNames}}`);
  matcher.addPattern("!.yarn{,/**/*}");
  matcher.addPattern("!.editorconfig");
  matcher.addPattern("!.yarnrc.yml");
  return matcher.createFilter();
}

function sourceBuildFiles(sourceRoot, included) {
  const files = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if ([".git", ".working", "node_modules"].includes(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (!included(absolute, entry)) continue;
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        const relative = path.relative(sourceRoot, absolute).replaceAll("\\", "/");
        files.push(relative);
      }
    }
  };
  visit(sourceRoot);
  return files;
}

async function changedAgainstBundle({ sourceRoot, graph, installedBundle, workerRoot, packageJson }) {
  const changed = [];
  const buildFiles = packageJson.build?.files || [];
  const included = packageFileFilter(sourceRoot, packageJson);
  const includedRelative = relative => included(path.join(sourceRoot, relative), {
    isDirectory: () => false,
  });
  const transform = createTransformer(sourceRoot, packageJson.build || {}, packageJson.build?.extraMetadata, null);
  const packaged = new Map(installedBundle.packageFiles.map(record => [record.path, record]));
  const candidates = new Set(installedBundle.packageFiles
    .filter(record => projectExecutionFile(record.path) || buildFileIncluded(record.path, buildFiles))
    .map(record => record.path));
  for (const relative of sourceBuildFiles(sourceRoot, included)) candidates.add(relative);
  for (const relative of Object.keys(graph.membership)) {
    if (includedRelative(relative)) candidates.add(relative);
  }
  for (const relative of [...candidates].sort()) {
    if (REPOSITORY_INSTALL_FILES.has(relative)) continue;
    const currentOwners = (graph.membership[relative] || []).map(record => record.unit);
    const owners = currentOwners.length ? currentOwners : installedBundle.executionOwners[relative] || [];
    const onlyWorker = owners.length === 1 && owners[0] === "worker";
    if (onlyWorker && workerRoot) {
      if (!sameFile(path.join(sourceRoot, relative), path.join(workerRoot, relative))) changed.push(relative);
      continue;
    }
    const record = packaged.get(relative);
    if (!record) { changed.push(relative); continue; }
    if (relative === "package.json") {
      const transformed = await transform(path.join(sourceRoot, relative));
      const bytes = transformed == null ? fs.readFileSync(path.join(sourceRoot, relative)) : Buffer.from(transformed);
      if (!sameBytes(bytes, record)) changed.push(relative);
    } else if (!sameRecord(path.join(sourceRoot, relative), record)) changed.push(relative);
  }
  return changed;
}

function postJson(url, value, timeoutMs = 150_000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(value);
    const request = http.request(url, { method: "POST", timeout: timeoutMs,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, response => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => {
        let output;
        try { output = JSON.parse(text || "{}"); }
        catch { reject(new Error(`활성화 응답 JSON을 읽지 못했습니다: ${text.slice(0, 200)}`)); return; }
        if (response.statusCode !== 200 || output.ok === false) {
          reject(Object.assign(new Error(output.error || `활성화 HTTP ${response.statusCode}`), { code: output.code, details: output.details }));
          return;
        }
        resolve(output);
      });
    });
    request.on("timeout", () => request.destroy(Object.assign(new Error("worker 활성화 응답 시간이 초과됐습니다."), { code: "TIMEOUT" })));
    request.on("error", reject);
    request.end(body);
  });
}

// 전체 설치는 앱을 종료·재시작하므로 --full 을 명시했을 때만 · MCP 만 고친 줄 알고 실행한 명령이 앱을 내리지 않게
// 반환: 거부 문구, 진행이면 null
export function fullInstallRefusal(plan, { full = false } = {}) {
  if (plan?.action !== "full-install" || full) return null;
  const reasons = plan.reasons?.length
    ? plan.reasons.map(item => `  - ${item.file} (${(item.units || []).join(", ") || "공용"})`)
    : [`  - ${plan.reason || "공용 파일 변경"}`];
  return [
    "앱 재시작이 필요한 전체 설치로 판정되어 실행하지 않았습니다. 앱은 그대로입니다.",
    "전체 설치가 필요한 이유:",
    ...reasons,
    "MCP 작업 프로세스만 교체하려면 위 파일의 변경을 빼고 다시 실행하세요.",
    "앱을 재시작하는 전체 설치는 사용자 승인을 받은 뒤 pnpm install:app --full 로 실행합니다.",
  ].join("\n");
}

export async function planAppInstall({ sourceRoot, forceFull = false, forceRecover = false, resolveTarget = resolveDeploymentTarget,
  readHealth = requestHealthJson, requestWorker = postJson } = {}) {
  if (forceFull) return { action: "full-install", reason: "--full" };
  let target;
  try { target = await resolveTarget({ mode: "installed" }); }
  catch (error) { return { action: "full-install", reason: `설치 앱에 worker 교체 장치가 없음: ${error.message}` }; }
  if (!target.appPath || !target.mainPid || !target.serverPid) {
    return { action: "full-install", reason: "설치 앱 healthz에 worker 교체 식별값이 없음", target };
  }
  const health = await readHealth(target.healthUrl);
  target = { ...target, health };
  const installedBundleFile = path.join(target.serverRoot, ".iris-bundle.json");
  let installedBundle;
  try { installedBundle = readBundleGeneration(installedBundleFile); }
  catch (error) { return { action: "full-install", reason: `설치 bundle 기준을 읽지 못함: ${error.message}`, target };
  }
  const sourceBundle = createBundleGeneration({
    root: sourceRoot,
    generation: installedBundle.generation,
    buildId: installedBundle.buildId,
    packageFiles: installedBundle.packageFiles,
    executionOwners: installedBundle.executionOwners,
    nodeAbi: installedBundle.nodeAbi,
    electronAbi: installedBundle.electronAbi,
    platform: installedBundle.platform,
    arch: installedBundle.arch,
  });
  const graph = buildExecutionGraph({ root: sourceRoot });
  const packageJson = JSON.parse(fs.readFileSync(path.join(sourceRoot, "package.json"), "utf8"));
  let workerStatus = target.health?.worker || null;
  const pointerFile = path.join(target.stateDir, "mcp-worker", "current.json");
  let workerRoot = null;
  let previousDeployId = workerStatus?.deployId || null;
  try {
    const pointer = JSON.parse(fs.readFileSync(pointerFile, "utf8"));
    if (pointer.schemaVersion === 1 && pointer.bundleId === installedBundle.id
      && pointer.deployId === workerStatus?.deployId) {
      workerRoot = path.join(target.stateDir, "mcp-worker", pointer.deployId);
      previousDeployId = pointer.deployId;
    }
  } catch {}
  if (String(workerStatus?.deployId || "").startsWith("bundle:")) workerRoot = null;
  const differences = bundleDifferences(sourceBundle, installedBundle);
  if (differences.length) return { action: "full-install", reason: "설치 bundle 세대 불일치",
    bundleDifferences: differences, target, graph, sourceBundle, installedBundle, previousDeployId, workerStatus };
  let changedFiles;
  try { changedFiles = await changedAgainstBundle({ sourceRoot, graph, installedBundle, workerRoot, packageJson }); }
  catch (error) { return { action: "full-install", reason: `패키징 변환 비교 실패: ${error.message}`,
    target, graph, sourceBundle, installedBundle, previousDeployId, workerStatus }; }
  if (!changedFiles.length) {
    let action = forceRecover || workerStatus?.accepting !== true ? "worker-recover" : "none";
    if (action === "none") {
      const baseUrl = target.healthUrl.replace(/\/healthz$/, "");
      try { await requestWorker(`${baseUrl}/browser-cmd`, { cmd: "tabs", args: {} }, 10_000); }
      catch {
        try {
          const health = await readHealth(target.healthUrl);
          target = { ...target, health };
          workerStatus = health?.worker || workerStatus;
        } catch {}
        action = "worker-recover";
      }
    }
    return { action, target, graph, sourceBundle, installedBundle, previousDeployId, workerStatus, reconnectRequired: false };
  }
  const classification = classifyChanges({ root: sourceRoot, changedFiles, graph, sourceBundle, installedBundle,
    previousMembership: installedBundle.executionOwners });
  return { ...classification, target, sourceBundle, installedBundle, previousDeployId, changedFiles, workerStatus, forceRecover };
}

export async function deployWorkerPlan(plan, { sourceRoot, stopObservations = false, activate = postJson,
  readHealth = requestHealthJson, requestWorker = postJson } = {}) {
  if (plan.action !== "worker-replace") throw new Error(`worker 교체 계획이 아닙니다: ${plan.action}`);
  const manifest = createDeploymentManifest({ sourceRoot, graph: plan.graph, unit: "worker", bundle: plan.installedBundle });
  const prepared = prepareDeployment({
    sourceRoot,
    stateDir: plan.target.stateDir,
    manifest,
    installedBundle: plan.installedBundle,
    installedNodeModules: path.join(plan.target.serverRoot, "node_modules"),
  });
  const baseUrl = plan.target.healthUrl.replace(/\/healthz$/, "");
  const normalInput = {
    deployId: manifest.deployId,
    expectPrevId: plan.previousDeployId || plan.target.health?.worker?.deployId || undefined,
    stopObservations,
    recover: plan.forceRecover === true || plan.workerStatus?.accepting !== true,
  };
  const recoverInput = { deployId: manifest.deployId, recover: true };
  const probe = async () => {
    const health = await readHealth(plan.target.healthUrl);
    if (health?.worker?.accepting !== true) throw Object.assign(new Error("worker가 요청을 받을 상태가 아닙니다."), { code: "WORKER_UNAVAILABLE" });
    await requestWorker(`${baseUrl}/browser-cmd`, { cmd: "tabs", args: {} }, 10_000);
    return health;
  };
  let result, health;
  try { result = await activate(`${baseUrl}/mcp-worker/activate`, normalInput); }
  catch (error) {
    let accepting = false;
    try { await probe(); accepting = true; } catch {}
    if (error?.code !== "TIMEOUT" && accepting) throw error;
    result = await activate(`${baseUrl}/mcp-worker/activate`, recoverInput);
  }
  try { health = await probe(); }
  catch {
    result = await activate(`${baseUrl}/mcp-worker/activate`, recoverInput);
    health = await probe();
  }
  const continuity = {
    mainPid: { before: plan.target.mainPid, after: health.mainPid, unchanged: Number(plan.target.mainPid) === Number(health.mainPid) },
    serverPid: { before: plan.target.serverPid, after: health.pid, unchanged: Number(plan.target.serverPid) === Number(health.pid) },
  };
  cleanupDeployments({ stateDir: plan.target.stateDir });
  return { manifest, prepared, result, health, continuity };
}

export async function recoverWorkerPlan(plan, { activate = postJson, readHealth = requestHealthJson,
  requestWorker = postJson } = {}) {
  if (plan.action !== "worker-recover") throw new Error(`worker 복구 계획이 아닙니다: ${plan.action}`);
  const baseUrl = plan.target.healthUrl.replace(/\/healthz$/, "");
  let result = await activate(`${baseUrl}/mcp-worker/activate`, { recover: true });
  const probe = async () => {
    const nextHealth = await readHealth(plan.target.healthUrl);
    if (nextHealth?.worker?.accepting !== true) throw Object.assign(new Error("worker가 요청을 받을 상태가 아닙니다."), { code: "WORKER_UNAVAILABLE" });
    await requestWorker(`${baseUrl}/browser-cmd`, { cmd: "tabs", args: {} }, 10_000);
    return nextHealth;
  };
  let health;
  try { health = await probe(); }
  catch {
    result = await activate(`${baseUrl}/mcp-worker/activate`, { recover: true });
    health = await probe();
  }
  return { result, health, continuity: {
    mainPid: { before: plan.target.mainPid, after: health.mainPid, unchanged: Number(plan.target.mainPid) === Number(health.mainPid) },
    serverPid: { before: plan.target.serverPid, after: health.pid, unchanged: Number(plan.target.serverPid) === Number(health.pid) },
  } };
}
