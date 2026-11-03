// iOS 화면 도우미(serve-sim)는 기기와 같은 수명. 켜진 기기에 붙은 탭이 있는데 도우미가 없으면 같은 기기로 다시 붙여 새로 띄움.
// 도우미가 끝나면 탭에는 마지막 화면만 남고 사람 터치와 app_tap 이 기기에 닿지 않음(2026-10-20 iPhone 13, 도우미가 로그 없이 끝남).
// 다시 붙기는 탭의 attach 와 같은 경로라, 도우미가 살아 있으면 그대로 쓰고 기기는 끄지 않음(shared-device-guard)
const { execFile } = require("node:child_process");

// 다시 붙일 대상: iOS 세션 중 켜져 있고 도우미가 없는 기기와 그 기기에 붙은 탭(worktree) 하나
function plan({ sessions, worktrees, alive, booted }) {
  const out = [];
  for (const s of sessions) {
    if (s.backend !== "ios" || alive.has(s.deviceUdid) || !booted.has(s.deviceUdid)) continue;
    const worktree = worktrees.find(([, udid]) => udid === s.deviceUdid)?.[0];
    if (worktree) out.push({ udid: s.deviceUdid, worktree });
  }
  return out;
}

// ps 출력에서 도우미가 떠 있는 기기
function aliveFromPs(stdout, udids) {
  const lines = String(stdout || "").split("\n").filter((line) => /(^|\/)serve-sim-bin\s/.test(line));
  return new Set(udids.filter((udid) => lines.some((line) => line.trim().split(/\s+/).includes(udid))));
}

function bootedFromSimctl(stdout) {
  try {
    return new Set(Object.values(JSON.parse(stdout).devices).flat().filter((d) => d.state === "Booted").map((d) => d.udid));
  } catch { return null; }
}

function run(command, args) {
  return new Promise((resolve) => execFile(command, args, { timeout: 10000, maxBuffer: 16 * 1024 * 1024 },
    (error, stdout) => resolve(error ? null : String(stdout))));
}

function createHelperWatchdog({ registry, reattach, exec = run, intervalMs = 3000, retryMs = 10000, log = console }) {
  const lastTry = new Map();
  let timer = null, busy = false;
  async function tick(now = Date.now()) {
    if (busy) return [];
    busy = true;
    try {
      const sessions = registry.listSessions().filter((s) => s.backend === "ios");
      if (!sessions.length) return [];
      const ps = await exec("ps", ["-ww", "-axo", "command="]);
      // 확인하지 못하면 도우미가 있다고 봄. 못 본 것을 없는 것으로 판정해 다시 띄우지 않음
      if (ps == null) return [];
      const alive = aliveFromPs(ps, sessions.map((s) => s.deviceUdid));
      if (sessions.every((s) => alive.has(s.deviceUdid))) return [];
      const booted = bootedFromSimctl(await exec("xcrun", ["simctl", "list", "devices", "booted", "-j"]));
      if (!booted) return [];
      const due = plan({ sessions, worktrees: [...registry.activeByWorktree.entries()], alive, booted })
        .filter(({ udid }) => !lastTry.has(udid) || now - lastTry.get(udid) >= retryMs);
      for (const { udid, worktree } of due) {
        lastTry.set(udid, now);
        log.info(`[emulator] helper for ${udid} is gone while the device is booted; reattaching ${worktree}`);
        try { await reattach(udid, worktree); }
        catch (error) { log.warn(`[emulator] helper reattach failed for ${udid}:`, error && error.message || error); }
      }
      return due;
    } finally { busy = false; }
  }
  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => { tick().catch((error) => log.warn("[emulator] helper check failed:", error && error.message || error)); }, intervalMs);
      timer.unref?.();
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
  };
}

module.exports = { createHelperWatchdog, plan, aliveFromPs, bootedFromSimctl };
