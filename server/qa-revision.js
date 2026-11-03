import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LEGACY = /^[a-f0-9]{64}$/;
const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function legacyQaRevision(root = defaultRoot) {
  const hash = crypto.createHash("sha256");
  const walk = relative => {
    const folder = path.join(root, relative);
    for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) walk(name);
      else if (entry.isFile()) {
        hash.update(name + "\0");
        hash.update(fs.readFileSync(path.join(root, name)));
      }
    }
  };
  for (const folder of ["server", "native", "web"]) walk(folder);
  return hash.digest("hex");
}

const revisionPart = (name, value) => {
  const text = String(value || "").trim();
  if (!text || text.length > 300) throw new Error(`${name}가 올바르지 않습니다.`);
  return encodeURIComponent(text);
};

export function qaRevision(options) {
  if (typeof options === "string") return legacyQaRevision(options);
  const bundleId = options?.bundleId ?? process.env.IRIS_BUNDLE_ID;
  const deployId = options?.deployId ?? process.env.IRIS_MCP_WORKER_DEPLOY_ID;
  if (!bundleId && !deployId) return legacyQaRevision(options?.root || defaultRoot);
  if (!bundleId || !deployId) throw new Error("QA revision에는 bundle id와 worker deploy id가 모두 필요합니다.");
  return `bundle=${revisionPart("bundle id", bundleId)};worker=${revisionPart("worker deploy id", deployId)}`;
}

export function qaRevisionMatches(saved, current = qaRevision(), { legacyRevision = process.env.IRIS_QA_LEGACY_REVISION, root = defaultRoot } = {}) {
  if (saved === current) return true;
  if (!LEGACY.test(String(saved || ""))) return false;
  const legacy = legacyRevision || (!process.env.IRIS_MCP_WORKER_DEPLOY_ID ? legacyQaRevision(root) : null);
  return saved === legacy;
}
