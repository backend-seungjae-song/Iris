// 대화 보기 입력창 도구: / 명령 목록, @ 파일 후보
//
// 소유 범위
//   명령 파일·스킬 폴더·작업 폴더를 읽어 후보를 만드는 일. 터미널 입력은 하지 않음(server/agent-chat.js)
//
// 제공 API
//   listCommands(kind, cwd, homes, cliBuiltins) · claudeBuiltins() · cliBuiltinCommands(commands) · suggestFiles(cwd, query, limit) · parseFrontmatter(text) · rankPaths(paths, query, limit)
//
// 유지 조건
//   Claude Code·Codex 가 터미널에서 받는 / 명령과 같은 이름
//   Claude 내장 명령은 설치된 CLI 의 초기화 응답에서 받음. CLI 목록에 없는 터미널 전용 명령과 Codex 는 여기서 정함
//   사용자·프로젝트 명령과 스킬은 파일에서 읽음. 개수·크기 제한 안에서만
//   파일 후보는 git 저장소면 git ls-files(무시 파일 제외), 아니면 깊이 제한 폴더 훑기
import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import os from "node:os";
import { projectClaudeDir } from "./agent-homes.js";

const MAX_COMMAND_FILES = 500;
const MAX_WALK = 20000;

// 내장 명령(터미널 입력창에서 쓰는 것만). 설명은 화면 표시용
// Claude 는 CLI 목록을 못 받았을 때와 CLI 목록에 없는 터미널 전용 명령(resume·exit 등)에만 씀
const CLAUDE_BUILTINS = [
  ["add-dir", "작업 폴더 추가"], ["agents", "서브에이전트 관리"], ["clear", "대화 지우기"], ["compact", "대화 압축", "[지시]"],
  ["config", "설정"], ["context", "컨텍스트 사용량"], ["cost", "사용량·비용"], ["doctor", "설치 점검"], ["exit", "끝내기"],
  ["export", "대화 내보내기"], ["help", "도움말"], ["hooks", "훅 설정"], ["init", "CLAUDE.md 만들기"], ["mcp", "MCP 서버 관리"],
  ["memory", "메모리 파일 편집"], ["model", "모델 바꾸기", "[모델]"], ["permissions", "권한 설정"], ["resume", "이전 대화 이어가기"],
  ["review", "코드 검토"], ["rewind", "이전 시점으로 되돌리기"], ["status", "상태"], ["usage", "사용 한도"],
];
const CODEX_BUILTINS = [
  ["approvals", "승인 방식"], ["compact", "대화 압축"], ["diff", "변경 보기"], ["init", "AGENTS.md 만들기"], ["mcp", "MCP 도구"],
  ["mention", "파일 언급"], ["model", "모델·추론 수준"], ["new", "새 대화"], ["quit", "끝내기"], ["review", "변경 검토"],
  ["status", "세션 상태"],
];

// Claude CLI 초기화 응답의 commands → 내장 명령. 이름이 __ 로 시작하는 것은 서버 실행 세션 전용
export function cliBuiltinCommands(commands) {
  if (!Array.isArray(commands)) return null;
  const out = [];
  for (const c of commands) {
    if (!c || c.builtin !== true || typeof c.name !== "string" || !c.name || c.name.startsWith("__")) continue;
    out.push({ name: c.name, description: typeof c.description === "string" ? c.description : "", argumentHint: typeof c.argumentHint === "string" ? c.argumentHint : "", kind: "builtin" });
  }
  return out.length ? out : null;
}

const CLI_LIST_TTL_MS = 6 * 60 * 60 * 1000;   // Claude Code 업데이트를 따라가는 주기
const CLI_RETRY_MS = 60 * 1000;
const CLI_TIMEOUT_MS = 20 * 1000;
let cliCache = { at: 0, ok: false, promise: null, list: null };

// 설치된 claude 에 초기화 요청만 보내 내장 명령 목록을 받음
// - --safe-mode: 사용자 훅·스킬·MCP 를 띄우지 않음. 모델 호출·기록 파일 없음
// - 실패하면 null(호출부가 고정 목록을 씀)
export function claudeBuiltins({ now = Date.now(), run = runClaudeInitialize } = {}) {
  const fresh = cliCache.ok ? now - cliCache.at < CLI_LIST_TTL_MS : now - cliCache.at < CLI_RETRY_MS;
  if (cliCache.promise) return cliCache.promise;
  if (cliCache.at && fresh) return Promise.resolve(cliCache.list);
  cliCache.promise = run().then((commands) => cliBuiltinCommands(commands), () => null).then((list) => {
    cliCache = { at: Date.now(), ok: !!list, promise: null, list: list || cliCache.list };
    return cliCache.list;
  });
  return cliCache.promise;
}

export function resetClaudeBuiltinsForTest() { cliCache = { at: 0, ok: false, promise: null, list: null }; }

function runClaudeInitialize() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith("HERDR_")) delete env[k];
    const child = spawn("claude", ["-p", "--safe-mode", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
      { cwd: os.homedir(), env, stdio: ["pipe", "pipe", "ignore"] });
    let buf = "", done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true; clearTimeout(timer);
      try { child.kill(); } catch {}
      err ? reject(err) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("claude 초기화 응답 시간 초과")), CLI_TIMEOUT_MS);
    timer.unref?.();
    child.on("error", (e) => finish(e));
    child.on("exit", () => finish(new Error("claude 가 초기화 응답 전에 끝남")));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m?.type === "control_response" && m.response?.request_id === "iris-commands") finish(null, m.response.response?.commands);
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.write(JSON.stringify({ type: "control_request", request_id: "iris-commands", request: { subtype: "initialize" } }) + "\n");
  });
}

// 앞머리 --- 블록의 한 줄 key: value 만. 값의 따옴표는 벗김
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ""));
  const out = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

function readHead(file) {
  try {
    const fd = fs.openSync(file, "r");
    try { const buf = Buffer.alloc(4096); const n = fs.readSync(fd, buf, 0, buf.length, 0); return buf.subarray(0, n).toString("utf8"); }
    finally { fs.closeSync(fd); }
  } catch { return ""; }
}

// commands 폴더의 *.md → /폴더:이름. 하위 폴더는 이름 앞에 콜론으로
function commandFiles(dir, prefix = "", out = [], depth = 0) {
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const d of names) {
    if (out.length >= MAX_COMMAND_FILES || d.name.startsWith(".")) continue;
    const full = path.join(dir, d.name);
    if (d.isDirectory() && depth < 3) commandFiles(full, `${prefix}${d.name}:`, out, depth + 1);
    else if (d.isFile() && d.name.endsWith(".md")) {
      const fm = parseFrontmatter(readHead(full));
      out.push({ name: `${prefix}${d.name.slice(0, -3)}`, description: fm.description || "", argumentHint: fm["argument-hint"] || "" });
    }
  }
  return out;
}

function skillDirs(dir) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const d of names) {
    if (out.length >= MAX_COMMAND_FILES || !d.isDirectory() || d.name.startsWith(".")) continue;
    const fm = parseFrontmatter(readHead(path.join(dir, d.name, "SKILL.md")));
    if (!fm.name && !fm.description) continue;
    if (fm["user-invocable"] === "false") continue;
    out.push({ name: fm.name || d.name, description: fm.description || "", argumentHint: fm["argument-hint"] || "" });
  }
  return out;
}

// kind: "claude" | "codex". homes: { claude, codex } 설정 폴더
// cliBuiltins: claudeBuiltins() 결과(없으면 고정 목록만)
// → [{ name, description, argumentHint, kind }] 이름 중복은 앞의 것(프로젝트 > 사용자 > CLI 내장 > 고정 내장)
export function listCommands(kind, cwd, homes, cliBuiltins = null) {
  const list = [];
  if (kind === "codex") {
    for (const c of commandFiles(path.join(homes.codex, "prompts"))) list.push({ ...c, name: `prompts:${c.name}`, kind: "custom" });
    for (const [name, description, argumentHint = ""] of CODEX_BUILTINS) list.push({ name, description, argumentHint, kind: "builtin" });
  } else {
    if (path.isAbsolute(cwd || "")) {
      for (const c of commandFiles(projectClaudeDir(cwd, "commands"))) list.push({ ...c, kind: "custom" });
      for (const c of skillDirs(projectClaudeDir(cwd, "skills"))) list.push({ ...c, kind: "skill" });
    }
    for (const c of commandFiles(path.join(homes.claude, "commands"))) list.push({ ...c, kind: "custom" });
    for (const c of skillDirs(path.join(homes.claude, "skills"))) list.push({ ...c, kind: "skill" });
    if (cliBuiltins) list.push(...cliBuiltins);
    for (const [name, description, argumentHint = ""] of CLAUDE_BUILTINS) list.push({ name, description, argumentHint, kind: "builtin" });
  }
  const seen = new Set();
  return list.filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)));
}

// 경로 후보 순위: 파일 이름이 검색어로 시작 > 이름에 포함 > 경로에 포함 > 글자 순서대로 들어 있음. 같으면 짧은 경로
export function rankPaths(paths, query, limit = 50) {
  const q = String(query || "").toLowerCase();
  const scored = [];
  for (const p of paths) {
    const lower = p.toLowerCase();
    const base = lower.slice(lower.lastIndexOf("/") + 1);
    let score;
    if (!q) score = 3;
    else if (base.startsWith(q)) score = 0;
    else if (base.includes(q)) score = 1;
    else if (lower.includes(q)) score = 2;
    else {
      let i = 0;
      for (const ch of lower) if (ch === q[i]) i++;
      if (i < q.length) continue;
      score = 3;
    }
    scored.push([score, p.length, p]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : 1));
  return scored.slice(0, limit).map((s) => s[2]);
}

function gitFiles(cwd) {
  return new Promise((resolve) => {
    execFile("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd, maxBuffer: 32 * 1024 * 1024, timeout: 5000, windowsHide: true },
      (err, out) => resolve(err ? null : String(out).split("\0").filter(Boolean).slice(0, MAX_WALK)));
  });
}

function walkFiles(cwd) {
  const out = [];
  const queue = [""];
  while (queue.length && out.length < MAX_WALK) {
    const rel = queue.shift();
    let names = [];
    try { names = fs.readdirSync(path.join(cwd, rel), { withFileTypes: true }); } catch { continue; }
    for (const d of names) {
      if (d.name.startsWith(".") || d.name === "node_modules") continue;
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) { if (r.split("/").length < 6) queue.push(r); }
      else if (d.isFile()) out.push(r);
    }
  }
  return out;
}

// → { directories: [상대 경로], entries: [{ path, kind: "file"|"directory" }] }
export async function suggestFiles(cwd, query, limit = 50) {
  if (!path.isAbsolute(cwd || "") || !fs.existsSync(cwd)) return { directories: [], entries: [] };
  const files = (await gitFiles(cwd)) || walkFiles(cwd);
  const dirs = new Set();
  for (const f of files) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  const topDirs = rankPaths([...dirs], query, Math.min(10, limit));
  const topFiles = rankPaths(files, query, limit);
  return {
    directories: topDirs,
    entries: [...topDirs.map((p) => ({ path: p, kind: "directory" })), ...topFiles.map((p) => ({ path: p, kind: "file" }))].slice(0, limit),
  };
}
