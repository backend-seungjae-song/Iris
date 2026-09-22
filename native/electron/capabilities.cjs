// 네이티브 쪽 기능 표.
//
// 소유 범위
//   기능 하나가 네이티브에서 어느 모듈로 들어가는가. 그 진입점 목록 하나.
//
// 제공 API
//   NATIVE_CAPABILITIES: { id, module } 의 배열. id 는 렌더러 표(web/js/core/capabilities.js)의
//   id 와 같은 용어를 쓴다. 같은 기능이 두 이름을 가지면 양쪽을 연결해 볼 수 없다.
//
// 의존 대상
//   없다. 이 파일은 문자열만 갖는다. 여기서 require 를 하면 표를 읽는 순간 전부 로드된다.
//
// 유지 조건
//   module 은 반드시 require.resolve 에 리터럴을 넘겨 적는다. 이 형태는 모듈을 실행하지 않고
//   가리키기만 하므로 표를 읽어도 아무것도 로드되지 않고, 동시에 그래프 도구가 그 변을 인식한다.
//   문자열로만 적으면 어떤 도구도 그것을 참조로 읽지 못해, 그 모듈이 고아로 잡히거나 소유
//   판정에서 조용히 제외된다(확인 결과: 문자열로만 뒀더니 bin/graph.mjs 가 "진입점에서 안 닿음"으로
//   잡았다).
//   여기 등록된 모듈은 main.cjs 가 최상위에서 require 하지 않는다. 둘 다 있으면 경계가 없는 것과
//   같다. 정적으로 로드되면서 표에도 적힌 상태가 되어 검사만 통과한다.
//
// 영향 범위
//   capability-host.cjs 가 이 표를 순회한다. bin/graph.mjs 가 이 파일의 경로 문자열을 변으로 읽고,
//   스위트가 이 표를 경계로 삼아 네이티브 소유를 파생한다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs native/electron/capabilities.cjs

const NATIVE_CAPABILITIES = [
  { id: "chromemirror", module: require.resolve("./chrome-mirror-backend.cjs") },
  { id: "detachtab", module: require.resolve("./detached-tab-window.cjs") },
  { id: "extensionloader", module: require.resolve("./extension-loader.cjs") },
  { id: "sketch", module: require.resolve("./sketch-shot.cjs") },
];

module.exports = { NATIVE_CAPABILITIES };
