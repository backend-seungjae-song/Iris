// 창 전환 host의 저장·등록·IPC·직렬 실행 수명을 가짜 경계로 검증한다.
//
// 소유 범위
//   메모리 fs·전역 단축키·catalog·timer를 주입해 B3의 상태 변화와 외부 효과를 관찰하는 카드.
//
// 제공 API
//   node --test test/switcher-host.mjs 한 명령으로 B3 host 계약을 판정한다.
//
// 의존 대상
//   switcher-host.cjs의 주입 API와 switcher-core.cjs의 저장 모형만 쓰며 Electron·osascript는 띄우지 않는다.
//
// 유지 조건
//   신뢰 판정은 모든 효과보다 먼저이고, 저장 경로·개별 해제·순차 step·재시작 두 차례를 외부 효과로 센다.
//
// 영향 범위
//   공급자는 B3 host와 순수 core이고, 소비자는 B4·B5가 쓸 ac-window-switcher IPC와 상태 방송 계약이다.
//   지금 목록은 이걸로 센다: node bin/importers.mjs test/switcher-host.mjs

import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const core = require("../native/electron/switcher-core.cjs");
const { createSwitcherHost } = require("../native/electron/switcher-host.cjs");

const HOME = "/가짜-상태";
const STATE = path.join(HOME, "window-switcher.json");
const BACKUP = STATE + ".bak";
const KEYMAP = path.join(HOME, "keymap.json");
const DEFAULT_RELAY = {
  "screen-toggle": { alt: true, code: "Tab" },
  "pick-toggle": { mod: true, shift: true, key: "e" },
};

function window(overrides = {}) {
  return {
    id: 101, cgId: 101, pid: 77, pidStart: "Sun Aug 30 10:00:00 2026",
    matchApp: "메모", matchTitle: "한 장", displayApp: "메모", displayTitle: "한 장",
    ordinal: 1, bounds: [0, 0, 800, 600], idConfidence: "exact", ...overrides,
  };
}

function stored(overrides = {}) {
  return core.serialize({ version: 1, cursor: null, picked: [window(overrides)] });
}

function memoryFs(initial = {}) {
  const files = new Map(Object.entries(initial).map(([name, value]) => [name, String(value)]));
  const writes = [];
  // 진단 파일은 잃어도 되는 기록이라 "덮지 않는다" 계약의 대상이 아니다. 검사 범위를 좁힌다.
  writes.state = () => writes.filter((name) => !String(name).includes("-diag."));
  return {
    files, writes,
    readFileSync(name) {
      if (!files.has(name)) throw Object.assign(new Error("없음"), { code: "ENOENT" });
      return files.get(name);
    },
    writeFileSync(name, value) { writes.push(name); files.set(name, String(value)); },
    renameSync(from, to) {
      if (!files.has(from)) throw Object.assign(new Error("없음"), { code: "ENOENT" });
      files.set(to, files.get(from)); files.delete(from);
    },
    mkdirSync() {},
  };
}

function fakeShortcuts(registerResult = () => true) {
  const callbacks = new Map();
  const registered = [];
  const unregistered = [];
  let unregisterAll = 0;
  return {
    callbacks, registered, unregistered,
    register(accelerator, callback) {
      registered.push(accelerator);
      const ok = registerResult(accelerator);
      if (ok) callbacks.set(accelerator, callback);
      return ok;
    },
    unregister(accelerator) { unregistered.push(accelerator); callbacks.delete(accelerator); },
    unregisterAll() { unregisterAll += 1; },
    isRegistered(accelerator) { return callbacks.has(accelerator); },
    get unregisterAllCount() { return unregisterAll; },
  };
}

function fakeTimers() {
  const timeouts = [];
  const intervals = [];
  return {
    timeouts, intervals,
    setTimeout(fn, ms) { const item = { fn, ms, unref() {} }; timeouts.push(item); return item; },
    clearTimeout(item) { const found = timeouts.indexOf(item); if (found >= 0) timeouts.splice(found, 1); },
    setInterval(fn, ms) { const item = { fn, ms, unref() {} }; intervals.push(item); return item; },
    clearInterval(item) { const found = intervals.indexOf(item); if (found >= 0) intervals.splice(found, 1); },
  };
}

function setup(options = {}) {
  const fs = options.fs || memoryFs();
  const shortcuts = options.shortcuts || fakeShortcuts();
  const timers = options.timers || fakeTimers();
  const broadcasts = [];
  const catalog = options.catalog || {
    async enumerate() { return { ok: true, windows: options.windows || [window()] }; },
    async step({ ordered, dir }) { return { ok: true, raised: dir === 1 ? ordered[0] : ordered.at(-1), resolved: ordered, missing: [], front: null }; },
    cancel() {},
  };
  const iconRunner = options.iconRunner || {
    async icons({ appKeys }) {
      return { icons: {}, missing: appKeys.map((appKey) => ({ appKey, reason: "not-found" })) };
    },
    cancel() {},
  };
  const mediaRunner = options.mediaRunner || {
    permission() {
      return options.screenPermission ? options.screenPermission() : "not-determined";
    },
    async thumbnails({ targets }) {
      const permission = this.permission();
      return {
        permission,
        thumbs: {},
        missing: targets.map((item) => ({
          id: item.id,
          reason: permission === "granted" ? "not-found" : "permission",
        })),
        elapsedMs: 0,
      };
    },
    async titles() {
      return { ok: false, titles: {}, elapsedMs: 0, reason: "permission" };
    },
  };
  const opened = [];
  const host = createSwitcherHost({
    core, catalog, iconRunner, mediaRunner, fs, path, stateHome: () => HOME, globalShortcut: shortcuts,
    defaultRelay: DEFAULT_RELAY, killProbe: options.killProbe || (() => true),
    raiseOwnWindow: options.raiseOwnWindow, ownPid: options.ownPid,
    isTrustedSender: (event, expected) => event?.trusted === true && expected === "http://iris.test",
    isTrustedMediaSender: options.isTrustedMediaSender || ((event) => event?.trusted === true),
    expectedAppUrl: "http://iris.test", broadcast: (payload) => broadcasts.push(payload),
    shell: { async openExternal(url) { opened.push(url); } },
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval, clearInterval: timers.clearInterval,
    now: options.now,
  });
  return { host, fs, shortcuts, timers, catalog, iconRunner, mediaRunner, broadcasts, opened };
}

const trusted = { trusted: true };

async function refresh(host) {
  return host.handle(trusted, { op: "list", refresh: true });
}

test("제목 없는 CG 행이 없으면 앱 제목 조회를 건너뛴다", async () => {
  let calls = 0;
  const { host } = setup({
    windows: [window({ reachable: "cg" }), window({ id: 202, cgId: null, reachable: "ax", matchTitle: "" })],
    mediaRunner: {
      async titles() { calls += 1; return { ok: true, titles: {}, elapsedMs: 1 }; },
    },
  });

  await refresh(host);

  assert.equal(calls, 0);
  assert.equal(host.getStatus().titleLookupMs, 0);
});

test("제목 없는 CG 행은 한 번 조회해 매칭 제목과 표시 제목을 채운다", async () => {
  const calls = [];
  const { host } = setup({
    windows: [window({ id: 202, cgId: 202, reachable: "cg", matchTitle: "", displayTitle: "" })],
    mediaRunner: {
      async titles(input) {
        calls.push(input);
        return { ok: true, titles: { 202: "다른 데스크톱" }, elapsedMs: 17 };
      },
    },
  });

  const listed = await refresh(host);

  assert.deepEqual(calls, [{ ids: [202] }]);
  assert.equal(listed.windows[0].matchTitle, "다른 데스크톱");
  assert.equal(listed.windows[0].displayTitle, "다른 데스크톱");
  assert.equal(listed.status.titleLookupMs, 17);
});

test("앱 제목 조회 실패는 열거를 실패시키지 않는다", async () => {
  const { host } = setup({
    windows: [window({ reachable: "cg", matchTitle: "", displayTitle: "" })],
    mediaRunner: {
      async titles() { return { ok: false, titles: {}, elapsedMs: 9, reason: "capture-failed" }; },
    },
  });

  const listed = await refresh(host);

  assert.equal(listed.windows.length, 1);
  assert.equal(listed.windows[0].matchTitle, "");
  assert.equal(listed.status.titleLookupMs, 9);
});

test("제목 보강 뒤에도 빈 CG 행만 빼고 AX 행은 남긴다", async () => {
  const windows = [
    window({ id: 201, cgId: 201, reachable: "cg", matchTitle: "", displayTitle: "" }),
    window({ id: 202, cgId: 202, reachable: "cg", matchTitle: "", displayTitle: "" }),
    window({ id: 303, cgId: null, reachable: "ax", matchTitle: "", displayTitle: "" }),
  ];
  const { host } = setup({
    windows,
    mediaRunner: {
      async titles() { return { ok: true, titles: { 201: "읽히는 제목" }, elapsedMs: 4 }; },
    },
  });

  const listed = await refresh(host);

  assert.deepEqual(listed.windows.map((item) => item.id), [201, 303]);
  assert.equal(listed.windows[0].matchTitle, "읽히는 제목");
  assert.equal(listed.windows[1].reachable, "ax");
});

test("CG 제목이 전부 빈 결과에서는 어떤 CG 행도 빼지 않는다", async () => {
  const windows = [
    window({ id: 201, cgId: 201, reachable: "cg", matchTitle: "", displayTitle: "" }),
    window({ id: 202, cgId: 202, reachable: "cg", matchTitle: "", displayTitle: "" }),
    window({ id: 303, cgId: null, reachable: "ax", matchTitle: "AX 제목", displayTitle: "AX 제목" }),
  ];
  const { host } = setup({
    windows,
    mediaRunner: {
      async titles() { return { ok: true, titles: {}, elapsedMs: 3 }; },
    },
  });

  const listed = await refresh(host);

  assert.deepEqual(listed.windows.map((item) => item.id), [201, 202, 303]);
});

test("T5 체크가 0개면 전역 단축키를 등록하지 않는다", () => {
  const { host, shortcuts } = setup();
  host.start();
  assert.equal(shortcuts.isRegistered("Alt+Tab"), false);
  assert.deepEqual(host.getStatus().registered, { next: false, prev: false });
});

test("T13·T24 마지막 체크 해제는 자기 가속기만 풀고 픽 단축키를 보존한다", async () => {
  const fs = memoryFs({ [STATE]: JSON.stringify(stored()) });
  const { host, shortcuts } = setup({ fs });
  host.start();
  await host.handle(trusted, { op: "unpick", pickKey: core.deserialize(fs.files.get(STATE)).picked[0].pickKey });

  assert.deepEqual(shortcuts.unregistered.sort(), ["Alt+Shift+Tab", "Alt+Tab"].sort());
  assert.equal(shortcuts.unregisterAllCount, 0);
  assert.equal(shortcuts.isRegistered("CommandOrControl+Shift+E"), false);
});

test("T14 사용자 재지정은 다음·이전 가속기에 같은 기본 modifier를 반영한다", () => {
  const fs = memoryFs({
    [STATE]: JSON.stringify(stored()),
    [KEYMAP]: JSON.stringify({ "screen-toggle": { mod: true, alt: true, code: "Tab" } }),
  });
  const { host, shortcuts } = setup({ fs });
  host.start();

  assert.equal(shortcuts.isRegistered("CommandOrControl+Alt+Tab"), true);
  assert.equal(shortcuts.isRegistered("CommandOrControl+Alt+Shift+Tab"), true);
  assert.equal(shortcuts.registered.includes("Alt+Tab"), false);
});

test("R4a 화살표·스페이스와 Electron이 허용한 키를 전역 가속기로 바꾼다", () => {
  const cases = [
    [" ", "Space"], ["Escape", "Escape"], ["Enter", "Return"],
    ["Backspace", "Backspace"], ["Delete", "Delete"], ["Insert", "Insert"],
    ["Home", "Home"], ["End", "End"], ["PageUp", "PageUp"], ["PageDown", "PageDown"],
    ["ArrowUp", "Up"], ["ArrowDown", "Down"], ["ArrowLeft", "Left"], ["ArrowRight", "Right"],
    ["-", "-"], ["=", "="], ["[", "["], ["]", "]"], ["\\", "\\"],
    [";", ";"], ["'", "'"], [",", ","], [".", "."], ["/", "/"],
  ];

  for (const [key, acceleratorKey] of cases) {
    const fs = memoryFs({
      [STATE]: JSON.stringify(stored()),
      [KEYMAP]: JSON.stringify({ "screen-toggle": { alt: true, key } }),
    });
    const { host, shortcuts } = setup({ fs });
    host.start();
    assert.equal(shortcuts.registered.includes(`Alt+${acceleratorKey}`), true, key);
  }
});

test("R4a 전역 가속기로 바꿀 수 없는 키는 지원 불가 사유를 남긴다", () => {
  const fs = memoryFs({
    [STATE]: JSON.stringify(stored()),
    [KEYMAP]: JSON.stringify({ "screen-toggle": { alt: true, key: "한글키" } }),
  });
  const { host, shortcuts, broadcasts } = setup({ fs });
  host.start();

  assert.deepEqual(shortcuts.registered, []);
  assert.deepEqual(host.getStatus().registerError, { next: "unsupported", prev: "unsupported" });
  assert.deepEqual(broadcasts.at(-1).registerError, { next: "unsupported", prev: "unsupported" });
});

test("T17 한 방향 등록 실패가 체크 목록과 다른 방향을 없애지 않는다", () => {
  const fs = memoryFs({ [STATE]: JSON.stringify(stored()) });
  const shortcuts = fakeShortcuts((accelerator) => accelerator !== "Alt+Tab");
  const { host } = setup({ fs, shortcuts });
  host.start();

  assert.equal(host.getStatus().registered.next, false);
  assert.equal(host.getStatus().registered.prev, true);
  assert.equal(core.deserialize(fs.files.get(STATE)).picked.length, 1);
});

test("keymap 변경은 등록에 성공했던 방향만 풀고 새 가속기로 다시 묶는다", () => {
  const fs = memoryFs({ [STATE]: JSON.stringify(stored()) });
  const shortcuts = fakeShortcuts((accelerator) => accelerator !== "Alt+Shift+Tab");
  const { host } = setup({ fs, shortcuts });
  host.start();
  fs.files.set(KEYMAP, JSON.stringify({ "screen-toggle": { mod: true, alt: true, code: "Tab" } }));
  host.keymapChanged();

  assert.deepEqual(shortcuts.unregistered, ["Alt+Tab"]);
  assert.equal(shortcuts.isRegistered("CommandOrControl+Alt+Tab"), true);
  assert.equal(shortcuts.isRegistered("CommandOrControl+Alt+Shift+Tab"), true);
});

test("T21·T23·T27 pick은 전용 상태 파일에 즉시 원자 저장하고 등록한다", async () => {
  const { host, fs, shortcuts } = setup();
  host.start();
  await refresh(host);
  const result = await host.handle(trusted, { op: "pick", id: 101 });

  assert.equal(result.picked.length, 1);
  assert.equal(core.deserialize(fs.files.get(STATE)).picked.length, 1);
  assert.equal(fs.files.has(STATE + ".tmp"), false);
  assert.equal(fs.writes.some((name) => name === path.join(HOME, "ui-state.json")), false);
  assert.equal([...fs.files.keys()].some((name) => name.endsWith("window-switcher.json")), true);
  assert.equal(shortcuts.isRegistered("Alt+Tab"), true);
});

test("move는 id와 key로 고른 순서를 저장하고 목록 revision을 올린 뒤 그 순서를 순환에 넘긴다", async () => {
  const first = window({ id: 101, cgId: 101, matchTitle: "첫 창", displayTitle: "첫 창" });
  const second = window({ id: 202, cgId: 202, matchTitle: "둘째 창", displayTitle: "둘째 창",
    bounds: [900, 0, 800, 600] });
  const savedState = core.serialize({ version: 1, picked: [first, second], cursor: null });
  const fs = memoryFs({ [STATE]: JSON.stringify(savedState) });
  let ordered = null;
  const catalog = {
    async enumerate() { return { ok: true, windows: [first, second] }; },
    async step(input) {
      ordered = input.ordered;
      return { ok: true, raised: input.ordered[0], resolved: input.ordered, missing: [], front: null };
    },
    cancel() {},
  };
  const { host, broadcasts } = setup({ fs, catalog });
  host.start();
  await refresh(host);
  const before = host.getStatus().listRevision;

  const moved = await host.handle(trusted, { op: "move", id: 202, dir: -1 });
  await host.handle(trusted, { op: "step", dir: 1 });

  assert.deepEqual(moved.picked.map((item) => item.cgId), [202, 101]);
  assert.deepEqual(core.deserialize(fs.files.get(STATE)).picked.map((item) => item.cgId), [202, 101]);
  assert.equal(moved.status.listRevision, before + 1);
  assert.equal(broadcasts.at(-1).listRevision, before + 1);
  assert.deepEqual(ordered, [202, 101]);

  const restored = await host.handle(trusted, { op: "move", key: moved.picked[0].pickKey, dir: 1 });
  assert.deepEqual(restored.picked.map((item) => item.cgId), [101, 202]);
  assert.deepEqual(core.deserialize(fs.files.get(STATE)).picked.map((item) => item.cgId), [101, 202]);
  assert.equal(restored.status.listRevision, before + 2);
});

test("정상 저장 뒤 직전 정상본을 .bak으로 남긴다", async () => {
  const previous = stored({ id: 201, cgId: 201, matchTitle: "이전" });
  const fs = memoryFs({ [STATE]: JSON.stringify(previous) });
  const { host } = setup({ fs });
  host.start();
  await refresh(host);
  await host.handle(trusted, { op: "pick", id: 101 });

  assert.deepEqual(core.deserialize(fs.files.get(BACKUP)), core.deserialize(previous));
});

test("T25 부분 등록 결과를 방향별로 담고 같은 가속기는 next만 등록한다", () => {
  const partialFs = memoryFs({ [STATE]: JSON.stringify(stored()) });
  const partial = setup({ fs: partialFs, shortcuts: fakeShortcuts((acc) => acc !== "Alt+Shift+Tab") });
  partial.host.start();
  assert.deepEqual(partial.host.getStatus().registered, { next: true, prev: false });

  const sameFs = memoryFs({
    [STATE]: JSON.stringify(stored()),
    [KEYMAP]: JSON.stringify({
      "screen-toggle": { alt: true, shift: true, code: "Tab" },
      "screen-toggle-back": { alt: true, shift: true, code: "Tab" },
    }),
  });
  const same = setup({ fs: sameFs });
  same.host.start();
  assert.deepEqual(same.shortcuts.registered, ["Alt+Shift+Tab"]);
  assert.equal(same.host.getStatus().conflict, "same-accelerator");
});

test("T26 ready 뒤 3초·8초 재결합 창 안에서 돌아온 창을 살린다", async () => {
  const fs = memoryFs({ [STATE]: JSON.stringify(stored()) });
  const timers = fakeTimers();
  let calls = 0;
  const catalog = {
    async enumerate() { calls += 1; return { ok: true, windows: calls === 1 ? [] : [window()] }; },
    async step() { throw new Error("부르지 않음"); }, cancel() {},
  };
  const { host } = setup({ fs, timers, catalog });
  host.start();

  await timers.timeouts.find((item) => item.ms === 3000).fn();
  await timers.timeouts.find((item) => item.ms === 8000).fn();

  assert.equal(calls, 2);
  assert.equal(core.deserialize(fs.files.get(STATE)).picked.length, 1);
  assert.equal(host.getStatus().droppedOnRestart, 0);
});

test("R6 재시작 재결합 전에는 죽은 pid로 저장본을 지우지 않고 앱과 제목으로 다시 붙인다", async () => {
  const fs = memoryFs({ [STATE]: JSON.stringify(stored()) });
  const timers = fakeTimers();
  let calls = 0;
  const returned = window({ id: 202, cgId: 202, pid: 88, pidStart: "Sun Aug 30 10:01:00 2026" });
  const catalog = {
    async enumerate() { calls += 1; return { ok: true, windows: calls === 1 ? [] : [returned] }; },
    async step() { throw new Error("부르지 않음"); }, cancel() {},
  };
  const { host } = setup({ fs, timers, catalog, killProbe: () => false });
  host.start();

  timers.intervals[0].fn();
  assert.equal(core.deserialize(fs.files.get(STATE)).picked.length, 1);
  assert.equal(fs.writes.state().length, 0, "재결합 전에는 고른 목록 파일을 덮지 않는다");
  await timers.timeouts.find((item) => item.ms === 3000).fn();
  assert.equal(core.deserialize(fs.files.get(STATE)).picked.length, 1);
  await timers.timeouts.find((item) => item.ms === 8000).fn();

  const rejoined = core.deserialize(fs.files.get(STATE));
  assert.equal(rejoined.picked.length, 1);
  assert.equal(rejoined.picked[0].cgId, 202);
  assert.equal(host.getStatus().droppedOnRestart, 0);
});

test("열거에서 같은 pid의 시작 시각이 달라지면 다른 프로세스로 보고 저장과 등록에서 뺀다", async () => {
  const fs = memoryFs({ [STATE]: JSON.stringify(stored()) });
  const probes = [];
  const timers = fakeTimers();
  let calls = 0;
  const catalog = {
    async enumerate() {
      calls += 1;
      return { ok: true, windows: [window({ pidStart: calls === 1
        ? "Sun Aug 30 10:00:00 2026" : "Sun Aug 30 11:00:00 2026" })] };
    },
    async step() { throw new Error("부르지 않음"); }, cancel() {},
  };
  const { host, shortcuts } = setup({
    fs, timers, catalog,
    killProbe(pid, signal) { probes.push([pid, signal]); return true; },
  });
  host.start();
  await timers.timeouts.find((item) => item.ms === 8000).fn();
  await refresh(host);

  assert.equal(core.deserialize(fs.files.get(STATE)).picked.length, 0);
  assert.equal(shortcuts.isRegistered("Alt+Tab"), false);
  assert.deepEqual(probes.at(-1), [77, 0]);
});

test("T28a 모르는 id는 저장과 등록을 바꾸지 않는다", async () => {
  const { host, fs, shortcuts } = setup();
  host.start();
  await refresh(host);
  const writes = fs.writes.state().length;
  const registrations = shortcuts.registered.length;

  assert.deepEqual(await host.handle(trusted, { op: "pick", id: 999 }), { error: "unknown-window" });
  assert.equal(fs.writes.state().length, writes);
  assert.equal(shortcuts.registered.length, registrations);
});

test("T28b 신뢰되지 않은 sender는 어떤 상태와 등록도 다시 계산하지 않는다", async () => {
  const fs = memoryFs({ [STATE]: JSON.stringify(stored()) });
  const { host, shortcuts } = setup({ fs });
  host.start();
  const before = { registered: shortcuts.registered.length, unregistered: shortcuts.unregistered.length, writes: fs.writes.state().length };

  assert.deepEqual(await host.handle({ trusted: false }, { op: "unpick", id: 101 }), { error: "untrusted" });
  assert.deepEqual({ registered: shortcuts.registered.length, unregistered: shortcuts.unregistered.length, writes: fs.writes.state().length }, before);
});

test("신뢰되지 않은 sender의 move는 저장과 목록 revision을 바꾸지 않는다", async () => {
  const first = window({ id: 101, cgId: 101, matchTitle: "첫 창", displayTitle: "첫 창" });
  const second = window({ id: 202, cgId: 202, matchTitle: "둘째 창", displayTitle: "둘째 창",
    bounds: [900, 0, 800, 600] });
  const fs = memoryFs({
    [STATE]: JSON.stringify(core.serialize({ version: 1, picked: [first, second], cursor: null })),
  });
  const { host } = setup({ fs, windows: [first, second] });
  host.start();
  await refresh(host);
  const before = { text: fs.files.get(STATE), writes: fs.writes.state().length, revision: host.getStatus().listRevision };

  assert.deepEqual(await host.handle({ trusted: false }, { op: "move", id: 202, dir: -1 }), { error: "untrusted" });
  assert.deepEqual({ text: fs.files.get(STATE), writes: fs.writes.state().length, revision: host.getStatus().listRevision }, before);
});

test("T28c 이상한 dir은 catalog.step을 부르지 않는다", async () => {
  const fs = memoryFs({ [STATE]: JSON.stringify(stored()) });
  let steps = 0;
  const catalog = { async enumerate() { return { ok: true, windows: [window()] }; }, async step() { steps += 1; }, cancel() {} };
  const { host } = setup({ fs, catalog });
  host.start();

  assert.deepEqual(await host.handle(trusted, { op: "step", dir: 0 }), { error: "bad-dir" });
  assert.equal(steps, 0);
});

test("T30 세 번 누르면 catalog.step을 겹치지 않고 세 번 순서대로 실행한다", async () => {
  const fs = memoryFs({ [STATE]: JSON.stringify(stored()) });
  const releases = [];
  let running = 0;
  let maxRunning = 0;
  let calls = 0;
  const catalog = {
    async enumerate() { return { ok: true, windows: [window()] }; },
    step() {
      calls += 1; running += 1; maxRunning = Math.max(maxRunning, running);
      return new Promise((resolve) => releases.push(() => { running -= 1; resolve({ ok: true, raised: 101, resolved: [101], missing: [], front: null }); }));
    }, cancel() {},
  };
  const { host } = setup({ fs, catalog });
  host.start();
  const results = [1, 2, 3].map(() => host.handle(trusted, { op: "step", dir: 1 }));
  for (let index = 0; index < 3; index += 1) {
    while (!releases[index]) await Promise.resolve();
    releases[index]();
  }
  await Promise.all(results);

  assert.equal(calls, 3);
  assert.equal(maxRunning, 1);
});

test("R10a step이 못 찾은 창은 즉시 흐려지고 목록 revision을 방송한다", async () => {
  const fs = memoryFs({ [STATE]: JSON.stringify(stored()) });
  const catalog = {
    async enumerate() { return { ok: true, windows: [window()] }; },
    async step() { return { ok: true, raised: null, resolved: [], missing: [101], front: null }; },
    cancel() {},
  };
  const { host, broadcasts } = setup({ fs, catalog });
  host.start();
  await refresh(host);
  const before = host.getStatus().listRevision;

  const stepped = await host.handle(trusted, { op: "step", dir: 1 });
  const listed = await host.handle(trusted, { op: "list" });

  assert.equal(listed.windows.find((row) => row.id === 101).visible, false);
  assert.equal(stepped.status.listRevision, before + 1);
  assert.equal(broadcasts.at(-1).listRevision, before + 1);
});

// 목록을 다시 읽는 일을 설정 화면만 할 수 있으면, 앱을 껐다 켠 뒤 눌러도 아무 일이 없다.
// 고른 창은 남아 있는데 그 안의 pid·cgId 가 이전 실행의 값이라 스크립트가 하나도 못 찾기 때문이다.
// 사용자에게는 기능이 꺼져 있고 설정 창전환을 한 번 열어야 켜지는 것으로 보인다.
function healHarness({ missing, second, now }) {
  const fs = memoryFs({ [STATE]: JSON.stringify(stored()) });
  const counts = { enumerate: 0, step: 0 };
  const catalog = {
    async enumerate() {
      counts.enumerate += 1;
      return { ok: true, windows: [window({ reachable: "cg", onScreen: false })] };
    },
    async step() {
      counts.step += 1;
      return counts.step === 1
        ? { ok: true, raised: null, resolved: [], missing, front: null }
        : second;
    },
    cancel() {},
  };
  return { ...setup({ fs, catalog, now }), counts };
}

test("회차 기록에 그때의 앞 창을 남긴다", async () => {
  // 앞 창이 고른 목록 밖이면 selectTarget 은 커서를 무시하고 첫 창부터 고른다(R9). 그래서 올리기가
  // 실제로 적용되지 않은 회차에서는 누를 때마다 같은 창만 기록에 남는다. 그 둘을 회차만 보고
  // 구분하려면 그때의 앞 창이 기록되어 있어야 한다.
  const fs = memoryFs({ [STATE]: JSON.stringify(stored()) });
  const catalog = {
    async enumerate() { return { ok: true, windows: [window()] }; },
    async step() { return { ok: true, raised: 101, resolved: [101], missing: [], front: 4242 }; },
    cancel() {},
  };
  const { host } = setup({ fs, catalog });
  host.start();
  await refresh(host);
  await host.handle(trusted, { op: "step", dir: 1 });

  const diag = JSON.parse(String(fs.readFileSync(path.join(HOME, "window-switcher-diag.json"), "utf8")));
  assert.equal(diag.lastStep.front, 4242, "그때의 앞 창을 안 남겼다");
});

test("우리 창을 올린 회차에도 그때의 앞 창을 남긴다", async () => {
  // 실제로 막힌 경로가 이 분기다. 우리 창을 앱이 올리는 회차다.
  const fs = memoryFs({ [STATE]: JSON.stringify(stored()) });
  const catalog = {
    async enumerate() { return { ok: true, windows: [window()] }; },
    async step() { return { ok: true, raised: null, own: 101, resolved: [101], missing: [], front: 4242 }; },
    cancel() {},
  };
  const { host } = setup({ fs, catalog, ownPid: 77, raiseOwnWindow: () => true });
  host.start();
  await refresh(host);
  await host.handle(trusted, { op: "step", dir: 1 });

  const diag = JSON.parse(String(fs.readFileSync(path.join(HOME, "window-switcher-diag.json"), "utf8")));
  assert.equal(diag.lastStep.how, "own-window", "이 회차가 우리 창 갈래가 아니다 — 검사가 다른 곳을 재고 있다");
  assert.equal(diag.lastStep.front, 4242, "우리 창 회차의 앞 창을 안 남겼다");
});

test("고른 창을 하나도 못 찾으면 스스로 목록을 다시 읽고 한 번 더 간다", async () => {
  const h = healHarness({
    missing: [101],
    second: { ok: true, raised: 101, resolved: [101], missing: [], front: 101 },
  });
  h.host.start();
  await refresh(h.host);
  const before = h.counts.enumerate;

  const out = await h.host.handle(trusted, { op: "step", dir: 1 });
  assert.equal(h.counts.enumerate, before + 1, "스스로 목록을 안 읽었다 — 설정 화면 없이는 못 켜진다");
  assert.equal(h.counts.step, 2, "다시 읽고 한 번 더 가지 않았다");
  assert.equal(out.raised, 101, "다시 읽은 뒤에도 창을 못 올렸다");
});

test("찾았는데 못 간 창은 목록을 다시 읽지 않는다", async () => {
  // 못 간 것은 그 창의 문제라 다시 읽어도 그대로다. 다시 읽으면 그 사실을 알리는 표시만 지워진다.
  const h = healHarness({
    missing: [{ id: 101, reason: "desktop-switch-failed" }],
    second: { ok: true, raised: 101, resolved: [101], missing: [], front: 101 },
  });
  h.host.start();
  await refresh(h.host);
  const before = h.counts.enumerate;

  await h.host.handle(trusted, { op: "step", dir: 1 });
  assert.equal(h.counts.enumerate, before, "못 간 창에까지 목록을 다시 읽었다");
  assert.equal(h.counts.step, 1, "못 간 창에까지 한 번 더 갔다");
  assert.equal((await h.host.handle(trusted, { op: "list" })).windows[0].switchBlocked, true,
    "못 갔다는 표시가 지워졌다");
});

test("고른 창이 정말 없어졌으면 누를 때마다 훑지 않는다", async () => {
  // 다시 읽어도 해결되지 않는 경우가 있다. 그때 누를 때마다 전체를 훑으면 매번 몇 초가 걸린다.
  let clock = 1000;
  const h = healHarness({
    missing: [101],
    second: { ok: true, raised: null, resolved: [], missing: [101], front: null },
    now: () => clock,
  });
  h.host.start();
  await refresh(h.host);
  const before = h.counts.enumerate;

  await h.host.handle(trusted, { op: "step", dir: 1 });
  assert.equal(h.counts.enumerate, before + 1);
  clock += 1000;                                   // 아직 최소 간격 안
  await h.host.handle(trusted, { op: "step", dir: 1 });
  assert.equal(h.counts.enumerate, before + 1, "간격 안인데 또 훑었다");
  clock += 5000;                                   // 간격을 넘겼다
  await h.host.handle(trusted, { op: "step", dir: 1 });
  assert.equal(h.counts.enumerate, before + 2, "간격을 넘겼는데 안 훑었다");
});

test("막혔던 창이 실제로 올라가면 그 행의 전환 표시를 지운다", async () => {
  const fs = memoryFs({ [STATE]: JSON.stringify(stored()) });
  let calls = 0;
  const catalog = {
    async enumerate() { return { ok: true, windows: [window({ reachable: "cg", onScreen: false })] }; },
    async step() {
      calls += 1;
      return calls === 1
        ? { ok: true, raised: null, resolved: [], missing: [{ id: 101, reason: "desktop-switch-failed" }], front: null }
        : { ok: true, raised: 101, resolved: [101], missing: [], front: 101 };
    },
    cancel() {},
  };
  const { host } = setup({ fs, catalog });
  host.start();
  await refresh(host);

  await host.handle(trusted, { op: "step", dir: 1 });
  assert.equal((await host.handle(trusted, { op: "list" })).windows[0].switchBlocked, true);

  await host.handle(trusted, { op: "step", dir: 1 });
  assert.notEqual((await host.handle(trusted, { op: "list" })).windows[0].switchBlocked, true);
});

test("새 열거는 모든 행의 전환 표시를 지운다", async () => {
  const fs = memoryFs({ [STATE]: JSON.stringify(stored()) });
  const catalog = {
    async enumerate() {
      return { ok: true, windows: [window({ reachable: "cg", onScreen: false })] };
    },
    async step() {
      return {
        ok: true, raised: null, resolved: [],
        missing: [{ id: 101, reason: "desktop-switch-failed" }], front: null,
      };
    },
    cancel() {},
  };
  const { host } = setup({ fs, catalog });
  host.start();
  await refresh(host);
  await host.handle(trusted, { op: "step", dir: 1 });
  assert.equal((await host.handle(trusted, { op: "list" })).windows[0].switchBlocked, true);

  const refreshed = await refresh(host);

  assert.equal(refreshed.windows.some((row) => row.switchBlocked === true), false);
});

test("전환 표시는 상태 파일에 저장하거나 상태 파일에서 복원하지 않는다", async () => {
  const saved = stored();
  saved.picked[0].switchBlocked = true;
  const fs = memoryFs({ [STATE]: JSON.stringify(saved) });
  const catalog = {
    async enumerate() { return { ok: true, windows: [window({ reachable: "cg", onScreen: false })] }; },
    async step() {
      return {
        ok: true, raised: null, resolved: [],
        missing: [{ id: 101, reason: "desktop-switch-failed" }], front: null,
      };
    },
    cancel() {},
  };
  const { host } = setup({ fs, catalog });
  host.start();

  const restored = await refresh(host);
  assert.notEqual(restored.windows[0].switchBlocked, true);

  await host.handle(trusted, { op: "step", dir: 1 });
  assert.equal((await host.handle(trusted, { op: "list" })).windows[0].switchBlocked, true);
  await host.handle(trusted, { op: "unpick", id: 101 });

  assert.equal(fs.files.get(STATE).includes("switchBlocked"), false);
});

test("R12 끝난 프로세스의 항목을 빼면 목록 revision을 방송한다", async () => {
  const fs = memoryFs({ [STATE]: JSON.stringify(stored()) });
  let alive = true;
  const { host, timers, broadcasts } = setup({ fs, killProbe: () => alive });
  host.start();
  await timers.timeouts.find((item) => item.ms === 8000).fn();
  const before = host.getStatus().listRevision;
  alive = false;

  timers.intervals[0].fn();

  assert.equal(core.deserialize(fs.files.get(STATE)).picked.length, 0);
  assert.equal(host.getStatus().listRevision, before + 1);
  assert.equal(broadcasts.at(-1).listRevision, before + 1);
});

test("T32 실행 중 마지막 체크를 풀면 취소하고 결과·큐·등록을 버린다", async () => {
  const fs = memoryFs({ [STATE]: JSON.stringify(stored()) });
  let finish;
  let steps = 0;
  let cancels = 0;
  const catalog = {
    async enumerate() { return { ok: true, windows: [window()] }; },
    step() { steps += 1; return new Promise((resolve) => { finish = resolve; }); },
    cancel() { cancels += 1; finish?.({ ok: false, reason: "cancelled" }); },
  };
  const { host, shortcuts } = setup({ fs, catalog });
  host.start();
  const first = host.handle(trusted, { op: "step", dir: 1 });
  const queued = host.handle(trusted, { op: "step", dir: -1 });
  while (!finish) await Promise.resolve();
  const pickKey = core.deserialize(fs.files.get(STATE)).picked[0].pickKey;
  await host.handle(trusted, { op: "unpick", pickKey });
  assert.equal((await first).raised, null);
  assert.equal((await queued).raised, null);

  assert.equal(cancels, 1);
  assert.equal(steps, 1);
  assert.deepEqual(host.getStatus().registered, { next: false, prev: false });
  assert.equal(shortcuts.unregisterAllCount, 0);
});

test("T36 픽 모드 가속기와 충돌하면 그 방향을 등록하지 않는다", () => {
  const fs = memoryFs({
    [STATE]: JSON.stringify(stored()),
    [KEYMAP]: JSON.stringify({ "screen-toggle": { mod: true, shift: true, key: "e" } }),
  });
  const { host, shortcuts } = setup({ fs });
  host.start();

  assert.equal(shortcuts.registered.includes("CommandOrControl+Shift+E"), false);
  assert.equal(host.getStatus().conflict, "internal:pick-mode");
});

test("깨진 주 파일은 .bak을 시도하고 백업도 깨졌으면 빈 목록으로 기동한다", () => {
  const recovered = setup({ fs: memoryFs({ [STATE]: "{깨짐", [BACKUP]: JSON.stringify(stored()) }) });
  recovered.host.start();
  assert.equal(recovered.host.getStatus().pickedMode, true);

  const empty = setup({ fs: memoryFs({ [STATE]: "{깨짐", [BACKUP]: "[]" }) });
  empty.host.start();
  assert.equal(empty.host.getStatus().pickedMode, false);
});

test("timeout 뒤에도 다음 step 입력을 실행한다", async () => {
  const fs = memoryFs({ [STATE]: JSON.stringify(stored()) });
  let calls = 0;
  const catalog = {
    async enumerate() { return { ok: true, windows: [window()] }; },
    async step() {
      calls += 1;
      return calls === 1 ? { ok: false, reason: "timeout" } : { ok: true, raised: 101, resolved: [101], missing: [], front: null };
    }, cancel() {},
  };
  const { host } = setup({ fs, catalog });
  host.start();
  const [first, second] = await Promise.all([
    host.handle(trusted, { op: "step", dir: 1 }),
    host.handle(trusted, { op: "step", dir: 1 }),
  ]);

  assert.equal(first.raised, null);
  assert.equal(second.raised, 101);
  assert.equal(calls, 2);
});

test("상태 IPC와 접근성 설정 열기, 상태 변경 방송의 공개 모양을 고정한다", async () => {
  const { host, broadcasts, opened } = setup();
  host.start();
  assert.deepEqual(Object.keys(await host.handle(trusted, { op: "status" })), ["status"]);
  assert.deepEqual(await host.handle(trusted, { op: "open-permissions" }), { ok: true });
  assert.equal(opened[0], "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
  assert.deepEqual(await host.handle(trusted, { op: "open-permissions", kind: "screen" }), { ok: true });
  assert.equal(opened[1], "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
  assert.deepEqual(await host.handle(trusted, { op: "open-permissions", kind: "camera" }), { error: "bad-kind" });
  assert.equal(opened.length, 2);
  await refresh(host);
  await host.handle(trusted, { op: "pick", id: 101 });
  assert.deepEqual(Object.keys(broadcasts.at(-1)).sort(),
    ["accelerators", "conflict", "listRevision", "pickedMode", "registerError", "registered"]);
});

test("media는 host가 고른 앱 열쇠와 화면 권한으로 아이콘·빈 thumbs·누락 사유를 만든다", async () => {
  const calls = [];
  const win = window({ appKey: "com.example.Notes" });
  const { host } = setup({
    windows: [win],
    screenPermission: () => "denied",
    iconRunner: {
      async icons(input) {
        calls.push(input);
        return { icons: { "com.example.Notes": "data:image/png;base64,AQID" }, missing: [] };
      },
      cancel() {},
    },
  });
  await refresh(host);

  const result = await host.handle(trusted, { op: "media", targets: ["renderer-value"], budget: 1 });

  assert.deepEqual(calls, [{ appKeys: ["com.example.Notes"] }]);
  assert.deepEqual(result, {
    permission: "denied",
    icons: { "com.example.Notes": "data:image/png;base64,AQID" },
    thumbs: {},
    missing: [{ id: 101, reason: "permission" }],
    elapsedMs: 0,
  });
});

test("media는 granted 권한에서 못 찍은 창만 not-found로 남긴다", async () => {
  const { host } = setup({
    windows: [window({ appKey: "com.example.Notes" })],
    screenPermission: () => "granted",
    iconRunner: {
      async icons() { return { icons: {}, missing: [{ appKey: "com.example.Notes", reason: "not-found" }] }; },
      cancel() {},
    },
  });
  await refresh(host);

  const result = await host.handle(trusted, { op: "media" });

  assert.deepEqual(result.thumbs, {});
  assert.deepEqual(result.missing, [
    { appKey: "com.example.Notes", reason: "not-found" },
    { id: 101, reason: "not-found" },
  ]);
  assert.equal(result.elapsedMs, 0);
});

test("media는 창 그림과 getSources 왕복 시간을 응답에 싣고 revision 목록은 캐시만 읽는다", async () => {
  let captures = 0;
  const thumb = "data:image/png;base64,AQID";
  const { host } = setup({
    windows: [window()],
    mediaRunner: {
      permission() { return "granted"; },
      async thumbnails({ targets }) {
        captures += 1;
        assert.deepEqual(targets.map(({ pid, pidStart, cgId }) => ({ pid, pidStart, cgId })), [{
          pid: 77, pidStart: "Sun Aug 30 10:00:00 2026", cgId: 101,
        }]);
        return { permission: "granted", thumbs: { 101: thumb }, missing: [], elapsedMs: 37 };
      },
    },
  });
  await refresh(host);

  const media = await host.handle(trusted, { op: "media" });
  await host.handle(trusted, { op: "list" });

  assert.equal(media.thumbs[101], thumb);
  assert.equal(media.elapsedMs, 37);
  assert.equal(captures, 1);
});

test("창 그림 캐시는 pid·시작 시각·CG ID가 모두 같은 창에만 재사용한다", async () => {
  const thumb = "data:image/png;base64,AQID";
  let listed = [window()];
  let capture = 0;
  const catalog = {
    async enumerate() { return { ok: true, windows: listed }; },
    async step() { return { ok: true, raised: null, resolved: [], missing: [], front: null }; },
    cancel() {},
  };
  const { host } = setup({
    catalog,
    mediaRunner: {
      permission() { return "granted"; },
      async thumbnails() {
        capture += 1;
        return capture === 1
          ? { permission: "granted", thumbs: { 101: thumb }, missing: [], elapsedMs: 1 }
          : { permission: "granted", thumbs: {}, missing: [{ id: 101, reason: "not-found" }], elapsedMs: 2 };
      },
    },
  });
  await refresh(host);
  assert.equal((await host.handle(trusted, { op: "media" })).thumbs[101], thumb);

  listed = [window({ pidStart: "Sun Aug 30 11:00:00 2026" })];
  await refresh(host);
  const changedProcess = await host.handle(trusted, { op: "media" });

  assert.deepEqual(changedProcess.thumbs, {});
  assert.deepEqual(changedProcess.missing.filter((item) => item.id === 101), [{ id: 101, reason: "not-found" }]);
});

test("media 전용 신뢰 판정 실패는 권한·아이콘·캐시를 전혀 읽지 않는다", async () => {
  let permissions = 0;
  let icons = 0;
  const { host } = setup({
    isTrustedMediaSender: () => false,
    screenPermission: () => { permissions += 1; return "granted"; },
    iconRunner: {
      async icons() { icons += 1; return { icons: {}, missing: [] }; },
      cancel() {},
    },
  });

  assert.deepEqual(await host.handle(trusted, { op: "media" }), { error: "untrusted" });
  assert.equal(permissions, 0);
  assert.equal(icons, 0);
  assert.deepEqual(Object.keys(await host.handle(trusted, { op: "status" })), ["status"]);
});

test("새 media generation 뒤에 끝난 옛 아이콘 결과는 캐시를 덮지 않는다", async () => {
  const deferred = [];
  let calls = 0;
  const iconRunner = {
    icons() {
      calls += 1;
      if (calls <= 2) return new Promise((resolve) => deferred.push(resolve));
      return Promise.resolve({ icons: {}, missing: [] });
    },
    cancel() {},
  };
  const { host } = setup({ windows: [window({ appKey: "same.app" })], iconRunner, screenPermission: () => "granted" });
  await refresh(host);
  const old = host.handle(trusted, { op: "media" });
  const current = host.handle(trusted, { op: "media" });
  deferred[1]({ icons: { "same.app": "data:image/png;base64,Qg==" }, missing: [] });
  assert.equal((await current).icons["same.app"], "data:image/png;base64,Qg==");
  deferred[0]({ icons: { "same.app": "data:image/png;base64,QQ==" }, missing: [] });
  assert.equal((await old).icons["same.app"], "data:image/png;base64,Qg==");

  const cached = await host.handle(trusted, { op: "media" });
  assert.equal(cached.icons["same.app"], "data:image/png;base64,Qg==");
});

test("아이콘 캐시는 현재 창과 숨은 체크 row만 남긴다", async () => {
  const first = window({ id: 101, appKey: "current.app" });
  const hidden = window({ id: 202, appKey: "hidden.app", displayTitle: "숨길 창" });
  let listed = [first, hidden];
  let iconCall = 0;
  const catalog = {
    async enumerate() { return { ok: true, windows: listed }; },
    async step() { return { ok: true, raised: null, resolved: [], missing: [], front: null }; },
    cancel() {},
  };
  const { host } = setup({
    catalog,
    screenPermission: () => "granted",
    iconRunner: {
      async icons() {
        iconCall += 1;
        return iconCall === 1
          ? { icons: { "current.app": "data:image/png;base64,Qw==", "hidden.app": "data:image/png;base64,SA==" }, missing: [] }
          : { icons: {}, missing: [] };
      },
      cancel() {},
    },
  });
  await refresh(host);
  await host.handle(trusted, { op: "pick", id: 202 });
  await host.handle(trusted, { op: "media" });
  listed = [first];
  await refresh(host);

  const withHiddenPick = await host.handle(trusted, { op: "media" });
  assert.equal("hidden.app" in withHiddenPick.icons, true);
  const hiddenRow = (await host.handle(trusted, { op: "list" })).windows.find((row) => row.visible === false);
  await host.handle(trusted, { op: "unpick", pickKey: hiddenRow.pickKey });
  const pruned = await host.handle(trusted, { op: "media" });
  assert.equal("hidden.app" in pruned.icons, false);
  assert.equal("current.app" in pruned.icons, true);
});

test("media 호출 뒤에도 publicStatus와 revision 방송에 그림 키를 싣지 않는다", async () => {
  const { host, broadcasts } = setup({ windows: [window({ appKey: "com.example.Notes" })] });
  host.start();
  await refresh(host);
  await host.handle(trusted, { op: "media" });
  await host.handle(trusted, { op: "pick", id: 101 });

  assert.deepEqual(Object.keys(host.getStatus()).sort(),
    ["accelerators", "listRevision", "permission", "pickedMode", "registerError", "registered", "titleLookupMs"]);
  assert.deepEqual(Object.keys(broadcasts.at(-1)).sort(),
    ["accelerators", "conflict", "listRevision", "pickedMode", "registerError", "registered"]);
});

test("host를 멈추면 catalog와 icon runner를 각각 취소한다", () => {
  let catalogCancels = 0;
  let iconCancels = 0;
  const { host } = setup({
    catalog: {
      async enumerate() { return { ok: true, windows: [] }; },
      async step() { return { ok: false, reason: "cancelled" }; },
      cancel() { catalogCancels += 1; },
    },
    iconRunner: {
      async icons() { return { icons: {}, missing: [] }; },
      cancel() { iconCancels += 1; },
    },
  });

  host.stop();

  assert.equal(catalogCancels, 1);
  assert.equal(iconCancels, 1);
});

// 우리 앱 자기 창은 osascript 로 갈 수 없다. AX 는 현재 데스크톱만 보고, open 은 이미 앞에 있는
// 앱을 부르는 것이라 아무 일도 하지 않는다. 고른 셋 중 둘이 Iris 창이면 그 지점에서 순환이
// 멈춘다. Electron 은 자기 창을 focus() 로 부를 수 있다.

async function pickTwo(host) {
  await refresh(host);
  const listed = await host.handle(trusted, { op: "list" });
  for (const row of listed.windows) await host.handle(trusted, { op: "pick", id: row.id });
  return listed.windows.map((row) => row.id);
}

test("우리 창이 아니면 원래 osascript 길로 간다", async () => {
  const stepCalls = [];
  const { host } = setup({
    raiseOwnWindow: () => false,
    catalog: {
      async enumerate() { return { ok: true, windows: [window()] }; },
      async step(input) { stepCalls.push(input); return { ok: true, raised: 101, resolved: [101], missing: [] }; },
      cancel() {},
    },
  });

  await pickTwo(host);
  await host.handle(trusted, { op: "step", dir: 1 });

  assert.equal(stepCalls.length, 1, "남의 창은 osascript 로 가야 한다");
});

test("raiseOwnWindow 주입이 없으면 지금까지와 똑같이 돈다", async () => {
  const stepCalls = [];
  const { host } = setup({
    catalog: {
      async enumerate() { return { ok: true, windows: [window()] }; },
      async step(input) { stepCalls.push(input); return { ok: true, raised: 101, resolved: [101], missing: [] }; },
      cancel() {},
    },
  });

  await pickTwo(host);
  await host.handle(trusted, { op: "step", dir: 1 });

  assert.equal(stepCalls.length, 1);
});

test("자기 창은 스크립트가 짚고 앱이 올린다", async () => {
  const raised = [];
  const stepCalls = [];
  const { host } = setup({
    raiseOwnWindow: (target) => { raised.push(target.id ?? target.cgId); return true; },
    ownPid: 4242,
    catalog: {
      async enumerate() { return { ok: true, windows: [window()] }; },
      async step(input) {
        stepCalls.push(input);
        return { ok: true, raised: null, own: input.ordered[0], resolved: input.ordered, missing: [] };
      },
      cancel() {},
    },
  });

  await pickTwo(host);
  const out = await host.handle(trusted, { op: "step", dir: 1 });

  assert.equal(stepCalls.length, 1, "고르는 일은 스크립트가 한다");
  assert.equal(stepCalls[0].ownPid, 4242, "우리 pid 를 스크립트에 넘겨야 자기 창을 알아본다");
  assert.equal(raised.length, 1, "올리는 일은 앱이 한다");
  assert.equal(out.raised, raised[0]);
});

test("앱이 그 창을 못 찾으면 올렸다고 하지 않는다", async () => {
  const { host } = setup({
    raiseOwnWindow: () => false,
    ownPid: 4242,
    catalog: {
      async enumerate() { return { ok: true, windows: [window()] }; },
      async step(input) { return { ok: true, raised: null, own: input.ordered[0], resolved: input.ordered, missing: [] }; },
      cancel() {},
    },
  });

  await pickTwo(host);
  const out = await host.handle(trusted, { op: "step", dir: 1 });

  assert.equal(out.raised, null);
});

test("자기 창을 올리면 그 창이 다음 순환의 기준이 된다", async () => {
  const { host } = setup({
    raiseOwnWindow: () => true,
    ownPid: 4242,
    catalog: {
      async enumerate() { return { ok: true, windows: [window()] }; },
      async step(input) { return { ok: true, raised: null, own: input.ordered[0], resolved: input.ordered, missing: [] }; },
      cancel() {},
    },
  });

  await pickTwo(host);
  await host.handle(trusted, { op: "step", dir: 1 });
  const listed = await host.handle(trusted, { op: "list" });
  assert.equal(listed.status.lastStep.how, "own-window");
  assert.equal(listed.status.lastStep.failed, undefined);
});

test("전환이 안 됐으면 그 사실을 상태에 남긴다", async () => {
  const { host } = setup({
    catalog: {
      async enumerate() { return { ok: true, windows: [window()] }; },
      async step(input) {
        return { ok: true, raised: null, resolved: [], missing: [{ id: input.ordered[0], reason: "desktop-switch-failed" }] };
      },
      cancel() {},
    },
  });

  await pickTwo(host);
  await host.handle(trusted, { op: "step", dir: 1 });
  const listed = await host.handle(trusted, { op: "list" });

  assert.equal(listed.status.lastStep.how, "osascript");
  assert.equal(listed.status.lastStep.failed, "desktop-switch-failed");
  assert.ok(listed.status.lastStep.at, "언제였는지도 남아야 한다");
});

// 앱 안에서만 아는 사실을 밖에서 볼 수 있어야 동작하지 않을 때 원인을 짚을 수 있다.
test("전환을 시도하면 진단 파일에 그 결과가 남는다", async () => {
  const { host, fs } = setup({
    catalog: {
      async enumerate() { return { ok: true, windows: [window()] }; },
      async step(input) {
        return { ok: true, raised: null, resolved: [], missing: [{ id: input.ordered[0], reason: "desktop-switch-failed" }] };
      },
      cancel() {},
    },
  });

  await pickTwo(host);
  await host.handle(trusted, { op: "step", dir: 1 });

  const raw = fs.readFileSync(path.join(HOME, "window-switcher-diag.json"), "utf8");
  const diag = JSON.parse(String(raw));
  assert.equal(diag.lastStep.failed, "desktop-switch-failed");
  assert.equal(diag.lastStep.how, "osascript");
  assert.equal(diag.pickedCount, 1);
  assert.ok(Array.isArray(diag.rows) && diag.rows.length >= 1, "무엇이 목록에 있었는지도 남아야 한다");
  assert.ok(diag.accelerators, "어떤 키로 등록했는지도 남아야 한다");
});

test("고른 창이 없으면 그 사실이 진단에 남는다", async () => {
  const { host, fs } = setup();
  await refresh(host);
  await host.handle(trusted, { op: "step", dir: 1 });
  const diag = JSON.parse(String(fs.readFileSync(path.join(HOME, "window-switcher-diag.json"), "utf8")));
  assert.equal(diag.lastStep.failed, "고른 창이 없다");
});

// 한 번 실패한 창을 매번 다시 시도하면 그 차례마다 몇 초를 다시 쓴다.
