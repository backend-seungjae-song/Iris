#!/usr/bin/env node
// 설치된 Iris launcher를 Codex와 Claude가 찾을 수 있도록 각자의 skills 아래에 한 파일만 둔다.
// 기존 전역 지침·설정은 열지 않고, 이 스크립트가 표식을 남긴 전용 파일만 다시 쓴다.
// --check 는 아무것도 쓰지 않고 두 파일이 지금 내용과 같은지만 보고한다(다르면 exit 1).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(HERE, "templates", "iris-agent-context", "SKILL.md");
const MANAGED_MARKER = "<!-- iris-agent-context-managed:v1 -->";
const SKILL_NAME = "iris-agent-context";
const REQUIRED_RUNTIME_FILES = [
  "bin/agent-context.mjs",
  "bin/agent-run.mjs",
  "package.json",
  "server/agent-lineage.js",
  "server/codex-session.js",
  "server/env.cjs",
  "server/herdr-session.cjs",
  "server/herdr.js",
  "server/state-home.cjs",
];

function installedRoot(appPath) {
  return path.join(appPath, "Contents", "Resources", "app.asar.unpacked");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function preflightRuntime(appPath) {
  const root = installedRoot(appPath);
  const missing = REQUIRED_RUNTIME_FILES.filter((rel) => {
    try { return !fs.statSync(path.join(root, rel)).isFile(); }
    catch { return true; }
  });
  if (missing.length) throw new Error(`installed Iris agent context package is incomplete: ${missing.join(", ")}`);
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")); }
  catch { throw new Error("installed Iris agent context package.json is unreadable"); }
  if (pkg.type !== "module") throw new Error("installed Iris agent context package must declare type=module");
  return { root, launcherPath: path.join(root, "bin", "agent-context.mjs"), runnerPath: path.join(root, "bin", "agent-run.mjs") };
}

function targetInfo(home, content, runtime) {
  if (typeof home !== "string" || !home) throw new Error(`${runtime} home is required`);
  const target = path.join(path.resolve(home), "skills", SKILL_NAME, "SKILL.md");
  let previous = null;
  try {
    const ownStat = fs.lstatSync(target);
    if (ownStat.isSymbolicLink()) throw new Error(`${runtime} managed skill file is a symlink and will not be replaced: ${target}`);
    const stat = fs.statSync(target);
    if (!stat.isFile()) throw new Error(`${runtime} managed skill target is not a file: ${target}`);
    previous = fs.readFileSync(target, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (previous != null && !previous.includes(MANAGED_MARKER)) {
    throw new Error(`${runtime} skill already exists and is not managed by Iris: ${target}`);
  }
  return { runtime, target, previous, content, changed: previous !== content };
}

function installTargets(targets) {
  const staged = [];
  try {
    for (const target of targets.filter((item) => item.changed)) {
      fs.mkdirSync(path.dirname(target.target), { recursive: true, mode: 0o700 });
      const temp = path.join(path.dirname(target.target), `.SKILL.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
      fs.writeFileSync(temp, target.content, { mode: 0o644 });
      staged.push({ ...target, temp });
    }
    for (const item of staged) fs.renameSync(item.temp, item.target);
  } finally {
    for (const item of staged) { try { fs.unlinkSync(item.temp); } catch {} }
  }
}

export function installAgentContext(options = {}) {
  const appPath = path.resolve(options.appPath || "/Applications/Iris.app");
  const codexHome = options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const claudeHome = options.claudeHome || process.env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude");
  const { launcherPath, runnerPath } = preflightRuntime(appPath);
  let template;
  try { template = fs.readFileSync(TEMPLATE, "utf8"); }
  catch { throw new Error(`Iris agent context skill template is unavailable: ${TEMPLATE}`); }
  if (!template.includes(MANAGED_MARKER) || !template.includes("{{LAUNCHER}}") || !template.includes("{{RUNNER}}")) {
    throw new Error("Iris agent context skill template is invalid");
  }
  const content = template
    .replace("{{LAUNCHER}}", shellQuote(launcherPath))
    .replace("{{RUNNER}}", shellQuote(runnerPath));

  // 두 대상을 모두 검사한 뒤에만 쓰기 시작한다. 한쪽의 사용자 소유 skill 때문에 다른 쪽만
  // 바뀌는 부분 설치를 만들지 않는다.
  const targets = [
    targetInfo(codexHome, content, "Codex"),
    targetInfo(claudeHome, content, "Claude"),
  ];
  if (!options.check) installTargets(targets);
  return {
    launcherPath,
    installed: targets.map((item) => item.target),
    changed: targets.filter((item) => item.changed).map((item) => item.target),
  };
}

function main() {
  const { values } = parseArgs({ options: {
    app: { type: "string" },
    "codex-home": { type: "string" },
    "claude-home": { type: "string" },
    check: { type: "boolean" },
  } });
  const result = installAgentContext({
    appPath: values.app,
    codexHome: values["codex-home"],
    claudeHome: values["claude-home"],
    check: values.check,
  });
  if (values.check) {
    const current = result.installed.length - result.changed.length;
    console.log(`Agent context guidance check: ${current} up to date, ${result.changed.length} missing or outdated`);
    for (const target of result.changed) console.log(`  needs update: ${target}`);
    if (result.changed.length) process.exitCode = 1;
    return;
  }
  console.log(`Agent context guidance ready: ${result.changed.length} updated, ${result.installed.length} present`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
