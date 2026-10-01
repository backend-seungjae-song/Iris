import fs from "node:fs";
import path from "node:path";

import { claudeHome, codexHome } from "./agent-homes.js";
import stateHomeModule from "./state-home.cjs";

const { stateHome } = stateHomeModule;
const reports = new Map();
const SESSION_TAIL_BYTES = 256 * 1024;

function inside(root, file) {
  return !!root && (file === root || file.startsWith(root + path.sep));
}

function real(value) {
  try { return fs.realpathSync(value); } catch { return null; }
}

function roots(options = {}) {
  return {
    claude: real(options.claudeRoot || claudeHome("projects")),
    codex: real(options.codexRoot || codexHome("sessions")),
    state: real(options.stateDir || stateHome()),
  };
}

export function validateAgentSessionPath(agent, value, options = {}) {
  if (!["claude", "codex"].includes(agent) || typeof value !== "string" || !value.endsWith(".jsonl")) return null;
  const file = real(value);
  const allowed = roots(options);
  if (!file || !inside(allowed[agent], file) || inside(allowed.state, file)) return null;
  try { return fs.statSync(file).isFile() ? file : null; } catch { return null; }
}

export function sessionIdsFromTranscriptTail(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - SESSION_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    const read = fs.readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, read).toString("utf8").split("\n");
    if (start > 0) lines.shift();
    const ids = new Set();
    for (const line of lines) {
      if (!line.includes("session_id")) continue;
      try {
        const value = JSON.parse(line)?.session_id;
        if (typeof value === "string" && value) ids.add(value);
      } catch {}
    }
    return ids;
  } catch {
    return new Set();
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

function belongsToSession(agent, file, sessionId) {
  const lowerId = sessionId.toLowerCase();
  const stem = path.basename(file, ".jsonl").toLowerCase();
  if (agent === "codex") return stem.endsWith(`-${lowerId}`);
  return stem === lowerId || sessionIdsFromTranscriptTail(file).has(sessionId);
}

export function reportAgentSessionPath(input, options = {}) {
  const paneId = String(input?.paneId || "");
  const agent = String(input?.agent || "").toLowerCase();
  const sessionId = String(input?.sessionId || "");
  if (!paneId || !sessionId || sessionId.length > 512 || /[\x00-\x1f\x7f]/.test(sessionId)) return null;
  const key = `${agent}\0${paneId}`;
  if (["claude", "codex"].includes(agent)) reports.delete(key);
  const file = validateAgentSessionPath(agent, input?.transcriptPath, options);
  if (!file || !belongsToSession(agent, file, sessionId)) return null;
  const record = { paneId, agent, sessionId, file };
  reports.set(key, record);
  return record;
}

export function agentSessionPathFor(paneId, agent, options = {}) {
  const key = `${String(agent || "").toLowerCase()}\0${String(paneId || "")}`;
  const record = reports.get(key);
  if (!record) return null;
  const file = validateAgentSessionPath(record.agent, record.file, options);
  if (!file) { reports.delete(key); return null; }
  return { ...record, file };
}

export function resetAgentSessionPathsForTest() {
  reports.clear();
}
