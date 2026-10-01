// request_id 재사용 시 이전 요청의 답 거부
export function acceptedPermissionVerdict(latest, value) {
  if (value?.type !== "permission_verdict" || !latest
    || value.requestId !== latest.requestId || value.seq !== latest.seq) return null;
  if (value.behavior !== "allow" && value.behavior !== "deny") return null;
  return { request_id: value.requestId, behavior: value.behavior };
}
