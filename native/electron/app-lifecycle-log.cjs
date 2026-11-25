// 앱 본체 수명 기록: diagnostics/app-lifecycle.jsonl
//
// 남기는 것
//   start(이전 실행이 정상 종료 없이 끝났으면 그 실행의 pid·시작·마지막 생존 시각), quit(이유),
//   main-stall(앱 본체 이벤트 루프가 5초 넘게 멈췄다 돌아온 시간), renderer-gone·child-process-gone(이유·종료 코드)
// 이유
//   2026-11-17 10:58~11:03 앱 본체가 멈추고 재시작됐는데 멈춘 시간·재시작 이유가 어디에도 남지 않았음.
//   앱 본체 콘솔 출력은 파일로 가지 않음
// 유지 조건
//   기록 실패는 앱 동작에 영향 없음. 예외는 삼킴. 실행 중 표시 파일(running.json)은 정상 종료 때만 지움

const fs = require("node:fs");
const path = require("node:path");

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const TICK_MS = 1000;
const STALL_MS = 5000;
const ALIVE_EVERY_MS = 10000;

// 1초 간격 타이머의 실제 간격 → 멈춘 시간(ms) 또는 null
function stallFrom(previousTick, now, tickMs = TICK_MS, stallMs = STALL_MS) {
  const gap = now - previousTick;
  return gap - tickMs >= stallMs ? gap - tickMs : null;
}

function createAppLifecycleLog({ app, dir, pid = process.pid, version = "", now = Date.now,
  setIntervalFn = setInterval, fsImpl = fs }) {
  const file = path.join(dir, "app-lifecycle.jsonl");
  const marker = path.join(dir, "running.json");
  let startedAt = 0, lastTick = 0, lastAliveWrite = 0;

  function write(event, details = {}) {
    try {
      fsImpl.mkdirSync(dir, { recursive: true });
      try { if (fsImpl.statSync(file).size >= MAX_FILE_BYTES) fsImpl.renameSync(file, `${file}.1`); } catch {}
      fsImpl.appendFileSync(file, `${JSON.stringify({ at: new Date(now()).toISOString(), event, pid, ...details })}\n`);
    } catch {}
  }

  function writeMarker(t) {
    try { fsImpl.writeFileSync(marker, JSON.stringify({ pid, version, startedAt, lastAliveAt: t })); } catch {}
  }

  function tick() {
    const t = now();
    const stall = stallFrom(lastTick, t);
    if (stall != null) write("main-stall", { ms: stall, resumedAt: new Date(t).toISOString() });
    lastTick = t;
    if (t - lastAliveWrite >= ALIVE_EVERY_MS) { lastAliveWrite = t; writeMarker(t); }
  }

  function start() {
    startedAt = lastTick = lastAliveWrite = now();
    let previous = null;
    try { previous = JSON.parse(fsImpl.readFileSync(marker, "utf8")); } catch {}
    write("start", { version, ...(previous ? { previousUnclean: previous } : {}) });
    writeMarker(startedAt);
    const timer = setIntervalFn(tick, TICK_MS);
    if (timer && timer.unref) timer.unref();
    app.on("render-process-gone", (_event, wc, details) => {
      let url = "";
      try { url = wc.getURL(); } catch {}
      write("renderer-gone", { wc: wc?.id, url: url.slice(0, 200), reason: details?.reason, exitCode: details?.exitCode });
    });
    app.on("child-process-gone", (_event, details) => {
      write("child-process-gone", { type: details?.type, name: details?.name || details?.serviceName,
        reason: details?.reason, exitCode: details?.exitCode });
    });
  }

  // 정상 종료 직전 한 번
  function quit(reason) {
    write("quit", { reason });
    try { fsImpl.unlinkSync(marker); } catch {}
  }

  return { start, quit, tick };
}

module.exports = { createAppLifecycleLog, stallFrom, STALL_MS };
