// 프로세스별 메모리와 그 프로세스가 그리는 webContents 의 주기 기록.
//
// 소유 범위
//   기록 timer, 기록 파일 경로, 파일 크기 상한에 따른 교체, 요청 pid 렌더러의 힙 스냅샷,
//   앱 창 렌더러의 할당 프로파일(요청 또는 메모리 상한 초과 시).
//
// 제공 API
//   createProcessMemoryLog(...)의 start·sample·watchWindows·snapshotRequested. timer 는 제공하지 않음.
//
// 의존 대상
//   조립부가 넘기는 app(getAppMetrics·once), webContents·창 목록 함수, screen, 기록 폴더, 파일 쓰기 함수,
//   footprint 읽기 함수(기본은 macOS footprint 명령).
//
// 유지 조건
//   렌더러 pid 와 탭 연결 수단이 이 기록뿐. 탭 연결은 webContents id(서버의 browser-tab-wc)와 URL 로 확인.
//   URL 은 query·hash 제외, 하위 frame 과 service worker 는 origin 만. 로그인 토큰이 query 로 오는 사이트 대비.
//   footprint 는 getAppMetrics workingSet 이 못 보는 GPU 의 IOSurface·스왑 확인용.
//   하위 frame·service worker 는 탭에 속하지 않는 렌더러(30초마다 교체되던 것)의 정체 확인용.
//   요청·1분 감시의 할당 프로파일은 앱 창(type window)만. 웹 페이지에 debugger 를 붙이면 사이트가 자동화로
//   판정할 수 있음. 예외는 footprint 1.5GB 넘은 webview 의 자동 프로파일(6시간에 1회). Runtime 은 켜지 않고
//   HeapProfiler 만 사용. 큰 webview 는 workingSet 이 작고(대부분 압축·스왑) footprint 만 커서 5분 기록의
//   footprint 로 판정. 탐색 때 CDP 정책이 debugger 를 떼면 그 회차는 버리고 10분 뒤 재시도.
//   프로파일 결과(saved·failed)는 process-memory.jsonl 에 event 행으로 기록.
//   기록 실패는 앱 동작에 영향 없음. 예외는 삼킴.
//   힙 스냅샷·프로파일 요청은 heap-request.json 의 pids. 요청 파일은 한 번 쓰고 삭제.
//
// 영향 범위
//   공급자는 main.cjs 의 Electron app·webContents·BrowserWindow·screen·stateHome() 폴더.
//   소비자는 메모리 진단 작업의 분석 스크립트.

const path = require("node:path");
const { pinWhileAttached } = require("./debugger-pin.cjs");

const SAMPLE_INTERVAL_MS = 5 * 60000;
const WATCH_INTERVAL_MS = 60000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
// 콘솔 창 평소 170~340MB, 급증 때 1GB 관측
const WINDOW_PROFILE_KB = 700 * 1024;
// YouTube 탭 590MB → 2GB(17시간), 한때 5.5GB 관측
const WEBVIEW_PROFILE_MB = 1500;
const PROFILE_MS = 120000;
const AUTO_PROFILE_GAP_MS = 6 * 3600000;
const PROFILE_RETRY_MS = 10 * 60000;
const KEEP_FILES = 8;
const FOOTPRINT_CATEGORIES = {
  "App-Specific Tag 16": "v8",
  "App-Specific Tag 14": "partitionAlloc",
  IOSurface: "ioSurface",
  "Owned physical footprint (unmapped) (graphics)": "graphics",
  "IOAccelerator (graphics)": "accelerator",
};

const mb = (n) => Math.round(n / 104857.6) / 10;

function pageUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === "file:" || u.protocol === "http:" || u.protocol === "https:"
      ? `${u.protocol}//${u.host}${u.pathname}` : u.protocol;
  } catch { return ""; }
}

function originOf(raw) {
  try {
    const u = new URL(raw);
    return u.host ? `${u.protocol}//${u.host}` : u.protocol;
  } catch { return ""; }
}

function footprintRows(report) {
  const rows = {};
  for (const p of report?.processes || []) {
    const row = { footprint: mb(p.footprint || 0) };
    for (const [name, key] of Object.entries(FOOTPRINT_CATEGORIES)) {
      const c = p.categories?.[name];
      if (c) row[key] = { dirty: mb(c.dirty || 0), swapped: mb(c.swapped || 0) };
    }
    rows[p.pid] = row;
  }
  return rows;
}

function createProcessMemoryLog({
  app,
  allWebContents,
  allWindows = () => [],
  screen = null,
  dir,
  fs = require("node:fs"),
  readFootprint = null,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  setTimeoutFn = setTimeout,
  now = () => new Date(),
}) {
  const file = path.join(dir, "process-memory.jsonl");
  let timer = null;
  let watchTimer = null;
  let profiling = false;
  let lastAutoProfile = -Infinity;
  let lastWebviewProfile = -Infinity;

  function defaultFootprint(pids, done) {
    if (process.platform !== "darwin" || !pids.length) { done(null); return; }
    const out = path.join(dir, "footprint.tmp.json");
    require("node:child_process").execFile("/usr/bin/footprint",
      [...pids.flatMap((pid) => ["-p", String(pid)]), "-f", "bytes", "-j", out], { timeout: 60000 }, () => {
        let report = null;
        try { report = JSON.parse(fs.readFileSync(out, "utf8")); } catch {}
        try { fs.unlinkSync(out); } catch {}
        done(report);
      });
  }

  function frameRows(wc) {
    const main = wc.mainFrame;
    const rows = new Map();
    for (const frame of main?.framesInSubtree || []) {
      try {
        if (frame === main || frame.osProcessId === main.osProcessId) continue;
        const origin = originOf(frame.url) || frame.origin || "";
        const key = `${frame.osProcessId} ${origin}`;
        const row = rows.get(key) || { pid: frame.osProcessId, processId: frame.processId, origin, count: 0 };
        row.count++;
        rows.set(key, row);
      } catch {}
    }
    return [...rows.values()];
  }

  function contentsRows() {
    const rows = [];
    for (const wc of allWebContents()) {
      try {
        if (wc.isDestroyed()) continue;
        const host = wc.hostWebContents;
        const row = {
          wc: wc.id,
          type: wc.getType(),
          pid: wc.getOSProcessId(),
          processId: wc.getProcessId?.(),
          url: pageUrl(wc.getURL()),
          host: host && !host.isDestroyed() ? host.id : null,
        };
        const frames = frameRows(wc);
        if (frames.length) row.frames = frames;
        rows.push(row);
      } catch {}
    }
    return rows;
  }

  function serviceWorkerRows() {
    const sessions = new Set();
    for (const wc of allWebContents()) { try { if (!wc.isDestroyed() && wc.session) sessions.add(wc.session); } catch {} }
    const rows = [];
    for (const ses of sessions) {
      try {
        const partition = ses.storagePath ? path.basename(ses.storagePath) : "memory";
        for (const sw of Object.values(ses.serviceWorkers.getAllRunning())) {
          rows.push({ partition, scope: originOf(sw.scope), processId: sw.renderProcessId });
        }
      } catch {}
    }
    return rows;
  }

  function windowRows() {
    const rows = [];
    for (const w of allWindows()) {
      try {
        if (w.isDestroyed()) continue;
        const b = w.getBounds();
        rows.push({
          id: w.id, wc: w.webContents?.id, x: b.x, y: b.y, width: b.width, height: b.height,
          scale: screen ? screen.getDisplayMatching(b).scaleFactor : null,
          visible: w.isVisible(), minimized: w.isMinimized(), focused: w.isFocused(),
        });
      } catch {}
    }
    return rows;
  }

  function metrics() {
    return app.getAppMetrics().map((m) => ({
      pid: m.pid,
      type: m.type,
      service: m.serviceName || m.name || "",
      created: m.creationTime ? Math.round(m.creationTime) : null,
      workingSetKB: m.memory ? m.memory.workingSetSize : null,
      cpu: m.cpu ? Math.round(m.cpu.percentCPUUsage * 10) / 10 : null,
    }));
  }

  function rotateIfLarge() {
    try {
      if (fs.statSync(file).size < MAX_FILE_BYTES) return;
      fs.renameSync(file, `${file}.1`);
    } catch {}
  }

  function write(row) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      rotateIfLarge();
      fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
    } catch {}
  }

  function sample() {
    let row;
    try {
      row = { at: now().toISOString(), processes: metrics(), contents: contentsRows(),
        serviceWorkers: serviceWorkerRows(), windows: windowRows() };
    } catch { return; }
    try {
      (readFootprint || defaultFootprint)(row.processes.map((p) => p.pid), (report) => {
        const fp = footprintRows(report);
        if (Object.keys(fp).length) row.footprint = fp;
        write(row);
        watchWebviews(fp, row.contents);
      });
    } catch { write(row); }
  }

  function prune(pattern) {
    try {
      const files = fs.readdirSync(dir).filter((f) => pattern.test(f))
        .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
      for (const { f } of files.slice(KEEP_FILES)) fs.unlinkSync(path.join(dir, f));
    } catch {}
  }

  // 회수된 객체까지 포함해 쓰고 버리는 할당이 많은 함수, 같은 구간의 CPU 사용 함수를 찾는 용도
  function profileWindow(wc, reason, { type = "window", onFail = () => {} } = {}) {
    if (profiling) return null;
    let dbg;
    try {
      if (wc.isDestroyed() || wc.getType() !== type) return null;
      dbg = wc.debugger;
      if (dbg.isAttached()) return null;
      dbg.attach("1.3");
      pinWhileAttached(dbg);
    } catch { return null; }
    profiling = true;
    const pid = wc.getOSProcessId();
    const out = path.join(dir, `renderer-${pid}-wc${wc.id}-${now().getTime()}-${reason}.heapprofile`);
    const result = (value) => write({ at: now().toISOString(), event: "profile", wc: wc.id, pid, type, reason, result: value });
    const finish = () => { try { if (dbg.isAttached()) dbg.detach(); } catch {} profiling = false; };
    (async () => {
      await dbg.sendCommand("HeapProfiler.enable");
      await dbg.sendCommand("HeapProfiler.startSampling", { samplingInterval: 32768,
        includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
      await dbg.sendCommand("Profiler.enable");
      await dbg.sendCommand("Profiler.start");
      await new Promise((resolve) => setTimeoutFn(resolve, PROFILE_MS));
      const { profile } = await dbg.sendCommand("HeapProfiler.stopSampling");
      const { profile: cpu } = await dbg.sendCommand("Profiler.stop");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(out, JSON.stringify(profile));
      fs.writeFileSync(out.replace(/\.heapprofile$/, ".cpuprofile"), JSON.stringify(cpu));
      prune(/^renderer-.*\.heapprofile$/);
      prune(/^renderer-.*\.cpuprofile$/);
      result("saved");
    })().catch((e) => { result(`failed: ${String(e && e.message || e).slice(0, 120)}`); onFail(); }).finally(finish);
    return out;
  }

  function watchWebviews(fp, contents) {
    try {
      if (now().getTime() - lastWebviewProfile < AUTO_PROFILE_GAP_MS) return null;
      const big = (contents || [])
        .filter((c) => c.type === "webview" && fp[c.pid]?.footprint > WEBVIEW_PROFILE_MB)
        .sort((a, b) => fp[b.pid].footprint - fp[a.pid].footprint);
      for (const c of big) {
        const wc = allWebContents().find((w) => !w.isDestroyed() && w.id === c.wc);
        if (!wc) continue;
        const out = profileWindow(wc, "auto-webview", { type: "webview",
          onFail: () => { lastWebviewProfile = now().getTime() - AUTO_PROFILE_GAP_MS + PROFILE_RETRY_MS; } });
        if (out) lastWebviewProfile = now().getTime();
        return out;
      }
    } catch {}
    return null;
  }

  function watchWindows() {
    try {
      if (now().getTime() - lastAutoProfile < AUTO_PROFILE_GAP_MS) return null;
      const ws = new Map(app.getAppMetrics().map((m) => [m.pid, m.memory ? m.memory.workingSetSize : 0]));
      for (const wc of allWebContents()) {
        if (wc.isDestroyed() || wc.getType() !== "window" || !(ws.get(wc.getOSProcessId()) > WINDOW_PROFILE_KB)) continue;
        const out = profileWindow(wc, "auto");
        if (out) lastAutoProfile = now().getTime();
        return out;
      }
    } catch {}
    return null;
  }

  // { pids, profile } — profile 이 참이면 그 pid 의 앱 창에 할당 프로파일, 아니면 힙 스냅샷
  function snapshotRequested() {
    const request = path.join(dir, "heap-request.json");
    let pids, wantProfile;
    try {
      const body = JSON.parse(fs.readFileSync(request, "utf8"));
      pids = new Set(body.pids);
      wantProfile = body.profile === true;
      fs.unlinkSync(request);
    } catch { return []; }
    const files = [];
    for (const wc of allWebContents()) {
      try {
        if (wc.isDestroyed() || !pids.has(wc.getOSProcessId())) continue;
        pids.delete(wc.getOSProcessId());
        if (wantProfile) {
          const out = profileWindow(wc, "request");
          if (out) files.push(out);
          continue;
        }
        const out = path.join(dir, `renderer-${wc.getOSProcessId()}-wc${wc.id}-${Date.now()}.heapsnapshot`);
        wc.takeHeapSnapshot(out).then(() => prune(/^renderer-.*\.heapsnapshot$/)).catch(() => {});
        files.push(out);
      } catch {}
    }
    return files;
  }

  function start() {
    if (timer) return;
    sample();
    timer = setIntervalFn(sample, SAMPLE_INTERVAL_MS);
    if (timer.unref) timer.unref();
    watchTimer = setIntervalFn(watchWindows, WATCH_INTERVAL_MS);
    if (watchTimer.unref) watchTimer.unref();
    app.once("before-quit", () => {
      if (timer) clearIntervalFn(timer);
      if (watchTimer) clearIntervalFn(watchTimer);
      timer = null;
      watchTimer = null;
    });
  }

  return { start, sample, watchWindows, snapshotRequested };
}

module.exports = { createProcessMemoryLog, SAMPLE_INTERVAL_MS, WINDOW_PROFILE_KB, WEBVIEW_PROFILE_MB, PROFILE_MS };
