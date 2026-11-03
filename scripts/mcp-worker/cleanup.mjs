import fs from "node:fs";
import path from "node:path";

import { readJson, removeDirectoryInside } from "./util.mjs";

export function cleanupDeployments({ stateDir, inProgress = [], keep = 2 } = {}) {
  if (!Number.isInteger(keep) || keep < 0) throw new Error(`keep은 0 이상의 정수여야 합니다: ${keep}`);
  const deployRoot = path.join(stateDir, "mcp-worker");
  if (!fs.existsSync(deployRoot)) return [];
  let current = {};
  const currentFile = path.join(deployRoot, "current.json");
  if (fs.existsSync(currentFile)) current = readJson(currentFile, "current.json");
  const protectedNames = new Set([current.deployId, current.previousDeployId, ...inProgress].filter(Boolean));
  const candidates = fs.readdirSync(deployRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !protectedNames.has(entry.name) && entry.name !== "worker.lock")
    .map((entry) => ({ name: entry.name, mtimeMs: fs.statSync(path.join(deployRoot, entry.name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  const removed = [];
  for (const item of candidates.slice(keep)) {
    removeDirectoryInside(deployRoot, path.join(deployRoot, item.name));
    removed.push(item.name);
  }
  return removed;
}
