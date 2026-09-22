// 보관함. 나중에 쓸 세션을 종료해 메모리를 회수한다.
//
// 핵심은 종료해도 복원할 수 있는 세션 키다. herdr agent.list의 agent_session.value가 그 키이고,
// claude는 `claude --resume <uuid>`, codex는 `codex resume <uuid>`로 같은 대화를 이어 간다.
// 확인 결과: 실행 중인 에이전트 34개 중 33개가 세션 id를 갖고, 그중 32개가
// ~/.claude/projects/*/<uuid>.jsonl 로 확인됐다. 키가 없는 세션은 보관하지 않는다. 보관하는
// 순간 복원할 방법이 사라지기 때문이다.
//
// 보관 단위는 둘이다. 에이전트 하나(pane)만 보관하거나 스페이스를 통째로 보관한다. 스페이스를
// 보관하면 그 안의 에이전트가 각각 항목으로 남아, 복원할 때 필요한 것만 골라 실행한다. 통째로
// 복원하면 보관한 이유인 메모리 사용량이 그대로 돌아온다.
import fs from "node:fs";
import path from "node:path";
import { claudeHome, codexHome } from "./agent-homes.js";
import { stateHome } from "./state-home.cjs";

const DATA_DIR = stateHome();
const ARCHIVE_PATH = path.join(DATA_DIR, "archives.json");

// 세션을 잇는 명령. 이 표에 없는 종류는 보관을 막는다(복원 방법을 모르는 채로 종료하지 않는다).
const RESUME_ARGV = {
  claude: (uuid) => ["claude", "--resume", uuid],
  codex: (uuid) => ["codex", "resume", uuid],
};
export function canResume(agentKind) { return !!RESUME_ARGV[String(agentKind || "").toLowerCase()]; }
export function resumeArgv(agentKind, uuid) {
  const f = RESUME_ARGV[String(agentKind || "").toLowerCase()];
  return f ? f(String(uuid)) : null;
}

// ── 마지막 내용 ──
// herdr의 pane.read는 화면에 보이는 만큼만 반환한다. lines를 올려도 뷰포트(≈55줄) 위쪽은 나오지
// 않아서 200줄을 화면에서는 얻을 수 없다. 대신 세션 기록 파일에서 읽는다. 내용 파악에도 검색에도
// 화면 덤프보다 정확하다.
// 기록 파일은 매우 클 수 있어(확인 결과: codex 최대 931MB) 반드시 끝에서만 읽는다.
// 읽는 크기가 종류마다 다른 이유는 codex 기록의 한 줄이 훨씬 크기 때문이다. 줄마다 암호화된
// reasoning 블록과 token_count가 붙어서, 같은 400KB를 읽으면 대화는 한두 줄만 포함되고 도구
// 기록만 남는다(확인 결과: 400KB에서 어시스턴트 발언 1줄, 2MB에서 13줄).
const TAIL_BYTES = 400_000;
const TAIL_BYTES_CODEX = 2_000_000;

function tailBytes(file, n = TAIL_BYTES) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(n, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    // 앞이 잘려 깨진 첫 줄은 버린다
    return buf.toString("utf8").split("\n").slice(size > len ? 1 : 0);
  } finally { fs.closeSync(fd); }
}

function findTranscript(kind, uuid) {
  if (!uuid) return null;
  const k = String(kind || "").toLowerCase();
  try {
    if (k === "claude") {
      const root = claudeHome("projects");
      for (const d of fs.readdirSync(root)) {
        const f = path.join(root, d, uuid + ".jsonl");
        if (fs.existsSync(f)) return f;
      }
      return null;
    }
    if (k === "codex") {
      // 파일명에 세션 uuid가 들어 있다: rollout-<시각>-<uuid>.jsonl
      const root = codexHome("sessions");
      const stack = [root];
      while (stack.length) {
        const d = stack.pop();
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) stack.push(p);
          else if (e.name.includes(uuid) && e.name.endsWith(".jsonl")) return p;
        }
      }
    }
  } catch {}
  return null;
}

// 기록 한 줄을 사람이 읽는 한 줄로 변환한다. 형식이 다르면 빈 문자열을 반환해 건너뛴다.
function claudeLine(m) {
  const c = m?.message?.content;
  let text = "";
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) {
    text = c.map((b) => b?.type === "text" ? b.text
      : b?.type === "tool_use" ? `[도구 ${b.name || ""}]`
      : b?.type === "tool_result" ? "[결과]" : "").filter(Boolean).join("\n");
  }
  if (!text.trim()) return "";
  const r = m?.message?.role;
  return r === "user" ? `사용자: ${text}` : r === "assistant" ? `어시스턴트: ${text}` : text;
}

// codex rollout. 대화는 event_msg(user_message/agent_message)에 사람이 읽는 형태로 들어 있다.
// response_item.message는 쓰지 않는다. assistant 항목은 agent_message와 내용이 중복되고,
// user 항목은 <codex_internal_context> 같은 내부 주입이 섞여 사용자 입력과 구분되지 않는다.
// 도구는 호출 기록만 남긴다. 어디까지 진행했는지가 목록에서 세션을 식별하는 근거가 된다.
function codexLine(m) {
  const p = m?.payload;
  if (!p || typeof p !== "object") return "";
  const t = p.type;
  if (t === "user_message" && typeof p.message === "string") return `사용자: ${p.message}`;
  if (t === "agent_message" && typeof p.message === "string") return `어시스턴트: ${p.message}`;
  if (t === "custom_tool_call" || t === "function_call" || t === "local_shell_call") return `[도구 ${p.name || "exec"}]`;
  if (t === "custom_tool_call_output" || t === "function_call_output") return "[결과]";
  if (t === "patch_apply_end") return "[파일 수정]";
  return "";
}

export function transcriptTail(kind, uuid, maxLines = 200, knownFile = null) {
  const k = String(kind || "").toLowerCase();
  // 파일을 이미 아는 경우(codex 세션은 그 파일을 찾아 둔다) 다시 탐색하지 않는다.
  const file = knownFile && fs.existsSync(knownFile) ? knownFile : findTranscript(kind, uuid);
  if (!file) return null;
  const lineOf = k === "codex" ? codexLine : claudeLine;
  let out = [];
  try {
    for (const line of tailBytes(file, k === "codex" ? TAIL_BYTES_CODEX : TAIL_BYTES)) {
      let m; try { m = JSON.parse(line); } catch { continue; }
      const t = lineOf(m).trim();
      if (t) out.push(t);
    }
  } catch { return null; }
  const lines = out.join("\n").split("\n");
  return lines.length ? lines.slice(-maxLines).join("\n") : null;
}

let items = [];      // 보관 항목 배열(최신이 앞)
let seq = 0;

function newId() { return "ar" + Date.now().toString(36) + (++seq).toString(36); }

export function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(ARCHIVE_PATH, "utf8"));
    items = Array.isArray(raw?.items) ? raw.items : [];
  } catch { items = []; }
  return items;
}

let saveTimer = null;
function writeNow() {
  saveTimer = null;
  try {
    fs.mkdirSync(path.dirname(ARCHIVE_PATH), { recursive: true });
    fs.writeFileSync(ARCHIVE_PATH + ".tmp", JSON.stringify({ items }), { mode: 0o600 });
    fs.renameSync(ARCHIVE_PATH + ".tmp", ARCHIVE_PATH);
  } catch {}
}
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeNow, 120);
}
// 보관은 되돌릴 수 없다. 보관한 세션을 목록에서 잃으면 복원할 방법이 없다.
// 지연 저장을 기다리는 중에 종료 신호를 받으면 방금 보관한 항목이 저장되지 않는다.
export function flushNow() {
  if (!saveTimer) return false;
  clearTimeout(saveTimer);
  writeNow();
  return true;
}

export function list() { return items; }

// 보관 전에 남길 화면 줄 수. 목록에서 세션을 식별하는 근거이자 나중에 내용으로 검색하는
// 대상이므로 넉넉히 남긴다(200줄).
export const TAIL_LINES = 200;

// 에이전트 한 건을 보관 항목으로 만든다. state(=buildMonitorState 결과)의 레코드를 그대로 받는다.
// tail은 보관 직전에 읽은 마지막 화면으로, 세션을 복원하지 않고도 내용을 확인하게 한다.
export function agentEntry(a, spaceLabel, spaceCwd, tail) {
  return {
    id: newId(), kind: "agent", at: Date.now(),
    agent: a.agent || null,
    session: a.sessionUuid || null,
    cwd: a.cwd || null,
    name: a.tabLabel || null,          // 복원할 때 이 이름으로 탭을 만든다(사용자 지정)
    spaceLabel: spaceLabel || null,
    spaceCwd: spaceCwd || null,
    tail: typeof tail === "string" && tail.trim() ? tail : null,
  };
}

export function add(entry) { items.unshift(entry); persist(); return entry; }

export function addMany(entries) { items.unshift(...entries); persist(); return entries; }

export function get(id) { return items.find((x) => x.id === id) || null; }

export function remove(id) {
  const i = items.findIndex((x) => x.id === id);
  if (i < 0) return false;
  items.splice(i, 1); persist(); return true;
}

// 스페이스 항목: 폴더·이름에 더해 탭 구성까지 담는다. 세션이 붙지 않은 터미널 탭도
// 그 스페이스의 일부라서, 기록하지 않으면 복원할 때 사라진다.
// tabs = [{ label, entry }] 순서대로. entry는 그 탭에 붙은 세션의 보관 항목 id(없으면 null).
export function spaceEntry(label, cwd, agentIds, tabs) {
  return {
    id: newId(), kind: "space", at: Date.now(),
    label: label || null, cwd: cwd || null,
    agents: agentIds || [], tabs: Array.isArray(tabs) ? tabs : [],
  };
}
