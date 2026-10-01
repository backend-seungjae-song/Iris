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

// Origin 추가 허용 호스트 이름. 쉼표 구분
// 비교는 http://<이름>:<이 서버 포트> 전체 origin 기준
// 호출마다 읽기. 검사가 값을 바꿔 가며 호출
function allowedOriginHosts() {
  return (process.env.IRIS_ALLOWED_ORIGIN_HOSTS || "").split(",").map((s) => s.trim()).filter(isHostName);
}

// 호스트 이름 형식 판정. 영문·숫자·하이픈 라벨의 점 연결만
// 경로·포트·userinfo·query 포함 값 제외. 포함 시 URL 해석에서 포트 제한 무력화
function isHostName(value) {
  return /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(value);
}

// 서버 네트워크 정책 버전. /healthz 응답에 포함
// 앱은 같은 값의 서버에만 재사용 연결. 이전 정책(0.0.0.0 수신) 서버 재사용 방지
const NET_POLICY = "loopback-only/1";

// 기존 원격 설정(REMOTE·HOST) 중 지정된 항목 목록
// 값과 무관하게 바인딩은 루프백 고정. 외부 접속은 원격 게이트웨이 전용
// 이 목록은 기동 경고 표시용
function ignoredRemoteEnv() {
  return ["REMOTE", "HOST"].filter((name) => process.env[name]);
}

// 서버 수신 주소. 루프백 고정
function host() {
  return "127.0.0.1";
}

// 앱이 자식 서버를 실행할 때 전달하는 설정. 읽는 위치와 쓰는 위치가 갈라지면 한쪽만
// 이름이 바뀌고 자식 프로세스는 기본값으로 실행된다. 그러면 개발 앱이 실행한 서버가 설치 앱의
// 상태 폴더를 쓴다.
function childEnv({ port, stateDir }) {
  return { IRIS_PORT: String(port), IRIS_STATE_DIR: stateDir };
}

module.exports = { stateDirOverride, port, portWithLegacy, allowedOriginHosts, ignoredRemoteEnv, host, NET_POLICY, DEFAULT_PORT, childEnv };
