import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { sliceBetween } from "../bin/slice-anchor.mjs";

import { createKeyedSerialExecutor } from "../server/mcp-host/serial.js";
import { COMMAND_ROUTES, WORKER_HANDLERS, requiredFeatures, runsOutsideQueue, workerHandlerFor } from "../server/mcp-worker/command-routes.js";
import { createWorkerHostTaskService } from "../server/mcp-worker/host-task-service.js";
import { QA_COMMAND_NAMES, QA_TRAITS, qaUnitCommand } from "../server/mcp-worker/qa-route.js";
import {
  CONTROL_SOURCE, GENERATION, LEGACY_PARTS, PASSWORD, SCENARIOS, WC_ID, accountId, qaPage, createWorkerRun, runLegacy,
} from "./fixtures/qa-input-route-scenarios.mjs";

const GOLDEN_URL = new URL("./fixtures/worker-route-qa-input-golden.json", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");
const scenarioOf = (name) => SCENARIOS.find((item) => item.name === name);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 옛 처리기 기록 갱신: UPDATE_QA_INPUT_GOLDEN=1 node --test test/mcp-worker-qa-input-route.mjs
if (process.env.UPDATE_QA_INPUT_GOLDEN === "1") {
  const recorded = [];
  for (const scenario of SCENARIOS) recorded.push({ name: scenario.name, cmd: scenario.cmd, ...(await runLegacy(scenario)) });
  fs.writeFileSync(GOLDEN_URL, JSON.stringify(recorded, null, 2) + "\n");
}
const golden = JSON.parse(fs.readFileSync(GOLDEN_URL, "utf8"));
const OPEN_DIALOG = { kind: "confirm", message: "삭제할까요?", full: "삭제할까요?" };

test("시나리오와 기록이 같은 목록이고 옮긴 QA 명령을 모두 덮는다", () => {
  assert.deepEqual(golden.map((item) => item.name), SCENARIOS.map((item) => item.name));
  const covered = new Set(golden.map((item) => item.cmd));
  assert.deepEqual(QA_COMMAND_NAMES.filter((name) => !covered.has(name)), []);
  for (const name of QA_COMMAND_NAMES) {
    assert.equal(COMMAND_ROUTES[name], "worker", name);
    assert.equal(typeof workerHandlerFor(name), "function", name);
    assert.deepEqual(requiredFeatures(name), ["worker-command-unit", "worker-qa-input-commands"], name);
    assert.equal(runsOutsideQueue(name), false, name);
  }
  assert.deepEqual(Object.keys(WORKER_HANDLERS).filter((name) => name.startsWith("qa-") && QA_COMMAND_NAMES.includes(name)), QA_COMMAND_NAMES);
  // 오류 · 사람 확인 · 로그인 호스트 차단 · 비밀 가림이 모두 기록에 있다
  assert.equal(golden.some((item) => item.response.ok === false && item.response.code === "cdp_blocked"), true);
  assert.equal(golden.some((item) => item.response.ok === false && item.response.code === "window_not_drawing"), true);
  assert.equal(golden.some((item) => item.response.ok === true && item.response.data?.humanRequired === true), true);
  assert.equal(JSON.stringify(golden).includes(PASSWORD), true, "옛 경로의 탭 안 글자 입력(guarded) 효과에 비밀번호 글자가 보여야 가림 검사가 의미 있음");
});

for (const scenario of SCENARIOS) {
  const recorded = golden.find((item) => item.name === scenario.name);
  test(`golden master: ${scenario.name} 은 옛 처리기와 응답·부수 효과(CDP 호출 순서 포함)가 같다`, async () => {
    const worker = createWorkerRun(scenario);
    const { response, effects } = await worker.run();
    assert.deepEqual(response, recorded.response);
    assert.deepEqual(effects, recorded.effects);
    // 단위 규칙: 모든 호출이 사용자 명령 이름으로 묶이고 단위마다 마지막 호출 표시는 많아야 하나
    const units = new Map();
    for (const relay of worker.relays) {
      const list = units.get(relay.commandId) || [];
      list.push(relay);
      units.set(relay.commandId, list);
    }
    for (const relays of units.values()) {
      assert.equal(new Set(relays.map((r) => r.unit.command)).size, 1);
      assert.equal(relays.filter((r) => r.unit.phase === "last").length <= 1, true);
      if (relays.some((r) => r.unit.phase === "last")) assert.equal(relays.at(-1).unit.phase, "last");
      assert.equal(relays.every((r) => r.unit.outside !== true), true);
    }
    // 비밀번호 원문은 worker 가 받은 어떤 응답에도 없다 (worker 가 보낸 호출에도 없다)
    assert.equal(JSON.stringify(worker.relays).includes(PASSWORD), false);
    assert.equal(JSON.stringify(worker.responses).includes(PASSWORD), false);
  });
}

test("옛 처리기를 다시 돌린 응답과 효과가 기록과 같다(기록의 진위)", async () => {
  for (const item of golden) {
    const again = await runLegacy(SCENARIOS.find((scenario) => scenario.name === item.name));
    assert.deepEqual({ response: again.response, effects: again.effects }, { response: item.response, effects: item.effects }, item.name);
  }
});

test("QA 채널의 순서대로 qa-mode 켜기 단위 뒤에 명령 단위가 이어진다", async () => {
  const worker = createWorkerRun(scenarioOf("input-click"));
  await worker.run();
  const ids = [...new Set(worker.relays.map((r) => r.commandId))];
  assert.equal(ids.length, 2);
  const [mode, command] = ids.map((id) => worker.relays.filter((r) => r.commandId === id));
  assert.equal(mode[0].unit.command, "qa-mode");
  assert.deepEqual(mode.map((r) => r.command), ["cdp.gate", "ai.enter", "viewport.ensureReady", "qa.mode", "ai.leave", "result.redact"]);
  assert.deepEqual(mode.find((r) => r.command === "qa.mode").args, { enabled: true });
  assert.equal(command[0].unit.command, "qa-input");
  // 옛 cdpExecRaw·cdpExecInner 순서: 붙임 → AI 표식 → 준비 → 창 그림 검사(focus.state) → 구독 → 실행 → 구독 해제 → 표식 반환 → 가리기(마지막)
  const names = command.map((r) => r.command);
  assert.deepEqual(names.slice(0, 5), ["cdp.gate", "ai.enter", "viewport.ensureReady", "focus.state", "cdp.frames"]);
  assert.equal(names[5], "cdp.subscribe");
  assert.deepEqual(names.slice(-3), ["cdp.unsubscribe", "ai.leave", "result.redact"]);
  assert.equal(command.at(-1).unit.phase, "last");
  assert.deepEqual(command.find((r) => r.command === "cdp.subscribe").args.methods, ["Runtime.bindingCalled"]);
  assert.equal(command.find((r) => r.command === "cdp.subscribe").args.scoped, true);
  // 대기열 안 단위 · 같은 탭 token 으로 이어서 보냄
  assert.equal(new Set(worker.relays.map((r) => r.targetToken.wcId)).size, 1);
});

test("읽기 전용 명령은 AI 표식을 달지 않고 키가 필요한 명령만 창 그림을 따진다", async () => {
  const readOnly = createWorkerRun(scenarioOf("viewport-state-set"));
  await readOnly.run();
  const command = readOnly.relays.filter((r) => r.unit.command === "qa-viewport-state").map((r) => r.command);
  assert.deepEqual(command, ["cdp.gate", "viewport.ensureReady", "viewport.get", "result.redact"]);
  const locate = createWorkerRun(scenarioOf("locate-found"));
  await locate.run();
  const names = locate.relays.filter((r) => r.unit.command === "qa-locate").map((r) => r.command);
  assert.equal(names.includes("ai.enter"), true);
  assert.equal(names.includes("focus.state"), false);
  assert.equal(names.includes("cdp.subscribe"), false);
});

test("옛 목록이 cdp-control.cjs 와 같다: READ_ONLY · NEEDS_KEYS · ANIMATES 에 QA 명령이 없음", () => {
  const names = (source, label) => {
    const match = new RegExp(`const ${label} = new Set\\(\\[([^\\]]*)\\]\\)`).exec(source);
    assert.ok(match, label);
    return match[1].match(/"([^"]+)"/g).map((item) => item.slice(1, -1));
  };
  const observation = read("../native/electron/cdp-observation.cjs");
  assert.deepEqual([...QA_TRAITS.READ_ONLY].sort(), names(CONTROL_SOURCE, "READ_ONLY_CMDS").filter((name) => QA_COMMAND_NAMES.includes(name)).sort());
  assert.deepEqual([...QA_TRAITS.NEEDS_KEYS].sort(), names(CONTROL_SOURCE, "NEEDS_KEYS").filter((name) => QA_COMMAND_NAMES.includes(name)).sort());
  assert.deepEqual(names(observation, "ANIMATES").filter((name) => QA_COMMAND_NAMES.includes(name)), []);
  const bypass = names(CONTROL_SOURCE, "QUEUE_BYPASS");
  assert.deepEqual(bypass.filter((name) => QA_COMMAND_NAMES.includes(name)), []);
  assert.match(CONTROL_SOURCE, /const KEYS_NEED_PAINT = \(cmd\) => NEEDS_KEYS\.has\(cmd\) && cmd !== "login"/);
});

test("처리기가 쓰는 옛 원문 순서가 cdp-control.cjs 에 있다(원본이 바뀌면 사본과 기록을 다시 대조)", () => {
  const inOrder = (from, needles) => {
    for (const needle of needles) {
      const at = CONTROL_SOURCE.indexOf(needle, from);
      assert.equal(at > from, true, needle);
      from = at;
    }
  };
  inOrder(CONTROL_SOURCE.indexOf("async function cdpExecRaw("), ["const noCdp = attachPolicy.blocked(wc.id)", "attachPolicy.touch(wc.id);", "const send = ensureAttached(wc);",
    "const aiTicket = enterAiCommand(wc.id, cmd);", "cdpExecInner(send, wc, cmd, args, webContentsMod)"]);
  // cdpExecInner: QA 준비 → 창 그림 검사 → 붙잡기 → 실행 → 해제
  inOrder(CONTROL_SOURCE.indexOf("async function cdpExecInner("), ["await ensureQaReady(send, wc, cmd);", "paintableProbe(wc.id)", "captureHold(wc.id, true)",
    "runCdpCmd(send, wc, cmd, args, webContentsMod)", "captureHold(wc.id, false)"]);
  // ensureQaReady: QA 탭은 qa-viewport 만 빼고 호스트 확대 보정, 그 밖은 숨은 탭 준비
  assert.match(LEGACY_PARTS.exec.length ? CONTROL_SOURCE : "", /if \(qaContents\.has\(wc\.id\)\) \{ if \(cmd !== "qa-viewport"\) await qaViewportCommands\.reconcile\(send, wc\); return; \}\n  return hiddenViewport\.ensureReady\(send, wc\.id, cmd\);/);
  // 메인이 relay 의 viewport.ensureReady 로 같은 함수를 부름
  assert.match(CONTROL_SOURCE, /ensureReady: async \(wc, command, send\) => \{\n      await ensureQaReady\(send \|\| relaySend\(wc\), wc, command\);/);
  assert.match(CONTROL_SOURCE, /"worker-qa-input-commands"/);
});

test("worker 사본은 원본과 파일 내용이 같다(머리말·import/require·export 줄만 다름)", () => {
  const stripWorker = (text) => text.replace(/^\/\/ worker 사본[^\n]*\n\/\/ 원본은 ⑧에서 지움\n/, "").replace(/^import [^;]*;\n/gm, "")
    .replace(/export \{[^}]*\};/, "").replace(/\n{3,}/g, "\n\n").trim();
  const stripOriginal = (text) => text.replace(/^const \{? ?[^=]*\}? = require\([^)]*\);\n/gm, "").replace(/module\.exports = \{[^}]*\};/, "").replace(/\n{3,}/g, "\n\n").trim();
  assert.equal(stripWorker(read("../server/mcp-worker/qa-input-commands.js")), stripOriginal(read("../native/electron/cdp-qa-input.cjs")));
  assert.equal(stripWorker(read("../server/mcp-worker/qa-keys.js")), stripOriginal(read("../native/electron/cdp-qa-keys.cjs")));
  // 로그인 화면 조회 두 함수 (페이지에 주입되는 inspectLoginPage 는 문자열이 같아야 함)
  const functions = (text) => {
    const start = "// 로그인 칸과 사람 확인이 필요한 화면의 읽기 전용 조회";
    return sliceBetween(text, start, text.includes("function createQaLoginCommands") ? "function createQaLoginCommands" : "export {").trim();
  };
  assert.equal(functions(read("../server/mcp-worker/qa-login-page.js")), functions(read("../native/electron/cdp-qa-login.cjs")));
});

test("로그인 처리기의 응답 문구가 옛 cdp-qa-login.cjs 에 그대로 있다(원본이 바뀌면 worker 처리기를 다시 대조)", () => {
  const legacy = read("../native/electron/cdp-qa-login.cjs");
  const worker = read("../server/mcp-worker/qa-route.js");
  const relay = read("../native/electron/relay/index.cjs");
  for (const text of ["로그인 필드가 올바르지 않습니다", "로그인 승인 후 출처가 바뀌었습니다", "허용된 로그인 계정이 아닙니다", "로그인 입력 전 출처가 바뀌었습니다",
    "결제·본인확인·캡차는 사람이 처리해야 합니다", "로그인 칸이 바뀌었습니다", "비어 있는 로그인 칸에 포커스가 필요합니다", "로그인 입력값이 없습니다",
    "QA 로그인 입력 실패", "사용 가능한 저장 계정이나 로컬 테스트 계정이 없습니다", "로그인 칸을 하나로 확인하지 못했습니다"]) {
    assert.equal(legacy.includes(text), true, `legacy: ${text}`);
    assert.equal(worker.includes(text) || relay.includes(text), true, `worker: ${text}`);
  }
  for (const text of ["로그인 계정 조회 실패", "로그인 계정의 출처가 다릅니다"]) {
    assert.equal(legacy.includes(text), true, `legacy: ${text}`);
    assert.equal(relay.includes(text), true, `relay: ${text}`);
  }
  assert.equal(legacy.includes(".digest(\"hex\").slice(0, 24)") && relay.includes(".digest(\"hex\").slice(0, 24)"), true);
});

test("QA 입력 수신 확인: 구독 이벤트가 없으면 binding 으로만 온 입력은 확인되지 않고, 이벤트가 오면 확인된다", async () => {
  const scenario = scenarioOf("input-click-binding-only");
  const withEvents = await createWorkerRun(scenario).run();
  assert.equal(withEvents.response.ok, true);
  const worker = createWorkerRun(scenario, { listen: false });
  const { response } = await worker.run();
  assert.equal(response.ok, false);
  assert.match(response.error, /수신을 확인하지 못했습니다/);
  // 이벤트 없이도 페이지 쪽 기록이 있으면 확인됨(옛 fromPage 경로)
  const pull = await createWorkerRun(scenarioOf("input-click-page-only"), { listen: false }).run();
  assert.equal(pull.response.ok, true);
});

test("구독은 입력이 끝나면 풀리고, 확인 창으로 막힌 단위에서는 메인이 단위를 닫으며 거둔다", async () => {
  const done = createWorkerRun(scenarioOf("input-click"));
  await done.run();
  assert.equal(done.world.subscribers.size, 0);
  assert.equal(done.relays.filter((r) => r.command === "cdp.subscribe").length, 1);
  assert.equal(done.relays.filter((r) => r.command === "cdp.unsubscribe").length, 1);
  // 구독 뒤 첫 CDP 호출에서 확인 창이 뜸 → 처리기는 멈추고 unsubscribe 는 닫힌 문 뒤라 못 나감
  const blocked = createWorkerRun(scenarioOf("input-click"), {
    onExecute: async (relay) => { if (relay.command === "cdp.subscribe") blocked.hostState.dialog = OPEN_DIALOG; },
  });
  await blocked.accept();
  const response = await blocked.execute();
  assert.equal(response.ok, false);
  assert.equal(response.dialogOpen.kind, "confirm");
  await sleep(60);
  assert.equal(blocked.world.subscribers.size, 0, "scoped 구독을 단위 닫힘 때 거둠");
  assert.equal(blocked.relays.some((r) => r.command === "cdp.unsubscribe"), false);
});

test("확인 창으로 막혀 닫히는 단위는 빌린 사용자 포커스와 capture hold 와 AI 표식을 돌려준다", async () => {
  const scenario = { ...scenarioOf("input-type-borrowed"), env: { shown: false, focus: "borrowed", focusReturn: "returned" } };
  const worker = createWorkerRun(scenario, {
    onExecute: async (relay) => { if (relay.command === "focus.prepare") worker.hostState.dialog = OPEN_DIALOG; },
  });
  await worker.accept();
  const response = await worker.execute();
  assert.equal(response.ok, false);
  assert.equal(response.dialogOpen.kind, "confirm");
  await sleep(60);
  const names = worker.effects.map((e) => e[0] === "cdp" ? e[1] : e[0]);
  assert.equal(names.filter((name) => name === "focus.prepare").length, 1);
  assert.equal(names.filter((name) => name === "focus.return").length, 1, "메인이 단위를 닫으며 포커스를 한 번 반환");
  assert.equal(names.filter((name) => name === "hold").length, 2, "capture hold 걸고 풀기");
  assert.deepEqual(worker.effects.filter((e) => e[0] === "hold").map((e) => e[1]), [true, false]);
  assert.equal(names.filter((name) => name === "ai.leave").length, names.filter((name) => name === "ai.enter").length, "AI 표식이 짝을 맞춤");
  assert.equal(worker.world.subscribers.size, 0);
});

test("F13: 확인 창이 떠 있으면 qa-mode 켜기와 QA 명령은 막히고, qa-mode 해제는 막히지 않는다", async () => {
  const scenario = scenarioOf("input-click");
  const blocked = createWorkerRun(scenario, { hostDialog: OPEN_DIALOG });
  await blocked.accept();
  const response = await blocked.execute();
  assert.equal(response.ok, false);
  assert.deepEqual(response.dialogOpen, { kind: "confirm", message: "삭제할까요?" });
  assert.match(response.error, /qa_dialog/);
  // 켜기 단위만 시작되고 첫 호출에서 막혀 명령 단위는 열리지 않음 · 막힌 단위는 명시 종료로 닫힘
  assert.deepEqual([...new Set(blocked.relays.map((r) => r.unit.command))], ["qa-mode"]);
  assert.equal(blocked.relays.some((r) => r.command === "qa.mode"), false);
  assert.equal(blocked.relays.at(-1).command, "unit.end");

  const off = createWorkerRun({ ...scenarioOf("mode-off"), via: undefined }, { hostDialog: OPEN_DIALOG });
  await off.accept();
  off.world.qaContents.add(WC_ID);
  const released = await off.inContext(() => off.executor.modeOff("tab-a"));
  assert.deepEqual(JSON.parse(JSON.stringify(released)), { ok: true, data: { ok: true } });
  assert.equal(off.relays.every((r) => r.unit.command === "qa-mode-off"), true);
  assert.deepEqual(off.relays.find((r) => r.command === "qa.mode").args, { enabled: false });
  assert.equal(off.world.qaContents.has(WC_ID), false, "확인 창이 떠 있어도 QA 모드가 풀림");
  // 같은 이름의 켜기 단위(qa-mode)는 계속 막힘 · 단위 이름으로만 통과시킴
  assert.equal(qaUnitCommand("qa-mode", { enabled: false }), "qa-mode-off");
  assert.equal(qaUnitCommand("qa-mode", { enabled: true }), "qa-mode");
  assert.equal(qaUnitCommand("qa-input", { enabled: false }), "qa-input");
});

test("qa-dialog-state·qa-dialog-answer 는 단위를 거치지 않고 host 확인 창 연산으로 간다", async () => {
  const worker = createWorkerRun(scenarioOf("input-click"));
  const calls = [];
  const base = worker.hostApi.call;
  worker.hostApi.call = async (operation, input, options) => { calls.push([operation, input]); return operation.startsWith("browser.dialog") ? { ok: true, data: { dialog: null } } : base(operation, input, options); };
  await worker.accept();
  assert.deepEqual(await worker.inContext(() => worker.executor.execute("tab-a", "qa-dialog-state", {})), { ok: true, data: { dialog: null } });
  await worker.inContext(() => worker.executor.execute("tab-a", "qa-dialog-answer", { answer: "ok" }));
  assert.deepEqual(calls.map(([operation]) => operation).filter((name) => name !== "browser.resolveForCommand"), ["browser.dialogState", "browser.dialogAnswer"]);
  assert.equal(calls.find(([operation]) => operation === "browser.dialogAnswer")[1].qa, true);
  assert.equal(worker.relays.length, 0, "확인 창 연산은 qa-mode 도 켜지 않음");
});

test("경로 표를 legacy 로 바꾸면 그 명령만 옛 봉투로 되돌아간다(앱 재시작 불필요)", async () => {
  for (const name of QA_COMMAND_NAMES.filter((item) => item !== "qa-mode")) {
    const scenario = SCENARIOS.find((item) => item.cmd === name && !item.via);
    const worker = createWorkerRun(scenario, { routes: { ...COMMAND_ROUTES, [name]: "legacy" } });
    await worker.run();
    const commands = worker.relays.map((r) => r.command);
    assert.equal(commands.includes(name), true, name);
    const legacy = worker.relays.find((r) => r.command === name);
    assert.equal(legacy.unit == null, true, `${name} 은 단위 표시 없는 옛 봉투`);
    assert.equal(worker.relays.filter((r) => r.unit).every((r) => r.unit.command === "qa-mode"), true, "qa-mode 켜기만 단위");
  }
  const allLegacy = createWorkerRun(scenarioOf("input-click"), { routes: Object.fromEntries(QA_COMMAND_NAMES.map((name) => [name, "legacy"])) });
  await allLegacy.run();
  assert.deepEqual(allLegacy.relays.map((r) => r.command), ["qa-mode", "qa-input"]);
  assert.equal(allLegacy.relays.every((r) => r.unit == null), true);
  // 일반 이름: url 은 단위 실행 기능만 있으면 worker 처리기(wc.info), 경로 표를 legacy 로 바꾸면 옛 봉투
  const plain = createWorkerRun(scenarioOf("input-click"));
  await plain.accept();
  await plain.execute("url", {});
  assert.equal(plain.relays.at(-1).command, "wc.info");
  assert.equal(plain.relays.at(-1).unit?.command, "url");
  const plainLegacy = createWorkerRun(scenarioOf("input-click"), { routes: { ...COMMAND_ROUTES, url: "legacy" } });
  await plainLegacy.accept();
  await plainLegacy.execute("url", {});
  assert.equal(plainLegacy.relays.at(-1).command, "url");
  assert.equal(plainLegacy.relays.at(-1).unit == null, true);
});

test("메인이 worker-qa-input-commands 를 알리지 않으면 옛 봉투로 보낸다(이전 설치 앱과 호환)", async () => {
  for (const features of [[], ["worker-command-unit"], ["worker-qa-input-commands"], ["worker-command-unit", "worker-native-commands"]]) {
    const worker = createWorkerRun(scenarioOf("input-click"), { features });
    await worker.run();
    assert.deepEqual(worker.relays.map((r) => r.command), ["qa-mode", "qa-input"], features.join());
    assert.equal(worker.relays.every((r) => r.unit == null), true);
  }
  const off = createWorkerRun(scenarioOf("mode-off"), { features: [] });
  await off.accept();
  await off.inContext(() => off.executor.modeOff("tab-a"));
  assert.deepEqual(off.relays.map((r) => [r.command, r.unit]), [["qa-mode", null]]);
  assert.deepEqual(off.relays[0].args, { enabled: false });
});

test("비밀번호는 worker 에 오지 않는다: 계정 목록은 공개 필드만, 입력값은 메인이 넣는다", async () => {
  const worker = createWorkerRun(scenarioOf("login-input-password"));
  const { response } = await worker.run();
  assert.equal(response.ok, true);
  assert.equal(response.data.length, PASSWORD.length);
  const accounts = worker.responses.find((item) => item.ok === true && item.data?.accounts);
  assert.deepEqual(Object.keys(accounts.data.accounts[0]).sort(), ["allowed", "id", "local", "username"]);
  assert.equal(accounts.data.accounts[0].id, accountId("qa-user@example.test"));
  const insert = worker.relays.filter((r) => r.command === "login.input");
  assert.deepEqual(insert.map((r) => r.args.qa), ["check", "cdp"]);
  assert.equal(insert.every((r) => !("text" in r.args) && !("password" in r.args)), true);
  assert.equal(worker.relays.some((r) => r.command === "cdp.send" && r.args.method === "Input.insertText" && r.args.params.text.includes("hunter")), false);
  // 메인이 한 번만 읽음 (옛 accountsFor 와 같음)
  assert.equal(worker.effects.filter((e) => e[0] === "login.provider").length, 1);
  // 비밀번호 글자는 메인 안(Input.insertText)에서만 나감
  assert.equal(worker.effects.some((e) => e[0] === "cdp" && e[1] === "Input.insertText" && e[2].text === PASSWORD), true);
});

test("탭 안 글자 입력 경로(사용자 포커스 보호)도 비밀번호는 메인이 글자별로 보낸다", async () => {
  const worker = createWorkerRun(scenarioOf("login-input-password-guarded-chars"));
  const { response } = await worker.run();
  assert.equal(response.ok, true);
  assert.equal(response.data.via, "tab-key-input");
  assert.equal(JSON.stringify(worker.relays).includes(PASSWORD), false);
  assert.deepEqual(worker.effects.filter((e) => e[0] === "wc.input").map((e) => e[1].keyCode).join(""), PASSWORD);
  assert.deepEqual(worker.relays.filter((r) => r.command === "login.input").map((r) => r.args.qa), ["check", "chars"]);
  assert.equal(worker.relays.some((r) => r.command === "wc.input"), false);
});

test("worker 세대가 은퇴하거나 단위가 닫히면 로그인 계정 캐시가 남지 않는다", async () => {
  const worker = createWorkerRun(scenarioOf("login-input-password"));
  await worker.run();
  await sleep(30);
  assert.equal(worker.relay.state?.().commandScopes ?? 0, 0);
});

test("세션 식별값은 호출마다 그대로 전달되고 다른 세션의 호출과 섞이지 않는다", async () => {
  const a = createWorkerRun(scenarioOf("input-click"), { identity: { session: "pane-a", run: "run-a", key: "key-a" }, commandId: `${GENERATION}/a` });
  const b = createWorkerRun(scenarioOf("locate-found"), { identity: { session: "pane-b", run: "run-b", key: "key-b" }, commandId: `${GENERATION}/b` });
  const [ra, rb] = await Promise.all([a.run(), b.run()]);
  assert.equal(ra.response.ok, true);
  assert.equal(rb.response.ok, true);
  assert.equal(a.relays.every((r) => r.commandId.startsWith(`${GENERATION}/a`)), true);
  assert.equal(b.relays.every((r) => r.commandId.startsWith(`${GENERATION}/b`)), true);
  assert.equal(a.relays.every((r) => r.input.controlLabel === "iris-qa" && r.input.answerTool === "qa_dialog"), true);
});

test("같은 탭의 두 QA 명령은 탭 잠금을 단위가 쥐는 동안 겹치지 않는다", async () => {
  const serial = createKeyedSerialExecutor();
  const order = [];
  const gate = { release: null, entered: null };
  const hold = new Promise((resolve) => { gate.release = resolve; });
  const first = createWorkerRun(scenarioOf("input-click"), {
    serial,
    onExecute: async (relay, meta) => {
      order.push(`${meta.commandId}:${relay.command}`);
      if (relay.command === "focus.state") await hold;
    },
  });
  const second = createWorkerRun(scenarioOf("locate-found"), {
    serial, commandId: `${GENERATION}/qa-2`,
    onExecute: async (relay, meta) => { order.push(`${meta.commandId}:${relay.command}`); },
  });
  await Promise.all([first.accept(), second.accept()]);
  const one = first.execute();
  await sleep(40);
  const two = second.execute();
  await sleep(80);
  assert.equal(order.some((entry) => entry.startsWith(`${GENERATION}/qa-2:`) && entry.endsWith(":cdp.gate") && order.indexOf(entry) > -1 && !order.includes(`${GENERATION}/qa-1:result.redact`)), false,
    "앞 단위가 끝나기 전에는 뒤 단위의 기본 명령이 시작되지 않음");
  gate.release();
  const [r1, r2] = await Promise.all([one, two]);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
});

test("window_not_drawing 오류 code 와 문구가 옛 응답과 같다", async () => {
  const worker = createWorkerRun(scenarioOf("input-window-not-drawing"));
  const { response } = await worker.run();
  assert.equal(response.code, "window_not_drawing");
  assert.match(response.error, /^이 탭을 담은 창이 최소화 상태라 화면을 그리지 않습니다 — qa-input 를 보내도 도달하지 않습니다\./);
  // 창 그림 검사에서 멈추면 capture hold·구독을 걸지 않음
  assert.equal(worker.relays.some((r) => ["hold.capture", "cdp.subscribe", "focus.prepare"].includes(r.command)), false);
});

test("옛 응답에 없던 INTERNAL code 는 붙지 않는다(옛 처리기는 code 없는 일반 오류)", async () => {
  for (const name of ["viewport-bad-size", "login-info-provider-error", "login-input-origin-changed", "login-input-empty-password"]) {
    const { response } = await createWorkerRun(scenarioOf(name)).run();
    assert.equal(response.ok, false, name);
    assert.equal("code" in response, false, name);
  }
});

test("host 작업 위임의 qa-mode: 해제는 열린 확인 창에서도 통과하고 켜기는 막힌다", async () => {
  const worker = createWorkerRun(scenarioOf("mode-off"), { hostDialog: OPEN_DIALOG });
  await worker.accept();
  const service = createWorkerHostTaskService({ hostApi: worker.hostApi });
  const task = (enabled) => ({ task: { type: "legacyRelay", target: { tabId: "tab-a", targetToken: { wcId: WC_ID, documentGeneration: 3, debuggerGeneration: 4 } },
    relay: { command: "qa-mode", args: { enabled }, timeoutMs: 10000 } }, identity: { session: "pane", run: "run-1", key: "key-1" }, commandId: `${GENERATION}/host-task` });
  worker.world.qaContents.add(WC_ID);
  const off = JSON.parse(JSON.stringify(await service.dispatch(task(false))));
  assert.deepEqual(off, { ok: true, data: { ok: true } });
  assert.equal(worker.world.qaContents.has(WC_ID), false);
  assert.equal(worker.relays.every((r) => r.unit.command === "qa-mode-off"), true);
  const on = JSON.parse(JSON.stringify(await service.dispatch(task(true))));
  assert.equal(on.ok, false);
  assert.equal(on.dialogOpen.kind, "confirm");
  assert.equal(worker.world.qaContents.has(WC_ID), false, "켜기는 열린 확인 창에 막혀 QA 모드가 켜지지 않음");
});
