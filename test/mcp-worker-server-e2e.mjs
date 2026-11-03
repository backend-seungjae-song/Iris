import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createRequire } from "node:module";

import { createBundleGeneration } from "../scripts/mcp-worker/bundle-generation.mjs";
import { prepareDeployment } from "../scripts/mcp-worker/deployment.mjs";
import { buildExecutionGraph } from "../scripts/mcp-worker/graph.mjs";
import { createDeploymentManifest } from "../scripts/mcp-worker/manifest.mjs";
import { createQaLedger } from "../server/qa-ledger.js";

const root = path.resolve(import.meta.dirname, "..");
const scratch = path.join(root, ".working", "20261101-1716-mcp-app-separation", "scratch", "f12");
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const { createQaLedgerAnchor } = createRequire(import.meta.url)("../native/electron/qa-ledger-anchor.cjs");

async function waitFor(check, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(20);
  }
  throw new Error("조건을 기다리다 시간이 초과됐습니다.");
}

function copyWorkerSource(graph, destination, marker, broken = false, hostTaskFailure = null) {
  for (const relative of graph.units.worker.files) {
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, relative), target);
  }
  const browser = path.join(destination, "server", "mcp-worker", "browser-service.js");
  {
    const source = fs.readFileSync(browser, "utf8");
    fs.writeFileSync(browser, source.replace(
      "  const sessionCommand = async (command, args) => {",
      `  const sessionCommand = async (command, args) => {
    if (command === "fixture-authorize-device") {
      try {
        await call("qa.deviceAuthorize", { device: args.device }, {
          identity: { session: args.session, run: args.fixtureRun, key: args.fixtureKey },
        });
        const owner = await call("qa.owner", { target: "device:" + args.device });
        return { ok: true, data: { device: args.device, owner: owner?.owner ?? owner } };
      } catch (error) {
        return { ok: false, error: String(error.message || error), ...(error.code ? { code: error.code } : {}) };
      }
    }
    if (command === "fixture-release-target") {
      try {
        const released = await call("qa.releaseIfOwner", { target: args.target }, {
          identity: { session: args.session, run: args.fixtureRun, key: args.fixtureKey },
        });
        return { ok: true, data: released };
      } catch (error) {
        return { ok: false, error: String(error.message || error), ...(error.code ? { code: error.code } : {}) };
      }
    }
    if (command === "fixture-qa-create") {
      const identity = { session: args.session, run: args.fixtureRun, key: args.fixtureKey };
      try {
        return commandResponse(await call("qa.tabCreate", { url: args.url }, { identity }));
      } catch (error) {
        return { ok: false, error: String(error.message || error), ...(error.code ? { code: error.code } : {}) };
      }
    }
    if (command === "fixture-qa-close") {
      const identity = { session: args.session, run: args.fixtureRun, key: args.fixtureKey };
      try {
        return commandResponse(await call("qa.tabClose", { tabId: args.closeTab }, { identity }));
      } catch (error) {
        return { ok: false, error: String(error.message || error), ...(error.code ? { code: error.code } : {}) };
      }
    }
    if (command === "fixture-lifecycle-host-task") {
      const state = await call("browser.commandTargetState", { tabRef: args.tab });
      const target = state.target;
      const generation = process.env.IRIS_MCP_WORKER_GENERATION;
      const lifecycleIdentity = { session: args.session, run: args.fixtureRun, lifecycle: true };
      const lifecycleCommandId = args.invalidPrefix
        ? \`wrong/lifecycle/\${args.fixtureRun}/fixture\`
        : \`\${generation}/lifecycle/\${args.fixtureRun}/fixture\`;
      return hostApi.withCommand({ identity: lifecycleIdentity, commandId: lifecycleCommandId }, async () => {
        try {
          return commandResponse(await call("browser.legacyHostTask", {
            tabId: target.tabId,
            target,
            relay: { command: "redact", args: { text: "fixture lifecycle" }, timeoutMs: 3000 },
          }, { identity: lifecycleIdentity, commandId: lifecycleCommandId }));
        } catch (error) {
          return { ok: false, error: String(error.message || error), ...(error.code ? { code: error.code } : {}) };
        }
      });
    }
    if (command === "fixture-relay-event") {
      let stop;
      const event = new Promise(resolve => { stop = hostApi.onRelayEvent(value => { stop(); resolve(value); }); });
      const state = await call("browser.commandTargetState", { tabRef: args.tab });
      const target = state.target;
      const subscription = await call("browser.executeWithDialog", {
        tabId: target.tabId,
        targetToken: target.targetToken,
        relay: { command: "cdp.subscribe", args: { subscriptionId: args.subscriptionId }, timeoutMs: 30000 },
      });
      if (subscription?.ok === false) { stop(); return subscription; }
      return { ok: true, data: { subscription, event: await event } };
    }`,
    ));
  }
  if (marker) {
    let source = fs.readFileSync(browser, "utf8");
    source = source.replace(
      'if (command === "tabs") return commandResponse(await call("browser.sessionView", {}));',
      `if (command === "tabs") return { ...commandResponse(await call("browser.sessionView", {})), workerMarker: ${JSON.stringify(marker)} };`,
    );
    source = source.replace(
      'if (command === "trace") return commandResponse(await call("journal.sessionCommand", { command, args }));',
      `if (command === "fixture-journal-begin") return commandResponse(await call("journal.sessionCommand", { command: "run", args: { action: "begin", runId: args.runId } }));
    if (command === "trace") return commandResponse(await call("journal.sessionCommand", { command, args }));`,
    );
    fs.writeFileSync(browser, source);
  }
  const hostTasks = path.join(destination, "server", "mcp-worker", "host-task-service.js");
  if (fs.existsSync(hostTasks) && (marker || hostTaskFailure)) {
    const source = fs.readFileSync(hostTasks, "utf8");
    fs.writeFileSync(hostTasks, source.replace(
      "    const input = normalizeHostTask(task);",
      `    const input = normalizeHostTask(task);
    ${hostTaskFailure ? `if (input.relay.command === ${JSON.stringify(hostTaskFailure)}) throw Object.assign(new Error("fixture host task timeout"), { code: "TIMEOUT" });` : ""}
    input.relay.args.workerMarker = ${JSON.stringify(marker)};`,
    ));
  }
  if (broken) fs.appendFileSync(path.join(destination, "server", "mcp-worker", "entry.js"), "\nthrow new Error('fixture boot failure');\n");
}

test("공용 서버·가짜 Electron·작업 프로세스 왕복과 배포 교체·복구", { timeout: 60_000 }, async (t) => {
  fs.mkdirSync(scratch, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(scratch, "server-e2e-"));
  const stateDir = path.join(fixture, "state");
  const home = path.join(fixture, "home");
  const workspace = path.join(fixture, "workspace");
  for (const directory of [stateDir, home, workspace]) fs.mkdirSync(directory, { recursive: true });
  const fakeAdb = path.join(fixture, "adb");
  const fakeIdb = path.join(fixture, "idb");
  fs.writeFileSync(fakeAdb, "#!/bin/sh\nprintf 'Pixel_9\\nOK\\n'\n", { mode: 0o755 });
  fs.writeFileSync(fakeIdb, `#!/bin/sh
if [ "\${1:-}" = "ui" ] && [ "\${2:-}" = "describe-all" ]; then
  printf '[{"type":"Application","AXLabel":"Fixture"}]\\n'
fi
`, { mode: 0o755 });

  const graph = buildExecutionGraph({ root });
  const bundle = createBundleGeneration({ root, generation: "e2e", electronAbi: process.versions.modules });
  const deployment = (name, digest, marker, broken, hostTaskFailure) => {
    const sourceRoot = path.join(fixture, name);
    copyWorkerSource(graph, sourceRoot, marker, broken, hostTaskFailure);
    const manifest = createDeploymentManifest({ sourceRoot, graph, bundle,
      source: { commit: name, worktreeSha256: digest }, now: new Date("2026-11-01T00:00:00Z") });
    prepareDeployment({ sourceRoot, stateDir, manifest, installedBundle: bundle,
      installedNodeModules: path.join(root, "node_modules") });
    return manifest;
  };
  const second = deployment("fixture-v2", "2".repeat(64), "v2", false);
  const fallback = deployment("fixture-fallback", "4".repeat(64), "slow", false);
  const broken = deployment("fixture-bad", "3".repeat(64), null, true);

  process.env.HOME = home;
  process.env.IRIS_STATE_DIR = stateDir;
  process.env.IRIS_PORT = "42976";
  process.env.PORT = "42976";
  process.env.IRIS_BUNDLE_ID = bundle.id;
  process.env.IRIS_ADB = fakeAdb;
  process.env.IRIS_IDB = fakeIdb;
  process.env.REMOTE = "";

  const herdrCalls = [];
  net.connect = (_socketPath, connected) => {
    const socket = new EventEmitter();
    socket.destroyed = false;
    socket.write = raw => {
      const request = JSON.parse(String(raw).trim());
      herdrCalls.push(request.method);
      const result = request.method === "agent.list"
        ? { agents: [{ agent: "codex", agent_status: "idle", cwd: workspace, workspace_id: "X", pane_id: "A", focused: true }] }
        : request.method === "workspace.list" ? { workspaces: [{ workspace_id: "X", label: "X" }] }
          : request.method === "pane.get" ? { pane: { workspace_id: "X", pane_id: "A", cwd: workspace } }
          : request.method === "pane.list" ? { panes: [{ workspace_id: "X", pane_id: "A", cwd: workspace }] } : { tabs: [] };
      queueMicrotask(() => socket.emit("data", Buffer.from(`${JSON.stringify({ id: request.id, result })}\n`)));
      return true;
    };
    socket.destroy = () => { socket.destroyed = true; };
    queueMicrotask(() => connected?.());
    return socket;
  };

  let requestHandler, wss;
  class FakeHttpServer extends EventEmitter {
    listen(...args) { queueMicrotask(() => args.find(value => typeof value === "function")?.()); return this; }
  }
  http.createServer = handler => { requestHandler = handler; return new FakeHttpServer(); };
  const originalOn = EventEmitter.prototype.on;
  EventEmitter.prototype.on = function (event, listener) {
    if (this.constructor?.name === "WebSocketServer") wss = this;
    return originalOn.call(this, event, listener);
  };
  const originalInterval = globalThis.setInterval;
  globalThis.setInterval = () => ({ unref() {} });
  const firstServer = await import(`../server/index.js?worker-e2e=${path.basename(fixture)}`);
  EventEmitter.prototype.on = originalOn;
  globalThis.setInterval = originalInterval;
  assert.ok(requestHandler && wss);

  const request = (method, url, value) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${method} ${url} fixture 응답 시간 초과`)), 15_000);
    const body = value === undefined ? "" : JSON.stringify(value);
    const input = Readable.from(body ? [body] : []);
    input.method = method;
    input.url = url;
    input.headers = {};
    input.socket = { remoteAddress: "127.0.0.1" };
    const response = { statusCode: 200, writeHead(code) { this.statusCode = code; return this; },
      end(raw = "") { clearTimeout(timeout); try { resolve({ status: this.statusCode, body: JSON.parse(String(raw) || "{}") }); } catch (error) { reject(error); } } };
    requestHandler(input, response);
  });
  const anchor = createQaLedgerAnchor({ dir: path.join(fixture, "anchor") });
  const anchorCalls = [];
  const relayCalls = [];
  const baseCommandFixtures = {
    "cdp.gate": () => ({ noCdp: false, documentGeneration: 1, debuggerGeneration: 1 }),
    "ai.enter": () => ({ ticket: "fixture-ticket" }),
    "ai.leave": () => ({ left: true }),
    "viewport.ensureReady": () => ({ ready: true }),
    "focus.state": () => ({ shown: true, paint: { ok: true } }),
    "dialog.answer": () => ({ none: true }),
    "result.redact": (message) => ({ value: message.args.value }),
  };
  const emulatorCalls = [];
  let emulatorTabs = [
    { udid: "device-1", persistentId: "device-1", owner: "A", space: "X", tab: "device-tab" },
    { udid: "emulator-5554", persistentId: "Pixel_9", owner: "A", space: "X", tab: "android-tab", name: "Pixel 9" },
  ];
  let emulatorListCalls = 0;
  let failEmulatorListAt = null;
  let automaticIos = 0;
  const wireMessages = [];
  const relayAttempts = new Map();
  let failQaModeRelease = false;
  let openDialogAfterQaObserve = null;
  let relayOwner = null;
  const socket = new EventEmitter();
  socket._local = true;
  const tabWcs = new Map([["tab-a", 101]]);
  socket.readyState = 1;
  socket.ping = () => {};
  socket.close = () => { socket.readyState = 3; socket.emit("close"); };
  const send = message => socket.emit("message", Buffer.from(JSON.stringify(message)));
  let nextWc = 200;
  socket.send = raw => {
    const message = JSON.parse(String(raw));
    wireMessages.push(message);
    if (message.type === "wake-tab") {
      const wc = ++nextWc;
      tabWcs.set(message.tabId, wc);
      queueMicrotask(() => {
        send({ type: "browser-tab-wc", wc, tabId: message.tabId, space: "X", url: "about:blank", win: "console" });
        send({ type: "browser-target-generation", wc, documentGeneration: 1, debuggerGeneration: 1 });
      });
    }
    if (message.type === "emulator-ask") {
      emulatorCalls.push(message);
      if (message.kind === "list") emulatorListCalls += 1;
      if (message.kind === "list" && emulatorListCalls === failEmulatorListAt) {
        queueMicrotask(() => send({ type: "emulator-reply", id: message.id, ok: false, error: "fixture 승인 단계 목록 실패" }));
        return;
      }
      let reply = message.kind === "list"
        ? { tabs: structuredClone(emulatorTabs) }
        : message.kind === "viewport" ? { data: { current: "phone", presets: ["phone"] } }
          : {};
      if (message.kind === "open") {
        if (message.device) {
          const opened = emulatorTabs.find(tab => [tab.udid, tab.persistentId].includes(message.device)) || emulatorTabs[0];
          reply = { udid: opened.udid, persistentId: opened.persistentId };
        } else {
          automaticIos += 1;
          const udid = `00000000-0000-0000-0000-${String(automaticIos).padStart(12, "0")}`;
          emulatorTabs.push({ udid, persistentId: udid, owner: message.owner, space: "X", tab: `ios-tab-${automaticIos}` });
          reply = { udid, persistentId: udid };
        }
      }
      queueMicrotask(() => send({ type: "emulator-reply", id: message.id, ok: true, ...reply }));
    }
    if (message.type === "worker.accept") queueMicrotask(() => {
      const previousBoot = String(relayOwner || "").split(":")[0];
      const nextBoot = String(message.workerGeneration || "").split(":")[0];
      const accepted = !relayOwner || relayOwner === message.workerGeneration || previousBoot !== nextBoot
        || message.takeover === true;
      if (accepted) relayOwner = message.workerGeneration;
      send({ type: "worker.accepted", id: message.id, ok: accepted,
        ...(accepted ? { data: {} } : { code: "BUSY", error: "이전 세대가 남았습니다." }) });
    });
    if (message.type === "worker.retire") queueMicrotask(() => {
      const retired = relayOwner === message.workerGeneration;
      if (retired) relayOwner = null;
      send({ type: "worker.retired", id: message.id, ok: retired,
        ...(retired ? { data: {} } : { code: "STALE_WORKER", error: "다른 세대입니다." }) });
    });
    if (message.type === "cdp-exec") queueMicrotask(async () => {
      relayCalls.push(message);
      const attemptKey = `${message.cmd}:${message.args?.fixture || ""}`;
      relayAttempts.set(attemptKey, (relayAttempts.get(attemptKey) || 0) + 1);
      if (message.cmd === "redact" && message.args?.workerMarker === "slow") await sleep(3100);
      if (message.cmd === "qa.anchor") {
        const result = await anchor(message.args);
        anchorCalls.push({ args: message.args, result });
        send({ type: "cdp-result", id: message.id, ok: result.ok, data: result.data, error: result.error });
      } else if (message.cmd === "qa-mode" && message.args?.enabled === false && failQaModeRelease) {
        send({ type: "cdp-result", id: message.id, ok: false, error: "fixture QA mode 해제 실패", code: "EXECUTOR_GONE" });
      } else if (message.args?.fixture === "sent-unknown-once" && relayAttempts.get(attemptKey) === 1) {
        send({ type: "cdp-result", id: message.id, ok: false, error: "timeout(30s)", code: "TIMEOUT" });
      } else if (message.args?.fixture === "electron-error") {
        send({ type: "cdp-result", id: message.id, ok: false, error: "fixture selector missing", code: "NOT_FOUND" });
      } else if (message.cmd === "cdp.subscribe") {
        send({ type: "cdp-result", id: message.id, ok: true,
          data: { subscribed: true, subscriptionId: message.args.subscriptionId } });
        queueMicrotask(() => send({ type: "relay-event", event: {
          workerGeneration: message.workerGeneration,
          subscriptionId: message.args.subscriptionId,
          eventSeq: 1,
          method: "Runtime.consoleAPICalled",
          params: { fixture: true },
        } }));
      } else if (message.cmd === "dialog.state") {
        send({ type: "cdp-result", id: message.id, ok: true, data: { dialog: null } });
      } else if (baseCommandFixtures[message.cmd]) {
        // 단위 실행을 알린 메인의 기본 명령 (dialog · redact 가 옛 Electron 명령 대신 부르는 것)
        send({ type: "cdp-result", id: message.id, ok: true, data: baseCommandFixtures[message.cmd](message) });
      } else {
        const data = message.cmd === "url" || message.cmd === "wc.info" ? { url: "https://e2e.test/" }
          : message.cmd === "qa-snapshot" || message.cmd === "snapshot"
            ? { url: "https://e2e.test/", snapshot: "fixture", trusted: true }
            : message.cmd === "qa-background-observe"
              ? { id: "background-e2e", reactionId: "background-e2e", candidates: [], unexpected: [], scenes: [] }
              : message.cmd === "qa-reaction-end"
                ? { id: "background-e2e", reactionId: "background-e2e", candidates: [], unexpected: [], scenes: [] }
            : message.cmd === "dialog" ? { none: true, note: "떠 있는 확인 창이 없습니다." } : {};
        send({ type: "cdp-result", id: message.id, ok: true, data });
        if (["qa-observe", "observe"].includes(message.cmd) && openDialogAfterQaObserve?.wc === message.wc) {
          const dialog = openDialogAfterQaObserve;
          openDialogAfterQaObserve = null;
          setTimeout(() => send({ type: "browser-dialog-open", wc: dialog.wc, kind: "confirm", message: "종료 중 확인 창" }), 1);
        }
      }
    });
  };
  wss.clients.add(socket);
  wss.emit("connection", socket, { socket: { remoteAddress: "127.0.0.1" } });
  send({ type: "cdp-executor-register", app: "/fixture/Iris.app", pid: 7001 });
  send({ type: "browser-sync", mutation: { op: "group.create", space: "X", id: "ai:A", name: "A" } });
  send({ type: "browser-sync", mutation: { op: "tab.open", space: "X", id: "tab-a", url: "https://e2e.test/", group: "ai:A" } });
  send({ type: "browser-tab-wc", wc: 101, tabId: "tab-a", space: "X", url: "https://e2e.test/", win: "console" });
  send({ type: "browser-target-generation", wc: 101, documentGeneration: 1, debuggerGeneration: 1 });

  const initial = await waitFor(async () => (await request("GET", "/mcp-worker/status")).body.accepting
    ? (await request("GET", "/mcp-worker/status")).body : null);
  const serverPid = process.pid;
  const sessionlessTabs = (await request("POST", "/browser-cmd", { cmd: "tabs", args: {} })).body;
  assert.equal(sessionlessTabs.ok, true, sessionlessTabs.error);
  const tabAHandle = await waitFor(async () => {
    const tabs = (await request("POST", "/browser-cmd", { cmd: "tabs", session: "A", args: {} })).body;
    return tabs.data?.tabs?.find(tab => tab.tabId === "tab-a")?.handle || null;
  });

  const charter = {
    question: "F12 host 부수 효과가 유지되는가?", scope: "F12 통합 fixture", exclusions: "없음",
    environment: "격리된 임시 상태", sharedEnvironment: false, timebox: "1분", people: "없음", documents: "없음",
  };
  const sessionRecord = {
    work: "F12 host 부수 효과를 확인했다", curios: "없음", checked: "F12 통합 경로",
    unverified: { items: "없음", reason: "해당 없음" }, blockers: "없음", outOfScope: "없음", risks: "없음",
    stopCriterion: "questions_answered", remainingQuestions: "없음",
  };
  const plan = (entries = [], decision = "test") => ({
    build: { repo: root },
    risks: [{ id: "fixture-risk", risk: "host 부수 효과가 달라질 수 있다", size: "mid", knowledge: "some", decision,
      ...(decision === "test" ? {} : { reason: "F12 host release만 확인" }) }],
    listRationale: "각 host 연산의 외부 효과를 확인한다", entries, surfaces: entries.length ? entries : ["https://e2e.test/"],
  });
  const rowDeclaration = (id, retestOf) => ({
    action: "declare", id, what: `${id} 결과`, given: "통합 fixture", basis: "spec", basisNote: "F12 요구",
    paths: ["정상"], risk: ["fixture-risk"], oracle: "F12 요구와 같은 부수 효과",
    dataChanging: false, mustNotChange: { notApplicable: true, reason: "격리된 fixture 상태만 사용" },
    ...(retestOf ? { retestOf } : {}),
  });
  const seedLedger = createQaLedger({ anchor });
  const reportShot = path.join(fixture, "report.png");
  fs.writeFileSync(reportShot, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz8AAAAASUVORK5CYII=", "base64"));
  const seedCompleteRun = async (runId) => {
    await seedLedger.begin({ runId, session: "A", plan: plan(["https://e2e.test/"]), charter });
    await seedLedger.append(runId, { kind: "row", action: "declare", rowId: "saved", rowData: rowDeclaration("saved") });
    const lane = { rowId: "saved", path: "정상", lanes: [["saved", "정상"]], surface: "tab-a", url: "https://e2e.test/" };
    await seedLedger.append(runId, { kind: "entry", surface: "tab-a", tab: "tab-a", url: "https://e2e.test/" });
    await seedLedger.append(runId, { kind: "row", action: "open", ...lane, rowData: {} });
    await seedLedger.append(runId, { kind: "observation", cmd: "snapshot", ...lane, pass: true });
    const expected = { effects: [{ id: "saved", type: "appear", text: "Saved", oracle: "명세나 대화에서 정한 내용" }], within: 100 };
    const accepted = await seedLedger.append(runId, { kind: "accepted", cmd: "click", ...lane, expected });
    await seedLedger.append(runId, { kind: "frame", phase: "S1", claim: { kind: "S1" }, ...lane, acceptedSeq: accepted.seq, shot: reportShot });
    await seedLedger.append(runId, { kind: "action", cmd: "click", ...lane, acceptedSeq: accepted.seq, expected, pass: true, trusted: true });
    const after = await seedLedger.append(runId, { kind: "frame", phase: "S2", claim: { kind: "S2", effectId: "saved" }, ...lane,
      acceptedSeq: accepted.seq, shot: reportShot });
    await seedLedger.append(runId, { kind: "reaction", cmd: "click", ...lane, acceptedSeq: accepted.seq, expected, pass: true,
      detail: { pass: true, effects: [{ ...expected.effects[0], observed: true, sceneSeq: after.seq }] } });
    await seedLedger.append(runId, { kind: "observation", cmd: "observe", ...lane, pass: true });
    await seedLedger.append(runId, { kind: "assertion", ...lane, pass: true,
      expected: { mode: "contains", text: "Saved" }, observed: "Saved", shot: reportShot });
    await seedLedger.append(runId, { kind: "row", action: "close", ...lane,
      rowData: { color: "green", note: "Saved 표시", sceneJudgment: "결과 화면 전체를 확인했다" } });
    await seedLedger.end(runId, { session: sessionRecord });
  };
  const beginQa = async (entries = [], decision = "test") => {
    const response = (await request("POST", "/qa-cmd", { cmd: "run_begin", session: "A", args: {
      plan: plan(entries, decision), charter,
    } })).body;
    assert.equal(response.ok, true, response.error);
    return response.data;
  };
  const openQaEntry = async (run, url = "https://e2e.test/") => {
    const response = (await request("POST", "/qa-cmd", { cmd: "open_entry", session: "A", run: run.runId, key: run.runKey,
      args: { url, newTab: true } })).body;
    assert.equal(response.ok, true, response.error);
    return response.data.tabId;
  };

  await t.test("qa_report resume.from은 요청한 과거 run anchor를 읽는다", async () => {
    await seedLedger.begin({ runId: "f12-report-a", session: "A", plan: plan(), charter });
    await seedCompleteRun("f12-report-b");
    const resumed = (await request("POST", "/qa-cmd", { cmd: "run_resume", session: "A", run: "f12-report-b", args: {} })).body;
    assert.equal(resumed.ok, true, resumed.error);
    const start = anchorCalls.length;
    const report = (await request("POST", "/qa-cmd", { cmd: "report", session: "A", run: "f12-report-b", key: resumed.data.runKey,
      args: { resume: { from: "f12-report-a" } } })).body;
    assert.equal(report.ok, false);
    assert.doesNotMatch(report.error || "", /RUN_DENIED|회차가 다릅니다/);
    assert.equal(anchorCalls.slice(start).some(call => call.args.op === "read" && call.args.runId === "f12-report-a"
      && call.args.run === "f12-report-a"), true);
  });

  await t.test("qa-fix retestOf는 요청한 과거 run anchor를 읽는다", async () => {
    await seedLedger.begin({ runId: "f12-retest-a", session: "A", plan: plan(), charter });
    const failure = await seedLedger.append("f12-retest-a", { kind: "assertion", pass: false, rowId: "saved" });
    const defect = await seedLedger.append("f12-retest-a", { kind: "defect", rowId: "saved",
      detail: { problem: "Saved 표시 누락", failureSeq: failure.seq } });
    await seedLedger.append("f12-retest-a", { kind: "fix", detail: { defect: defect.seq, commit: "a".repeat(40) } });
    const current = await beginQa();
    const start = anchorCalls.length;
    const declared = (await request("POST", "/qa-cmd", { cmd: "row", session: "A", run: current.runId, key: current.runKey,
      args: rowDeclaration("retest", { run: "f12-retest-a", defect: defect.seq }) })).body;
    assert.equal(declared.ok, true, declared.error);
    assert.equal(anchorCalls.slice(start).some(call => call.args.op === "read" && call.args.runId === "f12-retest-a"
      && call.args.run === "f12-retest-a"), true);
  });

  await t.test("QA app pick 조회는 pane을 확인하고 등록한다", async () => {
    const run = await beginQa();
    try {
      const start = herdrCalls.filter(method => method === "pane.get").length;
      const picks = (await request("POST", "/qa-cmd", { cmd: "app_picks", session: "A", run: run.runId, key: run.runKey, args: {} })).body;
      assert.equal(picks.ok, true, picks.error);
      assert.equal(herdrCalls.filter(method => method === "pane.get").length, start + 1);
    } finally {
      await request("POST", "/qa-cmd", { cmd: "run_end", session: "A", run: run.runId, key: run.runKey, args: { session: sessionRecord } });
    }
  });

  await t.test("QA dialog 상태 조회와 응답은 제어 활동을 표시한다", async () => {
    const run = await beginQa(["https://e2e.test/"], "accept");
    const tab = await openQaEntry(run);
    try {
      const { releaseControl } = await import("../server/browser-runtime.js");
      const labeled = message => message.type === "control-active"
        && message.tabs?.some(item => item.tabId === tab && item.labels?.includes("iris-qa"));
      const expect = { effects: [{ type: "none", oracle: "현실에서 알거나 볼 수 있는 사실" }], within: 100 };
      // 창이 없을 때는 상태 조회만 실행됨
      releaseControl(tab);
      let start = wireMessages.length;
      const stateOnly = (await request("POST", "/qa-cmd", { cmd: "dialog", session: "A", run: run.runId, key: run.runKey,
        args: { answer: "cancel", expect } })).body;
      assert.equal(stateOnly.ok, true, stateOnly.error);
      assert.equal(wireMessages.slice(start).some(labeled), true);
      releaseControl(tab);
      send({ type: "browser-dialog-open", wc: tabWcs.get(tab), kind: "confirm", message: "F12 dialog" });
      start = wireMessages.length;
      const answered = (await request("POST", "/qa-cmd", { cmd: "dialog", session: "A", run: run.runId, key: run.runKey,
        args: { answer: "cancel", expect } })).body;
      assert.equal(answered.ok, true, answered.error);
      assert.equal(wireMessages.slice(start).some(labeled), true);
    } finally {
      await request("POST", "/qa-cmd", { cmd: "run_end", session: "A", run: run.runId, key: run.runKey, args: { session: sessionRecord } });
    }
  });

  await t.test("회차 종료 release는 마지막 기록 중 열린 dialog에 막히지 않는다", async () => {
    const run = await beginQa(["https://e2e.test/"], "accept");
    const tab = await openQaEntry(run);
    openDialogAfterQaObserve = { wc: tabWcs.get(tab) };
    try {
      const ended = (await request("POST", "/qa-cmd", { cmd: "run_end", session: "A", run: run.runId, key: run.runKey,
        args: { session: sessionRecord } })).body;
      assert.equal(ended.ok, true, ended.error);
      assert.equal(relayCalls.some(call => call.cmd === "qa-mode" && call.args?.enabled === false), true);
    } finally {
      openDialogAfterQaObserve = null;
      send({ type: "browser-dialog-closed", wc: tabWcs.get(tab) });
      await request("POST", "/qa-cmd", { cmd: "close_tab", session: "A", run: run.runId, key: run.runKey, args: { tab } });
    }
  });

  const askWireStart = wireMessages.length;
  const sessionlessAsk = (await request("POST", "/browser-cmd", { cmd: "ask", args: { message: "세션 없는 질문" } })).body;
  assert.equal(sessionlessAsk.data?.question, "세션 없는 질문");
  assert.equal(wireMessages.slice(askWireStart).some(message => ["ai-ask", "ai-notify"].includes(message.type)), false);
  const sessionlessDevices = (await request("POST", "/browser-cmd", { cmd: "app-devices", args: {} })).body;
  assert.equal(sessionlessDevices.data?.tabs?.[0]?.udid, "device-1");
  const browser = (await request("POST", "/browser-cmd", { cmd: "url", session: "A", args: { tab: "tab-a" } })).body;
  assert.equal(browser.data?.url, "https://e2e.test/");
  const target = (await request("POST", "/browser-cmd", { cmd: "target", session: "A", args: {} })).body;
  assert.deepEqual(Object.keys(target.data).sort(), ["handle", "pending", "pinned", "pinnedAll", "session", "tab", "tabId"].sort());
  send({ type: "browser-sync", mutation: { op: "tab.open", space: "X", id: "tab-dead", url: "https://dead.test/", group: "ai:A" } });
  send({ type: "browser-tab-wc", wc: 102, tabId: "tab-dead", space: "X", url: "https://dead.test/", win: "console" });
  send({ type: "browser-target-generation", wc: 102, documentGeneration: 1, debuggerGeneration: 1 });
  const deadHandle = await waitFor(async () => {
    const tabs = (await request("POST", "/browser-cmd", { cmd: "tabs", session: "A", args: {} })).body;
    return tabs.data?.tabs?.find(tab => tab.tabId === "tab-dead")?.handle || null;
  });
  send({ type: "browser-sync", mutation: { op: "tab.close", space: "X", id: "tab-dead" } });
  send({ type: "browser-tab-gone", wc: 102, tabId: "tab-dead" });
  const deadTarget = await waitFor(async () => {
    const reply = (await request("POST", "/browser-cmd", { cmd: "url", session: "A", args: { tab: deadHandle } })).body;
    return /없습니다/.test(reply.error || "") ? reply : null;
  });
  assert.equal(deadTarget.data.tabs.some(tab => tab.tabId === "tab-a"), true);
  const missingReview = (await request("POST", "/browser-cmd", {
    cmd: "notify", session: "A", args: { level: "info", title: "확인", review: true },
  })).body;
  assert.equal(missingReview.ok, false);
  assert.match(missingReview.error, /tab이 필요/);
  const reviewIds = [];
  for (const title of ["보고서 1", "보고서 2", "보고서 3", "보고서 4", "보고서 5"]) {
    const notice = (await request("POST", "/browser-cmd", {
      cmd: "notify", session: "A", args: { level: "info", title, review: true, tab: tabAHandle },
    })).body;
    assert.equal(notice.ok, true, notice.error);
    assert.notEqual(notice.data.shown, "merged");
    assert.equal(notice.data.tab, tabAHandle);
    reviewIds.push(notice.data.id);
  }
  assert.equal(new Set(reviewIds).size, 5);
  const reviewMessages = wireMessages.filter(message => message.type === "ai-notify" && reviewIds.includes(message.id));
  assert.equal(reviewMessages.length, 5);
  assert.equal(reviewMessages.every(message => message.review === true && message.tab === "tab-a"), true);
  for (const title of ["하나", "둘", "셋"]) {
    await request("POST", "/browser-cmd", { cmd: "notify", args: { level: "info", title } });
  }
  const mergedNotice = (await request("POST", "/browser-cmd", {
    cmd: "notify", args: { level: "info", title: "넷" },
  })).body;
  assert.equal(mergedNotice.data.shown, "merged");
  send({ type: "browser-sync", mutation: { op: "tab.open", space: "X", id: "tab-sleep", url: "https://sleep.test/", group: "ai:A" } });
  const sleepingTab = await waitFor(async () => {
    const reply = (await request("POST", "/browser-cmd", { cmd: "tabs", session: "A", args: {} })).body;
    return reply.data?.tabs?.find(tab => tab.tabId === "tab-sleep") || null;
  });
  const pinnedSleep = (await request("POST", "/browser-cmd", {
    cmd: "target", session: "A", args: { tab: sleepingTab.handle },
  })).body;
  assert.equal(pinnedSleep.ok, true, pinnedSleep.error);
  const woke = (await request("POST", "/browser-cmd", { cmd: "url", session: "A", args: {} })).body;
  assert.equal(woke.ok, true, woke.error);
  assert.equal(tabWcs.has("tab-sleep"), true);
  await request("POST", "/browser-cmd", { cmd: "untarget", session: "A", args: { tab: sleepingTab.handle } });
  const emptyAsk = (await request("POST", "/browser-cmd", { cmd: "ask", session: "A", args: { message: "   " } })).body;
  assert.deepEqual(emptyAsk, { ok: false, error: "message를 적어 주세요." });
  const approve = (await request("POST", "/browser-cmd", { cmd: "approve", session: "A", args: {
    summary: "배포할까요?", approve_label: "진행", deny_label: "중지",
  } })).body;
  assert.equal(approve.data?.question, "배포할까요?");
  assert.deepEqual(approve.data?.choices, ["진행", "중지"]);
  assert.equal(approve.data?.approved, false);
  const appDevices = (await request("POST", "/browser-cmd", { cmd: "app-devices", session: "A", args: {} })).body;
  assert.equal(appDevices.data?.tabs?.[0]?.udid, "device-1");
  const appViewport = (await request("POST", "/browser-cmd", { cmd: "app-viewport", session: "A", args: { device: "device-1" } })).body;
  assert.equal(appViewport.data?.current, "phone");
  const appOpen = (await request("POST", "/browser-cmd", { cmd: "app-open", session: "A", args: { device: "device-1" } })).body;
  assert.equal(appOpen.data?.udid, "device-1");
  assert.equal(emulatorCalls.some(call => call.kind === "list"), true);
  const targetsBefore = (await request("POST", "/browser-cmd", { cmd: "app-targets-get", session: "A", args: {} })).body;
  assert.equal(Object.hasOwn(targetsBefore.data, "assignments"), false);
  await request("POST", "/browser-cmd", { cmd: "app-targets-set", session: "A", args: { devices: ["device-1"] } });
  await request("POST", "/browser-cmd", { cmd: "app-targets-set", session: "A", args: { devices: [] } });
  assert.equal(emulatorCalls.some(call => call.kind === "release" && call.owner === "A" && call.keep.length === 0), true);
  const missingTarget = (await request("POST", "/browser-cmd", { cmd: "url", session: "A", args: { tab: "@missing" } })).body;
  assert.match(missingTarget.error, /그런 탭 핸들이 없습니다/);
  assert.equal(Array.isArray(missingTarget.data?.tabs), true);
  const ordinaryRelayStart = relayCalls.length;
  for (const command of ["qa-input", "qa-anchor", "run", "row", "journal", "expect", "report"]) {
    const denied = (await request("POST", "/browser-cmd", { cmd: command, session: "A", args: { tab: "tab-a" } })).body;
    assert.equal(denied.ok, false, command);
    assert.match(denied.error, /QA 전용 명령/);
  }
  assert.equal(relayCalls.length, ordinaryRelayStart);
  const goto = (await request("POST", "/browser-cmd", { cmd: "goto", session: "A",
    args: { tab: "tab-a", url: "https://e2e.test/next" } })).body;
  assert.equal(goto.ok, true, goto.error);
  assert.equal(relayCalls.at(-1).cmd, "goto");
  const retriedLocate = (await request("POST", "/browser-cmd", { cmd: "locate", session: "A",
    args: { tab: "tab-a", fixture: "sent-unknown-once" } })).body;
  assert.equal(retriedLocate.ok, true, retriedLocate.error);
  assert.equal(retriedLocate.data?.retried, 1);
  assert.equal(relayAttempts.get("locate:sent-unknown-once"), 2);
  const singleClick = (await request("POST", "/browser-cmd", { cmd: "click", session: "A",
    args: { tab: "tab-a", fixture: "sent-unknown-once" } })).body;
  assert.equal(singleClick.ok, false);
  assert.equal(relayAttempts.get("click:sent-unknown-once"), 1);
  const electronError = (await request("POST", "/browser-cmd", { cmd: "text", session: "A",
    args: { tab: "tab-a", fixture: "electron-error" } })).body;
  assert.equal(electronError.error, "fixture selector missing");
  assert.equal(Object.hasOwn(electronError, "sent"), false);
  assert.equal(relayAttempts.get("text:electron-error"), 1);
  const dialogNone = (await request("POST", "/browser-cmd", { cmd: "dialog", session: "A", args: { tab: "tab-a", answer: "cancel" } })).body;
  assert.deepEqual(dialogNone.data, { none: true, note: "떠 있는 확인 창이 없습니다." });
  const trace = (await request("POST", "/browser-cmd", { cmd: "trace", session: "A", args: {} })).body;
  assert.equal(trace.ok, true);
  assert.ok(trace.data.count >= 1);
  const qa = (await request("POST", "/qa-cmd", { cmd: "run_begin", session: "A", args: {
    plan: { build: { repo: root }, risks: [{ id: "r", risk: "결과 불일치", size: "mid", knowledge: "some", decision: "investigate", reason: "왕복 확인" }],
      listRationale: "공용 서버 왕복 확인", entries: ["https://e2e.test/"], surfaces: ["https://e2e.test/"] },
    charter: { question: "왕복하는가?", scope: "왕복", exclusions: "없음", environment: "격리 환경", sharedEnvironment: false,
      timebox: "1분", people: "없음", documents: "없음" },
  } })).body;
  assert.equal(qa.ok, true, `${qa.error}\n${JSON.stringify(anchorCalls)}`);
  const runId = qa.data.runId;
  const runKey = qa.data.runKey;
  const entry = (await request("POST", "/qa-cmd", { cmd: "open_entry", session: "A", run: runId, key: runKey,
    args: { url: "https://e2e.test/", newTab: true } })).body;
  assert.equal(entry.ok, true, entry.error);
  const qaTab = entry.data.tabId;
  const qaOwnedRelayStart = relayCalls.length;
  const qaOwned = (await request("POST", "/browser-cmd", { cmd: "url", session: "A", args: { tab: qaTab } })).body;
  assert.equal(qaOwned.error, "QA 회차가 소유한 탭입니다.");
  assert.equal(relayCalls.length, qaOwnedRelayStart);
  const emptyReason = (await request("POST", "/qa-cmd", { cmd: "ask_user", session: "A", run: runId, key: runKey,
    args: { reason: "   " } })).body;
  assert.equal(emptyReason.ok, false);
  assert.match(emptyReason.error, /reason/);
  send({ type: "browser-dialog-open", wc: tabWcs.get(qaTab), kind: "confirm", message: "먼저 답할까요?" });
  const blockedStart = relayCalls.length;
  const blockedSnapshot = (await request("POST", "/qa-cmd", {
    cmd: "snapshot", session: "A", run: runId, key: runKey, args: {},
  })).body;
  assert.equal(blockedSnapshot.ok, false);
  // 열린 창이 있으면 qa-mode 켜기도 보내지 않음(Chromium 이 창이 열린 동안 응답하지 않음, eb90977 qa-channel)
  assert.deepEqual(relayCalls.slice(blockedStart).filter(call => call.cmd === "qa-mode"), []);
  assert.equal(blockedSnapshot.data?.dialogOpen?.kind || blockedSnapshot.dialogOpen?.kind, "confirm", JSON.stringify(blockedSnapshot));
  const clearBlocked = (await request("POST", "/qa-cmd", { cmd: "dialog", session: "A", run: runId, key: runKey,
    args: { answer: "cancel", expect: { effects: [{ type: "none", oracle: "현실에서 알거나 볼 수 있는 사실" }], within: 100 } } })).body;
  assert.equal(clearBlocked.ok, true, clearBlocked.error);
  const snapshotStart = relayCalls.length;
  const snapshot = (await request("POST", "/qa-cmd", { cmd: "snapshot", session: "A", run: runId, key: runKey, args: {} })).body;
  assert.equal(snapshot.ok, true, snapshot.error);
  assert.equal(snapshot.data.snapshot, "fixture");
  const snapshotRelays = relayCalls.slice(snapshotStart).map(call => call.cmd).filter(command => command !== "qa.anchor");
  assert.deepEqual(snapshotRelays, ["qa-mode", "snapshot"]);
  send({ type: "browser-dialog-open", wc: tabWcs.get(qaTab), kind: "confirm", message: "계속할까요?" });
  const dialogState = (await request("POST", "/qa-cmd", { cmd: "dialog", session: "A", run: runId, key: runKey,
    args: { answer: "cancel", expect: { effects: [{ type: "none", oracle: "현실에서 알거나 볼 수 있는 사실" }], within: 100 } } })).body;
  assert.equal(dialogState.ok, true, dialogState.error);
  assert.equal(dialogState.data?.answered, "cancel");
  assert.doesNotMatch(dialogState.error || "", /qa_dialog로 답하라/);
  const afterDialog = (await request("POST", "/qa-cmd", { cmd: "snapshot", session: "A", run: runId, key: runKey, args: {} })).body;
  assert.equal(afterDialog.ok, true, afterDialog.error);
  assert.equal(wireMessages.some(message => message.type === "control-active"
    && message.tabs?.some(tab => tab.tabId === qaTab && tab.labels?.includes("iris-qa"))), true);
  // MCP 재연결: 새 stdio 는 key 없음. 같은 세션의 명시적 run_resume 만 새 key 로 이어받음
  const otherResume = (await request("POST", "/qa-cmd", { cmd: "run_resume", session: "B", run: runId, args: {} })).body;
  assert.equal(otherResume.ok, false);
  const resumed = (await request("POST", "/qa-cmd", { cmd: "run_resume", session: "A", run: runId, args: {} })).body;
  assert.equal(resumed.ok, true, resumed.error);
  assert.ok(resumed.data.runKey && resumed.data.runKey !== runKey);
  const staleKey = (await request("POST", "/qa-cmd", { cmd: "snapshot", session: "A", run: runId, key: runKey, args: {} })).body;
  assert.equal(staleKey.ok, false);
  const freshKey = (await request("POST", "/qa-cmd", { cmd: "snapshot", session: "A", run: runId, key: resumed.data.runKey, args: {} })).body;
  assert.equal(freshKey.ok, true, freshKey.error);

  const activated = await request("POST", "/mcp-worker/activate", {
    deployId: second.deployId, expectPrevId: initial.deployId, stopObservations: true,
  });
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  assert.equal(process.pid, serverPid);
  assert.notEqual(activated.body.worker.pid, initial.pid);
  const marked = (await request("POST", "/browser-cmd", { cmd: "tabs", session: "A", args: {} })).body;
  assert.equal(marked.workerMarker, "v2");
  // fixture 명령은 교체한 v2 작업 프로세스에만 있음
  await t.test("기기 승인은 선택 뒤 추가 list 실패 조건을 만들지 않는다", async () => {
    const run = await beginQa();
    const start = emulatorListCalls;
    failEmulatorListAt = start + 1;
    try {
      const target = (await request("POST", "/browser-cmd", { cmd: "fixture-authorize-device", session: "A",
        args: { device: "avd:Pixel_9", session: "A", fixtureRun: run.runId, fixtureKey: run.runKey } })).body;
      assert.equal(target.ok, true, target.error);
      assert.equal(emulatorListCalls, start);
    } finally {
      failEmulatorListAt = null;
      await request("POST", "/browser-cmd", { cmd: "fixture-release-target", session: "A",
        args: { target: "device:avd:Pixel_9", session: "A", fixtureRun: run.runId, fixtureKey: run.runKey } });
    }
  });

  await t.test("qa.tabClose는 qa-mode 해제 실패와 관계없이 소유권을 놓고 탭을 닫는다", async () => {
    const run = await beginQa();
    const created = (await request("POST", "/browser-cmd", { cmd: "fixture-qa-create", session: "A",
      args: { url: "https://e2e.test/", session: "A", fixtureRun: run.runId, fixtureKey: run.runKey } })).body;
    assert.equal(created.ok, true, created.error);
    const tab = created.data.tabId;
    failQaModeRelease = true;
    try {
      const closed = (await request("POST", "/browser-cmd", { cmd: "fixture-qa-close", session: "A",
        args: { closeTab: tab, session: "A", fixtureRun: run.runId, fixtureKey: run.runKey } })).body;
      assert.equal(closed.ok, true, closed.error);
      const tabs = (await request("POST", "/browser-cmd", { cmd: "tabs", session: "A", args: {} })).body;
      assert.equal(tabs.data?.tabs?.some(item => item.tabId === tab), false);
    } finally {
      failQaModeRelease = false;
      await request("POST", "/browser-cmd", { cmd: "fixture-qa-close", session: "A",
        args: { closeTab: tab, session: "A", fixtureRun: run.runId, fixtureKey: run.runKey } });
    }
  });
  const mobileResume = (await request("POST", "/qa-cmd", {
    cmd: "run_resume", session: "A", run: runId, args: {},
  })).body;
  assert.equal(mobileResume.ok, true, mobileResume.error);
  const activeRunKey = mobileResume.data.runKey;
  const androidTarget = (await request("POST", "/browser-cmd", { cmd: "fixture-authorize-device", session: "A",
    args: { device: "avd:Pixel_9", session: "A", fixtureRun: runId, fixtureKey: activeRunKey } })).body;
  assert.equal(androidTarget.ok, true, androidTarget.error);
  assert.equal(androidTarget.data?.device, "avd:Pixel_9", JSON.stringify(androidTarget));
  assert.equal(androidTarget.data?.owner, runId);
  const androidTargets = (await request("POST", "/browser-cmd", {
    cmd: "app-targets-get", session: "A", args: {},
  })).body;
  assert.deepEqual(androidTargets.data?.devices, []);

  emulatorTabs = [];
  const firstIos = (await request("POST", "/qa-cmd", {
    cmd: "app_snapshot", session: "A", run: runId, key: activeRunKey, args: {},
  })).body;
  assert.equal(firstIos.ok, true, firstIos.error);
  const targetsAfterAutomaticIos = (await request("POST", "/browser-cmd", {
    cmd: "app-targets-get", session: "A", args: {},
  })).body;
  assert.deepEqual(targetsAfterAutomaticIos.data?.devices, []);
  emulatorTabs = [];
  const secondIos = (await request("POST", "/qa-cmd", {
    cmd: "app_snapshot", session: "A", run: runId, key: activeRunKey, args: {},
  })).body;
  assert.equal(secondIos.ok, true, secondIos.error);
  assert.equal(emulatorCalls.filter(call => call.kind === "open" && !call.device).length, 2);
  // QA 기기 등록 저장은 에뮬레이터 탭 소유권을 놓지 않음(eb90977 qa-mobile 의 setAppTargets 직접 호출과 같음)
  const releaseBeforeQaClear = emulatorCalls.filter(call => call.kind === "release").length;
  const qaClear = (await request("POST", "/qa-cmd", {
    cmd: "app_target", session: "A", run: runId, key: activeRunKey, args: { clear: true },
  })).body;
  assert.equal(qaClear.ok, true, qaClear.error);
  assert.equal(emulatorCalls.filter(call => call.kind === "release").length, releaseBeforeQaClear);
  const relayEvent = (await request("POST", "/browser-cmd", {
    cmd: "fixture-relay-event", session: "A", args: { tab: "tab-a", subscriptionId: "server-e2e-sub" },
  })).body;
  assert.equal(relayEvent.ok, true, relayEvent.error);
  assert.equal(relayEvent.data?.subscription?.data?.subscribed, true);
  assert.equal(relayEvent.data?.event?.workerGeneration, activated.body.worker.workerGeneration);
  assert.equal(relayEvent.data?.event?.subscriptionId, "server-e2e-sub");
  assert.equal(relayEvent.data?.event?.eventSeq, 1);

  const lifecycleRelayStart = relayCalls.length;
  const lifecycleHostTask = (await request("POST", "/browser-cmd", {
    cmd: "fixture-lifecycle-host-task", session: "A", args: { tab: "tab-a", session: "A", fixtureRun: runId },
  })).body;
  assert.equal(lifecycleHostTask.ok, true, lifecycleHostTask.error);
  assert.equal(relayCalls.slice(lifecycleRelayStart).filter(call => call.cmd === "redact").length, 1);
  const invalidLifecycleStart = relayCalls.length;
  const invalidLifecycleHostTask = (await request("POST", "/browser-cmd", {
    cmd: "fixture-lifecycle-host-task", session: "A",
    args: { tab: "tab-a", session: "A", fixtureRun: runId, invalidPrefix: true },
  })).body;
  assert.equal(invalidLifecycleHostTask.ok, false);
  assert.equal(invalidLifecycleHostTask.code, "INVALID_REQUEST");
  assert.equal(relayCalls.length, invalidLifecycleStart);

  const hostTaskStart = relayCalls.length;
  send({ type: "browser-dialog-open", wc: tabWcs.get("tab-a"), kind: "confirm", message: "worker가 답할까요?" });
  const delegatedDialog = (await request("POST", "/browser-cmd", {
    cmd: "dialog", session: "A", args: { tab: "tab-a", answer: "cancel" },
  })).body;
  assert.equal(delegatedDialog.ok, true, delegatedDialog.error);
  const journalBegin = (await request("POST", "/browser-cmd", {
    cmd: "fixture-journal-begin", session: "A", args: { runId },
  })).body;
  assert.equal(journalBegin.ok, true, journalBegin.error);
  const delegatedClick = (await request("POST", "/browser-cmd", {
    cmd: "click", session: "A", args: { tab: "tab-a", sel: "button" },
  })).body;
  assert.equal(delegatedClick.ok, true, delegatedClick.error);
  send({ type: "browser-dialog-open", wc: tabWcs.get("tab-a"), kind: "confirm", message: "가릴 문구" });
  const delegatedRedact = (await request("POST", "/browser-cmd", {
    cmd: "url", session: "A", args: { tab: "tab-a" },
  })).body;
  assert.equal(delegatedRedact.ok, false);
  await request("POST", "/browser-cmd", { cmd: "dialog", session: "A", args: { tab: "tab-a", answer: "cancel" } });
  const resumedAfterDeploy = (await request("POST", "/qa-cmd", {
    cmd: "run_resume", session: "A", run: runId, args: {},
  })).body;
  assert.equal(resumedAfterDeploy.ok, true, resumedAfterDeploy.error);
  const snapshotAfterDeploy = (await request("POST", "/qa-cmd", {
    cmd: "snapshot", session: "A", run: runId, key: resumedAfterDeploy.data.runKey, args: {},
  })).body;
  assert.equal(snapshotAfterDeploy.ok, true, snapshotAfterDeploy.error);
  const closedAfterDeploy = (await request("POST", "/qa-cmd", {
    cmd: "close_tab", session: "A", run: runId, key: resumedAfterDeploy.data.runKey, args: { tab: qaTab },
  })).body;
  assert.equal(closedAfterDeploy.ok, true, closedAfterDeploy.error);
  const delegatedLegacyCalls = relayCalls.slice(hostTaskStart)
    .filter(call => ["dialog", "redact", "qa-mode", "screenshot"].includes(call.cmd));
  for (const command of ["dialog", "redact", "screenshot"]) {
    assert.equal(delegatedLegacyCalls.some(call => call.cmd === command && call.args?.workerMarker === "v2"), true,
      `${command} host 작업이 현재 worker 구현을 지나지 않았습니다: ${JSON.stringify(delegatedLegacyCalls)}`);
  }
  assert.equal(delegatedLegacyCalls.some(call => call.cmd === "qa-mode"
    && call.workerGeneration === activated.body.worker.workerGeneration), true,
    `qa-mode가 현재 worker 세대에서 실행되지 않았습니다: ${JSON.stringify(delegatedLegacyCalls)}`);

  // 메인이 단위 실행을 알리면 dialog · redact 는 옛 Electron 명령 대신 기본 명령 단위로 간다 (옛 명령 이름은 relay 에 나타나지 않음)
  send({ type: "cdp-executor-register", app: "/fixture/Iris.app", pid: 7001, features: ["worker-command-unit", "worker-native-commands"] });
  await sleep(150);
  const unitStart = relayCalls.length;
  send({ type: "browser-dialog-open", wc: tabWcs.get("tab-a"), kind: "confirm", message: "단위로 답할까요?" });
  const unitDialog = (await request("POST", "/browser-cmd", {
    cmd: "dialog", session: "A", args: { tab: "tab-a", answer: "cancel" },
  })).body;
  assert.equal(unitDialog.ok, true, unitDialog.error);
  send({ type: "browser-dialog-open", wc: tabWcs.get("tab-a"), kind: "confirm", message: "단위로 가릴 문구" });
  const unitBlocked = (await request("POST", "/browser-cmd", { cmd: "url", session: "A", args: { tab: "tab-a" } })).body;
  assert.equal(unitBlocked.ok, false);
  await request("POST", "/browser-cmd", { cmd: "dialog", session: "A", args: { tab: "tab-a", answer: "cancel" } });
  const unitCalls = relayCalls.slice(unitStart);
  assert.equal(unitCalls.some(call => call.cmd === "dialog.answer"), true, JSON.stringify(unitCalls.map(call => call.cmd)));
  assert.equal(unitCalls.some(call => call.cmd === "result.redact" && call.unit?.command === "redact" && call.unit?.outside === true), true);
  assert.equal(unitCalls.some(call => ["dialog", "redact"].includes(call.cmd)), false, "옛 Electron 명령으로 가지 않음");
  assert.equal(unitCalls.filter(call => call.unit?.command === "dialog").every(call => call.unit.outside === true), true);
  assert.equal(unitCalls.every(call => call.workerGeneration === activated.body.worker.workerGeneration), true);
  send({ type: "cdp-executor-register", app: "/fixture/Iris.app", pid: 7001 });
  await sleep(150);

  const fallbackActivation = await request("POST", "/mcp-worker/activate", {
    deployId: fallback.deployId, expectPrevId: second.deployId,
  });
  assert.equal(fallbackActivation.status, 200, JSON.stringify(fallbackActivation.body));
  send({ type: "browser-dialog-open", wc: tabWcs.get("tab-a"), kind: "confirm", message: "느린 위임 문구" });
  const slowStart = relayCalls.length;
  const slowResult = (await request("POST", "/browser-cmd", {
    cmd: "url", session: "A", args: { tab: "tab-a" },
  })).body;
  assert.equal(slowResult.ok, false);
  await sleep(200);
  const slowRedacts = relayCalls.slice(slowStart).filter(call => call.cmd === "redact");
  assert.equal(slowRedacts.length, 1, JSON.stringify(slowRedacts));
  assert.equal(slowRedacts[0].args?.workerMarker, "slow");
  await request("POST", "/browser-cmd", { cmd: "dialog", session: "A", args: { tab: "tab-a", answer: "cancel" } });

  const [firstBad, secondBad] = await Promise.all([
    request("POST", "/mcp-worker/activate", { deployId: broken.deployId, expectPrevId: fallback.deployId }),
    request("POST", "/mcp-worker/activate", { deployId: broken.deployId, expectPrevId: fallback.deployId }),
  ]);
  assert.ok([firstBad, secondBad].some(result => result.body.code === "DEPLOYMENT_BUSY"));
  assert.ok([firstBad, secondBad].some(result => result.body.code !== "DEPLOYMENT_BUSY" && result.status === 500));
  const restored = await waitFor(async () => {
    const value = (await request("GET", "/mcp-worker/status")).body;
    return value.accepting ? value : null;
  });
  assert.equal(restored.deployId, fallback.deployId);
  assert.equal((await request("GET", "/healthz")).body.pid, serverPid);

  const forced = await request("POST", "/mcp-worker/activate", { recover: true });
  assert.equal(forced.status, 200, JSON.stringify(forced.body));
  assert.equal(forced.body.recovered, true);
  assert.equal((await request("POST", "/browser-cmd", { cmd: "tabs", session: "A", args: {} })).body.ok, true);

  const firstBootGeneration = forced.body.worker.workerGeneration;
  socket.close();
  await firstServer.workerSupervisor.shutdown();
  assert.equal(relayOwner, firstBootGeneration);

  let restartedWss = null;
  EventEmitter.prototype.on = function (event, listener) {
    if (this.constructor?.name === "WebSocketServer") restartedWss = this;
    return originalOn.call(this, event, listener);
  };
  globalThis.setInterval = () => ({ unref() {} });
  const restartedServer = await import(`../server/index.js?worker-e2e-restart=${path.basename(fixture)}`);
  EventEmitter.prototype.on = originalOn;
  globalThis.setInterval = originalInterval;
  assert.ok(requestHandler && restartedWss && restartedServer.workerSupervisor);
  socket.readyState = 1;
  socket.destroyed = false;
  restartedWss.clients.add(socket);
  restartedWss.emit("connection", socket, { socket: { remoteAddress: "127.0.0.1" } });
  send({ type: "cdp-executor-register", app: "/fixture/Iris.app", pid: 7001 });
  send({ type: "browser-sync", mutation: { op: "group.create", space: "X", id: "ai:A", name: "A" } });
  send({ type: "browser-sync", mutation: { op: "tab.open", space: "X", id: qaTab, url: "https://e2e.test/", group: "ai:A" } });
  send({ type: "browser-tab-wc", wc: 301, tabId: qaTab, space: "X", url: "https://e2e.test/", win: "console" });
  send({ type: "browser-target-generation", wc: 301, documentGeneration: 1, debuggerGeneration: 1 });
  const restarted = await waitFor(async () => (await request("GET", "/mcp-worker/status")).body.accepting
    ? (await request("GET", "/mcp-worker/status")).body : null);
  assert.notEqual(restarted.workerGeneration.split(":")[0], firstBootGeneration.split(":")[0]);
  assert.equal(relayOwner, restarted.workerGeneration);

  const restartedOther = (await request("POST", "/qa-cmd", {
    cmd: "run_resume", session: "B", run: runId, args: {},
  })).body;
  assert.equal(restartedOther.ok, false);
  const restartedResume = (await request("POST", "/qa-cmd", {
    cmd: "run_resume", session: "A", run: runId, args: {},
  })).body;
  assert.equal(restartedResume.ok, true, restartedResume.error);
  assert.ok(restartedResume.data.runKey);
  await restartedServer.workerSupervisor.shutdown();
  socket.close();
});
