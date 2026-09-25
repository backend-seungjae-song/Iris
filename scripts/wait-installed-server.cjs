#!/usr/bin/env node
// 새로 켠 설치 앱의 서버가 요청을 받을 때까지 기다린다. install-app.sh 가 이 결과로 이전 앱
// 백업을 지울지 되돌릴지 정한다. 준비되면 0, 시간 안에 준비되지 않으면 1 로 끝난다.
//
// 판정은 앱이 붙을 서버를 고를 때와 같다(server-host.cjs 의 healthMatches). /healthz 가 ok 이고
// 포트와 상태 폴더가 설치 앱의 것이어야 한다. 포트만 보면 같은 포트의 개발 서버를 설치 앱의
// 서버로 여긴다. 설치 앱은 IRIS_PORT·IRIS_STATE_DIR 없이 실행되므로 호출자도 그 변수를 지운 채
// 부른다. 그래야 여기서 계산한 포트·상태 폴더가 설치 앱의 것과 같다.
const { probe, healthMatches } = require("../native/electron/server-host.cjs");
const { port } = require("../server/env.cjs");
const { stateHome } = require("../server/state-home.cjs");

// 앱 실행에 몇 초, 앱이 서버를 기다리는 한도(server-host.cjs READY_TIMEOUT_MS)가 20초다.
const TIMEOUT_MS = 45000;
const POLL_MS = 500;

async function main() {
  const want = { port: port(), stateDir: stateHome() };
  const deadline = Date.now() + TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    last = await probe(want.port);
    if (healthMatches(last, want)) {
      console.log(`서버 준비 — pid ${last.pid}, ${last.stateDir}`);
      return 0;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  const seen = last ? `pid ${last.pid}, 포트 ${last.port}, 상태 ${last.stateDir}` : "응답 없음";
  console.error(`${TIMEOUT_MS / 1000}초 안에 ${want.port}번에서 ${want.stateDir} 서버가 준비되지 않았습니다(마지막: ${seen}).`);
  return 1;
}

main().then((code) => process.exit(code), (e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
