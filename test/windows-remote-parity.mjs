import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { windowsPowerShellEnv } from "../server/windows-powershell.cjs";
import { createSecureContext } from "node:tls";

import { prepareGatewayCertificate } from "../server/remote/certificate.js";
import { createBrowserFeature } from "../server/remote/features/browser.js";
import { MAX_BROWSER_FRAME_JPEG_BYTES } from "../server/remote/contract/ipc.js";
import { createQuestionHookInstaller } from "../server/remote/installer.js";
import { redactMacPaths } from "../server/remote/public-text.js";

function directory(t) {
  const root = process.env.IRIS_WINDOWS_TEST_TMP || os.tmpdir();
  fs.mkdirSync(root, { recursive: true });
  const result = fs.mkdtempSync(path.join(root, "iris-remote-windows-"));
  t.after(() => fs.rmSync(result, { recursive: true }));
  return result;
}

test("Windows 경로는 드라이브·UNC·공백을 가리고 HTTP 주소는 보존한다", () => {
  const redact = (value) => redactMacPaths(value, undefined, "win32");
  for (const value of [String.raw`C:\Users\private\file.js`, "D:/work/private/file.js",
    String.raw`\\server\private\file.js`, "//server/private/file.js", String.raw`\\?\C:\Users\private\file.js`]) {
    assert.equal(redact(`오류 ${value} 및 https://example.test/a`), "오류 [Windows 경로] https://example.test/a");
  }
  assert.equal(redact(String.raw`{"file":"C:\Users\User Name\private.js"}`), '{"file":"[Windows 경로]"}');
  assert.equal(redact(String.raw`'\\server\shared folder\private.js'`), "'[Windows 경로]'");
  assert.equal(redact(String.raw`C:\Users\User Name\private.js`), "[Windows 경로]");
  assert.equal(redact(String.raw`C:\Users\private.js https://example.test/a`), "[Windows 경로] https://example.test/a");
  assert.equal(redact(String.raw`오류 C:\Users\First Last\private.js`), "오류 [Windows 경로]");
  assert.equal(redact(String.raw`오류 C:\Users\name\private file.js`), "오류 [Windows 경로]");
  assert.equal(redact(String.raw`오류 C:\Users\User Name\private.js 및 https://example.test/a`), "오류 [Windows 경로] https://example.test/a");
  assert.equal(redact("https://example.test/a /Users/you/work.js"), "https://example.test/a [Mac 경로]");
  assert.equal(redactMacPaths(String.raw`오류 C:\Users\private`, undefined, "darwin"), String.raw`오류 C:\Users\private`);
  const originals = [];
  redactMacPaths(String.raw`"C:\Users\User Name\private.js"`, (_label, original) => { originals.push(original); return "[숨김]"; }, "win32");
  assert.deepEqual(originals, [String.raw`C:\Users\User Name\private.js`]);
});

test("Windows 질문 훅은 PowerShell 셸을 지정하고 기존 사용자 훅을 보존한다", async (t) => {
  const settingsPath = path.join(directory(t), "settings.json");
  const installer = createQuestionHookInstaller({ platform: "win32", settingsPath,
    nodePath: String.raw`C:\Program Files\Iris\Iris.exe`, hookPath: String.raw`C:\Users\O'Brien $() & name\hook.mjs`,
    socketPath: String.raw`\\.\pipe\iris-agent`, asNode: true });
  assert.match(installer.command, /^\$env:ELECTRON_RUN_AS_NODE='1'; & 'C:\\Program Files/);
  assert.match(installer.command, /O''Brien \$\(\) & name/);
  await installer.install();
  const settings = JSON.parse(await fsp.readFile(settingsPath, "utf8"));
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].shell, "powershell");
  assert.equal(await installer.isInstalled(), true);
  assert.equal((await installer.install()).unchanged, true);
  settings.hooks.PreToolUse[0].hooks.push({ type: "command", command: "keep" });
  await fsp.writeFile(settingsPath, JSON.stringify(settings));
  await installer.remove();
  assert.deepEqual(JSON.parse(await fsp.readFile(settingsPath, "utf8")).hooks.PreToolUse[0].hooks,
    [{ type: "command", command: "keep" }]);
});

test("Windows 질문 훅은 stdin·환경변수·인자·종료 코드를 실제 PowerShell에서 전달한다", { skip: process.platform !== "win32" }, (t) => {
  const home = directory(t);
  const hookPath = path.join(home, "hook's $() & name.mjs");
  fs.writeFileSync(hookPath, `process.stdin.setEncoding('utf8'); let text=''; process.stdin.on('data', v=>text+=v);
    process.stdin.on('end', ()=>{console.log(JSON.stringify({text, env:process.env.ELECTRON_RUN_AS_NODE, args:process.argv.slice(2)})); process.exitCode=17;});`);
  const socketPath = String.raw`\\.\pipe\iris-O'Brien-$()-agent`;
  const installer = createQuestionHookInstaller({ settingsPath: path.join(home, "settings.json"),
    nodePath: process.execPath, hookPath, socketPath });
  let failure;
  try { execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", installer.command],
    { input: "hook input", encoding: "utf8", timeout: 10_000, windowsHide: true }); }
  catch (error) { failure = error; }
  assert.equal(failure?.status, 17);
  assert.deepEqual(JSON.parse(failure.stdout.trim()), { text: "hook input", env: "1", args: [socketPath] });
});

test("Windows 인증서는 openssl 없이 생성·TLS 로드·재사용한다", async (t) => {
  const stateDir = directory(t);
  const options = { stateDir, platform: "win32", execFile: async () => { throw new Error("openssl unavailable"); } };
  const first = await prepareGatewayCertificate(options);
  const certificate = new X509Certificate(first.certPem);
  assert.equal(certificate.subject, "CN=Iris Remote");
  assert.equal(certificate.verify(certificate.publicKey), true);
  assert.equal(certificate.ca, false);
  assert.deepEqual(certificate.keyUsage, ["1.3.6.1.5.5.7.3.1"]);
  const privateKey = createPrivateKey(first.keyPem);
  assert.equal(privateKey.asymmetricKeyDetails.namedCurve, "prime256v1");
  assert.equal(createPublicKey(privateKey).export({ format: "der", type: "spki" })
    .equals(certificate.publicKey.export({ format: "der", type: "spki" })), true);
  assert.ok(createSecureContext({ key: first.keyPem, cert: first.certPem, minVersion: "TLSv1.3" }));
  assert.equal(new Date(certificate.validTo) - new Date(certificate.validFrom), 3650 * 86400000);
  const second = await prepareGatewayCertificate(options);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.certHash, first.certHash);
  assert.deepEqual((await fsp.readdir(path.join(stateDir, "remote"))).sort(), ["gateway-cert.pem", "gateway-key.pem"]);
});

function browser(t, execFile, source) {
  const stateDir = directory(t), messages = [];
  const feature = createBrowserFeature({ platform: "win32", stateDir, execFile,
    browserState: () => ({ tabsBySpace: { work: [{ id: "tab" }] } }), runtimeSnapshot: () => ({ workspaces: [] }),
    tabMeta: () => ({ wc: 42 }), controlSnapshot: () => [], cdpReady: () => true,
    requestCdp: async () => ({ ok: true, data: { path: source || path.join(stateDir, "source's $() & name.png") } }),
    agents: {}, send: (_id, value) => messages.push(value), setTimer: () => ({ unref() {} }), clearTimer() {} });
  t.after(() => feature.close());
  const request = { tab: feature.catalog().tabs[0].ref, width: 390, fps: 2, desktop: false };
  return { feature, request, messages, stateDir };
}

function jpeg(width, height) {
  const bytes = Buffer.alloc(24);
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]);
  bytes.writeUInt16BE(height, 7); bytes.writeUInt16BE(width, 9);
  return bytes;
}

test("Windows 프레임은 sips 없이 JPEG를 보내고 변환 파일을 삭제한다", async (t) => {
  let destination;
  const fixture = browser(t, (file, args, options, callback) => {
    assert.equal(file, "powershell.exe");
    assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, 10_000);
    assert.deepEqual(options.env, windowsPowerShellEnv());
    assert.match(args[args.indexOf("-File") + 1], /windows-frame\.ps1$/);
    assert.match(args[args.indexOf("-SourcePath") + 1], /source's \$\(\) & name\.png$/);
    destination = args[args.indexOf("-DestinationPath") + 1];
    assert.equal(args[args.indexOf("-MaximumBytes") + 1], String(MAX_BROWSER_FRAME_JPEG_BYTES));
    fs.writeFileSync(destination, jpeg(390, 200)); callback(null, "", "");
  });
  assert.deepEqual(await fixture.feature.watchFrame({ connId: "phone" }, fixture.request), { ok: true });
  assert.equal(fixture.messages[0].type, "browser.frame");
  assert.equal(fixture.messages[0].width, 390);
  assert.equal(fixture.messages[0].height, 200);
  assert.equal(fs.existsSync(destination), false);
});

test("Windows 변환 실패·깨진 JPEG·용량 초과는 프레임을 보내지 않는다", async (t) => {
  for (const result of [null, Buffer.from("not jpeg"), Buffer.concat([jpeg(390, 200), Buffer.alloc(MAX_BROWSER_FRAME_JPEG_BYTES)])]) {
    const fixture = browser(t, (_file, args, _options, callback) => {
      const destination = args[args.indexOf("-DestinationPath") + 1];
      if (result) fs.writeFileSync(destination, result);
      callback(result ? null : new Error("conversion failed"), "", "");
    });
    assert.deepEqual(await fixture.feature.watchFrame({ connId: "phone" }, fixture.request),
      { ok: false, code: "browser-frame-unavailable" });
    assert.deepEqual(fixture.messages, []);
    assert.deepEqual(fs.readdirSync(path.join(fixture.stateDir, "remote", "frames")), []);
  }
});

test("Windows 기본 이미지 변환은 실제 PowerShell에서 PNG를 JPEG로 바꾼다", { skip: process.platform !== "win32" }, async (t) => {
  const source = path.join(directory(t), "image's $() & name.png");
  fs.copyFileSync(new URL("../assets/icon.png", import.meta.url), source);
  const fixture = browser(t, undefined, source);
  assert.deepEqual(await fixture.feature.watchFrame({ connId: "phone" }, fixture.request), { ok: true });
  const frame = fixture.messages[0];
  assert.equal(frame.width, 390); assert.equal(frame.height, 390);
  const bytes = Buffer.from(frame.jpeg, "base64");
  assert.equal(bytes.readUInt16BE(0), 0xffd8);
  assert.equal(bytes.readUInt16BE(bytes.length - 2), 0xffd9);
  assert.ok(bytes.length <= MAX_BROWSER_FRAME_JPEG_BYTES);
  assert.deepEqual(fs.readdirSync(path.join(fixture.stateDir, "remote", "frames")), []);
});
