// Claude Code AskUserQuestion 을 Paseo 질문 카드로 보이고 답을 터미널 키로 넣음
// - 질문 내용은 기록의 tool_use 입력. 터미널 화면에는 설명이 잘리고 여러 개 고르기 여부가 틀리게 보임
// - 키는 실제 화면에서 잰 것: 단일 선택 = 줄 이동 + Enter, 여러 개 = 줄마다 Space + Submit 줄 Enter,
//   직접 입력 = Type something 줄에서 글(여러 개면 체크가 저절로 켜짐), 마지막 확인 화면 = Submit answers Enter

// 화면 선택지 글의 앞 표시("❯ 1. ") 를 뗀 단추 이름
export function optionLabel(text) {
  return String(text || "").replace(/^\s*(?:[›❯●○]\s*)?(?:\d+[.)]\s*)?/u, "").trim();
}

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 8;

function parseQuestions(input) {
  const list = Array.isArray(input?.questions) ? input.questions : null;
  if (!list?.length || list.length > MAX_QUESTIONS) return null;
  const out = [];
  for (const q of list) {
    if (typeof q?.question !== "string" || !q.question.trim() || !Array.isArray(q.options)) return null;
    const options = [];
    for (const o of q.options.slice(0, MAX_OPTIONS)) {
      if (typeof o?.label !== "string" || !o.label.trim()) return null;
      options.push({ label: o.label, description: typeof o.description === "string" ? o.description : "",
        ...(typeof o.preview === "string" && o.preview ? { preview: o.preview } : {}) });
    }
    out.push({ question: q.question, header: typeof q.header === "string" && q.header ? q.header : q.question, multiSelect: q.multiSelect === true, options });
  }
  return out;
}

// 기록(JSONL 줄들) 끝에서 아직 답이 없는 AskUserQuestion. { toolUseId, questions } | null
export function pendingQuestion(lines) {
  const answered = new Set();
  for (let i = lines.length - 1; i >= 0; i--) {
    let rec;
    try { rec = JSON.parse(lines[i]); } catch { continue; }
    const content = Array.isArray(rec?.message?.content) ? rec.message.content : [];
    if (rec?.type === "user") {
      for (const c of content) if (c?.type === "tool_result" && typeof c.tool_use_id === "string") answered.add(c.tool_use_id);
      // 사람이 쓴 말이 나오면 그 앞 질문은 끝난 것
      if (typeof rec.message?.content === "string" || content.some((c) => c?.type === "text")) return null;
      continue;
    }
    if (rec?.type !== "assistant") continue;
    for (const c of content.slice().reverse()) {
      if (c?.type !== "tool_use" || c.name !== "AskUserQuestion" || typeof c.id !== "string") continue;
      if (answered.has(c.id)) return null;
      const questions = parseQuestions(c.input);
      return questions ? { toolUseId: c.id, questions } : null;
    }
  }
  return null;
}

// 이어 받은 기록 묶음으로 답 없는 AskUserQuestion id 를 갱신. 없으면 null
// - herdr 가 질문 중에도 blocked 로 보고하지 않을 때가 있어, 이 값이 있으면 질문 화면을 읽음
export function openAskAfter(open, records) {
  for (const rec of records) {
    const content = Array.isArray(rec?.message?.content) ? rec.message.content : [];
    if (rec?.type === "assistant") {
      for (const c of content) if (c?.type === "tool_use" && c.name === "AskUserQuestion" && typeof c.id === "string") open = c.id;
    } else if (rec?.type === "user") {
      if (typeof rec.message?.content === "string" || content.some((c) => c?.type === "text")) open = null;
      else if (content.some((c) => c?.type === "tool_result" && c.tool_use_id === open)) open = null;
    }
  }
  return open;
}

// 기록 끝의 결과 없는 도구 호출 하나의 이름과 입력을 글로. 승인 화면 위가 잘려 내용이 안 보일 때 씀
// - 결과 없는 호출이 둘 이상이면 어느 것을 묻는지 알 수 없어 null
export function pendingToolInput(lines) {
  const answered = new Set();
  for (let i = lines.length - 1; i >= 0; i--) {
    let rec;
    try { rec = JSON.parse(lines[i]); } catch { continue; }
    const content = Array.isArray(rec?.message?.content) ? rec.message.content : [];
    if (rec?.type === "user") {
      for (const c of content) if (c?.type === "tool_result" && typeof c.tool_use_id === "string") answered.add(c.tool_use_id);
      if (typeof rec.message?.content === "string" || content.some((c) => c?.type === "text")) return null;
      continue;
    }
    if (rec?.type !== "assistant" || !content.some((c) => c?.type === "tool_use")) continue;
    const open = content.filter((c) => c?.type === "tool_use" && typeof c.name === "string" && !answered.has(c.id));
    if (open.length !== 1) return null;
    const { name, input } = open[0];
    const rows = Object.entries(input && typeof input === "object" ? input : {}).map(([key, value]) => {
      if (typeof value === "string") return value.includes("\n") ? `${key}:\n${value.split("\n").map((l) => `  ${l}`).join("\n")}` : `${key}: ${value}`;
      return `${key}: ${JSON.stringify(value)}`;
    });
    return [name, ...rows].join("\n");
  }
  return null;
}

// Codex 기록(rollout JSONL 줄들) 끝에서 아직 답이 없는 request_user_input. { toolUseId, questions } | null
// - 질문 모양은 Paseo codex-app-server-agent.ts normalizeCodexQuestionPrompts 와 같음(id·header·question 필수)
// - 여러 개 고르기·선택지 없는 질문은 터미널 화면을 재지 않아 제외(일반 카드로 남음)
export function pendingCodexQuestion(lines) {
  const answered = new Set();
  for (let i = lines.length - 1; i >= 0; i--) {
    let rec;
    try { rec = JSON.parse(lines[i]); } catch { continue; }
    const p = rec?.type === "response_item" ? rec.payload : null;
    if (!p) continue;
    if (p.type === "function_call_output" && typeof p.call_id === "string") { answered.add(p.call_id); continue; }
    if (p.type === "message" && p.role === "user") return null;
    if (p.type !== "function_call" || p.name !== "request_user_input" || typeof p.call_id !== "string") continue;
    if (answered.has(p.call_id)) return null;
    let input;
    try { input = JSON.parse(p.arguments); } catch { return null; }
    const raw = Array.isArray(input?.questions) ? input.questions : null;
    if (!raw?.length || raw.some((q) => typeof q?.id !== "string" || !q.id || typeof q.header !== "string" || !q.header.trim()
      || q.multiSelect === true || !Array.isArray(q.options) || !q.options.length)) return null;
    const questions = parseQuestions({ questions: raw.map((q) => ({ ...q, multiSelect: false })) });
    return questions ? { toolUseId: p.call_id, questions } : null;
  }
  return null;
}

function parseAgyQuestions(raw) {
  let list = raw;
  if (typeof raw === "string") {
    try { list = JSON.parse(raw); } catch { return null; }
  }
  if (!Array.isArray(list) || !list.length) return null;
  return parseQuestions({
    questions: list.map((q) => ({
      question: q?.question,
      header: q?.header,
      multiSelect: q?.is_multi_select === true || q?.multiSelect === true,
      options: Array.isArray(q?.options)
        ? q.options.map((o) => (typeof o === "string" ? { label: o, description: "" } : o))
        : [],
    })),
  });
}

// Antigravity transcript 끝에서 아직 답이 없는 ask_question 추출
export function pendingAgyQuestion(lines) {
  let genericAfter = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    let rec;
    try { rec = JSON.parse(lines[i]); } catch { continue; }
    if (rec?.type === "USER_INPUT" && (!rec.source || rec.source === "USER_EXPLICIT")) return null;
    if (rec?.type === "GENERIC" && rec.source === "MODEL") { genericAfter++; continue; }
    if (rec?.type !== "PLANNER_RESPONSE" || !Array.isArray(rec.tool_calls)) continue;
    const idx = rec.tool_calls.findIndex((tc) => tc?.name === "ask_question");
    if (idx < 0) return null;
    if (genericAfter > idx) return null;
    const questions = parseAgyQuestions(rec.tool_calls[idx]?.args?.questions);
    return questions ? { toolUseId: `s${rec.step_index ?? i}:tc${idx}`, questions } : null;
  }
  return null;
}

export function openAgyAskAfter(open, records) {
  for (const rec of records) {
    if (!rec || typeof rec !== "object") continue;
    if (rec.type === "PLANNER_RESPONSE" && Array.isArray(rec.tool_calls)) {
      const idx = rec.tool_calls.findIndex((tc) => tc?.name === "ask_question");
      if (idx >= 0) open = `s${rec.step_index ?? ""}:tc${idx}`;
    } else if (rec.type === "USER_INPUT" && (!rec.source || rec.source === "USER_EXPLICIT")) {
      open = null;
    } else if (rec.type === "GENERIC" && rec.source === "MODEL") {
      open = null;
    }
  }
  return open;
}

// Paseo 질문 카드의 여러 개 답: 고른 label 들 뒤에 직접 입력 글, ", " 로 이음
// - Paseo packages/server/src/server/agent/providers/question-card-answer.ts splitMultiSelectAnswer 와 같은 규칙
export function splitMultiSelectAnswer(answer, labels) {
  let remaining = answer;
  const selected = [];
  while (remaining.length > 0) {
    const label = labels
      .filter((c) => !selected.includes(c))
      .sort((a, b) => b.length - a.length)
      .find((c) => remaining === c || remaining.startsWith(`${c}, `));
    if (!label) break;
    selected.push(label);
    remaining = remaining === label ? "" : remaining.slice(label.length + 2);
  }
  return { selected, custom: remaining || null };
}

// Paseo 카드 답({ [header 또는 질문]: 글 }) → 질문마다 { labels, text }. 답 없는 질문이 있으면 { error }
export function questionAnswers(questions, answers) {
  const out = [];
  for (const q of questions) {
    const raw = answers?.[q.header] ?? answers?.[q.question];
    const value = typeof raw === "string" ? raw.replace(/\s*\n\s*/g, " ").trim() : "";
    if (!value) return { error: "모든 질문에 답해 주세요" };
    const labels = q.options.map((o) => o.label);
    if (q.multiSelect) {
      const { selected, custom } = splitMultiSelectAnswer(value, labels);
      out.push({ labels: selected, text: custom });
    } else {
      out.push(labels.includes(value) ? { labels: [value], text: null } : { labels: [], text: value });
    }
  }
  return { answers: out };
}

const same = (a, b) => String(a).replace(/\s+/g, " ").trim() === String(b).replace(/\s+/g, " ").trim();

// 지금 화면(extractPrompt 결과)이 이 질문을 보이는가
// - 화면 해석은 선택지 위 마지막 8줄만 읽고 화면보다 긴 질문은 윗부분이 가려짐 → 화면 글이 질문의 끝부분이면 같은 질문
// - 끝부분 비교는 공백을 다 뺌. 터미널 줄바꿈이 낱말 중간에 들어가 공백 위치가 기록과 다름
const squash = (s) => String(s).replace(/\s+/g, "");
// - Codex 화면은 질문 위에 "Question 1/2 (2 unanswered)" 줄이 있음
const CODEX_STEP = /^\s*Question \d+\/\d+[^\n]*\n/;
export function showsQuestion(p, q) {
  if (!p || p.variant === "review") return false;
  const text = String(p.question).replace(CODEX_STEP, "");
  if (same(text, q.question)) return true;
  const seen = squash(text);
  return !!seen && squash(q.question).endsWith(seen);
}

// 지금 화면에서 보낼 키 묶음. 묶음 사이에 잠깐 쉼(글과 키를 한 번에 보내면 붙여넣기로 받음)
// - p: extractPrompt 결과, q: 질문, a: { labels, text }. 못 하면 { error }
export function questionKeys(p, q, a) {
  const opts = p.options.filter((o) => o.role !== "chat");
  const label = (o) => optionLabel(o.text);
  let cur = Math.max(0, opts.findIndex((o) => o.row === p.selectedRow));
  const chunks = [];
  const move = (to) => {
    const d = to - cur;
    cur = to;
    if (d) chunks.push((d < 0 ? "\x1b[A" : "\x1b[B").repeat(Math.abs(d)));
  };
  // 미리보기(preview) 질문은 선택지가 좁은 왼쪽 칸에 접혀 첫 줄만 선택지 글로 읽힘 → 같은 번호이고 글 앞부분이 같으면 그 선택지
  const no = (o) => Number(/^\s*(?:[›❯●○]\s*)?(\d+)[.)]/u.exec(o.text)?.[1]) || 0;
  const find = (name) => {
    const exact = opts.findIndex((o) => o.role !== "text" && label(o) === name);
    if (exact >= 0) return exact;
    const n = q.options.findIndex((o) => o.label === name) + 1;
    const want = squash(name);
    return n ? opts.findIndex((o) => o.role !== "text" && no(o) === n && !!squash(label(o)) && want.startsWith(squash(label(o)))) : -1;
  };
  const typeRow = opts.findIndex((o) => o.role === "text");
  if (a.text && typeRow < 0) return { error: "직접 입력 칸을 찾지 못했습니다" };
  if (!q.multiSelect) {
    if (a.text) { move(typeRow); chunks.push(a.text, "\r"); return { chunks }; }
    const i = find(a.labels[0]);
    if (i < 0) return { error: `선택지 "${a.labels[0]}" 를 찾지 못했습니다` };
    move(i); chunks.push("\r");
    return { chunks };
  }
  const want = new Set(a.labels);
  for (const name of q.options.map((o) => o.label)) {
    const i = find(name);
    if (i < 0) { if (want.has(name)) return { error: `선택지 "${name}" 를 찾지 못했습니다` }; continue; }
    if (!!opts[i].checked !== want.has(name)) { move(i); chunks.push(" "); }
  }
  if (a.text) { move(typeRow); chunks.push(a.text); }
  // 질문이 여럿인 카드는 마지막 질문 전까지 끝 줄이 "Next"
  let submit = find("Submit");
  if (submit < 0) submit = find("Next");
  if (submit < 0) return { error: "Submit 줄을 찾지 못했습니다" };
  move(submit); chunks.push("\r");
  return { chunks };
}

// Codex request_user_input 화면의 키(실제 화면에서 잰 것)
// - 선택지 = 줄 이동 + Enter, 직접 입력 = "None of the above" 줄에서 Tab(notes 칸) + 글 + Enter
// - Enter 하면 다음 질문으로, 마지막 질문의 Enter 는 전부 제출(확인 화면 없음)
export function codexQuestionKeys(p, q, a) {
  const opts = p.options;
  const label = (o) => optionLabel(o.text);
  let cur = Math.max(0, opts.findIndex((o) => o.row === p.selectedRow));
  const chunks = [];
  const move = (to) => {
    const d = to - cur;
    cur = to;
    if (d) chunks.push((d < 0 ? "\x1b[A" : "\x1b[B").repeat(Math.abs(d)));
  };
  if (a.text) {
    const other = opts.findIndex((o) => /^None of the above$/i.test(label(o)));
    if (other < 0) return { error: "직접 입력 줄(None of the above)을 찾지 못했습니다" };
    move(other); chunks.push("\t", a.text, "\r");
    return { chunks };
  }
  const n = q.options.findIndex((o) => o.label === a.labels[0]) + 1;
  const i = opts.findIndex((o) => label(o) === a.labels[0]);
  const at = i >= 0 ? i : opts.findIndex((o) => Number(/^\s*(?:›\s*)?(\d+)[.)]/u.exec(o.text)?.[1]) === n);
  if (!n || at < 0) return { error: `선택지 "${a.labels[0]}" 를 찾지 못했습니다` };
  move(at); chunks.push("\r");
  return { chunks };
}

// 마지막 확인 화면("Review your answers")의 제출 키. 확인 화면이 아니면 null
export function reviewKeys(p) {
  if (p?.variant !== "review") return null;
  const opts = p.options;
  const i = opts.findIndex((o) => /^Submit answers$/i.test(optionLabel(o.text)));
  if (i < 0) return null;
  const cur = Math.max(0, opts.findIndex((o) => o.row === p.selectedRow));
  const d = i - cur;
  return [...(d ? [(d < 0 ? "\x1b[A" : "\x1b[B").repeat(Math.abs(d))] : []), "\r"];
}
