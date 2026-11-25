import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { clearLine, createInterface, cursorTo } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import { bindRestoredTerminal } from "./managed-binding.mjs";
import { loadManagedPaseo } from "./managed-paseo-runtime.mjs";

export async function checkManagedRuntime(runtime) {
  const paseo = await loadManagedPaseo(runtime);
  const stateDir = await mkdtemp(join(tmpdir(), "iris-paseo-check-"));
  let host;
  try {
    host = await paseo.open({ http: createServer(), stateDir, provider: "codex" });
    const [agents, workspaces] = await Promise.all([host.client.fetchAgents(), host.client.fetchWorkspaces()]);
    if (agents.entries.length || workspaces.entries.length) throw new Error("A fresh Paseo runtime returned nonempty directories");
    await paseo.checkBuiltinPlugins();
  } finally {
    try { await host?.close(); }
    finally { await rm(stateDir, { recursive: true, force: true }); }
  }
}

const run = promisify(execFile);
const herdr = () => process.env.HERDR_BIN_PATH || "herdr";

function hostOptions(args) {
  const { values } = parseArgs({ args, options: {
    "state-dir": { type: "string" }, socket: { type: "string" }, cwd: { type: "string", default: process.cwd() },
    provider: { type: "string" }, runtime: { type: "string" }, "pane-id": { type: "string" }, "terminal-id": { type: "string" },
  } });
  if (process.platform === "win32") throw new Error("Managed Paseo sessions require Unix domain sockets");
  for (const key of ["state-dir", "socket", "cwd", "runtime"]) {
    if (!values[key] || !isAbsolute(values[key])) throw new Error(`--${key} requires an absolute path`);
  }
  if (Buffer.byteLength(values.socket) >= 104) throw new Error("The managed agent socket path is too long");
  if (!/^[a-z][a-z0-9-]*$/.test(values.provider ?? "")) throw new Error("--provider requires a Paseo provider ID");
  if (!values["pane-id"] || /[\s\x00-\x1f]/.test(values["pane-id"])) throw new Error("--pane-id requires a herdr pane ID");
  return { stateDir: values["state-dir"], socket: values.socket, cwd: values.cwd,
    provider: values.provider, runtime: values.runtime, paneId: values["pane-id"], terminalId: values["terminal-id"] ?? null };
}

async function ensurePrivateDirectory(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const entry = await lstat(dir);
  if (!entry.isDirectory() || entry.uid !== process.getuid() || (entry.mode & 0o077) !== 0) {
    throw new Error(`Managed agents require an owner-only directory: ${dir}`);
  }
}

async function loadIntent(options) {
  const { stateDir, socket, cwd, provider, paneId, terminalId, runtime } = options;
  const file = join(stateDir, "agent-intent.json");
  const identity = { socket, cwd, provider, paneId, terminalId, runtime };
  const temporary = `${file}.${process.pid}`;
  const proposed = { ...identity, agentId: randomUUID() };
  try {
    await writeFile(temporary, JSON.stringify(proposed), { mode: 0o600, flag: "wx" });
    try { await link(temporary, file); return proposed; }
    finally { await unlink(temporary); }
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const intent = JSON.parse(await readFile(file, "utf8"));
  if (Object.entries(identity).some(([key, value]) => intent[key] !== value) || typeof intent.agentId !== "string") {
    throw new Error("The managed agent state belongs to another launch");
  }
  return intent;
}

async function resumeOptions(encoded) {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded ?? "")) throw new Error("Invalid managed Paseo resume state");
  const stateDir = Buffer.from(encoded, "base64url").toString("utf8");
  if (!isAbsolute(stateDir)) throw new Error("Managed Paseo resume state requires an absolute path");
  const intent = JSON.parse(await readFile(join(stateDir, "agent-intent.json"), "utf8"));
  const args = ["--state-dir", stateDir, "--socket", intent.socket, "--cwd", intent.cwd,
    "--provider", intent.provider, "--runtime", intent.runtime, "--pane-id", intent.paneId];
  if (intent.terminalId) args.push("--terminal-id", intent.terminalId);
  return hostOptions(args);
}

async function herdrPanes() {
  const { stdout } = await run(herdr(), ["pane", "list"], { timeout: 1_000 });
  return JSON.parse(stdout).result?.panes ?? [];
}

async function restoredTerminal(intent, previous) {
  const panes = await herdrPanes();
  const pane = panes.find((entry) => entry.pane_id === process.env.HERDR_PANE_ID);
  if (!process.env.HERDR_SOCKET_PATH || !pane?.terminal_id || !pane.cwd || await realpath(pane.cwd) !== intent.cwd) {
    throw new Error("Cannot verify the restored herdr terminal and its working directory");
  }
  if (pane.terminal_id !== previous.terminalId && panes.some((entry) => entry.terminal_id === previous.terminalId)) {
    throw new Error("The previously bound herdr terminal still exists");
  }
  return { paneId: pane.pane_id, terminalId: pane.terminal_id };
}

async function listen(http, socket) {
  await new Promise((accept, reject) => {
    const listening = () => { http.off("error", failed); accept(); };
    const failed = (error) => { http.off("listening", listening); reject(error); };
    http.once("error", failed);
    http.listen(socket, listening);
  });
}

function socketIsIdle(path) {
  return new Promise((resolve) => {
    const attempt = createConnection(path);
    const timer = setTimeout(() => { attempt.destroy(); resolve(false); }, 1_000);
    const done = (idle) => { clearTimeout(timer); attempt.destroy(); resolve(idle); };
    attempt.once("connect", () => done(false));
    attempt.once("error", (error) => done(error.code === "ECONNREFUSED"));
  });
}

function processHasExited(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === "ESRCH"; }
}

async function reclaimSocket(socket, ownerFile) {
  const marker = `${socket}.reclaim`;
  const lock = await open(marker, "wx", 0o600);
  try {
    const owner = JSON.parse(await readFile(ownerFile, "utf8"));
    const socketEntry = await lstat(socket);
    if (owner.socket !== socket || !socketEntry.isSocket() || !processHasExited(owner.pid) ||
      socketEntry.ino !== owner.inode || socketEntry.dev !== owner.device || !await socketIsIdle(socket)) {
      throw new Error(`Cannot establish that the managed socket is stale: ${socket}`);
    }
    const current = await lstat(socket);
    if (current.ino !== socketEntry.ino || current.dev !== socketEntry.dev) throw new Error("Managed socket ownership changed");
    await unlink(socket);
  } finally {
    await lock.close();
    await unlink(marker);
  }
}

async function openSocket(http, { socket, stateDir }) {
  const ownerFile = join(stateDir, "socket-owner.json");
  try { await listen(http, socket); }
  catch (error) {
    if (error.code !== "EADDRINUSE") throw error;
    await reclaimSocket(socket, ownerFile).catch((cause) => {
      throw new Error(`EADDRINUSE: ${cause.message}`, { cause });
    });
    await listen(http, socket);
  }
  const entry = await lstat(socket);
  await publishJson(ownerFile, { socket, pid: process.pid, inode: entry.ino, device: entry.dev });
}

async function publishJson(file, data) {
  const temporary = `${file}.${process.pid}`;
  try {
    await writeFile(temporary, `${JSON.stringify(data)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

async function getPaneAgent(host, intent) {
  const { agentId, provider, cwd } = intent;
  const record = await host.store.get(agentId);
  if (record) {
    if (record.provider !== provider || record.cwd !== cwd) throw new Error("The persisted Paseo agent does not match this pane");
    return host.loadAgent(agentId);
  }
  const existing = await readFile(join(intent.stateDir, "state.json"), "utf8").catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (existing) throw new Error("The pane's Paseo agent record is missing");
  return host.client.createAgent({ agentId, provider, cwd, idempotencyKey: agentId });
}

function paneReporter(intent, agent) {
  const { paneId, agentId, terminalId, stateDir } = intent;
  const resumeState = Buffer.from(stateDir).toString("base64url");
  let previous;
  let sequence = Date.now();
  let pending = Promise.resolve();
  async function report(state) {
    if (state === previous) return;
    let targetPane = paneId;
    if (terminalId) {
      const panes = await herdrPanes();
      targetPane = panes.find((pane) => pane.terminal_id === terminalId)?.pane_id;
      if (!targetPane) throw new Error(`Cannot find herdr terminal ${terminalId}`);
    } else if (process.env.HERDR_PANE_ID !== paneId) {
      throw new Error(`Cannot verify herdr pane ${paneId}`);
    }
    await run(herdr(), ["pane", "report-agent", targetPane, "--source", "iris-paseo",
      "--agent", "iris-paseo", "--state", state, "--agent-session-id", agentId, "--seq", String(++sequence),
      "--", "node", fileURLToPath(import.meta.url), "--resume-state", resumeState], { timeout: 1_000 });
    previous = state;
  }
  return agent.subscribe((event) => {
    if (event.type !== "agent_state") return;
    const current = event.agent;
    const state = current.pendingPermissions.size ? "blocked" : current.lifecycle === "running" ? "working"
      : current.lifecycle === "error" || current.lifecycle === "closed" ? "unknown" : "idle";
    pending = pending.then(() => report(state)).catch((error) => console.error(`Paseo: ${error.message}`));
  }, { agentId });
}

function paneTerminal(host, agentId, stop) {
  if (!process.stdin.isTTY) return () => {};
  const terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: true, prompt: "> " });
  const print = (message) => {
    clearLine(process.stdout, 0);
    cursorTo(process.stdout, 0);
    console.log(message);
    terminal.prompt(true);
  };
  const errors = (error) => print(error.message);
  const unsubscribe = host.agent.subscribe((event) => {
    if (event.type !== "agent_stream") return;
    const stream = event.event;
    if (stream.type === "timeline" && stream.item.type === "assistant_message") print(stream.item.text);
    if (stream.type === "permission_requested") print("Paseo 대화에서 응답이 필요합니다.");
  }, { agentId, replayState: false });
  terminal.on("line", (line) => {
    const prompt = line.trim();
    if (prompt === "/exit") { stop(); return; }
    if (prompt) void host.client.sendAgentMessage(agentId, line).catch(errors);
    terminal.prompt();
  });
  terminal.on("SIGINT", () => { void host.client.cancelAgent(agentId).catch(errors); });
  terminal.on("close", stop);
  terminal.prompt();
  return () => { unsubscribe(); terminal.removeListener("close", stop); terminal.close(); };
}

async function main(args) {
  if (args[0] === "--check-runtime" && args.length === 2 && isAbsolute(args[1])) {
    await checkManagedRuntime(args[1]);
    return;
  }
  const resuming = args[0] === "--resume-state" && args.length === 2;
  const options = resuming ? await resumeOptions(args[1]) : hostOptions(args);
  const cwd = await realpath(options.cwd);
  if (!(await stat(cwd)).isDirectory()) throw new Error("The managed agent cwd must be a directory");
  await ensurePrivateDirectory(options.stateDir);
  await ensurePrivateDirectory(dirname(options.socket));
  const http = createServer((_req, res) => res.writeHead(404).end());
  const startupError = join(options.stateDir, "startup-error.json");
  let host;
  let stopTerminal;
  let unsubscribe;
  let ownsSocket = false;
  let ready = false;
  try {
    const intent = { ...await loadIntent({ ...options, cwd }), stateDir: options.stateDir };
    let binding = { paneId: intent.paneId, terminalId: intent.terminalId };
    if (resuming) {
      const previous = JSON.parse(await readFile(join(options.stateDir, "state.json"), "utf8"));
      if (previous.agentId !== intent.agentId || previous.provider !== intent.provider || previous.paneId !== intent.paneId) {
        throw new Error("Cannot verify the saved Paseo agent identity");
      }
      binding = await restoredTerminal(intent, previous);
    }
    await openSocket(http, options);
    ownsSocket = true;
    await unlink(startupError).catch((error) => { if (error.code !== "ENOENT") throw error; });
    const paseo = await loadManagedPaseo(options.runtime);
    host = await paseo.open({ ...options, http });
    const result = await getPaneAgent(host, intent);
    const workspaceId = result.workspaceId;
    if (!workspaceId || result.id !== intent.agentId) throw new Error("Paseo did not return the pane's agent and workspace IDs");
    await host.store.flush();
    if (binding.terminalId && binding.terminalId !== intent.terminalId) bindRestoredTerminal(options.stateDir, binding.terminalId);
    await publishJson(join(options.stateDir, "state.json"), {
      agentId: intent.agentId, paneId: intent.paneId, provider: intent.provider, workspaceId, serverId: host.serverId,
      terminalId: binding.terminalId,
    });
    ready = true;
    unsubscribe = paneReporter({ ...intent, ...binding }, host.agent);
    console.log(`Paseo · ${intent.provider} · ${intent.agentId}`);
    await new Promise((resolve) => {
      process.once("SIGHUP", resolve);
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
      stopTerminal = paneTerminal(host, intent.agentId, resolve);
    });
  } catch (error) {
    if (ownsSocket && !ready) {
      const message = String(error.message).split("\n", 1)[0].slice(0, 500);
      await publishJson(startupError, { message }).catch((failure) => console.error(`Paseo: ${failure.message}`));
    }
    throw error;
  } finally {
    stopTerminal?.();
    unsubscribe?.();
    try { await host?.close(); }
    finally { await new Promise((resolve) => http.close(resolve)); }
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`Paseo: ${error.message}`);
    process.exitCode = 1;
  });
}
