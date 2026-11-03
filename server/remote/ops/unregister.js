import { projectError, projectFeature } from "../projection.js";

// 폰이 연결을 연 기기 자신을 레지스트리에서 지운다. 기기 키 서명으로 인증된 연결에서만 도달한다
export function createUnregisterOperation(options) {
  return async function handleUnregister(entry, message) {
    const session = options.auth?.get(entry.connId);
    if (!session || typeof options.unregisterDevice !== "function") return projectError("unavailable", message.rid);
    const removed = await options.unregisterDevice(session.deviceId, entry.connId);
    if (!removed?.ok) return projectError("unavailable", message.rid);
    return projectFeature({ type: "remote.action.result", rid: message.rid, result: removed.unchanged ? "unchanged" : "done" });
  };
}
