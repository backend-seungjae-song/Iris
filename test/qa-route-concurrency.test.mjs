import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createQaRoutes } from "../server/qa-routes.js";

test("동시에 저장한 QA 경로는 validated-routes 목록을 서로 덮어쓰지 않는다", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-route-concurrency-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let nextSeq = 4;
  const events = [
    { seq: 1, event: { kind: "entry", url: "http://localhost:4271/start" } },
    { seq: 2, event: { kind: "accepted", cmd: "click" } },
    { seq: 3, event: { kind: "action", acceptedSeq: 2, cmd: "click", pass: true, target: { role: "button", name: "Go" },
      received: [{ type: "click", trusted: true, role: "button", name: "Go" }] } },
    { seq: 4, event: { kind: "assertion", pass: true, arrival: { mode: "url", sel: "http://localhost:4271/next" } } },
  ];
  const ledger = {
    async verify() { return { events }; },
    async append(_runId, event) {
      await new Promise(resolve => setTimeout(resolve, event.name === "first" ? 15 : 0));
      return { seq: ++nextSeq };
    },
  };
  const routes = createQaRoutes({ dir, ledger, executor: async () => ({ ok: true }) });
  await Promise.all([
    routes.save({ runId: "run-a", name: "first", fromSeq: 2, toSeq: 4, currentUrl: "http://localhost:4271/start" }),
    routes.save({ runId: "run-a", name: "second", fromSeq: 2, toSeq: 4, currentUrl: "http://localhost:4271/start" }),
  ]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "validated-routes.json"), "utf8"))
    .map((record) => record.name).sort(), ["first", "second"]);
});
