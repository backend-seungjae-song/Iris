import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPinStore, validAccessPin } from "../server/remote/pin.js";

async function tempState(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "iris-remote-pin-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("접속 PIN은 숫자 6자리 이상만 받고 scrypt 결과를 0600 파일에 저장한다", async (t) => {
  const stateDir = await tempState(t);
  const store = createPinStore({ stateDir });
  assert.deepEqual(await store.initialize(), { ok: true, configured: false });
  assert.equal(validAccessPin("12345"), false);
  assert.equal(validAccessPin("123456"), true);
  assert.deepEqual(await store.set("123456"), { ok: true });

  const file = path.join(stateDir, "remote", "access-pin.json");
  const raw = await fsp.readFile(file, "utf8");
  const record = JSON.parse(raw);
  assert.equal(raw.includes("123456"), false);
  assert.equal(record.algorithm, "scrypt");
  assert.deepEqual({ N: record.N, r: record.r, p: record.p }, { N: 32768, r: 8, p: 3 });
  assert.equal((await fsp.stat(file)).mode & 0o777, 0o600);

  const reopened = createPinStore({ stateDir });
  assert.deepEqual(await reopened.initialize(), { ok: true, configured: true });
  assert.deepEqual(await reopened.verify("123456", { deviceId: "phone", peerIp: "100.64.1.2" }), { ok: true });
});

test("틀린 PIN은 같은 기기와 주소에 지수 대기를 적용하고 성공하면 초기화한다", async (t) => {
  const stateDir = await tempState(t);
  let now = 1_000;
  const derive = async (pin, salt) => Buffer.alloc(32, pin === "123456" ? salt[0] : 99);
  const store = createPinStore({ stateDir, now: () => now, derive, randomBytes: () => Buffer.alloc(16, 7) });
  await store.initialize();
  await store.set("123456");
  const identity = { deviceId: "phone", peerIp: "100.64.1.2" };

  assert.deepEqual(await store.verify("000000", identity), {
    ok: false, error: "incorrect", retryAfterMs: 1_000,
  });
  assert.deepEqual(await store.verify("123456", identity), {
    ok: false, error: "retry-later", retryAfterMs: 1_000,
  });
  now += 1_000;
  assert.deepEqual(await store.verify("000000", identity), {
    ok: false, error: "incorrect", retryAfterMs: 2_000,
  });
  now += 2_000;
  assert.deepEqual(await store.verify("123456", identity), { ok: true });
});

