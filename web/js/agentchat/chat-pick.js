// 요소 선택 모드에서 대화 화면(Paseo iframe) 안의 대화를 고르는 단위와 입력창에 붙일 블록
// - 단위: 에이전트 답 안의 문단·목록 항목·코드·표·인용·제목·이미지, 그 밖은 내 말·에이전트 답·도구 카드·도구 묶음 하나
// - Paseo 화면의 data-testid(user-message·assistant-message·tool-call-badge·turn-summary)와 표준 요소로 판정
// - 블록 제목 "대화 선택" 은 server/paseo-ui/entry/iris-contexts-model.js 가 칩 종류 "대화" 로 읽음
import { noticeBlock } from "../panel/xterm-wiring.js";

const MESSAGES = [
  ['[data-testid="user-message"]', "내 말"],
  ['[data-testid="assistant-message"]', "에이전트 답"],
  ['[data-testid="tool-call-badge"]', "도구"],
  ['[data-testid="turn-summary"]', "도구 묶음"],
];
const PARTS = [
  ["img", "이미지"], ["pre", "코드"], ["table", "표"], ["blockquote", "인용"],
  ["h1,h2,h3,h4,h5,h6", "제목"], ["li", "목록 항목"], ["p", "문단"],
];
const TEXT_MAX = 4000;

// 고를 단위와 이름. 대화가 아닌 곳(입력창·빈 곳)이면 null
export function chatPickUnit(el) {
  const start = el && el.nodeType === 1 ? el : el?.parentElement;
  if (!start?.closest || !start.closest('[data-testid="agent-chat-scroll"]')) return null;
  for (const [sel, name] of MESSAGES) {
    const msg = start.closest(sel);
    if (!msg) continue;
    if (name === "에이전트 답") {
      for (const [psel, pname] of PARTS) {
        const part = start.closest(psel);
        if (part && msg.contains(part)) return { el: part, kind: `${name} · ${pname}` };
      }
    }
    return { el: msg, kind: name };
  }
  return null;
}

// 고른 단위의 내용. 이미지는 주소(Iris 파일 주소면 실제 경로), 그 밖은 화면 글
export function chatPickContent(unit) {
  const el = unit.el;
  if (el.tagName === "IMG") {
    const src = el.getAttribute("src") || "";
    let shown = src;
    try {
      const u = new URL(src, "http://x");
      const p = u.searchParams.get("path");
      if (p) shown = p;
    } catch {}
    return { text: (el.getAttribute("alt") || "").trim(), image: shown };
  }
  const text = String(el.innerText ?? el.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
  return { text: text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX - 1)}…` : text, image: "" };
}

export function chatPickBlock({ pid, where, kind, text, image }) {
  return noticeBlock(`대화 선택 #${pid}${where ? ` · ${where}` : ""}`, [
    `종류: ${kind}`,
    image ? `이미지: ${image}` : "",
    text ? `내용:\n${text}` : "",
  ]);
}
