// 소유 범위: 명시한 에이전트 pane에 제출하지 않은 초안을 입력한다.
// 제공 API: createAgentDraftWriter({herdr, getSnapshot}) → async(request).
// 의존 대상: herdr pane 조회·입력과 runtime-state의 현재 세션 목록.
// 유지 조건: 동일 요청을 재실행하지 않고 대상 identity와 제어문자를 입력 전에 검사한다.
// 영향 범위: Diff 의견과 GitHub PR 로그의 로컬 초안 전달.
import { snapshot } from "./runtime-state.js";

const fail = (code, message) => Object.assign(new Error(message), { code });
const MAX_RECEIPTS = 256;

export function createAgentDraftWriter({ herdr, getSnapshot = snapshot }) {
  const receipts = new Map();
  return function writeDraft(request) {
    const { requestId, paneId, terminalId, spaceId, text } = request || {};
    if (![requestId, paneId, terminalId, spaceId].every((s) => typeof s === "string" && s.length > 0 && s.length <= 200))
      return Promise.reject(fail("INVALID_TARGET", "에이전트를 다시 선택하세요"));
    if (typeof text !== "string" || !text.trim() || text.length > 64000 || /[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text))
      return Promise.reject(fail("INVALID_TEXT", "보낼 내용이 비었거나, 너무 길거나, 쓸 수 없는 문자가 있습니다"));
    const fingerprint = JSON.stringify([paneId, terminalId, spaceId, text]);
    const old = receipts.get(requestId);
    if (old) return old.fingerprint === fingerprint ? old.promise
      : Promise.reject(fail("REQUEST_CONFLICT", "요청이 중복되었습니다. 다시 시도하세요"));
    // 입력 결과를 받지 못해도 같은 요청을 다시 보내지 않는다. 새 요청은 사용자가 터미널을 확인한 뒤 만든다.
    if (receipts.size >= MAX_RECEIPTS)
      return Promise.reject(fail("RECEIPTS_FULL", "전달 기록이 가득 찼습니다. 앱을 다시 시작하세요"));
    const promise = (async () => {
      const matches = () => (getSnapshot().state || []).find((a) => a.paneId === paneId && a.terminalId === terminalId
        && a.workspaceId === spaceId && /^(claude|codex)$/i.test(a.agent || "") && a.status !== "working");
      if (!matches()) throw fail("TARGET_CHANGED", "에이전트가 바뀌었거나 작업 중입니다");
      const pane = await herdr.paneGet(paneId);
      if (pane.terminal_id !== terminalId || pane.workspace_id !== spaceId || !matches())
        throw fail("TARGET_CHANGED", "세션이 바뀌어 입력을 취소했습니다");
      try { await herdr.paneSendText(paneId, "\x1b[200~" + text + "\x1b[201~"); }
      catch { throw fail("DELIVERY_UNKNOWN", "입력됐는지 확인하지 못했습니다. 터미널을 확인한 뒤 다시 시도하세요"); }
      return { paneId, terminalId, spaceId };
    })();
    receipts.set(requestId, { fingerprint, promise });
    return promise;
  };
}
