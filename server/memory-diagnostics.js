// 서버 메모리 진단. 주기 기록과 신호로 받는 프로파일
//
// 주기 기록: 1분마다 diagnostics/server-memory.jsonl 에 memoryUsage·V8 힙 공간별 용량과 사용량
// 프로파일: SIGUSR2 수신 시, 또는 RSS 가 600MB 를 넘으면(6시간에 1회) 120초 동안 할당 프로파일(회수된 객체 포함)과
// CPU 프로파일 저장. 종류별 최근 8개만 유지
// 정상 RSS 83~177MB, 수정 전 누수 때 2.6GB
// 힙 용량과 살아 있는 객체 크기의 차이, 할당이 많은 함수를 찾는 용도
// 기록 실패는 서버 동작에 영향 없음. 예외는 삼킴
import fs from "node:fs";
import path from "node:path";
import v8 from "node:v8";
import inspector from "node:inspector";

const SAMPLE_INTERVAL_MS = 60000;
const PROFILE_MS = 120000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const AUTO_PROFILE_RSS_MB = 600;
const AUTO_PROFILE_GAP_MS = 6 * 3600000;
const KEEP_FILES = 8;

const mb = (n) => Math.round(n / 104857.6) / 10;

export function memorySample(now = new Date()) {
  const mu = process.memoryUsage();
  const hs = v8.getHeapStatistics();
  return {
    at: now.toISOString(),
    rss: mb(mu.rss), heapTotal: mb(mu.heapTotal), heapUsed: mb(mu.heapUsed),
    external: mb(mu.external), arrayBuffers: mb(mu.arrayBuffers),
    physical: mb(hs.total_physical_size), malloced: mb(hs.malloced_memory), peakMalloced: mb(hs.peak_malloced_memory),
    heapLimit: mb(hs.heap_size_limit),
    spaces: Object.fromEntries(v8.getHeapSpaceStatistics().map((s) => [s.space_name,
      { size: mb(s.space_size), used: mb(s.space_used_size), available: mb(s.space_available_size), physical: mb(s.physical_space_size) }])),
  };
}

function prune(dir, pattern) {
  try {
    const files = fs.readdirSync(dir).filter((f) => pattern.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(KEEP_FILES)) fs.unlinkSync(path.join(dir, f));
  } catch {}
}

export function startMemoryDiagnostics({ dir, log = console.log, setIntervalFn = setInterval,
  sampleFn = memorySample, nowMs = Date.now, setTimeoutFn = setTimeout } = {}) {
  const file = path.join(dir, "server-memory.jsonl");
  let profiling = false;
  let lastAutoProfile = -Infinity;

  function sample() {
    try {
      const row = sampleFn();
      fs.mkdirSync(dir, { recursive: true });
      try { if (fs.statSync(file).size >= MAX_FILE_BYTES) fs.renameSync(file, `${file}.1`); } catch {}
      fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
      if (row.rss > AUTO_PROFILE_RSS_MB && nowMs() - lastAutoProfile >= AUTO_PROFILE_GAP_MS && !profiling) {
        lastAutoProfile = nowMs();
        profile("auto");
      }
    } catch {}
  }

  function profile(reason = "request") {
    if (profiling) return false;
    profiling = true;
    const session = new inspector.Session();
    const post = (method, params = {}) => new Promise((resolve, reject) =>
      session.post(method, params, (err, res) => (err ? reject(err) : resolve(res))));
    const stamp = Date.now();
    (async () => {
      session.connect();
      await post("HeapProfiler.enable");
      await post("Profiler.enable");
      await post("HeapProfiler.startSampling", { samplingInterval: 32768, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
      await post("Profiler.start");
      log(`[diag] 프로파일 시작 ${PROFILE_MS / 1000}초 (${reason})`);
      await new Promise((resolve) => setTimeoutFn(resolve, PROFILE_MS));
      const { profile: heap } = await post("HeapProfiler.stopSampling");
      const { profile: cpu } = await post("Profiler.stop");
      fs.mkdirSync(dir, { recursive: true });
      const base = path.join(dir, `server-${stamp}-${reason}`);
      fs.writeFileSync(`${base}.heapprofile`, JSON.stringify(heap));
      fs.writeFileSync(`${base}.cpuprofile`, JSON.stringify(cpu));
      prune(dir, /^server-.*\.heapprofile$/);
      prune(dir, /^server-.*\.cpuprofile$/);
      log(`[diag] 프로파일 저장 ${base}`);
    })().catch((e) => log(`[diag] 프로파일 실패 ${e.message}`)).finally(() => {
      try { session.disconnect(); } catch {}
      profiling = false;
    });
    return true;
  }

  sample();
  const timer = setIntervalFn(sample, SAMPLE_INTERVAL_MS);
  if (timer && timer.unref) timer.unref();
  if (process.platform !== "win32") process.on("SIGUSR2", () => profile("request"));
  return { sample, profile };
}
