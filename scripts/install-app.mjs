#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { windowsPowerShellEnv } from "../server/windows-powershell.cjs";

const windows = process.platform === "win32";
const script = fileURLToPath(new URL(windows ? "./setup-win.ps1" : "./install-app.sh", import.meta.url));
const result = spawnSync(windows ? "powershell.exe" : "bash", windows
  ? ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "--yes", "--app-only"]
  : [script, ...process.argv.slice(2)], { stdio: "inherit", ...(windows ? { env: windowsPowerShellEnv() } : {}) });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
