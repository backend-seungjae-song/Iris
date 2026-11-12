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
      options.push({ label: o.label, description: typeof o.description === "string" ? o.description : "" });
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
export function showsQuestion(p, q) {
  if (!p || p.variant === "review") return false;
  if (same(p.question, q.question)) return true;
  const seen = squash(p.question);
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
