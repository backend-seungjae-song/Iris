// macOS Touch ID WebAuthn의 앱 수준 설정. 세션·계정 선택 UI는 소유하지 않는다.
// Electron 43의 Touch ID 자격증명은 Secure Enclave 기기 귀속이며 partition별 metadata secret로
// 갈린다. Chrome이나 iCloud Keychain의 패스키를 공유한다고 간주하면 안 된다.
const { spawnSync } = require("node:child_process");

const BUNDLE_ID = "app.iris.console";
const GROUP_SUFFIX = `.${BUNDLE_ID}.webauthn`;
const TEAM_ID_RE = /^[A-Z0-9]{10}$/;

function parseSigningInfo(raw) {
  const text = String(raw || "");
  const teamId = (text.match(/^TeamIdentifier=([^\r\n]+)$/m) || [])[1] || "";
  const identifier = (text.match(/^Identifier=([^\r\n]+)$/m) || [])[1] || "";
  if (!TEAM_ID_RE.test(teamId) || !/^[A-Za-z0-9.-]+$/.test(identifier)) return null;
  return { teamId, identifier };
}

function hasKeychainAccessGroup(raw, group) {
  const text = String(raw || "");
  const key = text.indexOf("<key>keychain-access-groups</key>");
  if (key < 0) return false;
  const end = text.indexOf("</array>", key);
  if (end < 0) return false;
  return text.slice(key, end).includes(`<string>${group}</string>`);
}

function inspectExecutable(execPath, run = spawnSync) {
  const common = { encoding: "utf8", timeout: 2_000, maxBuffer: 1024 * 1024 };
  const signature = run("/usr/bin/codesign", ["-dv", "--verbose=4", execPath], common);
  if (!signature || signature.status !== 0) return null;
  const signing = parseSigningInfo(`${signature.stdout || ""}\n${signature.stderr || ""}`);
  if (!signing) return null;

  const entitlement = run("/usr/bin/codesign", ["-d", "--entitlements", ":-", execPath], common);
  if (!entitlement || entitlement.status !== 0) return null;
  return {
    ...signing,
    entitlements: `${entitlement.stdout || ""}\n${entitlement.stderr || ""}`,
  };
}

function disabled(reason) { return { enabled: false, reason }; }

function configurePlatformWebAuthn(app, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "darwin") return disabled("unsupported-platform");
  if (!app || typeof app.configureWebAuthn !== "function") return disabled("api-unavailable");
  if (typeof app.isReady === "function" && !app.isReady()) return disabled("app-not-ready");
  if (options.defaultApp === true || (options.defaultApp === undefined && process.defaultApp)) {
    return disabled("development-runtime");
  }

  let inspected;
  try {
    inspected = (options.inspectExecutable || inspectExecutable)(options.execPath || process.execPath);
  } catch {
    return disabled("signature-unavailable");
  }
  if (!inspected) return disabled("signature-unavailable");

  const expectedBundleId = options.bundleId || BUNDLE_ID;
  if (inspected.identifier !== expectedBundleId) return disabled("bundle-id-mismatch");
  const derivedGroup = `${inspected.teamId}.${expectedBundleId}.webauthn`;
  const requestedGroup = options.keychainAccessGroup || derivedGroup;
  if (requestedGroup !== derivedGroup) return disabled("access-group-mismatch");
  if (!hasKeychainAccessGroup(inspected.entitlements, requestedGroup)) {
    return disabled("entitlement-missing");
  }

  try {
    app.configureWebAuthn({
      touchID: {
        keychainAccessGroup: requestedGroup,
        promptReason: options.promptReason || "sign in to $1",
      },
    });
    return { enabled: true, reason: "configured" };
  } catch {
    // 서명·Secure Enclave·OS 지원이 맞지 않아도 앱 시작과 기존 외부 handoff는 계속된다.
    return disabled("configuration-failed");
  }
}

module.exports = {
  BUNDLE_ID,
  configurePlatformWebAuthn,
  hasKeychainAccessGroup,
  inspectExecutable,
  parseSigningInfo,
};
