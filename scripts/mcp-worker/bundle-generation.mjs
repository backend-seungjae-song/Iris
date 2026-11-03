import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { canonicalJson, readJson, relativePath, sha256 } from "./util.mjs";

const BUNDLE_FIELDS = ["id", "buildId", "generation", "lockfileSha256", "nodeAbi", "electronAbi", "platform", "arch",
  "overridesSha256", "packagingSha256", "patches", "packageFiles", "executionOwners"];

function normalizedExecutionOwners(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([rawPath, rawOwners]) => {
    const file = relativePath(rawPath);
    if (!Array.isArray(rawOwners)) throw new Error(`bundle 파일 실행 주체가 배열이 아닙니다: ${file}`);
    const owners = [...new Set(rawOwners.map(owner => String(owner)))].sort();
    if (owners.some(owner => !/^[A-Za-z][A-Za-z0-9_-]*$/.test(owner))) {
      throw new Error(`bundle 파일 실행 주체가 올바르지 않습니다: ${file}`);
    }
    return [file, owners];
  }).sort(([left], [right]) => left.localeCompare(right)));
}

function requiredHash(file, label) {
  try { return sha256(fs.readFileSync(file)); }
  catch (error) { throw new Error(`${label}을 읽지 못했습니다: ${error.message}`); }
}

export function createBundleGeneration({
  root,
  generation,
  buildId = randomUUID(),
  packageFiles = [],
  executionOwners = {},
  nodeAbi = process.versions.modules,
  electronAbi,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const sourceRoot = path.resolve(root);
  const packageJson = readJson(path.join(sourceRoot, "package.json"), "package.json");
  const patches = Object.values(packageJson.pnpm?.patchedDependencies || {}).map((raw) => {
    const patchPath = relativePath(raw);
    return { path: patchPath, sha256: requiredHash(path.join(sourceRoot, patchPath), patchPath) };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const base = {
    buildId: String(buildId),
    generation: String(generation || packageJson.version || "0"),
    lockfileSha256: requiredHash(path.join(sourceRoot, "pnpm-lock.yaml"), "pnpm-lock.yaml"),
    nodeAbi: String(nodeAbi || ""),
    electronAbi: String(electronAbi || ""),
    platform: String(platform),
    arch: String(arch),
    overridesSha256: sha256(canonicalJson(packageJson.pnpm?.overrides || {})),
    packagingSha256: sha256(canonicalJson({
      files: packageJson.build?.files || [],
      asarUnpack: packageJson.build?.asarUnpack || [],
      extraResources: packageJson.build?.extraResources || [],
    })),
    patches,
    packageFiles: packageFiles.map(record => ({
      path: relativePath(record.path),
      location: record.location === "unpacked" ? "unpacked" : "asar",
      size: Number(record.size),
      sha256: String(record.sha256),
    })).sort((a, b) => a.path.localeCompare(b.path)),
    executionOwners: normalizedExecutionOwners(executionOwners),
  };
  if (!base.buildId || !base.nodeAbi || !base.electronAbi) throw new Error("build ID와 Node·Electron ABI가 필요합니다.");
  return { id: sha256(canonicalJson(base)), ...base };
}

export function collectBundleFileRecords({ asarFile, asarModule } = {}) {
  if (!asarFile || !fs.existsSync(asarFile)) throw new Error(`app.asar가 없습니다: ${asarFile || "미지정"}`);
  if (!asarModule?.listPackage || !asarModule?.statFile || !asarModule?.extractFile) {
    throw new Error("asar 파일 목록을 읽는 모듈이 필요합니다.");
  }
  const records = [];
  for (const raw of asarModule.listPackage(asarFile, { isPack: false })) {
    const file = relativePath(String(raw).replace(/^[/\\]+/, ""));
    let stat;
    try { stat = asarModule.statFile(asarFile, file, false); }
    catch { continue; }
    if (!Number.isInteger(stat?.size) || stat.size < 0) continue;
    const hash = stat.integrity?.algorithm === "SHA256" && /^[0-9a-f]{64}$/i.test(String(stat.integrity.hash || ""))
      ? String(stat.integrity.hash).toLowerCase() : sha256(asarModule.extractFile(asarFile, file, false));
    records.push({ path: file, location: stat.unpacked ? "unpacked" : "asar", size: stat.size, sha256: hash });
  }
  records.sort((a, b) => a.path.localeCompare(b.path));
  return records;
}

export function electronAbiFromExecutable(executable) {
  if (!executable || !fs.existsSync(executable)) throw new Error(`Electron 실행 파일이 없습니다: ${executable || "미지정"}`);
  const result = spawnSync(executable, ["-p", "process.versions.modules"], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8",
    timeout: 15_000,
  });
  const abi = String(result.stdout || "").trim().split(/\s+/).at(-1);
  if (result.status !== 0 || !/^\d+$/.test(abi)) {
    throw new Error(`Electron ABI를 확인하지 못했습니다(exit ${result.status}): ${String(result.stderr || "").trim()}`);
  }
  return abi;
}

export function bundleDifferences(expected, actual) {
  return BUNDLE_FIELDS.filter((field) => canonicalJson(expected?.[field]) !== canonicalJson(actual?.[field]))
    .map((field) => ({ field, expected: expected?.[field], actual: actual?.[field] }));
}

export function writeBundleGeneration({ root, outputFile, electronExecutable, generation, buildId, packageFiles,
  executionOwners, platform, arch }) {
  const value = createBundleGeneration({
    root,
    generation,
    buildId,
    packageFiles,
    executionOwners,
    platform,
    arch,
    electronAbi: electronAbiFromExecutable(electronExecutable),
  });
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, `${JSON.stringify(value, null, 2)}\n`, { flag: "w" });
  return value;
}

export function readBundleGeneration(file) {
  const value = readJson(file, "bundle 세대 파일");
  const missing = BUNDLE_FIELDS.filter((field) => value[field] === undefined);
  if (missing.length) throw new Error(`bundle 세대 파일에 필드가 없습니다: ${missing.join(", ")}`);
  for (const record of value.packageFiles) {
    relativePath(record.path);
    if (!["asar", "unpacked"].includes(record.location) || !Number.isInteger(record.size) || record.size < 0
      || !/^[0-9a-f]{64}$/.test(String(record.sha256))) throw new Error(`bundle 파일 정보가 올바르지 않습니다: ${record.path}`);
  }
  value.executionOwners = normalizedExecutionOwners(value.executionOwners);
  return value;
}
