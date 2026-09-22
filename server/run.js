// 실행 통합: 프로젝트의 npm 스크립트(dev/build/test 등)를 발견·실행하고 출력을 캡처한다.
// dev 서버 URL을 출력에서 자동 감지해 브라우저 자동 오픈(→ observe로 QA 루프 연결)에 쓴다.
// 조작(start/stop)은 로컬 전용(index.js가 게이팅). 대상 cwd는 fsPathAllowed로 워크스페이스 하위 제한.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stateHome } from "./state-home.cjs";

// 출력에서 dev 서버 주소 감지. localhost/127/0.0.0.0 우선, 포트 포함 http(s) URL.
const URL_RE = /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[a-z0-9.-]+)(?::\d{2,5})?(?:\/[^\s'"]*)?)/i;
function stripAnsi(s) { return String(s).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ""); }

// 자동 오픈 허용 여부: 로컬호스트 계열만(스크립트가 외부 URL을 찍어 임베디드 브라우저를 유도하는 것 차단).
export function isLocalUrl(u) {
  try { const h = new URL(u).hostname; return h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0" || h === "::1" || h === "[::1]"; }
  catch { return false; }
}

// launchd 서버 PATH 에는 ~/Library/pnpm(전역 pnpm)이 없어서 spawn 이 ENOENT 로 실패한다. PATH 를 보강한다.
function runEnv() {
  const extra = [path.join(os.homedir(), "Library", "pnpm"), "/opt/homebrew/bin", "/usr/local/bin"];
  const PATH = [...extra, process.env.PATH || ""].filter(Boolean).join(":");
  return { ...process.env, PATH, FORCE_COLOR: "0", NO_COLOR: "1", npm_config_color: "false", BROWSER: "none" };
}

function detectPkgMgr(cwd) {
  if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(cwd, "package-lock.json"))) return "npm";
  return "npm";
}

export function listScripts(cwd) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
    const scripts = (pkg && typeof pkg.scripts === "object" && pkg.scripts) ? pkg.scripts : {};
    // 프로토타입 오염과 상속 속성을 배제하고 own string 값만 받는다.
    const own = {};
    for (const k of Object.keys(scripts)) if (Object.hasOwn(scripts, k) && typeof scripts[k] === "string") own[k] = scripts[k];
    return { ok: true, name: pkg.name || path.basename(cwd), pkgmgr: detectPkgMgr(cwd), scripts: own };
  } catch (e) { return { ok: false, error: "package.json 없음/파싱 실패: " + (e.message || e) }; }
}

const BUF_CAP = 500;       // 라인 링버퍼 상한(줄 수)
const LINE_CAP = 4000;     // 라인당 문자 상한(거대 단일라인 메모리 폭주 방지)
const CHUNK_CAP = 65536;   // 이벤트로 방출하는 chunk 바이트 상한
const DATA_DIR = stateHome();
const PIDS_FILE = path.join(DATA_DIR, "run-pids.json");

// orphan 청소: 이전 인스턴스가 SIGKILL(kickstart -k)로 죽으면 detached 자식(dev 서버)이 남는다.
// 시작 시 기록된 pgid가 살아있으면(우리가 만든 그룹) 죽이고 파일을 비운다.
// pid 만 보고 종료하면 안 된다. pid 는 재사용되므로 기록된 번호를 그 사이 다른 프로세스가
// 차지했으면 우리가 띄운 dev 서버가 아니라 무관한 프로세스 그룹을 종료하게 된다. 그 번호가
// 기록해 둔 그 프로세스인지 시작 시각으로 확인하고, 확인할 수 없으면 종료하지 않는다.
function startedAtOf(pid) {
  try {
    const out = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).trim();
    const t = out ? Date.parse(out) : NaN;
    return Number.isFinite(t) ? t : null;
  } catch { return null; }
}
const REAP_START_TOLERANCE_MS = 5000;   // 우리가 적은 시각과 실제 시작 시각의 허용 오차

function reapOrphans() {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(PIDS_FILE, "utf8")); } catch { list = []; }
  if (Array.isArray(list)) for (const e of list) {
    const pid = e && e.pid; if (!pid) continue;
    try { process.kill(pid, 0); } catch { continue; } // 이미 죽음
    const recorded = Number(e.startedAt);
    if (!Number.isFinite(recorded)) continue;        // 언제 띄웠는지 모르면 손대지 않는다
    const actual = startedAtOf(pid);
    if (actual === null) continue;                   // 물어볼 수 없으면 손대지 않는다
    if (Math.abs(actual - recorded) > REAP_START_TOLERANCE_MS) continue;  // 번호만 같은 남의 것
    try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
  }
  try { fs.mkdirSync(path.dirname(PIDS_FILE), { recursive: true }); fs.writeFileSync(PIDS_FILE, "[]"); } catch {}
}

export class RunManager {
  constructor(onEvent) {
    this.onEvent = onEvent || (() => {});
    this.runs = new Map(); // canonical cwd → state
    try { reapOrphans(); } catch {}
  }
  persistPids() {
    const arr = [];
    for (const [, r] of this.runs) if (r.running && r.pid) arr.push({ pid: r.pid, startedAt: r.startedAt });
    try { fs.mkdirSync(path.dirname(PIDS_FILE), { recursive: true }); fs.writeFileSync(PIDS_FILE, JSON.stringify(arr)); } catch {}
  }
  status(cwd) {
    const r = this.runs.get(cwd);
    if (!r) return { running: false, url: null, script: null, tail: [] };
    return { running: r.running, script: r.script, pkgmgr: r.pkgmgr, url: r.url, pid: r.pid, exitCode: r.exitCode, tail: r.buffer.slice(-50) };
  }
  start(cwd, script) {
    const cur = this.runs.get(cwd);
    if (cur && cur.running) return { ok: false, error: "이미 실행 중: " + cur.script, running: cur.script };
    if (typeof script !== "string" || !script) return { ok: false, error: "스크립트 이름 필요" };
    const info = listScripts(cwd);
    if (!info.ok) return { ok: false, error: info.error };
    if (!Object.hasOwn(info.scripts, script)) return { ok: false, error: "스크립트 없음: " + script };
    let proc;
    try { proc = spawn(info.pkgmgr, ["run", script], { cwd, detached: true, env: runEnv(), stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { return { ok: false, error: "실행 실패: " + (e.message || e) }; }
    const state = { proc, pid: proc.pid, script, pkgmgr: info.pkgmgr, buffer: [], url: null, running: true, startedAt: Date.now(), exitCode: null, carry: "" };
    this.runs.set(cwd, state);
    this.persistPids();
    const emit = this.onEvent;
    const handle = (data, stream) => {
      let text = stripAnsi(data);
      if (text.length > CHUNK_CAP) text = text.slice(0, CHUNK_CAP) + "…[잘림]";
      // 완성된 라인만 처리(미완성 라인은 carry로 이월 → chunk 경계에서 URL 오탐 방지).
      const full = state.carry + text;
      const parts = full.split(/\r?\n/);
      state.carry = parts.pop();
      if (state.carry.length > LINE_CAP) state.carry = state.carry.slice(0, LINE_CAP);
      for (let line of parts) {
        if (line === "") continue;
        if (line.length > LINE_CAP) line = line.slice(0, LINE_CAP) + "…";
        state.buffer.push(line);
        if (state.buffer.length > BUF_CAP) state.buffer.splice(0, state.buffer.length - BUF_CAP);
        if (!state.url) { const m = line.match(URL_RE); if (m) { const u = m[1].replace(/[.,)\]]+$/, ""); state.url = u; emit({ type: "run-url", cwd, url: u, local: isLocalUrl(u), script }); } }
      }
      emit({ type: "run-output", cwd, data: text, stream });
    };
    proc.stdout && proc.stdout.on("data", (d) => handle(d, "stdout"));
    proc.stderr && proc.stderr.on("data", (d) => handle(d, "stderr"));
    proc.on("error", (e) => { const m = "[실행 오류] " + (e.message || e); state.buffer.push(m); state.running = false; this.persistPids(); emit({ type: "run-output", cwd, data: m + "\n", stream: "stderr" }); emit({ type: "run-exit", cwd, code: null, signal: null, error: String(e.message || e), script }); });
    proc.on("exit", (code, signal) => { state.running = false; state.exitCode = code; this.persistPids(); emit({ type: "run-exit", cwd, code, signal, script }); });
    emit({ type: "run-started", cwd, script, pkgmgr: info.pkgmgr, pid: proc.pid });
    return { ok: true, pid: proc.pid, script, pkgmgr: info.pkgmgr };
  }
  stop(cwd) {
    const r = this.runs.get(cwd);
    if (!r || !r.running) return { ok: false, error: "실행 중 아님" };
    const pid = r.pid;
    try { process.kill(-pid, "SIGTERM"); } catch { try { r.proc.kill("SIGTERM"); } catch {} }
    // 그룹이 여전히 살아있으면(자식이 TERM 무시) 강제 종료한다. 리더 exit 상태가 아니라 그룹 존재로 판정한다.
    setTimeout(() => { try { process.kill(-pid, 0); process.kill(-pid, "SIGKILL"); } catch {} this.persistPids(); }, 4000);
    return { ok: true };
  }
  stopAll() { for (const cwd of this.runs.keys()) { try { this.stop(cwd); } catch {} } }
}
