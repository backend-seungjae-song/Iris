import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { deflateSync } from "node:zlib";
import { createRequire } from "node:module";
import { createQaLedger } from "../server/qa-ledger.js";
import { createQaReport } from "../server/qa-report.js";
import { createQaSummary } from "../server/qa-summary.js";
import { captureQaBuild } from "../server/qa-build.js";
import { qaCharter, qaSession, qaPlan, qaRowContract } from "./qa-fixtures.mjs";
const require = createRequire(import.meta.url);
const { createQaLedgerAnchor } = require("../native/electron/qa-ledger-anchor.cjs");
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "evidence-tests-"));
const previous = process.env.IRIS_STATE_DIR;
process.env.IRIS_STATE_DIR = root;
test.after(() => { if (previous === undefined) delete process.env.IRIS_STATE_DIR; else process.env.IRIS_STATE_DIR = previous; fs.rmSync(root, { recursive: true, force: true }); });
const ledger = createQaLedger({ anchor: createQaLedgerAnchor({ dir: path.join(root, "native") }) });
const url = "http://localhost:4291/result";
function png(shade, width = 80) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4); size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, body, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(80, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(80 * (width * 3 + 1), shade); for (let y = 0; y < 80; y++) pixels[y * (width * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}
const shot = path.join(root, "source.png"), different = path.join(root, "different.png");
fs.writeFileSync(shot, png(210)); fs.writeFileSync(different, png(60));
async function begin(runId, build) { await ledger.begin({ runId, session: "owner", plan: qaPlan({ entries: [url], ...(build ? { build } : {}) }), charter: qaCharter() }); }
async function row(runId, id, color = "green", retestOf, retestFix) {
  const lane = { rowId: id, path: "정상", surface: "browser", url };
  await ledger.append(runId, { kind: "row", action: "declare", rowId: id, rowData: { ...qaRowContract(), id, what: `${id} 결과`, given: "사용자", basis: "assumed", basisNote: "고정 검사 입력", paths: ["정상"], ...(retestOf ? { retestOf, retestFix } : {}) } });
  await ledger.append(runId, { kind: "row", action: "open", ...lane, rowData: {} });
  await ledger.append(runId, { kind: "frame", phase: "after", shot, ...lane });
  const assertion = await ledger.append(runId, { kind: "assertion", pass: color !== "red", expected: { mode: "exists" }, shot, ...lane });
  await ledger.append(runId, { kind: "row", action: "close", sceneJudgment: "기대 결과와 화면 전체의 상태를 확인했고 추가 이상은 보이지 않았다.", ...lane, rowData: { color, sceneJudgment: "화면 전체에 추가 이상이 보이지 않았다.", note: "결과 확인" } });
  return assertion;
}

test("E1 사진 내용이 같아도 주장별 사진 기록을 유지한다", async () => {
  await begin("dedup");
  const first = await ledger.append("dedup", { kind: "frame", shot });
  await ledger.append("dedup", { kind: "frame", shot: different });
  const third = await ledger.append("dedup", { kind: "frame", shot });
  assert.notEqual(third.event.shot, first.event.shot);
  assert.equal(first.event.shotSeq, first.seq); assert.equal(third.event.shotSeq, third.seq);
  assert.equal(third.event.same, undefined);
  assert.equal(fs.readdirSync(path.join(ledger.paths("dedup").folder, "shots")).length, 3);
  await ledger.verify("dedup");
});

test("E1 보고서는 주장별 장면을 보존하고 원본 폴더를 변경하지 않는다", async () => {
  await begin("report-dedup"); await row("report-dedup", "a"); await row("report-dedup", "b");
  await ledger.end("report-dedup", { session: qaSession() });
  const folder = path.join(ledger.paths("report-dedup").folder, "shots");
  const before = fs.readdirSync(folder);
  const report = await createQaReport(ledger, "report-dedup");
  assert.deepEqual(fs.readdirSync(folder), before);
  for (const file of [report.path, report.devPath]) {
    const html = fs.readFileSync(file, "utf8");
    assert.ok((html.match(/<img\b[^>]*src="data:image/g) || []).length >= 1);
    assert.doesNotMatch(html, /같은 사진과 같음/);
    const build = html.search(/<h2>빌드<\/h2>|<dt>확인한 코드<\/dt>/);
    assert.ok(build >= 0 && build < html.indexOf("<h2>Charter</h2>"), file);
  }
});

test("E1 설명과 표시를 HTML에 더해도 장부 원본은 그대로다", async () => {
  await begin("annotated"); await row("annotated", "annotated");
  await ledger.append("annotated", { kind: "observation", cmd: "screenshot", rowId: "annotated", path: "정상", shot: different,
    caption: "화면 안내", marks: [{ label: "점검 위치", color: "#ff0000", x: .1, y: .2, w: .3, h: .4 }],
    stability: { waitedMs: 100, stable: false, remaining: ["animation"] }, url });
  await ledger.end("annotated", { session: qaSession() });
  const folder = path.join(ledger.paths("annotated").folder, "shots");
  const before = fs.readdirSync(folder).map(file => [file, fs.readFileSync(path.join(folder, file)).toString("base64")]);
  const report = await createQaReport(ledger, "annotated");
  assert.deepEqual(fs.readdirSync(folder).map(file => [file, fs.readFileSync(path.join(folder, file)).toString("base64")]), before);
  for (const file of [report.path, report.devPath]) { const html = fs.readFileSync(file, "utf8"); assert.match(html, /화면 안내/); assert.match(html, /점검 위치/); assert.match(html, /안정 전 촬영/); }
});

test("E3 metadata는 장부 sanitize와 재검증을 통과해 보존된다", async () => {
  await begin("metadata");
  const metadata = { stability: { waitedMs: 430, stable: false, remaining: ["animation", "network"] }, captureTarget: { tab: "t1", surface: "browser" }, viewport: { width: 390, height: 844, dpr: 2 }, url };
  const saved = await ledger.append("metadata", { kind: "frame", shot, ...metadata, forbidden: "omit" });
  for (const key of Object.keys(metadata)) assert.deepEqual(saved.event[key], metadata[key]);
  assert.equal(saved.event.forbidden, undefined);
  const reread = (await ledger.verify("metadata")).events.at(-1).event;
  assert.deepEqual(reread.stability, metadata.stability); assert.deepEqual(reread.captureTarget, metadata.captureTarget);
});

test("E3 서버가 시작과 종료 HEAD branch dirty를 기록하고 보고서에 먼저 표시한다", async () => {
  const repo = path.join(root, "repo"); fs.mkdirSync(repo);
  const git = args => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git(["init", "-b", "base"]); fs.writeFileSync(path.join(repo, "file"), "first"); git(["add", "."]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"]);
  const firstHead = git(["rev-parse", "HEAD"]);
  await assert.rejects(begin("bad-build", { repo: "relative" }), /절대 경로/);
  assert.equal(fs.existsSync(ledger.paths("bad-build").folder), false);
  await begin("build", { repo }); await row("build", "build");
  git(["switch", "-c", "fix"]); fs.writeFileSync(path.join(repo, "file"), "second"); git(["add", "."]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fix"]);
  fs.writeFileSync(path.join(repo, "dirty"), "pending");
  await ledger.end("build", { session: qaSession() });
  const events = (await ledger.verify("build")).events;
  assert.equal(events[0].event.build.head, firstHead); assert.equal(events[0].event.build.branch, "base"); assert.equal(events[0].event.build.dirty, false);
  assert.equal(events.at(-1).event.build.head, git(["rev-parse", "HEAD"])); assert.equal(events.at(-1).event.build.branch, "fix"); assert.equal(events.at(-1).event.build.dirty, true);
  assert.equal(captureQaBuild({ repo }).repo, repo);
  const report = await createQaReport(ledger, "build");
  // 개발자용은 저장소·HEAD·branch·변경 여부 전부, 사람용은 커밋 앞 7자와 변경 여부만
  const dev = fs.readFileSync(report.devPath, "utf8"), plain = fs.readFileSync(report.path, "utf8");
  assert.match(dev, /HEAD [a-f0-9]{40} · branch base · dirty false/); assert.match(dev, /branch fix · dirty true/);
  assert.ok(plain.includes(`커밋 ${firstHead.slice(0, 7)} → ${git(["rev-parse", "HEAD"]).slice(0, 7)} · 커밋하지 않은 변경 있음`));
  assert.doesNotMatch(plain, /branch|dirty|HEAD/);
  git(["checkout", "--detach", firstHead]);
  await begin("detached-build", { repo }); await ledger.end("detached-build", { session: qaSession() });
  const detached = (await ledger.verify("detached-build")).events;
  assert.equal(detached[0].event.build.branch, null); assert.equal(detached.at(-1).event.build.branch, null);
});

test("U5 검증된 여러 회차 요약은 결함 수정 재확인과 중단 미확인 정보를 모은다", async () => {
  await begin("failed"); const failed = await row("failed", "bad", "red");
  const defect = await ledger.append("failed", { kind: "defect", detail: { problem: "저장 결과 오류", failureSeq: failed.seq } });
  const fix = await ledger.append("failed", { kind: "fix", detail: { defect: defect.seq, commit: "a".repeat(40), branch: "fix/save", summary: "저장 결과 수정" } });
  await assert.rejects(ledger.end("failed", { session: qaSession() }), /판정이 필요한 결함/);
  await begin("retest"); await row("retest", "fixed", "green", { run: "failed", defect: String(defect.seq) }, { seq: fix.seq, commit: fix.event.detail.commit }); await ledger.append("retest", { kind: "play_result", rowId: "fixed", path:"정상", detail: { pass: true, retestOf: { run: "failed", defect: defect.seq }, retestFix: { seq: fix.seq, commit: fix.event.detail.commit }, shotSeq: 1 } }); await ledger.end("retest", { session: qaSession() });
  await begin("blocked"); await ledger.append("blocked", { kind: "blocked", reason: "인증에 사람 필요" });
  await ledger.end("blocked", { session: { ...qaSession(), unverified: { items: "모바일 화면", reason: "기기 없음" }, blockers: "인증 실패", remainingQuestions: "로그인 후 저장 결과", stopCriterion: "blocked" } });
  const result = await createQaSummary(ledger, ["failed", "retest", "blocked"], { session: "owner" });
  assert.equal(result.verifiedRuns.length, 3); assert.equal(result.summary.fixed.length, 1);
  assert.equal(result.summary.fixed[0].status, "수정 확인");
  const html = fs.readFileSync(result.path, "utf8");
  for (const text of ["통과", "실패", "고침", "못 함", "확인 방해 문제", "미확인 영역", "빌드", "fix/save", "재확인", "인증에 사람 필요", "중단 후 미해결", "모바일 화면"]) assert.ok(html.includes(text), text);
  assert.ok((html.match(/<img\b/g) || []).length >= 0);
  await ledger.append("failed", { kind: "fix", detail: { defect: defect.seq, commit: "c".repeat(40), branch: "fix/newer", summary: "후속 수정" } });
  const newer = await createQaSummary(ledger, ["failed", "retest"]);
  assert.equal(newer.summary.fixed.length, 2);
  assert.equal(newer.summary.fixed[0].status,"이전 수정");
  assert.equal(newer.summary.fixed[1].status,"수정 미확인");
  assert.equal(newer.summary.fixed[0].retests.length, 1); assert.equal(newer.summary.fixed[1].retests.length, 0);
});

test("U5 수정 후 재확인 실패와 미실시는 수정 커밋과 함께 남는다", async () => {
  await begin("pending-fix"); const failure = await row("pending-fix", "pending", "red");
  const defect = await ledger.append("pending-fix", { kind: "defect", detail: { problem: "다른 저장 오류", failureSeq: failure.seq } });
  const fix = await ledger.append("pending-fix", { kind: "fix", detail: { defect: defect.seq, commit: "b".repeat(40), branch: "fix/pending", summary: "수정 기록" } });
  await ledger.append("pending-fix", { kind: "session_note", detail: { kind: "질문", text: "추가 조건에 사람 답 필요" } });
  await ledger.append("pending-fix", { kind: "frame", shot, stability: { waitedMs: 500, stable: false, remaining: ["animation"] }, captureTarget: { surface: "browser" }, viewport: { width: 80, height: 80 }, url });
  await ledger.append("pending-fix", { kind: "human_review", detail: { defect: defect.seq, reason: "재실행 환경 확인 필요" } });
  await ledger.end("pending-fix", { session: qaSession() });
  const pending = await createQaSummary(ledger, ["pending-fix"]);
  assert.equal(pending.summary.fixed.length, 1); assert.equal(pending.summary.fixed[0].retests.length, 0);
  assert.ok(pending.summary.unable.some(text => text.includes("수정 후 재확인 미확인")));
  const html = fs.readFileSync(pending.path, "utf8"); assert.match(html, /fix\/pending/); assert.match(html, /추가 조건에 사람 답 필요/); assert.match(html, /안정 전 촬영/);
  const report = await createQaReport(ledger, "pending-fix");
  for (const file of [report.path, report.devPath]) assert.match(fs.readFileSync(file, "utf8"), /안정 전 촬영/);
  await begin("failed-retest"); await row("failed-retest", "still-bad", "red", { run: "pending-fix", defect: String(defect.seq) }, { seq: fix.seq, commit: fix.event.detail.commit }); await ledger.append("failed-retest", { kind: "play_result", rowId: "still-bad", detail: { pass: false, retestOf: { run: "pending-fix", defect: defect.seq }, retestFix: { seq: fix.seq, commit: fix.event.detail.commit }, shotSeq: 1 } }); await ledger.end("failed-retest", { session: qaSession() });
  const failed = await createQaSummary(ledger, ["pending-fix", "failed-retest"]);
  assert.equal(failed.summary.fixed[0].retestResults[0].status, "실패");
  assert.ok(failed.summary.unable.some(text => text.includes("수정 후 재확인 실패")));
});

test("U5 체인 실패와 다른 세션의 장부는 내용과 사진을 요약에 넣지 않는다", async () => {
  await begin("tampered"); await ledger.append("tampered", { kind: "frame", shot, caption: "장부 비밀 내용" });
  const journal = ledger.paths("tampered").journal;
  fs.writeFileSync(journal, fs.readFileSync(journal, "utf8").replace("장부 비밀 내용", "변조 비밀 내용"));
  await ledger.begin({ runId: "foreign", session: "other", plan: qaPlan({ entries: [url] }), charter: { ...qaCharter(), scope: "다른 사람 비밀 내용" } });
  const result = await createQaSummary(ledger, ["tampered", "foreign"], { session: "owner" });
  assert.equal(result.verifiedRuns.length, 0); assert.equal(result.rejectedRuns.length, 2);
  assert.match(result.rejectedRuns.find(item => item.runId === "tampered").reason, /장부 검증 실패: QA 장부 해시가 변조됐습니다/);
  const html = fs.readFileSync(result.path, "utf8"); assert.match(html, /장부 검증 실패/); assert.doesNotMatch(html, /장부 비밀 내용|변조 비밀 내용|다른 사람 비밀 내용|<img/);
  for (const ids of [[], ["failed", "failed"], ["../outside"], "failed"]) await assert.rejects(createQaSummary(ledger, ids), /runIds/);
});
