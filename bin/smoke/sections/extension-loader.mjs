// 소유 범위: Chrome 확장 resolver와 persistent Electron session loader의 실제 실행 계약,
//   async capability boot 순서, native/renderer id와 DevTools hook 배선, hardening 공존 guard.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run. 이 파일을 직접 실행해도 같은 검사를 돈다.
// 의존 대상: temp Chrome fixture, fake app/session/IPC, profile-session-policy와 capability-boot.
// 유지 조건: version·manifest·symlink·id·dedupe·partition 결과는 소스 모양이 아니라
//   실제 함수를 실행해 판정한다. 소스 guard는 조립점과 금지 Electron listener에만 쓴다.
// 영향 범위: native/electron/{extension-loader,profile-session-policy,main,preload,capabilities}.cjs,
//   web/js/{core/capabilities,core/capability-boot,browser/extension-loader,panel/touch-drag}.js, bin/smoke.mjs.

import {
  mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { check, checkAsync, read, require_, summary } from "../core.mjs";
import { callHook, clearHooks } from "../../../web/js/core/hooks.js";

const NATIVE = read("native/electron/extension-loader.cjs");
const NATIVE_CAPS = read("native/electron/capabilities.cjs");
const RENDERER_CAPS = read("web/js/core/capabilities.js");
const RENDERER = read("web/js/browser/extension-loader.js");
const TOUCH = read("web/js/panel/touch-drag.js");
const PRELOAD = read("native/electron/preload.cjs");
const MAIN = read("native/electron/main.cjs");

const loaderModule = require_("../native/electron/extension-loader.cjs");
const policyModule = require_("../native/electron/profile-session-policy.cjs");
const roots = [];

function tempRoot(label) {
  const root = mkdtempSync(path.join(os.tmpdir(), `iris-extension-${label}-`));
  roots.push(root);
  return root;
}

function candidate(root, dirname, manifest = {}) {
  const dir = path.join(root, dirname);
  mkdirSync(dir, { recursive: true });
  if (manifest !== null) {
    writeFileSync(path.join(dir, "manifest.json"), typeof manifest === "string"
      ? manifest
      : JSON.stringify({ version: dirname.replace(/_[0-9]+$/, ""), devtools_page: "main.html", permissions: ["storage"], ...manifest }));
  }
  return dir;
}

function fakeSession({ returnedId = loaderModule.REACT_DEVTOOLS.id, reject = null, persistent = true } = {}) {
  const registry = new Map();
  const calls = [];
  const removed = [];
  return {
    calls,
    removed,
    isPersistent: () => persistent,
    extensions: {
      async loadExtension(extensionPath) {
        calls.push(extensionPath);
        if (reject) throw new Error(reject);
        const extension = { id: returnedId, name: "fixture" };
        registry.set(returnedId, extension);
        return extension;
      },
      getExtension: (id) => registry.get(id) || null,
      removeExtension(id) { removed.push(id); registry.delete(id); },
    },
  };
}

function immediateApp() { return { whenReady: () => Promise.resolve() }; }

function controller({ root, partitions, sessions, app = immediateApp(), onHardened = () => () => {}, notices = [] }) {
  return loaderModule.createExtensionLoader({
    app,
    extensionRoot: root,
    sessionFromPartition: (partition) => sessions.get(partition),
    forEachHardened: async (visit) => { for (const partition of partitions) await visit(partition); },
    onSessionHardened: onHardened,
    notice: (message) => notices.push(message),
    log: () => {},
    error: () => {},
  });
}

export default async function run() {
  console.log("[extension-loader] Chrome 확장 로더");

  await checkAsync("숫자 version과 Chrome suffix에서 가장 높은 유효 directory를 고른다", async () => {
    const root = tempRoot("version");
    candidate(root, "7.0.9_0");
    candidate(root, "7.0.10_0");
    let result = loaderModule.resolveExtension({ extensionRoot: root });
    if (!result.ok || path.basename(result.path) !== "7.0.10_0" || result.warnings.length) {
      throw new Error(result.path || result.error || result.warnings.join(","));
    }

    const suffixRoot = tempRoot("suffix");
    candidate(suffixRoot, "7.1.0_0", { version: "7.1.0" });
    candidate(suffixRoot, "7.1.0_2", { version: "7.1.0" });
    result = loaderModule.resolveExtension({ extensionRoot: suffixRoot });
    if (!result.ok || path.basename(result.path) !== "7.1.0_2") throw new Error(result.path || result.error);
    return true;
  });

  await checkAsync("invalid JSON·version·manifest 없음은 실행 resolver가 명시적으로 거절한다", async () => {
    const root = tempRoot("manifest");
    candidate(root, "9.0.0_0", "{broken");
    candidate(root, "10.0.0_0", { version: "latest" });
    candidate(root, "11.0.0_0", null);
    const result = loaderModule.resolveExtension({ extensionRoot: root });
    if (result.ok || result.stage !== "manifest" || result.rejected.length !== 3) {
      throw new Error(JSON.stringify(result));
    }
    const reasons = result.rejected.map((item) => item.error).join(" / ");
    if (!/manifest JSON/.test(reasons) || !/manifest version/.test(reasons) || !/manifest\.json 없음/.test(reasons)) {
      throw new Error(reasons);
    }
    return true;
  });

  await checkAsync("extension id root 밖 symlink는 load 후보가 되지 않는다", async () => {
    const root = tempRoot("symlink-root");
    const outside = tempRoot("symlink-outside");
    candidate(outside, "12.0.0_0");
    symlinkSync(path.join(outside, "12.0.0_0"), path.join(root, "12.0.0_0"), "dir");
    const result = loaderModule.resolveExtension({ extensionRoot: root });
    if (result.ok || !result.rejected.some((item) => /root 밖 symlink/.test(item.error))) {
      throw new Error(JSON.stringify(result));
    }
    return true;
  });

  await checkAsync("returned id 불일치는 unload하고 verify 실패로 남긴다", async () => {
    const root = tempRoot("id-mismatch");
    candidate(root, "7.0.1_0");
    const partition = "persist:acbrowser";
    const sess = fakeSession({ returnedId: "wrong-extension-id" });
    const loader = controller({ root, partitions: [partition], sessions: new Map([[partition, sess]]) });
    const aggregate = await loader.enable();
    const result = aggregate.results[0];
    if (aggregate.ok || result.stage !== "verify" || sess.removed.join() !== "wrong-extension-id") {
      throw new Error(JSON.stringify({ aggregate, removed: sess.removed }));
    }
    return true;
  });

  await checkAsync("같은 partition 동시 요청은 loadExtension 한 번으로 합친다", async () => {
    const root = tempRoot("dedupe");
    candidate(root, "7.0.1_0");
    const partition = "persist:acbrowser";
    const sess = fakeSession();
    const loader = controller({ root, partitions: [partition], sessions: new Map([[partition, sess]]) });
    const [left, right] = await Promise.all([loader.ensurePartition(partition), loader.ensurePartition(partition)]);
    if (!left.ok || !right.ok || left.returnedId !== loaderModule.REACT_DEVTOOLS.id || left.verified !== true
      || sess.calls.length !== 1 || loader.loadPromises.size !== 1) {
      throw new Error(JSON.stringify({ left, right, calls: sess.calls.length }));
    }
    return true;
  });

  await checkAsync("load reject와 non-persistent session은 load stage 실패로 남긴다", async () => {
    const root = tempRoot("load-failures");
    candidate(root, "7.0.1_0");
    const rejected = fakeSession({ reject: "Electron load 거절" });
    const memory = fakeSession({ persistent: false });
    const partitions = ["persist:acbrowser", "persist:acprof:memory"];
    const loader = controller({ root, partitions, sessions: new Map([[partitions[0], rejected], [partitions[1], memory]]) });
    const aggregate = await loader.enable();
    if (aggregate.ok || aggregate.results.some((result) => result.stage !== "load")
      || rejected.calls.length !== 1 || memory.calls.length !== 0) {
      throw new Error(JSON.stringify(aggregate));
    }
    return true;
  });

  await checkAsync("base 성공/profile 실패 aggregate와 renderer 실패 알림이 둘 다 partition을 보존한다", async () => {
    const root = tempRoot("aggregate");
    candidate(root, "7.0.1_0");
    const partitions = ["persist:acbrowser", "persist:acprof:work"];
    const sessions = new Map([
      [partitions[0], fakeSession()],
      [partitions[1], fakeSession({ reject: "profile 실패" })],
    ]);
    const aggregate = await controller({ root, partitions, sessions }).enable();
    if (aggregate.ok || aggregate.results.length !== 2
      || !aggregate.results.find((result) => result.partition === partitions[0])?.ok
      || aggregate.results.find((result) => result.partition === partitions[1])?.ok !== false) {
      throw new Error(JSON.stringify(aggregate));
    }

    clearHooks();
    const toasts = [];
    const waited = [];
    const renderer = await import(new URL(`../../../web/js/browser/extension-loader.js?aggregate=${Date.now()}`, import.meta.url).href);
    await renderer.initCapability({
      acHost: {
        enableExtensionLoader: async () => aggregate,
        waitForExtension: async (partition) => { waited.push(partition); return aggregate.results[0]; },
      },
      showToast: (message) => toasts.push(message),
    });
    if (!toasts.some((message) => message.includes("persist:acprof:work(load)"))) throw new Error(toasts.join(" / "));
    await callHook("extensionloader.before-devtools", { partition: partitions[0] });
    if (waited.join() !== partitions[0]) throw new Error("before-devtools가 현재 partition을 기다리지 않았다");
    clearHooks();
    return true;
  });

  await checkAsync("app ready와 session hardening 완료 전에는 extension을 load하지 않는다", async () => {
    const root = tempRoot("ordering");
    candidate(root, "7.0.1_0");
    const partition = "persist:acbrowser";
    const sess = fakeSession();
    const partitions = [];
    let hardenedListener = null;
    let releaseReady;
    const ready = new Promise((resolve) => { releaseReady = resolve; });
    const loader = controller({
      root,
      partitions,
      sessions: new Map([[partition, sess]]),
      app: { whenReady: () => ready },
      onHardened: (listener) => { hardenedListener = listener; return () => {}; },
    });
    const enabling = loader.enable();
    partitions.push(partition);
    hardenedListener(partition, sess);
    await Promise.resolve();
    if (sess.calls.length) throw new Error("app ready 전에 load했다");
    releaseReady();
    const aggregate = await enabling;
    if (!aggregate.ok || sess.calls.length !== 1) throw new Error(JSON.stringify(aggregate));
    return true;
  });

  await checkAsync("profile policy는 hardening과 session hook 뒤에 한 번만 hardened 통지를 보낸다", async () => {
    const events = [];
    const sess = {
      setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDisplayMediaRequestHandler() {},
      setDevicePermissionHandler() {}, removeListener() {}, on() {},
    };
    const policy = policyModule.createProfileSessionPolicy({
      basePartition: "persist:acbrowser",
      fromPartition: () => sess,
      hardenBrowserSession: () => events.push("hardening"),
      userAgentForPartition: () => "ua",
      audioInputPermission: () => false,
      systemPreferences: { getMediaAccessStatus: () => "granted", askForMediaAccess: () => Promise.resolve(true) },
      platform: "linux",
      installSessionHook: () => events.push("session-hook"),
    });
    policy.onSessionHardened(() => events.push("hardened-notice"));
    policy.hardenSession(sess, "persist:acbrowser");
    policy.hardenSession(sess, "persist:acbrowser");
    if (events.join("/") !== "hardening/session-hook/hardened-notice/hardening") throw new Error(events.join("/"));
    return true;
  });

  await checkAsync("async capability가 끝나기 전 다음 capability boot가 진행되지 않는다", async () => {
    const { bootCapabilities } = await import(new URL(`../../../web/js/core/capability-boot.js?ordering=${Date.now()}`, import.meta.url).href);
    const events = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const pending = bootCapabilities({
      items: [
        { id: "first", load: async () => ({ initCapability: async () => { events.push("first-start"); await gate; events.push("first-end"); } }) },
        { id: "second", load: async () => { events.push("second-load"); return {}; } },
      ],
    });
    await Promise.resolve();
    await Promise.resolve();
    const beforeRelease = events.join("/");
    release();
    await pending;
    if (beforeRelease !== "first-start" || events.join("/") !== "first-start/first-end/second-load") {
      throw new Error(`${beforeRelease} -> ${events.join("/")}`);
    }
    return true;
  });

  check("native와 renderer capability id가 같고 각자 전용 module을 가리킨다", () => {
    const nativeIds = [...NATIVE_CAPS.matchAll(/id:\s*"extensionloader"/g)].length;
    const rendererIds = [...RENDERER_CAPS.matchAll(/id:\s*"extensionloader"/g)].length;
    return nativeIds === 1 && rendererIds === 1
      && /id:\s*"extensionloader",\s*module:\s*require\.resolve\("\.\/extension-loader\.cjs"\)/.test(NATIVE_CAPS)
      && /id:\s*"extensionloader"[\s\S]{0,240}import\("\.\.\/browser\/extension-loader\.js"\)/.test(RENDERER_CAPS);
  });

  check("before-devtools caller/provider와 제한된 preload API가 짝을 이룬다", () => {
    return /provide\("extensionloader\.before-devtools"/.test(RENDERER)
      && /await callHook\("extensionloader\.before-devtools",\s*\{ partition: r\.el\.partition \}\)/.test(TOUCH)
      && /enableExtensionLoader:\s*\(\) => ipcRenderer\.invoke\("ac-extension-loader-enable"\)/.test(PRELOAD)
      && /waitForExtension:\s*\(partition\) => ipcRenderer\.invoke\("ac-extension-loader-wait", partition\)/.test(PRELOAD);
  });

  check("native ctx는 ready·session 순회/구독·trusted IPC·notice/log만 공급한다", () => {
    return /app,\s*\n\s*sessionFromPartition:/.test(MAIN)
      && /forEachHardened: \(callback\) => profileSessionPolicy\.forEachHardened\(callback\)/.test(MAIN)
      && /onSessionHardened: \(listener\) => profileSessionPolicy\.onSessionHardened\(listener\)/.test(MAIN)
      && /isTrustedSender,/.test(MAIN) && /notice: \(message\) =>/.test(MAIN);
  });

  check("loader는 Electron WebRequest listener를 하나 더 등록하지 않는다", () => {
    return !/\bonBeforeSendHeaders\b|sess\.webRequest/.test(NATIVE);
  });

  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await run();
  process.exit(summary());
}
