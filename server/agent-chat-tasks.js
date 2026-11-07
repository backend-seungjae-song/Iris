// 대화 화면의 백그라운드 셸·Monitor 목록과 출력(터미널 Claude Code 의 백그라운드 작업 창과 같은 내용)
// - 목록: 기록 파일의 시작 줄(Bash 백그라운드 결과 backgroundTaskId·Monitor 결과 taskId)과 끝 줄(<task-notification> 상태·TaskStop 결과)
// - 출력: Claude Code 가 쓰는 <임시 폴더>/claude-<uid>/<프로젝트 폴더>/<세션>/tasks/<id>.output
// - 경로는 기록 파일 경로와 작업 id 로만 만듦. 창에서 경로를 받지 않음
// - 서브에이전트 출력(.output 이 기록 파일로 가는 심볼릭 링크)은 대상 아님. 서브에이전트 대화 보기가 따로 있음
import fs from "node:fs";
import path from "node:path";

export const TASK_ID_RE = /^[a-z0-9]{6,24}$/;
const END_STATUS = new Set(["completed", "failed", "killed", "stopped"]);
const CMD_MAX = 2000;
const DESC_MAX = 300;
const SUMMARY_MAX = 300;
const LIST_MAX = 100;
const SCAN_CHUNK = 8 * 1024 * 1024;   // 이보다 긴 줄(이미지 등)은 건너뜀. 작업 기록 줄은 짧음
export const TAIL_BYTES = 4096;
export const READ_MAX = 512 * 1024;

export function emptyTaskIndex() {
  return { offset: 0, calls: new Map(), tasks: new Map(), ends: new Map() };
}

function str(v, max) { return typeof v === "string" ? v.slice(0, max) : ""; }
function time(v) { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }

// 사용자 줄에서 알림 글만(도구 결과 안의 글은 빼고: 기록을 grep 한 출력에도 같은 태그가 있음)
function noticeTexts(rec) {
  const out = [];
  if (rec.type === "user") {
    const c = rec.message?.content;
    if (typeof c === "string") out.push(c);
    else if (Array.isArray(c)) for (const b of c) if (b?.type === "text" && typeof b.text === "string") out.push(b.text);
  } else if (rec.type === "attachment" && typeof rec.attachment?.prompt === "string") out.push(rec.attachment.prompt);
  return out;
}

const NOTICE_RE = /<task-notification>([\s\S]*?)<\/task-notification>/g;
function tag(body, name) {
  const m = body.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1].trim() : "";
}

// 기록 한 줄 → 색인 갱신. 키 글자가 없으면 JSON 해석도 하지 않음
export function scanTaskLine(index, line) {
  const call = line.includes('"name":"Bash"') || line.includes('"name":"Monitor"');
  const start = line.includes('"backgroundTaskId"') || line.includes('"taskId"');
  const notice = line.includes("<task-notification>");
  const stop = line.includes("Successfully stopped task");
  if (!call && !start && !notice && !stop) return;
  let rec;
  try { rec = JSON.parse(line); } catch { return; }
  if (!rec || typeof rec !== "object") return;
  const ts = time(rec.timestamp);
  if (call && rec.type === "assistant" && Array.isArray(rec.message?.content)) {
    for (const b of rec.message.content) {
      if (b?.type !== "tool_use" || typeof b.id !== "string" || (b.name !== "Bash" && b.name !== "Monitor")) continue;
      const input = b.input && typeof b.input === "object" ? b.input : {};
      index.calls.set(b.id, { name: b.name, command: str(input.command, CMD_MAX), description: str(input.description, DESC_MAX) });
    }
  }
  if (rec.type === "user" && Array.isArray(rec.message?.content)) {
    const tur = rec.toolUseResult && typeof rec.toolUseResult === "object" ? rec.toolUseResult : null;
    const result = rec.message.content.find((b) => b?.type === "tool_result" && typeof b.tool_use_id === "string");
    if (start && tur && result) {
      const id = typeof tur.backgroundTaskId === "string" ? tur.backgroundTaskId : typeof tur.taskId === "string" ? tur.taskId : "";
      const c = index.calls.get(result.tool_use_id);
      if (TASK_ID_RE.test(id) && c) {
        index.tasks.set(id, {
          id, toolUseId: result.tool_use_id, kind: c.name === "Monitor" ? "monitor" : "shell",
          command: c.command, description: c.description, startedAt: ts,
          timeoutMs: c.name === "Monitor" && Number.isFinite(tur.timeoutMs) ? tur.timeoutMs : null,
          persistent: tur.persistent === true,
        });
      }
    }
    if (stop && tur && typeof tur.task_id === "string" && TASK_ID_RE.test(tur.task_id) && !index.ends.has(tur.task_id)) {
      index.ends.set(tur.task_id, { status: "stopped", summary: "", at: ts });
    }
  }
  if (notice) {
    for (const text of noticeTexts(rec)) {
      for (const m of text.matchAll(NOTICE_RE)) {
        const id = tag(m[1], "task-id");
        const status = tag(m[1], "status");
        if (!TASK_ID_RE.test(id) || !END_STATUS.has(status)) continue;
        index.ends.set(id, { status, summary: tag(m[1], "summary").slice(0, SUMMARY_MAX), at: ts });
      }
    }
  }
}

// 버퍼의 완전한 줄만 읽고 마지막 줄바꿈 다음 위치를 돌려줌
export function scanTaskBuffer(index, buf) {
  let at = 0;
  for (;;) {
    const nl = buf.indexOf(10, at);
    if (nl < 0) return at;
    scanTaskLine(index, buf.toString("utf8", at, nl));
    at = nl + 1;
  }
}

// 기록 파일의 offset..end 를 이어 읽음. 줄 하나가 SCAN_CHUNK 보다 길면 그 줄은 건너뜀
export async function scanTaskFile(index, file, end) {
  if (index.offset >= end) return;
  const fh = await fs.promises.open(file, "r");
  try {
    while (index.offset < end) {
      const len = Math.min(SCAN_CHUNK, end - index.offset);
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, index.offset);
      if (!bytesRead) break;
      const used = scanTaskBuffer(index, buf.subarray(0, bytesRead));
      if (used > 0) { index.offset += used; continue; }
      // 줄바꿈이 없는 긴 줄: 다음 줄바꿈까지 건너뜀
      if (index.offset + bytesRead >= end) break;
      index.offset += bytesRead;
      for (;;) {
        const more = Buffer.alloc(Math.min(SCAN_CHUNK, end - index.offset));
        const r = await fh.read(more, 0, more.length, index.offset);
        if (!r.bytesRead) return;
        const nl = more.subarray(0, r.bytesRead).indexOf(10);
        if (nl >= 0) { index.offset += nl + 1; break; }
        index.offset += r.bytesRead;
        if (index.offset >= end) return;
      }
    }
  } finally { await fh.close(); }
}

// 상태: 끝 기록이 있으면 그 상태. Monitor 는 제한 시간이 지났으면 expired(끝 기록이 안 남음)
export function taskStatus(task, end, now) {
  if (end) return end.status;
  if (task.kind === "monitor" && !task.persistent && task.timeoutMs && task.startedAt && now > task.startedAt + task.timeoutMs) return "expired";
  return "running";
}

// 화면에 보낼 목록(최근 시작 순, 최대 LIST_MAX)
export function taskList(index, now) {
  return [...index.tasks.values()]
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
    .slice(0, LIST_MAX)
    .map((t) => {
      const end = index.ends.get(t.id) || null;
      return { id: t.id, toolUseId: t.toolUseId, kind: t.kind, command: t.command, description: t.description,
        startedAt: t.startedAt, endedAt: end?.at ?? null, status: taskStatus(t, end, now), summary: end?.summary || "" };
    });
}

// 기록 파일 → tasks 폴더. Claude 기록 폴더(projectsRoot) 안의 <프로젝트>/<세션>.jsonl 이나 <프로젝트>/<세션>/subagents/*.jsonl 만
export function tasksDirFor(file, projectsRoot, tmpRoot) {
  const rel = path.relative(projectsRoot, file);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  let session = null;
  if (parts.length === 2 && parts[1].endsWith(".jsonl")) session = parts[1].slice(0, -6);
  else if (parts.length === 4 && parts[2] === "subagents") session = parts[1];
  if (!session || !/^[A-Za-z0-9._-]+$/.test(session) || !/^[A-Za-z0-9._-]+$/.test(parts[0])) return null;
  return path.join(tmpRoot, parts[0], session, "tasks");
}

// Claude Code 임시 폴더(<CLAUDE_CODE_TMPDIR 또는 /tmp>/claude-<uid>). 없으면 null
export function claudeTmpRoot(env = process.env) {
  const base = env.CLAUDE_CODE_TMPDIR || "/tmp";
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid === null) return null;
  try { return fs.realpathSync(path.join(base, `claude-${uid}`)); } catch { return null; }
}

// 출력 파일 하나. 일반 파일만(심볼릭 링크 거부)
function outputFile(dir, id) {
  if (!dir || !TASK_ID_RE.test(id)) return null;
  const file = path.join(dir, `${id}.output`);
  try {
    const st = fs.lstatSync(file);
    return st.isFile() ? { file, size: st.size } : null;
  } catch { return null; }
}

export function taskOutputSize(dir, id) {
  return outputFile(dir, id)?.size ?? null;
}

// UTF-8 글자 중간에서 자르지 않게 앞뒤를 맞춤
function utf8Head(buf) {
  let i = 0;
  while (i < buf.length && i < 4 && (buf[i] & 0xc0) === 0x80) i++;
  return i;
}
function utf8End(buf) {
  for (let back = 1; back <= Math.min(4, buf.length); back++) {
    const b = buf[buf.length - back];
    if ((b & 0x80) === 0) return buf.length;
    if ((b & 0xc0) === 0xc0) {
      const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2;
      return back >= need ? buf.length : buf.length - back;
    }
  }
  return buf.length;
}

// from 부터 최대 max 바이트. from 이 없거나 파일보다 크면(새로 씀) 끝 max 바이트부터
export function readTaskOutput(dir, id, from, max = READ_MAX) {
  const hit = outputFile(dir, id);
  if (!hit) return null;
  let start = Number.isInteger(from) && from >= 0 && from <= hit.size ? from : Math.max(0, hit.size - max);
  const skipped = start > 0 && start !== from;
  const len = Math.min(max, hit.size - start);
  if (len <= 0) return { size: hit.size, start, end: start, text: "", skipped };
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(hit.file, "r");
  let n = 0;
  try { n = fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
  let part = buf.subarray(0, n);
  if (start !== from) { const h = utf8Head(part); part = part.subarray(h); start += h; }
  const e = utf8End(part);
  return { size: hit.size, start, end: start + e, text: part.subarray(0, e).toString("utf8"), skipped };
}

export function taskTail(dir, id) {
  const r = readTaskOutput(dir, id, null, TAIL_BYTES);
  return r ? { size: r.size, tail: r.text, cut: r.start > 0 } : null;
}
