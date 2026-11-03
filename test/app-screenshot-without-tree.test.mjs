import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-shot-idle-"));
const log = path.join(dir, "calls.jsonl");
const fake = path.join(dir, "adb");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz8AAAAASUVORK5CYII=", "base64");
fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args.includes("screencap")) process.stdout.write(Buffer.from(${JSON.stringify(png.toString("base64"))}, "base64"));
else { process.stderr.write("ERROR: could not get idle state.\\n"); process.exitCode = 1; }
`);
fs.chmodSync(fake, 0o755);
process.env.IRIS_ADB = fake;
process.env.IRIS_STATE_DIR = path.join(dir, "state");
const { createAppSurface } = await import("../bin/mcp/app.mjs");
const serial = "test-animated-android";
const surface = createAppSurface({
  currentSession: async () => "screenshot-test",
  call: async command => command === "app-targets-get"
    ? {ok: true, data: {devices: [serial]}}
    : {ok: true, data: {tabs: [{udid: serial, name: "Android", mine: true}]}},
});
const shot = surface.tools.find(tool => tool.name === "app_screenshot");
test.after(() => fs.rmSync(dir, {recursive: true, force: true}));

for (const mark of [undefined, []]) test(`unmarked screenshot works without an idle accessibility tree (${JSON.stringify(mark)})`, async () => {
  fs.writeFileSync(log, "");
  const result = await shot.run({device: serial, ...(mark ? {mark} : {})});
  assert.equal(result.ok, true);
  assert.deepEqual(fs.readFileSync(result.data.path), png);
  assert.equal(result.data.marks, 0);
  assert.ok(fs.readFileSync(log, "utf8").trim().split("\n").every(line => JSON.parse(line).includes("screencap")));
});

test("marked screenshot still requires its accessibility target", async () => {
  fs.writeFileSync(log, "");
  await assert.rejects(shot.run({device: serial, mark: [{name: "확인"}]}), /could not get idle state/);
  assert.ok(fs.readFileSync(log, "utf8").includes("uiautomator"));
  assert.ok(!fs.readFileSync(log, "utf8").includes("screencap"));
});
