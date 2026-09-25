const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function simulatorFrameworkDir(developerDir, existsSync = fs.existsSync) {
  const candidates = [
    path.resolve(developerDir, "..", "SharedFrameworks"),
    path.join(developerDir, "Library", "PrivateFrameworks"),
  ];
  return candidates.find((dir) => existsSync(path.join(dir, "SimulatorKit.framework", "SimulatorKit"))) || null;
}

function withSimulatorFrameworkPath(env, options = {}) {
  if ((options.platform ?? process.platform) !== "darwin") return env;

  let developerDir;
  try {
    developerDir = (options.developerDir ?? execFileSync("/usr/bin/xcode-select", ["-p"], {
      encoding: "utf8", timeout: 3000,
    })).trim();
  } catch {
    return env;
  }

  const existsSync = options.existsSync ?? fs.existsSync;
  const frameworkDir = simulatorFrameworkDir(developerDir, existsSync);
  if (!frameworkDir) return env;
  return {
    ...env,
    DYLD_FRAMEWORK_PATH: [frameworkDir, env.DYLD_FRAMEWORK_PATH].filter(Boolean).join(path.delimiter),
  };
}

module.exports = { simulatorFrameworkDir, withSimulatorFrameworkPath };
