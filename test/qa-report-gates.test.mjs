import { qaPlan, qaRowContract } from "./qa-fixtures.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { checkQaReport, legacyQaEvents } from "../server/qa-report.js";
import { deriveQaRows } from "../server/qa-rows.js";
import { validateQaCommand } from "../server/qa-protocol.js";

const charter = {
  question: "사용자가 저장 결과를 확인할 수 있는가", scope: "저장 화면", exclusions: "없음",
  environment: "격리한 로컬 데이터", sharedEnvironment: false, timebox: "10분", people: "없음", documents: "저장 명세",
};
const sessionRecord = {
  work: "저장 확인", defects: "없음", curios: "없음", checked: "결과 표시", unverified: { items: "없음", reason: "해당 없음" },
  blockers: "없음", outOfScope: "없음", risks: "없음", stopCriterion: "questions_answered", remainingQuestions: "없음",
};
const lane = { rowId: "save", path: "정상", lanes: [["save", "정상"]] };

// 서버 장부의 순번과 event 필드로 구성한다. 기존 MCP 보고서의 평면 기록은 사용하지 않는다.
function complete() {
  return [
    { kind: "run_begin", charter, plan: qaPlan({ entries: ["http://localhost:4321/start"] }) },
    { kind: "row", action: "declare", rowId: "save", rowData: { ...qaRowContract(), id: "save", what: "저장 결과 표시", given: "저장 화면을 연 사용자", basis: "spec", basisNote: "저장 명세", paths: ["정상"] } },
    { kind: "entry", url: "http://localhost:4321/start" },
    { kind: "row", action: "open", ...lane, rowData: {} },
    { kind: "observation", cmd: "snapshot", ...lane, pass: true },
    { kind: "accepted", cmd: "click", ...lane, expected: { effects: [{ type: "appear", text: "Saved", oracle: "명세나 대화에서 정한 내용", id: "e1" }], within: 1200 } },
    { kind: "frame", claim: { kind: "S1" }, ...lane, acceptedSeq: 6, shot: "shots/before.png" },
    { kind: "action", cmd: "click", ...lane, acceptedSeq: 6, pass: true, trusted: true,
      target: { role: "button", name: "Save" }, received: [{ type: "click", trusted: true, role: "button", name: "Save" }] },
    { kind: "frame", claim: { kind: "S2" }, ...lane, acceptedSeq: 6, shot: "shots/after.png" },
    { kind: "observation", cmd: "observe", ...lane, pass: true, shot: "shots/observed.png" },
    { kind: "assertion", ...lane, pass: true, expected: { mode: "contains", text: "Saved" }, shot: "shots/assertion.png", url: "http://localhost:4321/start" },
    { kind: "row", action: "close", sceneJudgment: "기대 결과와 화면 전체의 상태를 확인했고 추가 이상은 보이지 않았다.", ...lane, rowData: { color: "green", sceneJudgment: "화면 전체에 추가 이상이 보이지 않았다.", note: "저장 결과 표시", frames: 4, receipts: 1, failed: 0 } },
    { kind: "run_end", sessionRecord },
    // 반응 기록은 조작 번호로 찾으므로 끝에 두어 다른 기록의 순번을 유지
    { kind: "reaction", cmd: "click", ...lane, acceptedSeq: 6 },
  ].map((event, index) => ({ seq: index + 1, event: structuredClone(event) }));
}
const event = (events, kind, more = () => true) => events.find(record => record.event.kind === kind && more(record.event)).event;
const declaration = events => event(events, "row", item => item.action === "declare").rowData;
const close = events => event(events, "row", item => item.action === "close").rowData;
function insertBeforeClose(events, inserted) {
  const index = events.findIndex(record => record.event.kind === "row" && record.event.action === "close");
  events.splice(index, 0, { seq: index + 1, event: structuredClone(inserted) });
  for (let i = index + 1; i < events.length; i++) events[i].seq = i + 1;
}
function reject(code, change) {
  const events = complete();
  change(events);
  assert.throws(() => checkQaReport(events), error => error.message.startsWith(`[${code}]`));
}

test("complete verified-record projection satisfies every report gate", () => {
  const events = complete();
  const checked = checkQaReport(events);
  assert.equal(checked.state.rows[0].state, "closed");
  assert.deepEqual(checked.state.gaps, []);
  assert.equal(checked.state.rows[0].walked.정상.receipts, 1);
  assert.equal(checked.state.rows[0].walked.정상.frames, 4);
  assert.deepEqual(checked.begin.charter, charter);
  assert.deepEqual(checked.end.sessionRecord, sessionRecord);
});

test("S0 rejects action before a successful screen observation", () => {
  reject("S0", events => { event(events, "observation", item => item.cmd === "snapshot").cmd = "url"; });
  reject("S0", events => { event(events, "observation", item => item.cmd === "snapshot").pass = false; });
});
test("L rejects action without a successful following observation", () => {
  reject("L", events => { event(events, "observation", item => item.cmd === "observe").cmd = "url"; });
  reject("L", events => { event(events, "observation", item => item.cmd === "observe").pass = false; });
});
test("S1 rejects an assertion lacking its scene", () => {
  reject("S1", events => { delete event(events, "assertion").shot; });
});
test("S2 rejects an assertion outside every row", () => {
  reject("S2", events => { const item = event(events, "assertion"); delete item.rowId; delete item.path; delete item.lanes; });
  reject("S2", events => { event(events, "assertion").url = "https://outside.test/result"; });
  reject("S2", events => { delete event(events, "assertion").url; });
});
test("P2 rejects an assertion outside declared paths", () => {
  reject("P2", events => { const item = event(events, "assertion"); item.path = "경계"; item.lanes = [["save", "경계"]]; });
});
test("P3 rejects missing or mismatched expectation and result scenes of an expect-required action", () => {
  for (const kind of ["S1", "S2"]) {
    reject("P3", events => { delete event(events, "frame", item => item.claim?.kind === kind).shot; });
    reject("P3", events => { event(events, "frame", item => item.claim?.kind === kind).acceptedSeq = 999; });
  }
  reject("reaction", events => { event(events, "reaction").acceptedSeq = 999; });
  reject("P3", events => { delete event(events, "accepted", item => item.cmd === "click").expected; });
});
test("P3 needs no scenes for a preparation action without an expectation", () => {
  const events = complete();
  const index = events.findIndex(record => record.event.kind === "accepted");
  for (const record of events) if (record.event.acceptedSeq === 6) record.event.acceptedSeq = 9;
  events.splice(index, 0, { seq: 0, event: { kind: "accepted", cmd: "viewport", ...lane } }, { seq: 0, event: { kind: "action", cmd: "viewport", ...lane, acceptedSeq: index + 1, pass: true } },
    { seq: 0, event: { kind: "observation", cmd: "snapshot", ...lane, pass: true } });
  events.forEach((record, i) => { record.seq = i + 1; });
  assert.doesNotThrow(() => checkQaReport(events));
});
test("P1 rejects a colored path with no valid assertion", () => {
  reject("P1", events => { event(events, "assertion").kind = "observation"; });
  reject("P1", events => insertBeforeClose(events, { kind: "row", action: "void", rowData: { receipt: "11", why: "다른 화면의 판정" } }));
});
test("P1c rejects green when a valid failed assertion remains", () => {
  reject("P1c", events => { event(events, "assertion").pass = false; });
});
test("P1d rejects red without a valid failed assertion", () => {
  reject("P1d", events => { close(events).color = "red"; });
});
test("P1d accepts red backed by a noFailure defect on the same path", () => {
  const events = complete();
  close(events).color = "red";
  insertBeforeClose(events, { kind: "defect", mode: "agent_action", rowId: "save", path: "경계", detail: { noFailure: true, problem: "저장 뒤 다른 값 표시" } });
  assert.throws(() => checkQaReport(events), /\[P1d\]/);
  event(events, "defect").path = "정상";
  assert.doesNotThrow(() => checkQaReport(events));
  delete event(events, "defect").detail.noFailure;
  assert.throws(() => checkQaReport(events), /\[P1d\]/);
});
test("D1 requires an original assertion and reason for every void", () => {
  reject("D1", events => insertBeforeClose(events, { kind: "row", action: "void", rowData: { receipt: "999", why: "다른 화면의 판정" } }));
  reject("D1", events => insertBeforeClose(events, { kind: "row", action: "void", rowData: { receipt: "11", why: " " } }));
  reject("D1", events => insertBeforeClose(events, { kind: "row", action: "void", rowData: { receipt: "6", why: "판정이 없는 조작" } }));
});
test("valid void preserves its original record and is excluded from row evidence", () => {
  const events = complete();
  event(events, "assertion").pass = false;
  close(events).color = "gray";
  insertBeforeClose(events, { kind: "row", action: "void", rowData: { receipt: "11", why: "다른 화면의 판정" } });
  const checked = checkQaReport(events);
  assert.equal(events.find(record => record.seq === 11).event.pass, false);
  assert.equal(checked.state.rows[0].walked.정상.receipts, 0);
  assert.equal(checked.state.rows[0].walked.정상.failed, 0);
});
test("LR0 requires a declared confirmation row", () => {
  reject("LR0", events => { for (const record of events) if (record.event.kind === "row") record.event.kind = "observation"; });
});
test("LR1 rejects open and declared-but-unclosed paths using projection gaps", () => {
  reject("LR1", events => { event(events, "row", item => item.action === "close").action = "note"; });
  reject("LR1", events => { declaration(events).paths.push("경계"); });
  const events = complete();
  declaration(events).paths.push("경계");
  assert.deepEqual(deriveQaRows(events).gaps, [{ rowId: "save", path: "경계" }]);
});
test("LR1 rejects source-list items absent from covers and accepts complete coverage", () => {
  const list = { kind: "row", action: "list", rowData: { name: "기능 목록", items: [{ id: "save-result", text: "저장 결과 표시" }] } };
  reject("LR1", events => insertBeforeClose(events, list));
  const events = complete();
  declaration(events).covers = ["save-result"];
  insertBeforeClose(events, list);
  assert.equal(checkQaReport(events).state.coverage[0].missing.length, 0);
});
test("basis requires a source and a nonempty note", () => {
  reject("basis", events => { delete declaration(events).basis; });
  reject("basis", events => { delete declaration(events).basisNote; });
  reject("basis", events => { declaration(events).basisNote = " "; });
});
test("charter and session records remain required for report publication", () => {
  reject("session", events => { event(events, "run_begin").kind = "entry"; });
  reject("session", events => { event(events, "run_end").kind = "observation"; });
  const events = complete();
  delete event(events, "run_end").sessionRecord.risks;
  assert.throws(() => checkQaReport(events), /sessionRecord.risks/);
});
test("browser and mobile observations satisfy the same screen gates", () => {
  const events = complete();
  event(events, "observation", item => item.cmd === "snapshot").cmd = "app_snapshot";
  event(events, "observation", item => item.cmd === "observe").cmd = "app_observe";
  for (const record of events) record.event.surface = "mobile";
  assert.doesNotThrow(() => checkQaReport(events));
});
test("S0 and L require observation of the action's own surface", () => {
  reject("S0", events => { event(events, "observation", item => item.cmd === "snapshot").surface = "mobile"; });
  reject("L", events => { event(events, "observation", item => item.cmd === "observe").surface = "mobile"; });
});
test("execution rejects an accepted request without a completion record", () => {
  reject("execution", events => insertBeforeClose(events, { kind: "accepted", cmd: "click", ...lane }));
  reject("execution", events => { event(events, "action").pass = false; });
});
test("판정 없이 막힌 조작은 조작 seq 를 무효로 하면 green 경로의 실패 조작에서 빠진다", () => {
  const events = complete();
  event(events, "action").pass = false;
  assert.throws(() => checkQaReport(events), error => error.message.startsWith("[execution]"));
  insertBeforeClose(events, { kind: "row", action: "void", rowData: { receipt: "8", why: "조작이 앱에 전달되지 않음" } });
  assert.doesNotThrow(() => checkQaReport(events));
});
test("A2 rejects green if all valid assertions precede the last action", () => {
  reject("A2", events => {
    const [assertion] = events.splice(10, 1);
    events.splice(5, 0, assertion);
    for (let i = 0; i < events.length; i++) {
      events[i].seq = i + 1;
      if (events[i].event.acceptedSeq === 6) events[i].event.acceptedSeq = 7;
    }
  });
});
test("a valid void can exclude a failed assertion whose screenshot is missing", () => {
  const events = complete();
  const assertion = event(events, "assertion");
  assertion.pass = false; delete assertion.shot;
  close(events).color = "gray";
  insertBeforeClose(events, { kind: "row", action: "void", rowData: { receipt: "11", why: "스크린샷 저장 실패" } });
  assert.doesNotThrow(() => checkQaReport(events));
});
test("LR2 excludes all aside scenes even when an assertion remains valid", () => {
  reject("LR2", events => insertBeforeClose(events, { kind: "row", action: "aside", ...lane,
    rowData: { frames: ["shots/before.png", "shots/after.png", "shots/observed.png", "shots/assertion.png"], why: "다른 항목의 화면" } }));
});
function derived() {
  const events = complete();
  declaration(events).derivation = { source: "표시값 명세" };
  event(events, "assertion").observed = "Result A";
  insertBeforeClose(events, { kind: "assertion", ...lane, pass: true, observed: "Result B", shot: "shots/result-b.png", url: "http://localhost:4321/start" });
  insertBeforeClose(events, { kind: "row", action: "derivation", rowId: "save", rowData: { derivation: { source: "표시값 명세", instances: [
    { input: "A", source_value: "Result A", observed: "Result A", evidence: "11" },
    { input: "B", source_value: "Result B", observed: "Result B", evidence: "12" },
  ] } } });
  return events;
}
test("manifest D rechecks native assertion values before report publication", () => {
  assert.doesNotThrow(() => checkQaReport(derived()));
  for (const change of [
    events => { event(events, "row", item => item.action === "derivation").rowData.derivation.instances.pop(); },
    events => { event(events, "row", item => item.action === "derivation").rowData.derivation.instances[0].observed = "invented"; },
    events => { event(events, "row", item => item.action === "derivation").rowData.derivation.instances[1].evidence = "11"; },
  ]) {
    const events = derived(); change(events);
    assert.throws(() => checkQaReport(events), /\[manifest D\]/);
  }
});
test("manifest D requires a single-valued limitation in session unverified notes", () => {
  const events = derived();
  event(events, "assertion", item => item.observed === "Result B").observed = "Result A";
  const derivation = event(events, "row", item => item.action === "derivation").rowData.derivation;
  derivation.instances[1].observed = "Result A";
  derivation.limitation = "두 입력이 같은 표시값";
  assert.throws(() => checkQaReport(events), /\[manifest D\]/);
  event(events, "run_end").sessionRecord.unverified = { items: derivation.limitation, reason: "표시값 차이 미확인" };
  assert.doesNotThrow(() => checkQaReport(events));
});
test("P1b has no caller-supplied receipt or verdict path into review or expect", () => {
  for (const args of [{ receipt: "foreign-run:11" }, { steps: [{ receipt: "11", verdict: "pass" }] }, { serverEvents: [] }])
    assert.throws(() => validateQaCommand("report", args), /허용되지 않은 인자/);
  for (const extra of [{ receipt: "11" }, { pass: true }, { shot: "invented.png" }])
    assert.throws(() => validateQaCommand("expect", { mode: "exists", sel: "button", ...extra }), /허용되지 않은 인자/);
});
test("D2 cannot count a voided assertion as a colored result's evidence", () => {
  reject("P1", events => insertBeforeClose(events, { kind: "row", action: "void", rowData: { receipt: "11", why: "다른 화면의 판정" } }));
});
test("legacy report projection retains row, path, lane and absolute scene identity", () => {
  const events = complete();
  const projected = legacyQaEvents(events, "/qa/run");
  const assertion = projected.find(item => item.kind === "assertion");
  assert.deepEqual({ row: assertion.row, path: assertion.path_, lanes: assertion.lanes, id: assertion.id, shot: assertion.shot },
    { row: "save", path: "정상", lanes: [["save", "정상"]], id: "11", shot: "/qa/run/shots/assertion.png" });
  assert.equal(projected.find(item => item.kind === "row" && item.act === "close").path, "정상");
});

test("a linked failure scene resolves the failed assertion without modifying its original record", () => {
  const events = complete(), assertion = event(events,"assertion");
  assertion.pass = false; delete assertion.shot; delete assertion.url;
  close(events).color = "red";
  insertBeforeClose(events,{kind:"failure",...lane,shot:"shots/failure.png",url:"http://localhost:4321/start",detail:{failureSeq:11,console:[],network:[],exceptions:[]}});
  assert.doesNotThrow(()=>checkQaReport(events));
  assert.equal(assertion.shot,undefined);
  assert.equal(legacyQaEvents(events,"/qa/run").find(item=>item.kind === "assertion").shot,"/qa/run/shots/failure.png");
});

test("a capture failure can remain explicitly unverified but cannot become a colored result", () => {
  const events = complete(), assertion = event(events,"assertion");
  assertion.pass = false; delete assertion.shot; delete assertion.url;
  close(events).color = "gray";
  insertBeforeClose(events,{kind:"failure",...lane,detail:{failureSeq:11,captureError:"capture unavailable",console:[],network:[],exceptions:[]}});
  assert.doesNotThrow(()=>checkQaReport(events));
  close(events).color = "red";
  assert.throws(()=>checkQaReport(events),/\[S1\]/);
});

function reactionOnly(pass = true) {
  const events = complete().filter(r => !["assertion", "reaction"].includes(r.event.kind));
  const frame = event(events, "frame", e => e.claim.kind === "S2");
  frame.claim.kind = pass ? "S2" : "S3";
  frame.url = "http://localhost:4321/start";
  const action = event(events, "action");
  action.expected = event(events, "accepted").expected;
  const frameIndex = events.findIndex(r => r.event === frame);
  const [scene] = events.splice(frameIndex, 1);
  events.splice(events.findIndex(r => r.event === action), 0, scene);
  const index = events.findIndex(r => r.event === action) + 1;
  events.splice(index, 0, { event: { kind: "reaction", ...lane, acceptedSeq: 6, pass,
    expected: action.expected, detail: { pass, effects: [{ ...action.expected.effects[0], observed: pass }],
      candidates: pass ? [] : [{ id: "c1", code: "K1" }] } } });
  close(events).color = pass ? "green" : "red";
  events.forEach((r, i) => { r.seq = i + 1; });
  if (!pass) {
    events.push({ seq: events.length + 1, event: { kind: "unexpected", detail: { id: "c1", class: "문제", source: "server/qa-reaction.js:1", cause: "선언한 기대 효과 미관찰", condition: { code: "K1" } } } });
    const defectSeq = events.length + 1;
    events.push({ seq: defectSeq, event: { kind: "defect", detail: { problem: "선언한 기대 효과 미관찰" } } });
    events.push({ seq: events.length + 1, event: { kind: "unexpected_defect", detail: { id: "c1", defectSeq } } });
  }
  return events;
}

test("reaction 판정만으로 통과와 K1 실패를 검사하고 보고서 판정으로 변환", () => {
  for (const pass of [true, false]) {
    const events = reactionOnly(pass);
    assert.doesNotThrow(() => checkQaReport(events));
    const projected = legacyQaEvents(events, "/qa/run").find(e => e.kind === "assertion");
    assert.equal(projected.pass, pass);
    assert.equal(projected.shot, "/qa/run/shots/after.png");
    assert.equal(projected.url, "http://localhost:4321/start");
    assert.equal(event(events, "reaction").shot, undefined);
  }
});

test("reaction 색 판정과 장면·항목·화면 연결을 검사", () => {
  for (const [code, change] of [
    ["P1c", events => { close(events).color = "green"; }],
    ["S1", events => { event(events, "frame", e => e.claim.kind === "S3").claim.kind = "S2"; }],
    ["S2", events => { event(events, "frame", e => e.claim.kind === "S3").url = "https://outside.test"; }],
    ["P2", events => { const e = event(events, "reaction"); e.path = "없는 경로"; e.lanes = []; }],
  ]) {
    const events = reactionOnly(false);
    change(events);
    assert.throws(() => checkQaReport(events), error => error.message.startsWith(`[${code}]`));
  }
  const events = reactionOnly();
  close(events).color = "red";
  assert.throws(() => checkQaReport(events), /\[P1d\]/);
});

test("D2 무효 처리한 reaction은 색 판정 근거에서 제외", () => {
  const events = reactionOnly();
  const receipt = String(events.find(r => r.event.kind === "reaction").seq);
  insertBeforeClose(events, { kind: "row", action: "void", rowData: { receipt, why: "다른 화면의 기대" } });
  assert.throws(() => checkQaReport(events), /\[P1\]/);
  close(events).color = "gray";
  assert.doesNotThrow(() => checkQaReport(events));
});

test("A2 마지막 조작보다 앞선 reaction만으로 통과 불가", () => {
  const events = reactionOnly();
  const index = events.findIndex(r => r.event.kind === "reaction");
  const [reaction] = events.splice(index, 1);
  events.splice(events.findIndex(r => r.event.kind === "action"), 0, reaction);
  events.forEach((r, i) => { r.seq = i + 1; });
  assert.throws(() => checkQaReport(events), /\[A2\]/);
});
