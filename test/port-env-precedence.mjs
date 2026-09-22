import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 개발 환경과 설치된 앱의 분리는 데이터 보존 조건이다. 그 분리를 여는 값이 IRIS_PORT 와
// IRIS_STATE_DIR 둘인데, 포트 쪽이 적용되지 않는 경로가 있었다.
//
// 확인 결과: `IRIS_PORT=4293 IRIS_STATE_DIR=~/.iris-verify node server/index.js` 가
// 상태 폴더는 옮겨 갔는데 포트는 4271(설치된 앱의 포트)에 붙었다. 셸에 PORT=4271 이
// 남아 있었고 http-handler 가 PORT 를 먼저 봤기 때문이다. 격리하려고 띄운 서버가 실제 앱과
// 같은 포트를 잡았다.
//
// PORT 는 흔한 이름이라 이 서버 외의 것도 물려준다. 그래서 둘 다 있으면 IRIS_PORT 가
// 우선해야 한다. IRIS_PORT 가 이 서버를 지정하는 값이기 때문이다.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function resolvedPort(env) {
  const src = "import('./server/http-handler.js').then((m) => console.log(m.PORT));";
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", src], {
    cwd: ROOT, encoding: "utf8",
    // 물려받은 환경을 전부 끊는다. 이 검사 자체가 남아 있는 PORT 에 오염되면
    // 무엇을 재는지 알 수 없게 된다.
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  });
  return Number(out.trim());
}

test("IRIS_PORT beats a leaked PORT", () => {
  assert.equal(resolvedPort({ IRIS_PORT: "4293", PORT: "4271" }), 4293);
});

test("PORT still works alone (옛 설정 호환)", () => {
  assert.equal(resolvedPort({ PORT: "4281" }), 4281);
});

test("IRIS_PORT alone is honoured", () => {
  assert.equal(resolvedPort({ IRIS_PORT: "4291" }), 4291);
});

test("neither set falls back to the installed app's port", () => {
  assert.equal(resolvedPort({}), 4271);
});

test("쓰레기 값은 무시하고 다음 후보로 내려간다", () => {
  assert.equal(resolvedPort({ IRIS_PORT: "안녕", PORT: "4281" }), 4281);
  assert.equal(resolvedPort({ IRIS_PORT: "0", PORT: "4281" }), 4281);
  assert.equal(resolvedPort({ IRIS_PORT: "-1" }), 4271);
});
