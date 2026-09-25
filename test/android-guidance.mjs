import assert from "node:assert/strict";
import { test } from "node:test";
import { androidGuidance } from "../web/js/emulator/android-guidance.js";

test("설치 누락과 SDK 구성 요소 부족에 맞는 작업을 보여 준다", () => {
  const base = { android: { sdkFound: false }, androidSetup: { studioPath: null } };
  assert.equal(androidGuidance(base).action, "download");
  assert.equal(androidGuidance(base).secondaryAction, "locate");
  const partial = { ...base, androidSetup: { studioPath: "/Applications/Android Studio.app", sdkParts: { adb: true, emulator: false } } };
  assert.equal(androidGuidance(partial).action, "open");
  assert.match(androidGuidance(partial).message, /에뮬레이터/);
});

test("SDK가 있어도 가상 기기가 없으면 생성 경로를 안내한다", () => {
  const base = {
    android: { sdkFound: true, message: "No Android devices or AVDs found. Create one in Android Studio." },
    androidSetup: { studioPath: "/Applications/Android Studio.app" }, devices: [],
  };
  assert.equal(androidGuidance(base).action, "open");
  assert.match(androidGuidance(base).message, /Virtual Device Manager/);
  assert.equal(androidGuidance({ ...base, devices: [{ runtime: "Android" }] }), null);
});
