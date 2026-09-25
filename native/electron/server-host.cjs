// 서버의 수명주기를 앱이 소유한다.
//
// 설계 이유: 이전에는 launchd가 저장소 소스를 읽어 서버를 실행하고, 앱은 이미 떠 있는 서버에
// 붙기만 했다. 그 구조에서 세 가지 문제가 생겼다.
//  (a) 저장소가 없는 사용자는 앱만으로 아무것도 실행할 수 없다. 배포하려면 이 전제를 없애야 한다.
//  (b) 앱을 재시작해도 이전 서버가 그대로 살아 있어 수정이 반영되지 않는다.
//  (c) 서버가 뜨지 못하는 상태에 빠지면 KeepAlive가 그 실패를 무한히 반복한다
// (확인 결과: 재기동 6,957회 동안 관리되는 서버가 한 번도 뜨지 못했다).
// 앱이 자식 프로세스로 관리하면 셋 다 해결된다. 앱과 함께 시작하고, 앱과 함께 종료하며, 재시도는 유한하다.
//
// 이미 떠 있는 서버가 있으면 종료하지 않고 그 서버에 붙는다. 서버는 사용자가 쓰는 도구의 상태(탭·계정·기록)를
// 보유하고, 그 프로세스를 앱 실행을 이유로 교체하면 안 된다. 전환기에는 launchd와
// 앱이 겹쳐 실행될 수 있는데, 그때도 상태를 보유한 쪽이 계속 소유한다.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { childEnv } = require("../../server/env.cjs");
const { createDevSourceWatch } = require("./dev-source-watch.cjs");

const PROBE_TIMEOUT_MS = 700;
const READY_TIMEOUT_MS = 20000;
// launchd의 무한 KeepAlive와 다른 점이다. 짧은 간격으로 반복해서 종료되면 재시도로 해결되지
// 않는 문제이므로, 멈추고 사용자에게 알린다.
const RESTART_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];
const RAPID_WINDOW_MS = 60000;
// 모듈을 읽는 시점이 아니라 감시를 켜는 시점에 정한다. 검사가 짧은 간격으로 실행할 수 있게 한다.
const watchIntervalMs = () => Math.max(500, Number(process.env.IRIS_SERVER_WATCH_MS || 15000));
// 소스 감시가 요청한 재시작에서 이전 자식이 상태 폴더 잠금을 해제하기를 기다리는 시간. 기다리지 않고
// 실행하면 새 자식이 잠금을 얻지 못해 기동에 실패하거나, 얻을 때까지 대기하며 화면이 멈춘다.
const LOCK_RELEASE_TIMEOUT_MS = 5000;
const LOCK_POLL_MS = 50;

// 서버 소스가 있는 곳. 개발(저장소에서 바로 실행)과 설치본(앱 번들 안)이 다르다.
// 번들에서는 asar 안의 파일을 자식 프로세스가 열 수 없으므로 app.asar.unpacked를 쓴다
// (package.json build.asarUnpack이 server/·web/·node-pty를 그리로 뺀다).
function resolveServerRoot(app) {
  const named = (process.env.IRIS_SERVER_ROOT || "").trim();
  if (named) return named;
  if (!app.isPackaged) return path.resolve(__dirname, "..", "..");
  return path.join(process.resourcesPath, "app.asar.unpacked");
}

// 서버를 돌릴 런타임.
//  - 설치본: Electron 자신을 node로 쓴다(ELECTRON_RUN_AS_NODE). 사용자 기기에 node가 없어도
//    실행된다. 네이티브 모듈(node-pty)은 electron-builder가
//    이 Electron의 ABI로 다시 빌드해 넣는다.
//  - 개발: 저장소의 node_modules는 시스템 node ABI로 깔려 있으므로 시스템 node를 쓴다.
//    여기서 Electron을 node로 쓰면 node-pty가 ABI 불일치로 안 열려 터미널이 통째로 죽는다.
function resolveRuntime(app) {
  const named = (process.env.IRIS_SERVER_NODE || "").trim();
  if (named) return { bin: named, asNode: false };
  if (app.isPackaged) return { bin: process.execPath, asNode: true };
  const dirs = (process.env.PATH || "").split(path.delimiter).concat([
    "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin",
    path.join(os.homedir(), ".local", "share", "fnm", "aliases", "default", "bin"),
  ]);
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, "node");
    try { fs.accessSync(candidate, fs.constants.X_OK); return { bin: candidate, asNode: false }; } catch {}
  }
  // 개발 기기에 node가 없는 경우는 사실상 없지만, 없으면 터미널을 잃더라도 화면은 뜨는 편이 낫다.
  return { bin: process.execPath, asNode: true };
}

// 두 경로가 같은 폴더를 가리키는지 판정한다. 문자열 비교로는 부족하다. macOS에서 `/tmp`는
// `/private/tmp`의 symlink이고, 대소문자를 무시하는 볼륨에서는 `/Users/X`와 `/users/x`가
// 같은 곳이다. 다르다고 잘못 판정하면 앱은 자기 서버에 안 붙고, 같다고 잘못 판정하면
// 남의 상태를 자기 것으로 여긴다. 실제 경로를 물어보고, 물어볼 수 없으면(아직 없는 폴더 등)
// 문자열 정규화로 내려간다.
function samePath(a, b) {
  const norm = (v) => {
    const p = path.resolve(String(v || ""));
    try { return fs.realpathSync.native(p); } catch { return p; }
  };
  const na = norm(a), nb = norm(b);
  if (na === nb) return true;
  return na.toLowerCase() === nb.toLowerCase();   // 대소문자 무시 볼륨
}

// /healthz 응답이 그 포트·상태 폴더의 Iris 서버인지. 앱이 붙을 서버를 고를 때와 설치 스크립트가
// 새 앱의 서버가 떴는지 볼 때 같은 기준을 쓴다.
function healthMatches(health, { port, stateDir }) {
  if (!health || health.ok !== true) return false;
  if (Number(health.port) !== Number(port)) return false;
  return samePath(health.stateDir, stateDir);
}

// 그 포트에 이미 서버가 있는가. 없으면(연결 거부) null, 있으면 그쪽이 알려준 것.
function probe(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/healthz", timeout: PROBE_TIMEOUT_MS }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

async function waitUntilUp(port, deadline) {
  while (Date.now() < deadline) {
    const health = await probe(port);
    if (health) return health;
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

class ServerHost {
  constructor({ app, port, stateDir, onLog }) {
    this.app = app;
    this.port = port;
    this.stateDir = stateDir;
    this.onLog = onLog || (() => {});
    this.child = null;
    this.owned = false;      // 이 앱이 실행한 서버인지. 아니면 붙기만 한 서버다
    this.stopping = false;
    this.restarts = [];
    this.logStream = null;
    this.watchTimer = null;
    this.conflict = null;    // 그 자리에 있는 남의 서버(있으면 우리는 띄우지 않는다)
    this.reloading = false;  // 소스 감시가 요청한 의도된 재시작인지. 재시도 예산에서 제외한다
    this.sourceWatch = null; // 개발 환경에서만 실행된다
  }

  log(line) {
    const text = `[server-host] ${line}`;
    console.log(text);
    this.onLog(text);
  }

  openLog() {
    if (this.logStream) return this.logStream;
    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
      this.logStream = fs.createWriteStream(path.join(this.stateDir, "server.log"), { flags: "a" });
    } catch { this.logStream = null; }
    return this.logStream;
  }

  // 그 포트에 있는 것이 이 앱의 서버인지 판정한다. 포트가 같다고 같은 서버는 아니다.
  // 개발 인스턴스, 다른 상태 폴더를 쓰는 Iris, 우연히 /healthz에 JSON 200을 주는 다른 프로그램이
  // 모두 같은 포트에 있을 수 있다. 그 서버에 붙으면 사용자는 자기 탭·북마크가 사라진 화면을 보고
  // 다른 인스턴스의 상태를 수정하게 된다. 상태 폴더가 정체성이므로 그 값으로 구분한다.
  matches(health) {
    return healthMatches(health, { port: this.port, stateDir: this.stateDir });
  }

  // 앱이 켜질 때 한 번. 이미 있으면 붙고, 없으면 띄운다.
  async start() {
    const existing = await probe(this.port);
    if (existing && this.matches(existing)) {
      this.log(`이미 떠 있는 서버에 붙습니다 — pid ${existing.pid}, ${existing.stateDir}`);
      this.watch();
      // 붙기만 한 서버는 이 앱의 것이 아니므로 직접 재시작하지 않는다(reload 가 owned 를 확인한다).
      // 감시는 건다. 그 서버가 내려가면 watch() 가 이 앱의 자식으로 실행하고, 그 뒤부터 소유한다.
      this.watchSource();
      return { attached: true, health: existing };
    }
    if (existing) {
      // 실행하지 않는다. 여기서 자식을 실행하면 그 자식은 상태 폴더 잠금만 점유한 채 포트를
      // 얻지 못하고 재시도를 반복한다. 요청을 처리하지 못하면서 정상 서버의 기동까지 막는다.
      this.conflict = existing;
      this.log(`${this.port}번을 다른 서버가 쓰고 있습니다 — pid ${existing.pid}, 상태 ${existing.stateDir || "?"}.`);
      this.log(`  우리 상태 폴더는 ${this.stateDir} 입니다. 그쪽을 내리거나 IRIS_PORT로 포트를 갈라 주세요.`);
      return { attached: false, health: null, conflict: existing };
    }
    this.spawnOnce();
    const health = await waitUntilUp(this.port, Date.now() + READY_TIMEOUT_MS);
    if (!health || !this.matches(health)) {
      // 기동하지 못한 자식을 그대로 두면 잠금만 점유한 채 남는다. 종료한 뒤 사용자에게 알린다.
      this.log(`서버가 ${READY_TIMEOUT_MS / 1000}초 안에 응답하지 않았습니다 — 그 자식을 내리고 ${path.join(this.stateDir, "server.log")}를 남깁니다.`);
      const dead = this.child;
      this.child = null;
      try { dead && dead.kill("SIGTERM"); } catch {}
      return { attached: false, health: null };
    }
    this.log(`서버를 띄웠습니다 — pid ${health.pid}, ${health.stateDir}`);
    this.watch();
    this.watchSource();
    return { attached: false, health };
  }

  // 서버가 사라졌는지 주기적으로 본다.
  // 자식의 종료는 exit로 알 수 있지만, 붙어 있기만 한 서버의 종료는 통지되지 않는다.
  // 전환기에 launchd 잡을 내리면 그 상황이 발생한다. 화면은 재연결 중 상태로 멈추고,
  // 앱은 직접 실행할 수 있다는 것을 알지 못한 채 대기한다.
  watch() {
    if (this.watchTimer) return;
    this.watchTimer = setInterval(async () => {
      if (this.stopping || this.child || this.probing) return;
      // probe는 최대 700ms 걸린다. 그 사이 다음 tick이 겹쳐 들어오면 둘 다 "없다"를 보고
      // 각자 자식을 띄운다.
      this.probing = true;
      let health = null;
      try { health = await probe(this.port); } finally { this.probing = false; }
      // await 뒤에는 상태가 달라져 있을 수 있다. backoff 재시작이 그 사이에 자식을 실행했거나
      // 앱이 종료 중일 수 있으므로 다시 확인한다.
      if (this.stopping || this.child) return;
      if (health) return;   // 누구의 것이든 그 포트에 서버가 있으면 종료하지 않는다
      if (this.restarts.length >= RESTART_BACKOFF_MS.length) return;  // 재시도 예산을 넘기지 않는다
      this.log("붙어 있던 서버가 사라졌습니다 — 이제 앱이 띄웁니다.");
      this.spawnOnce();
    }, watchIntervalMs());
    if (this.watchTimer.unref) this.watchTimer.unref();
  }

  // 개발 환경에서만 실행한다. 설치본에서 실행하면 사용자가 쓰는 도구가 저장 한 번에 재시작된다.
  // 이 금지 조건은 여기 한 곳에서만 판정한다.
  watchSource() {
    if (this.sourceWatch || this.app.isPackaged) return null;
    if (process.env.IRIS_DEV_WATCH === "0") return null;
    this.sourceWatch = createDevSourceWatch({
      fs, path,
      root: resolveServerRoot(this.app),
      log: (line) => this.log(line),
      reload: (rel) => this.reload(rel),
    });
    this.sourceWatch.start();
    return this.sourceWatch;
  }

  // 의도된 재시작이다. 비정상 종료 후의 재시작과 구분한다. 재시도 예산은 반복 종료를 세는
  // 것이지 수정 횟수를 세는 것이 아니다. 여기서 예산을 쓰면 다섯 번 저장한 뒤로는
  // 서버가 다시 뜨지 않는다.
  async reload(rel) {
    if (this.stopping || this.reloading || !this.owned) return false;
    const child = this.child;
    if (!child) return false;
    this.reloading = true;
    this.log(`server/${rel ? " " + rel : ""} 가 바뀌었습니다 — 서버 자식만 다시 띄웁니다.`);
    try { child.kill("SIGTERM"); } catch {}
    await this.awaitLockRelease();
    this.reloading = false;
    if (this.stopping) return false;
    this.spawnOnce();
    if (this.sourceWatch) this.sourceWatch.noteReloaded();
    return true;
  }

  // 이전 자식의 SIGTERM 핸들러가 잠금을 해제하고 종료할 때까지 기다린다. 무한히 기다리지는
  // 않는다. 해제하지 못하고 종료했으면 새 자식이 그 잠금을 만료된 것으로 보고 인수한다.
  async awaitLockRelease() {
    const lock = path.join(this.stateDir, "server.lock");
    const deadline = Date.now() + LOCK_RELEASE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.child) { await new Promise((r) => setTimeout(r, LOCK_POLL_MS)); continue; }
      if (!fs.existsSync(lock)) return true;
      await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
    }
    return false;
  }

  spawnOnce() {
    // 이미 자식이 있으면 다시 실행하지 않는다. 감시 tick과 backoff 재시작이 겹치면 자식이 둘이
    // 되고, this.child는 하나만 가리키므로 나머지 하나가 추적에서 빠진다. 앱을 종료해도 남는
    // 서버 프로세스가 그렇게 생긴다.
    if (this.child || this.stopping) return;
    const root = resolveServerRoot(this.app);
    const runtime = resolveRuntime(this.app);
    const entry = path.join(root, "server", "index.js");
    if (!fs.existsSync(entry)) {
      this.log(`서버 소스를 찾지 못했습니다: ${entry}`);
      return;
    }
    const env = { ...process.env, ...childEnv({ port: this.port, stateDir: this.stateDir }) };
    // 서버가 자신을 설정하는 변수다. 앱이 물려받은 옛 값이 새 계약을 덮지 않게 지운다.
    delete env.PORT;
    if (runtime.asNode) env.ELECTRON_RUN_AS_NODE = "1";
    else delete env.ELECTRON_RUN_AS_NODE;

    const child = spawn(runtime.bin, [entry], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    this.owned = true;
    const out = this.openLog();
    if (out) { child.stdout.pipe(out, { end: false }); child.stderr.pipe(out, { end: false }); }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => process.stdout.write(d));
    child.stderr.on("data", (d) => process.stderr.write(d));
    // spawn이 ENOENT 등으로 실패하면 error만 오고 exit는 오지 않는 경우가 있다. 그때 아무것도
    // 기록하지 않으면 재시도 예산이 동작하지 않아, 앱이 서버 없이 대기 상태로 남는다.
    child.on("error", (e) => {
      this.log(`서버를 띄우지 못했습니다: ${e && e.message}`);
      if (this.child === child) this.onChildExit(null, "spawn-error");
    });
    child.on("exit", (code, signal) => this.onChildExit(code, signal));
    this.log(`${runtime.asNode ? "Electron(node 모드)" : runtime.bin}로 ${entry} 기동 — 포트 ${this.port}`);
  }

  onChildExit(code, signal) {
    this.child = null;
    if (this.stopping || !this.owned) return;
    // 이 앱이 요청해서 종료된 경우다. reload() 가 잠금 해제를 기다린 뒤 직접 다시 실행한다.
    // 여기서 backoff 로 또 실행하면 자식이 둘이 되고 재시도 예산도 줄어든다.
    if (this.reloading) return;
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < RAPID_WINDOW_MS);
    if (this.restarts.length >= RESTART_BACKOFF_MS.length) {
      this.owned = false;
      this.log(`서버가 ${RAPID_WINDOW_MS / 1000}초 안에 ${this.restarts.length}번 죽었습니다 — 다시 띄우지 않습니다. ${path.join(this.stateDir, "server.log")}를 보세요.`);
      return;
    }
    const delay = RESTART_BACKOFF_MS[this.restarts.length];
    this.restarts.push(now);
    this.log(`서버가 내려갔습니다(code ${code}, signal ${signal || "-"}) — ${delay / 1000}초 뒤 다시 띄웁니다.`);
    // unref 로 이 대기가 프로세스를 유지하지 않게 한다. 앱은 자체 수명으로 살아 있고,
    // 앱이 없는 환경(테스트)에서는 이 타이머만 남아 종료되지 않는 일이 없어야 한다.
    setTimeout(() => { if (!this.stopping) this.spawnOnce(); }, delay).unref?.();
  }

  // 앱 종료 시. 이 앱이 실행한 서버만 종료한다. 붙기만 한 서버는 다른 소유자의 것이다.
  stop() {
    this.stopping = true;
    if (this.watchTimer) { clearInterval(this.watchTimer); this.watchTimer = null; }
    if (this.sourceWatch) { this.sourceWatch.stop(); this.sourceWatch = null; }
    const child = this.child;
    this.child = null;
    if (!child || !this.owned) return;
    // 먼저 SIGTERM 을 보낸다. 서버의 핸들러가 잠금을 해제하고 종료한다.
    try { child.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 3000).unref?.();
  }
}

module.exports = { ServerHost, probe, healthMatches, resolveServerRoot, resolveRuntime };
