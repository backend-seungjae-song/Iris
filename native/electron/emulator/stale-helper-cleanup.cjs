const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

function elapsedSeconds(value) {
  const [daysPart, timePart] = value.includes("-") ? value.split("-") : ["0", value];
  const parts = timePart.split(":").map(Number);
  if (!/^\d+$/.test(daysPart) || ![2, 3].includes(parts.length) || parts.some((n) => !Number.isInteger(n) || n < 0)) return null;
  const [hours, minutes, seconds] = parts.length === 3 ? parts : [0, ...parts];
  if (minutes > 59 || seconds > 59) return null;
  return Number(daysPart) * 86400 + hours * 3600 + minutes * 60 + seconds;
}

function priorHelpers(output, { runtimeRoot, deviceUdid, activePid, appUptimeSeconds }) {
  if (!Number.isInteger(activePid) || activePid <= 0 || !deviceUdid || typeof runtimeRoot !== "string" ||
      !path.isAbsolute(runtimeRoot) || !Number.isFinite(appUptimeSeconds)) return [];
  const prefix = runtimeRoot + path.sep;
  const target = `/bin/serve-sim-bin ${deviceUdid} --port `;
  const helpers = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\S+)\s+(\d+(?:\.\d+)?)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const age = elapsedSeconds(match[2]);
    const cpu = Number(match[3]);
    const command = match[4];
    if (pid === activePid || age === null || age <= appUptimeSeconds + 60 || cpu < 50) continue;
    if (!command.startsWith(prefix) || !command.includes(target)) continue;
    helpers.push({ pid, command });
  }
  return helpers;
}

async function processList() {
  const { stdout } = await execFileAsync("ps", ["-ww", "-axo", "pid=,etime=,%cpu=,command="], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

async function hasClients(pid) {
  const { stdout } = await execFileAsync("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP"], { timeout: 5000, maxBuffer: 1024 * 1024 });
  if (!stdout.includes("(LISTEN)")) return true;
  return stdout.includes("(ESTABLISHED)");
}

async function cleanupPriorHelpers({ runtimeRoot, deviceUdid, activePid, appUptimeSeconds }, ops = {}) {
  const list = ops.processList ?? processList;
  const clients = ops.hasClients ?? hasClients;
  const pause = ops.pause ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const terminate = ops.terminate ?? ((pid) => process.kill(pid, "SIGTERM"));
  const options = { runtimeRoot, deviceUdid, activePid, appUptimeSeconds };
  const first = priorHelpers(await list(), options);
  const terminated = [];
  for (const helper of first) {
    if (await clients(helper.pid)) continue;
    await pause(1000);
    const stillPrior = priorHelpers(await list(), options).some((item) => item.pid === helper.pid && item.command === helper.command);
    if (!stillPrior || await clients(helper.pid)) continue;
    terminate(helper.pid);
    terminated.push(helper.pid);
  }
  return terminated;
}

module.exports = { cleanupPriorHelpers, elapsedSeconds, priorHelpers };
