import fs from "node:fs";
import os from "node:os";

// 에이전트가 새로 켤 수 있는 에뮬레이터 대수. 켜진 기기(Iris 밖에서 켠 것 포함)가 한도에 닿으면 새로 켜지 않는다.
// 기기 하나의 몫은 추정값이다. iOS 시뮬레이터는 1.5~2GiB, Android 에뮬레이터는 기본 2GiB 램에 qemu 몫이 더 든다.

const GiB = 1024 ** 3;
export const CAPACITY_RULE = Object.freeze({
  reserveMemory: 8 * GiB, memoryPerDevice: 3 * GiB,
  reserveCores: 2, coresPerDevice: 2,
  reserveDisk: 20 * GiB, diskPerDevice: 4 * GiB,
});

function freeDiskBytes(dir) {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch { return null; }
}

// 시뮬레이터(~/Library/Developer)와 AVD(~/.android)가 모두 홈 볼륨에 있다.
export function emulatorCapacity({
  totalMemory = os.totalmem(), cores = os.cpus().length, freeDisk = freeDiskBytes(os.homedir()), rule = CAPACITY_RULE,
} = {}) {
  const byMemory = Math.floor((totalMemory - rule.reserveMemory) / rule.memoryPerDevice);
  const byCores = Math.floor((cores - rule.reserveCores) / rule.coresPerDevice);
  const limit = Math.max(1, Math.min(byMemory, byCores));
  // 여유를 못 읽으면 막지 않는다. 못 잰 것을 부족으로 판정하지 않는다.
  const diskOk = freeDisk == null || freeDisk - rule.reserveDisk >= rule.diskPerDevice;
  const gib = (n) => Math.round((n / GiB) * 10) / 10;
  return {
    limit, diskOk,
    detail: { cores, memoryGiB: gib(totalMemory), freeDiskGiB: freeDisk == null ? null : gib(freeDisk), byMemory, byCores },
  };
}
