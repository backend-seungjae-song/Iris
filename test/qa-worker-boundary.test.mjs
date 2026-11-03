import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createIpcClient } from "../server/mcp-worker/ipc-client.js";
import { createWorkerActivity } from "../server/mcp-worker/activity.js";
import { createQaMobile } from "../server/qa-mobile.js";
import { qaRevision, qaRevisionMatches } from "../server/qa-revision.js";
import { EventEmitter } from "node:events";

test("worker 소유 QA 모듈은 공용 상태 모듈을 직접 import하지 않는다", () => {
  const forbidden = ["browser-runtime", "browser-commands", "browser/dialogs", "qa-ownership", "qa-journal", "app-targets", "qa-grants"];
  for (const file of ["server/qa-channel.js", "server/qa-mobile.js"]) {
    const source = fs.readFileSync(file, "utf8");
    for (const name of forbidden) assert.doesNotMatch(source, new RegExp(`from ["'][^"']*${name.replace("/", "\\/")}`), `${file}: ${name}`);
  }
});

test("host IPC 요청은 세대·identity·commandId·callId를 보존한다", async () => {
  const events = new EventEmitter(), sent = [];
  const ipc = createIpcClient({ workerGeneration: "boot:7", events, send: message => sent.push(message) });
  const pending = ipc.request("qa.tabCreate", { identity: { session: "s", run: "r", key: "k" },
    commandId: "boot:7/1", callId: 3, input: { url: "https://example.test" } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].workerGeneration, "boot:7");
  assert.equal(sent[0].commandId, "boot:7/1");
  assert.equal(sent[0].callId, 3);
  assert.deepEqual(sent[0].identity, { session: "s", run: "r", key: "k" });
  events.emit("message", { protocol: 1, type: "host.response", requestId: sent[0].requestId, workerGeneration: "boot:7", ok: true, output: { tabId: "tab" } });
  assert.deepEqual(await pending, { tabId: "tab" });
  ipc.close();
});

test("QA revision은 bundle id와 worker deploy id를 기록하고 기존 hash 판정을 읽는다", t => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-revision-worker-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const folder of ["server", "native", "web"]) fs.mkdirSync(path.join(dir, folder));
  fs.writeFileSync(path.join(dir, "server", "entry.js"), "v1");
  const legacy = qaRevision(dir);
  const current = qaRevision({ bundleId: "bundle-12", deployId: "deploy-34" });
  assert.equal(current, "bundle=bundle-12;worker=deploy-34");
  assert.equal(qaRevisionMatches(legacy, current, { legacyRevision: legacy }), true);
  assert.equal(qaRevisionMatches("0".repeat(64), current, { legacyRevision: legacy }), false);
});

test("모바일 reaction_start는 관찰 목록에 남고 중단 뒤 해제된다", async t => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-worker-mobile-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const device = "11111111-1111-4111-8111-111111111111";
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz8AAAAASUVORK5CYII=", "base64");
  const activity = createWorkerActivity();
  const mobile = createQaMobile({
    activity, shotsDir: dir,
    listDevices: async () => ({ ok: true, data: { tabs: [{ udid: device, tab: "phone", owner: "alice", mine: true }] } }),
    readTargets: async () => ({ alice: [device] }),
    backend: {
      verify: async () => {},
      tree: async () => [{ type: "Application", AXLabel: "Fixture", frame: { x: 0, y: 0, width: 1, height: 1 } }],
      input: async () => {},
      screenshot: async (_target, file) => fs.writeFileSync(file, png),
    },
  });
  const started = await mobile.execute("alice", "reaction_start", {
    device, expect: { effects: [{ type: "appear", text: "ready", oracle: "기능의 용도" }], within: 100 },
    action: { command: "tap", args: { x: 1, y: 1 } },
  });
  assert.equal(started.ok, true, started.error);
  assert.equal(activity.snapshot().observations.length, 1);
  await mobile.flush("alice", { close: true });
  assert.equal(activity.snapshot().observations.length, 0);
});

test("모바일 배경 관찰도 관찰 목록에 남고 저장·중단 뒤 해제된다", async t => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-worker-background-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const device = "22222222-2222-4222-8222-222222222222";
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz8AAAAASUVORK5CYII=", "base64");
  const activity = createWorkerActivity();
  const mobile = createQaMobile({
    activity, shotsDir: dir, reactionOptions: { interval: 1, tailMs: 1 },
    listDevices: async () => ({ ok: true, data: { tabs: [{ udid: device, tab: "phone", owner: "alice", mine: true }] } }),
    readTargets: async () => ({ alice: [device] }),
    backend: {
      verify: async () => {},
      tree: async () => [{ type: "Application", AXLabel: "Fixture", frame: { x: 0, y: 0, width: 1, height: 1 } }],
      input: async () => {},
      screenshot: async (_target, file) => fs.writeFileSync(file, png),
    },
  });
  const observed = await mobile.execute("alice", "background_observe", { device });
  assert.equal(observed.ok, true, observed.error);
  assert.equal(activity.snapshot().observations.length, 1);
  const flushed = await mobile.flush("alice", { close: true });
  assert.equal(flushed.observations.length, 1);
  assert.equal(activity.snapshot().observations.length, 0);
});
