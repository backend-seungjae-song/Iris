// 사람용 보고서가 조작 기록·녹화 장면으로 수십만 px 가 되던 사례(qa-edc59fef). 판정 대상·장면과 반응 묶기를 확인
import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { deflateSync } from "node:zlib";
import { renderQaActionReport } from "../server/qa-action-report.js";
import { renderSessionRecords } from "../bin/mcp/report-session.mjs";
import { legacyQaEvents, createQaReport } from "../server/qa-report.js";
import { createQaLedger } from "../server/qa-ledger.js";
import { qaCharter, qaSession, qaPlan, qaRowContract } from "./qa-fixtures.mjs";
const require = createRequire(import.meta.url);
const { createQaLedgerAnchor } = require("../native/electron/qa-ledger-anchor.cjs");

function png(shade) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4); size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, body, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(80, 0); header.writeUInt32BE(80, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(80 * 241, shade); for (let y = 0; y < 80; y++) pixels[y * 241] = 0;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}
const folder = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-readable-"));
test.after(() => fs.rmSync(folder, { recursive: true, force: true }));

test("판단이 끝난 같은 반응은 한 줄로 묶고 첫 장면만 붙이며, 나머지 장면을 다른 칸에 다시 넣지 않는다", () => {
  const expected = { effects: [{ type: "appear", text: "검색", oracle: "같은 제품의 비슷한 기능" }], within: 1000 };
  const ids = ["a1", "a2", "a3", "a4", "a5"];
  const records = [
    { kind: "row", action: "declare", rowId: "r", rowData: { ...qaRowContract(), id: "r", what: "검색 화면", given: "홈", basis: "spec", basisNote: "명세", paths: ["정상"] } },
    { kind: "accepted", rowId: "r", path: "정상", cmd: "app_tap", expected },
    { kind: "reaction", rowId: "r", path: "정상", acceptedSeq: 2, detail: { pass: true, unexpected: [...ids, "new"].map((id, index) => ({ id, description: id === "new" ? "새 반응" : "주사위 흔들림", catalogKey: id === "new" ? undefined : "dice", sceneSeq: 4 + index })) } },
    ...[...ids, "new"].map((id, index) => {
      fs.writeFileSync(path.join(folder, `${id}.png`), `scene-${index}`);
      return { kind: "frame", rowId: "r", path: "정상", acceptedSeq: 2, shot: `${id}.png`, claim: { kind: "S4", candidateId: id } };
    }),
    ...ids.map(id => ({ kind: "unexpected", detail: { id, verdict: "판단 완료", class: "배경 반응", source: "home_hero.dart:1006", cause: "주기 애니메이션", condition: { text: "주사위" } } })),
  ].map((event, index) => ({ seq: index + 1, event }));
  const html = renderQaActionReport(records, folder);
  assert.match(html, /배경 반응 · 5건 \(a1, a2, a3 외\) · 주사위 흔들림 · source home_hero\.dart:1006/);
  assert.match(html, /new · 새 반응 · 단서 .* · 판단 안 됨/);
  assert.equal((html.match(/<figure /g) || []).length, 2, "묶은 반응은 첫 장면, 판단 안 된 반응은 자기 장면");
  assert.doesNotMatch(html, /항목 확인 기록|개별 확인 장면/);
});

test("반응 판정은 기대 효과의 대상·방식과 같은 조작의 효과 장면을 보고서로 넘기고, 종료 판단 장면은 설명을 단 장면이 된다", () => {
  const records = [
    { kind: "accepted", rowId: "r", path: "정상", cmd: "app_tap", expected: { effects: [{ type: "disappear", text: "인기\n검색어", oracle: "명세" }] } },
    { kind: "frame", rowId: "r", path: "정상", acceptedSeq: 1, shot: "s2.png", claim: { kind: "S2", effectId: "e1" } },
    { kind: "reaction", rowId: "r", path: "정상", acceptedSeq: 1, pass: true, expected: { effects: [{ type: "disappear", text: "인기\n검색어", oracle: "명세" }] }, detail: { pass: true } },
    { kind: "frame", rowId: "r", path: "정상", shot: "s5.png", claim: { kind: "S5", description: "펼침 카드에서 낱말 사이 줄바꿈" } },
  ].map((event, index) => ({ seq: index + 1, event }));
  const events = legacyQaEvents(records, folder);
  const verdict = events.find(e => e.kind === "assertion");
  assert.equal(verdict.label, "인기 검색어");
  assert.equal(verdict.mode, "absent");
  assert.equal(verdict.shot, path.join(folder, "s2.png"));
  const end = events.find(e => e.kind === "frame" && e.path === path.join(folder, "s5.png"));
  assert.equal(end.why, "찍음");
  assert.match(end.caption, /펼침 카드에서 낱말 사이 줄바꿈/);
});

test("사람용 report.html 에는 조작 기록이 없고 촬영 정보는 본문 안에 접혀 있으며, report-dev.html 에는 조작 기록이 있다", async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-readable-state-"));
  const previous = process.env.IRIS_STATE_DIR;
  process.env.IRIS_STATE_DIR = root;
  try {
    const ledger = createQaLedger({ anchor: createQaLedgerAnchor({ dir: path.join(root, "native") }) });
    const url = "http://localhost:4291/result", shot = path.join(folder, "a1.png");
    fs.writeFileSync(shot, png(200));
    const lane = { rowId: "r", path: "정상", surface: "browser", url };
    await ledger.begin({ runId: "readable", session: "owner", plan: qaPlan({ entries: [url] }), charter: qaCharter() });
    await ledger.append("readable", { kind: "row", action: "declare", rowId: "r", rowData: { ...qaRowContract(), id: "r", what: "결과", given: "사용자", basis: "assumed", basisNote: "고정 입력", paths: ["정상"] } });
    await ledger.append("readable", { kind: "row", action: "open", ...lane, rowData: {} });
    await ledger.append("readable", { kind: "frame", phase: "after", shot, ...lane });
    await ledger.append("readable", { kind: "assertion", ...lane, pass: true, expected: { text: "결과" }, observed: { text: "결과" }, shot });
    await ledger.append("readable", { kind: "row", action: "close", ...lane, rowData: { color: "green", note: "확인", sceneJudgment: "전체 확인" } });
    await ledger.end("readable", { session: qaSession() });
    const report = await createQaReport(ledger, "readable");
    const plain = fs.readFileSync(report.path, "utf8"), dev = fs.readFileSync(report.devPath, "utf8");
    assert.doesNotMatch(plain, /조작과 결과|data-stage="S1"/);
    assert.match(dev, /조작과 결과/);
    const capture = plain.indexOf("<h2>촬영 정보</h2>");
    assert.ok(capture > 0 && capture < plain.lastIndexOf("</main>"), "촬영 정보는 main 안");
    assert.match(plain, /<details class="captures"><summary>사진 \d+장의/);
    assert.ok(plain.indexOf("케이스별 확인 내용") < plain.indexOf("<h2>Charter</h2>"), "케이스가 세션 기록보다 먼저");
  } finally {
    if (previous === undefined) delete process.env.IRIS_STATE_DIR; else process.env.IRIS_STATE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("결함의 기대 결과가 조작 기대(effects)이면 JSON 대신 읽는 줄로 나온다", () => {
  const esc = value => String(value ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const analysis = { charterChanges: [], notes: [], outsideRows: [], rowCounts: { inside: 0, outside: 0 },
    time: { totalMs: 0, setupMs: 0, investigationMs: 0, testMs: 0, insideMs: 0, outsideMs: 0, unassignedMs: 0 },
    defects: [{ seq: 1, problem: "삭제 확인 창 없음", expected: { effects: [{ type: "appear", text: "카테고리를 삭제하시겠습니까?", oracle: "명세" }] }, actual: "바로 삭제" }] };
  const html = renderSessionRecords(null, null, esc, analysis);
  assert.match(html, /<dt>기대 결과<\/dt><dd>표시 · 카테고리를 삭제하시겠습니까\?<\/dd>/);
  assert.doesNotMatch(html, /&quot;effects&quot;/);
});

test("사람용 재현 절차는 명령 이름 없이 대상·행동·기대 결과로 적는다", async () => {
  const { plainStep } = await import("../bin/mcp/report-session.mjs");
  const tap = plainStep({ cmd: "app_tap", input: { kind: "app_tap", delivered: true, x: 117.4, y: 642.9 }, pass: true,
    expected: { effects: [{ type: "disappear", role: "StaticText", name: "웰컴 미션이\n시작됐어요!", oracle: "사용자가 원할 만한 동작", id: "e1" }] } });
  // 이름 없는 좌표 조작은 확인 줄과 같은 말로. 좌표 숫자는 읽는 사람이 대조할 수 없음
  assert.deepEqual(tap, { action: "화면 한 곳 누름", result: "'웰컴 미션이 시작됐어요!' 사라짐", pass: true });
  assert.equal(plainStep({ cmd: "app_swipe", input: { x1: 200, y1: 700, x2: 205, y2: 200 } }).action, "화면 위로 밀기");
  assert.equal(plainStep({ cmd: "app_swipe", input: { x1: 200, y1: 700, x2: 500, y2: 400 } }).action, "화면 밀기");
  const typed = plainStep({ cmd: "type", target: { role: "textbox", name: "검색" }, input: { text: "버거" }, pass: false });
  assert.equal(typed.action, "'검색' 입력 '버거'");
  // 주소는 사람용에 두지 않음
  assert.equal(JSON.stringify(plainStep({ cmd: "open_entry", url: "http://localhost:3002/shop?x=1" })).includes("/shop"), false);
  assert.equal(plainStep({ cmd: "mystery" }).action, "조작");
  assert.equal(plainStep({ cmd: "app_key", target: { name: "코드" }, input: { key: "Enter" },
    expected: { effects: [{ type: "navigate", url: "http://localhost:3002/operations" }, { type: "request", path: "/admin/x" }] } }).result, "다른 화면으로 이동 · 서버 요청");
});
