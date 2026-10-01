const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { stateHome } = require("../../server/state-home.cjs");
const { copyExtension, discoverChromeExtensions, displayName, readManifest, inside } = require("./browser-extension-catalog.cjs");

const LIMITATION = "Electron은 Chrome 확장 API 일부만 지원합니다. 설치돼도 일부 기능이 작동하지 않을 수 있습니다. 확장의 사이트 접근 권한은 manifest.json에 따라 적용됩니다. 설치 후 현재 탭을 새로고침하세요.";
const REACT_DEVTOOLS_ID = "fmkadmapgofadopljbjfkapdkoienihi";
const errorText = (error) => String(error?.message || error);

function extensionPageURL(id, resource) {
  if (!/^[a-p]{32}$/.test(id) || typeof resource !== "string" || !resource) return null;
  try {
    const decoded = decodeURIComponent(resource);
    if (/^[a-z][a-z\d+.-]*:/i.test(decoded) || decoded.startsWith("/") || decoded.includes("\\")
      || decoded.split(/[/?#]/).includes("..")) return null;
    const url = new URL(resource, `chrome-extension://${id}/`);
    return url.protocol === "chrome-extension:" && url.hostname === id ? url.href : null;
  } catch { return null; }
}

function createBrowserExtensions(deps) {
  const { app, BrowserWindow, webContents, sessionFromPartition, forEachHardened, onSessionHardened, isTrustedSender, isProfilePartition } = deps;
  const root = path.join((deps.stateHomeImpl || stateHome)(), "browser-extensions");
  const registryPath = path.join(root, "registry.json");
  const sessions = new Map();
  const failures = new Map();
  const popups = new Map();
  let queue = Promise.resolve();
  let records = {};
  try {
    records = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    if (!records || typeof records !== "object" || Array.isArray(records)) throw new Error("확장 저장 파일 형식이 올바르지 않습니다.");
    for (const [partition, list] of Object.entries(records)) {
      if (!isProfilePartition(partition) || !Array.isArray(list)
        || list.some((record) => !/^[0-9a-f-]{36}$/.test(record.key) || typeof record.enabled !== "boolean")) {
        throw new Error("확장 저장 파일 형식이 올바르지 않습니다.");
      }
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }

  function save() {
    fs.mkdirSync(root, { recursive: true });
    const temporary = `${registryPath}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, JSON.stringify(records, null, 2)); fs.renameSync(temporary, registryPath); }
    finally { fs.rmSync(temporary, { force: true }); }
  }

  function serial(operation) {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }

  function directory(record) {
    const result = path.join(root, "files", record.key);
    const resolved = fs.realpathSync(result);
    if (!inside(fs.realpathSync(path.join(root, "files")), resolved)) throw new Error("저장된 확장 경로가 올바르지 않습니다.");
    return resolved;
  }

  function owned(partition) {
    const session = sessions.get(partition);
    if (!session || !session.isPersistent()) throw new Error("현재 브라우저 프로필을 확인할 수 없습니다.");
    return session;
  }

  function closePopup(partition, id) {
    const key = `${partition}:${id}`;
    const popup = popups.get(key);
    if (popup && !popup.isDestroyed()) popup.close();
    popups.delete(key);
  }

  function ownsExtension(record, extension) {
    if (!extension) return false;
    try { return path.resolve(extension.path) === directory(record); } catch { return false; }
  }

  function unload(partition, record) {
    const api = owned(partition).extensions;
    const ours = ownsExtension(record, api.getExtension(record.id));
    let target = path.join(root, "files", record.key);
    try { target = directory(record); } catch {}
    deps.compatibility?.revokePath(owned(partition), target);
    if (!ours) return false;
    api.removeExtension(record.id);
    return true;
  }

  async function load(partition, record) {
    const api = owned(partition).extensions;
    const target = directory(record);
    deps.compatibility?.authorizePath(owned(partition), target);
    if (record.id && api.getExtension(record.id)) {
      const existing = api.getExtension(record.id);
      if (path.resolve(existing.path) !== target) throw new Error("같은 ID의 확장을 다른 기능에서 사용 중입니다.");
      return existing;
    }
    const extension = await api.loadExtension(target);
    if (!extension?.id || !api.getExtension(extension.id)) throw new Error("Electron에서 확장 설치를 확인하지 못했습니다.");
    if (record.sourceId && record.sourceId !== extension.id) {
      api.removeExtension(extension.id);
      throw new Error("Chrome의 확장 ID와 가져온 확장 ID가 다릅니다.");
    }
    record.id = extension.id;
    failures.delete(`${partition}:${record.key}`);
    return extension;
  }

  function restore(partition, session) {
    if (!isProfilePartition(partition)) return Promise.resolve();
    sessions.set(partition, session || sessionFromPartition(partition));
    return serial(async () => {
      await app.whenReady();
      for (const record of records[partition] || []) {
        if (!record.enabled) continue;
        try { await load(partition, record); }
        catch (error) {
          failures.set(`${partition}:${record.key}`, errorText(error));
          deps.error?.("[browser-extensions]", partition, errorText(error));
          deps.notice?.({ text: `${record.name || "확장"} 복원 실패`, detail: errorText(error) });
        }
      }
    });
  }

  function targetFor(event, guestId) {
    if (!isTrustedSender(event) || !Number.isSafeInteger(guestId) || guestId <= 0) throw new Error("브라우저 탭을 확인할 수 없습니다.");
    const guest = webContents.fromId(guestId);
    if (!guest || guest.isDestroyed() || event.sender.isDestroyed() || guest.getType() !== "webview"
      || guest.hostWebContents !== event.sender) throw new Error("현재 창의 브라우저 탭이 아닙니다.");
    const partition = [...sessions].find(([, session]) => session === guest.session)?.[0];
    if (!partition) throw new Error("현재 브라우저 프로필을 확인할 수 없습니다.");
    return { guest, partition, session: owned(partition), parent: BrowserWindow.fromWebContents(event.sender) };
  }

  function install(partition, candidate) {
    return serial(async () => {
      await app.whenReady();
      const api = owned(partition).extensions;
      if (candidate.sourceId === REACT_DEVTOOLS_ID || (candidate.sourceId && (api.getExtension(candidate.sourceId)
        || (records[partition] || []).some((record) => record.sourceId === candidate.sourceId)))) {
        throw new Error("이미 다른 기능에서 사용하는 확장입니다.");
      }
      const record = { key: randomUUID(), enabled: true, name: candidate.name || "확장", sourceId: candidate.sourceId || null };
      const destination = path.join(root, "files", record.key);
      try {
        const manifest = copyExtension(candidate.path, destination);
        if (manifest.key) {
          const id = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32)
            .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + parseInt(digit, 16)));
          if (id === REACT_DEVTOOLS_ID || api.getExtension(id)
            || (records[partition] || []).some((item) => item.id === id)) throw new Error("이미 설치되거나 다른 기능에서 사용하는 확장입니다.");
        }
        record.name = displayName(destination, manifest);
        const extension = await load(partition, record);
        record.name = extension.name || record.name;
        (records[partition] ||= []).push(record);
        try { save(); }
        catch (error) { records[partition].pop(); unload(partition, record); throw error; }
        return record;
      } catch (error) { deps.compatibility?.revokePath(owned(partition), destination); fs.rmSync(destination, { recursive: true, force: true }); throw error; }
    });
  }

  function setEnabled(partition, key, enabled) {
    return serial(async () => {
      const record = (records[partition] || []).find((item) => item.key === key);
      if (!record) throw new Error("설치된 확장을 찾을 수 없습니다.");
      const previous = record.enabled;
      if (enabled) await load(partition, record);
      const unloaded = !enabled && unload(partition, record);
      record.enabled = enabled;
      try { save(); } catch (error) {
        record.enabled = previous;
        if (enabled && !previous) unload(partition, record);
        if (unloaded) await load(partition, record);
        throw error;
      }
      if (!enabled) closePopup(partition, record.id);
    });
  }

  function remove(partition, key) {
    return serial(async () => {
      const list = records[partition] || [];
      const index = list.findIndex((item) => item.key === key);
      if (index < 0) throw new Error("설치된 확장을 찾을 수 없습니다.");
      const record = list[index];
      const unloaded = unload(partition, record);
      list.splice(index, 1);
      try { save(); } catch (error) { list.splice(index, 0, record); if (unloaded) await load(partition, record); throw error; }
      closePopup(partition, record.id);
      fs.rmSync(path.join(root, "files", record.key), { recursive: true, force: true });
      failures.delete(`${partition}:${key}`);
    });
  }

  async function openPage(target, extension, resource) {
    const url = extensionPageURL(extension.id, resource);
    if (!url) throw new Error("확장 화면 주소가 올바르지 않습니다.");
    const key = `${target.partition}:${extension.id}`;
    const existing = popups.get(key);
    if (existing && !existing.isDestroyed()) {
      if (existing.webContents.getURL() !== url) await existing.loadURL(url);
      existing.focus();
      return existing;
    }
    const popup = new BrowserWindow({ parent: target.parent, width: 440, height: 600, show: false,
      title: extension.name, autoHideMenuBar: true,
      webPreferences: { session: target.session, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false },
    });
    popups.set(key, popup);
    popup.on("closed", () => { if (popups.get(key) === popup) popups.delete(key); });
    popup.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const allowed = (raw) => { try { const parsed = new URL(raw); return parsed.protocol === "chrome-extension:" && parsed.hostname === extension.id; } catch { return false; } };
    popup.webContents.on("will-navigate", (event, raw) => { if (!allowed(raw)) event.preventDefault(); });
    popup.webContents.on("will-redirect", (event, raw) => { if (!allowed(raw)) event.preventDefault(); });
    try { await popup.loadURL(url); if (!popup.isDestroyed()) popup.show(); return popup; }
    catch (error) { if (!popup.isDestroyed()) popup.close(); throw error; }
  }

  function nativeUI() { return deps.nativeUI || require("electron"); }
  function message(parent, title, detail, type = "info") {
    const options = { type, title, message: title, detail, buttons: ["확인"] };
    return parent ? nativeUI().dialog.showMessageBox(parent, options) : nativeUI().dialog.showMessageBox(options);
  }

  async function showMenu(event, request = {}) {
    await app.whenReady();
    await ready;
    await queue;
    const target = targetFor(event, request.guestWebContentsId);
    const run = (operation, success) => async () => {
      try { const current = targetFor(event, request.guestWebContentsId); await operation(current); if (success) await message(current.parent, success, LIMITATION); }
      catch (error) { await message(target.parent, "확장 작업 실패", errorText(error), "error"); }
    };
    const loaded = target.session.extensions.getAllExtensions();
    const managed = records[target.partition] || [];
    const items = [{ label: "현재 프로필의 확장", enabled: false }];
    for (const record of managed) {
      const extension = loaded.find((item) => item.id === record.id && ownsExtension(record, item));
      const submenu = [];
      if (extension) {
        const manifest = extension.manifest || readManifest(directory(record));
        const popup = manifest.action?.default_popup || manifest.browser_action?.default_popup;
        const options = manifest.options_ui?.page || manifest.options_page;
        if (popup) submenu.push({ label: "확장 열기", click: run((current) => openPage(current, extension, popup)) });
        if (options) submenu.push({ label: "설정 열기", click: run((current) => openPage(current, extension, options)) });
      }
      submenu.push({ label: "사용", type: "checkbox", checked: !!extension, click: run(() => setEnabled(target.partition, record.key, !extension)) });
      if (failures.has(`${target.partition}:${record.key}`)) submenu.push({ label: "로드 실패 내용", click: run(() => message(target.parent, "확장 로드 실패", failures.get(`${target.partition}:${record.key}`), "error")) });
      submenu.push({ label: "제거", click: run(() => remove(target.partition, record.key)) });
      items.push({ label: record.name, submenu });
    }
    for (const extension of loaded.filter((item) => !managed.some((record) => record.id === item.id && ownsExtension(record, item)))) {
      items.push({ label: `${extension.name} (다른 기능에서 관리)`, enabled: false });
    }
    if (items.length === 1) items.push({ label: "설치된 확장 없음", enabled: false });
    const profiles = (deps.discoverChromeExtensions || discoverChromeExtensions)();
    items.push({ type: "separator" }, { label: "Chrome에서 가져오기", submenu: profiles.length ? profiles.map((profile) => ({
      label: profile.name, submenu: profile.candidates.map((candidate) => ({ label: `${candidate.name} ${candidate.version}`,
        enabled: candidate.sourceId !== REACT_DEVTOOLS_ID && !loaded.some((extension) => extension.id === candidate.sourceId)
          && !managed.some((record) => record.sourceId === candidate.sourceId),
        click: run(() => install(target.partition, candidate), "확장 설치 완료"),
      })),
    })) : [{ label: "가져올 Chrome 확장 없음", enabled: false }] });
    items.push({ label: "압축 해제된 확장 폴더 선택…", click: run(async () => {
      const options = { title: "manifest.json이 있는 확장 폴더 선택", properties: ["openDirectory"] };
      const result = target.parent ? await nativeUI().dialog.showOpenDialog(target.parent, options) : await nativeUI().dialog.showOpenDialog(options);
      if (!result.canceled && result.filePaths.length === 1) {
        await install(target.partition, { path: result.filePaths[0] });
        await message(target.parent, "확장 설치 완료", LIMITATION);
      }
    }) });
    items.push({ type: "separator" }, { label: "확장 지원 범위", click: run(() => message(target.parent, "확장 지원 범위", LIMITATION)) });
    nativeUI().Menu.buildFromTemplate(items).popup(target.parent ? { window: target.parent } : {});
    return { ok: true };
  }

  const unsubscribe = onSessionHardened((partition, session) => { void restore(partition, session).catch((error) => deps.error?.("[browser-extensions]", errorText(error))); });
  const ready = app.whenReady().then(() => forEachHardened((partition) => restore(partition))).then(() => undefined);
  return { ready, install, setEnabled, remove, restore, showMenu, targetFor, openPage, unsubscribe };
}

function initCapability(ctx) {
  let compatibility = ctx.compatibility;
  if (!compatibility && typeof ctx.app.on === "function") {
    const tabs = require("./browser-extension-tabs.cjs").createExtensionTabs(ctx);
    compatibility = require("./browser-extension-compatibility.cjs").createExtensionCompatibility({ ...ctx, createTab: (session, properties) => tabs.create(session, properties) });
  }
  const manager = createBrowserExtensions({ ...ctx, compatibility });
  manager.ready.catch((error) => ctx.error?.("[browser-extensions]", errorText(error)));
  ctx.ipcMain.handle("ac-browser-extensions-menu", async (event, request) => {
    if (!ctx.isTrustedSender(event)) return { ok: false, error: "신뢰되지 않은 발신자입니다." };
    try { return await manager.showMenu(event, request); }
    catch (error) { return { ok: false, error: errorText(error) }; }
  });
  return manager;
}

module.exports = { createBrowserExtensions, extensionPageURL, initCapability };
