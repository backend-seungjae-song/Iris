import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createChannelRuntime } from "../server/remote/channel-runtime.js";

test("채널 설정은 절대 경로를 저장하고 실행 옵션은 붙이지 않는다", async (t) => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "iris-channel-runtime-"));
  t.after(() => fsp.rm(stateDir, { recursive: true, force: true }));
  const runtime = createChannelRuntime({
    stateDir,
    socketPath: path.join(stateDir, "remote", "agent.sock"),
    scriptPath: "/absolute/iris-channel.mjs",
    nodePath: "/absolute/node",
    asNode: false,
  });
  await runtime.start();
  const config = JSON.parse(await fsp.readFile(runtime.configPath, "utf8"));
  assert.equal((await fsp.stat(path.dirname(runtime.configPath))).mode & 0o777, 0o700);
  assert.equal((await fsp.stat(runtime.configPath)).mode & 0o777, 0o600);
  assert.deepEqual(config, { mcpServers: { "iris-remote": {
    command: "/absolute/node",
    args: ["/absolute/iris-channel.mjs", path.join(stateDir, "remote", "agent.sock")],
  } } });
  const { agentArgv } = await import("../server/agent-launch.js");
  assert.deepEqual(agentArgv("claude"), ["claude"]);
  assert.equal(runtime.active(), true);
  runtime.stop();
  assert.equal(runtime.active(), false);
});
