const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile, execFileSync } = require("node:child_process");
const { simulatorFrameworkDir } = require("./serve-sim-framework-env.cjs");

const XCODE_DOWNLOAD_URL = "https://apps.apple.com/app/xcode/id497799835";

function inspectXcode(options = {}) {
  const existsSync = options.existsSync ?? fs.existsSync;
  const readdirSync = options.readdirSync ?? fs.readdirSync;
  const roots = options.roots ?? ["/Applications", path.join(os.homedir(), "Applications")];
  let selectedDir = null;
  try {
    selectedDir = (options.selectedDir ?? execFileSync("/usr/bin/xcode-select", ["-p"], {
      encoding: "utf8", timeout: 3000,
    })).trim();
  } catch {}

  function usable(developerDir) {
    return existsSync(path.join(developerDir, "usr", "bin", "simctl"))
      && Boolean(simulatorFrameworkDir(developerDir, existsSync));
  }

  if (selectedDir && usable(selectedDir)) {
    return { status: "ready", selectedDir, candidates: [selectedDir] };
  }

  const candidates = [];
  const installedApps = [];
  for (const root of roots) {
    let entries;
    try { entries = readdirSync(root); } catch { continue; }
    for (const entry of entries) {
      if (!/^Xcode.*\.app$/i.test(entry)) continue;
      const developerDir = path.join(root, entry, "Contents", "Developer");
      if (!existsSync(path.join(root, entry, "Contents", "MacOS", "Xcode"))) continue;
      installedApps.push(path.join(root, entry));
      if (usable(developerDir)) candidates.push(developerDir);
    }
  }
  const unique = [...new Set(candidates)];
  return {
    status: unique.length === 1 ? "repair" : unique.length > 1 ? "choose" : installedApps.length ? "incomplete" : "missing",
    selectedDir,
    candidates: unique,
    installedApps,
  };
}

function xcodeAppPath(developerDir) {
  if (path.basename(developerDir) !== "Developer" || path.basename(path.dirname(developerDir)) !== "Contents") return null;
  const appPath = path.dirname(path.dirname(developerDir));
  return /\.app$/i.test(path.basename(appPath)) ? appPath : null;
}

async function switchXcode(developerDir, options = {}) {
  const inspect = options.inspect ?? inspectXcode;
  if (!xcodeAppPath(developerDir) || inspect({ selectedDir: developerDir, roots: [] }).status !== "ready") {
    return { ok: false, error: "시뮬레이터 도구가 있는 Xcode 앱을 선택하세요" };
  }
  const script = 'on run argv\n  do shell script "/usr/bin/xcode-select --switch " & quoted form of (item 1 of argv) with administrator privileges\nend run';
  await new Promise((resolve, reject) => {
    (options.execFile ?? execFile)("/usr/bin/osascript", ["-e", script, developerDir], { timeout: 120000 },
      (error) => error ? reject(error) : resolve());
  });
  const current = inspect();
  return current.status === "ready" && current.selectedDir === developerDir
    ? { ok: true } : { ok: false, error: "Xcode 선택을 확인하지 못했습니다" };
}

module.exports = { XCODE_DOWNLOAD_URL, inspectXcode, switchXcode, xcodeAppPath };
