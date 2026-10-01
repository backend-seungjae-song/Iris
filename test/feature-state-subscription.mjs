import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { handleFeatureState, onFeatureStateSaved } from "../server/feature-state.js";

function put(body, order = []) {
  return new Promise((resolve) => {
    const req = new EventEmitter();
    req.method = "PUT";
    const res = {
      writeHead(status) { this.status = status; return this; },
      end(value) { order.push("response"); resolve({ status: this.status, value }); },
    };
    handleFeatureState(req, res, true);
    req.emit("data", JSON.stringify(body));
    req.emit("end");
  });
}

test("feature-state 저장 사건은 rename 뒤 응답 전에 복사본으로 전달된다", { concurrency: false }, async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "iris-feature-saved-"));
  const previous = process.env.IRIS_STATE_DIR;
  process.env.IRIS_STATE_DIR = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.IRIS_STATE_DIR; else process.env.IRIS_STATE_DIR = previous;
    await fsp.rm(home, { recursive: true, force: true });
  });

  const order = [];
  let received;
  const off = onFeatureStateSaved((value) => {
    order.push("subscriber");
    received = value;
    value.hidden.push("changed-by-listener");
  });
  t.after(off);
  const result = await put({ baseRevision: 0, hidden: ["remote"], shown: ["usage"] }, order);
  assert.equal(result.status, 200);
  assert.deepEqual(order, ["subscriber", "response"]);
  assert.deepEqual(received, { revision: 1, hidden: ["remote", "changed-by-listener"], shown: ["usage"] });
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(home, "features.json"), "utf8")), {
    version: 1, revision: 1, hidden: ["remote"], shown: ["usage"],
  });
});

test("feature-state 쓰기 실패에는 알리지 않고 구독자 예외와 해제는 저장 결과를 바꾸지 않는다", { concurrency: false }, async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "iris-feature-errors-"));
  const previous = process.env.IRIS_STATE_DIR;
  process.env.IRIS_STATE_DIR = home;
  const originalRename = fs.renameSync;
  t.after(async () => {
    fs.renameSync = originalRename;
    if (previous === undefined) delete process.env.IRIS_STATE_DIR; else process.env.IRIS_STATE_DIR = previous;
    await fsp.rm(home, { recursive: true, force: true });
  });

  let calls = 0;
  const offThrow = onFeatureStateSaved(() => { calls++; throw new Error("listener failed"); });
  const offCount = onFeatureStateSaved(() => { calls++; });
  let result = await put({ baseRevision: 0, hidden: [], shown: [] });
  assert.equal(result.status, 200);
  assert.equal(calls, 2);
  assert.equal(JSON.parse(await fsp.readFile(path.join(home, "features.json"), "utf8")).revision, 1);

  offThrow();
  offCount();
  result = await put({ baseRevision: 1, hidden: ["remote"], shown: [] });
  assert.equal(result.status, 200);
  assert.equal(calls, 2);

  const offFailure = onFeatureStateSaved(() => { calls++; });
  fs.renameSync = () => { const error = new Error("rename failed"); error.code = "EIO"; throw error; };
  result = await put({ baseRevision: 2, hidden: [], shown: [] });
  offFailure();
  assert.equal(result.status, 500);
  assert.equal(calls, 2);
});
