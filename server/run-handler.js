import { isPathAllowed as fsPathAllowed } from "./runtime-state.js";

// run.* WebSocket 요청의 로컬·경로 경계와 RunManager 위임을 맡는 leaf handler.
//
// 소유 범위
//   run.list/status/start/stop namespace의 분기 순서와 오류 응답 계약.
//
// 제공 API
//   entry가 RunManager port를 한 번 주입하는 initRunHandler와 run.* 요청을 받는 handleRun.
//
// 의존 대상
//   runtime-state의 단일 경로 판정과 entry가 주입하는 listScripts·runManager 함수 port.
//
// 유지 조건
//   list/status를 포함해 전부 로컬 전용이며, 경로 형식·길이·허용 판정을 통과한 뒤에만 owner를 부른다.
//   알 수 없는 op도 종전과 같은 run-error로 끝내고 다른 handler를 import하거나 호출하지 않는다.
//
// 영향 범위
//   server/index.js의 RunManager 생성·init 호출·run.* dispatch와 HTTP /run-cmd 경로,
//   server/run.js의 list/status/start/stop 계약 및 test/run-*·shutdown lifecycle 검사.

let listScripts;
let runMgr;

export function initRunHandler(deps) {
  listScripts = deps.listScripts;
  runMgr = deps.runManager;
}

// 실행 통합(WS): run.list/start/status/stop. 실행 출력엔 민감정보가 섞일 수 있고 셸 실행이므로
// list/status 포함 전부 로컬(루프백) 전용(M5). 원격/폰은 실행 통합을 쓰지 않는다.
export function handleRun(ws, msg) {
  const op = msg.type.slice(4); // "run." 뒤
  const dir = msg.path;
  if (typeof dir !== "string" || !dir || dir.length > 4096 || !fsPathAllowed(dir)) { ws.send(JSON.stringify({ type: "run-error", op, path: typeof dir === "string" ? dir : "", error: "허용되지 않은 경로" })); return; }
  if (!ws._local) { ws.send(JSON.stringify({ type: "run-error", op, path: dir, error: "실행 통합은 로컬에서만(AC5)" })); return; }
  if (op === "list") { ws.send(JSON.stringify({ type: "run-scripts", path: dir, ...listScripts(dir) })); return; }
  if (op === "status") { ws.send(JSON.stringify({ type: "run-status", path: dir, ...runMgr.status(dir) })); return; }
  if (op === "start") { const r = runMgr.start(dir, String(msg.script || "")); if (!r.ok) ws.send(JSON.stringify({ type: "run-error", op, path: dir, error: r.error, running: r.running })); return; }
  if (op === "stop") { const r = runMgr.stop(dir); if (!r.ok) ws.send(JSON.stringify({ type: "run-error", op, path: dir, error: r.error })); return; }
  ws.send(JSON.stringify({ type: "run-error", op, path: dir, error: "알 수 없는 run 연산: " + op }));
}
