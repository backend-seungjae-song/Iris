// 에뮬레이터 기기별 음량. 기기 소리를 내는 Mac 프로세스를 찾아 audio-tap 도우미(Swift)에 넘김
//
// 소리 경로
//   iOS 시뮬레이터: 기기 안 앱 프로세스가 Mac 출력으로 직접 재생 → 그 기기 launchd_sim 의 자손 전부
//   Android 에뮬레이터: 에뮬레이터(qemu) 프로세스가 직접 재생 → 콘솔 포트(emulator-NNNN 의 NNNN)를 연 프로세스
//
// 유지 조건
//   100%·음소거 아님이면 도우미를 띄우지 않음(권한 창·컴파일·지연 없이 원래 출력 그대로)
//   프로세스 번호는 렌더러가 아니라 여기서만 해석(렌더러는 기기 id 만 전달)
//   저장 파일은 상태 폴더(ctx.stateDir)의 emulator-volumes.json, 도우미 바이너리도 상태 폴더 캐시
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");

const STORE_FILE = "emulator-volumes.json";
const SOURCE = path.join(__dirname, "audio-tap.swift");
const RESEND_MS = 2000; // 기기 부팅·앱 실행으로 프로세스가 바뀌는 주기 추적
const ID_RE = /^[\w.:-]{1,128}$/;
const PASSTHROUGH = Object.freeze({ volume: 1, muted: false });

function normalizeLevel(raw) {
  const v = Number(raw && raw.volume);
  return { volume: Number.isFinite(v) ? Math.round(Math.min(1, Math.max(0, v)) * 100) / 100 : 1, muted: !!(raw && raw.muted) };
}
function isPassthrough(level) { return level.volume >= 1 && !level.muted; }

function parseProcessTable(text) {
  const rows = [];
  for (const line of String(text).split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] });
  }
  return rows;
}

// 그 기기 launchd_sim 과 자손 전부. 명령줄에 기기 폴더가 들어간 프로세스도 포함(부모가 바뀐 경우 대비)
function iosPids(rows, udid) {
  const marker = `/CoreSimulator/Devices/${udid}/`;
  const children = new Map();
  for (const r of rows) {
    if (!children.has(r.ppid)) children.set(r.ppid, []);
    children.get(r.ppid).push(r.pid);
  }
  const out = new Set();
  const queue = rows.filter((r) => r.command.includes(marker) && /launchd_sim/.test(r.command)).map((r) => r.pid);
  while (queue.length) {
    const pid = queue.shift();
    if (out.has(pid)) continue;
    out.add(pid);
    for (const c of children.get(pid) || []) queue.push(c);
  }
  for (const r of rows) if (r.command.includes(marker)) out.add(r.pid);
  return [...out].sort((a, b) => a - b);
}

function androidConsolePort(device) {
  const m = /^emulator-(\d{2,5})$/.exec(String(device));
  return m ? Number(m[1]) : null;
}

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err && !stdout ? "" : String(stdout)));
  });
}

async function resolvePids(device) {
  const port = androidConsolePort(device);
  if (port) {
    const out = await run("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
    return [...new Set(out.split(/\s+/).filter(Boolean).map(Number).filter(Number.isInteger))].sort((a, b) => a - b);
  }
  return iosPids(parseProcessTable(await run("/bin/ps", ["-axo", "pid=,ppid=,command="])), device);
}

// 소스 해시로 캐시. 설치 앱은 소스가 asar 안이라 swiftc 가 못 읽음 → 상태 폴더에 복사 후 컴파일
function helperBuilder(cacheDir, deps = {}) {
  const exec = deps.execFile || execFile;
  let pending = null;
  return () => {
    if (pending) return pending;
    pending = (async () => {
      const source = fs.readFileSync(SOURCE, "utf8");
      const hash = crypto.createHash("sha256").update(source).digest("hex").slice(0, 16);
      const bin = path.join(cacheDir, `audio-tap-${hash}`);
      if (fs.existsSync(bin)) return bin;
      fs.mkdirSync(cacheDir, { recursive: true });
      const src = bin + ".swift";
      const tmp = bin + ".tmp";
      fs.writeFileSync(src, source);
      await new Promise((resolve, reject) => {
        exec("/usr/bin/xcrun", ["swiftc", "-O", "-o", tmp, src], { timeout: 180000 }, (err, _out, stderr) => {
          if (err) reject(new Error("음량 도우미를 만들지 못했습니다(Xcode 명령줄 도구 필요): " + String(stderr || err.message).trim().slice(0, 300)));
          else resolve();
        });
      });
      fs.renameSync(tmp, bin);
      return bin;
    })();
    pending.catch(() => { pending = null; });
    return pending;
  };
}

function createVolumeController({ stateDir, deps = {} }) {
  const storePath = path.join(stateDir, STORE_FILE);
  const buildHelper = deps.buildHelper || helperBuilder(path.join(stateDir, "audio-tap"));
  const findPids = deps.resolvePids || resolvePids;
  const spawnHelper = deps.spawn || ((bin) => spawn(bin, [], { stdio: ["pipe", "pipe", "ignore"] }));
  const devices = new Map(); // 기기 id → { key, level, helper, timer, waiters, error }

  function readStore() {
    try {
      const raw = JSON.parse(fs.readFileSync(storePath, "utf8"));
      return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    } catch { return {}; }
  }
  function writeStore(store) {
    fs.mkdirSync(stateDir, { recursive: true });
    const tmp = storePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, storePath);
  }
  function stored(key) {
    const store = readStore();
    return Object.prototype.hasOwnProperty.call(store, key) ? normalizeLevel(store[key]) : { ...PASSTHROUGH };
  }

  function stopHelper(entry) {
    clearInterval(entry.timer);
    entry.timer = null;
    const h = entry.helper;
    entry.helper = null;
    for (const w of entry.waiters.splice(0)) w({ ok: true });
    if (h) { try { h.stdin.end(); } catch {} setTimeout(() => { try { h.kill(); } catch {} }, 1000).unref?.(); }
  }

  async function send(device, entry) {
    const pids = await findPids(device);
    const h = entry.helper;
    if (!h || entry !== devices.get(device)) return { ok: true };
    return new Promise((resolve) => {
      entry.waiters.push(resolve);
      try { h.stdin.write(JSON.stringify({ pids, volume: entry.level.volume, muted: entry.level.muted }) + "\n"); }
      catch (err) { entry.waiters.pop(); resolve({ ok: false, error: String(err && err.message || err) }); }
    });
  }

  async function startHelper(device, entry) {
    const bin = await buildHelper();
    if (entry.helper || isPassthrough(entry.level) || entry !== devices.get(device)) return;
    const h = spawnHelper(bin);
    entry.helper = h;
    let buf = "";
    h.stdout.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let msg; try { msg = JSON.parse(line); } catch { msg = { ok: false, error: "도우미 응답 오류" }; }
        entry.error = msg.ok ? null : String(msg.error || "음량 적용 실패");
        const w = entry.waiters.shift();
        if (w) w(msg);
      }
    });
    h.on("exit", () => {
      if (entry.helper !== h) return;
      entry.helper = null;
      entry.error = "음량 도우미가 종료되었습니다";
      clearInterval(entry.timer); entry.timer = null;
      for (const w of entry.waiters.splice(0)) w({ ok: false, error: entry.error });
    });
    h.on("error", () => {});
    entry.timer = setInterval(() => { void send(device, entry); }, RESEND_MS);
    entry.timer.unref?.();
  }

  async function apply(device) {
    const entry = devices.get(device);
    if (isPassthrough(entry.level)) { stopHelper(entry); return { ok: true }; }
    try { if (!entry.helper) await startHelper(device, entry); }
    catch (err) { return { ok: false, error: String(err && err.message || err) }; }
    const r = await send(device, entry);
    return r && r.ok === false ? { ok: false, error: r.error || "음량 적용 실패" } : { ok: true };
  }

  function entryFor(device, key) {
    let entry = devices.get(device);
    if (!entry || entry.key !== key) {
      if (entry) stopHelper(entry);
      entry = { key, level: stored(key), helper: null, timer: null, waiters: [], error: null };
      devices.set(device, entry);
    }
    return entry;
  }

  function check(device, key) {
    return typeof device === "string" && typeof key === "string" && ID_RE.test(device) && ID_RE.test(key);
  }

  // 화면이 기기를 보여 줄 때: 저장값을 돌려주고 그 기기에 적용
  async function use({ device, key } = {}) {
    if (!check(device, key)) return { ok: false, error: "기기 값이 올바르지 않습니다" };
    const entry = entryFor(device, key);
    const r = await apply(device);
    return { ...r, ...entry.level };
  }

  async function set({ device, key, volume, muted } = {}) {
    if (!check(device, key)) return { ok: false, error: "기기 값이 올바르지 않습니다" };
    const level = normalizeLevel({ volume, muted });
    const store = readStore();
    if (isPassthrough(level)) delete store[key]; else store[key] = level;
    try { writeStore(store); } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
    const entry = entryFor(device, key);
    entry.level = level;
    const r = await apply(device);
    return { ...r, ...level };
  }

  function stopAll() { for (const entry of devices.values()) stopHelper(entry); devices.clear(); }

  return { use, set, stopAll };
}

module.exports = { createVolumeController, iosPids, parseProcessTable, androidConsolePort, normalizeLevel, isPassthrough, helperBuilder };
