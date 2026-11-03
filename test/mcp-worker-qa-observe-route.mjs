import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { sliceBetween } from "../bin/slice-anchor.mjs";

import { ordinaryCommandDenied } from "../server/qa-command-contract.js";
import { COMMAND_ROUTES, WORKER_HANDLERS, requiredFeatures, runsOutsideQueue, workerHandlerFor } from "../server/mcp-worker/command-routes.js";
import { createWorkerHostTaskService } from "../server/mcp-worker/host-task-service.js";
import { QA_OBSERVE_COMMAND_NAMES, QA_OBSERVE_TRAITS, pngSize } from "../server/mcp-worker/qa-observe-route.js";
import { QA_COMMAND_NAMES } from "../server/mcp-worker/qa-route.js";
import {
  CONTROL_SOURCE, EVENTS, EXPECT_SECRET_SCENARIO, GENERATION, SCENARIOS, SCRATCH, SECRET, WC_ID, createWorkerRun, pngOf, runLegacy,
} from "./fixtures/qa-observe-route-scenarios.mjs";
import { SCENARIOS as PAGE_SCENARIOS, SCRATCH as PAGE_SCRATCH, createWorkerRun as createPageRun } from "./fixtures/page-route-scenarios.mjs";

const GOLDEN_URL = new URL("./fixtures/worker-route-qa-observe-golden.json", import.meta.url);
const read = (file) => fs.readFileSync(new URL(file, import.meta.url), "utf8");
// 임시 폴더 이름은 시각만 쓰면 동시에 띄운 실행끼리 겹쳐 pid 와 난수를 붙인다
const RUN = `t${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const rootOf = (name, side) => path.join(SCRATCH, RUN, name, side);
const scenarioOf = (name) => SCENARIOS.find((item) => item.name === name);
const cmdsOf = (scenario) => (scenario.steps || [scenario]).map((step) => step.cmd).filter(Boolean);

// 옛 처리기 기록 갱신: UPDATE_QA_OBSERVE_GOLDEN=1 node --test test/mcp-worker-qa-observe-route.mjs
if (process.env.UPDATE_QA_OBSERVE_GOLDEN === "1") {
  const recorded = [];
  for (const scenario of SCENARIOS) recorded.push({ name: scenario.name, cmds: cmdsOf(scenario), ...(await runLegacy(scenario, rootOf(scenario.name, "record"))) });
  fs.writeFileSync(GOLDEN_URL, JSON.stringify(recorded, null, 2) + "\n");
}
const golden = JSON.parse(fs.readFileSync(GOLDEN_URL, "utf8"));

test("시나리오와 기록이 같은 목록이고 옮긴 QA 명령을 모두 덮는다", () => {
  assert.deepEqual(golden.map((item) => item.name), SCENARIOS.map((item) => item.name));
  const covered = new Set(golden.flatMap((item) => item.cmds));
  assert.deepEqual(QA_OBSERVE_COMMAND_NAMES.filter((name) => !covered.has(name)), []);
  for (const name of QA_OBSERVE_COMMAND_NAMES) {
    assert.equal(COMMAND_ROUTES[name], "worker", name);
    assert.equal(typeof workerHandlerFor(name), "function", name);
    assert.deepEqual(requiredFeatures(name), ["worker-command-unit", "worker-qa-input-commands", "worker-qa-observe-commands"], name);
    assert.equal(runsOutsideQueue(name), false, name);
    // QA 전용 이름이라 일반 MCP 명령으로 고를 수 없다
    assert.equal(ordinaryCommandDenied(name), true, name);
    assert.equal(QA_COMMAND_NAMES.includes(name), false, `6a 표와 겹치지 않음: ${name}`);
  }
  assert.deepEqual(Object.keys(WORKER_HANDLERS).filter((name) => QA_OBSERVE_COMMAND_NAMES.includes(name)), QA_OBSERVE_COMMAND_NAMES);
  // 오류 · 로그인 호스트 차단 · 비밀 가림 · 창 그림 검사 · 장면 파일이 모두 기록에 있다
  const flat = golden.flatMap((item) => item.responses);
  assert.equal(flat.some((r) => r.ok === false && r.code === "cdp_blocked"), true);
  assert.equal(flat.some((r) => r.ok === false && r.code === "window_not_drawing"), true);
  assert.equal(JSON.stringify(golden).includes(SECRET), false);
  assert.equal(JSON.stringify(golden).includes("••••"), true);
  assert.equal(golden.some((item) => item.files.length > 0), true);
});

for (const scenario of SCENARIOS) {
  const recorded = golden.find((item) => item.name === scenario.name);
  test(`golden master: ${scenario.name} 은 옛 처리기와 응답·부수 효과(CDP 호출 순서 포함)·파일이 같다`, async () => {
    const worker = createWorkerRun(scenario, rootOf(scenario.name, "worker"));
    const { responses, effects, files } = await worker.run();
    assert.deepEqual(responses, recorded.responses);
    assert.deepEqual(effects, recorded.effects);
    assert.deepEqual(files, recorded.files);
    // 단위 규칙: 단위마다 사용자 명령 이름 하나, 마지막 호출 표시는 많아야 하나이고 있으면 맨 끝
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
      // 대기열 밖 단위는 반응 장면 촬영뿐
      if (relays.some((r) => r.unit.outside === true)) {
        assert.equal(relays.every((r) => r.unit.outside === true && r.unit.command === "qa-screenshot"), true);
        assert.equal(relays.every((r) => r.command !== "ai.enter"), true);
      }
    }
    // 비밀 원문은 worker 가 받은 어떤 응답에도 없다 · 보낸 호출에는 호출자가 인자로 준 글(캡션)을 가리려고 메인에 보내는 result.redact 뿐
    assert.equal(JSON.stringify(worker.relays.filter((r) => r.command !== "result.redact")).includes(SECRET), false);
    assert.equal(JSON.stringify(worker.responses).includes(SECRET), false);
  });
}

test("옛 처리기를 다시 돌린 응답과 효과가 기록과 같다(기록의 진위)", async () => {
  for (const item of golden) {
    const again = await runLegacy(scenarioOf(item.name), rootOf(item.name, "again"));
    assert.deepEqual({ responses: again.responses, effects: again.effects, files: again.files }, { responses: item.responses, effects: item.effects, files: item.files }, item.name);
  }
});

test("QA 채널의 순서대로 qa-mode 켜기 단위 뒤에 명령 단위가 이어지고 옛 cdpExecRaw·cdpExecInner 순서를 따른다", async () => {
  const worker = createWorkerRun(scenarioOf("screenshot-stable"), rootOf("order", "worker"));
  await worker.run();
  const ids = [...new Set(worker.relays.map((r) => r.commandId))];
  assert.equal(ids.length, 2);
  const [, command] = ids.map((id) => worker.relays.filter((r) => r.commandId === id));
  assert.equal(command[0].unit.command, "qa-screenshot");
  // 관문 → 준비 → 창 그림 검사 → 프레임 → 본문(탭 정보 · 가리기 · 안정 확인 · 촬영) → 마지막 가리기. 읽기 전용이라 AI 표식 없음
  const names = command.map((r) => r.command);
  assert.deepEqual(names.slice(0, 5), ["cdp.gate", "viewport.ensureReady", "focus.state", "cdp.frames", "wc.info"]);
  assert.equal(names.includes("ai.enter"), false);
  assert.equal(command.at(-1).command, "result.redact");
  assert.equal(command.at(-1).unit.phase, "last");
  assert.equal(names.includes("obs.pending"), true);
  assert.equal(names.includes("hold.capture"), true);
  // 대기열 안 단위 · 같은 탭 token 으로 이어서 보냄
  assert.equal(new Set(worker.relays.map((r) => r.targetToken.wcId)).size, 1);
});

test("qa-expect 는 AI 표식을 달고(옛 READ_ONLY_CMDS 에 없음) 안의 촬영도 관문·준비·창 검사를 거친다", async () => {
  const worker = createWorkerRun(scenarioOf("expect-exists-pass"), rootOf("expect-order", "worker"));
  await worker.run();
  const names = worker.relays.filter((r) => r.unit.command === "qa-expect").map((r) => r.command);
  assert.deepEqual(names.slice(0, 3), ["cdp.gate", "ai.enter", "viewport.ensureReady"]);
  assert.equal(names.filter((name) => name === "cdp.gate").length, 2, "촬영(중첩 cdpExecRaw)의 관문");
  assert.equal(names.filter((name) => name === "focus.state").length, 1, "촬영의 창 그림 검사");
  assert.equal(names.indexOf("ai.leave") > names.lastIndexOf("hold.capture"), true);
  assert.equal(names.filter((name) => name === "ai.enter").length, 1);
});

test("ref 로 표시하는 촬영은 메인 registry 를 기본 명령 ref.resolve 로 읽고, 없는 ref 오류는 옛 처리기와 같다", async () => {
  const worker = createWorkerRun(scenarioOf("screenshot-ref-mark"), rootOf("ref-resolve", "worker"));
  const { responses } = await worker.run();
  assert.equal(responses[0].ok, true);
  const resolves = worker.relays.filter((r) => r.command === "ref.resolve");
  assert.deepEqual(resolves.map((r) => r.args), [{ ref: "e5" }]);
  assert.equal(resolves[0].unit.command, "qa-screenshot");
  assert.deepEqual(worker.effects.filter((e) => e[0] === "ref.resolve"), [["ref.resolve", "e5"]]);
  const missing = createWorkerRun(scenarioOf("screenshot-ref-missing"), rootOf("ref-missing", "worker"));
  const result = (await missing.run()).responses[0];
  assert.equal(result.ok, false);
  assert.equal(result.code, "not_found");
  assert.match(result.error, /ref e9 를 찾을 수 없습니다/);
});

test("contextaction 은 옮기지 않는다: 부르는 자리가 메인 안 원격 기능이고 제한 시간이 단위(25초)보다 긴 35초", () => {
  assert.equal(Object.hasOwn(COMMAND_ROUTES, "contextaction"), false);
  assert.equal(workerHandlerFor("contextaction"), null);
  // 옛 처리기가 쓰는 35초와 명령 단위의 25초
  assert.match(CONTROL_SOURCE, /const timeoutMs = cmd === "contextaction" \? 35000 : CMD_TIMEOUT_MS;/);
  assert.match(CONTROL_SOURCE, /timeoutMs: CMD_TIMEOUT_MS,\n\}\);/);
  // 옛 봉투 분기: worker 메타가 있고 기본 명령 집합에 있는 이름만 중계로 가고, 메타 없는 봉투는 옛 처리기(cdpExecRaw 의 contextaction)
  assert.match(CONTROL_SOURCE, /if \(hasWorkerMeta && electronRelay\?\.isBaseCommand\(cmd\)\)/);
  assert.match(CONTROL_SOURCE, /if \(cmd === "contextaction"\) return contextActionCommand\(wc, args \|\| \{\}\);/);
  // 부르는 자리: 원격 브라우저 기능이 메인의 runCdp 로 부름
  assert.match(read("../server/remote/features/browser.js"), /command\(request\.tab, "contextaction", \{ name: "pagetranslate\.page" \}, 36_000\)/);
});

test("옛 목록이 cdp-control.cjs 와 같다: READ_ONLY_CMDS · NEEDS_PIXELS 에서 이 조각 명령의 속성, ANIMATES 에는 없음", () => {
  const names = (source, label) => {
    const match = new RegExp(`const ${label} = new Set\\(\\[([^\\]]*)\\]\\)`).exec(source);
    assert.ok(match, label);
    return match[1].match(/"([^"]+)"/g).map((item) => item.slice(1, -1));
  };
  const observation = read("../native/electron/cdp-observation.cjs");
  assert.deepEqual([...QA_OBSERVE_TRAITS.READ_ONLY].sort(), names(CONTROL_SOURCE, "READ_ONLY_CMDS").filter((name) => QA_OBSERVE_COMMAND_NAMES.includes(name)).sort());
  assert.deepEqual([...QA_OBSERVE_TRAITS.NEEDS_PIXELS].sort(), names(CONTROL_SOURCE, "NEEDS_PIXELS").filter((name) => QA_OBSERVE_COMMAND_NAMES.includes(name)).sort());
  assert.deepEqual(names(observation, "ANIMATES").filter((name) => QA_OBSERVE_COMMAND_NAMES.includes(name)), []);
  assert.deepEqual(names(CONTROL_SOURCE, "QUEUE_BYPASS").filter((name) => QA_OBSERVE_COMMAND_NAMES.includes(name)), []);
  assert.deepEqual(names(CONTROL_SOURCE, "NEEDS_KEYS").filter((name) => QA_OBSERVE_COMMAND_NAMES.includes(name)), []);
  assert.equal(QA_OBSERVE_TRAITS.READ_ONLY.has("qa-expect"), false);
});

test("처리기가 쓰는 옛 원문이 cdp-control.cjs 에 있다(원본이 바뀌면 사본과 기록을 다시 대조)", () => {
  // qa-screenshot 은 옛 QA 탭 확대 보정 → 창 그림 검사 → 본문 순서 · 안의 캡처 잡기는 본문(qa-capture)이 함
  const inner = sliceBetween(CONTROL_SOURCE, "async function cdpExecInner(", "async function runCdpCmd(");
  assert.equal(inner.indexOf("await ensureQaReady(send, wc, cmd);") < inner.indexOf("paintableProbe(wc.id)"), true);
  assert.match(inner, /KEYS_NEED_PAINT\(cmd\) \|\| NEEDS_PIXELS\.has\(cmd\)/);
  // qa-expect 안의 촬영은 cdpExecRaw 를 다시 부름
  assert.match(CONTROL_SOURCE, /createQaExpectCommands\(\{ screenshot: \(_send, wc, args\) =>\s*cdpExecRaw\(commandWebContentsMods\.get\(wc\), wc\.id, "qa-screenshot", args\) \}\)/);
  // 반응 관찰의 촬영은 qa-screenshot 본문을 대기열·관문 없이 바로 부름
  assert.match(CONTROL_SOURCE, /createQaReactionCommands\(\{ observation,\s*screenshot: qaCaptureCommands\["qa-screenshot"\] \}\)/);
  // 모드 해제는 반응 관찰을 먼저 정리
  assert.match(sliceBetween(CONTROL_SOURCE, "async function setQaMode(", "const commandHandlers = "), /if \(!enabled\) \{ await qaReactionCommands\.dispose\(wc\.id\); qaContents\.delete\(wc\.id\)/);
  // 반응 관찰이 남아 있으면 CDP 를 떼지 않는 부착 정책: 옛 hasActive 와 worker 구독
  assert.match(CONTROL_SOURCE, /\(wcId\) => qaReactionCommands\.hasActive\(wcId\),\n[^\n]*\n\s*\(wcId\) => !!\(electronRelay && electronRelay\.hasPersistentSubscription\(wcId\)\)/);
  assert.match(CONTROL_SOURCE, /"worker-qa-observe-commands", "worker-ax-tree"\]/);
});

test("worker 사본은 원본과 파일 내용이 같다(머리말·import/require·export 줄만 다르고, 다른 점은 명시)", () => {
  const stripWorker = (text) => text.replace(/^\/\/ worker 사본[^\n]*\n\/\/ 원본은 ⑧에서 지움\n(\/\/ 다른 점[^\n]*\n)?/, "").replace(/^import [^;]*;\n/gm, "")
    .replace(/export \{[^}]*\};/, "").replace(/\n{3,}/g, "\n\n").trim();
  const stripOriginal = (text) => text.replace(/^const \{? ?[^=]*\}? = require\([^)]*\);\n/gm, "").replace(/module\.exports = \{[^}]*\};/, "").replace(/\n{3,}/g, "\n\n").trim();
  assert.equal(stripWorker(read("../server/mcp-worker/qa-expect-commands.js")), stripOriginal(read("../native/electron/cdp-qa-expect.cjs")));
  assert.equal(stripWorker(read("../server/mcp-worker/qa-stability.js")),
    stripOriginal(read("../native/electron/cdp-qa-stability.cjs")).replace("pending = observation?.pendingRequests ? observation.pendingRequests(wc.id) : null;", "pending = observation?.pendingRequests ? await observation.pendingRequests(wc.id) : null;"));
  // 촬영: Electron 창으로 그림을 합성하는 imageRenderer 는 메인의 img.render · 메인 동기 조회 다섯 곳은 기본 명령이라 await · zoomOf 는 원본 cdp-qa-viewport.cjs 의 같은 함수
  const rawCapture = read("../native/electron/cdp-qa-capture.cjs");
  const original = sliceBetween(rawCapture, "function momentMark(", "function imageRenderer(BrowserWindow) {")
    + sliceBetween(rawCapture, "function createQaCaptureCommands(", "module.exports = {");
  const patched = [
    ["const entry = refRegistry.resolveRef(wc.id, spec.ref);", "const entry = await refRegistry.resolveRef(wc.id, spec.ref);"],
    ["const caption = redact(wc.id, String(args.caption || \"\"));", "const caption = await redact(wc.id, String(args.caption || \"\"));"],
    ["marks:redact(wc.id,marks)", "marks:await redact(wc.id,marks)"],
    ["const seen=observation.observe(wc.id,level,limit);", "const seen=await observation.observe(wc.id,level,limit);"],
    ["return redact(wc.id,result);", "return await redact(wc.id,result);"],
  ].reduce((text, [from, to]) => { assert.equal(text.includes(from), true, from); return text.replace(from, to); }, original);
  const workerRaw = read("../server/mcp-worker/qa-capture-commands.js");
  assert.equal(sliceBetween(workerRaw, "function momentMark(", "export {"), patched);
  const zoomOf = (text) => sliceBetween(text, "function zoomOf(wc) {", "\n}\n").trim();
  assert.equal(zoomOf(workerRaw), zoomOf(read("../native/electron/cdp-qa-viewport.cjs")));
});

test("반응 관찰 사본: 판정 본문은 원본과 같고 상태 보유·구독·촬영·진단만 다르다", async () => {
  const original = read("../native/electron/cdp-qa-reaction.cjs");
  const copy = read("../server/mcp-worker/qa-reaction-commands.js");
  const part = (text, from, to) => sliceBetween(text, from, to).trim();
  // 페이지에 주입되는 관찰 함수와 패턴 비교는 글자까지 같아야 한다
  assert.equal(part(copy, "function matchesPattern(", "// 격리 영역의 읽기 전용 DOM 관찰"), part(original, "function matchesPattern(", "// 격리 영역의 읽기 전용 DOM 관찰"));
  // 기대 효과 판정 · 후보 기록 · 이벤트 해석(ingest)
  const sameBlock = (from, to) => assert.equal(part(copy, from, to), part(original, from, to), from);
  // 원본에 없는 수정 두 곳: 지워진 실행 환경을 목록에서 빼고(ingest) 끝 조회에서 사라진 환경 오류를 건너뜀(종료 판정)
  const CLEARED_FROM = "state.snapshots.delete(key);\n";
  const CLEARED_TO = CLEARED_FROM + "      state.contexts=state.contexts.filter(c=>(c.sid ?? null)!==(sid || null));\n";
  const REFRESH_FROM = 'for(const c of state.contexts){const response=await (c.sid==null?state.send:state.send.on(c.sid))("Runtime.evaluate",{expression:"globalThis.__irisQaReactionState.refresh()",contextId:c.contextId,returnByValue:true});if(response.result?.value?.effects)';
  const REFRESH_TO = 'for(const c of [...state.contexts]){const response=await (c.sid==null?state.send:state.send.on(c.sid))("Runtime.evaluate",{expression:"globalThis.__irisQaReactionState.refresh()",contextId:c.contextId,returnByValue:true}).catch(error=>{if(GONE_CONTEXT.test(String(error?.message||error)))return null;throw error;});if(response?.result?.value?.effects)';
  const patch = (text, from, to) => { assert.equal(text.includes(from), true, from); return text.replace(from, to); };
  sameBlock("const push=(list,item)=>{list.push(item);};", "const capture=(state,kind,description");
  // 원본은 이 사이에 observation.subscribeEvents 전역 연결이 있고 사본은 명령 단위 정리용 attach 가 있다
  assert.equal(part(copy, "const candidate=(state,code,description,rect,extra={})=>{", "  const attach=(state,send,io)=>{"),
    patch(part(original, "const candidate=(state,code,description,rect,extra={})=>{", "  observation.subscribeEvents("), CLEARED_FROM, CLEARED_TO));
  sameBlock("  const install=async(state,send,sid=null)=>{", "  const stop=async(state)=>{");
  sameBlock("  const result=state=>({ok:true,id:state.id", "  const commands = {");
  sameBlock("    async \"qa-target-resolve\"(send,_wc,args={}) {", "    async \"qa-background-observe\"(");
  // 시작 검사(기대 효과 형식 · 전제 검사)와 종료 판정
  const startBody = (text) => sliceBetween(text, "      const expect=args.expect;", "      active.set(id,state);").trim().replace(/\s+/g, " ");
  assert.equal(startBody(copy), startBody(original));
  const afterArm = (text) => sliceBetween(text, "        state.beforeEffects.clear();", "      }catch(error){await stop(state);throw error;}").trim();
  assert.equal(afterArm(copy), afterArm(original));
  const endBody = (text) => sliceBetween(text, "        while(now()<state.deadline && state.completedAt==null) {", "      }finally{").trim();
  assert.equal(endBody(copy).replace("await io.diagSince(state.started)", "observation.diagSince?.(wc.id,state.started)"), patch(endBody(original), REFRESH_FROM, REFRESH_TO));
  // 같은 상수
  for (const line of ["const BINDING = \"__irisQaReaction\";", "const WORLD = \"iris-qa-reaction\";", "const LATE_MS = 1000;", "const LOADING_MS = 10000;", "const TAIL_MS = 200;", "const BACKGROUND_MS = 1000;", "const ABANDONED_MS = 30000;"]) {
    assert.equal(original.includes(line) && copy.includes(line), true, line);
  }
  // 주입 함수가 글자까지 같다(문자열 비교가 위에서 이미 같음) · 모듈로 불러도 같은 함수 본문
  const legacy = (await import("node:module")).createRequire(import.meta.url)("../native/electron/cdp-qa-reaction.cjs");
  const worker = await import("../server/mcp-worker/qa-reaction-commands.js");
  assert.equal(worker.reactionWatch.toString(), legacy.reactionWatch.toString());
  assert.equal(worker.matchesPattern.toString(), legacy.matchesPattern.toString());
});

test("반응 관찰이 듣는 CDP 이벤트 목록이 옛 ingest 가 읽는 method 와 같다", () => {
  const ingest = sliceBetween(read("../native/electron/cdp-qa-reaction.cjs"), "  function ingest(", "  const lookup=");
  const read_ = new Set([...ingest.matchAll(/method===\"([A-Za-z.]+)\"/g)].map((match) => match[1]));
  const subscribed = new Set(/const REACTION_METHODS = Object\.freeze\(\[([\s\S]*?)\]\);/.exec(read("../server/mcp-worker/qa-observe-route.js"))[1].match(/"[A-Za-z.]+"/g).map((item) => item.slice(1, -1)));
  assert.deepEqual([...subscribed].sort(), [...read_].sort());
});

test("PNG 크기는 머리말에서 읽고 PNG 가 아니면 0×0", () => {
  assert.deepEqual(pngSize(pngOf(640, 480)), { width: 640, height: 480 });
  assert.deepEqual(pngSize(Buffer.from("not a png at all, not even close to one")), { width: 0, height: 0 });
  assert.deepEqual(pngSize(Buffer.alloc(0)), { width: 0, height: 0 });
});

test("경로 표를 legacy 로 바꾸면 옛 봉투 하나로 간다(명령마다)", async () => {
  for (const name of QA_OBSERVE_COMMAND_NAMES) {
    const scenario = SCENARIOS.find((item) => cmdsOf(item).includes(name));
    const worker = createWorkerRun(scenario, rootOf(scenario.name, `legacy-route-${name}`), { routes: { ...COMMAND_ROUTES, [name]: "legacy" } });
    await worker.run().catch(() => {});
    const forName = worker.relays.filter((r) => r.command === name);
    assert.equal(forName.every((r) => r.unit == null), true, name);
    assert.equal(forName.length > 0, true, name);
    assert.equal(worker.relays.some((r) => r.unit?.command === name), false, name);
  }
});

test("메인이 worker-qa-observe-commands 를 알리지 않으면 이 조각 명령만 옛 봉투로 보낸다(이전 설치 앱과 호환)", async () => {
  for (const features of [[], ["worker-command-unit"], ["worker-command-unit", "worker-qa-input-commands"]]) {
    const worker = createWorkerRun(scenarioOf("screenshot-stable"), rootOf("legacy-features", `f${features.length}`), { features });
    await worker.run();
    const commands = worker.relays.map((r) => r.command);
    assert.equal(commands.at(-1), "qa-screenshot", features.join());
    assert.equal(worker.relays.at(-1).unit == null, true);
    // 6a 의 qa-mode 는 기능이 있으면 계속 단위
    assert.equal(worker.relays[0].unit != null, features.includes("worker-qa-input-commands"), features.join());
  }
});

test("반응 관찰: 장기 구독이 관찰이 끝나도 모드 해제까지 남고, 해제하면 구독·스크립트·바인딩 정리 호출이 간다", async () => {
  const worker = createWorkerRun(scenarioOf("reaction-appear-observed"), rootOf("reaction-lifetime", "worker"));
  await worker.accept();
  const startStep = scenarioOf("reaction-appear-observed").steps[0];
  const response = await worker.execute("qa-reaction-start", startStep.args);
  assert.equal(response.ok, true);
  // start 단위가 닫혀도 구독은 살아 있어 메인의 부착 정책이 CDP 를 떼지 않는다
  assert.equal(worker.relay.hasPersistentSubscription(WC_ID), true);
  const subscribe = worker.relays.find((r) => r.command === "cdp.subscribe");
  assert.equal(subscribe.args.scoped, undefined);
  assert.equal(subscribe.unit.command, "qa-reaction-start");
  await worker.execute("qa-reaction-end", { id: response.data.id, delivered: true });
  assert.equal(worker.relay.hasPersistentSubscription(WC_ID), true, "옛 hasActive 는 idle 상태에서도 참");
  await worker.inContext(() => worker.executor.modeOff("tab-a"));
  assert.equal(worker.relay.hasPersistentSubscription(WC_ID), false);
  const removed = worker.effects.filter((e) => e[0] === "cdp" && e[1] === "Page.removeScriptToEvaluateOnNewDocument");
  assert.equal(removed.length >= 1, true);
  assert.equal(worker.relays.filter((r) => r.command === "cdp.unsubscribe").length >= 1, true);
});

test("worker 세대가 은퇴하면 반응 관찰이 남긴 구독·스크립트·바인딩을 메인이 거둔다", async () => {
  const worker = createWorkerRun(scenarioOf("reaction-appear-observed"), rootOf("reaction-retire", "worker"));
  await worker.accept();
  await worker.execute("qa-reaction-start", scenarioOf("reaction-appear-observed").steps[0].args);
  assert.equal(worker.relay.hasPersistentSubscription(WC_ID), true);
  const before = worker.effects.length;
  await worker.relay.retireGeneration(GENERATION);
  assert.equal(worker.relay.hasPersistentSubscription(WC_ID), false);
  const after = worker.effects.slice(before);
  assert.equal(after.some((e) => e[0] === "cdp" && e[1] === "Page.removeScriptToEvaluateOnNewDocument"), true);
  assert.equal(after.some((e) => e[0] === "cdp" && e[1] === "Runtime.removeBinding"), true);
});

test("scoped 구독(QA 입력의 수신 기록)은 부착 정책에 CDP 유지 근거가 아니다", async () => {
  const worker = createWorkerRun(scenarioOf("screenshot-stable"), rootOf("scoped-sub", "worker"));
  await worker.accept();
  const target = { wcId: WC_ID, documentGeneration: 3, debuggerGeneration: 4 };
  const request = (command, args) => ({ workerGeneration: GENERATION, commandId: `${GENERATION}/x`, callId: `${command}-${Math.random()}`, command, target, args });
  await worker.relay.execute(request("cdp.subscribe", { subscriptionId: "s-scoped", methods: [], scoped: true }));
  assert.equal(worker.relay.hasPersistentSubscription(WC_ID), false);
  await worker.relay.execute(request("cdp.subscribe", { subscriptionId: "s-long", methods: [] }));
  assert.equal(worker.relay.hasPersistentSubscription(WC_ID), true);
  assert.equal(worker.relay.hasPersistentSubscription(WC_ID + 1), false);
});

test("obs.pending · obs.since 는 옛 observation 값을 그대로 돌려준다(since 는 diag 에 감싸 moments 충돌을 피함)", async () => {
  const worker = createWorkerRun({ ...scenarioOf("screenshot-stable"), env: { shown: true, pending: [3], diag: { console: [{ text: "a" }], exceptions: [], network: [], dialogs: [], moments: [{ kind: "m" }] } } },
    rootOf("obs-base", "worker"));
  await worker.accept();
  const target = { wcId: WC_ID, documentGeneration: 3, debuggerGeneration: 4 };
  const call = (command, args) => worker.relay.execute({ workerGeneration: GENERATION, commandId: `${GENERATION}/y`, callId: `${command}-1`, command, target, args });
  assert.deepEqual(await call("obs.pending", {}), { pending: 3 });
  const since = await call("obs.since", { since: 5 });
  assert.deepEqual(Object.keys(since), ["diag"]);
  assert.deepEqual(since.diag.moments, [{ kind: "m" }]);
  assert.deepEqual(worker.effects.filter((e) => e[0] === "diagSince"), [["diagSince", WC_ID, 5]]);
});

test("반응 관찰은 탭마다 따로다: 다른 탭의 관찰 id 로는 읽을 수 없다", async () => {
  const worker = createWorkerRun(scenarioOf("reaction-appear-observed"), rootOf("reaction-tabs", "worker"));
  await worker.accept();
  const started = await worker.execute("qa-reaction-start", scenarioOf("reaction-appear-observed").steps[0].args);
  const other = clone(await worker.inContext(() => worker.executor.execute("tab-b", "qa-reaction-poll", { id: started.data.id })));
  assert.equal(other.ok, false);
  assert.match(other.error, /이 탭의 반응 관찰을 찾지 못했습니다/);
  const same = await worker.execute("qa-reaction-poll", { id: started.data.id });
  assert.equal(same.ok, true);
});
const clone = (value) => JSON.parse(JSON.stringify(value ?? null));

test("명령 사이에 온 이벤트의 장면 촬영은 그 사이 바뀐 문서 세대의 target token 으로 간다(낡은 token 은 host 가 거절)", async () => {
  const worker = createWorkerRun(scenarioOf("reaction-appear-observed"), rootOf("reaction-token", "worker"));
  const previous = process.env.IRIS_STATE_DIR;
  process.env.IRIS_STATE_DIR = rootOf("reaction-token", "worker");
  try {
    await worker.accept();
    const started = await worker.execute("qa-reaction-start", scenarioOf("reaction-appear-observed").steps[0].args);
    assert.equal(started.ok, true);
    worker.world.gens.documentGeneration += 1;
    const event = EVENTS.appear("e1", "저장됨");
    worker.world.ctl.emit(event.method, event.params);
    await worker.world.clock.drain();
    const polled = await worker.execute("qa-reaction-poll", { id: started.data.id });
    const scene = polled.data.scenes.find((item) => item.claim.kind === "S2");
    assert.ok(scene, "기대 효과 장면이 있어야 함");
    assert.equal(scene.shotError, undefined);
    assert.equal(typeof scene.shot, "string");
  } finally { if (previous === undefined) delete process.env.IRIS_STATE_DIR; else process.env.IRIS_STATE_DIR = previous; }
});

test("이벤트 구독이 상한을 넘어 끊기면 관찰 결과의 limits 에 남는다", async () => {
  const worker = createWorkerRun(scenarioOf("reaction-appear-observed"), rootOf("reaction-overflow", "worker"));
  await worker.accept();
  const started = await worker.execute("qa-reaction-start", scenarioOf("reaction-appear-observed").steps[0].args);
  const subscriptionId = worker.relays.find((r) => r.command === "cdp.subscribe").args.subscriptionId;
  for (const listener of [...worker.relayListeners]) listener({ workerGeneration: GENERATION, subscriptionId, eventSeq: 9, error: { code: "EVENT_OVERFLOW", message: "이벤트 구독 상한을 넘었습니다." } });
  const polled = await worker.execute("qa-reaction-poll", { id: started.data.id });
  assert.deepEqual(polled.data.limits, [{ code: "EVENT_OVERFLOW", message: "이벤트 구독 상한을 넘었습니다." }]);
});

test("확인 창이 열려 있으면 이 조각 명령은 host 게이트가 막고 단위를 명시 종료로 닫는다", async () => {
  const dialog = { kind: "confirm", message: "삭제할까요?", full: "삭제할까요?" };
  for (const name of QA_OBSERVE_COMMAND_NAMES) {
    const scenario = SCENARIOS.find((item) => cmdsOf(item).includes(name));
    const step = (scenario.steps || [scenario]).find((item) => item.cmd === name);
    // qa-mode 켜기를 지난 뒤 명령 단위 안에서 확인 창이 뜸
    const worker = createWorkerRun(scenario, rootOf(scenario.name, `dialog-${name}`), {
      onExecute: async (relay) => { if (relay.command === "viewport.ensureReady" && relay.unit?.command === name) worker.hostState.dialog = dialog; },
    });
    await worker.accept();
    const response = await worker.execute(name, { ...(step.args || {}), id: "x" });
    assert.equal(response.ok, false, name);
    assert.deepEqual(response.dialogOpen, { kind: "confirm", message: "삭제할까요?" }, name);
    const unit = worker.relays.filter((r) => r.unit?.command === name);
    assert.equal(unit.at(-1).command, "unit.end", name);
    assert.equal(unit.some((r) => r.command === "result.redact" || r.command === "cdp.send"), false, name);
  }
});

test("host 작업 위임의 screenshot 은 page 기능이 있으면 worker 처리기(탭 대기열 안 단위), 없으면 옛 legacyHostTask", async () => {
  const calls = [];
  const features = (list) => async (operation, input) => {
    calls.push([operation, input]);
    if (operation === "browser.status") return { executor: { features: list } };
    if (operation === "browser.executeWithDialog") return { ok: false, error: "stop", commandState: "completed" };
    return { ok: true, legacy: true };
  };
  const task = { type: "legacyRelay", target: { tabId: "t", wcId: 7, targetToken: { wcId: 7, documentGeneration: 3, debuggerGeneration: 4 } }, relay: { command: "screenshot", args: { stable: false }, timeoutMs: 30000 } };
  const run = async (list) => {
    calls.length = 0;
    const service = createWorkerHostTaskService({ hostApi: { call: features(list), withCommand: (_c, fn) => fn(), current: () => ({}) } });
    await service.dispatch({ task, identity: { session: "pane", run: "run-1" }, commandId: `${GENERATION}/host-1`, callId: 1 });
    return calls.filter(([operation]) => operation !== "browser.status");
  };
  const viaWorker = await run(["worker-command-unit", "worker-page-commands"]);
  const executes = viaWorker.filter(([operation]) => operation === "browser.executeWithDialog");
  assert.equal(executes.length > 0, true);
  assert.equal(executes[0][1].relay.command, "cdp.gate");
  assert.deepEqual(executes[0][1].relay.unit, { command: "screenshot", phase: "run" });
  assert.equal(executes.every(([, input]) => input.relay.unit.outside !== true), true);
  assert.equal(viaWorker.some(([operation]) => operation === "browser.legacyHostTask"), false);
  for (const list of [[], ["worker-command-unit"], ["worker-native-commands"]]) {
    const legacy = await run(list);
    assert.deepEqual(legacy.map(([operation, input]) => [operation, input.relay.command]), [["browser.legacyHostTask", "screenshot"]], list.join());
  }
  // 확인 창을 푸는 작업은 계속 대기열 밖
  calls.length = 0;
  const service = createWorkerHostTaskService({ hostApi: { call: features(["worker-command-unit", "worker-native-commands"]), withCommand: (_c, fn) => fn(), current: () => ({}) } });
  await service.dispatch({ task: { ...task, relay: { command: "dialog", args: { answer: "ok" }, timeoutMs: 10000 } }, identity: { session: "pane" }, commandId: `${GENERATION}/host-2`, callId: 2 });
  assert.equal(calls.filter(([operation]) => operation === "browser.executeWithDialog").every(([, input]) => input.relay.unit.outside === true), true);
});

test("host 작업 위임(journal)의 screenshot 은 일반 screenshot 의 옛 처리기 기록과 응답·효과·파일이 같다", async () => {
  const pageGolden = JSON.parse(read("./fixtures/worker-route-page-golden.json"));
  const realNow = Date.now;
  let last = 0;
  // 파일 이름의 밀리초 시각이 겹치지 않게 (page-route 시험과 같음)
  Date.now = () => (last = Math.max(realNow(), last + 1));
  try {
    const scenarios = PAGE_SCENARIOS.filter((item) => item.cmd === "screenshot");
    assert.equal(scenarios.length >= 5, true);
    for (const scenario of scenarios) {
      const recorded = pageGolden.find((item) => item.name === scenario.name);
      const worker = createPageRun(scenario, path.join(PAGE_SCRATCH, RUN, "host-task", scenario.name));
      const result = await worker.run({ hostTask: true });
      assert.deepEqual(result.response, recorded.response, scenario.name);
      assert.deepEqual(result.effects, recorded.effects, scenario.name);
      assert.deepEqual(result.files, recorded.files, scenario.name);
      // 확인 창을 푸는 작업(outside)이 아니라 탭 대기열 안 단위
      assert.equal(worker.relays.every((r) => r.unit.command === "screenshot" && r.unit.outside !== true), true, scenario.name);
      assert.equal(worker.relays[0].command, "cdp.gate", scenario.name);
    }
  } finally { Date.now = realNow; }
});

test("알려진 차이: 단위가 호출마다 응답을 비밀 가리기에 거쳐 qa-expect 가 비밀 글자와 직접 비교하면 가려진 값과 비교한다", async () => {
  const legacy = await runLegacy(EXPECT_SECRET_SCENARIO, rootOf("expect-secret", "legacy"));
  const worker = await createWorkerRun(EXPECT_SECRET_SCENARIO, rootOf("expect-secret", "worker")).run();
  assert.equal(legacy.responses[0].data.pass, true);
  assert.equal(worker.responses[0].data.pass, false);
  assert.equal(JSON.stringify(worker.responses).includes(SECRET), false);
});
