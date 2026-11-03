import { privatePath } from "./windows-private.cjs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import stateHomeModule from "../state-home.cjs";

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
  if (![socketPath, scriptPath, nodePath, configPath].every((value) => typeof value === "string" && path.isAbsolute(value))) {
    throw new TypeError("channel runtime paths must be absolute");
  }
  let started = false;

  // 이 설정 파일을 claude 에 넘기는 것은 ~/.claude/bin/claude-pane. 원격이 꺼지면 채널 서버가 재연결 대기
  async function start() {
    if (started) return;
    await fsp.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
    await fsp.chmod(path.dirname(configPath), 0o700);
    if (process.platform === "win32") privatePath(path.dirname(configPath));
    await atomicJson(configPath, {
      mcpServers: {
        "iris-remote": { command: nodePath, args: [scriptPath, socketPath],
          ...(asNode ? { env: { ELECTRON_RUN_AS_NODE: "1" } } : {}) },
      },
    });
    started = true;
  }

  function stop() {
    started = false;
  }

  return { configPath, socketPath, start, stop, active: () => started };
}
