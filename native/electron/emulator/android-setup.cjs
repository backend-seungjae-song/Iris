const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ANDROID_STUDIO_URL = "https://developer.android.com/studio";

function sdkParts(root, existsSync = fs.existsSync) {
  return {
    adb: existsSync(path.join(root, "platform-tools", "adb")),
    emulator: existsSync(path.join(root, "emulator", "emulator")),
  };
}

function inspectAndroidSetup(options = {}) {
  const existsSync = options.existsSync ?? fs.existsSync;
  const readdirSync = options.readdirSync ?? fs.readdirSync;
  const home = options.home ?? os.homedir();
  const env = options.env ?? process.env;
  const roots = options.roots ?? ["/Applications", path.join(home, "Applications")];
  const sdkCandidates = options.configuredPath ? [options.configuredPath] : [...new Set([
    env.ANDROID_HOME, env.ANDROID_SDK_ROOT, path.join(home, "Library", "Android", "sdk"),
  ].filter(Boolean))];
  const sdk = sdkCandidates.map((root) => ({ path: root, ...sdkParts(root, existsSync) }));
  const complete = sdk.find((item) => item.adb && item.emulator);
  const partial = sdk.find((item) => item.adb || item.emulator || existsSync(item.path));
  const installedApps = [];
  for (const root of roots) {
    let entries;
    try { entries = readdirSync(root); } catch { continue; }
    for (const entry of entries) {
      if (!/^Android Studio.*\.app$/i.test(entry)) continue;
      const appPath = path.join(root, entry);
      if (existsSync(path.join(appPath, "Contents", "Info.plist"))) installedApps.push(appPath);
    }
  }
  return {
    studioPath: installedApps[0] || null,
    sdkPath: complete?.path || partial?.path || null,
    sdkParts: complete ? { adb: true, emulator: true } : partial
      ? { adb: partial.adb, emulator: partial.emulator } : { adb: false, emulator: false },
  };
}

module.exports = { ANDROID_STUDIO_URL, inspectAndroidSetup, sdkParts };
