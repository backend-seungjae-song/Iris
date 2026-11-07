// 에이전트 채팅 보기의 서버 쪽. pane 이나 서브에이전트 하나의 대화 기록 파일을 찾아 끝에서부터
// 보내고, 파일이 늘어나면 늘어난 만큼 이어 보낸다. 화면은 Paseo 대화 화면 빌드(paseo-ui)가 그린다.
//
// 소유 범위
//   agentchat.* WebSocket 메시지, 연결별 구독, 기록 파일 찾기와 경로 확인, 감시(fs.watch + 1초 stat),
//   대화 속 이미지 제공(GET /agentchat-image · /agentchat-file).
//
// 제공 API
//   initAgentChat(ctx) · handleAgentChat(ws, msg) · agentChatOnConnect(ws) · resolveSubagentFile(...) ·
//   stopAgentChat() · handleAgentChatImage(req, res) · handleAgentChatFile(req, res).
//
// 의존 대상
//   runtime-state 의 관제 상태(pane → 에이전트 종류·세션 UUID), join 의 세션 색인, codex-session 의
//   rollout 찾기, agent-chat-transcript 의 해석·읽기, paseo-ui 의 화면 빌드 상태.
//
// 유지 조건
//   파일 경로를 창에서 받지 않는다. 창은 paneId 와 서브에이전트 id 만 보내고, 서버가 그 값으로 경로를
//   만든 뒤 realpath 가 Claude·Codex 기록 폴더 안인지 확인한다. 경로를 받으면 이 메시지가 임의
//   파일 읽기 통로가 된다. 터미널과 같은 이유로 로컬 연결만 받는다.
//   fs.watch 는 이벤트를 놓치거나 겹쳐 보내므로 앞당기는 데만 쓰고, 1초 stat 이 도착을 보장한다.
//   이미지 경로는 같은 출처(Sec-Fetch-Site: same-origin)의 로컬 요청만 받는다. 다른 로컬 페이지가
//   <img> 로 파일을 불러오지 못하게 한다. /agentchat-file 은 이미지 확장자·크기 제한 안에서만 읽는다.
//
// 영향 범위
//   server/capabilities.js 의 agentchat 줄이 부른다. 창 쪽 짝은 web/js/agentchat/boot.js.
//   현재 목록 확인: node bin/importers.mjs server/agent-chat.js
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { claudeHome, codexHome } from "./agent-homes.js";
import { indexProjects } from "./join.js";
import { resolveCodexSession } from "./codex-session.js";
import { snapshot } from "./runtime-state.js";
import { LIMITS, completeEnd, readForward, readTailWindow } from "./agent-chat-transcript.js";
import { isLoopbackRequest } from "./http-handler.js";
import { listCommands, suggestFiles } from "./agent-chat-tools.js";
import { TASK_ID_RE, claudeTmpRoot, emptyTaskIndex, readTaskOutput, scanTaskFile, taskList, taskOutputSize, taskTail, tasksDirFor } from "./agent-chat-tasks.js";
import { claudeFooter, claudeMeta, codexConfiguredModel, codexMeta, codexModelsFromCache } from "./agent-chat-meta.js";
import { clearKeys, terminalDraft } from "./agent-chat-draft.js";
import { optionLabel, pendingQuestion, questionAnswers, questionKeys, reviewKeys, showsQuestion } from "./agent-chat-question.js";
export { optionLabel };
// 권한·질문 화면 해석은 폰 기능의 것을 그대로 씀(같은 화면, 같은 판정)
import { extractPrompt } from "./remote/features/prompts.js";
import { terminalSelection } from "./remote/features/terminal.js";
import { initPaseoUi, paseoUiStatus, reportPaseoUiBroken, requestPaseoUi, stopPaseoUi } from "./paseo-ui/index.js";
import { IMAGE_TYPES } from "./paseo-ui/plan.js";

const POLL_MS = 1000;
const WATCH_DEBOUNCE_MS = 40;
const WATCH_MAX_WAIT_MS = 250;
const RESOLVE_EVERY_MS = 5000;
const MISSING_BACKOFF = [500, 1000, 2000, 5000];
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_IMAGE_LINE = 64 * 1024 * 1024;
const MAX_IMAGE_FILE = 30 * 1024 * 1024;
const ENTER_DELAY_MS = 500;
const CLEAR_DELAY_MS = 150;
const MAX_UPLOAD = 30 * 1024 * 1024;
const UPLOAD_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const { stateHome } = createRequire(import.meta.url)("./state-home.cjs");
const MAX_SEND_TEXT = 200 * 1024;
const META_EVERY_MS = 2000;           // 기록 꼬리·화면 읽기 간격. herdr 호출 하나가 100ms 안팎
const META_TAIL_BYTES = 1024 * 1024;  // 지금 값은 기록 끝 쪽에 있음. 처음 열 때만 이만큼 읽음
const MODE_MAX_STEPS = 6;             // Shift+Tab 으로 모드를 도는 최대 횟수

let herdr = null;
const subsByWs = new Map();   // ws → Map(key → sub)
const sendQueues = new Map(); // paneId → Promise. 같은 pane 에 보내는 글이 섞이지 않게 차례로

export function initAgentChat(ctx) {
  herdr = ctx.herdr || null;
  // paseoUi: false — 화면 빌드 관리를 켜지 않음(테스트). 켜면 상태 폴더를 정리하고 네트워크로 빌드함
  if (ctx.paseoUi !== false) initPaseoUi({ onStatus: (st) => ctx.broadcastLocal?.({ type: "agentchat.ui", ...st }) });
  ctx.onShutdown?.(() => { stopAgentChat(); });
}

export function stopAgentChat() {
  stopPaseoUi();
  for (const ws of [...subsByWs.keys()]) dropAll(ws);
}

// 재연결한 창은 구독을 다시 보내야 한다. 서버는 연결이 끊기면 구독을 모두 버린다.
export function agentChatOnConnect(ws) {
  if (!ws._local) return;
  send(ws, { type: "agentchat.hello" });
  send(ws, { type: "agentchat.ui", ...paseoUiStatus() });
}

function send(ws, obj) {
  if (ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch {} }
}

export function handleAgentChat(ws, msg) {
  if (!msg.type.startsWith("agentchat.")) return false;
  if (!ws._local) { send(ws, { type: "agentchat.frame", key: String(msg.key || ""), kind: "error", reason: "원격 연결에서는 대화 기록을 열 수 없습니다" }); return true; }
  const key = typeof msg.key === "string" ? msg.key.slice(0, 200) : "";
  if (!key) return true;
  if (msg.type === "agentchat.open") { requestPaseoUi(); open(ws, key, msg); }
  else if (msg.type === "agentchat.close") drop(ws, key);
  else if (msg.type === "agentchat.older") older(ws, key);
  else if (msg.type === "agentchat.send") sendToPane(ws, key, msg);
  else if (msg.type === "agentchat.cancel") cancelPane(ws, key);
  else if (msg.type === "agentchat.commands" || msg.type === "agentchat.files") inputTools(ws, key, msg);
  else if (msg.type === "agentchat.answer") answerPrompt(ws, key, msg);
  else if (msg.type === "agentchat.mode") setMode(ws, key, msg);
  else if (msg.type === "agentchat.taskread") readTask(ws, key, msg);
  else if (msg.type === "agentchat.ui-broken" && typeof msg.build === "string") reportPaseoUiBroken(msg.build.slice(0, 100), String(msg.reason || ""));
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
    nextResolve: 0, pollTimer: null, watcher: null, watchTimer: null, watchSince: 0, busy: false, closed: false,
    meta: null, metaEnd: 0, metaAt: 0, metaSent: "", prompt: null, promptGen: 0, screen: null };
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
  // 기록을 처음부터 다시 그리면 메타도 새 파일 끝에서 다시 읽음. 다른 세션 파일로 바뀐 뒤 이전 모델·사용량이 남지 않게
  sub.meta = null; sub.metaEnd = 0; sub.metaAt = 0;
  withFd(sub.file, (fd, st) => {
    const src = fileSource(fd, st.size);
    const end = completeEnd(src);
    const win = readTailWindow(src, { end, want: LIMITS.initial, kind: sub.kind });
    sub.ino = st.ino; sub.start = win.start; sub.end = end;
    send(sub.ws, { type: "agentchat.frame", key: sub.key, kind, messages: win.messages, hasOlder: win.hasOlder,
      source: sub.kind, file: path.basename(sub.file), gen: String(st.ino) });
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
        // 모델·사용량·Codex 모델 목록도 바로. 다음 주기까지 기다리면 입력창 모델 칸이 빈 채로 보임
        await refreshMeta(sub, true);
        await refreshTasks(sub);
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
    await refreshMeta(sub);
    await refreshTasks(sub);
    schedule(sub, POLL_MS);
  } catch (e) {
    send(sub.ws, { type: "agentchat.frame", key: sub.key, kind: "error", reason: String(e?.message || e) });
    schedule(sub, MISSING_BACKOFF[MISSING_BACKOFF.length - 1]);
  } finally {
    sub.busy = false;
  }
}

// ── 백그라운드 셸·Monitor(agent-chat-tasks.js) ──
// - 목록은 바뀐 때만 보냄. 출력 끝(tail)은 크기·상태가 바뀐 작업만 넣음(창이 이전 것을 유지)
// - 기록 파일이 바뀌면(세션 바뀜·다시 씀) 색인을 새로 만들고 reset 으로 알림
async function refreshTasks(sub) {
  if (sub.kind !== "claude" || !sub.file) return;
  let t = sub.tasks;
  if (!t || t.file !== sub.file || t.ino !== sub.ino || t.index.offset > sub.end) {
    let projects = null;
    try { projects = fs.realpathSync(claudeHome("projects")); } catch {}
    const tmp = claudeTmpRoot();
    t = sub.tasks = { file: sub.file, ino: sub.ino, index: emptyTaskIndex(), sizes: new Map(), sent: false,
      dir: projects && tmp ? tasksDirFor(sub.file, projects, tmp) : null };
  }
  await scanTaskFile(t.index, sub.file, sub.end);
  if (sub.closed || sub.tasks !== t) return;
  const list = taskList(t.index, Date.now());
  let changed = !t.sent;
  const out = list.map((task) => {
    const prev = t.sizes.get(task.id);
    const size = !prev || task.status === "running" || prev.status !== task.status ? taskOutputSize(t.dir, task.id) : prev.size;
    t.sizes.set(task.id, { size, status: task.status });
    if (prev && prev.size === size && prev.status === task.status) return { ...task, size };
    changed = true;
    const tl = size != null ? taskTail(t.dir, task.id) : null;
    return { ...task, size, tail: tl?.tail ?? "", cut: !!tl?.cut };
  });
  if (!changed && t.count === list.length) return;
  t.count = list.length;
  send(sub.ws, { type: "agentchat.tasks", key: sub.key, reset: !t.sent, tasks: out });
  t.sent = true;
}

function readTask(ws, key, msg) {
  const sub = subsByWs.get(ws)?.get(key);
  const id = msg.id ?? null;
  const taskId = String(msg.taskId || "");
  const reply = (body) => send(ws, { type: "agentchat.taskread", key, id, taskId, ...body });
  if (!sub?.tasks || !TASK_ID_RE.test(taskId) || !sub.tasks.index.tasks.has(taskId)) { reply({ error: "이 대화의 작업이 아닙니다" }); return; }
  const from = Number.isInteger(msg.from) ? msg.from : null;
  const r = readTaskOutput(sub.tasks.dir, taskId, from);
  reply(r || { error: "출력 파일이 없습니다(Claude Code 가 지웠거나 다른 기기의 작업)" });
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

// ── 입력 ────────────────────────────────────────────────────────────────────
// 보낼 글 → pane 입력 조각. 입력 칸을 다 비우고, 여러 줄은 bracketed paste 로 감싸 한 번에 받게 함
// - lines: 지금 입력 칸의 화면 줄 수(모르면 null)
// - Enter 는 붙여넣기가 끝난 뒤 따로. 붙여 보내면 붙여넣기 도중에 제출됨
// - 글 끝이 @경로면 공백 하나 더함. 커서가 @ 낱말 안에 있으면 Claude Code 파일 자동완성이 Enter 를 받아 제출되지 않음
export function inputChunks(text, lines = null) {
  let body = String(text).replace(/\r\n?/g, "\n");
  if (/(^|\s)@\S+$/.test(body)) body += " ";
  const payload = body.includes("\n") ? `\x1b[200~${body}\x1b[201~` : body;
  return [clearKeys(lines), payload, "\r"];
}

// 지움으로 내용이 사라지는 입력 칸. 대화 화면 입력창에 다 옮겨지지 않은 글
export function draftBlockReason(draft) {
  if (draft?.pasted) return "터미널 입력줄에 붙여 넣은 덩어리가 있어 여기서 보내면 그 내용이 빠집니다. 터미널에서 보내거나 지운 뒤 다시 보내 주세요";
  if (draft?.cut) return "터미널 입력줄 글이 길어 화면에 다 보이지 않습니다. 터미널에서 보내거나 지운 뒤 다시 보내 주세요";
  return "";
}

// 화면에서 읽은 입력 칸 글. 입력 칸이 안 보이면(질문 화면 등) null
async function readDraft(paneId, kind) {
  const value = await herdr.paneRead(paneId, "visible", "ansi", false);
  return terminalDraft(String(value?.text ?? (typeof value === "string" ? value : "")), kind);
}

// Claude 서브에이전트에 보낼 글을 부모 에이전트에게 전달 부탁으로 감쌈
// - Claude Code 는 실행 중 서브에이전트에 직접 입력할 길이 없고 부모의 SendMessage 로만 전달됨
export function subagentRelayText({ agentId, description = "", text }) {
  const name = description ? `${agentId}(${description})` : agentId;
  return `서브에이전트 ${name}에게 SendMessage 로 아래 글을 그대로 전달해 주세요.\n\n${text}`;
}

function findSubagent(list, agentId) {
  for (const s of Array.isArray(list) ? list : []) {
    if (String(s?.agentId) === agentId) return s;
    const hit = findSubagent(s?.children, agentId);
    if (hit) return hit;
  }
  return null;
}

// agentchat.send { key, text } — 그 구독의 pane 으로 보냄. 창이 보고 있는 pane 과 관계없이 구독할 때 정한 pane 에 고정
// - 서브에이전트 보기는 부모 pane 에 전달 부탁으로 보냄
function sendToPane(ws, key, msg) {
  const sub = subsByWs.get(ws)?.get(key);
  const raw = typeof msg.text === "string" ? msg.text : "";
  const reply = (ok, reason = "") => send(ws, { type: "agentchat.sent", key, id: msg.id ?? null, ok, ...(reason ? { reason } : {}) });
  if (!sub) { reply(false, "보낼 대상이 없습니다"); return; }
  if (!raw.trim() || raw.length > MAX_SEND_TEXT) { reply(false, "보낼 글이 비었거나 너무 깁니다"); return; }
  if (!herdr?.paneSendText) { reply(false, "터미널에 연결되지 않았습니다"); return; }
  const text = sub.agentId
    ? subagentRelayText({ agentId: sub.agentId, description: findSubagent(agentOf(sub.paneId)?.subagents, sub.agentId)?.description || "", text: raw })
    : raw;
  const paneId = sub.paneId;
  const kind = sub.kind || kindOf(agentOf(paneId)) || "claude";
  const prev = sendQueues.get(paneId) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    let draft = null;
    try { draft = await readDraft(paneId, kind); } catch {}
    const blocked = draftBlockReason(draft);
    if (blocked) throw new Error(blocked);
    const [clear, payload, enter] = inputChunks(text, draft?.lines ?? null);
    // 지우는 키는 따로. 글과 한 번에 보내면 Claude Code 가 묶음 전체를 붙여넣기로 받아 지우지 않음
    await herdr.paneSendText(paneId, clear);
    await new Promise((r) => setTimeout(r, CLEAR_DELAY_MS));
    await herdr.paneSendText(paneId, payload);
    await new Promise((r) => setTimeout(r, ENTER_DELAY_MS));
    await herdr.paneSendText(paneId, enter);
  });
  sendQueues.set(paneId, next);
  next.then(() => reply(true), (e) => reply(false, String(e?.message || e)))
    .finally(() => { if (sendQueues.get(paneId) === next) sendQueues.delete(paneId); });
}

// 입력창 도구. 작업 폴더는 창이 아니라 서버가 아는 그 pane 의 cwd
// - agentchat.commands { key, id } → { commands }
// - agentchat.files { key, id, query } → { directories, entries }
function inputTools(ws, key, msg) {
  const sub = subsByWs.get(ws)?.get(key);
  const id = msg.id ?? null;
  const agent = sub ? agentOf(sub.paneId) : null;
  const cwd = typeof agent?.cwd === "string" ? agent.cwd : "";
  if (!sub) { send(ws, { type: msg.type, key, id, error: "대상이 없습니다" }); return; }
  if (msg.type === "agentchat.commands") {
    const commands = listCommands(sub.kind || kindOf(agent) || "claude", cwd, { claude: claudeHome(), codex: codexHome() });
    send(ws, { type: msg.type, key, id, commands });
    return;
  }
  const query = typeof msg.query === "string" ? msg.query.slice(0, 200) : "";
  suggestFiles(cwd, query, 50).then((r) => send(ws, { type: msg.type, key, id, ...r }),
    (e) => send(ws, { type: msg.type, key, id, error: String(e?.message || e) }));
}

// agentchat.cancel { key } — 그 구독의 pane 에 Esc. Claude Code·Codex 모두 Esc 가 진행 중인 차례를 멈춤
function cancelPane(ws, key) {
  const sub = subsByWs.get(ws)?.get(key);
  if (!sub || sub.agentId || !herdr?.paneSendText) return;
  herdr.paneSendText(sub.paneId, "\x1b").catch(() => {});
}

// ── 입력창 아래 표시값·권한 요청 ────────────────────────────────────────────
// - 지금 모델·effort·모드·컨텍스트 사용량: 기록 꼬리(agent-chat-meta.js). Claude effort·모드는 화면 아래줄이 더 최근
// - 권한·질문: 에이전트가 답을 기다릴 때(herdr blocked) 화면을 읽어 폰 기능과 같은 해석(extractPrompt)
// - 바뀐 것만 agentchat.meta 로 보냄. 서브에이전트 보기는 입력이 없어 보내지 않음

function emptyMeta() { return { model: null, effort: null, mode: null, usage: null }; }

function mergeMeta(base, next) {
  const out = { ...base };
  for (const k of Object.keys(next)) if (next[k] !== null && next[k] !== undefined) out[k] = next[k];
  return out;
}

// [from, size) 의 완전한 줄만 객체로. 처음 열 때는 끝에서 META_TAIL_BYTES 만. end 는 다음에 읽을 줄 시작
export function readRecords(file, from) {
  return withFd(file, (fd, st) => {
    const start = Math.max(from, st.size - META_TAIL_BYTES, 0);
    if (start >= st.size) return { records: [], end: Math.min(from, st.size) };
    const buf = Buffer.alloc(st.size - start);
    const n = fs.readSync(fd, buf, 0, buf.length, start);
    const data = buf.subarray(0, n);
    const skip = start > from ? data.indexOf(10) + 1 : 0;   // 중간에서 시작했으면 잘린 첫 줄 버림
    const last = data.lastIndexOf(10);
    if (skip <= 0 && start > from || last < skip) return { records: [], end: from };
    const records = [];
    for (const line of data.subarray(skip, last).toString("utf8").split("\n")) {
      if (!line) continue;
      try { records.push(JSON.parse(line)); } catch {}
    }
    return { records, end: start + last + 1 };
  });
}

let codexModelsCache = { at: 0, models: null };
function codexModels() {
  if (Date.now() - codexModelsCache.at < 60_000) return codexModelsCache.models;
  let models = null;
  try {
    const cache = JSON.parse(fs.readFileSync(codexHome("models_cache.json"), "utf8"));
    let configured = null;
    try { configured = codexConfiguredModel(fs.readFileSync(codexHome("config.toml"), "utf8")); } catch {}
    models = codexModelsFromCache(cache, configured);
  } catch {}
  codexModelsCache = { at: Date.now(), models };
  return models;
}

async function readScreen(paneId) {
  const value = await herdr.paneRead(paneId, "visible", "text", true);
  const text = String(value?.text ?? (typeof value === "string" ? value : ""));
  let size = null;
  try {
    const result = await herdr.call("pane.layout", { pane_id: paneId });
    const rect = (result?.layout || result)?.panes?.find((p) => p.pane_id === paneId)?.rect;
    if (Number.isSafeInteger(rect?.width) && Number.isSafeInteger(rect?.height)) size = { columns: rect.width, rows: rect.height };
  } catch {}
  const hash = crypto.createHash("sha256").update(JSON.stringify([text, size])).digest("hex");
  return { text, hash, columns: size?.columns ?? 0, rows: size?.rows ?? 0 };
}


async function refreshMeta(sub, force = false) {
  if (sub.agentId || !sub.file || sub.closed) return;
  const now = Date.now();
  if (!force && now - sub.metaAt < META_EVERY_MS) return;
  sub.metaAt = now;
  try {
    const got = readRecords(sub.file, sub.metaEnd);
    if (got) {
      if (got.end < sub.metaEnd) sub.meta = null;   // 파일이 바뀜
      sub.metaEnd = got.end;
      sub.meta = mergeMeta(sub.meta || emptyMeta(), sub.kind === "codex" ? codexMeta(got.records) : claudeMeta(got.records));
    }
  } catch {}
  const agent = agentOf(sub.paneId);
  let prompt = null;
  if (herdr?.paneRead && herdr?.call && agent) {
    const waiting = agent.status === "blocked";
    if (sub.kind === "claude" || waiting) {
      try {
        const frame = await readScreen(sub.paneId);
        if (sub.closed) return;
        sub.screen = frame;
        if (sub.kind === "claude") sub.meta = mergeMeta(sub.meta || emptyMeta(), claudeFooter(frame.text));
        if (waiting) {
          const p = extractPrompt(frame);
          const choices = cardChoices(p);
          const asked = sub.kind === "claude" ? askedQuestion(sub, p) : null;
          if (asked) {
            // AskUserQuestion: 화면 선택지 대신 기록의 질문 그대로(Paseo 질문 카드)
            const id = `question-${asked.toolUseId}`;
            prompt = { id, kind: "question", toolUseId: asked.toolUseId, questions: asked.questions, options: [] };
            sub.prompt = { id, toolUseId: asked.toolUseId, questions: asked.questions };
          } else if (choices.length && isAnsweredLeftover(sub.answered, p, Date.now())) {
            // 답한 질문이 화면에 남은 동안: 카드 없음, 회차도 그대로
          } else if (choices.length) {
            sub.answered = null;
            const id = promptIdOf(sub, p);
            prompt = { id, title: p.title || null, question: p.question, detail: p.detail || null, variant: p.variant || null,
              options: choices.map((o) => ({ row: o.row, text: optionLabel(o.text), role: o.role })), selectedRow: p.selectedRow };
            sub.prompt = { id, choiceRows: choices.map((o) => o.row) };
          }
        }
      } catch {}
    }
  }
  if (!prompt) { if (sub.prompt) sub.promptGen++; sub.prompt = null; }
  // 터미널 입력줄 글. 대화 화면 입력창이 같은 글을 보임. 질문 화면일 때는 입력 칸이 없음
  let draft = null;
  if (herdr?.paneRead && agent && agent.status !== "blocked") {
    try {
      const d = await readDraft(sub.paneId, sub.kind);
      if (sub.closed) return;
      if (d) draft = { text: d.text, pasted: d.pasted, cut: d.cut };
    } catch {}
  }
  // Codex 모델 목록은 Claude 대화에도 실음. 부모가 미리 갖고 있어야 Codex 대화로 처음 바꿀 때 모델 칸이 "오류"가 되지 않음
  const payload = { agent: sub.meta || emptyMeta(), prompt, codexModels: codexModels(), draft };
  const json = JSON.stringify(payload);
  if (json === sub.metaSent) return;
  sub.metaSent = json;
  send(sub.ws, { type: "agentchat.meta", key: sub.key, ...payload });
}

// 기록 끝에서 읽을 크기. AskUserQuestion 호출은 마지막 기록 몇 줄 안에 있음
const QUESTION_TAIL_BYTES = 256 * 1024;
function transcriptTail(file) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - QUESTION_TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    if (start > 0) lines.shift();   // 잘린 첫 줄
    return lines.filter(Boolean);
  } finally { fs.closeSync(fd); }
}

// 지금 화면이 기록의 답 없는 AskUserQuestion 질문(또는 그 확인 화면)이면 그 질문. 이미 답했으면 null
function askedQuestion(sub, p) {
  if (!p || !sub.file) return null;
  let q = null;
  try { q = pendingQuestion(transcriptTail(sub.file)); } catch { return null; }
  if (!q || sub.answeredQuestion === q.toolUseId) return null;
  return p.variant === "review" || q.questions.some((x) => showsQuestion(p, x)) ? q : null;
}

// 권한 카드로 보일 선택지. 여러 개 고르기·직접 입력은 화살표+Enter 로 답할 수 없음 → 카드 없이 터미널 안내만(부모 창 hint)
export function cardChoices(p) {
  return p && !p.multiSelect ? p.options.filter((o) => o.selectable !== false) : [];
}

// 같은 질문이 남아 있는 동안 고정되는 id. 화면 해시(타이머 등)는 넣지 않음
// - 내용(detail)과 회차(promptGen)를 넣음. 문구만 같은 다음 질문이 지난 답을 받거나 답한 것으로 숨지 않게
export function promptIdOf(sub, p) {
  return crypto.createHash("sha256").update(JSON.stringify([sub.paneId, sub.promptGen, promptContent(p)])).digest("hex").slice(0, 24);
}
const promptContent = (p) => [p.title || "", p.question, p.detail || "", p.options.map((o) => o.text)];

// 답을 보낸 직후 터미널이 아직 다시 그리지 않아 화면에 남은 같은 질문. 이 시간 안에는 새 질문으로 보지 않음
// - 답하면서 회차를 올리므로 그냥 두면 같은 질문이 새 id 로 다시 읽혀 카드가 또 뜸
// - 이 시간이 지나도 같은 질문이 있으면 터미널이 다시 물은 것으로 보고 카드를 띄움
export const ANSWER_SETTLE_MS = 4000;
export function isAnsweredLeftover(answered, p, now) {
  return !!answered && now < answered.until && JSON.stringify(promptContent(p)) === answered.content;
}

// agentchat.answer { key, id, promptId, row } — 지금 화면이 그 질문 그대로일 때만 화살표로 옮기고 Enter
function answerPrompt(ws, key, msg) {
  const sub = subsByWs.get(ws)?.get(key);
  const reply = (ok, reason = "") => send(ws, { type: "agentchat.answered", key, id: msg.id ?? null, ok, ...(reason ? { reason } : {}) });
  if (!sub || sub.agentId || !herdr?.paneSendText) { reply(false, "보낼 대상이 없습니다"); return; }
  if (sub.prompt?.questions && sub.prompt.id === msg.promptId) { answerQuestion(sub, msg, reply); return; }
  if (!sub.prompt || sub.prompt.id !== msg.promptId || !sub.prompt.choiceRows.includes(msg.row)) { reply(false, "질문이 이미 바뀌었습니다"); return; }
  const want = sub.prompt;
  const paneId = sub.paneId;
  const prev = sendQueues.get(paneId) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    // 지금 화면의 질문이 사용자가 본 질문과 같을 때만. 질문과 상관없는 화면 변화(진행 표시 등)로는 거절하지 않음
    const frame = await readScreen(paneId);
    const now = extractPrompt(frame);
    if (!cardChoices(now).length || promptIdOf(sub, now) !== want.id) throw new Error("질문이 바뀌어 답하지 않았습니다");
    // 줄 번호는 화면이 스크롤되면 달라지므로 몇 번째 선택지인지로 지금 화면의 줄을 다시 찾음
    const row = cardChoices(now)[want.choiceRows.indexOf(msg.row)]?.row;
    const diff = row == null ? null : terminalSelection(frame.text, row);
    if (diff == null) throw new Error("선택지를 찾지 못했습니다");
    await herdr.paneSendText(paneId, (diff < 0 ? "\x1b[A" : "\x1b[B").repeat(Math.abs(diff)) + "\r");
    return JSON.stringify(promptContent(now));
  });
  sendQueues.set(paneId, next);
  next.then((answered) => {
    if (sub.prompt?.id === want.id) { sub.prompt = null; sub.promptGen++; sub.answered = { content: answered, until: Date.now() + ANSWER_SETTLE_MS }; }
    sub.metaAt = 0; reply(true);
  }, (e) => reply(false, String(e?.message || e)))
    .finally(() => { if (sendQueues.get(paneId) === next) sendQueues.delete(paneId); });
}

// AskUserQuestion 답 { promptId, answers: { [header 또는 질문]: 글 } } 또는 { promptId, dismiss: true }
// - 질문마다 지금 화면이 그 질문일 때만 키를 넣음. 마지막에 확인 화면이 뜨면 Submit answers
const QUESTION_STEP_MS = 150;
const QUESTION_SETTLE_MS = 500;
function answerQuestion(sub, msg, reply) {
  const want = sub.prompt;
  const paneId = sub.paneId;
  const parsed = msg.dismiss ? { answers: null } : questionAnswers(want.questions, msg.answers);
  if (parsed.error) { reply(false, parsed.error); return; }
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const screen = async () => extractPrompt(await readScreen(paneId));
  const prev = sendQueues.get(paneId) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    if (!parsed.answers) { await herdr.paneSendText(paneId, "\x1b"); return; }
    for (const [i, q] of want.questions.entries()) {
      const p = await screen();
      if (!showsQuestion(p, q)) throw new Error(i === 0 ? "질문이 바뀌어 답하지 않았습니다" : "터미널 질문 화면이 예상과 달라 멈췄습니다. 남은 답은 터미널에서 해 주세요");
      const keys = questionKeys(p, q, parsed.answers[i]);
      if (keys.error) throw new Error(keys.error);
      for (const chunk of keys.chunks) { await herdr.paneSendText(paneId, chunk); await pause(QUESTION_STEP_MS); }
      await pause(QUESTION_SETTLE_MS);
    }
    const review = reviewKeys(await screen());
    for (const chunk of review || []) { await herdr.paneSendText(paneId, chunk); await pause(QUESTION_STEP_MS); }
  });
  sendQueues.set(paneId, next);
  next.then(() => {
    sub.answeredQuestion = want.toolUseId;
    if (sub.prompt?.id === want.id) { sub.prompt = null; sub.promptGen++; }
    sub.metaAt = 0; reply(true);
  }, (e) => { sub.metaAt = 0; reply(false, String(e?.message || e)); })
    .finally(() => { if (sendQueues.get(paneId) === next) sendQueues.delete(paneId); });
}

// agentchat.mode { key, id, modeId } — Claude 는 Shift+Tab 으로 돌며 화면 아래줄이 목표 모드가 되면 멈춤
const CLAUDE_MODES = new Set(["default", "acceptEdits", "plan", "auto", "bypassPermissions"]);
function setMode(ws, key, msg) {
  const sub = subsByWs.get(ws)?.get(key);
  const reply = (ok, reason = "") => send(ws, { type: "agentchat.moded", key, id: msg.id ?? null, ok, ...(reason ? { reason } : {}) });
  if (!sub || sub.agentId || !herdr?.paneSendText || !herdr?.paneRead) { reply(false, "보낼 대상이 없습니다"); return; }
  if (sub.kind !== "claude") { reply(false, "Codex 는 터미널에서 바꿔 주세요"); return; }
  const target = String(msg.modeId || "");
  if (!CLAUDE_MODES.has(target)) { reply(false, "알 수 없는 모드입니다"); return; }
  const paneId = sub.paneId;
  const prev = sendQueues.get(paneId) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    for (let step = 0; step <= MODE_MAX_STEPS; step++) {
      const { mode } = claudeFooter((await readScreen(paneId)).text);
      if (mode === target) return;
      if (!mode) throw new Error("터미널 화면에서 지금 모드를 읽지 못했습니다");
      if (step === MODE_MAX_STEPS) break;
      await herdr.paneSendText(paneId, "\x1b[Z");
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error("이 세션에서 고를 수 없는 모드입니다");
  });
  sendQueues.set(paneId, next);
  next.then(() => { sub.metaAt = 0; reply(true); }, (e) => reply(false, String(e?.message || e)))
    .finally(() => { if (sendQueues.get(paneId) === next) sendQueues.delete(paneId); });
}

// ── 대화 속 이미지 ──────────────────────────────────────────────────────────
// - 문서·iframe 으로 여는 요청은 거절. SVG 를 Iris 출처 문서로 열면 스크립트가 Iris API 에 닿음
const IMAGE_DESTS = new Set(["image", "empty"]);
function imageRequestAllowed(req) {
  return isLoopbackRequest(req) && req.headers["sec-fetch-site"] === "same-origin"
    && IMAGE_DESTS.has(String(req.headers["sec-fetch-dest"] || "empty"));
}

// - CSP sandbox: 문서로 열리더라도 스크립트 실행·같은 출처 권한 없음
function sendImage(res, mime, bytes) {
  res.writeHead(200, { "content-type": mime, "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:" });
  res.end(bytes);
}

// 기록 줄 하나에서 i 번째 내용 블록의 이미지 → { mime, bytes } 또는 null
// j 가 있으면 도구 결과 안 이미지: Claude 는 content[i].content[j], Codex 는 payload.output[j]
export function imageFromRecord(rec, i, j = null) {
  const list = Array.isArray(rec?.message?.content) ? rec.message.content
    : Array.isArray(rec?.attachment?.prompt) ? rec.attachment.prompt
      : Array.isArray(rec?.payload?.content) ? rec.payload.content : null;
  const nested = j === null ? null
    : Array.isArray(rec?.payload?.output) ? rec.payload.output
      : Array.isArray(list?.[i]?.content) && list[i].type === "tool_result" ? list[i].content : null;
  const c = j === null ? list?.[i] : nested?.[j];
  if (!c || typeof c !== "object") return null;
  if (c.type === "image" && c.source?.type === "base64" && typeof c.source.data === "string") {
    const mime = String(c.source.media_type || "");
    return Object.values(IMAGE_TYPES).includes(mime) ? { mime, bytes: Buffer.from(c.source.data, "base64") } : null;
  }
  const url = typeof c.image_url === "string" ? c.image_url : typeof c.image_url?.url === "string" ? c.image_url.url : "";
  const m = /^data:(image\/[a-z+.-]+);base64,(.*)$/s.exec(url);
  if (m && Object.values(IMAGE_TYPES).includes(m[1])) return { mime: m[1], bytes: Buffer.from(m[2], "base64") };
  return null;
}

// GET /agentchat-image?pane=&agent=&off=&i=[&f=&g=] — 그 pane 의 기록 파일에서 off 위치 줄만 다시 읽음
// - f(기록 파일 이름)·g(inode)가 있으면 지금 기록 파일과 같을 때만 줌. 세션이 바뀌면 같은 off 가 다른 이미지

export function handleAgentChatImage(req, res) {
  if (!imageRequestAllowed(req)) { res.writeHead(403).end(); return; }
  const q = new URL(req.url, "http://x").searchParams;
  const paneId = String(q.get("pane") || "").slice(0, 100);
  const agentId = q.get("agent") || null;
  const off = Number(q.get("off"));
  const i = Number(q.get("i"));
  const j = q.has("j") ? Number(q.get("j")) : null;
  const wantFile = q.get("f");
  const wantGen = q.get("g");
  if (!paneId || (agentId !== null && !ID_RE.test(agentId)) || !Number.isSafeInteger(off) || off < 0 || !Number.isSafeInteger(i) || i < 0 || i > 1000
    || (j !== null && (!Number.isSafeInteger(j) || j < 0 || j > 1000))) {
    res.writeHead(400).end(); return;
  }
  resolveTarget({ paneId, agentId }).then((hit) => {
    if (!hit.file || (wantFile !== null && path.basename(hit.file) !== wantFile)) { res.writeHead(404).end(); return; }
    const line = withFd(hit.file, (fd, st) => {
      if (off >= st.size || (wantGen !== null && String(st.ino) !== wantGen)) return null;
      const chunks = [];
      let pos = off, total = 0;
      while (total < MAX_IMAGE_LINE) {
        const buf = Buffer.alloc(Math.min(LIMITS.chunk * 16, st.size - pos));
        if (!buf.length) break;
        const n = fs.readSync(fd, buf, 0, buf.length, pos);
        if (n <= 0) break;
        const nl = buf.subarray(0, n).indexOf(10);
        chunks.push(buf.subarray(0, nl < 0 ? n : nl));
        total += nl < 0 ? n : nl;
        if (nl >= 0) break;
        pos += n;
      }
      return Buffer.concat(chunks).toString("utf8");
    });
    let rec = null;
    try { rec = JSON.parse(line || "null"); } catch {}
    const img = imageFromRecord(rec, i, j);
    if (!img) { res.writeHead(404).end(); return; }
    sendImage(res, img.mime, img.bytes);
  }).catch(() => { if (!res.headersSent) res.writeHead(500).end(); });
}

// POST /agentchat-upload?name= — 입력창 첨부 파일. 상태 폴더에 저장하고 경로를 돌려줌. 에이전트는 그 경로를 글로 받음
// - 같은 출처 fetch 만. 30MB 까지. 7일 지난 첨부는 다음 업로드 때 지움
export function uploadName(raw) {
  // 공백도 바꿈. 경로는 보낼 글 끝에 공백으로 이어 붙음
  let base = path.basename(String(raw || "")).replace(/[\u0000-\u001f/\\:*?"<>|\s]/g, "_");
  // 파일 이름 한도는 UTF-8 255바이트. 확장자는 남기고 앞부분을 글자 단위로 줄임
  const ext = /\.[A-Za-z0-9]{1,10}$/.exec(base)?.[0] || "";
  let stem = base.slice(0, base.length - ext.length);
  while (Buffer.byteLength(stem + ext) > 200 && stem.length) stem = [...stem].slice(0, -1).join("");
  base = stem + ext;
  return base && base !== "." && base !== ".." && stem ? base : "file" + ext;
}

export function handleAgentChatUpload(req, res) {
  if (!isLoopbackRequest(req) || req.headers["sec-fetch-site"] !== "same-origin" || String(req.headers["sec-fetch-dest"] || "empty") !== "empty") {
    res.writeHead(403).end(); return;
  }
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_UPLOAD) { res.writeHead(413).end(); req.resume(); return; }
  const name = uploadName(new URL(req.url, "http://x").searchParams.get("name"));
  const chunks = [];
  let size = 0, over = false;
  req.on("data", (c) => { size += c.length; if (size > MAX_UPLOAD) over = true; else chunks.push(c); });
  req.on("error", () => { if (!res.headersSent) res.writeHead(400).end(); });
  req.on("end", () => {
    if (over) { res.writeHead(413).end(); return; }
    try {
      const root = path.join(stateHome(), "agentchat-uploads");
      pruneUploads(root);
      const dir = path.join(root, `${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}`);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, name);
      fs.writeFileSync(file, Buffer.concat(chunks));
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ path: file, size, fileName: name }));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: String(e?.message || e) }));
    }
  });
}

function pruneUploads(root) {
  let names = [];
  try { names = fs.readdirSync(root); } catch { return; }
  const now = Date.now();
  for (const n of names) {
    const t = parseInt(n.split("-")[0], 36);
    if (Number.isFinite(t) && now - t > UPLOAD_KEEP_MS) fs.rmSync(path.join(root, n), { recursive: true, force: true });
  }
}

// GET /agentchat-file?path=&cwd= — 답변 마크다운의 로컬 이미지. 이미지 확장자만, 크기 제한
export function handleAgentChatFile(req, res) {
  if (!imageRequestAllowed(req)) { res.writeHead(403).end(); return; }
  const q = new URL(req.url, "http://x").searchParams;
  const raw = String(q.get("path") || "");
  const cwd = String(q.get("cwd") || "");
  const file = path.isAbsolute(raw) ? raw : (path.isAbsolute(cwd) ? path.join(cwd, raw) : "");
  const mime = IMAGE_TYPES[path.extname(file).toLowerCase()];
  if (!file || !mime || raw.includes("\0")) { res.writeHead(400).end(); return; }
  let real;
  try { real = fs.realpathSync(file); } catch { res.writeHead(404).end(); return; }
  if (IMAGE_TYPES[path.extname(real).toLowerCase()] !== mime) { res.writeHead(400).end(); return; }
  fs.stat(real, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end(); return; }
    if (st.size > MAX_IMAGE_FILE) { res.writeHead(413).end(); return; }
    fs.readFile(real, (e, bytes) => {
      if (e) { res.writeHead(404).end(); return; }
      res.setHeader("x-file-path", encodeURIComponent(real));
      res.setHeader("x-file-mtime", st.mtime.toISOString());
      sendImage(res, mime, bytes);
    });
  });
}
