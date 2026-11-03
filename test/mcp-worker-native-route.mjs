import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createKeyedSerialExecutor } from "../server/mcp-host/serial.js";
import { COMMAND_ROUTES, requiredFeatures, runsOutsideQueue, workerHandlerFor } from "../server/mcp-worker/command-routes.js";
import { createWorkerHostTaskService } from "../server/mcp-worker/host-task-service.js";
import { NATIVE_COMMAND_NAMES, NATIVE_TRAITS, OUTSIDE_COMMANDS, invalidUploadPaths } from "../server/mcp-worker/native-route.js";
import { CONTROL_SOURCE, FAKE_SECRET, GENERATION, SCENARIOS, createWorkerRun, runLegacy } from "./fixtures/native-route-scenarios.mjs";

const require = createRequire(import.meta.url);
const { createUploadController } = require("../native/electron/cdp-upload.cjs");
const GOLDEN_URL = new URL("./fixtures/worker-route-native-golden.json", import.meta.url);
const read = (file) => fs.readFileSync(new URL(file, import.meta.url), "utf8");
const RUN = `t${Date.now()}`;
const SCRATCH = path.join(process.env.IRIS_TEST_SCRATCH || path.join(os.tmpdir(), "iris-native-route-test"), RUN);
const rootOf = (name, side) => path.join(SCRATCH, name, side);
const scenarioOf = (name) => SCENARIOS.find((item) => item.name === name);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const withTimeout = (promise, ms, label) => Promise.race([promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} ${ms}ms 안에 끝나지 않음`)), ms))]);
const pending = async (promise, ms = 120) => (await Promise.race([promise.then(() => "settled"), sleep(ms).then(() => "pending")])) === "pending";
const waitFor = async (check, label, ms = 1500) => {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error(`${label} 조건이 ${ms}ms 안에 맞지 않음`);
    await sleep(5);
  }
};

// 옛 처리기 기록 갱신: UPDATE_NATIVE_GOLDEN=1 node --test test/mcp-worker-native-route.mjs
if (process.env.UPDATE_NATIVE_GOLDEN === "1") {
  const recorded = [];
  for (const scenario of SCENARIOS) recorded.push({ name: scenario.name, cmd: scenario.cmd, ...(await runLegacy(scenario, rootOf(scenario.name, "record"))) });
  fs.writeFileSync(GOLDEN_URL, JSON.stringify(recorded, null, 2) + "\n");
}
const golden = JSON.parse(fs.readFileSync(GOLDEN_URL, "utf8"));
const OPEN_DIALOG = { kind: "confirm", message: "삭제할까요?", full: "삭제할까요?" };

test("시나리오와 기록이 같은 목록이고 옮긴 명령을 모두 덮는다", () => {
  assert.deepEqual(golden.map((item) => item.name), SCENARIOS.map((item) => item.name));
  const covered = new Set(golden.map((item) => item.cmd));
  assert.deepEqual(NATIVE_COMMAND_NAMES.filter((name) => !covered.has(name)), []);
  for (const name of NATIVE_COMMAND_NAMES) {
    assert.equal(COMMAND_ROUTES[name], "worker", name);
    assert.equal(typeof workerHandlerFor(name), "function", name);
    assert.deepEqual(requiredFeatures(name), ["worker-command-unit", "worker-native-commands"], name);
  }
  // 로그인 호스트 차단(cdp_blocked)과 CDP 없이 되는 경로가 모두 기록에 있다
  assert.equal(golden.some((item) => item.response.ok === false && item.response.code === "cdp_blocked"), true);
  assert.equal(golden.some((item) => item.name.endsWith("blocked-host") && item.response.ok === true), true);
});

test("dialog 는 host 작업 위임이 부르는 처리기이고, 일반 경로는 host 확인 창 연산(browser.dialogAnswer)이 먼저 가져간다", () => {
  assert.equal(NATIVE_COMMAND_NAMES.includes("dialog"), true);
  assert.equal(COMMAND_ROUTES.dialog, "worker");
  assert.equal(typeof workerHandlerFor("dialog"), "function");
  assert.equal(runsOutsideQueue("dialog"), true);
  assert.equal(COMMAND_ROUTES.redact, "worker");
  assert.equal(workerHandlerFor("redact"), null, "redact 는 일반 MCP 명령이 아니라 host 작업 위임 전용");
  for (const name of ["handoff", "cdpstate"]) assert.equal(COMMAND_ROUTES[name], undefined, name);
  const browser = read("../server/mcp-worker/browser-service.js");
  assert.ok(browser.indexOf('if (command === "dialog")') < browser.indexOf("const workerHandler = workerHandlerFor(command, routes)"));
});

test("대기열 밖 실행 목록은 옛 QUEUE_BYPASS 중 옮긴 명령과 같다", () => {
  const bypass = /const QUEUE_BYPASS = new Set\(\[([^\]]*)\]\)/.exec(CONTROL_SOURCE)[1].match(/"([^"]+)"/g).map((item) => item.slice(1, -1));
  assert.deepEqual([...OUTSIDE_COMMANDS].sort(), bypass.filter((name) => NATIVE_COMMAND_NAMES.includes(name)).sort());
  for (const name of NATIVE_COMMAND_NAMES) assert.equal(runsOutsideQueue(name), bypass.includes(name), name);
});

test("읽기 전용 · 키 필요 · 프레임 필요 목록이 옛 cdp-control.cjs·cdp-observation.cjs 와 같다", () => {
  const names = (source, label) => {
    const match = new RegExp(`const ${label} = new Set\\(\\[([^\\]]*)\\]\\)`).exec(source);
    assert.ok(match, label);
    return match[1].match(/"([^"]+)"/g).map((item) => item.slice(1, -1));
  };
  const observation = read("../native/electron/cdp-observation.cjs");
  assert.deepEqual([...NATIVE_TRAITS.READ_ONLY].sort(), names(CONTROL_SOURCE, "READ_ONLY_CMDS").filter((name) => NATIVE_COMMAND_NAMES.includes(name)).sort());
  assert.deepEqual([...NATIVE_TRAITS.NEEDS_KEYS].sort(), names(CONTROL_SOURCE, "NEEDS_KEYS").filter((name) => NATIVE_COMMAND_NAMES.includes(name)).sort());
  assert.deepEqual([...NATIVE_TRAITS.ANIMATES].sort(), names(observation, "ANIMATES").filter((name) => NATIVE_COMMAND_NAMES.includes(name)).sort());
});

test("옛 처리기의 응답 문구가 worker 처리기에 그대로 있다(원본이 바뀌면 사본을 다시 대조)", () => {
  const legacy = read("../native/electron/cdp-cmd-native.cjs");
  const worker = read("../server/mcp-worker/native-route.js");
  const relay = read("../native/electron/relay/index.cjs");
  for (const text of ["올릴 파일 경로가 없습니다.", "없거나 절대경로가 아닌 파일: ", "이제 파일 선택을 여는 버튼을 누르세요. 선택창 대신 이 파일이 들어갑니다.",
    "사람이 처리", "사람이 저장 위치를 고릅니다", "절대경로가 필요합니다: ", "누를 버튼 이름이 필요합니다. 먼저 nativewin으로 확인하세요.",
    "알 수 없는 응답 \"${bad}\" — ok · cancel · off 만 가능", "Math.min(120000, Math.max(1000, Number(args.timeout) || 60000))".replace("args.", "bodyArgs.")]) {
    assert.equal(worker.includes(text), true, `worker: ${text}`);
  }
  for (const text of ["올릴 파일 경로가 없습니다.", "없거나 절대경로가 아닌 파일: ", "이제 파일 선택을 여는 버튼을 누르세요. 선택창 대신 이 파일이 들어갑니다.",
    "사람이 처리", "사람이 저장 위치를 고릅니다", "절대경로가 필요합니다: ", "누를 버튼 이름이 필요합니다. 먼저 nativewin으로 확인하세요.",
    "알 수 없는 응답 \"${bad}\" — ok · cancel · off 만 가능"]) {
    assert.equal(legacy.includes(text), true, `legacy: ${text}`);
  }
  assert.equal(legacy.includes("폴더를 만들 수 없습니다: "), true);
  assert.equal(relay.includes("폴더를 만들 수 없습니다: "), true);
  assert.equal(worker.includes("slice(0, 300)"), true);
  assert.equal(legacy.includes("slice(0, 300)"), true);
});

test("처리기가 쓰는 옛 원문 순서가 cdp-control.cjs 에 있다(원본이 바뀌면 사본과 기록을 다시 대조)", () => {
  const inOrder = (from, needles) => {
    for (const needle of needles) {
      const at = CONTROL_SOURCE.indexOf(needle, from);
      assert.equal(at > from, true, needle);
      from = at;
    }
    return from;
  };
  // cdpExecRaw: 로그인 호스트 판정 → CDP 없는 실행 / 붙임 → AI 표식 → 실행 → 로그인 결과 처리
  const start = CONTROL_SOURCE.indexOf("async function cdpExecRaw(");
  inOrder(start, ["const noCdp = attachPolicy.blocked(wc.id)", "detachAiSession(wc);", "if (!CDP_FREE_CMDS.has(cmd))",
    "const aiTicket = enterAiCommand(wc.id, cmd);", "noteLoginResult(wc, cmd, await runWithoutCdp(wc, cmd, args))",
    "attachPolicy.touch(wc.id);", "const send = ensureAttached(wc);", "noteLoginResult(wc, cmd, await cdpExecInner(send, wc, cmd, args, webContentsMod))"]);
  // cdpExecInner: 숨은 탭 준비 → 붙잡기 → 실행 → 트랜지션 대기 → 해제
  const inner = CONTROL_SOURCE.indexOf("async function cdpExecInner(");
  inOrder(inner, ["await ensureQaReady(send, wc, cmd);", "await captureHold(wc.id, true)", "await runCdpCmd(send, wc, cmd, args, webContentsMod)",
    "await observation.settleAnimations(send)", "await captureHold(wc.id, false)"]);
  assert.match(CONTROL_SOURCE, /if \(cmd === "login" && out && out\.needUser\) attachPolicy\.release\(wc\.id\)/);
  assert.match(CONTROL_SOURCE, /const KEYS_NEED_PAINT = \(cmd\) => NEEDS_KEYS\.has\(cmd\) && cmd !== "login"/);
});

test("업로드 경로 검사는 옛 cdp-upload.cjs invalidPaths 와 같다", () => {
  const root = path.join(SCRATCH, "invalid-paths");
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, "a.txt");
  fs.writeFileSync(file, "a");
  const legacy = createUploadController({ isAbsolute: path.isAbsolute, existsSync: fs.existsSync, showOpenDialog() {}, windowFromWebContents() {}, recordUpload() {}, clearChooser() {} });
  const inputs = [file, path.join(root, "none.txt"), "relative.txt", "", root, file + "/x", "a.txt"];
  // 현재 폴더에 실제로 있는 상대 경로도 절대경로가 아니면 잘못된 경로
  const previous = process.cwd();
  process.chdir(root);
  try {
    assert.deepEqual(invalidUploadPaths(inputs), legacy.invalidPaths(inputs));
    assert.equal(invalidUploadPaths(["a.txt"]).length, 1);
  } finally { process.chdir(previous); }
});

for (const scenario of SCENARIOS) {
  const recorded = golden.find((item) => item.name === scenario.name);
  test(`golden master: ${scenario.name} 은 옛 처리기와 응답·부수 효과가 같다`, async () => {
    const worker = createWorkerRun(scenario, rootOf(scenario.name, "worker"));
    const result = await worker.run();
    assert.deepEqual(result.response, recorded.response);
    assert.deepEqual(result.effects, recorded.effects);
    // 단위 규칙: 모든 호출이 사용자 명령 이름으로 묶이고 대기열 밖 표시는 옛 QUEUE_BYPASS 명령만
    assert.equal(worker.relays.every((r) => r.unit.command === scenario.cmd), true);
    assert.equal(worker.relays.every((r) => (r.unit.outside === true) === (OUTSIDE_COMMANDS.has(scenario.cmd) || scenario.cmd === "redact")), true);
    assert.equal(worker.relays.filter((r) => r.unit.phase === "last").length <= 1, true);
    // host 작업 위임은 하위 호출마다 새 commandId (host 의 같은 commandId·callId·입력 중복 방지에 걸리지 않음)
    if (scenario.via === "hostTask") {
      assert.equal(worker.relays.every((r) => r.commandId.startsWith(`${GENERATION}/1/host/`)), true);
      assert.equal(worker.hostCalls.some(([operation]) => operation === "browser.legacyHostTask"), false, "옛 Electron 명령으로 가지 않음");
    }
    if (scenario.cmd === "redact") {
      assert.deepEqual(worker.relays.map((r) => r.command), ["result.redact"]);
      assert.equal(worker.relays[0].unit.phase, "last");
      return;
    }
    // 앞 단계 순서: 첫 호출은 cdp.gate, 마지막은 result.redact(성공은 last, 실패는 last 없이 unit.end)
    assert.equal(worker.relays[0].command, "cdp.gate");
    if (result.response.ok) {
      assert.equal(worker.relays.at(-1).command, "result.redact");
      assert.equal(worker.relays.at(-1).unit.phase, "last");
    } else {
      assert.equal(worker.relays.at(-1).command, "unit.end");
      assert.equal(worker.relays.at(-1).unit.phase, "end");
    }
    // AI 표식을 얻었으면 처리기가 직접 돌려준다 (단위 종료 때의 반환에 기대지 않음)
    if (worker.relays.some((r) => r.command === "ai.enter") && result.response.ok) {
      const names = worker.relays.map((r) => r.command);
      assert.equal(names.indexOf("ai.leave") > names.indexOf("ai.enter"), true);
      assert.equal(names.indexOf("ai.leave") < names.indexOf("result.redact"), true);
    }
    // 실패 응답에는 관찰 순간이 없다 (옛 경로도 비우지 않음)
    if (!result.response.ok) assert.equal(JSON.stringify(result.response).includes("moments"), false);
    // 이 슬라이스가 쓰지 않는 기본 명령: 사람 포커스·QA·비밀번호가 오가는 명령
    assert.equal(worker.relays.some((r) => ["focus.prepare", "focus.return", "login.accounts", "login.input", "native.click", "native.key", "native.drag", "qa.mode"].includes(r.command)), false);
  });
}

test("옛 처리기를 다시 돌린 응답과 효과가 기록과 같다(기록의 진위)", async () => {
  for (const item of golden) {
    const again = await runLegacy(scenarioOf(item.name), rootOf(item.name, "again"));
    assert.deepEqual(again, { response: item.response, effects: item.effects }, item.name);
  }
});

test("비밀번호 원문은 worker 로 오지 않는다: 중계 인자·응답·최종 응답 어디에도 없고 메인만 기억한다", async () => {
  const names = SCENARIOS.filter((item) => item.cmd === "login").map((item) => item.name);
  assert.equal(names.length >= 8, true);
  for (const name of names) {
    const scenario = scenarioOf(name);
    const run = createWorkerRun(scenario, rootOf(name, "secret"));
    const result = await run.run();
    assert.equal(JSON.stringify(run.relays).includes(FAKE_SECRET), false, `${name}: 중계 인자`);
    assert.equal(JSON.stringify(run.responses).includes(FAKE_SECRET), false, `${name}: 메인 응답`);
    assert.equal(JSON.stringify(result.response).includes(FAKE_SECRET), false, `${name}: 최종 응답`);
    assert.equal(JSON.stringify(run.responses).includes("\"secret\""), false, `${name}: secret 칸`);
    // 채운 로그인은 메인이 비밀을 기억해 이후 모든 결과에서 가린다
    if (scenario.env.login.secret) assert.equal(result.effects.some((effect) => effect[0] === "rememberSecret"), true, name);
  }
  const source = read("../server/mcp-worker/native-route.js");
  assert.equal(/login\.(accounts|input)/.test(source), false);
  assert.equal(/password|secret/i.test(source.replace(/\/\/.*$/gm, "")), false);
});

test("로그인 결과에 비밀이 섞여 와도 최종 응답은 가려진다", async () => {
  const run = createWorkerRun(scenarioOf("login-secret-echoed-in-result"), rootOf("login-secret-echoed-in-result", "echo"));
  const { response } = await run.run();
  assert.equal(JSON.stringify(response).includes(FAKE_SECRET), false);
  assert.equal(JSON.stringify(response).includes("••••"), true);
});

test("로그인이 사람 개입을 요구하면 메인이 붙임을 풀고 worker 는 새 세대 token 으로 이어 간다", async () => {
  const run = createWorkerRun(scenarioOf("login-need-user"), rootOf("login-need-user", "gen"));
  await run.run();
  const fill = run.relays.findIndex((r) => r.command === "login.fill");
  const after = run.relays.slice(fill + 1);
  assert.deepEqual(after.map((r) => r.command), ["cdp.sync", "ai.leave", "result.redact"]);
  assert.equal(run.relays[fill].targetToken.debuggerGeneration, 4);
  // cdp.sync 는 세대 비교를 면제받아 옛 token 으로 가고, 이후 호출은 응답으로 받은 새 세대
  assert.equal(after[0].targetToken.debuggerGeneration, 4);
  assert.equal(after[1].targetToken.debuggerGeneration, 5);
  assert.equal(after[2].targetToken.debuggerGeneration, 5);
});

test("확인 창(JS)이 떠 있어도 dialogs 는 모든 단계가 막히지 않고 끝난다", async () => {
  for (const name of ["dialogs-ok", "dialogs-queue", "dialogs-off-default", "dialogs-bad-word"]) {
    const run = createWorkerRun(scenarioOf(name), rootOf(name, "open"), { hostDialog: OPEN_DIALOG });
    const result = await run.run();
    assert.equal(result.response.ok, true, name);
    assert.equal(run.responses.every((response) => response.commandState === "completed"), true, name);
    assert.equal(run.relays.at(-1).command, "result.redact", name);
    assert.equal(JSON.stringify(result.response).includes("dialogOpen"), false, name);
  }
});

test("확인 창이 떠 있으면 나머지 네이티브 명령은 옛 browser-commands.js 처럼 막히고 그 사실을 알린다", async () => {
  for (const name of ["dialoginfo-open", "nativewin-sheet", "nativekey-escape", "nativeclick-ok", "login-filled", "upload-arm", "download-arm"]) {
    const scenario = scenarioOf(name);
    const run = createWorkerRun(scenario, rootOf(name, "blocked"), { hostDialog: OPEN_DIALOG });
    const result = await run.run();
    assert.equal(result.response.ok, false, name);
    assert.equal(result.response.dialogOpen.kind, "confirm", name);
    assert.match(result.response.error, /browser_dialog/, name);
    // 첫 호출이 막히고 단위만 닫음: 어떤 표식도 얻지 않음
    assert.deepEqual(run.relays.map((r) => r.command), ["cdp.gate", "unit.end"], name);
    assert.deepEqual(result.effects.filter((effect) => effect[0] === "ai.enter"), [], name);
    assert.equal(run.relays.at(-1).unit.outside === true, OUTSIDE_COMMANDS.has(scenario.cmd), name);
  }
});

test("명령 도중 확인 창이 뜨면 대기열 밖 명령도 얻은 AI 표식을 단위 종료 때 돌려준다", async () => {
  for (const name of ["nativekey-escape", "nativeclick-ok", "login-filled", "upload-arm"]) {
    const scenario = scenarioOf(name);
    let run;
    run = createWorkerRun(scenario, rootOf(name, "ticket"), {
      onExecute: async (relay) => { if (relay.command === "ai.enter") run.hostState.dialog = OPEN_DIALOG; },
    });
    const result = await run.run();
    assert.equal(result.response.ok, false, name);
    assert.equal(result.response.dialogOpen.kind, "confirm", name);
    assert.deepEqual(run.relays.map((r) => r.command).slice(-2), ["viewport.ensureReady", "unit.end"], name);
    await waitFor(() => run.releases.length === 1, `${name} 반환`);
    await waitFor(() => run.world.effects.some((effect) => effect[0] === "ai.leave"), `${name} ai.leave`);
    assert.equal(run.world.effects.filter((effect) => effect[0] === "ai.leave").length, 1, name);
  }
});

test("대기열 밖 명령은 막힌 단위 뒤에 서지 않고 일반 명령은 서서 기다린다", async () => {
  const serial = createKeyedSerialExecutor();
  const gate = deferred();
  const scenario = {
    name: "queue-mix", cmd: "upload", args: {}, refs: undefined,
    env: { shown: true, login: { ok: true, origin: "https://example.test", username: "u", secret: FAKE_SECRET }, ax: { key: { ok: true, key: "escape" }, window: { ok: true, windows: [], blocking: [], note: "x" }, click: { ok: true, clicked: "열기", where: "OK-sheet" } } },
    setup: (root) => { fs.mkdirSync(path.join(root, "files"), { recursive: true }); fs.writeFileSync(path.join(root, "files", "a.txt"), "a"); },
  };
  const run = createWorkerRun(scenario, rootOf("queue-mix", "worker"), {
    serial,
    onExecute: async (relay, meta) => { if (meta.commandId === `${GENERATION}/stuck` && relay.command === "viewport.ensureReady") await gate.promise; },
  });
  await run.accept();
  const stuck = run.dispatch("upload", { paths: [path.join(run.root, "files", "a.txt")] }, `${GENERATION}/stuck`);
  await waitFor(() => run.relays.some((r) => r.commandId === `${GENERATION}/stuck` && r.command === "viewport.ensureReady"), "막힌 단위 시작");
  const outside = [
    run.dispatch("nativekey", { key: "escape" }, `${GENERATION}/key`),
    run.dispatch("nativewin", {}, `${GENERATION}/win`),
    run.dispatch("nativeclick", { button: "열기" }, `${GENERATION}/click`),
    run.dispatch("dialogs", { plan: "ok" }, `${GENERATION}/dialogs`),
    run.dispatch("dialoginfo", {}, `${GENERATION}/info`),
  ];
  const results = await withTimeout(Promise.all(outside), 1500, "대기열 밖 명령");
  assert.deepEqual(results.map((item) => item.ok), [true, true, true, true, true]);
  assert.equal(await pending(stuck), true, "막힌 명령은 계속 기다림");
  // 일반 네이티브 명령은 막힌 단위 뒤에 선다
  const login = run.dispatch("login", {}, `${GENERATION}/login`);
  assert.equal(await pending(login), true, "login 은 막힌 단위 뒤에 섬");
  assert.equal(run.world.effects.some((effect) => effect[0] === "login.provider"), false, "login 은 아직 메인에서 실행되지 않음");
  gate.resolve();
  assert.equal((await withTimeout(stuck, 1500, "막힌 명령")).ok, true);
  assert.equal((await withTimeout(login, 1500, "login")).ok, true);
  assert.equal(serial.size(), 0, "탭 잠금이 남지 않음");
});

test("메인이 worker-native-commands 를 알리지 않으면 옛 봉투로 보낸다(이전 설치 앱과 호환)", async () => {
  for (const features of [["worker-command-unit"], [], ["worker-native-commands"], ["worker-command-unit", "worker-input-commands", "worker-page-commands"]]) {
    for (const name of ["dialogs-ok", "nativekey-escape", "login-filled", "upload-arm"]) {
      const scenario = scenarioOf(name);
      const run = createWorkerRun(scenario, rootOf(name, `legacy-${features.length}`), { features });
      await run.run();
      assert.deepEqual(run.relays.map((r) => [r.command, r.unit ?? null]), [[scenario.cmd, null]], `${name} ${features}`);
    }
  }
});

test("경로 표를 legacy 로 바꾸면 옛 봉투로 되돌아간다(앱 재시작 불필요)", async () => {
  for (const name of NATIVE_COMMAND_NAMES.filter((item) => item !== "dialog")) {
    const scenario = SCENARIOS.find((item) => item.cmd === name);
    const run = createWorkerRun(scenario, rootOf(scenario.name, "route-legacy"), { routes: { ...COMMAND_ROUTES, [name]: "legacy" } });
    await run.run();
    assert.deepEqual(run.relays.map((r) => [r.command, r.unit ?? null]), [[name, null]], name);
  }
});

test("worker 세대가 은퇴하면 무장한 대화상자 계획·업로드·다운로드를 풀고, 새 세대가 다시 무장한 것은 건드리지 않는다", async () => {
  const dialogs = createWorkerRun(scenarioOf("dialogs-queue"), rootOf("dialogs-queue", "retire"));
  await dialogs.run();
  const download = createWorkerRun(scenarioOf("download-arm"), rootOf("download-arm", "retire"));
  await download.run();
  const upload = createWorkerRun(scenarioOf("upload-arm"), rootOf("upload-arm", "retire"));
  await upload.run();
  for (const run of [dialogs, download, upload]) {
    const before = run.world.effects.length;
    await run.relay.retireGeneration(GENERATION, {});
    const released = run.world.effects.slice(before).map((effect) => effect[0]);
    if (run === dialogs) assert.deepEqual(released, ["plan.clear"]);
    if (run === download) assert.deepEqual(released, ["download.disarm"]);
    if (run === upload) assert.deepEqual(released, ["upload.forget"]);
  }
  assert.deepEqual(dialogs.world.state.plan, { queue: [], mode: null, text: null });
});

// ── host 작업 위임: dialog · redact 는 기본 명령 단위로, 그 밖은 옛 Electron 명령(legacyHostTask)으로 ──
test("확인 창이 떠 있어도 host 작업 위임의 dialog 와 redact 단위는 막히지 않는다(열린 창을 푸는 단위)", async () => {
  for (const name of ["dialog-confirm-ok", "dialog-none", "redact-plain", "redact-secret"]) {
    const run = createWorkerRun(scenarioOf(name), rootOf(name, "open"), { hostDialog: OPEN_DIALOG });
    const result = await run.run();
    assert.equal(result.response.ok, true, name);
    assert.equal(run.responses.every((response) => response.commandState === "completed"), true, name);
    assert.equal(run.relays.every((r) => r.unit.outside === true), true, `${name}: 탭 잠금 밖 단위`);
  }
  // 같은 열린 창에서 다른 단위(dialoginfo 가 아닌 login)는 계속 막힘
  const login = createWorkerRun(scenarioOf("login-filled"), rootOf("login-filled", "open2"), { hostDialog: OPEN_DIALOG });
  assert.equal((await login.run()).response.ok, false);
});

test("host 연산이 탭 잠금을 쥔 채 dialog · redact 작업을 맡겨도 잠금을 풀 필요 없이 끝난다(runUnlocked 없이도 교착 없음)", async () => {
  const serial = createKeyedSerialExecutor();
  for (const name of ["dialog-confirm-ok", "redact-plain"]) {
    const run = createWorkerRun(scenarioOf(name), rootOf(name, "locked"), { serial });
    await run.accept();
    const response = await withTimeout(serial.run(["tab:tab-a"], () => run.hostTask()), 1500, `${name} 잠금 안`);
    assert.equal(response.ok, true, name);
  }
  assert.equal(serial.size(), 0);
});

test("host 작업 위임: 메인이 단위를 알리지 않거나 경로 표가 legacy 이거나 page 기능 없이 screenshot 이면 옛 legacyHostTask 로 보낸다", async () => {
  const taskInput = (command, args) => ({ tabId: "tab-a", target: { tabId: "tab-a", wcId: 7, targetToken: { wcId: 7, documentGeneration: 3, debuggerGeneration: 4 } },
    relay: { command, args, timeoutMs: 10000 } });
  for (const features of [[], ["worker-command-unit"], ["worker-native-commands"]]) {
    const run = createWorkerRun(scenarioOf("dialog-confirm-ok"), rootOf("dialog-confirm-ok", `legacy-${features.length}`), { features });
    await run.accept();
    await run.hostTask("dialog", { answer: "ok" });
    assert.equal(run.relays.length, 0, features.join());
    assert.deepEqual(run.hostCalls.map(([operation, input]) => [operation, input]), [["browser.legacyHostTask", taskInput("dialog", { answer: "ok" })]]);
  }
  const switched = createWorkerRun(scenarioOf("dialog-confirm-ok"), rootOf("dialog-confirm-ok", "routes"), { routes: { ...COMMAND_ROUTES, dialog: "legacy", redact: "legacy" } });
  await switched.accept();
  await switched.hostTask("dialog", { answer: "ok" });
  await switched.hostTask("redact", { text: "문구" });
  assert.equal(switched.relays.length, 0);
  assert.deepEqual(switched.hostCalls.map(([operation, input]) => input.relay.command), ["dialog", "redact"]);
  const screenshot = createWorkerRun(scenarioOf("dialog-confirm-ok"), rootOf("dialog-confirm-ok", "shot"));
  await screenshot.accept();
  await screenshot.hostTask("screenshot", { tab: "tab-a" });
  assert.equal(screenshot.relays.length, 0);
  assert.deepEqual(screenshot.hostCalls.map(([operation, input]) => [operation, input.relay.command]), [["browser.legacyHostTask", "screenshot"]]);
  // 허용 목록 밖 작업 · 잘못된 요청은 그대로 거절
  await assert.rejects(() => screenshot.hostTask("eval", {}), (error) => error.code === "INVALID_REQUEST");
  const bare = createWorkerHostTaskService({ hostApi: { call: async () => ({}), withCommand: (_c, run) => run() } });
  await assert.rejects(() => bare.dispatch({ task: null }), (error) => error.code === "INVALID_REQUEST");
  await assert.rejects(() => bare.dispatch({ task: { type: "legacyRelay", target: { tabId: "t" } } }), (error) => error.code === "INVALID_REQUEST");
});

test("같은 요청 안에서 반복한 같은 작업도 중복 방지에 걸리지 않고 매번 새 단위로 간다", async () => {
  const run = createWorkerRun(scenarioOf("redact-plain"), rootOf("redact-plain", "repeat"));
  await run.accept();
  const first = await run.hostTask("redact", { text: "같은 문구" });
  const second = await run.hostTask("redact", { text: "같은 문구" });
  assert.deepEqual(first, second);
  assert.equal(run.relays.length, 2);
  assert.equal(new Set(run.relays.map((r) => r.commandId)).size, 2);
  assert.equal(run.relays.every((r) => r.commandId.startsWith(`${GENERATION}/1/host/`)), true);
});

test("redact 는 메인의 비밀 가리기를 한 번 거쳐 옛 redact 응답 모양({ok,data:{ok,text}})으로 돌아온다", async () => {
  const run = createWorkerRun(scenarioOf("redact-secret"), rootOf("redact-secret", "shape"));
  await run.accept();
  const response = await run.hostTask("redact", { text: `앞 ${FAKE_SECRET} 뒤` });
  assert.deepEqual(response, { ok: true, data: { ok: true, text: "앞 •••• 뒤" } });
  assert.deepEqual(run.relays.map((r) => r.command), ["result.redact"]);
  assert.equal(JSON.stringify(run.relays).includes(FAKE_SECRET), true, "가릴 문구는 worker 가 메인으로 보냄(메인만 비밀을 알고 가림)");
  assert.equal(JSON.stringify(response).includes(FAKE_SECRET), false);
});

test("host 작업 위임의 controlLabel 과 lifecycle 은 원래 요청과 같다", async () => {
  const run = createWorkerRun(scenarioOf("redact-plain"), rootOf("redact-plain", "label"));
  await run.accept();
  await run.hostTask("redact", { text: "a" }, `${GENERATION}/qa`, { session: "pane", run: "run-1", key: "key-1" });
  await run.hostTask("redact", { text: "b" }, `${GENERATION}/pane`, { session: "pane" });
  await run.hostTask("redact", { text: "c" }, `${GENERATION}/lifecycle/run-1/x`, { session: "pane", run: "run-1", lifecycle: true });
  assert.deepEqual(run.relays.map((r) => r.input), [
    { tabId: "tab-a", targetToken: { wcId: 7, documentGeneration: 3, debuggerGeneration: 4 }, controlLabel: "iris-qa" },
    { tabId: "tab-a", targetToken: { wcId: 7, documentGeneration: 3, debuggerGeneration: 4 }, controlLabel: "pane" },
    { tabId: "tab-a", targetToken: { wcId: 7, documentGeneration: 3, debuggerGeneration: 4 }, controlLabel: "iris-qa", lifecycle: true },
  ]);
});
