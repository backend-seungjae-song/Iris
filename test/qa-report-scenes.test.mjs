// 사람용 보고서의 장면 고르기·캡션·확인 줄 묶기. 같은 팝업 10장·'설명 없음' 17장·판정 글이 가리킨 사진 누락이 실린 사례
import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { deflateSync } from "node:zlib";
import { createQaLedger } from "../server/qa-ledger.js";
import { createQaCombinedReport } from "../server/qa-combined-report.js";
import { dhashPng, hashDistance } from "../bin/mcp/png-dhash.mjs";
import { sliceBetween } from "../bin/slice-anchor.mjs";
import { seqRefs, dropSeqRefs, clausesOf, typingIntermediates, collapseChecks, plainText, checkText, orderChecks, EFFECT_PHRASE } from "../bin/mcp/report-plain.mjs";
import { QA_EXPECT_SCHEMA } from "../server/qa-protocol.js";
import { normalizeOverviewCases } from "../server/qa-report.js";
import crypto from "node:crypto";
import { qaCharter, qaSession, qaPlan, qaRowContract } from "./qa-fixtures.mjs";
const require = createRequire(import.meta.url);
const { createQaLedgerAnchor } = require("../native/electron/qa-ledger-anchor.cjs");

// 9×8 칸 무늬 PNG. filter 1(Sub)로도 인코딩해 풀기 경로를 확인
function png(seedValue, { filter = 0, tweak = 0 } = {}) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4); size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, body, checksum]);
  };
  const W = 90, H = 80, header = Buffer.alloc(13); header.writeUInt32BE(W, 0); header.writeUInt32BE(H, 4); header[8] = 8; header[9] = 2;
  let seed = seedValue * 7919 + 1;
  const cell = Array.from({ length: 72 }, () => (seed = (seed * 1103515245 + 12345) % 2147483648) % 256);
  const rows = [];
  for (let y = 0; y < H; y++) {
    const raw = Buffer.alloc(W * 3);
    for (let x = 0; x < W; x++) raw.fill(cell[Math.floor(y / 10) * 9 + Math.floor(x / 10)], x * 3, x * 3 + 3);
    if (tweak && y === 0) raw[0] = (raw[0] + tweak) & 255;
    const line = Buffer.alloc(W * 3 + 1); line[0] = filter;
    for (let i = 0; i < raw.length; i++) line[i + 1] = filter === 1 ? (raw[i] - (i >= 3 ? raw[i - 3] : 0)) & 255 : raw[i];
    rows.push(line);
  }
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

test("dHash: 같은 그림은 필터와 관계없이 같고, 한 화소만 다르면 거의 같고, 다른 무늬는 멀다", () => {
  const a = dhashPng(png(1)), sub = dhashPng(png(1, { filter: 1 })), near = dhashPng(png(1, { tweak: 3 })), far = dhashPng(png(2));
  assert.equal(typeof a, "bigint");
  assert.equal(a, sub);
  assert.ok(hashDistance(a, near) <= 6);
  assert.ok(hashDistance(a, far) > 6);
  assert.equal(dhashPng(Buffer.from("not a png")), null);
});

test("판정 글의 회차 안 번호만 찾고 개수·배율·전화번호·파일 줄 번호는 빼며, 캡션에서는 번호만 지운다", () => {
  assert.deepEqual(seqRefs("1.2배 lib/app.dart:249 11개 40단계 010-3335-8620 9자리 5113~5180 #68 (17417, 스냅샷 17423)"),
    [{ from: 5113, to: 5180 }, { from: 68, to: 68 }, { from: 17417, to: 17417 }, { from: 17423, to: 17423 }]);
  const known = (a, b) => [17493, 17505, 17417, 17423, 6249].some((n) => n >= a && n <= b);
  assert.equal(dropSeqRefs("안내가 뜨고 팝업이 남았다(사진 17493).", known), "안내가 뜨고 팝업이 남았다.");
  assert.equal(dropSeqRefs("다시 찍은 사진 17505에서 -0.5px다.", known), "다시 찍은 사진에서 -0.5px다.");
  assert.equal(dropSeqRefs("고쳐 17505에서 띄어쓰기 위치로 바뀜", known), "고쳐 사진에서 띄어쓰기 위치로 바뀜");
  assert.equal(dropSeqRefs("검색 대기 17417·입력 17423·결과", known), "검색 대기·입력·결과");
  assert.equal(dropSeqRefs("팝업이 열림(17417, 스냅샷 17423).", known), "팝업이 열림.");
  assert.equal(dropSeqRefs("40단계가 통과했다(마지막 receipt 6249).", known), "40단계가 통과했다.");
  // 그 경로에 없는 맨 번호와 보고서에 없는 번호는 남기고, '스냅샷 번호'는 보고서의 다른 경로 번호여도 지움
  assert.equal(dropSeqRefs("상품 133 통과", known), "상품 133 통과");
  assert.equal(dropSeqRefs("전체 삭제(5080) 뒤 열림(스냅샷 9999).", known), "전체 삭제(5080) 뒤 열림(스냅샷 9999).");
  assert.equal(dropSeqRefs("전체 삭제(5080) 뒤 열림(스냅샷 9999).", known, (a) => a === 9999), "전체 삭제(5080) 뒤 열림.");
  assert.equal(dropSeqRefs("앨범 (2026) 열림", known), "앨범 (2026) 열림");
  assert.deepEqual(clausesOf("글자 최대(앱이 1.2배로 제한, lib/app.dart:249)에서 메인 17995, 전체 카테고리 18006"),
    ["글자 최대(앱이 1.2배로 제한, lib/app.dart:249)에서 메인 17995", "전체 카테고리 18006"]);
});

test("확인자 글에서는 Iris 명령 이름·회차 번호·반응 후보 참조만 바꾸고, 다른 앱에서 화면 내용일 수 있는 낱말은 둔다", () => {
  // 명령 이름은 스키마에서 유도: 손으로 적은 표에 없던 qa_app_expect, 한국어 이름이 없는 명령, 조사 맞춤
  assert.equal(plainText("qa_app_expect의 label은 맞지 않았다"), "화면 조건 판정의 label은 맞지 않았다");
  assert.equal(plainText("qa_play의 app_type"), "자동 실행의 입력");
  assert.equal(plainText("qa_route_save로 저장"), "QA 명령으로 저장");
  assert.equal(plainText("qa_dialog 결과로 기록됨. 폼이 남은 것은 qa_expect 10691로 판정"), "대화상자 응답 결과로 기록됨. 폼이 남은 것은 화면 조건 판정으로 판정");
  // 반응 후보 참조(후보 id + K 코드)는 괄호째
  assert.equal(plainText("입력 전부터 있었다(후보 a6478 K1). 끝"), "입력 전부터 있었다. 끝");
  assert.equal(plainText("성립할 수 없었다(후보 a5827 K1 '조작 전부터 조건에 맞는 요소 있음')."), "성립할 수 없었다.");
  // 회차 번호는 이 보고서에 있는 번호일 때만
  const known = (a, b = a) => [7164, 2425, 19130, 18498, 12].some((n) => n >= a && n <= b);
  assert.equal(plainText("기록 seq 7164 뒤 스냅샷 2425·촬영 19130 확인", known), "기록 뒤 스냅샷·촬영 확인");
  assert.equal(plainText("팝업이 그대로(사진 18498).", known), "팝업이 그대로.");
  assert.equal(plainText("기록 seq 7164 뒤 스냅샷 2425 확인"), "기록 seq 7164 뒤 스냅샷 2425 확인");
  // 번호가 보고서에 있어도 개수·연도·도구 옵션 같은 글은 그대로
  assert.equal(plainText("사진 12장 업로드 완료", known), "사진 12장 업로드 완료");
  assert.equal(plainText("앨범 (2026) 열림", known), "앨범 (2026) 열림");
  assert.equal(plainText("개발자 도구 (receipt 표시 옵션) 켬", known), "개발자 도구 (receipt 표시 옵션) 켬");
  // 해시·소스 경로·좌표·요구 번호·영어 효과 이름·제품 코드는 다른 앱에서 화면 내용일 수 있어 그대로(확인자가 text 로 고침)
  for (const keep of ["커밋 fe6b10c0 표시", "파일 test/features/shop/shop_layout_test.dart 열림", "(48,281) 좌표 표시", "P30 모델", "U6 요금제",
    "S3 등급", "K1 리그", "unchanged 배지", "tool-issues 6", "카테고리 key qa_c6a 삭제", "상품 133 통과 · 1.2배 · 010-3335-8620 · GS25 · 2pt"])
    assert.equal(plainText(keep), keep);
});

test("입력 중간은 같은 대상에 연속한 입력 조작으로만 판별하고, 같은 확인 줄은 구조 값으로 묶는다", () => {
  const typed = (name, to) => ({ act: { kind: "type", name }, effects: [{ type: "change", name, to }], pass: true });
  const xs = [typed("전화번호", "010-3"), typed("전화번호", "010-33"), typed("전화번호", "010-333"), { act: { kind: "tap", name: "확인" }, effects: [{ type: "appear", name: "닫힘" }], pass: true }, typed("전화번호", "010-3335")];
  assert.deepEqual([...typingIntermediates(xs)].map((x) => x.effects[0].to), ["010-3", "010-33"]);
  // 조작 기록이 없는 옛 판정은 앞부분이 같아도 따로 확인한 값일 수 있어 빼지 않음
  assert.equal(typingIntermediates([{ label: "수량", want: "1" }, { label: "수량", want: "10" }]).size, 0);
  const line = checkText({ act: { kind: "tap", name: "칩" }, effects: [{ type: "appear", name: "목록" }], pass: true });
  const out = collapseChecks([line, { ...line }, checkText({ act: { kind: "tap", name: "칩" }, effects: [{ type: "appear", name: "목록", observed: false }], pass: false }), { ...line }]);
  assert.deepEqual(out.map((c) => [c.pass, c.count]), [[true, 3], [false, 1]]);
  // 30자를 넘는 이름이 잘려 같아 보여도 원래 이름이 다르면 다른 줄
  const long = (tail) => checkText({ act: { kind: "tap", name: "아주 긴 버튼 이름이 서른 글자를 넘어서 잘리는 경우 " + tail }, effects: [{ type: "none" }], pass: true });
  assert.equal(long("가").want, long("나").want);
  assert.equal(collapseChecks([long("가"), long("나")]).length, 2);
});

test("확인 줄은 기록된 조작과 효과로 문장을 만든다: 효과 종류 전부, 관찰 결과, 전달 실패, 이름·키·방향이 없을 때", () => {
  // 효과 문구 표가 스키마의 효과 종류와 같음(새 효과가 생기면 이 시험이 실패)
  const types = QA_EXPECT_SCHEMA.properties.effects.items.anyOf.map((x) => x.properties.type.enum[0]).sort();
  assert.deepEqual(Object.keys(EFFECT_PHRASE).sort(), types);
  const say = (x) => checkText(x).want;
  assert.equal(say({ act: { kind: "tap", name: "전체보기" }, effects: [{ type: "appear", name: "전체 카테고리", observed: true }], pass: true }), "'전체보기'를 누르자 '전체 카테고리'가 나타남");
  assert.equal(say({ act: { kind: "tap", name: "칩 X" }, effects: [{ type: "disappear", name: "치킨" }], pass: true }), "'칩 X'를 누르자 '치킨'이 사라짐");
  // 여러 효과 중 일부만 관찰
  assert.equal(say({ act: { kind: "tap", name: "저장" }, effects: [{ type: "appear", name: "완료", observed: true }, { type: "disappear", name: "입력칸", observed: false }], pass: false }),
    "'저장'을 누르자 '완료'가 나타남, '입력칸'이 사라지지 않음");
  // 관찰 기록이 없는 실패는 기대로
  assert.equal(say({ act: { kind: "tap", name: "저장" }, effects: [{ type: "appear", name: "완료" }], pass: false }), "'저장'을 누르자 '완료'가 나타나야 함");
  assert.equal(say({ act: { kind: "tap", name: "저장", delivered: false }, effects: [{ type: "appear", name: "완료", observed: false }], pass: false }),
    "'저장'을 누르려 했으나 입력이 전달되지 않았고 '완료'가 나타나지 않음");
  assert.equal(say({ act: { kind: "tap" }, effects: [{ type: "none" }], pass: true }), "화면 한 곳을 누르자 변화 없음");
  assert.equal(say({ act: { kind: "type" }, effects: [{ type: "change", name: "수량", to: "2" }], pass: true }), "입력하자 '수량'이 '2'로 바뀜");
  assert.equal(say({ act: { kind: "type", name: "검색" }, effects: [{ type: "change", name: "검색", to: "3" }], pass: true }), "'검색'에 입력하자 '검색'이 '3'으로 바뀜");
  assert.equal(say({ act: { kind: "key", name: "검색", key: "ENTER" }, effects: [{ type: "appear", name: "결과" }], pass: true }), "'검색'에서 Enter 키를 누르자 '결과'가 나타남");
  assert.equal(say({ act: { kind: "key" }, effects: [{ type: "none" }], pass: true }), "키를 누르자 변화 없음");
  assert.equal(say({ act: { kind: "swipe", dx: 0, dy: -400 }, effects: [{ type: "none" }], pass: true }), "화면을 위로 밀자 변화 없음");
  assert.equal(say({ act: { kind: "swipe", dx: 300, dy: 280 }, effects: [{ type: "none" }], pass: true }), "화면을 밀자 변화 없음");
  assert.equal(say({ act: { kind: "swipe", dx: 0, dy: 0 }, effects: [{ type: "none" }], pass: true }), "화면을 밀자 변화 없음");
  assert.equal(say({ act: { kind: "swipe", dx: -280 }, effects: [{ type: "none" }], pass: true }), "화면을 왼쪽으로 밀자 변화 없음");
  assert.equal(say({ act: { kind: "scroll", dy: 4600 }, effects: [{ type: "none" }], pass: true }), "화면을 아래로 스크롤하자 변화 없음");
  assert.equal(say({ act: { kind: "dblclick", name: "사진" }, effects: [{ type: "dialog" }], pass: true }), "'사진'을 두 번 누르자 대화상자가 뜸");
  assert.equal(say({ act: { kind: "pinch" }, effects: [{ type: "request" }], pass: true }), "조작하자 서버 요청이 나감");
  // 여러 줄 이름은 같은 줄을 합침, 조작 기록이 없으면 효과만, 효과 기록도 없으면 대상과 기대
  assert.equal(say({ effects: [{ type: "appear", name: "백화점\n백화점" }], pass: true }), "'백화점'이 나타남");
  assert.equal(say({ label: "칩", mode: "exists", pass: true }), "화면에 있음");
  assert.equal(checkText({ label: "칩", mode: "exists", pass: true }).target, "칩");
});

test("확인 줄 순서: 실패 → 미확인 → 통과 → 여러 조작 뒤 매번 확인한 화면", () => {
  const c = (name, effect, pass = true) => checkText({ act: { kind: "tap", name }, effects: [{ type: "appear", name: effect }], pass });
  const lines = orderChecks([c("뒤로", "검색"), c("홈", "검색"), c("전체보기", "전체 카테고리"), c("탭", "검색"), c("결제", "완료", false),
    { kind: "디자인", target: "", want: "피그마와 같음", got: "", pass: undefined, key: "x" }]);
  assert.deepEqual(lines.map((x) => x.want), ["'결제'를 누르자 '완료'가 나타나야 함", "피그마와 같음", "'전체보기'를 누르자 '전체 카테고리'가 나타남",
    "'뒤로'를 누르자 '검색'이 나타남", "'홈'을 누르자 '검색'이 나타남", "'탭'을 누르자 '검색'이 나타남"]);
  // 두 번만 확인한 효과는 반복이 아님
  assert.deepEqual(orderChecks([c("뒤로", "검색"), c("홈", "검색"), c("A", "가")]).map((x) => x.want),
    ["'뒤로'를 누르자 '검색'이 나타남", "'홈'을 누르자 '검색'이 나타남", "'A'를 누르자 '가'가 나타남"]);
});

test("overview.cases scenes·text 입력 검사", () => {
  const ids = new Set(["C1"]);
  const sha = "A".repeat(64);
  const [ok] = normalizeOverviewCases([{ id: "C1", scenes: [{ sha256: sha, caption: " 설명 " }, { sha256: "b".repeat(64), hide: true }], text: [{ from: "PUT", to: "" }] }], ids);
  assert.deepEqual(ok.scenes, [{ sha256: "a".repeat(64), caption: "설명" }, { sha256: "b".repeat(64), hide: true }]);
  assert.deepEqual(ok.text, [{ from: "PUT", to: "" }]);
  const bad = (c, re) => assert.throws(() => normalizeOverviewCases([{ id: "C1", ...c }], ids), re);
  bad({ scenes: [{ sha256: "xyz", caption: "a" }] }, /64자 16진/);
  bad({ scenes: [{ sha256: sha, caption: "a", hide: true }] }, /하나만/);
  bad({ scenes: [{ sha256: sha }] }, /하나만/);
  bad({ scenes: [{ sha256: sha, hide: false }] }, /true만/);
  bad({ scenes: [{ sha256: sha, caption: "  " }] }, /비었습니다/);
  bad({ scenes: [{ sha256: sha, caption: "a" }, { sha256: sha.toLowerCase(), hide: true }] }, /두 번/);
  bad({ text: [{ from: " ", to: "a" }] }, /from이 비었/);
  bad({ text: [{ from: "a" }] }, /to는 글/);
  bad({ text: [{ from: "a", to: "" }, { from: "a", to: "b" }] }, /두 번/);
});

test("판정 글이 가리킨 사진을 그 문장으로 싣고(거의 같아도 둘 다), 거의 같은 자동 사진·안정 전 사진·통과 경로의 실패 사진은 빼며 '설명 없음'이 없다", async (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-scenes-"));
  const previous = process.env.IRIS_STATE_DIR;
  process.env.IRIS_STATE_DIR = root;
  t.after(() => { if (previous === undefined) delete process.env.IRIS_STATE_DIR; else process.env.IRIS_STATE_DIR = previous; fs.rmSync(root, { recursive: true, force: true }); });
  const ledger = createQaLedger({ anchor: createQaLedgerAnchor({ dir: path.join(root, "native") }) });
  const url = "http://localhost:4291/result";
  const run = async (runId, rowId, body) => {
    const lane = { rowId, path: "정상", surface: "browser", url };
    await ledger.begin({ runId, session: "owner", plan: qaPlan({ entries: [url] }), charter: qaCharter() });
    await ledger.append(runId, { kind: "row", action: "declare", rowId, rowData: { ...qaRowContract(), id: rowId, what: "메인 > 열기 > 표시", given: "사용자", basis: "assumed", basisNote: "고정 입력", paths: ["정상"] } });
    // 판정 글의 번호는 두 자리 이상만 찾으므로 앞에 기록을 채움
    for (let i = 0; i < 10; i++) await ledger.append(runId, { kind: "observation", surface: "browser", url });
    await ledger.append(runId, { kind: "row", action: "open", ...lane, rowData: {} });
    const file = (name, buf) => { const p = path.join(root, `${runId}-${name}.png`); fs.writeFileSync(p, buf); return p; };
    await body(lane, file);
    await ledger.end(runId, { session: qaSession() });
  };
  await run("first", "A1", async (lane, file) => {
    await ledger.append("first", { kind: "assertion", ...lane, pass: true, expected: { text: "결과" }, observed: { text: "결과" }, shot: file("v", png(50)) });
    await ledger.append("first", { kind: "row", action: "close", ...lane, rowData: { color: "green", note: "표시", sceneJudgment: "전체 확인" } });
  });
  await run("second", "S1", async (lane, file) => {
    const cited = await ledger.append("second", { kind: "frame", cmd: "screenshot", shot: file("cited", png(11)), ...lane });
    const twin = await ledger.append("second", { kind: "frame", cmd: "screenshot", shot: file("twin", png(11, { tweak: 1 })), ...lane });
    await ledger.append("second", { kind: "frame", cmd: "screenshot", shot: file("plain", png(12)), ...lane });
    await ledger.append("second", { kind: "frame", cmd: "screenshot", shot: file("near", png(12, { tweak: 2 })), ...lane });
    await ledger.append("second", { kind: "frame", cmd: "screenshot", shot: file("unstable", png(13)), stability: { stable: false, remaining: ["animation"] }, ...lane });
    await ledger.append("second", { kind: "assertion", ...lane, pass: false, expected: { text: "결과" }, observed: { text: "없음" }, shot: file("fail", png(14)) });
    await ledger.append("second", { kind: "assertion", ...lane, pass: true, expected: { text: "결과" }, observed: { text: "결과" }, shot: file("pass", png(15)) });
    await ledger.append("second", { kind: "row", action: "close", ...lane, rowData: { color: "green", note: "표시", sceneJudgment: `장면 전체에 이상 없음. 메인 머리와 배너가 피그마와 같다(사진 ${cited.seq}·${twin.seq}).` } });
  });
  const report = await createQaCombinedReport(ledger, ["first", "second"], { title: "보고서" });
  const plain = fs.readFileSync(report.path, "utf8");
  const card = sliceBetween(plain, '<article id="w2"', "</article>");
  const captions = [...card.matchAll(/<figcaption[^>]*><b>[^<]*<\/b><span>([^<]*)<\/span>/g)].map((m) => m[1]);
  assert.equal(captions[0], "메인 머리와 배너가 피그마와 같다.");
  // 판정 글이 번호로 따로 가리킨 두 사진은 거의 같아도 묶지 않음
  assert.equal(captions[1], "메인 머리와 배너가 피그마와 같다.");
  assert.equal(captions.length, 4, captions.join(" / "));
  assert.ok(captions.every((c) => c !== "설명 없음" && !/\d{3,}/.test(c)), captions.join(" / "));
  assert.match(card, /거의 같은 장면 1장, 안정 전 촬영 장면 1장, 통과 전 실패 장면 1장 제외/);
  // 통과 경로의 실패 판정은 확인 줄 목록에서 빠지고 접힌 칸에
  assert.match(card, /<h4>확인 1건 · 통과 1건<\/h4>/);
  assert.match(card, /통과 전에 실패한 확인 1건<\/summary><ul class="checks"><li class="no">/);
});

// 회차 사진 유실은 회차 기록 검증(QA 사진이 없습니다)이 보고서 전에 막음. 보고서의 유실 처리는 검증 뒤 파일이 사라지는 경우용이라 여기서 다루지 않음
test("확인자 덮어쓰기: 사진 설명 바꾸기·빼기·글 바꾸기가 적용되고, 가리킨 대상이 없으면 오류로 멈추며 이전 보고서를 남긴다", async (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-edits-"));
  const previous = process.env.IRIS_STATE_DIR;
  process.env.IRIS_STATE_DIR = root;
  t.after(() => { if (previous === undefined) delete process.env.IRIS_STATE_DIR; else process.env.IRIS_STATE_DIR = previous; fs.rmSync(root, { recursive: true, force: true }); });
  const ledger = createQaLedger({ anchor: createQaLedgerAnchor({ dir: path.join(root, "native") }) });
  const url = "http://localhost:4291/result";
  const lane = { rowId: "E1", path: "정상", surface: "browser", url };
  const file = (name, buf) => { const p = path.join(root, `${name}.png`); fs.writeFileSync(p, buf); return p; };
  const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  const keep = file("keep", png(31)), hide = file("hide", png(32)), shared = file("shared", png(33));
  await ledger.begin({ runId: "edits", session: "owner", plan: qaPlan({ entries: [url] }), charter: qaCharter() });
  await ledger.append("edits", { kind: "row", action: "declare", rowId: "E1", rowData: { ...qaRowContract(), id: "E1", what: "메인 > 열기 > 표시", given: "PUT 요청 뒤", basis: "assumed", basisNote: "고정 입력", paths: ["정상"] } });
  await ledger.append("edits", { kind: "row", action: "open", ...lane, rowData: {} });
  await ledger.append("edits", { kind: "frame", cmd: "screenshot", shot: keep, caption: "고치기 전 코드에서는 이 칸이 없었다", ...lane });
  await ledger.append("edits", { kind: "frame", cmd: "screenshot", shot: hide, caption: "로딩 화면", ...lane });
  // 같은 사진을 쓰는 판정 둘 중 하나만 무효
  const voided = await ledger.append("edits", { kind: "assertion", ...lane, pass: true, expected: { text: "결과" }, observed: { text: "결과" }, shot: shared });
  await ledger.append("edits", { kind: "assertion", ...lane, pass: true, expected: { text: "결과" }, observed: { text: "결과" }, shot: shared });
  await ledger.append("edits", { kind: "row", action: "void", ...lane, rowData: { receipt: String(voided.seq), why: "잘못 건 기대" } });
  await ledger.append("edits", { kind: "row", action: "close", ...lane, rowData: { color: "green", note: "DELETE 200 뒤 목록이 비었다", sceneJudgment: "이상 없음" } });
  await ledger.end("edits", { session: qaSession() });
  const other = { rowId: "O1", path: "정상", surface: "browser", url };
  await ledger.begin({ runId: "other", session: "owner", plan: qaPlan({ entries: [url] }), charter: qaCharter() });
  await ledger.append("other", { kind: "row", action: "declare", rowId: "O1", rowData: { ...qaRowContract(), id: "O1", what: "목록 > 열기 > 표시", given: "사용자", basis: "assumed", basisNote: "고정 입력", paths: ["정상"] } });
  await ledger.append("other", { kind: "row", action: "open", ...other, rowData: {} });
  await ledger.append("other", { kind: "assertion", ...other, pass: true, expected: { text: "목록" }, observed: { text: "목록" }, shot: file("other", png(35)) });
  await ledger.append("other", { kind: "row", action: "close", ...other, rowData: { color: "green", note: "표시", sceneJudgment: "이상 없음" } });
  await ledger.end("other", { session: qaSession() });
  const build = (cases) => createQaCombinedReport(ledger, ["edits", "other"], { title: "보고서", overview: { cases } });
  const good = [{ id: "E1", scenes: [{ sha256: sha(keep), caption: "새 입력칸이 보임" }, { sha256: sha(hide), hide: true }],
    text: [{ from: "PUT 요청 뒤", to: "저장 뒤" }, { from: "DELETE 200 뒤 ", to: "삭제 뒤 " }],
    // 증거 사진이 회차 사진과 같은 파일이면 한 번만
    checks: [{ kind: "디자인", text: "피그마와 같음", pass: true, evidence: [{ file: shared, caption: "메인" }] }] }];
  const report = await build(good);
  const plain = fs.readFileSync(report.path, "utf8");
  const card = sliceBetween(plain, '<article id="w1"', "</article>");
  const figures = [...card.matchAll(/<figure class="sc[^"]*"[^>]*data-sha256="([0-9a-f]{64})"/g)].map((m) => m[1]);
  const allFigures = [...card.matchAll(/<figure class="sc/g)].length;
  assert.equal(allFigures, figures.length, "케이스 사진마다 data-sha256");
  assert.ok(figures.includes(sha(keep)) && figures.includes(sha(shared)) && !figures.includes(sha(hide)), figures.join(" "));
  assert.equal(figures.filter((x) => x === sha(shared)).length, 1);
  assert.match(card, /새 입력칸이 보임/);
  assert.doesNotMatch(card, /고치기 전 코드|PUT 요청|DELETE 200/);
  assert.match(card, /저장 뒤/);
  assert.match(card, /삭제 뒤 목록이 비었다/);
  assert.match(card, /확인자가 뺀 장면 1장/);
  assert.deepEqual(report.sceneEdits.applied, [sha(keep)]);
  assert.deepEqual(report.sceneEdits.hidden, [sha(hide)]);
  // 가리킨 대상이 없으면 오류, 두 보고서 파일은 그대로
  const before = [fs.readFileSync(report.path, "utf8"), fs.readFileSync(report.devPath, "utf8")];
  await assert.rejects(build([{ id: "E1", scenes: [{ sha256: "f".repeat(64), caption: "x" }] }]), /E1: scenes\.sha256 f{64}/);
  await assert.rejects(build([{ id: "E1", text: [{ from: "없는 문장", to: "x" }] }]), /E1: text\.from '없는 문장'/);
  assert.deepEqual([fs.readFileSync(report.path, "utf8"), fs.readFileSync(report.devPath, "utf8")], before);
  // 사진을 모두 빼면 대신할 사진을 되살리지 않음
  const none = await build([{ id: "E1", scenes: [sha(keep), sha(hide), sha(shared)].map((x) => ({ sha256: x, hide: true })) }]);
  const empty = fs.readFileSync(none.path, "utf8");
  const emptyCard = sliceBetween(empty, '<article id="w1"', "</article>");
  assert.equal([...emptyCard.matchAll(/<figure class="sc/g)].length, 0);
  assert.match(emptyCard, /확인자가 뺀 장면 3장/);
});

test("거의 같은 사진은 화면에 나갈 설명과 판정 상태가 같을 때만 한 장으로 합치고, 설명이 다르면 따로 둔다", async (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-merge-"));
  const previous = process.env.IRIS_STATE_DIR;
  process.env.IRIS_STATE_DIR = root;
  t.after(() => { if (previous === undefined) delete process.env.IRIS_STATE_DIR; else process.env.IRIS_STATE_DIR = previous; fs.rmSync(root, { recursive: true, force: true }); });
  const ledger = createQaLedger({ anchor: createQaLedgerAnchor({ dir: path.join(root, "native") }) });
  const url = "http://localhost:4291/result";
  const file = (name, buf) => { const p = path.join(root, `${name}.png`); fs.writeFileSync(p, buf); return p; };
  for (const [runId, rowId] of [["m1", "M1"], ["m2", "M2"]]) {
    const lane = { rowId, path: "정상", surface: "browser", url };
    await ledger.begin({ runId, session: "owner", plan: qaPlan({ entries: [url] }), charter: qaCharter() });
    await ledger.append(runId, { kind: "row", action: "declare", rowId, rowData: { ...qaRowContract(), id: rowId, what: "메인 > 열기 > 표시", given: "사용자", basis: "assumed", basisNote: "고정 입력", paths: ["정상"] } });
    await ledger.append(runId, { kind: "row", action: "open", ...lane, rowData: {} });
    if (runId === "m1") {
      // 실패 사진과 거의 같은 통과 사진: 다른 상태를 증명하므로 둘 다
      await ledger.append(runId, { kind: "assertion", ...lane, pass: false, expected: { text: "가" }, observed: { text: "나" }, shot: file("f", png(41)) });
      await ledger.append(runId, { kind: "assertion", ...lane, pass: true, expected: { text: "다" }, observed: { text: "다" }, shot: file("p", png(41, { tweak: 1 })) });
      await ledger.append(runId, { kind: "row", action: "close", ...lane, rowData: { color: "red", note: "실패", sceneJudgment: "실패" } });
    } else {
      // 설명이 다른 거의 같은 사진 둘: 화면 모양은 비슷해도 다른 사실이라 따로(확인 창만 다른 화면이 1비트 차이인 사례)
      await ledger.append(runId, { kind: "frame", cmd: "screenshot", shot: file("a", png(42)), caption: "팝업 열림", ...lane });
      await ledger.append(runId, { kind: "frame", cmd: "screenshot", shot: file("b", png(42, { tweak: 1 })), caption: "번호 한 글자 지움", ...lane });
      // 설명이 같은 거의 같은 사진: 한 장
      await ledger.append(runId, { kind: "frame", cmd: "screenshot", shot: file("d", png(43)), caption: "목록 그대로", ...lane });
      await ledger.append(runId, { kind: "frame", cmd: "screenshot", shot: file("e", png(43, { tweak: 1 })), caption: "목록 그대로", ...lane });
      await ledger.append(runId, { kind: "assertion", ...lane, label: "팝업", pass: true, expected: { text: "팝업" }, observed: { text: "팝업" }, shot: file("c", png(44)) });
      await ledger.append(runId, { kind: "row", action: "close", ...lane, rowData: { color: "green", note: "표시", sceneJudgment: "이상 없음" } });
    }
    await ledger.end(runId, { session: qaSession() });
  }
  // 실패·통과 사진의 설명을 같게 덮어써 판정 상태만 다르게 함. 같은 증거 파일에 확인 글 둘(대상만 다르고 사진 설명 같음)
  const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  const proof = file("proof", png(45));
  const report = await createQaCombinedReport(ledger, ["m1", "m2"], { title: "보고서", overview: { cases: [
    { id: "M1", scenes: [{ sha256: sha(path.join(root, "f.png")), caption: "같은 화면" }, { sha256: sha(path.join(root, "p.png")), caption: "같은 화면" }] },
    { id: "M2", checks: [{ kind: "디자인", text: "이메일", pass: true, evidence: [{ file: proof, caption: "확인됨" }] },
      { kind: "디자인", text: "휴대전화", pass: true, evidence: [{ file: proof, caption: "확인됨" }] }] }] } });
  const plain = fs.readFileSync(report.path, "utf8");
  const card = (id) => sliceBetween(plain, `<article id="${id}"`, "</article>");
  const caps = (id) => [...card(id).matchAll(/<figcaption[^>]*><b>[^<]*<\/b><span>([^<]*)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(caps("w1"), ["같은 화면", "같은 화면"]);
  assert.deepEqual(caps("w2").slice(0, 4), ["이메일 · 확인됨 / 휴대전화 · 확인됨", "팝업 열림", "번호 한 글자 지움", "목록 그대로"], caps("w2").join(" | "));
  assert.equal(caps("w2").length, 5, caps("w2").join(" | "));
  // 같은 증거 파일 1장 + 설명이 같은 거의 같은 사진 1장
  assert.match(card("w2"), /거의 같은 장면 2장/);
});

test("title 없는 요약에 고치는 칸을 주면 거부한다", async () => {
  const { createQaChannel } = await import("../server/qa-channel.js");
  const call = createQaChannel({ ledger: { verify: async () => ({ events: [] }) }, createEntry: async () => ({ ok: true, data: {} }),
    execute: async () => ({ ok: true, data: {} }), release: async () => {}, close: async () => {} });
  for (const overview of [{ cases: [{ id: "C1", scenes: [{ sha256: "a".repeat(64), hide: true }] }] }, { text: [{ from: "가", to: "나" }] }, { notes: [{ id: "n1", hide: true }] }]) {
    const result = await call("summary", { runIds: ["a", "b"], overview }, "owner").then((x) => x, (e) => ({ ok: false, error: e.message }));
    assert.match(JSON.stringify(result), /title을 넣으세요/, JSON.stringify(overview));
  }
});

test("overviewFile은 파일을 overview로 읽어 같은 검사를 거치고, overview와 함께 주면 거부한다", async () => {
  const { createQaChannel } = await import("../server/qa-channel.js");
  const call = createQaChannel({ ledger: { verify: async () => ({ events: [] }) }, createEntry: async () => ({ ok: true, data: {} }),
    execute: async () => ({ ok: true, data: {} }), release: async () => {}, close: async () => {} });
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-ovfile-"));
  try {
    const write = (name, body) => { const p = path.join(dir, name); fs.writeFileSync(p, body); return p; };
    const run = (args) => call("summary", { runIds: ["a", "b"], ...args }, "owner").then((x) => JSON.stringify(x), (e) => e.message);
    // 읽은 overview 가 title 없는 요약 검사까지 감
    assert.match(await run({ overviewFile: write("ok.json", JSON.stringify({ text: [{ from: "가", to: "나" }] })) }), /title을 넣으세요/);
    assert.match(await run({ overviewFile: write("bad.json", JSON.stringify({ text: [{ from: "가" }] })) }), /args\.overview\.text/);
    assert.match(await run({ overviewFile: write("broken.json", "{") }), /JSON으로 읽지 못했습니다/);
    assert.match(await run({ overviewFile: path.join(dir, "none.json") }), /파일이 없습니다/);
    assert.match(await run({ overviewFile: "rel/ov.json" }), /절대 경로/);
    assert.match(await run({ overviewFile: path.join(dir, "ok.json"), overview: {} }), /overview와 함께 쓸 수 없습니다/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("묶기·반복·입력 중간의 경계: 방향이 다른 밀기, 값만 다른 같은 효과, 줄어든 입력, 표에 없는 조작 이름", () => {
  const swipe = (dy) => checkText({ act: { kind: "swipe", dx: 0, dy }, effects: [{ type: "none" }], pass: true });
  assert.equal(collapseChecks([swipe(-300), swipe(300)]).length, 2);
  const changed = (by, to) => checkText({ act: { kind: "tap", name: by }, effects: [{ type: "change", name: "수량", to }], pass: true });
  assert.equal(orderChecks([changed("A", "1"), changed("B", "2"), changed("C", "3"), changed("D", "4"), checkText({ act: { kind: "tap", name: "E" }, effects: [{ type: "appear", name: "가" }], pass: true })]).at(0).want, "'E'를 누르자 '가'가 나타남");
  const typed = (to) => ({ act: { kind: "type", name: "수량" }, effects: [{ type: "change", name: "수량", to }], pass: true });
  assert.equal(typingIntermediates([typed("10"), typed("1")]).size, 0);
  for (const kind of ["__proto__", "constructor", "toString"]) assert.equal(checkText({ act: { kind }, effects: [{ type: "none" }], pass: true }).want, "조작하자 변화 없음");
  assert.equal(checkText({ effects: [{ type: "constructor" }], pass: true }).want, "기대한 변화가 확인됨");
  assert.throws(() => normalizeOverviewCases([{ id: "C1", scenes: [{ sha256: "a".repeat(64), hide: true, caption: 42 }] }], new Set(["C1"])), /caption은 글/);
});

test("설명 전문 보존, 다른 케이스의 무효 판정과 무관, 원문 기준 text 검사, 덮어쓰기 요청별 결과, 실패한 증거 사진 표시", async (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-edge-B-"));
  const previous = process.env.IRIS_STATE_DIR;
  process.env.IRIS_STATE_DIR = root;
  t.after(() => { if (previous === undefined) delete process.env.IRIS_STATE_DIR; else process.env.IRIS_STATE_DIR = previous; fs.rmSync(root, { recursive: true, force: true }); });
  const ledger = createQaLedger({ anchor: createQaLedgerAnchor({ dir: path.join(root, "native") }) });
  const url = "http://localhost:4291/result";
  const file = (name, buf) => { const p = path.join(root, `${name}.png`); fs.writeFileSync(p, buf); return p; };
  const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  const shared = file("shared", png(51)), auto = file("auto", png(52)), ev = file("ev", png(53));
  const long = "설명 " + "가나다라마바사아자차".repeat(20) + " 끝 조건";
  const runIt = async (runId, rowId, body) => {
    const lane = { rowId, path: "정상", surface: "browser", url };
    await ledger.begin({ runId, session: "owner", plan: qaPlan({ entries: [url] }), charter: qaCharter() });
    await ledger.append(runId, { kind: "row", action: "declare", rowId, rowData: { ...qaRowContract(), id: rowId, what: "메인 > 열기 > 표시", given: "가나다 원문", basis: "assumed", basisNote: "고정 입력", paths: ["정상"] } });
    await ledger.append(runId, { kind: "row", action: "open", ...lane, rowData: {} });
    await body(lane);
    await ledger.end(runId, { session: qaSession() });
  };
  await runIt("g1", "G1", async (lane) => {
    // 설명 단 사진이 다른 케이스(G2)에서 무효 처리한 판정과 같은 파일
    await ledger.append("g1", { kind: "frame", cmd: "screenshot", shot: shared, caption: long, ...lane });
    // 사진 없는 기록(화면 구조 읽기)의 번호도 이 회차 번호라 지움. 보고서에 없는 번호는 둠
    for (let i = 0; i < 12; i++) await ledger.append("g1", { kind: "observation", surface: "browser", url });
    await ledger.append("g1", { kind: "row", action: "close", ...lane, rowData: { color: "green", note: "표시됨(스냅샷 12), 앨범(스냅샷 99999)", sceneJudgment: "이상 없음" } });
  });
  await runIt("g2", "G2", async (lane) => {
    const v = await ledger.append("g2", { kind: "assertion", ...lane, pass: true, expected: { text: "가" }, observed: { text: "가" }, shot: shared });
    await ledger.append("g2", { kind: "row", action: "void", ...lane, rowData: { receipt: String(v.seq), why: "잘못 건 기대" } });
    // 판정 없는 자동 장면 한 장뿐인 경로
    await ledger.append("g2", { kind: "frame", cmd: "app_tap", shot: auto, ...lane });
    await ledger.append("g2", { kind: "row", action: "close", ...lane, rowData: { color: "green", note: "표시", sceneJudgment: "이상 없음" } });
  });
  const build = (cases) => createQaCombinedReport(ledger, ["g1", "g2"], { title: "보고서", overview: { cases } });
  const report = await build([
    { id: "G1", text: [{ from: "가나다 원문", to: "바뀐 조건" }, { from: "원문", to: "x" }] },
    { id: "G2", scenes: [{ sha256: sha(auto), hide: true }],
      checks: [{ kind: "디자인", text: "맞음", pass: true, evidence: [{ file: ev }] }, { kind: "디자인", text: "틀림", pass: false, evidence: [{ file: ev }] }] }]);
  const plain = fs.readFileSync(report.path, "utf8");
  const card = (id) => sliceBetween(plain, `<article id="${id}"`, "</article>");
  assert.ok(card("w1").includes(`data-sha256="${sha(shared)}"`), "다른 케이스의 무효 판정이 이 케이스 사진을 빼지 않음");
  assert.ok(card("w1").includes(long), "설명 전문");
  assert.match(card("w1"), /바뀐 조건/);
  assert.match(card("w1"), /표시됨, 앨범\(스냅샷 99999\)/);
  assert.match(card("w2"), /<figure class="sc on bad"[^>]*data-sha256="[0-9a-f]+"/, "실패한 증거 사진이 대표가 되어 실패 표시");
  assert.doesNotMatch(card("w2"), new RegExp(sha(auto)));
  assert.match(card("w2"), /확인자가 뺀 장면 1장/);
  assert.deepEqual(report.sceneEdits.hidden, [sha(auto)]);
  // 원문에 없는 from 은 원문 규칙이 바꾼 뒤 화면에 나갈 글에서 찾음. 원문에 있으면 겹쳐도 통과
  assert.deepEqual((await build([{ id: "G1", text: [{ from: "가나다 원문", to: "변경된 표시 조건" }, { from: "변경된 표시 조건", to: "최종 표시 조건" }] }])).textEdits.map((x) => [x.how, x.count]), [["원문", 1], ["보이는 글", 1]]);
  await build([{ id: "G1", text: [{ from: "가나다 원문", to: "X" }, { from: "원문", to: "Y" }] }]);
});

// ── 5차: 글 고치기 두 단계·케이스 밖 글·오류 안내, 증거 사진, 다른 회차 번호, 화면 조건 판정 대상, 빌드·회차 표시
test("번호·쉼표·확인 줄 순서·입력 글자 수·다른 회차 사진 번호", async () => {
  const { ownRunRefs } = await import("../bin/mcp/report-plain.mjs");
  assert.deepEqual(clausesOf("필요 33,333P가 보이고, 부족 9,333P"), ["필요 33,333P가 보이고", "부족 9,333P"]);
  assert.deepEqual(ownRunRefs("펼침 카드(사진 1592)에서 바뀌고, 앞 회차 사진 600의 끊김이 없다. 이 회차 사진 610도"), [{ from: 1592, to: 1592 }, { from: 610, to: 610 }]);
  // 다른 회차를 말한 뒤의 번호는 괄호·나열·긴 문장에서도 잇지 않음. 수식어 없는 '회차'는 제품 낱말이라 봄
  const nums = (t) => ownRunRefs(t).map((r) => r.from);
  assert.deepEqual(nums("앞 회차 사진(600)"), []);
  assert.deepEqual(nums("앞 회차 사진 600, 610"), []);
  assert.deepEqual(nums("이번 회차 결과를 앞 회차 사진 600과 비교"), []);
  assert.deepEqual(nums("qa-427cb182 사진 600"), []);
  assert.deepEqual(nums("결제 회차 선택 뒤 사진 600"), [600]);
  assert.deepEqual(nums("사진 590은 이번 것. 앞 회차 사진 600"), [590]);
  assert.equal(checkText({ act: { kind: "type", length: 3 }, effects: [{ type: "appear", name: "2건의 상품" }], pass: true }).want, "3글자를 입력하자 '2건의 상품'이 나타남");
  assert.equal(checkText({ act: { kind: "type", name: "검색", length: 3 }, effects: [{ type: "appear", name: "결과" }], pass: true }).want, "'검색'에 입력하자 '결과'가 나타남");
  const tap = (name, type) => ({ act: { kind: "tap", name }, effects: [{ type, name: type === "none" ? undefined : "결과" }], pass: true });
  const order = orderChecks([tap("가", "none"), tap("나", "appear"), tap("다", "none"), tap("라", "disappear")].map(checkText));
  assert.deepEqual(order.map((c) => c.want.slice(1, 2)), ["나", "라", "가", "다"]);
  // 변화 없음뿐인 통과 줄은 같은 효과가 되풀이된 통과 줄보다도 뒤
  const again = orderChecks([tap("가", "none"), tap("나", "appear"), tap("다", "appear"), tap("라", "appear")].map(checkText));
  assert.deepEqual(again.map((c) => c.want.slice(1, 2)), ["나", "다", "라", "가"]);
});

test("화면 조건 판정은 기대한 대상과 값을 확인 줄에 쓴다", async (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-expect-"));
  const previous = process.env.IRIS_STATE_DIR;
  process.env.IRIS_STATE_DIR = root;
  t.after(() => { if (previous === undefined) delete process.env.IRIS_STATE_DIR; else process.env.IRIS_STATE_DIR = previous; fs.rmSync(root, { recursive: true, force: true }); });
  const { legacyQaEvents } = await import("../server/qa-report.js");
  const ev = (seq, event) => ({ seq, event: { rowId: "A1", path: "정상", ...event } });
  const out = legacyQaEvents([
    ev(1, { kind: "assertion", cmd: "app_expect", mode: "agent_action", pass: true, expected: { mode: "exists", label: "버거킹 내 상품 검색", type: "TextField" } }),
    ev(2, { kind: "assertion", cmd: "expect", pass: false, expected: { mode: "equals", sel: "#n", text: "3" }, observed: { text: "2" } }),
    // 실제 실행기가 남기는 모양: 브라우저는 찾은 요소의 글이나 null, 앱은 글을 이은 문자열
    ev(3, { kind: "assertion", cmd: "expect", pass: false, expected: { mode: "equals", selector: "#n", text: "3" }, observed: "2" }),
    ev(4, { kind: "assertion", cmd: "expect", pass: false, expected: { mode: "equals", selector: "#n", text: "3" }, observed: null }),
    ev(5, { kind: "assertion", cmd: "app_expect", pass: false, expected: { mode: "contains", label: "합계", text: "3" }, observed: "1\n2" }),
  ], root).filter((e) => e.kind === "assertion");
  assert.deepEqual([checkText(out[2]).want, checkText(out[2]).got], ["'3' 일치", "2"]);
  assert.equal(checkText(out[3]).got, "대상을 못 찾음");
  assert.deepEqual([checkText(out[4]).target, checkText(out[4]).got], ["합계", "1\n2"]);
  assert.equal(checkText(out[0]).target, "버거킹 내 상품 검색");
  assert.equal(checkText(out[0]).want, "화면에 있음");
  assert.deepEqual([checkText(out[1]).want, checkText(out[1]).got], ["'3' 일치", "2"]);
});

test("증거 사진은 합계를 입력 때 제한하고 overview.text·notes 입력을 검사한다", async () => {
  const { readCaseEvidence, parseReportEdits } = await import("../server/qa-report.js");
  const many = Array.from({ length: 201 }, () => ({ file: "/없는/파일.png" }));
  assert.throws(() => readCaseEvidence([{ id: "A", checks: [{ kind: "디자인", text: "맞음", evidence: many }] }]), /200장까지/);
  // 장수가 적어도 파일 합계가 100MB 넘으면 거절(디스크를 쓰지 않는 빈 파일)
  const big = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-big-"));
  try {
    const files = Array.from({ length: 7 }, (_, i) => { const p = path.join(big, `${i}.png`); fs.writeFileSync(p, ""); fs.truncateSync(p, 15 * 1024 * 1024); return { file: p }; });
    assert.throws(() => readCaseEvidence([{ id: "A", checks: [{ kind: "디자인", text: "맞음", evidence: files }] }]), /합쳐 100MB까지/);
    assert.equal(readCaseEvidence([{ id: "A", checks: [{ kind: "디자인", text: "맞음", evidence: files.slice(0, 6) }] }])[0].checks[0].evidence.length, 6);
  } finally { fs.rmSync(big, { recursive: true, force: true }); }
  assert.deepEqual(parseReportEdits({ text: [{ from: "가", to: "" }], notes: [{ id: "n1", hide: true }] }), { text: [{ from: "가", to: "" }], notes: [{ id: "n1", hide: true }] });
  assert.throws(() => parseReportEdits({ text: [{ from: "가", to: "나" }, { from: "가", to: "다" }] }), /overview\.text에 같은 from/);
  assert.throws(() => parseReportEdits({ notes: [{ id: "n1" }] }), /hide는 true만/);
});

test("글 고치기: 원문에 없으면 화면에 나갈 글에서 찾고, 케이스 밖 글은 overview.text로, 못 찾으면 찾은 곳을 알린다", async (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-text5-"));
  const previous = process.env.IRIS_STATE_DIR;
  process.env.IRIS_STATE_DIR = root;
  t.after(() => { if (previous === undefined) delete process.env.IRIS_STATE_DIR; else process.env.IRIS_STATE_DIR = previous; fs.rmSync(root, { recursive: true, force: true }); });
  const ledger = createQaLedger({ anchor: createQaLedgerAnchor({ dir: path.join(root, "native") }) });
  const url = "http://localhost:4291/result";
  const runIt = async (runId, rowId, body) => {
    const lane = { rowId, path: "정상", surface: "browser", url };
    await ledger.begin({ runId, session: "owner", plan: qaPlan({ entries: [url] }), charter: qaCharter() });
    await ledger.append(runId, { kind: "row", action: "declare", rowId, rowData: { ...qaRowContract(), id: rowId, what: "메인 > 열기 > 표시", given: "가입한 사용자", basis: "user", basisNote: "U6·U7(P116), 첫 질문", paths: ["정상"] } });
    for (let i = 0; i < 12; i++) await ledger.append(runId, { kind: "observation", surface: "browser", url });
    await ledger.append(runId, { kind: "row", action: "open", ...lane, rowData: {} });
    await body(lane);
    await ledger.end(runId, { session: qaSession() });
  };
  await runIt("t1", "T1", async (lane) => {
    await ledger.append("t1", { kind: "assertion", ...lane, pass: true, label: "목록", expected: { mode: "exists", label: "목록" }, observed: {} });
    await ledger.append("t1", { kind: "session_note", detail: { kind: "관찰", text: "느린 요청 slow_query 14.9s 확인" } });
    await ledger.append("t1", { kind: "row", action: "note", rowId: "T1", rowData: { id: "n1", row: "T1", what: "정책 미정", decide: "표시 정책 qa_note 결정", simple: true } });
    await ledger.append("t1", { kind: "row", action: "note", rowId: "T1", rowData: { id: "n2", row: "T1", what: "같은 질문", decide: "표시 정책 결정(중복)", simple: true } });
    // seq 12는 이 회차 번호라 Iris가 괄호째 지움 → 화면에는 "확인함 끝"
    await ledger.append("t1", { kind: "row", action: "close", ...lane, rowData: { color: "green", note: "확인함(seq 12와 같음) 끝", sceneJudgment: "이상 없음" } });
  });
  await runIt("t2", "T2", async (lane) => {
    await ledger.append("t2", { kind: "row", action: "close", ...lane, rowData: { color: "green", note: "둘째 케이스 결과 메모 남김", sceneJudgment: "이상 없음" } });
  });
  const build = (overview) => createQaCombinedReport(ledger, ["t1", "t2"], { title: "보고서", overview });
  const report = await build({
    text: [{ from: "slow_query 14.9s", to: "14.9초 걸림" }, { from: "표시 정책 메모 결정", to: "표시 방식" }],
    notes: [{ id: "1-n2", hide: true }],
    cases: [{ id: "T1", text: [{ from: "가입한", to: "로그인한" }, { from: "확인함 끝", to: "확인 끝" }, { from: "사용자 결정 · U6·U7(P116), ", to: "사용자 결정 · " }] }],
  });
  const plain = fs.readFileSync(report.path, "utf8");
  const card = sliceBetween(plain, '<article id="w1"', "</article>");
  assert.match(card, /로그인한 사용자/, "원문 규칙");
  assert.match(card, /확인 끝/, "Iris가 번호를 지운 뒤 글을 가리킨 표시 규칙");
  assert.match(card, /사용자 결정 · 첫 질문/, "Iris 이름표를 포함한 표시 규칙");
  assert.match(plain, /14\.9초 걸림/, "세션 메모");
  assert.doesNotMatch(plain, /slow_query/);
  assert.match(plain, /<h2>결정할 사항 1<\/h2>/);
  assert.match(plain, /<p class="q">표시 방식<\/p>/, "결정 카드 글: Iris가 명령 이름을 바꾼 뒤 글");
  assert.doesNotMatch(plain, /같은 질문/);
  assert.deepEqual(report.textEdits.map((x) => [x.scope, x.how, x.count > 0]), [["T1", "원문", true], ["T1", "보이는 글", true], ["T1", "보이는 글", true],
    ["overview", "원문", true], ["overview", "보이는 글", true]]);
  // 규칙 종류는 범위 기록 전체로 한 번 정함: 기록에 있는 '메모'는 원문 규칙이라 Iris가 qa_note에서 만든 '메모'는 그대로
  const memo = fs.readFileSync((await build({ text: [{ from: "메모", to: "수정" }] })).path, "utf8");
  assert.match(memo, /둘째 케이스 결과 수정 남김/);
  assert.match(memo, /표시 정책 메모 결정/);
  // 앞 표시 규칙이 먼저 바꿔 할 일이 없는 표시 규칙은 오류가 아니고 바꾼 수 0
  const twice = await build({ cases: [{ id: "T1", text: [{ from: "사용자 결정 · U6·U7(P116), ", to: "다른 근거 " }, { from: "사용자 결정", to: "사람 결정" }] }] });
  assert.deepEqual(twice.textEdits.map((x) => x.count), [1, 0]);
  // overview에 직접 쓴 글(확인 글)은 text 대상이 아님
  await assert.rejects(build({ text: [{ from: "직접 쓴 확인", to: "x" }], cases: [{ id: "T1", checks: [{ kind: "디자인", text: "직접 쓴 확인", pass: true }] }] }), /overview에 직접 쓴 글/);
  // 못 찾은 글: 다른 케이스·케이스 밖·확인 줄·앞 규칙의 to·어디에도 없음
  const fails = async (overview, pattern) => assert.rejects(build(overview), pattern);
  await fails({ cases: [{ id: "T1", text: [{ from: "둘째 케이스", to: "x" }] }] }, /T1: text\.from '둘째 케이스'\(케이스 2\(T2\)의 결과에 있음/);
  await fails({ cases: [{ id: "T1", text: [{ from: "slow_query", to: "x" }] }] }, /세션 메모에 있음\. 케이스 밖 글은 overview\.text로/);
  await fails({ cases: [{ id: "T1", text: [{ from: "화면에 있음", to: "x" }] }] }, /확인 줄은 기록에서 만든 문장이라 바꿀 수 없음/);
  await fails({ cases: [{ id: "T1", text: [{ from: "확인함 끝", to: "Z1" }, { from: "Z1", to: "Z2" }] }] }, /앞 규칙의 to에서만 나옴/);
  // 표시 규칙은 원문 규칙이 바꾼 뒤 화면에 나갈 글에서 찾음. 바뀌기 전 글로 적으면 바꾼 수 0으로 넘기지 않고 알림
  const after = await build({ cases: [{ id: "T1", text: [{ from: "첫 질문", to: "둘째 질문" }, { from: "사용자 결정 · U6·U7(P116), 둘째 질문", to: "근거 질문" }] }] });
  assert.deepEqual(after.textEdits.map((x) => [x.how, x.count]), [["원문", 1], ["보이는 글", 1]]);
  assert.match(fs.readFileSync(after.path, "utf8"), /근거 질문/);
  await fails({ cases: [{ id: "T1", text: [{ from: "첫 질문", to: "둘째 질문" }, { from: "사용자 결정 · U6·U7(P116), 첫 질문", to: "x" }] }] },
    /T1: text\.from '사용자 결정 · U6·U7\(P116\), 첫 질문'\(원문 규칙이 먼저 바꾼 글\. 바뀐 뒤 글로\)/);
  await fails({ text: [{ from: "없는 글", to: "x" }] }, /overview\.text\.from '없는 글'\(보고서 어디에도 없음\)/);
  await fails({ notes: [{ id: "n9", hide: true }] }, /overview\.notes\.id 'n9'\(결정할 사항에 없음/);
});

test("증거 사진은 상한과 상관없이 모두 맨 앞에, 처음 보이는 사진은 판정 글이 가리킨 사진, 빌드·회차 표시", async (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-proof-"));
  const previous = process.env.IRIS_STATE_DIR;
  process.env.IRIS_STATE_DIR = root;
  t.after(() => { if (previous === undefined) delete process.env.IRIS_STATE_DIR; else process.env.IRIS_STATE_DIR = previous; fs.rmSync(root, { recursive: true, force: true }); });
  const ledger = createQaLedger({ anchor: createQaLedgerAnchor({ dir: path.join(root, "native") }) });
  const url = "http://localhost:4291/result";
  const file = (name, buf) => { const p = path.join(root, `${name}.png`); fs.writeFileSync(p, buf); return p; };
  // 빌드는 계획의 저장소를 git 으로 읽음. 커밋 하나와 커밋하지 않은 파일이 있는 임시 저장소
  const repo = path.join(root, "app-repo");
  fs.mkdirSync(repo);
  const { execFileSync } = await import("node:child_process");
  const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "qa-branch"); fs.writeFileSync(path.join(repo, "a.txt"), "a"); git("add", "a.txt"); git("commit", "-qm", "a");
  fs.writeFileSync(path.join(repo, "b.txt"), "b");
  const head = git("rev-parse", "HEAD");
  for (const runId of ["p1", "p2"]) {
    const lane = { rowId: runId.toUpperCase(), path: "정상", surface: "browser", url };
    await ledger.begin({ runId, session: "owner", plan: qaPlan({ entries: [url], build: { repo } }), charter: qaCharter() });
    await ledger.append(runId, { kind: "row", action: "declare", rowId: lane.rowId, rowData: { ...qaRowContract(), id: lane.rowId, what: "메인 > 열기 > 표시", given: "사용자", basis: "assumed", basisNote: "고정 입력", paths: ["정상"] } });
    await ledger.append(runId, { kind: "row", action: "open", ...lane, rowData: {} });
    const seqs = [];
    // 서로 다른 판정 사진 8장. 판정 글은 마지막 사진을 가리킴
    for (let i = 0; i < 8; i++) seqs.push((await ledger.append(runId, { kind: "assertion", ...lane, pass: true, label: `칸${i}`, expected: { mode: "exists", label: `칸${i}` }, observed: {}, shot: file(`${runId}-${i}`, png(60 + i * 3)) })).seq);
    await ledger.append(runId, { kind: "row", action: "close", ...lane, rowData: { color: "green", note: "표시", sceneJudgment: `마지막 화면이 맞다(사진 ${seqs.at(-1)}).` } });
    await ledger.end(runId, { session: qaSession() });
  }
  const evidence = Array.from({ length: 7 }, (_, i) => ({ file: file(`ev${i}`, png(100 + i * 3)), caption: `크기 ${i}` }));
  const report = await createQaCombinedReport(ledger, ["p1", "p2"], { title: "보고서", overview: { cases: [{ id: "P1", checks: [{ kind: "디자인", text: "피그마와 같음", pass: true, evidence }] }] } });
  const plain = fs.readFileSync(report.path, "utf8"), dev = fs.readFileSync(report.devPath, "utf8");
  const card = (id) => sliceBetween(plain, `<article id="${id}"`, "</article>");
  const caps = [...card("w1").matchAll(/<figcaption[^>]*><b>[^<]*<\/b><span>([^<]*)<\/span>/g)].map((m) => m[1]);
  assert.equal(caps.filter((c) => c.startsWith("피그마와 같음")).length, 7, caps.join(" | "));
  assert.ok(caps.slice(0, 7).every((c) => c.startsWith("피그마와 같음")), "증거 사진 맨 앞");
  assert.equal(caps.length, 12, "증거 7장 + 상한 5장");
  // 처음 보이는 사진: 증거 사진이 있으면 증거, 없는 케이스는 판정 글이 가리킨 마지막 사진
  assert.match(card("w1"), /<figure class="sc on"[^>]*>\s*<button[^>]*><span class="frame"><img[^>]*alt="피그마와 같음/);
  const on = card("w2").match(/<figure class="sc on"[^>]*>[\s\S]*?<figcaption[^>]*><b>([^<]*)<\/b><span>([^<]*)/);
  assert.match(on[2], /^마지막 화면이 맞다/);
  assert.equal(on[1].split("/")[0], on[1].split("/")[1], "마지막 장");
  assert.match(card("w2"), /<a href="report-dev\.html#q2">나머지 장면 \d+장은 개발자용 보고서에 있음<\/a>/);
  // 같은 순위 안에서는 처음부터 끝까지 고르게(가리킨 마지막 사진 + 나머지 7장 중 4장)
  const w2 = [...card("w2").matchAll(/<figcaption[^>]*><b>[^<]*<\/b><span>([^<]*)<\/span>/g)].map((m) => (m[1].match(/칸\d/g) || []).join(""));
  assert.deepEqual(w2, ["칸0", "칸2", "칸4", "칸6", "칸7"]);
  // 빌드: 사람용은 커밋 앞 7자와 변경 여부, 경로·branch 는 개발자용에만. 두 보고서 모두 Charter 앞
  assert.ok(plain.includes(`<h2>빌드</h2><dl class="pairs"><dt>확인한 코드</dt><dd><p>커밋 ${head.slice(0, 7)} · 커밋하지 않은 변경 있음</p>`));
  assert.ok(!plain.includes(repo) && !/qa-branch|dirty/.test(plain), "저장소 경로·branch 는 사람용에 없음");
  assert.ok(dev.includes(`${repo}<br>HEAD ${head} · branch qa-branch · dirty true`));
  for (const html of [plain, dev]) { const a = html.indexOf("<h2>빌드</h2>"), b = html.indexOf("<h2>Charter"); assert.ok(a > 0 && b > a, "빌드가 Charter 앞"); }
  assert.match(plain, /<h2>Charter <small>마지막 회차 [^<]+<\/small><\/h2>/);
  assert.match(plain, /보고서 검사: 회차 기록이 보고서 조건을 갖췄는지/);
});
