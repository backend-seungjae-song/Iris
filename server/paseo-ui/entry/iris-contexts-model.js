// Iris 요소 선택 블록 → 칩 표시값(종류·요약). 블록 글은 web/js 의 각 선택 기능이 만듦
// - 머리 줄 형식: "⟦Iris⟧ 제목" (web/js/panel/xterm-wiring.js noticeBlock) 또는 "[제목]"(녹화·사이트)
// - 모르는 형식도 칩으로 받음. 종류 other, 요약은 첫 줄

const KINDS = [
  // [머리 제목 앞부분, 종류, 표시 이름]
  ["앱 요소 선택", "app", "앱 요소"],
  ["요소 선택", "element", "브라우저 요소"],
  ["대화 선택", "chat", "대화"],
  ["화면 스케치", "sketch", "화면 스케치"],
  ["브라우저 재현 기록", "record", "조작 기록"],
  ["세션 지목", "session", "세션"],
  ["문서 탭 지목", "doc", "문서 탭"],
  ["표 셀 선택", "cell", "표 셀"],
  ["브라우저 탭 지목", "tab", "브라우저 탭"],
  ["브라우저 그룹 지목", "group", "탭 그룹"],
  ["에뮬레이터 지목", "device", "기기"],
  ["사이트 지목", "site", "사이트"],
];

const SUMMARY_MAX = 40;

function shorten(value) {
  const one = String(value || "").replace(/\s+/g, " ").trim();
  return one.length <= SUMMARY_MAX ? one : `${one.slice(0, SUMMARY_MAX - 1)}…`;
}

function field(lines, prefix) {
  const hit = lines.find((l) => l.startsWith(prefix));
  return hit ? hit.slice(prefix.length).trim() : "";
}

// 머리 제목에서 "제목 · 나머지" 의 나머지. "#p1a2 " 같은 선택 번호는 뺌
function afterTitle(title, name) {
  return title.slice(name.length).replace(/^\s*#\w+\s*/, "").replace(/^\s*·\s*/, "").trim();
}

function summaryOf(kind, rest, lines) {
  switch (kind) {
    case "element": {
      // 요소: <tag#id.cls> "글자"
      const el = field(lines, "요소:");
      const text = /"(.+)"\s*$/.exec(el);
      if (text) return text[1];
      return el.replace(/\s*".*$/, "") || field(lines, "선택자:") || rest;
    }
    case "app": return field(lines, "위젯:").replace(/\s*·.*$/, "") || rest;
    // 내용 첫 줄, 이미지면 파일 이름, 둘 다 없으면 종류
    case "chat": {
      const at = lines.findIndex((l) => l.startsWith("내용:"));
      const first = at >= 0 ? lines.slice(at + 1).find((l) => l.trim() && l.trim() !== "⟦/Iris⟧") : "";
      return first || field(lines, "이미지:").split("/").pop() || field(lines, "종류:");
    }
    case "record": return rest;
    case "tab": return field(lines, "탭:") || rest;
    case "group": return field(lines, "그룹:").replace(/\s*\(.*$/, "") || rest;
    case "device": return field(lines, "기기:").replace(/\s*\(.*$/, "") || rest;
    case "site": return lines[0] || rest;
    default: return rest;
  }
}

export function parseContext(content) {
  const text = String(content || "");
  const lines = text.split("\n");
  const head = (lines[0] || "").trim();
  const title = head.startsWith("⟦Iris⟧") ? head.slice("⟦Iris⟧".length).trim()
    : /^\[(.*)\]$/.test(head) ? head.slice(1, -1).trim() : "";
  for (const [name, kind, label] of KINDS) {
    if (!title.startsWith(name)) continue;
    const rest = afterTitle(title, name);
    return { kind, label, summary: shorten(summaryOf(kind, rest, lines.slice(1)) || label) };
  }
  // 이 화면이 모르는 선택 종류(새 기능이 먼저 설치된 부모 창 등): 제목을 요약으로
  return { kind: "other", label: "붙인 내용", summary: shorten(title || head || text) || "내용" };
}
