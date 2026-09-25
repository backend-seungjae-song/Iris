import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { withSimulatorFrameworkPath } = require("../native/electron/emulator/serve-sim-framework-env.cjs");
const developerDir = "/Applications/Xcode.app/Contents/Developer";
const shared = "/Applications/Xcode.app/Contents/SharedFrameworks";
const legacy = path.join(developerDir, "Library", "PrivateFrameworks");
const simulatorKit = (dir) => path.join(dir, "SimulatorKit.framework", "SimulatorKit");

test("Xcode SharedFrameworks 경로를 serve-sim 자식 환경에 전달한다", () => {
  const env = { DYLD_FRAMEWORK_PATH: "/existing" };
  const result = withSimulatorFrameworkPath(env, {
    platform: "darwin", developerDir,
    existsSync: (file) => file === simulatorKit(shared),
  });
  assert.equal(result.DYLD_FRAMEWORK_PATH, `${shared}:/existing`);
  assert.equal(env.DYLD_FRAMEWORK_PATH, "/existing");
});

test("구형 Xcode 경로와 프레임워크 부재를 구분한다", () => {
  const options = { platform: "darwin", developerDir };
  assert.equal(withSimulatorFrameworkPath({}, {
    ...options, existsSync: (file) => file === simulatorKit(legacy),
  }).DYLD_FRAMEWORK_PATH, legacy);
  const env = { PATH: "/bin" };
  assert.equal(withSimulatorFrameworkPath(env, { ...options, existsSync: () => false }), env);
  assert.equal(withSimulatorFrameworkPath(env, { ...options, platform: "linux" }), env);
});
