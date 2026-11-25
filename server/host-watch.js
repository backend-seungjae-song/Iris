// 앱 본체가 멈춰도 서버 1분 기록에 남기는 호스트 상태: 앱 본체 프로세스, iOS 화면 도우미(serve-sim), 스왑
// - 2026-11-17 10:58~11:03 앱 본체가 멈춘 동안 앱 쪽 기록이 비었고, 그사이 serve-sim 이 보내지 못한 화면을 쌓아 3.5GB
// - serve-sim 은 받는 쪽이 읽지 않으면 초당 약 17MB 씩 한도 없이 쌓음(평소 25MB 안팎). 상한을 넘으면 종료해 스왑 증가를 끊고,
//   앱 본체의 helper-watchdog 가 같은 기기로 다시 띄움
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const { parseSwap } = createRequire(import.meta.url)("../native/electron/resource-guard.cjs");

export const HELPER_CAP_MB = 1024;

// ps -Ao pid=,rss=,%cpu=,state=,args= → { main, helpers }
export function parseHostPs(text, mainPid) {
  let main = null;
  const helpers = [];
  for (const line of String(text || "").split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const row = { pid: Number(m[1]), rssMB: Math.round(Number(m[2]) / 1024), cpu: Number(m[3]), state: m[4] };
    if (row.pid === mainPid) main = row;
    if (/(^|\/)serve-sim-bin\s/.test(m[5])) {
      helpers.push({ ...row, name: "serve-sim", device: m[5].split(/serve-sim-bin\s+/)[1]?.split(/\s+/)[0] || null });
    }
  }
  return { main, helpers };
}

export function helpersOverCap(helpers, capMB = HELPER_CAP_MB) {
  return helpers.filter((h) => h.rssMB > capMB);
}

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8", timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
}

// 기록 한 번 분량: 호스트 상태와, 상한을 넘은 도우미를 종료한 결과
export function watchHost({ mainPid = process.ppid, exec = run, kill = process.kill, capMB = HELPER_CAP_MB } = {}) {
  const out = {};
  try { Object.assign(out, parseHostPs(exec("/bin/ps", ["-Ao", "pid=,rss=,%cpu=,state=,args="]), mainPid)); }
  catch (e) { out.error = `ps: ${String(e.message || e).slice(0, 80)}`; }
  try { out.swap = parseSwap(exec("/usr/sbin/sysctl", ["-n", "vm.swapusage"])); } catch {}
  const killed = [];
  for (const h of helpersOverCap(out.helpers || [], capMB)) {
    try { kill(h.pid, "SIGTERM"); killed.push({ ...h, result: "terminated" }); }
    catch (e) { killed.push({ ...h, result: `failed: ${String(e.message || e).slice(0, 60)}` }); }
  }
  if (killed.length) out.killedHelpers = killed;
  return out;
}
