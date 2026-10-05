const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const [operation, directory, name] = process.argv.slice(2);
const source = path.join(directory, `checkout ${name}`);
const destination = path.join(directory, `local ${name}`);
const record = (event, details = {}) => fs.writeSync(1, JSON.stringify({ event, ...details }) + "\n");
record("prepare:start", { operation, node: process.version, source, destination });
fs.mkdirSync(source, { recursive: true });
fs.mkdirSync(destination, { recursive: true });
if (operation === "copyFileSync") {
  const target = path.join(destination, "Iris.exe");
  record("operation:start", { source: process.execPath, destination: target });
  fs.copyFileSync(process.execPath, target);
  record("operation:return");
  assert.deepEqual(fs.readFileSync(target), fs.readFileSync(process.execPath));
} else if (operation === "cpSync") {
  const executable = fs.readFileSync(process.execPath);
  fs.writeFileSync(path.join(source, "Iris.exe"), executable);
  fs.mkdirSync(path.join(source, "resources", "herdr"), { recursive: true });
  fs.writeFileSync(path.join(source, "resources", "herdr", "herdr.exe"), executable);
  const target = path.join(destination, "win-unpacked");
  record("operation:start", { source, destination: target });
  fs.cpSync(source, target, { recursive: true });
  record("operation:return");
  assert.deepEqual(fs.readFileSync(path.join(target, "Iris.exe")), executable);
  assert.deepEqual(fs.readFileSync(path.join(target, "resources", "herdr", "herdr.exe")), executable);
} else {
  throw new Error(`Unknown operation: ${operation}`);
}
record("verified");
