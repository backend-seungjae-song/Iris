// 여러 회차를 사람용 보고서 한 장으로: 같은 항목은 마지막 판정이 케이스, 앞 판정은 이력. 경로마다 장면 상한
import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { deflateSync } from "node:zlib";
import { createQaLedger } from "../server/qa-ledger.js";
import { applyReplaces, createQaCombinedReport, pickFinalRuns } from "../server/qa-combined-report.js";
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
  // 장면마다 다른 9×8 무늬. 단색이면 모두 거의 같은 장면으로 빠짐
  let seed = shade * 7919 + 1;
  const cell = Array.from({ length: 72 }, () => (seed = (seed * 1103515245 + 12345) % 2147483648) % 256);
  for (let y = 0; y < 80; y++) for (let x = 0; x < 80; x++) pixels.fill(cell[Math.min(7, Math.floor(y / 10)) * 9 + Math.floor(x * 9 / 80)], y * 241 + 1 + x * 3, y * 241 + 4 + x * 3);
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}

test("항목마다 보고서 검사를 통과한 마지막 회차를 고르고, 없으면 마지막 회차를 고른다", () => {
  const row = (id, color) => ({ id, paths: ["정상"], walked: { 정상: { color } } });
  const final = pickFinalRuns([
    { reportable: false, rows: [row("A", "red"), row("B", "red")] },
    { reportable: true, rows: [row("A", "green")] },
  ]);
  assert.equal(final.get("A").index, 1);
  assert.deepEqual(final.get("A").history.map(h => h.color), ["red", "green"]);
  assert.equal(final.get("B").index, 0);
});

test("다시 선언한 항목은 앞 항목을 케이스에서 빼고 앞 판정을 이력 앞에 붙인다", () => {
  const final = new Map([["W3", { index: 0, color: "red", history: [{ index: 0, color: "red" }] }], ["W3a", { index: 0, color: "green", history: [{ index: 0, color: "green" }] }]]);
  const out = applyReplaces(final, [{ from: "W3", to: "W3a", why: "조건을 바꿔 다시 확인" }]);
  assert.deepEqual([...out.keys()], ["W3a"]);
  assert.deepEqual(out.get("W3a").history, [{ index: 0, color: "red", from: "W3" }, { index: 0, color: "green" }]);
  assert.throws(() => applyReplaces(final, [{ from: "X", to: "W3a", why: "" }]), /합친 회차에 없는 항목입니다: X/);
});

test("두 회차를 합치면 같은 항목은 마지막 판정 하나로 보이고 앞 판정과 장면 상한이 적힌다", async (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-combined-"));
  const previous = process.env.IRIS_STATE_DIR;
  process.env.IRIS_STATE_DIR = root;
  t.after(() => { if (previous === undefined) delete process.env.IRIS_STATE_DIR; else process.env.IRIS_STATE_DIR = previous; fs.rmSync(root, { recursive: true, force: true }); });
  const ledger = createQaLedger({ anchor: createQaLedgerAnchor({ dir: path.join(root, "native") }) });
  const url = "http://localhost:4291/result";
  const lane = { rowId: "r", path: "정상", surface: "browser", url };
  const runOnce = async (runId, pass, shots) => {
    await ledger.begin({ runId, session: "owner", plan: qaPlan({ entries: [url] }), charter: qaCharter() });
    await ledger.append(runId, { kind: "row", action: "declare", rowId: "r", rowData: { ...qaRowContract(), id: "r", what: "결과 화면 > 저장 > 결과 표시", given: "사용자", basis: "assumed", basisNote: "고정 입력", paths: ["정상"] } });
    await ledger.append(runId, { kind: "row", action: "open", ...lane, rowData: {} });
    for (let i = 0; i < shots; i++) {
      const shot = path.join(root, `${runId}-${i}.png`); fs.writeFileSync(shot, png(40 + i * 10));
      await ledger.append(runId, { kind: "frame", cmd: "screenshot", caption: `장면 ${i + 1}`, shot, ...lane });
    }
    const shot = path.join(root, `${runId}-verdict.png`); fs.writeFileSync(shot, png(pass ? 220 : 10));
    await ledger.append(runId, { kind: "assertion", ...lane, pass, expected: { text: "결과" }, observed: { text: pass ? "결과" : "없음" }, shot });
    await ledger.append(runId, { kind: "row", action: "close", ...lane, rowData: { color: pass ? "green" : "red", note: pass ? "결과 표시" : "결과 없음", sceneJudgment: "전체 확인" } });
    await ledger.end(runId, { session: qaSession() });
  };
  await runOnce("first", false, 0);
  await runOnce("second", true, 9);
  const report = await createQaCombinedReport(ledger, ["second", "first"], { title: "상점 개편 QA 보고서",
    overview: { features: [{ name: "결과 표시", need: "저장하면 결과가 보임", understood: "저장 후 결과", built: "결과 화면", cases: ["second:r"] }], scope: ["결과 화면"] } });
  const plain = fs.readFileSync(report.path, "utf8");
  assert.match(plain, /<h1>상점 개편 QA 보고서<\/h1>/);
  assert.equal(report.cases, 1);
  assert.equal(report.replaced, 1);
  // 판정 이력은 문장 대신 회차·판정 칩. 케이스 안과 확인 범위의 판정 변경 표 둘 다
  assert.match(plain, /<h4>판정 이력<\/h4><ol class="hist"><li><span class="run">\d\d-\d\d \d\d:\d\d<\/span><span class="chip red">실패<\/span><\/li><li><span class="run">\d\d-\d\d \d\d:\d\d<\/span><span class="chip green">통과/);
  assert.match(plain, /뒤 회차에서 판정이 바뀐 케이스 1<\/h3>/);
  assert.match(plain, /합친 회차 2<\/h3>/);
  assert.doesNotMatch(plain, /이전 확인/);
  assert.match(plain, /<a href="report-dev\.html#q\d+">나머지 장면 5장은 개발자용 보고서에 있음<\/a>/);
  assert.doesNotMatch(plain, /조작과 결과|data-stage="S1"/);
  assert.ok(!report.path.includes(`${path.sep}second${path.sep}`), "회차 폴더의 manifest 를 덮어쓰지 않음");
});

test("검증하지 못한 회차가 하나라도 있으면 사유를 담아 거절한다", async () => {
  const ledger = { verify: async (id) => { if (id === "bad") throw new Error("QA 메인 프로세스 앵커가 응답하지 않았습니다."); return { events: [{ seq: 1, event: { kind: "run_begin", session: "s", at: 1 } }] }; }, paths: (id) => ({ folder: `/nonexistent/${id}` }) };
  await assert.rejects(createQaCombinedReport(ledger, ["good", "bad"], { title: "보고서" }), /검증하지 못한 회차가 있어 합친 보고서를 만들지 않았습니다: bad · 기록 검증 실패: QA 메인 프로세스 앵커가 응답하지 않았습니다/);
});

test("replaces 를 주면 다른 ID로 다시 확인한 앞 항목이 케이스에서 빠지고 이력과 확인 범위에 남는다", async (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-combined-"));
  const previous = process.env.IRIS_STATE_DIR;
  process.env.IRIS_STATE_DIR = root;
  t.after(() => { if (previous === undefined) delete process.env.IRIS_STATE_DIR; else process.env.IRIS_STATE_DIR = previous; fs.rmSync(root, { recursive: true, force: true }); });
  const ledger = createQaLedger({ anchor: createQaLedgerAnchor({ dir: path.join(root, "native") }) });
  const url = "http://localhost:4291/result";
  const runOnce = async (runId, rowId, pass) => {
    const lane = { rowId, path: "정상", surface: "browser", url };
    await ledger.begin({ runId, session: "owner", plan: qaPlan({ entries: [url] }), charter: qaCharter() });
    await ledger.append(runId, { kind: "row", action: "declare", rowId, rowData: { ...qaRowContract(), id: rowId, what: `찜 목록 > ${rowId} > 표시`, given: "사용자", basis: "assumed", basisNote: "고정 입력", paths: ["정상"] } });
    await ledger.append(runId, { kind: "row", action: "open", ...lane, rowData: {} });
    const shot = path.join(root, `${runId}.png`); fs.writeFileSync(shot, png(pass ? 220 : 10));
    await ledger.append(runId, { kind: "assertion", ...lane, pass, expected: { text: "결과" }, observed: { text: pass ? "결과" : "없음" }, shot });
    await ledger.append(runId, { kind: "row", action: "close", ...lane, rowData: { color: pass ? "green" : "red", note: pass ? "결과 표시" : "결과 없음", sceneJudgment: "전체 확인" } });
    await ledger.end(runId, { session: qaSession() });
  };
  await runOnce("first", "W3", false);
  await runOnce("second", "W3a", true);
  const report = await createQaCombinedReport(ledger, ["first", "second"], { title: "보고서",
    overview: { features: [{ name: "찜", need: "찜", understood: "찜", built: "찜", cases: ["W3"] }] },
    replaces: [{ from: "W3", to: "W3a", why: "조건을 바꿔 다시 확인" }] });
  const plain = fs.readFileSync(report.path, "utf8");
  assert.equal(report.cases, 1);
  assert.match(plain, /다시 선언해 대신한 항목 1<\/h3>/);
  assert.match(plain, /<td title="찜 목록 &gt; W3 &gt; 표시">찜 목록 &gt; W3 &gt; 표시<\/td><td>조건을 바꿔 다시 확인<\/td>/);
  assert.match(plain, /<span class="chip red">실패<\/span><small title="찜 목록 &gt; W3 &gt; 표시">다른 선언<\/small>/);
  // 앞 선언 이름·대신한 이유·판정 이력의 앞 선언도 overview.text 로 고침
  const edited = await createQaCombinedReport(ledger, ["first", "second"], { title: "보고서",
    overview: { features: [{ name: "찜", need: "찜", understood: "찜", built: "찜", cases: ["W3"] }],
      text: [{ from: "W3 > 표시", to: "첫 선언" }, { from: "조건을 바꿔 다시 확인", to: "조건 변경" }] },
    replaces: [{ from: "W3", to: "W3a", why: "조건을 바꿔 다시 확인" }] });
  const after = fs.readFileSync(edited.path, "utf8");
  assert.match(after, /<td title="찜 목록 &gt; 첫 선언">찜 목록 &gt; 첫 선언<\/td><td>조건 변경<\/td>/);
  assert.match(after, /<small title="찜 목록 &gt; 첫 선언">다른 선언<\/small>/);
  assert.doesNotMatch(after, /W3 &gt; 표시/);
});

test("overview.cases 의 제목·흐름이 케이스 표와 머리에 보이고, 확인 줄마다 종류 칩이 붙고 종류로 거를 수 있다", async (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-combined-"));
  const previous = process.env.IRIS_STATE_DIR;
  process.env.IRIS_STATE_DIR = root;
  t.after(() => { if (previous === undefined) delete process.env.IRIS_STATE_DIR; else process.env.IRIS_STATE_DIR = previous; fs.rmSync(root, { recursive: true, force: true }); });
  const ledger = createQaLedger({ anchor: createQaLedgerAnchor({ dir: path.join(root, "native") }) });
  const url = "http://localhost:4291/result";
  const runOnce = async (runId, rowId) => {
    const lane = { rowId, path: "정상", surface: "browser", url };
    await ledger.begin({ runId, session: "owner", plan: qaPlan({ entries: [url] }), charter: qaCharter() });
    await ledger.append(runId, { kind: "row", action: "declare", rowId, rowData: { ...qaRowContract(), id: rowId, what: `찜 목록 화면에서 하트를 누르면 카드가 그 자리에 남고 다시 열면 빠진다(${rowId})`, given: "사용자", basis: "assumed", basisNote: "고정 입력", paths: ["정상"] } });
    await ledger.append(runId, { kind: "row", action: "open", ...lane, rowData: {} });
    const shot = path.join(root, `${runId}.png`); fs.writeFileSync(shot, png(220));
    await ledger.append(runId, { kind: "assertion", ...lane, pass: true, expected: { text: "결과" }, observed: { text: "결과" }, shot });
    await ledger.append(runId, { kind: "row", action: "close", ...lane, rowData: { color: "green", note: "결과 표시", sceneJudgment: "전체 확인" } });
    await ledger.end(runId, { session: qaSession() });
  };
  await runOnce("first", "W1");
  await runOnce("second", "D1");
  const side = path.join(root, "figma-side.png"); fs.writeFileSync(side, png(90));
  const cases = [{ id: "first:W1", title: "찜 해제", flow: "찜 목록 > 하트 누르기 > 카드 남음", result: "해제한 카드가 남고 다시 열면 빠짐", kind: ["기능", "디자인"] },
    { id: "D1", title: "디자인 대조", checks: [{ kind: "디자인", text: "피그마와 나란히 놓아 2pt 안에서 같음", pass: true, evidence: [{ file: side, caption: "메인" }] }, { kind: "접근성", text: "글자 최대에서 잘림 없음" }] }];
  const report = await createQaCombinedReport(ledger, ["first", "second"], { title: "보고서", overview: { cases } });
  const plain = fs.readFileSync(report.path, "utf8");
  // 케이스 종류는 확인 줄 종류의 합. cases[].kind 는 그리지 않음
  assert.match(plain, /<button type="button" class="fk on" data-k="" aria-pressed="true">전체 2<\/button><button type="button" class="fk" data-k="기능" aria-pressed="false">기능 2<\/button><button type="button" class="fk" data-k="디자인" aria-pressed="false">디자인 1<\/button><button type="button" class="fk" data-k="접근성" aria-pressed="false">접근성 1<\/button>/);
  assert.match(plain, /<tr class="green" data-kinds="기능">/);
  assert.match(plain, /<tr class="green" data-kinds="디자인\|접근성\|기능">/);
  // 머리에는 종류 칩이 없고 확인 줄마다 있음
  assert.doesNotMatch(plain, /<header[^>]*>[^\n]*class="kind"/);
  assert.match(plain, /<li class="ok"><b>통과<\/b><span class="kind">디자인<\/span><span>피그마와 나란히 놓아 2pt 안에서 같음<\/span><\/li>/);
  assert.match(plain, /<li class="ck"><b>확인<\/b><span class="kind">접근성<\/span><span>글자 최대에서 잘림 없음<\/span><\/li>/);
  assert.match(plain, /<li class="ok"><b>통과<\/b><span class="kind">기능<\/span>/);
  // 증거 사진은 캐러셀 맨 앞, 해시를 기록
  const sha = (await import("node:crypto")).createHash("sha256").update(fs.readFileSync(side)).digest("hex");
  assert.match(plain, new RegExp(`<figure class="sc on" data-sha256="${sha}">[\\s\\S]*?<span>피그마와 나란히 놓아 2pt 안에서 같음 · 메인</span>`));
  assert.match(plain, new RegExp(`증거 파일 1개</summary><ul><li><span>figma-side.png</span><code>sha256 ${sha}</code>`));
  await assert.rejects(createQaCombinedReport(ledger, ["first", "second"], { title: "보고서", overview: { cases: [{ id: "D1", checks: [{ kind: "디자인", text: "x", evidence: [{ file: "figma-side.png" }] }] }] } }), /절대 경로/);
  await assert.rejects(createQaCombinedReport(ledger, ["first", "second"], { title: "보고서", overview: { cases: [{ id: "D1", checks: [{ kind: "디자인", text: "x", evidence: [{ file: path.join(root, "없음.png") }] }] }] } }), /증거 사진이 없습니다/);
  await assert.rejects(createQaCombinedReport(ledger, ["first", "second"], { title: "보고서", overview: { cases: [{ id: "D1", checks: [{ kind: "디자인", text: "x", evidence: [{ file: path.join(root, "native") }] }] }] } }), /png·jpg·webp/);
  assert.match(plain, /<td class="what"><b>찜 해제<\/b><span class="mflow"><span>찜 목록<\/span><span>하트 누르기<\/span><span>카드 남음<\/span><\/span><\/td>/);
  assert.match(plain, /<h3 class="ttl">찜 해제<\/h3>/);
  // 결과 칸: 받은 짧은 결과, 없으면 닫을 때 쓴 첫 줄
  assert.match(plain, /<td class="res"><div class="clamp" title="해제한 카드가 남고 다시 열면 빠짐">/);
  assert.match(plain, /<td class="res"><div class="clamp" title="결과 표시">/);
  assert.match(plain, /<ol class="flow"><li>찜 목록<\/li><li>하트 누르기<\/li><li>카드 남음<\/li><\/ol>/);
  assert.match(plain, /선언한 확인 항목 원문<\/summary><p>찜 목록 화면에서 하트를 누르면/);
  // 흐름이 없는 케이스는 선언 설명을 흐름으로 쓰고 원문 접기를 두지 않음
  assert.match(plain, /<h3 class="ttl">디자인 대조<\/h3>\s*<ol class="flow"><li>찜 목록 화면에서 하트를 누르면 카드가 그 자리에 남고 다시 열면 빠진다\(D1\)<\/li><\/ol>\s*\n\s*<dl/);
  await assert.rejects(createQaCombinedReport(ledger, ["first", "second"], { title: "보고서", overview: { cases: [{ id: "X9" }] } }), /overview.cases의 케이스가 보고서에 없습니다: X9/);
  await assert.rejects(createQaCombinedReport(ledger, ["first", "second"], { title: "보고서", overview: { cases: [{ id: "W1" }, { id: "first:W1" }] } }), /같은 케이스가 두 번/);
});
