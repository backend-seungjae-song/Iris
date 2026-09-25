// 에이전트가 답을 끝내며 사용자에게 질문을 남겼는지 판정한다(상태 점의 "질문 있음").
//
// herdr 는 working·idle·done·blocked·unknown 만 주고 질문 신호가 없다. 그래서 done·idle 인
// 에이전트의 대화 기록 끝을 읽어, 마지막 에이전트 텍스트 답 뒤에 사용자 발화가 없고 그 답의
// 마지막 줄이 물음표로 끝나면 질문으로 본다. herdr status 는 바꾸지 않고 question 만 붙인다.
//
// 앱 셸 모듈이다. 채팅 보기 기능의 해석기(agent-chat-transcript.js)는 기능을 끄면 빠지므로
// 가져오지 않고 필요한 만큼만 따로 해석한다. 기록 파일은 읽기만 한다.
import fs from "node:fs";
import path from "node:path";
import { claudeHome, codexHome } from "./agent-homes.js";

const TAIL_BYTES = 64 * 1024;
const cache = new Map(); // realpath → { size, mtimeMs, question }

// 물음표 뒤에 붙는 닫는 괄호·따옴표·마크다운 강조 문자와 공백은 허용한다.
const QUESTION_END = /[?？][\s)\]}"'`*_~”’」』）》]*$/;

function endsWithQuestion(text) {
  const lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length ? QUESTION_END.test(lines[lines.length - 1]) : false;
}

function claudeText(rec) {
  const c = rec.message?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
}

// 사용자 발화인가. tool_result 만 담긴 user 레코드와 하네스가 넣은 메타 레코드는 발화가 아니다.
function claudeUserSpoke(rec) {
  if (rec.isMeta || rec.isSynthetic || rec.isCompactSummary || rec.isSidechain) return false;
  const c = rec.message?.content;
  if (typeof c === "string") return c.trim() !== "";
  if (!Array.isArray(c)) return false;
  return c.some((b) => b && b.type !== "tool_result");
}

function codexText(p) {
  const c = p.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.filter((b) => b && typeof b.text === "string").map((b) => b.text).join("\n");
}

// 레코드 하나를 뒤에서부터 본다. 판정이 나면 true/false, 건너뛸 레코드면 null.
function judge(rec) {
  if (!rec || typeof rec !== "object") return null;
  if (rec.type === "user") return claudeUserSpoke(rec) ? false : null;
  if (rec.type === "assistant") {
    if (rec.isSidechain) return null;
    const text = claudeText(rec);
    return text.trim() ? endsWithQuestion(text) : null; // 도구 호출·생각만 있는 레코드는 건너뛴다
  }
  if (rec.type === "response_item" && rec.payload?.type === "message") {
    if (rec.payload.role === "user") return false;
    if (rec.payload.role === "assistant") {
      const text = codexText(rec.payload);
      return text.trim() ? endsWithQuestion(text) : null;
    }
  }
  return null;
}

// JSONL 텍스트의 끝에서부터 판정한다. 끝에서 자른 조각이면 첫 줄은 잘렸을 수 있어 버린다.
function questionFromTail(text, cutHead = false) {
  const lines = String(text || "").split("\n");
  if (cutHead) lines.shift();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const v = judge(rec);
    if (v !== null) return v;
  }
  return false;
}

function realRoot(dir) {
  try { return fs.realpathSync(dir); } catch { return null; }
}

function inside(file, root) {
  return !!root && (file === root || file.startsWith(root + path.sep));
}

// 기록 파일 하나의 판정. 허용된 두 폴더 밖이거나 읽지 못하면 false.
function questionOfFile(file, roots, seen) {
  let real;
  try { real = fs.realpathSync(file); } catch { return false; }
  if (!roots.some((r) => inside(real, r))) return false;
  let st;
  try { st = fs.statSync(real); } catch { return false; }
  if (!st.isFile()) return false;
  seen.add(real);
  const hit = cache.get(real);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.question;
  let question = false;
  let fd;
  try {
    fd = fs.openSync(real, "r");
    const start = Math.max(0, st.size - TAIL_BYTES);
    const buf = Buffer.alloc(st.size - start);
    const n = fs.readSync(fd, buf, 0, buf.length, start);
    question = questionFromTail(buf.subarray(0, n).toString("utf8"), start > 0);
  } catch {
    question = false;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
  cache.set(real, { size: st.size, mtimeMs: st.mtimeMs, question });
  return question;
}

// 관제 상태의 각 에이전트에 question 을 붙인다. done·idle 이 아니면 false 이고 파일을 읽지 않는다.
export function attachQuestionState(state) {
  const roots = [realRoot(claudeHome("projects")), realRoot(codexHome("sessions"))].filter(Boolean);
  const seen = new Set();
  for (const s of state || []) {
    const file = s.transcriptFile || s.sessionFile || null;
    s.question = (s.status === "done" || s.status === "idle") && file ? questionOfFile(file, roots, seen) : false;
  }
  // 이번에 보지 않은 파일은 캐시에서 뺀다. 닫힌 세션의 항목이 계속 쌓이지 않게 한다.
  for (const key of cache.keys()) if (!seen.has(key)) cache.delete(key);
  return state;
}
