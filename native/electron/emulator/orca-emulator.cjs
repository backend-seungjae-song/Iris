// 생성 파일. 직접 고치지 않는다. scripts/vendor-orca-emulator.mjs 로 다시 만든다.
// 원본: https://github.com/stablyai/orca @ 841d06a9690c551ec8d4f70a72376632ffa3c2e5
// MIT License
//
// Copyright (c) 2026 Lovecast Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// iris-main-entry.ts
var iris_main_entry_exports = {};
__export(iris_main_entry_exports, {
  EMULATOR_METHODS: () => EMULATOR_METHODS,
  EmulatorBridge: () => EmulatorBridge,
  RuntimeEmulatorCommands: () => RuntimeEmulatorCommands,
  registerEmulatorFrameStreamHandlers: () => registerEmulatorFrameStreamHandlers,
  registerEmulatorVideoStreamHandlers: () => registerEmulatorVideoStreamHandlers
});
module.exports = __toCommonJS(iris_main_entry_exports);

// src/main/emulator/emulator-bridge.ts
var import_node_os9 = require("node:os");

// src/main/emulator/emulator-errors.ts
var EmulatorError = class extends Error {
  static {
    __name(this, "EmulatorError");
  }
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "EmulatorError";
  }
};

// src/main/emulator/emulator-session-registry.ts
var EmulatorSessionRegistry = class {
  static {
    __name(this, "EmulatorSessionRegistry");
  }
  activeByWorktree = /* @__PURE__ */ new Map();
  sessions = /* @__PURE__ */ new Map();
  registerActive(worktreeId, info, options = {}) {
    const key = info.deviceUdid;
    this.sessions.set(key, {
      deviceUdid: info.deviceUdid,
      wsUrl: info.wsUrl,
      streamUrl: info.streamUrl,
      axUrl: info.axUrl,
      pid: info.helperPid,
      managed: options.managed === true,
      initialized: true,
      // Why: default to the iOS/serve-sim contract so existing callers that
      // predate multi-backend keep their prior behavior.
      backend: info.backend ?? options.backend ?? "ios",
      streamCodec: info.streamCodec ?? "mjpeg"
    });
    this.activeByWorktree.set(worktreeId, key);
  }
  unregisterWorktree(worktreeId) {
    this.activeByWorktree.delete(worktreeId);
  }
  getActiveForWorktree(worktreeId) {
    if (!worktreeId) {
      return null;
    }
    const key = this.activeByWorktree.get(worktreeId);
    if (!key) {
      return null;
    }
    const session = this.sessions.get(key);
    return session ? toSessionInfo(session) : null;
  }
  getActiveSessionKey(worktreeId) {
    return this.activeByWorktree.get(worktreeId) ?? null;
  }
  getSession(key) {
    return this.sessions.get(key);
  }
  toSessionInfo(session) {
    return toSessionInfo(session);
  }
  hasActiveWorktreeForSession(key) {
    return [...this.activeByWorktree.values()].some((activeKey) => activeKey === key);
  }
  listSessions() {
    return [...this.sessions.values()];
  }
  clearSessionAndWorktrees(key) {
    this.sessions.delete(key);
    for (const [worktreeId, activeKey] of this.activeByWorktree.entries()) {
      if (activeKey === key) {
        this.activeByWorktree.delete(worktreeId);
      }
    }
  }
  clear() {
    this.sessions.clear();
    this.activeByWorktree.clear();
  }
};
function toSessionInfo(session) {
  return {
    deviceUdid: session.deviceUdid,
    wsUrl: session.wsUrl,
    streamUrl: session.streamUrl,
    axUrl: session.axUrl,
    helperPid: session.pid,
    streamCodec: session.streamCodec
  };
}
__name(toSessionInfo, "toSessionInfo");

// src/main/emulator/emulator-start-lease-registry.ts
var EmulatorStartLeaseRegistry = class {
  static {
    __name(this, "EmulatorStartLeaseRegistry");
  }
  claimsByBackend = /* @__PURE__ */ new Map();
  cleanupByBackend = /* @__PURE__ */ new Map();
  pendingCleanupByBackend = /* @__PURE__ */ new Map();
  async acquire(backend, device, isRegistered) {
    this.claimsByBackend.set(backend, (this.claimsByBackend.get(backend) ?? 0) + 1);
    try {
      await this.cleanupByBackend.get(backend);
      const info = await backend.startSession(device);
      let released = false;
      return {
        info,
        release: /* @__PURE__ */ __name(async (options = {}) => {
          if (released) {
            return;
          }
          released = true;
          if (options.cleanupIfUnused) {
            this.addPendingCleanup(backend, info, isRegistered, {
              includeOrphaned: true,
              shutdownDevice: true
            });
          }
          await this.release(backend);
        }, "release")
      };
    } catch (error) {
      await this.release(backend);
      throw error;
    }
  }
  async cleanupWhenIdle(backend, info, isRegistered, options = {}) {
    this.addPendingCleanup(backend, info, isRegistered, options);
    await this.drainCleanup(backend);
  }
  async release(backend) {
    const remaining = this.decrement(backend);
    if (remaining > 0) {
      return;
    }
    await this.drainCleanup(backend);
  }
  async drainCleanup(backend) {
    await this.cleanupByBackend.get(backend);
    if ((this.claimsByBackend.get(backend) ?? 0) > 0) {
      return;
    }
    const pending = this.pendingCleanupByBackend.get(backend);
    this.pendingCleanupByBackend.delete(backend);
    if (!pending) {
      return;
    }
    const cleanup = Promise.allSettled(
      [...pending.values()].map(async ({ info, isRegistered, includeOrphaned, shutdownDevice }) => {
        if (isRegistered(info)) {
          return;
        }
        await backend.stopHelperForDevice(info.deviceUdid, {
          helperPid: info.helperPid,
          includeOrphaned
        });
        if (shutdownDevice) {
          await backend.shutdownDevice(info.deviceUdid);
        }
      })
    ).then(() => void 0).finally(() => this.cleanupByBackend.delete(backend));
    this.cleanupByBackend.set(backend, cleanup);
    await cleanup;
  }
  addPendingCleanup(backend, info, isRegistered, options) {
    const pending = this.pendingCleanupByBackend.get(backend) ?? /* @__PURE__ */ new Map();
    const existing = pending.get(info.deviceUdid);
    pending.set(info.deviceUdid, {
      info,
      isRegistered,
      includeOrphaned: options.includeOrphaned === true || existing?.includeOrphaned === true,
      shutdownDevice: options.shutdownDevice === true || existing?.shutdownDevice === true
    });
    this.pendingCleanupByBackend.set(backend, pending);
  }
  decrement(backend) {
    const next = Math.max(0, (this.claimsByBackend.get(backend) ?? 1) - 1);
    if (next === 0) {
      this.claimsByBackend.delete(backend);
    } else {
      this.claimsByBackend.set(backend, next);
    }
    return next;
  }
};

// src/main/emulator/emulator-device-inventory.ts
async function listAvailableEmulatorDevices(backends) {
  const perBackend = await Promise.all(
    backends.map(async (backend) => {
      if (!backend.isSupportedOnHost()) {
        return [];
      }
      try {
        return await backend.listDevices();
      } catch {
        return [];
      }
    })
  );
  return perBackend.flat();
}
__name(listAvailableEmulatorDevices, "listAvailableEmulatorDevices");

// src/main/emulator/serve-sim-detached-session.ts
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
var import_node_os = require("node:os");
var MJPEG_STREAM_SUFFIX = "/stream.mjpeg";
function streamUrlFromServeSimUrl(url) {
  return url.endsWith(MJPEG_STREAM_SUFFIX) ? url : `${url.replace(/\/$/, "")}${MJPEG_STREAM_SUFFIX}`;
}
__name(streamUrlFromServeSimUrl, "streamUrlFromServeSimUrl");
function deriveAxUrlFromStreamUrl(streamUrl) {
  if (!streamUrl || !streamUrl.endsWith(MJPEG_STREAM_SUFFIX)) {
    return void 0;
  }
  return `${streamUrl.slice(0, -MJPEG_STREAM_SUFFIX.length)}/ax`;
}
__name(deriveAxUrlFromStreamUrl, "deriveAxUrlFromStreamUrl");
function parseServeSimDetachedSession(raw, udid) {
  if (!raw || typeof raw !== "object") {
    throw new EmulatorError("emulator_helper_failed", "serve-sim did not return stream endpoints.");
  }
  const json = raw;
  const wsUrl = typeof json.wsUrl === "string" ? json.wsUrl : void 0;
  const streamUrl = typeof json.streamUrl === "string" ? json.streamUrl : typeof json.url === "string" ? streamUrlFromServeSimUrl(json.url) : void 0;
  const info = {
    deviceUdid: typeof json.device === "string" ? json.device : udid,
    wsUrl: wsUrl ?? "",
    streamUrl: streamUrl ?? "",
    axUrl: typeof json.axUrl === "string" ? json.axUrl : deriveAxUrlFromStreamUrl(streamUrl)
  };
  if (!info.streamUrl || !info.wsUrl) {
    throw new EmulatorError("emulator_helper_failed", "serve-sim did not return stream endpoints.");
  }
  try {
    const statePath = (0, import_node_path.join)((0, import_node_os.tmpdir)(), "serve-sim", `server-${info.deviceUdid}.json`);
    if ((0, import_node_fs.existsSync)(statePath)) {
      const state = JSON.parse((0, import_node_fs.readFileSync)(statePath, "utf8"));
      if (typeof state.pid === "number") {
        info.helperPid = state.pid;
      }
    }
  } catch {
  }
  return info;
}
__name(parseServeSimDetachedSession, "parseServeSimDetachedSession");

// src/main/emulator/backends/ios-emulator-backend.ts
var import_node_os6 = require("node:os");

// src/main/emulator/simctl-simulator-devices.ts
var import_node_child_process4 = require("node:child_process");
var import_node_os3 = require("node:os");

// src/shared/child-process/run-process.ts
var import_node_child_process2 = require("node:child_process");

// src/shared/child-process/windows-command-line.ts
function quoteWindows(value, escapePercent) {
  if (!(escapePercent ? /[\\"%]/ : /[\\"]/).test(value)) {
    return `"${value}"`;
  }
  let quoted = '"';
  let backslashes = 0;
  for (const char of value) {
    if (char === "\\") {
      backslashes += 1;
      continue;
    }
    if (char === '"') {
      quoted += `${"\\".repeat(backslashes * 2)}""`;
      backslashes = 0;
      continue;
    }
    if (escapePercent && char === "%") {
      quoted += `${"\\".repeat(backslashes * 2)}"^%"`;
      backslashes = 0;
      continue;
    }
    quoted += `${"\\".repeat(backslashes)}${char}`;
    backslashes = 0;
  }
  return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}
__name(quoteWindows, "quoteWindows");
function quoteWindowsCmdArgument(value) {
  return quoteWindows(value, true);
}
__name(quoteWindowsCmdArgument, "quoteWindowsCmdArgument");
function buildWindowsCmdShimCommandLine(program, args) {
  for (const value of [program, ...args]) {
    if (/[\r\n]/.test(value)) {
      throw new Error("cmd.exe cannot receive an argument containing a line break");
    }
  }
  const inner = [program, ...args].map(quoteWindowsCmdArgument).join(" ");
  return `/d /v:off /s /c "${inner}"`;
}
__name(buildWindowsCmdShimCommandLine, "buildWindowsCmdShimCommandLine");
var CMD_INTERPRETED_EXTENSIONS = [".cmd", ".bat"];
function isCmdInterpretedProgram(program) {
  const lower = program.toLowerCase();
  return CMD_INTERPRETED_EXTENSIONS.some((extension) => lower.endsWith(extension));
}
__name(isCmdInterpretedProgram, "isCmdInterpretedProgram");

// src/shared/child-process/windows-cmd-shim-resolution.ts
var import_node_fs2 = require("node:fs");
var import_node_path2 = require("node:path");
var DISABLE_FLAG = "ORCA_DISABLE_CMD_SHIM_RESOLUTION";
var MAX_SHIM_BYTES = 64 * 1024;
var DP0 = String.raw`(?:%~dp0|%dp0%)\\?`;
var DP0_NODE_EXE = `"${DP0}node\\.exe"`;
var dp0Path = /* @__PURE__ */ __name((group) => `"${DP0}(?<${group}>[^"\\r\\n]+)"`, "dp0Path");
var ECHO_OFF = String.raw`@echo off\n`;
var FIND_DP0 = String.raw`GOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT /b\n:start\nSETLOCAL\nCALL :find_dp0\n`;
var NODE_PATH_BLOCK = String.raw`(?:@IF NOT DEFINED NODE_PATH \(\n@SET "NODE_PATH=(?<nodePath>[^"\r\n]*)"\n\) ELSE \(\n@SET "NODE_PATH=(?<nodePathElse>[^"\r\n]*)"\n\)\n)?`;
var PATHEXT_STRIP = String.raw`SET PATHEXT=%PATHEXT:;\.JS;=;%`;
var NPM_PROG_NODE_SHIM = new RegExp(
  String.raw`^${ECHO_OFF}${FIND_DP0}IF EXIST ${DP0_NODE_EXE} \(\nSET "_prog=${DP0}node\.exe"\n\) ELSE \(\nSET "_prog=node"\n${PATHEXT_STRIP}\n\)\nendLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & "%_prog%" +${dp0Path("script")} +%\*$`,
  "i"
);
var BRANCHED_NODE_SHIM = new RegExp(
  String.raw`^(?:@SETLOCAL\n)?${NODE_PATH_BLOCK}@?IF EXIST ${DP0_NODE_EXE} \(\n${DP0_NODE_EXE} +${dp0Path("script")} +%\*\n\) ELSE \(\n(?:@?SETLOCAL\n)?@?${PATHEXT_STRIP}\nnode +${dp0Path("scriptElse")} +%\*\n\)$`,
  "i"
);
var NPM_DIRECT_SHIM = new RegExp(
  String.raw`^${ECHO_OFF}(?:${FIND_DP0})?${dp0Path("target")} +%\*$`,
  "i"
);
var PNPM_DIRECT_SHIM = new RegExp(String.raw`^(?:@SETLOCAL\n)?@?${dp0Path("target")} +%\*$`, "i");
var UNSAFE_SHIM_PATH = /[%^&|<>":\r\n]/;
var DIRECT_TARGET_EXTENSIONS = [".exe", ".com"];
function isPlainRelativePath(spelled) {
  return !UNSAFE_SHIM_PATH.test(spelled) && !import_node_path2.win32.isAbsolute(spelled);
}
__name(isPlainRelativePath, "isPlainRelativePath");
function canonicalize(contents) {
  return contents.replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0).join("\n");
}
__name(canonicalize, "canonicalize");
function parseWindowsCmdShim(contents) {
  const canonical = canonicalize(contents);
  const prog = NPM_PROG_NODE_SHIM.exec(canonical)?.groups;
  if (prog?.script) {
    return isPlainRelativePath(prog.script) ? { kind: "node", script: prog.script } : null;
  }
  const branched = BRANCHED_NODE_SHIM.exec(canonical)?.groups;
  if (branched?.script) {
    if (branched.script !== branched.scriptElse || !isPlainRelativePath(branched.script)) {
      return null;
    }
    const nodePath = branched.nodePath;
    if (nodePath === void 0) {
      return { kind: "node", script: branched.script };
    }
    if (nodePath.includes("%") || branched.nodePathElse !== `${nodePath};%NODE_PATH%`) {
      return null;
    }
    return { kind: "node", script: branched.script, nodePathPrefix: nodePath };
  }
  for (const pattern of [NPM_DIRECT_SHIM, PNPM_DIRECT_SHIM]) {
    const target = pattern.exec(canonical)?.groups?.target;
    if (target) {
      return isPlainRelativePath(target) ? { kind: "direct", target } : null;
    }
  }
  return null;
}
__name(parseWindowsCmdShim, "parseWindowsCmdShim");
var parseCache = /* @__PURE__ */ new Map();
var PARSE_CACHE_LIMIT = 256;
var nodeCache = /* @__PURE__ */ new Map();
var NODE_CACHE_LIMIT = 256;
function statFile(path2) {
  try {
    const stats = (0, import_node_fs2.statSync)(path2);
    return stats.isFile() ? stats : null;
  } catch {
    return null;
  }
}
__name(statFile, "statFile");
function readParsedShim(program) {
  const stats = statFile(program);
  if (!stats || stats.size > MAX_SHIM_BYTES) {
    return null;
  }
  const cached = parseCache.get(program);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    return cached.parsed;
  }
  let contents;
  try {
    contents = (0, import_node_fs2.readFileSync)(program, "utf8");
  } catch {
    return null;
  }
  const parsed = parseWindowsCmdShim(contents);
  if (parseCache.size >= PARSE_CACHE_LIMIT) {
    parseCache.clear();
  }
  parseCache.set(program, { mtimeMs: stats.mtimeMs, size: stats.size, parsed });
  return parsed;
}
__name(readParsedShim, "readParsedShim");
function firstEnvKey(env, name) {
  const lower = name.toLowerCase();
  return Object.keys(env).find((key) => key.toLowerCase() === lower && env[key] !== void 0);
}
__name(firstEnvKey, "firstEnvKey");
var DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";
function resolveShimNode(directory, env) {
  const pathKey = firstEnvKey(env, "PATH");
  const pathValue = (pathKey ? env[pathKey] : void 0) ?? "";
  const pathExtKey = firstEnvKey(env, "PATHEXT");
  const pathExtValue = (pathExtKey ? env[pathExtKey] : void 0) || DEFAULT_PATHEXT;
  const key = `${directory}
${pathValue}
${pathExtValue}`;
  const cached = nodeCache.get(key);
  if (cached !== void 0 && (cached === null || statFile(cached))) {
    return cached;
  }
  const resolved = probeShimNode(directory, pathValue, pathExtValue);
  if (nodeCache.size >= NODE_CACHE_LIMIT) {
    nodeCache.clear();
  }
  nodeCache.set(key, resolved);
  return resolved;
}
__name(resolveShimNode, "resolveShimNode");
function probeShimNode(directory, pathValue, pathExtValue) {
  const sibling = import_node_path2.win32.join(directory, "node.exe");
  if (statFile(sibling)) {
    return sibling;
  }
  const extensions = pathExtValue.split(";").map((extension) => extension.trim().toLowerCase()).filter((extension) => extension.startsWith("."));
  for (const entry of pathValue.split(";")) {
    const trimmed = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!trimmed || !import_node_path2.win32.isAbsolute(trimmed)) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = import_node_path2.win32.join(trimmed, `node${extension}`);
      if (!statFile(candidate)) {
        continue;
      }
      return extension === ".exe" ? candidate : null;
    }
  }
  return null;
}
__name(probeShimNode, "probeShimNode");
function withNodePath(env, prefix) {
  const key = firstEnvKey(env, "NODE_PATH") ?? "NODE_PATH";
  const existing = env[key];
  return { ...env, [key]: existing ? `${prefix};${existing}` : prefix };
}
__name(withNodePath, "withNodePath");
function resolveWindowsCmdShim(program, env) {
  const disableKey = firstEnvKey(env, DISABLE_FLAG);
  if (disableKey && env[disableKey]) {
    return null;
  }
  if (!import_node_path2.win32.isAbsolute(program)) {
    return null;
  }
  const parsed = readParsedShim(program);
  if (!parsed) {
    return null;
  }
  const directory = import_node_path2.win32.dirname(program);
  if (parsed.kind === "direct") {
    const target = import_node_path2.win32.resolve(directory, parsed.target);
    const lower = target.toLowerCase();
    if (!DIRECT_TARGET_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
      return null;
    }
    return statFile(target) ? { program: target, prefixArgs: [] } : null;
  }
  const script = import_node_path2.win32.resolve(directory, parsed.script);
  if (!statFile(script)) {
    return null;
  }
  const node = resolveShimNode(directory, env);
  if (!node) {
    return null;
  }
  return {
    program: node,
    prefixArgs: [script],
    ...parsed.nodePathPrefix ? { env: withNodePath(env, parsed.nodePathPrefix) } : {}
  };
}
__name(resolveWindowsCmdShim, "resolveWindowsCmdShim");

// src/shared/child-process/spawn-resolution.ts
function resolveSpawn(spec, platform9) {
  const args = spec.args ?? [];
  const base = {
    cwd: spec.cwd,
    env: spec.env,
    stdio: spec.stdio ?? ["pipe", "pipe", "pipe"],
    // Why unconditional: Orca's main process is GUI-subsystem and owns no
    // console, so every console-subsystem child it starts gets a fresh visible
    // conhost that takes foreground — keystrokes typed into an Orca terminal at
    // that moment land in the black box instead.
    windowsHide: true,
    detached: spec.detached,
    windowsVerbatimArguments: spec.windowsVerbatimArguments,
    // Why never `shell: true`: it concatenates arguments without escaping (Node
    // itself warns DEP0190) and it silently makes windowsHide a no-op.
    shell: false,
    ...spec.terminationBarrier && platform9 !== "win32" ? { detached: true } : {}
  };
  if (platform9 !== "win32" || !isCmdInterpretedProgram(spec.program)) {
    return { file: spec.program, args, options: base };
  }
  const shim = resolveWindowsCmdShim(spec.program, spec.env ?? process.env);
  if (shim) {
    return {
      file: shim.program,
      args: [...shim.prefixArgs, ...args],
      options: {
        ...base,
        ...shim.env ? { env: shim.env } : {},
        // Why cleared rather than inherited: the flag exists for callers that
        // hand us a whole pre-built command line, and there is no such line
        // here — Node would join `[script, ...args]` unquoted and shred any
        // argument containing a space.
        windowsVerbatimArguments: void 0
      }
    };
  }
  const comSpec = spec.env?.ComSpec ?? process.env.ComSpec ?? "cmd.exe";
  return {
    file: comSpec,
    args: [buildWindowsCmdShimCommandLine(spec.program, args)],
    options: { ...base, windowsVerbatimArguments: true }
  };
}
__name(resolveSpawn, "resolveSpawn");

// src/shared/child-process/process-tree-termination.ts
var import_node_child_process = require("node:child_process");

// src/shared/child-process/process-tree-kill-gate.ts
var gate = null;
function admitProcessTreeKill(kill) {
  try {
    return gate?.(kill) ?? true;
  } catch {
    return true;
  }
}
__name(admitProcessTreeKill, "admitProcessTreeKill");

// src/shared/child-process/process-tree-termination.ts
var PROBE_INTERVAL_MS = 25;
var SUBPROCESS_TIMEOUT_MS = 2e3;
var MAX_PS_OUTPUT_BYTES = 8 * 1024 * 1024;
function signalProcessTree(child, signal) {
  if (!child.pid) {
    killRoot(child, signal);
    return Promise.resolve(true);
  }
  if (process.platform === "win32") {
    if (hasExited(child)) {
      killRoot(child, signal);
      return Promise.resolve(false);
    }
    return taskkillTree(child, child.pid, signal);
  }
  if (!admitProcessTreeKill({
    pid: child.pid,
    site: "run-process-tree",
    scope: "posix-process-group"
  })) {
    killRoot(child, signal);
    return Promise.resolve(false);
  }
  try {
    process.kill(-child.pid, signal);
    return Promise.resolve(true);
  } catch {
    return Promise.resolve(!processGroupExists(child.pid));
  }
}
__name(signalProcessTree, "signalProcessTree");
async function forceTerminateProcessTree(child) {
  const signaled = await signalProcessTree(child, "SIGKILL");
  if (!signaled) {
    return false;
  }
  if (process.platform !== "win32" && child.pid) {
    return waitForPosixProcessGroupQuiescence(child.pid);
  }
  return true;
}
__name(forceTerminateProcessTree, "forceTerminateProcessTree");
function hasExited(child) {
  return (child.exitCode ?? null) !== null || (child.signalCode ?? null) !== null;
}
__name(hasExited, "hasExited");
function taskkillTree(child, rootPid, signal) {
  if (!admitProcessTreeKill({ pid: rootPid, site: "run-process-tree", scope: "win-taskkill-tree" })) {
    killRoot(child, signal);
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let killer;
    try {
      killer = (0, import_node_child_process.spawn)("taskkill", ["/pid", String(rootPid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
        shell: false
      });
    } catch {
      killRoot(child, signal);
      resolve(false);
      return;
    }
    let settled = false;
    const finish = /* @__PURE__ */ __name((fallback) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (fallback) {
        killRoot(child, signal);
      }
      resolve(!fallback);
    }, "finish");
    killer.once("error", () => finish(true));
    killer.once("close", (code) => finish(code !== 0));
    const timer = setTimeout(() => {
      killer.kill();
      finish(true);
    }, SUBPROCESS_TIMEOUT_MS);
    timer.unref?.();
  });
}
__name(taskkillTree, "taskkillTree");
async function waitForPosixProcessGroupQuiescence(processGroupId) {
  const deadline = Date.now() + SUBPROCESS_TIMEOUT_MS;
  while (true) {
    const states = await readPosixProcessGroupStates(processGroupId);
    if (states ? states.every((state) => state.startsWith("Z")) : !processGroupExists(processGroupId)) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
  }
}
__name(waitForPosixProcessGroupQuiescence, "waitForPosixProcessGroupQuiescence");
function readPosixProcessGroupStates(processGroupId) {
  return new Promise((resolve) => {
    let probe;
    try {
      probe = (0, import_node_child_process.spawn)("ps", ["-axo", "pgid=,state="], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        shell: false
      });
    } catch {
      resolve(null);
      return;
    }
    let output = "";
    let truncated = false;
    let settled = false;
    const finish = /* @__PURE__ */ __name((states) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(states);
    }, "finish");
    probe.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      if (output.length + text.length > MAX_PS_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      output += text;
    });
    probe.stdout?.on("error", () => {
    });
    probe.once("error", () => finish(null));
    probe.once("close", (code) => {
      if (code !== 0 || truncated) {
        finish(null);
        return;
      }
      const states = output.split("\n").flatMap((line) => {
        const match = line.trim().match(/^(\d+)\s+(\S+)/);
        return match && Number(match[1]) === processGroupId ? [match[2]] : [];
      });
      finish(states);
    });
    const timer = setTimeout(() => {
      probe.kill();
      finish(null);
    }, SUBPROCESS_TIMEOUT_MS);
    timer.unref?.();
  });
}
__name(readPosixProcessGroupStates, "readPosixProcessGroupStates");
function processGroupExists(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}
__name(processGroupExists, "processGroupExists");
function killRoot(child, signal) {
  try {
    child.kill(signal);
  } catch {
  }
}
__name(killRoot, "killRoot");

// src/shared/child-process/bounded-output-sink.ts
var import_node_buffer = require("node:buffer");
function createOutputSink(maxBytes) {
  const chunks = [];
  let bytes = 0;
  return {
    write(raw) {
      const chunk = import_node_buffer.Buffer.isBuffer(raw) ? raw : import_node_buffer.Buffer.from(raw);
      const remaining = maxBytes - bytes;
      if (remaining <= 0) {
        bytes += chunk.length;
        return;
      }
      chunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk);
      bytes += chunk.length;
    },
    text: /* @__PURE__ */ __name(() => chunks.length === 0 ? "" : (chunks.length === 1 ? chunks[0] : import_node_buffer.Buffer.concat(chunks)).toString("utf8"), "text"),
    // Why: callers that parse the output need to tell a short answer from a
    // clipped one -- truncated JSON or JSONL parses as a smaller valid result.
    truncated: /* @__PURE__ */ __name(() => bytes > maxBytes, "truncated")
  };
}
__name(createOutputSink, "createOutputSink");

// src/shared/child-process/child-termination-reporter.ts
function createChildTerminationReporter(callback) {
  let reported = false;
  const report = /* @__PURE__ */ __name(() => {
    if (reported) {
      return;
    }
    reported = true;
    callback?.();
  }, "report");
  return { report, reportIf: /* @__PURE__ */ __name((confirmed) => confirmed ? report() : void 0, "reportIf") };
}
__name(createChildTerminationReporter, "createChildTerminationReporter");

// src/shared/child-process/process-spec.ts
var DEFAULT_PROCESS_TIMEOUT_MS = 3e4;
var DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

// src/shared/child-process/run-process.ts
var PROCESS_EXIT_GRACE_MS = 2e3;
var BARRIER_UNVERIFIED_EXIT_GRACE_MS = 1e4;
function spawnProcess(spec) {
  const resolved = resolveSpawn(spec, process.platform);
  return (0, import_node_child_process2.spawn)(
    resolved.file,
    [...resolved.args],
    resolved.options
  );
}
__name(spawnProcess, "spawnProcess");
function runProcess(spec) {
  if (spec.signal?.aborted) {
    spec.onChildTerminated?.();
    return Promise.resolve({ code: null, signal: null, stdout: "", stderr: "", timedOut: false });
  }
  const maxOutputBytes = spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return new Promise((resolve, reject) => {
    const terminationReporter = createChildTerminationReporter(spec.onChildTerminated);
    let child;
    try {
      child = spawnProcess(spec);
    } catch (error) {
      terminationReporter.report();
      reject(error);
      return;
    }
    const stdout = createOutputSink(maxOutputBytes);
    const stderr = createOutputSink(maxOutputBytes);
    let timedOut = false;
    let settled = false;
    let barrierStopping = false;
    let barrierAttemptComplete = false;
    let barrierTerminationVerified = false;
    let initialBarrierTermination;
    let deferredExit = null;
    let deferredClose = null;
    let deferredError = null;
    let rootExitedBeforeBarrier = false;
    const settle = /* @__PURE__ */ __name((act) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      clearTimeout(barrierDeadlineTimer);
      spec.signal?.removeEventListener("abort", onAbort);
      act();
    }, "settle");
    child.stdout?.on("data", (chunk) => stdout.write(chunk));
    child.stderr?.on("data", (chunk) => {
      stderr.write(chunk);
      if (typeof spec.terminationBarrier === "object") {
        spec.terminationBarrier.observeStderr?.(chunk);
      }
    });
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream?.on("error", () => {
      });
    }
    let graceTimer;
    let barrierDeadlineTimer;
    const signalBarrierTree = /* @__PURE__ */ __name((signal) => (typeof spec.terminationBarrier === "object" ? spec.terminationBarrier.signal(child, signal) : signalProcessTree(child, signal)).catch(() => false), "signalBarrierTree");
    const forceBarrierTree = /* @__PURE__ */ __name(() => (typeof spec.terminationBarrier === "object" ? spec.terminationBarrier.force(child) : forceTerminateProcessTree(child)).catch(() => false), "forceBarrierTree");
    const resolveFromClose = /* @__PURE__ */ __name((code, signal) => settle(
      () => resolve({
        code,
        signal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        timedOut,
        outputTruncated: stdout.truncated() || stderr.truncated()
      })
    ), "resolveFromClose");
    const settleBarrierOutcome = /* @__PURE__ */ __name(() => {
      const rootExit = deferredClose ?? deferredExit;
      if (deferredError) {
        settle(() => reject(deferredError));
        return;
      }
      resolveFromClose(rootExit?.code ?? null, rootExit?.signal ?? null);
    }, "settleBarrierOutcome");
    const resolveBarrierIfSafe = /* @__PURE__ */ __name(() => {
      const rootExit = deferredClose ?? deferredExit;
      if (barrierTerminationVerified || rootExitedBeforeBarrier && rootExit) {
        settleBarrierOutcome();
        return;
      }
      if (!barrierAttemptComplete) {
        return;
      }
      barrierDeadlineTimer ??= setTimeout(settleBarrierOutcome, BARRIER_UNVERIFIED_EXIT_GRACE_MS);
      barrierDeadlineTimer.unref?.();
    }, "resolveBarrierIfSafe");
    const stopAndSettle = /* @__PURE__ */ __name(() => {
      if (spec.terminationBarrier) {
        barrierStopping = true;
        initialBarrierTermination ??= signalBarrierTree();
        if (process.platform === "win32") {
          void initialBarrierTermination.then((terminated) => {
            if (!terminated) {
              return;
            }
            barrierAttemptComplete = true;
            barrierTerminationVerified = true;
            terminationReporter.report();
            resolveBarrierIfSafe();
          });
        }
      } else {
        terminate(child);
      }
      graceTimer ??= setTimeout(() => {
        if (spec.terminationBarrier) {
          const initialTermination = initialBarrierTermination ?? Promise.resolve(false);
          if (process.platform === "win32") {
            if (typeof spec.terminationBarrier === "object") {
              void Promise.all([initialTermination, forceBarrierTree()]).then(
                ([initialTerminated, forceTerminated]) => {
                  barrierAttemptComplete = true;
                  barrierTerminationVerified = initialTerminated || forceTerminated;
                  terminationReporter.reportIf(barrierTerminationVerified);
                  if (!barrierTerminationVerified) {
                    terminate(child, "SIGKILL");
                  }
                  resolveBarrierIfSafe();
                }
              );
              return;
            }
            void initialTermination.then((terminated) => {
              if (!terminated) {
                terminate(child, "SIGKILL");
              }
              barrierAttemptComplete = true;
              barrierTerminationVerified = terminated;
              terminationReporter.reportIf(barrierTerminationVerified);
              resolveBarrierIfSafe();
            });
            return;
          }
          void Promise.all([initialTermination, forceBarrierTree()]).then(
            ([_initialTerminated, forceTerminated]) => {
              barrierAttemptComplete = true;
              barrierTerminationVerified = forceTerminated;
              terminationReporter.reportIf(barrierTerminationVerified);
              if (!barrierTerminationVerified) {
                terminate(child, "SIGKILL");
              }
              resolveBarrierIfSafe();
            }
          );
          return;
        }
        terminate(child, "SIGKILL");
        resolveFromClose(null, null);
      }, PROCESS_EXIT_GRACE_MS);
      graceTimer.unref?.();
    }, "stopAndSettle");
    const timer = spec.timeoutMs === null ? void 0 : setTimeout(() => {
      timedOut = true;
      stopAndSettle();
    }, spec.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS);
    timer?.unref?.();
    const onAbort = /* @__PURE__ */ __name(() => stopAndSettle(), "onAbort");
    spec.signal?.addEventListener("abort", onAbort, { once: true });
    if (spec.signal?.aborted) {
      onAbort();
    }
    child.once("error", (error) => {
      terminationReporter.reportIf(!child.pid);
      if (barrierStopping) {
        deferredError = error;
        resolveBarrierIfSafe();
        return;
      }
      settle(() => reject(error));
    });
    child.once("exit", (code, signal) => {
      if (!barrierStopping) {
        rootExitedBeforeBarrier = true;
      }
      deferredExit = { code, signal };
      if (barrierStopping) {
        resolveBarrierIfSafe();
      }
    });
    child.once("close", (code, signal) => {
      terminationReporter.report();
      if (!barrierStopping) {
        rootExitedBeforeBarrier = true;
      }
      if (barrierStopping) {
        deferredClose = { code, signal };
        resolveBarrierIfSafe();
        return;
      }
      resolveFromClose(code, signal);
    });
    child.stdin?.end(spec.input);
  });
}
__name(runProcess, "runProcess");
function terminate(child, signal) {
  try {
    child.kill(signal);
  } catch {
  }
}
__name(terminate, "terminate");

// src/main/emulator/serve-sim-execution.ts
var import_node_fs4 = require("node:fs");
var import_electron = require("./electron-guard.cjs");
var import_node_os2 = require("node:os");
var import_node_path4 = require("node:path");

// src/main/emulator/serve-sim-runtime-materializer.ts
var import_node_child_process3 = require("node:child_process");
var import_node_fs3 = require("node:fs");
var import_node_path3 = require("node:path");
var EXECUTABLE_RELATIVE_PATHS = [
  (0, import_node_path3.join)("bin", "serve-sim-bin"),
  (0, import_node_path3.join)("dist", "simcam", "serve-sim-camera-helper")
];
function defaultClearQuarantine(dir) {
  if (process.platform !== "darwin") {
    return;
  }
  (0, import_node_child_process3.execFileSync)("/usr/bin/xattr", ["-rd", "com.apple.quarantine", dir], { timeout: 3e4 });
}
__name(defaultClearQuarantine, "defaultClearQuarantine");
function pruneStaleServeSimRuntimes(targetRootDir, keepVersion) {
  let entries;
  try {
    entries = (0, import_node_fs3.readdirSync)(targetRootDir);
  } catch {
    return;
  }
  for (const entryName of entries) {
    if (entryName === keepVersion) {
      continue;
    }
    try {
      (0, import_node_fs3.rmSync)((0, import_node_path3.join)(targetRootDir, entryName), { recursive: true, force: true });
    } catch {
    }
  }
}
__name(pruneStaleServeSimRuntimes, "pruneStaleServeSimRuntimes");
function materializeServeSimRuntime(options) {
  const { bundledPackageDir, targetRootDir, version } = options;
  const clearQuarantine = options.clearQuarantine ?? defaultClearQuarantine;
  const targetDir = (0, import_node_path3.join)(targetRootDir, version);
  const entryPath = (0, import_node_path3.join)(targetDir, "dist", "serve-sim.js");
  if ((0, import_node_fs3.existsSync)(entryPath)) {
    return targetDir;
  }
  const stagingDir = (0, import_node_path3.join)(targetRootDir, `.staging-${version}-${process.pid}`);
  try {
    (0, import_node_fs3.mkdirSync)(targetRootDir, { recursive: true });
    pruneStaleServeSimRuntimes(targetRootDir, version);
    (0, import_node_fs3.rmSync)(stagingDir, { recursive: true, force: true });
    (0, import_node_fs3.rmSync)(targetDir, { recursive: true, force: true });
    (0, import_node_fs3.cpSync)(bundledPackageDir, stagingDir, { recursive: true });
    for (const relativePath of EXECUTABLE_RELATIVE_PATHS) {
      const executablePath = (0, import_node_path3.join)(stagingDir, relativePath);
      if ((0, import_node_fs3.existsSync)(executablePath)) {
        (0, import_node_fs3.chmodSync)(executablePath, 493);
      }
    }
    clearQuarantine(stagingDir);
    try {
      (0, import_node_fs3.renameSync)(stagingDir, targetDir);
    } catch (error) {
      if (!(0, import_node_fs3.existsSync)(entryPath)) {
        throw error;
      }
    }
    return (0, import_node_fs3.existsSync)(entryPath) ? targetDir : null;
  } catch {
    return null;
  } finally {
    (0, import_node_fs3.rmSync)(stagingDir, { recursive: true, force: true });
  }
}
__name(materializeServeSimRuntime, "materializeServeSimRuntime");

// src/main/emulator/serve-sim-execution.ts
var EXEC_TIMEOUT_MS = 9e4;
var MAC_OPEN_SHIM_DIR = (0, import_node_path4.join)((0, import_node_os2.tmpdir)(), "orca-serve-sim-open-shim");
var MAC_OPEN_SHIM_PATH = (0, import_node_path4.join)(MAC_OPEN_SHIM_DIR, "open");
// Why(Iris): serve-sim 은 부팅 뒤 `open -ga Simulator` 를 부르고 실패는 무시한다. 화면 전송은
// Simulator.app 없이 된다. Orca 는 숨겨서 띄웠지만 사용자에게는 별도 시뮬레이터가 켜진 것으로 보이고,
// 그 앱을 종료하면 기기도 함께 꺼진다. 그래서 Simulator 를 여는 요청은 아무것도 하지 않는다.
var MAC_OPEN_SHIM = `#!/bin/sh
has_simulator_target=0
for arg in "$@"; do
  case "$arg" in
    Simulator|Simulator.app|com.apple.iphonesimulator|*Simulator.app*)
      has_simulator_target=1
      ;;
  esac
done
if [ "$has_simulator_target" = "1" ]; then
  exit 0
fi
exec /usr/bin/open "$@"
`;
function ensureMacOpenShim() {
  if ((0, import_node_os2.platform)() !== "darwin") {
    return null;
  }
  try {
    (0, import_node_fs4.mkdirSync)(MAC_OPEN_SHIM_DIR, { recursive: true });
    const current = (0, import_node_fs4.existsSync)(MAC_OPEN_SHIM_PATH) ? (0, import_node_fs4.readFileSync)(MAC_OPEN_SHIM_PATH, "utf8") : "";
    if (current !== MAC_OPEN_SHIM) {
      (0, import_node_fs4.writeFileSync)(MAC_OPEN_SHIM_PATH, MAC_OPEN_SHIM, { mode: 493 });
    }
    (0, import_node_fs4.chmodSync)(MAC_OPEN_SHIM_PATH, 493);
    return MAC_OPEN_SHIM_DIR;
  } catch {
    return null;
  }
}
__name(ensureMacOpenShim, "ensureMacOpenShim");
function getServeSimEnv(executable) {
  const env = executable.usesElectronAsNode ? { ...process.env, ELECTRON_RUN_AS_NODE: "1" } : { ...process.env };
  const openShimDir = ensureMacOpenShim();
  if (openShimDir) {
    env.PATH = `${openShimDir}${import_node_path4.delimiter}${env.PATH ?? ""}`;
  }
  return require("./serve-sim-framework-env.cjs").withSimulatorFrameworkPath(env);
}
__name(getServeSimEnv, "getServeSimEnv");
var materializedServeSimPackageDir;
function resolveMaterializedServeSimPackageDir(bundledPackageDir) {
  if (materializedServeSimPackageDir !== void 0) {
    return materializedServeSimPackageDir;
  }
  materializedServeSimPackageDir = materializeServeSimRuntime({
    bundledPackageDir,
    targetRootDir: (0, import_node_path4.join)(import_electron.app.getPath("userData"), "serve-sim-runtime"),
    version: import_electron.app.getVersion()
  });
  if (materializedServeSimPackageDir === null) {
    console.warn(
      "[serve-sim] runtime materialization failed; running from the app bundle (camera injection may hit Gatekeeper on quarantined installs)"
    );
  }
  return materializedServeSimPackageDir;
}
__name(resolveMaterializedServeSimPackageDir, "resolveMaterializedServeSimPackageDir");
function resolveServeSimExecutable() {
  const bundledResourcesPath = process.resourcesPath ?? (process.platform === "darwin" ? (0, import_node_path4.join)(import_electron.app.getPath("exe"), "..", "..", "Resources") : (0, import_node_path4.join)(import_electron.app.getPath("exe"), "..", "resources"));
  for (const bundledPackageDir of [
    (0, import_node_path4.join)(bundledResourcesPath, "serve-sim"),
    (0, import_node_path4.join)(bundledResourcesPath, "node_modules", "serve-sim")
  ]) {
    const bundledEntry = (0, import_node_path4.join)(bundledPackageDir, "dist", "serve-sim.js");
    if (!(0, import_node_fs4.existsSync)(bundledEntry)) {
      continue;
    }
    if (process.platform === "darwin") {
      const materializedDir = resolveMaterializedServeSimPackageDir(bundledPackageDir);
      if (materializedDir) {
        return {
          command: process.execPath,
          baseArgs: [(0, import_node_path4.join)(materializedDir, "dist", "serve-sim.js")],
          usesElectronAsNode: true
        };
      }
    }
    return { command: process.execPath, baseArgs: [bundledEntry], usesElectronAsNode: true };
  }
  const nodeModulesPackageDir = (0, import_node_path4.join)(import_electron.app.getAppPath(), "node_modules", "serve-sim");
  const nodeModulesEntry = (0, import_node_path4.join)(nodeModulesPackageDir, "dist", "serve-sim.js");
  if ((0, import_node_fs4.existsSync)(nodeModulesEntry)) {
    const helperBin = (0, import_node_path4.join)(nodeModulesPackageDir, "bin", "serve-sim-bin");
    if ((0, import_node_fs4.existsSync)(helperBin) && process.platform !== "win32") {
      try {
        (0, import_node_fs4.accessSync)(helperBin, import_node_fs4.constants.X_OK);
      } catch {
        (0, import_node_fs4.chmodSync)(helperBin, 493);
      }
    }
    return { command: process.execPath, baseArgs: [nodeModulesEntry], usesElectronAsNode: true };
  }
  return { command: "serve-sim", baseArgs: [], usesElectronAsNode: false };
}
__name(resolveServeSimExecutable, "resolveServeSimExecutable");
function parseServeSimCommandArgs(input) {
  const args = [];
  let current = "";
  let inDouble = false;
  let inSingle = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (char === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (char === " " && !inDouble && !inSingle) {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) {
    args.push(current);
  }
  return args;
}
__name(parseServeSimCommandArgs, "parseServeSimCommandArgs");
function stripEmulatorTargetArgs(args) {
  const stripped = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--device" || arg === "-d" || arg === "--emulator" || arg === "--worktree") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--device=") || arg.startsWith("-d=") || arg.startsWith("--emulator=") || arg.startsWith("--worktree=")) {
      continue;
    }
    stripped.push(arg);
  }
  return stripped;
}
__name(stripEmulatorTargetArgs, "stripEmulatorTargetArgs");
async function execServeSimCommand(executable, args, options) {
  const timeout = options?.timeoutMs ?? EXEC_TIMEOUT_MS;
  const finalArgs = [...args];
  if (options?.json && !finalArgs.includes("-q") && !finalArgs.includes("--quiet")) {
    finalArgs.push("-q");
  }
  let result;
  try {
    result = await runProcess({
      program: executable.command,
      args: [...executable.baseArgs, ...finalArgs],
      env: getServeSimEnv(executable),
      maxOutputBytes: 10 * 1024 * 1024,
      timeoutMs: timeout
    });
  } catch (error) {
    throw new EmulatorError(
      "emulator_error",
      error instanceof Error ? error.message : "serve-sim command failed"
    );
  }
  if (result.code !== 0 || result.timedOut) {
    const message = result.stdout || result.stderr || "serve-sim command failed";
    if (/no serve-sim server|not running/i.test(message)) {
      throw new EmulatorError(
        "emulator_no_active",
        "No active emulator for this worktree \u2014 use orca emulator list/attach or open the pane"
      );
    }
    throw new EmulatorError("emulator_error", message);
  }
  if (options?.json) {
    try {
      return JSON.parse(result.stdout);
    } catch {
      return result.stdout.trim();
    }
  }
  return result.stdout.trim();
}
__name(execServeSimCommand, "execServeSimCommand");

// src/main/emulator/simctl-simulator-devices.ts
var UDID_RE = /^[0-9A-F]{8}-([0-9A-F]{4}-){3}[0-9A-F]{12}$/i;
var SIMCTL_UNAVAILABLE_MESSAGE = "Xcode Simulator tools are unavailable. Install full Xcode, open it once, then select it with `sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer`.";
function parseSimctlDevices(stdout) {
  const data = JSON.parse(stdout || "{}");
  const devices = [];
  for (const [runtime, runtimeDevices] of Object.entries(data.devices ?? {})) {
    for (const device of runtimeDevices) {
      if (!device.udid) {
        continue;
      }
      devices.push({
        name: device.name ?? device.udid,
        udid: device.udid,
        state: device.state ?? "unknown",
        runtime,
        isAvailable: device.isAvailable
      });
    }
  }
  return devices;
}
__name(parseSimctlDevices, "parseSimctlDevices");
function mapSimctlError(error, stderr) {
  const raw = `${error.message}
${stderr?.toString() ?? ""}`;
  const lower = raw.toLowerCase();
  if (error.code === "ENOENT" || lower.includes("unable to find utility") && lower.includes("simctl") || lower.includes("not a developer tool")) {
    return new EmulatorError("emulator_simctl_unavailable", SIMCTL_UNAVAILABLE_MESSAGE);
  }
  return new EmulatorError("emulator_error", raw.trim() || "xcrun simctl command failed.");
}
__name(mapSimctlError, "mapSimctlError");
async function listSimulatorDevices() {
  if ((0, import_node_os3.platform)() !== "darwin") {
    return [];
  }
  return new Promise((resolve, reject) => {
    (0, import_node_child_process4.execFile)(
      "xcrun",
      ["simctl", "list", "devices", "-j"],
      { timeout: 15e3 },
      (error, stdout, stderr) => {
        if (error) {
          reject(mapSimctlError(error, stderr));
          return;
        }
        try {
          resolve(parseSimctlDevices(stdout));
        } catch (parseError) {
          reject(parseError);
        }
      }
    );
  });
}
__name(listSimulatorDevices, "listSimulatorDevices");
async function resolveSimulatorUdid(deviceOrName, serveSimExecutable) {
  if (UDID_RE.test(deviceOrName)) {
    return deviceOrName;
  }
  try {
    const devices = await listSimulatorDevices();
    const needle = deviceOrName.toLowerCase();
    const match = devices.find(
      (device) => device.name.toLowerCase().includes(needle) || device.udid === deviceOrName
    );
    if (match) {
      return match.udid;
    }
  } catch {
  }
  try {
    const raw = await execServeSimCommand(serveSimExecutable, ["--list", "-q"], {
      json: true,
      timeoutMs: 1e4
    });
    if (raw && typeof raw === "object") {
      const device = raw.device;
      if (typeof device === "string" && device.toLowerCase().includes(deviceOrName.toLowerCase())) {
        return device;
      }
    }
  } catch {
  }
  return deviceOrName;
}
__name(resolveSimulatorUdid, "resolveSimulatorUdid");
async function ensureSimulatorBooted(udid) {
  if ((0, import_node_os3.platform)() !== "darwin") {
    throw new EmulatorError(
      "emulator_not_macos",
      "iOS Simulator requires macOS with Xcode Command Line Tools."
    );
  }
  const devices = await listSimulatorDevices();
  const device = devices.find((candidate) => candidate.udid === udid);
  if (!device) {
    throw new EmulatorError(
      "emulator_device_not_found",
      `Simulator ${udid} not found. Create one via Xcode > Window > Devices and Simulators.`
    );
  }
  if (device.state === "Booted") {
    return;
  }
  try {
    await new Promise((resolve, reject) => {
      (0, import_node_child_process4.execFile)("xcrun", ["simctl", "boot", udid], { timeout: 45e3 }, (error, _stdout, stderr) => {
        if (error) {
          const message = error.message.toLowerCase();
          if (message.includes("booted") || message.includes("current state")) {
            resolve();
            return;
          }
          reject(mapSimctlError(error, stderr));
          return;
        }
        resolve();
      });
    });
  } catch {
  }
  const deadline = Date.now() + 22e3;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    try {
      const fresh = await listSimulatorDevices();
      if (fresh.find((candidate) => candidate.udid === udid)?.state === "Booted") {
        return;
      }
    } catch {
    }
  }
}
__name(ensureSimulatorBooted, "ensureSimulatorBooted");
async function shutdownSimulatorDevice(udid) {
  if ((0, import_node_os3.platform)() !== "darwin") {
    throw new EmulatorError(
      "emulator_not_macos",
      "iOS Simulator requires macOS with Xcode Command Line Tools."
    );
  }
  await new Promise((resolve, reject) => {
    (0, import_node_child_process4.execFile)(
      "xcrun",
      ["simctl", "shutdown", udid],
      { timeout: 3e4 },
      (error, _stdout, stderr) => {
        if (!error) {
          resolve();
          return;
        }
        const message = `${error.message}
${stderr?.toString() ?? ""}`.toLowerCase();
        if (/\bcurrent state:\s*shutdown\b/.test(message)) {
          resolve();
          return;
        }
        reject(mapSimctlError(error, stderr));
      }
    );
  });
}
__name(shutdownSimulatorDevice, "shutdownSimulatorDevice");

// src/main/emulator/serve-sim-endpoint-readiness.ts
var import_node_net = require("node:net");
var import_promises = require("node:timers/promises");
var DEFAULT_READY_TIMEOUT_MS = 5e3;
var CONNECT_TIMEOUT_MS = 500;
var RETRY_DELAY_MS = 100;
function parseTcpEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    const fallbackPort = url.protocol === "https:" || url.protocol === "wss:" ? 443 : 80;
    const port = url.port ? Number(url.port) : fallbackPort;
    if (!url.hostname || !Number.isFinite(port)) {
      return null;
    }
    return { host: url.hostname, port };
  } catch {
    return null;
  }
}
__name(parseTcpEndpoint, "parseTcpEndpoint");
function canConnectToEndpoint(endpoint) {
  return new Promise((resolve) => {
    const socket = (0, import_node_net.connect)({ host: endpoint.host, port: endpoint.port });
    socket.unref();
    let settled = false;
    const finish = /* @__PURE__ */ __name((ready) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(ready);
    }, "finish");
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}
__name(canConnectToEndpoint, "canConnectToEndpoint");
async function waitForServeSimEndpointReady(endpoint, timeoutMs = DEFAULT_READY_TIMEOUT_MS) {
  const target = parseTcpEndpoint(endpoint);
  if (!target) {
    return false;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await canConnectToEndpoint(target)) {
      return true;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return false;
    }
    await (0, import_promises.setTimeout)(Math.min(RETRY_DELAY_MS, remaining));
  }
  return false;
}
__name(waitForServeSimEndpointReady, "waitForServeSimEndpointReady");

// src/main/emulator/serve-sim-helper-processes.ts
var import_node_child_process5 = require("node:child_process");
var import_node_os4 = require("node:os");

// src/shared/command-token-scanner.ts
var COMMAND_TOKEN_SCAN_MAX_CHARS = 4096;
function commandContainsToken(command, expectedToken) {
  if (!expectedToken) {
    return false;
  }
  const scanLimit = Math.min(command.length, COMMAND_TOKEN_SCAN_MAX_CHARS);
  let index = 0;
  while (index < scanLimit) {
    while (index < scanLimit && isCommandTokenWhitespace(command.charCodeAt(index))) {
      index += 1;
    }
    const tokenStart = index;
    while (index < scanLimit && !isCommandTokenWhitespace(command.charCodeAt(index))) {
      index += 1;
    }
    if (tokenStart < index && command.slice(tokenStart, index) === expectedToken) {
      return true;
    }
  }
  return false;
}
__name(commandContainsToken, "commandContainsToken");
function isCommandTokenWhitespace(code) {
  return code === 32 || code >= 9 && code <= 13 || code === 160 || code === 5760 || code >= 8192 && code <= 8202 || code === 8232 || code === 8233 || code === 8239 || code === 8287 || code === 12288 || code === 65279;
}
__name(isCommandTokenWhitespace, "isCommandTokenWhitespace");

// src/shared/process-output-field-scanner.ts
function* iterateProcessOutputLines(output) {
  let lineStart = 0;
  for (let index = 0; index < output.length; index += 1) {
    const code = output.charCodeAt(index);
    if (code !== 10 && code !== 13) {
      continue;
    }
    yield output.slice(lineStart, index);
    if (code === 13 && output.charCodeAt(index + 1) === 10) {
      index += 1;
    }
    lineStart = index + 1;
  }
  if (lineStart < output.length) {
    yield output.slice(lineStart);
  }
}
__name(iterateProcessOutputLines, "iterateProcessOutputLines");

// src/main/emulator/serve-sim-helper-processes.ts
function execFileText(command, args) {
  return new Promise((resolve, reject) => {
    (0, import_node_child_process5.execFile)(command, args, { timeout: 5e3, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout.toString());
    });
  });
}
__name(execFileText, "execFileText");
function parseServeSimHelperProcesses(psOutput) {
  const helpers = [];
  for (const line of iterateProcessOutputLines(psOutput)) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match) {
      continue;
    }
    const pid = Number(match[1]);
    const command = match[2] ?? "";
    if (!Number.isInteger(pid) || !/(^|\/)serve-sim-bin(?:\s|$)/.test(command)) {
      continue;
    }
    helpers.push({ pid, command });
  }
  return helpers;
}
__name(parseServeSimHelperProcesses, "parseServeSimHelperProcesses");
function commandTargetsDevice(command, deviceUdid) {
  return commandContainsToken(command, deviceUdid);
}
__name(commandTargetsDevice, "commandTargetsDevice");
async function listServeSimHelperProcessesForDevice(deviceUdid, options = {}) {
  if ((0, import_node_os4.platform)() !== "darwin") {
    return [];
  }
  const knownPid = options.helperPid;
  const includeOrphaned = options.includeOrphaned === true;
  const output = await execFileText("ps", ["-axo", "pid=,command="]).catch(() => "");
  if (!output) {
    return [];
  }
  return parseServeSimHelperProcesses(output).filter((helper) => {
    if (knownPid !== void 0 && helper.pid === knownPid) {
      return true;
    }
    return includeOrphaned && commandTargetsDevice(helper.command, deviceUdid);
  });
}
__name(listServeSimHelperProcessesForDevice, "listServeSimHelperProcessesForDevice");
async function killServeSimHelperProcessesForDevice(deviceUdid, options = {}) {
  const helperPids = (await listServeSimHelperProcessesForDevice(deviceUdid, options)).map(
    (helper) => helper.pid
  );
  for (const pid of new Set(helperPids)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
    }
  }
}
__name(killServeSimHelperProcessesForDevice, "killServeSimHelperProcessesForDevice");

// src/main/emulator/emulator-gesture-sender.ts
var import_ws = __toESM(require("ws"));

// src/shared/emulator-touch-frame.ts
var SERVE_SIM_TOUCH_MESSAGE_TAG = 3;
function encodeServeSimTouchFrame(touch) {
  const json = new TextEncoder().encode(JSON.stringify(touch));
  const frame = new Uint8Array(1 + json.length);
  frame[0] = SERVE_SIM_TOUCH_MESSAGE_TAG;
  frame.set(json, 1);
  return frame;
}
__name(encodeServeSimTouchFrame, "encodeServeSimTouchFrame");

// src/main/emulator/emulator-gesture-sender.ts
async function sendEmulatorGestureSequence(wsUrl, points) {
  await new Promise((resolve, reject) => {
    const ws = new import_ws.default(wsUrl);
    let index = 0;
    let timer = null;
    const cleanup = /* @__PURE__ */ __name(() => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }, "cleanup");
    const sendNext = /* @__PURE__ */ __name(() => {
      if (index >= points.length) {
        cleanup();
        timer = setTimeout(() => {
          ws.close();
          resolve();
        }, 50);
        return;
      }
      const point = points[index++];
      ws.send(Buffer.from(encodeServeSimTouchFrame(point)));
      timer = setTimeout(sendNext, 16);
    }, "sendNext");
    ws.on("open", sendNext);
    ws.on("error", (error) => {
      cleanup();
      reject(error);
    });
    ws.on("close", () => {
      cleanup();
      if (index < points.length) {
        reject(new Error("Emulator gesture stream closed before all points were sent"));
      }
    });
  });
}
__name(sendEmulatorGestureSequence, "sendEmulatorGestureSequence");

// src/main/emulator/serve-sim-accessibility-tree.ts
var import_electron2 = require("./electron-guard.cjs");

// src/main/emulator/serve-sim-ax-normalization.ts
var MAX_AX_NODES = 500;
function asRecord(value) {
  return typeof value === "object" && value !== null ? value : {};
}
__name(asRecord, "asRecord");
function numeric(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
__name(numeric, "numeric");
function asString(value) {
  return typeof value === "string" ? value : "";
}
__name(asString, "asString");
function readFrame(value) {
  const frame = asRecord(value);
  return {
    x: numeric(frame.x),
    y: numeric(frame.y),
    width: numeric(frame.width),
    height: numeric(frame.height)
  };
}
__name(readFrame, "readFrame");
function screenFrame(roots) {
  const first = readFrame(asRecord(roots[0]).frame);
  return first.width > 0 && first.height > 0 ? first : { x: 0, y: 0, width: 1, height: 1 };
}
__name(screenFrame, "screenFrame");
function round4(value) {
  return Math.round(value * 1e4) / 1e4;
}
__name(round4, "round4");
function normalizeFrame(frame, screen) {
  return {
    x: round4((frame.x - screen.x) / screen.width),
    y: round4((frame.y - screen.y) / screen.height),
    width: round4(frame.width / screen.width),
    height: round4(frame.height / screen.height)
  };
}
__name(normalizeFrame, "normalizeFrame");
function normalizeNode(raw, screen, budget) {
  budget.remaining -= 1;
  const node = asRecord(raw);
  const rawChildren = Array.isArray(node.children) ? node.children : [];
  const children = [];
  for (const child of rawChildren) {
    if (budget.remaining <= 0) {
      break;
    }
    children.push(normalizeNode(child, screen, budget));
  }
  const normalized = {
    role: asString(node.role_description),
    type: asString(node.type),
    label: asString(node.AXLabel),
    value: asString(node.AXValue),
    enabled: node.enabled !== false,
    frame: normalizeFrame(readFrame(node.frame), screen),
    children
  };
  const uniqueId = asString(node.AXUniqueId);
  if (uniqueId) {
    normalized.id = uniqueId;
  }
  if (children.length < rawChildren.length) {
    normalized.truncated = true;
  }
  return normalized;
}
__name(normalizeNode, "normalizeNode");
function normalizeServeSimAxTree(roots) {
  const screen = screenFrame(roots);
  const budget = { remaining: MAX_AX_NODES };
  const normalized = [];
  for (const root of roots) {
    if (budget.remaining <= 0) {
      break;
    }
    normalized.push(normalizeNode(root, screen, budget));
  }
  return normalized;
}
__name(normalizeServeSimAxTree, "normalizeServeSimAxTree");

// src/main/emulator/serve-sim-accessibility-tree.ts
var AX_REQUEST_TIMEOUT_MS = 5e3;
var MAX_ERROR_BODY_LENGTH = 512;
async function requestServeSimAccessibilityTree(axUrl) {
  try {
    const response = await import_electron2.net.fetch(axUrl, {
      signal: AbortSignal.timeout(AX_REQUEST_TIMEOUT_MS)
    });
    const body = await response.text();
    if (!response.ok) {
      const detail = body.slice(0, MAX_ERROR_BODY_LENGTH) || response.statusText;
      const retry = response.status === 503 ? " Accessibility may still be warming up; retry." : "";
      throw new EmulatorError(
        "emulator_helper_failed",
        `serve-sim AX request failed (${response.status}): ${detail}.${retry}`
      );
    }
    let tree;
    try {
      tree = JSON.parse(body);
    } catch {
      throw new EmulatorError("emulator_error", "serve-sim AX returned invalid JSON.");
    }
    if (!Array.isArray(tree) || tree.some((node) => typeof node !== "object" || node === null || Array.isArray(node))) {
      throw new EmulatorError("emulator_error", "serve-sim AX returned an invalid tree.");
    }
    return normalizeServeSimAxTree(tree);
  } catch (error) {
    if (error instanceof EmulatorError) {
      throw error;
    }
    const detail = error instanceof Error && error.name === "TimeoutError" ? "request timed out" : error instanceof Error ? error.message : "unknown request failure";
    throw new EmulatorError("emulator_helper_failed", `Unable to read serve-sim AX: ${detail}`);
  }
}
__name(requestServeSimAccessibilityTree, "requestServeSimAccessibilityTree");

// src/main/emulator/simulator-app-visibility.ts
var import_node_child_process6 = require("node:child_process");
var import_node_os5 = require("node:os");
async function hideNativeSimulatorApp() {
  if ((0, import_node_os5.platform)() !== "darwin") {
    return;
  }
  await new Promise((resolve) => {
    (0, import_node_child_process6.execFile)(
      "osascript",
      [
        "-e",
        'tell application "System Events"',
        "-e",
        'if exists application process "Simulator" then set visible of application process "Simulator" to false',
        "-e",
        "end tell"
      ],
      { timeout: 2e3 },
      () => {
        resolve();
      }
    );
  });
}
__name(hideNativeSimulatorApp, "hideNativeSimulatorApp");

// src/main/emulator/backends/ios-emulator-backend.ts
var IosEmulatorBackend = class {
  static {
    __name(this, "IosEmulatorBackend");
  }
  kind = "ios";
  streamCodec = "mjpeg";
  capabilities = {
    install: false,
    launch: false,
    permissions: false,
    accessibilityTree: true,
    logcat: false
  };
  cachedServeSimExecutable;
  waitForEndpointReady;
  constructor(options = {}) {
    this.waitForEndpointReady = options.waitForEndpointReady ?? waitForServeSimEndpointReady;
  }
  // Why: resolving the executable can materialize the serve-sim runtime (a one-time
  // recursive copy + xattr subprocess on macOS after each version bump). Defer it
  // off the startup path — the bridge is constructed before the main window shows —
  // so it only runs when an emulator command is actually issued.
  get serveSimExecutable() {
    this.cachedServeSimExecutable ??= resolveServeSimExecutable();
    return this.cachedServeSimExecutable;
  }
  isSupportedOnHost() {
    return (0, import_node_os6.platform)() === "darwin";
  }
  async resolveDeviceId(deviceOrName) {
    return resolveSimulatorUdid(deviceOrName, this.serveSimExecutable);
  }
  async ownsDevice(id) {
    if (!this.isSupportedOnHost()) {
      return false;
    }
    try {
      const needle = id.toLowerCase();
      const devices = await listSimulatorDevices();
      return devices.some((device) => device.udid === id || device.name.toLowerCase() === needle);
    } catch {
      return false;
    }
  }
  async listDevices() {
    const devices = await listSimulatorDevices();
    return devices.map((device) => toEmulatorDevice(device));
  }
  // iOS-specific passthroughs the router exposes for back-compat with the
  // runtime/availability code (not part of the cross-backend interface).
  async listSimulators() {
    return listSimulatorDevices();
  }
  async listRunningHelpers() {
    return this.execServeSim(["--list", "-q"], { json: true });
  }
  async checkServeSimAvailable() {
    await this.execServeSim(["--help"], { timeoutMs: 1e4 });
  }
  async checkAvailability() {
    if (!this.isSupportedOnHost()) {
      return { available: false, devices: [], message: "iOS Simulator requires macOS." };
    }
    let devices = [];
    try {
      devices = await this.listDevices();
    } catch (error) {
      return {
        available: false,
        devices: [],
        message: error instanceof Error ? error.message : "xcrun simctl is unavailable."
      };
    }
    if (devices.length === 0) {
      return {
        available: false,
        devices,
        message: "No iOS simulators found. Add one in Xcode Settings > Platforms."
      };
    }
    try {
      await this.checkServeSimAvailable();
    } catch (error) {
      return {
        available: false,
        devices,
        message: error instanceof Error ? error.message : "serve-sim is unavailable."
      };
    }
    return { available: true, devices, message: "Ready" };
  }
  async tap(deviceId, x, y) {
    const udid = await this.resolveDeviceId(deviceId);
    await this.execServeSim(["tap", x.toString(), y.toString(), "-d", udid]);
  }
  async gesture(_deviceId, points, wsUrl) {
    if (points.length === 0) {
      return;
    }
    if (!wsUrl) {
      throw new EmulatorError("emulator_no_active", "No active emulator stream for gesture input");
    }
    await sendEmulatorGestureSequence(wsUrl, points);
  }
  async type(deviceId, text) {
    const udid = await this.resolveDeviceId(deviceId);
    await this.execServeSim(["type", text, "-d", udid]);
  }
  async button(deviceId, name) {
    const udid = await this.resolveDeviceId(deviceId);
    await this.execServeSim(["button", name, "-d", udid]);
  }
  async rotate(deviceId, orientation) {
    const udid = await this.resolveDeviceId(deviceId);
    await this.execServeSim(["rotate", orientation, "-d", udid]);
  }
  async exec(deviceId, command) {
    const udid = await this.resolveDeviceId(deviceId);
    const rawArgs = stripEmulatorTargetArgs(parseServeSimCommandArgs(command.trim()));
    return this.execServeSim([...rawArgs, "-d", udid], { json: true });
  }
  async accessibilityTree(_deviceId, axUrl) {
    if (!axUrl) {
      throw new EmulatorError(
        "emulator_no_active",
        "No active iOS emulator AX endpoint \u2014 attach the simulator first."
      );
    }
    return requestServeSimAccessibilityTree(axUrl);
  }
  async startSession(deviceId) {
    const udid = await this.resolveDeviceId(deviceId);
    await ensureSimulatorBooted(udid);
    const startDetachedHelper = /* @__PURE__ */ __name(async () => {
      const raw = await this.execServeSim(["--detach", "-q", udid], { json: true });
      return parseServeSimDetachedSession(raw, udid);
    }, "startDetachedHelper");
    const waitForReadyOrKill = /* @__PURE__ */ __name(async (info2) => {
      if (await this.waitForEndpointReady(info2.streamUrl) && await this.hasHelperForSession(info2)) {
        return true;
      }
      await this.stopHelperForDevice(info2.deviceUdid, {
        helperPid: info2.helperPid,
        includeOrphaned: true
      });
      return false;
    }, "waitForReadyOrKill");
    const throwPersistentMissingFramebuffer = /* @__PURE__ */ __name((error) => {
      throw new EmulatorError(
        "emulator_helper_failed",
        `Simulator ${udid} keeps booting without a working display (no framebuffer descriptor), even after a reboot. Erase it with \`xcrun simctl erase ${udid}\` or recreate it in Xcode > Window > Devices and Simulators.

${error.message}`
      );
    }, "throwPersistentMissingFramebuffer");
    let didRecycleWedgedBoot = false;
    const startHelperRecyclingWedgedBoot = /* @__PURE__ */ __name(async () => {
      try {
        return await startDetachedHelper();
      } catch (error) {
        if (!isMissingFramebufferError(error)) {
          throw error;
        }
        if (didRecycleWedgedBoot) {
          return throwPersistentMissingFramebuffer(error);
        }
        didRecycleWedgedBoot = true;
        await shutdownSimulatorDevice(udid);
        await ensureSimulatorBooted(udid);
        try {
          return await startDetachedHelper();
        } catch (retryError) {
          if (!isMissingFramebufferError(retryError)) {
            throw retryError;
          }
          return throwPersistentMissingFramebuffer(retryError);
        }
      }
    }, "startHelperRecyclingWedgedBoot");
    let info = await startHelperRecyclingWedgedBoot();
    if (!await waitForReadyOrKill(info)) {
      info = await startHelperRecyclingWedgedBoot();
      if (!await waitForReadyOrKill(info)) {
        throw new EmulatorError(
          "emulator_helper_failed",
          "serve-sim started but its stream endpoint is not reachable."
        );
      }
    }
    await hideNativeSimulatorApp().catch(() => {
    });
    return { ...info, streamCodec: "mjpeg", backend: "ios" };
  }
  async stopHelperForDevice(deviceId, options = {}) {
    await this.execServeSim(["--kill", "-q", deviceId]).catch(() => {
    });
    await killServeSimHelperProcessesForDevice(deviceId, options).catch(() => {
    });
  }
  async shutdownDevice(deviceId) {
    await shutdownSimulatorDevice(deviceId);
  }
  async isSessionReusable(info) {
    if (!await this.waitForEndpointReady(info.streamUrl)) {
      return false;
    }
    return this.hasHelperForSession(info);
  }
  async hasHelperForSession(info) {
    const helpers = await listServeSimHelperProcessesForDevice(info.deviceUdid, {
      helperPid: info.helperPid,
      includeOrphaned: true
    }).catch(() => []);
    return helpers.length > 0;
  }
  async execServeSim(args, options) {
    return execServeSimCommand(this.serveSimExecutable, args, options);
  }
};
var MISSING_FRAMEBUFFER_RE = /No framebuffer display descriptor found/i;
function isMissingFramebufferError(error) {
  return error instanceof EmulatorError && error.code === "emulator_error" && MISSING_FRAMEBUFFER_RE.test(error.message);
}
__name(isMissingFramebufferError, "isMissingFramebufferError");
function toEmulatorDevice(device) {
  return {
    backend: "ios",
    id: device.udid,
    name: device.name,
    state: device.state === "Booted" ? "booted" : "shutdown",
    detail: device.runtime,
    isAvailable: device.isAvailable !== false
  };
}
__name(toEmulatorDevice, "toEmulatorDevice");

// src/main/emulator/android/android-sdk-host-discovery.ts
var import_node_os7 = require("node:os");
var import_node_fs5 = require("node:fs");

// src/main/emulator/android/android-sdk-discovery.ts
var import_node_path5 = require("node:path");
function discoverAndroidSdk(options) {
  const { env, platform: platform9, homedir: homedir2, exists } = options;
  const win322 = platform9 === "win32";
  for (const sdkRoot of candidateSdkRoots(env, platform9, homedir2)) {
    const paths = resolveToolPaths(sdkRoot, win322);
    if (exists(paths.adb) && exists(paths.emulator)) {
      return paths;
    }
  }
  return null;
}
__name(discoverAndroidSdk, "discoverAndroidSdk");
function candidateSdkRoots(env, platform9, homedir2) {
  const roots = [];
  if (env.ANDROID_HOME) {
    roots.push(env.ANDROID_HOME);
  }
  if (env.ANDROID_SDK_ROOT) {
    roots.push(env.ANDROID_SDK_ROOT);
  }
  roots.push(defaultSdkRoot(env, platform9, homedir2));
  return roots;
}
__name(candidateSdkRoots, "candidateSdkRoots");
function defaultSdkRoot(env, platform9, homedir2) {
  if (platform9 === "win32") {
    const localAppData = env.LOCALAPPDATA ?? (0, import_node_path5.join)(homedir2, "AppData", "Local");
    return (0, import_node_path5.join)(localAppData, "Android", "Sdk");
  }
  if (platform9 === "darwin") {
    return (0, import_node_path5.join)(homedir2, "Library", "Android", "sdk");
  }
  return (0, import_node_path5.join)(homedir2, "Android", "Sdk");
}
__name(defaultSdkRoot, "defaultSdkRoot");
function resolveToolPaths(sdkRoot, win322) {
  return {
    sdkRoot,
    adb: (0, import_node_path5.join)(sdkRoot, "platform-tools", win322 ? "adb.exe" : "adb"),
    emulator: (0, import_node_path5.join)(sdkRoot, "emulator", win322 ? "emulator.exe" : "emulator"),
    avdmanager: (0, import_node_path5.join)(
      sdkRoot,
      "cmdline-tools",
      "latest",
      "bin",
      win322 ? "avdmanager.bat" : "avdmanager"
    )
  };
}
__name(resolveToolPaths, "resolveToolPaths");

// src/main/emulator/android/android-sdk-host-discovery.ts
var configuredSdkPath = null;
function setConfiguredAndroidSdkPath(path2) {
  const trimmed = path2?.trim();
  configuredSdkPath = trimmed ? trimmed : null;
}
__name(setConfiguredAndroidSdkPath, "setConfiguredAndroidSdkPath");
function discoverAndroidSdkFromHost() {
  const env = configuredSdkPath ? { ...process.env, ANDROID_HOME: configuredSdkPath } : process.env;
  try {
    return discoverAndroidSdk({ env, platform: (0, import_node_os7.platform)(), homedir: (0, import_node_os7.homedir)(), exists: import_node_fs5.existsSync });
  } catch {
    return null;
  }
}
__name(discoverAndroidSdkFromHost, "discoverAndroidSdkFromHost");

// src/main/emulator/android/android-sdk-state.ts
var SDK_MISSING = "Android SDK not found. Install Android Studio and set ANDROID_HOME.";
var AndroidSdkState = class {
  constructor(injected, injectedSdk) {
    this.injected = injected;
    this.injectedSdk = injectedSdk;
  }
  injected;
  injectedSdk;
  static {
    __name(this, "AndroidSdkState");
  }
  resolve() {
    return this.injected ? this.injectedSdk : discoverAndroidSdkFromHost();
  }
  require() {
    const sdk = this.resolve();
    if (!sdk) {
      throw new EmulatorError("emulator_error", SDK_MISSING);
    }
    return sdk;
  }
};

// src/main/emulator/android/adb-devices.ts
var DEVICES_HEADER = "List of devices attached";
function parseAdbDevices(stdout) {
  const devices = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line === DEVICES_HEADER) {
      continue;
    }
    const tokens = line.split(/\s+/);
    const serial = tokens[0];
    if (!serial) {
      continue;
    }
    let state;
    let tokenStart;
    if (tokens[1] === "no" && tokens[2] === "permissions") {
      state = "no permissions";
      tokenStart = 3;
    } else {
      state = tokens[1] ?? "";
      tokenStart = 2;
    }
    const device = {
      serial,
      state,
      isEmulator: serial.startsWith("emulator-")
    };
    for (const token of tokens.slice(tokenStart)) {
      const sep = token.indexOf(":");
      if (sep === -1) {
        continue;
      }
      const key = token.slice(0, sep);
      const value = token.slice(sep + 1);
      if (key === "model") {
        device.model = value;
      } else if (key === "product") {
        device.product = value;
      }
    }
    devices.push(device);
  }
  return devices;
}
__name(parseAdbDevices, "parseAdbDevices");
function parseWmSize(stdout) {
  const override = /Override size:\s*(\d+)x(\d+)/.exec(stdout);
  const physical = /Physical size:\s*(\d+)x(\d+)/.exec(stdout);
  const match = override ?? physical;
  if (!match) {
    return null;
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}
__name(parseWmSize, "parseWmSize");
function isBootCompleted(getpropStdout) {
  return getpropStdout.trim() === "1";
}
__name(isBootCompleted, "isBootCompleted");
var adbDevicesArgs = ["devices", "-l"];
function adbShellArgs(serial, command) {
  return ["-s", serial, "shell", ...command];
}
__name(adbShellArgs, "adbShellArgs");
function wmSizeArgs(serial) {
  return adbShellArgs(serial, ["wm", "size"]);
}
__name(wmSizeArgs, "wmSizeArgs");
function bootCompletedArgs(serial) {
  return adbShellArgs(serial, ["getprop", "sys.boot_completed"]);
}
__name(bootCompletedArgs, "bootCompletedArgs");

// src/main/emulator/android/avd-manager.ts
var listAvdsArgs = ["-list-avds"];
var EMULATOR_LOG_PREFIX = /^(INFO|WARNING|ERROR|DEBUG|VERBOSE|PANIC)\s/;
function isNoiseLine(line) {
  return line === "" || line.startsWith("No AVD") || EMULATOR_LOG_PREFIX.test(line);
}
__name(isNoiseLine, "isNoiseLine");
function parseAvdList(stdout) {
  return stdout.split("\n").map((line) => line.trim()).filter((line) => !isNoiseLine(line));
}
__name(parseAvdList, "parseAvdList");
function bootAvdArgs(name, options = {}) {
  const args = ["-avd", name];
  if (options.noSnapshot) {
    args.push("-no-snapshot");
  }
  if (options.noWindow) {
    args.push("-no-window");
  }
  if (options.noBootAnim) {
    args.push("-no-boot-anim");
  }
  if (options.gpu) {
    args.push("-gpu", options.gpu);
  }
  return args;
}
__name(bootAvdArgs, "bootAvdArgs");
function emuKillArgs(serial) {
  return ["-s", serial, "emu", "kill"];
}
__name(emuKillArgs, "emuKillArgs");

// src/main/emulator/android/android-adb-result.ts
function ensureAdbOk(result, label) {
  if (result.code !== 0) {
    throw new EmulatorError(
      "emulator_error",
      `${label} failed: ${(result.stderr || result.stdout).trim() || "unknown error"}`
    );
  }
  return result;
}
__name(ensureAdbOk, "ensureAdbOk");

// src/main/emulator/android/android-input-mapping.ts
function toPixel(normalized, dimension) {
  const rounded = Math.round(normalized * dimension);
  const max = dimension - 1;
  if (rounded < 0) {
    return 0;
  }
  if (rounded > max) {
    return max;
  }
  return rounded;
}
__name(toPixel, "toPixel");
function normalizedToDevicePixels(x, y, size) {
  return {
    x: toPixel(x, size.width),
    y: toPixel(y, size.height)
  };
}
__name(normalizedToDevicePixels, "normalizedToDevicePixels");
var BUTTON_KEYCODES = {
  home: 3,
  back: 4,
  recents: 187,
  app_switch: 187,
  recent: 187,
  overview: 187,
  power: 26,
  lock: 26,
  volume_up: 24,
  volup: 24,
  volume_down: 25,
  voldown: 25
};
function androidButtonKeycode(name) {
  const keycode = BUTTON_KEYCODES[name];
  if (keycode === void 0) {
    throw new EmulatorError("emulator_error", `Unknown Android hardware button: ${name}`);
  }
  return keycode;
}
__name(androidButtonKeycode, "androidButtonKeycode");

// src/main/emulator/android/android-input-commands.ts
function androidShellArgs(serial, command) {
  return ["-s", serial, "shell", ...command];
}
__name(androidShellArgs, "androidShellArgs");
async function androidTap(runner, sdk, serial, x, y, size) {
  const pixel = normalizedToDevicePixels(x, y, size);
  ensureAdbOk(
    await runner(
      sdk.adb,
      androidShellArgs(serial, ["input", "tap", String(pixel.x), String(pixel.y)])
    ),
    "adb tap"
  );
}
__name(androidTap, "androidTap");
async function androidSwipe(runner, sdk, serial, points, size) {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last || points.length < 2) {
    return;
  }
  const start = normalizedToDevicePixels(first.x, first.y, size);
  const end = normalizedToDevicePixels(last.x, last.y, size);
  ensureAdbOk(
    await runner(
      sdk.adb,
      androidShellArgs(serial, [
        "input",
        "swipe",
        String(start.x),
        String(start.y),
        String(end.x),
        String(end.y),
        "300"
      ])
    ),
    "adb swipe"
  );
}
__name(androidSwipe, "androidSwipe");
async function androidTypeText(runner, sdk, serial, text) {
  ensureAdbOk(
    await runner(sdk.adb, androidShellArgs(serial, ["input", "text", text.replace(/ /g, "%s")])),
    "adb type"
  );
}
__name(androidTypeText, "androidTypeText");
async function androidButton(runner, sdk, serial, name) {
  ensureAdbOk(
    await runner(
      sdk.adb,
      androidShellArgs(serial, ["input", "keyevent", String(androidButtonKeycode(name))])
    ),
    "adb button"
  );
}
__name(androidButton, "androidButton");
async function androidRotate(runner, sdk, serial, orientation) {
  ensureAdbOk(
    await runner(
      sdk.adb,
      androidShellArgs(serial, ["settings", "put", "system", "accelerometer_rotation", "0"])
    ),
    "adb rotate"
  );
  ensureAdbOk(
    await runner(
      sdk.adb,
      androidShellArgs(serial, [
        "settings",
        "put",
        "system",
        "user_rotation",
        String(orientationToRotation(orientation))
      ])
    ),
    "adb rotate"
  );
}
__name(androidRotate, "androidRotate");
async function androidExec(runner, sdk, serial, command) {
  const result = ensureAdbOk(await runner(sdk.adb, androidShellArgs(serial, [command])), "adb exec");
  return result.stdout;
}
__name(androidExec, "androidExec");
function orientationToRotation(orientation) {
  switch (orientation) {
    case "landscape_left":
      return 1;
    case "portrait_upside_down":
      return 2;
    case "landscape_right":
      return 3;
    default:
      return 0;
  }
}
__name(orientationToRotation, "orientationToRotation");

// src/main/emulator/android/android-command-runner.ts
var import_node_child_process7 = require("node:child_process");
var import_node_path7 = require("node:path");

// src/main/emulator/emulator-probe.ts
var import_node_fs6 = require("node:fs");
var import_node_os8 = require("node:os");
var import_node_path6 = require("node:path");
var EMULATOR_PROBE_LOG = (0, import_node_path6.join)((0, import_node_os8.tmpdir)(), "orca-android-emu-probe.log");
var EMULATOR_PROBE_ENABLED = process.env.ORCA_EMULATOR_PROBE === "1";
function errorMessage(error) {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return typeof error === "string" ? error : JSON.stringify(error);
}
__name(errorMessage, "errorMessage");
function format(level, event, data) {
  let payload = "";
  if (data !== void 0) {
    try {
      payload = ` ${JSON.stringify(data)}`;
    } catch {
      payload = " [unserializable]";
    }
  }
  return `${(/* @__PURE__ */ new Date()).toISOString()} [emu:${level}] ${event}${payload}`;
}
__name(format, "format");
function append(text) {
  try {
    (0, import_node_fs6.appendFileSync)(EMULATOR_PROBE_LOG, `${text}
`);
  } catch {
  }
}
__name(append, "append");
function emulatorProbe(event, data) {
  if (!EMULATOR_PROBE_ENABLED) {
    return;
  }
  const text = format("info", event, data);
  console.log(text);
  append(text);
}
__name(emulatorProbe, "emulatorProbe");
function emulatorProbeError(event, error, data) {
  if (!EMULATOR_PROBE_ENABLED) {
    return;
  }
  const detail = {
    ...data && typeof data === "object" ? data : {},
    error: errorMessage(error)
  };
  const text = format("error", event, detail);
  console.error(text);
  append(text);
}
__name(emulatorProbeError, "emulatorProbeError");

// src/main/emulator/android/android-command-runner.ts
var DEFAULT_TIMEOUT_MS = 6e4;
var MAX_BUFFER_BYTES = 16 * 1024 * 1024;
var execFileAndroidCommandRunner = /* @__PURE__ */ __name((binary, args, options) => new Promise((resolve) => {
  (0, import_node_child_process7.execFile)(
    binary,
    [...args],
    { timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES },
    (error, stdout, stderr) => {
      const exitCode = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
      const result = {
        stdout: stdout?.toString() ?? "",
        stderr: stderr?.toString() ?? "",
        code: exitCode
      };
      if (exitCode === 0) {
        emulatorProbe("cmd", { bin: (0, import_node_path7.basename)(binary), args });
      } else {
        emulatorProbeError("cmd.fail", error ?? new Error(result.stderr || "nonzero exit"), {
          bin: (0, import_node_path7.basename)(binary),
          args,
          code: exitCode,
          stderr: result.stderr.slice(0, 400)
        });
      }
      resolve(result);
    }
  );
}), "execFileAndroidCommandRunner");

// src/main/emulator/android/android-device-inventory.ts
async function listRunningAdbDevices(runner, sdk) {
  const result = await runner(sdk.adb, adbDevicesArgs);
  return parseAdbDevices(result.stdout).filter((device) => device.state === "device");
}
__name(listRunningAdbDevices, "listRunningAdbDevices");
async function resolveRunningAvdNames(runner, sdk, running) {
  const names = /* @__PURE__ */ new Map();
  await Promise.all(
    running.filter((device) => device.isEmulator).map(async (device) => {
      const out = await runner(sdk.adb, ["-s", device.serial, "emu", "avd", "name"]);
      const name = firstNonStatusLine(out.stdout);
      if (name) {
        names.set(device.serial, name);
      }
    })
  );
  return names;
}
__name(resolveRunningAvdNames, "resolveRunningAvdNames");
async function findRunningAvdSerial(runner, sdk, avdName, running) {
  const names = await resolveRunningAvdNames(runner, sdk, running);
  for (const [serial, name] of names) {
    if (name === avdName) {
      return serial;
    }
  }
  return null;
}
__name(findRunningAvdSerial, "findRunningAvdSerial");
async function listAndroidDevices(runner, sdk) {
  const [running, avdsResult] = await Promise.all([
    listRunningAdbDevices(runner, sdk),
    runner(sdk.emulator, listAvdsArgs)
  ]);
  const avds = parseAvdList(avdsResult.stdout);
  const runningAvdBySerial = await resolveRunningAvdNames(runner, sdk, running);
  return mergeAndroidDevices(running, avds, runningAvdBySerial);
}
__name(listAndroidDevices, "listAndroidDevices");
function firstNonStatusLine(stdout) {
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (line !== "" && line !== "OK") {
      return line;
    }
  }
  return null;
}
__name(firstNonStatusLine, "firstNonStatusLine");
function mergeAndroidDevices(running, avds, runningAvdBySerial) {
  const devices = [];
  const bootedAvdNames = new Set(runningAvdBySerial.values());
  for (const device of running) {
    const avdName = runningAvdBySerial.get(device.serial);
    devices.push({
      backend: "android",
      id: device.serial,
      name: avdName ?? device.model ?? device.serial,
      state: "booted",
      detail: device.isEmulator ? "emulator" : "device",
      isAvailable: true
    });
  }
  for (const avd of avds) {
    if (bootedAvdNames.has(avd)) {
      continue;
    }
    devices.push({
      backend: "android",
      id: avd,
      name: avd,
      state: "shutdown",
      detail: "avd",
      isAvailable: true
    });
  }
  return devices;
}
__name(mergeAndroidDevices, "mergeAndroidDevices");

// src/main/emulator/android/android-app-control.ts
function installApkArgs(serial, apkPath, options) {
  const args = ["-s", serial, "install"];
  if (options?.reinstall) {
    args.push("-r");
  }
  args.push(apkPath);
  return args;
}
__name(installApkArgs, "installApkArgs");
function launchAppArgs(serial, packageName, activity) {
  if (activity && activity.trim() !== "") {
    return ["-s", serial, "shell", "am", "start", "-n", `${packageName}/${activity}`];
  }
  return [
    "-s",
    serial,
    "shell",
    "monkey",
    "-p",
    packageName,
    "-c",
    "android.intent.category.LAUNCHER",
    "1"
  ];
}
__name(launchAppArgs, "launchAppArgs");

// src/main/emulator/android/android-permissions.ts
function permissionArgs(serial, op, packageName, permission) {
  const base = ["-s", serial, "shell", "pm"];
  if (op === "reset") {
    return [...base, "reset-permissions"];
  }
  if (!permission || permission.trim() === "") {
    throw new EmulatorError("emulator_error", `pm ${op} requires a permission name`);
  }
  return [...base, op, packageName, permission];
}
__name(permissionArgs, "permissionArgs");

// src/main/emulator/android/android-logcat.ts
function logcatArgs(serial, options) {
  const args = ["-s", serial, "logcat"];
  if (options?.dump) {
    args.push("-d");
  }
  args.push("-v", "threadtime");
  if (options?.lines !== void 0) {
    args.push("-t", String(options.lines));
  }
  if (options?.filters) {
    args.push(...options.filters);
  }
  return args;
}
__name(logcatArgs, "logcatArgs");
var LOGCAT_LINE = /^(\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s+\d+\s+\d+\s+([A-Z])\s+([^:]+):(.*)$/;
function parseLogcatLine(line) {
  const trimmed = line.trim();
  const match = LOGCAT_LINE.exec(trimmed);
  if (!match) {
    return { message: trimmed };
  }
  return {
    timestamp: match[1],
    level: match[2],
    tag: match[3].trim(),
    message: match[4].trim()
  };
}
__name(parseLogcatLine, "parseLogcatLine");

// src/main/emulator/android/uiautomator-tree.ts
function parseAndroidBounds(value) {
  const match = value.trim().match(/^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/);
  if (!match) {
    return null;
  }
  return {
    left: Number(match[1]),
    top: Number(match[2]),
    right: Number(match[3]),
    bottom: Number(match[4])
  };
}
__name(parseAndroidBounds, "parseAndroidBounds");
function parseUiAutomatorXml(xml) {
  if (xml.trim() === "") {
    throw new EmulatorError("emulator_error", "Cannot parse empty uiautomator XML");
  }
  let root;
  try {
    root = parseDocument(xml);
  } catch (error) {
    if (error instanceof EmulatorError) {
      throw error;
    }
    throw new EmulatorError(
      "emulator_error",
      `Failed to parse uiautomator XML: ${error.message}`
    );
  }
  const topLevel = root.tag === "node" ? [root] : root.children.filter((child) => child.tag === "node");
  return { children: topLevel.map(mapNode) };
}
__name(parseUiAutomatorXml, "parseUiAutomatorXml");
function mapNode(raw) {
  const attrs = raw.attributes;
  const node = {
    children: raw.children.filter((child) => child.tag === "node").map(mapNode)
  };
  setString(node, "className", attrs["class"]);
  setString(node, "text", attrs["text"]);
  setString(node, "resourceId", attrs["resource-id"]);
  setString(node, "contentDesc", attrs["content-desc"]);
  setString(node, "packageName", attrs["package"]);
  setBool(node, "clickable", attrs["clickable"]);
  setBool(node, "enabled", attrs["enabled"]);
  setBool(node, "focused", attrs["focused"]);
  const bounds = attrs["bounds"] === void 0 ? null : parseAndroidBounds(attrs["bounds"]);
  if (bounds) {
    node.bounds = bounds;
  }
  return node;
}
__name(mapNode, "mapNode");
function setString(node, key, value) {
  if (value !== void 0 && value !== "") {
    node[key] = value;
  }
}
__name(setString, "setString");
function setBool(node, key, value) {
  if (value === "true") {
    node[key] = true;
  } else if (value === "false") {
    node[key] = false;
  }
}
__name(setBool, "setBool");
function parseDocument(xml) {
  let i = 0;
  const n = xml.length;
  const fail = /* @__PURE__ */ __name((message) => {
    throw new EmulatorError("emulator_error", `${message} at offset ${i}`);
  }, "fail");
  const isWs = /* @__PURE__ */ __name((c) => c === " " || c === "	" || c === "\n" || c === "\r", "isWs");
  const skipWs = /* @__PURE__ */ __name(() => {
    while (i < n && isWs(xml[i])) {
      i++;
    }
  }, "skipWs");
  const startsWith = /* @__PURE__ */ __name((token) => xml.startsWith(token, i), "startsWith");
  const skipDelimited = /* @__PURE__ */ __name((open, close, label) => {
    const end = xml.indexOf(close, i + open.length);
    if (end === -1) {
      fail(`Unterminated ${label}`);
    }
    i = end + close.length;
  }, "skipDelimited");
  const readName = /* @__PURE__ */ __name(() => {
    const start = i;
    while (i < n) {
      const c = xml[i];
      if (isWs(c) || c === "=" || c === "/" || c === ">" || c === "<" || c === '"' || c === "'") {
        break;
      }
      i++;
    }
    return xml.slice(start, i);
  }, "readName");
  const skipProlog = /* @__PURE__ */ __name(() => {
    for (; ; ) {
      skipWs();
      if (i >= n) {
        return;
      }
      if (startsWith("<?")) {
        skipDelimited("<?", "?>", "processing instruction");
      } else if (startsWith("<!--")) {
        skipDelimited("<!--", "-->", "comment");
      } else if (startsWith("<!")) {
        skipDelimited("<!", ">", "declaration");
      } else {
        return;
      }
    }
  }, "skipProlog");
  const parseElement = /* @__PURE__ */ __name(() => {
    if (xml[i] !== "<") {
      fail("Expected element start");
    }
    i++;
    const tag = readName();
    if (tag === "") {
      fail("Expected tag name");
    }
    const attributes = {};
    for (; ; ) {
      skipWs();
      if (i >= n) {
        fail("Unterminated start tag");
      }
      if (xml[i] === "/") {
        if (xml[i + 1] !== ">") {
          fail("Malformed self-closing tag");
        }
        i += 2;
        return { tag, attributes, children: [] };
      }
      if (xml[i] === ">") {
        i++;
        break;
      }
      const name = readName();
      if (name === "") {
        fail("Expected attribute name");
      }
      skipWs();
      if (xml[i] !== "=") {
        fail("Expected '=' after attribute name");
      }
      i++;
      skipWs();
      const quote = xml[i];
      if (quote !== '"' && quote !== "'") {
        fail("Expected quoted attribute value");
      }
      i++;
      const start = i;
      while (i < n && xml[i] !== quote) {
        i++;
      }
      if (i >= n) {
        fail("Unterminated attribute value");
      }
      attributes[name] = decodeEntities(xml.slice(start, i));
      i++;
    }
    return parseChildren(tag, attributes);
  }, "parseElement");
  const parseChildren = /* @__PURE__ */ __name((tag, attributes) => {
    const children = [];
    for (; ; ) {
      if (i >= n) {
        fail(`Unterminated element <${tag}>`);
      }
      if (xml[i] !== "<") {
        while (i < n && xml[i] !== "<") {
          i++;
        }
        continue;
      }
      if (startsWith("</")) {
        i += 2;
        const closeName = readName();
        skipWs();
        if (xml[i] !== ">") {
          fail("Malformed end tag");
        }
        i++;
        if (closeName !== tag) {
          fail(`Mismatched end tag </${closeName}> for <${tag}>`);
        }
        return { tag, attributes, children };
      }
      if (startsWith("<!--")) {
        skipDelimited("<!--", "-->", "comment");
      } else if (startsWith("<![CDATA[")) {
        skipDelimited("<![CDATA[", "]]>", "CDATA section");
      } else if (startsWith("<?")) {
        skipDelimited("<?", "?>", "processing instruction");
      } else {
        children.push(parseElement());
      }
    }
  }, "parseChildren");
  skipProlog();
  if (i >= n || xml[i] !== "<") {
    fail("No root element found");
  }
  return parseElement();
}
__name(parseDocument, "parseDocument");
function decodeEntities(value) {
  if (!value.includes("&")) {
    return value;
  }
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (match, body) => {
    switch (body) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default: {
        const code = body[1] === "x" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
        return Number.isNaN(code) ? match : String.fromCodePoint(code);
      }
    }
  });
}
__name(decodeEntities, "decodeEntities");

// src/main/emulator/android/android-capability-operations.ts
var UIAUTOMATOR_DUMP_PATH = "/sdcard/window_dump.xml";
async function installAndroidApk(runner, sdk, serial, apkPath, options) {
  const result = await runner(sdk.adb, installApkArgs(serial, apkPath, options));
  if (result.code !== 0 || /Failure|Error/i.test(`${result.stdout}${result.stderr}`)) {
    throw new EmulatorError(
      "emulator_error",
      `adb install failed: ${(result.stderr || result.stdout).trim() || "unknown error"}`
    );
  }
}
__name(installAndroidApk, "installAndroidApk");
async function launchAndroidApp(runner, sdk, serial, packageName, activity) {
  ensureAdbOk(await runner(sdk.adb, launchAppArgs(serial, packageName, activity)), "adb launch");
}
__name(launchAndroidApp, "launchAndroidApp");
async function setAndroidPermission(runner, sdk, serial, op, packageName, permission) {
  ensureAdbOk(
    await runner(sdk.adb, permissionArgs(serial, op, packageName, permission)),
    "adb permission"
  );
}
__name(setAndroidPermission, "setAndroidPermission");
async function dumpAndroidAccessibilityTree(runner, sdk, serial) {
  ensureAdbOk(
    await runner(sdk.adb, ["-s", serial, "shell", "uiautomator", "dump", UIAUTOMATOR_DUMP_PATH]),
    "uiautomator dump"
  );
  const xml = ensureAdbOk(
    await runner(sdk.adb, ["-s", serial, "shell", "cat", UIAUTOMATOR_DUMP_PATH]),
    "read ui dump"
  );
  return parseUiAutomatorXml(xml.stdout);
}
__name(dumpAndroidAccessibilityTree, "dumpAndroidAccessibilityTree");
async function captureAndroidLogcat(runner, sdk, serial, options) {
  const result = ensureAdbOk(
    await runner(sdk.adb, logcatArgs(serial, { ...options, dump: true })),
    "adb logcat"
  );
  return result.stdout.split("\n").filter((line) => line.trim() !== "").map(parseLogcatLine);
}
__name(captureAndroidLogcat, "captureAndroidLogcat");

// src/main/emulator/android/android-avd-boot.ts
var import_node_child_process8 = require("node:child_process");
async function bootAndroidDevice(runner, sdk, deviceOrName, options) {
  const running = await listRunningAdbDevices(runner, sdk);
  if (running.some((device) => device.serial === deviceOrName)) {
    return deviceOrName;
  }
  const existing = await findRunningAvdSerial(runner, sdk, deviceOrName, running);
  if (existing) {
    return existing;
  }
  const avds = parseAvdList((await runner(sdk.emulator, listAvdsArgs)).stdout);
  if (!avds.includes(deviceOrName)) {
    throw new EmulatorError(
      "emulator_device_not_found",
      `"${deviceOrName}" is not a running device or a known AVD.`
    );
  }
  const known = new Set(running.map((device) => device.serial));
  launchAvd(sdk.emulator, deviceOrName);
  return waitForNewBootedSerial(runner, sdk, deviceOrName, known, options);
}
__name(bootAndroidDevice, "bootAndroidDevice");
function launchAvd(emulatorPath, avdName) {
  const child = (0, import_node_child_process8.spawn)(emulatorPath, [...bootAvdArgs(avdName), "-no-window"], {
    stdio: "ignore",
    windowsHide: true
  });
  child.on("error", (error) => emulatorProbeError("emulator.launch.fail", error, { avdName }));
  child.unref();
}
__name(launchAvd, "launchAvd");
async function waitForNewBootedSerial(runner, sdk, avdName, known, options) {
  let waited = 0;
  while (waited < options.bootTimeoutMs) {
    const fresh = (await listRunningAdbDevices(runner, sdk)).filter(
      (device) => device.isEmulator && !known.has(device.serial)
    );
    for (const device of fresh) {
      const booted = await runner(sdk.adb, bootCompletedArgs(device.serial));
      if (isBootCompleted(booted.stdout)) {
        return device.serial;
      }
    }
    await options.sleep(options.pollIntervalMs);
    waited += options.pollIntervalMs;
  }
  throw new EmulatorError(
    "emulator_helper_failed",
    `AVD "${avdName}" did not finish booting in time.`
  );
}
__name(waitForNewBootedSerial, "waitForNewBootedSerial");

// src/main/emulator/android/scrcpy-server-download.ts
var import_electron3 = require("./electron-guard.cjs");
var import_node_fs7 = require("node:fs");
var import_node_path8 = require("node:path");
var import_node_https = require("node:https");
var import_promises2 = require("node:stream/promises");

// src/main/emulator/android/scrcpy-server-deploy.ts
var SCRCPY_SERVER_VERSION = "2.4";
var SCRCPY_DEVICE_JAR_PATH = "/data/local/tmp/scrcpy-server.jar";
function pushScrcpyServerArgs(serial, localJarPath, deviceJarPath = SCRCPY_DEVICE_JAR_PATH) {
  return ["-s", serial, "push", localJarPath, deviceJarPath];
}
__name(pushScrcpyServerArgs, "pushScrcpyServerArgs");
function scrcpyForwardArgs(serial, localPort, scid) {
  return ["-s", serial, "forward", `tcp:${localPort}`, `localabstract:scrcpy_${scid}`];
}
__name(scrcpyForwardArgs, "scrcpyForwardArgs");
function scrcpyRemoveForwardArgs(serial, localPort) {
  return ["-s", serial, "forward", "--remove", `tcp:${localPort}`];
}
__name(scrcpyRemoveForwardArgs, "scrcpyRemoveForwardArgs");
function startScrcpyServerArgs(serial, options) {
  const version = options.version ?? SCRCPY_SERVER_VERSION;
  const jar = options.deviceJarPath ?? SCRCPY_DEVICE_JAR_PATH;
  const params = [
    `scid=${options.scid}`,
    "log_level=info",
    "tunnel_forward=true",
    "audio=false",
    "control=true",
    "cleanup=true",
    "clipboard_autosync=false",
    "video_codec=h264"
  ];
  if (options.maxSize !== void 0) {
    params.push(`max_size=${options.maxSize}`);
  }
  if (options.maxFps !== void 0) {
    params.push(`max_fps=${options.maxFps}`);
  }
  if (options.videoBitRate !== void 0) {
    params.push(`video_bit_rate=${options.videoBitRate}`);
  }
  return [
    "-s",
    serial,
    "shell",
    `CLASSPATH=${jar}`,
    "app_process",
    "/",
    "com.genymobile.scrcpy.Server",
    version,
    ...params
  ];
}
__name(startScrcpyServerArgs, "startScrcpyServerArgs");

// src/main/emulator/android/scrcpy-server-download.ts
var DOWNLOAD_URL = `https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_SERVER_VERSION}/scrcpy-server-v${SCRCPY_SERVER_VERSION}`;
var MIN_VALID_BYTES = 1e4;
function scrcpyServerJarPath() {
  return (0, import_node_path8.join)(import_electron3.app.getPath("userData"), "scrcpy", `scrcpy-server-v${SCRCPY_SERVER_VERSION}.jar`);
}
__name(scrcpyServerJarPath, "scrcpyServerJarPath");
function isScrcpyServerJarReady() {
  try {
    const path2 = scrcpyServerJarPath();
    return (0, import_node_fs7.existsSync)(path2) && (0, import_node_fs7.statSync)(path2).size >= MIN_VALID_BYTES;
  } catch {
    return false;
  }
}
__name(isScrcpyServerJarReady, "isScrcpyServerJarReady");
var inFlightDownload = null;
async function ensureScrcpyServerJar() {
  const path2 = scrcpyServerJarPath();
  if (isScrcpyServerJarReady()) {
    return path2;
  }
  if (!inFlightDownload) {
    inFlightDownload = downloadScrcpyServerJar(path2).finally(() => {
      inFlightDownload = null;
    });
  }
  return inFlightDownload;
}
__name(ensureScrcpyServerJar, "ensureScrcpyServerJar");
async function downloadScrcpyServerJar(path2) {
  emulatorProbe("scrcpy.jar.download.start", { url: DOWNLOAD_URL, dest: path2 });
  (0, import_node_fs7.mkdirSync)((0, import_node_path8.dirname)(path2), { recursive: true });
  try {
    await downloadTo(DOWNLOAD_URL, path2);
  } catch (error) {
    (0, import_node_fs7.rmSync)(path2, { force: true });
    emulatorProbeError("scrcpy.jar.download.fail", error, { url: DOWNLOAD_URL });
    const detail = error instanceof Error ? error.message : "unknown error";
    throw new EmulatorError("emulator_helper_failed", `Could not download scrcpy server: ${detail}`);
  }
  if (!isScrcpyServerJarReady()) {
    (0, import_node_fs7.rmSync)(path2, { force: true });
    throw new EmulatorError(
      "emulator_helper_failed",
      "Downloaded scrcpy server was invalid or truncated."
    );
  }
  emulatorProbe("scrcpy.jar.download.ok", { dest: path2, bytes: (0, import_node_fs7.statSync)(path2).size });
  return path2;
}
__name(downloadScrcpyServerJar, "downloadScrcpyServerJar");
function downloadTo(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error("too many redirects"));
      return;
    }
    const req = (0, import_node_https.get)(url, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        const next = new URL(res.headers.location, url);
        if (next.protocol !== "https:") {
          res.resume();
          reject(new Error(`refusing non-https redirect to ${next.protocol}`));
          return;
        }
        res.resume();
        downloadTo(next.toString(), dest, redirects + 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(`HTTP ${status}`));
        return;
      }
      (0, import_promises2.pipeline)(res, (0, import_node_fs7.createWriteStream)(dest)).then(resolve, reject);
    });
    req.on("error", reject);
    req.setTimeout(3e4, () => req.destroy(new Error("download timed out")));
  });
}
__name(downloadTo, "downloadTo");

// src/main/emulator/scrcpy-video-registry.ts
var MAX_GOP_FRAMES = 120;
var ScrcpyVideoRegistry = class {
  static {
    __name(this, "ScrcpyVideoRegistry");
  }
  entries = /* @__PURE__ */ new Map();
  register(deviceId, close) {
    this.entries.set(deviceId, { subscribers: /* @__PURE__ */ new Set(), gop: [], close });
  }
  pushMeta(deviceId, meta) {
    const entry = this.entries.get(deviceId);
    if (!entry) {
      return;
    }
    entry.meta = meta;
    for (const subscriber of entry.subscribers) {
      subscriber({ type: "meta", meta });
    }
  }
  pushFrame(deviceId, frame) {
    const entry = this.entries.get(deviceId);
    if (!entry) {
      return;
    }
    if (frame.config) {
      entry.config = frame;
    } else if (frame.keyFrame) {
      entry.gop = [frame];
    } else if (entry.gop.length > 0) {
      entry.gop.push(frame);
      if (entry.gop.length > MAX_GOP_FRAMES) {
        entry.gop.splice(1, 1);
      }
    }
    for (const subscriber of entry.subscribers) {
      subscriber({ type: "frame", frame });
    }
  }
  // Subscribe a renderer; replays the cached meta + config so the decoder can
  // start without waiting for the next keyframe. Returns an unsubscribe fn.
  subscribe(deviceId, subscriber) {
    const entry = this.entries.get(deviceId);
    if (!entry) {
      return () => {
      };
    }
    if (entry.meta) {
      subscriber({ type: "meta", meta: entry.meta });
    }
    if (entry.config) {
      subscriber({ type: "frame", frame: entry.config });
    }
    for (const frame of entry.gop) {
      subscriber({ type: "frame", frame });
    }
    entry.subscribers.add(subscriber);
    return () => entry.subscribers.delete(subscriber);
  }
  stop(deviceId) {
    const entry = this.entries.get(deviceId);
    if (!entry) {
      return;
    }
    entry.close();
    entry.subscribers.clear();
    this.entries.delete(deviceId);
  }
  has(deviceId) {
    return this.entries.has(deviceId);
  }
};
var scrcpyVideoRegistry = new ScrcpyVideoRegistry();

// src/main/emulator/android/scrcpy-stream-session.ts
var import_node_child_process9 = require("node:child_process");
var import_node_net2 = require("node:net");
var import_node_crypto = require("node:crypto");

// src/shared/relay-frame-buffer.ts
var RelayFrameBuffer = class {
  static {
    __name(this, "RelayFrameBuffer");
  }
  chunks = [];
  head = 0;
  bytes = 0;
  get length() {
    return this.bytes;
  }
  get chunkCount() {
    return this.chunks.length - this.head;
  }
  append(chunk) {
    this.chunks.push(chunk);
    this.bytes += chunk.length;
  }
  clear() {
    this.chunks = [];
    this.head = 0;
    this.bytes = 0;
  }
  drain() {
    const out = this.chunks.length - this.head === 1 ? this.chunks[this.head] : Buffer.concat(this.chunks.slice(this.head), this.bytes);
    this.clear();
    return out;
  }
  peek(count) {
    const first = this.chunks[this.head];
    if (first.length >= count) {
      return first;
    }
    const out = Buffer.allocUnsafe(count);
    let copied = 0;
    for (let index = this.head; index < this.chunks.length; index += 1) {
      const part = this.chunks[index];
      copied += part.copy(out, copied, 0, Math.min(part.length, count - copied));
      if (copied >= count) {
        break;
      }
    }
    return out;
  }
  take(count) {
    const first = this.chunks[this.head];
    if (first.length === count) {
      this.removeHead();
      this.bytes -= count;
      return first;
    }
    if (first.length > count) {
      this.chunks[this.head] = first.subarray(count);
      this.bytes -= count;
      return first.subarray(0, count);
    }
    const out = Buffer.allocUnsafe(count);
    let copied = 0;
    while (copied < count) {
      const part = this.chunks[this.head];
      const take = Math.min(part.length, count - copied);
      part.copy(out, copied, 0, take);
      copied += take;
      if (take === part.length) {
        this.removeHead();
      } else {
        this.chunks[this.head] = part.subarray(take);
      }
    }
    this.bytes -= count;
    return out;
  }
  removeHead() {
    this.chunks[this.head] = void 0;
    this.head += 1;
    if (this.head === this.chunks.length || this.head >= 1024 && this.head * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
  }
  discard(count) {
    let remaining = count;
    while (remaining > 0) {
      const part = this.chunks[this.head];
      if (part.length <= remaining) {
        this.removeHead();
        remaining -= part.length;
      } else {
        this.chunks[this.head] = part.subarray(remaining);
        remaining = 0;
      }
    }
    this.bytes -= count;
  }
};

// src/main/emulator/android/scrcpy-video-frame-parser.ts
var FRAME_HEADER_SIZE = 12;
var CODEC_META_SIZE = 12;
var MAX_FRAME_BYTES = 16 * 1024 * 1024;
var MAX_PENDING_CHUNKS = 1024;
var CONFIG_FLAG = 1n << 63n;
var KEY_FRAME_FLAG = 1n << 62n;
var PTS_MASK = (1n << 62n) - 1n;
function parseCodecId(bytes) {
  let id = "";
  for (const byte of bytes) {
    if (byte !== 0) {
      id += String.fromCharCode(byte);
    }
  }
  return id;
}
__name(parseCodecId, "parseCodecId");
function parseScrcpyVideoMeta(buffer) {
  if (buffer.length < CODEC_META_SIZE) {
    return null;
  }
  return {
    codecId: parseCodecId(buffer.subarray(0, 4)),
    width: buffer.readUInt32BE(4),
    height: buffer.readUInt32BE(8)
  };
}
__name(parseScrcpyVideoMeta, "parseScrcpyVideoMeta");
function parseScrcpyVideoFrames(buffer) {
  const frames = [];
  while (buffer.length >= FRAME_HEADER_SIZE) {
    const header = buffer.peek(FRAME_HEADER_SIZE);
    const meta = header.readBigUInt64BE(0);
    const size = header.readUInt32BE(8);
    if (size > MAX_FRAME_BYTES) {
      throw new Error(`scrcpy frame size ${size} exceeds ${MAX_FRAME_BYTES}; stream desynced`);
    }
    if (buffer.length < FRAME_HEADER_SIZE + size) {
      break;
    }
    const packet = buffer.take(FRAME_HEADER_SIZE + size);
    frames.push({
      config: (meta & CONFIG_FLAG) !== 0n,
      keyFrame: (meta & KEY_FRAME_FLAG) !== 0n,
      pts: meta & PTS_MASK,
      data: Buffer.from(packet.subarray(FRAME_HEADER_SIZE))
    });
  }
  if (frames.length > 0 && buffer.length > 0) {
    const pendingHead = buffer.peek(1);
    if (pendingHead.buffer.byteLength > Math.max(Buffer.poolSize, pendingHead.length * 2)) {
      buffer.append(Buffer.from(buffer.drain()));
    }
  }
  if (buffer.chunkCount > MAX_PENDING_CHUNKS) {
    buffer.append(buffer.drain());
  }
  return frames;
}
__name(parseScrcpyVideoFrames, "parseScrcpyVideoFrames");

// src/main/emulator/android/scrcpy-stream-session.ts
var DEVICE_NAME_BYTES = 64;
var DUMMY_BYTE = 1;
var DYNAMIC_FORWARD_PORT = 0;
function newScid() {
  return ((0, import_node_crypto.randomBytes)(4).readUInt32BE(0) & 2147483647).toString(16).padStart(8, "0");
}
__name(newScid, "newScid");
var ScrcpyStreamSession = class _ScrcpyStreamSession {
  constructor(options, callbacks, scid, port) {
    this.options = options;
    this.callbacks = callbacks;
    this.scid = scid;
    this.port = port;
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
  }
  options;
  callbacks;
  scid;
  port;
  static {
    __name(this, "ScrcpyStreamSession");
  }
  server = null;
  videoSocket = null;
  controlSocket = null;
  pendingVideo = new RelayFrameBuffer();
  metaSeen = false;
  headerStripped = false;
  closed = false;
  ready;
  resolveReady = null;
  rejectReady = null;
  static async start(options, callbacks) {
    const scid = newScid();
    const port = options.localPort ?? DYNAMIC_FORWARD_PORT;
    emulatorProbe("scrcpy.start", { serial: options.serial, port, scid });
    const session = new _ScrcpyStreamSession(options, callbacks, scid, port);
    try {
      await session.deploy();
      session.spawnServer();
      session.connectSockets();
      await session.ready;
    } catch (error) {
      session.close();
      throw error;
    }
    return session;
  }
  async deploy() {
    const { runner, sdk, serial, localJarPath } = this.options;
    ensureAdbOk(
      await runner(sdk.adb, pushScrcpyServerArgs(serial, localJarPath, SCRCPY_DEVICE_JAR_PATH)),
      "scrcpy server push"
    );
    const forward = ensureAdbOk(
      await runner(sdk.adb, scrcpyForwardArgs(serial, this.port, this.scid)),
      "scrcpy port forward"
    );
    if (this.port === DYNAMIC_FORWARD_PORT) {
      const allocated = Number.parseInt(forward.stdout.trim(), 10);
      if (!Number.isFinite(allocated) || allocated <= 0) {
        throw new Error("adb did not return a local scrcpy port");
      }
      this.port = allocated;
      emulatorProbe("scrcpy.forward.port", { serial, port: this.port });
    }
  }
  spawnServer() {
    const { sdk, serial, maxSize } = this.options;
    this.server = (0, import_node_child_process9.spawn)(sdk.adb, startScrcpyServerArgs(serial, { scid: this.scid, maxSize }), {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let serverLog = "";
    const capture = /* @__PURE__ */ __name((chunk) => {
      serverLog += chunk.toString();
    }, "capture");
    this.server.stdout?.on("data", capture);
    this.server.stderr?.on("data", capture);
    this.server.on("error", (error) => this.fail(error.message));
    this.server.on("exit", (code) => {
      emulatorProbe("scrcpy.server.exit", { code, log: serverLog.slice(0, 1e3).trim() });
      if (!this.metaSeen) {
        this.fail("scrcpy server exited before the video stream started");
        return;
      }
      this.close();
    });
  }
  connectSockets() {
    this.openVideoSocket(0);
  }
  // adb accepts the forwarded TCP connection before the server's abstract socket
  // exists (then resets it), so retry until the server actually delivers bytes
  // (the dummy byte). Only then is the connection real; connect control after.
  openVideoSocket(attempt) {
    if (this.closed) {
      return;
    }
    const socket = (0, import_node_net2.connect)(this.port, "127.0.0.1");
    let settled = false;
    const retry = /* @__PURE__ */ __name(() => {
      if (settled || this.closed) {
        return;
      }
      settled = true;
      socket.destroy();
      if (attempt >= 100) {
        emulatorProbeError("scrcpy.socket.fail", new Error("no data"), { attempt });
        this.fail("scrcpy video stream did not start");
        return;
      }
      setTimeout(() => this.openVideoSocket(attempt + 1), 100);
    }, "retry");
    socket.once("data", (chunk) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.setTimeout(0);
      emulatorProbe("scrcpy.video.connected", { attempt, bytes: chunk.length });
      this.videoSocket = socket;
      socket.on("data", (next) => this.handleVideoChunk(next));
      socket.on("error", (error) => this.fail(error.message));
      this.handleVideoChunk(chunk);
      this.openControlSocket();
    });
    socket.once("error", retry);
    socket.once("close", retry);
    socket.setTimeout(2e3, retry);
  }
  openControlSocket() {
    if (this.closed) {
      return;
    }
    const socket = (0, import_node_net2.connect)(this.port, "127.0.0.1");
    socket.on(
      "error",
      (error) => emulatorProbeError("scrcpy.control.fail", error, { serial: this.options.serial })
    );
    socket.on("close", () => {
      if (this.controlSocket === socket) {
        this.controlSocket = null;
      }
    });
    this.controlSocket = socket;
  }
  handleVideoChunk(chunk) {
    const buffer = this.pendingVideo;
    if (chunk.length > 0) {
      buffer.append(Buffer.from(chunk));
    }
    if (!this.headerStripped) {
      const headerLen = DUMMY_BYTE + DEVICE_NAME_BYTES;
      if (buffer.length < headerLen) {
        return;
      }
      buffer.discard(headerLen);
      this.headerStripped = true;
    }
    let shouldResolveReady = false;
    if (!this.metaSeen) {
      if (buffer.length < 12) {
        return;
      }
      const meta = parseScrcpyVideoMeta(buffer.peek(12));
      this.metaSeen = true;
      emulatorProbe("scrcpy.meta", meta);
      this.callbacks.onMeta(meta);
      shouldResolveReady = true;
      buffer.discard(12);
    }
    let frames;
    try {
      frames = parseScrcpyVideoFrames(buffer);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
      return;
    }
    if (shouldResolveReady) {
      this.resolveReady?.();
      this.resolveReady = null;
      this.rejectReady = null;
    }
    for (const frame of frames) {
      this.callbacks.onFrame(frame);
    }
  }
  fail(message) {
    if (this.closed) {
      return;
    }
    emulatorProbeError("scrcpy.fail", new Error(message), { serial: this.options.serial });
    this.rejectReady?.(new Error(message));
    this.resolveReady = null;
    this.rejectReady = null;
    this.callbacks.onError(message);
    this.close();
  }
  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    emulatorProbe("scrcpy.close", { serial: this.options.serial });
    this.videoSocket?.destroy();
    this.controlSocket?.destroy();
    this.server?.kill();
    void this.options.runner(this.options.sdk.adb, scrcpyRemoveForwardArgs(this.options.serial, this.port)).catch(() => {
    });
    this.callbacks.onClose();
  }
};

// src/main/emulator/android/android-stream-session-starter.ts
function toArrayBuffer(buffer) {
  const arrayBuffer = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(arrayBuffer).set(buffer);
  return arrayBuffer;
}
__name(toArrayBuffer, "toArrayBuffer");
var startAndroidStreamSession = /* @__PURE__ */ __name(async ({
  runner,
  sdk,
  serial,
  jarPath,
  maxSize
}) => {
  let session = null;
  scrcpyVideoRegistry.register(serial, () => session?.close());
  try {
    session = await ScrcpyStreamSession.start(
      { runner, sdk, serial, localJarPath: jarPath, maxSize },
      {
        onMeta: /* @__PURE__ */ __name((meta) => scrcpyVideoRegistry.pushMeta(serial, meta), "onMeta"),
        onFrame: /* @__PURE__ */ __name((frame) => scrcpyVideoRegistry.pushFrame(serial, {
          config: frame.config,
          keyFrame: frame.keyFrame,
          pts: frame.pts.toString(),
          bytes: toArrayBuffer(frame.data)
        }), "onFrame"),
        onError: /* @__PURE__ */ __name(() => scrcpyVideoRegistry.stop(serial), "onError"),
        onClose: /* @__PURE__ */ __name(() => scrcpyVideoRegistry.stop(serial), "onClose")
      }
    );
  } catch (error) {
    scrcpyVideoRegistry.stop(serial);
    throw error;
  }
  let closed = false;
  return {
    info: androidStreamSessionInfo(serial),
    handle: {
      close: /* @__PURE__ */ __name(() => {
        if (closed) {
          return;
        }
        closed = true;
        session?.close();
        scrcpyVideoRegistry.stop(serial);
      }, "close")
    }
  };
}, "startAndroidStreamSession");
function androidStreamSessionInfo(serial) {
  return {
    deviceUdid: serial,
    streamUrl: `scrcpy://${serial}`,
    wsUrl: "",
    streamCodec: "h264",
    backend: "android"
  };
}
__name(androidStreamSessionInfo, "androidStreamSessionInfo");

// src/main/emulator/android/android-stream-controller.ts
var AndroidStreamController = class {
  constructor(deps) {
    this.deps = deps;
  }
  deps;
  static {
    __name(this, "AndroidStreamController");
  }
  handles = /* @__PURE__ */ new Map();
  starts = /* @__PURE__ */ new Map();
  async start(serial) {
    const inFlight = this.starts.get(serial);
    if (inFlight) {
      return inFlight;
    }
    const start = this.begin(serial);
    this.starts.set(serial, start);
    try {
      return await start;
    } finally {
      this.starts.delete(serial);
    }
  }
  async begin(serial) {
    if (this.handles.has(serial) && scrcpyVideoRegistry.has(serial)) {
      return androidStreamSessionInfo(serial);
    }
    this.handles.delete(serial);
    const jarPath = await this.deps.ensureJar();
    const { info, handle } = await this.deps.startStreamSession({
      runner: this.deps.runner,
      sdk: this.deps.sdk(),
      serial,
      jarPath,
      maxSize: this.deps.maxSize
    });
    this.handles.set(serial, handle);
    return info;
  }
  stop(serial) {
    const handle = this.handles.get(serial);
    if (handle) {
      handle.close();
      this.handles.delete(serial);
    }
  }
};

// src/main/emulator/backends/android-emulator-backend.ts
var DEFAULT_BOOT_TIMEOUT_MS = 18e4;
var DEFAULT_POLL_INTERVAL_MS = 2e3;
var AndroidEmulatorBackend = class {
  static {
    __name(this, "AndroidEmulatorBackend");
  }
  kind = "android";
  streamCodec = "h264";
  capabilities = {
    install: true,
    launch: true,
    permissions: true,
    accessibilityTree: true,
    logcat: true
  };
  runner;
  sdkState;
  bootTimeoutMs;
  pollIntervalMs;
  sleep;
  ensureJar;
  startStreamSession;
  streamMaxSize;
  screenSizes = /* @__PURE__ */ new Map();
  streams;
  constructor(options = {}) {
    this.runner = options.runner ?? execFileAndroidCommandRunner;
    this.sdkState = new AndroidSdkState(options.sdk !== void 0, options.sdk ?? null);
    this.bootTimeoutMs = options.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.sleep = options.sleep ?? defaultSleep;
    this.ensureJar = options.ensureJar ?? ensureScrcpyServerJar;
    this.startStreamSession = options.startStreamSession ?? startAndroidStreamSession;
    this.streamMaxSize = options.streamMaxSize ?? 1280;
    this.streams = new AndroidStreamController({
      runner: this.runner,
      sdk: /* @__PURE__ */ __name(() => this.requireSdk(), "sdk"),
      ensureJar: this.ensureJar,
      startStreamSession: this.startStreamSession,
      maxSize: this.streamMaxSize
    });
  }
  isSupportedOnHost() {
    return this.sdkState.resolve() !== null;
  }
  async checkAvailability() {
    const sdk = this.sdkState.resolve();
    if (!sdk) {
      return {
        available: false,
        devices: [],
        message: "Android SDK not found. Install Android Studio and set ANDROID_HOME."
      };
    }
    const sdkPath = sdk.sdkRoot;
    let devices = [];
    try {
      devices = await this.listDevices();
    } catch (error) {
      const message = error instanceof Error ? error.message : "adb is unavailable.";
      return { available: false, devices: [], message, sdkPath };
    }
    if (devices.length === 0) {
      return {
        available: false,
        devices,
        message: "No Android devices or AVDs found. Create one in Android Studio.",
        sdkPath
      };
    }
    return { available: true, devices, message: "Ready", sdkPath };
  }
  async listDevices() {
    const sdk = this.sdkState.resolve();
    return sdk ? listAndroidDevices(this.runner, sdk) : [];
  }
  async ownsDevice(id) {
    if (!this.sdkState.resolve()) {
      return false;
    }
    const devices = await this.listDevices();
    return devices.some((device) => device.id === id || device.name === id);
  }
  async resolveDeviceId(deviceOrName) {
    const sdk = this.requireSdk();
    const running = await listRunningAdbDevices(this.runner, sdk);
    if (running.some((device) => device.serial === deviceOrName)) {
      return deviceOrName;
    }
    const serial = await findRunningAvdSerial(this.runner, sdk, deviceOrName, running);
    if (serial) {
      return serial;
    }
    throw new EmulatorError(
      "emulator_device_not_found",
      `Android device "${deviceOrName}" is not running. Boot it first.`
    );
  }
  async startSession(deviceId) {
    return this.streams.start(await this.ensureBooted(deviceId));
  }
  async stopHelperForDevice(deviceId, options = {}) {
    this.streams.stop(deviceId);
    if (options.includeOrphaned) {
      const sdk = this.sdkState.resolve();
      if (!sdk) {
        return;
      }
      const serial = await this.resolveDeviceId(deviceId).catch(() => null);
      if (!serial) {
        return;
      }
      await this.runner(sdk.adb, ["-s", serial, "forward", "--remove-all"]).catch(() => {
      });
    }
  }
  async shutdownDevice(deviceId) {
    const sdk = this.requireSdk();
    const serial = await this.resolveDeviceId(deviceId);
    this.screenSizes.delete(serial);
    ensureAdbOk(await this.runner(sdk.adb, emuKillArgs(serial)), "adb emulator shutdown");
  }
  async isSessionReusable(info) {
    return scrcpyVideoRegistry.has(info.deviceUdid);
  }
  async tap(deviceId, x, y) {
    const serial = await this.resolveDeviceId(deviceId);
    await androidTap(this.runner, this.requireSdk(), serial, x, y, await this.getScreenSize(serial));
  }
  async gesture(deviceId, points, _wsUrl) {
    const serial = await this.resolveDeviceId(deviceId);
    await androidSwipe(
      this.runner,
      this.requireSdk(),
      serial,
      points,
      await this.getScreenSize(serial)
    );
  }
  async type(deviceId, text) {
    await androidTypeText(
      this.runner,
      this.requireSdk(),
      await this.resolveDeviceId(deviceId),
      text
    );
  }
  async button(deviceId, name) {
    await androidButton(this.runner, this.requireSdk(), await this.resolveDeviceId(deviceId), name);
  }
  async rotate(deviceId, orientation) {
    const serial = await this.resolveDeviceId(deviceId);
    this.screenSizes.delete(serial);
    await androidRotate(this.runner, this.requireSdk(), serial, orientation);
  }
  async exec(deviceId, command) {
    return androidExec(
      this.runner,
      this.requireSdk(),
      await this.resolveDeviceId(deviceId),
      command
    );
  }
  async installApp(deviceId, apkPath, options) {
    await this.withSerial(
      deviceId,
      (sdk, serial) => installAndroidApk(this.runner, sdk, serial, apkPath, options)
    );
  }
  async launchApp(deviceId, packageName, activity) {
    await this.withSerial(
      deviceId,
      (sdk, serial) => launchAndroidApp(this.runner, sdk, serial, packageName, activity)
    );
  }
  async setPermission(deviceId, op, packageName, permission) {
    await this.withSerial(
      deviceId,
      (sdk, serial) => setAndroidPermission(this.runner, sdk, serial, op, packageName, permission)
    );
  }
  async accessibilityTree(deviceId) {
    return this.withSerial(
      deviceId,
      (sdk, serial) => dumpAndroidAccessibilityTree(this.runner, sdk, serial)
    );
  }
  async logcat(deviceId, options) {
    return this.withSerial(
      deviceId,
      (sdk, serial) => captureAndroidLogcat(this.runner, sdk, serial, options)
    );
  }
  async withSerial(deviceId, run) {
    return run(this.requireSdk(), await this.resolveDeviceId(deviceId));
  }
  // Boots an AVD (by name) when not running and waits for boot; returns the serial.
  async ensureBooted(deviceOrName) {
    return bootAndroidDevice(this.runner, this.requireSdk(), deviceOrName, {
      bootTimeoutMs: this.bootTimeoutMs,
      pollIntervalMs: this.pollIntervalMs,
      sleep: this.sleep
    });
  }
  async getScreenSize(serial) {
    const cached = this.screenSizes.get(serial);
    if (cached) {
      return cached;
    }
    const sdk = this.requireSdk();
    const result = await this.runner(sdk.adb, wmSizeArgs(serial));
    const size = parseWmSize(result.stdout);
    if (!size) {
      throw new EmulatorError("emulator_error", `Could not read screen size for ${serial}.`);
    }
    this.screenSizes.set(serial, size);
    return size;
  }
  requireSdk() {
    return this.sdkState.require();
  }
};
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
__name(defaultSleep, "defaultSleep");

// src/main/emulator/emulator-bridge.ts
var EmulatorBridge = class {
  static {
    __name(this, "EmulatorBridge");
  }
  sessionRegistry = new EmulatorSessionRegistry();
  startLeases = new EmulatorStartLeaseRegistry();
  backends;
  iosBackend;
  androidBackend;
  constructor(options = {}) {
    this.iosBackend = new IosEmulatorBackend(options);
    this.androidBackend = new AndroidEmulatorBackend();
    this.backends = [this.iosBackend, this.androidBackend];
  }
  listBackends() {
    return this.backends;
  }
  // Aggregated device list across host-supported backends (iOS simulators +
  // Android devices/AVDs), for the unified `orca emulator list`.
  async listAllDevices() {
    return listAvailableEmulatorDevices(this.backends);
  }
  // iOS-specific passthroughs kept for back-compat with the runtime + availability code.
  async listSimulators() {
    return this.iosBackend.listSimulators();
  }
  async listRunningHelpers() {
    return this.iosBackend.listRunningHelpers();
  }
  async checkServeSimAvailable() {
    return this.iosBackend.checkServeSimAvailable();
  }
  registerActiveEmulator(worktreeId, info, options = {}) {
    this.sessionRegistry.registerActive(worktreeId, info, options);
  }
  unregisterActiveEmulator(worktreeId) {
    this.sessionRegistry.unregisterWorktree(worktreeId);
  }
  getActiveForWorktree(worktreeId) {
    return this.sessionRegistry.getActiveForWorktree(worktreeId);
  }
  // On a device switch, keep slow-to-boot Android emulators running for instant
  // switch-back; shut down other backends' devices so they are not leaked.
  async stopActiveForSwitch(worktreeId) {
    const keepAlive = this.backendForActiveWorktree(worktreeId)?.kind === "android";
    return this.stopActiveForWorktreeInternal(worktreeId, { shutdownDevice: !keepAlive });
  }
  async getReusableActiveForWorktree(worktreeId, device) {
    const active = this.getActiveForWorktree(worktreeId);
    if (!active) {
      return null;
    }
    const backend = this.backendForActiveWorktree(worktreeId);
    if (!backend) {
      return null;
    }
    if (device) {
      const resolved = await backend.resolveDeviceId(device).catch(() => null);
      if (resolved !== active.deviceUdid) {
        return null;
      }
    }
    return await backend.isSessionReusable(active) ? active : null;
  }
  async stopActiveForWorktree(worktreeId, options = {}) {
    return this.stopActiveForWorktreeInternal(worktreeId, options);
  }
  async stopActiveManagedForWorktree(worktreeId, options = {}) {
    return this.stopActiveForWorktreeInternal(worktreeId, { ...options, managedOnly: true });
  }
  async stopActiveForWorktreeInternal(worktreeId, options = {}) {
    const key = this.sessionRegistry.getActiveSessionKey(worktreeId);
    if (!key) {
      return null;
    }
    const session = this.sessionRegistry.getSession(key);
    this.sessionRegistry.unregisterWorktree(worktreeId);
    if (!session || options.managedOnly && !session.managed) {
      return null;
    }
    if (this.sessionRegistry.hasActiveWorktreeForSession(key)) {
      return session.deviceUdid;
    }
    const backend = this.backendForKind(session.backend);
    if (!backend) {
      return null;
    }
    const sessionInfo = this.sessionRegistry.toSessionInfo(session);
    await this.startLeases.cleanupWhenIdle(
      backend,
      sessionInfo,
      (info) => this.sessionRegistry.hasActiveWorktreeForSession(info.deviceUdid),
      {
        includeOrphaned: !options.managedOnly,
        shutdownDevice: options.shutdownDevice
      }
    );
    if (!this.sessionRegistry.hasActiveWorktreeForSession(key)) {
      this.sessionRegistry.clearSessionAndWorktrees(key);
    }
    return session.deviceUdid;
  }
  async shutdownActiveManagedForWorktree(worktreeId) {
    return this.stopActiveManagedForWorktree(worktreeId, { shutdownDevice: true });
  }
  async tap(x, y, opts) {
    const { backend, device } = await this.resolveTarget(opts);
    await backend.tap(device, x, y);
  }
  async gesture(points, opts) {
    if (points.length === 0) {
      return;
    }
    const { backend, device } = await this.resolveTarget(opts);
    const udid = await backend.resolveDeviceId(device);
    const wsUrl = this.sessionRegistry.getSession(udid)?.wsUrl ?? null;
    await backend.gesture(udid, points, wsUrl);
  }
  async type(text, opts) {
    const { backend, device } = await this.resolveTarget(opts);
    await backend.type(device, text);
  }
  async button(name, opts) {
    const { backend, device } = await this.resolveTarget(opts);
    await backend.button(device, name);
  }
  async rotate(orientation, opts) {
    const { backend, device } = await this.resolveTarget(opts);
    await backend.rotate(device, orientation);
  }
  async exec(command, opts) {
    const { backend, device } = await this.resolveTarget(opts);
    return backend.exec(device, command);
  }
  async accessibilityTree(opts) {
    return this.runCapability("accessibilityTree", opts, async (backend, device) => {
      if (backend.kind !== "ios") {
        return backend.accessibilityTree(device);
      }
      const udid = await backend.resolveDeviceId(device);
      const worktreeId = opts?.worktreeId;
      const session = (worktreeId ? this.getActiveForWorktree(worktreeId) : null) ?? this.sessionRegistry.getSession(udid);
      if (worktreeId && session && session.deviceUdid !== udid) {
        throw new EmulatorError(
          "emulator_no_active",
          `iOS simulator ${udid} is not active for this worktree (active: ${session.deviceUdid}); attach the requested simulator first.`
        );
      }
      const axUrl = session?.axUrl ?? deriveAxUrlFromStreamUrl(session?.streamUrl);
      return backend.accessibilityTree(udid, axUrl);
    });
  }
  // Runs a capability-gated verb against the resolved target, rejecting backends
  // that do not advertise the capability (e.g. install/logcat on iOS).
  async runCapability(capability, opts, run) {
    const { backend, device } = await this.resolveTarget(opts);
    if (!backend.capabilities[capability]) {
      throw new EmulatorError(
        "emulator_unsupported",
        `${capability} is not supported by the ${backend.kind} emulator backend`
      );
    }
    return run(backend, device);
  }
  async acquireHelperForDevice(device) {
    const backend = await this.backendForDevice(device);
    return this.startLeases.acquire(
      backend,
      device,
      (info) => this.sessionRegistry.hasActiveWorktreeForSession(info.deviceUdid)
    );
  }
  async kill(device, worktreeId) {
    const { backend, udid } = await this.resolveStopTarget(device, worktreeId);
    await backend.stopHelperForDevice(udid, {
      helperPid: this.sessionRegistry.getSession(udid)?.pid,
      includeOrphaned: true
    });
    this.sessionRegistry.clearSessionAndWorktrees(udid);
    return udid;
  }
  async shutdown(device, worktreeId) {
    const { backend, udid } = await this.resolveStopTarget(device, worktreeId);
    await backend.stopHelperForDevice(udid, {
      helperPid: this.sessionRegistry.getSession(udid)?.pid,
      includeOrphaned: true
    });
    await backend.shutdownDevice(udid);
    this.sessionRegistry.clearSessionAndWorktrees(udid);
    return udid;
  }
  async destroyAllSessions() {
    const promises = [];
    for (const session of this.sessionRegistry.listSessions()) {
      if (!session.managed) {
        continue;
      }
      const backend = this.backendForKind(session.backend);
      if (!backend) {
        continue;
      }
      promises.push(
        backend.stopHelperForDevice(session.deviceUdid, { helperPid: session.pid }).catch(() => {
        }).then(() => backend.shutdownDevice(session.deviceUdid).catch(() => {
        }))
      );
    }
    await Promise.allSettled(promises);
    this.sessionRegistry.clear();
  }
  async onAppQuit() {
    await this.destroyAllSessions();
  }
  async resolveTarget(opts) {
    const explicit = opts?.device ?? opts?.emulator;
    if (explicit) {
      return { backend: await this.backendForDevice(explicit), device: explicit };
    }
    if (opts?.worktreeId) {
      const active = this.getActiveForWorktree(opts.worktreeId);
      const backend = this.backendForActiveWorktree(opts.worktreeId);
      if (active && backend) {
        return { backend, device: active.deviceUdid };
      }
    }
    throw new EmulatorError(
      "emulator_no_active",
      "No active emulator for this worktree \u2014 use orca emulator attach or open the pane"
    );
  }
  async resolveStopTarget(device, worktreeId) {
    if (device) {
      const backend2 = await this.backendForDevice(device);
      return { backend: backend2, udid: await backend2.resolveDeviceId(device) };
    }
    const { backend, device: resolved } = await this.resolveTarget({ worktreeId });
    return { backend, udid: await backend.resolveDeviceId(resolved) };
  }
  backendForKind(kind) {
    return this.backends.find((backend) => backend.kind === kind) ?? null;
  }
  backendForActiveWorktree(worktreeId) {
    const key = this.sessionRegistry.getActiveSessionKey(worktreeId);
    if (!key) {
      return null;
    }
    const session = this.sessionRegistry.getSession(key);
    return session ? this.backendForKind(session.backend) : null;
  }
  async backendForDevice(device) {
    for (const backend of this.backends) {
      if (await backend.ownsDevice(device)) {
        return backend;
      }
    }
    return this.backends.find((backend) => backend.isSupportedOnHost()) ?? ((0, import_node_os9.platform)() === "darwin" ? this.iosBackend : this.androidBackend);
  }
};

// src/main/emulator/emulator-availability.ts
var import_node_os10 = require("node:os");
function pickDefaultSimulatorDevice(devices) {
  const available = devices.filter((device) => device.isAvailable !== false);
  const booted = available.filter((device) => device.state === "Booted");
  const bootedIphone = booted.find((device) => /iPhone/i.test(device.name || ""));
  return bootedIphone || booted[0] || available.find((device) => /iPhone/i.test(device.name || "")) || available[0] || devices[0] || null;
}
__name(pickDefaultSimulatorDevice, "pickDefaultSimulatorDevice");
async function inspectIosAvailability(bridge) {
  let devices = [];
  let simctl = { ok: true };
  let serveSim = { ok: true };
  try {
    devices = await bridge.listSimulators();
    if (devices.length === 0) {
      simctl = {
        ok: false,
        message: "No iOS simulators found. Add one in Xcode Settings > Platforms."
      };
    }
  } catch (error) {
    simctl = {
      ok: false,
      message: error instanceof Error ? error.message : "xcrun simctl is unavailable."
    };
  }
  try {
    await bridge.checkServeSimAvailable();
  } catch (error) {
    serveSim = {
      ok: false,
      message: error instanceof Error ? error.message : "serve-sim is unavailable."
    };
  }
  return { available: simctl.ok && serveSim.ok && devices.length > 0, devices, simctl, serveSim };
}
__name(inspectIosAvailability, "inspectIosAvailability");
function toSimulatorRow(device) {
  return {
    name: device.name,
    udid: device.id,
    state: device.state === "booted" ? "Booted" : "Shutdown",
    runtime: "Android",
    isAvailable: device.isAvailable
  };
}
__name(toSimulatorRow, "toSimulatorRow");
async function inspectEmulatorAvailability(bridge) {
  const currentPlatform = (0, import_node_os10.platform)();
  const backends = bridge.listBackends();
  const iosBackend = backends.find((backend) => backend.kind === "ios");
  const androidBackend = backends.find((backend) => backend.kind === "android");
  const ios = iosBackend?.isSupportedOnHost() ? await inspectIosAvailability(bridge) : { available: false, devices: [], simctl: { ok: false }, serveSim: { ok: false } };
  const android = androidBackend ? await androidBackend.checkAvailability() : { available: false, devices: [], message: "" };
  const devices = [...ios.devices, ...android.devices.map(toSimulatorRow)];
  const available = ios.available || android.available;
  const message = available ? "Ready" : currentPlatform === "darwin" ? ios.simctl.message || ios.serveSim.message || android.message || "Mobile Emulator is not available." : android.message || "Mobile Emulator is not available.";
  return {
    platform: currentPlatform,
    available,
    devices,
    simctl: ios.simctl,
    serveSim: ios.serveSim,
    android: {
      sdkFound: Boolean(android.sdkPath),
      sdkPath: android.sdkPath,
      message: android.message || ""
    },
    message
  };
}
__name(inspectEmulatorAvailability, "inspectEmulatorAvailability");

// src/main/emulator/emulator-default-attach-device.ts
async function resolveDefaultAttachDevice(bridge) {
  let iosDefault;
  try {
    iosDefault = pickDefaultSimulatorDevice(await bridge.listSimulators())?.udid;
  } catch {
    iosDefault = void 0;
  }
  if (iosDefault) {
    return iosDefault;
  }
  const all = await bridge.listAllDevices();
  return (all.find((row) => row.state === "booted") ?? all[0])?.id;
}
__name(resolveDefaultAttachDevice, "resolveDefaultAttachDevice");

// src/main/runtime/orca-runtime-emulator.ts
var RuntimeEmulatorCommands = class _RuntimeEmulatorCommands {
  constructor(host) {
    this.host = host;
  }
  host;
  static {
    __name(this, "RuntimeEmulatorCommands");
  }
  requireEmulatorBridge() {
    const bridge = this.host.getEmulatorBridge();
    if (!bridge) {
      throw new EmulatorError("emulator_no_active", "No emulator session is active");
    }
    setConfiguredAndroidSdkPath(this.host.getSettings().androidSdkPath ?? null);
    return bridge;
  }
  // Why: RPC envelopes require a serializable `result` field; void/undefined omits it and breaks CLI schema validation.
  static OK = { ok: true };
  // High-level delegation (mirror browser* methods).
  async emulatorTap(params) {
    const bridge = this.requireEmulatorBridge();
    const worktreeId = await this.resolveWorktreeId(params.worktree);
    await bridge.tap(params.x, params.y, { device: params.device ?? params.emulator, worktreeId });
    return _RuntimeEmulatorCommands.OK;
  }
  async emulatorGesture(params) {
    const bridge = this.requireEmulatorBridge();
    const worktreeId = await this.resolveWorktreeId(params.worktree);
    await bridge.gesture(params.points, { device: params.device ?? params.emulator, worktreeId });
    return _RuntimeEmulatorCommands.OK;
  }
  async emulatorType(params) {
    const bridge = this.requireEmulatorBridge();
    const worktreeId = await this.resolveWorktreeId(params.worktree);
    await bridge.type(params.text, { device: params.device ?? params.emulator, worktreeId });
    return _RuntimeEmulatorCommands.OK;
  }
  async emulatorButton(params) {
    const bridge = this.requireEmulatorBridge();
    const worktreeId = await this.resolveWorktreeId(params.worktree);
    await bridge.button(params.name, { device: params.device ?? params.emulator, worktreeId });
    return _RuntimeEmulatorCommands.OK;
  }
  async emulatorRotate(params) {
    const bridge = this.requireEmulatorBridge();
    const worktreeId = await this.resolveWorktreeId(params.worktree);
    await bridge.rotate(params.orientation, {
      device: params.device ?? params.emulator,
      worktreeId
    });
    return _RuntimeEmulatorCommands.OK;
  }
  async emulatorExec(params) {
    const bridge = this.requireEmulatorBridge();
    const worktreeId = await this.resolveWorktreeId(params.worktree);
    return bridge.exec(params.command, {
      device: params.device,
      emulator: params.emulator,
      worktreeId
    });
  }
  async emulatorAttach(params) {
    const settings = this.host.getSettings();
    if (settings.mobileEmulatorEnabled === false) {
      throw new EmulatorError("emulator_disabled", "Mobile Emulator is disabled in Settings.");
    }
    const bridge = this.requireEmulatorBridge();
    let device = params.device ?? settings.mobileEmulatorDefaultDeviceUdid ?? void 0;
    if (!device) {
      device = await resolveDefaultAttachDevice(bridge);
    }
    if (!device) {
      throw new EmulatorError(
        "emulator_device_not_found",
        "No emulator device specified. Choose a default device in Settings > Mobile Emulator or pass a device."
      );
    }
    const worktreeId = await this.resolveWorktreeId(params.worktree);
    if (worktreeId) {
      const reusable = await bridge.getReusableActiveForWorktree(worktreeId, device);
      if (reusable) {
        this.notifyRendererEmulatorAutoAttach(worktreeId, reusable);
        if (params.focus) {
          this.notifyRendererEmulatorPaneFocus(worktreeId);
        }
        return { attached: true, info: reusable };
      }
      await bridge.stopActiveForSwitch(worktreeId);
    }
    const lease = await bridge.acquireHelperForDevice(device);
    const { info } = lease;
    if (worktreeId) {
      try {
        const currentWorktreeId = await this.resolveWorktreeId(params.worktree);
        if (currentWorktreeId !== worktreeId) {
          throw new EmulatorError(
            "emulator_no_active",
            "The workspace changed while the emulator was starting. Reattach the emulator."
          );
        }
      } catch (error) {
        await lease.release({ cleanupIfUnused: true }).catch(() => {
        });
        if (error instanceof Error && error.message === "selector_not_found") {
          throw new EmulatorError(
            "emulator_no_active",
            "The workspace changed while the emulator was starting. Reattach the emulator."
          );
        }
        throw error;
      }
      bridge.registerActiveEmulator(worktreeId, info, { managed: true });
      await lease.release();
      this.notifyRendererEmulatorAutoAttach(worktreeId, info);
      if (params.focus) {
        this.notifyRendererEmulatorPaneFocus(worktreeId);
      }
    } else {
      await lease.release();
    }
    return { attached: true, info };
  }
  async emulatorList(_params = {}) {
    const bridge = this.requireEmulatorBridge();
    return bridge.listRunningHelpers();
  }
  async emulatorUnregisterActive(params) {
    const bridge = this.requireEmulatorBridge();
    const worktreeId = await this.resolveCleanupWorktreeId(params.worktree);
    if (worktreeId) {
      bridge.unregisterActiveEmulator(worktreeId);
    }
    return _RuntimeEmulatorCommands.OK;
  }
  async emulatorListSimulators(_params = {}) {
    const bridge = this.requireEmulatorBridge();
    return bridge.listSimulators();
  }
  async emulatorAvailability(_params = {}) {
    return inspectEmulatorAvailability(this.requireEmulatorBridge());
  }
  // Why: unified device inventory across backends (iOS simulators + Android
  // devices/AVDs) for the cross-platform `orca emulator devices` command.
  async emulatorListDevices(_params = {}) {
    return this.requireEmulatorBridge().listAllDevices();
  }
  async resolveWorktreeId(worktree) {
    return worktree ? await this.host.resolveEmulatorWorkspaceId(worktree) : void 0;
  }
  async resolveCleanupWorktreeId(worktree) {
    return worktree ? await this.host.resolveEmulatorCleanupWorkspaceId(worktree) : void 0;
  }
  async emulatorInstall(params) {
    const worktreeId = await this.resolveWorktreeId(params.worktree);
    await this.requireEmulatorBridge().runCapability(
      "install",
      { device: params.device ?? params.emulator, worktreeId },
      (backend, device) => backend.installApp(device, params.path, { reinstall: params.reinstall })
    );
    return _RuntimeEmulatorCommands.OK;
  }
  async emulatorLaunch(params) {
    const worktreeId = await this.resolveWorktreeId(params.worktree);
    await this.requireEmulatorBridge().runCapability(
      "launch",
      { device: params.device ?? params.emulator, worktreeId },
      (backend, device) => backend.launchApp(device, params.package, params.activity)
    );
    return _RuntimeEmulatorCommands.OK;
  }
  async emulatorPermissions(params) {
    const worktreeId = await this.resolveWorktreeId(params.worktree);
    await this.requireEmulatorBridge().runCapability(
      "permissions",
      { device: params.device ?? params.emulator, worktreeId },
      (backend, device) => backend.setPermission(device, params.op, params.package ?? "", params.permission)
    );
    return _RuntimeEmulatorCommands.OK;
  }
  async emulatorAx(params) {
    const worktreeId = await this.resolveWorktreeId(params.worktree);
    return this.requireEmulatorBridge().accessibilityTree({
      device: params.device ?? params.emulator,
      worktreeId
    });
  }
  async emulatorLogcat(params) {
    const worktreeId = await this.resolveWorktreeId(params.worktree);
    return this.requireEmulatorBridge().runCapability(
      "logcat",
      { device: params.device ?? params.emulator, worktreeId },
      (backend, device) => backend.logcat(device, { lines: params.lines, filters: params.filters })
    );
  }
  async emulatorKill(params) {
    const bridge = this.requireEmulatorBridge();
    const worktreeId = await this.resolveCleanupWorktreeId(params.worktree);
    const killedUdid = await bridge.kill(params.device ?? params.emulator, worktreeId);
    return { ok: true, deviceUdid: killedUdid };
  }
  async emulatorShutdown(params) {
    const bridge = this.requireEmulatorBridge();
    const worktreeId = await this.resolveCleanupWorktreeId(params.worktree);
    if (params.managedOnly && worktreeId && !params.device && !params.emulator) {
      const shutdownUdid2 = await bridge.shutdownActiveManagedForWorktree(worktreeId);
      return { ok: true, deviceUdid: shutdownUdid2 ?? void 0 };
    }
    const shutdownUdid = await bridge.shutdown(params.device ?? params.emulator, worktreeId);
    return { ok: true, deviceUdid: shutdownUdid };
  }
  // Window may not exist during shutdown, so sends are best-effort.
  sendToRenderer(channel, payload) {
    try {
      this.host.getAuthoritativeWindow().webContents.send(channel, payload);
    } catch {
    }
  }
  // Why: mirror browser:pane-focus — scoped per worktree, no cross-worktree yank unless user is already there.
  notifyRendererEmulatorPaneFocus(worktreeId) {
    this.sendToRenderer("emulator:pane-focus", { worktreeId });
  }
  notifyRendererEmulatorAutoAttach(worktreeId, info) {
    this.sendToRenderer("ui:emulatorAutoAttach", { worktreeId, info });
  }
  // Raw for extensibility.
  async emulatorExecRaw(params) {
    return this.emulatorExec(params);
  }
};

// src/main/runtime/rpc/core.ts
var import_zod = require("zod");
function defineMethod(spec) {
  return {
    name: spec.name,
    params: spec.params,
    handler: spec.handler
  };
}
__name(defineMethod, "defineMethod");

// src/main/runtime/rpc/methods/emulator.ts
var import_node_path9 = __toESM(require("node:path"));
var import_zod3 = require("zod");

// src/shared/rpc-contract/emulator-params.ts
var import_zod2 = require("zod");
var WorktreeParam = import_zod2.z.object({ worktree: import_zod2.z.string().optional() }).partial();
var TapParams = import_zod2.z.object({
  x: import_zod2.z.number().min(0).max(1),
  y: import_zod2.z.number().min(0).max(1),
  device: import_zod2.z.string().optional(),
  emulator: import_zod2.z.string().optional(),
  worktree: import_zod2.z.string().optional()
});
var GesturePoint = import_zod2.z.object({
  edge: import_zod2.z.number().int().min(0).max(4).optional(),
  type: import_zod2.z.enum(["begin", "move", "end"]),
  x: import_zod2.z.number().min(0).max(1),
  y: import_zod2.z.number().min(0).max(1)
});
var GestureParams = import_zod2.z.object({
  points: import_zod2.z.array(GesturePoint).min(2).max(64),
  device: import_zod2.z.string().optional(),
  emulator: import_zod2.z.string().optional(),
  worktree: import_zod2.z.string().optional()
});
var TypeParams = import_zod2.z.object({
  text: import_zod2.z.string(),
  device: import_zod2.z.string().optional(),
  emulator: import_zod2.z.string().optional(),
  worktree: import_zod2.z.string().optional()
});
var ButtonParams = import_zod2.z.object({
  name: import_zod2.z.string(),
  device: import_zod2.z.string().optional(),
  emulator: import_zod2.z.string().optional(),
  worktree: import_zod2.z.string().optional()
});
var RotateOrientation = import_zod2.z.enum([
  "portrait",
  "portrait_upside_down",
  "landscape_left",
  "landscape_right"
]);
var RotateParams = import_zod2.z.object({
  orientation: RotateOrientation,
  device: import_zod2.z.string().optional(),
  emulator: import_zod2.z.string().optional(),
  worktree: import_zod2.z.string().optional()
});
var ExecParams = import_zod2.z.object({
  command: import_zod2.z.string(),
  device: import_zod2.z.string().optional(),
  emulator: import_zod2.z.string().optional(),
  worktree: import_zod2.z.string().optional()
});
var LaunchParams = import_zod2.z.object({
  package: import_zod2.z.string(),
  activity: import_zod2.z.string().optional(),
  device: import_zod2.z.string().optional(),
  emulator: import_zod2.z.string().optional(),
  worktree: import_zod2.z.string().optional()
});
var PermissionsParams = import_zod2.z.object({
  op: import_zod2.z.enum(["grant", "revoke", "reset"]),
  package: import_zod2.z.string().optional(),
  permission: import_zod2.z.string().optional(),
  device: import_zod2.z.string().optional(),
  emulator: import_zod2.z.string().optional(),
  worktree: import_zod2.z.string().optional()
}).superRefine((value, ctx) => {
  if (value.op === "reset") {
    if (value.package) {
      ctx.addIssue({
        code: import_zod2.z.ZodIssueCode.custom,
        path: ["package"],
        message: "package is not allowed for reset"
      });
    }
    if (value.permission) {
      ctx.addIssue({
        code: import_zod2.z.ZodIssueCode.custom,
        path: ["permission"],
        message: "permission is not allowed for reset"
      });
    }
    return;
  }
  if (!value.package) {
    ctx.addIssue({
      code: import_zod2.z.ZodIssueCode.custom,
      path: ["package"],
      message: "package is required for grant/revoke"
    });
  }
  if (!value.permission) {
    ctx.addIssue({
      code: import_zod2.z.ZodIssueCode.custom,
      path: ["permission"],
      message: "permission is required for grant/revoke"
    });
  }
});
var AxParams = import_zod2.z.object({
  device: import_zod2.z.string().optional(),
  emulator: import_zod2.z.string().optional(),
  worktree: import_zod2.z.string().optional()
});
var LogcatParams = import_zod2.z.object({
  lines: import_zod2.z.number().int().positive().optional(),
  filters: import_zod2.z.array(import_zod2.z.string()).optional(),
  device: import_zod2.z.string().optional(),
  emulator: import_zod2.z.string().optional(),
  worktree: import_zod2.z.string().optional()
});
var AttachParams = import_zod2.z.object({
  device: import_zod2.z.string().optional(),
  worktree: import_zod2.z.string().optional(),
  focus: import_zod2.z.boolean().optional()
});
var KillParams = import_zod2.z.object({
  device: import_zod2.z.string().optional(),
  emulator: import_zod2.z.string().optional(),
  worktree: import_zod2.z.string().optional()
});
var ShutdownParams = KillParams.extend({
  managedOnly: import_zod2.z.boolean().optional()
});
var ListParams = WorktreeParam;
var EmulatorUnregisterActiveParams = import_zod2.z.object({ worktree: import_zod2.z.string().optional() }).partial();
var EmulatorListDevicesParams = import_zod2.z.object({ worktree: import_zod2.z.string().optional() }).partial();
var EmulatorAvailabilityParams = import_zod2.z.object({ worktree: import_zod2.z.string().optional() }).partial();
var EmulatorListSimulatorsParams = import_zod2.z.object({ worktree: import_zod2.z.string().optional() }).partial();

// src/main/runtime/rpc/methods/emulator.ts
var InstallParams = import_zod3.z.object({
  path: import_zod3.z.string().refine((value) => import_node_path9.default.isAbsolute(value), {
    message: "path must be absolute"
  }),
  reinstall: import_zod3.z.boolean().optional(),
  device: import_zod3.z.string().optional(),
  emulator: import_zod3.z.string().optional(),
  worktree: import_zod3.z.string().optional()
});
var EMULATOR_METHODS = [
  defineMethod({
    name: "emulator.list",
    params: ListParams,
    handler: /* @__PURE__ */ __name(async (params, { runtime }) => runtime.emulatorList(params), "handler")
  }),
  defineMethod({
    name: "emulator.attach",
    params: AttachParams,
    handler: /* @__PURE__ */ __name(async (params, { runtime }) => runtime.emulatorAttach(params), "handler")
  }),
  defineMethod({
    name: "emulator.tap",
    params: TapParams,
    handler: /* @__PURE__ */ __name(async (params, { runtime }) => runtime.emulatorTap(params), "handler")
  }),
  defineMethod({
    name: "emulator.gesture",
    params: GestureParams,
    handler: /* @__PURE__ */ __name(async (params, { runtime }) => runtime.emulatorGesture(params), "handler")
  }),
  defineMethod({
    name: "emulator.type",
    params: TypeParams,
    handler: /* @__PURE__ */ __name(async (params, { runtime }) => runtime.emulatorType(params), "handler")
  }),
  defineMethod({
    name: "emulator.button",
    params: ButtonParams,
    handler: /* @__PURE__ */ __name(async (params, { runtime }) => runtime.emulatorButton(params), "handler")
  }),
  defineMethod({
    name: "emulator.rotate",
    params: RotateParams,
    handler: /* @__PURE__ */ __name(async (params, { runtime }) => runtime.emulatorRotate(params), "handler")
  }),
  defineMethod({
    name: "emulator.exec",
    params: ExecParams,
    handler: /* @__PURE__ */ __name(async (params, { runtime }) => runtime.emulatorExec(params), "handler")
  }),
  defineMethod({
    name: "emulator.kill",
    params: KillParams,
    handler: /* @__PURE__ */ __name(async (params, { runtime }) => runtime.emulatorKill(params), "handler")
  }),
  defineMethod({
    name: "emulator.shutdown",
    params: ShutdownParams,
    handler: /* @__PURE__ */ __name(async (params, { runtime }) => runtime.emulatorShutdown(params), "handler")
  }),
  defineMethod({
    name: "emulator.listSimulators",
    params: EmulatorListSimulatorsParams,
    handler: /* @__PURE__ */ __name(async (params, { runtime }) => runtime.emulatorListSimulators(params), "handler")
  }),
  defineMethod({
    name: "emulator.availability",
    params: EmulatorAvailabilityParams,
    handler: /* @__PURE__ */ __name(async (params, { runtime }) => runtime.emulatorAvailability(params), "handler")
  }),
  defineMethod({
    name: "emulator.listDevices",
    params: EmulatorListDevicesParams,
    handler: /* @__PURE__ */ __name(async (params, { runtime }) => runtime.emulatorListDevices(params), "handler")
  }),
  defineMethod({
    name: "emulator.install",
    params: InstallParams,
    handler: /* @__PURE__ */ __name(async (params, { runtime }) => runtime.emulatorInstall(params), "handler")
  }),
  defineMethod({
    name: "emulator.launch",
    params: LaunchParams,
    handler: /* @__PURE__ */ __name(async (params, { runtime }) => runtime.emulatorLaunch(params), "handler")
  }),
  defineMethod({
    name: "emulator.permissions",
    params: PermissionsParams,
    handler: /* @__PURE__ */ __name(async (params, { runtime }) => runtime.emulatorPermissions(params), "handler")
  }),
  defineMethod({
    name: "emulator.ax",
    params: AxParams,
    handler: /* @__PURE__ */ __name(async (params, { runtime }) => runtime.emulatorAx(params), "handler")
  }),
  defineMethod({
    name: "emulator.logcat",
    params: LogcatParams,
    handler: /* @__PURE__ */ __name(async (params, { runtime }) => runtime.emulatorLogcat(params), "handler")
  }),
  defineMethod({
    name: "emulator.unregisterActive",
    params: EmulatorUnregisterActiveParams,
    handler: /* @__PURE__ */ __name(async (params, { runtime }) => runtime.emulatorUnregisterActive(params), "handler")
  })
];

// src/main/ipc/emulator-frame-stream.ts
var import_electron4 = require("./electron-guard.cjs");
var import_node_crypto2 = require("node:crypto");

// src/main/emulator/mjpeg-frame-stream.ts
var import_node_http = require("node:http");
var import_node_https2 = require("node:https");

// src/main/emulator/mjpeg-frame-parser.ts
var JPEG_START = Buffer.from([255, 216]);
var JPEG_END = Buffer.from([255, 217]);
var DEFAULT_MAX_PENDING_BYTES = 2 * 1024 * 1024;
function trimPendingBuffer(buffer, maxBytes) {
  if (buffer.length <= maxBytes) {
    return Buffer.from(buffer);
  }
  return Buffer.from(buffer.subarray(buffer.length - maxBytes));
}
__name(trimPendingBuffer, "trimPendingBuffer");
function extractJpegFrames(pending, chunk, maxPendingBytes = DEFAULT_MAX_PENDING_BYTES) {
  let cursor = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
  const frames = [];
  while (cursor.length > 0) {
    const frameStart = cursor.indexOf(JPEG_START);
    if (frameStart === -1) {
      const keepLastByte = cursor.at(-1) === 255;
      return { frames, pending: keepLastByte ? Buffer.from([255]) : Buffer.alloc(0) };
    }
    if (frameStart > 0) {
      cursor = cursor.subarray(frameStart);
    }
    const frameEnd = cursor.indexOf(JPEG_END, JPEG_START.length);
    if (frameEnd === -1) {
      return { frames, pending: trimPendingBuffer(cursor, maxPendingBytes) };
    }
    const nextOffset = frameEnd + JPEG_END.length;
    frames.push(cursor.subarray(0, nextOffset));
    cursor = cursor.subarray(nextOffset);
  }
  return { frames, pending: Buffer.alloc(0) };
}
__name(extractJpegFrames, "extractJpegFrames");

// src/main/emulator/mjpeg-frame-stream.ts
var RECONNECT_DELAY_MS = 1e3;
var REQUEST_TIMEOUT_MS = 1e4;
var MAX_FPS = 30;
var MIN_FRAME_INTERVAL_MS = Math.floor(1e3 / MAX_FPS);
function normalizeStreamUrl(streamUrl, streamKey) {
  const url = new URL(streamUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Simulator stream must use http or https.");
  }
  if (!url.pathname.endsWith("/stream.mjpeg")) {
    throw new Error("Simulator stream must target stream.mjpeg.");
  }
  url.searchParams.set("raw", "1");
  if (streamKey) {
    url.searchParams.set("_orca", streamKey);
  }
  return url;
}
__name(normalizeStreamUrl, "normalizeStreamUrl");
function requestForUrl(url, response) {
  return (url.protocol === "https:" ? import_node_https2.request : import_node_http.request)(
    url,
    {
      headers: {
        Accept: "application/octet-stream, image/jpeg"
      },
      timeout: REQUEST_TIMEOUT_MS
    },
    response
  );
}
__name(requestForUrl, "requestForUrl");
var MjpegFrameStream = class {
  static {
    __name(this, "MjpegFrameStream");
  }
  pending = Buffer.alloc(0);
  reconnectTimer = null;
  request = null;
  stopped = false;
  lastFrameAt = 0;
  streamUrl;
  callbacks;
  constructor(streamUrl, callbacks, streamKey) {
    this.streamUrl = normalizeStreamUrl(streamUrl, streamKey);
    this.callbacks = callbacks;
  }
  start() {
    this.openRequest();
  }
  stop() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.request?.destroy();
    this.request = null;
    this.pending = Buffer.alloc(0);
  }
  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openRequest();
    }, RECONNECT_DELAY_MS);
  }
  openRequest() {
    if (this.stopped) {
      return;
    }
    const req = requestForUrl(this.streamUrl, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        this.callbacks.onError(`Simulator stream returned HTTP ${res.statusCode}.`);
        res.resume();
        this.scheduleReconnect();
        return;
      }
      res.on("data", (chunk) => this.handleChunk(chunk));
      res.on("end", () => this.scheduleReconnect());
      res.on("error", (error) => {
        this.callbacks.onError(error.message);
        this.scheduleReconnect();
      });
    });
    this.request = req;
    req.on("timeout", () => req.destroy(new Error("Simulator stream timed out.")));
    req.on("error", (error) => {
      if (this.stopped) {
        return;
      }
      this.callbacks.onError(error.message);
      this.scheduleReconnect();
    });
    req.end();
  }
  handleChunk(chunk) {
    const result = extractJpegFrames(this.pending, chunk);
    this.pending = result.pending;
    for (const frame of result.frames) {
      const now = Date.now();
      if (this.lastFrameAt > 0 && now - this.lastFrameAt < MIN_FRAME_INTERVAL_MS) {
        continue;
      }
      this.lastFrameAt = now;
      this.callbacks.onFrame(frame);
    }
  }
};

// src/main/ipc/emulator-frame-stream.ts
var sessions = /* @__PURE__ */ new Map();
function stopFrameStream(streamId) {
  const session = sessions.get(streamId);
  if (!session) {
    return;
  }
  session.stream.stop();
  session.owner.removeListener("destroyed", session.onOwnerDestroyed);
  sessions.delete(streamId);
}
__name(stopFrameStream, "stopFrameStream");
function frameToArrayBuffer(frame) {
  const arrayBuffer = new ArrayBuffer(frame.byteLength);
  new Uint8Array(arrayBuffer).set(frame);
  return arrayBuffer;
}
__name(frameToArrayBuffer, "frameToArrayBuffer");
function registerEmulatorFrameStreamHandlers() {
  import_electron4.ipcMain.handle(
    "emulator:frameStreamStart",
    (event, args) => {
      const owner = event.sender;
      const ownerWindow = import_electron4.BrowserWindow.fromWebContents(owner);
      if (!ownerWindow) {
        throw new Error("Emulator frame stream must originate from a BrowserWindow.");
      }
      const streamId = (0, import_node_crypto2.randomUUID)();
      const stream = new MjpegFrameStream(
        args.streamUrl,
        {
          onError: /* @__PURE__ */ __name((message) => {
            if (!owner.isDestroyed()) {
              owner.send("emulator:frameStreamError", { streamId, message });
            }
          }, "onError"),
          onFrame: /* @__PURE__ */ __name((frame) => {
            if (!owner.isDestroyed()) {
              owner.send("emulator:frameStreamFrame", {
                streamId,
                bytes: frameToArrayBuffer(frame)
              });
            }
          }, "onFrame")
        },
        args.streamKey
      );
      const onOwnerDestroyed = /* @__PURE__ */ __name(() => stopFrameStream(streamId), "onOwnerDestroyed");
      sessions.set(streamId, { owner, stream, onOwnerDestroyed });
      owner.once("destroyed", onOwnerDestroyed);
      stream.start();
      return { streamId };
    }
  );
  import_electron4.ipcMain.handle("emulator:frameStreamStop", (_event, args) => {
    stopFrameStream(args.streamId);
  });
}
__name(registerEmulatorFrameStreamHandlers, "registerEmulatorFrameStreamHandlers");

// src/main/ipc/emulator-video-stream.ts
var import_electron5 = require("./electron-guard.cjs");
var import_node_crypto3 = require("node:crypto");
function registerEmulatorVideoStreamHandlers() {
  const subscriptions = /* @__PURE__ */ new Map();
  const stopSubscription = /* @__PURE__ */ __name((streamId, owner) => {
    const subscription = subscriptions.get(streamId);
    if (!subscription || owner && subscription.owner !== owner) {
      return;
    }
    subscription.unsubscribe();
    subscription.owner.removeListener("destroyed", subscription.onOwnerDestroyed);
    subscriptions.delete(streamId);
  }, "stopSubscription");
  import_electron5.ipcMain.handle(
    "emulator:videoStreamStart",
    (event, args) => {
      const owner = event.sender;
      if (!import_electron5.BrowserWindow.fromWebContents(owner)) {
        throw new Error("Emulator video stream must originate from a BrowserWindow.");
      }
      if (typeof args?.deviceId !== "string") {
        throw new Error("Emulator video stream requires a deviceId string.");
      }
      emulatorProbe("video.subscribe", { deviceId: args.deviceId });
      const streamId = args.streamId ?? (0, import_node_crypto3.randomUUID)();
      const existing = subscriptions.get(streamId);
      if (existing && existing.owner !== owner) {
        throw new Error("Video stream id is already in use by another renderer");
      }
      stopSubscription(streamId, owner);
      const onOwnerDestroyed = /* @__PURE__ */ __name(() => stopSubscription(streamId, owner), "onOwnerDestroyed");
      const pendingSubscription = {
        owner,
        unsubscribe: /* @__PURE__ */ __name(() => {
        }, "unsubscribe"),
        onOwnerDestroyed
      };
      subscriptions.set(streamId, pendingSubscription);
      setTimeout(() => {
        if (owner.isDestroyed() || subscriptions.get(streamId) !== pendingSubscription) {
          return;
        }
        const unsubscribe = scrcpyVideoRegistry.subscribe(args.deviceId, (videoEvent) => {
          if (owner.isDestroyed()) {
            return;
          }
          if (videoEvent.type === "meta") {
            owner.send("emulator:videoStreamMeta", {
              streamId,
              deviceId: args.deviceId,
              meta: videoEvent.meta
            });
          } else {
            owner.send("emulator:videoStreamFrame", {
              streamId,
              deviceId: args.deviceId,
              ...videoEvent.frame
            });
          }
        });
        pendingSubscription.unsubscribe = unsubscribe;
      }, 0);
      owner.once("destroyed", onOwnerDestroyed);
      return { streamId };
    }
  );
  import_electron5.ipcMain.handle("emulator:videoStreamStop", (event, args) => {
    stopSubscription(args.streamId, event.sender);
  });
}
__name(registerEmulatorVideoStreamHandlers, "registerEmulatorVideoStreamHandlers");
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  EMULATOR_METHODS,
  EmulatorBridge,
  RuntimeEmulatorCommands,
  registerEmulatorFrameStreamHandlers,
  registerEmulatorVideoStreamHandlers
});
