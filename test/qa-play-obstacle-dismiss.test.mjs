// 방해 화면 닫기 대상을 찾지 못한 실행과 응답 크기
import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { playQaSteps } from "../server/qa-play.js";
import { qaPendingReactions } from "../server/qa-reaction.js";
import { compactQaRemediation, deriveQaRemediation } from "../server/qa-remediation.js";
import { createQaLedger } from "../server/qa-ledger.js";
import { createQaChannel } from "../server/qa-channel.js";
import { createQaRoutes } from "../server/qa-routes.js";
import { qaCharter, qaPlan, qaRowContract } from "./qa-fixtures.mjs";
const { createQaLedgerAnchor } = createRequire(import.meta.url)("../native/electron/qa-ledger-anchor.cjs");

const handler = { key: "k-invite", class: "방해 화면", condition: { text: "친구 초대하고" },
  handler: { method: "click", target: { text: "걸음" }, expect: { effects: [{ type: "disappear", text: "친구 초대하고", oracle: "같은 제품의 비슷한 기능" }], within: 5000 } } };

async function playWithDismiss(dismiss) {
  const events = [];
  let seq = 0;
  const record = async event => { events.push({ seq: ++seq, event }); return { seq }; };
  const result = await playQaSteps({
    steps: [{ action: "app_tap", target: { role: "Image", name: "상점" }, expect: { effects: [] } }],
    handlers: [handler],
    resolve: async target => {
      if (target === handler.handler.target) return dismiss();
      return { found: true, x: 1, y: 1, occluded: true, blocker: { text: "친구 초대하고\n주사위" } };
    },
    input: async () => { throw new Error("입력하면 안 됨"); },
    record,
    capture: async () => ({ seq: ++seq, shot: "/shot.png" }),
    close: async () => {},
  });
  return { result, events };
}

test("닫기 대상이 여러 개면 막힘으로 닫고 그 방해 화면을 다시 판단 대기로 돌린다", async () => {
  const { result, events } = await playWithDismiss(() => { throw new Error('조작 대상이 여러 개입니다: {"text":"걸음"} 7개'); });
  assert.equal(result.pass, false);
  assert.equal(result.status, "막힘");
  assert.match(result.steps[0].reason, /닫기 대상 \{"text":"걸음"\}.*7개.*qa_unexpected id obstacle-\d+/);
  const pending = qaPendingReactions(events);
  assert.equal(pending.length, 1, JSON.stringify(events));
  assert.match(pending[0].id, /^obstacle-\d+$/);
  assert.equal(pending[0].catalogKey, "k-invite");
});

test("닫기 대상을 찾지 못해도 같은 방식으로 다시 판단 대기가 된다", async () => {
  const { result, events } = await playWithDismiss(() => ({ found: false }));
  assert.equal(result.status, "막힘");
  assert.match(result.steps[0].reason, /찾을 수 없음/);
  assert.equal(qaPendingReactions(events).length, 1);
});

test("qa_play 응답의 remediation 요약은 남은 조건을 남기고 재실행 기록 본문을 뺀다", () => {
  const steps = Array.from({ length: 30 }, (_, i) => ({ action: "app_tap", target: { text: `단계 ${i}` } }));
  const events = [
    { seq: 1, event: { kind: "defect", rowId: "r", detail: { problem: "p" } } },
    { seq: 2, event: { kind: "fix", detail: { defect: 1, commit: "abc", affectedRows: ["r2"] } } },
    { seq: 3, event: { kind: "play_result", rowId: "r", detail: { pass: false, retestOf: { defect: 1 }, retestFix: { seq: 2 }, steps } } },
  ];
  const full = deriveQaRemediation(events), compact = compactQaRemediation(full);
  assert.equal(compact.defects.length, 1);
  assert.equal(compact.defects[0].retestSeq, 3);
  assert.deepEqual(compact.defects[0].waiting, full.defects[0].waiting);
  assert.equal(JSON.stringify(compact).includes("단계 0"), false);
  assert.ok(JSON.stringify(compact).length < JSON.stringify(full).length / 2);
});

test("qa_row 응답은 이 항목과 열린 경로만 돌려준다", async t => {
  const root = path.join(fs.realpathSync(os.tmpdir()), "qa-play-obstacle-dismiss-tests");
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, "run-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = createQaLedger({ dir, anchor: createQaLedgerAnchor({ dir: path.join(dir, "anchors") }) });
  const call = createQaChannel({ ledger, createEntry: async () => ({ ok: false, error: "웹 탭 없음" }),
    restore: async () => ({ ok: true }), release: async () => {}, ask: async () => ({ ok: true, data: { answer: "승인" } }),
    makeRoutes: options => createQaRoutes({ ...options, dir, revisionOf: () => "revision-1" }),
    execute: async () => ({ ok: true, data: {} }), mobileFactory: () => ({ execute: async () => ({ ok: true, data: {} }) }) });
  const begin = await call("run_begin", { plan: qaPlan({ entries: ["http://localhost:3002/shop"] }), charter: qaCharter() }, "owner");
  assert.equal(begin.ok, true, JSON.stringify(begin));
  const send = (args) => call("row", args, "owner", begin.data.runId);
  for (const id of ["a", "b"]) assert.equal((await send({ action: "declare", ...qaRowContract(), id, what: "상점 열기 " + id, given: "홈 화면", basis: "spec", basisNote: "기획서", paths: ["정상"] })).ok, true);
  const opened = await send({ action: "open", row: "b", path: "정상" });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.equal(opened.data.rows, undefined);
  assert.equal(opened.data.rowCount, 2);
  assert.equal(opened.data.row.id, "b");
  assert.deepEqual(opened.data.open, [{ id: "b", path: "정상" }]);
});
