import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { NATIVE_CAPABILITIES } = require("../native/electron/capabilities.cjs");
const { bootNativeCapabilities } = require("../native/electron/capability-host.cjs");
const { isProfilePartition } = require("../native/electron/profile-session-policy.cjs");
const { createCredentialIpc } = require("../native/electron/credential-ipc.cjs");
const { createAiCausality } = require("../native/electron/ai-causality.cjs");

const { createPartitionStores } = require("../native/electron/partition-data-store.cjs");
const BASE = "persist:acbrowser";
const PROFILE = "persist:acprof:sample";
const trusted = { trusted: true, sender: {} };
const guest = { trusted: false };
const entries = [{ key: "city", value: "Seoul" }];
const BASE_GUEST = 10;
const PROFILE_GUEST = 11;

function fixture(t, isOn = true, safeStorageOverride = {}, platform = "darwin") {
  const stateDir = fs.mkdtempSync(path.join(tmpdir(), "iris-form-history-native-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const capability = NATIVE_CAPABILITIES.find(({ id }) => id === "formhistory");
  assert.ok(capability);
  delete require.cache[capability.module];
  const channels = new Map();
  const preloads = [];
  const diagnostics = [];
  const sessions = new Map();
  const guests = new Map();
  const causality = createAiCausality();
  let harden;
  const ipcMain = { handle: (channel, handle) => channels.set(channel, handle) };
  const ctx = {
    stateDir, ipcMain, isProfilePartition, isTrustedSender: (event) => event.trusted,
    webContents: { fromId: (id) => guests.get(id) },
    aiDriving: causality.driving,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => value.toString(),
      ...safeStorageOverride,
    },
    app: { whenReady: () => Promise.resolve() },
    onSessionHardened: (listener) => { harden = listener; },
    forEachHardened: (listener) => listener(BASE),
    sessionFromPartition(partition) {
      if (!sessions.has(partition)) {
        sessions.set(partition, { registerPreloadScript: (options) => preloads.push([partition, options]) });
      }
      return sessions.get(partition);
    },
    log: (...args) => diagnostics.push(args),
    error: (...args) => diagnostics.push(args),
  };
  for (const [id, partition] of [[BASE_GUEST, BASE], [PROFILE_GUEST, PROFILE]]) {
    guests.set(id, {
      id, session: ctx.sessionFromPartition(partition), hostWebContents: trusted.sender,
      isDestroyed: () => false, getType: () => "webview",
    });
  }
  const reopen = () => createPartitionStores({ ...ctx, fs, files: [capability.partitionStore], platform });
  const stores = reopen();
  ctx.openPartitionStore = stores.open;
  const loaded = bootNativeCapabilities({ items: [capability], isOn: () => isOn, ctx,
    onError: (_id, error) => { throw error; } });
  return { capability, loaded, channels, preloads, diagnostics, stores, reopen, ctx, harden, guests, causality };
}

test("기능을 끄면 네이티브 모듈, 프레임 preload, IPC가 로드되지 않는다", async (t) => {
  const { capability, loaded, channels, preloads } = fixture(t, false);
  await Promise.resolve();
  assert.deepEqual(loaded, []);
  assert.equal(require.cache[capability.module], undefined);
  assert.equal(channels.size, 0);
  assert.deepEqual(preloads, []);
});

test("프로필 세션마다 프레임 preload를 한 번 등록한다", async (t) => {
  const { loaded, preloads, harden } = fixture(t);
  harden(PROFILE);
  harden(PROFILE);
  harden("invalid");
  await Promise.resolve();
  assert.deepEqual(loaded, ["formhistory"]);
  assert.deepEqual(preloads.map(([partition, item]) => [partition, item.type, path.basename(item.filePath)]),
    [[PROFILE, "frame", "form-history-preload.cjs"], [BASE, "frame", "form-history-preload.cjs"]]);
});

test("조회·추가·삭제 IPC는 신뢰 발신자와 올바른 프로필에만 허용한다", (t) => {
  const { channels, ctx } = fixture(t);
  const query = channels.get("ac-form-history-query");
  const add = channels.get("ac-form-history-add");
  const remove = channels.get("ac-form-history-remove");
  assert.equal(add(trusted, BASE, entries, BASE_GUEST), true);
  assert.deepEqual(query(trusted, BASE, "city", "", BASE_GUEST), ["Seoul"]);
  assert.deepEqual(query(guest, BASE, "city", "", BASE_GUEST), []);
  assert.equal(add(guest, BASE, [{ key: "city", value: "Oslo" }], BASE_GUEST), false);
  assert.equal(remove(guest, BASE, "city", "Seoul"), false);
  assert.deepEqual(query(trusted, BASE, "city", "", BASE_GUEST), ["Seoul"]);
  assert.deepEqual(query(trusted, "invalid", "city", "", BASE_GUEST), []);
  assert.equal(add(trusted, "invalid", entries, BASE_GUEST), false);
  assert.equal(remove(trusted, "invalid", "city", "Seoul"), false);
  assert.equal(remove(trusted, BASE, "city", "Seoul"), true);
  assert.deepEqual(query(trusted, BASE, "city", "", BASE_GUEST), []);
  assert.equal(fs.existsSync(path.join(ctx.stateDir, "form-history.enc")), true);
});

test("조회·추가 IPC는 게스트 유형, 호스트, 프로필 세션, AI 실행 상태를 확인한다", async (t) => {
  const { channels, guests, causality } = fixture(t);
  const query = channels.get("ac-form-history-query");
  const add = channels.get("ac-form-history-add");
  assert.equal(add(trusted, BASE, entries, BASE_GUEST), true);

  const baseGuest = guests.get(BASE_GUEST);
  guests.set(12, { ...baseGuest, id: 12, getType: () => "window" });
  guests.set(13, { ...baseGuest, id: 13, isDestroyed: () => true });
  for (const [name, event, id] of [
    ["누락된 게스트", trusted, undefined],
    ["존재하지 않는 게스트", trusted, 99],
    ["webview가 아닌 게스트", trusted, 12],
    ["이미 닫힌 게스트", trusted, 13],
    ["다른 호스트의 게스트", { trusted: true, sender: {} }, BASE_GUEST],
    ["다른 프로필 세션의 게스트", trusted, PROFILE_GUEST],
  ]) {
    await t.test(name, () => {
      assert.equal(add(event, BASE, [{ key: "city", value: "Oslo" }], id), false);
      assert.deepEqual(query(event, BASE, "city", "", id), []);
    });
  }

  await t.test("AI가 조작 중인 게스트", () => {
    const ticket = causality.enter(BASE_GUEST);
    assert.equal(add(trusted, BASE, [{ key: "city", value: "Oslo" }], BASE_GUEST), false);
    assert.deepEqual(query(trusted, BASE, "city", "", BASE_GUEST), []);
    assert.equal(add(trusted, PROFILE, entries, PROFILE_GUEST), true);
    assert.deepEqual(query(trusted, PROFILE, "city", "", PROFILE_GUEST), ["Seoul"]);
    causality.leave(ticket, { grace: false });
    assert.deepEqual(query(trusted, BASE, "city", "", BASE_GUEST), ["Seoul"]);
  });
});

test("프로필 purge IPC가 해당 프로필의 입력 기록을 지운다", async (t) => {
  const { channels, stores, ctx } = fixture(t);
  createCredentialIpc({ ...ctx, credentialService: {}, basePartition: BASE, purgePartition: stores.purge });
  const add = channels.get("ac-form-history-add");
  const query = channels.get("ac-form-history-query");
  const purge = channels.get("ac-purge-partition");
  add(trusted, BASE, entries, BASE_GUEST);
  add(trusted, PROFILE, entries, PROFILE_GUEST);
  assert.equal((await purge(guest, PROFILE)).ok, false);
  assert.deepEqual(query(trusted, PROFILE, "city", "", PROFILE_GUEST), ["Seoul"]);
  assert.equal((await purge(trusted, PROFILE)).ok, true);
  assert.deepEqual(query(trusted, PROFILE, "city", "", PROFILE_GUEST), []);
  assert.deepEqual(query(trusted, BASE, "city", "", BASE_GUEST), ["Seoul"]);
});

test("기능이 꺼져 있어도 프로필 purge IPC가 디스크의 입력 기록을 지운다", async (t) => {
  const { capability, ctx, channels } = fixture(t);
  channels.get("ac-form-history-add")(trusted, BASE, entries, BASE_GUEST);
  channels.get("ac-form-history-add")(trusted, PROFILE, entries, PROFILE_GUEST);
  delete require.cache[capability.module];
  const stores = createPartitionStores({ ...ctx, fs, files: [capability.partitionStore], platform: "darwin" });
  createCredentialIpc({ ...ctx, credentialService: {}, basePartition: BASE, purgePartition: stores.purge });
  assert.equal((await channels.get("ac-purge-partition")(trusted, PROFILE)).ok, true);
  const data = stores.open(capability.partitionStore).load();
  assert.equal(Object.hasOwn(data, PROFILE), false);
  assert.equal(Object.hasOwn(data, BASE), true);
  assert.equal(require.cache[capability.module], undefined);
});

test("저장 실패의 진단에 입력값이나 복호화 오류 원문을 남기지 않는다", (t) => {
  const sample = "synthetic-private-form-value";
  const { channels, diagnostics } = fixture(t, true, { encryptString() { throw new Error(sample); } });
  const logs = [];
  t.mock.method(console, "error", (...args) => logs.push(args));
  t.mock.method(console, "warn", (...args) => logs.push(args));
  t.mock.method(console, "log", (...args) => logs.push(args));
  assert.equal(channels.get("ac-form-history-add")(trusted, BASE, [{ key: "note", value: sample }], BASE_GUEST), false);
  assert.equal([...diagnostics, ...logs].flat(Infinity).map(String).join("\n").includes(sample), false);
});

test("Windows 입력 기록은 암호화 파일 없이 실행 중에만 조회할 수 있다", (t) => {
  const { channels, ctx, capability, reopen } = fixture(t, true, {
    isEncryptionAvailable: () => false,
  }, "win32");
  const add = channels.get("ac-form-history-add");
  const query = channels.get("ac-form-history-query");
  assert.equal(add(trusted, BASE, entries, BASE_GUEST), true);
  assert.deepEqual(query(trusted, BASE, "city", "", BASE_GUEST), ["Seoul"]);
  assert.deepEqual(fs.readdirSync(ctx.stateDir), []);
  assert.deepEqual(reopen().open(capability.partitionStore).load(), {});
});

test("프로필 삭제가 진행 중이거나 끝난 뒤 도착한 입력 기록은 저장하지 않는다", async (t) => {
  const { channels, stores, ctx } = fixture(t);
  const add = channels.get("ac-form-history-add");
  const query = channels.get("ac-form-history-query");
  const clearSession = Promise.withResolvers();
  createCredentialIpc({
    ...ctx, credentialService: { clear() {} }, basePartition: BASE,
    beginPartitionPurge: stores.beginPurge,
    purgePartition: (partition) => stores.purge(partition, () => clearSession.promise),
  });
  assert.equal(add(trusted, PROFILE, entries, PROFILE_GUEST), true);
  assert.equal((await channels.get("ac-clear-creds")(trusted, PROFILE, true)).ok, true);
  assert.equal(add(trusted, PROFILE, entries, PROFILE_GUEST), false);
  const deletion = channels.get("ac-purge-partition")(trusted, PROFILE);
  assert.equal(add(trusted, PROFILE, entries, PROFILE_GUEST), false);
  assert.equal(add(trusted, BASE, entries, BASE_GUEST), true);
  clearSession.resolve();
  assert.equal((await deletion).ok, true);
  assert.equal(add(trusted, PROFILE, entries, PROFILE_GUEST), false);
  assert.deepEqual(query(trusted, PROFILE, "city", "", PROFILE_GUEST), []);
  assert.deepEqual(query(trusted, BASE, "city", "", BASE_GUEST), ["Seoul"]);
});

test("입력 기록 삭제 실패를 다음 시작과 저장소 접근에서 재시도한다", async (t) => {
  let failWrite = false;
  const { channels, stores, ctx, reopen, capability } = fixture(t, true, {
    encryptString(value) {
      if (failWrite) throw new Error("disk unavailable");
      return Buffer.from(value);
    },
  });
  createCredentialIpc({ ...ctx, credentialService: {}, basePartition: BASE, purgePartition: stores.purge });
  const add = channels.get("ac-form-history-add");
  const file = path.join(ctx.stateDir, capability.partitionStore);
  const read = () => JSON.parse(fs.readFileSync(file));
  assert.equal(add(trusted, BASE, entries, BASE_GUEST), true);
  assert.equal(add(trusted, PROFILE, entries, PROFILE_GUEST), true);
  failWrite = true;
  assert.equal((await channels.get("ac-purge-partition")(trusted, PROFILE)).ok, false);
  assert.equal(Object.hasOwn(read(), PROFILE), true);
  const restarted = reopen();
  restarted.retryPurges();
  assert.equal(Object.hasOwn(read(), PROFILE), true);
  failWrite = false;
  restarted.open(capability.partitionStore).load(BASE);
  assert.equal(Object.hasOwn(read(), PROFILE), false);
  assert.equal(Object.hasOwn(read(), BASE), true);
});

test("프로필 삭제는 읽을 수 있는 복구 사본도 정리하고 해독할 수 없는 사본을 보존한다", async (t) => {
  const { channels, stores, ctx, capability } = fixture(t);
  createCredentialIpc({ ...ctx, credentialService: {}, basePartition: BASE, purgePartition: stores.purge });
  const file = path.join(ctx.stateDir, capability.partitionStore);
  const readable = `${file}.unreadable-readable`;
  const unreadable = `${file}.unreadable-corrupt`;
  const add = channels.get("ac-form-history-add");
  assert.equal(add(trusted, BASE, entries, BASE_GUEST), true);
  assert.equal(add(trusted, PROFILE, entries, PROFILE_GUEST), true);
  fs.copyFileSync(file, readable);
  fs.writeFileSync(unreadable, "corrupt");
  const result = await channels.get("ac-purge-partition")(trusted, PROFILE);
  for (const filename of [file, readable]) {
    const data = JSON.parse(fs.readFileSync(filename));
    assert.equal(Object.hasOwn(data, PROFILE), false);
    assert.equal(Object.hasOwn(data, BASE), true);
  }
  assert.equal(fs.readFileSync(unreadable, "utf8"), "corrupt");
  assert.equal(result.ok, false);
});
