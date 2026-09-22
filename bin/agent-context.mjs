#!/usr/bin/env node
// A separate terminal context has an explicit parent and a single launch receipt.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { stateHome } from "../server/state-home.cjs";
import { herdrSession } from "../server/herdr-session.cjs";
import { HerdrClient } from "../server/herdr.js";
import { resolveCodexSession } from "../server/codex-session.js";
import { writeAgentLineage } from "../server/agent-lineage.js";

const run = promisify(execFile);
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const REASONS = new Set(["independent-work", "independent-review", "separate-evidence", "isolated-trial"]);
const EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

function executable(name, env) {
  for (const dir of [...String(env.PATH || "").split(path.delimiter), path.join(os.homedir(), ".local", "bin")]) {
    const candidate = path.join(dir, name);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
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
  const ancestors = deps.ancestors || ancestorPids();
  if (!(info?.process_info?.foreground_processes || []).some((p) => ancestors.has(p.pid) && [p.name, path.basename(p.argv0 || "")].includes(parent.agent))) {
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
    ? [runtimeBin, "--model", options.model, "--config", `model_reasoning_effort=${JSON.stringify(options.effort)}`, brief]
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

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    id: { type: "string" }, runtime: { type: "string" }, model: { type: "string" }, effort: { type: "string" },
    reason: { type: "string" }, brief: { type: "string" }, cwd: { type: "string" }, name: { type: "string" },
    "dry-run": { type: "boolean" }, help: { type: "boolean" },
  } });
  if (values.help) {
    console.log("pnpm agent:context launch --id JOB --runtime codex|claude --model MODEL --effort LEVEL --reason independent-work|independent-review|separate-evidence|isolated-trial --brief FILE [--cwd DIR] [--name NAME] [--dry-run]");
    return;
  }
  if (positionals.length !== 1 || positionals[0] !== "launch") throw new Error("Expected launch; use --help for the contract");
  console.log(JSON.stringify(await launchContext({ ...values, dryRun: values["dry-run"] }), null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
