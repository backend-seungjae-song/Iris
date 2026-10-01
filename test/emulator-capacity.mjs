import test from "node:test";
import assert from "node:assert/strict";
import { emulatorCapacity } from "../server/emulator-capacity.js";

const GiB = 1024 ** 3;

test("한도는 메모리·코어 가운데 작은 쪽이고 최소 1대다", () => {
  assert.equal(emulatorCapacity({ totalMemory: 18 * GiB, cores: 12, freeDisk: 100 * GiB }).limit, 3);
  assert.equal(emulatorCapacity({ totalMemory: 64 * GiB, cores: 8, freeDisk: 100 * GiB }).limit, 3);
  assert.equal(emulatorCapacity({ totalMemory: 8 * GiB, cores: 4, freeDisk: 100 * GiB }).limit, 1);
});

test("디스크 여유가 예비분과 한 대 몫보다 적으면 새로 켜지 않는다", () => {
  assert.equal(emulatorCapacity({ totalMemory: 32 * GiB, cores: 10, freeDisk: 23 * GiB }).diskOk, false);
  assert.equal(emulatorCapacity({ totalMemory: 32 * GiB, cores: 10, freeDisk: 24 * GiB }).diskOk, true);
  assert.equal(emulatorCapacity({ totalMemory: 32 * GiB, cores: 10, freeDisk: null }).diskOk, true);
});
