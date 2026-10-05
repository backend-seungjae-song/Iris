#!/usr/bin/env node
// A separate terminal context has an explicit parent and a single launch receipt.
// The worktree subcommand creates a git worktree and records the calling pane as its creator for the Iris sidebar.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import http from "node:http";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { stateHome } from "../server/state-home.cjs";
import { herdrSession } from "../server/herdr-session.cjs";
import { HerdrClient } from "../server/herdr.js";
import { resolveCodexSession } from "../server/codex-session.js";
import { writeAgentLineage } from "../server/agent-lineage.js";
import { createWorktreeFromCommand } from "../server/worktree-handlers.js";
import { port as irisPort } from "../server/env.cjs";
import { MAX_PROMPT_TARGET_MARKERS } from "../server/prompt-targets.js";
import { validateAgentSessionPath } from "../server/agent-session-path.js";
import { chooseCodexResumePane, chooseHerdrPane, processAncestry } from "./iris-session.mjs";

const run = promisify(execFile);
const MAX_HOOK_INPUT_BYTES = 64 * 1024 * 1024;
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const REASONS = new Set(["independent-work", "independent-review", "separate-evidence", "isolated-trial"]);
const EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

function executable(name, env) {
  for (const dir of [...String(env[process.platform === "win32" ? Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH" : "PATH"] || "").split(path.delimiter), path.join(os.homedir(), ".local", "bin")]) {
    for (const suffix of process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""]) {
      const candidate = path.join(process.platform === "win32" ? dir.replace(/^"|"$/g, "") : dir, name + suffix);
      try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
    }
  }
  throw new Error(`Executable not found: ${name}`);
}

function ancestorPids() {
  const seen = new Set();
  let pid = process.pid;
  while (pid > 1 && !seen.has(pid) && seen.size < 32) {
    seen.add(pid);
    pid = Number(execFileSync("/bin/ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim());
  }
  return seen;
}

function atomicWrite(file, data) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temp, file);
}

async function startHerdr(argv, env) {
  const { stdout } = await run(executable("herdr", env), argv, { env, timeout: 15_000, maxBuffer: 256 << 10 });
  const response = JSON.parse(stdout);
  if (response.error) throw new Error(`herdr creation rejected: ${response.error.code || "unknown"}`);
  return response.result;
}

export async function launchContext(options, deps = {}) {
  const env = deps.env || process.env;
  const client = deps.client || new HerdrClient();
  const socketPath = deps.socketPath || herdrSession().socket;
  const stateDir = deps.stateDir || stateHome();
  const start = deps.start || ((args) => startHerdr(args, env));
  const writeLineage = deps.writeLineage || writeAgentLineage;
  if (!env.HERDR_PANE_ID || !env.HERDR_SOCKET_PATH || path.resolve(env.HERDR_SOCKET_PATH) !== path.resolve(socketPath)) {
    throw new Error("Caller herdr socket does not match this Iris state. Set the correct IRIS_STATE_DIR/IRIS_HERDR_SESSION; no fallback target is used.");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(options.id || "")) throw new Error("--id must be a stable job id (letters, digits, - or _)");
  if (!["codex", "claude"].includes(options.runtime)) throw new Error("--runtime must be codex or claude");
  if (!options.model || !EFFORTS.has(options.effort)) throw new Error("Specify --model and --effort explicitly");
  if (options.runtime === "claude" && !["low", "medium", "high", "xhigh", "max"].includes(options.effort)) throw new Error("Claude effort must be low, medium, high, xhigh or max");
  if (!REASONS.has(options.reason)) throw new Error("Choose --reason independent-work, independent-review, separate-evidence or isolated-trial");
  const cwd = path.resolve(options.cwd || process.cwd());
  if (!fs.statSync(cwd).isDirectory()) throw new Error("--cwd must be a directory");
  const briefFile = path.resolve(options.brief || "");
  if (!fs.statSync(briefFile).isFile() || fs.statSync(briefFile).size > 64 * 1024) throw new Error("--brief must be a file of at most 64 KiB");
  const brief = fs.readFileSync(briefFile, "utf8").trim();
  if (!brief) throw new Error("Brief is empty");
  const parent = await client.paneGet(env.HERDR_PANE_ID);
  if (!parent?.terminal_id || !parent.workspace_id || !["codex", "claude"].includes(parent.agent)) throw new Error("Caller pane is not a live Codex or Claude terminal");
  const info = await client.call("pane.process_info", { pane_id: parent.pane_id });
  const ancestors = deps.ancestors || (process.platform === "win32" ? new Set(await processAncestry()) : ancestorPids());
  if (!(info?.process_info?.foreground_processes || []).some((p) => ancestors.has(p.pid) && [p.name, path.basename(p.argv0 || "")].some((name) => (process.platform === "win32" ? path.win32.basename(name || "").replace(/\.(exe|cmd)$/i, "").toLowerCase() : name) === parent.agent))) {
    throw new Error("Caller process does not belong to the parent runtime pane");
  }
  if (parent.agent === "codex" && env.CODEX_SESSION_ID && env.CODEX_THREAD_ID !== env.CODEX_SESSION_ID) {
    throw new Error("A native subagent has no independent terminal parent; use its native child mechanism");
  }
  const claudeSessionId = env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID;
  if (parent.agent === "claude" && claudeSessionId && parent.agent_session?.value && claudeSessionId !== parent.agent_session.value) {
    throw new Error("Caller Claude session does not match the live parent pane");
  }
  const parentSessionId = parent.agent === "codex" ? env.CODEX_THREAD_ID : claudeSessionId || parent.agent_session?.value;
  if (!parentSessionId) throw new Error("Current parent session id is unavailable");
  const runtimeBin = (deps.executable || executable)(options.runtime, env);
  const name = String(options.name || options.id).trim().slice(0, 120);
  const key = sha(parent.terminal_id + "\n" + options.id);
  const directory = path.join(stateDir, "agent-context", sha(socketPath));
  const file = path.join(directory, key + ".json");
  const signature = sha(JSON.stringify({ runtime: options.runtime, model: options.model, effort: options.effort, reason: options.reason, name, cwd, brief: sha(brief), parentSessionId }));
  if (fs.existsSync(file)) {
    const previous = JSON.parse(fs.readFileSync(file, "utf8"));
    if (previous.signature !== signature) throw new Error("This job id already has different inputs; use a new job id for a different task");
    if (previous.status !== "launched") throw new Error(`Previous launch is ${previous.status}; reconcile its receipt before doing anything else: ${file}`);
    return { ...previous, receipt: file, reused: true };
  }
  const childSessionId = options.runtime === "claude" ? crypto.randomUUID() : undefined;
  const command = options.runtime === "codex"
    ? [runtimeBin, "--no-daemon", "--model", options.model, "--config", `model_reasoning_effort=${JSON.stringify(options.effort)}`, brief]
    : [runtimeBin, "--model", options.model, "--effort", options.effort, "--session-id", childSessionId, brief];
  const args = ["agent", "start", name, "--workspace", parent.workspace_id, "--cwd", cwd, "--no-focus", "--", ...command];
  const record = { version: 1, id: options.id, signature, status: "launching", createdAt: new Date().toISOString(), socketPath,
    parent: { paneId: parent.pane_id, terminalId: parent.terminal_id, sessionId: parentSessionId, runtime: parent.agent },
    reason: options.reason, label: name, briefFile, briefSha256: sha(brief), runtime: options.runtime, model: options.model, effort: options.effort };
  if (options.dryRun) return { ...record, status: "preview", receipt: file };
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Claim before the side effect. An unknown response never causes a second spawn.
  fs.writeFileSync(file, JSON.stringify(record) + "\n", { flag: "wx", mode: 0o600 });
  let spawned;
  try {
    spawned = await start(args);
    const child = spawned?.agent;
    if (!child?.pane_id || !child.terminal_id || child.workspace_id !== parent.workspace_id) throw new Error("Creation receipt lacks the expected child identity");
    record.child = { paneId: child.pane_id, terminalId: child.terminal_id, runtime: options.runtime, ...(childSessionId ? { sessionId: childSessionId } : {}) };
    // Persist creation before lineage registration so a registration failure is recoverable.
    record.status = "created";
    atomicWrite(file, record);
    if (options.runtime === "codex") {
      const resolveSession = deps.resolveSession || resolveCodexSession;
      const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
      let identity;
      for (let attempt = 0; attempt < 8; attempt++) {
        identity = await resolveSession(client, child.pane_id);
        if (identity?.uuid) break;
        if (attempt < 7) await sleep(500);
      }
      if (!identity?.uuid) throw new Error("Child Codex session identity is not ready; retain the created pane and reconcile the receipt");
      record.child.sessionId = identity.uuid;
      atomicWrite(file, record);
    }
    const currentParent = await client.paneGet(parent.pane_id);
    if (currentParent.terminal_id !== parent.terminal_id) throw new Error("Parent identity changed during creation");
    record.lineageFile = writeLineage({ version: 1, socketPath, parent: record.parent, child: record.child,
      createdAt: record.createdAt, reason: record.reason, label: name }, { stateDir, socketPath });
    record.status = "launched";
    atomicWrite(file, record);
    return { ...record, receipt: file, reused: false };
  } catch (error) {
    record.status = record.child ? "created_unlinked" : "uncertain";
    record.error = error.message;
    atomicWrite(file, record);
    throw new Error(`Launch ${record.status}; inspect ${file}. Do not relaunch blindly. ${error.message}`);
  }
}

// The creating session is recorded only when this process provably runs inside the caller's herdr pane
// of this Iris state; otherwise the worktree is still created and the sidebar shows the creator as unknown.
async function callerSession(env, deps) {
  if (!env.HERDR_PANE_ID) return { session: null, note: "Not inside a herdr pane; the creating session was not recorded." };
  const socketPath = deps.socketPath || herdrSession().socket;
  if (!env.HERDR_SOCKET_PATH || path.resolve(env.HERDR_SOCKET_PATH) !== path.resolve(socketPath)) {
    return { session: null, note: "The caller's herdr socket is not this Iris state's session; the creating session was not recorded." };
  }
  const client = deps.client || new HerdrClient();
  try {
    const pane = await client.paneGet(env.HERDR_PANE_ID);
    const info = await client.call("pane.process_info", { pane_id: pane?.pane_id });
    const ancestors = deps.ancestors || (process.platform === "win32" ? new Set(await processAncestry()) : ancestorPids());
    if (!pane?.terminal_id || !pane.workspace_id || !ancestors.has(info?.process_info?.shell_pid)) {
      return { session: null, note: "This process does not belong to the pane named by HERDR_PANE_ID; the creating session was not recorded." };
    }
    let label = null;
    try { label = (await client.tabList(pane.workspace_id)).find((tab) => tab.tab_id === pane.tab_id)?.label || null; } catch {}
    return { session: { paneId: pane.pane_id, terminalId: pane.terminal_id, workspaceId: pane.workspace_id,
      agent: pane.agent || null, sessionId: pane.agent_session?.value || null, label } };
  } catch {
    return { session: null, note: "herdr pane information is unavailable; the creating session was not recorded." };
  }
}

export async function createWorktree(options, deps = {}) {
  const env = deps.env || process.env;
  const repo = path.resolve(options.repo || process.cwd());
  const name = String(options.name || "").trim();
  if (!name) throw new Error("--name is required (letters or digits first, then letters, digits, . _ -)");
  const branch = String(options.branch || `feat/${name}`).trim();
  let base = String(options.base || "").trim();
  if (!base) {
    base = execFileSync("git", ["-C", repo, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
    if (!base || base === "HEAD") throw new Error("The current checkout has no branch; pass --base BRANCH");
  }
  const { session, note } = await callerSession(env, deps);
  const made = await (deps.create || createWorktreeFromCommand)({ repo, name, branch, base, session });
  if (!made.recorded) throw new Error(`Worktree created at ${made.path} but its creator record could not be saved`);
  return { path: made.path, branch: made.branch, base: made.base, primary: made.primary,
    creator: session ? { paneId: session.paneId, workspaceId: session.workspaceId, agent: session.agent } : null, ...(note ? { note } : {}) };
}

export function extractPromptTargetMarkers(prompt) {
  const text = String(prompt || "");
  const matches = [];
  const pattern = /@device:[A-Za-z0-9][A-Za-z0-9._:-]*~[A-Za-z0-9_-]{8,128}|@[A-Za-z0-9._-]+-(?:tab|group)-[A-Za-z][0-9A-Fa-f]{5}~[A-Za-z0-9_-]{8,128}/g;
  for (const match of text.matchAll(pattern)) {
    if (!matches.includes(match[0])) matches.push(match[0]);
    // 상한을 넘긴 사실까지 서버에 보내야 요청 전체가 거절된다. 앞부분만 적용하면 뒤 nonce가 재사용된다.
    if (matches.length > MAX_PROMPT_TARGET_MARKERS) break;
  }
  return matches;
}

function readHookInput(input = process.stdin) {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    input.setEncoding("utf8");
    input.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk, "utf8");
      body += chunk;
      if (bytes > MAX_HOOK_INPUT_BYTES) reject(new Error("훅 입력이 너무 큽니다"));
    });
    input.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); }
      catch { reject(new Error("훅 입력 JSON을 읽지 못했습니다")); }
    });
    input.on("error", reject);
  });
}

async function promptPane(hook, deps = {}) {
  const env = deps.env || process.env;
  const envPane = env.IRIS_SESSION || env.HERDR_PANE_ID;
  if (envPane && await processInPane(envPane, deps)) return envPane;
  const sessionId = String(hook?.session_id || "");
  if (!sessionId) return null;
  const client = deps.client || new HerdrClient();
  try {
    const agents = await Promise.race([
      client.agentList(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("session lookup timeout")), 250)),
    ]);
    const runtime = deps.runtime || env.IRIS_AGENT_CONTEXT_RUNTIME;
    const hits = agents.filter((agent) => (!runtime || agent.agent === runtime)
      && [agent?.agent_session?.value, agent?.session_id].includes(sessionId));
    if (hits.length) return hits.length === 1 ? String(hits[0].pane_id || "") || null : null;
    if (runtime !== "codex") return null;
    const infos = await Promise.race([
      Promise.all(agents.map((agent) => client.call("pane.process_info", { pane_id: agent.pane_id }).catch(() => null))),
      new Promise((_, reject) => setTimeout(() => reject(new Error("process lookup timeout")), 750)),
    ]);
    const resumed = chooseCodexResumePane(agents, infos, sessionId);
    if (resumed) return resumed;
    const lineage = await (deps.ancestry || processAncestry)();
    return chooseHerdrPane(agents.filter((agent) => agent.agent === runtime),
      infos.filter((_, i) => agents[i].agent === runtime), lineage);
  } catch { return null; }
}

// 환경 변수 pane 확인. 공용 Codex 데몬의 hook 은 데몬을 처음 띄운 pane 의 HERDR_PANE_ID 를 물려받음
async function processInPane(pane, deps = {}) {
  if (deps.ownsPane) return deps.ownsPane(pane);
  const client = deps.client || new HerdrClient();
  try {
    const info = await Promise.race([
      client.call("pane.process_info", { pane_id: pane }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("pane lookup timeout")), 250)),
    ]);
    return (process.platform === "win32" ? new Set(await processAncestry()) : ancestorPids()).has(info?.process_info?.shell_pid);
  } catch { return false; }
}

function callPromptTargets(markers, session, agentSession, deps = {}, registerOnly = false) {
  if (deps.call) return deps.call(markers, session, agentSession, { registerOnly });
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ cmd: "prompt-targets", args: { markers, registerOnly, ...(agentSession ? { agentSession } : {}) }, session });
    const req = http.request({ host: "127.0.0.1", port: irisPort(), path: "/browser-cmd", method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error("서버 응답을 읽지 못했습니다")); }
      });
    });
    req.setTimeout(1100, () => req.destroy(new Error("서버 응답 시간 초과")));
    req.on("error", reject);
    req.end(payload);
  });
}

async function reportHerdrSession(agentSession, hook, deps = {}) {
  if (!agentSession || !hook?.session_id) return;
  if (deps.reportHerdr) return deps.reportHerdr(agentSession, hook);
  const env = deps.env || process.env;
  const command = env.HERDR_BIN_PATH || executable("herdr", env);
  const args = ["pane", "report-agent-session", agentSession.paneId,
    "--source", `herdr:${agentSession.agent}`, "--agent", agentSession.agent,
    "--agent-session-id", agentSession.sessionId];
  if (agentSession.transcriptPath) args.push("--agent-session-path", agentSession.transcriptPath);
  if (typeof hook.source === "string" && hook.source) args.push("--session-start-source", hook.source);
  await run(command, args, { env, timeout: 1000, maxBuffer: 256 << 10 });
}

function hookAgentSession(hook, pane, runtime, deps = {}) {
  if (!pane || !["claude", "codex"].includes(runtime) || hook?.agent_id || hook?.is_subagent) return null;
  const sessionId = String(hook?.session_id || "");
  if (!sessionId || sessionId.length > 512 || /[\x00-\x1f\x7f]/.test(sessionId)) return null;
  const transcriptPath = validateAgentSessionPath(runtime, hook?.transcript_path, deps.pathOptions);
  if (String(hook?.transcript_path || "").split(path.sep).includes("subagents")) return null;
  // SessionStart는 기록 파일을 만들기 전에 올 수 있다. ID 등록은 파일 생성과 분리한다.
  return { paneId: pane, agent: runtime, sessionId, ...(transcriptPath ? { transcriptPath } : {}) };
}

function promptTargetSummary(data) {
  const activated = Array.isArray(data?.activated) ? data.activated : [];
  const rejected = Array.isArray(data?.rejected) ? data.rejected : [];
  const parts = activated.map((record) => {
    if (record.kind === "device") return `기기 ${record.label || record.target?.udid}(${record.target?.udid})`;
    const label = record.kind === "element" ? "요소" : record.kind === "group" ? "그룹" : "탭";
    return `${label} ${record.ref}`;
  });
  const lines = [];
  if (parts.length) lines.push(`지목 등록: ${parts.join(" · ")}`);
  const devices = [...new Set(activated.filter((record) => record.kind === "device").map((record) => record.target?.udid).filter(Boolean))];
  if (devices.length > 1) lines.push(`등록 기기가 ${devices.length}대라 app_* 도구에는 device를 적으세요.`);
  if (rejected.length) {
    const counts = new Map();
    for (const item of rejected) counts.set(item.reason || "알 수 없는 이유", (counts.get(item.reason || "알 수 없는 이유") || 0) + 1);
    lines.push(`지목 구분자 ${rejected.length}개 거절: ${[...counts].map(([reason, count]) => `${reason} ${count}`).join(" · ")}`);
  }
  return lines.join("\n");
}

export async function submitPromptTargets(hook, deps = {}) {
  const markers = extractPromptTargetMarkers(hook?.prompt);
  const runtime = String(deps.runtime || deps.env?.IRIS_AGENT_CONTEXT_RUNTIME || process.env.IRIS_AGENT_CONTEXT_RUNTIME || "").toLowerCase();
  try {
    if (hook?.agent_id || hook?.is_subagent) return "";
    const pane = await promptPane(hook, { ...deps, runtime });
    if (!pane) return markers.length ? "지목 등록 실패: 이 프롬프트의 Iris pane을 확인하지 못했습니다." : "";
    const agentSession = hookAgentSession(hook, pane, runtime, deps);
    try { await reportHerdrSession(agentSession, hook, deps); } catch {}
    const registerOnly = hook?.hook_event_name === "SessionStart" || !Object.hasOwn(hook || {}, "prompt");
    const result = await callPromptTargets(markers, pane, agentSession?.transcriptPath ? agentSession : null, deps, registerOnly);
    if (!result?.ok) return `지목 등록 실패: ${result?.error || "Iris 서버가 요청을 거절했습니다."}`;
    return markers.length ? promptTargetSummary(result.data) : "";
  } catch (error) {
    return markers.length ? `지목 등록 실패: ${String(error?.message || error)}` : "";
  }
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    id: { type: "string" }, runtime: { type: "string" }, model: { type: "string" }, effort: { type: "string" },
    reason: { type: "string" }, brief: { type: "string" }, cwd: { type: "string" }, name: { type: "string" },
    repo: { type: "string" }, base: { type: "string" }, branch: { type: "string" },
    "dry-run": { type: "boolean" }, help: { type: "boolean" },
  } });
  if (values.help) {
    console.log("pnpm agent:context launch --id JOB --runtime codex|claude --model MODEL --effort LEVEL --reason independent-work|independent-review|separate-evidence|isolated-trial --brief FILE [--cwd DIR] [--name NAME] [--dry-run]");
    console.log("pnpm agent:context worktree --name NAME [--repo DIR] [--base BRANCH] [--branch BRANCH]");
    return;
  }
  if (positionals.length === 1 && positionals[0] === "prompt-targets") {
    const output = await submitPromptTargets(await readHookInput(), { runtime: values.runtime });
    if (output) process.stdout.write(output + "\n", () => process.exit(0));
    else process.exit(0);
    return;
  }
  if (positionals.length === 1 && positionals[0] === "worktree") {
    const result = JSON.stringify(await createWorktree(values), null, 2) + "\n";
    // HerdrClient keeps a 5 s timeout timer per call; exit once the answer is flushed instead of waiting for it.
    process.stdout.write(result, () => process.exit(0));
    return;
  }
  if (positionals.length !== 1 || positionals[0] !== "launch") throw new Error("Expected launch, worktree or prompt-targets; use --help for the contract");
  console.log(JSON.stringify(await launchContext({ ...values, dryRun: values["dry-run"] }), null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    if (process.argv.includes("prompt-targets")) {
      process.stdout.write(`지목 등록 실패: ${error.message}\n`, () => process.exit(0));
      return;
    }
    console.error(error.message); process.exitCode = 1;
  });
}
