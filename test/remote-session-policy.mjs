import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createSessionPolicyStore } from "../server/remote/session-policy.js";

async function tempState(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "iris-remote-policy-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("PIN 기한은 stateHome 아래 형식으로 기본 30분을 저장하고 다시 읽는다", async (t) => {
  const stateDir = await tempState(t);
  const first = createSessionPolicyStore({ stateDir });
  assert.deepEqual(await first.initialize(), { ok: true, pinIdleMinutes: 30 });
  assert.equal((await first.set(20)).pinIdleMinutes, 20);

  const second = createSessionPolicyStore({ stateDir });
  assert.deepEqual(await second.initialize(), { ok: true, pinIdleMinutes: 20 });
  const remoteDir = path.join(stateDir, "remote");
  const policyFile = path.join(remoteDir, "session-policy.json");
  const saved = JSON.parse(await fsp.readFile(policyFile, "utf8"));
  assert.deepEqual(saved, { version: 1, pinIdleMinutes: 20 });
  assert.equal((await fsp.stat(remoteDir)).mode & 0o777, 0o700);
  assert.equal((await fsp.stat(policyFile)).mode & 0o777, 0o600);
});

test("PIN 기한은 10·20·30·60분만 받는다", async (t) => {
  const store = createSessionPolicyStore({ stateDir: await tempState(t) });
  await store.initialize();
  for (const value of [0, 15, 31, 120, "30"]) {
    assert.deepEqual(await store.set(value), { ok: false, error: "invalid-session-policy" });
  }
  for (const value of [10, 20, 30, 60]) {
    assert.equal((await store.set(value)).ok, true);
  }
});

test("형식이 틀린 저장 파일은 기본값으로 덮어쓰지 않는다", async (t) => {
  const stateDir = await tempState(t);
  const directory = path.join(stateDir, "remote");
  await fsp.mkdir(directory);
  await fsp.writeFile(path.join(directory, "session-policy.json"), '{"pinIdleMinutes":15}\n');
  const store = createSessionPolicyStore({ stateDir });
  assert.deepEqual(await store.initialize(), { ok: false, error: "session-policy-invalid" });
  assert.equal(store.getPinIdleMinutes(), 30);
});
