// 터미널은 서버의 설정 변수를 물려받지 않는다.
// 확인 결과: 서버에 주어진 PORT=4271이 터미널로 전달되어, 그 안에서 띄운 shop CMS의
// `next dev`가 포트 지정 없이 4271을 잡았다. 와일드카드(*:4271)로 붙어 Iris의 127.0.0.1:4271과
// 충돌 없이 공존했고, 이름으로 붙는 쪽(localhost → ::1)은 Iris 대신 CMS로 연결됐다.
import assert from "node:assert";

process.env.PORT = "4271";
process.env.REMOTE = "1";
process.env.ELECTRON_RUN_AS_NODE = "1";
process.env.HERDR_PANE_ID = "w1:p1";
process.env.IRIS_STATE_DIR = "/tmp/ac-test-state";
process.env.PATH = process.env.PATH || "/usr/bin";
// Iris 를 Claude Code·Codex 세션의 셸에서 띄운 경우
process.env.CLAUDECODE = "1";
process.env.CLAUDE_CODE_SESSION_ID = "launching-session";
process.env.CLAUDE_CODE_CHILD_SESSION = "1";
process.env.CLAUDE_PID = "123";
process.env.CODEX_COMPANION_TRANSCRIPT_PATH = "/tmp/launching.jsonl";
process.env.ANTHROPIC_API_KEY = "sk-test";

const { cleanEnv } = await import("../server/pty.js");
const env = cleanEnv();

assert.equal(env.PORT, undefined, "PORT를 물려주면 터미널의 개발 서버가 이 포트를 잡는다");
assert.equal(env.REMOTE, undefined, "REMOTE는 서버 바인딩 전용 플래그다");
assert.equal(env.ELECTRON_RUN_AS_NODE, undefined, "물려주면 터미널에서 띄운 Electron 앱이 node 로 뜬다");
assert.equal(env.HERDR_PANE_ID, undefined, "herdr는 중첩 attach를 거부한다");
assert.equal(env.IRIS_STATE_DIR, "/tmp/ac-test-state", "상태 폴더는 물려줘야 CLI가 같은 쪽을 본다");
assert.ok(env.PATH, "PATH는 남아야 한다");
for (const k of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_PID", "CODEX_COMPANION_TRANSCRIPT_PATH"]) {
  assert.equal(env[k], undefined, `${k}: 물려주면 pane 의 Claude 훅이 Iris 를 띄운 세션을 자기 세션으로 보고한다`);
}
assert.equal(env.ANTHROPIC_API_KEY, "sk-test", "사용자가 정한 API 키는 남아야 한다");
assert.equal(env.TERM, "xterm-256color");

console.log("ok  터미널 환경 격리 — PORT·REMOTE·ELECTRON_RUN_AS_NODE·HERDR_*·에이전트 세션 변수 제거, 상태·PATH 보존");
