import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import { isIP } from "node:net";
import os from "node:os";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const TAILSCALE_EXECUTABLES = Object.freeze([
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
]);

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export async function findTailscaleExecutable(options = {}) {
  const access = options.access || fs.access;
  for (const candidate of options.candidates || TAILSCALE_EXECUTABLES) {
    try {
      await access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  throw failure("tailscale-cli-not-found");
}

function localIpv4Addresses(interfaces) {
  const values = new Set();
  for (const entries of Object.values(interfaces || {})) {
    for (const entry of entries || []) {
      if ((entry.family === "IPv4" || entry.family === 4) && isIP(entry.address) === 4) values.add(entry.address);
    }
  }
  return values;
}

export async function resolveTailscaleAddress(options = {}) {
  const executable = options.executable || await (options.findExecutable || findTailscaleExecutable)(options);
  const run = options.execFile || execFile;
  let stdout;
  try {
    ({ stdout } = await run(executable, ["ip", "-4"], { timeout: 2_000, maxBuffer: 16 * 1024 }));
  } catch {
    throw failure("tailscale-address-unavailable");
  }
  const addresses = [...new Set(String(stdout || "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean))];
  if (addresses.length !== 1 || isIP(addresses[0]) !== 4) throw failure("tailscale-address-unavailable");
  const address = addresses[0];
  if (!localIpv4Addresses((options.networkInterfaces || os.networkInterfaces)()).has(address)) {
    throw failure("tailscale-address-mismatch");
  }
  return { address, executable };
}
