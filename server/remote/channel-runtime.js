import { privatePath } from "./windows-private.cjs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import stateHomeModule from "../state-home.cjs";
import { registerLaunchOptions } from "../agent-launch.js";

const { stateHome } = stateHomeModule;
const DEFAULT_SCRIPT = fileURLToPath(new URL("./channel/iris-channel.mjs", import.meta.url));

async function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try { await fsp.rename(temporary, file); }
  finally { await fsp.unlink(temporary).catch(() => {}); }
}

export function createChannelRuntime(options = {}) {
  const root = options.stateDir || stateHome();
  const socketPath = options.socketPath || path.join(root, "remote", "agent.sock");
  const scriptPath = options.scriptPath || DEFAULT_SCRIPT;
  const nodePath = options.nodePath || process.execPath;
  const asNode = options.asNode ?? true;
  const configPath = options.configPath || path.join(root, "remote", "iris-channel.mcp.json");
  const register = options.registerLaunchOptions || registerLaunchOptions;
  if (![socketPath, scriptPath, nodePath, configPath].every((value) => typeof value === "string" && path.isAbsolute(value))) {
    throw new TypeError("channel runtime paths must be absolute");
  }
  let unregister = null;

  async function start() {
    if (unregister) return;
    await fsp.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
    await fsp.chmod(path.dirname(configPath), 0o700);
    if (process.platform === "win32") privatePath(path.dirname(configPath));
    await atomicJson(configPath, {
      mcpServers: {
        "iris-remote": { command: nodePath, args: [scriptPath, socketPath],
          ...(asNode ? { env: { ELECTRON_RUN_AS_NODE: "1" } } : {}) },
      },
    });
    unregister = register((kind) => kind === "claude"
      ? ["--mcp-config", configPath, "--dangerously-load-development-channels", "server:iris-remote"]
      : []);
  }

  function stop() {
    unregister?.();
    unregister = null;
  }

  return { configPath, socketPath, start, stop, active: () => !!unregister };
}
