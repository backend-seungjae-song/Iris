// 기기 메모리·배터리 감시
//
// 1분마다 메모리 압력·스왑·프로세스별 메모리(footprint)·에너지·배터리를 diagnostics/resource.jsonl 에 기록
// 18GB 기기에서 프로세스 메모리 합 34.5GB·스왑 13GB, 배터리 2% 가 겹쳐 10분간 멈춘 사례(2026-10-19)
// 경고: 많이 쓰는 묶음과 이유를 알림. 심각: Iris 의 쉬는 탭을 바로 재움. 다른 프로세스는 알리기만 함
// 개발 서버가 상한(3GB)을 넘으면 그 프로세스를 이름으로 알림. next dev 하나가 3.9GB 까지 커진 사례
//
// 판정은 순수 함수(parse*, decideResourceAction), 읽기·기록·알림은 createResourceGuard 안에서만

const path = require("node:path");

const SAMPLE_INTERVAL_MS = 60000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const NOTICE_GAP_MS = 15 * 60000;

const POLICY = {
  devServerCapMB: 3072,
  warnSwapRatio: 0.5,
  criticalSwapRatio: 0.8,
  // 기기 메모리 대비 프로세스 메모리 합. 이 배수를 넘으면 스왑·압축으로 버티는 중
  warnFootprintRatio: 1.4,
  criticalFootprintRatio: 1.8,
  warnBatteryPct: 20,
  // 5% 아래에서 시스템이 성능을 크게 제한함(사용자 관찰)
  criticalBatteryPct: 8,
  warnDrainPctPerHour: 25,
};

const DEV_SERVER = [
  /next-server \(v/, /\/next\/dist\/bin\/next (dev|start)\b/, /\bnext dev\b/,
  /\/vite\/bin\/vite\.js\b/, /webpack-dev-server/, /\bwebpack (serve|--watch)\b/,
  /react-scripts\/scripts\/start/, /\bnuxi? dev\b/, /\bastro dev\b/, /\bstorybook dev\b/,
];

const GROUPS = [
  ["Iris.app", "Iris"], ["CoreSimulator", "시뮬레이터"], ["Simulator.app", "시뮬레이터"], ["/Runner.app/", "시뮬레이터"],
  ["Virtualization.VirtualMachine", "가상 머신(도커 등)"], ["next-server", "next dev"], ["/next/dist/bin/next", "next dev"],
  ["flutter", "flutter"], ["dart-sdk", "flutter"], ["/.local/bin/claude", "claude"], ["/claude/versions/", "claude"],
  ["codex", "codex"], ["Slack", "Slack"], ["KakaoTalk", "카카오톡"], ["ChatGPT", "ChatGPT"],
  ["Google Chrome", "Chrome"], ["WindowServer", "WindowServer"],
];

function isDevServer(args) { return DEV_SERVER.some((re) => re.test(String(args || ""))); }

function groupOf(args) {
  const text = String(args || "");
  for (const [needle, name] of GROUPS) if (text.includes(needle)) return name;
  return path.basename(text.split(/\s+/)[0] || "") || "기타";
}

// "3944M", "1583M+", "12K", "1.2G" → MB
function sizeMB(text) {
  const m = /^(\d+(?:\.\d+)?)([BKMG])/.exec(String(text || "").trim());
  if (!m) return 0;
  return Number(m[1]) * { B: 1 / 1048576, K: 1 / 1024, M: 1, G: 1024 }[m[2]];
}

// top -l 2 -o mem -stats pid,mem,power 출력 → [{pid, mb, power}]. 에너지는 두 번째 표본부터 값이 있어 마지막 표만 읽음
function parseTop(text) {
  const rows = [];
  const blocks = String(text || "").split(/^\s*PID\s+MEM\s+POWER\s*$/m);
  for (const line of blocks[blocks.length - 1].split("\n")) {
    const m = /^\s*(\d+)\s+(\d+(?:\.\d+)?[BKMG]\S*)\s+(\d+(?:\.\d+)?)\s*$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), mb: Math.round(sizeMB(m[2])), power: Number(m[3]) });
  }
  return rows;
}

// ps -Ao pid=,args= → Map(pid → args)
function parsePs(text) {
  const out = new Map();
  for (const line of String(text || "").split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m) out.set(Number(m[1]), m[2]);
  }
  return out;
}

// vm.swapusage: total = 14336.00M  used = 13104.81M  free = 1231.19M
function parseSwap(text) {
  const total = /total = ([\d.]+)M/.exec(text || ""), used = /used = ([\d.]+)M/.exec(text || "");
  return { totalMB: total ? Math.round(Number(total[1])) : 0, usedMB: used ? Math.round(Number(used[1])) : 0 };
}

// pmset -g batt: Now drawing from 'Battery Power' / -InternalBattery-0 (id=…)	9%; discharging; …
function parseBattery(text) {
  const pct = /(\d+)%;/.exec(text || "");
  if (!pct) return null;
  return { pct: Number(pct[1]), onBattery: /Battery Power/.test(text) };
}

// 배터리로 도는 마지막 구간의 시간당 감소율. 구간이 10분 이상일 때만
function drainPerHour(history, now) {
  const run = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (!h.battery || !h.battery.onBattery || now - h.t > 3600000) break;
    run.unshift(h);
  }
  if (run.length < 2) return null;
  const first = run[0], last = run[run.length - 1], hours = (last.t - first.t) / 3600000;
  if (hours < 1 / 6) return null;
  return Math.round(((first.battery.pct - last.battery.pct) / hours) * 10) / 10;
}

// 한 번의 기록으로 단계와 이유를 정함
function decideResourceAction({ memMB, swap, pressure, battery, drain, processes }, policy = POLICY) {
  const footprintMB = processes.reduce((sum, p) => sum + p.mb, 0);
  const swapRatio = swap.totalMB ? swap.usedMB / swap.totalMB : 0;
  const reasons = [];
  let level = "normal";
  const raise = (to, why) => { reasons.push(why); if (to === "critical" || level === "normal") level = to; };
  if (pressure >= 4) raise("critical", "메모리 압력 심각");
  else if (pressure >= 2) raise("warn", "메모리 압력 경고");
  if (swapRatio >= policy.criticalSwapRatio) raise("critical", `스왑 ${swap.usedMB}MB/${swap.totalMB}MB`);
  else if (swapRatio >= policy.warnSwapRatio) raise("warn", `스왑 ${swap.usedMB}MB/${swap.totalMB}MB`);
  if (memMB && footprintMB >= memMB * policy.criticalFootprintRatio) raise("critical", `프로세스 메모리 합 ${(footprintMB / 1024).toFixed(1)}GB`);
  else if (memMB && footprintMB >= memMB * policy.warnFootprintRatio) raise("warn", `프로세스 메모리 합 ${(footprintMB / 1024).toFixed(1)}GB`);
  if (battery && battery.onBattery) {
    if (battery.pct <= policy.criticalBatteryPct) raise("critical", `배터리 ${battery.pct}%`);
    else if (battery.pct <= policy.warnBatteryPct) raise("warn", `배터리 ${battery.pct}%`);
    if (drain != null && drain >= policy.warnDrainPctPerHour) raise("warn", `배터리 시간당 ${drain}% 감소`);
  }
  const overCap = processes.filter((p) => p.dev && p.mb >= policy.devServerCapMB).sort((a, b) => b.mb - a.mb);
  if (overCap.length) raise("warn", `상한 넘은 개발 서버 ${overCap.map((p) => `${p.pid} ${(p.mb / 1024).toFixed(1)}GB`).join(", ")}`);
  return { level, reasons, footprintMB, discardTabs: level === "critical", overCap };
}

// 많이 쓰는 묶음 n개: "Iris 7.4GB", "Iris 85"
function topGroups(processes, key, n = 5) {
  const sums = new Map();
  for (const p of processes) sums.set(p.group, (sums.get(p.group) || 0) + p[key]);
  return [...sums].sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([name, v]) => key === "mb" ? `${name} ${(v / 1024).toFixed(1)}GB` : `${name} ${Math.round(v)}`);
}

function createResourceGuard({
  dir,
  notify,
  discardTabs,
  fs = require("node:fs"),
  exec = (cmd, args, cb) => require("node:child_process").execFile(cmd, args, { timeout: 20000, maxBuffer: 8 * 1024 * 1024 }, (e, out) => cb(e ? "" : String(out))),
  memMB = Math.round(require("node:os").totalmem() / 1048576),
  platform = process.platform,
  setIntervalFn = setInterval,
  setTimeoutFn = setTimeout,
  now = () => Date.now(),
}) {
  const file = path.join(dir, "resource.jsonl");
  const history = [];
  let timer = null, busy = false, lastNotice = -Infinity;

  const run = (cmd, args) => new Promise((resolve) => exec(cmd, args, resolve));

  function write(row) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      try { if (fs.statSync(file).size > MAX_FILE_BYTES) fs.renameSync(file, file + ".1"); } catch {}
      fs.appendFileSync(file, JSON.stringify(row) + "\n");
    } catch {}
  }

  async function sample() {
    if (busy || platform !== "darwin") return null;
    busy = true;
    try {
      const [top, ps, swapText, pressureText, batt] = await Promise.all([
        run("/usr/bin/top", ["-l", "2", "-s", "1", "-o", "mem", "-n", "80", "-stats", "pid,mem,power"]),
        run("/bin/ps", ["-Ao", "pid=,args="]),
        run("/usr/sbin/sysctl", ["-n", "vm.swapusage"]),
        run("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]),
        run("/usr/bin/pmset", ["-g", "batt"]),
      ]);
      const args = parsePs(ps);
      const processes = parseTop(top).map((r) => {
        const a = args.get(r.pid) || "";
        return { ...r, group: groupOf(a), dev: isDevServer(a) };
      });
      const t = now(), battery = parseBattery(batt);
      history.push({ t, battery });
      while (history.length > 120) history.shift();
      const input = { memMB, swap: parseSwap(swapText), pressure: Number(pressureText) || 0, battery, drain: drainPerHour(history, t), processes };
      const action = decideResourceAction(input);
      if (action.discardTabs) { try { discardTabs(); } catch {} }
      const byMemory = topGroups(processes, "mb"), byEnergy = topGroups(processes, "power");
      write({ at: new Date(t).toISOString(), level: action.level, reasons: action.reasons, memMB, footprintMB: action.footprintMB,
        swap: input.swap, pressure: input.pressure, battery, drainPerHour: input.drain, byMemory, byEnergy,
        top: processes.slice(0, 12).map((p) => ({ pid: p.pid, mb: p.mb, power: p.power, group: p.group, dev: p.dev })) });
      if (action.level !== "normal" && t - lastNotice >= NOTICE_GAP_MS) {
        lastNotice = t;
        try { notify({ title: action.level === "critical" ? "메모리·배터리 심각" : "메모리·배터리 경고",
          body: `${action.reasons.join(" · ")}\n메모리: ${byMemory.join(" · ")}\n에너지: ${byEnergy.slice(0, 3).join(" · ")}` }); } catch {}
      }
      return { ...action, byMemory, byEnergy };
    } catch { return null; } finally { busy = false; }
  }

  return {
    start() { if (!timer) { timer = setIntervalFn(sample, SAMPLE_INTERVAL_MS); setTimeoutFn(sample, 20000); } },
    sample,
  };
}

module.exports = { createResourceGuard, decideResourceAction, parseTop, parsePs, parseSwap, parseBattery, drainPerHour, isDevServer, groupOf, topGroups, POLICY };
