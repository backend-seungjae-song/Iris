import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  BUNDLE_ID, configurePlatformWebAuthn, hasKeychainAccessGroup, parseSigningInfo,
} = require("../native/electron/webauthn-platform.cjs");
const prepare = require("../scripts/prepare-webauthn-entitlements.cjs");

const TEAM = "ABCDEFGHIJ";
const GROUP = `${TEAM}.${BUNDLE_ID}.webauthn`;
const PROFILE_PATH = "/fixture/iris.provisionprofile";
const profile = (overrides = {}) => {
  const values = {
    expires: "2099-01-01T00:00:00Z",
    team: TEAM,
    application: `${TEAM}.${BUNDLE_ID}`,
    group: GROUP,
    ...overrides,
  };
  return `<plist><dict>
    <key>ExpirationDate</key><date>${values.expires}</date>
    <key>TeamIdentifier</key><array><string>${values.team}</string></array>
    <key>application-identifier</key><string>${values.application}</string>
    <key>keychain-access-groups</key><array><string>${values.group}</string></array>
  </dict></plist>`;
};
const signing = (overrides = {}) => ({
  teamId: TEAM,
  identifier: BUNDLE_ID,
  entitlements: `<key>keychain-access-groups</key><array><string>${GROUP}</string></array>`,
  ...overrides,
});

function fakeApp() {
  const calls = [];
  return {
    calls,
    isReady: () => true,
    configureWebAuthn: (options) => calls.push(options),
  };
}

test("서명 출력에서는 Team ID와 bundle identifier만 읽는다", () => {
  assert.deepEqual(parseSigningInfo([
    "Executable=/Applications/Example.app/Contents/MacOS/Example",
    `Identifier=${BUNDLE_ID}`,
    `TeamIdentifier=${TEAM}`,
    "Authority=Developer ID Application: redacted",
  ].join("\n")), { teamId: TEAM, identifier: BUNDLE_ID });
  assert.equal(parseSigningInfo(`Identifier=${BUNDLE_ID}\nTeamIdentifier=not-set`), null);
  assert.equal(hasKeychainAccessGroup(signing().entitlements, GROUP), true);
});

test("실제 서명과 entitlement가 맞을 때만 Touch ID를 설정한다", () => {
  const app = fakeApp();
  assert.deepEqual(configurePlatformWebAuthn(app, {
    platform: "darwin",
    defaultApp: false,
    inspectExecutable: () => signing(),
  }), { enabled: true, reason: "configured" });
  assert.deepEqual(app.calls, [{ touchID: {
    keychainAccessGroup: GROUP,
    promptReason: "sign in to $1",
  } }]);
});

test("준비 전·개발 런타임·서명 불일치는 조용히 기존 경로로 떨어진다", () => {
  const cases = [
    [{ platform: "linux" }, "unsupported-platform"],
    [{ platform: "darwin", defaultApp: true }, "development-runtime"],
    [{ platform: "darwin", defaultApp: false, inspectExecutable: () => null }, "signature-unavailable"],
    [{ platform: "darwin", defaultApp: false, inspectExecutable: () => signing({ identifier: "other.app" }) }, "bundle-id-mismatch"],
    [{ platform: "darwin", defaultApp: false, inspectExecutable: () => signing({ entitlements: "<dict/>" }) }, "entitlement-missing"],
  ];
  for (const [options, reason] of cases) {
    const app = fakeApp();
    assert.equal(configurePlatformWebAuthn(app, options).reason, reason);
    assert.equal(app.calls.length, 0);
  }

  const early = fakeApp();
  early.isReady = () => false;
  assert.equal(configurePlatformWebAuthn(early, { platform: "darwin", defaultApp: false }).reason, "app-not-ready");
});

test("명시한 access group도 현재 서명에서 유도한 값과 다르면 거절한다", () => {
  const app = fakeApp();
  const result = configurePlatformWebAuthn(app, {
    platform: "darwin",
    defaultApp: false,
    keychainAccessGroup: `${TEAM}.other.app.webauthn`,
    inspectExecutable: () => signing(),
  });
  assert.equal(result.reason, "access-group-mismatch");
  assert.equal(app.calls.length, 0);
});

test("Electron 설정 실패는 앱 시작을 깨뜨리지 않는다", () => {
  const app = fakeApp();
  app.configureWebAuthn = () => { throw new Error("unsupported machine"); };
  assert.equal(configurePlatformWebAuthn(app, {
    platform: "darwin", defaultApp: false, inspectExecutable: () => signing(),
  }).reason, "configuration-failed");
});

test("빌드 훅은 팀 값을 저장소가 아닌 dist entitlement에만 구체화한다", async (t) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-webauthn-build-"));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const config = {};
  const result = await prepare({
    electronPlatformName: "darwin",
    outDir,
    packager: { platformSpecificBuildOptions: config },
  }, {
    env: { IRIS_WEBAUTHN_TEAM_ID: TEAM, IRIS_WEBAUTHN_PROVISIONING_PROFILE: PROFILE_PATH },
    signingMaterial: {},
    profileText: profile(),
    root: path.resolve(import.meta.dirname, ".."),
  });
  assert.equal(result.enabled, true);
  assert.equal(config.entitlements, result.entitlements);
  const generated = fs.readFileSync(result.entitlements, "utf8");
  assert.match(generated, new RegExp(`<string>${GROUP.replaceAll(".", "\\.")}</string>`));
  assert.doesNotMatch(generated, /__IRIS_WEBAUTHN_KEYCHAIN_ACCESS_GROUP__/);
  const template = fs.readFileSync(new URL("../assets/entitlements.mac.template.plist", import.meta.url), "utf8");
  assert.match(template, /__IRIS_WEBAUTHN_KEYCHAIN_ACCESS_GROUP__/);
  assert.doesNotMatch(template, new RegExp(TEAM));
});

test("빌드 팀이 모호하면 entitlement를 억지로 만들지 않는다", async () => {
  const config = {};
  const result = await prepare({
    electronPlatformName: "darwin",
    outDir: "/unused",
    packager: { platformSpecificBuildOptions: config },
  }, {
    env: { IRIS_WEBAUTHN_PROVISIONING_PROFILE: PROFILE_PATH },
    signingMaterial: {},
    profileText: profile(),
  });
  assert.equal(result.enabled, false);
  assert.equal(config.entitlements, undefined);
});

test("provisioning profile이 없거나 access group을 허용하지 않으면 제한 entitlement를 생략한다", async () => {
  for (const options of [
    { env: { IRIS_WEBAUTHN_TEAM_ID: TEAM }, signingMaterial: {} },
    {
      env: { IRIS_WEBAUTHN_TEAM_ID: TEAM, IRIS_WEBAUTHN_PROVISIONING_PROFILE: PROFILE_PATH },
      signingMaterial: {},
      profileText: profile({ group: `${TEAM}.other.app` }),
    },
  ]) {
    const config = {};
    const result = await prepare({
      electronPlatformName: "darwin",
      outDir: "/unused",
      packager: { platformSpecificBuildOptions: config },
    }, options);
    assert.equal(result.enabled, false);
    assert.equal(config.entitlements, undefined);
  }
});

test("빌드 팀은 identity 이름이 아니라 유효 identity와 일치하는 인증서 OU에서 읽는다", () => {
  const hash = "0123456789ABCDEF0123456789ABCDEF01234567";
  const pem = "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----";
  class FakeCertificate {
    constructor(value) {
      assert.equal(value, pem);
      this.fingerprint = hash.match(/../g).join(":");
      this.subject = `CN=redacted\nOU=${TEAM}`;
    }
  }
  const teams = prepare.teamsFromSigningMaterial(
    `1) ${hash} \"Apple Development: name suffix is not a team\"`,
    pem,
    FakeCertificate,
  );
  assert.deepEqual(teams, [TEAM]);
});
