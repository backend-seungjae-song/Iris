import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-emulator-additional-"));
process.env.IRIS_STATE_DIR = stateDir;
process.env.IRIS_PORT = "4291";
const adbFile = path.join(stateDir, "adb");
const namesFile = path.join(stateDir, "names.json");
fs.writeFileSync(adbFile, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.length !== 5 || args[0] !== "-s" || args.slice(2).join(" ") !== "emu avd name") process.exit(2);
const name = JSON.parse(fs.readFileSync(${JSON.stringify(namesFile)}, "utf8"))[args[1]];
if (!name) process.exit(1);
process.stdout.write(name + "\\nOK\\n");
`, { mode: 0o700 });
process.env.IRIS_ADB = adbFile;
const { createAppSurface } = await import("../bin/mcp/app.mjs");
const { setAppTargets } = await import("../server/app-targets.js");
const { runBrowserCmd } = await import("../server/browser-commands.js");
const { initWsTransport } = await import("../server/ws-transport.js");
const { noteEmulatorReply } = await import("../server/emulator-bridge.js");
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const D = "44444444-4444-4444-8444-444444444444";
const device = (udid, own = true) => ({ udid, name: "iPhone 13", mine: own, owner: own ? "session" : "other", tab: `tab-${udid}` });

function fixture({ registered = [], tabs = [], session = "session", openResult, registrationError, listError, append = device(B) } = {}) {
  const calls = [];
  let stored = [...registered];
  const app = createAppSurface({ currentSession: async () => session, journal: async () => null, addReceipt: () => ({}),
    call: async (cmd, args) => {
      calls.push({ cmd, args: structuredClone(args) });
      if (cmd === "app-targets-get") return registrationError || { ok: true, data: { devices: stored } };
      if (cmd === "app-targets-set") { stored = [...args.devices]; return { ok: true, data: { devices: stored } }; }
      if (cmd === "app-devices") return listError || { ok: true, data: { tabs } };
      if (cmd === "app-open") {
        if (openResult) return openResult;
        const added = Array.isArray(append) ? append.shift() : append;
        tabs.push(added);
        return { ok: true, data: { udid: added.udid, name: added.name, owner: "session" } };
      }
      throw new Error(`Unexpected command: ${cmd}`);
    } });
  return { target: app.tools.find(tool => tool.name === "app_target"), app, calls,
    registered: () => stored, opens: () => calls.filter(call => call.cmd === "app-open"),
    writes: () => calls.filter(call => call.cmd === "app-targets-set") };
}
test.beforeEach(() => {
  fs.writeFileSync(namesFile, JSON.stringify({ "emulator-5554": "Pixel", "emulator-5556": "Pixel_copy" }));
  fs.rmSync(path.join(stateDir, "app-targets.json"), { force: true });
});
test.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));

test("additional 옵션을 기존 app_target에 제공한다", () => {
  const f = fixture();
  assert.equal(f.target.schema.additional.type, "boolean");
  assert.match(f.target.desc, /사용하지 않는 기기를 먼저/);
});

test("같은 원본의 추가 요청은 기존 등록·소유 기기를 유지하고 새 기기를 등록한다", async () => {
  const original = [device(A), device(C), device(D, false)];
  const snapshot = structuredClone(original);
  const f = fixture({ registered: [A], tabs: original });
  const result = await f.target.run({ additional: true, device: A });
  assert.equal(result.ok, true);
  assert.deepEqual(f.opens().map(call => call.args), [{ additional: true, device: A }]);
  assert.deepEqual(result.data.registered, [A, C, B]);
  assert.deepEqual(f.registered(), [A, C, B]);
  assert.deepEqual(original.slice(0, snapshot.length), snapshot);
  assert.equal(await f.app.simTarget(), null);
  assert.equal(await f.app.simTarget(A), A);
  assert.equal(await f.app.simTarget(B), B);
});

test("원본을 생략하면 한 대의 등록·소유 기기를 원본으로 전달한다", async () => {
  for (const registered of [[A], []]) {
    const f = fixture({ registered, tabs: [device(A)] });
    assert.equal((await f.target.run({ additional: true })).ok, true);
    assert.deepEqual(f.opens()[0].args, { additional: true, device: A });
    assert.deepEqual(f.registered(), [A, B]);
  }
});

test("원본이 없으면 기기 인자를 보내지 않아 설정된 기본 모델을 쓴다", async () => {
  const f = fixture({ tabs: [device(C, false)] });
  assert.equal((await f.target.run({ additional: true })).ok, true);
  assert.deepEqual(f.opens()[0].args, { additional: true });
  assert.deepEqual(f.registered(), [B]);
});

test("원본이 여러 대거나 이름·앞자리로 여러 대가 일치하면 열기 전에 거절한다", async () => {
  for (const args of [{ additional: true }, { additional: true, device: "iPhone 13" }]) {
    const f = fixture({ registered: [A], tabs: [device(A), device(C)] });
    const result = await f.target.run(args);
    assert.equal(result.ok, false);
    assert.match(result.error, /여러 대/);
    assert.deepEqual(f.opens(), []);
    assert.deepEqual(f.writes(), []);
  }
  const f = fixture({ tabs: [device("ios-a"), device("ios-b")] });
  assert.equal((await f.target.run({ additional: true, device: "ios-" })).ok, false);
  assert.deepEqual(f.opens(), []);
});

test("네 대 제한은 등록·소유 기기의 중복을 제외하고 열기 전에 확인한다", async () => {
  const f = fixture({ registered: [A, B], tabs: [device(A), device(C), device(D)] });
  const result = await f.target.run({ additional: true, device: A });
  assert.equal(result.ok, false);
  assert.match(result.error, /최대 4대/);
  assert.deepEqual(f.opens(), []);
  assert.deepEqual(f.registered(), [A, B]);
});

test("동시 추가 요청도 현재 등록을 다시 읽고 네 대를 넘기기 전에 거절한다", async () => {
  const f = fixture({ registered: [A, C, D], tabs: [device(A), device(C), device(D)], append: [device(B), device("fifth")] });
  const results = await Promise.all([f.target.run({ additional: true, device: A }), f.target.run({ additional: true, device: A })]);
  assert.deepEqual(results.map(result => result.ok), [true, false]);
  assert.match(results[1].error, /최대 4대/);
  assert.equal(f.opens().length, 1);
  assert.deepEqual(f.registered(), [A, C, D, B]);
});

test("clear와 additional을 함께 쓰거나 세션이 없으면 아무 요청도 보내지 않는다", async () => {
  for (const [options, args] of [[{}, { clear: true, additional: true }], [{ session: null }, { additional: true }]]) {
    const f = fixture(options);
    assert.equal((await f.target.run(args)).ok, false);
    assert.deepEqual(f.calls, []);
  }
});

test("저장소·탭 목록 실패는 새 기기를 열거나 등록을 바꾸지 않는다", async () => {
  for (const options of [{ registrationError: { ok: false, error: "storage failed" } }, { listError: { ok: false, error: "Iris offline" } }]) {
    const f = fixture({ registered: [A], tabs: [device(A)], ...options });
    assert.equal((await f.target.run({ additional: true })).ok, false);
    assert.deepEqual(f.opens(), []);
    assert.deepEqual(f.writes(), []);
    assert.deepEqual(f.registered(), [A]);
  }
});

test("열기 실패와 실행 한도 응답은 그대로 전달하고 기존 등록을 보존한다", async () => {
  for (const openResult of [{ ok: false, error: "create failed" }, { ok: false, code: "capacity", error: "disk", data: { capacity: { limit: 2, diskOk: false } } }]) {
    const f = fixture({ registered: [A], tabs: [device(A)], openResult });
    assert.deepEqual(await f.target.run({ additional: true }), openResult);
    assert.deepEqual(f.registered(), [A]);
    assert.deepEqual(f.writes(), []);
  }
});

test("기존 기기나 다른 세션 소유 기기를 반환하면 추가 등록을 거절한다", async () => {
  for (const append of [device(A), device(B, false)]) {
    const f = fixture({ registered: [A], tabs: [device(A)], append });
    assert.equal((await f.target.run({ additional: true, device: A })).ok, false);
    assert.deepEqual(f.registered(), [A]);
    assert.deepEqual(f.writes(), []);
  }
});

test("additional 없는 app_target은 기존 한 대 교체·조회·해제를 유지한다", async () => {
  const f = fixture({ registered: [A, C], tabs: [device(A), device(C)] });
  assert.deepEqual((await f.target.run({})).data.registered, [A, C]);
  assert.deepEqual((await f.target.run({ device: C })).data.registered, [C]);
  assert.deepEqual(f.opens(), []);
  assert.deepEqual((await f.target.run({ clear: true })).data.registered, []);
});

test("Android 원본과 추가 기기를 AVD 이름으로 확인하고 등록한다", async () => {
  const original = { udid: "emulator-5554", persistentId: "Pixel", name: "Pixel", mine: true, owner: "session" };
  const append = { ...original, udid: "emulator-5556", persistentId: "Pixel_copy" };
  const f = fixture({ registered: ["avd:Pixel"], tabs: [original], append });
  assert.equal((await f.target.run({ additional: true })).ok, true);
  assert.deepEqual(f.opens()[0].args, { additional: true, device: "Pixel" });
  assert.deepEqual(f.registered(), ["avd:Pixel", "avd:Pixel_copy"]);
});

test("Android의 실제 AVD가 원본 정보와 다르면 새 기기를 열지 않는다", async () => {
  fs.writeFileSync(namesFile, JSON.stringify({ "emulator-5554": "Other" }));
  const f = fixture({ registered: ["avd:Pixel"], tabs: [{ udid: "emulator-5554", persistentId: "Pixel", name: "Pixel", mine: true, owner: "session" }] });
  const result = await f.target.run({ additional: true });
  assert.equal(result.ok, false);
  assert.match(result.error, /확인하지 못/);
  assert.deepEqual(f.opens(), []);
  assert.deepEqual(f.writes(), []);
});

test("Android 추가 기기의 실제 AVD가 응답과 다르면 기존 등록을 보존한다", async () => {
  fs.writeFileSync(namesFile, JSON.stringify({ "emulator-5556": "Other" }));
  const f = fixture({ registered: [A], tabs: [device(A)], append: { udid: "emulator-5556", persistentId: "Pixel_copy", mine: true, owner: "session" } });
  assert.equal((await f.target.run({ additional: true })).ok, false);
  assert.deepEqual(f.registered(), [A]);
  assert.deepEqual(f.writes(), []);
});

test("오래된 Android serial은 원본으로 자동 선택하지 않는다", async () => {
  const f = fixture({ registered: ["emulator-5554"] });
  assert.equal((await f.target.run({ additional: true })).ok, false);
  assert.deepEqual(f.opens(), []);
  assert.deepEqual(f.registered(), ["emulator-5554"]);
});

test("서버는 인증된 additional 요청과 원본을 에뮬레이터로 전달한다", async () => {
  setAppTargets("session", [A]);
  setAppTargets("other", [C, "avd:Pixel"]);
  const requests = [];
  const ui = { readyState: 1, _local: true, send(raw) {
    const request = JSON.parse(raw);
    requests.push(request);
    if (request.type === "emulator-ask") noteEmulatorReply({ type: "emulator-reply", id: request.id, ok: true, udid: B, name: "iPhone 13", owner: request.owner });
  } };
  initWsTransport({ wss: { clients: new Set([ui]) } });
  const result = await runBrowserCmd("app-open", { additional: true, device: A }, "session");
  assert.equal(result.ok, true);
  assert.equal(result.data.udid, B);
  assert.equal(result.data.owner, "session");
  const request = requests.find(request => request.type === "emulator-ask");
  assert.equal(request.additional, true);
  assert.equal(request.device, A);
  assert.equal(request.owner, "session");
  assert.deepEqual(request.reservedDevices, [A, C, "avd:Pixel"]);
  assert.equal((await runBrowserCmd("app-open", { additional: true }, null)).ok, false);
  assert.equal(requests.filter(request => request.type === "emulator-ask").length, 1);
  assert.equal((await runBrowserCmd("app-open", { device: A }, "session")).ok, true);
  assert.deepEqual(requests.filter(request => request.type === "emulator-ask")[1].reservedDevices, [C, "avd:Pixel"]);
  fs.writeFileSync(path.join(stateDir, "app-targets.json"), "{broken");
  const failed = await runBrowserCmd("app-open", { additional: true, device: A }, "session");
  assert.equal(failed.ok, false);
  assert.match(failed.error, /등록 기기 목록을 읽지 못/);
  assert.equal(requests.filter(request => request.type === "emulator-ask").length, 2);
});
