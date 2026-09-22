// 사용자가 켠 Chrome 확장 하나를 Iris의 persistent browser session에 싣는다.
//
// 소유 범위
//   React Developer Tools descriptor, Chrome version 후보 검증·선택, partition별 load Promise와
//   enable/wait IPC. Chrome 전체 확장 목록이나 session hardening은 소유하지 않는다.
//
// 제공 API
//   initCapability(ctx), createExtensionLoader(deps), resolveExtension(deps), compareNumericVersions.
//
// 의존 대상
//   Node fs/path/os와 main이 주입하는 app·session 조회·hardened session 순회/구독·trusted IPC·notice/log.
//
// 유지 조건
//   app ready와 profile-session-policy의 hardened 통지 뒤에만 persistent session에 load한다.
//   renderer는 path/id를 넘길 수 없고, 선택 경로는 extension id root의 realpath 안이어야 한다.
//   같은 partition의 동시 요청은 한 Promise로 합치고 반환 id와 registry id를 모두 확인한다.
//
// 영향 범위
//   capabilities.cjs, main.cjs의 native capability ctx, preload.cjs의 제한 bridge,
//   profile-session-policy.cjs의 hardened 통지, bin/smoke/sections/extension-loader.mjs.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REACT_DEVTOOLS = Object.freeze({
  id: "fmkadmapgofadopljbjfkapdkoienihi",
  name: "React Developer Tools",
  chromeProfile: "Default",
});
const VERSION_RE = /^\d+(?:\.\d+)*$/;

function errorText(error) {
  return String(error && error.message || error || "알 수 없는 오류");
}

function compareNumericVersions(left, right) {
  const a = String(left).split(".").map(Number);
  const b = String(right).split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

function isWithin(root, target, pathImpl = path) {
  const relative = pathImpl.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${pathImpl.sep}`)
    && relative !== ".." && !pathImpl.isAbsolute(relative));
}

function resolveExtension({
  descriptor = REACT_DEVTOOLS,
  extensionRoot,
  fsImpl = fs,
  osImpl = os,
  pathImpl = path,
} = {}) {
  const root = extensionRoot || pathImpl.join(
    osImpl.homedir(),
    "Library/Application Support/Google/Chrome",
    descriptor.chromeProfile,
    "Extensions",
    descriptor.id,
  );
  let rootReal;
  let entries;
  try {
    rootReal = fsImpl.realpathSync(root);
    entries = fsImpl.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    return { ok: false, id: descriptor.id, stage: "discover", path: root, error: errorText(error), rejected: [] };
  }

  const candidates = [];
  const rejected = [];
  for (const entry of entries) {
    const candidatePath = pathImpl.join(root, entry.name);
    try {
      if (!fsImpl.statSync(candidatePath).isDirectory()) continue;
      const realPath = fsImpl.realpathSync(candidatePath);
      if (!isWithin(rootReal, realPath, pathImpl)) {
        rejected.push({ path: candidatePath, error: "extension root 밖 symlink" });
        continue;
      }
      const manifestPath = pathImpl.join(realPath, "manifest.json");
      if (!fsImpl.existsSync(manifestPath)) {
        rejected.push({ path: candidatePath, error: "manifest.json 없음" });
        continue;
      }
      let manifest;
      try { manifest = JSON.parse(fsImpl.readFileSync(manifestPath, "utf8")); }
      catch (error) {
        rejected.push({ path: candidatePath, error: `manifest JSON: ${errorText(error)}` });
        continue;
      }
      const version = String(manifest && manifest.version || "");
      if (!VERSION_RE.test(version)) {
        rejected.push({ path: candidatePath, error: `잘못된 manifest version: ${version || "(없음)"}` });
        continue;
      }
      if (typeof manifest.devtools_page !== "string" || !manifest.devtools_page.trim()) {
        rejected.push({ path: candidatePath, error: "devtools_page 없음" });
        continue;
      }
      const suffix = Number((/_([0-9]+)$/.exec(entry.name) || [])[1] || 0);
      const permissions = [
        ...(Array.isArray(manifest.permissions) ? manifest.permissions : []),
        ...(Array.isArray(manifest.host_permissions) ? manifest.host_permissions : []),
      ];
      candidates.push({
        id: descriptor.id,
        name: descriptor.name,
        version,
        suffix,
        path: realPath,
        manifest,
        warnings: permissions.filter((permission) => permission === "webRequest" || permission === "declarativeNetRequest"),
      });
    } catch (error) {
      rejected.push({ path: candidatePath, error: errorText(error) });
    }
  }

  candidates.sort((a, b) => {
    const versionOrder = compareNumericVersions(b.version, a.version);
    return versionOrder || b.suffix - a.suffix;
  });
  if (!candidates.length) {
    return {
      ok: false,
      id: descriptor.id,
      stage: "manifest",
      path: root,
      error: rejected.length ? rejected.map((item) => item.error).join("; ") : "유효한 version directory 없음",
      rejected,
    };
  }
  return { ok: true, ...candidates[0], stage: "manifest", rejected };
}

function createExtensionLoader({
  app,
  sessionFromPartition,
  forEachHardened,
  onSessionHardened,
  extensionRoot,
  descriptor = REACT_DEVTOOLS,
  fsImpl = fs,
  osImpl = os,
  pathImpl = path,
  log = (...args) => console.info(...args),
  error = (...args) => console.error(...args),
  notice = () => {},
} = {}) {
  const loads = new Map();
  let enabled = false;

  function report(result) {
    const payload = {
      id: result.id,
      version: result.version || null,
      partition: result.partition,
      path: result.path || null,
      stage: result.stage,
      ...(result.returnedId ? { returnedId: result.returnedId } : {}),
      ...(result.verified ? { verified: true } : {}),
      ...(result.error ? { error: result.error } : {}),
    };
    (result.ok ? log : error)("[extension-loader]", payload);
    return result;
  }

  async function loadPartition(partition) {
    const selected = resolveExtension({ descriptor, extensionRoot, fsImpl, osImpl, pathImpl });
    if (!selected.ok) return report({ ...selected, partition });

    let sess;
    try { sess = sessionFromPartition(partition); }
    catch (loadError) {
      return report({ ok: false, id: descriptor.id, version: selected.version, partition,
        path: selected.path, stage: "load", error: errorText(loadError) });
    }
    if (!sess || typeof sess.isPersistent !== "function" || !sess.isPersistent()) {
      return report({ ok: false, id: descriptor.id, version: selected.version, partition,
        path: selected.path, stage: "load", error: "persistent session이 아님" });
    }

    let loaded;
    try { loaded = await sess.extensions.loadExtension(selected.path); }
    catch (loadError) {
      return report({ ok: false, id: descriptor.id, version: selected.version, partition,
        path: selected.path, stage: "load", error: errorText(loadError) });
    }
    if (!loaded || loaded.id !== descriptor.id) {
      try { if (loaded && loaded.id) sess.extensions.removeExtension(loaded.id); } catch {}
      return report({ ok: false, id: descriptor.id, returnedId: loaded && loaded.id,
        version: selected.version, partition, path: selected.path, stage: "verify",
        error: `extension id 불일치: ${loaded && loaded.id || "(없음)"}` });
    }
    let verified;
    try { verified = sess.extensions.getExtension(descriptor.id); }
    catch (verifyError) {
      return report({ ok: false, id: descriptor.id, version: selected.version, partition,
        path: selected.path, stage: "verify", error: errorText(verifyError) });
    }
    if (!verified || verified.id !== descriptor.id) {
      return report({ ok: false, id: descriptor.id, version: selected.version, partition,
        path: selected.path, stage: "verify", error: "session registry에서 extension을 확인하지 못함" });
    }
    return report({ ok: true, id: descriptor.id, returnedId: loaded.id, verified: true,
      version: selected.version, partition, path: selected.path, stage: "verify", warnings: selected.warnings });
  }

  function ensurePartition(partition) {
    const key = String(partition || "");
    if (!loads.has(key)) loads.set(key, loadPartition(key));
    return loads.get(key);
  }

  async function hardenedPartitions() {
    const partitions = [];
    await forEachHardened((partition) => { partitions.push(String(partition)); });
    return partitions;
  }

  async function enable() {
    enabled = true;
    await app.whenReady();
    const partitions = await hardenedPartitions();
    const results = await Promise.all(partitions.map(ensurePartition));
    return { ok: results.every((result) => result.ok), results };
  }

  async function waitForPartition(partition) {
    await app.whenReady();
    const key = String(partition || "");
    if (!loads.has(key) && enabled && (await hardenedPartitions()).includes(key)) ensurePartition(key);
    const pending = loads.get(key);
    if (!pending) {
      return report({ ok: false, id: descriptor.id, partition: key, stage: "devtools-ready",
        error: "hardened session의 extension load가 예약되지 않음" });
    }
    const loaded = await pending;
    if (loaded.ok) return loaded;
    return report({ ...loaded, ok: false, causeStage: loaded.stage, stage: "devtools-ready" });
  }

  const unsubscribe = onSessionHardened((partition) => {
    if (!enabled) return;
    void app.whenReady()
      .then(() => ensurePartition(partition))
      .then((result) => {
        if (!result.ok) notice({ text: `${partition} 확장 로드 실패 (${result.stage})` });
      }, (readyError) => {
        error("[extension-loader]", {
          id: descriptor.id, partition, stage: "load", error: errorText(readyError),
        });
      });
  });

  return { enable, waitForPartition, ensurePartition, loadPromises: loads, unsubscribe };
}

function initCapability(ctx = {}) {
  const loader = createExtensionLoader(ctx);
  ctx.ipcMain.handle("ac-extension-loader-enable", (event) => {
    if (!ctx.isTrustedSender(event)) return { ok: false, results: [] };
    return loader.enable();
  });
  ctx.ipcMain.handle("ac-extension-loader-wait", (event, partition) => {
    if (!ctx.isTrustedSender(event)) return { ok: false, stage: "devtools-ready", error: "신뢰되지 않은 발신자" };
    return loader.waitForPartition(partition);
  });
  return loader;
}

module.exports = {
  REACT_DEVTOOLS,
  compareNumericVersions,
  createExtensionLoader,
  initCapability,
  resolveExtension,
};
