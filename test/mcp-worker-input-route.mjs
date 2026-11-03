import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { COMMAND_ROUTES } from "../server/mcp-worker/command-routes.js";
import { INPUT_COMMAND_NAMES, jsClickExpression, nativeRectExpression } from "../server/mcp-worker/input-route.js";
import { CONTROL_SOURCE, LEGACY_PARTS, SCENARIOS, createWorkerRun, runLegacy } from "./fixtures/input-route-scenarios.mjs";

const GOLDEN_URL = new URL("./fixtures/worker-route-input-golden.json", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");

// 옛 처리기 기록 갱신: UPDATE_INPUT_GOLDEN=1 node --test test/mcp-worker-input-route.mjs
if (process.env.UPDATE_INPUT_GOLDEN === "1") {
  const recorded = [];
  for (const scenario of SCENARIOS) recorded.push({ name: scenario.name, cmd: scenario.cmd, ...(await runLegacy(scenario)) });
  fs.writeFileSync(GOLDEN_URL, JSON.stringify(recorded, null, 2) + "\n");
}
const golden = JSON.parse(fs.readFileSync(GOLDEN_URL, "utf8"));

test("시나리오와 기록이 같은 목록이고 옮긴 명령을 모두 덮는다", () => {
  assert.deepEqual(golden.map((item) => item.name), SCENARIOS.map((item) => item.name));
  const covered = new Set(golden.map((item) => item.cmd));
  assert.deepEqual(INPUT_COMMAND_NAMES.filter((name) => !covered.has(name)), []);
  for (const name of INPUT_COMMAND_NAMES) assert.equal(COMMAND_ROUTES[name], "worker", name);
  assert.equal(golden.some((item) => item.response.ok === false && item.response.code), true);
});

for (const scenario of SCENARIOS) {
  const recorded = golden.find((item) => item.name === scenario.name);
  test(`golden master: ${scenario.name} 은 옛 처리기와 응답·부수 효과(CDP 입력 순서 포함)가 같다`, async () => {
    const worker = createWorkerRun(scenario, { legacyResponse: recorded.response });
    const response = await worker.run();
    assert.deepEqual(response, recorded.response);
    assert.deepEqual(worker.effects, recorded.effects);
    // 사용자 포커스를 옮기는 기본 명령은 이번 처리기에서 부르지 않는다
    assert.equal(worker.relays.some((r) => ["focus.prepare", "focus.return", "viewport.apply", "dialog.plan"].includes(r.command)), false);
    // 단위 규칙: 모든 호출이 사용자 명령 이름으로 묶이고 마지막 호출 표시는 많아야 하나
    assert.equal(worker.relays.every((r) => r.unit.command === scenario.cmd), true);
    assert.equal(worker.relays.filter((r) => r.unit.phase === "last").length <= 1, true);
    const lastIndex = worker.relays.findIndex((r) => r.unit.phase === "last");
    if (lastIndex >= 0) assert.equal(lastIndex, worker.relays.filter((r) => r.unit.phase !== "end").length - 1);
    // 성공은 마지막 호출로 닫고 실패는 명시 종료로 닫는다
    const closing = response.ok ? "last" : "end";
    if (response.ok) assert.equal(worker.relays.some((r) => r.unit.phase === closing), true);
    else assert.equal(worker.relays.at(-1).unit.phase === "end" && worker.relays.at(-1).command === "unit.end", true);
    // 실패 응답에는 관찰 순간이 없다 (옛 경로도 비우지 않음)
    if (!response.ok) assert.equal(JSON.stringify(response).includes("moments"), false);
  });
}

test("옛 처리기를 다시 돌린 응답과 효과가 기록과 같다(기록의 진위)", async () => {
  for (const item of golden) {
    const again = await runLegacy(SCENARIOS.find((scenario) => scenario.name === item.name));
    assert.deepEqual({ response: again.response, effects: again.effects }, { response: item.response, effects: item.effects }, item.name);
  }
});

test("처리기가 쓰는 옛 원문 구간이 cdp-control.cjs 에 있다(원본이 바뀌면 사본과 기록을 다시 대조)", () => {
  for (const [name, text] of Object.entries(LEGACY_PARTS)) assert.equal(text.length > 50, true, name);
  // 입력 명령의 옛 순서: 붙임 → AI 표식 → (cdpExecInner) ensureReady → 창 그림 검사 → hold → 처리기 → 애니메이션 → hold 해제, 마지막에 표식 반환
  const inOrder = (from, needles) => {
    for (const needle of needles) {
      const at = CONTROL_SOURCE.indexOf(needle, from);
      assert.equal(at > from, true, needle);
      from = at;
    }
  };
  inOrder(CONTROL_SOURCE.indexOf("async function cdpExecRaw("), ["attachPolicy.touch(wc.id)", "enterAiCommand(wc.id, cmd)", "cdpExecInner(send, wc, cmd, args, webContentsMod)", "leaveAiCommand(aiTicket)"]);
  inOrder(CONTROL_SOURCE.indexOf("async function cdpExecInner("), ["await ensureQaReady(send, wc, cmd)", "paintableProbe(wc.id)", "captureHold(wc.id, true)",
    "runCdpCmd(send, wc, cmd, args, webContentsMod)", "observation.settleAnimations(send)", "captureHold(wc.id, false)"]);
});

test("worker 사본은 원본과 파일 내용이 같다(머리말·export 줄만 다름)", () => {
  const strip = (text) => text.replace(/^\/\/ worker 사본[^\n]*\n\/\/ 원본은 ⑧에서 지움\n/, "")
    .replace(/module\.exports = \{[^}]*\};/, "").replace(/export \{[^}]*\};/, "").trim();
  assert.equal(strip(read("../server/mcp-worker/input-commands.js")), strip(read("../native/electron/cdp-cmd-input.cjs")));
  assert.equal(strip(read("../server/mcp-worker/layout.js")), strip(read("../native/electron/cdp-layout.cjs")));
  assert.equal(strip(read("../server/mcp-worker/text-insert.js")), LEGACY_PARTS.insert.trim());
});

test("settleAnimations 사본은 옛 구현과 같은 식을 보내고 같은 조건에서 멈춘다", async () => {
  const { settleAnimations } = await import("../server/mcp-worker/settle.js");
  const observation = (await import("node:module")).createRequire(import.meta.url)("../native/electron/cdp-observation.cjs");
  const legacy = observation.createObservation({ captureHold: () => false, isTabShown: () => false, now: Date.now, shotsDir: "/nonexistent", captureMoment: async () => null });
  const run = async (settle) => {
    const sent = [];
    let running = 2;
    await settle(async (method, params) => { sent.push([method, params]); return { result: { value: running-- } }; });
    return sent;
  };
  assert.deepEqual(await run((send) => settleAnimations(send, 0, { wait: async () => {} })), await run((send) => legacy.settleAnimations(send)));
  assert.equal((await run((send) => settleAnimations(send, 0, { wait: async () => {} }))).length, 3);
});

test("selector 클릭의 페이지 식은 옛 nativeClickSel·jsClickSel 이 보낸 문자열과 같다", () => {
  const sources = (name) => golden.find((item) => item.name === name).effects.filter((e) => e[0] === "wc.exec").map((e) => e[1]);
  assert.deepEqual(sources("click-sel-native"), [nativeRectExpression("#save")]);
  assert.deepEqual(sources("dblclick-sel-native"), [nativeRectExpression("#save")]);
  assert.deepEqual(sources("click-sel-js-hidden-tab"), [jsClickExpression("#save", 1)]);
});

test("경로 표를 legacy 로 바꾸면 옛 입력 봉투 하나로 간다", async () => {
  const scenario = SCENARIOS.find((item) => item.name === "click-ref-input");
  const recorded = golden.find((item) => item.name === scenario.name);
  const worker = createWorkerRun(scenario, { legacyResponse: recorded.response, routes: { ...COMMAND_ROUTES, click: "legacy" } });
  // legacy 봉투는 이 대역이 처리하지 않으므로 중계 명령 이름만 확인
  await worker.run().catch(() => {});
  assert.deepEqual(worker.relays.map((r) => [r.command, r.unit]), [["click", undefined]]);
});

test("입력 기능을 알리지 않는 메인(지금 설치 앱)과는 옛 입력 봉투로 간다", async () => {
  for (const features of [["worker-command-unit"], [], ["worker-input-commands"]]) {
    const scenario = SCENARIOS.find((item) => item.name === "fill-ref-input");
    const worker = createWorkerRun(scenario, { features });
    await worker.run().catch(() => {});
    assert.deepEqual(worker.relays.map((r) => [r.command, r.unit]), [["fill", undefined]], JSON.stringify(features));
  }
});

test("표에 없는 입력 명령(mouse·phone*·QA 입력)은 옛 봉투로 간다", async () => {
  for (const cmd of ["mouse", "phonekey", "phonetype", "phonefocus"]) {
    const scenario = { ...SCENARIOS[0], cmd, args: {} };
    const worker = createWorkerRun(scenario, {});
    await worker.run().catch(() => {});
    assert.deepEqual(worker.relays.map((r) => r.command), [cmd], cmd);
  }
});

test("처리 중 확인 창이 막으면 막힌 응답을 돌려주고 정리 호출 없이 단위를 명시 종료한다", async () => {
  const scenario = SCENARIOS.find((item) => item.name === "fill-ref-hidden-tab-hold");
  // cdp.send 4번째에서 확인 창이 열림 (hold 를 얻고 처리기 안에서)
  const worker = createWorkerRun(scenario, { blockAt: 3 });
  const response = await worker.run();
  assert.equal(response.dialogOpen.kind, "alert");
  assert.equal(worker.relays.at(-1).command, "unit.end");
  // 막힌 문 뒤라 ai.leave·hold 해제를 보내지 않음 (메인이 단위가 닫힐 때 반환)
  assert.equal(worker.relays.some((r) => r.command === "ai.leave"), false);
  assert.deepEqual(worker.effects.filter((e) => e[0] === "hold"), [["hold", true]]);
  assert.equal(worker.relays.filter((r) => r.command === "hold.capture").length, 1);
});

test("확인 창이 ref.resolve 나 cdp.attach 단계에서 막아도 응답을 그대로 돌려준다", async () => {
  const scenario = SCENARIOS.find((item) => item.name === "click-ref-input");
  const worker = createWorkerRun(scenario, { blockAt: 1 });
  const response = await worker.run();
  assert.equal(response.dialogOpen.message, "열림");
  assert.equal(worker.relays.at(-1).command, "unit.end");
});

test("최종 응답(오류 포함)은 메인의 비밀 가리기를 거친다: 저장된 비밀이 든 bulkfill 실패 메시지가 옛 경로와 같게 가려진다", async () => {
  const scenario = SCENARIOS.find((item) => item.name === "bulkfill-stops-secret");
  const recorded = golden.find((item) => item.name === scenario.name);
  assert.equal(JSON.stringify(recorded.response).includes("hunter2-pw"), false);
  assert.equal(JSON.stringify(recorded.response).includes("••••"), true);
  const worker = createWorkerRun(scenario, { legacyResponse: recorded.response });
  assert.deepEqual(await worker.run(), recorded.response);
  const error = createWorkerRun({ ...SCENARIOS.find((item) => item.name === "click-ref-unknown"), env: { ...SCENARIOS[0].env, secret: "알 수 없는" } }, {});
  assert.equal(JSON.stringify(await error.run()).includes("알 수 없는"), false);
});

test("처리 실패 때 ai.leave 는 마지막 표시 없이 보내고 단위는 명시 종료한다", async () => {
  const scenario = SCENARIOS.find((item) => item.name === "click-ref-box-failure");
  const worker = createWorkerRun(scenario, {});
  const response = await worker.run();
  assert.equal(response.ok, false);
  const leave = worker.relays.find((r) => r.command === "ai.leave");
  assert.equal(leave.unit.phase, "run");
  assert.deepEqual(worker.relays.slice(-3).map((r) => [r.command, r.unit.phase]), [["ai.leave", "run"], ["result.redact", "run"], ["unit.end", "end"]]);
});

test("성공 응답은 가리기 호출(result.redact)이 마지막 호출이고 관찰 순간은 그 응답에서 붙는다", async () => {
  const scenario = SCENARIOS.find((item) => item.name === "click-ref-input");
  const worker = createWorkerRun(scenario, {});
  const response = await worker.run();
  assert.deepEqual(worker.relays.slice(-2).map((r) => [r.command, r.unit.phase]), [["ai.leave", "run"], ["result.redact", "last"]]);
  assert.deepEqual(worker.relays.at(-1).command, "result.redact");
  assert.equal(worker.relays.at(-1).unit.phase, "last");
  assert.deepEqual(response.data.moments, [{ kind: "toast", text: "저장됨" }]);
});

test("selector 클릭 성공은 result.redact 가 마지막 호출이고 AI 표식·붙임을 건드리지 않는다", async () => {
  const scenario = SCENARIOS.find((item) => item.name === "click-sel-native");
  const worker = createWorkerRun(scenario, {});
  const response = await worker.run();
  assert.equal(response.ok, true);
  assert.equal(worker.relays.some((r) => ["ai.enter", "ai.leave", "cdp.attach", "cdp.send"].includes(r.command)), false);
  assert.deepEqual(worker.relays.at(-1).command, "result.redact");
  assert.equal(worker.relays.at(-1).unit.phase, "last");
});

test("cdp.detachIdle 이 올린 debugger 세대는 이후 호출의 target token 에 쓴다", async () => {
  const scenario = SCENARIOS.find((item) => item.name === "click-sel-native");
  const worker = createWorkerRun(scenario, {});
  await worker.run();
  assert.equal(worker.relays[0].command, "cdp.detachIdle");
  assert.equal(worker.relays[0].targetToken.debuggerGeneration, 4);
  assert.equal(worker.relays.slice(1).every((r) => r.targetToken.debuggerGeneration === 9), true);
});

test("세션 식별은 요청마다 그대로 전달하고 worker 전역 현재 세션을 두지 않는다", async () => {
  const source = read("../server/mcp-worker/input-route.js");
  assert.equal(/globalThis\.|process\.env|currentSession/.test(source), false);
  assert.equal(/^let /m.test(source), false);
});

test("withLayout 의 Emulation 호출만 임시 layout 표시를 달고 나머지 cdp.send 는 표시가 없다", async () => {
  const scenario = SCENARIOS.find((item) => item.name === "click-ref-hidden-layout");
  const worker = createWorkerRun(scenario, {});
  await worker.run();
  const sends = worker.relays.filter((r) => r.command === "cdp.send");
  const marked = sends.filter((r) => r.args.temporaryLayout === true).map((r) => r.args.method);
  assert.deepEqual(marked, ["Emulation.setDeviceMetricsOverride", "Emulation.clearDeviceMetricsOverride"]);
  assert.equal(sends.filter((r) => r.args.temporaryLayout !== true).every((r) => !r.args.method.startsWith("Emulation.")), true);
});
