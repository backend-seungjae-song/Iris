import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { COMMAND_ROUTES, requiredFeatures } from "../server/mcp-worker/command-routes.js";
import { DRAW_MARKS } from "../server/mcp-worker/draw-marks.js";
import { PAGE_COMMAND_NAMES } from "../server/mcp-worker/page-route.js";
import { CONTROL_SOURCE, LEGACY_DRAW_MARKS, SCENARIOS, SCRATCH, createWorkerRun, runLegacy } from "./fixtures/page-route-scenarios.mjs";

const GOLDEN_URL = new URL("./fixtures/worker-route-page-golden.json", import.meta.url);
const read = (file) => fs.readFileSync(new URL(file, import.meta.url), "utf8");
const RUN = `t${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
// 파일 이름의 밀리초 시각이 겹치지 않게 · 대역 캡처는 즉시 끝나 shotsizes 의 두 장이 같은 이름으로 덮어써짐
const realNow = Date.now;
async function uniqueNow(fn) {
  let last = 0;
  Date.now = () => (last = Math.max(realNow(), last + 1));
  try { return await fn(); } finally { Date.now = realNow; }
}
const rootOf = (name, side) => path.join(SCRATCH, RUN, name, side);
const scenarioOf = (name) => SCENARIOS.find((item) => item.name === name);

// 옛 처리기 기록 갱신: UPDATE_PAGE_GOLDEN=1 node --test test/mcp-worker-page-route.mjs
if (process.env.UPDATE_PAGE_GOLDEN === "1") {
  const recorded = [];
  for (const scenario of SCENARIOS) recorded.push({ name: scenario.name, cmd: scenario.cmd, ...(await uniqueNow(() => runLegacy(scenario, rootOf(scenario.name, "record")))) });
  fs.writeFileSync(GOLDEN_URL, JSON.stringify(recorded, null, 2) + "\n");
}
const golden = JSON.parse(fs.readFileSync(GOLDEN_URL, "utf8"));

test("시나리오와 기록이 같은 목록이고 옮긴 명령을 모두 덮는다", () => {
  assert.deepEqual(golden.map((item) => item.name), SCENARIOS.map((item) => item.name));
  const covered = new Set(golden.map((item) => item.cmd));
  assert.deepEqual(PAGE_COMMAND_NAMES.filter((name) => !covered.has(name)), []);
  for (const name of PAGE_COMMAND_NAMES) {
    assert.equal(COMMAND_ROUTES[name], "worker", name);
    assert.deepEqual(requiredFeatures(name), ["worker-command-unit", "worker-page-commands"], name);
  }
  assert.equal(golden.some((item) => item.response.ok === false && item.response.code === "cdp_blocked"), true);
  assert.equal(golden.some((item) => item.response.ok === false && item.response.code === "window_not_drawing"), true);
});

test("옮긴 명령 목록: 일반 MCP 에서 막힌 expect 와 폰 앱 경로 remoteframe·remotewheel 은 없다", () => {
  assert.equal(PAGE_COMMAND_NAMES.includes("expect"), false);
  assert.equal(COMMAND_ROUTES.expect, undefined);
  for (const name of ["remoteframe", "remotewheel", "a11y", "url", "snapshot"]) assert.equal(PAGE_COMMAND_NAMES.includes(name), false, name);
});

for (const scenario of SCENARIOS) {
  const recorded = golden.find((item) => item.name === scenario.name);
  test(`golden master: ${scenario.name} 은 옛 처리기와 응답·부수 효과(CDP 호출 순서)·쓴 파일이 같다`, async () => {
    const worker = createWorkerRun(scenario, rootOf(scenario.name, "worker"));
    const result = await uniqueNow(() => worker.run());
    assert.deepEqual(result.response, recorded.response);
    assert.deepEqual(result.effects, recorded.effects);
    assert.deepEqual(result.files, recorded.files);
    // 사용자 포커스·계획·QA 를 건드리는 기본 명령은 부르지 않는다 (viewport 명령의 viewport.apply 만 옛 경로처럼 사람 viewport 를 바꿈)
    assert.equal(worker.relays.some((r) => ["focus.prepare", "focus.return", "dialog.plan", "viewport.setTemporary", "viewport.qa", "qa.mode"].includes(r.command)), false);
    assert.equal(worker.relays.some((r) => r.command === "viewport.apply") && scenario.cmd !== "viewport" && scenario.cmd !== "shotsizes", false);
    // 단위 규칙: 모든 호출이 사용자 명령 이름으로 묶이고 마지막 호출 표시는 많아야 하나
    assert.equal(worker.relays.every((r) => r.unit.command === scenario.cmd), true);
    assert.equal(worker.relays.filter((r) => r.unit.phase === "last").length <= 1, true);
    const lastIndex = worker.relays.findIndex((r) => r.unit.phase === "last");
    if (lastIndex >= 0) assert.equal(lastIndex, worker.relays.filter((r) => r.unit.phase !== "end").length - 1);
    // 앞 단계 순서: 첫 호출은 cdp.gate, 마지막은 result.redact(성공은 last, 실패는 last 없이 unit.end)
    assert.equal(worker.relays[0].command, "cdp.gate");
    const closing = result.response.ok ? "last" : "end";
    if (result.response.ok) assert.equal(worker.relays.at(-1).command === "result.redact" && worker.relays.at(-1).unit.phase === closing, true);
    else assert.equal(worker.relays.at(-1).unit.phase === "end" && worker.relays.at(-1).command === "unit.end", true);
    // 실패 응답에는 관찰 순간이 없다 (옛 경로도 비우지 않음)
    if (!result.response.ok) assert.equal(JSON.stringify(result.response).includes("moments"), false);
  });
}

test("옛 처리기를 다시 돌린 응답과 효과·파일이 기록과 같다(기록의 진위)", async () => {
  for (const item of golden) {
    const again = await uniqueNow(() => runLegacy(scenarioOf(item.name), rootOf(item.name, "again")));
    assert.deepEqual(again, { response: item.response, effects: item.effects, files: item.files }, item.name);
  }
});

test("처리기가 쓰는 옛 원문 순서가 cdp-control.cjs 에 있다(원본이 바뀌면 사본과 기록을 다시 대조)", () => {
  const inOrder = (from, needles) => {
    for (const needle of needles) {
      const at = CONTROL_SOURCE.indexOf(needle, from);
      assert.equal(at > from, true, needle);
      from = at;
    }
  };
  // 옛 순서: noCdp 판정 → 세션 떼기 → CDP 없이 되는 명령만 → 붙임 → AI 표식 → ensureReady → 창 그림 검사 → hold → 처리기 → 애니메이션 → hold 해제 → 표식 반환
  inOrder(CONTROL_SOURCE.indexOf("async function cdpExecRaw("), ["const noCdp = attachPolicy.blocked(wc.id) || (cmd === \"goto\" && isGoogleAuthUrl(gotoTarget(args.url)));",
    "detachAiSession(wc);", "if (!CDP_FREE_CMDS.has(cmd)) {", "runWithoutCdp(wc, cmd, args)", "attachPolicy.touch(wc.id);", "ensureAttached(wc);",
    "enterAiCommand(wc.id, cmd)", "cdpExecInner(send, wc, cmd, args, webContentsMod)", "leaveAiCommand(aiTicket)"]);
  inOrder(CONTROL_SOURCE.indexOf("async function cdpExecInner("), ["await ensureQaReady(send, wc, cmd)", "paintableProbe(wc.id)", "captureHold(wc.id, true)",
    "runCdpCmd(send, wc, cmd, args, webContentsMod)", "observation.settleAnimations(send)", "captureHold(wc.id, false)"]);
  // 메인의 cdp.gate 는 같은 판정·같은 순서
  inOrder(CONTROL_SOURCE.indexOf("  gate: (wc, command, args) => {"), ["attachPolicy.blocked(wc.id) || (command === \"goto\" && isGoogleAuthUrl(gotoTarget(args && args.url)))",
    "detachAiSession(wc);", "CDP_FREE_CMDS.has(command)", "cdp_blocked".length ? "ERROR_CODES.CDP_BLOCKED" : "", "attachPolicy.touch(wc.id);", "ensureAttached(wc);"]);
  // 읽기 전용 명령 표(AI 표식을 달지 않는 명령)가 worker 의 표와 같다
  const readOnly = /const READ_ONLY_CMDS = new Set\(\[([^\]]*)\]\)/.exec(CONTROL_SOURCE)[1].match(/"[a-z-]+"/g).map((item) => item.slice(1, -1));
  const workerSource = read("../server/mcp-worker/page-route.js");
  const workerReadOnly = /const READ_ONLY = new Set\(\[([^\]]*)\]\)/.exec(workerSource)[1].match(/"[a-z]+"/g).map((item) => item.slice(1, -1));
  assert.deepEqual(workerReadOnly.filter((name) => !readOnly.includes(name)), []);
  assert.deepEqual(PAGE_COMMAND_NAMES.filter((name) => readOnly.includes(name)).sort(), [...workerReadOnly].sort());
  const animates = /const ANIMATES = new Set\(\[([^\]]*)\]\)/.exec(read("../native/electron/cdp-observation.cjs"))[1].match(/"[a-z]+"/g).map((item) => item.slice(1, -1));
  const workerAnimates = /const ANIMATES = new Set\(\[([^\]]*)\]\)/.exec(workerSource)[1].match(/"[a-z]+"/g).map((item) => item.slice(1, -1));
  assert.deepEqual(PAGE_COMMAND_NAMES.filter((name) => animates.includes(name)).sort(), [...workerAnimates].sort());
});

test("worker 사본은 원본과 파일 내용이 같다(머리말·export 줄만 다르고, 하나뿐인 await 차이는 명시)", () => {
  const strip = (text) => text.replace(/^\/\/ worker 사본[^\n]*\n\/\/ 원본은 ⑧에서 지움\n(\/\/ 다른 점[^\n]*\n)?/, "")
    .replace(/module\.exports = \{[^}]*\};/, "").replace(/export \{[^}]*\};/, "").trim();
  assert.equal(strip(read("../server/mcp-worker/inspect-commands.js")), strip(read("../native/electron/cdp-cmd-inspect.cjs")));
  assert.equal(strip(read("../server/mcp-worker/capture-commands.js")),
    strip(read("../native/electron/cdp-cmd-capture.cjs")).replace("if (args.sameAs && samePng(String(args.sameAs), png)) {", "if (args.sameAs && await samePng(String(args.sameAs), png)) {"));
  assert.equal(DRAW_MARKS, LEGACY_DRAW_MARKS);
});

test("촬영 도구 사본의 함수 본문은 cdp-capture-tools.cjs 와 같다(rectOf 의 ref 조회 한 줄만 비동기)", () => {
  const original = read("../native/electron/cdp-capture-tools.cjs");
  const copy = read("../server/mcp-worker/capture-tools.js");
  const part = (text, from, to) => {
    const start = text.indexOf(from);
    const end = text.indexOf(to, start);
    assert.equal(start >= 0 && end > start, true, from);
    return text.slice(start, end);
  };
  const same = (from, to, patch = (text) => text) => assert.equal(copy.includes(patch(part(original, from, to))), true, from);
  same("  // 그리기가 끝난 뒤에 찍는다.", "  // 이어 붙이기. nativeImage");
  same("  // 표시할 사각형(문서 좌표).", "  // QA 한 번에 스크린샷이 여러 장", (text) => text.replace("const e = refRegistry.resolveRef(wc.id, m.ref);", "const e = await resolveRef(m.ref);"));
  same("  // QA 한 번에 스크린샷이 여러 장", "  // 두 PNG를 픽셀로 비교해");
});

test("경로 표를 legacy 로 바꾸면 옛 봉투 하나로 간다(명령마다)", async () => {
  for (const name of PAGE_COMMAND_NAMES) {
    const scenario = SCENARIOS.find((item) => item.cmd === name);
    const worker = createWorkerRun(scenario, rootOf(scenario.name, "legacy-route"), { routes: { ...COMMAND_ROUTES, [name]: "legacy" } });
    await worker.run().catch(() => {});
    assert.deepEqual(worker.relays.map((r) => [r.command, r.unit]), [[name, undefined]], name);
  }
});

test("페이지 기능을 알리지 않는 메인(지금 설치 앱)과는 옛 봉투로 간다", async () => {
  for (const features of [["worker-command-unit"], [], ["worker-page-commands"], ["worker-command-unit", "worker-input-commands"]]) {
    const scenario = scenarioOf("eval-value");
    const worker = createWorkerRun(scenario, rootOf("eval-value", "features"), { features });
    await worker.run().catch(() => {});
    assert.deepEqual(worker.relays.map((r) => [r.command, r.unit]), [["eval", undefined]], JSON.stringify(features));
  }
});

test("expect 는 일반 MCP 에서 막혀 worker 처리기에 닿지 않는다", async () => {
  const worker = createWorkerRun({ ...scenarioOf("eval-value"), cmd: "expect", args: { sel: "#a" } }, rootOf("eval-value", "expect-denied"));
  const { response } = await worker.run();
  assert.equal(response.ok, false);
  assert.equal(worker.relays.length, 0);
});

test("로그인 호스트에서 CDP 가 필요한 명령은 cdp_blocked 로 끝나고 CDP 호출이 없다", async () => {
  for (const name of ["eval-on-blocked-host"]) {
    const worker = createWorkerRun(scenarioOf(name), rootOf(name, "blocked"));
    const { response, effects } = await worker.run();
    assert.equal(response.code, "cdp_blocked");
    assert.equal(effects.some((e) => e[0] === "cdp"), false);
    assert.equal(worker.relays.some((r) => r.command === "ai.enter"), false);
  }
});

test("처리 중 확인 창이 막으면 막힌 응답을 돌려주고 정리 호출 없이 단위를 명시 종료한다", async () => {
  const scenario = scenarioOf("goto-hidden-tab-hold");
  // 안 보이는 탭의 goto: hold → 이동 → 애니메이션 대기(cdp.send)에서 확인 창이 열림
  const worker = createWorkerRun(scenario, rootOf(scenario.name, "block"), { blockAt: 1 });
  const { response } = await worker.run();
  assert.equal(response.dialogOpen.kind, "alert");
  assert.equal(worker.relays.at(-1).command, "unit.end");
  // 막힌 문 뒤라 ai.leave·hold 해제를 보내지 않음 (메인이 단위가 닫힐 때 반환)
  assert.equal(worker.relays.some((r) => r.command === "ai.leave"), false);
  assert.deepEqual(worker.effects.filter((e) => e[0] === "hold"), [["hold", true]]);
  assert.equal(worker.relays.filter((r) => r.command === "hold.capture").length, 1);
});

test("확인 창이 cdp.gate 단계에서 막아도 응답을 그대로 돌려준다", async () => {
  const worker = createWorkerRun(scenarioOf("text-cdp"), rootOf("text-cdp", "block-gate"), { blockCommand: "cdp.gate" });
  const { response } = await worker.run();
  assert.equal(response.dialogOpen.message, "열림");
  assert.deepEqual(worker.relays.map((r) => r.command), ["cdp.gate", "unit.end"]);
});

test("이동하며 올라간 문서 세대는 이후 호출의 target token 에 쓴다(hold 해제·가리기 포함)", async () => {
  const scenario = scenarioOf("goto-hidden-tab-hold");
  const worker = createWorkerRun(scenario, rootOf(scenario.name, "token"));
  const { response } = await worker.run();
  assert.equal(response.ok, true);
  const navAt = worker.relays.findIndex((r) => r.command === "wc.nav");
  assert.equal(navAt > 0, true);
  assert.equal(worker.relays[navAt].targetToken.documentGeneration, 3);
  for (const relay of worker.relays.slice(navAt + 1)) assert.equal(relay.targetToken.documentGeneration, 4, relay.command);
  assert.equal(worker.relays.some((r) => r.command === "hold.capture" && r.args.on === false), true);
});

test("wait 도중 문서 세대가 바뀌면 cdp.sync 로 맞추고 이어서 기다린다", async () => {
  const scenario = scenarioOf("wait-ready");
  const worker = createWorkerRun(scenario, rootOf(scenario.name, "stale"), { staleOnce: { method: "Runtime.evaluate", remaining: 1 } });
  const { response } = await worker.run();
  assert.equal(response.ok, true);
  assert.equal(response.data.readyState, "complete");
  const syncAt = worker.relays.findIndex((r) => r.command === "cdp.sync");
  assert.equal(syncAt > 0, true);
  assert.equal(worker.relays[syncAt + 1].command, "cdp.send");
  assert.equal(worker.relays[syncAt + 1].targetToken.documentGeneration, 4);
});

test("명령 도중 문서가 바뀌어도 최종 응답은 세대 검사 없이 가려져 나간다(result.redact)", async () => {
  const scenario = scenarioOf("eval-value");
  const worker = createWorkerRun(scenario, rootOf(scenario.name, "redact-stale"), { bumpAfterSend: true });
  const result = await worker.run();
  assert.equal(result.response.ok, true);
  assert.deepEqual(result.response.data.value, 2);
  const redact = worker.relays.at(-1);
  assert.equal(redact.command, "result.redact");
  assert.equal(redact.targetToken.documentGeneration, 3);
});

test("처리기 오류(eval 예외·창 그림 없음)는 last 없이 가려지고 단위가 명시 종료된다", async () => {
  for (const name of ["eval-exception", "screenshot-window-not-drawing", "goto-load-error"]) {
    const worker = createWorkerRun(scenarioOf(name), rootOf(name, "failure"));
    const { response } = await worker.run();
    assert.equal(response.ok, false, name);
    const redact = worker.relays.find((r) => r.command === "result.redact");
    assert.equal(redact.unit.phase, "run", name);
    assert.equal(worker.relays.at(-1).command, "unit.end", name);
  }
});

test("ref 로 표시하는 촬영은 메인 registry 를 ref.resolve 로 읽는다", async () => {
  const worker = createWorkerRun(scenarioOf("screenshot-marks-caption"), rootOf("screenshot-marks-caption", "ref"));
  const { response } = await worker.run();
  assert.equal(response.ok, true);
  const resolves = worker.relays.filter((r) => r.command === "ref.resolve");
  assert.deepEqual(resolves.map((r) => r.args), [{ ref: "@e1" }]);
  const missing = new Map([["screenshot-ref-no-snapshot", "@zz"]]);
  for (const [name, ref] of missing) {
    const run = createWorkerRun(scenarioOf(name), rootOf(name, "ref-missing"));
    const result = await run.run();
    assert.deepEqual(result.response.data.missing.length, 1, name);
    assert.equal(result.response.data.missing[0].startsWith(ref), true, name);
  }
});

test("스크린샷은 상태 폴더의 artifacts/shots 에 저장한다(IRIS_STATE_DIR 기준)", async () => {
  const root = rootOf("screenshot-shown", "where");
  const worker = createWorkerRun(scenarioOf("screenshot-shown"), root);
  const { response, files } = await worker.run();
  assert.match(response.data.path, /^<RUN>\/artifacts\/shots\/shot-<T>\.png$/);
  assert.equal(files.some((item) => item.file.startsWith("shots/")), true);
});
