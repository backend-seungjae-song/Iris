// AI 로그인이 요청한 탭의 프로필(session partition)에 저장된 비밀번호만 고르는지 확인한다.
// 실제 credential-service·profile-session-policy·ai-login-policy 를 잇고, Electron 이 주는
// safeStorage·ipcMain·session·webContents 만 대역으로 둔다.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createCredentialService } = require("../native/electron/credential-service.cjs");
const { createProfileSessionPolicy, isProfilePartition } = require("../native/electron/profile-session-policy.cjs");
const { createAiLoginPolicy } = require("../native/electron/ai-login-policy.cjs");

const ORIGIN = "https://login.example.test";
const USER = "same-user";
const PART_A = "persist:acprof:alpha";
const PART_B = "persist:acprof:beta";

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from("enc:" + s, "utf8"),
    decryptString: (buf) => buf.toString("utf8").slice(4),
  };
}

function fakeSession() {
  return {
    setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDisplayMediaRequestHandler() {},
    setDevicePermissionHandler() {}, removeListener() {}, on() {},
  };
}

function setup(t, { sharePartitions }) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-ai-login-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const credentialService = createCredentialService({ stateDir, safeStorage: fakeSafeStorage(), sharePartitions });
  // A 를 먼저 넣는다. 공유 모드에서 저장 순서대로 훑으면 A 의 비밀번호가 먼저 걸린다.
  credentialService.set(PART_A, [{ origin: ORIGIN, url: ORIGIN, username: USER, password: "pw-alpha" }]);
  credentialService.set(PART_B, [{ origin: ORIGIN, url: ORIGIN, username: USER, password: "pw-beta" }]);
  fs.writeFileSync(path.join(stateDir, "ai-login.json"), JSON.stringify([{ origin: ORIGIN, username: USER }]));

  const sessions = new Map();
  const policy = createProfileSessionPolicy({
    basePartition: "persist:acbrowser",
    fromPartition: (p) => { if (!sessions.has(p)) sessions.set(p, fakeSession()); return sessions.get(p); },
    hardenBrowserSession() {},
    userAgentForPartition: () => "",
    audioInputPermission: () => false,
    systemPreferences: {},
    platform: "linux",
    installSessionHook() {},
  });
  policy.ensureHardened(PART_A);
  policy.ensureHardened(PART_B);

  let provider = null;
  const notes = [];
  createAiLoginPolicy({
    fs, path, stateDir,
    ipcMain: { handle() {} },
    isTrustedSender: () => true,
    credentialService,
    cookieImport: { listChromeProfiles: () => [] },
    chromeImportRegistry: { backfill() {}, has: () => false },
    chromeProfileCid: () => "",
    isProfilePartition,
    setLoginProvider: (fn) => { provider = fn; },
    ctlSend: (m) => notes.push(m),
    partitionForSession: (sess) => policy.partitionForSession(sess),
  });
  assert.equal(typeof provider, "function");

  const login = async (sess) => {
    const sent = [];
    const wc = { id: 7, session: sess, getURL: () => ORIGIN + "/signin", send: (ch, payload) => sent.push({ ch, payload }) };
    const result = await provider(wc, {});
    return { result, sent };
  };
  return { login, sessionOf: (p) => sessions.get(p), notes };
}

for (const sharePartitions of [false, true]) {
  test(`sharePartitions=${sharePartitions}: B 프로필 탭은 B 비밀번호를 채운다`, async (t) => {
    const h = setup(t, { sharePartitions });
    const b = await h.login(h.sessionOf(PART_B));
    assert.equal(b.result.ok, true, JSON.stringify(b.result));
    assert.equal(b.result.username, USER);
    assert.equal(b.result.secret, "pw-beta");
    assert.deepEqual(b.sent.map((s) => s.payload.password), ["pw-beta"]);

    const a = await h.login(h.sessionOf(PART_A));
    assert.equal(a.result.secret, "pw-alpha");
    assert.deepEqual(a.sent.map((s) => s.payload.password), ["pw-alpha"]);
  });

  test(`sharePartitions=${sharePartitions}: 등록되지 않은 session 은 저장된 로그인이 없는 것으로 본다`, async (t) => {
    const h = setup(t, { sharePartitions });
    const r = await h.login(fakeSession());
    assert.equal(r.result.ok, false);
    assert.equal(r.result.reason, "no-saved");
    assert.deepEqual(r.sent, []);
  });
}
