const fs = require("node:fs");
const path = require("node:path");
const prepareWebAuthn = require("./prepare-webauthn-entitlements.cjs");

module.exports = async function afterPack(context) {
  if (context.electronPlatformName === "darwin") {
    // 서명 후에 bundle에 파일을 추가하면 sealed resource 검증이 깨진다.
    const resources = path.join(context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources", "app.asar.unpacked");
    fs.mkdirSync(resources, { recursive: true });
    fs.writeFileSync(path.join(resources, ".source-root"), path.resolve(__dirname, "..") + "\n");
  }
  return prepareWebAuthn(context);
};
