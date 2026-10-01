import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createRegistry } from "../server/remote/registry.js";

const CONN_KEY = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEjdktXx43iY9//Ig37NmNXA3vQDP11ZfXXFQBrWzeCocqIjitkTHWGanBj5owBs0UlykarWzY111ZRvJBHemNeg==";
const DEVICE = { deviceId: "device-1", name: "Galaxy", connKey: CONN_KEY, nodeId: "node-1", addedAt: 1_000 };
const OFF = { version: 1, enabled: false, devices: [] };
const ON = { version: 1, enabled: true, devices: [DEVICE] };

async function tempState(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "iris-remote-registry-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writeRegistry(stateDir, state, clean = false) {
  const remoteDir = path.join(stateDir, "remote");
  await fsp.mkdir(remoteDir, { recursive: true });
  await fsp.writeFile(path.join(remoteDir, "registry.json"), `${JSON.stringify(state)}\n`);
  if (clean) await fsp.writeFile(path.join(remoteDir, "clean-shutdown"), "clean\n");
}

test("새 등록부는 꺼진 상태로 원자 저장하고 파일 권한을 0600으로 제한한다", async (t) => {
  const stateDir = await tempState(t);
  const registry = createRegistry({ stateDir });
  const initialized = await registry.initialize();
  assert.deepEqual(initialized, { ok: true, clean: false, created: true, needsConfirmation: false });
  const file = path.join(stateDir, "remote", "registry.json");
  assert.deepEqual(JSON.parse(await fsp.readFile(file, "utf8")), OFF);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("폐기와 끄기는 즉시 유효하고 추가와 켜기는 저장 성공 뒤 유효하다", async (t) => {
  const stateDir = await tempState(t);
  const registry = createRegistry({ stateDir, initialState: structuredClone(ON) });
  registry.change({ type: "remove-device", deviceId: DEVICE.deviceId });
  registry.change({ type: "disable" });
  assert.deepEqual(registry.effectiveState(), OFF);
  assert.deepEqual(registry.snapshot(), OFF);
  assert.equal((await registry.save()).ok, true);

  registry.change({ type: "add-device", device: DEVICE });
  registry.change({ type: "enable" });
  assert.deepEqual(registry.effectiveState(), OFF);
  assert.deepEqual(registry.snapshot(), ON);
  assert.equal((await registry.save()).ok, true);
  assert.deepEqual(registry.effectiveState(), ON);
});

test("진행 중 변경을 직렬 저장하고 마지막 호출은 최신 상태까지 기다린다", async (t) => {
  const stateDir = await tempState(t);
  let release;
  let started;
  let writes = 0;
  const waiting = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const registry = createRegistry({
    stateDir,
    initialState: structuredClone(OFF),
    io: {
      write: async (file, data, mode) => {
        writes++;
        if (writes === 1) {
          started();
          await gate;
        }
        await fsp.writeFile(file, data, { mode });
      },
    },
  });
  registry.change({ type: "add-device", device: DEVICE });
  const first = registry.save();
  await waiting;
  registry.change({ type: "enable" });
  const second = registry.save();
  release();
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
  assert.equal(writes, 2);
  assert.deepEqual(registry.effectiveState(), ON);
});

test("rename 전 저장 실패는 이전 등록부를 보존하고 실패 상태를 유지한다", async (t) => {
  const stateDir = await tempState(t);
  await writeRegistry(stateDir, OFF, true);
  const registry = createRegistry({
    stateDir,
    initialState: structuredClone(OFF),
    io: { rename: async () => { throw Object.assign(new Error("injected"), { code: "EIO" }); } },
  });
  registry.change({ type: "enable" });
  const saved = await registry.save();
  assert.equal(saved.ok, false);
  assert.equal(saved.error, "registry-save-failed");
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(stateDir, "remote", "registry.json"), "utf8")), OFF);
  assert.equal(registry.status().lastSaveFailed, true);
  assert.equal(registry.effectiveState().enabled, false);
});

test("정상 종료 표시는 확정 상태에서만 기록하고 다음 기동이 읽은 뒤 삭제한다", async (t) => {
  const stateDir = await tempState(t);
  await writeRegistry(stateDir, ON, true);
  const registry = createRegistry({ stateDir });
  const initialized = await registry.initialize();
  assert.equal(initialized.clean, true);
  assert.equal(fs.existsSync(path.join(stateDir, "remote", "clean-shutdown")), false);
  assert.equal(registry.markCleanShutdownSync(), true);
  assert.equal(fs.existsSync(path.join(stateDir, "remote", "clean-shutdown")), true);
});

test("저장 중이거나 마지막 저장이 실패했으면 정상 종료 표시를 쓰지 않는다", async (t) => {
  const stateDir = await tempState(t);
  let release;
  let started;
  const waiting = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const savingRegistry = createRegistry({
    stateDir,
    initialState: structuredClone(OFF),
    io: { write: async (file, data, mode) => { started(); await gate; await fsp.writeFile(file, data, { mode }); } },
  });
  savingRegistry.change({ type: "enable" });
  const saving = savingRegistry.save();
  await waiting;
  assert.equal(savingRegistry.markCleanShutdownSync(), false);
  release();
  await saving;

  const failedDir = await tempState(t);
  const failedRegistry = createRegistry({
    stateDir: failedDir,
    initialState: structuredClone(OFF),
    io: { write: async () => { throw Object.assign(new Error("injected"), { code: "EIO" }); } },
  });
  failedRegistry.change({ type: "enable" });
  assert.equal((await failedRegistry.save()).ok, false);
  assert.equal(failedRegistry.markCleanShutdownSync(), false);
});

test("종료 표시가 없어도 저장된 원격 켜짐을 그대로 복구한다", async (t) => {
  const stateDir = await tempState(t);
  await writeRegistry(stateDir, ON, false);
  const registry = createRegistry({ stateDir });
  const initialized = await registry.initialize();
  assert.equal(initialized.needsConfirmation, false);
  assert.equal(registry.effectiveState().enabled, true);
  registry.change({ type: "enable" });
  assert.equal(registry.effectiveState().enabled, true);
  assert.equal((await registry.save()).ok, true);
  assert.equal(registry.effectiveState().enabled, true);
});

test("형식 오류는 원격을 끄고 원본 파일을 보존한다", async (t) => {
  const stateDir = await tempState(t);
  const remoteDir = path.join(stateDir, "remote");
  const file = path.join(remoteDir, "registry.json");
  await fsp.mkdir(remoteDir, { recursive: true });
  await fsp.writeFile(file, "{broken");
  const registry = createRegistry({ stateDir });
  const initialized = await registry.initialize();
  assert.equal(initialized.ok, false);
  assert.equal(initialized.error, "registry-invalid");
  assert.equal(registry.effectiveState().enabled, false);
  assert.equal(registry.change({ type: "disable" }).ok, false);
  assert.equal(await fsp.readFile(file, "utf8"), "{broken");
});

test("등록부는 정확한 필드와 P-256 연결 키만 받는다", async (t) => {
  for (const state of [
    { ...ON, extra: true },
    { ...ON, version: 2 },
    { ...ON, devices: [{ ...DEVICE, connKey: "AQ==" }] },
    { ...ON, devices: [{ ...DEVICE, extra: true }] },
  ]) {
    const stateDir = await tempState(t);
    await writeRegistry(stateDir, state, true);
    const registry = createRegistry({ stateDir });
    assert.equal((await registry.initialize()).ok, false);
  }
});
