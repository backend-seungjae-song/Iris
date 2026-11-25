const OPEN = "<send_user_message_question_reply>";
const CLOSE = "</send_user_message_question_reply>";

function parseReplies(text) {
  if (!text.startsWith(OPEN + "\n") || !text.endsWith("\n" + CLOSE)) return null;
  try {
    const replies = JSON.parse(text.slice(OPEN.length, -CLOSE.length));
    return Array.isArray(replies) && replies.length && replies.every(reply => typeof reply?.questionItemId === "string"
      && typeof reply.question === "string" && typeof reply.answer === "string") ? replies : null;
  } catch {
    return null;
  }
}

export function displayCodexQuestionAnswer(text) {
  if (typeof text !== "string") return text;
  const replies = parseReplies(text);
  return replies ? replies.map(({ question, answer }) => `> ${question}\n\n${answer}`).join("\n\n") : text;
}

function questionList(item) {
  return item.questions.flatMap((question, index) => {
    if (typeof question.title !== "string" || !question.title.trim()) return [];
    const id = JSON.stringify(["request_user_input_async", item.id, index]);
    if (Buffer.byteLength(id) > 512) return [];
    return [{
      id,
      header: `Question ${index + 1}`,
      question: question.title,
      options: (question.options ?? []).map(label => ({ label, description: "" })),
      allowOther: true,
      multiSelect: false,
    }];
  });
}

export function pendingCodexQuestions(turns) {
  const pending = new Map();
  for (const turn of turns) for (const item of turn.items) applyCodexQuestionItem(pending, item);
  return pending;
}

function setQuestion(pending, requestId, questions) {
  if (!questions.length) { pending.delete(requestId); return; }
  const permission = {
    id: requestId,
    provider: "codex",
    name: "request_user_input_async",
    kind: "question",
    title: questions[0].question,
    input: { questions: questions.map(({ id: _id, ...question }) => question) },
  };
  pending.set(requestId, { questions, permission });
}

export function applyCodexQuestionItem(pending, item) {
  if (item.type === "agentMessage" && item.delivery === "async" && item.questions?.length) {
    setQuestion(pending, `codex-async:${item.id}`, questionList(item));
  } else if (item.type === "userMessage") {
    const text = item.content.filter(input => input.type === "text").map(input => input.text).join("\n");
    const replies = parseReplies(text)?.map(reply => reply.questionItemId);
    if (!replies) pending.clear();
    else for (const [id, { questions }] of pending) setQuestion(pending, id, questions.filter(q => !replies.includes(q.id)));
  }
}

function questionText(title) {
  let text = "";
  let bytes = 0;
  for (const char of title.replace(/[\r\n]/g, " ")) {
    bytes += Buffer.byteLength(char);
    if (bytes > 512) break;
    text += char;
  }
  return text;
}

export function nativeQuestionAnswer(request, response) {
  const answers = response?.updatedInput?.answers;
  if (response?.behavior !== "allow" || !answers || typeof answers !== "object" || Array.isArray(answers)) {
    throw new Error("Codex 질문의 답변을 입력하세요");
  }
  const questions = new Map(request.questions.map(question => [question.header, question]));
  const replies = Object.entries(answers).map(([header, answer]) => {
    const question = questions.get(header);
    if (!question || typeof answer !== "string" || !answer.trim()) throw new Error("Codex 질문 또는 답변이 변경되었습니다");
    return { questionItemId: question.id, question: questionText(question.question), answer: answer.trim() };
  });
  if (!replies.length) throw new Error("Codex 질문의 답변을 입력하세요");
  return `${OPEN}\n${JSON.stringify(replies)}\n${CLOSE}`;
}
