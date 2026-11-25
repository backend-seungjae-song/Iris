import fs from "node:fs";
import path from "node:path";
import { paneStateId, restoredPaneId } from "./managed-binding.mjs";
import { stateHome } from "../state-home.cjs";
import { parseBuildName } from "./plan.js";

function paneLocation(paneId, root, terminalId) {
  if (typeof paneId !== "string" || !paneId) throw new Error("pane ID가 없습니다");
  const original = paneStateId(root, paneId, terminalId);
  const id = terminalId ? restoredPaneId(root, terminalId) || original : original;
  const stateDir = path.join(root, "paseo-ui", "panes", id);
  const sockets = process.platform === "win32" ? null : path.join("/tmp", `iris-paseo-${process.getuid()}`);
  const socketPath = sockets ? path.join(sockets, id + ".sock") : "\\\\.\\pipe\\iris-paseo-" + id;
  return { id, paneId, stateDir, socketPath, sockets };
}

export function reserveManagedPane(paneId, provider, build, root = stateHome(), terminalId = null) {
  if (!parseBuildName(build) || typeof provider !== "string" || !provider) throw new Error("Paseo 실행 정보가 잘못되었습니다");
  const location = paneLocation(paneId, root, terminalId);
  if (location.sockets) {
    fs.mkdirSync(location.sockets, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(location.sockets);
    if (!st.isDirectory() || st.uid !== process.getuid() || (st.mode & 0o077)) throw new Error("Paseo 소켓 폴더 권한을 확인하세요");
  }
  fs.mkdirSync(path.dirname(location.stateDir), { recursive: true, mode: 0o700 });
  fs.mkdirSync(location.stateDir, { mode: 0o700 });
  fs.writeFileSync(path.join(location.stateDir, "pane.json"), JSON.stringify({ paneId, provider, build, terminalId }), { flag: "wx", mode: 0o600 });
  return { ...location, provider, build };
}

export function managedPane(paneId, root = stateHome(), terminalId = null) {
  const location = paneLocation(paneId, root, terminalId);
  if (!fs.existsSync(location.stateDir)) return null;
  const record = JSON.parse(fs.readFileSync(path.join(location.stateDir, "pane.json"), "utf8"));
  if ((!terminalId && record.paneId !== paneId) || !parseBuildName(record.build)) throw new Error("저장된 pane 정보를 확인할 수 없습니다");
  const state = readOptional(path.join(location.stateDir, "state.json"));
  if (terminalId && (state?.terminalId || record.terminalId) !== terminalId) return null;
  const startupError = state ? null : readOptional(path.join(location.stateDir, "startup-error.json"))?.message;
  if (state && (state.paneId !== record.paneId || state.provider !== record.provider)) throw new Error("Paseo 세션과 pane이 일치하지 않습니다");
  return { ...location, ...record, paneId, startupError, launchPaneId: record.paneId, agentId: state?.agentId ?? null, serverId: state?.serverId ?? null, workspaceId: state?.workspaceId ?? null };
}

export function liveManagedPane(agent) {
  if (agent.agent !== "iris-paseo" || !agent.terminal_id || !agent.pane_id) return null;
  const record = managedPane(agent.pane_id, undefined, agent.terminal_id);
  if (!record?.agentId) return null;
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(record.stateDir, "socket-owner.json"), "utf8"));
    const socket = fs.lstatSync(record.socketPath);
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !socket.isSocket()
      || owner.socket !== record.socketPath || owner.device !== socket.dev || owner.inode !== socket.ino) return null;
    process.kill(owner.pid, 0);
    return record;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return null;
    throw error;
  }
}

function readOptional(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  return null;
}
