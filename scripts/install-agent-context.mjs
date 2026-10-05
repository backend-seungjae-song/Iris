#!/usr/bin/env node
// 설치 대상: Iris launcher 안내와 Codex·Claude 세션 기록·지목 등록 훅
// 갱신 범위: skill 전용 파일과 각 이벤트의 Iris 표식 항목 하나
// 새 훅 조건: setup 확인 뒤 받은 --hooks
// 기존 훅 처리: 새 앱 경로 갱신, 에이전트 폴더가 있을 때만 설정 파일 생성
// --check: 파일 변경 없는 skill·훅 대조, 차이 또는 누락이면 exit 1
// --hook-status: 파일 변경 없는 missing 또는 present 출력
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(HERE, "templates", "iris-agent-context", "SKILL.md");
const MANAGED_MARKER = "<!-- iris-agent-context-managed:v1 -->";
const SKILL_NAME = "iris-agent-context";
const HOOK_MARKER = "IRIS_AGENT_CONTEXT_PROMPT_TARGETS=1";
const HOOK_BACKUP_SUFFIX = ".iris-agent-context.bak";
const REQUIRED_RUNTIME_FILES = [
  "bin/agent-context.mjs",
  "bin/iris-session.mjs",
  "bin/agent-run.mjs",
  "package.json",
  "server/agent-lineage.js",
  "server/agent-session-path.js",
  "server/codex-session.js",
  "server/env.cjs",
  "server/herdr-session.cjs",
  "server/herdr.js",
  "server/prompt-targets.js",
  "server/state-home.cjs",
];

function installedRoot(appPath) {
  if (process.platform === "win32") return path.join(appPath, "resources", "app.asar.unpacked");
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
  const nodePath = process.platform === "win32" ? path.join(appPath, "Iris.exe") : path.join(appPath, "Contents", "MacOS", path.basename(appPath, ".app"));
  try { fs.accessSync(nodePath, fs.constants.X_OK); }
  catch { throw new Error(`installed Iris node runtime is unavailable: ${nodePath}`); }
  return { root, nodePath, launcherPath: path.join(root, "bin", "agent-context.mjs"), runnerPath: path.join(root, "bin", "agent-run.mjs") };
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

function hookEntry(command) {
  return { hooks: [{ type: "command", command, timeout: 5 }] };
}

function containsHookMarker(item) {
  return Array.isArray(item?.hooks) && item.hooks.some(isManagedHook);
}

function isManagedHook(hook) {
  if (typeof hook?.command !== "string") return false;
  if (hook.command.includes(HOOK_MARKER)) return true;
  const encoded = hook.command.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)\s*$/i)?.[1];
  return !!encoded && Buffer.from(encoded, "base64").toString("utf16le").includes(HOOK_MARKER);
}

function hookTargetInfo(file, runtime, command, nested, add) {
  let previous;
  let created = false;
  try {
    const own = fs.lstatSync(file);
    if (own.isSymbolicLink()) return { runtime, target: file, skipped: "심볼릭 링크라 건드리지 않음", changed: true };
    if (!own.isFile()) return { runtime, target: file, skipped: "일반 파일이 아니라 건드리지 않음", changed: true };
    previous = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") return { runtime, target: file, skipped: String(error?.message || error), changed: true };
    // 에이전트 폴더가 없으면 그 CLI를 쓰지 않는 것. 폴더를 만들지 않음
    if (!fs.existsSync(path.dirname(file))) return { runtime, target: file, skipped: "에이전트 폴더가 없어 건너뜀", absent: true, changed: false };
    previous = "{}\n";
    created = true;
  }
  let data;
  try { data = JSON.parse(previous); }
  catch { return { runtime, target: file, skipped: "JSON이 깨져 있어 건드리지 않음", changed: true }; }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { runtime, target: file, skipped: "JSON 최상위 값이 객체가 아니라 건드리지 않음", changed: true };
  }
  if (nested && data.hooks !== undefined && (!data.hooks || typeof data.hooks !== "object" || Array.isArray(data.hooks))) {
    return { runtime, target: file, skipped: "hooks 값이 객체가 아니라 건드리지 않음", changed: true };
  }
  const owner = nested ? (data.hooks || (data.hooks = {})) : data;
  const events = ["SessionStart", "UserPromptSubmit"];
  for (const event of events) {
    if (owner[event] !== undefined && !Array.isArray(owner[event])) {
      return { runtime, target: file, skipped: `${event} 값이 배열이 아니라 건드리지 않음`, changed: true };
    }
  }
  const alreadyManaged = events.some((event) => (owner[event] || []).some(containsHookMarker));
  if (!add && !alreadyManaged) return { runtime, target: file, missing: true, changed: false };
  // Iris가 ID와 기록 경로를 함께 등록한다. 구형 등록기는 공유 데몬의 pane 환경을 그대로 사용한다.
  for (const event of ["SessionStart", "SessionEnd"]) {
    if (!Array.isArray(owner[event])) continue;
    owner[event] = owner[event].map((item) => ({ ...item, hooks: (item.hooks || []).filter((hook) => {
      const command = String(hook.command || "");
      return !(event === "SessionStart" && /^(?:bash|sh)\s+['"]?[^\n]*\/herdr-agent-state\.sh['"]?\s+session$/.test(command))
        && !(event === "SessionEnd" && /^(?:python3|\/usr\/bin\/python3)\s+['"]?[^\n]*\/herdr-session-register\.py['"]?$/.test(command));
    }) })).filter((item) => item.hooks.length);
  }
  for (const event of events) {
    const next = [];
    let placed = false;
    for (const item of owner[event] || []) {
      if (!containsHookMarker(item)) { next.push(item); continue; }
      const hooks = [];
      for (const hook of item.hooks) {
        if (!isManagedHook(hook)) { hooks.push(hook); continue; }
        if (!placed) { hooks.push(hookEntry(command).hooks[0]); placed = true; }
      }
      if (hooks.length) next.push({ ...item, hooks });
    }
    if (!placed) next.push(hookEntry(command));
    owner[event] = next;
  }
  const content = JSON.stringify(data, null, 2) + "\n";
  return { runtime, target: file, previous: created ? null : previous, content, created, changed: created || previous !== content };
}

function installHookTargets(targets) {
  for (const item of targets) {
    if (!item.changed || item.skipped) continue;
    if (!item.created) {
      const backup = item.target + HOOK_BACKUP_SUFFIX;
      try { fs.copyFileSync(item.target, backup, fs.constants.COPYFILE_EXCL); }
      catch (error) { if (error?.code !== "EEXIST") throw error; }
    }
    const temp = `${item.target}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      fs.writeFileSync(temp, item.content, { mode: item.created ? 0o600 : fs.statSync(item.target).mode & 0o777 });
      fs.renameSync(temp, item.target);
    } finally {
      try { fs.unlinkSync(temp); } catch {}
    }
  }
}

export function installAgentContext(options = {}) {
  const suppliedPath = options.appPath || (process.platform === "win32" ? path.join(process.env.LOCALAPPDATA || os.homedir(), "Programs", "Iris") : "/Applications/Iris.app");
  const appPath = path.resolve(process.platform === "win32" && /\.exe$/i.test(suppliedPath) ? path.dirname(suppliedPath) : suppliedPath);
  const codexHome = options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const claudeHome = options.claudeHome || process.env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude");
  const { nodePath, launcherPath, runnerPath } = preflightRuntime(appPath);
  let template;
  try { template = fs.readFileSync(TEMPLATE, "utf8"); }
  catch { throw new Error(`Iris agent context skill template is unavailable: ${TEMPLATE}`); }
  if (!template.includes(MANAGED_MARKER) || !template.includes("{{LAUNCHER}}") || !template.includes("{{RUNNER}}")) {
    throw new Error("Iris agent context skill template is invalid");
  }
  const windows = process.platform === "win32";
  const quote = windows ? (value) => `'${String(value).replaceAll("'", "''")}'` : shellQuote;
  let content = template
    .replace("{{LAUNCHER}}", quote(launcherPath))
    .replace("{{RUNNER}}", quote(runnerPath));
  if (windows) content = content.replaceAll("```sh", "```powershell").replaceAll("Cmd+W", "Ctrl+Shift+W");

  // 두 대상을 모두 검사한 뒤에만 쓰기 시작한다. 한쪽의 사용자 소유 skill 때문에 다른 쪽만
  // 바뀌는 부분 설치를 만들지 않는다.
  const targets = [
    targetInfo(codexHome, content, "Codex"),
    targetInfo(claudeHome, content, "Claude"),
  ];
  const hookTargets = [
    [claudeHome, "Claude", "claude"],
    [codexHome, "Codex", "codex"],
  ].map(([home, label, runtime]) => {
    const command = windows
      ? `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(`$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules'); Remove-Item Env:IRIS_STATE_DIR,Env:IRIS_PORT -ErrorAction SilentlyContinue; $env:IRIS_AGENT_CONTEXT_PROMPT_TARGETS='1'; $env:IRIS_AGENT_CONTEXT_RUNTIME='${runtime}'; $env:ELECTRON_RUN_AS_NODE='1'; & ${quote(nodePath)} ${quote(launcherPath)} prompt-targets --runtime ${runtime}; exit $LASTEXITCODE # ${HOOK_MARKER}`, "utf16le").toString("base64")}`
      : `/usr/bin/env -u IRIS_STATE_DIR -u IRIS_PORT ${HOOK_MARKER} IRIS_AGENT_CONTEXT_RUNTIME=${runtime} ELECTRON_RUN_AS_NODE=1 ${shellQuote(nodePath)} ${shellQuote(launcherPath)} prompt-targets --runtime ${runtime}`;
    return hookTargetInfo(path.join(home, label === "Claude" ? "settings.json" : "hooks.json"), label, command, true, !!options.addHooks);
  });
  if (!options.check) {
    installTargets(targets);
    installHookTargets(hookTargets);
  }
  return {
    launcherPath,
    installed: targets.map((item) => item.target),
    changed: targets.filter((item) => item.changed).map((item) => item.target),
    hooks: hookTargets.map(({ runtime, target, changed, skipped, missing, created }) => ({ runtime, target, changed, skipped, missing, created })),
    hookChanged: hookTargets.filter((item) => item.changed).map((item) => item.target),
    hookMissing: hookTargets.filter((item) => item.missing).map((item) => item.target),
  };
}

function main() {
  const { values } = parseArgs({ options: {
    app: { type: "string" },
    "codex-home": { type: "string" },
    "claude-home": { type: "string" },
    check: { type: "boolean" },
    hooks: { type: "boolean" },
    "hook-status": { type: "boolean" },
  } });
  const result = installAgentContext({
    appPath: values.app,
    codexHome: values["codex-home"],
    claudeHome: values["claude-home"],
    check: values.check || values["hook-status"],
    addHooks: values.hooks,
  });
  if (values["hook-status"]) {
    console.log(result.hookMissing.length ? "missing" : "present");
    return;
  }
  if (values.check) {
    const current = result.installed.length - result.changed.length;
    console.log(`Agent context guidance check: ${current} up to date, ${result.changed.length} missing or outdated; hooks ${result.hookChanged.length || result.hookMissing.length ? "need update" : "up to date"}`);
    for (const target of result.changed) console.log(`  needs update: ${target}`);
    for (const item of result.hooks) if (item.changed) console.log(`  hook ${item.skipped ? "skipped" : "needs update"}: ${item.target}${item.skipped ? ` (${item.skipped})` : ""}`);
    for (const target of result.hookMissing) console.log(`  hook missing: ${target}`);
    if (result.changed.length || result.hookChanged.length || result.hookMissing.length) process.exitCode = 1;
    return;
  }
  console.log(`Agent context guidance ready: ${result.changed.length} updated, ${result.installed.length} present`);
  for (const item of result.hooks) console.log(`  ${item.runtime} hook: ${item.skipped || (item.missing ? "not installed (run with --hooks)" : item.created ? "created" : item.changed ? "updated" : "present")}`);
  if (process.platform === "win32" && result.hooks.some((item) => item.skipped && item.changed)) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
