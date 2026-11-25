import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { stateHome } from "../state-home.cjs";
import { codexHome } from "../agent-homes.js";
import { connectCodexSocket } from "./codex-shared-transport.mjs";

const run = promisify(execFile);
const starting = new Map();
const startupGraceMs = 30_000;
const titleCache = new Map();
let reaping;
const threadIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function defaultCodexSocket() {
  return codexHome("app-server-control", "app-server-control.sock");
}

function paneSocketPath(socketPath) {
  if (typeof socketPath !== "string" || path.basename(socketPath) !== "control.sock") return false;
  const dir = path.dirname(socketPath);
  return path.dirname(dir) === "/tmp" && new RegExp(`^codex-pane-${process.getuid?.()}-[a-zA-Z0-9_]{8}$`).test(path.basename(dir));
}

async function privatePaneSocket(socketPath) {
  if (!paneSocketPath(socketPath)) return false;
  try {
    const dir = await lstat(path.dirname(socketPath));
    if (!dir.isDirectory() || dir.uid !== process.getuid() || (dir.mode & 0o077)) return false;
    const target = await realpath(socketPath);
    const advertised = path.join(await realpath(path.dirname(socketPath)), path.basename(socketPath));
    if (target !== advertised) {
      const physicalDir = path.join(await realpath("/tmp"), `codex-daemon-${dir.uid}`);
      const physical = await lstat(physicalDir);
      if (!physical.isDirectory() || physical.uid !== dir.uid || (physical.mode & 0o077)) return false;
      const digest = createHash("sha256").update(advertised).digest("hex");
      if (target !== path.join(physicalDir, digest)) return false;
    }
    const socket = await lstat(target);
    return socket.isSocket() && socket.uid === dir.uid;
  } catch { return false; }
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

function socketFor(id) {
  return path.join("/tmp", `iris-codex-${process.getuid()}`, `${id}.sock`);
}

function leasesDir() {
  return path.join(stateHome(), "paseo-ui", "codex-native");
}

function bindingPath(terminalId) { return path.join(leasesDir(), `${hash(terminalId)}.json`); }
function ownerPath(id) { return path.join(leasesDir(), `${id}.pid`); }

async function readOptional(file) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function storeRecord(file, record) {
  const temporary = `${file}.${randomUUID()}.new`;
  await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
  await rename(temporary, file);
}

function sameBinding(left, right) {
  if (!left || !right) return false;
  return ["terminalId", "id", "socketPath", "ownerManaged", "threadId", "cwd", "paneId", "workspaceId"]
    .every(key => (left[key] ?? null) === (right[key] ?? null));
}

async function storeBinding(file, binding) {
  const previous = await readOptional(file);
  if (!sameBinding(previous, binding)) await storeRecord(file, binding);
}

async function privateDirectory(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error("Codex 소켓 폴더 권한을 확인하세요");
}

function sameOwner(left, right) {
  if (!left || !right || left.id !== right.id || left.pid !== right.pid) return false;
  if (left.token || right.token) return left.token === right.token;
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSocket(info, owner) {
  return info?.isSocket() && info.dev === owner.dev && info.ino === owner.ino;
}

function sameFile(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

async function withSocket(socketPath, action) {
  const socket = connectCodexSocket(socketPath);
  try {
    await once(socket, "open");
    socket.on("error", () => {});
    return await action(socket);
  } finally { socket.close(); }
}

function ready(socketPath, timeoutMs = 5_000) {
  let timer;
  return Promise.race([
    withSocket(socketPath, () => true),
    new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
  ]).catch(() => false).finally(() => clearTimeout(timer));
}

export function startSharedCodex(socketPath, cwd, id, command, options) {
  if (starting.has(id)) return starting.get(id);
  const activeReap = reaping;
  const promise = (async () => {
    if (activeReap) await activeReap;
    return startSharedCodexOnce(socketPath, cwd, id, command, options);
  })();
  const tracked = promise.finally(() => {
    if (starting.get(id) === tracked) starting.delete(id);
  });
  starting.set(id, tracked);
  return tracked;
}

async function startSharedCodexOnce(socketPath, cwd, id, command, { timeoutMs = 8_000 } = {}) {
  await privateDirectory(path.dirname(socketPath));
  await mkdir(leasesDir(), { recursive: true, mode: 0o700 });
  if (await ready(socketPath, timeoutMs)) return readOptional(ownerPath(id));
  const initialSocket = await stat(socketPath).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  let knownSocket = initialSocket && { dev: initialSocket.dev, ino: initialSocket.ino };
  const child = spawn(command, ["app-server", "--listen", `unix://${socketPath}`], { cwd, detached: true, stdio: "ignore" });
  let failure;
  const token = randomUUID();
  child.once("error", (error) => { failure = error; });
  try {
    await storeRecord(ownerPath(id), { id, pid: child.pid, token });
    child.unref();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await ready(socketPath, Math.max(1, Math.min(5_000, deadline - Date.now())))) {
        if (child.pid && child.exitCode === null && child.signalCode === null) {
          const { dev, ino } = await stat(socketPath);
          await storeRecord(ownerPath(id), { id, pid: child.pid, dev, ino, token });
          return { id, pid: child.pid, dev, ino, token };
        }
        return readOptional(ownerPath(id));
      }
      if (failure) throw failure;
      if (child.exitCode !== null) break;
      await delay(Math.min(100, Math.max(1, deadline - Date.now())));
    }
    throw new Error("Codex 공유 서버에 연결할 수 없습니다");
  } catch (error) {
    let cleanupError;
    try { await stopDetachedChild(child); }
    catch (failure) { cleanupError = failure; }
    const currentSocket = await stat(socketPath).catch(failure => {
      if (failure.code === "ENOENT") return null;
      cleanupError ??= failure;
      return null;
    });
    if (knownSocket && currentSocket && sameFile(currentSocket, knownSocket)) {
      try { await unlink(socketPath); }
      catch (failure) { if (failure.code !== "ENOENT") cleanupError ??= failure; }
    }
    const currentOwner = await readOptional(ownerPath(id));
    if (sameOwner(currentOwner, { id, pid: child.pid, token })) {
      try { await unlink(ownerPath(id)); }
      catch (failure) { if (failure.code !== "ENOENT") cleanupError ??= failure; }
    }
    if (cleanupError) throw new AggregateError([error, cleanupError], "Codex 공유 서버 시작 실패를 정리하지 못했습니다");
    throw error;
  }
}

async function stopDetachedChild(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill("SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  await Promise.race([once(child, "exit"), delay(500)]);
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill("SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    if (child.exitCode === null && child.signalCode === null) await Promise.race([once(child, "exit"), delay(500)]);
  }
}

export async function withSharedCodexRpc(socketPath, action) {
  return withSocket(socketPath, async (ws) => {
    let sequence = 0;
    const request = (method, params) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const finished = () => {
        clearTimeout(timer);
        ws.off("message", response);
        ws.off("close", closed);
      };
      const closed = () => { finished(); reject(new Error("Codex 공유 서버 연결이 끊겼습니다")); };
      const response = (data) => {
        let message;
        try { message = JSON.parse(data); } catch { return; }
        if (message.id !== id) return;
        finished();
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      };
      const timer = setTimeout(closed, 5000);
      ws.on("message", response);
      ws.once("close", closed);
      try { ws.send(JSON.stringify({ id, method, params })); }
      catch (error) { finished(); reject(error); }
    });
    await request("initialize", { clientInfo: { name: "iris", version: "1" }, capabilities: { experimentalApi: true } });
    ws.send(JSON.stringify({ method: "initialized" }));
    return action(request);
  });
}

export async function sharedCodexPane(terminalId) {
  if (typeof terminalId !== "string" || !terminalId) return null;
  const binding = await readOptional(bindingPath(terminalId));
  if (binding?.terminalId !== terminalId || typeof binding.cwd !== "string") return null;
  if (binding.ownerManaged !== true && binding.id == null && (binding.socketPath === defaultCodexSocket() || await privatePaneSocket(binding.socketPath))) return binding;
  if (!/^[a-f0-9]{24}$/.test(binding.id) || binding.socketPath !== socketFor(binding.id)) return null;
  return { ...binding, socketPath: socketFor(binding.id) };
}

function processInfoRecords(processInfo) {
  const info = processInfo?.process_info || processInfo || {};
  return Array.isArray(info.foreground_processes) ? info.foreground_processes : [];
}

function isCodexProcess(record) {
  return [record?.name, record?.argv0, record?.argv?.[0]].some(value =>
    typeof value === "string" && /(?:^|[\\/])codex(?:\.exe|\.cmd|\.bat)?$/i.test(value));
}

function nativeRemote(record) {
  if (!isCodexProcess(record) || !Array.isArray(record.argv)) return null;
  const argv = record.argv.map(String);
  if (argv.some(arg => ["app-server", "exec", "mcp", "completion", "--no-daemon"].includes(arg))) return null;
  let remote;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--remote") remote = argv[i + 1];
    else if (argv[i].startsWith("--remote=")) remote = argv[i].slice("--remote=".length);
  }
  let socketPath;
  let ownerManaged = false;
  if (remote == null) socketPath = defaultCodexSocket();
  else {
    if (!remote.startsWith("unix://")) return null;
    socketPath = remote.slice("unix://".length).replace(/\/$/, "") || defaultCodexSocket();
    if (socketPath !== defaultCodexSocket() && !paneSocketPath(socketPath)) {
      const id = path.basename(socketPath, ".sock");
      if (!/^[a-f0-9]{24}$/i.test(id) || socketFor(id) !== socketPath) return null;
      ownerManaged = true;
    }
  }
  const resumeIndex = argv.indexOf("resume");
  const threadId = resumeIndex >= 0 && threadIdPattern.test(argv[resumeIndex + 1] || "") ? argv[resumeIndex + 1] : null;
  return { id: ownerManaged ? path.basename(socketPath, ".sock") : null, socketPath, threadId, ownerManaged };
}

async function sameCwd(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  try { return await realpath(left) === await realpath(right); }
  catch { return false; }
}

async function exactLoadedThread(request, { cwd, threadId, rawTitle, threadSource = "pane", diagnostic }) {
  const identity = codexTerminalTitleIdentity(rawTitle);
  const loaded = await loadedCodexThreads(request);
  const candidates = identity
    ? loaded.filter(id => id.toLowerCase().startsWith(identity))
    : threadSource === "private-pane" && !threadId && loaded.length === 1 ? loaded
    : threadId && (threadSource === "process" || threadSource === "binding" || threadSource === "private-pane" || loaded.length === 1)
      ? loaded.filter(id => id === threadId)
      : [];
  if (!candidates.length) {
    if (diagnostic) diagnostic.status = loaded.length ? "ambiguous" : "not-loaded";
    return null;
  }
  const matches = [];
  for (const id of candidates) {
    const result = await request("thread/read", { threadId: id, includeTurns: false });
    const thread = result?.thread;
    if (thread?.id !== id || !(await sameCwd(thread.cwd, cwd))) continue;
    matches.push(thread);
  }
  if (matches.length !== 1 && diagnostic) diagnostic.status = "ambiguous";
  return matches.length === 1 ? matches[0] : null;
}

export async function discoverSharedCodexForPane({ terminalId, cwd, threadId, rawTitle, processInfo, paneId, workspaceId, diagnostic } = {}) {
  if (typeof terminalId !== "string" || !terminalId || typeof cwd !== "string" || !path.isAbsolute(cwd)) return null;
  const records = processInfoRecords(processInfo);
  const remote = records.map(nativeRemote).find(Boolean);
  if (!remote) {
    if (diagnostic) diagnostic.status = records.some(isCodexProcess) && records.some(record => Array.isArray(record?.argv) && record.argv.map(String).includes("--no-daemon")) ? "no-daemon" : "unsupported";
    return null;
  }
  const privatePane = paneSocketPath(remote.socketPath);
  if (privatePane && !await privatePaneSocket(remote.socketPath)) return null;
  const titleIdentity = codexTerminalTitleIdentity(rawTitle);
  const selectedThreadId = titleIdentity ? null : remote.threadId || threadId;
  const threadSource = titleIdentity ? "title" : remote.threadId ? "process" : privatePane ? "private-pane" : threadId ? "pane" : null;
  if (!selectedThreadId && !titleIdentity && !privatePane) return null;
  if (remote.ownerManaged) {
    const owner = await readOptional(ownerPath(remote.id));
    if (owner?.id !== remote.id || !Number.isSafeInteger(owner.pid) || owner.pid < 2) {
      if (diagnostic) diagnostic.status = "transport-unavailable";
      return null;
    }
  }
  if (diagnostic) diagnostic.status = "transport-unavailable";
  let selected;
  try {
    selected = await withSharedCodexRpc(remote.socketPath, request => exactLoadedThread(request, {
      cwd, threadId: selectedThreadId, rawTitle, threadSource, diagnostic,
    }));
  } catch {
    return null;
  }
  if (!selected) return null;
  const canonicalCwd = await realpath(cwd).catch(() => cwd);
  const binding = { terminalId, id: remote.id, socketPath: remote.socketPath, ownerManaged: remote.ownerManaged,
    threadId: selected.id, cwd: canonicalCwd,
    ...(typeof paneId === "string" && paneId ? { paneId } : {}),
    ...(typeof workspaceId === "string" && workspaceId ? { workspaceId } : {}),
    boundAt: Date.now() };
  await mkdir(leasesDir(), { recursive: true, mode: 0o700 });
  await storeBinding(bindingPath(terminalId), binding);
  if (diagnostic) diagnostic.status = "bound";
  return { ...binding, socketPath: remote.socketPath };
}

export function codexTerminalTitleIdentity(title) {
  if (typeof title !== "string") return null;
  const identities = [...new Set([...title.matchAll(/(?:^|\s)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{5})(?:([0-9a-f]{7})|\.\.\.)(?=\s|$)/gi)]
    .map(([, prefix, tail]) => (prefix + (tail ?? "")).toLowerCase()))];
  return identities.length === 1 ? identities[0] : null;
}

export function codexTerminalTitleMatches(title, threadId) {
  const identity = codexTerminalTitleIdentity(title);
  return !!identity && typeof threadId === "string" && threadId.toLowerCase().startsWith(identity);
}

export async function matchSharedCodexTitle(request, rawTitle) {
  const identity = codexTerminalTitleIdentity(rawTitle);
  if (!identity) return null;
  const matching = (await loadedCodexThreads(request)).filter(id => id.toLowerCase().startsWith(identity));
  return matching.length === 1 ? matching[0] : null;
}

export async function selectSharedCodexThread(binding, rawTitle) {
  const identity = codexTerminalTitleIdentity(rawTitle);
  if (!identity) return null;
  const key = `${binding.socketPath}:${identity}`;
  const now = Date.now();
  const entry = titleCache.get(key);
  if (entry?.expiresAt > now) return entry.result;
  if (titleCache.size >= 128) titleCache.delete(titleCache.keys().next().value);
  const result = withSharedCodexRpc(binding.socketPath, request => matchSharedCodexTitle(request, rawTitle)).catch(() => null);
  titleCache.set(key, { expiresAt: now + 1_000, result });
  return result;
}

export async function sharedCodexForPane(terminalId, threadId, rawTitle) {
  const binding = await sharedCodexPane(terminalId);
  if (!binding || !threadIdPattern.test(threadId ?? "") || binding.threadId !== threadId || typeof binding.cwd !== "string") return null;
  const selected = await withSharedCodexRpc(binding.socketPath, request => exactLoadedThread(request, {
    cwd: binding.cwd, threadId, rawTitle, threadSource: "binding",
  })).catch(() => null);
  return selected ? { ...binding, threadId: selected.id, cwd: selected.cwd } : null;
}

export async function loadedCodexThreads(rpc) {
  let cursor;
  const ids = [];
  do {
    const result = await rpc("thread/loaded/list", { cursor });
    ids.push(...result.data);
    cursor = result.nextCursor;
  } while (cursor);
  return ids;
}

export function reapSharedCodex() {
  if (process.platform === "win32") return Promise.resolve();
  if (!reaping) reaping = reap().finally(() => { reaping = null; });
  return reaping;
}

async function reap() {
  const dir = leasesDir();
  const files = await readdir(dir).catch(error => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const ownerFiles = files.filter(file => /^[a-f0-9]{24}\.pid$/.test(file));
  if (starting.size) return;
  const leaseFiles = files.filter(file => /^[a-f0-9]{24}\.json$/.test(file));
  if (!ownerFiles.length) {
    await Promise.all(leaseFiles.map(async file => {
      const full = path.join(dir, file);
      const lease = await readOptional(full);
      if (lease?.ownerManaged === false) return;
      await unlink(full).catch(error => { if (error.code !== "ENOENT") throw error; });
    }));
    return;
  }
  const leases = await Promise.all(leaseFiles.map(file => readOptional(path.join(dir, file))));
  for (const file of ownerFiles) {
    const owner = await readOptional(path.join(dir, file));
    if (!owner || file !== `${owner.id}.pid` || !Number.isSafeInteger(owner.pid) || owner.pid < 2 || starting.has(owner.id)) continue;
    if (leases.some(lease => lease?.id === owner.id && Date.now() - lease.launchedAt < startupGraceMs)) continue;
    await reapIdleOwner(owner);
  }
}

async function reapIdleOwner(owner) {
  const socketPath = socketFor(owner.id);
  const url = `unix://${socketPath}`;
  const info = await stat(socketPath).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (!info) {
    if (!await processExists(owner.pid)) await removeStaleOwner(owner, false);
    return;
  }
  if (!owner.dev || !owner.ino || !sameSocket(info, owner)) {
    if (!await processExists(owner.pid)) await removeStaleOwner(owner, false);
    return;
  }
  const processState = await ownerProcessState(owner.pid, url);
  if (!processState.owner) {
    if (!processState.nativeClient) await removeStaleOwner(owner);
    return;
  }
  const safeToStop = await withSharedCodexRpc(socketPath, async (rpc) => {
    for (const threadId of await loadedCodexThreads(rpc)) {
      const { thread } = await rpc("thread/read", { threadId });
      if (thread.status?.type === "active") return false;
    }
    return true;
  }).catch(() => false);
  if (!safeToStop || starting.size || !await hasIdleOwnerProcess(owner.pid, url)) return;
  const current = await stat(socketPath).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (current && sameSocket(current, owner) && !starting.size && await ownerStillMatches(owner)) {
    try { process.kill(owner.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
}

async function hasIdleOwnerProcess(pid, url) {
  const state = await ownerProcessState(pid, url);
  return !state.nativeClient && state.owner;
}

async function ownerProcessState(pid, url) {
  const { stdout } = await run("ps", ["-axww", "-o", "pid=,command="], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
  const commands = stdout.trim().split("\n").map(line => line.trim().match(/^(\d+)\s+(.*)$/)?.slice(1));
  const nativeClient = commands.some(record => record?.[1].split(/\s+/).some((arg, i, argv) =>
    arg === `--remote=${url}` || (arg === "--remote" && argv[i + 1] === url)));
  const ownCommand = commands.find(record => Number(record?.[0]) === pid)?.[1].split(/\s+/);
  const isOwner = ownCommand?.slice(-3).join(" ") === `app-server --listen ${url}`;
  return { nativeClient, owner: isOwner };
}

async function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; if (error.code === "EPERM") return true; throw error; }
}

async function ownerStillMatches(owner) {
  return sameOwner(await readOptional(ownerPath(owner.id)), owner);
}

async function removeStaleOwner(owner, removeSocket = true) {
  if (starting.has(owner.id) || !await ownerStillMatches(owner)) return false;
  if (removeSocket) {
    const current = await stat(socketFor(owner.id)).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (current && (!owner.dev || !owner.ino || !sameSocket(current, owner))) return false;
    if (starting.has(owner.id) || !await ownerStillMatches(owner)) return false;
    if (current) await unlink(socketFor(owner.id));
  }
  const files = await readdir(leasesDir()).catch(error => { if (error.code === "ENOENT") return []; throw error; });
  await Promise.all(files.filter(file => file.endsWith(".json")).map(async file => {
    const full = path.join(leasesDir(), file);
    const lease = await readOptional(full);
    if (lease?.id !== owner.id || !await ownerStillMatches(owner)) return;
    if (lease.ownerToken == null && lease.target != null && !/^[a-f0-9]{24}\.json$/.test(file)) return;
    await unlink(full).catch(error => { if (error.code !== "ENOENT") throw error; });
  }));
  if (!await ownerStillMatches(owner)) return false;
  await unlink(ownerPath(owner.id)).catch(error => { if (error.code !== "ENOENT") throw error; });
  return true;
}
