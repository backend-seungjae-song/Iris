import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createQaMobile } from "../server/qa-mobile.js";

const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333", D = "44444444-4444-4444-8444-444444444444";
const directory = fs.mkdtempSync(path.join(os.tmpdir(),"qa-mobile-extras-test-"));
test.after(() => fs.rmSync(directory, { recursive: true, force: true }));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz8AAAAASUVORK5CYII=", "base64");
const tab = (udid = A, owner = "alice", extra = {}) => ({ udid, owner, mine: true, tab: `tab-${udid}`, name: "iPhone", ...extra });
const element = (text, x = 1, type = "StaticText") => ({ type, AXLabel: text, frame: { x, y: 1, width: 10, height: 10 } });

function fixture(options = {}) {
  let watchTime = 0;
  const f = { tabs: options.tabs || [tab()], assignments: options.assignments || { alice: [A] }, opens: [], writes: [], calls: [] };
  const backend = { verify: async device => f.calls.push(["verify", device.udid]), tree: async () => [element("Save")],
    input: async device => f.calls.push(["input", device.udid]),
    screenshot: async (_device, file) => { f.calls.push(["shot"]); fs.writeFileSync(file, PNG); }, ...options.backend };
  const mobile = createQaMobile({ listDevices: async () => ({ ok: true, data: { tabs: f.tabs } }), readTargets: async () => f.assignments,
    setTargets: async (session, devices) => { f.writes.push([session, devices]); f.assignments[session] = devices; },
    openDevice: async (session, args) => { f.opens.push([session, args]);
      if (options.openDevice) return options.openDevice(f, session, args);
      f.tabs.push(tab(B)); return { ok: true, data: { udid: B } }; },
    readPicks: options.readPicks, authorize: options.authorize, backend, shotsDir: directory,
    reactionOptions: { interval: 1, tailMs: 2, now: () => watchTime,
      wait: ms => new Promise(resolve => setImmediate(() => { watchTime += ms; resolve(); })) } });
  return Object.assign(f, mobile);
}

test("picks forwards Iris session selection fields without native access", async () => {
  const picks = { count: 1, picks: [{ widget: "Text", file: "lib/home.dart", line: 12, column: 4,
    values: [{ text: "Saved", file: "lib/home.dart", line: 13 }], props: [], chain: ["Home", "Text"] }] };
  const sessions = [], f = fixture({ readPicks: async session => { sessions.push(session); return { ok: true, data: picks }; } });
  assert.deepEqual(await f.execute("alice", "picks"), { ok: true, data: picks });
  assert.deepEqual(sessions, ["alice"]); assert.equal(f.calls.length, 0);
  assert.equal((await f.execute("alice", "picks", { file: "arbitrary" })).ok, false);
  assert.equal((await fixture({ readPicks: async () => ({ ok: false, error: "unavailable" }) }).execute("alice", "picks")).ok, false);
});

test("additional retains registrations and owned tabs, using only Iris tab allocation", async () => {
  const f = fixture({ tabs: [tab(A), tab(C)] });
  const result = await f.execute("alice", "target", { device: A, additional: true });
  assert.equal(result.ok, true);
  assert.deepEqual(f.opens, [["alice", { additional: true, device: A }]]);
  assert.deepEqual(result.data.registered, [A, C, B]);
  assert.equal(f.calls.some(call => call[0] === "input"), false);
  assert.equal((await f.execute("alice", "snapshot")).ok, false);
  assert.equal((await f.execute("alice", "snapshot", { device: B })).ok, true);
});

test("additional without a source uses the Iris default allocation", async () => {
  const f = fixture({ tabs: [], assignments: {} });
  assert.equal((await f.execute("alice", "target", { additional: true })).ok, true);
  assert.deepEqual(f.opens, [["alice", { additional: true }]]);
  assert.deepEqual(f.assignments.alice, [B]);
});

for (const [name, options, args] of [
  ["four owned devices", { tabs: [tab(A), tab(B), tab(C), tab(D)], openDevice: async f => {
    const udid = "55555555-5555-4555-8555-555555555555";
    f.tabs.push(tab(udid)); return { ok: true, data: { udid } };
  } }, { device: A }],
  ["ambiguous source", { tabs: [tab(A), tab(C)] }, {}],
  ["foreign source", { tabs: [tab(A), tab(B, "bob")] }, { device: B }],
  ["foreign registration on an owned source", { assignments: { alice: [A], bob: [A] } }, { device: A }],
  ["QA resource owned by another run", { authorize: async () => false }, { device: A }],
]) test(`additional rejects ${name} before tab creation`, async () => {
  const f = fixture(options);
  assert.equal((await f.execute("alice", "target", { additional: true, ...args })).ok, false);
  assert.equal(f.opens.length, 0); assert.equal(f.writes.length, 0);
});

for (const [name, openDevice] of [
  ["missing tab", async () => ({ ok: true, data: { udid: B } })],
  ["foreign owner", async f => { f.tabs.push(tab(B, "bob")); return { ok: true, data: { udid: B } }; }],
  ["foreign registration", async f => { f.tabs.push(tab(B)); f.assignments.bob = [B]; return { ok: true, data: { udid: B } }; }],
  ["reused existing device", async () => ({ ok: true, data: { udid: A } })],
  ["changed own registration", async f => { f.tabs.push(tab(B)); f.assignments.alice = [C]; return { ok: true, data: { udid: B } }; }],
  ["transferred original tab", async f => { f.tabs.push(tab(B)); f.tabs[0].owner = "bob"; return { ok: true, data: { udid: B } }; }],
  ["allocation failure", async () => ({ ok: false, error: "capacity" })],
]) test(`additional never registers an uncertain allocation: ${name}`, async () => {
  const f = fixture({ openDevice });
  assert.equal((await f.execute("alice", "target", { additional: true, device: A })).ok, false);
  assert.equal(f.writes.length, 0);
});

test("additional uses stable Android AVD identity as its source", async () => {
  const f = fixture({ tabs: [tab("emulator-5554", "alice", { persistentId: "Pixel" })], assignments: { alice: ["avd:Pixel"] },
    openDevice: async f => { f.tabs.push(tab("emulator-5556", "alice", { persistentId: "Pixel_2" })); return { ok: true, data: { udid: "emulator-5556" } }; } });
  const result = await f.execute("alice", "target", { additional: true });
  assert.equal(result.ok, true); assert.deepEqual(f.opens[0][1], { additional: true, device: "Pixel" });
  assert.deepEqual(result.data.registered, ["avd:Pixel", "avd:Pixel_2"]);
});

test("target without arguments queries and conflicting allocation options fail", async () => {
  const f = fixture();
  assert.deepEqual((await f.execute("alice", "target")).data.registered, [A]);
  for (const args of [{ additional: true, clear: true }, { additional: "true" }, { clear: true, device: A }]) {
    assert.equal((await f.execute("alice", "target", args)).ok, false);
  }
  assert.equal(f.opens.length, 0); assert.equal(f.writes.length, 0);
});

test("input captures an expected transient effect before it disappears", async () => {
  let count = 0;
  const app = { type: "Application", AXLabel: "Example", frame: { x: 0, y: 0, width: 100, height: 200 } };
  const f = fixture({ backend: { tree: async () => ++count === 2 ? [app, element("Save"), element("Saved", 40)] : [app, element("Save")] } });
  const result = await f.execute("alice", "tap", { x: 1, y: 2,
    expect:{effects:[{type:"appear",text:"Saved",oracle:"기능의 용도"}],within:20} });
  assert.equal(result.ok,true);
  assert.equal(result.data.reaction.pass,true);
  const effect=result.data.reaction.effects[0];
  const scene=result.data.reaction.scenes.find(item=>item.id===effect.sceneId);
  assert.equal(scene.claim.kind,"S2");assert.equal(scene.targetId,A);
  assert.ok(fs.existsSync(scene.shot));
  assert.match(fs.readFileSync(scene.shot + ".caption.txt", "utf8"), /Saved/);
  const marks = JSON.parse(fs.readFileSync(scene.shot + ".marks.json", "utf8")).marks;
  assert.equal(marks[0].x, 0.4); assert.equal(marks[0].h, 0.05);
  assert.deepEqual((await f.flush("alice")).moments, []);
});

test("ownership loss after delivery prevents additional native observations", async () => {
  let count = 0, inputs=0, f;
  f = fixture({ backend: { tree: async () => { count++; return [element("Save")]; },
    input:async()=>{inputs++;f.assignments.bob=[A];} } });
  const result=await f.execute("alice","tap",{x:1,y:2,expect:{effects:[{type:"none",oracle:"기능의 용도"}],within:20}});
  assert.equal(result.ok,false);assert.equal(count,1);assert.equal(inputs,1);
});

test("a serial change during the input baseline blocks native input", async () => {
  let f;
  f = fixture({ tabs: [tab("emulator-5554", "alice", { persistentId: "Pixel" })], assignments: { alice: ["avd:Pixel"] },
    backend: { tree: async () => { f.tabs[0].udid = "emulator-5556"; return []; } } });
  assert.equal((await f.execute("alice", "tap", { x: 1, y: 2, expect:{effects:[{type:"none",oracle:"기능의 용도"}],within:20} })).ok, false);
  assert.equal(f.calls.some(call => call[0] === "input"), false);
});
