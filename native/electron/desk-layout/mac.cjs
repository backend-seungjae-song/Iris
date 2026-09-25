// 창 레이아웃(desklayout)의 macOS 실행기. osascript(JXA) 자식 프로세스 하나로 창 목록 읽기·
// 위치/크기 적용·데스크톱을 넘기며 되돌리기를 순서대로 실행한다.
//
// 소유 범위
//   JXA 스크립트(list·apply·restore-desktops·running)의 조립·실행·직렬화. 창 전환기
//   (switcher-jxa.cjs·window-catalog.cjs)와 목적이 겹치지만 코드는 공유하지 않는다
//   (두 기능이 같은 파일을 공유하지 않는다). CG·AX·CGS·System Events를 다루는 부분은 이 파일 안에 새로 쓴다.
//
// 제공 API
//   createMac({ execFile }) → { listWindows() · applyWindows(items) · restoreAcrossDesktops(plan) ·
//   runningBundleIds() }. 모두 Promise를 돌려준다. 사각형은 { x, y, width, height }(전역 좌표, 왼쪽 위 원점).
//
// 의존 대상
//   execFile만 주입받는다. osascript(JXA)와 CoreGraphics·ApplicationServices(AX)·CGS(비공개 API, 창의
//   데스크톱 조회)·System Events(AX 창 조작, 데스크톱 전환 키)에 기댄다.
//
// 유지 조건
//   창 목록의 기준은 CG 전체 창 목록이다. AX(System Events)는 지금 데스크톱의 창만 돌려주고, 창 번호
//   속성(AXWindowNumber)도 없다(실측 2026-09-22: 모든 창이 걸러져 0개가 나왔다). AX 창은 pid와 위치로
//   CG 창에 짝짓는다.
//   osascript를 동시에 둘 띄우지 않는다(active 슬롯).
//   데스크톱 전환 키는 System Events로 보낸다. CGEvent로 보낸 ctrl+화살표는 전환을 일으키지 않았다(실측).
//   창을 끌 때 잡는 지점은 CG 맨 위 창 확인과 AX 요소 확인을 둘 다 통과한 곳만 쓴다. 제목 가운데를 잡았다가
//   Finder 폴더 아이콘을 끈 사례가 있다. 통과하는 곳이 없으면 그 창은 옮기지 않는다.
//
// 영향 범위
//   host.cjs가 이 API로 창을 읽고 복원한다. applyWindows·restoreAcrossDesktops를 부르는 순간 실제 창이
//   움직이고, restoreAcrossDesktops는 데스크톱을 전환하고 마우스를 움직인다.
//   현재 목록 확인: node bin/importers.mjs native/electron/desk-layout/mac.cjs

const MIN_WIDTH = 200;
const MIN_HEIGHT = 150;

// 공용 JXA 헤더: CG 창 목록, CGS 데스크톱 조회, AX 창 찾기.
const HEADER = String.raw`
ObjC.import("CoreGraphics");
ObjC.import("Foundation");
ObjC.import("AppKit");

var DL_MIN_W = ${MIN_WIDTH};
var DL_MIN_H = ${MIN_HEIGHT};

function dlNow() { return $.NSDate.date.timeIntervalSince1970; }
function dlSleep(s) { $.NSThread.sleepForTimeInterval(s); }

var DL_CID = (function () {
  try {
    ObjC.bindFunction("CGSMainConnectionID", ["int", []]);
    ObjC.bindFunction("CGSCopySpacesForWindows", ["id", ["int", "int", "id"]]);
    ObjC.bindFunction("CGSCopyManagedDisplaySpaces", ["id", ["int"]]);
    var cid = Number($.CGSMainConnectionID());
    return (isFinite(cid) && cid > 0) ? cid : 0;
  } catch (e) { return 0; }
})();

// 모니터별 데스크톱 목록과 지금 데스크톱. "디스플레이마다 별도의 Spaces"가 꺼진 기기에서는 항목이 하나다.
function dlDisplays() {
  var out = [];
  if (!DL_CID) return out;
  try {
    var list = ObjC.deepUnwrap($.CGSCopyManagedDisplaySpaces(DL_CID)) || [];
    for (var i = 0; i < list.length; i += 1) {
      var d = list[i] || {};
      var ids = [];
      var spaces = d.Spaces || [];
      for (var j = 0; j < spaces.length; j += 1) ids.push(Number(spaces[j].ManagedSpaceID));
      var cur = d["Current Space"] ? Number(d["Current Space"].ManagedSpaceID) : null;
      out.push({ display: String(d["Display Identifier"] || ""), order: ids, current: cur });
    }
  } catch (e) {}
  return out;
}

function dlSpaceOf(cgId) {
  if (!DL_CID) return null;
  try {
    var spaces = $.CGSCopySpacesForWindows(DL_CID, 0x7, $([cgId]));
    if (!spaces || !spaces.count) return null;
    var s = Number(spaces.objectAtIndex(0).intValue);
    return (isFinite(s) && s > 0) ? s : null;
  } catch (e) { return null; }
}

// 데스크톱 id → { display 항목, index(1부터) }
function dlLocate(displays, space) {
  for (var i = 0; i < displays.length; i += 1) {
    var at = displays[i].order.indexOf(space);
    if (at >= 0) return { entry: displays[i], index: at + 1 };
  }
  return null;
}

function dlBounds(b) {
  if (!b) return null;
  return { x: Math.round(Number(b.X)), y: Math.round(Number(b.Y)), width: Math.round(Number(b.Width)), height: Math.round(Number(b.Height)) };
}

// CGWindowListCopyWindowInfo는 CF 참조를 돌려주므로 castRefToObject로 바꾼 뒤에야 풀린다(바로 deepUnwrap하면 빈 값).
function dlCgWindows(onScreenOnly) {
  try {
    var list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(onScreenOnly ? 1 : 0, $.kCGNullWindowID)));
    return Array.isArray(list) ? list : [];
  } catch (e) { return []; }
}

function dlCgBoundsOf(cgId) {
  var list = dlCgWindows(false);
  for (var i = 0; i < list.length; i += 1) {
    if (Number(list[i].kCGWindowNumber) === cgId) return dlBounds(list[i].kCGWindowBounds);
  }
  return null;
}

function dlNear(a, b, tol) {
  return a && b && Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol
    && Math.abs(a.width - b.width) <= tol && Math.abs(a.height - b.height) <= tol;
}

function dlAxRect(win) {
  try {
    var p = win.position(), s = win.size();
    return { x: Math.round(p[0]), y: Math.round(p[1]), width: Math.round(s[0]), height: Math.round(s[1]) };
  } catch (e) { return null; }
}

// pid의 표준 AX 창 목록(지금 데스크톱 것만 나온다).
function dlAxWindows(pid) {
  var out = [];
  try {
    var procs = Application("System Events").processes.whose({ unixId: pid })();
    for (var p = 0; p < procs.length; p += 1) {
      var wins = procs[p].windows();
      for (var w = 0; w < wins.length; w += 1) {
        var win = wins[w];
        var subrole = "";
        try { subrole = win.subrole(); } catch (e) {}
        if (subrole !== "AXStandardWindow") continue;
        var minimized = false;
        try { minimized = win.attributes.byName("AXMinimized").value(); } catch (e) {}
        if (minimized) continue;
        var title = "";
        try { title = win.name() || ""; } catch (e) {}
        out.push({ win: win, rect: dlAxRect(win), title: String(title) });
      }
    }
  } catch (e) {}
  return out;
}

// 한 앱에 위치·크기가 같은 창이 여럿이면 위치만으로 구분되지 않는다(실측: 전체 화면 Chrome 창 셋이
// 서로 1px 안에 겹쳐 있었고, 늘 첫 창만 잡혔다). CG 목록은 앞에서 뒤 순서라, 그 안에서 몇 번째인지를
// AX 목록의 같은 순번과 맞춘다.
function dlCgRank(pid, rect, cgId) {
  var list = dlCgWindows(true);
  var rank = 0;
  for (var i = 0; i < list.length; i += 1) {
    var w = list[i];
    if (Number(w.kCGWindowLayer) !== 0 || Number(w.kCGWindowOwnerPID) !== pid) continue;
    var b = dlBounds(w.kCGWindowBounds);
    if (!b || !dlNear(b, rect, 1)) continue;
    if (Number(w.kCGWindowNumber) === cgId) return rank;
    rank += 1;
  }
  return 0;
}

function dlFindAx(pid, rect, rank) {
  var list = dlAxWindows(pid);
  var hits = [];
  for (var i = 0; i < list.length; i += 1) if (dlNear(list[i].rect, rect, 1)) hits.push(list[i]);
  if (!hits.length) return null;
  return hits[Math.min(Math.max(Number(rank) || 0, 0), hits.length - 1)];
}

function dlSetFrame(win, rect) {
  function once() {
    try { win.position = [rect.x, rect.y]; } catch (e) {}
    try { win.size = [rect.width, rect.height]; } catch (e) {}
    try { win.position = [rect.x, rect.y]; } catch (e) {}
  }
  once();
  var got = dlAxRect(win);
  if (!dlNear(got, rect, 2)) { once(); got = dlAxRect(win); }
  return { ok: dlNear(got, rect, 2), applied: got };
}
`;

// CG 전체 창 목록을 기준으로 표준 창을 나열한다.
// 지금 데스크톱의 창은 AX 표준 창과 pid·위치가 맞는 것만 남기고 AX 제목을 붙인다.
// 다른 데스크톱의 창은 AX로 볼 수 없어 CG 정보(층 0, 최소 크기, 일반 앱)로만 거른다.
const LIST_BODY = String.raw`
ObjC.import("ApplicationServices");
function run(argv) {
  // 권한이 없으면 AX 가 빈 목록을 돌려 지금 데스크톱 창이 전부 빠진다. 그 목록으로 저장하면 좋은 저장본을 덮으므로 실패로 알린다.
  if (!$.AXIsProcessTrusted()) return JSON.stringify({ ok: false, reason: "permission" });
  // 잠금 화면에서는 AX가 창을 하나도 돌려주지 않아 지금 데스크톱의 창이 전부 빠진다(실측 2026-09-22).
  // 그 목록으로 저장하면 저장본이 망가지므로 잠금 여부를 함께 알린다.
  var front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  var locked = !!(front && !front.isNil() && ObjC.unwrap(front.bundleIdentifier) === "com.apple.loginwindow");
  var displays = dlDisplays();
  var currentSpaces = displays.map(function (d) { return d.current; });
  var cg = dlCgWindows(false);
  var axCache = {};
  var appCache = {};
  var out = [];
  for (var i = 0; i < cg.length; i += 1) {
    var w = cg[i];
    if (Number(w.kCGWindowLayer) !== 0) continue;
    if (w.kCGWindowAlpha != null && Number(w.kCGWindowAlpha) <= 0) continue;
    var rect = dlBounds(w.kCGWindowBounds);
    if (!rect || rect.width < DL_MIN_W || rect.height < DL_MIN_H) continue;
    var pid = Number(w.kCGWindowOwnerPID);
    var cgId = Number(w.kCGWindowNumber);
    if (!appCache.hasOwnProperty(pid)) {
      var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
      appCache[pid] = (app && !app.isNil() && Number(app.activationPolicy) === 0)
        ? { bundle: ObjC.unwrap(app.bundleIdentifier) || "", name: ObjC.unwrap(app.localizedName) || "" } : null;
    }
    var info = appCache[pid];
    if (!info || !info.bundle) continue;
    var space = dlSpaceOf(cgId);
    if (!space) continue;
    var where = dlLocate(displays, space);
    if (!where) continue;
    var onCurrent = currentSpaces.indexOf(space) >= 0;
    var title = String(w.kCGWindowName || "");
    if (onCurrent) {
      if (!axCache.hasOwnProperty(pid)) axCache[pid] = dlAxWindows(pid);
      // CG도 AX도 앞에서 뒤 순서다. 이미 쓴 AX 창을 건너뛰면 위치가 같은 창들이 순서대로 짝지어진다.
      var hit = null;
      for (var a = 0; a < axCache[pid].length; a += 1) {
        var cand = axCache[pid][a];
        if (cand.used || !dlNear(cand.rect, rect, 1)) continue;
        cand.used = true; hit = cand; break;
      }
      if (!hit) continue;
      title = hit.title || title;
    }
    out.push({ bundle: info.bundle, appName: info.name, pid: pid, cgId: cgId, title: title,
      rect: rect, desktop: where.index, space: space, onCurrent: onCurrent });
  }
  var desk = displays.map(function (d) { return { order: d.order, current: d.current }; });
  return JSON.stringify({ ok: true, locked: locked, windows: out, desktops: desk });
}
`;

// 지금 데스크톱에 있는 창들의 위치·크기를 적용한다. items: [{ pid, cgId, from, to }].
const APPLY_BODY = String.raw`
function run(argv) {
  var items = JSON.parse(argv[0] || "{}").items || [];
  var results = [];
  for (var i = 0; i < items.length; i += 1) {
    var it = items[i];
    var ax = dlFindAx(Number(it.pid), it.from, dlCgRank(Number(it.pid), it.from, Number(it.cgId)));
    if (!ax) { results.push({ ok: false, reason: "window-not-found" }); continue; }
    var r = dlSetFrame(ax.win, it.to);
    results.push({ ok: r.ok, reason: r.ok ? null : "frame-did-not-land", applied: r.applied });
  }
  return JSON.stringify({ ok: true, results: results });
}
`;

// 데스크톱을 넘기며 되돌린다(단축키 복원 전용).
// plan.visits: [{ index, items: [{ key, pid, cgId, from, to, target, own }] }]. index·target은 데스크톱 순서(1부터).
// 방문한 데스크톱마다: 위치·크기 적용(own은 호출자가 이미 적용) → 데스크톱이 다른 창은 잡는 지점을 확인하고
// 끌어서 target까지 넘긴 뒤 원래 데스크톱으로 돌아온다. 끝나면 시작 데스크톱과 커서 위치로 돌아간다.
const RESTORE_BODY = String.raw`
ObjC.import("ApplicationServices");

var DL_ACTION_ROLES = ["AXButton", "AXTab", "AXTabGroup", "AXRadioButton", "AXTextField", "AXTextArea",
  "AXImage", "AXCheckBox", "AXMenuButton", "AXPopUpButton", "AXComboBox", "AXLink", "AXStaticText"];

function dlPressKey(forward) {
  try { Application("System Events").keyCode(forward ? 124 : 123, { using: "control down" }); return true; }
  catch (e) { return false; }
}

function dlCurrentOf(order) {
  var ds = dlDisplays();
  for (var i = 0; i < ds.length; i += 1) if (ds[i].order.join(",") === order.join(",")) return ds[i].current;
  return ds.length ? ds[0].current : null;
}

// 한 칸씩 넘기고, 도착은 지금 데스크톱 번호가 바뀐 것으로 판정한다(전환 직후 값은 늦게 바뀐다).
function dlWalk(order, toIndex, deadline) {
  var here = order.indexOf(dlCurrentOf(order)) + 1;
  if (here <= 0) return false;
  while (here !== toIndex) {
    if (dlNow() > deadline) return false;
    var forward = toIndex > here;
    var next = here + (forward ? 1 : -1);
    if (!dlPressKey(forward)) return false;
    var until = dlNow() + 2.5;
    while (dlCurrentOf(order) !== order[next - 1]) {
      if (dlNow() > until) return false;
      dlSleep(0.05);
    }
    here = next;
  }
  dlSleep(0.35); // 전환 애니메이션이 끝나야 창 위치·맨 위 판정이 맞다
  return true;
}

function dlTopAt(point) {
  var list = dlCgWindows(true);
  for (var i = 0; i < list.length; i += 1) {
    var w = list[i];
    if (Number(w.kCGWindowLayer) !== 0) continue;
    var b = dlBounds(w.kCGWindowBounds);
    if (b && point.x >= b.x && point.x < b.x + b.width && point.y >= b.y && point.y < b.y + b.height) return Number(w.kCGWindowNumber);
  }
  return null;
}

function dlRoleAt(point) {
  try {
    var sys = $.AXUIElementCreateSystemWide();
    var el = Ref();
    if ($.AXUIElementCopyElementAtPosition(sys, point.x, point.y, el) !== 0) return null;
    var role = Ref();
    // 속성 이름은 CFString 이어야 하고(JS 문자열은 -25201), 값은 Ref 라서 castRefToObject 로 풀어야 한다.
    if ($.AXUIElementCopyAttributeValue(el[0], $("AXRole"), role) !== 0) return null;
    return ObjC.unwrap(ObjC.castRefToObject(role[0])) || "";
  } catch (e) { return null; }
}

function dlGrabPoint(rect, cgId) {
  var ys = [rect.y + 10, rect.y + 6];
  var xs = [rect.x + 90, rect.x + rect.width * 0.25, rect.x + rect.width * 0.5, rect.x + rect.width * 0.75];
  for (var j = 0; j < ys.length; j += 1) {
    for (var i = 0; i < xs.length; i += 1) {
      var p = { x: Math.round(xs[i]), y: Math.round(ys[j]) };
      if (dlTopAt(p) !== cgId) continue;
      var role = dlRoleAt(p);
      if (role === null) continue;
      if (DL_ACTION_ROLES.indexOf(role) >= 0) continue;
      return p;
    }
  }
  return null;
}

function dlMouse(type, p) {
  var ev = $.CGEventCreateMouseEvent($(), type, $.CGPointMake(p.x, p.y), 0);
  $.CGEventPost(0, ev);
}

function dlRaise(pid, rect, rank) {
  var ax = dlFindAx(pid, rect, rank);
  if (!ax) return false;
  try { ax.win.actions.byName("AXRaise").perform(); } catch (e) {}
  try {
    var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
    if (app && !app.isNil()) app.activateWithOptions(2);
  } catch (e) {}
  dlSleep(0.25);
  return true;
}

// 창 하나를 지금 데스크톱에서 target 데스크톱으로 끌어 옮긴다. 성공하면 target에 서 있다.
function dlDrag(order, item, deadline) {
  var rect = dlCgBoundsOf(item.cgId);
  if (!rect) return "window-gone";
  dlRaise(item.pid, rect, dlCgRank(item.pid, rect, item.cgId));
  var grab = dlGrabPoint(rect, item.cgId);
  if (!grab) return "no-safe-grab-point";
  var nudge = { x: grab.x + 4, y: grab.y };
  dlMouse(5, grab);            // mouseMoved
  dlSleep(0.08);
  dlMouse(1, grab);            // leftMouseDown
  dlSleep(0.15);
  dlMouse(6, nudge);           // leftMouseDragged — 끌기가 시작돼야 창이 전환을 따라온다
  dlSleep(0.15);
  var walked = dlWalk(order, item.target, deadline);
  dlMouse(6, grab);            // 제자리로 되돌린 뒤 놓는다(4px 어긋남 방지)
  dlSleep(0.1);
  dlMouse(2, grab);            // leftMouseUp
  dlSleep(0.3);
  if (!walked) return "desktop-switch-failed";
  var space = dlSpaceOf(item.cgId);
  if (order.indexOf(space) + 1 !== item.target) return "window-did-not-follow";
  return null;
}

function run(argv) {
  var plan = JSON.parse(argv[0] || "{}");
  var order = plan.order || [];
  var deadline = dlNow() + (plan.budgetSeconds || 60);
  var startSpace = dlCurrentOf(order);
  var startIndex = order.indexOf(startSpace) + 1;
  var cursor = $.CGEventGetLocation($.CGEventCreate($()));
  var results = {};
  var visits = plan.visits || [];
  for (var v = 0; v < visits.length; v += 1) {
    var visit = visits[v];
    if (!dlWalk(order, visit.index, deadline)) {
      for (var k = 0; k < visit.items.length; k += 1) results[visit.items[k].key] = { ok: false, reason: "desktop-switch-failed" };
      continue;
    }
    for (var i = 0; i < visit.items.length; i += 1) {
      var it = visit.items[i];
      if (dlNow() > deadline) { results[it.key] = { ok: false, reason: "time-budget" }; continue; }
      var framed = { ok: true };
      if (!it.own) {
        var ax = dlFindAx(it.pid, it.from, dlCgRank(it.pid, it.from, it.cgId));
        framed = ax ? dlSetFrame(ax.win, it.to) : { ok: false, reason: "window-not-found" };
      }
      var moved = null, reason = framed.ok ? null : (framed.reason || "frame-did-not-land");
      if (it.target && it.target !== visit.index && framed.ok !== false) {
        var failed = dlDrag(order, it, deadline);
        if (failed) reason = failed; else moved = it.target;
        if (!dlWalk(order, visit.index, deadline)) { reason = reason || "desktop-switch-failed"; }
      }
      results[it.key] = { ok: !reason, reason: reason, movedTo: moved };
    }
  }
  if (startIndex > 0) dlWalk(order, startIndex, dlNow() + 15);
  dlMouse(5, { x: cursor.x, y: cursor.y });
  return JSON.stringify({ ok: true, results: results });
}
`;

// 실행 중인 앱. bundles는 전부(로그인 재실행 때 이미 떠 있는지 판정), regular는 Dock에 보이는 일반 앱만
// (재실행 목록 저장용 — 옛 init.lua의 kind()==1 과 같은 기준). NSWorkspace만 쓰므로 손쉬운 사용 권한이 없어도 된다.
const RUNNING_BODY = String.raw`
function run(argv) {
  var all = [], regular = [];
  var apps = $.NSWorkspace.sharedWorkspace.runningApplications;
  for (var i = 0; i < apps.count; i += 1) {
    var app = apps.objectAtIndex(i);
    var b = ObjC.unwrap(app.bundleIdentifier);
    if (!b) continue;
    all.push(String(b));
    if (Number(app.activationPolicy) === 0) regular.push(String(b));
  }
  return JSON.stringify({ ok: true, bundles: all, regular: regular });
}
`;

function buildRunnable(body) {
  return `${HEADER}\n${body}`;
}

function createMac({ execFile }) {
  if (typeof execFile !== "function") throw new TypeError("execFile 주입이 필요하다");
  let active = false;

  function run(body, payload, options) {
    if (active) return Promise.resolve({ ok: false, reason: "busy" });
    active = true;
    return new Promise((resolve) => {
      const args = ["-l", "JavaScript", "-e", buildRunnable(body), JSON.stringify(payload || {})];
      execFile("osascript", args, options, (err, stdout, stderr) => {
        active = false;
        if (err) {
          const detail = String(stderr || (err && err.message) || err);
          const reason = err.killed || err.signal ? "timeout"
            : /-25211|assistive|not authorized|accessibility|1002/i.test(detail) ? "permission" : "exec";
          resolve({ ok: false, reason, detail: detail.slice(0, 400) });
          return;
        }
        try {
          const parsed = JSON.parse(String(stdout || "").trim());
          resolve(parsed && typeof parsed === "object" ? parsed : { ok: false, reason: "parse" });
        } catch (parseErr) {
          resolve({ ok: false, reason: "parse", detail: String((parseErr && parseErr.message) || parseErr) });
        }
      });
    });
  }

  return {
    listWindows: () => run(LIST_BODY, {}, { timeout: 20000, maxBuffer: 4 << 20 }),
    applyWindows: (items) => run(APPLY_BODY, { items }, { timeout: 20000, maxBuffer: 1 << 20 }),
    restoreAcrossDesktops: (plan) => run(RESTORE_BODY, plan, { timeout: ((plan.budgetSeconds || 60) + 25) * 1000, maxBuffer: 1 << 20 }),
    runningBundleIds: () => run(RUNNING_BODY, {}, { timeout: 5000, maxBuffer: 1 << 20 }),
  };
}

module.exports = { createMac, buildRunnable, HEADER, LIST_BODY, APPLY_BODY, RESTORE_BODY, RUNNING_BODY };
