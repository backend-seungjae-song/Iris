// 대화 화면 기본 보기. 설정 > 대화 화면의 「기본 화면」 값과 pane 별 보기 판정
// - DOM·localStorage 를 보지 않음. 저장은 boot.js
// - 영향 범위: agentchat/boot.js(isChat·설정 분류), test/agent-chat.mjs

export const DEFAULT_VIEW_KEY = "ac.agentchat.defaultView";
export const VIEW_OPTIONS = [
  { value: "chat", label: "대화 화면" },
  { value: "term", label: "터미널" },
];

// 저장값 → "chat" | "term". 모르는 값은 대화 화면(P22 기본값)
export function parseDefaultView(raw) {
  return raw === "term" ? "term" : "chat";
}

// pane 보기: pane 에서 고른 값 우선, 없으면 기본 보기
// - 기본 보기가 터미널이어도 다른 세션이 띄운 자식 에이전트는 대화 화면(이전 동작)
export function chatFor(paneMode, defaultView, isChild) {
  if (paneMode === "chat" || paneMode === "term") return paneMode === "chat";
  return defaultView === "chat" || !!isChild;
}

export const CHAT_SETTINGS_URL = "/paseo-ui/?panel=chat-settings";

// 설정 화면 분류 모델(devtool/settings-view.js featureSectionPane 이 그림)
// - 표시 설정은 Paseo 설정 화면(ChatSection)을 그대로 띄움. 항목·기본값은 Paseo 가 정함
export function settingsSection(defaultView, frameHeight = 0) {
  return {
    id: "agentchat",
    label: "대화 화면",
    rows: [{
      key: "defaultView",
      label: "기본 화면",
      desc: "Claude Code나 Codex 세션을 열면 이 화면으로 보입니다. 세션 위의 전환 단추로 바꾼 세션은 다음에도 바꾼 화면으로 열립니다.",
      value: parseDefaultView(defaultView),
      options: VIEW_OPTIONS,
    }, {
      key: "paseoChat",
      label: "대화 표시",
      desc: "대화 화면에 무엇을 펼쳐 보일지 정합니다. 바꾸면 열린 대화 화면에 바로 반영됩니다.",
      frame: CHAT_SETTINGS_URL,
      height: frameHeight,
    }],
  };
}
