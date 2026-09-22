// macOS를 부르지 않고 창 카탈로그의 실행 경계를 고정한다.
//
// 소유 범위
//   가짜 execFile로 argv·파싱·정규화·실패 분류·동시 실행·취소 계약을 검증하는 카드.
//
// 제공 API
//   node --test test/window-catalog.mjs 한 명령으로 B2 완료 조건을 판정한다.
//
// 의존 대상
//   window-catalog.cjs의 주입 API와 switcher-jxa.cjs의 순수 문자열 조립 API에만 기대며 실제
//   osascript·접근성 권한·Electron은 쓰지 않는다.
//
// 유지 조건
//   사용자 제목은 argv에서만 관찰하고, timeout·cancel 뒤 실행 슬롯이 풀리는지까지 검사한다.
//
// 영향 범위
//   공급자는 B2 두 모듈이고, 이 카드가 깨지면 B3가 의존할 enumerate·step·cancel 경계가 바뀐 것이다.
//   지금 목록은 이걸로 센다: node bin/importers.mjs test/window-catalog.mjs

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { sliceBetween } from "../bin/slice-anchor.mjs";
import { readFileSync } from "node:fs";
const CORE_PATH = new URL("../native/electron/switcher-core.cjs", import.meta.url);

const require = createRequire(import.meta.url);
const { RUNNER_SRC, buildScript } = require("../native/electron/switcher-jxa.cjs");
const { createWindowCatalog } = require("../native/electron/window-catalog.cjs");
const core = require("../native/electron/switcher-core.cjs");
const CORE = "module.exports.assignOrdinals = (windows) => windows;\nmodule.exports.selectTarget = () => null;";

function catalogWith(execFile) {
  return createWindowCatalog({ execFile, readCoreSource: () => CORE, log: () => {} });
}

function child() {
  return { kill() {} };
}

function catalogFromJxaSnapshot({ axWindows = [], cgAll = [], cgOnScreen = [], runningApps = {} }) {
  return catalogWith((file, args, _options, callback) => {
    if (file === "ps") {
      callback(null, "", "");
      return child();
    }
    assert.equal(file, "osascript");
    const jxa = { ObjC: { import() {} } };
    vm.runInNewContext(args[3], jxa);
    const windows = jxa.irisMergeCgWindows(axWindows, cgAll, cgOnScreen, runningApps);
    callback(null, JSON.stringify({ ok: true, windows, front: null }), "");
    return child();
  });
}

function raiseHarness(minimizedValues, { failMain = false } = {}) {
  const events = [];
  let minimizedRead = 0;
  const minimizedAttribute = {};
  Object.defineProperty(minimizedAttribute, "value", {
    get() {
      return () => {
        const index = Math.min(minimizedRead, minimizedValues.length - 1);
        const value = minimizedValues[index];
        minimizedRead += 1;
        events.push(`최소화:${value}`);
        return value;
      };
    },
    set(value) { events.push(`최소화 해제:${value}`); },
  });
  const mainAttribute = {};
  Object.defineProperty(mainAttribute, "value", {
    set(value) {
      events.push(`주 창:${value}`);
      if (failMain) throw new Error("AXMain 없음");
    },
  });
  const win = {
    subrole: () => "AXStandardWindow",
    position: () => [10, 20],
    size: () => [300, 400],
    attributes: {
      byName(name) {
        if (name === "AXMinimized") return minimizedAttribute;
        if (name === "AXMain") return mainAttribute;
        throw new Error(`알 수 없는 속성: ${name}`);
      },
    },
    actions: {
      byName(name) {
        assert.equal(name, "AXRaise");
        return { perform() { events.push("창 올리기"); } };
      },
    },
  };
  const process = {
    unixId: () => 77,
    windows: () => [win],
  };
  Object.defineProperty(process, "frontmost", {
    set(value) { events.push(`앱 앞으로:${value}`); },
  });
  const jxa = {
    ObjC: { import() {} },
    $: { NSThread: { sleepForTimeInterval(value) { events.push(`대기:${value}`); } } },
    Application: () => ({ processes: { whose: () => () => [process] } }),
    core,
  };
  vm.runInNewContext(RUNNER_SRC, jxa);
  return { jxa, events, descriptor: { pid: 77, bounds: [10, 20, 300, 400] } };
}

function otherDesktopRaiseHarness({
  launchServicesAppearsAfter = Infinity,
  spaces = [[11], [501]],
  startIndex = 0,
  transitionFrames = () => [],
  blockedKeyCalls = [],
} = {}) {
  const events = [];
  let cgChecks = 0;
  let spaceIndex = startIndex;
  let pendingMove = null;
  let spaceKeys = 0;
  const minimized = { value: () => { events.push("최소화:false"); return false; } };
  const main = {};
  Object.defineProperty(main, "value", { set(value) { events.push(`주 창:${value}`); } });
  const win = {
    subrole: () => "AXStandardWindow",
    position: () => [40, 50],
    size: () => [700, 500],
    attributes: { byName: (name) => name === "AXMinimized" ? minimized : main },
    actions: { byName: () => ({ perform() { events.push("창 올리기"); } }) },
  };
  const process = { unixId: () => 88, windows: () => [win] };
  Object.defineProperty(process, "frontmost", { set(value) { events.push(`앱 앞으로:${value}`); } });
  const systemEvents = {
    processes: { whose: () => () => [process] },
    keyCode(code, options) {
      assert.equal(options.using, "control down");
      events.push(`공간 키:${code}`);
      spaceKeys += 1;
      if (blockedKeyCalls.includes(spaceKeys)) return;
      const direction = code === 124 ? 1 : -1;
      const nextIndex = Math.max(0, Math.min(spaces.length - 1, spaceIndex + direction));
      if (nextIndex === spaceIndex) return;
      const frames = transitionFrames({
        code,
        from: spaceIndex,
        to: nextIndex,
        spaces,
      });
      pendingMove = { nextIndex, frames: frames.map((ids) => ids.slice()) };
    },
  };
  const jxa = {
    ObjC: { import() {} },
    $: {
      NSThread: { sleepForTimeInterval(value) { events.push(`대기:${value}`); } },
    },
    Application: () => systemEvents,
    core,
  };
  vm.runInNewContext(RUNNER_SRC, jxa);
  jxa.irisCgOnScreenWindowIds = () => {
    cgChecks += 1;
    if (spaceKeys === 0 && cgChecks >= launchServicesAppearsAfter) spaceIndex = spaces.length - 1;
    if (pendingMove && pendingMove.frames.length > 0) {
      const ids = pendingMove.frames.shift();
      events.push(`온스크린:${ids.join(",")}`);
      return ids;
    }
    if (pendingMove) {
      spaceIndex = pendingMove.nextIndex;
      pendingMove = null;
    }
    const ids = spaces[spaceIndex].slice();
    events.push(`온스크린:${ids.join(",")}`);
    return ids;
  };
  return {
    jxa,
    events,
    getSpaceIndex: () => spaceIndex,
    descriptor: { id: 501, cgId: 501, pid: 88, bounds: [40, 50, 700, 500], reachable: "cg" },
  };
}

test("코어 소스 뒤에서 module.exports를 core로 고정한다", () => {
  const source = "/* 코어 원문 \\\"표식\\\" */\nmodule.exports = { assignOrdinals() {} };";
  const script = buildScript(source, "enumerate");
  const sourceAt = script.indexOf(source);
  const coreAt = script.indexOf("var core = module.exports;");

  assert.ok(sourceAt >= 0);
  assert.ok(coreAt > sourceAt + source.length - 1);
  assert.match(script, /function run\(argv\)/);
  assert.match(script, /ObjC\.castRefToObject/);
  assert.match(script, /irisCgWindows\(0\)/);
  assert.match(script, /irisCgWindows\(\$\.kCGWindowListOptionOnScreenOnly\)/);
});

test("CG에만 있는 다른 데스크톱 창도 reachable cg로 정규화해 목록에 세운다", async () => {
  const catalog = catalogWith((file, _args, _options, callback) => {
    if (file === "ps") callback(null, "88 Sun Aug 30 10:20:30 2026\n", "");
    else callback(null, JSON.stringify({ ok: true, windows: [{
      id: 501, cgId: 501, pid: 88, appKey: "com.example.Other", matchApp: "다른 앱",
      matchTitle: "다른 데스크톱", bounds: [900, 40, 700, 500], reachable: "cg", onScreen: false,
      idConfidence: "exact",
    }], front: null }), "");
    return child();
  });

  const listed = await catalog.enumerate();

  assert.equal(listed.windows.length, 1);
  assert.equal(listed.windows[0].reachable, "cg");
  assert.equal(listed.windows[0].onScreen, false);
  assert.equal(listed.windows[0].pidStart, "Sun Aug 30 10:20:30 2026");
});

test("AX 창과 같은 pid·bounds의 CG 창은 AX 정보 하나로 결합한다", () => {
  const jxa = { ObjC: { import() {} }, core };
  vm.runInNewContext(RUNNER_SRC, jxa);
  const ax = {
    id: 11, cgId: 11, pid: 77, appKey: "com.example.Editor", matchApp: "편집기",
    matchTitle: "정확한 AX 제목", displayTitle: "정확한 AX 제목", bounds: [10, 20, 800, 600],
    reachable: "ax", onScreen: true,
  };
  const merged = jxa.irisMergeCgWindows([ax], [
    { cgId: 11, pid: 77, ownerName: "편집기", title: "CG 제목", bounds: [10, 20, 800, 600] },
    { cgId: 12, pid: 77, ownerName: "편집기", title: "다른 데스크톱", bounds: [900, 20, 800, 600] },
  ], [{ cgId: 11, pid: 77, bounds: ax.bounds, z: 0 }], {
    77: { pid: 77, bundleId: "com.example.Editor", name: "편집기", regular: true },
  });

  assert.equal(merged.length, 2);
  assert.equal(merged[0].matchTitle, "정확한 AX 제목");
  assert.equal(merged[0].reachable, "ax");
  assert.deepEqual({ ...merged[1] }, {
    id: 12, cgId: 12, pid: 77, pidStart: "", appKey: "com.example.Editor",
    matchApp: "편집기", matchTitle: "다른 데스크톱", displayApp: "편집기",
    displayTitle: "다른 데스크톱", bounds: [900, 20, 800, 600], minimized: false,
    reachable: "cg", onScreen: false, idConfidence: "exact", z: null,
  });
});

test("일반 앱이 아니거나 실행 앱을 못 찾은 CG 전용 창은 목록에서 뺀다", async () => {
  const catalog = catalogFromJxaSnapshot({
    cgAll: [
      { cgId: 91, pid: 77, ownerName: "일반 앱", title: "일반 창", bounds: [0, 0, 800, 600] },
      { cgId: 92, pid: 88, ownerName: "보조 앱", title: "보조 창", bounds: [0, 0, 800, 600] },
      { cgId: 93, pid: 99, ownerName: "모르는 앱", title: "모르는 창", bounds: [0, 0, 800, 600] },
    ],
    runningApps: {
      77: { pid: 77, bundleId: "com.example.Regular", name: "일반 앱", regular: true },
      88: { pid: 88, bundleId: "com.example.Accessory", name: "보조 앱", regular: false },
    },
  });

  const listed = await catalog.enumerate();

  assert.deepEqual(listed.windows.map((window) => window.cgId), [91]);
});

test("AX 창은 일반 앱·목록 하한·제목 조건과 관계없이 남긴다", async () => {
  const ax = {
    id: -1, cgId: null, pid: 88, appKey: "com.example.Accessory", matchApp: "보조 앱",
    matchTitle: "", displayApp: "보조 앱", displayTitle: "", bounds: [10, 20, 100, 100],
    reachable: "ax", onScreen: false, idConfidence: "none",
  };
  const catalog = catalogFromJxaSnapshot({
    axWindows: [ax],
    cgAll: [
      { cgId: 101, pid: 88, ownerName: "보조 앱", title: "", bounds: ax.bounds },
      { cgId: 102, pid: 77, ownerName: "일반 앱", title: "읽히는 제목", bounds: [0, 0, 800, 600] },
    ],
    runningApps: {
      77: { pid: 77, bundleId: "com.example.Regular", name: "일반 앱", regular: true },
      88: { pid: 88, bundleId: "com.example.Accessory", name: "보조 앱", regular: false },
    },
  });

  const listed = await catalog.enumerate();

  assert.equal(listed.windows.length, 2);
  assert.equal(listed.windows[0].reachable, "ax");
  assert.deepEqual(listed.windows[0].bounds, [10, 20, 100, 100]);
  assert.equal(listed.windows[0].matchTitle, "");
});

test("CG 전용 창은 목록 하한 200×150보다 작으면 뺀다", async () => {
  const catalog = catalogFromJxaSnapshot({
    cgAll: [
      { cgId: 111, pid: 77, ownerName: "일반 앱", title: "폭이 작음", bounds: [0, 0, 199, 500] },
      { cgId: 112, pid: 77, ownerName: "일반 앱", title: "높이가 작음", bounds: [0, 0, 500, 149] },
      { cgId: 113, pid: 77, ownerName: "일반 앱", title: "경계", bounds: [0, 0, 200, 150] },
    ],
    runningApps: {
      77: { pid: 77, bundleId: "com.example.Regular", name: "일반 앱", regular: true },
    },
  });

  const listed = await catalog.enumerate();

  assert.deepEqual(listed.windows.map((window) => window.cgId), [113]);
});

test("CG 전체 목록은 layer 0과 최소 80×60 창만 받는다", () => {
  assert.match(RUNNER_SRC, /kCGWindowLayer"\)\.intValue !== 0/);
  assert.match(RUNNER_SRC, /bounds\[2\] < IRIS_MIN_WINDOW_WIDTH \|\| bounds\[3\] < IRIS_MIN_WINDOW_HEIGHT/);
  assert.match(RUNNER_SRC, /IRIS_MIN_WINDOW_WIDTH = 80/);
  assert.match(RUNNER_SRC, /IRIS_MIN_WINDOW_HEIGHT = 60/);
  // bounds 는 deepUnwrap 으로 읽는다. 필드를 직접 읽으면 kCGWindowBounds 가 없는 항목에서
  // 예외가 나 열거 전체가 실패하고, 확인 결과 직접 읽기가 더 느렸다.
  assert.match(RUNNER_SRC, /irisBounds\(ObjC\.deepUnwrap\(item\.objectForKey\("kCGWindowBounds"\)\)\)/);
  assert.doesNotMatch(RUNNER_SRC, /rawBounds\.objectForKey/);
});

test("CG 전용 목록 필터 계약은 실행 정책·별도 하한만 본문에 두고 제목 판정은 두지 않는다", () => {
  assert.match(RUNNER_SRC, /regular: Number\(app\.activationPolicy\) === 0/);
  assert.match(RUNNER_SRC, /IRIS_MIN_LISTED_WINDOW_WIDTH = 200/);
  assert.match(RUNNER_SRC, /IRIS_MIN_LISTED_WINDOW_HEIGHT = 150/);
  assert.match(RUNNER_SRC, /app\.regular !== true/);
  assert.match(RUNNER_SRC, /cg\.bounds\[2\] < IRIS_MIN_LISTED_WINDOW_WIDTH/);
  assert.match(RUNNER_SRC, /cg\.bounds\[3\] < IRIS_MIN_LISTED_WINDOW_HEIGHT/);
  assert.doesNotMatch(RUNNER_SRC, /canReadCgTitles/);
  assert.doesNotMatch(RUNNER_SRC, /if \([^\n]*title === ""\) continue/);
});

test("열거는 창 속성을 컬렉션으로 읽고 모든 응용 프로세스를 조회하지 않는다", () => {
  assert.match(RUNNER_SRC, /var names = p\.windows\.name\(\);/);
  assert.match(RUNNER_SRC, /var subs = p\.windows\.subrole\(\);/);
  assert.match(RUNNER_SRC, /var poss = p\.windows\.position\(\);/);
  assert.match(RUNNER_SRC, /var sizes = p\.windows\.size\(\);/);
  assert.match(RUNNER_SRC, /se\.processes\.whose\(\{ backgroundOnly: false \}\)\(\)/);
  assert.doesNotMatch(RUNNER_SRC, /applicationProcesses\(\)/);
});

test("최소화 창은 복원 완료를 확인한 뒤 앱과 주 창과 대상 창 순으로 올린다", () => {
  const { jxa, events, descriptor } = raiseHarness([true, true, true, false]);

  assert.equal(jxa.irisRaise(descriptor), true);
  assert.deepEqual(events, [
    "최소화:true",
    "최소화 해제:false",
    "최소화:true",
    "대기:0.05",
    "최소화:true",
    "대기:0.05",
    "최소화:false",
    "앱 앞으로:true",
    "주 창:true",
    "창 올리기",
  ]);
});

test("최소화 복원이 끝나지 않아도 20회 대기 뒤 창 올리기를 시도한다", () => {
  const { jxa, events, descriptor } = raiseHarness([true]);

  assert.equal(jxa.irisRaise(descriptor), true);
  assert.equal(events.filter((event) => event === "대기:0.05").length, 20);
  assert.deepEqual(events.slice(-3), ["앱 앞으로:true", "주 창:true", "창 올리기"]);
});

test("최소화되지 않은 창은 기다리지 않고 AXMain 실패에도 대상 창을 올린다", () => {
  const { jxa, events, descriptor } = raiseHarness([false], { failMain: true });

  assert.equal(jxa.irisRaise(descriptor), true);
  assert.deepEqual(events, ["최소화:false", "앱 앞으로:true", "주 창:true", "창 올리기"]);
});

test("대상이 이미 화면에 있으면 LaunchServices 요청과 대기와 걷기를 모두 건너뛴다", () => {
  const { jxa, events, descriptor } = otherDesktopRaiseHarness({ spaces: [[501]] });

  assert.equal(jxa.irisRaise({ ...descriptor, appKey: "com.example.Editor", matchApp: "편집기" }), true);
  assert.deepEqual(events.filter((event) => event.startsWith("대기:") || event.startsWith("공간 키:")), []);
  assert.deepEqual(events.slice(-4), ["최소화:false", "앱 앞으로:true", "주 창:true", "창 올리기"]);
});

test("걷기 본문은 처음 온스크린 집합으로 한 바퀴를 판정하지 않는다", () => {
  assert.doesNotMatch(RUNNER_SRC, /if \(irisSameCgWindowIds\(initial, current\)\)/);
});

test("LaunchServices 뒤 앞 앱이 바뀌어도 처음 고른 대상 ID를 그대로 올린다", () => {
  const jxa = { ObjC: { import() {} }, core };
  vm.runInNewContext(RUNNER_SRC, jxa);
  const targets = [501, 502].map((id) => ({ id, cgId: id, pid: id }));
  const raised = [];

  const result = jxa.irisStep({
    ordered: [501, 502], cursor: 501, dir: 1, targets,
    launchServices: { targetId: 501, wait: true },
  }, { windows: targets, front: 502 }, (descriptor) => {
    raised.push(descriptor.id);
    return true;
  });

  assert.equal(result.raised, 501);
  assert.deepEqual(raised, [501]);
});

test("대상이 이미 화면에 있어 첫 실행에서 올라가면 open을 전혀 부르지 않는다", async () => {
  const calls = [];
  const catalog = catalogWith((file, args, options, callback) => {
    calls.push({ file, args, options });
    callback(null, JSON.stringify({
      ok: true, raised: 501, resolved: [501], missing: [], front: 501,
    }), "");
    return child();
  });

  assert.equal((await catalog.step({ ordered: [501], targets: [{ id: 501 }] })).raised, 501);
  assert.deepEqual(calls.map((call) => call.file), ["osascript"]);
});

test("enumerate와 step은 서로 다른 제한 시간을 쓴다", async () => {
  const calls = [];
  const catalog = catalogWith((file, args, options, callback) => {
    calls.push({ file, args, options });
    if (args[3].includes('var __irisMode = "enumerate";')) {
      callback(null, JSON.stringify({ ok: true, windows: [], front: null }), "");
    } else {
      callback(null, JSON.stringify({ ok: true, raised: null, resolved: [], missing: [], front: null }), "");
    }
    return child();
  });

  await catalog.enumerate();
  await catalog.step();

  assert.deepEqual(calls.map((call) => call.options), [
    { timeout: 8000, maxBuffer: 1 << 20 },
    { timeout: 45000, maxBuffer: 1 << 20 },
  ]);
});

test("enumerate는 앞 창 ID와 null을 그대로 전달한다", async () => {
  const fronts = [731, null];
  const catalog = catalogWith((_file, _args, _options, callback) => {
    callback(null, JSON.stringify({ ok: true, windows: [], front: fronts.shift() }), "");
    return child();
  });

  assert.equal((await catalog.enumerate()).front, 731);
  assert.equal((await catalog.enumerate()).front, null);
});

test("step은 대상 PID를 argv에 싣고 step 모드로만 실행한다", async () => {
  let call;
  const catalog = catalogWith((file, args, options, callback) => {
    call = { file, args, options };
    callback(null, JSON.stringify({ ok: true, raised: null, resolved: [], missing: [], front: null }), "");
    return child();
  });
  const targets = [{ id: 11, pid: 101 }, { id: 12, pid: 202 }];

  await catalog.step({ ordered: [11, 12], targets });

  const payload = JSON.parse(call.args[4]);
  assert.deepEqual(payload.targets.map((target) => target.pid), [101, 202]);
  assert.equal("resolvedHint" in payload, false);
  assert.match(call.args[3], /var __irisMode = "step";/);
  assert.equal("enumerate" in payload, false);
});

test("T18 제목은 argv로만 가고 매칭 원문과 표시 문자열을 갈라 둔다", async () => {
  const title = `따옴표 " 역슬래시 \\\ 줄바꿈\n이모지 😀${"가".repeat(240)}`;
  const calls = [];
  const catalog = catalogWith((file, args, options, callback) => {
    calls.push({ file, args, options });
    if (file === "ps") {
      callback(null, "12 Sun Aug 30 10:20:30 2026\n", "");
    } else if (calls.filter((call) => call.file === "osascript").length === 1) {
      callback(null, JSON.stringify({ ok: true, windows: [{
        id: "w:1", cgId: 77, pid: 12, pidStart: "",
        appKey: "com.example.앱",
        matchApp: "앱\u0000이름", matchTitle: title,
        displayApp: "신뢰하지 않음", displayTitle: "신뢰하지 않음",
        bounds: [1, 2, 3, 4], idConfidence: "exact",
      }], front: 77 }), "");
    } else {
      callback(null, JSON.stringify({ ok: true, raised: null, resolved: [], missing: ["target-1"], front: null }), "");
    }
    return child();
  });

  const listed = await catalog.enumerate();
  const stepped = await catalog.step({ ordered: ["target-1"], cursor: 0, dir: 1,
    targets: [{ id: "target-1", matchTitle: title }] });

  assert.equal(listed.windows[0].matchTitle, title);
  assert.equal(listed.windows[0].appKey, "com.example.앱");
  assert.equal(listed.windows[0].displayTitle,
    Array.from(title.replace(/[\u0000-\u001f\u007f]/g, "")).slice(0, 200).join(""));
  assert.equal(listed.windows[0].displayApp, "앱이름");
  const stepCall = calls.filter((call) => call.file === "osascript")[1];
  assert.deepEqual(stepCall.args.slice(0, 3), ["-l", "JavaScript", "-e"]);
  assert.equal(stepCall.args[3].includes(title), false);
  assert.equal(JSON.parse(stepCall.args[4]).targets[0].matchTitle, title);
  assert.deepEqual(stepCall.options, { timeout: 45000, maxBuffer: 1 << 20 });
  assert.equal(stepped.ok, true);
});

test("T19 올리기 직전 사라진 창은 missing 성공 응답으로 보존한다", async () => {
  const expected = { ok: true, raised: null, resolved: { pick: null }, missing: ["pick"], front: "front" };
  const catalog = catalogWith((_file, _args, _options, callback) => {
    callback(null, JSON.stringify(expected), "");
    return child();
  });

  assert.deepEqual(await catalog.step({ targets: [{ id: "pick" }] }), expected);
});

test("R10a 이번 snapshot에서 둘째 창이 사라졌으면 한 번에 셋째 창을 올린다", () => {
  const jxa = { ObjC: { import() {} }, core };
  vm.runInNewContext(RUNNER_SRC, jxa);
  const targets = [11, 12, 13].map((id) => ({ id, cgId: id, pid: id }));
  const snapshot = { windows: [targets[0], targets[2]], front: 11 };
  const raised = [];

  const result = jxa.irisStep({ ordered: [11, 12, 13], cursor: null, dir: 1, targets }, snapshot,
    (descriptor) => { raised.push(descriptor.id); return true; });

  assert.equal(result.raised, 13);
  assert.deepEqual(raised, [13]);
  assert.deepEqual(Array.from(result.resolved), [11, 13]);
  assert.deepEqual(Array.from(result.missing), [12]);
});

test("R10a 올리기에 실패한 창을 빼고 같은 입력에서 다음 창을 한 번 더 고른다", () => {
  const jxa = { ObjC: { import() {} }, core };
  vm.runInNewContext(RUNNER_SRC, jxa);
  const targets = [11, 12, 13].map((id) => ({ id, cgId: id, pid: id }));
  const snapshot = { windows: targets, front: 11 };
  const attempted = [];

  const result = jxa.irisStep({ ordered: [11, 12, 13], cursor: null, dir: 1, targets }, snapshot,
    (descriptor) => { attempted.push(descriptor.id); return descriptor.id === 13; });

  assert.equal(result.raised, 13);
  assert.deepEqual(attempted, [12, 13]);
  assert.deepEqual(Array.from(result.resolved), [11, 13]);
  assert.deepEqual(Array.from(result.missing), [12]);
});

test("R6a CG ID 없는 창도 step 사이 제목이 바뀌면 같은 bounds로 찾아 올린다", () => {
  const jxa = { ObjC: { import() {} }, core };
  vm.runInNewContext(RUNNER_SRC, jxa);
  const target = {
    id: -101, cgId: null, pid: 77, pidStart: "Sun Aug 30 10:00:00 2026",
    matchApp: "편집기", matchTitle: "이전 제목", bounds: [10, 20, 300, 400], ordinal: 1,
  };
  const current = {
    id: -202, cgId: null, pid: 77, pidStart: "",
    matchApp: "편집기", matchTitle: "바뀐 제목", bounds: [10, 20, 300, 400], ordinal: 1,
  };
  const raised = [];

  const result = jxa.irisStep({ ordered: [target.id], cursor: null, dir: 1, targets: [target] },
    { windows: [current], front: null }, (descriptor) => { raised.push(descriptor.matchTitle); return true; });

  assert.equal(result.raised, target.id);
  assert.deepEqual(raised, ["바뀐 제목"]);
  assert.deepEqual(Array.from(result.missing), []);
});

test("step은 앞선 대조 우선순위를 쓰고 한 창을 두 대상에 다시 쓰지 않는다", () => {
  const jxa = { ObjC: { import() {} }, core };
  vm.runInNewContext(RUNNER_SRC, jxa);
  const pidStart = "Sun Aug 30 10:00:00 2026";
  const first = {
    id: -101, cgId: null, pid: 77, pidStart,
    matchApp: "편집기", matchTitle: "첫 제목", bounds: [10, 20, 300, 400], ordinal: 1,
  };
  const second = {
    id: -102, cgId: null, pid: 77, pidStart,
    matchApp: "편집기", matchTitle: "둘째 제목", bounds: [900, 20, 300, 400], ordinal: 1,
  };
  const boundsMatch = {
    id: -201, cgId: null, pid: 77, pidStart: "",
    matchApp: "편집기", matchTitle: "바뀐 첫 제목", bounds: first.bounds, ordinal: 1,
  };
  const titleMatch = {
    id: -202, cgId: null, pid: 77, pidStart: "",
    matchApp: "편집기", matchTitle: first.matchTitle, bounds: second.bounds, ordinal: 1,
  };
  const raised = [];

  const result = jxa.irisStep({
    ordered: [first.id, second.id], cursor: null, dir: 1, targets: [first, second],
  }, { windows: [boundsMatch, titleMatch], front: null },
  (descriptor) => { raised.push(descriptor.id); return true; });

  assert.equal(result.raised, first.id);
  assert.deepEqual(raised, [titleMatch.id]);
  assert.deepEqual(Array.from(result.resolved), [first.id]);
  assert.deepEqual(Array.from(result.missing), [second.id]);
});

test("T31 timeout 뒤에는 다음 호출을 시작할 수 있다", async () => {
  let count = 0;
  const catalog = catalogWith((_file, _args, _options, callback) => {
    count += 1;
    if (count === 1) callback(Object.assign(new Error("timed out"), { killed: true }), "", "");
    else callback(null, JSON.stringify({ ok: true, windows: [], front: null }), "");
    return child();
  });

  assert.equal((await catalog.enumerate()).reason, "timeout");
  assert.deepEqual(await catalog.enumerate(), { ok: true, windows: [], front: null });
  assert.equal(count, 2);
});

test("접근성 권한 stderr는 permission으로 접는다", async () => {
  const catalog = catalogWith((_file, _args, _options, callback) => {
    callback(new Error("failed"), "", "System Events got an error: -25211 assistive access disabled");
    return child();
  });

  assert.equal((await catalog.enumerate()).reason, "permission");
});

test("실행 중 cancel은 자식을 죽이고 cancelled로 접는다", async () => {
  let callback;
  let killed = 0;
  const catalog = catalogWith((_file, _args, _options, cb) => {
    callback = cb;
    return { kill() { killed += 1; callback(Object.assign(new Error("killed"), { signal: "SIGTERM" }), "", ""); } };
  });

  const pending = catalog.enumerate();
  await Promise.resolve();
  await Promise.resolve();
  catalog.cancel();
  const result = await pending;

  assert.equal(killed, 1);
  assert.equal(result.reason, "cancelled");
});

test("실행 중인 동안 두 번째 호출은 busy이고 첫 호출 완료 뒤 슬롯이 열린다", async () => {
  let callback;
  const catalog = catalogWith((_file, _args, _options, cb) => {
    callback = cb;
    return child();
  });

  const first = catalog.enumerate();
  assert.equal((await catalog.enumerate()).reason, "busy");
  await Promise.resolve();
  await Promise.resolve();
  callback(null, JSON.stringify({ ok: true, windows: [], front: null }), "");
  assert.equal((await first).ok, true);
});

test("조인 후보가 둘인 스크립트 응답은 안정 ID 없음으로 유지한다", async () => {
  const catalog = catalogWith((file, _args, _options, callback) => {
    if (file === "ps") {
      callback(null, "", "");
      return child();
    }
    callback(null, JSON.stringify({ ok: true, windows: [{
      id: "app:창:1", cgId: null, pid: 41, pidStart: "", matchApp: "앱", matchTitle: "창",
      displayApp: "앱", displayTitle: "창", bounds: [0, 0, 800, 600],
      idConfidence: "none",
    }], front: null }), "");
    return child();
  });

  const result = await catalog.enumerate();
  assert.equal(result.windows[0].cgId, null);
  assert.equal(result.windows[0].idConfidence, "none");
  assert.equal(Number.isInteger(result.windows[0].id), true);
  assert.ok(result.windows[0].id < 0);
});

test("JSON 한 줄이 아니면 parse 실패로 접는다", async () => {
  const catalog = catalogWith((_file, _args, _options, callback) => {
    callback(null, "not-json", "");
    return child();
  });

  assert.equal((await catalog.enumerate()).reason, "parse");
});

test("정규화한 창은 실제 코어에서 bounds 사전순으로 순번을 받는다", async () => {
  const catalog = catalogWith((file, _args, _options, callback) => {
    if (file === "ps") callback(null, "51 Sun Aug 30 11:00:00 2026\n", "");
    else callback(null, JSON.stringify({ ok: true, windows: [
      { cgId: 502, pid: 51, matchApp: "메모", matchTitle: "메모", bounds: [500.4, 50, 400, 300] },
      { cgId: 501, pid: 51, matchApp: "메모", matchTitle: "메모", bounds: [0.4, 50, 400, 300] },
    ], front: null }), "");
    return child();
  });

  const listed = await catalog.enumerate();
  const assigned = core.assignOrdinals(listed.windows);

  assert.deepEqual(listed.windows.map((window) => window.bounds), [
    [500, 50, 400, 300],
    [0, 50, 400, 300],
  ]);
  assert.equal(assigned.find((window) => window.id === 501).ordinal, 1);
  assert.equal(assigned.find((window) => window.id === 502).ordinal, 2);
});

test("정규화한 창은 실제 코어에서 같은 프로세스와 같은 자리로 다시 붙는다", async () => {
  const pidStart = "Sun Aug 30 11:10:00 2026";
  const catalog = catalogWith((file, _args, _options, callback) => {
    if (file === "ps") callback(null, `73 ${pidStart}\n`, "");
    else callback(null, JSON.stringify({ ok: true, windows: [{
      id: "잘못된 ID", cgId: null, pid: 73, matchApp: "편집기", matchTitle: "바뀐 제목",
      bounds: [10.2, 20.4, 300.1, 400.3],
    }], front: null }), "");
    return child();
  });

  const listed = await catalog.enumerate();
  const current = listed.windows[0];
  const state = { version: 1, cursor: null, picked: [{
    id: -1,
    cgId: null,
    pid: 73,
    pidStart,
    matchApp: "편집기",
    matchTitle: "이전 제목",
    ordinal: 1,
    bounds: [10, 20, 300, 400],
    pickKey: "편집기\u001f이전 제목\u001f1",
  }] };

  const result = core.reconcile({ state, windows: listed.windows, phase: "session" });

  assert.equal(result.state.picked.length, 1);
  assert.equal(result.state.picked[0].id, current.id);
  assert.equal(result.state.picked[0].matchTitle, "바뀐 제목");
  assert.equal(result.rows[0].picked, true);
});

test("모든 창 ID는 정수이고 CG ID가 없는 창도 내용이 같으면 ID가 같다", async () => {
  const windows = [
    { id: "무시", cgId: 91, pid: 81, matchApp: "앱", matchTitle: "정확", bounds: [0, 0, 100, 100] },
    { id: "무시", cgId: null, pid: 81, matchApp: "앱", matchTitle: "모호", bounds: [100, 0, 100, 100] },
  ];
  const catalog = catalogWith((file, _args, _options, callback) => {
    if (file === "ps") callback(null, "81 Sun Aug 30 11:20:00 2026\n", "");
    else callback(null, JSON.stringify({ ok: true, windows, front: null }), "");
    return child();
  });

  const first = await catalog.enumerate();
  const second = await catalog.enumerate();

  assert.equal(first.windows.every((window) => Number.isInteger(window.id)), true);
  assert.equal(first.windows[0].id, 91);
  assert.ok(first.windows[1].id < 0);
  assert.equal(first.windows[1].id, second.windows[1].id);

  const jxa = { ObjC: { import() {} } };
  vm.runInNewContext(RUNNER_SRC, jxa);
  const jxaBounds = Array.from(jxa.irisBounds({ X: 100, Y: 0, Width: 100, Height: 100 }));
  assert.deepEqual(jxaBounds, [100, 0, 100, 100]);
  assert.equal(jxa.irisWindowId(null, 81, "모호", jxaBounds), first.windows[1].id);
});

test("같은 snapshot의 fallback ID 충돌만 순번으로 갈라 서로 다른 창 ID를 만든다", () => {
  const jxa = { ObjC: { import() {} }, core };
  vm.runInNewContext(RUNNER_SRC, jxa);
  const duplicateBounds = [10, 20, 300, 400];
  const uniqueBounds = [500, 20, 300, 400];
  const duplicateId = jxa.irisWindowId(null, 81, "같은 제목", duplicateBounds);
  const uniqueId = jxa.irisWindowId(null, 81, "다른 제목", uniqueBounds);
  const windows = [
    { id: duplicateId, cgId: null, pid: 81, matchApp: "앱", matchTitle: "같은 제목", bounds: duplicateBounds },
    { id: duplicateId, cgId: null, pid: 81, matchApp: "앱", matchTitle: "같은 제목", bounds: duplicateBounds },
    { id: uniqueId, cgId: null, pid: 81, matchApp: "앱", matchTitle: "다른 제목", bounds: uniqueBounds },
  ];

  const snapshot = jxa.irisAssignSnapshotIds(windows, duplicateId);

  assert.notEqual(snapshot.windows[0].id, snapshot.windows[1].id);
  assert.equal(snapshot.windows[2].id, uniqueId);
  assert.equal(snapshot.front, snapshot.windows[0].id);
});

test("pid 시작 시각은 한 번의 ps 호출로 채우고 실패해도 열거를 살린다", async () => {
  const windows = [
    { cgId: 1, pid: 101, matchApp: "가", matchTitle: "하나", bounds: [0, 0, 10, 10] },
    { cgId: 2, pid: 102, matchApp: "나", matchTitle: "둘", bounds: [10, 0, 10, 10] },
    { cgId: 3, pid: 101, matchApp: "가", matchTitle: "셋", bounds: [20, 0, 10, 10] },
  ];
  const calls = [];
  const catalog = catalogWith((file, args, _options, callback) => {
    calls.push({ file, args });
    if (file === "ps") callback(null,
      "101 Sun Aug 30 12:00:00 2026\n102 Sun Aug 30 12:01:00 2026\n", "");
    else callback(null, JSON.stringify({ ok: true, windows, front: null }), "");
    return child();
  });

  const listed = await catalog.enumerate();
  const psCalls = calls.filter((call) => call.file === "ps");

  assert.equal(psCalls.length, 1);
  assert.deepEqual(psCalls[0].args, ["-o", "pid=,lstart=", "-p", "101,102"]);
  assert.deepEqual(listed.windows.map((window) => window.pidStart), [
    "Sun Aug 30 12:00:00 2026",
    "Sun Aug 30 12:01:00 2026",
    "Sun Aug 30 12:00:00 2026",
  ]);

  const failing = catalogWith((file, _args, _options, callback) => {
    if (file === "ps") callback(new Error("ps 실패"), "", "ps 실패");
    else callback(null, JSON.stringify({ ok: true, windows: [windows[0]], front: null }), "");
    return child();
  });
  const survived = await failing.enumerate();

  assert.equal(survived.ok, true);
  assert.equal(survived.windows[0].pidStart, "");
});

// 소스에 그 글자가 있는가는 그 코드가 그렇게 도는가와 다른 사실이다.
// JXA 스크립트를 실제로 돌려서 판정한다. osascript 가 주는 것들만 가짜로 세워 준다.
function loadRaiser() {
  const source = buildScript(readFileSync(CORE_PATH, "utf8"), "step");
  const prelude = `
    var __clock = 0;
    var $ = function (value) { return value; };
    $.NSThread = { sleepForTimeInterval: function (s) { __clock += s; } };
    $.NSDate = { get date() { return { timeIntervalSince1970: __clock }; } };
    $.NSWorkspace = { sharedWorkspace: { runningApplications: { count: 0 } } };
    var __desk = { current: 1, order: [1, 2, 3], ofWindow: {}, keyWorks: true, bindWorks: true };
    $.CGSMainConnectionID = function () { return 7; };
    $.CGSCopyManagedDisplaySpaces = function () {
      return [{ Spaces: __desk.order.map(function (id) { return { ManagedSpaceID: id }; }) }];
    };
    $.CGSCopySpacesForWindows = function (cid, mask, ids) {
      var space = __desk.ofWindow[String(ids[0])];
      if (space == null) return { count: 0, objectAtIndex: function () { return null; } };
      return { count: 1, objectAtIndex: function () { return { intValue: space }; } };
    };
    $.CGSCopyManagedDisplayForSpace = function () { return "화면"; };
    $.CGSManagedDisplayGetCurrentSpace = function () { return __desk.current; };

    $.kCGWindowListOptionOnScreenOnly = 1;
    $.kCGNullWindowID = 0;
    $.CGWindowListCopyWindowInfo = function () { return null; };
    ObjC = { import: function () {}, castRefToObject: function () { return { count: 0 }; },
             deepUnwrap: function (v) { return v; },
             bindFunction: function (name) { if (!__desk.bindWorks) throw new Error("심볼 없음 " + name); } };
    var __keys = [];
    function Application() {
      return {
        keyCode: function (code) {
          __keys.push(code);
          if (!__desk.keyWorks) return;
          var at = __desk.order.indexOf(__desk.current);
          if (at < 0) return;
          var next = code === 124 ? at + 1 : at - 1;
          if (next >= 0 && next < __desk.order.length) __desk.current = __desk.order[next];
        },
        processes: { byName: function () { return {}; } },
      };
    }
  `;
  const tail = `
    return {
      raise: function (d) { return irisRaise(d); },
      clock: function () { return __clock; },
      setOnScreen: function (f) { irisCgOnScreenWindowIds = f; },
      setRaiseAx: function (f) { irisRaiseAx = f; },
      desk: function () { return __desk; },
      resetClock: function () { __clock = 0; },
      keys: function () { return __keys.slice(); },
      step: function (input, snapshot, raiseWindow) { return irisStep(input, snapshot, raiseWindow); },
      processWindows: function (p, cgAll, cgOnScreen) { return irisProcessWindows(p, cgAll, cgOnScreen); },
    };
  `;
  return new Function(`${prelude}\n${source}\n${tail}`)();
}

const target = { reachable: "cg", cgId: 110, appKey: "com.example.app", matchApp: "예시" };

test("이미 이 데스크톱에 있으면 옮기지 않고 그 자리에서 그 창을 지목한다", () => {
  const r = loadRaiser();
  let raised = 0;
  r.setOnScreen(() => [110]);
  r.setRaiseAx(() => { raised += 1; return true; });
  assert.equal(r.raise(target), true);
  assert.deepEqual(r.keys(), [], "화면에 있는 창 때문에 데스크톱을 옮기면 안 된다");
  assert.equal(raised, 1);
});

test("한 칸 오른쪽이면 오른쪽으로 딱 한 번 누른다", () => {
  const r = loadRaiser();
  const d = r.desk();
  d.current = 1;
  d.ofWindow["110"] = 2;
  r.setOnScreen(() => (d.current === 2 ? [110] : [999]));
  r.setRaiseAx(() => true);
  assert.equal(r.raise(target), true);
  assert.deepEqual(r.keys(), [124]);
});

test("왼쪽이면 왼쪽으로 누른다", () => {
  const r = loadRaiser();
  const d = r.desk();
  d.current = 3;
  d.ofWindow["110"] = 2;
  r.setOnScreen(() => (d.current === 2 ? [110] : [999]));
  r.setRaiseAx(() => true);
  assert.equal(r.raise(target), true);
  assert.deepEqual(r.keys(), [123]);
});

// 목적지를 모른 채 훑으며 찾는 방식은 사용자를 엉뚱한 데스크톱으로 보낸다. 지금은 칸 수를
// 세어 그 수만큼만 누른다.
test("두 칸이면 두 번만 누른다", () => {
  const r = loadRaiser();
  const d = r.desk();
  d.current = 1;
  d.ofWindow["110"] = 3;
  r.setOnScreen(() => (d.current === 3 ? [110] : [999]));
  r.setRaiseAx(() => true);
  assert.equal(r.raise(target), true);
  assert.deepEqual(r.keys(), [124, 124]);
  assert.equal(d.current, 3, "지나치지도 모자라지도 않는다");
});

test("첫 칸에서 안 움직이면 더 누르지 않고 그 사유로 끝낸다", () => {
  const r = loadRaiser();
  const d = r.desk();
  d.current = 1;
  d.ofWindow["110"] = 3;
  d.keyWorks = false;
  r.setOnScreen(() => [999]);
  r.setRaiseAx(() => true);
  assert.deepEqual(r.raise(target), { ok: false, reason: "desktop-switch-failed" });
  assert.deepEqual(r.keys(), [124], "안 먹는 키를 계속 누르면 사람 화면만 흔든다");
  assert.equal(d.current, 1, "못 갔으면 있던 자리에 그대로 둔다");
});

test("데스크톱 번호를 못 읽으면 아무 키도 안 누른다", () => {
  const r = loadRaiser();
  r.desk().current = 1;
  r.setOnScreen(() => [999]);
  r.setRaiseAx(() => true);
  assert.deepEqual(r.raise(target), { ok: false, reason: "desktop-unknown" });
  assert.deepEqual(r.keys(), [], "모르는 자리로 사람을 옮기면 안 된다");
});

test("데스크톱 함수를 못 부르면 아무 키도 안 누른다", () => {
  const r = loadRaiser();
  const d = r.desk();
  d.bindWorks = false;
  d.ofWindow["110"] = 2;
  r.setOnScreen(() => [999]);
  r.setRaiseAx(() => true);
  assert.deepEqual(r.raise(target), { ok: false, reason: "desktop-unknown" });
  assert.deepEqual(r.keys(), []);
});

test("갔는데 그 창이 안 뜨면 못 잡았다고 적는다", () => {
  const r = loadRaiser();
  const d = r.desk();
  d.current = 1;
  d.ofWindow["110"] = 2;
  r.setOnScreen(() => [999]);
  r.setRaiseAx(() => true);
  assert.deepEqual(r.raise(target), { ok: false, reason: "window-out-of-reach" });
  assert.deepEqual(r.keys(), [124], "칸 수만큼만 누르고 더 헤매지 않는다");
});

test("도착한 뒤에 그 창을 지목한다", () => {
  const r = loadRaiser();
  const d = r.desk();
  d.current = 1;
  d.ofWindow["110"] = 2;
  const order = [];
  r.setOnScreen(() => { order.push("본다"); return d.current === 2 ? [110] : [999]; });
  r.setRaiseAx(() => { order.push("지목"); return true; });
  assert.equal(r.raise(target), true);
  assert.equal(order[order.length - 1], "지목", "마지막 행동은 그 창을 지목하는 것이다");
});

test("실패해도 상한 안에서 끝난다", () => {
  const r = loadRaiser();
  const d = r.desk();
  d.current = 1;
  d.ofWindow["110"] = 2;
  r.setOnScreen(() => [999]);
  r.setRaiseAx(() => true);
  r.raise(target);
  assert.ok(r.clock() <= 3, `기다린 시간이 ${r.clock()}초 — 상한을 넘었다`);
});

// 다시 들어오면 안 되는 셋.
//   CGSManagedDisplaySetCurrentSpace  WindowServer 만 바꾸고 Dock 에는 안 알린다. 다른
//     데스크톱 창이 겹쳐 보인다.
//   open 으로 앱 열기                 창 다섯이 같은 번들 id 라 엉뚱한 창으로 간다.
//   훑어서 찾는 걷기                  목적지를 모른 채 눌러서 엉뚱한 데스크톱으로 간다.
test("화면을 망가뜨리거나 헤매는 수단이 없다", () => {
  const source = buildScript("module.exports = {};", "step");
  for (const gone of ["CGSManagedDisplaySetCurrentSpace", "irisGoToDesktop",
    "irisOpenApp", "NSTask", "/usr/bin/open", "launchPath",
    "irisWalkToWindow", "irisWalkOneWay", "irisScanOneSpace", "IRIS_SPACE_MOVE_LIMIT"]) {
    assert.ok(!source.includes(gone), `${gone} 이 남아 있다`);
  }
  for (const shell of ["/bin/sh", "doShellScript", "NSAppleScript"]) {
    assert.ok(!source.includes(shell), `${shell} 이 남아 있다`);
  }
});

// 우리 앱 자기 창은 스크립트가 올리지 않고 지정만 한다. 이 분기가 빠지면 그 창들에서
// 순환이 멈춘다(고른 셋 중 둘이 Iris 창이면 아무 데도 가지 못한다).
function stepWith({ ownPid, pids }) {
  const r = loadRaiser();
  const windows = pids.map((pid, i) => ({
    id: 100 + i, cgId: 100 + i, pid, pidStart: "s", matchApp: "앱" + i, matchTitle: "창" + i,
    bounds: [0, 0, 900, 700], reachable: "cg", onScreen: false, ordinal: 1,
  }));
  const targets = windows.map((w) => ({ ...w }));
  const raisedBy = [];
  const out = r.step(
    { ordered: windows.map((w) => w.id), targets, cursor: null, dir: 1, ownPid },
    { windows, front: null },
    (descriptor) => { raisedBy.push(descriptor.cgId); return true; },
  );
  return { out, raisedBy };
}

// 위 셋은 스크립트에 ownPid 가 도착했을 때의 행동을 검사한다. 도착하지 못하면 그 셋은
// 전부 통과하면서 기능은 동작하지 않는다. catalog.step 이 인자를 풀어 다시 담으면서
// ownPid 를 빠뜨려도, 호스트 쪽 검사는 호스트가 catalog 에 넘겼는지까지만 본다.
// 그 사이를 검사하는 것이 없어 여기서 본다.
test("ownPid 가 스크립트 인자까지 실려 간다", () => {
  let payload = null;
  const catalog = catalogWith((file, args, _options, callback) => {
    if (file === "ps") { callback(null, "", ""); return child(); }
    payload = JSON.parse(args[4]);
    callback(null, JSON.stringify({ ok: true, raised: null, resolved: [], missing: [], front: null }), "");
    return child();
  });
  return catalog.step({ ordered: [1], cursor: null, dir: 1, targets: [{ id: 1 }], ownPid: 4242 })
    .then(() => {
      assert.ok(payload, "스크립트를 안 불렀다");
      assert.equal(payload.ownPid, 4242,
        "ownPid 가 스크립트까지 안 갔다 — 우리 창을 osascript 로 올리려 들고 화면은 그대로가 된다");
    });
});

// 앞 창의 번호가 그 창의 번호와 다르면, 앞 창이 늘 목록 밖으로 보여 첫 창만 되풀이된다.
// 겹쳐 있는 두 창(같은 pid·같은 위치) 때문에 cgId 를 고르지 못하는데, 그 판정을 두 목록에서
// 따로 하면(행은 전체 목록, 앞 창은 화면에 보이는 목록) 한쪽만 둘이 될 때 같은 창이 서로
// 다른 번호를 받는다.
function axProcess({ titles, bounds }) {
  // 함수의 name 은 못 바꾸므로 목록 접근자는 평범한 객체로 만든다.
  const wins = {
    name: () => titles,
    subrole: () => titles.map(() => "AXStandardWindow"),
    position: () => bounds.map((b) => [b[0], b[1]]),
    size: () => bounds.map((b) => [b[2], b[3]]),
  };
  return {
    windows: wins,
    unixId: () => 77,
    name: () => "겹친앱",
    bundleIdentifier: () => "com.example.overlap",
    frontmost: () => true,
  };
}

test("앞 창의 번호는 그 창의 번호와 같다", () => {
  const r = loadRaiser();
  const B = [10, 20, 800, 600];
  // 같은 pid·같은 위치에 창이 둘이다. 전체 목록에서는 못 고르고, 화면 목록에는 하나만 있다.
  const cgAll = [
    { cgId: 501, pid: 77, bounds: B },
    { cgId: 502, pid: 77, bounds: B },
  ];
  const cgOnScreen = [{ cgId: 501, pid: 77, bounds: B }];
  const out = r.processWindows(axProcess({ titles: ["앞창", "뒷창"], bounds: [B, B] }), cgAll, cgOnScreen);
  assert.equal(out.windows.length, 2);
  assert.equal(out.front, out.windows[0].id,
    "앞 창의 번호가 그 창의 번호와 다르다 — 목록 밖으로 보여 첫 창만 되풀이된다");
});

test("앞 창을 고른 목록의 번호로 옮긴다", () => {
  // 스냅샷의 번호와 고른 목록의 번호는 다른 실행에서 만들어져 값이 다를 수 있다. 옮기지 않으면
  // 앞 창이 목록 밖으로 보이고, 그러면 커서를 무시하고 첫 창부터 고른다(R9).
  const r = loadRaiser();
  const mk = (id, title) => ({
    id, cgId: null, pid: 77, pidStart: "s", matchApp: "앱", matchTitle: title,
    bounds: [0, 0, 900, 700], reachable: "cg", onScreen: false, ordinal: 1,
  });
  const windows = [mk(100, "창A"), mk(200, "창B")];
  const targets = [{ ...mk(900, "창A") }, { ...mk(901, "창B") }];
  const raised = [];
  const out = r.step(
    { ordered: [900, 901], targets, cursor: null, dir: 1 },
    { windows, front: 100 },                      // 스냅샷 번호로 준 앞 창 = 창A
    (d) => { raised.push(d.matchTitle); return true; },
  );
  assert.equal(out.raised, 901, "앞 창 다음이 아니라 첫 창으로 갔다");
  assert.deepEqual(raised, ["창B"]);
  assert.equal(out.front, 900, "돌려주는 앞 창도 고른 목록의 번호여야 한다");
});

test("우리 pid 의 창은 스크립트가 올리지 않고 id 만 돌려준다", () => {
  const { out, raisedBy } = stepWith({ ownPid: 777, pids: [777, 888] });
  assert.equal(out.own, 100, "우리 창 id 를 짚어야 한다");
  assert.equal(out.raised, null);
  assert.equal(raisedBy.length, 0, "스크립트가 우리 창을 올리려 들면 안 된다");
});

test("남의 pid 창은 지금까지처럼 스크립트가 올린다", () => {
  const { out, raisedBy } = stepWith({ ownPid: 777, pids: [888, 999] });
  assert.equal(out.own, undefined);
  assert.equal(out.raised, 100);
  assert.deepEqual(raisedBy, [100]);
});

test("ownPid 를 안 넘기면 우리 창도 스크립트가 올린다", () => {
  const { out, raisedBy } = stepWith({ ownPid: undefined, pids: [777, 888] });
  assert.equal(out.own, undefined);
  assert.deepEqual(raisedBy, [100]);
});

test("한 창이 막혀도 순환은 다음 창으로 넘어간다", () => {
  const r = loadRaiser();
  const windows = [110, 220].map((id, i) => ({
    id, cgId: id, pid: 900 + i, pidStart: "s", matchApp: "앱" + i, matchTitle: "창" + i,
    bounds: [0, 0, 900, 700], reachable: "cg", onScreen: false, ordinal: 1,
  }));
  const tried = [];
  const out = r.step(
    { ordered: [110, 220], targets: windows.map((w) => ({ ...w })), cursor: null, dir: 1 },
    { windows, front: null },
    (descriptor) => {
      tried.push(descriptor.cgId);
      return descriptor.cgId === 110 ? { ok: false, reason: "window-out-of-reach" } : true;
    },
  );
  assert.deepEqual(tried, [110, 220], "막힌 창에서 멈추면 안 된다");
  assert.equal(out.raised, 220);
  assert.ok(out.missing.some((m) => m && m.id === 110 && m.reason === "window-out-of-reach"),
    "막힌 사실은 그대로 적어야 한다");
});
