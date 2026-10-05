const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function headlessShellCandidates(home = os.homedir(), env = process.env) {
  const found = [];
  for (const [root, prefix] of [
    [path.join(home, ".cache/puppeteer/chrome-headless-shell"), ""],
    [path.join(home, "Library/Caches/ms-playwright"), "chromium_headless_shell-"],
    ...(process.platform === "win32" ? [[path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "ms-playwright"), "chromium_headless_shell-"]] : []),
  ]) {
    let versions = [];
    try { versions = fs.readdirSync(root).filter((name) => name.startsWith(prefix)); } catch { continue; }
    for (const version of versions) {
      const folder = path.join(root, version);
      let platforms = [];
      try { platforms = fs.readdirSync(folder).filter((name) => name.startsWith("chrome-headless-shell-")); } catch { continue; }
      for (const platform of platforms) {
        for (const name of ["chrome-headless-shell", "chrome-headless-shell.exe"]) {
          const bin = path.join(folder, platform, name);
          try {
            fs.accessSync(bin, fs.constants.X_OK);
            if (!isHeadlessShell(bin)) continue;
            found.push({ bin, mtime: fs.statSync(bin).mtimeMs });
          } catch {}
        }
      }
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime).map((entry) => entry.bin);
}

function isHeadlessShell(bin) {
  // 일반 Chrome을 가리키는 심볼릭 링크도 Dock에 앱을 추가한다.
  const real = fs.realpathSync(bin);
  return /^chrome-headless-shell(?:\.exe)?$/.test(path.basename(real)) && fs.statSync(real).isFile();
}

function headlessLaunchOptions({ home = os.homedir(), env = process.env } = {}) {
  const override = env.IRIS_HEADLESS_SHELL || env.CHROME_BIN;
  const executablePath = override || headlessShellCandidates(home, env)[0];
  try {
    if (executablePath) {
      fs.accessSync(executablePath, fs.constants.X_OK);
      if (isHeadlessShell(executablePath)) return { executablePath, headless: "shell" };
    }
  } catch {}
  throw new Error("자동 검증에는 chrome-headless-shell이 필요합니다. IRIS_HEADLESS_SHELL에 실행 경로를 지정하거나 "
    + "npx @puppeteer/browsers install chrome-headless-shell@stable --path ~/.cache/puppeteer 로 설치하세요.");
}

module.exports = { headlessShellCandidates, headlessLaunchOptions };

if (require.main === module) {
  try { console.log(headlessLaunchOptions().executablePath); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
