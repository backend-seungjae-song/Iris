// 에이전트 채팅 보기의 서버 쪽. pane 이나 서브에이전트 하나의 대화 기록 파일을 찾아 끝에서부터
// 보내고, 파일이 늘어나면 늘어난 만큼 이어 보낸다.
//
// 소유 범위
//   agentchat.* WebSocket 메시지, 연결별 구독, 기록 파일 찾기와 경로 확인, 감시(fs.watch + 1초 stat).
//
// 제공 API
//   initAgentChat(ctx) · handleAgentChat(ws, msg) · agentChatOnConnect(ws) · resolveSubagentFile(...).
//
// 의존 대상
//   runtime-state 의 관제 상태(pane → 에이전트 종류·세션 UUID), join 의 세션 색인, codex-session 의
//   rollout 찾기, agent-chat-transcript 의 해석·읽기.
//
// 유지 조건
//   파일 경로를 창에서 받지 않는다. 창은 paneId 와 서브에이전트 id 만 보내고, 서버가 그 값으로 경로를
//   만든 뒤 realpath 가 Claude·Codex 기록 폴더 안인지 확인한다. 경로를 받으면 이 메시지가 임의
//   파일 읽기 통로가 된다. 터미널과 같은 이유로 로컬 연결만 받는다.
//   fs.watch 는 이벤트를 놓치거나 겹쳐 보내므로 앞당기는 데만 쓰고, 1초 stat 이 도착을 보장한다.
//
// 영향 범위
//   server/capabilities.js 의 agentchat 줄이 부른다. 창 쪽 짝은 web/js/agentchat/boot.js.
//   현재 목록 확인: node bin/importers.mjs server/agent-chat.js
import fs from "node:fs";
import path from "node:path";
import { claudeHome, codexHome } from "./agent-homes.js";
import { indexProjects } from "./join.js";
import { resolveCodexSession } from "./codex-session.js";
import { snapshot } from "./runtime-state.js";
import { LIMITS, completeEnd, readForward, readTailWindow } from "./agent-chat-transcript.js";

const POLL_MS = 1000;
const WATCH_DEBOUNCE_MS = 40;
const WATCH_MAX_WAIT_MS = 250;
const RESOLVE_EVERY_MS = 5000;
const MISSING_BACKOFF = [500, 1000, 2000, 5000];
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

let herdr = null;
const subsByWs = new Map();   // ws → Map(key → sub)

export function initAgentChat(ctx) {
  herdr = ctx.herdr || null;
  ctx.onShutdown?.(() => { for (const ws of [...subsByWs.keys()]) dropAll(ws); });
}

// 재연결한 창은 구독을 다시 보내야 한다. 서버는 연결이 끊기면 구독을 모두 버린다.
export function agentChatOnConnect(ws) {
  if (ws._local) send(ws, { type: "agentchat.hello" });
}

function send(ws, obj) {
  if (ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch {} }
}

export function handleAgentChat(ws, msg) {
  if (!msg.type.startsWith("agentchat.")) return false;
  if (!ws._local) { send(ws, { type: "agentchat.frame", key: String(msg.key || ""), kind: "error", reason: "원격 연결에서는 대화 기록을 열 수 없습니다" }); return true; }
  const key = typeof msg.key === "string" ? msg.key.slice(0, 200) : "";
  if (!key) return true;
  if (msg.type === "agentchat.open") open(ws, key, msg);
  else if (msg.type === "agentchat.close") drop(ws, key);
  else if (msg.type === "agentchat.older") older(ws, key);
  return true;
}

function agentOf(paneId) {
  return (snapshot().state || []).find((a) => a.paneId === paneId) || null;
}

function kindOf(agent) {
  const name = String(agent?.agent || "").toLowerCase();
  if (name === "claude" || name.startsWith("claude")) return "claude";
  if (name === "codex" || name.startsWith("codex")) return "codex";
  return null;
}

function inside(root, file) {
  try {
    const realRoot = fs.realpathSync(root);
    const real = fs.realpathSync(file);
    return real.startsWith(realRoot + path.sep) ? real : null;
  } catch { return null; }
}

function claudeSessionRec(uuid) {
  if (!uuid || !ID_RE.test(uuid)) return null;
  return indexProjects().get(uuid) || null;
}

// 부모 세션 UUID 와 서브에이전트 id 로 기록 파일을 만든다. 중첩 서브에이전트도 같은 폴더에 있다.
export function resolveSubagentFile(rec, agentId, projectsRoot = claudeHome("projects")) {
  if (!rec || !ID_RE.test(String(agentId || ""))) return null;
  const sessionDir = rec.dir || (rec.file ? rec.file.replace(/\.jsonl$/, "") : null);
  if (!sessionDir) return null;
  return inside(projectsRoot, path.join(sessionDir, "subagents", `agent-${agentId}.jsonl`));
}

// 구독 대상 → { file, kind } 또는 { reason }.
async function resolveTarget(sub) {
  const agent = agentOf(sub.paneId);
  if (!agent) return { reason: "이 pane 을 herdr 목록에서 찾지 못했습니다" };
  const kind = kindOf(agent);
  // 세션 id 가 그대로면 찾은 파일도 그대로다. 색인(모든 프로젝트 폴더 읽기)을 5초마다 다시 만들지 않는다.
  if (kind === "claude" && sub.file && sub.uuid === agent.sessionUuid) return { file: sub.file, kind };
  sub.uuid = agent.sessionUuid || null;
  if (sub.agentId) {
    if (kind !== "claude") return { reason: "서브에이전트 기록은 Claude Code 세션에만 있습니다" };
    const rec = claudeSessionRec(agent.sessionUuid);
    if (!rec) return { reason: "부모 세션의 기록 폴더를 찾지 못했습니다" };
    const file = resolveSubagentFile(rec, sub.agentId);
    return file ? { file, kind: "claude" } : { reason: "서브에이전트 기록 파일이 아직 없습니다" };
  }
  if (kind === "claude") {
    if (!agent.sessionUuid) return { reason: "herdr 가 이 Claude 세션의 id 를 아직 알려 주지 않았습니다" };
    const rec = claudeSessionRec(agent.sessionUuid);
    const file = rec?.file ? inside(claudeHome("projects"), rec.file) : null;
    return file ? { file, kind } : { reason: "세션 기록 파일이 아직 없습니다(첫 메시지를 보내면 생깁니다)" };
  }
  if (kind === "codex") {
    let file = agent.sessionFile || null;
    if (!file && herdr) file = (await resolveCodexSession(herdr, sub.paneId))?.file || null;
    file = file ? inside(codexHome("sessions"), file) : null;
    return file ? { file, kind } : { reason: "이 pane 에서 실행 중인 Codex 의 rollout 파일을 찾지 못했습니다" };
  }
  return { reason: "Claude Code·Codex pane 만 채팅으로 볼 수 있습니다" };
}

function fileSource(fd, size) {
  return { size, readAt: (buf, pos) => fs.readSync(fd, buf, 0, buf.length, pos) };
}

function withFd(file, fn) {
  const fd = fs.openSync(file, "r");
  try { return fn(fd, fs.fstatSync(fd)); } finally { fs.closeSync(fd); }
}

function open(ws, key, msg) {
  const paneId = typeof msg.paneId === "string" ? msg.paneId.slice(0, 100) : "";
  const agentId = msg.agentId == null ? null : String(msg.agentId);
  if (!paneId || (agentId !== null && !ID_RE.test(agentId))) {
    send(ws, { type: "agentchat.frame", key, kind: "error", reason: "잘못된 요청입니다" });
    return;
  }
  drop(ws, key);
  let subs = subsByWs.get(ws);
  if (!subs) {
    subs = new Map();
    subsByWs.set(ws, subs);
    ws.once?.("close", () => dropAll(ws));
  }
  const sub = { ws, key, paneId, agentId, file: null, kind: null, ino: 0, start: 0, end: 0, missing: 0,
    nextResolve: 0, pollTimer: null, watcher: null, watchTimer: null, watchSince: 0, busy: false, closed: false };
  subs.set(key, sub);
  tick(sub);
}

function drop(ws, key) {
  const subs = subsByWs.get(ws);
  const sub = subs?.get(key);
  if (!sub) return;
  sub.closed = true;
  clearTimeout(sub.pollTimer);
  clearTimeout(sub.watchTimer);
  try { sub.watcher?.close(); } catch {}
  subs.delete(key);
}

function dropAll(ws) {
  const subs = subsByWs.get(ws);
  if (!subs) return;
  for (const key of [...subs.keys()]) drop(ws, key);
  subsByWs.delete(ws);
}

function schedule(sub, ms) {
  if (sub.closed) return;
  clearTimeout(sub.pollTimer);
  sub.pollTimer = setTimeout(() => tick(sub), ms);
  sub.pollTimer.unref?.();   // 구독 하나가 프로세스를 붙들지 않게 한다(서버는 HTTP 가 붙든다)
}

function watchFile(sub) {
  try { sub.watcher?.close(); } catch {}
  sub.watcher = null;
  try {
    sub.watcher = fs.watch(sub.file, () => {
      const now = Date.now();
      if (!sub.watchSince) sub.watchSince = now;
      clearTimeout(sub.watchTimer);
      const wait = Math.max(0, Math.min(WATCH_DEBOUNCE_MS, WATCH_MAX_WAIT_MS - (now - sub.watchSince)));
      sub.watchTimer = setTimeout(() => { sub.watchSince = 0; tick(sub); }, wait);
    });
    sub.watcher.on?.("error", () => {});
  } catch { sub.watcher = null; }
}

function snapshotFrame(sub, kind) {
  withFd(sub.file, (fd, st) => {
    const src = fileSource(fd, st.size);
    const end = completeEnd(src);
    const win = readTailWindow(src, { end, want: LIMITS.initial, kind: sub.kind });
    sub.ino = st.ino; sub.start = win.start; sub.end = end;
    send(sub.ws, { type: "agentchat.frame", key: sub.key, kind, messages: win.messages, hasOlder: win.hasOlder,
      source: sub.kind, file: path.basename(sub.file) });
  });
}

async function tick(sub) {
  if (sub.closed || sub.busy) return;
  sub.busy = true;
  try {
    const now = Date.now();
    if (!sub.file || now >= sub.nextResolve) {
      sub.nextResolve = now + RESOLVE_EVERY_MS;
      const hit = await resolveTarget(sub);
      if (sub.closed) return;
      if (!hit.file) {
        if (sub.file || sub.missing === 0) send(sub.ws, { type: "agentchat.frame", key: sub.key, kind: "missing", reason: hit.reason });
        sub.file = null;
        sub.missing++;
        schedule(sub, MISSING_BACKOFF[Math.min(sub.missing - 1, MISSING_BACKOFF.length - 1)]);
        return;
      }
      if (hit.file !== sub.file) {
        const first = !sub.file;
        sub.file = hit.file; sub.kind = hit.kind; sub.missing = 0;
        watchFile(sub);
        snapshotFrame(sub, first ? "snapshot" : "replacement");
        schedule(sub, POLL_MS);
        return;
      }
    }
    let st;
    try { st = fs.statSync(sub.file); } catch {
      sub.file = null; sub.nextResolve = 0;
      schedule(sub, MISSING_BACKOFF[0]);
      return;
    }
    if (st.ino !== sub.ino || st.size < sub.end) snapshotFrame(sub, "replacement");
    else if (st.size > sub.end) {
      withFd(sub.file, (fd, cur) => {
        const got = readForward(fileSource(fd, cur.size), sub.end, sub.kind);
        if (got.end === sub.end) return;
        sub.end = got.end;
        if (got.messages.length > LIMITS.append) {
          snapshotFrame(sub, "replacement");   // 한꺼번에 많이 쌓였으면 처음부터 다시 그리는 편이 싸다
          return;
        }
        if (got.messages.length) send(sub.ws, { type: "agentchat.frame", key: sub.key, kind: "append", messages: got.messages });
      });
    }
    schedule(sub, POLL_MS);
  } catch (e) {
    send(sub.ws, { type: "agentchat.frame", key: sub.key, kind: "error", reason: String(e?.message || e) });
    schedule(sub, MISSING_BACKOFF[MISSING_BACKOFF.length - 1]);
  } finally {
    sub.busy = false;
  }
}

function older(ws, key) {
  const sub = subsByWs.get(ws)?.get(key);
  if (!sub || !sub.file || sub.start <= 0) {
    send(ws, { type: "agentchat.older", key, messages: [], hasOlder: false });
    return;
  }
  try {
    withFd(sub.file, (fd, st) => {
      const win = readTailWindow(fileSource(fd, st.size), { end: sub.start, want: LIMITS.older, kind: sub.kind });
      sub.start = win.start;
      send(ws, { type: "agentchat.older", key, messages: win.messages, hasOlder: win.hasOlder });
    });
  } catch (e) {
    send(ws, { type: "agentchat.older", key, messages: [], hasOlder: false, reason: String(e?.message || e) });
  }
}
