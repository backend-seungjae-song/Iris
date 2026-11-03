// 한 조작의 기대 밖 화면 변화를 한 항목으로 판단
import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createQaLedger } from "../server/qa-ledger.js";
import { createQaChannel } from "../server/qa-channel.js";
import { createQaRoutes } from "../server/qa-routes.js";
import { qaPendingReactions } from "../server/qa-reaction.js";
import { qaCharter, qaPlan, qaRowContract } from "./qa-fixtures.mjs";
const { createQaLedgerAnchor } = createRequire(import.meta.url)("../native/electron/qa-ledger-anchor.cjs");
const root = path.join(fs.realpathSync(os.tmpdir()), "qa-unexpected-group-tests");

async function tappedRun(t) {
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, "run-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = createQaLedger({ dir, anchor: createQaLedgerAnchor({ dir: path.join(dir, "anchors") }) });
  const shot = () => { const file = path.join(dir, `qa-${Math.random()}.png`); fs.writeFileSync(file, "png"); return file; };
  const call = createQaChannel({ ledger,
    createEntry: async () => ({ ok: false, error: "웹 탭 없음" }),
    restore: async () => ({ ok: true }), release: async () => {}, ask: async () => ({ ok: true, data: { answer: "승인" } }),
    makeRoutes: options => createQaRoutes({ ...options, dir, revisionOf: () => "revision-1" }),
    execute: async tab => tab ? { ok: true, data: {} } : { ok: false, error: "QA 탭 소유권이 없습니다." },
    mobileFactory: (_run, onClaim) => ({ execute: async (_session, cmd) => {
      onClaim("phone");
      const base = { targetId: "phone", device: "phone", platform: "ios" };
      if (cmd === "reaction_start") return { ok: true, data: { ...base, reactionId: "w1", scenes: [{ id: "s1", path: shot(), claim: { kind: "S1", description: "조작 전" } }] } };
      // 화면 하나가 다시 그려져 요소 셋이 기대 밖 변화로 잡힘, 그와 별도로 코드 판정 후보 하나
      if (cmd === "reaction_end") return { ok: true, data: { ...base, pass: true, effects: [{ id: "e1", observed: true, sceneId: "s3" }],
        candidates: [{ id: "k1", code: "K7", description: "표시된 값: undefined", sceneId: "s3" }],
        unexpected: ["행 1", "행 2", "on"].map((text, i) => ({ id: `u${i + 1}`, description: "기대 밖 화면 변화: " + text, text, sel: `div:${i}`, sceneId: "s3" })),
        scenes: [{ id: "s3", path: shot(), claim: { kind: "S3", description: "조작 뒤" } }] } };
      if (cmd === "reaction_drain") return { ok: true, data: { ...base, empty: true } };
      return { ok: true, data: { ...base, inputAccepted: true, path: shot(), shot: shot() } };
    } }) });
  const begin = await call("run_begin", { plan: qaPlan({ entries: ["http://localhost:3002/shop"] }), charter: qaCharter() }, "owner");
  assert.equal(begin.ok, true, JSON.stringify(begin));
  const run = begin.data.runId, send = (cmd, args = {}) => call(cmd, args, "owner", run);
  assert.equal((await send("app_target", { device: "phone" })).ok, true);
  assert.equal((await send("row", { action: "declare", ...qaRowContract(), id: "r", what: "상점 열기", given: "홈 화면", basis: "spec", basisNote: "기획서", paths: ["정상"] })).ok, true);
  assert.equal((await send("row", { action: "open", row: "r", path: "정상" })).ok, true);
  const tap = await send("app_tap", { x: 1, y: 1, expect: { effects: [{ id: "e1", type: "appear", text: "상점", oracle: "기능의 용도" }] } });
  assert.equal(tap.ok, true, JSON.stringify(tap));
  return { ledger, run, send };
}

const judgment = (id, extra = {}) => ({ id, source: "미확인", attempts: ["시험 실행기 응답 확인"], cause: "목록 다시 그리기", condition: { kind: "목록" }, ...extra });

test("같은 조작의 기대 밖 화면 변화는 qa_review 에 한 항목으로 나오고 한 번 판단하면 모두 판단된다", async t => {
  const { ledger, run, send } = await tappedRun(t);
  const review = await send("review");
  assert.equal(review.ok, true, JSON.stringify(review));
  const group = review.data.items.find(item => item.group);
  assert.ok(group, JSON.stringify(review.data.items));
  // 응답에는 구성원 수만, full 이면 구성원 id 전부
  assert.equal(group.memberCount, 3);
  assert.equal(group.members, undefined);
  assert.match(group.description, /기대 밖 화면 변화 3건: 행 1, 행 2, on/);
  // 코드 판정 후보는 묶지 않음
  assert.equal(review.data.items.length, 2);
  assert.equal(review.data.total, 2);
  assert.equal((await send("review", { full: true })).data.items.find(item => item.group).members.length, 3);
  const page = await send("review", { limit: 1 });
  assert.equal(page.data.items.length, 1);
  assert.equal(page.data.nextOffset, 1);
  assert.equal((await send("review", { offset: 1, limit: 1 })).data.nextOffset, undefined);
  const judged = await send("unexpected", judgment(group.id, { class: "무관 반응" }));
  assert.equal(judged.ok, true, JSON.stringify(judged));
  const pending = qaPendingReactions((await ledger.verify(run)).events);
  assert.deepEqual(pending.map(item => item.code), ["K7"]);
});

test("문제로 판단한 묶음은 qa_defect 로 결함에 연결되면 판단이 끝난다", async t => {
  const { ledger, run, send } = await tappedRun(t);
  const group = (await send("review")).data.items.find(item => item.group);
  assert.equal((await send("unexpected", judgment(group.id, { class: "문제" }))).ok, true);
  const problem = qaPendingReactions((await ledger.verify(run)).events).find(item => item.group);
  assert.equal(problem.verdict, "문제");
  const defect = await send("defect", { problem: "목록이 통째로 다시 그려짐", oracle: "명세나 대화에서 정한 내용", oracleNote: "바뀐 행만 갱신", importance: "화면이 깜빡임", reproducible: "가끔 재현됨", tried: "목록 저장" });
  assert.equal(defect.ok, true, JSON.stringify(defect));
  const pending = qaPendingReactions((await ledger.verify(run)).events);
  assert.equal(pending.some(item => item.group || /-u\d+$/.test(item.id)), false, JSON.stringify(pending));
});
