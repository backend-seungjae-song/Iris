import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { bundleDifferences } from "./bundle-generation.mjs";
import { manifestFilesDigest, validateDeploymentManifest } from "./manifest.mjs";
import {
  fileRecord,
  fsyncDirectory,
  fsyncFile,
  listFiles,
  readJson,
  relativePath,
  removeDirectoryInside,
  sha256,
  sourceFile,
} from "./util.mjs";

export class FullInstallRequired extends Error {
  constructor(differences) {
    super(`설치 bundle 세대가 달라 전체 설치가 필요합니다: ${differences.map((item) => item.field).join(", ")}`);
    this.code = "FULL_INSTALL_REQUIRED";
    this.differences = differences;
  }
}

function manifestText(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function verifyCopiedFiles(directory, manifest) {
  const expected = [];
  for (const file of manifest.files) {
    const actual = fileRecord(directory, file.path);
    if (actual.size !== file.size) throw new Error(`파일 크기 불일치: ${file.path}`);
    if (actual.sha256 !== file.sha256) throw new Error(`파일 sha256 불일치: ${file.path}`);
    if (process.platform !== "win32" && actual.mode !== file.mode) throw new Error(`파일 mode 불일치: ${file.path}`);
    expected.push(file.path);
  }
  const actualFiles = listFiles(directory).filter((file) => !["manifest.json", ".complete.json", "node_modules"].includes(file) && !file.startsWith("node_modules/"));
  if (JSON.stringify(actualFiles.sort()) !== JSON.stringify(expected.sort())) {
    throw new Error(`실행 폴더 파일 목록 불일치: expected=${expected.join(",")} actual=${actualFiles.join(",")}`);
  }
}

export function verifyDeployment(directory) {
  const completeFile = path.join(directory, ".complete.json");
  if (!fs.existsSync(completeFile)) throw new Error(`완성 표시 파일이 없습니다: ${completeFile}`);
  const manifestFile = path.join(directory, "manifest.json");
  const manifestBytes = fs.readFileSync(manifestFile);
  const manifest = validateDeploymentManifest(JSON.parse(manifestBytes.toString("utf8")));
  const complete = readJson(completeFile, ".complete.json");
  if (complete.schemaVersion !== 1 || complete.deployId !== manifest.deployId) throw new Error("완성 표시의 배포 ID가 manifest와 다릅니다.");
  if (complete.manifestSha256 !== sha256(manifestBytes)) throw new Error("완성 표시의 manifest sha256이 다릅니다.");
  if (complete.filesSha256 !== manifestFilesDigest(manifest)) throw new Error("완성 표시의 파일 목록 sha256이 다릅니다.");
  verifyCopiedFiles(directory, manifest);
  const modules = path.join(directory, "node_modules");
  if (!fs.existsSync(modules) || !fs.lstatSync(modules).isSymbolicLink()) throw new Error("node_modules 링크가 없습니다.");
  return { directory: path.resolve(directory), manifest, complete, nodeModules: fs.realpathSync(modules) };
}

function copyManifestFiles(sourceRoot, destination, manifest) {
  for (const file of manifest.files) {
    const source = sourceFile(sourceRoot, file.path).absolute;
    const target = sourceFile(destination, file.path, { mustExist: false, rejectSymlink: false }).absolute;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, file.mode);
  }
}

export function prepareDeployment({ sourceRoot, stateDir, manifest, installedBundle, installedNodeModules }) {
  validateDeploymentManifest(manifest);
  const differences = bundleDifferences(manifest.bundle, installedBundle);
  if (differences.length) throw new FullInstallRequired(differences);
  if (!path.isAbsolute(stateDir)) throw new Error(`상태 폴더는 절대경로여야 합니다: ${stateDir}`);
  if (!installedNodeModules || !fs.statSync(installedNodeModules).isDirectory()) throw new Error(`설치 bundle의 node_modules가 없습니다: ${installedNodeModules}`);
  const deployRoot = path.join(stateDir, "mcp-worker");
  fs.mkdirSync(deployRoot, { recursive: true });
  const finalDirectory = path.join(deployRoot, relativePath(manifest.deployId));
  if (fs.existsSync(finalDirectory)) return { ...verifyDeployment(finalDirectory), reused: true };
  const temporary = path.join(deployRoot, `.${manifest.deployId}.tmp-${randomUUID()}`);
  fs.mkdirSync(temporary, { recursive: false, mode: 0o700 });
  try {
    copyManifestFiles(sourceRoot, temporary, manifest);
    const manifestFile = path.join(temporary, "manifest.json");
    fs.writeFileSync(manifestFile, manifestText(manifest), { flag: "wx" });
    fsyncFile(manifestFile);
    verifyCopiedFiles(temporary, manifest);
    fs.symlinkSync(path.resolve(installedNodeModules), path.join(temporary, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const complete = {
      schemaVersion: 1,
      deployId: manifest.deployId,
      manifestSha256: sha256(fs.readFileSync(manifestFile)),
      filesSha256: manifestFilesDigest(manifest),
      bundleId: manifest.bundle.id,
      completedAt: new Date().toISOString(),
    };
    const completeFile = path.join(temporary, ".complete.json");
    fs.writeFileSync(completeFile, `${JSON.stringify(complete, null, 2)}\n`, { flag: "wx" });
    fsyncFile(completeFile);
    verifyDeployment(temporary);
    fsyncDirectory(temporary);
    try { fs.renameSync(temporary, finalDirectory); }
    catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code) || !fs.existsSync(finalDirectory)) throw error;
      verifyDeployment(finalDirectory);
      removeDirectoryInside(deployRoot, temporary);
      return { ...verifyDeployment(finalDirectory), reused: true };
    }
    fsyncDirectory(deployRoot);
    return { ...verifyDeployment(finalDirectory), reused: false };
  } catch (error) {
    if (fs.existsSync(temporary)) removeDirectoryInside(deployRoot, temporary);
    throw error;
  }
}
