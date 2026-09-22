// 어느 herdr 세션에 연결할지 정하는 단일 지점.
//
// 한곳에 두는 이유: 두 곳이 각각 정하면 `herdr.js` 가 소켓 경로를, `pty.js` 가
// 세션 이름을 지정하는데, 그 둘이 같은 세션을 가리킨다는 보장이 없다. 둘 다
// `default` 이면 개발 앱을 실행하는 순간 사용자가 쓰는 채팅에 또 하나의 클라이언트로
// 연결된다. herdr 는 공유 세션의 PTY 를 연결된 클라이언트 크기로 리플로우하므로, 개발 창을
// 띄울 때마다 실제 채팅이 그 크기로 바뀐다.
//
// 이름을 사용자가 직접 지정하지 않고 상태 폴더에서 유도한다. 개발 환경은 이미 상태 폴더가
// 반드시 다르고(데이터 보존 조건이다), 그 값에 연동하면 개발 환경이 실수로 실제 채팅에
// 연결되는 조합 자체가 생기지 않는다. 문서로만 정한 규칙은 매번 판단이 필요하지만
// 이렇게 연동하면 판단할 여지가 없다.
//
// .cjs 인 이유는 state-home.cjs 와 같다. server/*.js(ESM)와 native/electron/*.cjs(CJS)가
// 같이 읽어야 한다.
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { stateHome, DIR_NAME } = require("./state-home.cjs");

const CONFIG_DIR = path.join(os.homedir(), ".config", "herdr");
const DEFAULT_SESSION = "default";

// herdr 세션 이름은 그대로 폴더 이름이 된다. 사용할 수 없는 문자를 제거하고, 앞뒤의 점과 하이픈도
// 제거한다. `..` 가 남으면 소켓 경로가 sessions/../herdr.sock 으로 정규화되어 실제 채팅
// 소켓을 가리킨다.
function sanitize(raw) {
  return String(raw || "")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^[.-]+/, "")
    .replace(/[.-]+$/, "")
    .slice(0, 40);
}

// 이름을 만들지 못했을 때의 기본값. `default` 로 두면 안 된다. 이름을 만들 수 없는 개발 폴더가
// 사용자가 쓰는 채팅에 연결되기 때문이다. 폴더마다 다른 값을 주되 같은 폴더면 항상 같아야 한다.
function fallbackName(seed) {
  return `iris-${crypto.createHash("sha1").update(String(seed)).digest("hex").slice(0, 8)}`;
}

// 상태 폴더 이름 → 세션 이름. `~/.iris` 는 설치본이므로 default 를 그대로 쓰고,
// 그 밖은 폴더 이름에서 끌어낸다(`~/.iris-dev` → dev).
function sessionNameFor(dir) {
  const abs = String(dir || "");
  const base = path.basename(abs);
  if (base === DIR_NAME) return DEFAULT_SESSION;
  const stripped = base.startsWith(`${DIR_NAME}-`) ? base.slice(DIR_NAME.length + 1) : base;
  const safe = sanitize(stripped);
  // 정규화 결과가 비었거나 default 가 된 경우다. 설치본이 아닌데 default 로 가면 안 된다.
  return safe && safe !== DEFAULT_SESSION ? safe : fallbackName(abs);
}

// herdr 는 세션마다 소켓을 따로 만든다(확인 결과). default 는 설정 폴더 바로 아래,
// 이름 있는 세션은 sessions/<이름>/ 아래다. 그래서 세션을 나누면 사이드바·에이전트 목록까지
// 함께 분리되며, 크기만 달라지는 것이 아니다.
function socketFor(name) {
  return name === DEFAULT_SESSION
    ? path.join(CONFIG_DIR, "herdr.sock")
    : path.join(CONFIG_DIR, "sessions", name, "herdr.sock");
}

// 사용자가 직접 지정할 때만 쓰는 값. 비어 있으면 상태 폴더가 정한다.
// 명시적으로 `default` 를 지정한 것은 의도가 분명하므로 그대로 따른다. 상태 폴더 연동은 실수를 막기
// 위한 것이지 의도적인 지정을 막는 것이 아니다.
function herdrSession() {
  const named = String(process.env.IRIS_HERDR_SESSION || "").trim();
  if (named) {
    const name = named === DEFAULT_SESSION ? DEFAULT_SESSION : (sanitize(named) || fallbackName(named));
    return { name, socket: socketFor(name), isDefault: name === DEFAULT_SESSION };
  }
  const name = sessionNameFor(stateHome());
  return { name, socket: socketFor(name), isDefault: name === DEFAULT_SESSION };
}

module.exports = { herdrSession, sessionNameFor, socketFor, sanitize, DEFAULT_SESSION };
