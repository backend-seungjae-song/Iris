import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("손상된 탭과 보관 목록을 원본 바이트로 보존한다", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-state-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.IRIS_STATE_DIR = dir;
  for (const [name, module] of [["browser-state.json", "browser-state"], ["archives.json", "archive"]]) {
    for (const bytes of ["{broken", "null", "[]"]) {
      fs.writeFileSync(path.join(dir, name), bytes);
      (await import("../server/" + module + ".js")).load();
      const copies = fs.readdirSync(dir).filter(file => file.startsWith(name + ".corrupt-"));
      assert.ok(copies.some(file => fs.readFileSync(path.join(dir, file), "utf8") === bytes));
    }
  }
});

test("나뉜 UTF-8 본문을 한 번만 전달하고 요청이 취소되면 폐기한다", async () => {
  const { EventEmitter } = await import("node:events");
  const { readRequestBody } = await import("../server/http-handler.js");
  const bytes = Buffer.from("한글");
  const bodies = [];
  for (const ending of ["end", "aborted", "limit"]) {
    const req = new EventEmitter();
    req.destroy = () => req.emit("aborted");
    readRequestBody(req, ending === "limit" ? 1 : bytes.length, value => bodies.push(value));
    req.emit("data", bytes.subarray(0, 1));
    req.emit("data", bytes.subarray(1));
    if (ending === "aborted") req.emit("aborted");
    req.emit("end");
  }
  assert.deepEqual(bodies, ["한글"]);
});
