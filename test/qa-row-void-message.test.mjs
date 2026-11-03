// qa_row void 를 항목 삭제로 오해하고 receipt 없이 부른 경우의 안내
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

test("receipt 없는 qa_row void 는 판정 무효 처리임과 항목을 넘기는 방법을 알려 준다", async (t) => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-row-void-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = createQaLedger({ dir: path.join(dir, "ledger"), anchor: createQaLedgerAnchor({ dir: path.join(dir, "native") }) });
  const call = createQaChannel({ ledger,
    createEntry: async () => ({ ok: true, data: { tabId: "entry-tab" } }), restore: async () => ({ ok: true }),
    execute: async () => ({ ok: true, data: {} }), release: async () => {}, ask: async () => ({ ok: true, data: { answer: "승인" } }),
    mobileFactory: () => ({}), makeRoutes: () => ({ list: async () => [] }) });
  const begun = await call("run_begin", { plan: qaPlan({ entries: ["http://localhost:4321/start"] }), charter: qaCharter() }, "owner");
  assert.equal(begun.ok, true, JSON.stringify(begun));
  const voided = await call("row", { action: "void", row: "B2", why: "진행할 수 없음" }, "owner", begun.data.runId);
  assert.equal(voided.ok, false);
  assert.match(voided.error, /판정 하나를 무효/);
  assert.match(voided.error, /qa_review decisions/);
});
