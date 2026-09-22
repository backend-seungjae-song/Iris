import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installAgentContext } from "../scripts/install-agent-context.mjs";

const REQUIRED = [
  "bin/agent-context.mjs", "bin/agent-run.mjs", "server/agent-lineage.js", "server/codex-session.js", "server/env.cjs",
  "server/herdr-session.cjs", "server/herdr.js", "server/state-home.cjs",
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
  return { root, appPath, unpacked, codexHome: path.join(root, "codex home"), claudeHome: path.join(root, "claude home") };
}

function skill(home) {
  return path.join(home, "skills", "iris-agent-context", "SKILL.md");
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
  assert.match(shippedCheck, /\["bin\/agent-context\.mjs", \.\.\.native/);
  const health = appInstaller.indexOf('if ! pgrep -f "$APP/Contents/MacOS/Iris"');
  const guidance = appInstaller.indexOf('node scripts/install-agent-context.mjs --app "$APP"');
  const discardBackup = appInstaller.indexOf('[ -n "$OLD" ] && rm -rf "$OLD"');
  assert.ok(health >= 0 && guidance > health && discardBackup > guidance,
    "guidance must install from the verified app before the recoverable backup is discarded");
});
