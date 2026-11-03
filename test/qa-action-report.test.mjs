import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderQaActionReport } from "../server/qa-action-report.js";
import { qaRowContract } from "./qa-fixtures.mjs";

test("조작 보고서는 S5·S6 주장과 사진 없음 이유를 표시한다", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "qa-action-report-"));
  const events = [
    { seq: 1, event: { kind: "accepted", expected: { effects: [{ type: "appear", text: "저장 완료", oracle: "정본" }], within: 1000 } } },
    { seq: 2, event: { kind: "action", cmd: "click", acceptedSeq: 1 } },
    { seq: 3, event: { kind: "reaction", acceptedSeq: 1, detail: { pass: true, effects: [{ id: "e1", description: "저장 완료 표시", sceneSeq: 4 }], candidates: [{ id: "a1-k1", description: "오류 후보", sceneSeq: 5 }] } } },
    { seq: 4, event: { kind: "frame", acceptedSeq: 1, shot: "missing.png", claim: { kind: "S2", effectId: "e1" } } },
    { seq: 5, event: { kind: "frame", acceptedSeq: 1, shot: "missing2.png", claim: { kind: "S4", candidateId: "a1-k1" } } },
    { seq: 6, event: { kind: "row", action: "close", rowId: "r1", path: "정상", rowData: { sceneJudgment: "전체 확인" } } },
    { seq: 7, event: { kind: "blocked", acceptedSeq: 1, reason: "사람 확인 필요", claim: { kind: "S6" } } },
  ];
  const html = renderQaActionReport(events, folder);
  assert.match(html, /S5 확인과 종료 판단/);
  assert.match(html, /S6 확인하지 못한 내용/);
  assert.match(html, /사진 없음 · 저장한 이미지 파일을 읽지 못함/);
  assert.match(html, /판단 안 됨/);
});

test("실제 accepted 기대와 항목을 연결하고 각 사진은 한 번만 표시한다", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "qa-action-claims-"));
  fs.writeFileSync(path.join(folder, "scene.png"), "test-image");
  const expected = { effects: [{ type: "none", oracle: "명세나 대화에서 정한 내용" }] };
  const row = (rowId, what) => ({ kind: "row", action: "declare", rowId, rowData: { ...qaRowContract(), id: rowId, what, given: "저장 화면", basis: "spec", basisNote: "저장 결과 명세", paths: ["정상"] } });
  const accepted = rowId => ({ kind: "accepted", rowId, path: "정상", cmd: "click", expected });
  const records = [
    row("a", "첫 항목"), row("b", "다른 항목"), accepted("a"),
    { kind: "frame", acceptedSeq: 3, shot: "scene.png", claim: { kind: "S1" } },
    { kind: "reaction", acceptedSeq: 3, detail: { pass: true, unavailable: ["모바일에서 확인 불가: K8"], candidates: [{ id: "c1", description: "반응", sceneSeq: 6 }] } },
    { kind: "frame", acceptedSeq: 3, shot: "scene.png", claim: { kind: "S4", candidateId: "c1" } },
    { kind: "unexpected", acceptedSeq: 3, detail: { id: "c1", verdict: "문제 아님", reason: "확인함" } },
    accepted("a"),
    { kind: "assertion", rowId: "a", path: "정상", pass: true, shot: "scene.png", claim: { kind: "S5" } },
    { kind: "frame", rowId: "a", path: "정상", shot: "scene.png", shotSeq: 9, claim: { kind: "S5" }, detail: { sourceSeq: 9 } },
    { kind: "row", rowId: "a", path: "정상", action: "close", rowData: { sceneJudgment: "최종 문구 일치" } },
  ].map((event, index) => ({ seq: index + 1, event }));
  const html = renderQaActionReport(records, folder);
  const strips = html.split('<article class="qa-action"').slice(1);
  assert.equal(strips.length, 2);
  assert.match(strips[0], /첫 항목/); assert.doesNotMatch(strips[0], /다른 항목|최종 문구 일치|판정 #9/);
  assert.match(strips[0], /사람 확인 전|모바일에서 확인 불가: K8/);
  assert.match(strips[1], /최종 문구 일치/);
  const ids = [...html.matchAll(/<figure id="([^"]+)"/g)].map(hit => hit[1]);
  assert.equal(ids.length, 3); assert.equal(new Set(ids).size, ids.length);
  assert.match(html, /href="#qa-scene-9"/);
  const alone = renderQaActionReport([records[8]], folder);
  assert.match(alone, /개별 확인 장면/); assert.match(alone, /사진 #9/);
});

test("사진 설명은 위치를 화면 비율로, 시각을 시계로 적고 준비 조작은 띠를 만들지 않는다", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "qa-action-readable-"));
  fs.writeFileSync(path.join(folder, "s1.png"), "a");
  fs.writeFileSync(path.join(folder, "s5.png"), "b");
  const expected = { effects: [{ type: "none", oracle: "명세나 대화에서 정한 내용" }], within: 1200 };
  const records = [
    { kind: "accepted", cmd: "viewport" },
    { kind: "action", cmd: "viewport", acceptedSeq: 1 },
    { kind: "accepted", rowId: "a", path: "정상", cmd: "click", expected },
    { kind: "frame", acceptedSeq: 3, shot: "s1.png", capturedAt: Date.UTC(2026, 9, 14, 8, 7, 3, 187), marks: [{ label: "‘저장’ button click ", x: 0.0375, y: 0.2, w: 0.4375, h: 0.08 }], claim: { kind: "S1" } },
    { kind: "reaction", acceptedSeq: 3, detail: { pass: true, effects: [{ id: "e1", expected: expected.effects[0], observed: true, elapsedMs: 590 }] } },
    { kind: "frame", rowId: "a", path: "정상", shot: "s5.png", at: Date.UTC(2026, 9, 14, 8, 7, 12, 5), claim: { kind: "S5" } },
    { kind: "row", rowId: "a", path: "정상", action: "close", rowData: { sceneJudgment: "전체 확인" } },
  ].map((event, index) => ({ seq: index + 1, event }));
  const html = renderQaActionReport(records, folder);
  assert.equal(html.split('<article class="qa-action"').length - 1, 1);
  assert.doesNotMatch(html, /undefined|· ·|미관찰ms|기대 판정 미확인/);
  assert.match(html, /가로 4%, 세로 20%, 너비 44%, 높이 8%/);
  assert.match(html, /촬영 17:07:03\.187/);
  assert.match(html, /기록 17:07:12\.005/);
  assert.match(html, /첫 반응 미관찰 · 효과 완료 미관찰/);
});
