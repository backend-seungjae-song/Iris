#!/usr/bin/env node
// Windows 설치 파일 빌드 (pnpm dist:win)
// 1. 동봉 herdr 준비(fetch-herdr-win.mjs)
// 2. electron-builder: x64 NSIS, 릴리스 게시 없음, 네이티브 재빌드 없음(node-pty 동봉 prebuild 사용)
// 7z 필터 BCJ 고정: 7-Zip 이 ARM64 실행 파일(herdr 의 conpty\arm64\OpenConsole.exe)에 ARM64 필터를 자동 적용하면
// 설치 프로그램이 그 파일을 풀지 못해 빠지고, herdr 가 ConPTY 묶음 검사에서 panic 으로 종료(Windows 러너 실측)
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fetchHerdr = fileURLToPath(new URL("./fetch-herdr-win.mjs", import.meta.url));
execFileSync(process.execPath, [fetchHerdr], { stdio: "inherit" });

process.env.ELECTRON_BUILDER_7Z_FILTER = "BCJ";
const { build, Platform, Arch } = await import("electron-builder");
await build({
  projectDir: root,
  targets: Platform.WINDOWS.createTarget(["nsis"], Arch.x64),
  publish: "never",
  config: { npmRebuild: false },
});
