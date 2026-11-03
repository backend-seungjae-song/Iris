import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function relativePath(value) {
  const normalized = String(value).replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`배포 경로는 상대경로여야 합니다: ${value}`);
  }
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`배포 경로에 빈 칸, . 또는 ..를 쓸 수 없습니다: ${value}`);
  }
  return parts.join("/");
}

export function sourceFile(root, relative, { mustExist = true, rejectSymlink = true } = {}) {
  const rel = relativePath(relative);
  const absolute = path.join(path.resolve(root), ...rel.split("/"));
  if (mustExist && !fs.existsSync(absolute)) throw new Error(`배포 파일이 없습니다: ${rel}`);
  if (rejectSymlink && fs.existsSync(absolute)) {
    let cursor = path.resolve(root);
    for (const part of rel.split("/")) {
      cursor = path.join(cursor, part);
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`배포 경로에 심볼릭 링크를 쓸 수 없습니다: ${rel}`);
    }
  }
  return { relative: rel, absolute };
}

export function listFiles(root, { ignore = [] } = {}) {
  const base = path.resolve(root);
  const ignored = new Set(ignore);
  const files = [];
  const visit = (directory, prefix = "") => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (ignored.has(relative) || ignored.has(entry.name)) continue;
      if (entry.isSymbolicLink()) files.push(relative);
      else if (entry.isDirectory()) visit(path.join(directory, entry.name), relative);
      else if (entry.isFile()) files.push(relative);
    }
  };
  if (fs.existsSync(base)) visit(base);
  return files;
}

export function readJson(file, label = path.basename(file)) {
  let value;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { throw new Error(`${label}을 읽지 못했습니다: ${error.message}`); }
  return value;
}

export function fileRecord(root, relative) {
  const resolved = sourceFile(root, relative);
  const stat = fs.statSync(resolved.absolute);
  if (!stat.isFile()) throw new Error(`배포 경로가 파일이 아닙니다: ${resolved.relative}`);
  const bytes = fs.readFileSync(resolved.absolute);
  return { path: resolved.relative, size: bytes.length, sha256: sha256(bytes), mode: stat.mode & 0o777 };
}

export function fsyncFile(file) {
  const descriptor = fs.openSync(file, "r");
  try { fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

export function fsyncDirectory(directory) {
  if (process.platform === "win32") return;
  const descriptor = fs.openSync(directory, "r");
  try { fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

export function removeDirectoryInside(parent, directory) {
  const base = path.resolve(parent);
  const target = path.resolve(directory);
  if (path.dirname(target) !== base || target === base) throw new Error(`정리 범위를 벗어난 폴더입니다: ${target}`);
  if (!fs.existsSync(target)) return;
  if (fs.lstatSync(target).isSymbolicLink()) throw new Error(`심볼릭 링크 폴더는 정리하지 않습니다: ${target}`);
  fs.rmSync(target, { recursive: true, force: false });
}
