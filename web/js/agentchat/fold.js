// 채팅 메시지 목록을 화면에 그릴 턴으로 묶는 순수 함수들.
//
// 소유 범위
//   턴 묶기(foldTurns), 도구 호출·결과 짝짓기, 도구 묶음 한 줄 요약, 편집 도구 입력의 diff 줄.
//
// 제공 API
//   foldTurns · pairTools · summarizeRun · briefArg · previewInput · formatInput · diffFromCall · diffFromText.
//
// 의존 대상
//   아무것도 import 하지 않는다. DOM 을 보지 않으므로 검사가 Node 에서 그대로 부른다.
//
// 유지 조건
//   서버가 보내는 메시지 모양({ id, role, blocks, ts })만 안다. 연속한 assistant·tool·reasoning
//   메시지는 한 턴이다. Claude Code 는 블록마다 줄을 따로 적어서, 묶지 않으면 도구 하나마다
//   머리가 새로 선다.
//
// 영향 범위
//   agentchat/view.js·boot.js 와 test/agent-chat.mjs. 현재 목록 확인: node bin/importers.mjs web/js/agentchat/fold.js

const SUMMARY_PARTS = 3;
const PREVIEW = 80;
const BRIEF = 28;
const DIFF_LINES = 120;
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "str_replace", "apply_patch", "NotebookEdit"]);

const isTool = (b) => b.type === "tool-call" || b.type === "tool-result";

// 턴: { key, role, segments } · segment: { kind: "text"|"tools"|"reasoning"|"image", ... }
export function foldTurns(messages) {
  const turns = [];
  for (const m of messages || []) {
    if (!m || !Array.isArray(m.blocks)) continue;
    const agentSide = m.role === "assistant" || m.role === "tool" || m.role === "reasoning";
    let turn = turns[turns.length - 1];
    if (!(agentSide && turn && turn.role === "assistant")) {
      turn = { key: String(m.id), role: agentSide ? "assistant" : m.role, segments: [], ts: m.ts ?? null };
      turns.push(turn);
    }
    if (m.role === "reasoning") {
      const text = m.blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      if (text) turn.segments.push({ kind: "reasoning", key: String(m.id), text });
      continue;
    }
    for (const b of m.blocks) {
      const last = turn.segments[turn.segments.length - 1];
      if (isTool(b)) {
        if (last && last.kind === "tools") last.blocks.push(b);
        else turn.segments.push({ kind: "tools", key: `${m.id}:${turn.segments.length}`, blocks: [b] });
      } else if (b.type === "text") {
        if (last && last.kind === "text") last.text += `\n\n${b.text}`;
        else turn.segments.push({ kind: "text", key: `${m.id}:${turn.segments.length}`, text: b.text });
      } else if (b.type === "image") turn.segments.push({ kind: "image", key: `${m.id}:${turn.segments.length}` });
    }
  }
  return turns.filter((t) => t.segments.length);
}

// 호출과 결과를 짝짓는다. id 가 있으면 id 로, 없으면 도착 순서로 앞의 빈 호출에 붙인다.
export function pairTools(blocks) {
  const pairs = [];
  const byId = new Map();
  const open = [];
  for (const b of blocks) {
    if (b.type === "tool-call") {
      const pair = { call: b, result: null };
      pairs.push(pair);
      if (b.id) byId.set(b.id, pair);
      open.push(pair);
    } else if (b.type === "tool-result") {
      let pair = b.id ? byId.get(b.id) : null;
      if (!pair) pair = open.find((p) => !p.result && !(p.call.id && b.id));
      if (pair && !pair.result) { pair.result = b; open.splice(open.indexOf(pair), 1); }
      else pairs.push({ call: null, result: b });
    }
  }
  return pairs;
}

function rawPreview(input) {
  if (input == null) return "";
  if (typeof input === "string") return input;
  if (typeof input !== "object") return String(input);
  try { return JSON.stringify(input); } catch { return ""; }
}

export function previewInput(input, max = PREVIEW) {
  const s = rawPreview(input).replace(/\s+/g, " ").trim();
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function briefArg(input) {
  if (input && typeof input === "object") {
    const p = input.file_path ?? input.filePath ?? input.path ?? input.notebook_path;
    if (typeof p === "string" && p) return p.split(/[\\/]/).filter(Boolean).pop() || p;
    const cmd = input.command ?? input.cmd ?? input.query ?? input.pattern ?? input.description;
    if (typeof cmd === "string") return previewInput(cmd, BRIEF + 1).slice(0, BRIEF);
    if (Array.isArray(cmd)) return previewInput(cmd.join(" "), BRIEF + 1).slice(0, BRIEF);
  }
  // Codex 의 코드 실행 도구는 입력이 스크립트 글이다. 그 안의 명령이 스크립트 첫머리보다 알려 주는 것이 많다.
  if (typeof input === "string") {
    const cmd = /\bcmd\s*:\s*"((?:[^"\\]|\\.)+)"/.exec(input)?.[1];
    if (cmd) return previewInput(cmd, BRIEF + 1).slice(0, BRIEF);
  }
  return previewInput(input, BRIEF + 1).slice(0, BRIEF);
}

// "3× Read foo.ts · Bash npm test · Grep todo · …"
export function summarizeRun(blocks) {
  const calls = blocks.filter((b) => b.type === "tool-call");
  const parts = calls.slice(0, SUMMARY_PARTS).map((c) => {
    const arg = briefArg(c.input);
    return arg ? `${c.name} ${arg}` : c.name;
  });
  if (calls.length > SUMMARY_PARTS) parts.push("…");
  return { count: calls.length || blocks.length, text: parts.join(" · ") };
}

export function formatInput(input) {
  if (input == null) return "";
  if (typeof input === "string") return input;
  try { return JSON.stringify(input, null, 2); } catch { return ""; }
}

function lines(value) {
  if (typeof value !== "string" || !value) return [];
  const out = value.split("\n");
  if (out[out.length - 1] === "") out.pop();
  return out;
}

function bound(out) {
  return out.length > DIFF_LINES ? [...out.slice(0, DIFF_LINES - 1), { kind: "meta", text: "… 이후 생략" }] : out;
}

// 패치 글(apply_patch·unified diff)을 줄 종류로 나눈다. 더하고 뺀 줄이 둘 미만이면 diff 로 보지 않는다.
export function diffFromText(text) {
  let changed = 0;
  const out = lines(text).map((l) => {
    if (/^(@@|\*\*\* |diff |index )/.test(l)) return { kind: "meta", text: l };
    if (l.startsWith("+") && !l.startsWith("+++")) { changed++; return { kind: "add", text: l.slice(1) }; }
    if (l.startsWith("-") && !l.startsWith("---")) { changed++; return { kind: "del", text: l.slice(1) }; }
    return { kind: "ctx", text: l };
  });
  return changed >= 2 ? bound(out) : null;
}

export function diffFromCall(call) {
  if (!call || !EDIT_TOOLS.has(call.name)) return null;
  const input = call.input;
  if (typeof input === "string") return diffFromText(input);
  if (!input || typeof input !== "object") return null;
  const edits = Array.isArray(input.edits) ? input.edits : [input];
  const out = [];
  const file = input.file_path ?? input.path ?? input.notebook_path;
  if (typeof file === "string") out.push({ kind: "meta", text: file });
  for (const e of edits) {
    if (!e || typeof e !== "object") continue;
    for (const t of lines(e.old_string ?? e.oldString ?? e.old)) out.push({ kind: "del", text: t });
    for (const t of lines(e.new_string ?? e.newString ?? e.new ?? e.content ?? e.file_text ?? e.new_source)) out.push({ kind: "add", text: t });
  }
  if (typeof input.patch === "string" || typeof input.input === "string") return diffFromText(input.patch ?? input.input);
  return out.some((l) => l.kind !== "meta") ? bound(out) : null;
}
