const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ANDROID_STUDIO_URL = "https://developer.android.com/studio";

function sdkParts(root, existsSync = fs.existsSync, platform = process.platform) {
  const windows = platform === "win32";
  const paths = windows ? path.win32 : path;
  const suffix = windows ? ".exe" : "";
  return {
    adb: existsSync(paths.join(root, "platform-tools", "adb" + suffix)),
    emulator: existsSync(paths.join(root, "emulator", "emulator" + suffix)),
  };
}

function inspectAndroidSetup(options = {}) {
  const existsSync = options.existsSync ?? fs.existsSync;
  const readdirSync = options.readdirSync ?? fs.readdirSync;
  const home = options.home ?? os.homedir();
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const windows = platform === "win32";
  const paths = windows ? path.win32 : path;
  const localAppData = env.LOCALAPPDATA || paths.join(home, "AppData", "Local");
  const roots = options.roots ?? (windows
    ? [env.ProgramFiles, env["ProgramFiles(x86)"]].filter(Boolean).map((root) => paths.join(root, "Android"))
    : ["/Applications", path.join(home, "Applications")]);
  const sdkCandidates = options.configuredPath ? [options.configuredPath] : [...new Set([
    env.ANDROID_HOME, env.ANDROID_SDK_ROOT, windows ? paths.join(localAppData, "Android", "Sdk") : path.join(home, "Library", "Android", "sdk"),
  ].filter(Boolean))];
  const sdk = sdkCandidates.map((root) => ({ path: root, ...sdkParts(root, existsSync, platform) }));
  const complete = sdk.find((item) => item.adb && item.emulator);
  const partial = sdk.find((item) => item.adb || item.emulator || existsSync(item.path));
  const installedApps = [];
  for (const root of roots) {
    let entries;
    try { entries = readdirSync(root); } catch { continue; }
    for (const entry of entries) {
      if (windows) {
        if (!/^Android Studio/i.test(entry)) continue;
        const executable = paths.join(root, entry, "bin", "studio64.exe");
        if (existsSync(executable)) installedApps.push(executable);
      } else {
        if (!/^Android Studio.*\.app$/i.test(entry)) continue;
        const appPath = path.join(root, entry);
        if (existsSync(path.join(appPath, "Contents", "Info.plist"))) installedApps.push(appPath);
      }
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
