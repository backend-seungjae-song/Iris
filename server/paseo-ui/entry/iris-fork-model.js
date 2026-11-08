// 대화 분기 판단(값만 다룸). 실행은 iris-chat-entry.tsx·web/js/agentchat/boot.js
// - Paseo 분기 단추는 채팅 기록 첨부를 새 초안 범위(workspace-attachments:draft=…)에 넣고 Paseo 탭 화면으로 옮김
// - Iris 대화 화면에는 그 탭 화면이 없어 첨부를 가져가 Iris 가 새 탭을 만듦

const DRAFT_SCOPE_PREFIX = "workspace-attachments:draft=";

// 새 초안 범위에 들어간 채팅 기록 첨부 → [{ scopeKey, sourceKey, attachment }]
export function forkDrafts(attachmentsByScope) {
  const out = [];
  for (const [scopeKey, list] of Object.entries(attachmentsByScope || {})) {
    if (!scopeKey.startsWith(DRAFT_SCOPE_PREFIX) || !Array.isArray(list)) continue;
    const hit = list.find((a) => a?.kind === "chat_history" && typeof a.attachment?.text === "string" && typeof a.source?.agentId === "string");
    if (hit) out.push({ scopeKey, sourceKey: hit.source.agentId, attachment: hit.attachment });
  }
  return out;
}

// 입력창의 /branch(이름 붙여도 같음). 터미널 Claude Code 의 /branch 대신 Paseo 방식 분기
export function isBranchCommand(text) {
  return /^\/branch(\s|$)/.test(String(text || "").trim());
}

// 새 pane 입력창에 붙일 채팅 기록 첨부(Paseo ChatHistoryContextAttachment 모양)
export function chatHistoryAttachment(attachment, { serverId, sourceKey, now = Date.now() }) {
  return { kind: "chat_history", id: `chat_history:iris-${now.toString(36)}`, attachment, source: { serverId, agentId: sourceKey } };
}
