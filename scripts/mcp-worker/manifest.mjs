import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { canonicalJson, fileRecord, listFiles, relativePath, sha256 } from "./util.mjs";

const DYNAMIC_FIELDS = ["threadEntrypoints", "workerModules", "executables", "platformScripts", "assets"];

function fallbackWorktreeFiles(root) {
  return listFiles(root, { ignore: [".git", "node_modules", "dist", ".working"] });
}

function gitWorktreeFiles(root) {
  const result = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root });
  if (result.status !== 0) return null;
  return result.stdout.toString("utf8").split("\0").filter(Boolean).sort();
}

export function computeWorktreeIdentity(root) {
  const sourceRoot = path.resolve(root);
  const files = gitWorktreeFiles(sourceRoot) || fallbackWorktreeFiles(sourceRoot);
  const hashParts = [];
  for (const raw of files) {
    const file = relativePath(raw);
    const absolute = path.join(sourceRoot, file);
    if (!fs.existsSync(absolute)) {
      hashParts.push(`${file}\0missing\0`);
      continue;
    }
    const stat = fs.lstatSync(absolute);
    const bytes = stat.isSymbolicLink() ? Buffer.from(fs.readlinkSync(absolute)) : fs.readFileSync(absolute);
    hashParts.push(`${file}\0${stat.mode & 0o777}\0${sha256(bytes)}\0`);
  }
  const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, encoding: "utf8" });
  return {
    commit: revision.status === 0 ? revision.stdout.trim() : "unknown",
    worktreeSha256: sha256(hashParts.join("")),
  };
}

export function createDeploymentManifest({
  sourceRoot,
  graph,
  unit = "worker",
  bundle,
  source = computeWorktreeIdentity(sourceRoot),
  protocol = { worker: 1, hostApi: 1, relay: 1 },
  dataCompatibility = { reads: [1], writes: 1, rollbackReader: 1 },
  now = new Date(),
}) {
  const unitGraph = graph?.units?.[unit];
  if (!unitGraph) throw new Error(`실행 주체 그래프가 없습니다: ${unit}`);
  if (!bundle?.id) throw new Error("worker manifest에 bundle 세대가 필요합니다.");
  const files = unitGraph.files.map((file) => fileRecord(sourceRoot, file)).sort((a, b) => a.path.localeCompare(b.path));
  if (files.length === 0) throw new Error("worker 배포 파일 목록이 비었습니다.");
  const dynamic = Object.fromEntries(DYNAMIC_FIELDS.map((field) => [field, [...new Set(unitGraph.dynamic?.[field] || [])].sort()]));
  const bundleSha256 = sha256(String(bundle.id));
  const deployId = `${String(source.commit || "unknown").slice(0, 12)}-${bundleSha256.slice(0, 16)}-${source.worktreeSha256}`;
  const manifest = {
    schemaVersion: 1,
    deployId,
    createdAt: now.toISOString(),
    source: { commit: String(source.commit), worktreeSha256: String(source.worktreeSha256) },
    protocol,
    bundle,
    dataCompatibility,
    files,
    dynamic,
  };
  validateDeploymentManifest(manifest);
  return manifest;
}

export function validateDeploymentManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1) throw new Error("지원하지 않는 worker manifest schema입니다.");
  if (!/^[^/]+-[0-9a-f]{16}-[0-9a-f]{64}$/.test(String(manifest.deployId || ""))) throw new Error(`올바르지 않은 deployId입니다: ${manifest.deployId}`);
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error("worker manifest 파일 목록이 비었습니다.");
  if (!/^[0-9a-f]{64}$/.test(String(manifest.source?.worktreeSha256 || ""))) throw new Error("worker manifest 작업 트리 sha256이 올바르지 않습니다.");
  for (const field of ["id", "buildId", "generation", "lockfileSha256", "nodeAbi", "electronAbi", "platform", "arch",
    "overridesSha256", "packagingSha256", "patches", "packageFiles", "executionOwners"]) {
    if (manifest.bundle?.[field] === undefined) throw new Error(`worker manifest bundle.${field}가 없습니다.`);
  }
  for (const field of ["lockfileSha256", "overridesSha256", "packagingSha256"]) {
    if (!/^[0-9a-f]{64}$/.test(String(manifest.bundle[field]))) throw new Error(`worker manifest bundle.${field}가 올바르지 않습니다.`);
  }
  if (!Array.isArray(manifest.bundle.patches)) throw new Error("worker manifest bundle.patches가 배열이 아닙니다.");
  for (const patch of manifest.bundle.patches) {
    relativePath(patch.path);
    if (!/^[0-9a-f]{64}$/.test(String(patch.sha256))) throw new Error(`bundle patch sha256이 올바르지 않습니다: ${patch.path}`);
  }
  if (!Array.isArray(manifest.bundle.packageFiles)) throw new Error("worker manifest bundle.packageFiles가 배열이 아닙니다.");
  if (!manifest.bundle.executionOwners || typeof manifest.bundle.executionOwners !== "object"
    || Array.isArray(manifest.bundle.executionOwners)) throw new Error("worker manifest bundle.executionOwners가 객체가 아닙니다.");
  // 삭제·이름 변경 파일 판정에 쓰는 설치 당시 실행 주체
  // 정렬된 고유 목록으로 bundle identity 재현성 유지
  for (const [file, owners] of Object.entries(manifest.bundle.executionOwners)) {
    relativePath(file);
    if (!Array.isArray(owners) || owners.length === 0) {
      throw new Error(`worker manifest bundle.executionOwners 소속이 올바르지 않습니다: ${file}`);
    }
    const normalizedOwners = [...new Set(owners.map((owner) => String(owner).trim()).filter(Boolean))].sort();
    if (normalizedOwners.length !== owners.length || normalizedOwners.some((owner, index) => owner !== owners[index])) {
      throw new Error(`worker manifest bundle.executionOwners 소속이 정렬된 고유 목록이 아닙니다: ${file}`);
    }
  }
  if (!["worker", "hostApi", "relay"].every((field) => Number.isInteger(manifest.protocol?.[field]))) throw new Error("worker manifest protocol이 올바르지 않습니다.");
  if (!Array.isArray(manifest.dataCompatibility?.reads)
    || !Number.isInteger(manifest.dataCompatibility?.writes)
    || !Number.isInteger(manifest.dataCompatibility?.rollbackReader)) throw new Error("worker manifest dataCompatibility가 올바르지 않습니다.");
  const seen = new Set();
  for (const file of manifest.files) {
    const clean = relativePath(file.path);
    if (clean !== file.path || seen.has(clean)) throw new Error(`worker manifest 파일 경로가 중복되거나 정규화되지 않았습니다: ${file.path}`);
    seen.add(clean);
    if (!Number.isInteger(file.size) || file.size < 0 || !/^[0-9a-f]{64}$/.test(file.sha256) || !Number.isInteger(file.mode)) {
      throw new Error(`worker manifest 파일 정보가 올바르지 않습니다: ${file.path}`);
    }
  }
  for (const field of DYNAMIC_FIELDS) {
    if (!Array.isArray(manifest.dynamic?.[field])) throw new Error(`worker manifest dynamic.${field}가 배열이 아닙니다.`);
    for (const file of manifest.dynamic[field]) if (!seen.has(relativePath(file))) throw new Error(`동적 파일이 files 목록에 없습니다: ${file}`);
  }
  return manifest;
}

export function manifestFilesDigest(manifest) {
  return sha256(canonicalJson(manifest.files));
}
