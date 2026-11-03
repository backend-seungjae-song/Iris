import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createQuestionHookInstaller } from "../server/remote/installer.js";

test("질문 hook 설치와 제거는 기존 설정을 보존하고 설치 전에 백업한다", async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "iris-hook-installer-"));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  const claude = path.join(home, ".claude");
  await fsp.mkdir(claude, { recursive: true });
  const settingsPath = path.join(claude, "settings.json");
  const original = { permissions: { allow: ["Read"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "keep" }] }] } };
  await fsp.writeFile(settingsPath, JSON.stringify(original, null, 4));
  const installer = createQuestionHookInstaller({
    settingsPath,
    nodePath: "/absolute/node",
    hookPath: "/absolute/ask-question.mjs",
    socketPath: "/tmp/agent.sock",
    now: () => new Date("2026-09-27T12:34:56.789Z"),
    asNode: false,
  });

  assert.equal(await installer.isInstalled(), false);
  assert.deepEqual(await installer.install(), { ok: true, installed: true });
  const installed = JSON.parse(await fsp.readFile(settingsPath, "utf8"));
  assert.deepEqual(installed.permissions, original.permissions);
  assert.deepEqual(installed.hooks.Stop, original.hooks.Stop);
  assert.equal(installed.hooks.PreToolUse.at(-1).matcher, "AskUserQuestion");
  assert.equal(installed.hooks.PreToolUse.at(-1).hooks[0].timeout, 1);
  assert.match(installed.hooks.PreToolUse.at(-1).hooks[0].command, /absolute\/node.*ask-question\.mjs.*agent\.sock/);
  const backups = (await fsp.readdir(claude)).filter((name) => name.startsWith(".iris-backup-"));
  assert.equal(backups.length, 1);
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(claude, backups[0]), "utf8")), original);

  assert.deepEqual(await installer.remove(), { ok: true, installed: false });
  const removed = JSON.parse(await fsp.readFile(settingsPath, "utf8"));
  assert.deepEqual(removed, original);
});

test("질문 hook 설치는 깨진 JSON을 덮어쓰거나 백업하지 않는다", async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "iris-hook-invalid-"));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  const claude = path.join(home, ".claude");
  await fsp.mkdir(claude, { recursive: true });
  const settingsPath = path.join(claude, "settings.json");
  await fsp.writeFile(settingsPath, "{broken");
  const installer = createQuestionHookInstaller({ settingsPath, nodePath: "/node", hookPath: "/hook", socketPath: "/sock", asNode: false });
  assert.deepEqual(await installer.install(), { ok: false, error: "settings-invalid" });
  assert.equal(await fsp.readFile(settingsPath, "utf8"), "{broken");
  assert.deepEqual((await fsp.readdir(claude)).filter((name) => name.startsWith(".iris-backup-")), []);
});

test("질문 hook 제거는 같은 그룹에 사용자가 넣은 다른 hook을 남긴다", async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "iris-hook-shared-group-"));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  const claude = path.join(home, ".claude");
  await fsp.mkdir(claude, { recursive: true });
  const settingsPath = path.join(claude, "settings.json");
  const installer = createQuestionHookInstaller({ settingsPath, nodePath: "/node", hookPath: "/hook", socketPath: "/sock", asNode: false });
  const other = { type: "command", command: "keep-mine" };
  await fsp.writeFile(settingsPath, JSON.stringify({ hooks: { PreToolUse: [
    { matcher: "AskUserQuestion", hooks: [other, { type: "command", command: installer.command, timeout: 600 }] },
  ] } }));
  assert.deepEqual(await installer.remove(), { ok: true, installed: false });
  assert.deepEqual(JSON.parse(await fsp.readFile(settingsPath, "utf8")),
    { hooks: { PreToolUse: [{ matcher: "AskUserQuestion", hooks: [other] }] } });
});

 test("69 같은 command의 오래된 timeout 갱신과 다른 hook 보존", async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'iris-69-install-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const settingsPath = path.join(root, 'settings.json');
  const installer = createQuestionHookInstaller({ settingsPath, nodePath: '/node', hookPath: '/hook', socketPath: '/sock' });
  await fsp.writeFile(settingsPath, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [
    { type: 'command', command: installer.command, timeout: 600 }, { type: 'command', command: 'keep', timeout: 42 } ] }] } }));
  assert.equal(await installer.isInstalled(), false);
  assert.equal((await installer.install()).ok, true);
  assert.equal(await installer.isInstalled(), true);
  const hooks = JSON.parse(await fsp.readFile(settingsPath)).hooks.PreToolUse[0].hooks;
  assert.equal(hooks.length, 2); assert.equal(hooks[0].timeout, 1); assert.equal(hooks[1].timeout, 42);
  assert.equal((await installer.install()).unchanged, true);
});

test("hook 설치는 PreToolUse 와 PermissionRequest 두 이벤트에 등록하고 한쪽만 있으면 채운다", async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "iris-hook-two-"));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  const settingsPath = path.join(home, "settings.json");
  const installer = createQuestionHookInstaller({ settingsPath, nodePath: "/node", hookPath: "/hook", socketPath: "/sock", asNode: false });
  await installer.install();
  let settings = JSON.parse(await fsp.readFile(settingsPath, "utf8"));
  assert.equal(settings.hooks.PermissionRequest.length, 1);
  assert.equal("matcher" in settings.hooks.PermissionRequest[0], false);
  assert.equal(settings.hooks.PermissionRequest[0].hooks[0].command, installer.command);
  assert.equal(await installer.isInstalled(), true);
  // 예전 버전이 PreToolUse 만 등록했던 설정에도 PermissionRequest 를 채움
  delete settings.hooks.PermissionRequest;
  await fsp.writeFile(settingsPath, JSON.stringify(settings));
  assert.equal(await installer.isInstalled(), false);
  assert.deepEqual(await installer.install(), { ok: true, installed: true });
  assert.equal(JSON.parse(await fsp.readFile(settingsPath, "utf8")).hooks.PreToolUse.length, 1);
  assert.deepEqual(await installer.remove(), { ok: true, installed: false });
  assert.deepEqual(JSON.parse(await fsp.readFile(settingsPath, "utf8")), {});
});
