export function questionHookOutput(questions, answers) {
  if (!Array.isArray(questions) || !Array.isArray(answers) || answers.length !== questions.length) return null;
  const mapped = {};
  for (let index = 0; index < questions.length; index++) {
    const question = questions[index];
    const answer = answers[index];
    if (typeof question?.question !== "string" || !Array.isArray(question.options)) return null;
    if (typeof answer?.text === "string" && answer.text.length > 0) mapped[question.question] = answer.text;
    else if (Array.isArray(answer?.labels) && answer.labels.length > 0) {
      const selected = new Set(answer.labels);
      const labels = question.options.map((option) => option.label).filter((label) => selected.has(label));
      if (labels.length !== selected.size || (!question.multiSelect && labels.length !== 1)) return null;
      mapped[question.question] = labels.join(", ");
    } else return null;
  }
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow",
    updatedInput: { questions, answers: mapped } } };
}
