// 큰 회차 검증 중에도 서버가 다른 일을 처리함. 사진 900MB 회차 검증이 25초 넘게 서버를 붙잡아
// 메인 프로세스가 연결을 끊고, 요약에서 그 뒤 회차가 "실행기 없음"으로 빠지던 사례(qa-92771d8c)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { createQaLedger } from "../server/qa-ledger.js";
import { qaPlan, qaCharter } from "./qa-fixtures.mjs";
const require = createRequire(import.meta.url);
const { createQaLedgerAnchor } = require("../native/electron/qa-ledger-anchor.cjs");

test("전체 검증 중 서버 이벤트 루프가 오래 멈추지 않는다", async (t) => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-ledger-yields-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = createQaLedger({ dir: path.join(dir, "ledger"), anchor: createQaLedgerAnchor({ dir: path.join(dir, "native") }) });
  await ledger.begin({ runId: "big", session: "s", plan: qaPlan({ entries: [] }), charter: qaCharter() });
  const source = path.join(dir, "shot.png");
  for (let i = 0; i < 300; i++) {
    fs.writeFileSync(source, crypto.randomBytes(512 * 1024));
    await ledger.append("big", { kind: "frame", mode: "agent_action", phase: "S4", shot: source });
  }
  let last = performance.now(), gap = 0;
  const timer = setInterval(() => { const now = performance.now(); gap = Math.max(gap, now - last); last = now; }, 2);
  const start = performance.now();
  const verified = await ledger.verify("big", { full: true });
  const total = performance.now() - start; gap = Math.max(gap, performance.now() - last);
  clearInterval(timer);
  assert.equal(verified.events.filter(r => r.event.shot).length, 300);
  assert.ok(total > 100, `검증이 너무 빨라 측정이 안 됨: ${total}ms`);
  assert.ok(gap < total / 2, `이벤트 루프가 ${Math.round(gap)}ms 멈춤 (검증 ${Math.round(total)}ms)`);
});

test("메인 프로세스가 잠깐 끊긴 동안의 앵커 요청은 다시 붙은 뒤 이어진다", async (t) => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-ledger-reconnect-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const real = createQaLedgerAnchor({ dir: path.join(dir, "native") });
  let down = 0;
  const ledger = createQaLedger({ dir: path.join(dir, "ledger"), anchor: (request) => down-- > 0 ? { ok: false, error: "실행기 없음" } : real(request) });
  await ledger.begin({ runId: "r", session: "s", plan: qaPlan({ entries: [] }), charter: qaCharter() });
  down = 2;
  const verified = await ledger.verify("r", { full: true });
  assert.equal(verified.seq, 1);
  down = 100;
  await assert.rejects(ledger.verify("r", { full: true }), /실행기 없음/);
});
