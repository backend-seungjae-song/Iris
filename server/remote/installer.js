import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function powershellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function timestamp(value) {
  return value.toISOString().replaceAll(/[-:.]/g, "");
}

export function createQuestionHookInstaller(options = {}) {
  const settingsPath = options.settingsPath || path.join(os.homedir(), ".claude", "settings.json");
  const nodePath = options.nodePath || process.execPath;
  const hookPath = options.hookPath;
  const socketPath = options.socketPath;
  const now = options.now || (() => new Date());
  const asNode = options.asNode ?? true;
  const windows = (options.platform || process.platform) === "win32";
  const paths = windows ? path.win32 : path;
  if (![nodePath, hookPath, socketPath].every((value) => typeof value === "string" && paths.isAbsolute(value))) {
    throw new TypeError("question hook paths must be absolute");
  }
  const command = windows
    ? `${asNode ? "$env:ELECTRON_RUN_AS_NODE='1'; " : ""}& ${[nodePath, hookPath, socketPath].map(powershellQuote).join(" ")}; exit $LASTEXITCODE`
    : `${asNode ? "ELECTRON_RUN_AS_NODE=1 " : ""}${[nodePath, hookPath, socketPath].map(shellQuote).join(" ")}`;
  const hook = { type: "command", command, timeout: 600, ...(windows ? { shell: "powershell" } : {}) };

  function isIrisGroup(group) {
    return group?.matcher === "AskUserQuestion"
      && Array.isArray(group.hooks)
      && group.hooks.some((hook) => hook?.type === "command" && hook.command === command);
  }

  async function readSettings() {
    try {
      const raw = await fsp.readFile(settingsPath, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid settings");
      return { ok: true, value: parsed, raw };
    } catch (cause) {
      if (cause?.code === "ENOENT") return { ok: true, value: {}, raw: null };
      return { ok: false, error: "settings-invalid" };
    }
  }

  async function isInstalled() {
    const loaded = await readSettings();
    if (!loaded.ok) return false;
    return Array.isArray(loaded.value.hooks?.PreToolUse)
      && loaded.value.hooks.PreToolUse.some(isIrisGroup);
  }

  async function save(value, raw) {
    const directory = path.dirname(settingsPath);
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    if (raw !== null) {
      const base = path.join(directory, `.iris-backup-${timestamp(now())}`);
      for (let suffix = 0; ; suffix++) {
        const backup = suffix === 0 ? base : `${base}-${suffix}`;
        try { await fsp.writeFile(backup, raw, { flag: "wx", mode: 0o600 }); break; }
        catch (cause) { if (cause?.code !== "EEXIST") throw cause; }
      }
    }
    const temporary = path.join(directory, `.settings.json.iris-${process.pid}-${Date.now()}.tmp`);
    try {
      await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await fsp.rename(temporary, settingsPath);
    } finally {
      await fsp.unlink(temporary).catch(() => {});
    }
  }

  async function install() {
    const loaded = await readSettings();
    if (!loaded.ok) return loaded;
    const settings = structuredClone(loaded.value);
    settings.hooks ||= {};
    const groups = Array.isArray(settings.hooks.PreToolUse) ? settings.hooks.PreToolUse : [];
    if (groups.some(isIrisGroup)) return { ok: true, installed: true, unchanged: true };
    settings.hooks.PreToolUse = [...groups, {
      matcher: "AskUserQuestion",
      hooks: [hook],
    }];
    try {
      await save(settings, loaded.raw);
      return { ok: true, installed: true };
    } catch {
      return { ok: false, error: "settings-save-failed" };
    }
  }

  async function remove() {
    const loaded = await readSettings();
    if (!loaded.ok) return loaded;
    const settings = structuredClone(loaded.value);
    const groups = Array.isArray(settings.hooks?.PreToolUse) ? settings.hooks.PreToolUse : [];
    if (!groups.some(isIrisGroup)) return { ok: true, installed: false, unchanged: true };
    // 같은 그룹에 사용자가 넣은 다른 hook 보존
    const kept = groups.flatMap((group) => {
      if (!isIrisGroup(group)) return [group];
      const hooks = group.hooks.filter((hook) => !(hook?.type === "command" && hook.command === command));
      return hooks.length ? [{ ...group, hooks }] : [];
    });
    if (kept.length) settings.hooks.PreToolUse = kept;
    else delete settings.hooks.PreToolUse;
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    try {
      await save(settings, loaded.raw);
      return { ok: true, installed: false };
    } catch {
      return { ok: false, error: "settings-save-failed" };
    }
  }

  return { command, settingsPath, isInstalled, install, remove };
}
