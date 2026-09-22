// capability 표. 사용자가 켜고 끄는 상위 개념과 그것을 실제로 로드하는 방법을 담는다.
//
// 소유 범위
//   capability 하나의 정의(id, 자기 파일, 어떤 rail 화면·영역에 붙는가, 어떻게 로드하는가)와
//   그 표의 순서. 연결은 소유하지 않는다. 그것은 각 기능의 initCapability 가 담당한다.
//
// 제공 API
//   CAPABILITIES · capabilityById(id) · capabilityIds(). 그 밖의 것은 없다.
//
// 의존 대상
//   정적으로는 아무것도 import 하지 않는다. 화면 모듈은 load() 안의 동적 import 로만 참조한다.
//   위쪽에 정적 import 를 하나라도 적으면 이 파일을 읽는 순간 전부 로드되어 이 표의 존재
//   이유가 사라진다. setup 은 main 이 준 ctx 로만 연결한다(main 을 import 하지 않는다).
//
// 유지 조건
//   load 는 반드시 동적 import 여야 한다. 끈 기능이 로드되지 않는 근거가 그것뿐이다.
//   로드된 모듈은 initCapability(ctx) 를 제공하고 { screen, ws } 를 반환한다. screen 은 rail 이
//   그 화면에 들어오고 나갈 때 호출할 함수, ws 는 그 기능이 받을 서버 메시지 type → 처리기다.
//   연결을 이 파일에 적지 않는다. 적으면 기능 하나를 고칠 때마다 여덟 기능이 함께 쓰는 파일을
//   수정하게 된다.
//   ctx 에서 꺼내 쓰는 이름은 main 이 실제로 넣어 주는 것이어야 한다. 없는 이름을 꺼내면
//   그 capability 만 동작하지 않으며, 검사가 양쪽을 대조한다.
//   windows 는 이 기능이 어느 창에 포함되는가다. 적지 않으면 본 창에만 포함된다. 분리 브라우저
//   창·메모 창은 같은 페이지를 다른 mode 로 여는 것이라, 여기 적지 않은 기능은 그 창에서
//   로드되지 않는다. alwaysIn 은 그 창에서는 사용자가 껐어도 로드한다는 뜻으로, 메모 창처럼
//   그 기능이 곧 그 창의 전부인 경우에 쓴다. 이 둘을 main 이 창 종류와 id 조합으로 판정하면
//   창을 하나 더 만들 때마다 앱 셸을 수정해야 한다.
//   presets 는 그 기능이 어느 그룹에 드는가다. 그룹 쪽에 id 목록을 두면 두 사람이 각자
//   기능을 추가할 때 같은 줄에서 충돌하므로, 추가하는 쪽이 스스로 선언한다.
//   rail 이 붙은 capability 는 rail 표(core/rail-items.js)에 같은 id 가 있어야 한다.
//   rail 이 없는 항목은 label 을 스스로 갖는다. 설정 목록이 이름을 가져올 곳이 여기뿐이다.
//   화면(screen)을 반환하는 항목은 반드시 rail 을 갖는다. rail 없는 화면은 진입점이 없다.
//   panel 은 그 기능만 쓰는 영역의 element id 다. 끄면 devtool/rail.js 가 그 영역을 내린다.
//   files 는 그 기능만 쓰는 파일 전부다. 이 목록이 기능별 병렬 수정의 근거이고, 검사가 세
//   방향으로 대조한다. 전부 입구에서 참조되는가, 앱 셸에서 참조되지 않는가, 계산 결과와 같은가.
//   앱 셸이 그중 하나를 정적으로 import 하기 시작하면 그 시점에 검사가 실패한다.
//   server 는 그 기능의 서버 쪽 구성 요소, 곧 서버·네이티브에 있는 그 기능 전용 파일이다.
//   files 와 css 는 렌더러만 나타내므로, 그 둘만 보고 기능을 고치러 온 사람은 서버 쪽 파일을
//   직접 찾아야 했다(확인 결과: 그런 파일이 다섯 기능에 있었고 표에는 적혀 있지 않았다).
//   직접 적는 목록은 생산자와 어긋나므로 검사가 반대 방향에서 강제한다. 어떤 서버 파일이
//   한 기능의 메시지 이름을 셋 이상 다루고 그것이 앱 셸 이름보다 많으면, 그 기능이 그 파일을
//   적어야 통과한다. 적은 파일이 실제로 그 기능의 것인지도 함께 검사한다.
//   page 는 그 기능이 통째로 갖는 독립 페이지 디렉터리다. 앱 셸 안의 화면에는 없다.
//   routes 는 그 페이지가 쓰는 HTTP 경로다. WebSocket 메시지 이름으로만 서버 소유를 판정하면
//   HTTP 로만 동작하는 기능은 자기 서버 파일을 적어 놓고도 그 기능의 것이 아니라고 걸린다.
//   그래서 경로도 소유의 근거로 받되, 적는 것만으로는 부족하고 그 경로가 실제로 라우팅되고
//   그 처리기가 적은 파일에서 나오는지를 검사가 확인한다.
//   css 는 그 기능의 화면 파일이다. 그 이름을 정의하는 것도 쓰는 것도 그 기능뿐이어야 하며,
//   검사가 접두사로 대조한다. 어느 화면이 켜지면 어느 화면이 내려가는가는 기능이 아니라
//   기능들 사이의 계약이라 03-feature-modes.css 가 갖고, 여러 화면이 함께 쓰는 공통 스타일은
//   01b-screen-chrome.css 가 갖는다. CSS 는 아직 항상 로드된다. 끄면 빠지는 것은 JS 뿐이다.
//
// 영향 범위
//   core/capability-boot.js 가 이 표를 순회하고, devtool/rail.js 가 결과를 받는다.
//   main.js 는 여기 등록된 화면을 정적으로 import 하지 않는다. 하면 검사가 실패한다.
//   현재 목록 확인: node bin/importers.mjs web/js/core/capabilities.js

export const CAPABILITIES = [
  {
    // herdr 화면을 어디서 자를지 마지막 몇 px 은 사용자가 맞춘다. 맞춘 값은 앱 셸이 소유하므로
    // 이 기능을 꺼도 값은 그대로 남고 조정판만 사라진다.
    id: "croptuner",
    windows: ["main"],
    files: ["panel/crop-tuner.js"],
    css: ["31-crop-tuner.css"],
    label: "herdr 자리 맞춤판",
    presets: ["full"],
    load: () => import("../panel/crop-tuner.js"),
  },
  {
    id: "mdformat",
    windows: ["main", "memo", "browser"],
    files: ["center/md-format.js"],
    css: [],
    label: "마크다운 서식 도구",
    presets: ["full"],
    load: () => import("../center/md-format.js"),
  },
  {
    id: "accounts",
    files: ["browser/accounts-screen.js", "browser/accounts-view.js"],
    css: ["06-accounts.css"],
    rail: "accounts",
    load: () => import("../browser/accounts-screen.js"),
  },
  {
    id: "archive",
    files: ["devtool/archive.js"],
    css: ["04-archive.css"],
    server: ["server/archive-handlers.js"],
    rail: "archive",
    load: () => import("../devtool/archive.js"),
  },
  {
    id: "memo",
    // 메모 창은 이 기능이 곧 그 창이라, 사용자가 껐어도 그 창에서는 로드해야 창이 성립한다.
    windows: ["main", "memo"],
    alwaysIn: ["memo"],
    files: [
      "panel/memo-boot.js",
      "panel/memo.js",
      "panel/memo-store.js",
      "panel/memo-messages.js",
      "panel/memo-window.js",
      "panel/memo-admin.js",
    ],
    css: ["05-memo-manage.css", "12-dock-memo.css"],
    server: ["server/memo-service.js"],
    rail: "memo",
    // rail 화면만이 아니라 사이드바 영역도 이 기능의 것이다. 끄면 그 영역도 함께 사라진다.
    panel: "panel-memo",
    // 메모는 화면 하나가 아니라 모듈 집합이다. 사이드바 메모·저장소·서버 메시지·분리 창·관리
    // 화면 다섯을 진입점이 연결하며, 끄면 다섯이 함께 로드되지 않는다.
    load: () => import("../panel/memo-boot.js"),
  },
  {
    // 메모랩(판·조각). 자기 문서·자기 페이지·자기 HTTP 저장소를 가진 한 장짜리 화면이라
    // Iris 문서에 포함하지 않고 iframe 으로 띄운다. 서버 쪽 구성 요소는 그 저장소다.
    id: "memolab",
    files: ["devtool/memolab-screen.js"],
    css: ["30-memolab.css"],
    server: ["server/memolab-store.js"],
    // 이 기능은 자기 페이지를 통째로 갖는다. 앱 셸이 아니라 서버가 그대로 내주는 한 장짜리다.
    page: "web/memolab",
    // WebSocket 이 아니라 HTTP 로 동작한다. 이 경로가 서버 쪽 구성 요소에 접근하는 유일한 경로다.
    routes: ["/memolab-state", "/memolab-ui"],
    rail: "memolab",
    load: () => import("../devtool/memolab-screen.js"),
  },
  {
    id: "sourcecontrol",
    server: ["server/git-handlers.js"],
    presets: ["dev"],
    // 깃은 화면 하나가 아니라 모듈 집합이다. 변경 목록 화면과 그 목록에서 여는 diff 화면이다.
    files: ["devtool/source-control.js", "devtool/diff.js", "core/repo-name.js"],
    css: ["07-git.css", "07b-diff.css"],
    rail: "sourcecontrol",
    load: () => import("../devtool/source-control.js"),
  },
  {
    // 이 창에서 끝낼 수 없는 인증을 Chrome 으로 넘긴다. rail 화면도 전용 영역도 없이
    // 주소줄 버튼·탭 우클릭·패스키 감지 세 곳에 붙는다. 로그인 벽은 분리 브라우저 창에서
    // 더 자주 나오므로 그 창에도 포함한다.
    id: "chromehandoff",
    windows: ["main", "browser"],
    files: ["browser/handoff.js"],
    css: ["22-handoff.css"],
    label: "Chrome 넘기기",
    load: () => import("../browser/handoff.js"),
  },
  {
    // 지금 보고 있는 페이지를 전체 길이로 찍고 그 위에 그려 채팅에 보낸다.
    // rail 화면 없이 주소줄 버튼 하나와 ⌘⇧D 에 붙는다. 분리 브라우저 창에도 포함하며,
    // 그 창에는 터미널이 없어 결과를 콘솔로 넘긴다.
    id: "sketch",
    native: true,
    windows: ["main", "browser"],
    files: ["browser/sketch.js", "browser/sketch-canvas.js"],
    css: ["32-sketch.css"],
    label: "화면 스케치",
    // 주소줄 버튼은 이 기능의 영역이다. 끄면 동작하지 않는 버튼이 남지 않고 함께 사라진다.
    panel: "wv-sketch",
    load: () => import("../browser/sketch.js"),
  },
  {
    // Cloudflare managed challenge 전면 인터스티셜("잠시만 기다리십시오")에 멈춘 탭을 감지해
    // 목적지로 다시 진입시킨다. rail·전용 영역·페이지 없이 challenge.navigation 훅 하나에만
    // 붙는다. Chrome 을 띄우지 않아 포커스를 가져가지 않으며, 분리 브라우저 창에도 포함한다.
    id: "challengerecovery",
    windows: ["main", "browser"],
    files: ["browser/challenge-recovery.js"],
    css: [],
    label: "claude.ai 보안 확인 복구",
    load: () => import("../browser/challenge-recovery.js"),
  },
  {
    // claude.ai는 자동으로, 다른 http(s) 사이트는 탭 우클릭으로 탭마다 수동으로 시작한다.
    // rail·panel 없이 본 창과 분리 브라우저 창의 webview 위에 screencast 표면만 붙인다.
    id: "chromemirror",
    windows: ["main", "browser"],
    files: ["browser/chrome-mirror-surface.js"],
    css: ["27-chrome-mirror.css"],
    native: true,
    server: ["native/electron/chrome-mirror-backend.cjs"],
    label: "진짜 Chrome 미러",
    load: () => import("../browser/chrome-mirror-surface.js"),
  },
  {
    // 이 브라우저에서 새로 로그인한 정보를 확인해 저장소에 담는다. 자동완성(autofill)과 반대
    // 방향이라 짝이지만 파일도 화면도 다르다. 분리 창에도 포함한다.
    id: "savelogin",
    windows: ["main", "browser"],
    files: ["browser/save-login.js"],
    css: ["23-save-login.css"],
    label: "로그인 저장",
    load: () => import("../browser/save-login.js"),
  },
  {
    // 텍스트 탭의 다른 표시 형태다. 자기 스타일 파일은 없다. 클래스 이름(.md-body)은 메모도
    // 같은 형태로 쓰므로 앱 셸이 정의한다. 그래서 css 는 빈 목록이며, 이 기능이 만드는 이름이
    // 모두 어딘가에 정의돼 있는지는 검사가 확인한다.
    id: "mdpreview",
    windows: ["main", "browser"],
    files: ["center/md-preview.js"],
    css: [],
    label: "마크다운 미리보기",
    load: () => import("../center/md-preview.js"),
  },
  {
    // 화면의 요소를 눌러 고르고, 그 뒤의 조작을 순서대로 기록한다.
    // 둘은 한 모듈 집합이다. 지목이 녹화에 항목을 넣고(pick.js → recPush), 녹화 중에는 지목이
    // 다르게 기록된다. 분리하면 한쪽만 껐을 때 기록이 불완전해진다.
    // ⌘⇧E·⌘⇧A 가 두 창에서 모두 동작하므로 본 창과 분리 브라우저 창에 함께 포함한다.
    id: "pickrec",
    windows: ["main", "browser"],
    files: [
      "browser/pick-boot.js", "browser/app-pick.js", "browser/pick.js",
      "browser/pick-host.js", "browser/record.js",
    ],
    css: ["25-pick-record.css"],
    label: "요소 지목·녹화",
    // 지목 버튼은 브라우저 툴바에 있다. 여기 적지 않으면 이 기능을 꺼도 그 버튼이 남아
    // 동작하지 않는 버튼이 된다. 설정 화면은 끈 기능이 화면에서 사라진다고 안내하므로
    // 이 영역도 함께 등록한다.
    panel: "wv-pick",
    load: () => import("../browser/pick-boot.js"),
  },
  {
    // 탭 하나를 독립 창으로 빼낸다. rail 화면도 전용 영역도 없이 탭 우클릭 항목과 탭바
    // 감추기 두 곳에 붙는다. 창 자체는 네이티브가 소유하고 여기서는 호출과 수신만 한다.
    // 분리 창의 도킹 복귀도 이 기능이라 그 창에도 포함한다.
    id: "detachtab",
    native: true,
    windows: ["main", "browser"],
    files: ["browser/detach-tab.js", "browser/tab-drag.js"],
    css: ["26-detach-tab.css"],
    label: "탭을 창으로 빼기",
    load: () => import("../browser/detach-tab.js"),
  },
  {
    // 주소줄 칩이 여는 드롭다운이다. ⌘⇧T 는 앱 셸의 스택이 담당하므로 이 기능을 꺼도 맨 위
    // 하나를 복원하는 경로는 남는다. 이 목록은 그 아래 항목을 고르기 위한 것이다.
    id: "closedtabs",
    windows: ["main", "browser"],
    files: ["browser/closed-tabs-menu.js"],
    css: ["24-closed-tabs.css"],
    label: "최근 닫은 탭 목록",
    load: () => import("../browser/closed-tabs-menu.js"),
  },
  {
    id: "pagetranslate",
    windows: ["main", "browser"],
    files: ["browser/page-translate.js"],
    css: [],
    label: "페이지 번역",
    load: () => import("../browser/page-translate.js"),
  },
  {
    id: "extensionloader",
    native: true,
    windows: ["main", "browser"],
    files: ["browser/extension-loader.js"],
    css: [],
    label: "React 개발자 도구",
    load: () => import("../browser/extension-loader.js"),
  },
  {
    id: "autofill",
    files: ["browser/autofill-allowlist.js"],
    css: ["06b-autofill.css"],
    rail: "autofill",
    load: () => import("../browser/autofill-allowlist.js"),
  },
  {
    id: "localdev",
    presets: ["dev"],
    files: ["devtool/localdev.js"],
    css: ["02b-localdev.css"],
    rail: "localdev",
    load: () => import("../devtool/localdev.js"),
  },
  {
    // rail 화면도 사이드바 영역도 아닌 기능으로, 가운데 탭에 붙는다. capability 의 범위는
    // rail 보다 넓다. 화면(screen)을 반환하지 않으므로 rail 없이도 성립한다.
    id: "viewer",
    // 분리 브라우저 창에도 포함한다. 브라우저가 분리형이면 표·문서 탭이 그 창에서 만들어지므로
    // (dock.js 의 reconcileDocTabs), 여기 적지 않으면 그 창에는 아무도 그리지 않는 탭만 생긴다.
    windows: ["main", "browser"],
    files: [
      "viewer/boot.js", "viewer/kinds.js",
      "docx/panel.js", "docx/editor.js",
      "sheet/actions.js", "sheet/conditional.js", "sheet/edit.js", "sheet/events.js",
      "sheet/formula.js", "sheet/mode.js", "sheet/model.js", "sheet/render.js",
      "sheet/tab-state.js", "sheet/viewer.js",
    ],
    css: ["13-sheet-view.css", "14-sheet-edit.css", "15-docx.css", "16-sheet-overlay.css"],
    label: "표·문서 뷰어",
    presets: ["dev"],
    load: () => import("../viewer/boot.js"),
  },
  {
    // rail 화면도 전용 영역도 없고 가운데 탭도 아닌, 터미널 위에서만 동작하는 기능이다. 끄면
    // xterm 의 기본 선택만 남는다(⌘C 는 그대로 동작하고, 파일을 놓아도 창이 이동하지 않는다).
    id: "chatcopy",
    files: [
      "chatcopy/boot.js", "chatcopy/copy-text.js", "chatcopy/edge-drag.js", "chatcopy/drop-path.js",
    ],
    css: ["21-chat-copy.css"],
    label: "채팅 복붙",
    load: () => import("../chatcopy/boot.js"),
  },
  {
    // rail 화면이 아니라 사이드바 영역 하나를 갖는 기능이다. capability 의 범위는 rail 보다
    // 넓다. label 은 rail 표에서 가져올 수 없으므로 여기서 직접 갖는다.
    id: "run",
    server: ["server/run.js", "server/run-handler.js"],
    presets: ["dev"],
    files: ["devtool/run.js"],
    css: ["08-run.css"],
    label: "실행",
    panel: "panel-run",
    load: () => import("../devtool/run.js"),
  },
  {
    // 영역 둘을 갖는 기능이다. 창 아래 상태 표시줄(남은 사용량)과 rail 화면(누적 사용량·계정
    // 상태)이며, 같은 자료를 쓰므로 함께 켜고 끈다. 분리하면 상태 표시줄의 링크가 존재하지
    // 않는 화면을 가리키게 된다.
    id: "usage",
    files: ["statusbar/usage.js", "usagestats/page.js"],
    css: ["28-usage.css", "29-usage-stats.css"],
    server: ["server/usage-handlers.js", "server/usage-history-handlers.js"],
    // 그 상태 표시줄은 이 기능만 쓰는 영역이라 끄면 함께 사라진다.
    panel: "statusbar",
    rail: "usage",
    load: () => import("../statusbar/usage.js"),
  },
];

export function capabilityIds() { return CAPABILITIES.map((c) => c.id); }
export function capabilityById(id) { return CAPABILITIES.find((c) => c.id === id) || null; }
