import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createCredStore } = require("../native/electron/cred-store.cjs");

// safeStorage 대역. 암호화는 되돌릴 수 있는 표시만 붙인다. 여기서 시험하는 것은 암호가 아니라
// "못 읽었을 때 무엇을 하는가"다.
function fakeSafeStorage({ available = true, decryptFails = false } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from("enc:" + s, "utf8"),
    decryptString: (buf) => {
      if (decryptFails) throw new Error("Keychain이 잠겨 있습니다");
      const s = buf.toString("utf8");
      if (!s.startsWith("enc:")) throw new Error("형식이 다릅니다");
      return s.slice(4);
    },
  };
}

function tmpFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-creds-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "creds.enc");
}

function writeStore(file, obj) {
  fs.writeFileSync(file, Buffer.from("enc:" + JSON.stringify(obj), "utf8"));
}

const TWO = { "profile-a": [{ origin: "https://a.test", username: "a" }], "profile-b": [{ origin: "https://b.test", username: "b" }] };
const NOW = () => new Date(2026, 7, 19, 17, 5, 9);

test("파일이 없으면 빈 저장소로 시작하고 그대로 쓴다", (t) => {
  const file = tmpFile(t);
  const v = createCredStore({ filePath: file, fs, safeStorage: fakeSafeStorage(), now: NOW });
  assert.deepEqual(v.load(), {});
  assert.equal(v.state().unreadable, false);
  const store = v.load();
  store["profile-a"] = TWO["profile-a"];
  assert.deepEqual(v.persist(store), { written: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8").slice(4)), { "profile-a": TWO["profile-a"] });
});

test("정상 파일은 그대로 읽고 다음 호출은 같은 객체를 준다", (t) => {
  const file = tmpFile(t);
  writeStore(file, TWO);
  const v = createCredStore({ filePath: file, fs, safeStorage: fakeSafeStorage(), now: NOW });
  const first = v.load();
  assert.deepEqual(first, TWO);
  assert.equal(v.load(), first);
  assert.equal(v.state().unreadable, false);
});

test("해독에 실패하면 그 파일 위에 덮어쓰지 않고 옆으로 밀어 둔다", (t) => {
  const file = tmpFile(t);
  writeStore(file, TWO);
  const before = fs.readFileSync(file);
  const v = createCredStore({ filePath: file, fs, safeStorage: fakeSafeStorage({ decryptFails: true }), now: NOW });

  assert.deepEqual(v.load(), {});              // 못 읽었으니 빈 것처럼 보이지만
  assert.equal(v.state().unreadable, true);    // 그 사실이 남아 있다
  assert.equal(v.state().cached, false);       // 캐시하지 않는다 = 다음 호출에서 재시도

  const store = v.load();
  store["profile-c"] = [{ origin: "https://c.test", username: "c" }];
  assert.deepEqual(v.persist(store), { written: true });

  const kept = `${file}.unreadable-20260819-170509`;
  assert.equal(fs.existsSync(kept), true, "못 읽은 파일이 보존되어야 한다");
  assert.deepEqual(fs.readFileSync(kept), before, "보존본은 원본 바이트 그대로여야 한다");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8").slice(4)), { "profile-c": store["profile-c"] });
});

test("Keychain이 잠깐 잠겼다 풀리면 저절로 원래 내용으로 돌아온다", (t) => {
  const file = tmpFile(t);
  writeStore(file, TWO);
  let locked = true;
  const safe = fakeSafeStorage();
  const orig = safe.decryptString;
  safe.decryptString = (buf) => { if (locked) throw new Error("Keychain이 잠겨 있습니다"); return orig(buf); };

  const v = createCredStore({ filePath: file, fs, safeStorage: safe, now: NOW });
  assert.deepEqual(v.load(), {});
  assert.equal(v.state().unreadable, true);

  locked = false;
  assert.deepEqual(v.load(), TWO, "잠금이 풀리면 다시 읽어야 한다");
  assert.equal(v.state().unreadable, false);
  assert.equal(fs.existsSync(`${file}.unreadable-20260819-170509`), false, "밀어 둘 일이 없었어야 한다");
});

test("암호화 자체가 불가하면 읽지도 쓰지도 않는다 — 평문으로 남기지 않는다", (t) => {
  const file = tmpFile(t);
  writeStore(file, TWO);
  const before = fs.readFileSync(file);
  const v = createCredStore({ filePath: file, fs, safeStorage: fakeSafeStorage({ available: false }), now: NOW });
  assert.deepEqual(v.load(), {});
  assert.equal(v.state().unreadable, true);
  assert.deepEqual(v.persist({ "profile-c": [] }), { written: false, reason: "no-encryption" });
  assert.deepEqual(fs.readFileSync(file), before, "원본이 그대로여야 한다");
});

test("밀어 두지 못하면 아무것도 쓰지 않는다", (t) => {
  const file = tmpFile(t);
  writeStore(file, TWO);
  const before = fs.readFileSync(file);
  const guarded = Object.create(fs);
  guarded.renameSync = (from, to) => { if (String(to).includes(".unreadable-")) throw new Error("EPERM"); return fs.renameSync(from, to); };
  const v = createCredStore({ filePath: file, fs: guarded, safeStorage: fakeSafeStorage({ decryptFails: true }), now: NOW });
  v.load();
  assert.deepEqual(v.persist({ "profile-c": [] }), { written: false, reason: "quarantine-failed" });
  assert.deepEqual(fs.readFileSync(file), before, "밀어 두기에 실패했으면 원본이 남아 있어야 한다");
});

test("저장은 임시 파일을 거쳐 원자적으로 갈아끼우고 권한을 좁힌다", (t) => {
  const file = tmpFile(t);
  const v = createCredStore({ filePath: file, fs, safeStorage: fakeSafeStorage(), now: NOW });
  v.load();
  assert.deepEqual(v.persist(TWO), { written: true });
  assert.equal(fs.existsSync(`${file}.tmp`), false, "임시 파일이 남아 있으면 안 된다");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
