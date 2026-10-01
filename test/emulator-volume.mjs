import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { createVolumeController, iosPids, parseProcessTable, androidConsolePort } = require("../native/electron/emulator/audio-volume.cjs");

const A = "D21A6DEC-41A5-4996-9A40-DF2BF656FF4A";
const B = "0F6C1E0B-7E4B-4C43-9B58-5B8E0C6F6A11";
const dev = (udid) => `/Users/<name>/Library/Developer/CoreSimulator/Devices/${udid}`;

test("iOS: 그 기기 launchd_sim 의 자손 전부, 다른 기기·Mac 프로세스는 제외", () => {
  const rows = parseProcessTable([
    `  100     1 launchd_sim ${dev(A)}/data/var/run/launchd_bootstrap.plist`,
    `  101   100 /Library/Developer/CoreSimulator/Volumes/iOS/usr/libexec/SpringBoard`,
    `  102   100 ${dev(A)}/data/Containers/Bundle/Application/X/Runner.app/Runner`,
    `  103   102 /some/child/of/runner`,
    `  200     1 launchd_sim ${dev(B)}/data/var/run/launchd_bootstrap.plist`,
    `  201   200 ${dev(B)}/data/Containers/Bundle/Application/Y/Other.app/Other`,
    `  300     1 /System/Library/CoreServices/SimAudioProcessorService`,
    `  400     1 ${dev(A)}/data/stray-process`,
  ].join("\n"));
  assert.deepEqual(iosPids(rows, A), [100, 101, 102, 103, 400]);
  assert.deepEqual(iosPids(rows, B), [200, 201]);
  assert.deepEqual(iosPids(rows, "no-such-device"), []);
});

test("Android: emulator-NNNN 만 콘솔 포트로 해석(AVD 이름·실기기는 없음)", () => {
  assert.equal(androidConsolePort("emulator-5554"), 5554);
  assert.equal(androidConsolePort("Pixel_8_API_35"), null);
  assert.equal(androidConsolePort("R5CT1234ABC"), null);
});

function fakeHelper(reply = () => ({ ok: true, tapped: 1 })) {
  const spawned = [];
  const spawn = () => {
    const stdout = new EventEmitter();
    const h = new EventEmitter();
    h.lines = []; h.ended = false; h.stdout = stdout; h.kill = () => {};
    h.stdin = {
      write(line) { h.lines.push(JSON.parse(line)); setImmediate(() => stdout.emit("data", JSON.stringify(reply(h.lines.at(-1))) + "\n")); },
      end() { h.ended = true; },
    };
    spawned.push(h);
    return h;
  };
  return { spawned, spawn };
}

function setup(t, opts = {}) {
  const stateDir = mkdtempSync(path.join(tmpdir(), "iris-emu-volume-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const helper = fakeHelper(opts.reply);
  let builds = 0;
  const make = () => createVolumeController({ stateDir, deps: {
    buildHelper: opts.buildHelper || (async () => { builds++; return "/fake/audio-tap"; }),
    resolvePids: async (device) => (device === "emulator-5554" ? [4242] : [100, 102]),
    spawn: helper.spawn,
  } });
  return { stateDir, helper, make, builds: () => builds, store: () => JSON.parse(readFileSync(path.join(stateDir, "emulator-volumes.json"), "utf8")) };
}

test("100%·음소거 아님이면 도우미를 만들지도 띄우지도 않음(권한 창 없음)", async (t) => {
  const s = setup(t);
  const c = s.make();
  const r = await c.use({ device: A, key: A });
  assert.deepEqual(r, { ok: true, volume: 1, muted: false });
  assert.equal(s.builds(), 0);
  assert.equal(s.helper.spawned.length, 0);
  c.stopAll();
});

test("음량을 낮추면 기기별로 저장하고 그 기기 프로세스와 크기를 도우미에 전달", async (t) => {
  const s = setup(t);
  const c = s.make();
  const r = await c.set({ device: "emulator-5554", key: "Pixel_8_API_35", volume: 0.4, muted: false });
  assert.equal(r.ok, true);
  assert.deepEqual(s.store(), { Pixel_8_API_35: { volume: 0.4, muted: false } });
  assert.equal(s.helper.spawned.length, 1);
  assert.deepEqual(s.helper.spawned[0].lines.at(-1), { pids: [4242], volume: 0.4, muted: false });

  // 앱을 다시 켜도(새 컨트롤러) 같은 기기는 저장값으로 시작
  c.stopAll();
  const again = s.make();
  const used = await again.use({ device: "emulator-5554", key: "Pixel_8_API_35" });
  assert.equal(used.volume, 0.4);
  assert.deepEqual(s.helper.spawned.at(-1).lines.at(-1), { pids: [4242], volume: 0.4, muted: false });
  // 다른 기기는 영향 없음
  assert.deepEqual(await again.use({ device: A, key: A }), { ok: true, volume: 1, muted: false });
  again.stopAll();
});

test("100% 로 되돌리면 저장값을 지우고 도우미를 닫음", async (t) => {
  const s = setup(t);
  const c = s.make();
  await c.set({ device: A, key: A, volume: 0.2, muted: false });
  const h = s.helper.spawned[0];
  await c.set({ device: A, key: A, volume: 1, muted: false });
  assert.equal(h.ended, true);
  assert.deepEqual(s.store(), {});
  await c.set({ device: A, key: A, volume: 1, muted: true });
  assert.deepEqual(s.helper.spawned.at(-1).lines.at(-1), { pids: [100, 102], volume: 1, muted: true });
  c.stopAll();
});

test("도우미 실패·컴파일 실패는 화면에 보일 오류로 돌려줌", async (t) => {
  const s = setup(t, { reply: () => ({ ok: false, error: "tap 560947818" }) });
  const r = await s.make().set({ device: A, key: A, volume: 0.5, muted: false });
  assert.deepEqual(r, { ok: false, error: "tap 560947818", volume: 0.5, muted: false });

  const s2 = setup(t, { buildHelper: async () => { throw new Error("음량 도우미를 만들지 못했습니다(Xcode 명령줄 도구 필요)"); } });
  const r2 = await s2.make().set({ device: A, key: A, volume: 0.5, muted: false });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /Xcode 명령줄 도구/);
  assert.equal(s2.helper.spawned.length, 0);
});

test("렌더러가 보낸 기기 값은 id 형식만 받음", async (t) => {
  const s = setup(t);
  const c = s.make();
  for (const bad of [{ device: "../x", key: A }, { device: A, key: "a b" }, { device: A }, {}]) {
    const r = await c.set({ ...bad, volume: 0.3 });
    assert.equal(r.ok, false);
  }
  assert.equal(s.helper.spawned.length, 0);
});

// 음량은 기기를 직접 다루는 조작이라 아래 기기 조작 줄(phoneBar)에. 윗줄은 Iris 제어
test("음량 조절은 아래 기기 조작 줄에 있다", () => {
  const pane = readFileSync(new URL("../web/js/emulator/pane.js", import.meta.url), "utf8");
  assert.match(pane, /phoneBar\.append\(tbSep\(\), volBox\)/);
  assert.doesNotMatch(pane, /toolbar\.append\([^)]*volBox/);
});

test("0%·음소거는 IOProc을 유지하고 스피커 연결과 샘플 복사를 생략한다", () => {
  const swift = readFileSync(new URL("../native/electron/emulator/audio-tap.swift", import.meta.url), "utf8");
  assert.match(swift, /let silent = muted \|\| volume == 0/);
  assert.match(swift, /if !silent \{[\s\S]*?aggDesc\[kAudioAggregateDeviceSubDeviceListKey\]/);
  assert.doesNotMatch(swift, /kAudioAggregateDeviceSubDeviceListKey:/);
  assert.match(swift, /AudioDeviceCreateIOProcIDWithBlock[\s\S]*?if silent \{ return \}/);
  assert.match(swift, /AudioDeviceStart\(agg, p\)/);
  assert.match(swift, /silent == tap\.silent/);
});
