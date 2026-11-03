import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const orca = require("../native/electron/emulator/orca-emulator.cjs");
const { guardSharedDevices, inspectSharedDevice } = require("../native/electron/emulator/shared-device-guard.cjs");

const UDID = "11111111-1111-4111-8111-111111111111";

function setup(found) {
  const bridge = new orca.EmulatorBridge();
  const calls = [];
  const ios = bridge.iosBackend;
  ios.resolveDeviceId = async (device) => device;
  ios.stopHelperForDevice = async (udid) => { calls.push(["stop", udid]); };
  ios.shutdownDevice = async (udid) => { calls.push(["shutdown", udid]); };
  const guard = guardSharedDevices(bridge, async () => found);
  const info = { deviceUdid: UDID, helperPid: 4242, wsUrl: "", streamUrl: "", axUrl: "", backend: "ios" };
  return { bridge, calls, guard, info, ios };
}

for (const [name, found, expected] of [
  ["device and helper from another Iris", { device: true, helper: true }, []],
  ["device from another Iris, helper started here", { device: true, helper: false }, [["stop", UDID]]],
  ["device and helper started here", { device: false, helper: false }, [["stop", UDID], ["shutdown", UDID]]],
]) {
  test(`app quit cleans only what this app started: ${name}`, async () => {
    const { bridge, calls, guard, info } = setup(found);
    await guard.beforeAttach(UDID);
    bridge.sessionRegistry.registerActive("w1", info, { managed: true });
    await bridge.onAppQuit();
    assert.deepEqual(calls, expected);
  });

  test(`idle tab cleanup cleans only what this app started: ${name}`, async () => {
    const { bridge, calls, guard, info, ios } = setup(found);
    await guard.beforeAttach(UDID);
    await bridge.startLeases.cleanupWhenIdle(ios, info, () => false, { includeOrphaned: true, shutdownDevice: true });
    assert.deepEqual(calls, expected);
  });
}

test("failed inspection treats the device and helper as another app's", async () => {
  assert.deepEqual(await inspectSharedDevice(UDID, async () => null), { device: true, helper: true });
  const exec = async (command) => command === "xcrun"
    ? JSON.stringify({ devices: { ios: [{ udid: UDID, state: "Shutdown" }] } })
    : `123 /x/serve-sim-bin 22222222-2222-4222-8222-222222222222 --port 1\n`;
  assert.deepEqual(await inspectSharedDevice(UDID, exec), { device: false, helper: false });
});
