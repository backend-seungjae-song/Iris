import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import lockfile from "proper-lockfile";
import { stateHome } from "../state-home.cjs";
import { shellCommand } from "../agent-launch.js";
import { nativeHandoffArgs } from "./native-commands.mjs";
import { parseBuildName } from "./plan.js";

const run = promisify(execFile);
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const dispatchedGraceMs = 1_000;

function ownershipPath(stateDir, id) {
  if (!uuid.test(id ?? "")) throw new Error("Paseo 세션 ID가 잘못되었습니다");
  return join(stateDir, "handoffs", `${id}.json`);
}

async function readOwnership(file) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    if (!uuid.test(value.token ?? "") || !["reserved", "dispatched", "running", "exited"].includes(value.phase)) {
      throw new Error("Paseo 전환 상태를 확인할 수 없습니다");
    }
    return value;
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export function readRuntimeHandoff(stateDir, id) {
  return readOwnership(ownershipPath(stateDir, id));
}

export function readEmbeddedHandoff(record) {
  if (!parseBuildName(record.build)) throw new Error("Paseo 릴리스 정보를 확인할 수 없습니다");
  return readRuntimeHandoff(join(stateHome(), "paseo-ui", "sessions", record.build), record.agentId);
}

async function writeOwnership(file, value, reserve = false) {
  const tmp = `${file}.${randomUUID()}.partial`;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  try {
    if (reserve) await link(tmp, file);
    else await rename(tmp, file);
  } finally { await unlink(tmp).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
}

async function withOwnershipLock(file, action) {
  const release = await lockfile.lock(file, { realpath: false, retries: { retries: 20, minTimeout: 5, maxTimeout: 50 } });
  try { return await action(); }
  finally { await release(); }
}

export async function reserveRuntimeHandoff(stateDir, id, owner) {
  const file = ownershipPath(stateDir, id);
  const value = { ...owner, token: randomUUID(), phase: "reserved" };
  await writeOwnership(file, value, true);
  return { ...value, file };
}

export async function clearRuntimeHandoff(stateDir, id, token, phase) {
  const file = ownershipPath(stateDir, id);
  await withOwnershipLock(file, async () => {
    const current = await readOwnership(file);
    if (current?.token !== token || current.phase !== phase) throw new Error("Paseo 전환 상태가 변경되었습니다");
    await unlink(file);
  });
}

async function changeOwnership(file, token, phase, next, changes = {}) {
  return withOwnershipLock(file, async () => {
    const current = await readOwnership(file);
    if (current?.token !== token || current.phase !== phase) throw new Error("Paseo 전환 상태가 변경되었습니다");
    await writeOwnership(file, { ...current, ...changes, phase: next });
    return { ...current, ...changes, phase: next };
  });
}

function explicitMissing(error) {
  return ["NOT_FOUND", "PANE_NOT_FOUND", "TERMINAL_NOT_FOUND"].includes(error?.code);
}

async function paneIsMissing(herdr, paneId, terminalId, error) {
  if (explicitMissing(error)) return true;
  if (typeof herdr.paneList !== "function") return false;
  try {
    const panes = await herdr.paneList();
    return Array.isArray(panes) && panes.every(pane => typeof pane?.terminal_id === "string") &&
      !panes.some(pane => pane.terminal_id === terminalId);
  } catch { return false; }
}

async function inspectShell(herdr, paneId, record) {
  if (process.platform === "win32") return { state: "unknown" };
  let pane;
  try { pane = await herdr.paneGet(paneId); }
  catch (error) { return { state: await paneIsMissing(herdr, paneId, record.terminalId, error) ? "missing" : "unknown" }; }
  if (pane.pane_id !== paneId || pane.terminal_id !== record.terminalId) {
    return { state: await paneIsMissing(herdr, paneId, record.terminalId) ? "missing" : "unknown" };
  }
  let info;
  try { ({ process_info: info } = await herdr.call("pane.process_info", { pane_id: paneId })); }
  catch (error) { return { state: await paneIsMissing(herdr, paneId, record.terminalId, error) ? "missing" : "unknown" }; }
  if (!info?.shell_pid) return { state: "unknown" };
  if (info.foreground_process_group_id !== info.shell_pid) return { state: "busy", shellPid: info.shell_pid };
  const shell = info.foreground_processes?.find(({ pid }) => pid === info.shell_pid);
  if (!shell?.cwd) return { state: "unknown", shellPid: info.shell_pid };
  let cwdMatches = false;
  try { cwdMatches = await realpath(shell.cwd) === await realpath(record.cwd); }
  catch { cwdMatches = false; }
  try {
    const tty = info.tty ? basename(info.tty) : (await run("ps", ["-p", String(info.shell_pid), "-o", "tty="], { timeout: 1_000 })).stdout.trim();
    if (!/^[A-Za-z0-9/_-]+$/.test(tty)) return { state: "unknown", shellPid: info.shell_pid };
    const { stdout } = await run("ps", ["-t", tty, "-o", "pid="], { timeout: 1_000 });
    const processes = stdout.trim().split(/\s+/).map(Number);
    if (processes.length !== 1 || processes[0] !== info.shell_pid) return { state: "busy", shellPid: info.shell_pid };
    try {
      if ((await herdr.paneGet(paneId)).terminal_id !== record.terminalId) {
        return { state: await paneIsMissing(herdr, paneId, record.terminalId) ? "missing" : "unknown", shellPid: info.shell_pid };
      }
    } catch (error) {
      return { state: await paneIsMissing(herdr, paneId, record.terminalId, error) ? "missing" : "unknown", shellPid: info.shell_pid };
    }
  } catch { return { state: "unknown", shellPid: info.shell_pid }; }
  return { state: cwdMatches ? "idle" : "cwd-mismatch", shellPid: info.shell_pid, shellName: shell.name ?? shell.argv0 ?? shell.argv?.[0] };
}

async function shellIdentity(herdr, paneId, record) {
  const shell = await inspectShell(herdr, paneId, record);
  if (shell.state === "busy") throw new Error("터미널에서 실행 중인 명령이 끝난 뒤 다시 시도하세요");
  if (shell.state === "cwd-mismatch") throw new Error("터미널 작업 폴더가 대화와 일치하지 않습니다");
  if (shell.state === "missing") throw new Error("터미널이 변경되었습니다");
  if (shell.state === "unknown") throw new Error("터미널의 장치 정보를 확인할 수 없습니다");
  return shell.shellPid;
}

export async function startEmbeddedHandoff({ runtime, record, paneId, herdr, commandsPath, nodePath = process.execPath }) {
  const commands = JSON.parse(await readFile(commandsPath, "utf8"));
  const handle = await runtime.describeHandle(record.agentId);
  if (!handle?.sessionId || handle.provider !== record.provider) throw new Error("같은 대화의 제공자 세션 ID를 찾지 못했습니다");
  const argv = nativeHandoffArgs(record.provider, handle.sessionId, handle.empty, commands);
  if (!argv) throw new Error("이 제공자는 현재 대화를 터미널에서 열 수 없습니다");
  return launchFromShell({ runtime, record, paneId, herdr, nodePath }, argv, () => runtime.releaseForTerminal(record.agentId, {
    terminalId: record.terminalId, paneId, sessionId: handle.sessionId, persistenceId: handle.persistenceId, empty: handle.empty,
  }));
}

async function rollbackDispatchedHandoff({ runtime, record, paneId, herdr, owner, shellPid }) {
  try {
    if (await shellIdentity(herdr, paneId, record) !== shellPid) return false;
  } catch {
    return false;
  }
  await changeOwnership(owner.file, owner.token, "dispatched", "reserved");
  await runtime.abortTerminalRelease(record.agentId, owner.token);
  return true;
}

export async function recoverStaleEmbeddedHandoff({ runtime, record, paneId, herdr }) {
  const owner = await readEmbeddedHandoff(record);
  if (!owner || !["dispatched", "running"].includes(owner.phase)) return false;
  const state = await inspectShell(herdr, paneId, record);
  if (state.state === "unknown" || state.state === "busy") return false;
  if (state.state === "missing") {
    if (owner.phase === "running" || !Number.isFinite(owner.dispatchedAt)) {
      await changeOwnership(owner.file, owner.token, owner.phase, "exited", { exitedAt: Date.now() });
    } else {
      await changeOwnership(owner.file, owner.token, "dispatched", "reserved");
      await runtime.abortTerminalRelease(record.agentId, owner.token);
    }
    return true;
  }
  const dispatchedAt = Number.isFinite(owner.dispatchedAt) ? owner.dispatchedAt : (Number.isFinite(owner.startedAt) ? owner.startedAt : 0);
  if (dispatchedAt && Date.now() - dispatchedAt < dispatchedGraceMs) return false;
  await changeOwnership(owner.file, owner.token, owner.phase, "exited", { exitedAt: Date.now() });
  return true;
}

async function launchFromShell({ runtime, record, paneId, herdr, nodePath }, argv, acquire) {
  const initialShell = await inspectShell(herdr, paneId, record);
  const shellPid = await shellIdentity(herdr, paneId, record);
  const owner = await acquire();
  try {
    if (await shellIdentity(herdr, paneId, record) !== shellPid) throw new Error("터미널 셸이 변경되었습니다");
    // 기존 셸 입력은 편집기의 kill buffer에 보관
    await herdr.call("pane.send_input", { pane_id: paneId, text: "", keys: ["Ctrl+E", "Ctrl+U"] });
    if (await shellIdentity(herdr, paneId, record) !== shellPid) throw new Error("터미널 셸이 변경되었습니다");
  } catch (error) {
    await runtime.abortTerminalRelease(record.agentId, owner.token);
    throw error;
  }
  await changeOwnership(owner.file, owner.token, "reserved", "dispatched", { dispatchedAt: Date.now() });
  const modulePath = fileURLToPath(import.meta.url);
  const env = process.versions.electron ? ["env", "ELECTRON_RUN_AS_NODE=1"] : [];
  const start = shellCommand([...env, nodePath, modulePath, "--terminal-start", owner.file, owner.token]);
  const finish = shellCommand([...env, nodePath, modulePath, "--terminal-exited", owner.file, owner.token]);
  const command = shellCommand(argv);
  const shellName = initialShell.shellName ?? "";
  const text = /(?:^|\/|\s)fish(?:$|\s)/.test(shellName)
    ? `if ${start}; ${command}; ${finish}; end`
    : `if ${start}; then ${command}; ${finish}; fi`;
  try {
    await herdr.call("pane.send_input", { pane_id: paneId, text, keys: ["Enter"] });
  } catch (error) {
    if (error?.delivery === "not-delivered") {
      try { await rollbackDispatchedHandoff({ runtime, record, paneId, herdr, owner, shellPid }); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], "터미널 전환 실패 상태를 회수하지 못했습니다"); }
    }
    throw error;
  }
  return owner;
}

export async function returnEmbeddedHandoff({ runtime, record, paneId, herdr }) {
  const owner = await readEmbeddedHandoff(record);
  if (!owner) return false;
  if (owner.terminalId !== record.terminalId || owner.phase !== "exited") throw new Error("터미널 대화를 종료한 뒤 다시 여세요");
  await verifyTerminalExited(herdr, paneId, record);
  await runtime.returnFromTerminal(record.agentId, owner, () => verifyTerminalExited(herdr, paneId, record));
  return true;
}

async function verifyTerminalExited(herdr, paneId, record) {
  const state = await inspectShell(herdr, paneId, record);
  if (["busy", "unknown"].includes(state.state)) throw new Error("터미널에서 실행 중인 명령이 끝난 뒤 다시 시도하세요");
  return state;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [operation, file, token] = process.argv.slice(2);
  if (!["--terminal-start", "--terminal-exited"].includes(operation) || !isAbsolute(file ?? "") || !uuid.test(token ?? "")) throw new Error("Paseo 전환 정보가 잘못되었습니다");
  if (operation === "--terminal-start") await changeOwnership(file, token, "dispatched", "running", { startedAt: Date.now() });
  else {
    const current = await readOwnership(file);
    if (!current || !["dispatched", "running"].includes(current.phase)) throw new Error("Paseo 전환 상태가 변경되었습니다");
    await changeOwnership(file, token, current.phase, "exited", { exitedAt: Date.now() });
  }
}
