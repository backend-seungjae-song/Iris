#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

export function devCommand(mode, { env: source = process.env, home = os.homedir(), electronPath, platform = process.platform } = {}) {
  if (!["server", "app", "seed"].includes(mode)) throw new Error(`모르는 개발 실행 항목: ${mode}`);
  const env = { ...source, IRIS_STATE_DIR: path.join(home, ".iris-dev") };
  if (mode !== "seed" || platform === "win32") env.IRIS_PORT = "4291";
  if (mode === "server") env.PORT = "4291";
  if (mode === "app" && platform === "win32") delete env.ELECTRON_RUN_AS_NODE;
  const args = mode === "app" ? ["native/electron/main.cjs"] : mode === "seed" ? ["bin/dev-seed.mjs"] : ["--watch", "server/index.js"];
  const command = mode === "app" ? (electronPath || createRequire(import.meta.url)("electron")) : process.execPath;
  return { command, args, env };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { command, args, env } = devCommand(process.argv[2] || "server");
  const child = spawn(command, [...args, ...process.argv.slice(3)], { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "inherit", env, shell: false });
  child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}
