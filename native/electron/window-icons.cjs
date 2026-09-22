// 실행 중인 macOS 앱의 아이콘을 창 카탈로그와 독립된 실행 슬롯에서 읽는다.
//
// 소유 범위
//   아이콘 전용 osascript 자식 하나, timeout·maxBuffer·cancel, 앱별·응답 전체 바이트 제한.
//
// 제공 API
//   createWindowIcons(deps)가 icons({ appKeys })와 cancel()을 제공한다.
//
// 의존 대상
//   주입받은 execFile과 macOS AppKit의 NSRunningApplication·NSImage·NSBitmapImageRep에 기대며
//   Electron·창 카탈로그·파일 시스템은 직접 알지 못한다.
//
// 유지 조건
//   앱 열쇠는 스크립트 본문에 넣지 않고 argv JSON으로만 넘긴다. 창 카탈로그와 active 슬롯을
//   공유하지 않으며, 크기 제한을 넘은 아이콘과 전체 제한 이후의 아이콘만 제외하고 나머지는 그대로 반환한다.
//
// 영향 범위
//   공급자는 main.cjs의 execFile이고 소비자는 switcher-host media 캐시다.
//   현재 목록 확인: node bin/importers.mjs native/electron/window-icons.cjs

const ICON_TIMEOUT_MS = 8000;
const ICON_MAX_BUFFER = 16 << 20;
const MAX_ICON_BYTES = 64 << 10;
const MAX_RESPONSE_BYTES = 512 << 10;
const MAX_APP_KEYS = 200;
const FAILURE_REASONS = new Set(["timeout", "exec", "parse", "cancelled", "busy", "too-large", "not-found"]);

const ICON_SCRIPT = String.raw`
ObjC.import("AppKit");
ObjC.import("Foundation");

function irisIconText(value, limit) {
  var chars = Array.from(value == null ? "" : String(value));
  return chars.slice(0, limit).join("");
}

function irisIconString(value) {
  try { return irisIconText(ObjC.unwrap(value), 400); } catch (_ignored) {
    return irisIconText(value, 400);
  }
}

function irisIconBase64(value) {
  try { return String(ObjC.unwrap(value) || ""); } catch (_ignored) {
    return String(value || "");
  }
}

function irisPngBase64(icon) {
  if (!icon) return "";
  var size = $.NSMakeSize(64, 64);
  var target = $.NSImage.alloc.initWithSize(size);
  target.lockFocus;
  try {
    icon.drawInRectFromRectOperationFraction(
      $.NSMakeRect(0, 0, 64, 64), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1
    );
  } finally {
    target.unlockFocus;
  }
  var rep = $.NSBitmapImageRep.imageRepWithData(target.TIFFRepresentation);
  if (!rep) return "";
  var png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
  return png ? irisIconBase64(png.base64EncodedStringWithOptions(0)) : "";
}

function run(argv) {
  try {
    var input = JSON.parse(String(argv && argv[0] || "{}"));
    var wanted = {};
    var keys = Array.isArray(input.appKeys) ? input.appKeys : [];
    for (var w = 0; w < keys.length; w += 1) wanted[String(keys[w])] = true;
    var apps = $.NSWorkspace.sharedWorkspace.runningApplications;
    var out = [];
    for (var i = 0; i < Number(apps.count); i += 1) {
      var app = apps.objectAtIndex(i);
      if (Number(app.activationPolicy) !== 0) continue;
      var pid = Number(app.processIdentifier);
      var bundleId = irisIconString(app.bundleIdentifier);
      var appKey = bundleId || "pid:" + String(pid);
      if (!wanted[appKey]) continue;
      out.push({
        pid: pid,
        bundleId: bundleId,
        name: irisIconString(app.localizedName),
        icon: irisPngBase64(app.icon),
      });
    }
    return JSON.stringify({ ok: true, apps: out });
  } catch (error) {
    return JSON.stringify({
      ok: false,
      reason: "exec",
      detail: irisIconText(error && (error.message || error) || error, 400),
    });
  }
}
`;

function text(value, limit) {
  return Array.from(value == null ? "" : String(value)).slice(0, limit).join("");
}

function appKeysFrom(input) {
  const source = input && Array.isArray(input.appKeys) ? input.appKeys : [];
  const out = [];
  const seen = new Set();
  for (const value of source) {
    const appKey = text(value, 400);
    if (!appKey || seen.has(appKey)) continue;
    seen.add(appKey);
    out.push(appKey);
    if (out.length >= MAX_APP_KEYS) break;
  }
  return out;
}

function allMissing(appKeys, reason) {
  return { icons: {}, missing: appKeys.map((appKey) => ({ appKey, reason })) };
}

function createWindowIcons({ execFile, log }) {
  if (typeof execFile !== "function") throw new TypeError("execFile 주입이 필요하다");
  let active = null;

  function note(reason) {
    if (!log) return;
    try {
      const summary = { reason };
      if (typeof log === "function") log("window-icons", summary);
      else if (typeof log.warn === "function") log.warn("window-icons", summary);
    } catch {}
  }

  function finish(state, resolve, result) {
    if (state.settled) return;
    state.settled = true;
    if (active === state) active = null;
    if (result.missing.length && Object.keys(result.icons).length === 0) note(result.missing[0].reason);
    resolve(result);
  }

  function interpret(appKeys, err, stdout, stderr) {
    if (err && (err.killed || err.signal)) return allMissing(appKeys, "timeout");
    if (err) return allMissing(appKeys, "exec");

    let parsed;
    try { parsed = JSON.parse(String(stdout || "").trim()); }
    catch { return allMissing(appKeys, "parse"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return allMissing(appKeys, "parse");
    if (parsed.ok === false) {
      const reason = FAILURE_REASONS.has(parsed.reason) ? parsed.reason : "exec";
      return allMissing(appKeys, reason);
    }
    if (parsed.ok !== true || !Array.isArray(parsed.apps)) return allMissing(appKeys, "parse");

    const apps = new Map();
    for (const app of parsed.apps) {
      if (!app || typeof app !== "object") continue;
      const pid = Number(app.pid);
      const bundleId = text(app.bundleId, 400);
      const appKey = bundleId || (Number.isInteger(pid) && pid > 0 ? `pid:${pid}` : "");
      if (appKey && !apps.has(appKey)) apps.set(appKey, app);
    }

    const icons = {};
    const missing = [];
    const accepted = [];
    let responseBytes = 0;
    for (const appKey of appKeys) {
      const app = apps.get(appKey);
      const base64 = app && typeof app.icon === "string" ? app.icon : "";
      if (!base64) {
        missing.push({ appKey, reason: "not-found" });
        continue;
      }
      const iconBytes = Buffer.byteLength(base64, "utf8");
      if (iconBytes > MAX_ICON_BYTES || responseBytes + iconBytes > MAX_RESPONSE_BYTES) {
        missing.push({ appKey, reason: "too-large" });
        continue;
      }
      icons[appKey] = `data:image/png;base64,${base64}`;
      accepted.push(appKey);
      responseBytes += iconBytes;
    }
    while (accepted.length && Buffer.byteLength(JSON.stringify({ icons, missing }), "utf8") > MAX_RESPONSE_BYTES) {
      const appKey = accepted.pop();
      delete icons[appKey];
      missing.push({ appKey, reason: "too-large" });
    }
    const order = new Map(appKeys.map((appKey, index) => [appKey, index]));
    missing.sort((left, right) => order.get(left.appKey) - order.get(right.appKey));
    return { icons, missing };
  }

  function icons(input = {}) {
    const appKeys = appKeysFrom(input);
    if (active) return Promise.resolve(allMissing(appKeys, "busy"));
    if (!appKeys.length) return Promise.resolve({ icons: {}, missing: [] });

    const state = { child: null, settled: false, cancelled: false };
    active = state;
    return new Promise((resolve) => {
      state.finishCancelled = () => finish(state, resolve, allMissing(appKeys, "cancelled"));
      const args = ["-l", "JavaScript", "-e", ICON_SCRIPT, JSON.stringify({ appKeys })];
      try {
        state.child = execFile("osascript", args, {
          timeout: ICON_TIMEOUT_MS,
          maxBuffer: ICON_MAX_BUFFER,
        }, (err, stdout, stderr) => {
          if (state.cancelled) return state.finishCancelled();
          finish(state, resolve, interpret(appKeys, err, stdout, stderr));
        });
        if (state.cancelled) {
          try { state.child && state.child.kill(); } catch {}
          state.finishCancelled();
        }
      } catch {
        finish(state, resolve, allMissing(appKeys, "exec"));
      }
    });
  }

  function cancel() {
    const state = active;
    if (!state || state.settled) return;
    state.cancelled = true;
    try { if (state.child && typeof state.child.kill === "function") state.child.kill(); } catch {}
    state.finishCancelled();
  }

  return { icons, cancel };
}

module.exports = {
  createWindowIcons,
  ICON_SCRIPT,
  MAX_ICON_BYTES,
  MAX_RESPONSE_BYTES,
};
