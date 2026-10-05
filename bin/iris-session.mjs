// CLI와 MCP는 호출마다 현재 pane 소유 관계를 확인한다.
import net from "node:net";
import path from "node:path";
import childProcess from "node:child_process";
import { herdrSession, herdrEndpoint } from "../server/herdr-session.cjs";

const HERDR_SOCK = herdrSession().socket;

function herdrCall(method, params = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(herdrEndpoint(HERDR_SOCK), () => {
      socket.write(JSON.stringify({ id: "iris-mcp", method, params }) + "\n");
    });
    let buf = "", done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      fn(value);
    };
    socket.on("data", (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      let msg;
      try { msg = JSON.parse(buf.slice(0, nl)); }
      catch { finish(reject, new Error("herdr bad response")); return; }
      if (msg.error) finish(reject, new Error(msg.error.message || "herdr error"));
      else finish(resolve, msg.result ?? msg);
    });
    socket.on("error", (e) => finish(reject, e));
    const timer = setTimeout(() => finish(reject, new Error(`herdr timeout: ${method}`)), 2000);
  });
}

export async function processAncestry() {
  if (process.platform === "win32") {
    const { request } = await import("../server/win-native.cjs");
    const result = await request({ op: "processes" });
    if (!result.ok) return [];
    const parents = new Map(result.processes.map((row) => [row.pid, row.ppid]));
    const out = [], seen = new Set();
    let pid = process.pid;
    while (pid > 1 && !seen.has(pid) && out.length < 32) {
      out.push(pid); seen.add(pid); pid = parents.get(pid) || 0;
    }
    return out;
  }
  return new Promise((resolve) => {
    childProcess.execFile("/bin/ps", ["-axo", "pid=,ppid="], { timeout: 2000, maxBuffer: 4 << 20 }, (err, stdout) => {
      if (err && !stdout) { resolve([]); return; }
      const parents = new Map();
      for (const line of String(stdout || "").split("\n")) {
        const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
        if (m) parents.set(Number(m[1]), Number(m[2]));
      }
      const out = [], seen = new Set();
      let pid = process.pid;
      while (pid > 1 && !seen.has(pid) && out.length < 32) {
        out.push(pid); seen.add(pid); pid = parents.get(pid) || 0;
      }
      resolve(out);
    });
  });
}

// 가장 가까운 조상 프로세스가 속한 pane 하나만 고른다. 같은 거리에서 둘 이상 맞으면 잘못된 탭을
// 여는 것보다 세션 없음으로 막는 편이 안전하다.
export function chooseHerdrPane(agents, processInfos, ancestry) {
  const rank = new Map((ancestry || []).map((pid, i) => [Number(pid), i]));
  const hits = [];
  for (let i = 0; i < (agents || []).length; i++) {
    const pane = agents[i]?.pane_id;
    if (!pane) continue;
    const raw = processInfos[i];
    const info = raw?.process_info || raw || {};
    const pids = [info.shell_pid, ...(Array.isArray(info.foreground_processes)
      ? info.foreground_processes.map((p) => p.pid) : [])].map(Number).filter(Number.isFinite);
    const scores = pids.map((pid) => rank.get(pid)).filter((v) => v != null);
    if (scores.length) hits.push({ pane: String(pane), score: Math.min(...scores) });
  }
  if (!hits.length) return null;
  const best = Math.min(...hits.map((h) => h.score));
  const panes = [...new Set(hits.filter((h) => h.score === best).map((h) => h.pane))];
  return panes.length === 1 ? panes[0] : null;
}

// 공유 daemon의 조상에는 TUI가 없다. 등록이 없는 명시적 resume만 실행 argv로 대조한다.
export function chooseCodexResumePane(agents, processInfos, thread) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(thread || "")) return null;
  const hits = [];
  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i];
    if (agent.agent !== "codex" || agent.agent_session || agent.session_id) continue;
    const info = processInfos[i]?.process_info || processInfos[i] || {};
    const matches = (info.foreground_processes || []).filter((p) => {
      const argv = p.argv || [];
      if ((process.platform === "win32" ? path.win32.basename(String(argv[0] || "")).replace(/\.(exe|cmd)$/i, "").toLowerCase() : String(argv[0] || "").split("/").at(-1)) !== "codex") return false;
      const command = argv[1] === "--no-daemon" ? 2 : 1;
      return argv[command] === "resume" && argv[command + 1] === thread;
    });
    if (matches.length === 1 && agent.pane_id) hits.push(agent.pane_id);
  }
  return hits.length === 1 ? hits[0] : null;
}

export function createSessionResolver({ env = process.env, call = herdrCall, ancestry = processAncestry } = {}) {
  let pending = null;
  return async function currentSession() {
    if (pending) return pending;
    pending = (async () => {
      try {
        const listed = await call("agent.list");
        const agents = listed?.agents || [];
        if (env.IRIS_SESSION) {
          const panes = await call("pane.list");
          return (panes?.panes || []).some(p => p.pane_id === env.IRIS_SESSION) ? env.IRIS_SESSION : null;
        }
        const thread = env.CODEX_THREAD_ID || env.CODEX_SESSION_ID;
        if (thread) {
          const hits = agents.filter(a => a.agent === "codex" &&
            (a.agent_session?.value === thread || a.session_id === thread));
          if (hits.length) return hits.length === 1 ? hits[0].pane_id : null;
        }
        const lineage = await ancestry();
        const infos = await Promise.all(agents.map(a =>
          call("pane.process_info", { pane_id: a.pane_id }).catch(() => null)));
        return chooseCodexResumePane(agents, infos, thread) || chooseHerdrPane(agents, infos, lineage);
      } catch { return null; }
    })();
    try { return await pending; } finally { pending = null; }
  };
}
