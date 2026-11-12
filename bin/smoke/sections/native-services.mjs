// 소유 범위: download-state·audio-diagnostics·cert-trust·chrome-import·credential-service·ui-state·native-ax.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사·파일 도구, sources 의 공유 소스, Node 파일·경로·프로세스 API.
// 유지 조건: 검사 이름과 본문. 이 파일들은 50-two-flows.mjs 를 기능별로 분리한 것이고,
//   분리하면서 검사 본문을 바꾸지 않았고, 인구조사 해시가 이를 강제한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부르며 sources 의 공유 상수 계약도 함께 본다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs bin/smoke/sections/native-services.mjs
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { homedir, tmpdir } from "node:os";

import { check, checkAsync, read, readAll, require_, ROOT, sourceFiles } from "../core.mjs";
import {
  browserRuntime, browserWindowManagerSource, cdpTransportSource, main, mainWindowSource,
  memoWindowManagerSource, nativeAx, pick, record, web, webview,
} from "../sources.mjs";
import { sliceBetween } from "../../slice-anchor.mjs";

const pathJoinTmp = () => path.join(tmpdir(), "iris-server-host-probe");

export default async function run() {
  console.log("[네이티브 곁일 — 다운로드·오디오·인증서·자격증명·UI 상태]");
  {
    check("다운로드 계획의 상태 전이", () => {
      const ds = require_("../native/electron/download-state.cjs");
      ds.disarm();
      if (ds.snapshot().dir !== null) throw new Error("disarm 뒤에도 폴더가 남는다");
      ds.arm("/tmp/a", false);
      ds.claim("/tmp/a/f.txt");
      if (ds.snapshot().dir !== "/tmp/a") throw new Error("한 번만이 아닌데 폴더가 풀렸다");
      if (ds.snapshot().pending !== "/tmp/a/f.txt") throw new Error("진행 중 경로를 안 잡는다");
      ds.complete("/tmp/a/f.txt", "interrupted");
      const done = ds.snapshot();
      // 실패도 완료로 처리한다. 비우지 않으면 다음 다운로드가 이전 경로를 그대로 쓴다.
      if (done.pending !== null) throw new Error("완료(실패)인데 진행 중 경로가 남는다");
      if (!done.last || done.last.state !== "interrupted") throw new Error("마지막 결과에 실패가 안 남는다");
      ds.arm("/tmp/b", true);
      ds.claim("/tmp/b/g.txt");
      if (ds.snapshot().dir !== null || ds.snapshot().once !== false) throw new Error("한 번만인데 안 풀렸다");
      ds.disarm();
      return true;
    });

    check("AudioService 진단의 env gate와 증가·종료 전이", () => {
      const { createAudioDiagnostics } = require_("../native/electron/audio-diagnostics.cjs");
      const offEvents = {}, offIntervals = [];
      const off = createAudioDiagnostics({
        app: {
          getAppMetrics: () => [],
          on: (name, fn) => { offEvents[name] = fn; },
          once: (name, fn) => { offEvents[name] = fn; },
        },
        env: {},
        log: () => { throw new Error("꺼진 진단이 로그를 남긴다"); },
        setIntervalFn: (fn) => { offIntervals.push(fn); return { unref() {} }; },
      });
      off.start();
      if (offIntervals.length || Object.keys(offEvents).length) throw new Error("env로 껐는데 timer나 listener를 만든다");

      const events = {}, intervals = [], logs = [];
      let metrics = [{ pid: 7, creationTime: 11, type: "Utility", serviceName: "Audio Service", memory: { workingSetSize: 10 } }];
      const diag = createAudioDiagnostics({
        app: {
          getAppMetrics: () => metrics,
          on: (name, fn) => { events[name] = fn; },
          once: (name, fn) => { events[name] = fn; },
        },
        env: { IRIS_AUDIO_DIAG: "1" },
        log: (...args) => logs.push(args.join(" ")),
        setIntervalFn: (fn) => { intervals.push(fn); return { unref() {} }; },
      });
      diag.start();
      if (intervals.length !== 1) throw new Error(`켜진 진단 timer가 ${intervals.length}개`);
      const memoryLogs = () => logs.filter((line) => line.includes('"event":"audio-service-memory"')).length;
      if (memoryLogs() !== 1) throw new Error("첫 AudioService 기준 표본을 안 남긴다");
      metrics = [{ pid: 7, creationTime: 11, type: "Utility", serviceName: "Audio Service", memory: { workingSetSize: 8 } }];
      diag.sample();
      if (memoryLogs() !== 1) throw new Error("감소 표본까지 남긴다");
      metrics = [{ pid: 7, creationTime: 11, type: "Utility", serviceName: "Audio Service", memory: { workingSetSize: 12 } }];
      diag.sample();
      if (memoryLogs() !== 2) throw new Error("증가 표본을 남기지 않는다");
      events["child-process-gone"](null, { type: "Utility", serviceName: "Network Service", reason: "clean-exit" });
      if (logs.some((line) => line.includes("Network Service") && line.includes("audio-service-gone"))) throw new Error("AudioService 아닌 종료를 남긴다");
      events["child-process-gone"](null, { type: "Utility", serviceName: "Audio Service", reason: "crashed" });
      if (!logs.some((line) => line.includes('"event":"audio-service-gone"'))) throw new Error("AudioService 종료를 남기지 않는다");
      return true;
    });

    check("프로세스 메모리 기록은 렌더러 pid 와 webContents 를 함께 남기고 query 를 뺀다", () => {
      const { createProcessMemoryLog } = require_("../native/electron/process-memory-log.cjs");
      const files = {};
      const fakeFs = {
        mkdirSync() {},
        statSync: (f) => { if (!(f in files)) throw new Error("ENOENT"); return { size: files[f].length }; },
        renameSync: (a, b) => { files[b] = files[a]; delete files[a]; },
        appendFileSync: (f, s) => { files[f] = (files[f] || "") + s; },
      };
      const wc = (id, pid, url, host = null) => ({ id, isDestroyed: () => false, getType: () => (host ? "webview" : "window"),
        getOSProcessId: () => pid, getURL: () => url, hostWebContents: host });
      const shell = wc(1, 101, "http://127.0.0.1:4271/?space=a");
      const log = createProcessMemoryLog({
        app: { getAppMetrics: () => [{ pid: 101, type: "Tab", memory: { workingSetSize: 2048 } }], once() {} },
        allWebContents: () => [shell, wc(2, 202, "https://example.com/path?token=secret#x", shell)],
        dir: "/d", fs: fakeFs, setIntervalFn: () => ({ unref() {} }), readFootprint: (_pids, done) => done(null),
      });
      log.start();
      const row = JSON.parse(files["/d/process-memory.jsonl"].trim());
      const page = row.contents.find((c) => c.wc === 2);
      if (!page || page.pid !== 202 || page.host !== 1 || page.type !== "webview") throw new Error("webview 의 pid·host 를 안 남긴다");
      if (page.url !== "https://example.com/path") throw new Error(`query·hash 가 남는다: ${page.url}`);
      if (row.processes[0].workingSetKB !== 2048) throw new Error("프로세스 메모리를 안 남긴다");
      files["/d/process-memory.jsonl"] = "x".repeat(5 * 1024 * 1024);
      log.sample();
      if (!files["/d/process-memory.jsonl.1"] || files["/d/process-memory.jsonl"].length > 100000) throw new Error("상한을 넘은 파일을 교체하지 않는다");
      const broken = createProcessMemoryLog({ app: { getAppMetrics: () => { throw new Error("x"); }, once() {} },
        allWebContents: () => [], dir: "/d", fs: fakeFs, setIntervalFn: () => ({ unref() {} }) });
      broken.sample();

      const shots = [];
      const shotWc = (id, pid) => ({ id, isDestroyed: () => false, getOSProcessId: () => pid,
        takeHeapSnapshot: (f) => { shots.push(f); return Promise.resolve(); } });
      files["/d/heap-request.json"] = JSON.stringify({ pids: [303] });
      Object.assign(fakeFs, { readFileSync: (f) => { if (!(f in files)) throw new Error("ENOENT"); return files[f]; },
        unlinkSync: (f) => { delete files[f]; } });
      const snap = createProcessMemoryLog({ app: { getAppMetrics: () => [], once() {} },
        allWebContents: () => [shotWc(1, 101), shotWc(3, 303), shotWc(4, 303)], dir: "/d", fs: fakeFs });
      snap.snapshotRequested();
      if (shots.length !== 1 || !shots[0].includes("renderer-303-wc3-")) throw new Error(`요청한 pid 렌더러 하나만 저장해야 한다: ${shots}`);
      if ("/d/heap-request.json" in files) throw new Error("요청 파일을 지우지 않아 다음 신호에 다시 저장한다");
      if (snap.snapshotRequested().length) throw new Error("요청 없이 저장한다");
      return true;
    });

    await checkAsync("프로세스 메모리 기록은 탭 밖 렌더러·창·footprint 를 남기고 큰 앱 창만 6시간에 한 번 할당·CPU 프로파일한다", async () => {
      const { createProcessMemoryLog, WINDOW_PROFILE_KB } = require_("../native/electron/process-memory-log.cjs");
      const dir = mkdtempSync(path.join(tmpdir(), "iris-process-memory-"));
      try {
        for (let i = 0; i < 9; i++) writeFileSync(path.join(dir, `renderer-1-wc1-${i}-auto.heapprofile`), "{}");
        const commands = [];
        let attached = false;
        const debuggerOf = (busy = false) => ({
          isAttached: () => busy || attached,
          attach: () => { attached = true; },
          detach: () => { attached = false; },
          sendCommand: async (method) => { commands.push(method);
            return method === "HeapProfiler.stopSampling" ? { profile: { head: {} } } : method === "Profiler.stop" ? { profile: { nodes: [] } } : {}; },
        });
        const main = { osProcessId: 101 };
        main.framesInSubtree = [main, { osProcessId: 101, processId: 3, url: "https://same.example/" },
          { osProcessId: 505, processId: 7, url: "https://ads.example/a?id=secret" }, { osProcessId: 505, processId: 7, url: "https://ads.example/b" }];
        const ses = { storagePath: "/x/Partitions/persist:acprof:Play",
          serviceWorkers: { getAllRunning: () => ({ 1: { scope: "chrome-extension://abc/path", renderProcessId: 9 } }) } };
        const wc = (id, pid, type, extra = {}) => ({ id, isDestroyed: () => false, getType: () => type, getOSProcessId: () => pid,
          getProcessId: () => pid + 1000, getURL: () => "http://127.0.0.1:4271/", hostWebContents: null, session: ses,
          debugger: debuggerOf(), ...extra });
        const shell = wc(1, 101, "window", { mainFrame: main });
        const page = wc(2, 202, "webview");
        let clock = 0;
        const ws = { 101: WINDOW_PROFILE_KB + 1, 202: WINDOW_PROFILE_KB * 2 };
        const log = createProcessMemoryLog({
          app: { getAppMetrics: () => Object.entries(ws).map(([pid, kb]) => ({ pid: Number(pid), type: "Tab", creationTime: 5.4, memory: { workingSetSize: kb } })) },
          allWebContents: () => [page, shell],
          allWindows: () => [{ id: 9, webContents: shell, isDestroyed: () => false, getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
            isVisible: () => true, isMinimized: () => false, isFocused: () => false }],
          screen: { getDisplayMatching: () => ({ scaleFactor: 2 }) },
          dir, now: () => new Date(clock), setTimeoutFn: (fn) => setImmediate(fn),
          readFootprint: (pids, done) => done({ processes: [{ pid: 101, footprint: 300 * 1048576,
            categories: { IOSurface: { dirty: 100 * 1048576, swapped: 0 }, Stack: { dirty: 1048576 } } }] }),
        });
        log.sample();
        const row = JSON.parse(readFileSync(path.join(dir, "process-memory.jsonl"), "utf8").trim());
        const frames = row.contents.find((c) => c.wc === 1).frames;
        if (JSON.stringify(frames) !== JSON.stringify([{ pid: 505, processId: 7, origin: "https://ads.example", count: 2 }])) throw new Error(`다른 프로세스 frame 을 origin 만으로 안 남긴다: ${JSON.stringify(frames)}`);
        if (JSON.stringify(row.serviceWorkers) !== JSON.stringify([{ partition: "persist:acprof:Play", scope: "chrome-extension://abc", processId: 9 }])) throw new Error(`service worker 를 안 남긴다: ${JSON.stringify(row.serviceWorkers)}`);
        if (row.windows[0]?.scale !== 2 || row.windows[0].wc !== 1 || row.windows[0].width !== 800) throw new Error("창 배치·배율을 안 남긴다");
        const fp = row.footprint?.[101];
        if (fp?.footprint !== 300 || fp.ioSurface?.dirty !== 100 || "Stack" in fp) throw new Error(`footprint 를 안 남긴다: ${JSON.stringify(fp)}`);
        if (row.processes[0].created !== 5) throw new Error("프로세스 생성 시각을 안 남긴다");

        const out = log.watchWindows();
        if (!out || !out.includes("renderer-101-wc1-")) throw new Error(`상한을 넘은 앱 창을 프로파일하지 않는다: ${out}`);
        for (let i = 0; i < 100 && !existsSync(out); i++) await new Promise((resolve) => setTimeout(resolve, 10));
        if (!existsSync(out) || attached) throw new Error("프로파일 파일을 안 쓰거나 debugger 를 안 뗀다");
        if (!commands.includes("HeapProfiler.startSampling")) throw new Error("할당 프로파일을 시작하지 않는다");
        const cpuOut = out.replace(/\.heapprofile$/, ".cpuprofile");
        for (let i = 0; i < 100 && !existsSync(cpuOut); i++) await new Promise((resolve) => setTimeout(resolve, 10));
        if (!commands.includes("Profiler.start") || !existsSync(cpuOut)) throw new Error("같은 구간의 CPU 프로파일을 안 남긴다");
        const kept = readdirSync(dir).filter((f) => f.endsWith(".heapprofile"));
        if (kept.length !== 8 || kept.includes("renderer-1-wc1-0-auto.heapprofile")) throw new Error(`최근 8개만 남겨야 한다: ${kept.length}`);
        clock += 3600000;
        if (log.watchWindows()) throw new Error("6시간 안에 다시 프로파일한다");
        clock += 6 * 3600000;
        ws[101] = 1;
        if (log.watchWindows()) throw new Error("웹 페이지(webview)를 프로파일한다");
        writeFileSync(path.join(dir, "heap-request.json"), JSON.stringify({ pids: [202], profile: true }));
        if (log.snapshotRequested().length) throw new Error("요청으로 웹 페이지를 프로파일한다");
        return true;
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    await checkAsync("프로세스 메모리 기록은 앱 창에만 문서 크기를 붙이고, 응답 없는 창이 있어도 기록한다", async () => {
      const { createProcessMemoryLog } = require_("../native/electron/process-memory-log.cjs");
      const dir = mkdtempSync(path.join(tmpdir(), "iris-window-dom-"));
      try {
        const scripts = [];
        const wc = (id, type, run) => ({ id, isDestroyed: () => false, getType: () => type, getOSProcessId: () => id * 100,
          getURL: () => "http://127.0.0.1:4271/", hostWebContents: null,
          executeJavaScript: (code) => { scripts.push({ id, code }); return run(); } });
        const shell = wc(1, "window", async () => ({ elements: 2000, iframes: [{ src: "/paseo-ui/", shown: true, elements: 900 }] }));
        const stuck = wc(3, "window", () => new Promise(() => {}));
        const page = wc(2, "webview", async () => ({ elements: 1 }));
        const log = createProcessMemoryLog({
          app: { getAppMetrics: () => [] }, allWebContents: () => [shell, page, stuck], dir,
          setTimeoutFn: (fn) => setImmediate(fn), readFootprint: (_pids, done) => done(null),
        });
        log.sample();
        const file = path.join(dir, "process-memory.jsonl");
        for (let i = 0; i < 100 && !existsSync(file); i++) await new Promise((resolve) => setTimeout(resolve, 10));
        if (!existsSync(file)) throw new Error("응답 없는 창 때문에 기록하지 않는다");
        const row = JSON.parse(readFileSync(file, "utf8").trim());
        const dom = row.contents.find((c) => c.wc === 1).dom;
        if (dom?.elements !== 2000 || dom.iframes[0].src !== "/paseo-ui/") throw new Error(`앱 창 문서 크기를 안 남긴다: ${JSON.stringify(dom)}`);
        if ("dom" in row.contents.find((c) => c.wc === 3)) throw new Error("응답 없는 창에 dom 을 붙인다");
        if (scripts.some((s) => s.id === 2) || "dom" in row.contents.find((c) => c.wc === 2)) throw new Error("웹 페이지(webview)에서 스크립트를 실행한다");
        return true;
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    await checkAsync("memory-infra 기록은 trace 요청으로만 하고, 하는 중에는 겹쳐 시작하지 않는다", async () => {
      const { createProcessMemoryLog } = require_("../native/electron/process-memory-log.cjs");
      const dir = mkdtempSync(path.join(tmpdir(), "iris-memory-trace-"));
      try {
        const calls = [];
        let finish;
        const contentTracing = {
          startRecording: async (config) => { calls.push(["start", config]); },
          stopRecording: async (out) => { calls.push(["stop", out]); writeFileSync(out, "{}"); return out; },
        };
        const log = createProcessMemoryLog({ app: { getAppMetrics: () => [] }, allWebContents: () => [], dir, contentTracing,
          setTimeoutFn: (fn) => { finish = fn; } });
        const request = path.join(dir, "heap-request.json");
        writeFileSync(request, JSON.stringify({ pids: [], profile: true }));
        if (log.snapshotRequested().length || calls.length) throw new Error("trace 없는 요청으로 기록한다");
        writeFileSync(request, JSON.stringify({ trace: true }));
        const [out] = log.snapshotRequested();
        if (!out || !path.basename(out).startsWith("memory-infra-") || existsSync(request)) throw new Error(`trace 요청을 처리하지 않는다: ${out}`);
        for (let i = 0; i < 100 && !finish; i++) await new Promise((resolve) => setTimeout(resolve, 10));
        const config = calls[0]?.[1];
        if (!config?.included_categories?.includes("disabled-by-default-memory-infra") || config.memory_dump_config?.triggers?.[0]?.mode !== "detailed")
          throw new Error(`memory-infra 상세 덤프로 시작하지 않는다: ${JSON.stringify(config)}`);
        writeFileSync(request, JSON.stringify({ trace: true }));
        if (log.snapshotRequested().length) throw new Error("기록 중에 겹쳐 시작한다");
        finish();
        const logFile = path.join(dir, "process-memory.jsonl");
        for (let i = 0; i < 100 && !(existsSync(logFile) && readFileSync(logFile, "utf8").includes('"saved"')); i++) await new Promise((resolve) => setTimeout(resolve, 10));
        if (!existsSync(out) || !readFileSync(logFile, "utf8").includes('"event":"trace"')) throw new Error("기록 파일이나 결과 행을 안 남긴다");
        return true;
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    await checkAsync("footprint 가 1.5GB 넘은 webview 만 5분 기록에서 프로파일하고, 끊기면 10분 뒤 다시 한다", async () => {
      const { createProcessMemoryLog, WEBVIEW_PROFILE_MB } = require_("../native/electron/process-memory-log.cjs");
      const dir = mkdtempSync(path.join(tmpdir(), "iris-webview-profile-"));
      try {
        let attached = false, failStop = true, starts = 0;
        const dbg = { isAttached: () => attached, attach: () => { attached = true; }, detach: () => { attached = false; },
          sendCommand: async (method) => {
            if (method === "HeapProfiler.startSampling") starts++;
            if (method === "HeapProfiler.stopSampling") {
              if (failStop) throw new Error("Debugger is not attached");
              return { profile: { head: {} } };
            }
            return method === "Profiler.stop" ? { profile: { nodes: [] } } : {};
          } };
        const wc = (id, pid, type) => ({ id, isDestroyed: () => false, getType: () => type, getOSProcessId: () => pid,
          getURL: () => "https://www.youtube.com/feed/playlists", hostWebContents: null, debugger: dbg });
        const small = wc(3, 303, "webview");
        const big = wc(2, 202, "webview");
        const fp = { 202: WEBVIEW_PROFILE_MB + 100, 303: WEBVIEW_PROFILE_MB - 100 };
        let clock = 0;
        const log = createProcessMemoryLog({
          app: { getAppMetrics: () => [{ pid: 202, type: "Tab", memory: { workingSetSize: 170 * 1024 } }] },
          allWebContents: () => [small, big], dir, now: () => new Date(clock), setTimeoutFn: (fn) => setImmediate(fn),
          readFootprint: (_pids, done) => done({ processes: Object.entries(fp).map(([pid, m]) => ({ pid: Number(pid), footprint: m * 1048576 })) }),
        });
        const events = () => readFileSync(path.join(dir, "process-memory.jsonl"), "utf8").trim().split("\n")
          .map((l) => JSON.parse(l)).filter((r) => r.event === "profile");
        const settle = async (n) => { for (let i = 0; i < 100 && events().length < n; i++) await new Promise((r) => setTimeout(r, 10)); };
        log.sample();
        await settle(1);
        if (starts !== 1) throw new Error(`큰 webview 를 프로파일하지 않는다: ${starts}`);
        const first = events()[0];
        if (first?.wc !== 2 || !String(first.result).startsWith("failed")) throw new Error(`끊긴 회차를 failed 로 안 남긴다: ${JSON.stringify(first)}`);
        if (attached) throw new Error("실패 후 debugger 를 안 뗀다");
        clock += 5 * 60000;
        log.sample();
        await new Promise((r) => setTimeout(r, 30));
        if (starts !== 1) throw new Error("10분 전에 다시 프로파일한다");
        clock += 6 * 60000;
        failStop = false;
        log.sample();
        await settle(2);
        if (events()[1]?.result !== "saved" || !readdirSync(dir).some((f) => f.includes("renderer-202-wc2-") && f.endsWith("-auto-webview.heapprofile")))
          throw new Error(`재시도에서 프로파일 파일을 안 남긴다: ${JSON.stringify(events())}`);
        clock += 3600000;
        log.sample();
        await new Promise((r) => setTimeout(r, 30));
        if (starts !== 2) throw new Error("성공 후 6시간 안에 다시 프로파일한다");
        fp[202] = WEBVIEW_PROFILE_MB - 1;
        clock += 6 * 3600000;
        log.sample();
        await new Promise((r) => setTimeout(r, 30));
        if (starts !== 2) throw new Error("1.5GB 이하 webview 를 프로파일한다");
        return true;
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    check("인증서 신뢰는 로컬 자체서명 범위와 한 번의 사람 질문에 묶인다", () => {
      const { createCertificateTrust } = require_("../native/electron/certificate-trust.cjs");
      const handlers = {}, prompts = [];
      const trust = createCertificateTrust({
        appUrl: "http://127.0.0.1:4291/",
        fetchImpl: (url) => { prompts.push(url); return new Promise(() => {}); },
      });
      trust.installCertificateTrust({ on: (name, fn) => { handlers[name] = fn; } });
      const handle = handlers["certificate-error"];
      if (typeof handle !== "function") throw new Error("certificate-error handler를 설치하지 않는다");
      const rejected = (url, error) => {
        let prevented = false, callbackCalled = false;
        const result = handle({ preventDefault: () => { prevented = true; } }, { id: 17 }, url, error,
          { fingerprint: "AA:BB" }, () => { callbackCalled = true; });
        if (prevented || callbackCalled || result !== null) throw new Error(`범위 밖 인증서를 가로챈다: ${url} ${error}`);
      };
      rejected("https://example.com/", "net::ERR_CERT_AUTHORITY_INVALID");
      rejected("http://localhost:4443/", "net::ERR_CERT_AUTHORITY_INVALID");
      rejected("https://localhost:4443/", "net::ERR_CERT_DATE_INVALID");
      if (prompts.length) throw new Error("로컬 자체서명 범위 밖에서 사람에게 묻는다");

      let prevented = 0;
      const event = { preventDefault: () => { prevented++; } };
      const first = handle(event, { id: 17 }, "https://dev.localhost:4443/", "net::ERR_CERT_AUTHORITY_INVALID",
        { fingerprint: "AA:BB" }, () => {});
      const second = handle(event, { id: 18 }, "https://dev.localhost:4443/", "net::ERR_CERT_AUTHORITY_INVALID",
        { fingerprint: "AA:BB" }, () => {});
      if (!first || first !== second) throw new Error("같은 host와 지문의 질문 Promise를 함께 쓰지 않는다");
      if (prevented !== 2) throw new Error("허용 후보 certificate-error를 기본 거절에서 인계받지 않는다");
      if (prompts.length !== 1) throw new Error(`같은 host를 ${prompts.length}번 묻는다`);
      if (!prompts[0].includes("/dialog-ask?noplan=1&")) throw new Error("prompt URL에서 noplan=1이 사라졌다");
      return true;
    });

    check("Chrome import 장부는 cid 중복·저장 복원·깨진 파일을 보존한다", () => {
      const { createChromeImportRegistry } = require_("../native/electron/chrome-import-registry.cjs");
      const dir = mkdtempSync(path.join(tmpdir(), "iris-chrome-imports-"));
      try {
        const make = () => createChromeImportRegistry({ stateDir: dir, fs: { ...require_("node:fs") }, path, now: () => 123 });
        const entry = { browser: { id: "chrome" }, profile: "Default", label: "Work", account: "", gaia: "" };
        const first = make();
        if (first.profileCid(entry) !== "chrome:Default") throw new Error("cid가 browser.id와 profile 조합이 아니다");
        first.note(entry, "persist:acprof:a");
        first.note(entry, "persist:acprof:b");
        if (first.list().length !== 2 || !first.latestForPartition("persist:acprof:a")) throw new Error("다른 partition의 연결을 덮어썼다");
        if (first.latestForPartition("persist:acprof:b")?.cid !== "chrome:Default") throw new Error("최신 partition 연결을 못 찾는다");
        const restored = make().list();
        if (restored.length !== 2 || restored.some((row) => row.cid !== "chrome:Default")) {
          throw new Error("저장했다 다시 읽은 장부가 다르다");
        }
        if (existsSync(path.join(dir, "chrome-imports.json.tmp"))) throw new Error("원자 저장 tmp가 남는다");
        writeFileSync(path.join(dir, "chrome-imports.json"), "{broken");
        if (make().list().length !== 0) throw new Error("깨진 파일을 빈 장부로 읽지 않는다");
        return true;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    check("자격증명 서비스는 비밀번호 비노출·정확 조회·읽기 실패 보존을 지킨다", () => {
      const { createCredentialService } = require_("../native/electron/credential-service.cjs");
      const fsMod = require_("node:fs");
      const safe = {
        isEncryptionAvailable: () => true,
        encryptString: (text) => Buffer.from("enc:" + text),
        decryptString: (buf) => {
          const text = buf.toString("utf8");
          if (!text.startsWith("enc:")) throw new Error("깨진 암호문");
          return text.slice(4);
        },
      };
      const dir = mkdtempSync(path.join(tmpdir(), "iris-credential-service-"));
      try {
        const service = createCredentialService({ stateDir: dir, fs: fsMod, safeStorage: safe });
        service.set("persist:acprof:a", [
          { origin: "https://a.test", url: "https://a.test/one", username: "alice", password: "old" },
          { origin: "https://a.test", url: "https://a.test/two", username: "alice", password: "new" },
          { origin: "https://b.test", url: "https://b.test/", username: "bob", password: "other" },
        ]);
        const listed = service.listForOrigin("persist:acprof:a", "https://a.test");
        if (listed.length !== 1 || listed[0].username !== "alice") throw new Error("정확한 origin 목록이 아니다");
        if (listed.some((row) => Object.prototype.hasOwnProperty.call(row, "password"))) throw new Error("목록에 password가 실린다");
        if (service.passwordFor("persist:acprof:a", "https://a.test", "alice") !== "new") throw new Error("정확한 계정의 마지막 값을 못 찾는다");
        if (service.passwordFor("persist:acprof:a", "https://b.test", "alice") !== undefined) throw new Error("다른 origin에 password를 준다");
        if (service.passwordFor("persist:acprof:a", "https://a.test", "bob") !== undefined) throw new Error("다른 계정에 password를 준다");

        const lockedDir = path.join(dir, "locked");
        fsMod.mkdirSync(lockedDir);
        const lockedFile = path.join(lockedDir, "creds.enc");
        const original = Buffer.from('enc:{"persist:old":[]}');
        fsMod.writeFileSync(lockedFile, original);
        const locked = createCredentialService({
          stateDir: lockedDir,
          fs: fsMod,
          safeStorage: { ...safe, decryptString: () => { throw new Error("Keychain 잠김"); } },
          now: () => new Date(2026, 7, 19, 17, 5, 9),
        });
        locked.set("persist:new", [{ origin: "https://new.test", username: "new", password: "secret" }]);
        const kept = lockedFile + ".unreadable-20260819-170509";
        if (!existsSync(kept) || !fsMod.readFileSync(kept).equals(original)) throw new Error("읽을 수 없는 vault 원본을 보존하지 않는다");
        return true;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    check("UI 상태는 부분 patch를 병합하고 깨진 파일을 비운다", () => {
      const store = require_("../native/electron/ui-state-store.cjs");
      const dir = mkdtempSync(path.join(tmpdir(), "iris-ui-state-"));
      try {
        writeFileSync(path.join(dir, "ui-state.json"), JSON.stringify({ kept: 1, nested: { left: true } }));
        store.writeUiState(dir, { added: 2 });
        const merged = store.readUiState(dir);
        if (merged.kept !== 1 || merged.added !== 2 || merged.nested?.left !== true) {
          throw new Error("부분 patch가 기존 값을 보존하지 않는다");
        }
        writeFileSync(path.join(dir, "ui-state.json"), "{broken");
        const broken = store.readUiState(dir);
        if (!broken || Object.keys(broken).length) throw new Error("깨진 파일을 빈 상태로 읽지 않는다");
        return true;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    check("네이티브 창 조회가 실행 파일 이름을 따라간다", () => {
      // `"Electron"`으로 고정되면 설치된 앱(프로세스 이름 `Iris`)에서 이 경로가 언제나
      // "앱 프로세스를 찾지 못했습니다"가 된다. 상수로 되돌리면 같은 실패가 재발한다.
      return /const AX_APP = path\.basename\(process\.execPath\);/.test(nativeAx)
        // 음성 조건은 native 전체를 본다. 한 파일로 좁히면 다른 모듈에 상수가 생겨도 통과한다.
        && !/const AX_APP = "(Electron|Iris)"/.test(readAll("native"));
    });
  }
  // 콘솔 창만 닫으면 브라우저 창이 남아 앱이 계속 뜬다. 창이 하나라도 있으면 만들지 않는 조건이나
  // 파괴된 창에 focus 만 거는 처리로는 ⌥1·Dock 으로 콘솔을 다시 열 수 없다.
  check("콘솔 창을 닫은 뒤 ⌥1·Dock 이 콘솔을 다시 만든다", () => {
    const main = read("native/electron/main.cjs");
    const show = sliceBetween(main, "function showConsoleWindow()", "\n}", "콘솔 다시 열기");
    return /mainWindow\.createWindow\(\)/.test(show)
      && /ipcMain\.on\("ac-refocus-console", \(\) => \{ try \{ showConsoleWindow\(\); \}/.test(main)
      && /app\.on\("activate", \(\) => \{ const win = getMainWindow\(\); if \(!win \|\| win\.isDestroyed\(\)\) mainWindow\.createWindow\(\); \}\)/.test(main);
  });
  // 렌더러가 beforeunload 를 막고 메인이 will-prevent-unload 를 처리하지 않으면 Electron 은 묻지 않고 닫기를 취소한다.
  // 그래서 신호를 보내는 창(콘솔)과 묻는 창이 같아야 한다.
  check("콘솔 창은 미저장 편집이 있으면 닫기·종료 전에 묻는다", () => {
    const mw = read("native/electron/main-window.cjs");
    const app = read("web/js/main.js");
    return /webContents\.on\("will-prevent-unload"[\s\S]{0,400}showMessageBoxSync[\s\S]{0,300}if \(r === 0\) ev\.preventDefault\(\)/.test(mw)
      && /if \(!AUX_MODE\) addEventListener\("beforeunload"[\s\S]{0,200}isTabDirty\(t\)[\s\S]{0,80}e\.preventDefault\(\)/.test(app);
  });
  // 설정 화면에서 바꾼 조합이 실제 동작과 같아야 한다. 옛 조합이 계속 동작하면 다른 앱의 같은 조합도 빼앗는다.
  check("요소 지목 전역 단축키는 키맵에서 바꾼 조합으로 다시 등록된다", () => {
    const { createPickMode } = require_(path.join(ROOT, "native/electron/pick-mode.cjs"));
    const { acceleratorFor } = require_(path.join(ROOT, "native/electron/switcher-host.cjs"));
    const log = [];
    const noop = () => {};
    const pm = createPickMode({
      app: { on: noop }, screen: {}, BrowserWindow: { getAllWindows: () => [] }, ipcMain: { on: noop, handle: noop },
      globalShortcut: { register: (a) => { log.push("+" + a); return true; }, unregister: (a) => log.push("-" + a), unregisterAll: noop },
      execFile: noop, browserWindowManager: { firstBrowserModeWindow: () => null }, getMainWindow: () => null,
      isTrustedSender: () => true, injectOverlayAllFrames: noop, hoverAtPoint: noop, diagSince: noop, runCdp: noop,
    });
    pm.registerGlobalShortcut();
    pm.registerGlobalShortcut(acceleratorFor({ mod: true, shift: true, key: "k" }));
    const main = read("native/electron/main.cjs");
    const onKeymap = sliceBetween(main, 'ipcMain.on("ac-keymap"', "\n});", "키맵 수신");
    return log.join(" ") === "+CommandOrControl+Shift+E -CommandOrControl+Shift+E +CommandOrControl+Shift+K"
      && /pickMode\.registerGlobalShortcut\(acceleratorFor\(map\["pick-toggle"\] \|\| DEFAULT_RELAY\["pick-toggle"\]\)\)/.test(onKeymap);
  });
}
