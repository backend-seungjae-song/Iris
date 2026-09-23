// rail 등록표. 왼쪽 rail 에 표시되는 도구 화면의 정적 선언이다.
//
// 이름을 "기능(feature)"이라 부르지 않는다. rail 화면은 기능 경계도 적재 경계도 아니다.
// 브라우저 코어가 로그인 화면을 정적으로 import 하고(webview-factory.js), 단축키와 메시지
// 라우팅이 메모 화면을 import 한다(keynav.js·memo-messages.js). 그래서 이 표에서 끄면
// 로드되지 않는다는 관계가 성립하지 않는다. 그러려면 import 그래프를 먼저 분리해야 한다.
//
// 소유 범위
//   rail 화면 하나의 정적 사실(이름·설명·아이콘·body class·패널 element·배치·내릴 수
//   있는가)과 rail 에 등록되는 순서.
//
// 제공 API
//   RAIL_ITEMS · railItemById(id) · railItemIds() · lockedIds() · fullIds(). 그 밖의 것은 없다.
//
// 의존 대상
//   아무것도 import 하지 않는다. DOM 도 window 도 보지 않으므로 Node 에서 그대로 호출되고,
//   앱을 켜지 않는 사본과 검사가 같은 표를 읽는다.
//
// 유지 조건
//   이 표가 정본이다. 같은 사실을 index.html·rail.js·CSS 에 다시 적지 않는다. 두 벌로 적으면
//   한쪽만 고쳐지고, 화면은 정상으로 보이는데 그 기능만 동작하지 않는다.
//   id 는 body class·패널 id·main 의 화면 콜백 표를 함께 묶는 키다. 바꾸면 넷을 같이 바꿔야 한다.
//   icon 은 svg 안쪽만 담는다. viewBox·stroke 같은 외곽 속성은 그리는 쪽이 붙인다.
//   canDisable 이 정책이고 disabledReason 은 문구다. 둘을 한 필드에 두면 문구를 고치는 일이
//   권한을 바꾸는 일이 된다. 전부 내리면 rail 이 비고, 설정을 내리면 되돌릴 화면이 사라진다.
//   index.html 의 rail 버튼 마크업은 이 표에서 그린 것과 문자열까지 같아야 하며 검사가 확인한다.
//   표가 정본이고 마크업은 그 사본이므로, 마크업을 직접 고치면 검사가 실패한다.
//
// 영향 범위
//   devtool/rail.js 의 선택·순환·목록, devtool/settings-view.js 의 「편의 기능」 목록,
//   main.js 의 화면 콜백 표, web/css 의 body.*-active 규칙, docs/iris-screens.json.
//   현재 목록 확인: node bin/importers.mjs web/js/core/rail-items.js

export const RAIL_ITEMS = [
  {
    id: "workspace", label: "작업",
    title: "워크스페이스",
    icon: "<rect x=\"3\" y=\"3\" width=\"18\" height=\"18\" rx=\"2\"/><path d=\"M9 3v18\"/>",
    body: null, panel: null, layout: "panel",
    canDisable: false, disabledReason: "rail 이 비지 않도록 남겨 둡니다",
  },
  {
    id: "sourcecontrol", label: "깃",
    title: "소스 제어 (Git)",
    icon: "<circle cx=\"6\" cy=\"6\" r=\"2.5\"/><circle cx=\"6\" cy=\"18\" r=\"2.5\"/><circle cx=\"17.5\" cy=\"6\" r=\"2.5\"/><path d=\"M6 8.5v7\"/><path d=\"M17.5 8.5a6 6 0 0 1-6 6H8.5\"/>",
    body: "sc-active", panel: "sc-panel", layout: "panel",
    canDisable: true, disabledReason: "",
  },
  {
    id: "accounts", label: "계정",
    title: "구글 계정",
    icon: "<circle cx=\"12\" cy=\"8\" r=\"4\"/><path d=\"M4.5 20a7.5 7.5 0 0 1 15 0\"/>",
    body: "acct-active", panel: "acct-panel", layout: "full",
    canDisable: true, disabledReason: "",
  },
  {
    id: "localdev", label: "서버",
    title: "로컬 데브 (*.test 라우트·포트)",
    icon: "<rect x=\"3\" y=\"4\" width=\"18\" height=\"7\" rx=\"1.5\"/><rect x=\"3\" y=\"13\" width=\"18\" height=\"7\" rx=\"1.5\"/><path d=\"M7 7.5h.01\"/><path d=\"M7 16.5h.01\"/>",
    body: "ld-active", panel: "ld-panel", layout: "full",
    canDisable: true, disabledReason: "",
  },
  {
    id: "autofill", label: "로그인",
    title: "AI 자동완성 로그인 허용 목록",
    icon: "<circle cx=\"15.5\" cy=\"8.5\" r=\"4.5\"/><path d=\"M12.3 11.7 4 20\"/><path d=\"M6.5 17.5 9 20\"/>",
    body: "af-active", panel: "af-panel", layout: "full",
    canDisable: true, disabledReason: "",
  },
  {
    id: "memo", label: "메모",
    title: "스페이스 메모 · 아카이브 (Ctrl/⌘⇧S로 오늘 자 보관)",
    icon: "<path d=\"M12.5 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6.5\"/><path d=\"m17.5 3.5 3 3L13 14l-3.5.5.5-3.5z\"/>",
    body: "mm-active", panel: "mm-panel", layout: "full",
    canDisable: true, disabledReason: "",
  },
  {
    id: "archive", label: "보관",
    title: "보관한 세션을 복원합니다",
    icon: "<rect x=\"3\" y=\"4\" width=\"18\" height=\"4.5\" rx=\"1\"/><path d=\"M5 8.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19V8.5\"/><path d=\"M10 13h4\"/>",
    body: "ar-active", panel: "ar-panel", layout: "full",
    canDisable: true, disabledReason: "",
  },
  {
    id: "memolab", label: "메모랩",
    title: "메모랩: 판·조각으로 적고 나누기",
    icon: "<rect x=\"3\" y=\"3\" width=\"7.5\" height=\"7.5\"/><rect x=\"13.5\" y=\"3\" width=\"7.5\" height=\"7.5\"/><rect x=\"3\" y=\"13.5\" width=\"7.5\" height=\"7.5\"/><path d=\"M14 17.5h7\"/><path d=\"M17.5 14v7\"/>",
    body: "ml-active", panel: "ml-panel", layout: "full",
    canDisable: true, disabledReason: "",
  },
  {
    id: "usage", label: "사용량",
    title: "사용량 상세·이력: 여태 쓴 토큰과 계정 상태",
    icon: "<path d=\"M4 20V10\"/><path d=\"M10 20V4\"/><path d=\"M16 20v-7\"/><path d=\"M22 20H2\"/>",
    body: "usg-active", panel: "usage-panel", layout: "full",
    canDisable: true, disabledReason: "",
  },
  {
    id: "emulator", label: "모바일",
    title: "모바일 에뮬레이터: iOS 시뮬레이터·Android 기기",
    icon: "<rect x=\"6\" y=\"2.5\" width=\"12\" height=\"19\" rx=\"2.5\"/><path d=\"M10.5 18.5h3\"/>",
    body: "emu-active", panel: "emu-panel", layout: "panel",
    canDisable: true, disabledReason: "",
  },
  {
    id: "keymap", label: "설정",
    title: "설정: 단축키, 보안",
    icon: "<path d=\"M9 9h6v6H9z\"/><path d=\"M9 9V6a3 3 0 1 0-3 3h3z\"/><path d=\"M15 9h3a3 3 0 1 0-3-3v3z\"/><path d=\"M15 15v3a3 3 0 1 0 3-3h-3z\"/><path d=\"M9 15H6a3 3 0 1 0 3 3v-3z\"/>",
    body: "km-active", panel: "km-panel", layout: "full",
    canDisable: false, disabledReason: "여기서 되돌려야 하므로 남겨 둡니다",
  },
];

export function railItemIds() { return RAIL_ITEMS.map((f) => f.id); }
export function railItemById(id) { return RAIL_ITEMS.find((f) => f.id === id) || null; }
export function lockedIds() { return RAIL_ITEMS.filter((f) => !f.canDisable).map((f) => f.id); }
export function fullIds() { return RAIL_ITEMS.filter((f) => f.layout === "full").map((f) => f.id); }
