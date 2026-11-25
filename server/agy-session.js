// Antigravity(agy) 프로세스가 열고 있는 presence/<uuid>.lock 또는 brain/<uuid> 에서
// 현재 대화 id 와 transcript.jsonl 경로를 찾는다.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { agyHome } from "./agent-homes.js";
import { agentSessionPathFor, validateAgentSessionPath } from "./agent-session-path.js";

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRESENCE_RE = /\/presence\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.lock$/i;
const BRAIN_RE = /\/brain\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;
const SCAN_TTL_MS = 1500;

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 8 << 20, timeout: 4000 }, (err, stdout) => resolve(err && !stdout ? "" : String(stdout || "")));
  });
}

let scanCache = { at: 0, byPid: new Map(), children: new Map() };
let scanning = null;

export function agyTranscriptPath(uuid, options = {}) {
  if (!ID_RE.test(uuid || "")) return null;
  const root = options.agyRoot || agyHome("brain");
  const logsDir = path.join(root, uuid, ".system_generated", "logs");
  // compact transcript.jsonl 은 긴 응답(A2UI JSON 등)을 잘라내므로 원문 transcript_full.jsonl 을 우선한다
  for (const name of ["transcript_full.jsonl", "transcript.jsonl"]) {
    const hit = validateAgentSessionPath("agy", path.join(logsDir, name), options);
    if (hit) return hit;
  }
  return null;
}

export function agySessionFromPath(file, sessionId = null, options = {}) {
  const verified = validateAgentSessionPath("agy", file, options);
  const match = verified ? BRAIN_RE.exec(verified) : null;
  if (!match || (sessionId && match[1].toLowerCase() !== String(sessionId).toLowerCase())) return null;
  if (path.basename(verified) === "transcript.jsonl") {
    const full = validateAgentSessionPath("agy", path.join(path.dirname(verified), "transcript_full.jsonl"), options);
    if (full) return { uuid: match[1], file: full };
  }
  return { uuid: match[1], file: verified };
}

export function extractAgyConversationId(openedPath) {
  if (typeof openedPath !== "string") return null;
  const p = PRESENCE_RE.exec(openedPath);
  if (p) return p[1];
  const b = BRAIN_RE.exec(openedPath);
  return b ? b[1] : null;
}

async function scan() {
  const now = Date.now();
  if (now - scanCache.at < SCAN_TTL_MS) return scanCache;
  if (scanning) return scanning;
  scanning = (async () => {
    if (process.platform === "win32") {
      scanCache = { at: Date.now(), byPid: new Map(), children: new Map() };
      scanning = null;
      return scanCache;
    }
    const root = fs.realpathSync(agyHome()) + path.sep;
    const [lsofOut, psOut] = await Promise.all([
      run("lsof", ["-c", "agy", "-c", "antigravity", "-Fpn"]),
      run("ps", ["-axo", "pid=,ppid=,comm="]),
    ]);
    const byPid = new Map();
    let pid = null;
    for (const line of lsofOut.split("\n")) {
      if (line[0] === "p") pid = Number(line.slice(1)) || null;
      else if (line[0] === "n" && pid) {
        const f = line.slice(1);
        let resolved;
        try { resolved = fs.realpathSync(f); } catch { continue; }
        if (!resolved.startsWith(root)) continue;
        const uuid = extractAgyConversationId(resolved);
        if (!uuid) continue;
        if (!byPid.has(pid)) byPid.set(pid, new Set());
        byPid.get(pid).add(uuid);
      }
    }
    const children = new Map();
    for (const line of psOut.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!m) continue;
      const kid = { pid: Number(m[1]), comm: path.basename(m[3].trim()) };
      const parent = Number(m[2]);
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(kid);
    }
    scanCache = { at: Date.now(), byPid, children };
    return scanCache;
  })().finally(() => { scanning = null; });
  return scanning;
}

function bestConversationForTree(byPid, children, rootPid) {
  if (!rootPid) return null;
  const seen = new Set();
  const stack = [rootPid];
  const uuids = new Set();
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const uuid of byPid.get(pid) || []) uuids.add(uuid);
    for (const kid of children.get(pid) || []) stack.push(kid.pid);
  }
  let best = null;
  for (const uuid of uuids) {
    const file = agyTranscriptPath(uuid);
    let mtime = 0;
    if (file) {
      try { mtime = fs.statSync(file).mtimeMs; } catch { mtime = 0; }
    }
    if (!best || (file && !best.file) || mtime > best.mtime) best = { uuid, file, mtime };
  }
  return best ? { uuid: best.uuid, file: best.file } : null;
}

function findAgyDescendant(children, rootPid) {
  const seen = new Set();
  const stack = [rootPid];
  while (stack.length) {
    const p = stack.pop();
    if (seen.has(p)) continue;
    seen.add(p);
    for (const kid of children.get(p) || []) {
      if (isAgyKind(kid.comm)) return kid.pid;
      stack.push(kid.pid);
    }
  }
  return null;
}

function isAgyKind(name) {
  const n = String(name || "").toLowerCase();
  return n === "agy" || n.startsWith("agy") || n.startsWith("antigravity");
}

export async function resolveAgySession(herdr, paneId, knownPane = null) {
  if (!paneId) return null;
  try {
    const reported = agentSessionPathFor(paneId, "agy");
    if (knownPane || typeof herdr.paneGet === "function") {
      const pane = knownPane || await herdr.paneGet(paneId);
      if (!isAgyKind(pane?.agent)) return null;
      if (pane?.agent_session?.kind === "id") {
        const id = pane.agent_session.value;
        if (!ID_RE.test(id || "")) return null;
        const hit = reported && agySessionFromPath(reported.file, id);
        return hit || { uuid: id, file: agyTranscriptPath(id) };
      }
      if (pane?.agent_session?.kind === "path") {
        return agySessionFromPath(pane.agent_session.value);
      }
    }
    if (reported && typeof herdr.paneGet !== "function") return agySessionFromPath(reported.file, reported.sessionId);
    const [{ byPid, children }, info] = await Promise.all([
      scan(),
      herdr.call("pane.process_info", { pane_id: paneId }),
    ]);
    const pi = info?.process_info || info || {};
    const fg = Array.isArray(pi.foreground_processes) ? pi.foreground_processes : [];
    const foreground = fg.find((p) => isAgyKind(path.basename(p.name || "")) || isAgyKind(path.basename(p.argv0 || "")));
    let pid = foreground?.pid || null;
    if (!pid && pi.shell_pid) pid = findAgyDescendant(children, Number(pi.shell_pid));
    if (!pid) return null;
    const hit = bestConversationForTree(byPid, children, pid);
    if (hit) return hit;
    const argv = foreground?.argv || [];
    const idx = argv.indexOf("--conversation");
    if (idx > 0 && ID_RE.test(argv[idx + 1] || "")) {
      return { uuid: argv[idx + 1], file: agyTranscriptPath(argv[idx + 1]) };
    }
    return null;
  } catch {
    return null;
  }
}

export function prewarmAgyScan() {
  if (process.platform === "win32") return;
  scan().catch(() => {});
}

export async function attachAgySessions(state, herdr, rawAgents = []) {
  const need = (state || []).filter((s) => isAgyKind(s.agent) && !s.sessionFile);
  if (!need.length) return state;
  const rawByPane = new Map((rawAgents || []).filter((a) => a?.pane_id && a.agent_session).map((a) => [a.pane_id, a]));
  await Promise.all(need.map(async (s) => {
    const hit = await resolveAgySession(herdr, s.paneId, rawByPane.get(s.paneId) || null);
    if (hit) { s.sessionUuid = hit.uuid; s.sessionFile = hit.file; }
  }));
  return state;
}
