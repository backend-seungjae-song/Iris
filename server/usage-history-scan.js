// 이력 스캔을 실행하는 자식 프로세스. 부모(서버)는 이 파일을 fork 하고 결과만 받는다.
//
// 소유 범위
//   캐시 파일을 읽고 스캔하고 원자적으로 다시 쓰는 순서, 진행률·완료를 부모에게 알리는 메시지.
//
// 제공 API
//   진입점 하나. import 용 모듈이 아니다.
//
// 의존 대상
//   argv[2] 로 받은 캐시 파일 경로와 server/usage-history.js 의 스캐너.
//
// 유지 조건
//   부모 프로세스에서 실행하지 않는다. 10GB 넘는 기록을 줄 단위로 JSON 파싱하므로 서버
//   프로세스 안에서 실행하면 그동안 앱의 WS 가 전부 멈춘다.
//   큰 결과를 IPC 로 보내지 않는다. 캐시는 이 프로세스가 파일에 쓰고, 부모에게는 요약만 준다.
//   덮어쓰기는 임시 파일에 쓴 뒤 옮긴다. 스캔 도중 앱이 종료되면 일부만 쓰인 캐시가 남는다.
//
// 영향 범위
//   server/usage-history-handlers.js 가 fork 하고 이 메시지를 받는다.

import fs from "node:fs";

import { scanHistory, buildSummary } from "./usage-history.js";

const file = process.argv[2];
const summaryFile = process.argv[3];

function send(msg) {
  if (typeof process.send === "function") process.send(msg);
}

function loadPrev() {
  try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return null; }
}

let lastSent = 0;
function progress(p) {
  const now = Date.now();
  // 200ms 보다 자주 보내면 IPC 비용이 스캔보다 커진다.
  if (now - lastSent < 200) return;
  lastSent = now;
  send({ type: "progress", ...p });
}

async function main() {
  if (!file || !summaryFile) { send({ type: "error", message: "캐시 경로가 없습니다" }); process.exit(1); return; }
  try {
    const state = await scanHistory(loadPrev(), progress);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file);
    // 요약은 따로 남긴다. 캐시 본문은 수십 MB 라 앱 시작 시점에 열기에 부담이 크다.
    // 부모는 이 작은 파일만 읽고 첫 화면을 그린다.
    const summary = buildSummary(state);
    const stmp = `${summaryFile}.tmp`;
    fs.writeFileSync(stmp, JSON.stringify(summary));
    fs.renameSync(stmp, summaryFile);
    send({ type: "done", summary });
  } catch (err) {
    send({ type: "error", message: String((err && err.message) || err).slice(0, 300) });
  }
}

main();
