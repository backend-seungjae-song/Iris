#!/usr/bin/env node
// Windows 설치 파일에 동봉할 herdr 준비 (pnpm dist:win 이 빌드 전에 실행)
// 대상: herdr 공식 릴리스의 windows-x86_64 zip (herdr.exe + ConPTY)
// 버전·SHA-256 고정. 올릴 때는 https://herdr.dev/latest.json 의 windows-x86_64 값으로 둘 다 교체
// 결과: dist/herdr-win/ (package.json build.win.extraResources 가 resources/herdr 로 복사)
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "0.9.3";
const SHA256 = "c75b1fa49f7a3ba4b8b11789912a6147e4214a3b6fd3556d0f80076c8887d795";
const URL = `https://github.com/herdrdev/herdr/releases/download/v${VERSION}/herdr-windows-x86_64.zip`;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "dist", "herdr-win");
const stamp = path.join(outDir, ".version");

function ready() {
  try {
    return fs.readFileSync(stamp, "utf8").trim() === VERSION && fs.existsSync(path.join(outDir, "herdr.exe"));
  } catch { return false; }
}

async function main() {
  if (ready()) {
    console.log(`herdr ${VERSION} (Windows) 준비됨: ${outDir}`);
    return;
  }
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`herdr 다운로드 실패: ${res.status} ${URL}`);
  const zip = Buffer.from(await res.arrayBuffer());
  const got = createHash("sha256").update(zip).digest("hex");
  if (got !== SHA256) throw new Error(`herdr zip SHA-256 불일치: ${got} (기대 ${SHA256})`);

  // 이전 버전 파일이 섞이지 않게 새 폴더에 풀고 교체
  const tmpDir = `${outDir}.tmp`;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  const zipPath = path.join(tmpDir, "herdr.zip");
  fs.writeFileSync(zipPath, zip);
  // tar(bsdtar): macOS 와 Windows 10 이상 기본 포함, zip 해제 가능
  execFileSync("tar", ["-xf", zipPath, "-C", tmpDir], { stdio: "inherit" });
  fs.rmSync(zipPath);
  if (!fs.existsSync(path.join(tmpDir, "herdr.exe"))) throw new Error("herdr zip 에 herdr.exe 없음");
  fs.writeFileSync(path.join(tmpDir, ".version"), `${VERSION}\n`);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.renameSync(tmpDir, outDir);
  console.log(`herdr ${VERSION} (Windows) 준비 완료: ${outDir}`);
}

main().catch((e) => { console.error(String((e && e.message) || e)); process.exit(1); });
