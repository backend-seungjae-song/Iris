const fs = require("node:fs");
const { copyTreeSync } = require("../../server/copy-tree.cjs");
const os = require("node:os");
const path = require("node:path");

const CHROME_ID = /^[a-p]{32}$/;

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function readManifest(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
  if (!manifest || typeof manifest.name !== "string" || !/^\d+(?:\.\d+){0,3}$/.test(manifest.version)
    || ![2, 3].includes(manifest.manifest_version)) throw new Error("유효한 확장 manifest.json이 없습니다.");
  return manifest;
}

function displayName(directory, manifest) {
  const match = /^__MSG_(.+)__$/.exec(manifest.name);
  if (match && /^[A-Za-z0-9_-]+$/.test(manifest.default_locale || "")) {
    try {
      const messages = JSON.parse(fs.readFileSync(path.join(directory, "_locales", manifest.default_locale, "messages.json"), "utf8"));
      return messages[match[1]]?.message || manifest.name;
    } catch {}
  }
  return manifest.name;
}

function compareVersions(a, b) {
  const left = a.split(/[._]/).map(Number), right = b.split(/[._]/).map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

function discoverChromeExtensions(root = process.platform === "win32"
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Google", "Chrome", "User Data")
  : path.join(os.homedir(), "Library/Application Support/Google/Chrome")) {
  const profiles = [];
  let info = {};
  try { info = JSON.parse(fs.readFileSync(path.join(root, "Local State"), "utf8")).profile?.info_cache || {}; } catch {}
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return profiles; }
  const rootReal = fs.realpathSync(root);
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^(Default|Profile \d+)$/.test(entry.name)) continue;
    const extensionsRoot = path.join(root, entry.name, "Extensions");
    let ids;
    try {
      if (!inside(rootReal, fs.realpathSync(extensionsRoot))) continue;
      ids = fs.readdirSync(extensionsRoot, { withFileTypes: true });
    } catch { continue; }
    const candidates = [];
    for (const id of ids) {
      if (!id.isDirectory() || !CHROME_ID.test(id.name)) continue;
      const idRoot = path.join(extensionsRoot, id.name);
      let versions;
      try { versions = fs.readdirSync(idRoot, { withFileTypes: true }); } catch { continue; }
      versions.sort((a, b) => compareVersions(b.name, a.name));
      for (const version of versions) {
        if (!version.isDirectory() || !/^\d+(?:\.\d+)*(?:_\d+)?$/.test(version.name)) continue;
        const directory = path.join(idRoot, version.name);
        try {
          if (!inside(rootReal, fs.realpathSync(directory))) continue;
          const manifest = readManifest(directory);
          candidates.push({ sourceId: id.name, path: directory, name: displayName(directory, manifest), version: manifest.version });
          break;
        } catch {}
      }
    }
    if (candidates.length) profiles.push({ name: info[entry.name]?.name || entry.name, candidates });
  }
  return profiles;
}

function copyExtension(source, destination) {
  const root = fs.realpathSync(source);
  readManifest(root);
  copyTreeSync(root, destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: (candidate) => {
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink() || !inside(root, fs.realpathSync(candidate)) || (!stat.isDirectory() && !stat.isFile())) {
        throw new Error("확장 폴더의 링크 또는 특수 파일은 가져올 수 없습니다.");
      }
      return true;
    },
  });
  return readManifest(destination);
}

module.exports = { copyExtension, discoverChromeExtensions, displayName, inside, readManifest };
