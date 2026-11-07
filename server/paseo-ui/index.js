// Paseo 대화 화면(UI 코드만) 빌드 관리. Paseo 데몬은 실행하지 않음
//
// 소유 범위
//   stateHome()/paseo-ui 아래 빌드 결과·상태 파일, 빌드 프로세스, GET /paseo-ui/* 정적 제공
//
// 제공 API
//   initPaseoUi(ctx) · requestPaseoUi() · paseoUiStatus() · reportPaseoUiBroken(build) · stopPaseoUi() ·
//   handlePaseoUiStatic(req, res)
//
// 의존 대상
//   plan.js(계산), state-home.cjs, http-handler.js 의 isLoopbackRequest, git·npm(빌드할 때만)
//
// 유지 조건
//   대화 보기를 처음 열 때까지 아무것도 받거나 빌드하지 않음. 그 뒤 6시간마다 새 태그 확인(unref)
//   마지막 확인 시각을 저장. 재시작해도 6시간이 지났으면 곧 확인
//   빌드는 Paseo 태그 소스에 Iris 진입 파일(entry/)만 넣어 expo export. Paseo 소스는 고치지 않음
//   빌드 이름 = Paseo 버전 + Iris 재료 해시(RECIPE). Iris 쪽 진입 파일만 바뀌어도 다시 빌드
//   빌드가 실패하면 이전 빌드를 그대로 씀. 새 빌드가 화면에서 깨지면(창이 알림) 바로 앞 빌드로 되돌림
//   빌드 소스(node_modules 약 1.8GB)는 끝나면 지움. Iris 가 끝나면 빌드 프로세스 그룹을 SIGKILL
//   빌드 단계는 새 태그의 코드를 실행함. 환경 변수는 허용 목록만 넘겨 토큰·키가 닿지 않게 함
//
// 영향 범위
//   server/agent-chat.js 가 상태를 창에 알리고, web/js/agentchat/boot.js 가 /paseo-ui/ 를 iframe 으로 띄움
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isLoopbackRequest } from "../http-handler.js";
import { buildName, checkDue, compareVersions, latestStableTag, nextBuild, parseBuildName, parseState, parseVersion, promote,
  recordFailure, rollback, staticTarget, CHECK_EVERY_MS, MAX_TRIES } from "./plan.js";

const require = createRequire(import.meta.url);
const { stateHome } = require("../state-home.cjs");

const REPO = "https://github.com/getpaseo/paseo";
const ENTRY = fileURLToPath(new URL("./entry/iris-chat-entry.tsx", import.meta.url));
const METRO_CONFIG = fileURLToPath(new URL("./entry/metro.config.cjs", import.meta.url));
const STEP_TIMEOUT_MS = 20 * 60 * 1000;
const KILL_GRACE_MS = 10 * 1000;
const MIN_FREE_BYTES = 3 * 1024 ** 3;
// 앱이 쓰는 워크스페이스만 설치. 데스크톱·웹사이트·서버 의존성은 받지 않음
const WORKSPACES = ["packages/app", "packages/client", "packages/protocol", "packages/highlight", "packages/plugin", "packages/expo-two-way-audio"];
const BUILD_SCRIPTS = ["build:highlight", "build:client", "build:plugin"];
const STATIC_TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".ttf": "font/ttf",
  ".woff": "font/woff", ".woff2": "font/woff2", ".wasm": "application/wasm", ".map": "application/json" };

// Iris 쪽 빌드 재료. 이 값이 바뀌면 같은 Paseo 버전도 다시 빌드
// - entry 폴더에서 빌드에 복사하는 파일 전부(entryFiles) + Metro 설정 + 빌드 절차
const RECIPE = (() => {
  const h = createHash("sha256");
  for (const name of entryFiles()) h.update(name).update("\0").update(fs.readFileSync(path.join(path.dirname(ENTRY), name))).update("\0");
  h.update(fs.readFileSync(METRO_CONFIG)).update("\0");
  h.update(JSON.stringify({ WORKSPACES, BUILD_SCRIPTS, prepare: String(prepareApp) }));
  return h.digest("hex").slice(0, 12);
})();

let paths = null;
let notify = () => {};
let status = { phase: "none", build: null, message: "" };   // build: { version, recipe }
let building = null;        // 진행 중인 빌드 Promise
const children = new Set(); // 진행 중인 하위 프로세스(빌드 단계·태그 조회)
let timer = null;
let stopped = false;

export function initPaseoUi(ctx = {}) {
  const root = path.join(stateHome(), "paseo-ui");
  paths = { root, builds: path.join(root, "builds"), state: path.join(root, "current.json"), log: path.join(root, "build.log") };
  notify = typeof ctx.onStatus === "function" ? ctx.onStatus : () => {};
  removeLeftovers();
  const state = readState();
  if (state.current && fs.existsSync(buildDir(state.current))) {
    status = { phase: "ready", build: state.current, message: "" };
    startTimer();
    if (needsCheck(state)) setTimeout(() => check(), 60 * 1000).unref?.();
  }
}

export function paseoUiStatus() {
  const name = status.build ? buildName(status.build.version, status.build.recipe) : null;
  return { phase: status.phase, version: status.build?.version || null, build: name, update: status.update || null,
    message: status.message || "", url: status.phase === "ready" && name ? `/paseo-ui/?b=${name}` : null };
}

// 대화 보기를 열 때 부름. 빌드가 없으면 첫 빌드(실패 뒤 기다리는 시간 무시), 있으면 확인 기한만 봄
export function requestPaseoUi() {
  if (!paths || stopped) return;
  startTimer();
  if (status.phase !== "ready") check({ force: true });
  else if (needsCheck(readState())) check();
}

// 확인 기한이 지났거나 Iris 쪽 재료가 바뀜(Iris 업데이트 직후)
function needsCheck(state) {
  return checkDue(state, Date.now()) || (!!state.current && state.current.recipe !== RECIPE);
}

// 창이 새 빌드 화면을 띄우지 못했다고 알림. 지금 빌드가 그 빌드이고 되돌아갈 빌드가 있으면 되돌림
export function reportPaseoUiBroken(name, reason = "") {
  if (!paths || status.phase !== "ready" || !status.build) return;
  if (buildName(status.build.version, status.build.recipe) !== name) return;
  const state = readState();
  const back = rollback(state, Date.now());
  log(`화면 실패 보고(${name}): ${String(reason).slice(0, 300)}`);
  if (!back || !fs.existsSync(buildDir(back.current))) return;
  writeState(back);
  log(`이전 빌드로 되돌림: ${buildName(back.current.version, back.current.recipe)}`);
  setStatus({ phase: "ready", build: back.current, update: null, message: `Paseo ${status.build.version} 화면이 열리지 않아 이전 화면으로 되돌렸습니다` });
}

export function stopPaseoUi() {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = null;
  // 서버가 곧 끝나므로 기다리지 않고 그룹째 끝냄. 빌드는 다음에 처음부터 다시 함
  for (const proc of children) killGroup(proc.pid, "SIGKILL");
  children.clear();
}

export function handlePaseoUiStatic(req, res) {
  if (!isLoopbackRequest(req)) { res.writeHead(403).end(); return true; }
  const cur = status.phase === "ready" ? status.build : readState().current;
  if (!cur) { res.writeHead(404).end("Paseo 화면이 아직 준비되지 않았습니다"); return true; }
  const rel = staticTarget(new URL(req.url, "http://x").pathname);
  if (!rel) { res.writeHead(400).end(); return true; }
  const dir = buildDir(cur);
  const file = path.join(dir, rel);
  if (!file.startsWith(dir + path.sep)) { res.writeHead(403).end(); return true; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end("not found"); return; }
    // 해시가 붙은 번들은 버전별 폴더라 오래 둬도 됨. index.html 은 버전이 바뀌면 다시 읽어야 함
    const cache = rel === "index.html" ? "no-store" : "public, max-age=31536000, immutable";
    res.writeHead(200, { "content-type": STATIC_TYPES[path.extname(file)] || "application/octet-stream", "cache-control": cache });
    res.end(data);
  });
  return true;
}

function startTimer() {
  if (timer || stopped) return;
  timer = setInterval(() => check(), CHECK_EVERY_MS);
  timer.unref?.();
}

function setStatus(next) {
  status = { ...status, ...next };
  notify(paseoUiStatus());
}

function check(opts = {}) {
  if (building || stopped) return building;
  building = (async () => {
    try {
      const tags = await capture(findGit(), ["ls-remote", "--tags", REPO]);
      const latest = latestStableTag(tags);
      if (!latest) throw new Error("Paseo 릴리스 태그를 찾지 못했습니다");
      let state = readState();
      state = { ...state, checkedAt: Date.now() };
      writeState(state);
      const want = nextBuild(state, latest, RECIPE, Date.now(), opts);
      if (!want) {
        const f = state.failed.find((x) => x.version === latest && x.recipe === RECIPE);
        if (status.phase !== "ready" && f) {
          setStatus({ phase: "error", message: f.count >= MAX_TRIES
            ? `Paseo ${latest} 화면 빌드가 ${f.count}번 실패해 다음 Paseo 버전까지 멈췄습니다. 빌드 기록: ${paths.log}`
            : `Paseo ${latest} 화면 빌드가 실패했습니다. 잠시 뒤 다시 시도합니다. 빌드 기록: ${paths.log}` });
        }
        return;
      }
      const commit = tags.split("\n").find((l) => l.trim().endsWith(`refs/tags/v${latest}`))?.split(/\s/)[0] || "?";
      log(`Paseo v${latest} 태그 커밋 ${commit}`);
      await build(want, state);
    } catch (e) {
      log(`확인·빌드 실패: ${e?.message || e}`);
      if (status.phase === "ready") setStatus({ update: null, message: `새 Paseo 화면 빌드 실패: ${e?.message || e}` });
      else setStatus({ phase: "error", message: String(e?.message || e) });
    } finally {
      building = null;
    }
  })();
  return building;
}

async function build(want, state) {
  const { version } = want;
  const name = buildName(want.version, want.recipe);
  const first = status.phase !== "ready";
  if (first) setStatus({ phase: "building", message: `Paseo ${version} 화면을 처음 준비하는 중입니다(몇 분 걸림)` });
  else setStatus({ update: version });
  fs.mkdirSync(paths.builds, { recursive: true });
  const free = freeBytes(paths.root);
  if (free !== null && free < MIN_FREE_BYTES) throw new Error(`디스크 여유 공간이 부족합니다(${(free / 1024 ** 3).toFixed(1)}GB, 3GB 필요)`);
  const npm = findNpm();
  if (!npm) throw new Error("npm을 찾지 못해 Paseo 화면을 빌드할 수 없습니다(Node.js 설치 필요)");
  const src = path.join(paths.root, `src-${name}.partial-${process.pid}`);
  const out = path.join(paths.builds, `${name}.partial-${process.pid}`);
  log(`Paseo ${name} 빌드 시작`);
  try {
    await step(findGit(), ["clone", "--depth", "1", "--branch", `v${version}`, "--quiet", REPO, src], paths.root, npm.dir);
    await step(npm.bin, ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error", ...WORKSPACES.map((w) => `--workspace=${w}`)], src, npm.dir);
    for (const script of BUILD_SCRIPTS) await step(npm.bin, ["run", script], src, npm.dir);
    prepareApp(path.join(src, "packages", "app"));
    const app = path.join(src, "packages", "app");
    await step(npm.bin, ["exec", "--", "expo", "export", "--platform", "web", "--output-dir", out], app, npm.dir);
    if (!fs.existsSync(path.join(out, "index.html"))) throw new Error("빌드 결과에 index.html 이 없습니다");
    fs.rmSync(buildDir(want), { recursive: true, force: true });
    fs.renameSync(out, buildDir(want));
    const next = promote(readState(), want);
    writeState(next);
    prune([next.current, next.previous]);
    log(`Paseo ${name} 빌드 완료`);
    setStatus({ phase: "ready", build: want, update: null, message: "" });
  } catch (e) {
    if (!stopped) writeState(recordFailure(readState(), want, Date.now()));
    throw e;
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
}

// 빌드용 소스에 Iris 파일만 더함. Paseo 소스 코드는 그대로
// - 진입: package.json main → iris-chat-entry.tsx
// - Metro: 원래 설정을 metro.config.paseo.cjs 로 옮기고 감싸는 설정을 넣음
// - 주소: 결과물을 /paseo-ui/ 아래에서 제공하려고 app.config.js 의 experiments 에 baseUrl 한 줄
//   (그 자리가 정확히 한 곳이 아니면 빌드 실패 → 이전 빌드 유지)
function prepareApp(app) {
  // 진입 파일과 그 옆 파일(iris-shim.ts 등). metro 설정은 아래에서 따로 넣음
  for (const name of entryFiles()) fs.copyFileSync(path.join(path.dirname(ENTRY), name), path.join(app, name));
  const pkgFile = path.join(app, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
  pkg.main = "iris-chat-entry.tsx";
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));
  fs.renameSync(path.join(app, "metro.config.cjs"), path.join(app, "metro.config.paseo.cjs"));
  fs.copyFileSync(METRO_CONFIG, path.join(app, "metro.config.cjs"));
  const configFile = path.join(app, "app.config.js");
  const text = fs.readFileSync(configFile, "utf8");
  if (text.split("experiments: {").length !== 2) throw new Error("Paseo app.config.js 의 experiments 위치를 찾지 못했습니다");
  fs.writeFileSync(configFile, text.replace("experiments: {", `experiments: {\n      baseUrl: "/paseo-ui",`));
}

// 빌드에 복사하는 entry 폴더 파일 이름(정렬). Metro 설정은 제외
function entryFiles() {
  return fs.readdirSync(path.dirname(ENTRY)).filter((n) => n !== path.basename(METRO_CONFIG) && /\.(tsx?|js)$/.test(n)).sort();
}

function buildDir(build) {
  return path.join(paths.builds, buildName(build.version, build.recipe));
}

function readState() {
  try { return parseState(fs.readFileSync(paths.state, "utf8")); } catch { return parseState(""); }
}

function writeState(state) {
  fs.mkdirSync(paths.root, { recursive: true });
  const tmp = `${paths.state}.tmp`;
  const { current, previous, failed, checkedAt } = state;
  fs.writeFileSync(tmp, JSON.stringify({ current, previous, failed, checkedAt }, null, 2) + "\n");
  fs.renameSync(tmp, paths.state);
}

function prune(keep) {
  const names = keep.filter(Boolean).map((b) => buildName(b.version, b.recipe));
  let list = [];
  try { list = fs.readdirSync(paths.builds); } catch { return; }
  for (const name of list) {
    if (parseBuildName(name) && !names.includes(name)) fs.rmSync(path.join(paths.builds, name), { recursive: true, force: true });
  }
}

// 이전 실행이 남긴 .partial 폴더. 상태 폴더는 server.lock 을 잡은 서버 하나만 쓰므로 시작 때 남은 것은 모두 지난 실행 것
function removeLeftovers() {
  for (const dir of [paths.root, paths.builds]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (/\.partial-\d+$/.test(name)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    }
  }
}

function freeBytes(dir) {
  try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch { return null; }
}

// 빌드에 넘기는 환경 변수. 토큰·API 키는 넘기지 않음
const ENV_KEEP = /^(HOME|USER|LOGNAME|SHELL|TMPDIR|TEMP|TMP|LANG|LC_[A-Z]+|TERM|SystemRoot|SYSTEMROOT|ComSpec|COMSPEC|PATHEXT|APPDATA|LOCALAPPDATA|USERPROFILE|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|npm_config_cache|NPM_CONFIG_CACHE)$/;
export function childEnv(binDir, source = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(source)) if (ENV_KEEP.test(k) && typeof v === "string") env[k] = v;
  env.PATH = [binDir, source.PATH || source.Path].filter(Boolean).join(path.delimiter);
  env.CI = "1";
  env.EXPO_NO_TELEMETRY = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

// 빌드 단계 하나. 낮은 우선순위로 실행하고 출력은 build.log 에
function step(bin, args, cwd, binDir) {
  if (stopped) return Promise.reject(new Error("Iris 가 종료되는 중입니다"));
  return new Promise((resolve, reject) => {
    const win = process.platform === "win32";
    const [cmd, cmdArgs] = win ? [bin, args] : ["nice", ["-n", "10", bin, ...args]];
    log(`$ ${path.basename(bin)} ${args.join(" ")}`);
    const logFd = fs.openSync(paths.log, "a");
    const proc = spawn(cmd, cmdArgs, { cwd, env: childEnv(binDir), stdio: ["ignore", logFd, logFd], shell: win, detached: !win, windowsHide: true });
    fs.closeSync(logFd);
    children.add(proc);
    let grace = null;
    const t = setTimeout(() => {
      killGroup(proc.pid, "SIGTERM");
      grace = setTimeout(() => killGroup(proc.pid, "SIGKILL"), KILL_GRACE_MS);
    }, STEP_TIMEOUT_MS);
    const done = () => { clearTimeout(t); clearTimeout(grace); children.delete(proc); };
    proc.on("error", (e) => { done(); reject(e); });
    proc.on("exit", (code, signal) => {
      done();
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(bin)} ${args[0]} 실패(${signal || code}). 빌드 기록: ${paths.log}`));
    });
  });
}

function capture(bin, args) {
  return new Promise((resolve, reject) => {
    if (stopped) { reject(new Error("Iris 가 종료되는 중입니다")); return; }
    const win = process.platform === "win32";
    const proc = spawn(bin, args, { env: childEnv(null), stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: !win });
    children.add(proc);
    let out = "", err = "";
    proc.stdout.on("data", (d) => { if (out.length < 1e6) out += d; });
    proc.stderr.on("data", (d) => { if (err.length < 4000) err += d; });
    const t = setTimeout(() => killGroup(proc.pid, "SIGKILL"), 60000);
    const done = () => { clearTimeout(t); children.delete(proc); };
    proc.on("error", (e) => { done(); reject(e); });
    proc.on("exit", (code) => { done(); code === 0 ? resolve(out) : reject(new Error(`git ls-remote 실패: ${err.trim().slice(-300)}`)); });
  });
}

function killGroup(pid, signal) {
  if (!pid) return;
  if (process.platform === "win32") {
    try { spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5000 }); } catch {}
    return;
  }
  try { process.kill(-pid, signal); } catch {}
}

// 설치 앱은 Dock 에서 떠서 PATH 가 짧음. 흔한 설치 위치를 차례로 봄
function searchDirs() {
  const dirs = (process.env.PATH || "").split(path.delimiter);
  dirs.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", path.join(os.homedir(), ".volta", "bin"),
    path.join(os.homedir(), ".local", "share", "fnm", "aliases", "default", "bin"));
  const nvm = path.join(os.homedir(), ".nvm", "versions", "node");
  try {
    const versions = fs.readdirSync(nvm).map((v) => v.replace(/^v/, "")).filter((v) => parseVersion(v));
    versions.sort((a, b) => compareVersions(b, a));
    for (const v of versions) dirs.push(path.join(nvm, `v${v}`, "bin"));
  } catch {}
  return dirs.filter(Boolean);
}

function findBin(name) {
  for (const dir of searchDirs()) {
    const bin = path.join(dir, name);
    try { fs.accessSync(bin, fs.constants.X_OK); return { bin, dir }; } catch {}
  }
  return null;
}

function findNpm() {
  return findBin(process.platform === "win32" ? "npm.cmd" : "npm");
}

function findGit() {
  return findBin(process.platform === "win32" ? "git.exe" : "git")?.bin || "git";
}

function log(line) {
  try { fs.mkdirSync(paths.root, { recursive: true }); fs.appendFileSync(paths.log, `[iris ${new Date().toISOString()}] ${line}\n`); } catch {}
}
