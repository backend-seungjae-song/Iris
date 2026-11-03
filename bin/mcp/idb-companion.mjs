// 이전 부팅에 묶였거나 종료된 idb companion 교체. 사용처: MCP 앱 도구(app.mjs)·QA 모바일(server/qa-mobile.js)
//
// companion 은 idb 가 처음 실행될 때 띄우는 상주 프로세스라 시뮬레이터를 껐다 켜도 그대로 남음.
// 남은 companion 은 접근성 조회는 되지만 입력·화면 캡처가 실패함. 기기 부팅(launchd_sim)보다 먼저 뜬
// companion 이면 종료 후 idb connect 로 다시 띄움.
import { execFile } from "node:child_process";
import { idbPath } from "./idb-path.mjs";

// ps etime([[dd-]hh:]mm:ss) → 초
export function etimeSeconds(text) {
  const match = String(text || "").trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return ((Number(days || 0) * 24 + Number(hours || 0)) * 60 + Number(minutes)) * 60 + Number(seconds);
}

// `ps -axo pid=,etime=,command=` 출력에서 그 기기의 companion 과 현재 부팅(launchd_sim)
function companionAndBoot(udid, psText) {
  let companion = null, boot = null;
  for (const line of String(psText || "").split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
    if (!match) continue;
    const [, pid, etime, command] = match;
    const age = etimeSeconds(etime);
    if (age == null) continue;
    if (/(^|\/)idb_companion\s/.test(command) && command.split(/\s+/).some((word, i, words) => words[i - 1] === "--udid" && word === udid)) companion = { pid: Number(pid), age };
    else if (/^launchd_sim\s/.test(command) && command.includes(`/Devices/${udid}/`)) boot = { age };
  }
  return { companion, boot };
}

// 그 기기의 현재 부팅보다 오래된 companion pid. 없으면 null
export function staleCompanionPid(udid, psText) {
  const { companion, boot } = companionAndBoot(udid, psText);
  return companion && boot && companion.age > boot.age ? companion.pid : null;
}

// 켜진 기기에 companion 없음. idb 는 /tmp/idb/state 의 옛 소켓 기록을 믿고 새 companion 을 띄우지 않음
export function missingCompanion(udid, psText) {
  const { companion, boot } = companionAndBoot(udid, psText);
  return Boolean(boot && !companion);
}

const exec = (file, args, timeout) => new Promise((resolve) => {
  execFile(file, args, { encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => resolve({ ok: !error, out: String(stdout || "") }));
});

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// 기기별 마지막 확인 시각. 반응 관찰은 120ms 간격으로 idb 를 부르므로 ps(약 0.1초)는 10초에 한 번
const checkedAt = new Map();
const CHECK_EVERY_MS = 10000;

// 낡거나 없는 companion 을 새로 띄움. 교체했으면 true. 판정·교체 실패는 원래 명령을 막지 않음
export async function refreshIdbCompanion(udid, { ps = () => exec("ps", ["-axo", "pid=,etime=,command="], 5000),
  kill = (pid) => process.kill(pid, "SIGTERM"), connect = () => exec(idbPath() || "idb", ["connect", udid], 30000),
  disconnect = () => exec(idbPath() || "idb", ["disconnect", udid], 10000), wait = (ms) => new Promise((r) => setTimeout(r, ms)), isAlive = alive,
  now = Date.now, checked = checkedAt } = {}) {
  if (now() - (checked.get(udid) ?? -Infinity) < CHECK_EVERY_MS) return false;
  checked.set(udid, now());
  const listed = await ps();
  if (!listed.ok) return false;
  if (missingCompanion(udid, listed.out)) {
    await disconnect();
    return (await connect()).ok;
  }
  const pid = staleCompanionPid(udid, listed.out);
  if (pid == null) return false;
  try { kill(pid); } catch { return false; }
  for (let i = 0; i < 20 && isAlive(pid); i++) await wait(250);
  if (isAlive(pid)) return false;
  return (await connect()).ok;
}
