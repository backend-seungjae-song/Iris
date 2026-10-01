import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installAgentContext } from "../scripts/install-agent-context.mjs";

const REQUIRED = [
  "bin/agent-context.mjs", "bin/iris-session.mjs", "bin/agent-run.mjs", "server/agent-lineage.js", "server/agent-session-path.js", "server/codex-session.js", "server/env.cjs",
  "server/herdr-session.cjs", "server/herdr.js", "server/prompt-targets.js", "server/state-home.cjs",
];

function fixture(t, name = "install") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `iris-agent-context-${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appPath = path.join(root, "Applications with spaces", "Iris.app");
  const unpacked = path.join(appPath, "Contents", "Resources", "app.asar.unpacked");
  for (const rel of REQUIRED) {
    const file = path.join(unpacked, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "fixture\n");
  }
  fs.writeFileSync(path.join(unpacked, "package.json"), JSON.stringify({ type: "module" }));
  const executable = path.join(appPath, "Contents", "MacOS", "Iris");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return { root, appPath, unpacked, codexHome: path.join(root, "codex home"), claudeHome: path.join(root, "claude home") };
}

function skill(home) {
  return path.join(home, "skills", "iris-agent-context", "SKILL.md");
}

function writeHookConfigs(f) {
  fs.mkdirSync(f.codexHome, { recursive: true });
  fs.mkdirSync(f.claudeHome, { recursive: true });
  fs.writeFileSync(path.join(f.codexHome, "hooks.json"), JSON.stringify({ keep: "codex", hooks: { UserPromptSubmit: [
    { hooks: [{ type: "command", command: "personal-codex", timeout: 9 }] },
  ] } }, null, 2) + "\n");
  fs.writeFileSync(path.join(f.claudeHome, "settings.json"), JSON.stringify({ keep: "claude", hooks: { Stop: [
    { hooks: [{ type: "command", command: "personal-claude" }] },
  ], UserPromptSubmit: [
    { hooks: [{ type: "command", command: "personal-prompt", timeout: 4 }] },
  ] } }, null, 2) + "\n");
}

test("fresh install writes discoverable managed guidance for Codex and Claude", (t) => {
  const f = fixture(t, "fresh");
  const result = installAgentContext(f);
  assert.equal(result.changed.length, 2);
  for (const home of [f.codexHome, f.claudeHome]) {
    const text = fs.readFileSync(skill(home), "utf8");
    assert.match(text, /name: iris-agent-context/);
    assert.match(text, /native subagents/);
    assert.match(text, /Before broad evidence gathering/);
    assert.match(text, /delegation permissions/);
    assert.match(text, /clicking a parent row shows only the parent's chat/);
    assert.match(text, /top-level sessions/);
    assert.match(text, /selected row clicked again/);
    assert.match(text, /Cmd\+W closes only the selected pane/);
    assert.ok(text.includes(`'${result.launcherPath}'`), "path with spaces must be shell quoted");
  }
});

test("reinstall is idempotent and preserves unrelated personal files", (t) => {
  const f = fixture(t, "repeat");
  fs.mkdirSync(f.codexHome, { recursive: true });
  const personal = path.join(f.codexHome, "AGENTS.md");
  fs.writeFileSync(personal, "personal guidance\n");
  installAgentContext(f);
  const before = fs.readFileSync(skill(f.codexHome), "utf8");
  const result = installAgentContext(f);
  assert.deepEqual(result.changed, []);
  assert.equal(fs.readFileSync(skill(f.codexHome), "utf8"), before);
  assert.equal(fs.readFileSync(personal, "utf8"), "personal guidance\n");
});

test("managed session and prompt hooks are merged for each agent and backed up once", (t) => {
  const f = fixture(t, "hooks");
  writeHookConfigs(f);
  const codexFile = path.join(f.codexHome, "hooks.json");
  const claudeFile = path.join(f.claudeHome, "settings.json");
  const codexBefore = fs.readFileSync(codexFile, "utf8");
  const claudeBefore = fs.readFileSync(claudeFile, "utf8");

  const first = installAgentContext({ ...f, addHooks: true });
  assert.equal(first.hookChanged.length, 2);
  const codex = JSON.parse(fs.readFileSync(codexFile, "utf8"));
  const claude = JSON.parse(fs.readFileSync(claudeFile, "utf8"));
  assert.equal(codex.keep, "codex");
  assert.equal(claude.keep, "claude");
  assert.equal(claude.hooks.Stop[0].hooks[0].command, "personal-claude");
  assert.equal(codex.hooks.UserPromptSubmit[0].hooks[0].command, "personal-codex");
  assert.equal(claude.hooks.UserPromptSubmit[0].hooks[0].command, "personal-prompt");
  for (const [runtime, data] of [["codex", codex], ["claude", claude]]) {
    for (const event of ["SessionStart", "UserPromptSubmit"]) {
      const managed = data.hooks[event].filter((entry) => entry.hooks.some((hook) => hook.command.includes("IRIS_AGENT_CONTEXT_PROMPT_TARGETS=1")));
      assert.equal(managed.length, 1);
      assert.equal(managed[0].hooks[0].timeout, 5);
      assert.match(managed[0].hooks[0].command, /ELECTRON_RUN_AS_NODE=1/);
      assert.match(managed[0].hooks[0].command, /Contents\/MacOS\/Iris'/);
      assert.match(managed[0].hooks[0].command, new RegExp(`app\\.asar\\.unpacked/bin/agent-context\\.mjs' prompt-targets --runtime ${runtime}$`));
    }
  }
  assert.equal(fs.readFileSync(codexFile + ".iris-agent-context.bak", "utf8"), codexBefore);
  assert.equal(fs.readFileSync(claudeFile + ".iris-agent-context.bak", "utf8"), claudeBefore);
  const afterFirst = [fs.readFileSync(codexFile, "utf8"), fs.readFileSync(claudeFile, "utf8")];
  assert.ok(afterFirst.every((text) => text.endsWith("\n") && text.includes('\n  "')));

  const second = installAgentContext({ ...f, addHooks: true });
  assert.deepEqual(second.hookChanged, []);
  assert.deepEqual([fs.readFileSync(codexFile, "utf8"), fs.readFileSync(claudeFile, "utf8")], afterFirst);
  assert.equal(fs.readFileSync(codexFile + ".iris-agent-context.bak", "utf8"), codexBefore);
  assert.equal(fs.readFileSync(claudeFile + ".iris-agent-context.bak", "utf8"), claudeBefore);
});

test("absent agent folders and broken hook configs are reported and never created or rewritten", (t) => {
  const f = fixture(t, "hook-skip");
  fs.mkdirSync(f.claudeHome, { recursive: true });
  const claudeFile = path.join(f.claudeHome, "settings.json");
  fs.writeFileSync(claudeFile, "{ broken\n");
  const result = installAgentContext({ ...f, addHooks: true });
  assert.equal(fs.existsSync(path.join(f.codexHome, "hooks.json")), false);
  assert.equal(fs.readFileSync(claudeFile, "utf8"), "{ broken\n");
  assert.match(result.hooks.find((item) => item.runtime === "Codex").skipped, /폴더가 없어/);
  assert.match(result.hooks.find((item) => item.runtime === "Claude").skipped, /JSON이 깨져/);
  assert.equal(fs.existsSync(claudeFile + ".iris-agent-context.bak"), false);
});

test("a missing hook config is created only when hooks are requested and the agent folder exists", (t) => {
  const f = fixture(t, "hook-create");
  fs.mkdirSync(f.codexHome, { recursive: true });
  fs.mkdirSync(f.claudeHome, { recursive: true });
  const codexFile = path.join(f.codexHome, "hooks.json");
  const claudeFile = path.join(f.claudeHome, "settings.json");
  const plain = installAgentContext(f);
  assert.deepEqual(plain.hookMissing, [claudeFile, codexFile]);
  assert.equal(fs.existsSync(codexFile) || fs.existsSync(claudeFile), false);
  assert.deepEqual(installAgentContext({ ...f, check: true }).hookMissing, [claudeFile, codexFile]);

  const added = installAgentContext({ ...f, addHooks: true });
  assert.deepEqual(added.hookChanged, [claudeFile, codexFile]);
  for (const file of [codexFile, claudeFile]) {
    const hooks = JSON.parse(fs.readFileSync(file, "utf8")).hooks;
    assert.equal(hooks.UserPromptSubmit.length, 1);
    assert.equal(hooks.SessionStart.length, 1);
    assert.match(hooks.UserPromptSubmit[0].hooks[0].command, /IRIS_AGENT_CONTEXT_PROMPT_TARGETS=1/);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(file + ".iris-agent-context.bak"), false);
  }
  assert.deepEqual(installAgentContext({ ...f, check: true }).hookMissing, []);
});

test("without --hooks an existing Iris hook is refreshed but a personal-only config gains nothing", (t) => {
  const f = fixture(t, "hook-refresh");
  writeHookConfigs(f);
  const codexFile = path.join(f.codexHome, "hooks.json");
  const claudeFile = path.join(f.claudeHome, "settings.json");
  const codexBefore = fs.readFileSync(codexFile, "utf8");
  const oldHook = { type: "command", command: "IRIS_AGENT_CONTEXT_PROMPT_TARGETS=1 old-app-path", timeout: 1 };
  const claude = JSON.parse(fs.readFileSync(claudeFile, "utf8"));
  claude.hooks.UserPromptSubmit.push({ hooks: [oldHook] });
  fs.writeFileSync(claudeFile, JSON.stringify(claude, null, 2) + "\n");

  const result = installAgentContext(f);
  assert.deepEqual(result.hookMissing, [codexFile]);
  assert.deepEqual(result.hookChanged, [claudeFile]);
  assert.equal(fs.readFileSync(codexFile, "utf8"), codexBefore);
  const entries = JSON.parse(fs.readFileSync(claudeFile, "utf8")).hooks.UserPromptSubmit;
  assert.equal(entries.length, 2);
  assert.match(entries[1].hooks[0].command, /app\.asar\.unpacked\/bin\/agent-context\.mjs' prompt-targets --runtime claude$/);
  assert.equal(entries[1].hooks[0].timeout, 5);
  assert.equal(JSON.parse(fs.readFileSync(claudeFile, "utf8")).hooks.SessionStart.length, 1);
});

test("wrong hook field types are reported without replacing user values", (t) => {
  const f = fixture(t, "hook-shape");
  fs.mkdirSync(f.codexHome, { recursive: true });
  fs.mkdirSync(f.claudeHome, { recursive: true });
  const codexFile = path.join(f.codexHome, "hooks.json");
  const claudeFile = path.join(f.claudeHome, "settings.json");
  fs.writeFileSync(codexFile, '{"hooks":{"UserPromptSubmit":{"mine":true}}}\n');
  fs.writeFileSync(claudeFile, '{"hooks":"mine"}\n');
  const result = installAgentContext(f);
  assert.equal(fs.readFileSync(codexFile, "utf8"), '{"hooks":{"UserPromptSubmit":{"mine":true}}}\n');
  assert.equal(fs.readFileSync(claudeFile, "utf8"), '{"hooks":"mine"}\n');
  assert.match(result.hooks.find((item) => item.runtime === "Codex").skipped, /배열이 아니라/);
  assert.match(result.hooks.find((item) => item.runtime === "Claude").skipped, /객체가 아니라/);
});

test("check compares managed hooks without writing settings or backups", (t) => {
  const f = fixture(t, "hook-check");
  writeHookConfigs(f);
  const codexFile = path.join(f.codexHome, "hooks.json");
  const claudeFile = path.join(f.claudeHome, "settings.json");
  const before = [fs.readFileSync(codexFile, "utf8"), fs.readFileSync(claudeFile, "utf8")];
  const missing = installAgentContext({ ...f, check: true });
  assert.equal(missing.hookMissing.length, 2);
  assert.deepEqual([fs.readFileSync(codexFile, "utf8"), fs.readFileSync(claudeFile, "utf8")], before);
  assert.equal(fs.existsSync(codexFile + ".iris-agent-context.bak"), false);
  installAgentContext({ ...f, addHooks: true });
  const current = installAgentContext({ ...f, check: true });
  assert.deepEqual([current.hookChanged, current.hookMissing], [[], []]);
});

test("outdated and duplicate Iris entries become one entry without moving personal hooks", (t) => {
  const f = fixture(t, "hook-update");
  fs.mkdirSync(f.codexHome, { recursive: true });
  fs.mkdirSync(f.claudeHome, { recursive: true });
  const oldHook = { type: "command", command: "IRIS_AGENT_CONTEXT_PROMPT_TARGETS=1 old", timeout: 1 };
  const old = { hooks: [oldHook] };
  const mixed = { hooks: [oldHook, { type: "command", command: "personal-in-same-group" }] };
  const personal = { hooks: [{ type: "command", command: "personal" }] };
  fs.writeFileSync(path.join(f.codexHome, "hooks.json"), JSON.stringify({ hooks: { UserPromptSubmit: [mixed, personal, old] } }, null, 2) + "\n");
  fs.writeFileSync(path.join(f.claudeHome, "settings.json"), JSON.stringify({ hooks: { UserPromptSubmit: [mixed, personal, old] } }, null, 2) + "\n");
  installAgentContext({ ...f, addHooks: true });
  for (const file of [path.join(f.codexHome, "hooks.json"), path.join(f.claudeHome, "settings.json")]) {
    const hooks = JSON.parse(fs.readFileSync(file, "utf8")).hooks;
    const entries = hooks.UserPromptSubmit;
    assert.equal(entries.length, 2);
    assert.match(entries[0].hooks[0].command, /IRIS_AGENT_CONTEXT_PROMPT_TARGETS=1/);
    assert.equal(entries[0].hooks[0].timeout, 5);
    assert.equal(entries[0].hooks[1].command, "personal-in-same-group");
    assert.equal(entries[1].hooks[0].command, "personal");
    assert.equal(hooks.SessionStart.length, 1);
  }
});

test("check mode reports missing or outdated guidance without writing", (t) => {
  const f = fixture(t, "check");
  const missing = installAgentContext({ ...f, check: true });
  assert.equal(missing.changed.length, 2);
  assert.equal(fs.existsSync(skill(f.codexHome)), false);
  assert.equal(fs.existsSync(skill(f.claudeHome)), false);
  installAgentContext(f);
  assert.deepEqual(installAgentContext({ ...f, check: true }).changed, []);
  fs.writeFileSync(skill(f.claudeHome), fs.readFileSync(skill(f.claudeHome), "utf8") + "\nstale\n");
  const stale = installAgentContext({ ...f, check: true });
  assert.deepEqual(stale.changed, [skill(f.claudeHome)]);
  assert.match(fs.readFileSync(skill(f.claudeHome), "utf8"), /stale/);
});

test("unmanaged skill conflict is rejected before either home changes", (t) => {
  const f = fixture(t, "conflict");
  fs.mkdirSync(path.dirname(skill(f.codexHome)), { recursive: true });
  fs.writeFileSync(skill(f.codexHome), "user-owned skill\n");
  assert.throws(() => installAgentContext(f), /not managed by Iris/);
  assert.equal(fs.readFileSync(skill(f.codexHome), "utf8"), "user-owned skill\n");
  assert.equal(fs.existsSync(skill(f.claudeHome)), false);
});

test("symlink homes remain symlinks", (t) => {
  const f = fixture(t, "symlink");
  const realCodex = path.join(f.root, "real codex home");
  fs.mkdirSync(realCodex, { recursive: true });
  fs.symlinkSync(realCodex, f.codexHome);
  installAgentContext(f);
  assert.equal(fs.lstatSync(f.codexHome).isSymbolicLink(), true);
  assert.equal(fs.existsSync(skill(realCodex)), true);
});

test("an existing skill-file symlink is preserved and blocks both writes", (t) => {
  const f = fixture(t, "skill-symlink");
  const ownedElsewhere = path.join(f.root, "personal-skill.md");
  fs.writeFileSync(ownedElsewhere, "personal skill\n");
  fs.mkdirSync(path.dirname(skill(f.codexHome)), { recursive: true });
  fs.symlinkSync(ownedElsewhere, skill(f.codexHome));
  assert.throws(() => installAgentContext(f), /is a symlink and will not be replaced/);
  assert.equal(fs.lstatSync(skill(f.codexHome)).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(ownedElsewhere, "utf8"), "personal skill\n");
  assert.equal(fs.existsSync(skill(f.claudeHome)), false);
});

test("CLAUDE_CONFIG_DIR is the default Claude skill home", (t) => {
  const f = fixture(t, "claude-config-dir");
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = f.claudeHome;
  t.after(() => {
    if (previous == null) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  });
  const result = installAgentContext({ appPath: f.appPath, codexHome: f.codexHome });
  assert.ok(result.installed.includes(skill(f.claudeHome)));
});

test("incomplete installed package leaves both guidance homes untouched", (t) => {
  const f = fixture(t, "missing");
  fs.mkdirSync(f.codexHome, { recursive: true });
  fs.mkdirSync(f.claudeHome, { recursive: true });
  const codexSettings = path.join(f.codexHome, "config.toml");
  const claudeSettings = path.join(f.claudeHome, "CLAUDE.md");
  fs.writeFileSync(codexSettings, "model = 'mine'\n");
  fs.writeFileSync(claudeSettings, "my guidance\n");
  fs.unlinkSync(path.join(f.unpacked, "server", "agent-lineage.js"));
  assert.throws(() => installAgentContext(f), /package is incomplete/);
  assert.equal(fs.readFileSync(codexSettings, "utf8"), "model = 'mine'\n");
  assert.equal(fs.readFileSync(claudeSettings, "utf8"), "my guidance\n");
  assert.equal(fs.existsSync(skill(f.codexHome)), false);
  assert.equal(fs.existsSync(skill(f.claudeHome)), false);
});

test("packaging keeps the installed launcher and its module boundary unpacked", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const shippedCheck = fs.readFileSync(path.join(root, "scripts", "check-shipped.mjs"), "utf8");
  const appInstaller = fs.readFileSync(path.join(root, "scripts", "install-app.sh"), "utf8");
  assert.ok(pkg.build.files.includes("bin/agent-context.mjs"));
  assert.ok(pkg.build.asarUnpack.includes("bin/agent-context.mjs"));
  assert.ok(pkg.build.asarUnpack.includes("package.json"));
  assert.ok(pkg.build.asarUnpack.includes("server/**"));
  assert.ok(pkg.build.files.includes("bin/iris-session.mjs"));
  assert.ok(pkg.build.asarUnpack.includes("bin/iris-session.mjs"));
  assert.match(shippedCheck, /\["bin\/agent-context\.mjs", "bin\/iris-session\.mjs", \.\.\.native/);
  const health = appInstaller.indexOf('running || rollback "새 앱이 서버 준비 중에 종료됨"');
  const guidance = appInstaller.indexOf('node scripts/install-agent-context.mjs --app "$APP"');
  const discardBackup = appInstaller.indexOf('[ -n "$OLD" ] && rm -rf "$OLD"');
  assert.ok(health >= 0 && guidance > health && discardBackup > guidance,
    "guidance must install from the verified app before the recoverable backup is discarded");
});

test("중복된 Herdr 세션 등록만 제거하고 다른 개인 훅은 보존한다", (t) => {
  const f = fixture(t, "registration");
  writeHookConfigs(f);
  for (const [home, name] of [[f.codexHome, "hooks.json"], [f.claudeHome, "settings.json"]]) {
    const file = path.join(home, name);
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    data.hooks.SessionStart = [{ hooks: [
      { type: "command", command: "bash '/home/you/herdr-agent-state.sh' session" },
      { type: "command", command: "personal-start" },
    ] }];
    data.hooks.SessionEnd = [{ hooks: [
      { type: "command", command: "python3 ~/.claude/hooks/herdr-session-register.py" },
      { type: "command", command: "personal-end" },
    ] }];
    fs.writeFileSync(file, JSON.stringify(data));
  }
  installAgentContext({ ...f, addHooks: true });
  for (const [home, name] of [[f.codexHome, "hooks.json"], [f.claudeHome, "settings.json"]]) {
    const data = JSON.parse(fs.readFileSync(path.join(home, name), "utf8"));
    const commands = Object.values(data.hooks).flatMap(g => g.flatMap(i => i.hooks.map(h => h.command)));
    assert.ok(commands.includes("personal-start"));
    assert.ok(commands.includes("personal-end"));
    assert.ok(!commands.some(c => c.includes("herdr-agent-state.sh") || c.includes("herdr-session-register.py")));
    assert.equal(data.hooks.SessionStart.flatMap(i => i.hooks).filter(h => h.command.includes("IRIS_AGENT_CONTEXT")).length, 1);
  }
});
