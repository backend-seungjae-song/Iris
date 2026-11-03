import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

import { createWorkerBrowserService } from "../server/mcp-worker/browser-service.js";
import { COMMAND_ROUTES } from "../server/mcp-worker/command-routes.js";
import { buildSnapshot as workerBuildSnapshot } from "../server/mcp-worker/snapshot-engine.js";
import { humanHint as workerHumanHint, loginHint as workerLoginHint } from "../server/mcp-worker/page-hints.js";
import { createPageSend, dumpRefs, legacySend, pages } from "./fixtures/snapshot-pages.mjs";

const require = createRequire(import.meta.url);
const refRegistry = require("../native/electron/cdp-ref-registry.cjs");
const { pruneAxNodes } = require("../native/electron/ax-prune.cjs");
const { buildSnapshot: legacyBuildSnapshot } = require("../native/electron/snapshot-engine.cjs");
const { humanHint: legacyHumanHint, loginHint: legacyLoginHint } = require("../native/electron/cdp-hints.cjs");
const golden = JSON.parse(fs.readFileSync(new URL("./fixtures/worker-route-snapshot-golden.json", import.meta.url), "utf8"));
const activity = { run: (_kind, _id, run) => run() };
const token = { wcId: 7, documentGeneration: 3, debuggerGeneration: 4 };

// 메인 대역: 기본 명령을 페이지 대역으로 실행 · ref.record 는 실제 registry(wc 8)에 기록
// axTree: true 면 메인이 worker-ax-tree 기능을 알리고 ax.tree 를 실제 축소 함수로 처리 · false 면 옛 메인(cdp.send 만)
// batch: "ok" 면 cdp.batch 를 처리(cursor 요소 해석용 대역 포함) · "fail" 이면 실패 응답 · "block" 이면 확인 창 차단
function harness(page, { generations = null, blockAt = null, attachError = null, axTree = false, batch = null } = {}) {
  const relays = [];
  const basic = createPageSend(page);
  const send = async (method, params = {}, sid = null) => {
    if (!batch) return basic(method, params, sid);
    if (method === "Runtime.evaluate" && params.expression === "window.__acCursorInteractive") return { result: { objectId: "arr" } };
    if (method === "Runtime.getProperties") {
      return { result: [...page.cursor.map((_, i) => ({ name: String(i), value: { objectId: `obj-${i}` } })), { name: "length", value: { value: page.cursor.length } }] };
    }
    if (method === "DOM.describeNode" && String(params.objectId).startsWith("obj-")) {
      const i = Number(params.objectId.slice(4));
      return { node: { backendNodeId: page.cursor[i]?.text === "이미 있는 것" ? 101 : 5000 + i } };
    }
    return basic(method, params, sid);
  };
  let sends = 0;
  const hostApi = {
    withCommand: (_command, run) => run(),
    call: async (operation, input) => {
      if (operation === "journal.accept") return {};
      if (operation === "browser.commandGuard") return { qaOwned: false };
      if (operation === "browser.commandTargetState") return { target: { tabId: "tab-a", targetToken: token, tab: {} } };
      if (operation === "browser.status") return { executorReady: true, executor: { app: "x", pid: 1, features: axTree ? ["worker-command-unit", "worker-ax-tree"] : ["worker-command-unit"] } };
      if (operation !== "browser.executeWithDialog") return {};
      const { command, args, unit } = input.relay;
      relays.push({ command, args, unit, targetToken: input.targetToken });
      const done = (data) => ({ ok: true, data, commandState: "completed" });
      switch (command) {
        case "unit.end": return done({ ended: true });
        case "cdp.attach":
          if (attachError) return { ok: false, error: attachError, commandState: "completed" };
          return done(generations || { documentGeneration: token.documentGeneration, debuggerGeneration: token.debuggerGeneration });
        case "viewport.ensureReady": return done({ ready: true });
        case "cdp.frames": return done({ frames: Object.keys(page.frames) });
        case "ref.record": refRegistry.clear(8); refRegistry.recordSnapshot(8, new Map(args.refs)); return done({ recorded: args.refs.length });
        case "wc.info": return done({ url: page.url, title: page.title, wcId: 7 });
        case "ax.tree": {
          if (!axTree) throw new Error("기능을 알리지 않은 메인에 ax.tree 를 보냈다");
          sends += 1;
          if (blockAt === sends) return { ok: false, dialogOpen: { kind: "alert", message: "열림" }, error: "확인 창", commandState: "blocked" };
          const full = await send("Accessibility.getFullAXTree", {}, args.sessionId ?? null);
          return done(JSON.parse(JSON.stringify({ nodes: pruneAxNodes(full.nodes) })));
        }
        case "cdp.send": {
          sends += 1;
          if (blockAt === sends) return { ok: false, dialogOpen: { kind: "alert", message: "열림" }, error: "확인 창", commandState: "blocked" };
          return done(await send(args.method, args.params, args.sessionId ?? null));
        }
        case "cdp.batch": {
          if (!batch) throw new Error("예상하지 않은 중계 명령 cdp.batch");
          if (batch === "fail") return { ok: false, error: "batch 실패", commandState: "completed" };
          if (batch === "block") return { ok: false, dialogOpen: { kind: "alert", message: "열림" }, error: "확인 창", commandState: "blocked" };
          const results = [];
          for (const item of args.commands) results.push(await send(item.method, item.params, item.sessionId ?? null));
          return done({ results });
        }
        default: throw new Error(`예상하지 않은 중계 명령 ${command}`);
      }
    },
  };
  return { relays, hostApi };
}

const run = (service, page) => service.dispatch({ command: "snapshot", args: page.args, identity: { session: "pane" }, commandId: "c/1" });

test("snapshot 은 worker 경로", () => { assert.equal(COMMAND_ROUTES.snapshot, "worker"); });

for (const axTree of [false, true]) for (const fixture of golden) {
  test(`snapshot golden master(${axTree ? "ax.tree" : "cdp.send"}): ${fixture.name} 은 옛 처리기와 응답·ref registry 가 같다`, async () => {
    const page = pages[fixture.name];
    const { relays, hostApi } = harness(page, { axTree });
    const response = await run(createWorkerBrowserService({ hostApi, activity }), page);
    assert.deepEqual(JSON.parse(JSON.stringify(response)), fixture.response);
    refRegistry.clear(8);
    const refs = fixture.refs.map(([ref]) => ref);
    // registry 는 harness 안 ref.record 가 채움 · 위 clear 는 다음 시험용이라 기록 시점 값을 다시 대조
    const again = harness(page, { axTree });
    await run(createWorkerBrowserService({ hostApi: again.hostApi, activity }), page);
    assert.deepEqual(JSON.parse(JSON.stringify(dumpRefs(refRegistry, 8, refs))), fixture.refs);
    // 단위 구성: 마지막 기본 명령에만 last, 명시 종료 없음
    assert.equal(relays.every((r) => r.unit.command === "snapshot"), true);
    assert.deepEqual(relays.filter((r) => r.unit.phase === "last").map((r) => r.command), ["cdp.send"]);
    // 접근성 트리 요청은 기능이 있을 때만 ax.tree · 없으면 전체 트리를 cdp.send 로 받음 (프레임마다 하나씩)
    const treeCalls = relays.filter((r) => r.command === "ax.tree" || (r.command === "cdp.send" && r.args.method === "Accessibility.getFullAXTree"));
    assert.equal(treeCalls.length, 1 + Object.keys(page.frames).length);
    assert.equal(treeCalls.every((r) => r.command === (axTree ? "ax.tree" : "cdp.send")), true);
    assert.deepEqual(treeCalls.slice(1).map((r) => r.args.sessionId), Object.keys(page.frames));
    if (axTree) assert.equal(relays.some((r) => r.command === "cdp.send" && r.args.method === "Accessibility.getFullAXTree"), false);
    assert.equal(relays.at(-1).unit.phase, "last");
    assert.equal(relays.some((r) => r.command === "unit.end"), false);
    assert.deepEqual(relays.slice(0, 3).map((r) => r.command), ["cdp.attach", "viewport.ensureReady", "cdp.frames"]);
    assert.equal(relays.filter((r) => r.command === "ref.record").length, 1);
  });
}

test("옛 처리기를 같은 페이지로 다시 돌린 응답이 기록과 같다(기록의 진위)", async () => {
  const { runLegacySnapshot } = await import("./fixtures/snapshot-pages.mjs");
  for (const fixture of golden) {
    refRegistry.clear(7);
    assert.deepEqual({ ok: true, data: await runLegacySnapshot(pages[fixture.name], 7, refRegistry) }, fixture.response, fixture.name);
  }
});

test("확인 창이 ax.tree 를 막아도 응답을 그대로 돌려주고 단위를 명시 종료한다", async () => {
  const page = pages.ordinary;
  // 기본 CDP 호출 순서: Accessibility.enable(1) → ax.tree(2)
  const { relays, hostApi } = harness(page, { axTree: true, blockAt: 2 });
  const response = await run(createWorkerBrowserService({ hostApi, activity }), page);
  assert.equal(response.dialogOpen.kind, "alert");
  assert.equal(relays.at(-1).command, "unit.end");
  assert.equal(relays.some((r) => r.command === "ref.record"), false);
});

// cursor 요소 해석 묶음 · 응답은 묶지 않은 옛 처리기 기록(golden)과 같아야 함
const ordinaryGolden = golden.find((fixture) => fixture.name === "ordinary");
const cursorEvaluates = (relays) => relays.filter((r) => r.command === "cdp.send" && /^window\.__acCursorInteractive\[/.test(r.args.params?.expression || ""));

test("snapshot 의 cursor 요소 해석은 cdp.batch 한 번으로 보내고 응답은 golden 과 같다", async () => {
  const page = pages.ordinary;
  const { relays, hostApi } = harness(page, { axTree: true, batch: "ok" });
  const response = await run(createWorkerBrowserService({ hostApi, activity }), page);
  assert.deepEqual(JSON.parse(JSON.stringify(response)), ordinaryGolden.response);
  const batches = relays.filter((r) => r.command === "cdp.batch");
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].args.commands.map((c) => c.method), page.cursor.map(() => "DOM.describeNode"));
  assert.equal(cursorEvaluates(relays).length, 0);
  assert.equal(relays.some((r) => r.command === "cdp.send" && r.args.method === "DOM.describeNode"), false);
});

test("cdp.batch 가 실패하면 요소별로 하나씩 보내 같은 응답을 돌려준다", async () => {
  const page = pages.ordinary;
  const { relays, hostApi } = harness(page, { axTree: true, batch: "fail" });
  const response = await run(createWorkerBrowserService({ hostApi, activity }), page);
  assert.deepEqual(JSON.parse(JSON.stringify(response)), ordinaryGolden.response);
  assert.equal(relays.filter((r) => r.command === "cdp.batch").length, 1);
  assert.equal(relays.filter((r) => r.command === "cdp.send" && r.args.method === "DOM.describeNode").length, page.cursor.length);
});

test("cdp.batch 를 확인 창이 막으면 그 응답을 돌려주고 단위를 명시 종료한다", async () => {
  const page = pages.ordinary;
  const { relays, hostApi } = harness(page, { axTree: true, batch: "block" });
  const response = await run(createWorkerBrowserService({ hostApi, activity }), page);
  assert.equal(response.dialogOpen.kind, "alert");
  assert.equal(relays.at(-1).command, "unit.end");
  assert.equal(relays.some((r) => r.command === "ref.record"), false);
});

test("cdp.attach 가 올린 세대는 이후 호출의 target token 에 쓰고 이전 호출은 옛 token 을 쓴다", async () => {
  const page = pages.ordinary;
  const { relays, hostApi } = harness(page, { generations: { documentGeneration: 3, debuggerGeneration: 9 } });
  const response = await run(createWorkerBrowserService({ hostApi, activity }), page);
  assert.equal(response.ok, true);
  assert.equal(relays[0].targetToken.debuggerGeneration, 4);
  assert.equal(relays.slice(1).every((r) => r.targetToken.debuggerGeneration === 9 && r.targetToken.wcId === 7), true);
});

test("처리 중 확인 창이 막으면 그 응답을 돌려주고 단위를 명시 종료한다", async () => {
  const page = pages.ordinary;
  const { relays, hostApi } = harness(page, { blockAt: 3 });
  const response = await run(createWorkerBrowserService({ hostApi, activity }), page);
  assert.equal(response.dialogOpen.kind, "alert");
  assert.equal(relays.at(-1).command, "unit.end");
  assert.equal(relays.at(-1).unit.phase, "end");
  assert.equal(relays.some((r) => r.command === "ref.record"), false);
});

test("붙임 실패(로그인 호스트 등)는 오류 응답을 그대로 돌려주고 단위를 종료한다", async () => {
  const page = pages.ordinary;
  const { relays, hostApi } = harness(page, { attachError: "로그인 호스트에서는 CDP 를 붙이지 않아 snapshot 를 실행할 수 없습니다." });
  const response = await run(createWorkerBrowserService({ hostApi, activity }), page);
  assert.equal(response.ok, false);
  assert.match(response.error, /로그인 호스트/);
  assert.deepEqual(relays.map((r) => r.command), ["cdp.attach", "unit.end"]);
});

test("경로 표를 legacy 로 바꾸면 옛 snapshot 봉투 하나로 간다", async () => {
  const page = pages.ordinary;
  const calls = [];
  const hostApi = {
    withCommand: (_c, r) => r(),
    call: async (operation, input) => {
      if (operation === "browser.commandGuard") return { qaOwned: false };
      if (operation === "browser.commandTargetState") return { target: { tabId: "tab-a", targetToken: token, tab: {} } };
      if (operation === "browser.executeWithDialog") { calls.push(input.relay); return { ok: true, data: { legacy: true }, commandState: "completed" }; }
      return {};
    },
  };
  const response = await run(createWorkerBrowserService({ hostApi, activity, routes: { snapshot: "legacy" } }), page);
  assert.deepEqual(response, { ok: true, data: { legacy: true } });
  assert.deepEqual(calls.map((c) => [c.command, c.unit]), [["snapshot", undefined]]);
});

test("worker 사본은 원본과 파일 내용이 같고(머리말·export 줄만 다름) 같은 입력에 같은 결과를 낸다", async () => {
  // 다른 범위: worker 만 CDP 왕복을 묶음(요소 해석 부분 + resolveBackendIds·resolveBatched) · 그 범위는 mcp-worker-snapshot-batch.mjs 가 결과로 대조
  const strip = (text) => text.replace(/^(\/\/ [^\n]*\n)+/, "").replace(/(const elements = JSON\.parse\(result\.value\);\n)[\s\S]*?(\n    await sendCommand\("Runtime\.evaluate", \{ expression: "delete)/, "$1$2")
    .replace(/\/\/ worker 사본 전용[\s\S]*?(?=export \{)/, "")
    .replace(/module\.exports = \{[^}]*\};/, "").replace(/export \{[^}]*\};/, "").trim();
  const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");
  assert.equal(strip(read("../server/mcp-worker/snapshot-engine.js")), strip(read("../native/electron/snapshot-engine.cjs")));
  assert.equal(strip(read("../server/mcp-worker/page-hints.js")), strip(read("../native/electron/cdp-hints.cjs")));
  for (const [name, page] of Object.entries(pages)) {
    const frames = (send) => Object.keys(page.frames).map((sid) => ({ sid, send: send.on(sid) }));
    const legacy = legacySend(page);
    const options = (send) => ({ ...page.args, frames: frames(send) });
    const a = await legacyBuildSnapshot(legacy, options(legacy));
    const b = await workerBuildSnapshot(legacy, options(legacy));
    assert.deepEqual({ ...b, refMap: [...b.refMap] }, { ...a, refMap: [...a.refMap] }, name);
    assert.equal(await workerLoginHint(legacy), await legacyLoginHint(legacy), name);
    assert.equal(await workerHumanHint(legacy), await legacyHumanHint(legacy), name);
  }
});
