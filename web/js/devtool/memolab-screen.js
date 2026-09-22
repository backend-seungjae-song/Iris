// 메모랩 화면: 판·조각을 Iris 안에서 연다.
//
// 소유 범위
//   rail 「메모랩」 영역 하나와 그 안에 들어가는 iframe. 메모랩 자체는 아니다. 그 화면은
//   web/memolab/ 이 소유하고 서버가 그대로 내준다.
//
// 설계 이유
//   메모랩은 자기 문서·CSS·단축키를 가진 한 장짜리 화면이다. Iris 문서 안으로
//   직접 들이면 전역 선택자와 초기화 시점을 광범위하게 바꿔야 하고, 그 비용을 낼 이유가
// 지금 요구에는 없다. 대신 주소·DOM·화면을 그대로 두고
//   진입점 하나만 만든다. 끄면 이 모듈이 로드되지 않고 iframe 도 생기지 않는다.
//
// 제공 API
//   panelHtml 과 initCapability. 그 밖의 것은 없다. 화면 쪽 함수는 이 창이 아니라
//   iframe 안 문서의 것이다.
//
// 의존 대상
//   ctx 에서 아무것도 꺼내지 않는다. 이 화면은 서버 메시지도 받지 않는다. 메모랩은 WebSocket 이
//   아니라 자기 HTTP 저장소(/memolab-state · /memolab-ui)를 쓴다.
//
// 영향 범위
//   core/rail-items.js 의 memolab 줄과 web/index.html 의 rail 버튼, core/capabilities.js 의
//   memolab 줄, web/css/30-memolab.css, docs/iris-screens.json, docs/iris-sequential-audit.md.
//   화면 자체는 web/memolab/ 이고 그 저장소는 server/memolab-store.js 다.
//
// 유지 조건
//   화면을 미리 로드하지 않는다. 처음 들어갈 때 src 를 넣는다. 그렇지 않으면 이 기능을 켠 사람은
//   한 번도 열지 않아도 판을 통째로 내려받는다.
//   iframe 을 지우지 않는다. 나갈 때 지우면 다시 들어올 때마다 새로 읽고, 적다 만 줄과
//   스크롤 위치가 사라진다.

export const panelHtml = `
  <div class="ml-head">
    <span class="ml-title">메모랩</span>
    <button class="ml-open" type="button" title="따로 열기">따로 열기</button>
  </div>
  <iframe class="ml-frame" title="메모랩"></iframe>
`;

const PAGE = "/memolab/";

let frame = null;
let loaded = false;

function mount(root) {
  if (!root) return;
  frame = root.querySelector(".ml-frame");
  const open = root.querySelector(".ml-open");
  // 창 하나를 통째로 쓰고 싶을 때. 같은 주소라 같은 저장소를 본다
  if (open) open.addEventListener("click", () => window.open(PAGE, "_blank", "noopener"));
}

function enter() {
  const root = document.getElementById("ml-panel");
  if (!frame || (root && !root.contains(frame))) mount(root);
  if (!frame || loaded) return;
  loaded = true;
  frame.src = PAGE;
}

export function initCapability() {
  return { screen: { enter } };
}
