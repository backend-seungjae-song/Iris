// 코드서명 identity의 Team ID를 빌드 산출물 안의 entitlement로만 구체화한다.
// 저장소의 템플릿과 로그에는 identity 이름·Team ID·access group을 남기지 않는다.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { X509Certificate } = require("node:crypto");

const BUNDLE_ID = "app.iris.console";
const PLACEHOLDER = "__IRIS_WEBAUTHN_KEYCHAIN_ACCESS_GROUP__";
const TEAM_ID_RE = /^[A-Z0-9]{10}$/;

function parseTeamFromGroup(value) {
  const match = String(value || "").match(/^([A-Z0-9]{10})\.app\.iris\.console\.webauthn$/);
  return match ? match[1] : null;
}

function identityHashes(raw) {
  const hashes = new Set();
  for (const line of String(raw || "").split(/\r?\n/)) {
    const identity = line.match(/^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"/);
    if (identity) hashes.add(identity[1].toUpperCase());
  }
  return hashes;
}

function teamsFromSigningMaterial(identityOutput, certificateOutput, Certificate = X509Certificate) {
  const hashes = identityHashes(identityOutput);
  const teams = new Set();
  const certificates = String(certificateOutput || "")
    .match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
  for (const pem of certificates) {
    try {
      const certificate = new Certificate(pem);
      const fingerprint = String(certificate.fingerprint || "").replaceAll(":", "").toUpperCase();
      if (!hashes.has(fingerprint)) continue;
      const team = (String(certificate.subject || "").match(/(?:^|\n)OU=([^\n]+)/) || [])[1] || "";
      if (TEAM_ID_RE.test(team)) teams.add(team);
    } catch {}
  }
  return [...teams];
}

function resolveTeamId(env, signingMaterial) {
  const configuredGroup = env.IRIS_WEBAUTHN_KEYCHAIN_ACCESS_GROUP;
  if (configuredGroup) {
    const team = parseTeamFromGroup(configuredGroup);
    if (!team) throw new Error("IRIS_WEBAUTHN_KEYCHAIN_ACCESS_GROUP 형식이 앱 bundle과 맞지 않습니다.");
    return team;
  }
  for (const value of [env.IRIS_WEBAUTHN_TEAM_ID, env.APPLE_TEAM_ID]) {
    if (value) {
      if (!TEAM_ID_RE.test(value)) throw new Error("WebAuthn 코드서명 Team ID 형식이 올바르지 않습니다.");
      return value;
    }
  }
  const teams = teamsFromSigningMaterial(
    signingMaterial && signingMaterial.identities,
    signingMaterial && signingMaterial.certificates,
  );
  return teams.length === 1 ? teams[0] : null;
}

function readSigningMaterial(run = spawnSync) {
  const options = {
    encoding: "utf8", timeout: 5_000, maxBuffer: 1024 * 1024,
  };
  const identities = run("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"], options);
  const certificates = run("/usr/bin/security", ["find-certificate", "-a", "-p"], {
    ...options, maxBuffer: 10 * 1024 * 1024,
  });
  return {
    identities: identities && identities.status === 0 ? `${identities.stdout || ""}\n${identities.stderr || ""}` : "",
    certificates: certificates && certificates.status === 0 ? certificates.stdout || "" : "",
  };
}

function valueForKey(raw, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (String(raw || "").match(new RegExp(`<key>${escaped}</key>\\s*<(?:string|date)>([^<]+)</(?:string|date)>`)) || [])[1] || "";
}

function arrayForKey(raw, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = (String(raw || "").match(new RegExp(`<key>${escaped}</key>\\s*<array>([\\s\\S]*?)</array>`)) || [])[1] || "";
  return [...body.matchAll(/<string>([^<]+)<\/string>/g)].map((match) => match[1]);
}

function profileAllowsWebAuthn(raw, teamId, accessGroup, now = Date.now()) {
  const text = String(raw || "");
  const expires = Date.parse(valueForKey(text, "ExpirationDate"));
  const application = valueForKey(text, "application-identifier")
    || valueForKey(text, "com.apple.application-identifier");
  const allowedGroups = arrayForKey(text, "keychain-access-groups");
  return Number.isFinite(expires) && expires > now
    && arrayForKey(text, "TeamIdentifier").includes(teamId)
    && [ `${teamId}.${BUNDLE_ID}`, `${teamId}.*` ].includes(application)
    && (allowedGroups.includes(accessGroup) || allowedGroups.includes(`${teamId}.*`));
}

function readProvisioningProfile(profilePath, run = spawnSync) {
  const decoded = run("/usr/bin/security", ["cms", "-D", "-i", profilePath], {
    encoding: "utf8", timeout: 5_000, maxBuffer: 10 * 1024 * 1024,
  });
  return decoded && decoded.status === 0 ? decoded.stdout || "" : "";
}

async function prepareWebAuthnEntitlements(context, options = {}) {
  if (!context || context.electronPlatformName !== "darwin") return { enabled: false };
  const env = options.env || process.env;
  const config = context.packager && context.packager.platformSpecificBuildOptions;
  if (!config) throw new Error("electron-builder mac 설정을 찾지 못했습니다.");
  const configuredProfile = env.IRIS_WEBAUTHN_PROVISIONING_PROFILE || config.provisioningProfile;
  if (!configuredProfile || (!options.profileText && !fs.existsSync(configuredProfile))) {
    console.warn("[webauthn] 적합한 provisioning profile이 없어 제한 entitlement를 생략합니다.");
    return { enabled: false };
  }
  const signingMaterial = options.signingMaterial || readSigningMaterial(options.run);
  const teamId = resolveTeamId(env, signingMaterial);
  if (!teamId) {
    console.warn("[webauthn] 코드서명 팀을 하나로 정할 수 없어 Touch ID entitlement를 생략합니다.");
    return { enabled: false };
  }

  const root = options.root || path.resolve(__dirname, "..");
  const templatePath = path.join(root, "assets", "entitlements.mac.template.plist");
  const outputDir = path.join(context.outDir, ".webauthn-signing");
  const outputPath = path.join(outputDir, "entitlements.mac.plist");
  const accessGroup = `${teamId}.${BUNDLE_ID}.webauthn`;
  const profileText = options.profileText || readProvisioningProfile(configuredProfile, options.run);
  if (!profileAllowsWebAuthn(profileText, teamId, accessGroup, options.now)) {
    console.warn("[webauthn] provisioning profile이 앱의 WebAuthn access group을 허용하지 않아 entitlement를 생략합니다.");
    return { enabled: false };
  }
  const template = fs.readFileSync(templatePath, "utf8");
  if (!template.includes(PLACEHOLDER)) throw new Error("WebAuthn entitlement placeholder가 없습니다.");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, template.replaceAll(PLACEHOLDER, accessGroup));

  if (env.IRIS_WEBAUTHN_PROVISIONING_PROFILE) config.provisioningProfile = configuredProfile;
  config.entitlements = outputPath;
  console.log("[webauthn] Touch ID entitlement를 이 빌드의 macOS 서명에 연결했습니다.");
  return { enabled: true, entitlements: outputPath };
}

module.exports = prepareWebAuthnEntitlements;
module.exports.default = prepareWebAuthnEntitlements;
module.exports.parseTeamFromGroup = parseTeamFromGroup;
module.exports.profileAllowsWebAuthn = profileAllowsWebAuthn;
module.exports.resolveTeamId = resolveTeamId;
module.exports.teamsFromSigningMaterial = teamsFromSigningMaterial;
