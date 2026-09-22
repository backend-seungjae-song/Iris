// 사용자가 직접 입력하는 환경변수 이름을 정하는 파일.
//
// 한곳에 두는 이유: 상태 폴더 경로를 여러 곳에서 각각 조합하면 일부가 누락돼
// 개발 서버가 설치 앱의 폴더를 쓰게 된다. 기본값과 이름도 같은 종류의 값이다.
//
// 내부 시험 스위치(IRIS_DOCX_*·IRIS_AUDIO_* 등)는 여기에 두지 않는다. 사용자가 입력하지 않고
// 코드와 테스트에서만 쓰는 이름이라 한곳에 모을 이유가 없다.
const DEFAULT_PORT = 4271;

// 상태 폴더를 사용자가 직접 지정했을 때 그 값. 어디로 해석되는지는 state-home.cjs가 정한다.
function stateDirOverride() {
  const v = process.env.IRIS_STATE_DIR;
  return v === undefined || v === "" ? undefined : v;
}

// 서버 포트.
function port() {
  const n = Number(process.env.IRIS_PORT);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PORT;
}

// 서버 프로세스만 이전 이름 `PORT` 도 함께 받는다(launchd plist 가 아직 그 이름을 쓸 수 있다).
// 이 함수의 핵심은 순서이고 IRIS_PORT 가 먼저다. PORT 는 흔한 이름이라 다른 프로그램도
// 사용하며, 그 이름을 물려받은 셸에서 실행하면 격리하려던 서버가 설치된 앱의 포트를 잡는다
// (확인 결과: EADDRINUSE 종료 62회가 같은 원인이었다).
//
// 이 함수가 env.cjs 에 있는 이유는 규칙 때문이다. 사용자가 입력하는 환경변수 이름을 읽는 위치는
// 여기 하나다. 흩어지면 일부가 누락돼 설정한 값이 적용되지 않는다.
function portWithLegacy() {
  const iris = Number(process.env.IRIS_PORT);
  if (Number.isFinite(iris) && iris > 0) return iris;
  const legacy = Number(process.env.PORT);
  if (Number.isFinite(legacy) && legacy > 0) return legacy;
  return DEFAULT_PORT;
}

// 앱이 자식 서버를 실행할 때 전달하는 설정. 읽는 위치와 쓰는 위치가 갈라지면 한쪽만
// 이름이 바뀌고 자식 프로세스는 기본값으로 실행된다. 그러면 개발 앱이 실행한 서버가 설치 앱의
// 상태 폴더를 쓴다.
function childEnv({ port, stateDir }) {
  return { IRIS_PORT: String(port), IRIS_STATE_DIR: stateDir };
}

module.exports = { stateDirOverride, port, portWithLegacy, DEFAULT_PORT, childEnv };
