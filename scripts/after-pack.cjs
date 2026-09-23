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
    // serve-sim 헬퍼는 실행 파일이다. 복사하면서 실행 권한이 빠지면 에뮬레이터 연결이 권한 오류로 끝난다.
    // Orca 빌드 설정(electron-builder.config.cjs)도 같은 두 파일에 권한을 준다.
    const serveSim = path.join(path.dirname(resources), "node_modules", "serve-sim");
    for (const rel of ["bin/serve-sim-bin", "dist/simcam/serve-sim-camera-helper"]) {
      const file = path.join(serveSim, rel);
      if (!fs.existsSync(file)) throw new Error(`serve-sim 헬퍼가 패키지에 없습니다: ${file}`);
      fs.chmodSync(file, 0o755);
    }
  }
  return prepareWebAuthn(context);
};
