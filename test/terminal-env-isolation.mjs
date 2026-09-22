// 터미널은 서버의 설정 변수를 물려받지 않는다.
// 확인 결과: 서버에 주어진 PORT=4271이 터미널로 전달되어, 그 안에서 띄운 shop CMS의
// `next dev`가 포트 지정 없이 4271을 잡았다. 와일드카드(*:4271)로 붙어 Iris의 127.0.0.1:4271과
// 충돌 없이 공존했고, 이름으로 붙는 쪽(localhost → ::1)은 Iris 대신 CMS로 연결됐다.
import assert from "node:assert";

process.env.PORT = "4271";
process.env.REMOTE = "1";
process.env.HERDR_PANE_ID = "w1:p1";
process.env.IRIS_STATE_DIR = "/tmp/ac-test-state";
process.env.PATH = process.env.PATH || "/usr/bin";

const { cleanEnv } = await import("../server/pty.js");
const env = cleanEnv();

assert.equal(env.PORT, undefined, "PORT를 물려주면 터미널의 개발 서버가 이 포트를 잡는다");
assert.equal(env.REMOTE, undefined, "REMOTE는 서버 바인딩 전용 플래그다");
assert.equal(env.HERDR_PANE_ID, undefined, "herdr는 중첩 attach를 거부한다");
assert.equal(env.IRIS_STATE_DIR, "/tmp/ac-test-state", "상태 폴더는 물려줘야 CLI가 같은 쪽을 본다");
assert.ok(env.PATH, "PATH는 남아야 한다");
assert.equal(env.TERM, "xterm-256color");

console.log("ok  터미널 환경 격리 — PORT·REMOTE·HERDR_* 제거, 상태·PATH 보존");
