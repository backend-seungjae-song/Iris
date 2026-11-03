import { createHash } from "node:crypto";
import { promptList, terminalSelection, joinFragments } from "./terminal.js";

const OPTION_LINE = /^\s*(?:(?:[›❯]\s*)?\d+[.)]|[›❯●○])\s+\S/u;

export function hasOptionLines(frame) {
  return typeof frame?.text === "string" && frame.text.split(/\r?\n/).some(line => OPTION_LINE.test(line));
}

const SEPARATOR = /^\s*[─━═\-_]{8,}\s*$/u;
const BOX_EDGE = /^\s*[╭╮╰╯┌┐└┘├┤][─━═╌┄\s╭╮╰╯┌┐└┘├┤]*$/u;
const CHAT = /^(?:chat about|대화|채팅)/i;
const DENY = /^(?:no\b|decline|cancel|deny|reject|stop|skip|아니|거절|취소)/i;
const ALWAYS = /(?:don.?t ask again|always allow|always|remember|for this session|for the session|this session|future|for these files|for all|항상|다시 묻지)/i;
const ALLOW = /^(?:yes|allow|proceed|approve|grant|run|continue|accept|ok|provide|submit|예|허용|승인|확인)/i;

function cleanOption(text) {
  return text.replace(/^\s*(?:[›❯●○]\s*)?(?:\d+[.)]\s*)?/u, "").trim();
}

// 선택지 문구로 역할 판정, 거절이 먼저라 "No, and don't ask again" 도 거절
export function optionRole(text) {
  const label = cleanOption(text);
  if (DENY.test(label)) return "deny";
  if (/^always/i.test(label)) return "allowAlways";
  if (ALLOW.test(label)) return ALWAYS.test(label) ? "allowAlways" : "allow";
  return "choice";
}

// 탭 줄의 질문 칸 수와 현재 순서, 마지막 Submit 칸은 질문이 아니고 답한 칸은 ☒·☑ 로 표시됨
function stepsOf(row) {
  const cells = [...row.matchAll(/([☐☒☑✔])\s+([^☐☒☑✔←→]*)/gu)].filter(m => !/^\s*Submit\b/i.test(m[2]));
  if (cells.length < 2 || cells.length > 20) return null;
  const answered = cells.filter(m => m[1] === "☒" || m[1] === "☑").length;
  return { step: Math.min(answered + 1, cells.length), steps: cells.length };
}

// 제출 확인 화면: "● 질문 / → 답" 쌍을 번호 목록으로, 제목은 마지막 물음 줄, 경고 줄은 detail 에 남김
function reviewOf(lines) {
  const rows = lines.map(line => line.replace(/^\s*[│┃|]\s?/u, "").trim());
  if (!rows.some(row => /^review your answers/i.test(row))) return null;
  const entries = [];
  const warnings = [];
  let title = "";
  for (const row of rows) {
    if (!row || /^review your answers/i.test(row)) continue;
    if (/^●/u.test(row)) entries.push({ question: row.replace(/^●\s*/u, ""), answer: "" });
    else if (/^[→➜]/u.test(row) && entries.length) entries.at(-1).answer = row.replace(/^[→➜]\s*/u, "");
    else if (/^[⚠!]/u.test(row)) warnings.push(row);
    else if (/[?？]$/.test(row) && /submit/i.test(row)) title = row;
    else if (entries.length) {
      const last = entries.at(-1);
      if (last.answer) last.answer += ` ${row}`; else last.question += ` ${row}`;
    }
  }
  const detail = [...entries.map((e, i) => `${i + 1}. ${e.question}\n   → ${e.answer}`), ...warnings].join("\n").slice(0, 1500);
  return { title: title || "Ready to submit your answers?", detail };
}

// Codex 질문·승인 화면의 첫 줄: 구분선이 없어 이 줄에서 맥락을 자름
const HEADER = /^\s{0,3}(?:Question\s+\d+\/\d+\b.*|Would you like to\b.*|Do you want to\b.*|Implement this plan\?.*|Ready to submit\b.*)$/i;
const TIP = /^\s*Tip:/i;

// 경로 하드 랩 이음과 공통 들여쓰기 제거
function joinWrapped(lines) {
  const out = [];
  let glue = false;
  for (const line of lines) {
    const prev = out.at(-1);
    const part = line.trim();
    if (glue && part) { out[out.length - 1] = joinFragments([prev, part]); glue = false; continue; }
    out.push(line);
    glue = Boolean(part) && /^[^\s]+$/.test(part) === false ? false : Boolean(part) && /\//.test(part) && part.split(/\s+/).at(-1).length >= 35;
  }
  const indents = out.filter(l => l.trim()).map(l => l.length - l.trimStart().length);
  const base = indents.length ? Math.min(...indents) : 0;
  return out.map(l => l.slice(Math.min(base, l.length - l.trimStart().length)));
}

// 상자 안 장식 줄(╌ 구분선, Tip 안내와 이어지는 줄)을 뺀 본문
function cleanDetail(lines) {
  const out = [];
  let skip = 0;
  for (const line of lines) {
    if (skip > 0) { skip--; continue; }
    if (/^\s*[─━═╌┄\-_]{8,}\s*$/u.test(line)) continue;
    if (TIP.test(line)) { skip = (line.match(/"/g) || []).length % 2 ? 1 : 0; continue; }
    out.push(line);
  }
  // 상자 첫 줄의 종류 제목(Bash command 등)은 화면 종류 표시와 겹쳐 뺌
  if (out.length && /^\s*(?:Bash command|Edit file|Create file|Fetch|Tool use|Web Search|Read file|Delete file)\s*$/i.test(out[0])) out.shift();
  // Codex 사유 문단은 줄바꿈을 이어 한 문단으로
  const merged = [];
  let reason = false;
  for (const line of out) {
    if (/^\s*Reason:/i.test(line)) { reason = true; merged.push(line.trim()); continue; }
    if (reason && line.trim() && !/^\s*(?:\$|Environment:|Description:|Destination:)/.test(line)) { merged[merged.length - 1] += ` ${line.trim()}`; continue; }
    reason = false;
    merged.push(line);
  }
  return joinWrapped(merged).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// 계획 모드 본문: "Here is Claude's plan:" 아래부터 구분선 전까지, 스크롤 표시 제거
function planBody(lines, end) {
  let start = -1;
  for (let i = end - 1; i >= 0 && end - i < 120; i--) if (/Here is Claude.s plan:?\s*$/i.test(lines[i])) { start = i + 1; break; }
  if (start < 0) return "";
  const body = [];
  for (let i = start; i < end; i++) {
    const line = lines[i].replace(/\s*[↓↑]\s*$/u, "");
    if (SEPARATOR.test(line)) break;
    if (/^\s*[╌┄]{8,}\s*$/u.test(line)) continue;
    body.push(line.replace(/^\s{0,3}/, ""));
  }
  return body.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 4000);
}

// 선택지 위 맥락 줄, 구분선이나 앞 질문에서 멈추고 마지막 물음 줄을 제목으로 삼음
function promptContext(lines, end) {
  let block = [], boxed = false;
  for (let i = end - 1; i >= 0 && block.length < 60; i--) {
    if (SEPARATOR.test(lines[i])) { boxed = true; break; }
    if (BOX_EDGE.test(lines[i])) { boxed = true; continue; }
    block.unshift(lines[i].replace(/^\s*[│┃|]\s?|\s*[│┃|]\s*$/gu, "").trimEnd());
  }
  const sepAt = boxed ? end - 1 - block.length : -1;
  while (block.length && !block[0].trim()) block.shift();
  while (block.length && !block.at(-1).trim()) block.pop();
  const tabRow = line => /[☐☒✔]\s+\S/.test(line) && /(?:Submit|←|→|☐)/.test(line);
  const tabAt = block.map(tabRow).lastIndexOf(true);
  let steps = tabAt >= 0 ? stepsOf(block[tabAt]) : null;
  const review = tabAt >= 0 ? reviewOf(block.slice(tabAt + 1)) : null;
  if (review) return { ...review, text: block.join("\n"), steps };
  // Codex: 구분선 없이 이어진 기록 위쪽을 헤더 줄에서 자름
  if (!boxed) {
    let headerAt = -1;
    block.forEach((line, i) => { if (HEADER.test(line)) headerAt = i; });
    if (headerAt >= 0) {
      const before = block.slice(0, headerAt);
      block = block.slice(headerAt);
      const header = block[0].trim();
      const counted = header.match(/^Question\s+(\d+)\/(\d+)/i);
      // 질문이 하나뿐이면 단계 표시 없음(계약은 steps 2 이상)
      if (counted && Number(counted[2]) >= 2 && Number(counted[1]) <= Number(counted[2])) steps = { step: Number(counted[1]), steps: Number(counted[2]) };
      const rest = block.slice(1).map(l => l.replace(/^\s{1,4}/, ""));
      while (rest.length && !rest[0].trim()) rest.shift();
      let head = counted ? [] : [header];
      let at = 0;
      if (counted) {
        while (at < rest.length && rest[at].trim()) head.push(rest[at++].trim());
      }
      const title = head.join(" ").replace(/\s+/g, " ").slice(0, 400);
      let detail = cleanDetail(rest.slice(at)).slice(0, 1500);
      // 계획 확인은 위쪽 계획 본문이 판단 근거, 마지막 입력 에코(›) 아래부터
      if (/^Implement this plan/i.test(header)) {
        const echo = before.map(l => /^\s*›/.test(l)).lastIndexOf(true);
        detail = cleanDetail(before.slice(echo + 1).filter(l => !/^\s*Worked for\b/i.test(l))).slice(0, 4000);
      }
      return { title, detail, text: block.join("\n"), steps };
    }
  }
  const rest = block.filter(line => !tabRow(line));
  let title, detail;
  if (tabAt >= 0) {
    // Claude 질문 상자는 탭 줄 아래 모든 줄이 질문 본문
    title = block.slice(tabAt + 1).map(line => line.replace(/^\s*[│┃|]\s?/u, "").trim()).filter(Boolean).join(" ").slice(0, 400);
    detail = "";
  } else {
    let at = -1;
    rest.forEach((line, i) => { if (/[?？]\s*$/.test(line.trim())) at = i; });
    if (at < 0) at = rest.findIndex(line => line.trim());
    // 줄바꿈된 물음: 마지막 물음 줄에서 위로 이어진 문단을 제목으로
    let from = at;
    while (from > 0 && /^[a-z]/.test(rest[from].trim()) && rest[from - 1].trim()) from--;
    title = rest.slice(from, at + 1).map(line => line.trim()).join(" ").slice(0, 400) || (rest[at] || "").trim().slice(0, 400);
    detail = cleanDetail(rest.filter((_, i) => i < from || i > at));
    if (/^Claude has written up a plan/i.test(title)) detail = planBody(lines, sepAt >= 0 ? sepAt : end - 1) || detail;
    detail = detail.slice(0, 4000);
  }
  return { title, detail, text: block.join("\n"), steps };
}

// 승인 종류, 문구가 없으면 역할 조합으로 일반 승인과 선택 구분
function promptVariant(context, options) {
  const text = context.text;
  if (/review your answers|submit (?:your )?answers|ready to submit/i.test(text)) return "review";
  if (/do you trust|trust the (?:files|contents|folder)/i.test(text)) return "trust";
  if (/network access|approve network|connect to/i.test(text)) return "network";
  if (/grant (?:these )?permissions|additional permissions|permission request/i.test(text)) return "permissions";
  if (/following command|bash command|run (?:this|the) command|shell command/i.test(text)) return "command";
  if (/following edits|this edit|make this edit|apply (?:the )?(?:patch|changes)|create file|write to|edit file|diff/i.test(text)) return "edit";
  if (/tool call|allow this request|run the tool|mcp|requested info/i.test(text)) return "tool";
  if (/ready to code|proceed with (?:this|the) plan|\bplan\b/i.test(text)) return "plan";
  const roles = new Set(options.map(o => o.role));
  return roles.has("deny") && (roles.has("allow") || roles.has("allowAlways")) ? "approval" : "choice";
}

// 2열 선택지("라벨    설명")는 설명으로 나눔, 선택·제출 확인이 아닌 승인류에서 줄바꿈된 라벨은 이어 붙임
function normalizeOption(option, variant) {
  const split = option.text.match(/^(.*?\S)\s{2,}(\S.*)$/u);
  if (split) {
    option.description = joinFragments([split[2], option.description].filter(Boolean));
    option.text = split[1];
  } else if (variant !== "choice" && variant !== "review" && option.description) {
    option.text = joinFragments([option.text, option.description]);
    option.description = "";
  }
  option.text = option.text.slice(0, 300);
  option.description = option.description.slice(0, 300);
}

// fallback: 질문이 길어 본문이 화면 위로 밀려났을 때 쓸 질문 원문(훅이 받은 질문·승인 도구 설명)
export function extractPrompt(frame, fallback = '') {
  if (!frame || frame.error || frame.truncated || typeof frame.text !== "string"
    || !/^[0-9a-f]{64}$/.test(frame.hash) || !Number.isSafeInteger(frame.columns)
    || !Number.isSafeInteger(frame.rows) || frame.columns < 1 || frame.rows < 1
    || frame.columns > 4096 || frame.rows > 4096 || Buffer.byteLength(frame.text) > 48 * 1024) return null;
  const text = frame.text.replace(/\r\n/g, "\n").replace(/\t/g, " ").replace(/\x1b\[[0-9;]*m/g, "");
  if (/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text)) return null;
  const lines = text.split(/\r?\n/);
  const list = promptList(frame.text);
  const options = (list?.items || []).map(item => ({ row: item.row, text: item.text.slice(0, 300), description: item.description }));
  if (options.some(o => o.row > frame.rows) || options.length < 2 || options.length > 12) return null;
  const before = lines.slice(0, options[0].row - 1);
  while (before.length && !before.at(-1).trim()) before.pop();
  const paragraph = [];
  while (before.length && before.at(-1).trim() && paragraph.length < 8) paragraph.unshift(before.pop().trim().replace(/^[│┃|]\s?/u, "").replace(/\s*[│┃|]$/u, ""));
  const question = paragraph.join('\n').slice(-1000) || String(fallback || '').trim().slice(0, 1000);
  if (!question) return null;
  const context = promptContext(lines, options[0].row - 1);
  const BOX = /^\s*(?:[›❯]\s*)?(?:\d+[.)]\s*)?(\[[^\]]\]|\([^)]\)|[☐☑☒✔])\s*/u;
  const boxed = options.map(o => o.text.match(BOX));
  const hasBoxes = boxed.some(Boolean);
  options.forEach((o, i) => {
    const m = boxed[i];
    if (!m) return;
    o.checked = /[xX✔✓☑☒*●]/u.test(m[1]);
    o.text = o.text.replace(m[1], "").replace(/\s{2,}/g, " ").trim();
  });
  const multiSelect = hasBoxes || /(?:multi.?select|select (?:all|multiple)|space to (?:select|toggle)|복수|여러 개)/i.test(text);
  const free = /(?:\bother\b|type (?:your|something|an? (?:answer|response))|직접 입력|기타)/i;
  const roled = options.map(o => ({ ...o, selectable: !free.test(o.text),
    role: free.test(o.text) ? "text" : CHAT.test(cleanOption(o.text)) ? "chat" : optionRole(o.text) }));
  const variant = promptVariant(context, roled);
  roled.forEach(o => normalizeOption(o, variant));
  return { question, title: context.title, detail: context.detail, ...(context.steps || {}), variant,
    options: roled, selectedRow: options.find(o => terminalSelection(frame.text, o.row) === 0).row,
    multiSelect, hash: frame.hash, columns: frame.columns, rows: frame.rows };
}

// 도구 이름·대상 훅을 붙여도 되는 승인 화면. 폴더 신뢰·질문·제출 확인에 낡은 훅이 붙는 것을 막는다
const HINTED_VARIANTS = new Set(['command', 'edit', 'network', 'permissions', 'tool', 'plan', 'approval']);

export function createPromptStore({ agents, requests, terminalQuestions, terminal, setTimer = setTimeout, clearTimer = clearTimeout,
  now = Date.now, log = code => console.warn(`[remote] prompt reason=${code}`) }) {
  const records = new Map(), listeners = new Set(), retired = new Set(), seen = new Map(), connections = new Set(), answered = new Set();
  // 에이전트별 처음 본 순서, 화면이 바뀌어 기록을 다시 만들어도 목록 순서 유지
  const order = new Map(); let sequence = 0;
  let timer, reading = false, cursor = 0, closed = false;
  // herdr 가 질문 중에도 blocked 로 보고하지 않는 경우가 있어, 훅이 질문을 받아 둔 에이전트도 대기 중으로 봄
  const waiting = agent => agent.status === 'blocked' || !!agent.question || !!terminalQuestions?.list().some(q => q.agent === agent.ref);
  const blocked = () => new Set((requests?.list() || []).map(r => r.agent));
  function list() {
    const excluded = blocked();
    for (const [ref, record] of records) {
      const agent = agents.resolve(ref);
      if (!agent || !waiting(agent) || excluded.has(ref) || now() >= record.request.expiresAt) {
        log(!agent ? "session-ended" : now() >= record.request.expiresAt ? "expired" : "computer-answered"); retire(record); records.delete(ref);
      }
    }
    return [...records.values()].sort((a, b) => order.get(a.agent) - order.get(b.agent)).map(r => r.request);
  }
  function notify() { for (const fn of listeners) fn(); }
  function retire(record) {
    retired.add(record.agent + record.hash);
    if (retired.size > 128) retired.delete(retired.keys().next().value);
  }
  async function poll() {
    if (reading || closed || !connections.size) return;
    reading = true;
    const previous = JSON.stringify(list());
    try {
      const excluded = blocked();
      const pending = agents.list().filter(a => waiting(a) && !excluded.has(a.ref));
      const active = new Set(pending.map(a => a.ref));
      for (const [ref, record] of records) if (!active.has(ref)) { retire(record); records.delete(ref); }
      for (const ref of answered) if (!active.has(ref)) answered.delete(ref);
      const batch = Array.from({ length: Math.min(4, pending.length) }, (_, i) => pending[(cursor + i) % pending.length]);
      cursor += batch.length;
      for (const candidate of batch) {
        const agent = agents.resolve(candidate.ref);
        if (!agent) continue;
        let frame;
        try { frame = await terminal.readPrompt(agent); } catch { log("read-failed"); }
        if (closed) return;
        const current = agents.resolve(candidate.ref);
        if (!current || !waiting(current) || blocked().has(candidate.ref)) continue;
        const old = records.get(candidate.ref);
        const hint = terminalQuestions?.hint?.(candidate.ref) || null; // AskUserQuestion 훅은 PreToolUse 로 따로 받음
        const hintKey = hint ? `${hint.tool}\n${hint.target}` : '';
        if (old && old.hash === frame?.hash && old.hintKey === hintKey && old.structured === terminalQuestions?.list().find(q => q.agent === candidate.ref)?.ref) continue;
        if (!old && seen.has(candidate.ref) && seen.get(candidate.ref) === frame?.hash) continue;
        seen.set(candidate.ref, frame?.hash);
        if (seen.size > 128) seen.delete(seen.keys().next().value);
        // 체크 전환처럼 화면이 이전 상태로 되돌아올 수 있어, 화면이 바뀐 것만으로는 이전 화면을 폐기 목록에 넣지 않음
        if (old) records.delete(candidate.ref);
        if (retired.has(candidate.ref + frame?.hash) && !terminalQuestions?.list().some(q => q.agent === candidate.ref)) continue;
        let saved = terminalQuestions?.list().find(q => q.agent === candidate.ref);
        const prompt = extractPrompt(frame, saved?.body.questions?.[0]?.question || (hint ? `${hint.tool} ${hint.target}` : ''));
        if (old?.structured && old.request.body.screen && frame && !frame.error
          && prompt && prompt.question !== old.request.body.screen.question && old.hash !== frame.hash) {
          terminalQuestions?.dismiss?.(old.structured, "computer-answered");
          saved = undefined;
        }
        // 폰 연결 전에 컴퓨터에서 답한 보관 질문: 선택 목록이 화면에서 사라진 경우
        if (!old && saved && frame && !frame.error && !hasOptionLines(frame)) {
          terminalQuestions?.dismiss?.(saved.ref, "computer-answered");
          continue;
        }
        // 화면 일시 변화로 판독 실패한 프레임은 기존 질문 유지, 선택 목록이 보이거나 읽기 실패면 아직 답 전
        // 읽기 실패(시간 초과 등)인 프레임도 기존 질문 유지
        if (!prompt && old?.request.body.screen) {
          // 선택지가 안 보이는 프레임이 3번 이어질 때만 답한 것으로 보고 질문을 닫음, 다시 그리는 중간 프레임에 카드가 깜빡이지 않게 함
          const gone = frame && !frame.error && !hasOptionLines(frame);
          old.misses = gone ? (old.misses || 0) + 1 : 0;
          retired.delete(old.agent + old.hash);
          if (!gone || old.misses < 3) records.set(candidate.ref, old);
          else { answered.add(candidate.ref); if (old.structured) terminalQuestions?.dismiss?.(old.structured, "computer-answered"); }
          continue;
        }
        // 인식했던 질문이 닫힌 뒤 같은 대기 상태에서 읽은 답 후 화면으로는 빈 카드를 만들지 않음
        if (!prompt && answered.has(candidate.ref)) continue;
        if (prompt) answered.delete(candidate.ref);
        if (!prompt) log(frame?.error || 'unrecognized');
        // 선택 목록이 없는 정상 화면은 마지막 말이 질문으로 끝난 대기 상태일 뿐 답할 선택지가 없어 카드를 만들지 않음
        if (!prompt && !saved && frame && !frame.error && !hasOptionLines(frame)) continue;
        if (prompt) { terminal.markPrompt?.(candidate.ref, frame.hash); terminalQuestions?.touch?.(candidate.ref); }
        const at = now();
        if (!order.has(candidate.ref)) { order.set(candidate.ref, sequence++); if (order.size > 256) order.delete(order.keys().next().value); }
        // 식별자는 같은 질문이 유지되는 동안 고정, 화면 해시(타이머 등 변동)로 바꾸지 않음
        const identity = saved?.ref || prompt?.question || frame?.hash || 'unreadable';
        const ref = createHash('sha256').update(candidate.ref + identity).digest('hex').slice(0, 32);
        let questions = saved?.body.questions || (prompt ? [{ question: prompt.question, header: '터미널 질문',
          multiSelect: prompt.multiSelect, options: prompt.options.map(o => ({ label: o.text, description: '' })) }] : []);
        const request = { ref, agent: candidate.ref, kind: 'terminal-prompt', createdAt: old?.request.createdAt ?? at, expiresAt: at + 86400000,
          body: { questions, screen: prompt && hint && HINTED_VARIANTS.has(prompt.variant) ? { ...prompt, tool: hint.tool, ...(hint.target ? { target: hint.target } : {}) } : prompt } };
        records.set(candidate.ref, { agent: candidate.ref, hash: frame?.hash, hintKey, structured: saved?.ref, request });
        log('detected');
      }
    } finally {
      reading = false;
      if (previous !== JSON.stringify(list())) notify();
      if (!closed && connections.size) { timer = setTimer(() => { timer = null; void poll(); }, 1000); timer?.unref?.(); }
    }
  }
  const subscriptions = [requests, terminalQuestions, agents].map(store => store?.subscribe?.(() => notify()));
  return { list, poll,
    start(connId) { connections.add(connId); if (!timer && !reading) void poll(); },
    stop(connId) { connections.delete(connId); if (!connections.size && timer) { clearTimer(timer); timer = null; } },
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); if (!listeners.size && timer) { clearTimer(timer); timer = null; } }; },
    close() { closed = true; if (timer) clearTimer(timer); subscriptions.forEach(fn => fn?.()); records.clear(); listeners.clear(); } };
}
