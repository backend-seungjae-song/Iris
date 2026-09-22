// codex 세션 키 찾기.
//
// 보관은 복원 키가 있는 세션만 대상으로 한다. herdr는 그 키(agent_session)를 claude에만 제공하고
// codex 항목에는 넣지 않는다(확인 결과: agent.list의 codex 항목에 agent_session 필드 없음).
// 그래서 codex는 키 없는 세션으로 보여 보관이 막힌다. 여기서 그 키를 직접 찾는다.
//
// 찾는 방법: pane에서 실행 중인 codex 프로세스가 현재 쓰고 있는 rollout 파일이 그 대화다.
//  1) pane → pid: herdr pane.process_info. foreground_processes에 codex가 없으면(도구 실행 중이면
//     자식이 앞에 나온다) shell_pid의 자손을 ps로 훑어 찾는다.
//  2) pid → 파일: lsof가 그 프로세스가 연 rollout 목록을 반환한다. 여러 개가 잡히는데, 과거 대화를
//     읽어두기도 하기 때문이다. 그중 mtime이 가장 최근인 것이 지금 append되고 있는 대화다.
//     확인 결과: `codex continue` pane이 rollout 3개(07-07·07-11·08-02)를 열고 있었고, 화면의 대화는
//     최신 mtime인 07-11이었다. 파일을 연 순서(fd 번호)로 고르면 08-02가 잡혀 잘못된다.
//  3) 파일 → uuid: 파일명이 rollout-<시각>-<uuid>.jsonl. `codex resume <uuid>`가 이 열쇠를 받는다
//     (codex 0.145.0 `resume --help`: SESSION_ID는 UUID 또는 세션 이름).
//
// mtime을 보므로 한 프로세스 안에서 대화를 전환한 경우(codex는 스레드를 바꿀 수 있다)도 추적한다.
// 그래서 값을 오래 캐시하지 않고, 보관 직전에는 항상 새로 찾는다.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { codexHome } from "./agent-homes.js";

const SESSIONS = codexHome("sessions");
const UUID_RE = /rollout-.*?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

// 여러 pane을 한 회차에 조회하므로 lsof·ps는 회차마다 한 번만 실행한다. 회차 사이에도 짧게만
// 재사용한다. 키가 오래되면 다른 대화를 복원하게 되므로 캐시는 짧을수록 안전하다.
const SCAN_TTL_MS = 1500;

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 8 << 20, timeout: 4000 }, (err, stdout) => resolve(err && !stdout ? "" : String(stdout || "")));
  });
}

let scanCache = { at: 0, byPid: new Map(), children: new Map() };
let scanning = null;

// lsof 한 번으로 codex 프로세스들이 물고 있는 rollout 경로를 pid별로 모으고,
// ps 한 번으로 부모→자식 표를 만든다(전면 프로세스가 codex가 아닐 때 자손을 찾기 위해).
async function scan() {
  const now = Date.now();
  if (now - scanCache.at < SCAN_TTL_MS) return scanCache;
  if (scanning) return scanning;
  scanning = (async () => {
    const [lsofOut, psOut] = await Promise.all([
      run("lsof", ["-c", "codex", "-Fpn"]),
      run("ps", ["-axo", "pid=,ppid=,comm="]),
    ]);
    const byPid = new Map();
    let pid = null;
    for (const line of lsofOut.split("\n")) {
      if (line[0] === "p") pid = Number(line.slice(1)) || null;
      else if (line[0] === "n" && pid) {
        const f = line.slice(1);
        if (f.startsWith(SESSIONS) && UUID_RE.test(f)) {
          if (!byPid.has(pid)) byPid.set(pid, []);
          byPid.get(pid).push(f);
        }
      }
    }
    const children = new Map();   // ppid → [{pid, comm}]
    for (const line of psOut.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!m) continue;
      const kid = { pid: Number(m[1]), comm: path.basename(m[3].trim()) };
      const parent = Number(m[2]);
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(kid);
    }
    scanCache = { at: Date.now(), byPid, children };
    scanning = null;
    return scanCache;
  })();
  return scanning;
}

// 그 pid가 열고 있는 rollout 중 현재 사용 중인 파일.
function liveRollout(byPid, pid) {
  let best = null;
  for (const f of byPid.get(pid) || []) {
    const m = UUID_RE.exec(f);
    if (!m) continue;
    let mtime = 0;
    try { mtime = fs.statSync(f).mtimeMs; } catch { continue; }
    if (!best || mtime > best.mtime) best = { uuid: m[1], file: f, mtime };
  }
  return best;
}

// shell_pid 아래에서 codex 프로세스를 찾는다(전면 프로세스가 도구 실행 중인 자식일 때의 경로).
function findCodexDescendant(children, rootPid) {
  const seen = new Set();
  const stack = [rootPid];
  while (stack.length) {
    const p = stack.pop();
    if (seen.has(p)) continue;
    seen.add(p);
    for (const kid of children.get(p) || []) {
      if (kid.comm === "codex") return kid.pid;
      stack.push(kid.pid);
    }
  }
  return null;
}

// pane 하나의 codex 세션. 찾지 못하면 null 이고, 그때는 보관이 차단된다.
export async function resolveCodexSession(herdr, paneId) {
  if (!paneId) return null;
  try {
    const [{ byPid, children }, info] = await Promise.all([
      scan(),
      herdr.call("pane.process_info", { pane_id: paneId }),
    ]);
    const pi = info?.process_info || info || {};
    const fg = Array.isArray(pi.foreground_processes) ? pi.foreground_processes : [];
    let pid = fg.find((p) => p.name === "codex" || p.argv0 === "codex")?.pid || null;
    if (!pid && pi.shell_pid) pid = findCodexDescendant(children, Number(pi.shell_pid));
    if (!pid) return null;
    const hit = liveRollout(byPid, pid);
    return hit ? { uuid: hit.uuid, file: hit.file } : null;
  } catch {
    return null;
  }
}

// 관제 상태의 codex 항목에 세션 키를 채운다. herdr가 제공하는 항목(claude)은 변경하지 않는다.
export async function attachCodexSessions(state, herdr) {
  const need = (state || []).filter((s) => String(s.agent || "").toLowerCase() === "codex" && !s.sessionUuid);
  if (!need.length) return state;
  await Promise.all(need.map(async (s) => {
    const hit = await resolveCodexSession(herdr, s.paneId);
    if (hit) { s.sessionUuid = hit.uuid; s.sessionFile = hit.file; }
  }));
  return state;
}
