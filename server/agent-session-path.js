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
  if (options.roots) return options.roots; // 호출자가 한 번 구해 수천 파일에 재사용
  return {
    claude: real(options.claudeRoot || claudeHome("projects")),
    codex: real(options.codexRoot || codexHome("sessions")),
    state: real(options.stateDir || stateHome()),
  };
}

// 색인처럼 수천 파일을 매 재계산마다 검사하는 호출자가 세 루트의 realpath 를 한 번만 구하게 한다.
export function sessionPathRoots(options = {}) { return roots(options); }

// file 은 이미 realpath 가 확정된 일반 파일. 루트 안인지만 본다.
export function validateResolvedAgentSessionPath(agent, file, options = {}) {
  if (!["claude", "codex"].includes(agent) || typeof file !== "string") return null;
  const allowed = roots(options);
  return inside(allowed[agent], file) && !inside(allowed.state, file) ? file : null;
}

export function validateAgentSessionPath(agent, value, options = {}) {
  if (typeof value !== "string" || !value.endsWith(".jsonl")) return null;
  const file = validateResolvedAgentSessionPath(agent, real(value), options);
  if (!file) return null;
  try { return fs.statSync(file).isFile() ? file : null; } catch { return null; }
}

// 관제 재계산(4초 주기·herdr 이벤트마다)이 모든 기록 파일에 대해 부르는 함수
// 크기·수정 시각이 같으면 이전 결과 재사용, 읽을 때는 버퍼 재사용과 session_id 줄만 디코딩
// 매번 256KB 를 새로 할당·디코딩하던 때 서버가 분당 수백 MB 를 할당해 힙이 GB 단위로 커짐
const tailBuffer = Buffer.allocUnsafe(SESSION_TAIL_BYTES);
const tailCache = new Map();
// 상한은 기록 파일 수(2026-10 기준 약 3천 개)보다 크게. 넘치면 전체 재읽기가 매 재계산마다 반복
const TAIL_CACHE_LIMIT = 20000;
const NEWLINE = 0x0a;

export function sessionIdsFromTranscriptTail(file) {
  let fd;
  try {
    // 바뀌지 않은 파일은 stat 한 번으로 끝낸다. 열고 fstat 하고 닫는 세 호출을 수천 파일에 반복하면
    // 재계산 한 회차가 수백 ms 동안 이벤트 루프를 막는다.
    const st = fs.statSync(file);
    const cached = tailCache.get(file);
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return new Set(cached.ids);
    fd = fs.openSync(file, "r");
    const { size, mtimeMs } = fs.fstatSync(fd);
    const start = Math.max(0, size - SESSION_TAIL_BYTES);
    const view = tailBuffer.subarray(0, fs.readSync(fd, tailBuffer, 0, size - start, start));
    const ids = new Set();
    // 중간부터 읽었으면 잘린 첫 줄 제외
    let pos = 0;
    if (start > 0) {
      const first = view.indexOf(NEWLINE);
      pos = first < 0 ? view.length : first + 1;
    }
    while (pos < view.length) {
      const hit = view.indexOf("session_id", pos);
      if (hit < 0) break;
      const lineStart = Math.max(pos, view.lastIndexOf(NEWLINE, hit) + 1);
      const newline = view.indexOf(NEWLINE, hit);
      const lineEnd = newline < 0 ? view.length : newline;
      try {
        const value = JSON.parse(view.toString("utf8", lineStart, lineEnd))?.session_id;
        if (typeof value === "string" && value) ids.add(value);
      } catch {}
      pos = lineEnd + 1;
    }
    if (tailCache.size >= TAIL_CACHE_LIMIT) tailCache.delete(tailCache.keys().next().value);
    tailCache.set(file, { size, mtimeMs, ids });
    return new Set(ids);
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
