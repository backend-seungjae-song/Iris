import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createRequire } from "node:module";

const { createDevSourceWatch } = createRequire(import.meta.url)("../native/electron/dev-source-watch.cjs");
const { resolveAppPath } = createRequire(import.meta.url)("../native/electron/server-host.cjs");

test("개발 감시는 worker 변경만 묶였을 때만 작업 프로세스를 교체한다", async () => {
  let onChange, timer;
  const watcher = new EventEmitter();
  watcher.unref = () => {};
  watcher.close = () => {};
  const calls = [];
  const watch = createDevSourceWatch({
    fs: { watch: (_dir, _options, callback) => { onChange = callback; return watcher; } },
    path: { join: (...parts) => parts.join("/"), sep: "/" }, root: "/fixture", log: () => {},
    reload: async files => { calls.push(["server", files]); },
    reloadWorker: async files => { calls.push(["worker", files]); },
    classify: file => file.startsWith("mcp-worker/") ? "worker" : "server",
    setTimeoutFn: callback => { timer = callback; return { unref() {} }; }, clearTimeoutFn: () => {},
    setIntervalFn: () => ({ unref() {} }), clearIntervalFn: () => {},
  });
  watch.start();
  onChange("change", "mcp-worker/a.js");
  onChange("change", "mcp-worker/b.js");
  await timer();
  onChange("change", "index.js");
  onChange("change", "mcp-worker/c.js");
  await timer();
  assert.deepEqual(calls, [
    ["worker", "mcp-worker/a.js, mcp-worker/b.js"],
    ["server", "index.js, mcp-worker/c.js"],
  ]);
});

test("Windows 설치 앱의 IRIS_APP_PATH는 Iris.exe가 있는 설치 폴더다", () => {
  assert.equal(resolveAppPath({ isPackaged: true, platform: "win32",
    execPath: "C:\\Users\\me\\AppData\\Local\\Programs\\Iris\\Iris.exe", root: "C:\\source" }),
  "C:\\Users\\me\\AppData\\Local\\Programs\\Iris");
  assert.equal(resolveAppPath({ isPackaged: false, platform: "win32", execPath: "C:\\runtime\\electron.exe", root: "C:\\source" }),
    "C:\\source");
});
