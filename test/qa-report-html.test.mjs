import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createQaLedger } from "../server/qa-ledger.js";
import { applyQaRow, deriveQaRows } from "../server/qa-rows.js";
import { createQaReport } from "../server/qa-report.js";
import { recordQaSession } from "../server/qa-session.js";
import { artifactDir } from "../server/artifacts-home.cjs";
import { stateHome } from "../server/state-home.cjs";
import { qaCharter, qaSession, qaPlan, qaRowContract } from "./qa-fixtures.mjs";

const require = createRequire(import.meta.url);
const { createQaLedgerAnchor } = require("../native/electron/qa-ledger-anchor.cjs");
const root = fs.mkdtempSync(path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), ".qa-report-html-"));
const priorState = process.env.IRIS_STATE_DIR;
const priorPort = process.env.IRIS_PORT;
process.env.IRIS_STATE_DIR = root;
process.env.IRIS_PORT = "4291";
test.after(() => {
  if (priorState === undefined) delete process.env.IRIS_STATE_DIR; else process.env.IRIS_STATE_DIR = priorState;
  if (priorPort === undefined) delete process.env.IRIS_PORT; else process.env.IRIS_PORT = priorPort;
  fs.rmSync(root, { recursive: true, force: true });
});

const tiny = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz8AAAAASUVORK5CYII=", "base64");
// 실제 화면 캡처를 대신하는 오프라인 renderer 입력이다. PNG 규격의 RGB scanline과 CRC를 저장한다.
function fixturePng(shade = 240) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, body, checksum]);
  };
  const width = 800, height = 600, header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(height * (width * 3 + 1), shade);
  for (let y = 0; y < height; y++) pixels[y * (width * 3 + 1)] = 0;
  return Buffer.concat([tiny.subarray(0, 8), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}
const source = path.join(root, "fixture-800x600.png");
const smallSource = path.join(root, "fixture-1x1.png");
fs.writeFileSync(source, fixturePng()); fs.writeFileSync(smallSource, tiny);
const URL = "http://localhost:4291/result";
let scene = 0;
const image = (png) => {
  if (png === smallSource) return png;
  const file = path.join(root, `fixture-scene-${++scene}.png`);
  fs.writeFileSync(file, fixturePng(40 + scene));
  return file;
};
const contains = (html, pattern) => assert.ok(pattern.test(html), `HTML에 ${pattern} 포함`);

async function setup(runId) {
  const anchor = createQaLedgerAnchor({ dir: path.join(root, "native", runId) });
  const ledger = createQaLedger({ anchor });
  await ledger.begin({ runId, session: "offline-test", plan: qaPlan({ entries: [URL] }), charter: qaCharter() });
  await ledger.append(runId, { kind: "entry", url: URL, surface: "browser" });
  return { ledger, runId, row: args => applyQaRow({ ledger, runId, args }), append: event => ledger.append(runId, {mode:"agent_action",...event}) };
}
async function completeRow(f, id, color = "green", { voidReceipt = false, aside = false, png = source, outOfCharter = false } = {}) {
  const lane = { rowId: id, path: "정상", lanes: [[id, "정상"]], surface: "browser", url: URL };
  await f.row({ action: "declare", ...qaRowContract(), id, what: `${id} 결과 표시`, given: "결과 화면을 연 사용자", basis: "assumed", basisNote: "오프라인 판정 fixture", paths: ["정상"], outOfCharter });
  await f.row({ action: "open", row: id, path: "정상" });
  await f.append({ kind: "observation", cmd: "snapshot", ...lane, pass: true });
  const expected = { effects: [{ id: "e1", type: "appear", text: "Saved", oracle: "명세나 대화에서 정한 내용" }], within: 1200 };
  const accepted = await f.append({ kind: "accepted", cmd: "click", ...lane, expected });
  await f.append({ kind: "frame", phase: "S1", claim: { kind: "S1" }, ...lane, acceptedSeq: accepted.seq, shot: image(png) });
  const after = await f.append({ kind: "frame", phase: color === "red" ? "S3" : "S2", claim: { kind: color === "red" ? "S3" : "S2" }, ...lane, acceptedSeq: accepted.seq, shot: image(png) });
  await f.append({ kind: "action", cmd: "click", ...lane, acceptedSeq: accepted.seq, expected, pass: color !== "red", trusted: true });
  await f.append({ kind: "reaction", cmd: "click", ...lane, acceptedSeq: accepted.seq, expected, pass: color !== "red", detail: { pass: color !== "red", effects: [{ ...expected.effects[0], observed: color !== "red", ...(color !== "red" ? { sceneSeq: after.seq } : {}) }] } });
  await f.append({ kind: "observation", cmd: "observe", ...lane, pass: true });
  if (voidReceipt) {
    const wrong = await f.append({ kind: "assertion", ...lane, pass: false, expected: { mode: "contains", text: "wrong" }, shot: image(png) });
    await f.row({ action: "void", receipt: String(wrong.seq), why: "다른 항목의 기대 문구" });
  }
  const assertion = await f.append({ kind: "assertion", ...lane, pass: color !== "red", expected: { mode: "contains", text: "Saved" }, observed: "Saved", shot: image(png) });
  if (aside) await f.row({ action: "aside", row: id, path: "정상", frames: [after.event.shot], why: "전환 도중 표시한 중간 장면" });
  await f.row({ action: "close", sceneJudgment: "기대 결과와 화면 전체의 상태를 확인했고 추가 이상은 보이지 않았다.", row: id, path: "정상", color, note: `${id} 결과 표시`, simple: true });
  return assertion;
}

test("offline native-anchor ledger produces default HTML with charter, session, image, six colors, void and aside", async () => {
  assert.equal(stateHome(), root);
  const f = await setup("offline-report-colors");
  for (const color of ["green", "red", "orange", "yellow", "blue", "gray"])
    await completeRow(f, color, color, color === "green" ? { voidReceipt: true, aside: true } : {});
  await f.ledger.end(f.runId, { session: qaSession() });
  const report = await createQaReport(f.ledger, f.runId);
  assert.ok(report.path.startsWith(artifactDir("qa", root) + path.sep));
  const plain = fs.readFileSync(report.path, "utf8"), dev = fs.readFileSync(report.devPath, "utf8");
  for (const html of [plain, dev]) {
    contains(html, /<h2>Charter<\/h2>/);
    contains(html, /<h2>세션 기록<\/h2>/);
    assert.ok(html.indexOf("<h2>Charter</h2>") < html.indexOf("<h2>세션 기록</h2>"));
    contains(html, /<img[^>]+src="data:image\/(?:png|jpeg);base64,/);
    for (const color of ["green", "red", "orange", "yellow", "blue", "gray"]) assert.ok(html.includes(`class="chip ${color}"`), color);
    contains(html, /다른 항목의 기대 문구/);
    contains(html, /전환 도중 표시한 중간 장면/);
  }
  assert.ok(plain.indexOf('class="tally"') < plain.indexOf("<h2>세션 기록</h2>"), "결과가 세션 기록보다 먼저");
  contains(plain, /잘못 설정한 확인 제외/);
  contains(plain, /증거에서 제외한 장면/);
  contains(dev, /무효로 돌린 판정 1건/);
  contains(dev, /증거 아님으로 표시한 장면 1장/);
  const verified = await f.ledger.verify(f.runId);
  const green = deriveQaRows(verified.events).rows.find(row => row.id === "green");
  assert.equal(green.walked.정상.receipts, 2);
  assert.equal(green.walked.정상.failed, 0);
  assert.equal(report.ledger.rows, 6);
  assert.equal(verified.head, report.head);
  assert.equal(report.sessionAnalysis.time.invalidIntervals,0);
  const time = report.sessionAnalysis.time;
  assert.ok(time.totalMs > 0);
  assert.equal(time.totalMs, verified.events.at(-1).event.at - verified.events[0].event.at);
  assert.equal(time.totalMs,time.setupMs + time.investigationMs + time.testMs);
  assert.equal(time.totalMs,time.insideMs + time.outsideMs + time.unassignedMs);
  for (const html of [plain,dev]) {
    // 사람용 제목 뒤에는 개수·시간이 붙음(<small>)
    const sections = ["Charter","세션 기록","결함 목록","세션 메모","시간 분류","Charter 밖 확인 항목"].map(title => html.search(new RegExp(`<h2>${title}(</h2>| <small>)`)));
    assert.ok(sections.every((index,i)=>index >= 0 && (!i || index > sections[i-1])));
    contains(html,/inquiry metrics/);
  }
});

test("offline tiny scene remains in developer HTML and is excluded from the readable default report", async () => {
  const f = await setup("offline-report-tiny");
  await completeRow(f, "tiny", "green", { png: smallSource });
  await f.ledger.end(f.runId, { session: qaSession() });
  const report = await createQaReport(f.ledger, f.runId);
  const plain = fs.readFileSync(report.path, "utf8"), dev = fs.readFileSync(report.devPath, "utf8");
  assert.doesNotMatch(plain, /<img[^>]+src="data:image\/(?:png|jpeg);base64,/, "작은 장면은 사람용 보고서에 넣지 않음");
  contains(plain, /판독 불가 크기 장면/);
  contains(dev, /<img[^>]+src="data:image\/(?:png|jpeg);base64,/);
});

test("native ledger report includes structured defect, diagnostic evidence, note, revised charter and outside row", async () => {
  const f = await setup("offline-session-evidence");
  const assertion = await completeRow(f,"outside","red",{outOfCharter:true});
  await f.append({kind:"failure",mode:"agent_action",rowId:"outside",path:"정상",surface:"browser",url:URL,shot:source,
    detail:{failureSeq:assertion.seq,console:["<script>error</script>"],network:[{status:500}],exceptions:["TypeError"],environment:{url:URL,viewport:{width:800,height:600}}}});
  const command = (cmd,args) => recordQaSession({ledger:f.ledger,runId:f.runId,cmd,args,rowId:"outside",surface:"browser"});
  const defect = await command("defect",{problem:"<b>저장 문제</b>",oracle:"명세나 대화에서 정한 내용",oracleNote:"저장 결과 표시",importance:"사용자가 결과를 알 수 없음",reproducible:"가끔 재현됨",tried:"결과 확인"});
  await f.append({kind:"human_review",detail:{defect:defect.seq,reason:"추가 입력에 사람 확인 필요"}});
  await command("note",{kind:"질문",text:"<i>다른 입력은 어떤가</i>"});
  await command("charter",{charter:{...qaCharter(),scope:"알림 결과 포함"},reason:"알림도 확인"});
  await f.ledger.end(f.runId,{session:qaSession()});
  const report = await createQaReport(f.ledger,f.runId);
  assert.equal(report.sessionAnalysis.time.invalidIntervals,0);
  assert.equal(report.sessionAnalysis.defects.length,1);
  assert.equal(report.sessionAnalysis.defects[0].failureSeq,assertion.seq);
  assert.equal(report.sessionAnalysis.defects[0].failures.length,1);
  assert.equal(report.sessionAnalysis.outsideRows[0].id,"outside");
  for (const file of [report.path,report.devPath]) {
    const html = fs.readFileSync(file,"utf8");
    contains(html,/&lt;b&gt;저장 문제&lt;\/b&gt;/); contains(html,/&lt;script&gt;error&lt;\/script&gt;/);
    contains(html,/&lt;i&gt;다른 입력은 어떤가&lt;\/i&gt;/); contains(html,/알림 결과 포함/);
    contains(html,/수정 전/); contains(html,/수정 후/); contains(html,/Charter 밖/);
    assert.doesNotMatch(html,/\[object Object\]|<script>error/);
  }
  // 기대 결과: 개발자용은 원문, 사람용은 읽는 줄
  contains(fs.readFileSync(report.devPath,"utf8"),/&quot;mode&quot;: &quot;contains&quot;/);
  contains(fs.readFileSync(report.path,"utf8"),/'Saved' 포함/);
  // 실패 당시 기록 원문(JSON)은 개발자용에만
  assert.doesNotMatch(fs.readFileSync(report.path,"utf8"),/&quot;failureSeq&quot;/);
  contains(fs.readFileSync(report.devPath,"utf8"),/&quot;failureSeq&quot;/);
});

test("offline handoff renders instructions and a recorded reference scene with info verdicts before run completion", async () => {
  const f = await setup("offline-handoff");
  const frame = await f.append({ kind: "observation", cmd: "screenshot", shot: source, url: URL, pass: true });
  const report = await createQaReport(f.ledger, f.runId, { handoff: true, steps: [
    { name: "결과 확인", action: "저장 버튼을 누른다", expected: "Saved 문구가 보인다", shotSeq: frame.seq },
  ] });
  const html = fs.readFileSync(report.path, "utf8");
  contains(html, /저장 버튼을 누른다/);
  contains(html, /Saved 문구가 보인다/);
  contains(html, /이렇게 보이면 정상/);
  contains(html, /<img[^>]+src="data:image\/(?:png|jpeg);base64,/);
  contains(html, /<h2>Charter<\/h2>/);
  assert.equal(report.checks, undefined);
  assert.equal(report.failed, undefined);
  const manifest = JSON.parse(fs.readFileSync(path.join(report.store, "manifest.json"), "utf8"));
  assert.equal(manifest.kind, "handoff");
  assert.deepEqual(manifest.steps.map(step => step.verdict), ["info"]);
  await assert.rejects(createQaReport(f.ledger, f.runId, { handoff: true, steps: [
    { name: "결과 확인", action: "저장 버튼을 누른다", expected: "Saved 문구가 보인다", shotSeq: 999 },
  ] }), /촬영한 기준 이미지/);
});

test("이전 보고서는 같은 소유자의 검증된 종료 회차만 참조하고 overview 보존",async()=>{
  const previous=await setup("offline-prior"), current=await setup("offline-current");
  await completeRow(previous,"이전");await previous.ledger.end(previous.runId,{session:qaSession()});
  await completeRow(current,"현재");await current.ledger.end(current.runId,{session:qaSession()});
  // 두 회차를 읽는 동일 앵커 포트
  const ledger={...current.ledger,verify:run=>run === previous.runId ? previous.ledger.verify(run):current.ledger.verify(run)};
  const report=await createQaReport(ledger,current.runId,{session:"offline-test",overview:{scope:"새 확인 범위",features:[{name:"조회 기능",need:["조회"],understood:["결과"],built:["화면"],cases:["현재"]}]},resume:{from:previous.runId}});
  assert.ok(fs.readFileSync(report.path,"utf8").includes("새 확인 범위"));
  assert.ok(fs.readFileSync(report.path,"utf8").includes("조회 기능"));
  await assert.rejects(createQaReport(ledger,current.runId,{overview:{features:[{name:"없는 결과",cases:["foreign"]}]}}),/케이스/);
  assert.equal(report.previousReport.run,previous.runId);assert.ok(fs.existsSync(report.previousReport.path));
  await assert.rejects(createQaReport(ledger,current.runId,{session:"foreign",resume:{from:previous.runId}}),/세션/);
});

test("charter의 무인 진행·미리 승인 값을 이름과 함께 표시한다", async () => {
  const { renderSessionRecords } = await import("../bin/mcp/report-session.mjs");
  const html = renderSessionRecords({ sharedEnvironment: false, unattended: true, approvals: { logins: [], bulkFill: false }, investigationLimitMin: 1 }, null, v => String(v));
  assert.doesNotMatch(html, /undefined/);
  assert.match(html, /무인 진행<\/dt><dd>예/);
  assert.match(html, /계정: 없음 · 대량 기입: 아니오/);
  assert.match(html, /공유 환경<\/dt><dd>단독/);
});
