import assert from "node:assert/strict";
import test from "node:test";

import { bootCapabilities } from "../web/js/core/capability-boot.js";
import { clearHooks, hasHook } from "../web/js/core/hooks.js";

// 진짜 Chrome 미러가 bridge 유무에 따라 내는 결과. native bridge 가 전혀 없는 창은 조용히 미지원이고,
// bridge 가 있는데 미러 함수가 빠졌으면 사용자가 알 수 있어야 한다.
const item = { id: "chromemirror", load: () => import("../web/js/browser/chrome-mirror-surface.js") };
async function boot(acHost) {
  clearHooks();
  const errors = [];
  const loaded = await bootCapabilities({
    items: [item], ctx: { acHost, showToast: () => {}, getWebviewEntries: () => [] },
    onError: (id, e) => errors.push(`${id}: ${e.message}`),
  });
  return { loaded, errors };
}

test("bridge 가 전혀 없으면 오류 없이 미지원으로 끝난다", async () => {
  const r = await boot(undefined);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.loaded, ["chromemirror"]);
  assert.equal(hasHook("mirror.command"), false);
});

test("bridge 에 미러 함수가 빠졌으면 오류로 알린다", async () => {
  const r = await boot({ writeClipboard: async () => true });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /preload bridge/);
  assert.deepEqual(r.loaded, []);
});

test("bridge 가 갖춰져 있으면 미러 훅을 둔다", async () => {
  const fn = () => {};
  const r = await boot({ mirrorStart: fn, mirrorInput: fn, mirrorResize: fn, mirrorStop: fn, onMirrorFrame: fn, onMirrorMeta: fn });
  assert.deepEqual(r.errors, []);
  assert.equal(hasHook("mirror.command"), true);
});

test("Chrome 미러 종료는 현재 전용 프로필을 사용하는 프로세스에 TERM을 먼저 보낸다", async () => {
  const { ChromeMirrorBackend } = await import("../native/electron/chrome-mirror-backend.cjs");
  const signals = [];
  const backend = new ChromeMirrorBackend({ killFn: (...args) => signals.push(args) });
  let reads = 0;
  backend.findChromePids = async () => ++reads === 1 ? [98765] : [];
  await backend.killChromePids("/tmp/iris-mirror-test");
  assert.deepEqual(signals, [[98765, "SIGTERM"]]);
});

test("Chrome 전용 프로필이 기록한 주소와 다른 CDP 서버에는 연결하지 않는다", async t => {
  const { ChromeMirrorBackend } = await import("../native/electron/chrome-mirror-backend.cjs");
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { EventEmitter } = await import("node:events");
  const dir = await mkdtemp(path.join(tmpdir(), "iris-mirror-port-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let connected = false;
  let written;
  const backend = new ChromeMirrorBackend({
    browserForEntry: () => ({ bin: process.execPath }), stateHome: () => dir,
    spawnFn(_bin, args) {
      assert.ok(args.includes("--remote-debugging-port=0"));
      const child = new EventEmitter();
      child.pid = 9;
      written = writeFile(path.join(dir, "chrome-mirror-profile", "DevToolsActivePort"), "43210\n/devtools/browser/abc\n");
      return child;
    },
    waitForJsonFn: async port => {
      assert.equal(port, 43210);
      return { webSocketDebuggerUrl: "ws://127.0.0.1:43210/devtools/browser/other" };
    },
    openCdpFn: () => { connected = true; }, log() {},
  });
  backend.findChromePids = async () => [];
  t.after(() => process.removeListener("exit", backend.exitCleanup));
  backend.mirrors.set("test", {});
  await assert.rejects(backend.ensureBrowser(), /endpoint/);
  await written;
  assert.equal(connected, false);
  assert.equal(backend.cdpPort, null);
});

test("비슷한 이름의 Chrome 프로필은 미러 종료 대상에서 제외한다", async t => {
  const { ChromeMirrorBackend } = await import("../native/electron/chrome-mirror-backend.cjs");
  if (process.platform !== "darwin") { t.skip("macOS 프로세스 검색"); return; }
  const backend = new ChromeMirrorBackend({ execFileFn(_bin, args, _options, cb) {
    const pattern = new RegExp(args.at(-1));
    const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    assert.ok(pattern.test(chrome + " --user-data-dir=/tmp/mirror --option"));
    assert.equal(pattern.test(chrome + " --user-data-dir=/tmp/mirror-copy --option"), false);
    assert.equal(pattern.test("/bin/zsh -c echo --user-data-dir=/tmp/mirror"), false);
    cb(null, "");
  } });
  t.after(() => process.removeListener("exit", backend.exitCleanup));
  await backend.findChromePids("/tmp/mirror");
});

test("Chrome 시작과 정리가 함께 실패해도 시작 오류와 자원 해제가 유지된다", async t => {
  const { ChromeMirrorBackend } = await import("../native/electron/chrome-mirror-backend.cjs");
  const { EventEmitter } = await import("node:events");
  const { tmpdir } = await import("node:os");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(tmpdir(), "iris-mirror-cleanup-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cause = new Error("연결 초기화 실패");
  const endpoint = { port: 43210, ws: "ws://127.0.0.1:43210/devtools/browser/test" };
  let kills = 0;
  const backend = new ChromeMirrorBackend({
    stateHome: () => dir, browserForEntry: () => ({ bin: process.execPath }),
    spawnFn: () => Object.assign(new EventEmitter(), { pid: 9 }),
    activeEndpointFn: async () => endpoint,
    waitForJsonFn: async () => ({ webSocketDebuggerUrl: endpoint.ws }),
    openCdpFn: async () => ({
      call: async () => { throw cause; },
      close: () => { throw new Error("연결 해제 실패"); },
    }),
    log() {}, error() {},
  });
  t.after(() => process.removeListener("exit", backend.exitCleanup));
  backend.killChromePids = async () => { if (++kills === 2) throw new Error("프로세스 정리 실패"); };
  backend.mirrors.set("test", {});
  await assert.rejects(backend.ensureBrowser(), e => e === cause);
  assert.equal(kills, 2);
  assert.equal(backend.browserClient, null);
  assert.equal(backend.cdpPort, null);
});
