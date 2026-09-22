// 로컬 대화 기록에서 사용량 이력을 추출한다. 구독 잔량(server/usage.js)과는 다른 자료다.
//
// 소유 범위
//   Claude 트랜스크립트(~/.claude/projects·transcripts)와 Codex 롤아웃(~/.codex/sessions)을
//   스캔해 세션·날짜별 토큰 집계를 만드는 규칙. 파일 단위 캐시와 중복 소유권도 여기에 있다.
//
// 제공 API
//   scanHistory(prev, onProgress) · buildSummary(state) · parseClaudeLine · parseCodexLine ·
//   parseClaudeFile · parseCodexFile · claimKeys · resolveCodexDelta · keyHash · projectLabel.
//   그 밖의 것은 없다.
//
// 의존 대상
//   파일 시스템과 홈 경로만. 네트워크를 호출하지 않고 WS 에도 의존하지 않는다. 자식
//   프로세스에서 그대로 실행되고, 검사가 함수를 직접 호출한다.
//
// 유지 조건
//   같은 턴을 두 번 집계하지 않는다. 이어하기·갈래치기는 앞선 파일의 줄을 새 파일에 그대로
//   복사하므로, 파일별로 단순 합산하면 토큰이 실제의 몇 배가 된다. 그래서 턴마다 키를 만들고
//   파일 순서로 소유자를 정한다. 키 하나는 정확히 한 파일이 집계한다.
//   캐시를 사용하기 전에 소유자가 그대로인지 확인한다. 앞 파일이 사라지면 뒤 파일이 새 소유자가
//   되어 집계가 달라진다. 소유자 목록의 지문(g)이 일치하지 않으면 그 파일만 다시 읽는다.
//   Codex 의 total_token_usage 는 압축·재개 뒤 되감기는 스냅샷이다. 그대로 빼면 음수가 되고
//   더하면 두 번 집계한다. last_token_usage 가 그 회차의 증가분이다.
//   원문을 보관하지 않는다. 대화 내용은 이 파일을 거치지 않고 토큰 수만 남는다.
//
// 영향 범위
//   server/usage-history-scan.js(자식 진입점) · server/usage-history-handlers.js(중계) ·
//   web/js/usagestats/page.js 가 그리는 summary 모양.
//   현재 목록은 다음으로 확인한다: node bin/importers.mjs server/usage-history.js

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { claudeHome, codexHome } from "./agent-homes.js";

export const HISTORY_SCHEMA = 1;

// 화면이 표시하는 기간. 더 오래된 날짜는 총합에만 남는다.
const DAY_KEEP = 120;
const RECENT_SESSIONS = 24;
const TOP_N = 8;
const WALK_DEPTH = 8;

function num(v) { return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0; }
function str(v) { return typeof v === "string" && v.trim() ? v.trim() : null; }

// 키를 그대로 쌓으면 캐시 파일이 수십 MB 가 된다. 56 비트로 줄인다. 백만 개를 넣어도
// 충돌 확률이 1% 아래여서 한 턴이 잘못 제외될 일이 사실상 없다.
export function keyHash(s) {
  let a = 0x811c9dc5, b = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 16777619) >>> 0;
    b = Math.imul((b + c) >>> 0, 2654435761) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + (b >>> 8).toString(16).padStart(6, "0");
}

// 프로젝트 이름은 경로 끝 두 단계로 줄인다. 전체 경로는 화면에 너무 길고, 한 단계만 쓰면
// .working 처럼 흔한 이름이 서로 구분되지 않는다.
export function projectLabel(cwd) {
  if (!cwd) return "알 수 없는 위치";
  const parts = String(cwd).replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length >= 2) return parts.slice(-2).join("/");
  return parts[parts.length - 1] || String(cwd);
}

function dayOf(timestamp) {
  const t = Date.parse(timestamp);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function walkJsonl(dir, out, depth) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth < WALK_DEPTH) await walkJsonl(p, out, depth + 1); }
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

export function claudeDirs() {
  return [claudeHome("projects"), claudeHome("transcripts")];
}
export function codexDirs() {
  return [codexHome("sessions")];
}

async function listFiles(dirs) {
  const out = [];
  for (const d of dirs) await walkJsonl(d, out, 0);
  return [...new Set(out)].sort();
}

// Claude 쪽
// 갈래치기는 sessionId 를 새로 쓰면서 message.id·requestId 는 그대로 복사한다. 그래서 그 둘이
// 가장 강한 식별자이고, 없으면 uuid 를 사용한다.
function claudeKey(r) {
  const id = str(r.message && r.message.id);
  const req = str(r.requestId);
  if (id && req) return `${id}:${req}`;
  if (id) return `msg:${id}`;
  const uuid = str(r.uuid);
  return uuid ? `uuid:${uuid}` : null;
}

export function parseClaudeLine(line, fallbackSessionId) {
  let r;
  try { r = JSON.parse(line); } catch { return null; }
  if (!r || r.type !== "assistant" || !r.timestamp) return null;
  const sessionId = str(r.sessionId) || fallbackSessionId;
  if (!sessionId) return null;
  const u = (r.message && r.message.usage) || null;
  const inp = num(u && u.input_tokens), out = num(u && u.output_tokens);
  const cr = num(u && u.cache_read_input_tokens), cw = num(u && u.cache_creation_input_tokens);
  if (inp + out + cr + cw <= 0) return null;
  return {
    sessionId, timestamp: r.timestamp,
    model: str(r.message && r.message.model),
    cwd: str(r.cwd),
    key: claudeKey(r),
    inp, out, cr, cw,
  };
}

// 같은 파일 안에서 같은 키가 여러 줄로 나온다(스트리밍 중간 기록). 나중 줄이 더 완전한
// 값을 가지므로 큰 쪽을 남긴다.
export async function parseClaudeFile(file) {
  const fallback = path.basename(file, ".jsonl");
  const turns = [];
  const byKey = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf-8" }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line) continue;
      const t = parseClaudeLine(line, fallback);
      if (!t) continue;
      if (t.key && byKey.has(t.key)) {
        const prev = turns[byKey.get(t.key)];
        prev.inp = Math.max(prev.inp, t.inp); prev.out = Math.max(prev.out, t.out);
        prev.cr = Math.max(prev.cr, t.cr); prev.cw = Math.max(prev.cw, t.cw);
        continue;
      }
      turns.push(t);
      if (t.key) byKey.set(t.key, turns.length - 1);
    }
  } finally { rl.close(); }
  return turns;
}

// Codex 쪽
function rawUsage(v) {
  if (!v || typeof v !== "object") return null;
  return {
    inp: num(v.input_tokens), cached: num(v.cached_input_tokens),
    out: num(v.output_tokens), reasoning: num(v.reasoning_output_tokens),
    total: num(v.total_tokens),
  };
}
function usageEquals(a, b) {
  return a.inp === b.inp && a.cached === b.cached && a.out === b.out
    && a.reasoning === b.reasoning && a.total === b.total;
}
function usageMonotonic(next, prev) {
  return next.inp >= prev.inp && next.cached >= prev.cached && next.out >= prev.out
    && next.reasoning >= prev.reasoning && next.total >= prev.total;
}
function usageSub(a, b) {
  return {
    inp: Math.max(a.inp - b.inp, 0), cached: Math.max(a.cached - b.cached, 0),
    out: Math.max(a.out - b.out, 0), reasoning: Math.max(a.reasoning - b.reasoning, 0),
    total: Math.max(a.total - b.total, 0),
  };
}
function usageAdd(a, b) {
  return { inp: a.inp + b.inp, cached: a.cached + b.cached, out: a.out + b.out,
    reasoning: a.reasoning + b.reasoning, total: a.total + b.total };
}
// 되감긴 총계인지 확인한다. 압축·재개 직후에는 총계가 감소하지만 그 회차의 증가분은 유효하다.
function staleRegression(next, prev, last) {
  return next.total <= prev.total && last.total > 0 && next.total >= last.total;
}

// total 은 되감기는 스냅샷이고 last 가 그 회차의 증가분이다. 둘 중 무엇이 있는지에 따라 여섯 가지로 나뉜다.
export function resolveCodexDelta(total, last, prev) {
  if (total && last && prev) {
    if (usageEquals(total, prev)) return null;
    if (!usageMonotonic(total, prev) && staleRegression(total, prev, last)) return null;
    return { kind: "event", delta: last, next: total };
  }
  if (total && last) return { kind: "event", delta: last, next: total };
  if (total && prev) {
    if (usageEquals(total, prev)) return null;
    if (!usageMonotonic(total, prev)) return { kind: "baseline", next: total };
    return { kind: "event", delta: usageSub(total, prev), next: total };
  }
  if (total) return { kind: "event", delta: total, next: total };
  if (last && prev) return { kind: "event", delta: last, next: usageAdd(prev, last) };
  if (last) return { kind: "event", delta: last, next: null };
  return null;
}

function codexModel(payload) {
  if (!payload || typeof payload !== "object") return null;
  const direct = str(payload.model) || str(payload.model_name);
  if (direct) return direct;
  const info = payload.info;
  if (info && typeof info === "object") return str(info.model) || str(info.model_name);
  return null;
}

// 복사된 token_count 는 timestamp 와 두 수치 묶음이 글자까지 같다. 세션 id 는 갈래치기가
// 새로 쓰므로 키에 넣지 않는다.
function codexKey(timestamp, total, last) {
  const tup = (u) => (u ? [u.inp, u.cached, u.out, u.reasoning, u.total].join(",") : "");
  return `${timestamp}|${tup(total)}|${tup(last)}`;
}

export function parseCodexLine(line, ctx) {
  let r;
  try { r = JSON.parse(line); } catch { return null; }
  if (!r || !r.type || !r.payload) return null;

  if (r.type === "session_meta") {
    ctx.sessionId = str(r.payload.id) || str(r.payload.session_id) || ctx.sessionId;
    ctx.sessionCwd = str(r.payload.cwd);
    if (!ctx.cwd && ctx.sessionCwd) ctx.cwd = ctx.sessionCwd;
    return null;
  }
  if (r.type === "turn_context") {
    ctx.cwd = str(r.payload.cwd) || ctx.cwd || ctx.sessionCwd;
    ctx.model = codexModel(r.payload) || ctx.model;
    return null;
  }
  if (r.type !== "event_msg" || r.payload.type !== "token_count" || !r.timestamp) return null;

  const info = r.payload.info;
    // info 가 null 인 회차는 잔량 갱신 신호다. 손상된 줄이 아니므로 건너뛴다.
  if (!info || typeof info !== "object") return null;

  const total = rawUsage(info.total_token_usage);
  const last = rawUsage(info.last_token_usage);
  if (ctx.baselinePending) {
    ctx.baselinePending = false;
    if (total && !last && !ctx.prev) { ctx.prev = total; return null; }
  }
  const resolved = resolveCodexDelta(total, last, ctx.prev);
  if (!resolved) return null;
  if (resolved.kind === "baseline") { ctx.prev = resolved.next; return null; }

  const d = { ...resolved.delta, cached: Math.min(resolved.delta.cached, resolved.delta.inp) };
  if (d.inp + d.cached + d.out + d.reasoning + d.total <= 0) return null;
  ctx.prev = resolved.next;

  const model = codexModel(r.payload) || ctx.model;
  return {
    sessionId: ctx.sessionId, timestamp: r.timestamp,
    key: codexKey(r.timestamp, total, last),
    model, cwd: ctx.cwd || ctx.sessionCwd,
    inp: d.inp, cached: d.cached, out: d.out, reasoning: d.reasoning, total: d.total,
  };
}

export async function parseCodexFile(file) {
  const ctx = {
    sessionId: path.basename(file, ".jsonl"), sessionCwd: null, cwd: null,
    model: null, prev: null, baselinePending: true,
  };
  const events = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf-8" }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line) continue;
      const e = parseCodexLine(line, ctx);
      if (e) events.push(e);
    }
  } finally { rl.close(); }
  return events;
}

// 파일 하나의 집계
const ZERO_CLAUDE = { turns: 0, inp: 0, out: 0, cr: 0, cw: 0 };
const ZERO_CODEX = { events: 0, inp: 0, cached: 0, out: 0, reasoning: 0, total: 0 };

function addInto(target, src) {
  for (const k of Object.keys(target)) if (typeof src[k] === "number") target[k] += src[k];
}

function foldRows(rows, kind) {
  const zero = kind === "claude" ? ZERO_CLAUDE : ZERO_CODEX;
  const sessions = new Map();
  const daily = new Map();
  for (const r of rows) {
    const day = dayOf(r.timestamp);
    if (!day) continue;
    const project = projectLabel(r.cwd);
    const model = r.model || "알 수 없는 모델";
    const bump = kind === "claude"
      ? { turns: 1, inp: r.inp, out: r.out, cr: r.cr, cw: r.cw }
      : { events: 1, inp: r.inp, cached: r.cached, out: r.out, reasoning: r.reasoning, total: r.total };

    let s = sessions.get(r.sessionId);
    if (!s) { s = { id: r.sessionId, first: r.timestamp, last: r.timestamp, model, project, ...zero }; sessions.set(r.sessionId, s); }
    if (r.timestamp < s.first) s.first = r.timestamp;
    if (r.timestamp >= s.last) { s.last = r.timestamp; s.model = model; s.project = project; }
    addInto(s, bump);

    const dk = `${day} ${model} ${project}`;
    let d = daily.get(dk);
    if (!d) { d = { day, model, project, ...zero }; daily.set(dk, d); }
    addInto(d, bump);
  }
  return { sessions: [...sessions.values()], daily: [...daily.values()] };
}

// 앞 파일이 이미 집계한 키는 이 파일의 것이 아니다. 순서상 먼저 차지한 쪽이 소유자다.
// 지문 하나로 줄여 두면 다음 회차가 소유자가 같은지를 한 번의 비교로 판정한다.
function sigOf(owned) { return keyHash(owned.join("|")); }

export function claimKeys(seen, owner) {
  const owned = [];
  for (const h of seen) if (!owner.has(h)) { owner.add(h); owned.push(h); }
  return { owned, sig: sigOf(owned) };
}

// 스캔
// 캐시를 그대로 쓸 수 있는지는 파일이 바뀌지 않은 것만으로 정해지지 않는다. 앞 파일이
// 사라지면 이 파일이 새 소유자가 되는 키가 생기므로, 소유자 목록이 같은지도 확인한다.
async function scanKind(kind, prevFiles, onProgress) {
  const files = await listFiles(kind === "claude" ? claudeDirs() : codexDirs());
  const owner = new Set();
  const next = {};
  let parsed = 0, reused = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    let st;
    try { st = await fsp.stat(file); } catch { continue; }
    const cached = prevFiles[file];
    const fresh = cached && cached.m === st.mtimeMs && cached.s === st.size && Array.isArray(cached.k);

    if (fresh) {
      const claimed = claimKeys(cached.k, owner);
      if (claimed.sig === cached.g) {
        next[file] = cached;
        reused++;
        if (onProgress && i % 50 === 0) onProgress({ kind, done: i + 1, total: files.length, parsed, reused });
        continue;
      }
      // 소유자가 달라졌으므로 이 파일만 다시 읽는다. 방금 넣은 값은 아래에서 다시 채운다.
      for (const h of claimed.owned) owner.delete(h);
    }

    let rows;
    try {
      rows = kind === "claude" ? await parseClaudeFile(file) : await parseCodexFile(file);
    } catch { continue; }

    // 소유자 지문은 다음 회차가 이 파일의 캐시를 신뢰해도 되는지 판정하는 값이다. 파일을 읽는
    // 경로와 캐시를 다시 쓰는 경로가 같은 함수(claimKeys)로 소유자를 정해야 결과가 일치한다.
    // 목록을 순회해 중복을 제거하지 않는다. 큰 파일에서 그 처리가 회차당 몇 분이 걸렸다.
    const hashes = rows.map((r) => (r.key ? keyHash(r.key) : null));
    const seen = hashes.filter(Boolean);
    const claimed = claimKeys(seen, owner);
    const mine = new Set(claimed.owned);
    const kept = rows.filter((r, at) => {
      const h = hashes[at];
      if (!h) return true;              // 키가 없는 줄은 비교 대상이 없어 그대로 집계한다
      if (!mine.has(h)) return false;   // 앞 파일이 이미 집계한 턴이다(갈래치기가 복사한 줄)
      mine.delete(h);                   // 파일 안에서 같은 키가 또 나오면 그것도 사본이다
      return true;
    });
    next[file] = { m: st.mtimeMs, s: st.size, k: seen, g: claimed.sig, ...foldRows(kept, kind) };
    parsed++;
    if (onProgress && parsed % 10 === 0) onProgress({ kind, done: i + 1, total: files.length, parsed, reused });
  }

  if (onProgress) onProgress({ kind, done: files.length, total: files.length, parsed, reused });
  return { files: next, fileCount: files.length, parsed, reused };
}

export async function scanHistory(prev, onProgress) {
  const started = Date.now();
  const base = prev && prev.schema === HISTORY_SCHEMA ? prev : { claude: { files: {} }, codex: { files: {} } };
  const claude = await scanKind("claude", (base.claude && base.claude.files) || {}, onProgress);
  const codex = await scanKind("codex", (base.codex && base.codex.files) || {}, onProgress);
  return {
    schema: HISTORY_SCHEMA,
    scannedAt: Date.now(), durationMs: Date.now() - started,
    claude, codex,
  };
}

// 화면이 받는 요약
function mergeAll(files, kind) {
  const zero = kind === "claude" ? ZERO_CLAUDE : ZERO_CODEX;
  const sessions = new Map();
  const daily = new Map();
  for (const f of Object.values(files || {})) {
    for (const s of f.sessions || []) {
      let cur = sessions.get(s.id);
      if (!cur) { cur = { id: s.id, first: s.first, last: s.last, model: s.model, project: s.project, ...zero }; sessions.set(s.id, cur); }
      if (s.first < cur.first) cur.first = s.first;
      if (s.last >= cur.last) { cur.last = s.last; cur.model = s.model; cur.project = s.project; }
      addInto(cur, s);
    }
    for (const d of f.daily || []) {
      const dk = `${d.day} ${d.model} ${d.project}`;
      let cur = daily.get(dk);
      if (!cur) { cur = { day: d.day, model: d.model, project: d.project, ...zero }; daily.set(dk, cur); }
      addInto(cur, d);
    }
  }
  return { sessions: [...sessions.values()], daily: [...daily.values()] };
}

function totalOf(row, kind) {
  return kind === "claude" ? row.inp + row.out + row.cr + row.cw : row.total || (row.inp + row.out + row.reasoning);
}

function topList(rows, field, kind) {
  const by = new Map();
  for (const r of rows) {
    const k = r[field];
    const cur = by.get(k) || { name: k, tokens: 0, count: 0 };
    cur.tokens += totalOf(r, kind);
    cur.count += kind === "claude" ? r.turns : r.events;
    by.set(k, cur);
  }
  return [...by.values()].sort((a, b) => b.tokens - a.tokens).slice(0, TOP_N);
}

function providerSummary(kindState, kind) {
  const { sessions, daily } = mergeAll(kindState && kindState.files, kind);
  const zero = kind === "claude" ? ZERO_CLAUDE : ZERO_CODEX;
  const totals = { ...zero };
  const byDay = new Map();
  for (const d of daily) {
    addInto(totals, d);
    let cur = byDay.get(d.day);
    if (!cur) { cur = { day: d.day, ...zero }; byDay.set(d.day, cur); }
    addInto(cur, d);
  }
  const days = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  return {
    fileCount: (kindState && kindState.fileCount) || 0,
    sessionCount: sessions.length,
    activeDays: days.length,
    firstDay: days.length ? days[0].day : null,
    lastDay: days.length ? days[days.length - 1].day : null,
    totals,
    totalTokens: totalOf(totals, kind),
    daily: days.slice(-DAY_KEEP),
    models: topList(daily, "model", kind),
    projects: topList(daily, "project", kind),
    recent: sessions
      .sort((a, b) => (a.last < b.last ? 1 : -1))
      .slice(0, RECENT_SESSIONS)
      .map((s) => ({ ...s, tokens: totalOf(s, kind) })),
  };
}

export function buildSummary(state) {
  if (!state || state.schema !== HISTORY_SCHEMA) return null;
  return {
    scannedAt: state.scannedAt || 0,
    durationMs: state.durationMs || 0,
    claude: providerSummary(state.claude, "claude"),
    codex: providerSummary(state.codex, "codex"),
  };
}
