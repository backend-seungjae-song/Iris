// herdr pane 사이의 명시적 부모 관계를 기록하고 현재 agent snapshot에 결합한다.
// cwd·탭 이름처럼 우연히 같은 값으로는 관계를 만들지 않는다. launcher가 agent.start 전후에
// 실제 pane/session과 반환된 child terminal을 확인해 남긴 작은 receipt만 신뢰한다.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { herdrSession } from "./herdr-session.cjs";
import { stateHome } from "./state-home.cjs";

const VERSION = 1;
const RECEIPT_DIR = "agent-lineage";
const SAFE_TERMINAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function resolvedOptions(options = {}) {
  const stateDir = options.stateDir || stateHome();
  const socketPath = options.socketPath || herdrSession().socket;
  if (typeof stateDir !== "string" || !path.isAbsolute(stateDir)) throw new Error("agent lineage stateDir must be absolute");
  if (typeof socketPath !== "string" || !path.isAbsolute(socketPath)) throw new Error("agent lineage socketPath must be absolute");
  return { stateDir, socketPath };
}

function stringField(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function endpoint(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const paneId = stringField(value.paneId);
  const terminalId = stringField(value.terminalId);
  const runtime = stringField(value.runtime);
  if (!paneId || !terminalId || !runtime || !SAFE_TERMINAL_ID.test(terminalId)) return null;
  if (value.sessionId != null && !stringField(value.sessionId)) return null;
  return {
    paneId,
    terminalId,
    runtime,
    ...(value.sessionId == null ? {} : { sessionId: value.sessionId }),
  };
}

function validCreatedAt(value) {
  return (typeof value === "number" && Number.isFinite(value))
    || (typeof value === "string" && value.length > 0);
}

function validateRecord(value, socketPath) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== VERSION) return null;
  if (value.socketPath !== socketPath || !validCreatedAt(value.createdAt)) return null;
  const parent = endpoint(value.parent), child = endpoint(value.child);
  if (!parent || !child || parent.terminalId === child.terminalId) return null;
  const reason = stringField(value.reason);
  if (!reason || (value.label != null && typeof value.label !== "string")) return null;
  return {
    version: VERSION,
    socketPath,
    parent,
    child,
    createdAt: value.createdAt,
    reason,
    ...(value.label == null ? {} : { label: value.label }),
  };
}

function receiptDir(stateDir, socketPath) {
  const socketKey = crypto.createHash("sha256").update(socketPath).digest("hex");
  return path.join(stateDir, RECEIPT_DIR, socketKey);
}

function sameEndpointIdentity(a, b) {
  return a.paneId === b.paneId
    && a.terminalId === b.terminalId
    && a.runtime === b.runtime
    && (a.sessionId || null) === (b.sessionId || null);
}

function sameLineageIdentity(a, b) {
  return sameEndpointIdentity(a.parent, b.parent) && sameEndpointIdentity(a.child, b.child);
}

export function writeAgentLineage(record, options = {}) {
  const { stateDir, socketPath } = resolvedOptions(options);
  const next = validateRecord(record, socketPath);
  if (!next) throw new Error("invalid agent lineage record");

  const dir = receiptDir(stateDir, socketPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, `${next.child.terminalId}.json`);
  const temp = path.join(dir, `.${next.child.terminalId}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(next), { mode: 0o600 });
  try {
    try {
      // link는 기존 target을 덮지 않는다. 다른 부모가 같은 child를 동시에 claim해도 하나만 성공한다.
      fs.linkSync(temp, target);
      fs.unlinkSync(temp);
      return target;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    let previous;
    try {
      previous = validateRecord(JSON.parse(fs.readFileSync(target, "utf8")), socketPath);
    } catch {}
    if (!previous) throw new Error(`agent lineage receipt is unreadable: ${target}`);
    if (!sameLineageIdentity(previous, next)) throw new Error(`agent lineage conflict for ${next.child.terminalId}`);
    fs.renameSync(temp, target);
    return target;
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
}

export function readAgentLineage(options = {}) {
  const { stateDir, socketPath } = resolvedOptions(options);
  const dir = receiptDir(stateDir, socketPath);
  let files;
  try {
    if (options.terminalIds != null) {
      files = [...new Set(Array.from(options.terminalIds)
        .filter((terminalId) => typeof terminalId === "string" && SAFE_TERMINAL_ID.test(terminalId))
        .map((terminalId) => `${terminalId}.json`))].sort();
    } else {
      files = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
    }
  }
  catch { return []; }
  const records = [];
  for (const file of files) {
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")); }
    catch { continue; }
    const record = validateRecord(parsed, socketPath);
    if (!record || file !== `${record.child.terminalId}.json`) continue;
    records.push(record);
  }
  return records;
}

export function watchAgentLineage(onChange, options = {}) {
  if (typeof onChange !== "function") throw new Error("agent lineage watcher requires an onChange callback");
  const { stateDir, socketPath } = resolvedOptions(options);
  const dir = receiptDir(stateDir, socketPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = () => {
    try {
      const s = fs.statSync(dir, { bigint: true });
      return `${s.dev}:${s.ino}:${s.mtimeNs}:${s.ctimeNs}`;
    } catch {
      return null;
    }
  };
  let previous = stamp();
  const timer = setInterval(() => {
    const next = stamp();
    if (next == null) { previous = null; return; }
    if (next === previous) return;
    previous = next;
    onChange();
  }, 500);
  // 감시 타이머가 서버 종료를 막지 않는다. close는 테스트와 이후의 명시적 lifecycle owner가 쓴다.
  timer.unref();
  return { close: () => clearInterval(timer) };
}

function runtimeMatches(recorded, live) {
  return String(recorded || "").toLowerCase() === String(live || "").toLowerCase();
}

function sessionMatches(recorded, live) {
  return !recorded || recorded === live;
}

function cycleMembers(edges) {
  const cyclic = new Set();
  for (const start of edges.keys()) {
    const pathSeen = new Map();
    let at = start, step = 0;
    while (edges.has(at)) {
      if (pathSeen.has(at)) {
        const cycleStart = pathSeen.get(at);
        for (const [paneId, index] of pathSeen) if (index >= cycleStart) cyclic.add(paneId);
        break;
      }
      pathSeen.set(at, step++);
      at = edges.get(at).parentPaneId;
    }
  }
  return cyclic;
}

export function attachAgentLineage(state, rawAgents, options = {}) {
  const normalized = Array.isArray(state) ? state : [];
  for (const agent of normalized) {
    agent.parentPaneId = null;
    agent.parentSessionUuid = null;
    agent.lineageReason = null;
    agent.lineageLabel = null;
  }

  const liveByTerminal = new Map();
  for (const raw of Array.isArray(rawAgents) ? rawAgents : []) {
    if (stringField(raw?.terminal_id)) liveByTerminal.set(raw.terminal_id, raw);
  }
  const stateByPane = new Map(normalized.filter((a) => a?.paneId).map((a) => [a.paneId, a]));
  const edges = new Map();

  for (const record of readAgentLineage({ ...options, terminalIds: liveByTerminal.keys() })) {
    const rawParent = liveByTerminal.get(record.parent.terminalId);
    const rawChild = liveByTerminal.get(record.child.terminalId);
    if (!rawParent || !rawChild) continue;
    if (rawParent.pane_id !== record.parent.paneId || rawChild.pane_id !== record.child.paneId) continue;
    if (!rawParent.workspace_id || rawParent.workspace_id !== rawChild.workspace_id) continue;
    if (!runtimeMatches(record.parent.runtime, rawParent.agent) || !runtimeMatches(record.child.runtime, rawChild.agent)) continue;

    const parent = stateByPane.get(rawParent.pane_id), child = stateByPane.get(rawChild.pane_id);
    if (!parent || !child || parent === child) continue;
    if (parent.terminalId !== record.parent.terminalId || child.terminalId !== record.child.terminalId) continue;
    if (!sessionMatches(record.parent.sessionId, parent.sessionUuid)) continue;
    if (!sessionMatches(record.child.sessionId, child.sessionUuid)) continue;
    edges.set(child.paneId, { record, parent, child, parentPaneId: parent.paneId });
  }

  const cyclic = cycleMembers(edges);
  for (const [childPaneId, edge] of edges) {
    if (cyclic.has(childPaneId)) continue;
    edge.child.parentPaneId = edge.parent.paneId;
    edge.child.parentSessionUuid = edge.parent.sessionUuid || edge.record.parent.sessionId || null;
    edge.child.lineageReason = edge.record.reason;
    edge.child.lineageLabel = edge.record.label || null;
  }
  return state;
}
