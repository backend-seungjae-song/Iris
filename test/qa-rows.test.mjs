import { qaPlan, qaRowContract } from "./qa-fixtures.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyQaRow, deriveQaRows, QA_ROW_SCHEMA, validateQaDerivation } from "../server/qa-rows.js";

function fixture() {
  const events = [{ seq: 1, event: { kind: "run_begin", plan: qaPlan() } }];
  const ledger = {
    verify: async () => ({ events: structuredClone(events) }),
    append: async (_run, event) => {
      const rec = { seq: events.length + 1, event: structuredClone(event) };
      events.push(rec); return rec;
    },
  };
  const call = args => applyQaRow({ ledger, runId: "test", args });
  const record = event => ledger.append("test", event);
  const declare = (id = "R1", more = {}) => call({ action: "declare", ...qaRowContract(), id, what: "상태 표시", given: "로그인한 사용자", basis: "spec", paths: ["정상"], ...more });
  const proof = (id = "R1", pass = true, more = {}) => record({ kind: "assertion", rowId: id, path: "정상", pass, expected: { mode: "exists", sel: "button" }, shot: "shots/result.png", ...more });
  return { events, ledger, call, record, declare, proof };
}

test("선언 조건과 중복 id를 거부하고 근거를 보존", async () => {
  const f = fixture();
  for (const more of [{ id: "" }, { what: "" }, { given: "" }, { basis: "unknown" }, { paths: [] }, { paths: ["other"] }])
    await assert.rejects(f.declare("R1", more));
  await f.declare("R1", { basisNote: "명세 1절" });
  // 판정 전에는 같은 id 로 선언을 고칠 수 있음. 조작 기록만 있어도 고칠 수 있고, 판정 기록이 생기면 거부
  await f.declare("R1", { basisNote: "명세 1절 고침" });
  await f.record({ kind: "action", rowId: "R1", path: "정상", pass: true, shot: "shots/action.png" });
  await f.declare("R1", { basisNote: "명세 2절", quote: "상태를 표시한다." });
  await f.record({ kind: "reaction", rowId: "R1", path: "정상", pass: true });
  await assert.rejects(f.declare(), /판정 기록이 있는 항목/);
  assert.equal(deriveQaRows(f.events).rows[0].basisNote, "명세 2절");
  assert.equal(QA_ROW_SCHEMA.additionalProperties, false);
});

test("조작 기대 판정도 확인 항목의 영수증과 실패 수에 포함", async () => {
  const f = fixture();
  await f.declare();
  await f.call({ action: "open", row: "R1", path: "정상" });
  await f.record({ kind: "action", rowId: "R1", path: "정상", pass: true, expected: { effects: [{ id: "saved", type: "appear", text: "저장됨", oracle: "기능의 용도" }] }, shot: "shots/action.png" });
  await f.call({ action: "close", sceneJudgment: "조작 기대 효과와 화면 전체를 확인함.", row: "R1", path: "정상", color: "green", note: "저장 결과" });
  const walked = deriveQaRows(f.events).rows[0].walked.정상;
  assert.equal(walked.receipts, 1);
  assert.equal(walked.failed, 0);
  assert.equal(walked.frames, 1);
});

test("경로별 선언·증거와 하드 기대 실패에 red 강제", async () => {
  const f = fixture();
  await f.declare();
  await assert.rejects(f.call({ action: "open", row: "R1", path: "경계" }));
  await f.call({ action: "open", row: "R1", path: "정상" });
  await assert.rejects(f.call({ action: "close", sceneJudgment: "기대 결과와 화면 전체의 상태를 확인했고 추가 이상은 보이지 않았다.", row: "R1", path: "정상", color: "green", note: "상태 표시" }));
  await f.proof("R1", false);
  for (const color of ["orange", "yellow", "green", "gray", "blue"])
    await assert.rejects(f.call({ action: "close", sceneJudgment: "기대 결과와 화면 전체의 상태를 확인했고 추가 이상은 보이지 않았다.", row: "R1", path: "정상", color, note: "상태 표시", simple: true }));
  await f.call({ action: "close", sceneJudgment: "기대 결과와 화면 전체의 상태를 확인했고 추가 이상은 보이지 않았다.", row: "R1", path: "정상", color: "red", note: "상태 누락" });
  assert.equal(deriveQaRows(f.events).rows[0].walked.정상.color, "red");
});

test("실패 판정 없는 red 는 같은 경로의 noFailure 결함이 있을 때만 닫는다", async () => {
  const f = fixture(); await f.declare(); await f.call({ action: "open", row: "R1", path: "정상" }); await f.proof();
  const close = () => f.call({ action: "close", sceneJudgment: "영상 보상 팝업에 기본 보상에 없던 줄이 보임", row: "R1", path: "정상", color: "red", note: "골든티켓 추가 지급" });
  await assert.rejects(close(), /noFailure/);
  await f.record({ kind: "defect", mode: "agent_action", rowId: "R1", path: "다른 경로", detail: { noFailure: true, problem: "골든티켓 추가 지급" } });
  await assert.rejects(close(), /noFailure/);
  await f.record({ kind: "defect", mode: "agent_action", rowId: "R1", path: "정상", detail: { noFailure: true, problem: "골든티켓 추가 지급" } });
  await close();
  assert.equal(deriveQaRows(f.events).rows[0].walked.정상.color, "red");
});

test("6색 판정·blue 선택지·라벨 문체 거부", async () => {
  for (const color of ["red", "orange", "yellow", "green", "blue", "gray"]) {
    const f = fixture(); await f.declare("R1", { basis: "assumed" }); await f.proof("R1", color !== "red");
    await f.call({ action: "close", sceneJudgment: "기대 결과와 화면 전체의 상태를 확인했고 추가 이상은 보이지 않았다.", row: "R1", path: "정상", color, note: "확인 결과", simple: true });
    assert.equal(deriveQaRows(f.events).rows[0].walked.정상.color, color);
  }
  const f = fixture(); await f.declare();
  await assert.rejects(f.call({ action: "close", sceneJudgment: "기대 결과와 화면 전체의 상태를 확인했고 추가 이상은 보이지 않았다.", row: "R1", path: "정상", color: "blue", note: "정책 결정" }));
  await assert.rejects(f.call({ action: "close", sceneJudgment: "기대 결과와 화면 전체의 상태를 확인했고 추가 이상은 보이지 않았다.", row: "R1", path: "정상", color: "gray", note: "확인했다." }));
  await f.call({ action: "close", sceneJudgment: "기대 결과와 화면 전체의 상태를 확인했고 추가 이상은 보이지 않았다.", row: "R1", path: "정상", color: "blue", note: "정책 결정", options: [{ pick: "유지", then: "현재 정책 유지" }, { pick: "수정", then: "표시 변경" }] });
});

test("무효는 원본을 유지하고 집계에서 제외", async () => {
  const f = fixture(); await f.declare();
  const failed = await f.proof("R1", false);
  await assert.rejects(f.call({ action: "void", receipt: String(failed.seq), why: "" }));
  await assert.rejects(f.call({ action: "void", receipt: "999", why: "잘못된 대상" }));
  const result = await f.call({ action: "void", receipt: String(failed.seq), why: "기대 문구 오류" });
  assert.equal(result.original.pass, false);
  assert.equal(f.events.find(r => r.seq === failed.seq).event.pass, false);
  await assert.rejects(f.call({ action: "close", sceneJudgment: "기대 결과와 화면 전체의 상태를 확인했고 추가 이상은 보이지 않았다.", row: "R1", path: "정상", color: "green", note: "정상 동작" }));
  await f.proof();
  await f.call({ action: "close", sceneJudgment: "기대 결과와 화면 전체의 상태를 확인했고 추가 이상은 보이지 않았다.", row: "R1", path: "정상", color: "green", note: "정상 동작" });
});

test("다중 lane과 aside의 실제 장면 검증", async () => {
  const f = fixture(); await f.declare(); await f.declare("R2");
  await f.call({ action: "open", row: "R1", path: "정상" });
  await f.call({ action: "open", row: "R2", path: "정상" });
  assert.equal(deriveQaRows(f.events).open.length, 2);
  await f.record({ kind: "assertion", pass: true, shot: "shots/shared.png", lanes: [["R1", "정상"], ["R2", "정상"]] });
  await assert.rejects(f.call({ action: "aside", row: "R1", path: "정상", frames: ["fake.png"], why: "다른 항목" }));
  await f.call({ action: "aside", row: "R1", path: "정상", frames: ["shots/shared.png"], why: "다른 항목의 장면" });
  await assert.rejects(f.call({ action: "close", sceneJudgment: "기대 결과와 화면 전체의 상태를 확인했고 추가 이상은 보이지 않았다.", row: "R1", path: "정상", color: "green", note: "정상 동작" }));
  await f.call({ action: "close", sceneJudgment: "기대 결과와 화면 전체의 상태를 확인했고 추가 이상은 보이지 않았다.", row: "R2", path: "정상", color: "green", note: "정상 동작" });
  assert.deepEqual(deriveQaRows(f.events).open, [{ id: "R1", path: "정상" }]);
});

test("파일 목록 추출·covers 누락과 근거 교정", async () => {
  const f = fixture(), dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-rows-"));
  try {
    const source = path.join(dir, "fixture.txt");
    fs.writeFileSync(source, "feature('A')\nfeature('B')\n");
    await assert.rejects(f.call({ action: "list", from: { source, pick: "missing" } }));
    await assert.rejects(f.call({ action: "list", from: { source, pick: "[" } }));
    await f.call({ action: "list", name: "기능", from: { source, pick: "feature\\('([^']+)'\\)" } });
    await f.declare();
    await assert.rejects(f.call({ action: "covers", row: "R1", covers: ["C"] }));
    await f.call({ action: "covers", row: "R1", covers: ["A"] });
    assert.deepEqual(deriveQaRows(f.events).coverage[0].missing, ["B"]);
    await f.call({ action: "covers", row: "R1", covers: ["B"] });
    assert.deepEqual(deriveQaRows(f.events).rows[0].covers, ["A", "B"]);
    await f.call({ action: "basis", row: "R1", source: `${source}:1`, basisNote: "원문 근거" });
    assert.deepEqual(deriveQaRows(f.events).rows[0].quotes, ["feature('A')"]);
    assert.equal(f.events.find(r => r.event.action === "declare").event.rowData.basisNote, "검사의 단정문");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("결정 note는 증거와 선택지를 요구하고 임의 장면을 거부", async () => {
  const f = fixture();
  const note = { action: "note", what: "정책 미정", decide: "표시 정책", options: [{ pick: "유지", then: "현재 문구 유지" }, { pick: "변경", then: "새 문구 적용" }] };
  await assert.rejects(f.call(note));
  await assert.rejects(f.call({ ...note, shot: "/tmp/invented.png" }));
  await f.record({ kind: "observation", shot: "shots/observed.png" });
  await f.call({ ...note, shot: "shots/observed.png" });
  await f.call({ action: "note", what: "문구 교정", decide: "한 글자 교정", simple: true });
  assert.equal(deriveQaRows(f.events).notes.length, 2);
});

test("닫은 뒤 무효 처리해도 보고서 projection의 증거 수 감소", async () => {
  const f = fixture(); await f.declare();
  const rec = await f.proof();
  await f.call({ action: "close", sceneJudgment: "기대 결과와 화면 전체의 상태를 확인했고 추가 이상은 보이지 않았다.", row: "R1", path: "정상", color: "green", note: "정상 동작" });
  assert.equal(deriveQaRows(f.events).rows[0].walked.정상.receipts, 1);
  await f.call({ action: "void", receipt: String(rec.seq), why: "다른 문구의 판정" });
  assert.equal(deriveQaRows(f.events).rows[0].walked.정상.receipts, 0);
  assert.equal(deriveQaRows(f.events).rows[0].walked.정상.frames, 0);
});

test("파생값 원천 선언과 실제 관찰값 영수증으로 사례 검증", async () => {
  const f = fixture();
  await assert.rejects(f.declare("R1", { derivation: { source: "" } }));
  await assert.rejects(f.declare("R1", { derivation: null }));
  await f.declare("R1", { derivation: { source: "상태 매핑 명세 3절" } });
  const a = await f.proof("R1", true, { observed: "대기" });
  const b = await f.proof("R1", true, { observed: "완료" });
  const instances = [
    { input: "신규", source_value: "대기", observed: "대기", evidence: String(a.seq) },
    { input: "처리", source_value: "완료", observed: "완료", evidence: String(b.seq) },
  ];
  const result = await f.call({ action: "derivation", row: "R1", instances });
  assert.equal(result.row.derivation.source, "상태 매핑 명세 3절");
  assert.equal(result.row.derivation.sourceValueOrigin, "user_claim");
  assert.equal(result.row.derivation.observedOrigin, "assertion");
  assert.deepEqual(result.row.derivation.instances, instances);
  await assert.rejects(f.call({ action: "derivation", row: "R1", source: "새 명세", instances }));
  await assert.rejects(f.call({ action: "derivation", row: "R1", derivation: null, instances }));
  await assert.rejects(f.call({ action: "derivation", row: "R1", instances: [] }));
  for (const field of ["input", "source_value", "observed", "evidence"])
    await assert.rejects(f.call({ action: "derivation", row: "R1", instances: [{ ...instances[0], [field]: "" }, instances[1]] }));
  assert.throws(() => validateQaDerivation({ events: f.events, rowId: "R1", derivation: { source: "", instances } }));
});

test("파생값은 다른 항목·무효·누락·중복·사진 없는 영수증 거부", async () => {
  const f = fixture(); await f.declare("R1", { derivation: { source: "매핑 명세" } }); await f.declare("R2");
  const a = await f.proof("R1", true, { observed: "A" });
  const wrongRow = await f.proof("R2", true, { observed: "B" });
  const noShot = await f.proof("R1", true, { shot: undefined, observed: "B" });
  const noValue = await f.proof("R1", true);
  const b = await f.proof("R1", true, { observed: "B" });
  const pair = (evidence, observed = "B") => [
    { input: "첫 입력", source_value: "A", observed: "A", evidence: String(a.seq) },
    { input: "다음 입력", source_value: observed, observed, evidence: String(evidence) },
  ];
  for (const seq of [wrongRow.seq, noShot.seq, noValue.seq, 999])
    await assert.rejects(f.call({ action: "derivation", row: "R1", instances: pair(seq) }));
  await assert.rejects(f.call({ action: "derivation", row: "R1", instances: pair(a.seq, "A"), limitation: "단일 결과만 확인" }));
  await assert.rejects(f.call({ action: "derivation", row: "R1", instances: pair(b.seq, "거짓 관찰값") }));
  await f.call({ action: "derivation", row: "R1", instances: pair(b.seq) });
  await f.call({ action: "void", receipt: String(b.seq), why: "원천 조건 오류" });
  await assert.rejects(f.call({ action: "derivation", row: "R1", instances: pair(b.seq) }));
  assert.throws(() => validateQaDerivation({ events: f.events, rowId: "R1", derivation: deriveQaRows(f.events).rows[0].derivation }));
});

test("파생값의 서로 다른 입력과 단일 결과 limitation 강제", async () => {
  const f = fixture(); await f.declare("R1", { derivation: { source: "매핑 명세" } });
  const a = await f.proof("R1", true, { observed: "A" }), b = await f.proof("R1", true, { observed: "A" });
  const instances = [
    { input: "첫 조건", source_value: "A", observed: "A", evidence: String(a.seq) },
    { input: "첫 조건", source_value: "A", observed: "A", evidence: String(b.seq) },
  ];
  await assert.rejects(f.call({ action: "derivation", row: "R1", instances, limitation: "같은 결과만 확인" }));
  instances[1].input = "다른 조건";
  await assert.rejects(f.call({ action: "derivation", row: "R1", instances }));
  const result = await f.call({ action: "derivation", row: "R1", instances, limitation: "이 데이터로 상수와 매핑 구분 불가" });
  assert.equal(result.row.derivation.limitation, "이 데이터로 상수와 매핑 구분 불가");
});

test("reaction 무효 처리는 조작 판정을 중복 집계하지 않음", async () => {
  const f = fixture();
  await f.declare();
  await f.call({ action: "open", row: "R1", path: "정상" });
  const common = { rowId: "R1", path: "정상", acceptedSeq: 3, expected: { effects: [] }, pass: false };
  await f.record({ kind: "action", ...common });
  const reaction = await f.record({ kind: "reaction", ...common });
  await f.record({ kind: "frame", rowId: "R1", path: "정상", acceptedSeq: 3, claim: { kind: "S3" }, shot: "shots/failure.png" });
  await f.call({ action: "close", row: "R1", path: "정상", color: "red", simple: true, note: "기대 불일치", sceneJudgment: "다른 화면의 기대" });
  let lane = deriveQaRows(f.events).rows[0].walked.정상;
  assert.equal(lane.receipts, 1);
  assert.equal(lane.failed, 1);
  await f.call({ action: "void", receipt: String(reaction.seq), why: "다른 화면의 기대" });
  lane = deriveQaRows(f.events).rows[0].walked.정상;
  assert.equal(lane.receipts, 0);
  assert.equal(lane.failed, 0);
});

test("막힘으로 자동으로 닫힌 경로를 다시 열면 앞서 통과한 판정이 close 근거로 남고, 사람이 닫은 뒤 다시 열면 새로 센다", async () => {
  // qa-6face637 C5: 막힘으로 닫힌 뒤 다시 열자 같은 경로에서 통과한 10단계가 세지지 않아 데이터를 되돌리고 다시 실행함
  const f = fixture();
  await f.declare();
  await f.call({ action: "open", row: "R1", path: "정상" });
  await f.proof();
  await f.record({ kind: "row", mode: "agent_action", action: "close", rowId: "R1", path: "정상", rowData: { color: "gray", note: "막힘", sceneJudgment: "자동 실행 중단: 막힘", automatic: true } });
  await f.call({ action: "open", row: "R1", path: "정상" });
  const closed = await f.call({ action: "close", sceneJudgment: "앞선 통과 판정과 화면을 확인함.", row: "R1", path: "정상", color: "green", note: "상태 표시" });
  assert.equal(closed.row.walked.정상.receipts, 1);
  await f.call({ action: "open", row: "R1", path: "정상" });
  await assert.rejects(f.call({ action: "close", sceneJudgment: "다시 확인함.", row: "R1", path: "정상", color: "green", note: "상태 표시" }), /장면과 판정 영수증/);
});
