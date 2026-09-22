// Electron 창 UI 상태 파일의 읽기와 부분 갱신 저장.
//
// 소유 범위
//   상태 디렉터리 아래 ui-state.json의 파싱·부분 병합·임시 파일 원자적 교체 규칙.
//
// 제공 API
//   readUiState(stateDir) · writeUiState(stateDir, patch). 파일 경로나 상태 객체를 보관해 제공하지 않는다.
//
// 의존 대상
//   node:fs, node:path와 main.cjs가 stateHome()에서 구해 넘기는 상태 디렉터리.
//
// 유지 조건
//   읽을 수 없거나 깨진 파일은 빈 상태로 읽고, patch는 기존 키를 지우지 않는다. 저장은 같은
//   디렉터리의 .tmp 파일을 완성한 뒤 rename하며 기존 오류 무시 타이밍을 유지한다.
//
// 영향 범위
//   공급자는 server/state-home.cjs와 창들의 bounds·open·memo record patch이고, 양방향 소비자는
//   main.cjs의 window layout·browser/memo window 복원·종료 수명주기다. 저장 결과는 다음 앱
//   실행의 창 위치와 열림 상태까지 번진다.

const fs = require("node:fs");
const path = require("node:path");

function readUiState(stateDir) {
  const statePath = path.join(stateDir, "ui-state.json");
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8")) || {};
  } catch {
    return {};
  }
}

function writeUiState(stateDir, patch) {
  const statePath = path.join(stateDir, "ui-state.json");
  try {
    const state = readUiState(stateDir);
    Object.assign(state, patch);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const tmp = statePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, statePath);
  } catch {}
}

module.exports = { readUiState, writeUiState };
