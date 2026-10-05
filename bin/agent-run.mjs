#!/usr/bin/env node
// 셸에서 띄우던 비대화형 서브 세션을 herdr 자식 팬 안에서 돌린다.
//
// 배경: `codex exec`를 subprocess로 그냥 띄우면 프로세스만 생기고 팬이 없다.
// 팬이 없으면 herdr agent list에 안 뜨고, Iris Agents 트리에도 안 뜬다. 부모 팬만 working
// 으로 보이고 그 안에서 무엇이 도는지 밖에서 볼 길이 없다. herdr에는 이미 떠 있는 프로세스를
// 팬에 붙이는 표면이 없으므로(agent/pane 명령 전수 확인), 잡히게 하는 유일한 방법은 띄우는
// 순간을 바꾸는 것이다.
//
// 계약: 호출자에게 투명하다. stdin·stdout·stderr·종료 코드가 직접 실행했을 때와 같다.
// 그래서 호출부는 argv 앞에 이 래퍼를 붙이는 것 말고 바꿀 것이 없다.
//
// herdr 밖에서 불리면 명령을 그대로 실행한다. 래퍼가 새로운 실패 지점이 되면 안 된다.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { artifactDir } from "../server/artifacts-home.cjs";
import { herdrSession } from "../server/herdr-session.cjs";
import { writeAgentLineage } from "../server/agent-lineage.js";

const run = promisify(execFile);
const REASONS = new Set(["independent-work", "independent-review", "separate-evidence", "isolated-trial"]);
const RUNTIMES = new Set(["codex", "claude"]);
const POLL_MS = 200;
// 자식 팬은 명령이 끝나면 스스로 사라진다. 팬이 사라졌는데 종료 코드 파일이 없으면 누군가
// 팬을 닫은 것이다. 파일 시스템 반영이 늦을 수 있어 사라진 뒤에도 잠깐 더 본다.
const GRACE_AFTER_PANE_GONE_MS = 3_000;
// 부모 env 중 자식 팬이 자기 값을 새로 가져야 하는 환경변수. 부모 값을 물려주면 자식이 부모 팬을
// 자기라고 착각해 다시 래핑하려 들 수 있다.
const ENV_DENY = new Set([
  "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "HERDR_ENV", "HERDR_SESSION", "HERDR_SESSION_NAME",
  "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "TERM", "TERM_PROGRAM", "SHLVL", "_", "PWD", "OLDPWD",
  "IRIS_AGENT_RUN_ACTIVE",
]);
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
// 팬을 열었을 때 이 창이 무엇인지 먼저 밝히는 줄. 한 줄에 한 사실만 둔다.
const BANNER = ["배치 잡", "입력 불가", "완료 시 자동 닫힘"];

function executable(name, env) {
  for (const dir of [...String(env[process.platform === "win32" ? Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH" : "PATH"] || "").split(path.delimiter), path.join(os.homedir(), ".local", "bin")]) {
    if (!dir) continue;
    for (const suffix of process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""]) {
      const candidate = path.join(process.platform === "win32" ? dir.replace(/^"|"$/g, "") : dir, name + suffix);
      try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
    }
  }
  return null;
}

// 작은따옴표 문자열 하나로 감싼다. 셸이 안에서 다시 해석할 것이 남지 않는다.
function quote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function herdrJson(bin, argv) {
  return run(bin, argv, { timeout: 15_000, maxBuffer: 1 << 20 }).then(({ stdout }) => {
    // pane run처럼 성공하면 아무것도 출력하지 않는 명령이 있다. 실패는 종료 코드로 run이 던진다.
    if (!stdout.trim()) return null;
    const response = JSON.parse(stdout);
    if (response.error) throw new Error(`herdr rejected ${argv[0]} ${argv[1]}: ${response.error.code || "unknown"}`);
    return response.result;
  });
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve(""));
  });
}

// Windows npm shim 실행
function windowsInvocation(argv, env = process.env) {
  const raw = argv[0];
  let command = raw;
  if (!path.win32.extname(raw)) command = executable(raw, env) || raw;
  const args = argv.slice(1);
  if (!/\.(cmd|bat)$/i.test(command)) return { command, args, options: {} };
  const quote = (value) => {
    if (/[\r\n\0"%!]/.test(value)) throw new Error("cmd에서 안전하게 전달할 수 없는 인자입니다");
    return `"${value}"`;
  };
  return { command: env.ComSpec || "cmd.exe", args: [`/d /v:off /s /c "${[command, ...args].map(quote).join(" ")}"`], options: { windowsVerbatimArguments: true } };
}

// 래퍼가 아무것도 못 할 때의 경로. 명령을 그대로 이 프로세스에서 돌린다.
function passthrough(argv) {
  const invocation = process.platform === "win32" ? windowsInvocation(argv) : { command: argv[0], args: argv.slice(1), options: {} };
  const child = spawn(invocation.command, invocation.args, { stdio: "inherit", ...invocation.options });
  child.on("error", (error) => {
    process.stderr.write(`${argv[0]}: ${error.message}\n`);
    process.exit(127);
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}

function runtimeOf(argv0) {
  const base = process.platform === "win32" ? path.win32.basename(String(argv0 || "")).replace(/\.(exe|cmd)$/i, "").toLowerCase() : path.basename(String(argv0 || ""));
  return RUNTIMES.has(base) ? base : null;
}

function envFile(env) {
  const lines = [];
  for (const [key, value] of Object.entries(env)) {
    if (ENV_DENY.has(key) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    lines.push(`${key}=${quote(value)}`);
  }
  return lines.join("\n") + "\n";
}

// 팬 안에서 돌 스크립트. 화면에는 그대로 흐르게 두고 같은 바이트를 파일로도 남긴다.
// stdout·stderr를 합치지 않는다. 부르는 쪽이 둘을 구분해 판정한다.
function paneScript(dir, argv, cwd) {
  return [
    "#!/bin/bash",
    `cd ${quote(cwd)} || exit 127`,
    "set -a",
    `. ${quote(path.join(dir, "env.sh"))}`,
    "set +a",
    "export IRIS_AGENT_RUN_ACTIVE=1",
    // 이 팬은 대화형 세션과 화면이 다르다. `codex exec` 는 비대화형이라 채팅 화면을 그리지 않고,
    // 아래 리다이렉트가 색까지 없앤다. 그것을 모르면 "왜 이 창만 평문인가"로 읽힌다.
    // 무엇을 보고 있는지 세 줄로 먼저 밝힌다.
    // 이 줄들은 리다이렉트 앞에 둔다. 뒤로 가면 tee 를 거쳐 기록 파일에 섞이고, 부르는 쪽의
    // 마커·session id 파싱이 이 배너를 산출로 읽는다.
    ...BANNER.map((line) => `printf '\\033[2m%s\\033[0m\\n' ${quote(line)}`),
    "printf '\\n'",
    `ARGS=(${argv.map(quote).join(" ")})`,
    `"\${ARGS[@]}" < ${quote(path.join(dir, "in.txt"))} \\`,
    `  > >(tee ${quote(path.join(dir, "out.log"))}) \\`,
    `  2> >(tee ${quote(path.join(dir, "err.log"))} >&2)`,
    "status=$?",
    // tee가 마지막 바이트까지 쓰고 끝난 뒤에 종료 코드를 공개한다. 이 순서가 뒤집히면
    // 기다리던 쪽이 잘린 출력을 완성본으로 읽는다.
    "wait",
    `printf %s "$status" > ${quote(path.join(dir, "status.txt"))}.tmp`,
    `mv ${quote(path.join(dir, "status.txt"))}.tmp ${quote(path.join(dir, "status.txt"))}`,
    "",
  ].join("\n");
}

// 자식 탭과 함께 생긴 셸에 보낼 명령. exec로 셸을 스크립트로 바꿔야 스크립트가 끝날 때 팬도 닫힌다.
function paneCommand(script) {
  if (process.platform === "win32") {
    const quoted = (s) => `'${s.replaceAll("'", "''")}'`;
    const source = `$env:ELECTRON_RUN_AS_NODE='1'; & ${quoted(process.execPath)} ${quoted(fileURLToPath(import.meta.url))} --worker ${quoted(script)}; exit $LASTEXITCODE`;
    return `powershell.exe -NoProfile -EncodedCommand ${Buffer.from(source, "utf16le").toString("base64")}`;
  }
  return `exec /bin/bash ${quote(script)}`;
}

// 파일이 자라는 만큼만 읽어 그대로 흘린다. 호출자에게는 직접 실행과 같은 스트림으로 보인다.
function tailer(file, sink) {
  let offset = 0;
  return () => {
    let handle;
    try { handle = fs.openSync(file, "r"); } catch { return; }
    try {
      const size = fs.fstatSync(handle).size;
      while (offset < size) {
        const buffer = Buffer.allocUnsafe(Math.min(64 << 10, size - offset));
        const read = fs.readSync(handle, buffer, 0, buffer.length, offset);
        if (read <= 0) break;
        offset += read;
        sink.write(buffer.subarray(0, read));
      }
    } finally {
      fs.closeSync(handle);
    }
  };
}

async function paneAlive(bin, paneId) {
  try {
    await herdrJson(bin, ["pane", "get", paneId]);
    return true;
  } catch {
    return false;
  }
}

async function launch(options, argv) {
  const env = process.env;
  const herdrBin = executable("herdr", env);
  const socketPath = herdrSession().socket;
  const runtime = options.runtime || runtimeOf(argv[0]);
  // 추적할 수 없는 경우에는 추적한 것처럼 처리하지 않는다.
  if (!herdrBin || !runtime) return null;
  if (!env.HERDR_PANE_ID || !env.HERDR_SOCKET_PATH) return null;
  if (path.resolve(env.HERDR_SOCKET_PATH) !== path.resolve(socketPath)) return null;
  // 이미 자식 팬 안이면 또 감싸지 않는다.
  if (env.IRIS_AGENT_RUN_ACTIVE === "1") return null;

  let parent;
  try {
    parent = await herdrJson(herdrBin, ["pane", "get", env.HERDR_PANE_ID]);
    parent = parent?.pane || parent;
  } catch {
    return null;
  }
  if (!parent?.pane_id || !parent.terminal_id || !parent.workspace_id) return null;

  const cwd = path.resolve(options.cwd || process.cwd());
  if (!fs.statSync(cwd).isDirectory()) throw new Error("--cwd must be a directory");
  const label = String(options.label || `${runtime} ${path.basename(argv[1] || "")}`.trim()).slice(0, 120) || runtime;
  const reason = REASONS.has(options.reason) ? options.reason : "independent-work";

  const dir = path.join(artifactDir("agent-run"), sha(socketPath), `${Date.now().toString(36)}-${crypto.randomBytes(5).toString("hex")}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "in.txt"), await readStdin(), { mode: 0o600 });
  if (process.platform !== "win32") fs.writeFileSync(path.join(dir, "env.sh"), envFile(env), { mode: 0o600 });
  const script = path.join(dir, process.platform === "win32" ? "run.json" : "run.sh");
  if (process.platform === "win32") {
    const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !ENV_DENY.has(key)));
    fs.writeFileSync(script, JSON.stringify({ dir, argv, cwd, env: childEnv }), { mode: 0o600 });
  } else fs.writeFileSync(script, paneScript(dir, argv, cwd), { mode: 0o700 });
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({
    version: 1, label, reason, runtime, cwd, argv,
    parent: { paneId: parent.pane_id, terminalId: parent.terminal_id },
    createdAt: new Date().toISOString(),
  }, null, 2) + "\n", { mode: 0o600 });

  // 자식은 자기 탭을 받는다. 부모 탭을 쪼개면 병렬로 여럿 띄울 때 부모 화면이 좁아진다.
  const created = await herdrJson(herdrBin, ["tab", "create", "--workspace", parent.workspace_id, "--cwd", cwd, "--label", label, "--no-focus"]);
  const tabId = created?.tab?.tab_id;
  if (!tabId) throw new Error("herdr did not return a tab id");
  // herdr 0.9의 agent start는 지원 목록에 있는 대화형 에이전트만 띄우므로 스크립트를 실행할 수 없다.
  // 탭과 함께 생긴 셸 팬에서 스크립트를 실행한다.
  const child = created?.root_pane;
  try {
    if (!child?.pane_id || !child.terminal_id) throw new Error("herdr did not return the tab's pane");
    await herdrJson(herdrBin, ["pane", "run", child.pane_id, paneCommand(script)]);
  } catch (error) {
    try { await herdrJson(herdrBin, ["tab", "close", tabId]); } catch {}
    throw error;
  }

  // 팬 안의 foreground는 bash이므로 herdr는 런타임을 스스로 알아내지 못한다(확인 결과: agent=null).
  // 표식이 없으면 lineage가 런타임 일치 검사에서 이 자식을 버린다.
  try {
    await herdrJson(herdrBin, ["pane", "report-agent", child.pane_id,
      "--source", "iris-agent-run", "--agent", runtime, "--state", "working"]);
  } catch {}

  let lineageFile = null;
  try {
    lineageFile = writeAgentLineage({
      version: 1,
      socketPath,
      parent: { paneId: parent.pane_id, terminalId: parent.terminal_id, runtime: parent.agent, sessionId: parent.agent_session?.value },
      child: { paneId: child.pane_id, terminalId: child.terminal_id, runtime },
      createdAt: new Date().toISOString(),
      reason,
      label,
    }, { socketPath });
  } catch (error) {
    // 팬은 이미 돌고 있다. 트리에서 부모 아래로 못 붙는 것이 일을 멈출 이유는 아니다.
    process.stderr.write(`iris-agent-run: lineage 등록 실패 — ${error.message}\n`);
  }

  return { herdrBin, dir, child, tabId, lineageFile, runtime };
}

async function waitForExit(session) {
  const { herdrBin, dir, child } = session;
  const statusFile = path.join(dir, "status.txt");
  const pumpOut = tailer(path.join(dir, "out.log"), process.stdout);
  const pumpErr = tailer(path.join(dir, "err.log"), process.stderr);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let goneSince = 0;
  for (;;) {
    pumpOut();
    pumpErr();
    if (fs.existsSync(statusFile)) {
      pumpOut();
      pumpErr();
      const raw = fs.readFileSync(statusFile, "utf8").trim();
      const code = Number.parseInt(raw, 10);
      return Number.isInteger(code) ? code : 0;
    }
    if (await paneAlive(herdrBin, child.pane_id)) {
      goneSince = 0;
    } else {
      if (!goneSince) goneSince = Date.now();
      else if (Date.now() - goneSince > GRACE_AFTER_PANE_GONE_MS) {
        pumpOut();
        pumpErr();
        // 팬이 사라졌는데 종료 코드가 없다. 명령이 스스로 끝난 것이 아니라 밖에서 끊긴 것이다.
        process.stderr.write(`iris-agent-run: 자식 팬이 종료 코드 없이 닫혔다 — ${dir}\n`);
        return 130;
      }
    }
    await sleep(POLL_MS);
  }
}

// herdr 는 표식을 단 런타임 이름이 같아야 해제한다. 다르면 성공으로 응답하고 "working" 을 그대로 남긴다(확인).
async function finish(session, keep, herdr = herdrJson) {
  try {
    await herdr(session.herdrBin, ["pane", "release-agent", session.child.pane_id,
      "--source", "iris-agent-run", "--agent", session.runtime]);
  } catch {}
  // 자식 터미널이 종료되면 이 receipt는 아무 관계도 만들지 않는다. 지우지 않으면 잡 하나에
  // 파일 하나씩 계속 쌓인다. 사람이 만드는 자식과 달리 이 경로는 하루에도 수십 번 실행된다.
  if (session.lineageFile) {
    try { fs.rmSync(session.lineageFile, { force: true }); } catch {}
  }
  if (process.platform === "win32" && !keep) {
    try { await herdr(session.herdrBin, ["tab", "close", session.tabId]); } catch {}
  }
  if (keep) return;
  // 로그는 진단에 쓰이므로 성공한 회차만 지운다. 남기는 경로는 --keep이 소유한다.
  try { fs.rmSync(session.dir, { recursive: true, force: true }); } catch {}
}

// Windows 배치 입출력 바이트 보존
async function windowsWorker(file) {
  const { dir, argv, cwd, env } = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(argv) || !argv.length || !argv.every((arg) => typeof arg === "string")) throw new Error("invalid worker argv");
  const childEnv = { ...process.env, ...env, IRIS_AGENT_RUN_ACTIVE: "1" };
  for (const key of ["HERDR_PANE_ID", "HERDR_SOCKET_PATH", "HERDR_SESSION"]) {
    if (process.env[key]) childEnv[key] = process.env[key];
  }
  for (const line of BANNER) process.stdout.write(line + "\n");
  const invocation = windowsInvocation(argv, childEnv);
  const out = fs.openSync(path.join(dir, "out.log"), "w"), err = fs.openSync(path.join(dir, "err.log"), "w");
  const child = spawn(invocation.command, invocation.args, { cwd, env: childEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, ...invocation.options });
  child.stdout.on("data", (bytes) => { fs.writeSync(out, bytes); process.stdout.write(bytes); });
  child.stderr.on("data", (bytes) => { fs.writeSync(err, bytes); process.stderr.write(bytes); });
  child.stdin.on("error", () => {});
  fs.createReadStream(path.join(dir, "in.txt")).pipe(child.stdin);
  let failed = false;
  child.on("error", (error) => { failed = true; fs.writeSync(err, String(error.message)); });
  const code = await new Promise((resolve) => child.once("close", (status) => resolve(failed ? 127 : status ?? 1)));
  fs.closeSync(out); fs.closeSync(err);
  const status = path.join(dir, "status.txt");
  fs.writeFileSync(status + ".tmp", String(code)); fs.renameSync(status + ".tmp", status);
  process.exitCode = code;
}

async function main() {
  if (process.platform === "win32" && process.argv[2] === "--worker") return windowsWorker(process.argv[3]);
  const separator = process.argv.indexOf("--");
  const argv = separator >= 0 ? process.argv.slice(separator + 1) : [];
  const own = separator >= 0 ? process.argv.slice(2, separator) : process.argv.slice(2);
  const { values } = parseArgs({ args: own, allowPositionals: true, options: {
    label: { type: "string" }, reason: { type: "string" }, runtime: { type: "string" },
    cwd: { type: "string" }, keep: { type: "boolean" }, help: { type: "boolean" },
  } });
  if (values.help || (!argv.length && separator < 0)) {
    console.log("iris-agent-run [--label NAME] [--reason independent-work|independent-review|separate-evidence|isolated-trial] [--runtime codex|claude] [--cwd DIR] [--keep] -- <command...>");
    return;
  }
  if (!argv.length) throw new Error("Put the command after --");
  if (values.runtime && !RUNTIMES.has(values.runtime)) throw new Error("--runtime must be codex or claude");

  let session = null;
  try {
    session = await launch(values, argv);
  } catch (error) {
    process.stderr.write(`iris-agent-run: 자식 팬을 만들지 못했다 — ${error.message}\n`);
  }
  if (!session) return passthrough(argv);

  const code = await waitForExit(session);
  await finish(session, values.keep || code !== 0);
  process.exit(code);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

export { paneScript, paneCommand, quote, envFile, runtimeOf, finish, ENV_DENY, BANNER };
