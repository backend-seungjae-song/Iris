// adb 실행 파일 위치. 서버(app-pick.js)와 MCP 앱 도구(bin/mcp/app.mjs)가 같은 목록으로 찾는다.
//
// 서버는 앱이나 launchd 가 실행하므로 사용자 셸의 PATH 를 받지 못한다(확인 결과: adb를 찾지 못했다).
// 그래서 흔한 설치 경로를 직접 확인한다. IRIS_ADB 로 바꿀 수 있다.
import fs from "node:fs";
import path from "node:path";

let cached;
export function adbPath() {
  if (cached !== undefined) return cached;
  const home = process.env.HOME || "";
  const cands = [
    process.env.IRIS_ADB,
    process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, "platform-tools", "adb"),
    process.env.ANDROID_SDK_ROOT && path.join(process.env.ANDROID_SDK_ROOT, "platform-tools", "adb"),
    path.join(home, "Library", "Android", "sdk", "platform-tools", "adb"),
    "/opt/homebrew/share/android-commandlinetools/platform-tools/adb",
    "/usr/local/share/android-commandlinetools/platform-tools/adb",
    "/opt/homebrew/bin/adb",
  ].filter(Boolean);
  cached = cands.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
  return cached;
}
