import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { inspectAndroidSetup } = require("../native/electron/emulator/android-setup.cjs");
const home = "/tmp/iris-android-test";
const sdk = path.join(home, "Library", "Android", "sdk");
const studio = "/Applications/Android Studio Canary.app";
const inspect = (found, configuredPath) => inspectAndroidSetup({
  home, configuredPath, env: {}, roots: ["/Applications"],
  existsSync: (file) => found.has(file), readdirSync: () => ["Android Studio Canary.app"],
});

test("Studio 이름이나 SDK 위치에 버전을 가정하지 않는다", () => {
  const found = new Set([
    path.join(studio, "Contents", "Info.plist"),
    path.join(sdk, "platform-tools", "adb"),
    path.join(sdk, "emulator", "emulator"),
  ]);
  assert.deepEqual(inspect(found), {
    studioPath: studio, sdkPath: sdk, sdkParts: { adb: true, emulator: true },
  });
});

test("지정한 SDK의 구성 요소 부족을 다른 자동 경로로 가리지 않는다", () => {
  const chosen = "/custom/android-sdk";
  const found = new Set([
    path.join(chosen, "platform-tools", "adb"),
    path.join(sdk, "platform-tools", "adb"),
    path.join(sdk, "emulator", "emulator"),
  ]);
  assert.deepEqual(inspect(found, chosen).sdkParts, { adb: true, emulator: false });
  assert.equal(inspect(found, chosen).sdkPath, chosen);
});
