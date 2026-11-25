import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { paneScript, paneCommand, quote, envFile, runtimeOf, finish, ENV_DENY, BANNER } from "../bin/agent-run.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("quote가 작은따옴표를 담은 값을 셸이 다시 해석하지 못하게 닫는다", () => {
  assert.equal(quote("plain"), "'plain'");
  // 닫고 이스케이프하고 다시 여는 형태. 이것이 깨지면 인자 하나가 명령으로 실행된다.
  assert.equal(quote("it's"), `'it'\\''s'`);
  assert.equal(quote("a; rm -rf /"), "'a; rm -rf /'");
  assert.equal(quote("$(whoami)"), "'$(whoami)'");
});

test("자식 팬 env에서 팬 정체성 변수를 뺀다", () => {
  const text = envFile({ SAFE: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/s", TERM: "xterm", PWD: "/tmp" });
  assert.match(text, /^SAFE='1'$/m);
  for (const key of ["HERDR_PANE_ID", "HERDR_SOCKET_PATH", "TERM", "PWD"]) {
    assert.ok(!text.includes(`${key}=`), `${key}를 자식에게 물려주면 자식이 부모 팬을 자기라고 읽는다`);
  }
});

test("env 이름이 셸 식별자가 아니면 싣지 않는다", () => {
  const text = envFile({ "BASH_FUNC_x%%": "() { :; }", "a-b": "1", OK: "2" });
  assert.match(text, /^OK='2'$/m);
  assert.ok(!text.includes("BASH_FUNC"));
  assert.ok(!text.includes("a-b"));
});

test("자식 팬 기록에 API 키·토큰·비밀번호를 쓰지 않는다", () => {
  const text = envFile({ SAFE: "1", OPENAI_API_KEY: "openai-secret", HERDR_TOKEN: "herdr-secret", DB_PASSWORD: "db-secret", SSH_AUTH_SOCK: "/tmp/ssh-agent.sock" });
  assert.match(text, /^SAFE='1'$/m);
  assert.match(text, /^SSH_AUTH_SOCK='\/tmp\/ssh-agent\.sock'$/m);
  for (const key of ["OPENAI_API_KEY", "HERDR_TOKEN", "DB_PASSWORD"]) assert.ok(!text.includes(`${key}=`));
});

function waitForFile(file, timeout = 5000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (fs.existsSync(file)) return resolve();
      if (Date.now() - started >= timeout) return reject(new Error(`fixture file timeout: ${file}`));
      setTimeout(poll, 20);
    };
    poll();
  });
}

function waitForLog(file, event, timeout = 5000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(`"event":"${event}"`)) return resolve();
      if (Date.now() - started >= timeout) return reject(new Error(`fixture log timeout: ${event}`));
      setTimeout(poll, 20);
    };
    poll();
  });
}

function filesNamed(root, wanted, found = []) {
  if (!fs.existsSync(root)) return found;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) filesNamed(file, wanted, found);
    else if (entry.name === wanted) found.push(file);
  }
  return found;
}

function filesContaining(root, needle, found = []) {
  if (!fs.existsSync(root)) return found;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) filesContaining(file, needle, found);
    else if (fs.readFileSync(file, "utf8").includes(needle)) found.push(file);
  }
  return found;
}

function agentRunFixture(t, { tabDelay = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iris-agent-run-signal-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = path.join(root, "state");
  const xdg = path.join(root, "xdg");
  const mockLog = path.join(root, "herdr.jsonl");
  const childPid = path.join(root, "child.pid");
  const probe = path.join(root, "probe.cjs");
  const probeStarted = path.join(root, "probe.started");
  const probeStopped = path.join(root, "probe.stopped");
  const probeEnv = path.join(root, "probe.env.json");
  const mock = path.join(root, "herdr");
  fs.writeFileSync(mock, `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
const log = (event, extra = {}) => fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify({ event, ...extra }) + "\\n");
const out = (result) => process.stdout.write(JSON.stringify({ result }));
const cmd = args[0];
if (cmd === "pane" && args[1] === "get") {
  const id = args[2];
  if (id === "parent") out({ pane: { pane_id: "parent", terminal_id: "term-parent", workspace_id: "workspace", agent: "codex" } });
  else out({ pane: { pane_id: id, terminal_id: "term-child", workspace_id: "workspace", agent_status: "working" } });
} else if (cmd === "tab" && args[1] === "create") {
  log("tab.create");
  setTimeout(() => out({ tab: { tab_id: "tab-1" }, root_pane: { pane_id: "child", terminal_id: "term-child" } }), Number(process.env.MOCK_TAB_DELAY || 0));
} else if (cmd === "pane" && args[1] === "run") {
  const childEnv = { ...process.env };
  delete childEnv.PROVIDER_API_KEY;
  const child = spawn("/bin/bash", ["-lc", args.at(-1)], { detached: true, stdio: "ignore", env: childEnv });
  fs.writeFileSync(process.env.MOCK_CHILD_PID, String(child.pid));
  log("pane.run");
  out(null);
} else if (cmd === "tab" && args[1] === "close") {
  log("tab.close", { id: args[2] });
  try { process.kill(-Number(fs.readFileSync(process.env.MOCK_CHILD_PID, "utf8")), "SIGTERM"); } catch {}
  out(null);
} else if (cmd === "pane" && args[1] === "release-agent") {
  log("pane.release");
  out(null);
} else {
  log(args.join(" "));
  out(null);
}
`);
  fs.chmodSync(mock, 0o755);
  fs.writeFileSync(probe, `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.PROBE_STARTED, "started");
fs.writeFileSync(process.env.PROBE_ENV, JSON.stringify({ provider: process.env.PROVIDER_API_KEY, ssh: process.env.SSH_AUTH_SOCK }));
process.on("SIGTERM", () => { fs.writeFileSync(process.env.PROBE_STOPPED, "stopped"); process.exit(143); });
setInterval(() => {}, 1000);
`);
  fs.chmodSync(probe, 0o755);
  const herdrConfig = process.platform === "win32" ? path.join(xdg, "herdr") : path.join(root, ".config", "herdr");
  const socket = path.join(herdrConfig, "sessions", "agent-run-test", "herdr.sock");
  const env = {
    PATH: `${root}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, XDG_CONFIG_HOME: xdg,
    IRIS_STATE_DIR: state, IRIS_HERDR_SESSION: "agent-run-test", HERDR_PANE_ID: "parent", HERDR_SOCKET_PATH: socket,
    MOCK_LOG: mockLog, MOCK_CHILD_PID: childPid, MOCK_TAB_DELAY: String(tabDelay),
    PROBE_STARTED: probeStarted, PROBE_STOPPED: probeStopped, PROBE_ENV: probeEnv,
    PROVIDER_API_KEY: "fixture-provider-key", SSH_AUTH_SOCK: path.join(root, "ssh-agent.sock"),
  };
  const runner = spawn(process.execPath, [path.join(ROOT, "bin", "agent-run.mjs"), "--runtime", "codex", "--cwd", root, "--", probe],
    { cwd: root, env, stdio: ["pipe", "ignore", "pipe"] });
  runner.stderr.setEncoding("utf8");
  let stderr = "";
  runner.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (runner.exitCode === null && runner.signalCode === null) {
      runner.kill("SIGTERM");
      await new Promise((resolve) => runner.once("exit", resolve));
    }
    try { process.kill(-Number(fs.readFileSync(childPid, "utf8")), "SIGTERM"); } catch {}
  });
  return { root, state, mockLog, probeStarted, probeStopped, probeEnv, runner, stderr: () => stderr };
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

test("시작 중 SIGTERM은 지연된 tab.create 뒤 탭·파일을 회수한다", async (t) => {
  const f = agentRunFixture(t, { tabDelay: 500 });
  f.runner.stdin.end("fixture input");
  await waitForFile(f.mockLog);
  f.runner.kill("SIGTERM");
  const exit = await waitForExit(f.runner);
  assert.equal(exit.code, 143);
  assert.ok(fs.readFileSync(f.mockLog, "utf8").includes('"event":"tab.close"'), f.stderr());
  assert.equal(fs.existsSync(f.probeStarted), false);
  assert.equal(filesNamed(f.state, "env.sh").length, 0);
  assert.equal(filesNamed(f.state, "run.json").length, 0);
  assert.equal(filesNamed(f.state, "secret-env.json").length, 0);
});

test("실행 중 SIGTERM은 실제 자식과 herdr 탭·임시 파일을 함께 정리한다", async (t) => {
  const f = agentRunFixture(t);
  f.runner.stdin.end("fixture input");
  await waitForLog(f.mockLog, "tab.create");
  await waitForLog(f.mockLog, "pane.run");
  await waitForFile(f.probeStarted);
  const env = JSON.parse(fs.readFileSync(f.probeEnv, "utf8"));
  assert.equal(env.provider, "fixture-provider-key");
  assert.match(env.ssh, /ssh-agent\.sock$/);
  assert.equal(filesContaining(f.state, "fixture-provider-key").length, 0);
  f.runner.kill("SIGTERM");
  const exit = await waitForExit(f.runner);
  await waitForFile(f.probeStopped);
  assert.equal(exit.code, 143);
  const log = fs.readFileSync(f.mockLog, "utf8");
  assert.ok(log.includes('"event":"pane.release"'), f.stderr());
  assert.ok(log.includes('"event":"tab.close"'), f.stderr());
  assert.equal(filesNamed(f.state, "env.sh").length, 0);
  assert.equal(filesNamed(f.state, "run.json").length, 0);
  assert.equal(filesNamed(f.state, "secret-env.json").length, 0);
});

test("팬 스크립트가 stdout과 stderr를 갈라 남긴다", () => {
  const script = paneScript("/state/job", ["codex", "exec", "-m", "x"], "/repo");
  // 합치면 부르는 쪽이 둘을 갈라 판정하던 근거가 사라진다.
  assert.ok(!/2>&1/.test(script), "stdout·stderr를 합치면 안 된다");
  assert.match(script, /tee '\/state\/job\/out\.log'/);
  assert.match(script, /tee '\/state\/job\/err\.log' >&2/);
});

test("팬 스크립트가 tee를 기다린 뒤에 종료 코드를 공개한다", () => {
  const script = paneScript("/state/job", ["codex"], "/repo");
  const status = script.indexOf("status=$?");
  const wait = script.indexOf("\nwait");
  const publish = script.indexOf("status.txt'.tmp");
  assert.ok(status > 0 && wait > status, "종료 코드는 명령 직후에 잡는다");
  assert.ok(publish > wait, "wait보다 먼저 공개하면 기다리던 쪽이 잘린 출력을 완성본으로 읽는다");
  // 원자적 공개. 반쯤 쓰인 파일을 종료 코드로 읽는 회차가 없어야 한다.
  assert.match(script, /mv '\/state\/job\/status\.txt'\.tmp '\/state\/job\/status\.txt'/);
});

test("팬 스크립트가 무엇을 보는 창인지 먼저 밝힌다", () => {
  // 이 팬은 대화형 세션과 형태가 다르다. 이유를 적지 않으면 "왜 이 창만 평문인가"로 읽힌다.
  const script = paneScript("/state/job", ["codex"], "/repo");
  for (const line of BANNER) assert.ok(script.includes(quote(line)), `배너 줄이 빠졌다: ${line}`);
});

test("배너가 리다이렉트보다 앞에 선다", () => {
  // 뒤로 가면 tee 를 타고 기록 파일에 섞이고, 부르는 쪽의 마커·session id 파싱이 배너를
  // 산출로 읽는다. 화면에만 보이는 것이 이 줄들의 조건이다.
  const script = paneScript("/state/job", ["codex"], "/repo");
  const lastBanner = script.lastIndexOf(quote(BANNER[BANNER.length - 1]));
  const firstTee = script.indexOf("tee ");
  assert.ok(lastBanner > 0 && firstTee > 0, "둘 다 있어야 위치를 잴 수 있다");
  assert.ok(lastBanner < firstTee, "배너가 tee 뒤로 가면 기록 파일이 오염된다");
});

test("팬 스크립트가 stdin을 파일로 넘긴다", () => {
  const script = paneScript("/state/job", ["codex"], "/repo");
  assert.match(script, /< '\/state\/job\/in\.txt'/);
});

test("팬 스크립트가 재래핑을 막는 표식을 세운다", () => {
  const script = paneScript("/state/job", ["codex"], "/repo");
  assert.match(script, /export IRIS_AGENT_RUN_ACTIVE=1/);
  assert.ok(ENV_DENY.has("IRIS_AGENT_RUN_ACTIVE"), "표식을 부모 env로 덮으면 자식이 또 감싼다");
});

test("자식 팬에 보내는 명령이 셸을 스크립트로 바꾼다", () => {
  // exec가 빠지면 스크립트가 끝나도 셸이 남아 팬이 닫히지 않고, 래퍼는 팬 종료로 중단을 판정하지 못한다.
  assert.equal(paneCommand("/state/job/run.sh"), "exec /bin/bash '/state/job/run.sh'");
  assert.equal(paneCommand("/a b/it's.sh"), `exec /bin/bash '/a b/it'\\''s.sh'`);
});

test("런타임은 명령 이름에서 읽고 모르는 것은 감싸지 않는다", () => {
  assert.equal(runtimeOf("/usr/local/bin/codex"), "codex");
  assert.equal(runtimeOf("claude"), "claude");
  assert.equal(runtimeOf("bash"), null);
  assert.equal(runtimeOf(""), null);
});

test("래퍼가 설치 앱에 실릴 자리마다 등록돼 있다", () => {
  // 목록 하나만 빠져도 설치된 앱에서 파일이 사라지고, 그때는 조용히 pass-through로 흘러
  // 아무것도 잡히지 않는다.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.ok(pkg.build.files.includes("bin/agent-run.mjs"), "build.files");
  assert.ok(pkg.build.asarUnpack.includes("bin/agent-run.mjs"), "asarUnpack");
  const installer = fs.readFileSync(path.join(ROOT, "scripts", "install-agent-context.mjs"), "utf8");
  assert.ok(installer.includes('"bin/agent-run.mjs"'), "install preflight");
});

test("심볼릭 링크로 호출한 agent-run도 CLI 진입점을 실행한다", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-agent-run-link-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const link = path.join(dir, "agent-run.mjs");
  fs.symlinkSync(path.join(ROOT, "bin", "agent-run.mjs"), link);
  const result = spawnSync(process.execPath, [link, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /iris-agent-run/);
});

test("끝낼 때 표식을 단 런타임 이름으로 해제한다", async () => {
  // herdr 는 이름이 다르면 성공으로 응답하고 "working" 을 남겨, Claude 자식이 끝나도 작업 중으로 보인다.
  for (const runtime of ["claude", "codex"]) {
    const calls = [];
    const dir = fs.mkdtempSync(path.join(ROOT, ".agent-run-finish-"));
    try {
    for (const file of ["env.sh", "run.json", "secret-env.json"]) fs.writeFileSync(path.join(dir, file), "fixture");
      await finish({ herdrBin: "herdr", dir, child: { pane_id: "w1:p2" }, runtime, lineageFile: null }, true,
        async (_bin, argv) => { calls.push(argv); return null; });
    for (const file of ["env.sh", "run.json", "secret-env.json"]) assert.equal(fs.existsSync(path.join(dir, file)), false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    assert.deepEqual(calls[0], ["pane", "release-agent", "w1:p2", "--source", "iris-agent-run", "--agent", runtime]);
  }
});

test("신호 종료용 정리는 자식 탭과 민감한 임시 파일을 함께 지운다", async () => {
  const calls = [];
  const dir = fs.mkdtempSync(path.join(ROOT, ".agent-run-signal-"));
  try {
    for (const file of ["env.sh", "run.json", "out.log"]) fs.writeFileSync(path.join(dir, file), "fixture");
    await finish({ herdrBin: "herdr", dir, child: { pane_id: "w1:p2" }, tabId: "tab-1", runtime: "codex", lineageFile: null }, false,
      async (_bin, argv) => { calls.push(argv); return null; }, { closeTab: true });
    assert.deepEqual(calls, [
      ["pane", "release-agent", "w1:p2", "--source", "iris-agent-run", "--agent", "codex"],
      ["tab", "close", "tab-1"],
    ]);
    assert.equal(fs.existsSync(dir), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
