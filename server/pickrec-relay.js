import { relayToOneConsole } from "./herdr-handlers.js";

// 분리 창의 지목을 콘솔 한 곳으로 넘긴다. 로컬 소켓만으로는 앱과 셸을 구별할 수 있어 UI 인증도 확인한다.

const KINDS = new Set(["element", "tab", "group", "site"]);

export function handlePickrecRelay(ws, msg, options = {}) {
  if (msg?.type !== "pickrec.relay") return false;
  if (!ws._local || !ws._ui) {
    try { ws.send(JSON.stringify({ type: "control-error", message: "인증된 Iris UI에서만 지목을 전달할 수 있습니다." })); } catch {}
    return true;
  }
  const kind = String(msg.kind || "");
  const payload = msg.payload;
  if (!KINDS.has(kind) || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    try { ws.send(JSON.stringify({ type: "control-error", message: "지목 전달 값이 올바르지 않습니다." })); } catch {}
    return true;
  }
  (options.relay || relayToOneConsole)({ type: "pickrec.deliver", kind, payload }, { uiOnly: true });
  return true;
}
