import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { sliceBetween, sliceFrom } from "../bin/slice-anchor.mjs";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");

test("웹뷰 생성은 Chrome 프로필을 자동 재가져오지 않는다", () => {
  const source = fs.readFileSync(path.join(root, "web/js/browser/webview-factory.js"), "utf8");
  const createWebview = sliceFrom(source, "function createWebview", 7000, "createWebview");
  assert.doesNotMatch(createWebview, /maybeAutoImportProfile|importChromeProfile/);
  assert.doesNotMatch(source, /lastAutoImport/);
});

test("쿠키 DB 재생은 Electron session 생성 없이 모듈 초기화에서 먼저 끝난다", () => {
  const importer = fs.readFileSync(path.join(root, "native/electron/cookie-import.cjs"), "utf8");
  const replay = sliceBetween(importer, "function applyPendingCookieImports", "function copySnapshotToStaging", "쿠키 재적용");
  const startup = importer.slice(importer.lastIndexOf("// require 시점"), importer.indexOf("module.exports"));

  assert.match(startup, /applyPendingCookieImports\(\)/);
  assert.doesNotMatch(replay, /session\.fromPartition/);
  assert.doesNotMatch(importer, /session-cookie-store|createSessionCookieStore/);
});

test("인증 헬퍼는 연결된 실제 Chrome 프로필을 일반 창으로만 연다", () => {
  const source = fs.readFileSync(path.join(root, "native/electron/chrome-auth.cjs"), "utf8");
  const profile = sliceBetween(source, "async function runProfileHandoff", "async function runChromeAuth", "프로필 넘기기");
  const active = sliceBetween(source, "async function runChromeAuth", "module.exports", "Chrome 인증");
  assert.match(profile, /--profile-directory=/);
  assert.match(profile, /--new-window/);
  assert.match(profile, /"about:blank"/);
  assert.match(profile, /set URL of active tab of window id/);
  assert.doesNotMatch(profile, /--remote-debugging|--user-data-dir/);
  assert.match(active, /listChromeProfiles\(\).*runProfileHandoff/s);
  assert.doesNotMatch(active, /runIsolatedChromeAuth/);
});

test("실 프로필 수확은 현재 사이트 도메인 경계를 벗어나지 않는다", () => {
  const { baseDomain, inScope } = require("../native/electron/chrome-auth.cjs");
  const base = baseDomain("signin.example.co.kr");
  assert.equal(base, "example.co.kr");
  assert.equal(inScope(".auth.example.co.kr", base), true);
  assert.equal(inScope("evil-example.co.kr", base), false);
  assert.equal(baseDomain("alice.github.io"), "alice.github.io");
  assert.equal(inScope("api.alice.github.io", baseDomain("alice.github.io")), true);
  assert.equal(inScope("bob.github.io", baseDomain("alice.github.io")), false);
  assert.equal(baseDomain("tenant.appspot.com"), "tenant.appspot.com");
  assert.equal(baseDomain("localhost"), "localhost");
  assert.equal(baseDomain("127.0.0.1"), "127.0.0.1");
  assert.equal(baseDomain("user@example.com"), "");
  assert.equal(baseDomain("example.com:443"), "");
});

test("Chrome 프로필 가져오기는 Orca처럼 기존 쿠키 jar를 전체 교체한다", () => {
  const importer = fs.readFileSync(path.join(root, "native/electron/cookie-import.cjs"), "utf8");
  const staging = sliceBetween(importer, "function stageCookieRows", "function targetCookiesPath", "쿠키 임시 보관");
  const direct = sliceBetween(importer, "async function importCookiesFromChrome", "// require 시점", "쿠키 직접 가져오기");

  assert.match(staging, /DELETE FROM cookies;/);
  assert.match(direct, /replaceCookieSnapshot/);
  assert.doesNotMatch(direct, /clearStorageData\(\{ storages: \["cookies"\] \}\)/);
  assert.match(direct, /registerPendingCookieImport/);
  assert.match(direct, /discardStagingDatabase\(staging\)[\s\S]*stageCookieRows\(liveCookiesPath, importList/);
  assert.match(importer, /mode === "replace" \|\| mode === "replace-scoped" \? \{ cas: true \}/);
  assert.match(importer, /INTEGRITY_COOKIE_NAMES/);
});

test("인증 handoff는 선삭제 없이 원자적 cookie importer에 scoped 교체를 맡긴다", () => {
  const source = fs.readFileSync(path.join(root, "native/electron/chrome-auth.cjs"), "utf8");
  const profile = sliceBetween(source, "async function runProfileHandoff", "async function runChromeAuth", "프로필 넘기기");
  assert.doesNotMatch(profile, /session\.cookies\.remove/);
  assert.match(profile, /cookieFingerprint\(\(await session\.cookies\.get\(\{\}\)\)\.filter/);
  assert.match(profile, /cookieImport\.putCookies\(partition, cookies, \{[\s\S]{0,120}isCurrent, sourceIsCurrent, expectedTargetFingerprint/);
  assert.match(profile, /if \(!isCurrent\(\)\)/);
  assert.match(profile, /if \(result && result\.error\)/);
  assert.match(profile, /stableReads >= 2/);
  assert.match(profile, /if \(stableReads < 2\)/);
});

test("cookie import는 출처 UA를 기록하되 실행 엔진 정체성을 유지한다", () => {
  const importer = fs.readFileSync(path.join(root, "native/electron/cookie-import.cjs"), "utf8");
  assert.match(importer, /persistPartitionUserAgent\(partition, userAgent\)/);
  assert.match(importer, /applyHardening\(sess\)/);
});

test("가져온 브라우저 UA 주인은 파티션별 저장·적용을 함께 유지한다", () => {
  const handoff = fs.readFileSync(path.join(root, "native/electron/chrome-handoff-ipc.cjs"), "utf8");
  const authHandler = sliceBetween(handoff, 'ipcMain.handle("ac-chrome-auth"', 'ipcMain.on("ac-open-in-chrome"', "인증 IPC");
  // 파티션별 가져오기 출처는 보존하며, 실제 브라우저 정체성은 hardening 소유자가 결정한다.
  const policy = fs.readFileSync(path.join(root, "native/electron/profile-session-policy.cjs"), "utf8");
  assert.match(policy, /hardenBrowserSession\(sess, userAgentForPartition\(partition\)\)/);
  assert.match(authHandler, /const sourceBrowser = chromeSource\.split/);
  assert.match(authHandler, /if \(r && r\.ok\)[\s\S]*applyBrowserUserAgentToPartition\(partition, sourceBrowser\)/);
});

test("main은 파티션별 UA 주인에게 실제 함수를 배선한다", () => {
  const main = fs.readFileSync(path.join(root, "native/electron/main.cjs"), "utf8");
  // 소유자가 옳아도 main 이 실제 함수를 넘기지 않으면 아무 일도 일어나지 않는다.
  // 값 끝(쉼표)까지 확인한다. 접두사만 보면 `applyHardening && (() => {})` 가 통과한다.
  // 실제 함수 이름을 적어 둔 채로 동작을 끄는 형태다.
  assert.match(main, /hardenBrowserSession: applyHardening,\n/);
  assert.match(main, /userAgentForPartition: \(partition\) => cookieImport\.userAgentForPartition\(partition\),\n/);
  assert.match(main, /createChromeHandoffIpc\(\{[\s\S]{0,300}\n\s*cookieImport,\n/);
  assert.match(main, /for \(const imported of chromeImportRegistry\.list\(\)\)[\s\S]{0,240}rememberBrowserUserAgent\(imported\.partition, imported\.browser\)/);
});

test("인증 IPC는 파티션의 최신 Chrome 연결 장부를 우선한다", () => {
  const handoff = fs.readFileSync(path.join(root, "native/electron/chrome-handoff-ipc.cjs"), "utf8");
  const handler = sliceBetween(handoff, 'ipcMain.handle("ac-chrome-auth"', 'ipcMain.on("ac-open-in-chrome"', "인증 IPC");
  assert.match(handler, /chromeImportRegistry\.latestForPartition\(partition\)/);
  assert.match(handler, /cookieImport/);
  assert.match(handler, /chromeCid: chromeProfileCid/);
  assert.match(handler, /isCurrent: \(\) => chromeImportRegistry\.latestForPartition\(partition\) === recorded/);
});

test("Chrome import 장부는 파티션의 최신 연결을 고른다", () => {
  const registry = fs.readFileSync(path.join(root, "native/electron/chrome-import-registry.cjs"), "utf8");
  assert.match(registry, /Object\.values\(chromeImports \|\| \{\}\)/);
  assert.match(registry, /sort\(\(a, b\) => Number\(b\.at \|\| 0\) - Number\(a\.at \|\| 0\)\)/);
});
