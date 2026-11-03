// 설치 앱과 개발 앱이 같은 iOS 시뮬레이터를 쓸 때 자동 정리의 범위
//   붙이기 전에 이미 켜져 있던 기기는 끄지 않고, 이미 있던 화면 helper 는 종료하지 않음
//   (serve-sim --kill 은 기기 번호로 모든 helper 를 종료하므로 다른 앱의 화면과 기기까지 꺼짐)
//   사용자가 직접 끄는 경로(bridge.kill·shutdown)는 그대로
const { execFile } = require("node:child_process");

function run(command, args) {
  return new Promise((resolve) => execFile(command, args, { timeout: 10000, maxBuffer: 16 * 1024 * 1024 },
    (error, stdout) => resolve(error ? null : String(stdout))));
}

// 확인하지 못한 항목은 다른 앱의 것으로 판정
async function inspectSharedDevice(udid, exec = run) {
  const [list, ps] = await Promise.all([exec("xcrun", ["simctl", "list", "devices", "-j"]), exec("ps", ["-axo", "pid=,command="])]);
  let device = true;
  try { device = Object.values(JSON.parse(list).devices).flat().some((d) => d.udid === udid && d.state === "Booted"); } catch {}
  const helper = ps == null || ps.split("\n").some((line) => /(^|\/)serve-sim-bin\s/.test(line) && line.trim().split(/\s+/).includes(udid));
  return { device, helper };
}

function guardSharedDevices(bridge, inspect = inspectSharedDevice) {
  const shared = new Map(); // udid → { device, helper }
  const leases = bridge.startLeases;
  const addPending = leases.addPendingCleanup.bind(leases);
  leases.addPendingCleanup = (backend, info, isRegistered, options = {}) => {
    const found = shared.get(info.deviceUdid);
    if (found?.helper) return;
    addPending(backend, info, isRegistered, found?.device ? { ...options, shutdownDevice: false } : options);
  };
  const quit = bridge.onAppQuit.bind(bridge);
  bridge.onAppQuit = async () => {
    for (const session of bridge.sessionRegistry.listSessions()) {
      const found = shared.get(session.deviceUdid);
      if (!session.managed || !found) continue;
      if (!found.helper) await bridge.backendForKind(session.backend)?.stopHelperForDevice(session.deviceUdid, { helperPid: session.pid }).catch(() => {});
      session.managed = false;
    }
    return quit();
  };
  return {
    async beforeAttach(device) {
      if (!device) return;
      let udid;
      try { udid = await bridge.iosBackend.resolveDeviceId(device); } catch { return; }
      if (!udid || shared.has(udid)) return;
      const found = await inspect(udid);
      if (found.device || found.helper) shared.set(udid, found);
    },
  };
}

module.exports = { guardSharedDevices, inspectSharedDevice };
