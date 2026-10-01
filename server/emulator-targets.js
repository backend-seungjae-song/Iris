import { issuePromptTarget } from "./prompt-targets.js";
import { appDeviceTargetId } from "./app-targets.js";

// 에뮬레이터 기능의 UI 지목 요청을 대기 지정으로 바꾼다. 실제 등록은 제출 훅의 nonce 검증 경로가 맡는다.

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export function handleEmulatorTargets(ws, msg) {
  if (msg?.type !== "emulator.target-pending") return false;
  const pane = String(msg.pane || "");
  const udid = String(msg.udid || "");
  if (!ws._local || !ws._ui || !ID_RE.test(pane) || !ID_RE.test(udid)) {
    try { ws.send(JSON.stringify({ type: "emulator.target-pending-result", ok: false,
      request: msg.request || null, error: "기기 지목 요청이 허용되지 않았습니다" })); } catch {}
    return true;
  }
  try {
    const targetId = appDeviceTargetId({ udid, persistentId: msg.persistentId });
    const pending = issuePromptTarget({ pane, kind: "device", ref: `@device:${udid}`,
      target: { udid: targetId }, label: msg.name || "", platform: msg.platform || "" });
    ws.send(JSON.stringify({ type: "emulator.target-pending-result", ok: true,
      request: msg.request || null, pane, delimiter: pending.delimiter, udid,
      name: String(msg.name || "").slice(0, 200), platform: String(msg.platform || "").slice(0, 40) }));
  } catch (error) {
    try { ws.send(JSON.stringify({ type: "emulator.target-pending-result", ok: false,
      request: msg.request || null, error: String(error?.message || error) })); } catch {}
  }
  return true;
}
