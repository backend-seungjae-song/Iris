import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { renderQaActionReport } from "../server/qa-action-report.js";
import { createQaSummary } from "../server/qa-summary.js";
import { checkQaReport } from "../server/qa-report.js";
import { deriveQaRows } from "../server/qa-rows.js";
import { qaRiskResults } from "../server/qa-list-review.js";
import { createQaChannel } from "../server/qa-channel.js";
import { recordReactionJudgments } from "../server/qa-catalog.js";
import { qaCharter, qaPlan, qaRowContract, qaSession } from "./qa-fixtures.mjs";
import { sliceBetween } from "../bin/slice-anchor.mjs";

const tempRoot = fs.realpathSync(os.tmpdir());
fs.mkdirSync(tempRoot, { recursive: true });
const folder = fs.mkdtempSync(path.join(tempRoot, "report7-"));
test.after(() => fs.rmSync(folder, { recursive: true, force: true }));
const shot = path.join(folder, "shot.png");
fs.writeFileSync(shot, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz8AAAAASUVORK5CYII=", "base64"));
const url = "http://localhost:4321/start";
const oracle = "기능의 용도";
const expectation = { effects: [{ id: "saved", type: "appear", text: "저장됨", oracle }], within: 50 };
const rowSection = (html, id) => {
  const start = html.indexOf(`data-row-id="${id}"`);
  assert.ok(start >= 0, `${id} 확인 항목이 있어야 한다`);
  const next = html.indexOf('data-row-id="', start + 1);
  return html.slice(start, next < 0 ? html.indexOf("테스트와 별개로 본 것", start) : next);
};
const hasPhoto = (html, seq) => assert.match(html, new RegExp(`(?:id="qa-scene-${seq}"|href="#qa-scene-${seq}")`));

function evidence() {
  const events = [];
  const add = event => { const record = { seq: events.length + 1, event }; events.push(record); return record.seq; };
  const risks = [
    ["saved", "test"], ["failed", "test"], ["blocked", "investigate"], ["accepted", "accept"], ["delegated", "delegate"],
  ].map(([id, decision]) => ({ id, risk: `${id} 위험`, size: "mid", knowledge: "some", decision, ...(decision === "test" ? {} : { reason: `${id} 결정 이유` }) }));
  add({ kind: "run_begin", session: "owner", charter: qaCharter(), plan: qaPlan({ entries: [url], risks }) });
  for (const id of ["saved", "failed", "blocked"]) add({ kind: "row", action: "declare", rowId: id, rowData: { ...qaRowContract(), id, what: `${id} 결과`, given: `${id} 화면`, basis: "spec", basisNote: "고정 저장 명세", paths: ["정상"], risk: [id] } });
  const lane = id => ({ rowId: id, path: "정상", surface: "browser", url });
  const scenes = {};
  for (const phase of ["나타남", "처리", "사라짐"]) scenes[phase] = add({ kind: "frame", cmd: "obstacle_scene", ...lane("saved"), shot, claim: { kind: "S6", description: `방해 화면 ${phase}` }, detail: { phase, blocker: { sel: "#overlay", text: "도움말" } } });
  add({ kind: "catalog_begin", detail: { catalog: { items: [{ key: "known-overlay", class: "방해 화면", source: "web/overlay.js:2", cause: "도움말 안내 표시", condition: { sel: "#overlay" } }] } } });
  add({ kind: "obstacle_seen", ...lane("saved"), detail: { id: "known-overlay", catalogKey: "known-overlay", catalogClass: "방해 화면", sel: "#overlay", text: "도움말", sceneSeq: scenes["나타남"], known: true, count: 2 } });
  add({ kind: "observation", cmd: "snapshot", ...lane("saved"), pass: true });
  const accepted = add({ kind: "accepted", cmd: "click", ...lane("saved"), expected: expectation });
  add({ kind: "frame", ...lane("saved"), shot, acceptedSeq: accepted, claim: { kind: "S1", description: "저장 버튼 클릭" } });
  add({ kind: "action", cmd: "click", ...lane("saved"), acceptedSeq: accepted, pass: true });
  const effect = add({ kind: "frame", ...lane("saved"), shot, acceptedSeq: accepted, claim: { kind: "S2", effectId: "saved", description: "저장됨 표시" } });
  const candidate = add({ kind: "frame", ...lane("saved"), shot, acceptedSeq: accepted, claim: { kind: "S4", candidateId: "tooltip", description: "도움말" } });
  add({ kind: "reaction", ...lane("saved"), acceptedSeq: accepted, pass: true, detail: { pass: true, effects: [{ ...expectation.effects[0], observed: true, sceneSeq: effect }], unexpected: [{ id: "tooltip", text: "도움말", sel: "#help", description: "툴팁 단서", sceneSeq: candidate }] } });
  add({ kind: "unexpected", detail: { id: "tooltip", class: "무관 반응", source: "web/app.js:2", cause: "도움말 타이머", condition: { sel: "#help" } } });
  add({ kind: "observation", cmd: "observe", ...lane("saved"), pass: true });
  add({ kind: "assertion", ...lane("failed"), shot, pass: false, observed: "저장 안 됨" });
  scenes.unknown = add({ kind: "frame", cmd: "obstacle_scene", ...lane("blocked"), shot, claim: { kind: "S6", description: "방해 화면 나타남" }, detail: { phase: "나타남", blocker: { sel: "#unknown", text: "권한 안내" } } });
  add({ kind: "unknown_occlusion", ...lane("blocked"), detail: { id: "unknown", sel: "#unknown", text: "권한 안내", sceneSeq: scenes.unknown, reason: "막힘: 모르는 가림" } });
  add({ kind: "unexpected", detail: { id: "unknown", class: "방해 화면", source: "web/permission.js:3", cause: "권한 안내가 저장 버튼을 가림", condition: { sel: "#unknown" } } });
  add({ kind: "play_step", ...lane("blocked"), detail: { index: 0, status: "막힘", reason: "모르는 가림" } });
  add({ kind: "play_step", ...lane("blocked"), detail: { index: 1, status: "미실행", reason: "앞 단계 실패" } });
  for (const [id, color] of [["saved", "green"], ["failed", "red"], ["blocked", "gray"]]) add({ kind: "row", action: "close", ...lane(id), rowData: { color, note: `${id} 결과`, sceneJudgment: `${id} 화면 전체 확인` } });
  scenes.background = add({ kind: "frame", shot, claim: { kind: "S4", description: "시계 갱신" } });
  add({ kind: "background_reaction", detail: { items: [{ id: "clock", text: "시계", clue: "1초 주기", sceneSeq: scenes.background }] } });
  add({ kind: "unexpected", detail: { id: "clock", class: "배경 반응", source: "web/clock.js:4", cause: "시계 갱신 타이머", condition: { sel: "#clock" } } });
  add({ kind: "list_review", detail: { inventory: { fingerprint: "inventory-v1" }, review: { information: [{ row: "saved", text: "저장 여부를 확인한다" }], duplicates: [], distribution: "저장·실패·막힘 위험 확인", missingRisks: "외부 알림은 위임" } } });
  add({ kind: "catalog_update", detail: { item: { key: "clock", cause: "시계 갱신 타이머", count: 2 }, previous: { key: "clock", cause: "이전 시계 타이머", count: 1 } } });
  add({ kind: "run_end", sessionRecord: { ...qaSession(), defects: "없음" } });
  return { events, scenes, candidate };
}

test("실제 이벤트 형식의 항목별 방해 화면·반응 사진·단서·판단을 표시한다", () => {
  const { events, scenes, candidate } = evidence();
  const html = renderQaActionReport(events, folder);
  const saved = rowSection(html, "saved"), blocked = rowSection(html, "blocked");
  for (const phase of ["나타남", "처리", "사라짐"]) { assert.match(saved, new RegExp(`방해 화면 ${phase}`)); hasPhoto(saved, scenes[phase]); }
  for (const text of ["등록 방해 화면", "web/overlay.js:2", "도움말 안내 표시", "툴팁 단서", "무관 반응", "web/app.js:2", "도움말 타이머"]) assert.ok(saved.includes(text));
  hasPhoto(saved, candidate);
  for (const text of ["모르는 가림", "권한 안내", "web/permission.js:3", "권한 안내가 저장 버튼을 가림"]) assert.ok(blocked.includes(text));
  hasPhoto(blocked, scenes.unknown);
  assert.match(blocked, /blocked 화면 전체 확인/);
  assert.match(rowSection(html, "failed"), /저장 안 됨/);
  assert.ok(!saved.includes("권한 안내"));
  assert.ok(!saved.includes("저장 안 됨"));
  const background = sliceBetween(html, "테스트와 별개로 본 것", "</ul></section>", "배경 반응");
  for (const text of ["시계", "1초 주기", "배경 반응", "web/clock.js:4", "시계 갱신 타이머"]) assert.ok(background.includes(text));
  hasPhoto(background, scenes.background);
  assert.match(html, /미실행/);
  assert.match(html, /목록 검토/);
  assert.match(html, /이전 시계 타이머/);
  assert.doesNotMatch(html, /통과율|완료율|pass ratio/);
});

test("카탈로그로 이미 판단한 반응도 판정 근거를 표시한다", () => {
  const { events } = evidence();
  const reaction = events.find(record => record.event.kind === "reaction").event.detail;
  reaction.unexpected[0].catalogKey = "known-help";
  reaction.unexpected[0].known = true;
  const withoutJudgment = events.filter(record => !(record.event.kind === "unexpected" && record.event.detail.id === "tooltip"));
  withoutJudgment.find(record => record.event.kind === "catalog_begin").event.detail.catalog.items.push({ key: "known-help", class: "무관 반응", source: "web/help.js:8", cause: "알려진 도움말", condition: { sel: "#help" } });
  const html = rowSection(renderQaActionReport(withoutJudgment, folder), "saved");
  assert.match(html, /web\/help.js:8/);
  assert.match(html, /알려진 도움말/);
  reaction.unexpected[0].needsReview = true;
  reaction.unexpected[0].known = false;
  assert.match(rowSection(renderQaActionReport(withoutJudgment, folder), "saved"), /tooltip[^<]*판단 안 됨/);
});

test("summary는 위험별 결과와 목록 검토·카탈로그 변경 전후를 보존한다", async () => {
  const { events } = evidence();
  assert.doesNotThrow(() => checkQaReport(events));
  const ledger = { verify: async () => ({ events }), paths: () => ({ folder }) };
  const result = await createQaSummary(ledger, ["run-report7"], { session: "owner" });
  assert.deepEqual(result.summary.riskResults.map(item => [item.id, item.result]), [["saved", "확인됨"], ["failed", "실패"], ["blocked", "막힘"], ["accepted", "수용"], ["delegated", "위임"]]);
  assert.equal(result.summary.passed.length, 1);
  assert.equal(result.summary.catalogUpdates[0].previous.count, 1);
  assert.equal(result.summary.catalogUpdates[0].item.count, 2);
  assert.equal(result.summary.listReviews[0].inventory.fingerprint, "inventory-v1");
  const html = fs.readFileSync(result.path, "utf8");
  for (const text of ["위험별 완료 근거", "목록 검토", "반응 목록 변경", "이전 시계 타이머"]) assert.ok(html.includes(text));
  assert.doesNotMatch(html.match(/위험별 완료 근거[\s\S]*?<\/section>/)[0], /·\s*·/);
  assert.doesNotMatch(html, /통과율|완료율|pass ratio/);
});

test("미실행 단계만 있는 항목은 위험 확인이나 통과 근거가 되지 않는다", () => {
  const { events } = evidence();
  const withoutVerdicts = events.filter(record => !["assertion", "reaction", "action", "accepted"].includes(record.event.kind));
  withoutVerdicts.push({ seq: 999, event: { kind: "play_step", rowId: "saved", path: "정상", detail: { status: "미실행" } } });
  assert.notEqual(qaRiskResults(withoutVerdicts, deriveQaRows(withoutVerdicts).rows).find(item => item.id === "saved").result, "확인됨");
  assert.throws(() => checkQaReport(withoutVerdicts), /P1/);
});

for (const mode of ["unknown", "known", "missing"]) test(`채널이 기록한 ${mode} 장면을 보고서에 연결한다`, async () => {
  const known = mode === "known";
  const state = fs.mkdtempSync(path.join(folder, "channel-"));
  process.env.IRIS_STATE_DIR = state;
  const events = [];
  const append = async (_id, event) => { const r = { seq: events.length + 1, event: structuredClone(event) }; events.push(r); return r; };
  const ledger = { append, begin: args => append(args.runId, { kind: "run_begin", ...args }), verify: async () => ({ events }), end: (id, args) => append(id, { kind: "run_end", sessionRecord: { ...args.session, defects: "없음" } }) };
  const target = { role: "button", name: "저장" };
  if (known) recordReactionJudgments(process.cwd(), [{ class: "방해 화면", source: "server/qa-play.js:1", cause: "도움말 안내", condition: { sel: "#overlay" }, handler: { method: "click", target: { role: "button", name: "닫기" }, expect: { effects: [{ type: "disappear", text: "도움말", oracle }] } } }], { runId: "prior", seq: 1, runSeq: 1 });
  let occluded = true, serial = 0;
  const call = createQaChannel({ ledger, createEntry: async () => ({ ok: true, data: { tabId: "tab" } }), release: async () => {}, makeRoutes: () => ({ list: async () => [] }), execute: async (_tab, cmd, args) => {
    let data = { path: shot, shot, url, pass: true, trusted: true };
    if (cmd === "qa-background-observe" || cmd === "qa-reaction-drain") data = {};
    if (cmd === "qa-target-resolve") data = { found: mode !== "missing", x: 1, y: 1, occluded: args.target.name === "저장" && occluded, blocker: { sel: "#overlay", text: "도움말" } };
    if (cmd === "qa-input") occluded = false;
    if (cmd === "qa-reaction-start") data = { id: `r${++serial}`, scenes: [{ id: "s1", path: shot, claim: { kind: "S1", description: "클릭 전" } }] };
    if (cmd === "qa-reaction-end") data = { pass: true, effects: [], scenes: [{ id: "s2", path: shot, claim: { kind: "S2", description: "클릭 후" } }] };
    return { ok: true, data };
  } });
  const begin = await call("run_begin", { plan: qaPlan({ entries: [url] }), charter: qaCharter() }, "owner");
  assert.equal(begin.ok, true, begin.error);
  const send = (cmd, args = {}) => call(cmd, args, "owner", begin.data.runId);
  assert.equal((await send("open_entry", { url })).ok, true);
  const declaration = { action: "declare", ...qaRowContract(), id: "r1", what: "저장 결과", given: "저장 화면", basis: "spec", basisNote: "저장 명세", paths: ["정상"] };
  assert.equal((await send("row", declaration)).ok, true);
  await send("row", { action: "open", row: "r1", path: "정상" });
  await send("list_review", { review: { information: [{ row: "r1", text: "저장 결과 확인" }], duplicates: [], distribution: "저장 결과 조사", missingRisks: "없음" } });
  const played = await send("play", { steps: [{ action: "click", target, expect: expectation }] });
  assert.equal(played.ok, true, played.error);
  if (mode === "missing") {
    assert.equal(played.data.pass, false);
    const failure = events.find(record => record.event.kind === "assertion" && record.event.pass === false);
    assert.ok(failure?.event.shot);
    assert.equal(events.findLast(record => record.event.action === "close").event.rowData.color, "red");
    assert.equal((await send("run_end", { session: qaSession() })).ok, true);
    assert.doesNotThrow(() => checkQaReport(events));
    assert.equal(qaRiskResults(events, deriveQaRows(events).rows)[0].result, "실패");
    assert.match(rowSection(renderQaActionReport(events, folder), "r1"), /실패/);
    return;
  }
  const obstacle = events.filter(record => record.event.cmd === "obstacle_scene");
  assert.deepEqual(obstacle.map(record => record.event.detail.phase), known ? ["나타남", "처리", "사라짐"] : ["나타남"]);
  if (!known) {
    const unknown = events.find(record => record.event.kind === "unknown_occlusion").event.detail;
    const judged = await send("unexpected", { id: unknown.id, class: "무관 반응", source: "server/qa-play.js:1", cause: "시험용 안내가 버튼을 가렸다", condition: { sel: "#overlay" } });
    assert.equal(judged.ok, true, judged.error);
  }
  const html = rowSection(renderQaActionReport(events, folder), "r1");
  for (const record of obstacle) { assert.ok(html.includes(`방해 화면 ${record.event.detail.phase}`)); hasPhoto(html, record.seq); }
  if (!known) assert.match(html, /시험용 안내가 버튼을 가렸다/);
  else { assert.match(html, /등록 방해 화면/); assert.match(html, /도움말 안내/); }
});
