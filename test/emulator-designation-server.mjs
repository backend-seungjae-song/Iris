import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-emulator-designation-"));
process.env.IRIS_STATE_DIR = stateDir;
process.env.IRIS_PORT = "4291";
const adbFile = path.join(stateDir, "adb");
const avdNamesFile = path.join(stateDir, "avd-names.json");
fs.writeFileSync(adbFile, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.length !== 5 || args[0] !== "-s" || args.slice(2).join(" ") !== "emu avd name") process.exit(2);
const names = JSON.parse(fs.readFileSync(${JSON.stringify(avdNamesFile)}, "utf8"));
const name = names[args[1]];
if (!name) process.exit(1);
process.stdout.write(name + "\\nOK\\n");
`, { mode: 0o700 });
process.env.IRIS_ADB = adbFile;
const { appTargetsFor, readAppTargets, setAppTargets } = await import("../server/app-targets.js");
const { handleEmulatorTargets } = await import("../server/emulator-targets.js");
const { resetPromptTargetsForTest } = await import("../server/prompt-targets.js");
const { runBrowserCmd, runSessionCmd } = await import("../server/browser-commands.js");
const { initWsTransport } = await import("../server/ws-transport.js");
const { noteEmulatorReply } = await import("../server/emulator-bridge.js");
const { createAppSurface } = await import("../bin/mcp/app.mjs");
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const targetFile = path.join(stateDir, "app-targets.json");
let tabs, asks;
const ui = { readyState: 1, _local: true, send(raw) {
  const request = JSON.parse(raw);
  asks.push(request);
  if (request.type !== "emulator-ask") return;
  if (request.kind === "reown") {
    for (const tab of tabs) if (request.devices.includes(tab.udid)) tab.owner = request.owner;
  }
  noteEmulatorReply({ type: "emulator-reply", id: request.id, ok: true,
    ...(request.kind === "list" ? { tabs } : {}) });
} };
initWsTransport({ wss: { clients: new Set([ui]) } });

function surface(pane) {
  return createAppSurface({ currentSession: async () => pane, journal: async () => null,
    addReceipt: () => ({ id: "unused" }),
    call: (cmd, args) => runSessionCmd(cmd, args, pane) || runBrowserCmd(cmd, args, pane),
  });
}
function designate(pane, udid, persistentId = null) {
  const messages = [];
  handleEmulatorTargets({ _local: true, _ui: true, send: (raw) => messages.push(JSON.parse(raw)) },
    { type: "emulator.target-pending", request: "designation", pane, udid, persistentId, name: "iPhone" });
  assert.equal(messages[0].ok, true);
  return runSessionCmd("prompt-targets", { markers: [messages[0].delimiter] }, pane);
}

test.beforeEach(() => {
  fs.rmSync(targetFile, { recursive: true, force: true });
  resetPromptTargetsForTest();
  fs.writeFileSync(avdNamesFile, JSON.stringify({ "emulator-5554": "Pixel_API_35", "emulator-5556": "Pixel_API_35" }));
  tabs = [{ udid: A, name: "iPhone", space: "space", tab: "tab-a", owner: "old" },
    { udid: B, name: "iPhone", space: "space", tab: "tab-b", owner: "other" }];
  asks = [];
});
test.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));

test("기기 지목을 제출하면 같은 이름의 다른 기기와 구분해 UDID를 저장하고 소유를 넘긴다", async () => {
  setAppTargets("old", [A]);
  setAppTargets("other", [B]);
  assert.equal(designate("new", A).ok, true);
  assert.deepEqual(appTargetsFor("new"), [A]);
  assert.deepEqual(appTargetsFor("old"), []);
  assert.deepEqual(appTargetsFor("other"), [B]);
  assert.equal(tabs[0].owner, "new");
  const app = surface("new");
  for (const location of ["column", "strip", "detached", "column"]) {
    tabs[0].location = location;
    tabs.reverse();
    assert.equal(await app.simTarget(), A);
  }
  assert.equal(asks.some((ask) => ask.kind === "open"), false);
});

test("지목한 기기를 끄면 다른 켜진 기기를 자동 선택하지 않고 지목을 유지한다", async () => {
  assert.equal(designate("new", A).ok, true);
  const app = surface("new");
  tabs = tabs.filter((tab) => tab.udid !== A);
  assert.equal(await app.simTarget(), null);
  assert.deepEqual(appTargetsFor("new"), [A]);
  assert.equal(asks.some((ask) => ask.kind === "open"), false);
  const result = await app.tools.find((tool) => tool.name === "app_snapshot").run({});
  assert.equal(result.ok, false);
  assert.match(result.error, /등록한 기기/);
});

test("지목 저장 파일이 손상되면 등록 없음으로 해석해 다른 기기를 켜지 않는다", async () => {
  fs.writeFileSync(targetFile, "{broken");
  assert.throws(() => readAppTargets());
  const response = runSessionCmd("app-targets-get", {}, "new");
  assert.equal(response.ok, false);
  const app = surface("new");
  assert.equal(await app.simTarget(), null);
  assert.equal(asks.some((ask) => ask.kind === "open"), false);
  assert.throws(() => setAppTargets("new", [A]));
  assert.equal(fs.readFileSync(targetFile, "utf8"), "{broken");
});

test("지목 저장 파일을 읽지 못하면 읽기 오류를 전하고 자동 선택하지 않는다", async () => {
  fs.mkdirSync(targetFile);
  const response = runSessionCmd("app-targets-get", {}, "new");
  assert.equal(response.ok, false);
  assert.match(response.error, /읽지 못/);
  assert.equal(await surface("new").simTarget(), null);
  assert.equal(asks.some((ask) => ask.kind === "open"), false);
});

test("처음 등록하기 전에는 빈 저장소로 읽는다", () => {
  assert.deepEqual(readAppTargets(), {});
  assert.deepEqual(runSessionCmd("app-targets-get", {}, "new").data.devices, []);
});

test("Android 지목은 같은 AVD의 새 serial을 쓰고 다른 AVD가 재사용한 옛 serial을 선택하지 않는다", async () => {
  tabs = [{ udid: "emulator-5554", name: "Pixel", persistentId: "Pixel_API_35", owner: "new" }];
  assert.equal(designate("new", "emulator-5554", "Pixel_API_35").ok, true);
  assert.deepEqual(appTargetsFor("new"), ["avd:Pixel_API_35"]);
  const app = surface("new");
  assert.equal(await app.simTarget(), "emulator-5554");
  tabs = [{ udid: "emulator-5554", name: "Other", persistentId: "Other_AVD", owner: "new" }];
  assert.equal(await app.simTarget(), null);
  tabs.push({ udid: "emulator-5556", name: "Pixel", persistentId: "Pixel_API_35", owner: "new" });
  assert.equal(await app.simTarget(), "emulator-5556");
  const targets = await app.tools.find((tool) => tool.name === "app_targets").run({});
  assert.deepEqual(targets.data.targets.map((target) => [target.udid, target.registered]), [["emulator-5554", false], ["emulator-5556", true]]);
  assert.equal(asks.some((ask) => ask.kind === "open"), false);
});

test("app_target도 Android 기기를 AVD 이름으로 등록한다", async () => {
  tabs = [{ udid: "emulator-5554", name: "Pixel", persistentId: "Pixel_API_35", owner: "new" }];
  const result = await surface("new").tools.find((tool) => tool.name === "app_target").run({ device: "emulator-5554" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.registered, ["avd:Pixel_API_35"]);
  assert.deepEqual(appTargetsFor("new"), ["avd:Pixel_API_35"]);
});

test("AVD 정보 없는 옛 Android 시리얼 지정은 다른 기기를 선택하거나 저장 파일을 바꾸지 않는다", async () => {
  setAppTargets("new", ["emulator-5554"]);
  tabs = [{ udid: "emulator-5554", name: "Other", persistentId: "Other_AVD", owner: "new" }];
  const before = fs.readFileSync(targetFile, "utf8");
  const app = surface("new");
  assert.equal(await app.simTarget(), null);
  const result = await app.tools.find((tool) => tool.name === "app_snapshot").run({});
  assert.equal(result.ok, false);
  assert.match(result.error, /다시 지목/);
  assert.equal(asks.some((ask) => ask.kind === "open"), false);
  assert.equal(fs.readFileSync(targetFile, "utf8"), before);
});

test("Android 지목 요청에 AVD 이름이 없으면 등록을 만들지 않는다", () => {
  const messages = [];
  handleEmulatorTargets({ _local: true, _ui: true, send: (raw) => messages.push(JSON.parse(raw)) },
    { type: "emulator.target-pending", pane: "new", udid: "emulator-5554" });
  assert.equal(messages[0].ok, false);
  assert.match(messages[0].error, /AVD 이름/);
  assert.deepEqual(appTargetsFor("new"), []);
});

test("지목 저장 파일 내부의 잘못된 값도 등록 없음으로 바꾸지 않는다", async () => {
  const app = surface("new");
  for (const value of [{ udid: A }, [null, "bad id!"], 7, "", [A, null]]) {
    fs.writeFileSync(targetFile, JSON.stringify({ new: value }));
    const before = fs.readFileSync(targetFile, "utf8");
    assert.equal(runSessionCmd("app-targets-get", {}, "new").ok, false);
    assert.equal(await app.simTarget(), null);
    assert.throws(() => setAppTargets("new", [A]));
    assert.equal(fs.readFileSync(targetFile, "utf8"), before);
  }
  assert.equal(asks.some((ask) => ask.kind === "open"), false);
  fs.writeFileSync(targetFile, JSON.stringify({ new: [] }));
  assert.deepEqual(appTargetsFor("new"), []);
});

test("오래된 탭 정보와 같은 serial을 다른 AVD가 쓰면 실제 adb 이름 확인으로 지목 실행을 거절한다", async () => {
  setAppTargets("new", ["avd:Pixel_API_35"]);
  tabs = [{ udid: "emulator-5554", name: "Pixel", persistentId: "Pixel_API_35", owner: "new" }];
  const app = surface("new");
  for (const actual of [{ "emulator-5554": "Other_AVD" }, {}]) {
    fs.writeFileSync(avdNamesFile, JSON.stringify(actual));
    assert.equal(await app.simTarget(), null);
    assert.equal(await app.simTarget("avd:Pixel_API_35"), null);
    const result = await app.tools.find((tool) => tool.name === "app_target").run({ device: "avd:Pixel_API_35" });
    assert.equal(result.ok, false);
    assert.match(result.error, /확인하지 못/);
  }
  assert.equal(asks.some((ask) => ask.kind === "open"), false);
  assert.deepEqual(appTargetsFor("new"), ["avd:Pixel_API_35"]);
});

test("기기 이름이나 UDID 앞자리가 겹치면 새 기기를 열지 않고 정확한 UDID를 요구한다", async () => {
  tabs = [{ udid: "ios-a", name: "iPhone", owner: "new" }, { udid: "ios-b", name: "iPhone", owner: "new" }];
  const app = surface("new");
  for (const device of ["iPhone", "ios-"]) {
    assert.equal(await app.simTarget(device), null);
    const result = await app.tools.find((tool) => tool.name === "app_target").run({ device });
    assert.equal(result.ok, false);
    assert.match(result.error, /여러 대 일치/);
  }
  assert.equal(await app.simTarget("ios-b"), "ios-b");
  tabs.pop();
  assert.equal(await app.simTarget("iPhone"), "ios-a");
  assert.equal(asks.some((ask) => ask.kind === "open"), false);
});
