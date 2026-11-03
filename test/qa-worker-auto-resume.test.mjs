import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createQaChannel } from "../server/qa-channel.js";
import { createQaLedger } from "../server/qa-ledger.js";
import { qaPlan, qaCharter } from "./qa-fixtures.mjs";

const { createQaLedgerAnchor } = createRequire(import.meta.url)("../native/electron/qa-ledger-anchor.cjs");

test("worker 자동 복원은 현재 key를 요구하고 명시적 run_resume만 key를 교체한다", async t => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-worker-resume-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const anchor = createQaLedgerAnchor({ dir: path.join(dir, "anchor") });
  const ledger = () => createQaLedger({ dir: path.join(dir, "ledger"), anchor });
  const channel = autoResume => createQaChannel({ runKeys: true, autoResume, ledger: ledger(),
    createEntry: async () => ({ ok: true, data: { tabId: "tab" } }), execute: async () => ({ ok: true, data: {} }),
    restore: async () => ({ ok: true, data: { tabs: [] } }), release: async () => {}, releaseDevice: async () => {},
    mobileFactory: () => ({ execute: async () => ({ ok: true, data: { registered: [], devices: [] } }) }),
    makeRoutes: () => ({ list: async () => [] }) });
  const first = channel(false);
  const begun = await first("run_begin", { plan: qaPlan({ entries: ["http://localhost:4321/start"] }), charter: qaCharter() }, "owner");
  assert.equal(begun.ok, true, JSON.stringify(begun));
  const { runId, runKey: oldKey } = begun.data;

  const automatic = channel(true);
  const restored = await automatic("review", {}, "owner", runId, oldKey);
  assert.equal(restored.ok, true, JSON.stringify(restored));
  assert.equal((await ledger().verify(runId)).events.filter(record => record.event.kind === "run_key").length, 1);

  const takeover = await automatic("run_resume", {}, "owner", runId, "wrong-key");
  assert.equal(takeover.ok, true, JSON.stringify(takeover));
  assert.equal(takeover.data.takenOver, true);
  const newKey = takeover.data.runKey;
  const restarted = channel(true);
  const stale = await restarted("review", {}, "owner", runId, oldKey);
  assert.equal(stale.ok, false);
  assert.match(stale.error, /도구 연결이 아닙니다/);
  const fresh = await restarted("review", {}, "owner", runId, newKey);
  assert.equal(fresh.ok, true, JSON.stringify(fresh));
  assert.equal((await ledger().verify(runId)).events.filter(record => record.event.kind === "run_key").length, 2);
});
