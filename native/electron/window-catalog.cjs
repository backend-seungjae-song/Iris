// macOS 창 목록과 창 올리기 실행을 직렬 경계로 감싼다.
//
// 소유 범위
//   osascript 자식 프로세스 하나, argv 직렬화, 응답 정규화와 permission·timeout·parse·exec 판정.
//
// 제공 API
//   createWindowCatalog(deps)가 enumerate()·step(input)·cancel()을 제공한다.
//
// 의존 대상
//   execFile·readCoreSource·log를 주입받고 switcher-jxa.cjs의 buildScript를 쓴다. Electron·fs는 직접
//   require하지 않는다.
//
// 유지 조건
//   사용자 제목과 대상은 argv JSON으로만 넘기고, 동시에 osascript를 둘 띄우지 않는다. 취소와 timeout 뒤에는
//   실행 슬롯을 반드시 비우며, 올리기 직전 사라진 창은 성공 응답의 missing으로 그대로 돌려준다.
//
// 영향 범위
//   공급자는 switcher-jxa.cjs·switcher-core.cjs·child_process.execFile이고, 소비자는 switcher-host의
//   ⌥Tab 직렬화와 설정 화면의 창 목록이다.
//   현재 목록 확인: node bin/importers.mjs native/electron/window-catalog.cjs

const { buildScript } = require("./switcher-jxa.cjs");

const OSA_OPTIONS = {
  enumerate: { timeout: 8000, maxBuffer: 1 << 20 },
  // 다른 데스크톱 창은 open 으로 앱을 앞으로 가져오고 2.5초까지 기다린다. 그 위에 여유를 둔다.
  step: { timeout: 45000, maxBuffer: 1 << 20 },
};
const PS_OPTIONS = { timeout: 4000, maxBuffer: 1 << 20 };
const PERMISSION_RE = /-25211|assistive|not authorized|not permitted|accessibility|1002|않은 응용 프로그램|System Events process list unavailable/i;
const FAILURE_REASONS = new Set(["permission", "timeout", "parse", "exec", "cancelled", "busy"]);
const PID_APP_KEY_RE = /^pid:\d+$/;

function text(value, limit) {
  return Array.from(value == null ? "" : String(value)).slice(0, limit).join("");
}

function displayText(value) {
  return text(text(value, 400).replace(/[\u0000-\u001f\u007f]/g, ""), 200);
}

function normalizeBounds(bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 4) return [0, 0, 0, 0];
  const out = bounds.map(Number);
  return out.every(Number.isFinite) ? out.map(Math.round) : [0, 0, 0, 0];
}

function fallbackId(pid, matchTitle, bounds) {
  const source = [pid, matchTitle, ...bounds].join("\u001f");
  let hash = 2166136261;
  for (let i = 0; i < source.length; i += 1) {
    hash = Math.imul(hash ^ source.charCodeAt(i), 16777619) >>> 0;
  }
  return -(hash % 2000000000 + 1);
}

function normalizeWindow(window) {
  const appKey = text(window && window.appKey, 400);
  const matchApp = text(window && window.matchApp, 400);
  const matchTitle = text(window && window.matchTitle, 400);
  const rawCgId = Number(window && window.cgId);
  const cgId = window && window.cgId != null && Number.isInteger(rawCgId) ? rawCgId : null;
  const rawPid = Number(window && window.pid);
  const pid = Number.isInteger(rawPid) ? rawPid : 0;
  const bounds = normalizeBounds(window && window.bounds);
  const id = cgId != null ? cgId : Number.isInteger(window && window.id) ? window.id : fallbackId(pid, matchTitle, bounds);
  return {
    ...(window && typeof window === "object" ? window : {}),
    id,
    cgId,
    pid,
    pidStart: "",
    appKey,
    matchApp,
    matchTitle,
    displayApp: displayText(matchApp),
    displayTitle: displayText(matchTitle),
    bounds,
    reachable: window && window.reachable === "cg" ? "cg" : "ax",
    onScreen: !!(window && window.onScreen),
    idConfidence: cgId != null && window && window.idConfidence === "exact" ? "exact" : "none",
  };
}

function failure(reason, detail) {
  return { ok: false, reason, detail: text(detail, 400) };
}

function createWindowCatalog({ execFile, readCoreSource, log }) {
  if (typeof execFile !== "function") throw new TypeError("execFile 주입이 필요하다");
  if (typeof readCoreSource !== "function") throw new TypeError("readCoreSource 주입이 필요하다");

  let active = null;

  function note(result) {
    if (!log || result.ok) return;
    try {
      if (typeof log === "function") log("window-catalog", result);
      else if (typeof log.warn === "function") log.warn("window-catalog", result);
    } catch {}
  }

  function finish(state, resolve, result) {
    if (state.settled) return;
    state.settled = true;
    if (active === state) active = null;
    note(result);
    resolve(result);
  }

  function interpret(mode, err, stdout, stderr) {
    const errorDetail = String(stderr || (err && err.message) || err || "").trim();
    if (err && (err.killed || err.signal)) return failure("timeout", errorDetail || "osascript 응답 시간이 초과됐다");
    if (PERMISSION_RE.test(errorDetail)) return failure("permission", errorDetail);
    if (err) return failure("exec", errorDetail || "osascript 실행에 실패했다");

    let parsed;
    try { parsed = JSON.parse(String(stdout || "").trim()); }
    catch (parseError) { return failure("parse", parseError.message); }
    if (!parsed || typeof parsed !== "object") return failure("parse", "JSON 객체 응답이 아니다");
    if (parsed.ok === false) {
      const reason = FAILURE_REASONS.has(parsed.reason) ? parsed.reason : "exec";
      return failure(reason, parsed.detail || "스크립트 실행에 실패했다");
    }
    if (parsed.ok !== true) return failure("parse", "ok 필드가 없는 응답이다");

    if (mode === "enumerate") {
      if (!Array.isArray(parsed.windows) || !("front" in parsed)) {
        return failure("parse", "enumerate 응답 필드가 모자란다");
      }
      return { ok: true, windows: parsed.windows.map(normalizeWindow), front: parsed.front };
    }
    if (!("raised" in parsed) || !("resolved" in parsed) || !Array.isArray(parsed.missing) || !("front" in parsed)) {
      return failure("parse", "step 응답 필드가 모자란다");
    }
    const result = {
      ok: true,
      raised: parsed.raised,
      resolved: parsed.resolved,
      missing: parsed.missing,
      front: parsed.front,
    };
    // 이 앱의 자기 창은 앱이 직접 올린다. 스크립트는 그 id 만 알려 준다.
    if ("own" in parsed && parsed.own != null) result.own = parsed.own;
    return result;
  }

  function execute(mode, payload) {
    if (active) return Promise.resolve(failure("busy", "다른 창 조회가 실행 중이다"));

    const state = { child: null, settled: false, cancelled: false, generation: 0 };
    active = state;
    return new Promise((resolve) => {
      state.finishCancelled = () => finish(state, resolve, failure("cancelled", "실행을 취소했다"));
      Promise.resolve()
        .then(() => readCoreSource())
        .then((coreSource) => {
          if (state.cancelled) return state.finishCancelled();
          const script = buildScript(coreSource, mode);

          function startChild(file, args, options, callback, thrown) {
            if (state.cancelled) return state.finishCancelled();
            const generation = ++state.generation;
            let childProcess = null;
            try {
              childProcess = execFile(file, args, options, (...values) => {
                if (state.cancelled) return state.finishCancelled();
                callback(...values);
              });
            } catch (error) {
              thrown(error);
              return;
            }
            if (!state.settled && state.generation === generation) state.child = childProcess;
            if (state.cancelled) {
              try { childProcess && childProcess.kill(); } catch {}
              state.finishCancelled();
            }
          }

          function runScript(nextPayload, callback) {
            const args = ["-l", "JavaScript", "-e", script, JSON.stringify(nextPayload)];
            startChild("osascript", args, OSA_OPTIONS[mode], (err, stdout, stderr) => {
              callback(interpret(mode, err, stdout, stderr));
            }, (error) => callback(failure("exec", error && error.message || error)));
          }

          runScript(payload, (result) => finish(state, resolve, result));
        }, (error) => finish(state, resolve, failure("exec", error && error.message || error)));
    });
  }

  function addPidStarts(windows) {
    const pids = [];
    const seen = new Set();
    for (const window of windows) {
      if (window.pid > 0 && !seen.has(window.pid)) {
        seen.add(window.pid);
        pids.push(window.pid);
      }
    }
    if (pids.length === 0) return Promise.resolve(windows);

    return new Promise((resolve) => {
      const complete = (starts) => resolve(windows.map((window) => ({
        ...window,
        pidStart: starts.get(window.pid) || "",
      })));
      try {
        execFile("ps", ["-o", "pid=,lstart=", "-p", pids.join(",")], PS_OPTIONS, (err, stdout) => {
          const starts = new Map();
          if (!err) {
            for (const line of String(stdout || "").split(/\r?\n/)) {
              const match = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
              if (match) starts.set(Number(match[1]), text(match[2], 200));
            }
          }
          complete(starts);
        });
      } catch {
        complete(new Map());
      }
    });
  }

  async function enumerate() {
    const result = await execute("enumerate", {});
    if (!result.ok) return result;
    return { ok: true, windows: await addPidStarts(result.windows), front: result.front };
  }

  // ownPid 를 반드시 같이 넘긴다.
  //
  // 스크립트는 이 앱의 자기 창을 올리지 않고 id 만 알려 주며, 올리는 일은 앱이 한다
  // (raiseOwnWindow). 그 분기는 input.ownPid 로만 켜진다. 여기서 그 값을 빠뜨리면 스크립트는
  // 자기 창도 다른 앱 창처럼 osascript 로 올리려 하고, 그 경로로는 자기 창을 올리지 못한다.
  // AX 는 현재 데스크톱만 보고, 자기 프로세스를 frontmost 로 세우는 것도 자기 자신에게는
  // 동작하지 않는다. 스크립트는 성공을 돌려주지만 화면은 바뀌지 않는다.
  // 확인 결과(window-switcher-diag.json): 선택한 창이 모두 Iris 창인데도 기록이 전부
  // how="osascript" 였고 "own-window" 는 한 번도 없었다. 전체화면(자기 스페이스)에서 특히
  // 드러났고, 설정 화면을 열어 앱이 앞에 서 있으면 우연히 동작하기도 했다.
  // 호스트는 이미 ownPid 를 넘기고 있었고(switcher-host executeStep), 여기서만 누락됐다.
  function step({ ordered, cursor, dir, targets, ownPid } = {}) {
    return execute("step", { ordered, cursor, dir, targets, ownPid });
  }

  function cancel() {
    const state = active;
    if (!state || state.settled) return;
    state.cancelled = true;
    try { if (state.child && typeof state.child.kill === "function") state.child.kill(); } catch {}
    if (state.finishCancelled) state.finishCancelled();
  }

  return { enumerate, step, cancel };
}

module.exports = { createWindowCatalog };
