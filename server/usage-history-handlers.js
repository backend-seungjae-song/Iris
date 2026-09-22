// 사용량 이력의 스캔 지휘와 중계를 맡는 단일 소유자.
//
// 소유 범위
//   스캔 자식 프로세스 하나의 수명, 마지막 요약, 진행률, 다시 스캔할 시점 판단.
//   요약 파일 경로(stateHome()/usage-history-summary.json)도 여기서만 만든다.
//
// 제공 API
//   initUsageHistory({ broadcastLocal }) · handleUsageHistory(ws, msg) · usageHistoryWire().
//
// 의존 대상
//   stateHome() 과 자식 진입점 파일 하나. 스캔 규칙은 server/usage-history.js 가 소유한다.
//
// 유지 조건
//   스캔을 이 프로세스에서 실행하지 않는다. 기록이 10GB 를 넘어 서버 안에서 실행하면 그동안
//   앱 전체가 멈춘다. 자식 프로세스로 실행하고 결과만 받는다.
//   앱 시작 시점에 자동으로 스캔하지 않는다. 첫 스캔은 몇 분이 걸리고, 보지 않는 화면을 위해
//   실행할 때마다 디스크를 전부 읽는 비용이 크다. 화면을 열 때 시작한다.
//   동시에 두 번 실행하지 않는다. 자식이 둘이면 캐시 파일을 서로 덮어쓴다.
//   usage.history.* 는 로컬 연결에서만 받는다. 기록은 사용자의 작업 내용을 드러낸다.
//
// 영향 범위
//   server/index.js 의 초기화·분기·연결 시 첫 전송,
//   web/js/usagestats/page.js 가 받는 usage.history 계약.
//   현재 목록은 다음으로 확인한다: node bin/importers.mjs server/usage-history-handlers.js

import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stateHome } from "./state-home.cjs";

// 30분. 기록은 작업 중에만 늘고, 두 번째 스캔부터는 변경된 파일만 다시 읽는다.
const STALE_MS = 30 * 60 * 1000;

let broadcastLocal = () => {};
let summary = null;
let scanning = false;
let progress = null;
let error = null;
let child = null;
let paths = null;

function pathsOf() {
  if (!paths) {
    const home = stateHome();
    paths = {
      state: path.join(home, "usage-history.json"),
      summary: path.join(home, "usage-history-summary.json"),
    };
  }
  return paths;
}

function load() {
  try {
    const raw = fs.readFileSync(pathsOf().summary, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") summary = parsed;
  } catch {
    // 아직 스캔한 적이 없다. 화면이 그 상태를 그대로 표시한다.
  }
}

export function usageHistoryWire() {
  return {
    type: "usage.history",
    summary,
    scanning,
    progress,
    error,
    scannedAt: summary ? summary.scannedAt || 0 : 0,
  };
}

function announce() { broadcastLocal(usageHistoryWire()); }

function scan(force) {
  if (scanning) return;
  const scannedAt = summary ? summary.scannedAt || 0 : 0;
  if (!force && scannedAt && Date.now() - scannedAt < STALE_MS) return;

  const entry = fileURLToPath(new URL("./usage-history-scan.js", import.meta.url));
  const { state, summary: summaryPath } = pathsOf();
  scanning = true;
  progress = null;
  error = null;
  announce();

  try {
    child = fork(entry, [state, summaryPath], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  } catch (err) {
    scanning = false;
    error = String((err && err.message) || err).slice(0, 300);
    announce();
    return;
  }

  child.on("message", (msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "progress") { progress = { kind: msg.kind, done: msg.done, total: msg.total }; announce(); return; }
    if (msg.type === "done") { summary = msg.summary || null; progress = null; return; }
    if (msg.type === "error") { error = String(msg.message || "").slice(0, 300); }
  });
  // 자식이 예기치 않게 종료돼도 화면이 "훑는 중" 에서 멈추면 안 된다. 완료는 프로세스 종료로 판정한다.
  child.on("exit", (code) => {
    child = null;
    scanning = false;
    progress = null;
    if (code !== 0 && !error) error = `훑개가 ${code} 로 끝났습니다`;
    announce();
  });
  child.on("error", (err) => { error = String((err && err.message) || err).slice(0, 300); });
}

export function initUsageHistory(deps) {
  broadcastLocal = (deps && deps.broadcastLocal) || (() => {});
  load();
}

export function usageHistoryOnConnect(ws) {
  ws.send(JSON.stringify(usageHistoryWire()));
}

export function handleUsageHistory(ws, msg) {
  if (!ws._local) return;
  if (msg.type === "usage.history.get") { ws.send(JSON.stringify(usageHistoryWire())); scan(false); return; }
  if (msg.type === "usage.history.scan") { scan(true); }
}

// 앱이 종료될 때 자식 프로세스도 함께 종료한다. 남으면 디스크를 계속 읽으며 아무도 받지 않는 결과를 만든다.
export function stopUsageHistory() {
  if (child) { try { child.kill(); } catch { /* 이미 종료됨 */ } child = null; }
  scanning = false;
}
