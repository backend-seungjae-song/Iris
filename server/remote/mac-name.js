import { execFile as execFileCallback } from "node:child_process";
import { hostname } from "node:os";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const MAX_NAME_LENGTH = 64;

export function cleanMacName(value) {
  const clean = String(value || "").replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  return [...clean].slice(0, MAX_NAME_LENGTH).join("");
}

export async function readMacName(options = {}) {
  const run = options.execFile || execFile;
  try {
    const { stdout } = await run("/usr/sbin/scutil", ["--get", "ComputerName"], {
      encoding: "utf8", timeout: 2_000, maxBuffer: 1_024,
    });
    const name = cleanMacName(stdout);
    if (name) return name;
  } catch {}
  return cleanMacName((options.hostname || hostname)()) || "Mac";
}
