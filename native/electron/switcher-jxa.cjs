// 창 전환 코어를 macOS 창 조회·올리기 실행기에 묶는다.
//
// 소유 범위
//   JXA 실행기 본문과 코어 소스·실행 모드를 한 스크립트로 조립하는 경계.
//
// 제공 API
//   RUNNER_SRC와 buildScript(coreSource, mode)를 제공한다. 완성된 본문은 run(argv) 한 개를 노출한다.
//
// 의존 대상
//   삽입된 코어의 assignOrdinals(windows)·matchWindow(saved, candidate, phase)·selectTarget(input),
//   macOS AppKit·CoreGraphics·System Events에 기대며
//   Electron·파일 시스템은 알지 못한다.
//
// 유지 조건
//   사용자 값은 스크립트 본문에 넣지 않고 argv JSON으로만 받는다. 전체 창 조인은 옵션 0으로 하고,
//   앞 창의 안정 ID와 쌓임 순서·현재 화면 여부는 on-screen 목록으로만 판정한다.
//   CG ID와 AX 식별 정보가 모두 같은 창은 열거 순서로만 갈라지므로 다음 열거에서 순서가 바뀌면 체크도 바뀔 수 있다.
//
// 영향 범위
//   공급자는 switcher-core.cjs와 macOS AX·CG 계약이고, 소비자는 window-catalog.cjs의 두 실행 모드다.
//   현재 목록 확인: node bin/importers.mjs native/electron/switcher-jxa.cjs

const RUNNER_SRC = String.raw`
ObjC.import("CoreGraphics");
ObjC.import("Foundation");
ObjC.import("AppKit");

var IRIS_MIN_WINDOW_WIDTH = 80;
var IRIS_MIN_WINDOW_HEIGHT = 60;
var IRIS_MIN_LISTED_WINDOW_WIDTH = 200;
var IRIS_MIN_LISTED_WINDOW_HEIGHT = 150;
var IRIS_WINDOW_APPEAR_WAIT_LIMIT = 1;
var IRIS_DESKTOP_STEP_WAIT_LIMIT = 1.5;
var IRIS_RAISE_POLL_INTERVAL = 0.05;
var IRIS_ALL_DESKTOPS_MASK = 0x7;

function irisText(value, limit) {
  var chars = Array.from(value == null ? "" : String(value));
  return chars.slice(0, limit).join("");
}

function irisDisplay(value) {
  return irisText(irisText(value, 400).replace(/[\u0000-\u001f\u007f]/g, ""), 200);
}

function irisBounds(value) {
  if (!value) return null;
  var x = Number(Array.isArray(value) ? value[0] : (value.X != null ? value.X : value.x));
  var y = Number(Array.isArray(value) ? value[1] : (value.Y != null ? value.Y : value.y));
  var width = Number(Array.isArray(value) ? value[2] : (value.Width != null ? value.Width : value.width));
  var height = Number(Array.isArray(value) ? value[3] : (value.Height != null ? value.Height : value.height));
  if (![x, y, width, height].every(function (n) { return isFinite(n); })) return null;
  return [Math.round(x), Math.round(y), Math.round(width), Math.round(height)];
}

function irisSameBounds(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 4 || b.length !== 4) return false;
  for (var i = 0; i < 4; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function irisInteger(value) {
  return typeof value === "number" && isFinite(value) && Math.floor(value) === value;
}

function irisFallbackId(pid, matchTitle, bounds, ordinal) {
  var parts = [pid, matchTitle].concat(bounds);
  if (irisInteger(ordinal) && ordinal >= 1) parts.push(ordinal);
  var source = parts.join("\u001f");
  var hash = 2166136261;
  for (var i = 0; i < source.length; i += 1) {
    hash = Math.imul(hash ^ source.charCodeAt(i), 16777619) >>> 0;
  }
  return -(hash % 2000000000 + 1);
}

function irisWindowId(cgId, pid, matchTitle, bounds) {
  return irisInteger(cgId) ? cgId : irisFallbackId(pid, matchTitle, bounds);
}

function irisAssignSnapshotIds(windows, front) {
  var assigned = core.assignOrdinals(windows);
  if (!Array.isArray(assigned)) assigned = windows;
  var counts = {};
  var firstById = {};
  var i;
  var key;
  for (i = 0; i < assigned.length; i += 1) {
    if (assigned[i].cgId != null) continue;
    key = String(assigned[i].id);
    counts[key] = (counts[key] || 0) + 1;
  }
  for (i = 0; i < assigned.length; i += 1) {
    var item = assigned[i];
    key = String(item.id);
    if (item.cgId != null || counts[key] < 2) continue;
    var oldId = item.id;
    item.id = irisFallbackId(item.pid, item.matchTitle, item.bounds, item.ordinal);
    if (front === oldId && !firstById[key]) {
      front = item.id;
      firstById[key] = true;
    }
  }
  return { windows: assigned, front: front };
}

function irisCocoaText(value) {
  try { return irisText(ObjC.unwrap(value), 400); } catch (_ignored) {
    return irisText(value, 400);
  }
}

function irisCgWindows(option) {
  var ref = $.CGWindowListCopyWindowInfo(option, $.kCGNullWindowID);
  var list = ObjC.castRefToObject(ref);
  var out = [];
  for (var i = 0; i < list.count; i += 1) {
    var item = list.objectAtIndex(i);
    if (item.objectForKey("kCGWindowLayer").intValue !== 0) continue;
    // deepUnwrap 은 키가 없어도 null 을 돌려준다. 필드를 직접 읽으면 예외가 발생해 열거 전체가
    // 중단된다. 확인 결과 직접 읽기가 더 느리기도 했다(140개 기준 24ms 차이).
    var bounds = irisBounds(ObjC.deepUnwrap(item.objectForKey("kCGWindowBounds")));
    if (!bounds) continue;
    if (bounds[2] < IRIS_MIN_WINDOW_WIDTH || bounds[3] < IRIS_MIN_WINDOW_HEIGHT) continue;
    out.push({
      cgId: Number(item.objectForKey("kCGWindowNumber").intValue),
      pid: Number(item.objectForKey("kCGWindowOwnerPID").intValue),
      bounds: bounds,
      ownerName: irisCocoaText(item.objectForKey("kCGWindowOwnerName")),
      title: irisCocoaText(item.objectForKey("kCGWindowName")),
      z: i,
    });
  }
  return out;
}

function irisCgOnScreenWindowIds() {
  var windows = irisCgWindows($.kCGWindowListOptionOnScreenOnly);
  var seen = {};
  var ids = [];
  for (var i = 0; i < windows.length; i += 1) {
    var id = windows[i].cgId;
    if (!irisInteger(id) || seen[String(id)]) continue;
    seen[String(id)] = true;
    ids.push(id);
  }
  return ids;
}

function irisCgWindowIdIsOnScreen(ids, id) {
  for (var i = 0; i < ids.length; i += 1) {
    if (ids[i] === id) return true;
  }
  return false;
}

function irisRunningApplications() {
  var apps = $.NSWorkspace.sharedWorkspace.runningApplications;
  var out = {};
  for (var i = 0; i < Number(apps.count); i += 1) {
    var app = apps.objectAtIndex(i);
    var pid = Number(app.processIdentifier);
    if (!irisInteger(pid) || pid <= 0) continue;
    out[String(pid)] = {
      pid: pid,
      bundleId: irisCocoaText(app.bundleIdentifier),
      name: irisCocoaText(app.localizedName),
      regular: Number(app.activationPolicy) === 0,
    };
  }
  return out;
}

function irisAxValue(object, name, fallback) {
  try { return object[name](); } catch (_first) {
    try { return object.attributes.byName(name).value(); } catch (_second) { return fallback; }
  }
}

function irisAxBounds(win) {
  var position = irisAxValue(win, "position", null);
  var size = irisAxValue(win, "size", null);
  if (!position || !size) return null;
  return irisBounds({ X: position[0], Y: position[1], Width: size[0], Height: size[1] });
}

function irisCgMatch(cgWindows, pid, bounds) {
  var match = null;
  var count = 0;
  for (var i = 0; i < cgWindows.length; i += 1) {
    if (cgWindows[i].pid !== pid || !irisSameBounds(cgWindows[i].bounds, bounds)) continue;
    match = cgWindows[i];
    count += 1;
  }
  return count === 1 ? match : null;
}

function irisCgFirstMatch(cgWindows, pid, bounds) {
  for (var i = 0; i < cgWindows.length; i += 1) {
    if (cgWindows[i].pid === pid && irisSameBounds(cgWindows[i].bounds, bounds)) return cgWindows[i];
  }
  return null;
}

function irisCgZ(cgOnScreen, cgId) {
  for (var i = 0; i < cgOnScreen.length; i += 1) {
    if (cgOnScreen[i].cgId === cgId) return cgOnScreen[i].z;
  }
  return null;
}

function irisWindowBoundsKey(pid, bounds) {
  return String(pid) + "\u001f" + bounds.join("\u001f");
}

function irisMergeCgWindows(axWindows, cgAll, cgOnScreen, runningApps) {
  var out = axWindows.slice();
  var matched = {};
  var onScreen = {};
  var i;
  for (i = 0; i < axWindows.length; i += 1) {
    matched[irisWindowBoundsKey(axWindows[i].pid, axWindows[i].bounds)] = true;
  }
  for (i = 0; i < cgOnScreen.length; i += 1) onScreen[String(cgOnScreen[i].cgId)] = true;
  for (i = 0; i < cgAll.length; i += 1) {
    var cg = cgAll[i];
    if (matched[irisWindowBoundsKey(cg.pid, cg.bounds)]) continue;
    var app = runningApps[String(cg.pid)] || null;
    if (!app || app.regular !== true) continue;
    if (cg.bounds[2] < IRIS_MIN_LISTED_WINDOW_WIDTH || cg.bounds[3] < IRIS_MIN_LISTED_WINDOW_HEIGHT) continue;
    var title = irisText(cg.title, 400);
    var matchApp = irisText(app && app.name ? app.name : cg.ownerName, 400);
    var appKey = irisText(app && app.bundleId ? app.bundleId : "pid:" + String(cg.pid), 400);
    out.push({
      id: cg.cgId,
      cgId: cg.cgId,
      pid: cg.pid,
      pidStart: "",
      appKey: appKey,
      matchApp: matchApp,
      matchTitle: title,
      displayApp: irisDisplay(matchApp),
      displayTitle: irisDisplay(title),
      bounds: cg.bounds,
      minimized: false,
      reachable: "cg",
      onScreen: !!onScreen[String(cg.cgId)],
      idConfidence: "exact",
      z: irisCgZ(cgOnScreen, cg.cgId),
    });
  }
  return out;
}

function irisProcessWindows(p, cgAll, cgOnScreen) {
  var pid = Number(irisAxValue(p, "unixId", 0));
  var app = irisText(irisAxValue(p, "name", ""), 400);
  var bundleId = irisText(irisAxValue(p, "bundleIdentifier", ""), 400);
  var appKey = bundleId || "pid:" + String(pid);
  var names = p.windows.name();
  var subs = p.windows.subrole();
  var poss = p.windows.position();
  var sizes = p.windows.size();
  var count = Math.min(names.length, subs.length, poss.length, sizes.length);
  var frontmost = !!irisAxValue(p, "frontmost", false);
  var wins = null;
  var front = null;
  var out = [];
  for (var i = 0; i < count; i += 1) {
    var position = poss[i];
    var size = sizes[i];
    if (!position || !size) continue;
    var bounds = irisBounds({ X: position[0], Y: position[1], Width: size[0], Height: size[1] });
    if (!bounds) continue;
    var title = irisText(names[i], 400);
    var cg = irisCgMatch(cgAll, pid, bounds);
    var cgId = cg ? cg.cgId : null;
    var id = irisWindowId(cgId, pid, title, bounds);
    // 앞 창의 번호는 그 창의 번호와 같아야 한다.
    //
    // 여기서만 cgOnScreen 으로 다시 찾으면 안 된다. cgId 는 pid+위치로 찾고, 같은 위치에 창이
    // 둘이면 선택하지 못해 null 이 된다(irisCgMatch 의 count === 1). 두 목록은 담긴 창이 달라
    // 한쪽은 둘, 다른 쪽은 하나가 되는 경우가 생긴다. 그러면 같은 창인데 행은 위치로 만든 번호,
    // 앞 창은 cgId 가 되어 서로 일치하지 않는다. 앞 창이 목록 밖으로 판정되면 selectTarget 은
    // 커서를 무시하고 첫 창부터 고르므로(R9), 누를 때마다 같은 창만 나온다.
    if (frontmost && i === 0) front = id;
    if (String(subs[i] || "") !== "AXStandardWindow") continue;

    var onScreen = irisCgFirstMatch(cgOnScreen, pid, bounds);
    var z = cgId == null ? null : irisCgZ(cgOnScreen, cgId);
    var minimized = false;
    if (!onScreen) {
      if (wins === null) wins = p.windows();
      try { minimized = !!wins[i].attributes.byName("AXMinimized").value(); } catch (_ignored) {}
    }
    out.push({
      id: id,
      cgId: cgId,
      pid: pid,
      pidStart: "",
      appKey: appKey,
      matchApp: app,
      matchTitle: title,
      displayApp: irisDisplay(app),
      displayTitle: irisDisplay(title),
      bounds: bounds,
      minimized: minimized,
      reachable: "ax",
      onScreen: !!onScreen,
      idConfidence: cg ? "exact" : "none",
      z: z,
    });
  }
  return { windows: out, front: front };
}

function irisAddProcess(processes, seen, process) {
  var pid = Number(irisAxValue(process, "unixId", 0));
  if (pid > 0 && seen[String(pid)]) return;
  if (pid > 0) seen[String(pid)] = true;
  processes.push(process);
}

function irisEnumerateProcesses(se) {
  var procs = se.processes.whose({ backgroundOnly: false })();
  return procs || [];
}

function irisStepProcesses(se, targets) {
  var procs = [];
  var seen = {};
  var fronts = se.processes.whose({ frontmost: true })() || [];
  for (var i = 0; i < fronts.length; i += 1) irisAddProcess(procs, seen, fronts[i]);

  var pids = {};
  var list = Array.isArray(targets) ? targets : [];
  for (var j = 0; j < list.length; j += 1) {
    var pid = Number(list[j] && list[j].pid);
    if (irisInteger(pid) && pid > 0) pids[String(pid)] = pid;
  }
  var keys = Object.keys(pids);
  for (var k = 0; k < keys.length; k += 1) {
    var matches = se.processes.whose({ unixId: pids[keys[k]] })() || [];
    for (var m = 0; m < matches.length; m += 1) irisAddProcess(procs, seen, matches[m]);
  }
  return procs;
}

function irisSnapshot(processes) {
  var cgAll = irisCgWindows(0);
  var cgOnScreen = irisCgWindows($.kCGWindowListOptionOnScreenOnly);
  var runningApps = irisRunningApplications();
  var windows = [];
  var front = null;
  for (var i = 0; i < processes.length; i += 1) {
    try {
      var result = irisProcessWindows(processes[i], cgAll, cgOnScreen);
      windows = windows.concat(result.windows);
      if (front == null && result.front != null) front = result.front;
    } catch (_ignored) {}
  }
  windows = irisMergeCgWindows(windows, cgAll, cgOnScreen, runningApps);
  return irisAssignSnapshotIds(windows, front);
}

function irisSelectedId(selected) {
  if (selected && typeof selected === "object") {
    return selected.windowId != null ? selected.windowId :
      selected.resolvedId != null ? selected.resolvedId : selected.id;
  }
  return selected;
}

function irisFillTargetPidStarts(windows, targets) {
  var starts = {};
  var conflicts = {};
  var list = Array.isArray(targets) ? targets : [];
  var i;
  for (i = 0; i < list.length; i += 1) {
    var target = list[i];
    if (!target || !irisInteger(target.pid) || typeof target.pidStart !== "string" || !target.pidStart) continue;
    var key = String(target.pid);
    if (starts[key] && starts[key] !== target.pidStart) conflicts[key] = true;
    else starts[key] = target.pidStart;
  }
  for (i = 0; i < windows.length; i += 1) {
    var win = windows[i];
    var pidKey = String(win.pid);
    // host가 step 직전에 확인한 시작 시각을 같은 PID의 이번 snapshot에 보강한다.
    if (!win.pidStart && starts[pidKey] && !conflicts[pidKey]) win.pidStart = starts[pidKey];
  }
}

function irisFindWindow(windows, selected, used) {
  var best = -1;
  var bestPriority = 0;
  for (var i = 0; i < windows.length; i += 1) {
    if (used[i]) continue;
    var priority = core.matchWindow(selected, windows[i], "session");
    if (priority > 0 && (bestPriority === 0 || priority < bestPriority)) {
      best = i;
      bestPriority = priority;
    }
  }
  return best;
}

function irisResolveWindows(windows, targets) {
  var used = [];
  var matches = [];
  var resolved = [];
  var missing = [];
  var i;
  for (i = 0; i < windows.length; i += 1) used.push(false);
  for (i = 0; i < targets.length; i += 1) {
    var target = targets[i];
    var targetId = irisSelectedId(target);
    if (targetId == null) continue;
    var index = irisFindWindow(windows, target, used);
    if (index < 0) {
      missing.push(targetId);
      continue;
    }
    used[index] = true;
    matches.push({ id: targetId, window: windows[index] });
    resolved.push(targetId);
  }
  return { matches: matches, resolved: resolved, missing: missing };
}

function irisResolvedWindow(matches, id) {
  for (var i = 0; i < matches.length; i += 1) {
    if (matches[i].id === id) return matches[i].window;
  }
  return null;
}

function irisMissingHas(missing, id) {
  for (var i = 0; i < missing.length; i += 1) {
    var item = missing[i];
    if (item === id || (item && typeof item === "object" && item.id === id)) return true;
  }
  return false;
}

function irisSpaceSwitchFailure(reason) {
  return reason === "window-out-of-reach" || reason === "raise-did-not-land"
    || reason === "desktop-unknown" || reason === "desktop-switch-failed";
}

function irisStep(input, snapshot, raiseWindow) {
  var targets = Array.isArray(input.targets) ? input.targets : [];
  var windows = snapshot && Array.isArray(snapshot.windows) ? snapshot.windows : [];
  irisFillTargetPidStarts(windows, targets);
  var resolution = irisResolveWindows(windows, targets);
  var resolved = resolution.resolved;
  var missing = resolution.missing;
  var attempts = 0;
  // 앞 창을 선택 목록의 번호로 변환한다. 스냅샷의 번호와 targets 의 번호는 서로 다른 시점에 만들어져
  // 같은 창이라도 값이 다를 수 있다(저장본에는 번호가 아예 없어 pickKey 로 떨어지기도 한다).
  // 변환하지 않으면 앞 창이 항상 목록 밖으로 판정되어 첫 창만 반복된다.
  var front = snapshot ? snapshot.front : null;
  for (var f = 0; f < resolution.matches.length; f += 1) {
    if (resolution.matches[f].window && resolution.matches[f].window.id === front) {
      front = resolution.matches[f].id;
      break;
    }
  }

  while (attempts < targets.length && resolved.length > 0) {
    var selected = core.selectTarget({
      ordered: Array.isArray(input.ordered) ? input.ordered : [],
      resolved: resolved,
      front: front,
      cursor: input.cursor,
      dir: input.dir,
    });
    var selectedId = irisSelectedId(selected);
    if (selectedId == null) break;
    var descriptor = irisResolvedWindow(resolution.matches, selectedId);
    attempts += 1;
    // 이 앱의 자기 창은 osascript 로 전환할 수 없다. AX 는 현재 데스크톱만 보고, open 은 이미 앞에
    // 있는 앱을 호출하는 것이라 아무 동작도 하지 않는다. 앱이 직접 올리도록 id 만 돌려준다.
    // 선택을 두 곳에서 하면 두 판정이 어긋나므로, 선택은 여기 한 곳에만 둔다.
    if (descriptor && irisInteger(input.ownPid) && descriptor.pid === input.ownPid) {
      return { ok: true, raised: null, own: selectedId, resolved: resolved, missing: missing, front: front };
    }
    var outcome = descriptor ? raiseWindow(descriptor) : false;
    if (outcome === true || (outcome && outcome.ok === true)) {
      return { ok: true, raised: selectedId, resolved: resolved, missing: missing, front: front };
    }
    resolved = resolved.filter(function (id) { return id !== selectedId; });
    // 전환하지 못한 창에서 멈추면 다음 창으로도 가지 못하고, 사용자에게는 아무 반응이 없는 것으로
    // 보인다. 확인 결과 Chrome 이 막히면 그 뒤 순환 전체가 멈췄다.
    // 막힌 사실은 적고, 순환은 다음 후보로 계속한다.
    if (outcome && irisSpaceSwitchFailure(outcome.reason)) {
      if (!irisMissingHas(missing, selectedId)) missing.push({ id: selectedId, reason: outcome.reason });
      continue;
    }
    if (!irisMissingHas(missing, selectedId)) missing.push(selectedId);
  }

  return { ok: true, raised: null, resolved: resolved, missing: missing, front: front };
}

function irisFindAxTarget(descriptor) {
  var se = Application("System Events");
  var processes = se.processes.whose({ unixId: descriptor.pid })() || [];
  for (var i = 0; i < processes.length; i += 1) {
    var process = processes[i];
    if (Number(irisAxValue(process, "unixId", 0)) !== descriptor.pid) continue;
    var wins = process.windows();
    for (var j = 0; j < wins.length; j += 1) {
      var win = wins[j];
      var subrole = String(irisAxValue(win, "subrole", irisAxValue(win, "AXSubrole", "")) || "");
      if (subrole !== "AXStandardWindow" || !irisSameBounds(irisAxBounds(win), descriptor.bounds)) continue;
      return { process: process, window: win };
    }
  }
  return null;
}

function irisRaiseAxTarget(target) {
  try {
    var minimized = target.window.attributes.byName("AXMinimized");
    if (minimized.value()) {
      minimized.value = false;
      for (var i = 0; i < 20; i += 1) {
        if (!minimized.value()) break;
        $.NSThread.sleepForTimeInterval(0.05);
      }
    }
  } catch (_ignored) {}
  try { target.process.frontmost = true; } catch (_ignored) {}
  try { target.window.attributes.byName("AXMain").value = true; } catch (_ignored) {}
  try { target.window.actions.byName("AXRaise").perform(); } catch (_raiseFailed) { return false; }
  return true;
}

function irisRaiseAx(descriptor) {
  var target = irisFindAxTarget(descriptor);
  return target ? irisRaiseAxTarget(target) : false;
}

// 다른 데스크톱에 있는 창은 AX 로 접근할 수 없다. 현재 데스크톱의 창만 보이기 때문이다
// (확인 결과: Chrome 창 다섯이 CG 에는 모두 있는데 AX 목록에는 0개였다. System Events 를
// 거치든 AXUIElementCreateApplication 을 직접 호출하든 같았다).
//
// 그래서 앱을 여는 대신 그 창이 있는 데스크톱으로 먼저 이동한다. 창마다 어느 데스크톱에 있는지는
// 정확히 읽을 수 있고, 그 위치로 바로 이동하는 데 176ms 가 걸렸다. 이동한 뒤에는 AX 가 그 창을 본다.
// 이 방식이 앞서 버린 두 방식을 대신한다. 데스크톱을 하나씩 넘겨 찾는 방식은 느리고 시작 위치로
// 돌아오지 못했으며, open 으로 앱을 앞으로 가져오는 방식은 창을 지정하지 못해 엉뚱한 창으로
// 이동했다.
var irisCgsConnection = null;

function irisCgs() {
  if (irisCgsConnection !== null) return irisCgsConnection;
  irisCgsConnection = 0;
  try {
    ObjC.bindFunction("CGSMainConnectionID", ["int", []]);
    ObjC.bindFunction("CGSCopySpacesForWindows", ["id", ["int", "int", "id"]]);
    ObjC.bindFunction("CGSCopyManagedDisplayForSpace", ["id", ["int", "int"]]);
    ObjC.bindFunction("CGSManagedDisplayGetCurrentSpace", ["int", ["int", "id"]]);
    ObjC.bindFunction("CGSCopyManagedDisplaySpaces", ["id", ["int"]]);
    var cid = Number($.CGSMainConnectionID());
    if (isFinite(cid) && cid > 0) irisCgsConnection = cid;
  } catch (_bindFailed) {}
  return irisCgsConnection;
}

// 그 창이 어느 데스크톱에 있는지 읽는다. 읽지 못하면 null 을 돌려주고 값을 추정하지 않는다.
function irisWindowDesktop(cgId) {
  var cid = irisCgs();
  if (!cid) return null;
  try {
    var spaces = $.CGSCopySpacesForWindows(cid, IRIS_ALL_DESKTOPS_MASK, $([cgId]));
    if (!spaces || !spaces.count) return null;
    var space = Number(spaces.objectAtIndex(0).intValue);
    if (!isFinite(space) || space <= 0) return null;
    var display = $.CGSCopyManagedDisplayForSpace(cid, space);
    if (!display) return null;
    return { cid: cid, space: space, display: display };
  } catch (_readFailed) {
    return null;
  }
}

function irisCurrentDesktop(place) {
  try { return Number($.CGSManagedDisplayGetCurrentSpace(place.cid, place.display)); }
  catch (_readFailed) { return null; }
}

// 그 화면의 데스크톱 차례. 왼쪽에서 오른쪽 순서 그대로다.
function irisDesktopOrder(place) {
  try {
    var displays = ObjC.deepUnwrap($.CGSCopyManagedDisplaySpaces(place.cid));
    for (var d = 0; d < displays.length; d += 1) {
      var spaces = displays[d] && displays[d].Spaces;
      if (!spaces || !spaces.length) continue;
      var ids = [];
      for (var i = 0; i < spaces.length; i += 1) ids.push(Number(spaces[i].ManagedSpaceID));
      if (ids.indexOf(place.space) >= 0) return ids;
    }
  } catch (_readFailed) {}
  return null;
}

// 사용자가 쓰는 것과 같은 단축키로 한 칸 이동한다. 데스크톱을 직접 지정하는 호출은 쓰지 않는다.
// 그 호출은 WindowServer 만 바꾸고 Dock 에는 알리지 않아 두 상태가 어긋난다. 그러면 다른 데스크톱의
// 창이 이 데스크톱에 겹쳐 보이고, 사용자가 실제로 한 번 이동해야 사라진다.
function irisPressDesktopKey(forward) {
  try { Application("System Events").keyCode(forward ? 124 : 123, { using: "control down" }); }
  catch (_pressFailed) { return false; }
  return true;
}

function irisWaitForDesktop(place, space, limitSeconds) {
  var deadline = $.NSDate.date.timeIntervalSince1970 + limitSeconds;
  while ($.NSDate.date.timeIntervalSince1970 < deadline) {
    if (irisCurrentDesktop(place) === space) return true;
    $.NSThread.sleepForTimeInterval(IRIS_RAISE_POLL_INTERVAL);
  }
  return false;
}

// 몇 칸인지 계산해 그만큼만 이동한다. 목표를 모른 채 훑으며 찾고 도착 판정을 화면 목록 변화로
// 하면, 전환 중에 두 데스크톱의 창이 섞여 나와 엉뚱한 위치를 도착으로 판정한다.
// 그래서 목표 번호를 먼저 구하고, 도착은 현재 데스크톱 번호로 판정한다.
function irisWalkToDesktop(place) {
  var order = irisDesktopOrder(place);
  if (!order) return "desktop-unknown";
  var here = irisCurrentDesktop(place);
  var from = order.indexOf(here);
  var to = order.indexOf(place.space);
  if (from < 0 || to < 0) return "desktop-unknown";
  if (from === to) return null;
  var forward = to > from;
  var step = forward ? 1 : -1;
  for (var at = from; at !== to; at += step) {
    if (!irisPressDesktopKey(forward)) return "desktop-switch-failed";
    if (!irisWaitForDesktop(place, order[at + step], IRIS_DESKTOP_STEP_WAIT_LIMIT)) {
      // 한 칸도 이동하지 않았으면 그 단축키가 꺼져 있는 것이다. 더 누르지 않는다. 엉뚱한
      // 데스크톱으로 이동시키는 것이 이동하지 못하는 것보다 나쁘다.
      return "desktop-switch-failed";
    }
  }
  return null;
}

// 대상 창이 화면에 나타나기를 기다린다. 대기 횟수로 세면 한 번 읽는 비용(창 140개 순회)이 빠져
// 실제 시간과 어긋나므로 경과 시간으로 측정한다. 상한이 곧 사용자가 기다리는 시간이다.
function irisWaitForTargetOnScreen(descriptor, limitSeconds) {
  var deadline = $.NSDate.date.timeIntervalSince1970 + limitSeconds;
  while ($.NSDate.date.timeIntervalSince1970 < deadline) {
    if (irisCgWindowIdIsOnScreen(irisCgOnScreenWindowIds(), descriptor.cgId)) return true;
    $.NSThread.sleepForTimeInterval(IRIS_RAISE_POLL_INTERVAL);
  }
  return false;
}

function irisRaise(descriptor) {
  if (!descriptor || descriptor.reachable !== "cg") return irisRaiseAx(descriptor);
  if (!irisInteger(descriptor.cgId)) return false;
  // 이미 이 데스크톱에 있으면 그 자리에서 그 창을 지목한다.
  if (irisCgWindowIdIsOnScreen(irisCgOnScreenWindowIds(), descriptor.cgId)) return irisRaiseAx(descriptor);

  // 실패를 한 이름으로 묶으면 원인을 구분할 수 없으므로, 경우마다 다른 이름을 준다.
  var place = irisWindowDesktop(descriptor.cgId);
  if (!place) return { ok: false, reason: "desktop-unknown" };
  var failed = irisWalkToDesktop(place);
  if (failed) return { ok: false, reason: failed };
  if (!irisWaitForTargetOnScreen(descriptor, IRIS_WINDOW_APPEAR_WAIT_LIMIT)) {
    return { ok: false, reason: "window-out-of-reach" };
  }
  // 여기서부터 AX 가 그 창을 본다. 앱을 여는 것이 아니라 그 창 하나를 지정한다.
  irisRaiseAx(descriptor);
  return true;
}

function irisPermissionError(error) {
  var detail = String(error && (error.message || error) || "");
  return /-25211|assistive|not authorized|not permitted|accessibility|1002|않은 응용 프로그램|System Events process list unavailable/i.test(detail);
}

function run(argv) {
  try {
    var input = JSON.parse(String(argv && argv[0] || "{}"));
    var se = Application("System Events");
    var processes = __irisMode === "enumerate" ? irisEnumerateProcesses(se) : irisStepProcesses(se, input.targets);
    if (!processes.length) throw new Error("System Events process list unavailable");
    var snapshot = irisSnapshot(processes);
    if (__irisMode === "enumerate") {
      return JSON.stringify({ ok: true, windows: snapshot.windows, front: snapshot.front });
    }
    return JSON.stringify(irisStep(input, snapshot, irisRaise));
  } catch (error) {
    return JSON.stringify({
      ok: false,
      reason: irisPermissionError(error) ? "permission" : "exec",
      detail: String(error && (error.message || error) || error).slice(0, 400),
    });
  }
}
`;

function buildScript(coreSource, mode) {
  if (mode !== "enumerate" && mode !== "step") throw new TypeError("mode는 enumerate 또는 step이어야 한다");
  return `var module = { exports: {} }, exports = module.exports;\n${String(coreSource)}\nvar core = module.exports;\nvar __irisMode = ${JSON.stringify(mode)};\n${RUNNER_SRC}`;
}

module.exports = { RUNNER_SRC, buildScript };
