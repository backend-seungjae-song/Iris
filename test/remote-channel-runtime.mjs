import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createChannelRuntime } from "../server/remote/channel-runtime.js";

test("채널 설정은 절대 경로를 저장하고 원격 수명 동안 Claude 실행에만 옵션을 붙인다", async (t) => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "iris-channel-runtime-"));
  t.after(() => fsp.rm(stateDir, { recursive: true, force: true }));
  let provider = null;
  let unregistered = 0;
  const runtime = createChannelRuntime({
    stateDir,
    socketPath: path.join(stateDir, "remote", "agent.sock"),
    scriptPath: "/absolute/iris-channel.mjs",
    nodePath: "/absolute/node",
    asNode: false,
    registerLaunchOptions(value) { provider = value; return () => { provider = null; unregistered++; }; },
  });
  await runtime.start();
  const config = JSON.parse(await fsp.readFile(runtime.configPath, "utf8"));
  assert.equal((await fsp.stat(path.dirname(runtime.configPath))).mode & 0o777, 0o700);
  assert.equal((await fsp.stat(runtime.configPath)).mode & 0o777, 0o600);
  assert.deepEqual(config, { mcpServers: { "iris-remote": {
    command: "/absolute/node",
    args: ["/absolute/iris-channel.mjs", path.join(stateDir, "remote", "agent.sock")],
  } } });
  assert.deepEqual(provider("claude"), ["--mcp-config", runtime.configPath,
    "--dangerously-load-development-channels", "server:iris-remote"]);
  assert.deepEqual(provider("codex"), []);
  runtime.stop();
  assert.equal(provider, null);
  assert.equal(unregistered, 1);
});
