// AudioService 메모리 표본·종료 진단과 A/B 스위치 정책.
//
// 소유 범위
//   AudioService별 마지막 working set, 진단 timer, env에서 확정한 진단·A/B 모드.
//
// 제공 API
//   createAudioDiagnostics(...)가 start·log·sample·applyTestSwitches 명령과 enabled·testMode 조회를 준다.
//   원시 Map이나 timer는 내주지 않는다.
//
// 의존 대상
//   조립부가 넘기는 app metrics/event port, env, log, interval 생성·해제 함수와 현재 시각.
//
// 유지 조건
//   유효한 env 값만 ready 전에 스위치를 붙이고, 진단이 꺼졌으면 timer를 만들지 않는다. 메모리
//   표본은 첫 기준점과 직전보다 증가한 값만, 종료는 AudioService Utility 사건만 기록한다.
//
// 영향 범위
//   공급자는 main.cjs의 Electron app·commandLine·process.env와 preload의 --ac-audio-diag이고,
//   양방향 소비자는 main.cjs의 media IPC·BrowserWindow additionalArguments·ready 전 스위치·whenReady
//   시작부다. 로그는 app.log의 AudioService 메모리·미디어 상관 분석에도 쓰인다.

const AUDIO_TEST_MODES = new Set(["input", "output", "both"]);
const AUDIO_DIAG_INTERVAL_MS = 30000;

function createAudioDiagnostics({
  app,
  env = process.env,
  log = console.log,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  now = () => new Date(),
}) {
  const testMode = AUDIO_TEST_MODES.has(env.IRIS_AUDIO_TEST) ? env.IRIS_AUDIO_TEST : "";
  const enabled = env.IRIS_AUDIO_DIAG === "1" || !!testMode;
  const audioWorkingSets = new Map();
  let audioMetricsTimer = null;

  function audioDiagLog(event, details = {}) {
    if (!enabled) return;
    log("[audio-diag]", JSON.stringify({ timestamp: now().toISOString(), event, ...details }));
  }

  function isAudioUtility(details) {
    if (!details || details.type !== "Utility") return false;
    return /audio/i.test([details.name, details.serviceName].filter(Boolean).join(" "));
  }

  function audioMetricKey(metric) {
    return [metric.pid, metric.creationTime || 0, metric.serviceName || metric.name || ""].join(":");
  }

  function sampleAudioServiceMemory() {
    let metrics;
    try { metrics = app.getAppMetrics(); } catch { return; }
    if (!Array.isArray(metrics)) return;
    const alive = new Set();
    for (const metric of metrics) {
      if (!isAudioUtility(metric)) continue;
      const workingSetSize = Number(metric.memory && metric.memory.workingSetSize);
      if (!Number.isFinite(workingSetSize) || workingSetSize < 0) continue;
      const key = audioMetricKey(metric);
      const previous = audioWorkingSets.get(key);
      alive.add(key);
      audioWorkingSets.set(key, workingSetSize);
      if (previous === undefined || workingSetSize > previous) {
        audioDiagLog("audio-service-memory", {
          pid: metric.pid,
          creationTime: metric.creationTime,
          type: metric.type,
          name: metric.name || "",
          serviceName: metric.serviceName || "",
          workingSetSize,
          delta: previous === undefined ? null : workingSetSize - previous,
          unit: "KB",
        });
      }
    }
    for (const key of audioWorkingSets.keys()) if (!alive.has(key)) audioWorkingSets.delete(key);
  }

  function start() {
    if (!enabled || audioMetricsTimer) return;
    audioDiagLog("diagnostics-started", { intervalMs: AUDIO_DIAG_INTERVAL_MS, testMode: testMode || "baseline" });
    app.on("child-process-gone", (_event, details) => {
      if (!isAudioUtility(details)) return;
      audioDiagLog("audio-service-gone", {
        reason: details.reason || "",
        exitCode: details.exitCode,
        type: details.type || "",
        name: details.name || "",
        serviceName: details.serviceName || "",
      });
    });
    sampleAudioServiceMemory();
    audioMetricsTimer = setIntervalFn(sampleAudioServiceMemory, AUDIO_DIAG_INTERVAL_MS);
    if (audioMetricsTimer.unref) audioMetricsTimer.unref();
    app.once("before-quit", () => {
      if (audioMetricsTimer) clearIntervalFn(audioMetricsTimer);
      audioMetricsTimer = null;
    });
  }

  function applyTestSwitches(commandLine) {
    const switches = [];
    if (testMode === "input" || testMode === "both") {
      commandLine.appendSwitch("disable-audio-input");
      switches.push("disable-audio-input");
    }
    if (testMode === "output" || testMode === "both") {
      commandLine.appendSwitch("disable-audio-output");
      switches.push("disable-audio-output");
    }
    if (switches.length) audioDiagLog("switches-applied", { testMode, switches });
  }

  return {
    isEnabled: () => enabled,
    testMode: () => testMode,
    log: audioDiagLog,
    sample: sampleAudioServiceMemory,
    start,
    applyTestSwitches,
  };
}

module.exports = { createAudioDiagnostics };
