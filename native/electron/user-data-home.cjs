// Chromium 이 쿠키·로그인 세션·파티션을 두는 폴더가 어디인지 정하는 유일한 자리.
//
// 설계 이유: 개발 환경과 설치본이 갈린 것은 실행 방법의 부수 효과였다. 설치본은 productName 이
// Iris 라 `Application Support/Iris` 를 쓰고, 개발은 `npx electron` 이라 productName 이 없어
// `Application Support/Electron` 을 썼다. 명시적으로 정한 규칙도 검사도 없었다.
// 실행 방법이 바뀌면(예: 개발도 productName 을 갖는 빌드로 실행하면) 두 환경이 같은 쿠키
// 폴더를 쓰게 되고, 그때 잃는 것은 탭이 아니라 로그인 세션 전체다.
// 그래서 쿠키 폴더 이름을 상태 폴더에 연결한다. 상태 폴더가 다르면 쿠키 폴더도 반드시 다르다.
//
// 소유 범위
//   상태 폴더 → Chromium userData 폴더 이름의 대응 하나.
//
// 제공 API
//   userDataHomeFor(stateDir, base) 와, 조립부에서 부르는 pinUserDataHome(app).
//
// 의존 대상
//   state-home.cjs 의 기본 폴더 이름과, Electron app 의 getPath/setPath.
//   app.setPath("userData", …) 는 ready 전에 호출해야 한다. 그 뒤에는 이미 열린 세션이 있다.
//
// 유지 조건
//   설치본의 경로를 옮기지 않는다. 상태 폴더가 기본(`~/.iris`)이면 아무것도 하지 않는다.
//   여기서 한 글자만 달라져도 사용자의 로그인이 모두 사라진 것처럼 보인다.
//   개발 환경은 설치본과 같은 폴더를 쓸 수 없다. 이름을 만들지 못하면 기본값으로 되돌리지 않는다.
//
// 영향 범위
//   공급자는 main.cjs 의 Electron app 이고, 양방향 소비자는 cookie-import.cjs 다.
//   거기가 `app.getPath("userData")` 아래의 Partitions·staging 을 직접 읽는다.
//   씨앗 스크립트(bin/dev-seed.mjs)도 같은 대응을 알아야 하므로 함께 확인한다.
//   현재 목록 확인: node bin/importers.mjs native/electron/user-data-home.cjs

const path = require("node:path");
const { stateHome, DIR_NAME } = require("../../server/state-home.cjs");
const { sessionNameFor, DEFAULT_SESSION } = require("../../server/herdr-session.cjs");

const INSTALLED_DIR = "Iris";

// 상태 폴더 → userData 폴더 이름. 세션 이름과 같은 규칙을 쓴다. 환경을 구분하는 이름이
// 둘이면 하나만 수정되기 쉽다.
function userDataNameFor(stateDir) {
  const name = sessionNameFor(stateDir);
  return name === DEFAULT_SESSION ? INSTALLED_DIR : `${INSTALLED_DIR}-${name}`;
}

function userDataHomeFor(stateDir, base) {
  return path.join(base, userDataNameFor(stateDir));
}

// 조립부에서 ready 전에 한 번. 설치본이면 아무것도 하지 않는다.
function pinUserDataHome(app, stateDir = stateHome()) {
  if (path.basename(String(stateDir)) === DIR_NAME) return null;
  const base = path.dirname(app.getPath("userData"));
  const next = userDataHomeFor(stateDir, base);
  app.setPath("userData", next);
  return next;
}

module.exports = { pinUserDataHome, userDataHomeFor, userDataNameFor, INSTALLED_DIR };
