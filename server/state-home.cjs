// 상태 폴더가 어디인지 정하는 유일한 자리.
//
// 한 곳에 둔 이유: 한 파일이라도 경로를 직접 조합하면 개발 환경과 설치 앱의 분리가 전부
// 깨진다. browser-state.js·space-key.js가 빠져 있어 개발 서버가 설치 앱의 폴더를 그대로
// 사용했고, 그 결과 계정·검색 기록·탭이 삭제된 적이 있다. 경로를 만드는 자리는 여기 하나뿐이고
// 나머지는 이 함수를 호출한다.
//
// .cjs인 이유는 양쪽에서 함께 써야 하기 때문이다. server/*.js와 bin/*.mjs는 ESM,
// native/electron/*.cjs는 CJS다. CJS로 두면 양쪽에서 읽을 수 있다.
const os = require("node:os");
const path = require("node:path");
const { stateDirOverride } = require("./env.cjs");

const DIR_NAME = ".iris";

// 지정된 경로를 쓰기 전에 입력된 형태를 그대로 해석한다. `~/.iris-dev`나 `$HOME/.iris-dev`는
// 홈 디렉터리를 뜻하지만, 셸을 거치지 않고 전달되면 글자 그대로 남는다. package.json 스크립트가
// 그렇게 적혀 있고, plist·launchctl setenv·spawn env는 셸을 거치지 않는다. 그 문자열로 폴더를
// 만들면 앱이 탭도 계정도 없는 빈 화면으로 실행되어 데이터가 사라진 것처럼 보인다.
// 확장할 수 있으면 확장하고, 그래도 절대경로가 아니면 그대로 진행하지 않고 중단한다.
function resolveOverride(raw) {
  let v = raw;
  if (v === "~") v = os.homedir();
  else if (v.startsWith("~/")) v = path.join(os.homedir(), v.slice(2));
  else if (v === "$HOME") v = os.homedir();
  else if (v.startsWith("$HOME/")) v = path.join(os.homedir(), v.slice(6));
  if (!path.isAbsolute(v)) {
    throw new Error(`IRIS_STATE_DIR는 절대경로여야 합니다 — 받은 값: ${raw}`);
  }
  return v;
}

function stateHome() {
  const override = stateDirOverride();
  return override ? resolveOverride(override) : path.join(os.homedir(), DIR_NAME);
}

module.exports = { stateHome, DIR_NAME };
