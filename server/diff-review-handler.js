// 소유 범위: Diff 의견 초안의 로컬 전달과 응답.
// 제공 API: initDiffReviewHandler, handleDiffReview.
// 의존 대상: 초기화 때 주입한 agent-draft writer.
// 유지 조건: 로컬 요청만 전달하며 오류여도 의견을 삭제하지 않는다.
// 영향 범위: diffreview.draft 요청과 diffreview-draft 응답.
let writer;
export function initDiffReviewHandler({ draftWriter }) { writer = draftWriter; }
export async function handleDiffReview(ws, message) {
  const reply = (value) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: "diffreview-draft", requestId: message.requestId, ...value })); };
  if (!ws._local) { reply({ ok: false, error: { code: "LOCAL_ONLY", message: "원격 연결에서는 쓸 수 없습니다" } }); return; }
  if (message.type !== "diffreview.draft") { reply({ ok: false, error: { code: "INVALID_ACTION", message: "지원하지 않는 요청입니다" } }); return; }
  try {
    if (!writer || typeof message.requestId !== "string" || !message.requestId) throw new Error("잘못된 요청입니다");
    const result = await writer({ ...message, requestId: "diffreview:" + message.requestId });
    reply({ ok: true, ...result });
  } catch (error) { reply({ ok: false, error: { code: error.code || "DRAFT_FAILED", message: error.message } }); }
}
