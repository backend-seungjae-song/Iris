import { hostError } from "./errors.js";

export function createHostUserCoordinator({ now = Date.now, onAsk, notify, progress } = {}) {
  const asks = new Map();

  async function ask({ identity, input, request }) {
    const requestId = String(input.requestId || request.requestId || "");
    if (!requestId) throw hostError("INVALID_REQUEST", "사용자 질문 requestId가 필요합니다.");
    if (typeof input.message !== "string" || !input.message.trim()) {
      throw hostError("INVALID_REQUEST", "사용자에게 보여 줄 질문이 필요합니다.");
    }
    const existing = asks.get(requestId);
    if (existing) {
      if (existing.session !== identity.session || existing.run !== (identity.run || null)) {
        throw hostError(identity.run ? "RUN_DENIED" : "SESSION_DENIED", "다른 세션이나 회차의 사용자 질문입니다.");
      }
      if (existing.answer !== undefined) return { requestId, pending: false, answer: existing.answer };
      if (existing.deadline <= now()) return { requestId, pending: false, timedOut: true };
      return { requestId, pending: true };
    }
    const timeoutMs = Math.min(Math.max(Number(input.timeoutMs) || 120000, 1000), 10 * 60 * 1000);
    const item = { requestId, session: identity.session, run: identity.run || null,
      tab: input.tab || null, message: String(input.message || "").slice(0, 1000),
      choices: Array.isArray(input.choices || input.options?.choices)
        ? (input.choices || input.options.choices).map(String).slice(0, 20) : [],
      deadline: now() + timeoutMs, answer: undefined };
    asks.set(requestId, item);
    if (typeof onAsk === "function") await onAsk({ ...item, answer: undefined });
    return { requestId, pending: true };
  }

  function answer(requestId, answer) {
    const item = asks.get(String(requestId));
    if (!item || item.deadline <= now() || item.answer !== undefined) return false;
    item.answer = answer;
    return true;
  }

  function pending() {
    return [...asks.values()].filter((item) => item.answer === undefined && item.deadline > now())
      .map(({ answer: _answer, ...item }) => ({ ...item }));
  }

  return {
    ask,
    answer,
    pending,
    notify: typeof notify === "function" ? (ctx) => notify(ctx.input, ctx.identity.session)
      : () => { throw hostError("INTERNAL", "사용자 알림 port가 연결되지 않았습니다."); },
    progress: typeof progress === "function" ? (ctx) => progress(ctx.input, ctx.identity.session)
      : () => { throw hostError("INTERNAL", "사용자 진행 상태 port가 연결되지 않았습니다."); },
  };
}
