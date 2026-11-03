import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createQaMobile, nativeFailureMessage } from "../server/qa-mobile.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz8AAAAASUVORK5CYII=", "base64");
const directory = fs.mkdtempSync(path.join(os.tmpdir(),"qa-mobile-test-"));
test.after(() => fs.rmSync(directory, { recursive: true, force: true }));
const defaultExpect = {effects:[{type:"none",oracle:"기능의 용도"}],within:2};
const inputArgs = (command, args = {}) => ["tap","swipe","type","key"].includes(command) ? {...args,expect:defaultExpect} : args;
const callMobile = (mobile, session, command, args, context) => mobile.execute(session,command,inputArgs(command,args),context);
const nativeResult = async (kind,args) => {
  if(args.includes("describe-all")) return JSON.stringify(tree);
  if(args.includes("dump")) return '<hierarchy><node class="android.widget.TextView" text="Saved" content-desc="" resource-id="saved" enabled="true" bounds="[0,0][100,100]" /></hierarchy>';
  if(args.includes("screenshot")) {fs.writeFileSync(args.at(-1),PNG);return "";}
  if(args.includes("screencap")) return PNG;
  return "";
};
const tab = (udid = A, owner = "alice", extra = {}) => ({ udid, tab: `tab-${udid}`, mine: true, owner, name: "iPhone", ...extra });
const tree = [{ type: "Application", AXLabel: "Example", frame: { x: 0, y: 0, width: 390, height: 844 } },
  { type: "Button", AXLabel: "Save", frame: { x: 10, y: 20, width: 100, height: 40 } },
  { type: "StaticText", AXLabel: "Saved", frame: { x: 10, y: 80, width: 100, height: 40 } }];

function fixture(options = {}) {
  const calls = [], writes = [];
  const f = { tabs: options.tabs || [tab()], assignments: options.assignments || { alice: [A] } };
  const backend = { verify: async device => calls.push(["verify", device.udid]),
    input: async (device, command, args) => calls.push([command, device.udid, args]),
    tree: async device => { calls.push(["tree", device.udid]); return tree; },
    screenshot: async (device, file) => { calls.push(["screenshot", device.udid]); fs.writeFileSync(file, PNG); },
    ...options.backend };
  const mobile = createQaMobile({ listDevices: async () => options.listError || { ok: true, data: { tabs: f.tabs } },
    readTargets: async () => f.assignments,
    setTargets: async (session, devices) => { writes.push([session, devices]); f.assignments[session] = devices; },
    backend, authorize: options.authorize, shotsDir: directory, reactionOptions: { interval: 1, tailMs: 1 } });
  return Object.assign(f, { execute: (session,command,args,context) => callMobile(mobile,session,command,args,context), calls, writes });
}

test("only a session's allocated open device receives coordinate input", async () => {
  const f = fixture({ tabs: [tab(), tab(B, "bob")] });
  const result = await f.execute("alice", "tap", { x: 25, y: 30 });
  assert.equal(result.ok, true);
  assert.equal(result.data.inputAccepted, true);
  assert.equal(result.data.native, true);
  assert.equal(result.data.trusted, undefined);
  assert.deepEqual(f.calls.find(call => call[0] === "tap"), ["tap", A, { x: 25, y: 30, expect:defaultExpect }]);
  assert.equal((await f.execute("alice", "tap", { device: B, x: 25, y: 30 })).ok, false);
});

for (const [name, options] of [
  ["another session's tab", { tabs: [tab(A, "bob")], assignments: {} }],
  ["another session's registration on a public tab", { tabs: [tab(A, null)], assignments: { bob: [A] } }],
  ["a closed registered tab", { tabs: [] }],
  ["an unregistered tab in another space", { tabs: [tab(A, null, { mine: false })], assignments: {} }],
  ["conflicting owners of the same device", { tabs: [tab(), tab(A, "bob", { tab: "duplicate" })] }],
  ["corrupt registration", { assignments: { alice: [A], bob: A } }],
  ["Iris unavailable", { listError: { ok: false, error: "Iris unavailable" } }],
]) test(`rejects ${name} before native access`, async () => {
  const f = fixture(options);
  assert.equal((await f.execute("alice", "target", { device: A })).ok, false);
  assert.equal((await f.execute("alice", "tap", { device: A, x: 1, y: 2 })).ok, false);
  assert.equal(f.calls.length, 0);
  assert.equal(f.writes.length, 0);
});

test("target assigns an existing public tab, never starts a device or takes another assignment", async () => {
  const f = fixture({ tabs: [tab(A, null)], assignments: {} });
  assert.equal((await f.execute("alice", "tap", { device: A, x: 1, y: 2 })).ok, false);
  assert.equal((await f.execute("alice", "target", { device: A })).ok, true);
  assert.equal((await f.execute("alice", "tap", { x: 1, y: 2 })).ok, true);
  assert.equal((await f.execute("bob", "target", { device: A })).ok, false);
  assert.deepEqual(f.writes, [["alice", [A]]]);
  assert.equal((await f.execute("alice", "target", { clear: true })).ok, true);
  assert.deepEqual(f.assignments.alice, []);
});

test("targets excludes foreign tabs and requires explicit choice when several devices are allocated", async () => {
  const f = fixture({ tabs: [tab(), tab(B)], assignments: { alice: [A, B] } });
  assert.equal((await f.execute("alice", "snapshot")).ok, false);
  assert.equal((await f.execute("alice", "target", { device: "iPhone" })).ok, false);
  const result = await f.execute("alice", "targets");
  assert.equal(result.data.devices.length, 2);
  assert.equal((await f.execute("alice", "snapshot", { device: B })).ok, true);
});

test("unknown commands and extra arguments never reach backend", async () => {
  const f = fixture();
  for (const [command, args] of [
    ["shell", { command: "id" }], ["eval", { expression: "1" }], ["launch", {}], ["devices", {}],
    ["tap", { x: 1, y: 2, ref: "@a1" }], ["tap", { x: Infinity, y: 2 }],
    ["tap", { x: "1", y: 2 }], ["swipe", { x1: 1, y1: 1, x2: 2, y2: 2, duration: 0 }],
    ["key", { key: "APPLE_PAY" }], ["key", { key: "HOME", keycode: 3 }],
    ["key", { keycode: 3.2 }], ["expect", { mode: "exists" }], ["expect", { mode: "exists", sel: "button" }],
  ]) assert.equal((await f.execute("alice", command, args)).ok, false, command);
  assert.equal(f.calls.length, 0);
});

test("ownership transfer and QA authorization are checked on every command", async () => {
  const f = fixture();
  assert.equal((await f.execute("alice", "tap", { x: 1, y: 2 })).ok, true);
  f.assignments.bob = [A];
  assert.equal((await f.execute("alice", "tap", { device: A, x: 1, y: 2 })).ok, false);
  assert.equal(f.calls.filter(call => call[0] === "tap").length, 1);
  const guarded = fixture({ authorize: async () => ({ ok: false }) });
  assert.equal((await guarded.execute("alice", "snapshot")).ok, false);
  assert.equal(guarded.calls.length, 0);
});

test("independent adapters retain their own session dependencies during concurrent requests", async () => {
  let proceed, gated = false;
  const first = fixture({ backend: { verify: async () => {
    if (gated) return;
    gated = true;
    await new Promise(resolve => { proceed = resolve; });
  } } });
  const pending = first.execute("alice", "tap", { x: 1, y: 2 });
  await new Promise(resolve => setImmediate(resolve));
  const second = fixture({ tabs: [tab(B, "bob")], assignments: { bob: [B] } });
  assert.equal((await second.execute("bob", "tap", { x: 3, y: 4 })).ok, true);
  proceed();
  assert.equal((await pending).ok, true);
  assert.equal(first.calls.find(call => call[0] === "tap")[1], A);
  assert.equal(second.calls.find(call => call[0] === "tap")[1], B);
});

test("concurrent target requests cannot both acquire the same shared device", async () => {
  const f = fixture({ tabs: [tab(A, null)], assignments: {} });
  const results = await Promise.all([f.execute("alice", "target", { device: A }), f.execute("bob", "target", { device: A })]);
  assert.deepEqual(results.map(result => result.ok), [true, false]);
  assert.equal(f.writes.length, 1);
});

test("expect derives pass and failure from fresh accessibility text and PNG", async () => {
  const f = fixture();
  const pass = await f.execute("alice", "expect", { mode: "exists", label: "Saved" });
  assert.equal(pass.data.pass, true);
  assert.ok(fs.existsSync(pass.data.shot));
  const absent = await f.execute("alice", "expect", { mode: "absent", label: "Error" });
  assert.equal(absent.data.pass, true);
  assert.notEqual(pass.data.shot, absent.data.shot);
  assert.equal((await f.execute("alice", "expect", { mode: "equals", label: "Saved", text: "Saved" })).data.pass, true);
  assert.equal((await f.execute("alice", "expect", { mode: "contains", type: "Button", text: "aved" })).data.pass, false);
  assert.equal((await f.execute("alice", "expect", { mode: "exists", label: "Error" })).data.pass, false);
  assert.ok(f.calls.filter(call => call[0] === "tree").length === 5);
});

// label 에 판정 설명 문장을 넣어 요소 0개로 실패했는데 사유가 「기대 조건과 다릅니다」뿐이던 사례(2026-11-01)
test("expect names the unmatched label and the elements that hold the text", async () => {
  const f = fixture();
  const result = await f.execute("alice", "expect", { mode: "contains", label: "저장 뒤 완료 문구가 보임", text: "Saved" });
  assert.equal(result.data.pass, false);
  assert.match(result.data.reason, /label 「저장 뒤 완료 문구가 보임」/);
  assert.match(result.data.reason, /\[StaticText\] Saved/);
  const matched = await f.execute("alice", "expect", { mode: "contains", label: "Saved", text: "Error" });
  assert.equal(matched.data.reason, "접근성 트리가 기대 조건과 다릅니다.");
});

test("screenshot failure cannot produce a passing assertion or successful observe", async () => {
  const f = fixture({ backend: { screenshot: async () => { throw new Error("capture failed"); } } });
  const assertion = await f.execute("alice", "expect", { mode: "exists", label: "Saved" });
  assert.equal(assertion.ok, true);
  assert.equal(assertion.data.pass, false);
  assert.equal(assertion.data.shot, null);
  assert.match(assertion.data.shotError, /capture failed/);
  assert.equal((await f.execute("alice", "observe")).ok, false);
  assert.equal((await f.execute("alice", "screenshot")).ok, false);
});

test("a changed owner between tree and screenshot prevents pass", async () => {
  let f;
  f = fixture({ backend: { tree: async () => { f.tabs[0].owner = "bob"; return tree; } } });
  const result = await f.execute("alice", "expect", { mode: "exists", label: "Saved" });
  assert.equal(result.data.pass, false);
  assert.equal(f.calls.filter(call => call[0] === "screenshot").length, 0);
});

test("invalid screenshot bytes cannot serve as assertion evidence", async () => {
  const f = fixture({ backend: { screenshot: async (_device, file) => fs.writeFileSync(file, "not PNG") } });
  const result = await f.execute("alice", "expect", { mode: "exists", label: "Saved" });
  assert.equal(result.data.pass, false);
  assert.match(result.data.shotError, /PNG/);
});

test("AVD reconnection between tree and screenshot cannot capture an old serial", async () => {
  let f;
  f = fixture({ tabs: [tab("emulator-5554", "alice", { persistentId: "Pixel" })], assignments: { alice: ["avd:Pixel"] },
    backend: { tree: async () => { f.tabs[0].udid = "emulator-5556"; return tree; } } });
  const result = await f.execute("alice", "expect", { mode: "exists", label: "Saved" });
  assert.equal(result.data.pass, false);
  assert.match(result.data.shotError, /식별자/);
  assert.equal(f.calls.filter(call => call[0] === "screenshot").length, 0);
});

test("target and first input open a session emulator tab through Iris", async () => {
  const tabs = [], opens = [], assignments = {};
  const mobile = createQaMobile({ listDevices: async () => ({ ok: true, data: { tabs } }),
    readTargets: async () => assignments, setTargets: async (session, devices) => { assignments[session] = devices; },
    openDevice: async (session, args) => { opens.push(args); tabs.push(tab(args.device || B, session)); return { ok: true, data: { udid: args.device || B } }; },
    backend: { verify: async () => {}, input: async () => {}, tree: async () => tree, screenshot: async (_,file) => fs.writeFileSync(file,PNG) }, shotsDir: directory, reactionOptions:{interval:1,tailMs:1} });
  assert.equal((await callMobile(mobile,"alice", "tap", { device: A, x: 1, y: 2 })).ok, false);
  assert.equal((await callMobile(mobile,"alice", "target", { device: A })).ok, true);
  assert.deepEqual(opens, [{ device: A }]);
  assert.deepEqual(assignments.alice, [A]);
  tabs.length = 0;
  assert.equal((await callMobile(mobile,"alice", "tap", { x: 1, y: 2 })).ok, false);
  assert.equal(opens.length, 1);
  assignments.alice = [];
  assert.equal((await callMobile(mobile,"alice", "tap", { x: 1, y: 2 })).ok, true);
  assert.deepEqual(opens.at(-1), {});
});

test("native Android backend verifies AVD identity and emits only fixed input argv", async () => {
  const calls = [];
  const mobile = createQaMobile({ listDevices: async () => ({ ok: true, data: { tabs: [tab("emulator-5554", "alice", { persistentId: "Pixel" })] } }),
    readTargets: () => ({ alice: ["avd:Pixel"] }), shotsDir: directory, reactionOptions:{interval:1,tailMs:1},
    run: async (kind, args) => { calls.push([kind, args]); if (args.includes("avd")) return "Pixel\nOK\n"; return nativeResult(kind,args); } });
  assert.equal((await callMobile(mobile,"alice", "tap", { x: 12.6, y: 20.1 })).ok, true);
  assert.deepEqual(calls.findLast(call=>call[1].includes("input") || call[1][0] === "ui" && !call[1].includes("describe-all")), ["adb", ["-s", "emulator-5554", "shell", "input", "tap", "13", "20"]]);
  assert.equal((await callMobile(mobile,"alice", "type", { text: "a b;$(id)" })).ok, true);
  assert.deepEqual(calls.findLast(call=>call[1].includes("input") || call[1][0] === "ui" && !call[1].includes("describe-all")), ["adb", ["-s", "emulator-5554", "shell", "input", "text", "a%sb\\;\\$\\(id\\)"]]);
  assert.equal((await callMobile(mobile,"alice", "type", { text: "한글" })).ok, false);
  assert.equal((await callMobile(mobile,"alice", "key", { key: "SIRI" })).ok, false);
  assert.equal((await callMobile(mobile,"alice", "key", { key: "ENTER" })).ok, true);
  assert.deepEqual(calls.findLast(call=>call[1].includes("input") || call[1][0] === "ui" && !call[1].includes("describe-all"))[1].slice(2), ["shell", "input", "keyevent", "66"]);
});

test("reused Android serial cannot control a different AVD", async () => {
  const calls = [];
  const mobile = createQaMobile({ listDevices: async () => ({ ok: true, data: { tabs: [tab("emulator-5554", "alice", { persistentId: "Pixel" })] } }),
    readTargets: () => ({ alice: ["avd:Pixel"] }),
    run: async (_kind, args) => { calls.push(args); return "Other_AVD\nOK\n"; } });
  assert.equal((await callMobile(mobile,"alice", "tap", { x: 1, y: 2 })).ok, false);
  assert.deepEqual(calls, [["-s", "emulator-5554", "emu", "avd", "name"]]);
});

// idb 입력 명령은 Xcode 27 에서 사람 터치를 막으므로(bin/mcp/ios-hid.mjs) iOS 입력은 도우미로만 보낸다
const IDB_INPUT = new Set(["tap", "swipe", "text", "key", "button"]);
const fakeHid = (sent) => ({ tap: async (...a) => { sent.push(["tap", ...a]); }, swipe: async (...a) => { sent.push(["swipe", ...a]); },
  type: async (...a) => { sent.push(["type", ...a]); }, key: async (...a) => { sent.push(["key", ...a]); }, button: async (...a) => { sent.push(["button", ...a]); } });

test("native iOS backend sends input through the serve-sim helper, never idb input commands", async () => {
  const calls = [], sent = [];
  const mobile = createQaMobile({ listDevices: async () => ({ ok: true, data: { tabs: [tab()] } }), readTargets: () => ({ alice: [A] }), shotsDir: directory, reactionOptions:{interval:1,tailMs:1},
    run: async (kind, args) => { calls.push([kind, args]); return nativeResult(kind,args); }, hid: fakeHid(sent) });
  assert.equal((await callMobile(mobile,"alice", "tap", { x: 12.6, y: 20.1 })).ok, true);
  assert.deepEqual(sent.findLast(s => s[0] === "tap"), ["tap", A, 12.6, 20.1]);
  assert.equal((await callMobile(mobile,"alice", "swipe", { x1: 1.4, y1: 2.6, x2: 3.5, y2: 4, duration: 0.25 })).ok, true);
  assert.deepEqual(sent.findLast(s => s[0] === "swipe")[2], { x1: 1.4, y1: 2.6, x2: 3.5, y2: 4, duration: 0.25 });
  assert.equal((await callMobile(mobile,"alice", "key", { key: "ENTER" })).ok, true);
  assert.deepEqual(sent.findLast(s => s[0] === "key"), ["key", A, 40]);
  assert.equal((await callMobile(mobile,"alice", "key", { key: "BACK" })).ok, false);
  assert.equal((await callMobile(mobile,"alice", "type", { text: "stick" })).ok, true);
  assert.deepEqual(sent.findLast(s => s[0] === "type"), ["type", A, "stick"]);
  assert.deepEqual(calls.filter(([kind, args]) => kind === "idb" && args[0] === "ui" && IDB_INPUT.has(args[1])), []);
});

test("native iOS backend pastes text outside ASCII instead of key input", async () => {
  const calls = [], pasted = [], sent = [];
  const mobile = createQaMobile({ listDevices: async () => ({ ok: true, data: { tabs: [tab()] } }), readTargets: () => ({ alice: [A] }), shotsDir: directory, reactionOptions:{interval:1,tailMs:1},
    run: async (kind, args) => { calls.push([kind, args]); return nativeResult(kind,args); }, paste: async (udid, text) => { pasted.push([udid, text]); }, hid: fakeHid(sent) });
  assert.equal((await callMobile(mobile,"alice", "type", { text: "스틱" })).ok, true);
  assert.deepEqual(pasted, [[A, "스틱"]]);
  assert.equal(sent.some(s => s[0] === "type"), false);
});

test("idb·adb 실패 메시지는 오류 출력의 error 줄을 남기고 입력값은 가린다", () => {
  const stderr = "usage: idb ui text\nidb ui text: error: argument x: invalid int value: '195.36'\n";
  assert.equal(nativeFailureMessage("idb", ["ui", "tap", "--udid", A, "195.36", "120.5"], "idb ui tap: error: argument x: invalid int value: '195.36'\n"),
    "idb 실행에 실패했습니다: idb ui tap: error: argument x: invalid int value: '[입력값]'");
  assert.equal(nativeFailureMessage("idb", ["ui", "text", "--udid", A, "비밀번호1234"], "failed to type 비밀번호1234\n"), "idb 실행에 실패했습니다: failed to type [입력값]");
  assert.equal(nativeFailureMessage("adb", ["-s", "emulator-5554", "shell", "input", "tap", "1", "2"], ""), "adb 실행에 실패했습니다.");
  assert.equal(nativeFailureMessage("idb", ["ui", "tap", "--udid", A, "1", "2"], `error: device ${A} not found (exit 1)\n`), `idb 실행에 실패했습니다: error: device ${A} not found (exit [입력값])`);
  assert.ok(nativeFailureMessage("idb", ["ui", "tap"], stderr.repeat(100)).length <= 240);
});

test("이 세션이 등록한 기기는 다른 스페이스의 소유자 없는 탭에 있어도 쓴다", async () => {
  const f = fixture({ tabs: [tab(A, null, { mine: false, space: "w18" })], assignments: { alice: [A] } });
  assert.equal((await f.execute("alice", "snapshot", { device: A })).ok, true);
  assert.equal((await f.execute("bob", "snapshot", { device: A })).ok, false);
});

test("다른 세션이 소유한 탭의 기기는 등록돼 있어도 쓰지 않는다", async () => {
  const f = fixture({ tabs: [tab(A, "bob", { mine: false })], assignments: { alice: [A] } });
  assert.equal((await f.execute("alice", "snapshot", { device: A })).ok, false);
});

test("연결된 기기가 없으면 qa_app_target 으로 고를 수 있는 열린 기기를 알려 준다", async () => {
  const C = "33333333-3333-4333-8333-333333333333";
  const f = fixture({ tabs: [tab(A, null, { mine: false, space: "w18", name: "iPhone 13" }), tab(B, "bob", { name: "Pixel" }), tab(C, null, { name: "iPad" })],
    assignments: { bob: [C] } });
  const result = await f.execute("alice", "snapshot", {});
  assert.equal(result.ok, false);
  assert.match(result.error, /qa_app_target device로 연결할 수 있는 열린 기기: iPhone 13\(11111111-1111-4111-8111-111111111111, 스페이스 w18\)\./);
  // 고를 수 있는 목록에는 없고, 막은 세션을 밝힌다
  assert.doesNotMatch(result.error.split("다른 세션이 쓰는 기기")[0], /Pixel|iPad/);
  assert.match(result.error, /다른 세션이 쓰는 기기: Pixel\([^)]*\) — bob 세션이 사용 중, iPad\([^)]*\) — bob 세션이 사용 중\. 그 세션이 app_target clear로 놓아야/);
});

const MULTI_DISPLAY_WARNING = Buffer.from('[Warning] Multiple displays were found, but no display id was specified! Defaulting to the first display found, however this default is not guaranteed to be consistent across captures. A display id should be specified.\nA display ID can be specified with the [-d display-id] option.\nSee "dumpsys SurfaceFlinger --display-id" for valid display IDs.\n');

for (const [name, output, valid] of [
  ["clean PNG", PNG, true],
  ["multiple-display diagnostic followed by PNG", Buffer.concat([MULTI_DISPLAY_WARNING, PNG]), true],
  ["multiple-display diagnostic without PNG", Buffer.concat([MULTI_DISPLAY_WARNING, Buffer.from("not PNG")]), false],
  ["unknown prefix followed by PNG", Buffer.concat([Buffer.from("unexpected failure\n"), PNG]), false],
]) test(`native Android screenshot handles ${name}`, async () => {
  const serial = "samsung-foldable";
  const mobile = createQaMobile({
    listDevices: async () => ({ok: true, data: {tabs: [tab(serial, "alice")]}}),
    readTargets: () => ({alice: [serial]}),
    shotsDir: directory,
    run: async (kind, args) => args.includes("screencap") ? output : nativeResult(kind, args),
  });
  const result = await mobile.execute("alice", "screenshot", {});
  assert.equal(result.ok, valid);
  if (valid) assert.deepEqual(fs.readFileSync(result.data.path), PNG);
  else assert.match(result.error, /PNG/);
});
