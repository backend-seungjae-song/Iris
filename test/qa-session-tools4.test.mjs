import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createQaLedger } from "../server/qa-ledger.js";
import { applyQaRow, deriveQaRows } from "../server/qa-rows.js";
import { deriveQaDefect, recordQaSession } from "../server/qa-session.js";
import { QA_ORACLES, validateQaDefect } from "../server/qa-session-contract.js";
import { validateQaCommand } from "../server/qa-protocol.js";
import { qaCharter, qaSession, qaPlan, qaRowContract } from "./qa-fixtures.mjs";

const require = createRequire(import.meta.url);
const { createQaLedgerAnchor } = require("../native/electron/qa-ledger-anchor.cjs");
const taskRoot = path.join(fs.realpathSync(os.tmpdir()), "session-tools4-tests");
const defect = (more = {}) => ({ problem: "저장해도 목록에 표시되지 않는다", oracle: "명세나 대화에서 정한 내용",
  oracleNote: "저장한 주문은 목록에 나타나야 한다", importance: "주문 담당자가 저장 결과를 확인할 수 없다",
  reproducible: "가끔 재현됨", tried: "두 번 저장했다", ...more });
const expected = { mode: "contains", sel: "#orders", text: "주문 1" };
const rec = (seq, event) => ({ seq, event: { mode: "agent_action", ...event } });
const opened = () => [rec(1, { kind: "run_begin", plan: qaPlan(), charter: qaCharter() }),
  rec(2, { kind: "entry", url: "http://localhost:4291", surface: "web", tab: "web" }),
  rec(3, { kind: "row", action: "declare", rowId: "R1", rowData: { ...qaRowContract(), paths: ["정상"], outOfCharter: true } }),
  rec(4, { kind: "row", action: "open", rowId: "R1", path: "정상", rowData: {} })];
const proof = (seq, more = {}) => rec(seq, { kind: "assertion", rowId: "R1", path: "정상", surface: "web",
  expected, pass: false, observed: "주문 없음", shot: `shots/${seq}.png`, ...more });

async function setup(t) {
  fs.mkdirSync(taskRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(taskRoot, "session-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const anchor = createQaLedgerAnchor({ dir: path.join(dir, "native") });
  const ledger = createQaLedger({ dir, anchor });
  await ledger.begin({ runId: "run", session: "s", plan: qaPlan({ entries: ["http://localhost:4291"] }), charter: qaCharter() });
  return { ledger, dir, call: (cmd, args, more = {}) => recordQaSession({ ledger, runId: "run", cmd, args, ...more }) };
}

test("결함·메모·charter 명령은 지정된 객체와 값만 허용한다", () => {
  assert.deepEqual(QA_ORACLES, ["이전 버전", "명세나 대화에서 정한 내용", "같은 제품의 비슷한 기능", "비교할 만한 다른 제품",
    "사용자가 원할 만한 동작", "기능의 용도", "회사가 내세우는 이미지", "법규와 표준", "현실에서 알거나 볼 수 있는 사실", "동작을 설명할 수 없음"]);
  for (const oracle of QA_ORACLES) assert.equal(validateQaCommand("defect", defect({ oracle })).oracle, oracle);
  for (const reproducible of ["재현됨", "가끔 재현됨", "재현 안 됨"]) assert.equal(validateQaDefect(defect({ reproducible })).reproducible, reproducible);
  // reproducible 은 빼면 기록에서 계산
  { const value = defect(); delete value.reproducible; assert.equal(validateQaDefect(value).reproducible, undefined); }
  for (const key of Object.keys(defect()).filter(key => key !== "reproducible")) {
    const value = defect(); delete value[key];
    assert.throws(() => validateQaCommand("defect", value));
    assert.throws(() => validateQaDefect({ ...defect(), [key]: " " }));
  }
  assert.throws(() => validateQaCommand("defect", defect({ oracle: "spec" })));
  assert.throws(() => validateQaCommand("defect", defect({ reproducible: true })));
  assert.throws(() => validateQaCommand("defect", defect({ evidence: "직접 입력한 증거" })));
  for (const invalid of [[defect(), defect()], { defects: [defect(), defect()] }]) {
    assert.throws(() => validateQaCommand("defect", invalid));
    assert.throws(() => validateQaDefect(invalid));
  }
  for (const kind of ["관찰", "아이디어", "막힘", "질문"]) assert.deepEqual(validateQaCommand("note", { kind, text: "메모" }), { kind, text: "메모" });
  assert.throws(() => validateQaCommand("note", { kind: "결함", text: "메모" }));
  assert.throws(() => validateQaCommand("charter", { charter: qaCharter() }));
  assert.throws(() => validateQaCommand("run_end", { session: { ...qaSession(), defects: "없음" } }));
});

test("현재 항목의 실행·입력·실패 장면·관찰·환경을 결함에 보존한다", () => {
  const events = [...opened(), rec(5, { kind: "action", cmd: "type", rowId: "R1", path: "정상", surface: "web", input: { kind: "text", length: 4 }, target: { role: "textbox", name: "주문" }, pass: true }),
    proof(6), rec(7, { kind: "failure", rowId: "R1", path: "정상", surface: "web", shot: "shots/failure.png", shotHash: "hash", detail: { failureSeq: 6, console: ["저장 실패"], network: [{ status: 500 }], exceptions: ["Error"], environment: { url: "http://localhost:4291/orders", viewport: { width: 390, height: 844 }, device: { type: "browser" } } } }), proof(8)];
  const value = deriveQaDefect(events, defect({ reproducible: "재현됨" }));
  assert.equal(value.rowId, "R1"); assert.equal(value.path, "정상"); assert.equal(value.outOfCharter, true);
  assert.deepEqual(value.failureSeqs, [6, 8]); assert.equal(value.failureSeq, 8);
  assert.deepEqual(value.expected, expected); assert.equal(value.actual, "주문 없음");
  assert.deepEqual(value.steps.map(s => s.cmd), ["open_entry", "type"]);
  assert.deepEqual(value.steps[1].input, { kind: "text", length: 4 });
  assert.equal(value.frames[1].shot, "shots/failure.png");
  assert.deepEqual(value.observations[0].detail.network, [{ status: 500 }]);
  assert.deepEqual(value.environment, { url: "http://localhost:4291/orders", viewport: { width: 390, height: 844 }, device: { type: "browser" } });
});

test("재현됨은 다른 항목·화면·기대값·경로의 실패를 합산하지 않는다", () => {
  const other = [{ rowId: "R2" }, { surface: "other" }, { expected: { ...expected, text: "다른 주문" } }, { path: "실패" }, { mode: "route_replay" }];
  for (const value of other) assert.throws(() => deriveQaDefect([...opened(), proof(5, value), proof(6)], defect({ reproducible: "재현됨" })), /두 번/);
  assert.throws(() => deriveQaDefect([...opened(), proof(5, { tries: 10 })], defect({ reproducible: "재현됨" })), /두 번/);
});

test("재시도 통과 뒤에도 반복 실패를 보존하고 무효 판정은 제외한다", () => {
  assert.deepEqual(deriveQaDefect([...opened(), proof(5), proof(6), proof(7, { pass: true })], defect({ reproducible: "재현됨" })).failureSeqs, [5, 6]);
  assert.throws(() => deriveQaDefect([...opened(), proof(5), proof(6), rec(7, { kind: "row", action: "void", rowData: { receipt: "5" } })], defect({ reproducible: "재현됨" })), /두 번/);
  assert.deepEqual(deriveQaDefect([...opened(), proof(5), proof(6, { pass: true }), proof(7)], defect({ reproducible: "재현됨" })).failureSeqs, [5, 7]);
});

test("같은 항목을 다시 열어 재현하면 이전 실패를 세고 실행 단계는 현재 경로를 사용한다", () => {
  const events = [...opened(), proof(5), rec(6, { kind: "row", action: "close", rowId: "R1", path: "정상", rowData: {} }),
    rec(7, { kind: "row", action: "open", rowId: "R1", path: "정상", rowData: {} }), proof(8)];
  const value = deriveQaDefect(events, defect({ reproducible: "재현됨" }));
  assert.deepEqual(value.failureSeqs, [5, 8]); assert.equal(value.startSeq, 7);
});

test("가장 최근 실패가 다른 기대값이면 예전 반복 실패로 재현을 인정하지 않는다", () => {
  assert.throws(() => deriveQaDefect([...opened(), proof(5), proof(6), proof(7, { expected: { ...expected, sel: "#payment" } })], defect({ reproducible: "재현됨" })), /두 번/);
});

test("열린 항목이 없으면 마지막 진입 이후 기록과 현재 장면을 사용한다", () => {
  const value = deriveQaDefect([rec(1, { kind: "entry", surface: "old", url: "http://localhost:4291/old" }), proof(2),
    rec(3, { kind: "entry", surface: "new", url: "http://localhost:4291/new" }), rec(4, { kind: "observation", cmd: "defect_context", surface: "new", shot: "shots/current.png", detail: { environment: { url: "http://localhost:4291/new", viewport: { width: 800, height: 600 } } } })], defect({ reproducible: "재현 안 됨" }));
  assert.equal(value.startSeq, 3); assert.equal(value.rowId, undefined); assert.deepEqual(value.failureSeqs, []);
  assert.equal(value.frames[0].shot, "shots/current.png"); assert.equal(value.steps[0].url, "http://localhost:4291/new");
  assert.deepEqual(value.environment.viewport, { width: 800, height: 600 });
});

test("모바일 실패를 선택할 때 브라우저 진입 주소를 섞지 않는다", () => {
  const events = [...opened(), proof(5, { surface: "phone", cmd: "app_expect", url: "app://phone" }), proof(6, { surface: "phone", cmd: "app_expect", url: "app://phone" })];
  const value = deriveQaDefect(events, defect({ reproducible: "재현됨" }));
  assert.equal(value.surface, "phone"); assert.equal(value.environment.url, "app://phone"); assert.deepEqual(value.steps, []);
});

test("긴 기대값의 생략된 부분이 다르면 같은 기대값의 반복 실패로 세지 않는다", async (t) => {
  const { ledger, call } = await setup(t);
  await ledger.append("run", { kind: "entry", surface: "web", url: "http://localhost:4291" });
  await applyQaRow({ ledger, runId: "run", args: { action: "declare", ...qaRowContract(), id: "R1", what: "저장", given: "사용자", basis: "spec", paths: ["정상"] } });
  await applyQaRow({ ledger, runId: "run", args: { action: "open", row: "R1", path: "정상" } });
  const event = { kind: "assertion", mode: "agent_action", rowId: "R1", path: "정상", surface: "web", pass: false };
  const first = await ledger.append("run", { ...event, expected: { ...expected, text: "가".repeat(500) + "첫째" } });
  const second = await ledger.append("run", { ...event, expected: { ...expected, text: "가".repeat(500) + "둘째" } });
  assert.equal(first.event.expected.text, second.event.expected.text);
  assert.notEqual(first.event.expectedDigest, second.event.expectedDigest);
  await assert.rejects(call("defect", defect({ reproducible: "재현됨" })), /같은 기대값이 두 번 이상 실패한 판정이 필요합니다\(지금 1번\)/);
  const third = await ledger.append("run", { ...event, expected: { ...expected, text: "가".repeat(500) + "둘째" } });
  const saved = await call("defect", defect({ reproducible: "재현됨" }));
  assert.deepEqual(saved.event.detail.failureSeqs, [second.seq, third.seq]);
});

test("모바일 label과 type을 보존하고 다른 type 실패를 합산하지 않는다", async (t) => {
  const { ledger, call } = await setup(t);
  await applyQaRow({ ledger, runId: "run", args: { action: "declare", ...qaRowContract(), id: "R1", what: "저장", given: "사용자", basis: "spec", paths: ["정상"] } });
  await applyQaRow({ ledger, runId: "run", args: { action: "open", row: "R1", path: "정상" } });
  const event = { kind: "assertion", cmd: "app_expect", mode: "agent_action", rowId: "R1", path: "정상", surface: "phone", pass: false };
  const first = await ledger.append("run", { ...event, expected: { mode: "exists", label: "저장", type: "button" } });
  const second = await ledger.append("run", { ...event, expected: { type: "text", label: "저장", mode: "exists" } });
  assert.equal(first.event.expected.label, "저장"); assert.equal(first.event.expected.type, "button");
  assert.notEqual(first.event.expectedDigest, second.event.expectedDigest);
  await assert.rejects(call("defect", defect({ reproducible: "재현됨" })), /두 번/);
  const third = await ledger.append("run", { ...event, expected: { mode: "exists", label: "저장", type: "text", text: undefined } });
  assert.equal(second.event.expectedDigest, third.event.expectedDigest);
  assert.deepEqual((await call("defect", defect({ reproducible: "재현됨" }))).event.detail.failureSeqs, [second.seq, third.seq]);
});

test("동작 좌표와 입력 생략 표시를 보존하고 입력 원문은 저장하지 않는다", async (t) => {
  const { ledger, call } = await setup(t);
  await ledger.append("run", { kind: "entry", surface: "phone", url: "app://phone" });
  const input = { kind: "text", length: 4, param: "order", valueOmitted: "입력 원문은 보관하지 않음",
    x: 10, y: 20, toX: 30, toY: 40, x1: 50, y1: 60, x2: 70, y2: 80, duration: 250, keycode: 66 };
  const saved = await ledger.append("run", { kind: "action", mode: "agent_action", surface: "phone", cmd: "app_type", pass: true,
    input: { ...input, text: "비밀 원문", unexpected: "보관 금지", deltaX: Infinity } });
  assert.deepEqual(saved.event.input, input);
  assert.equal(fs.readFileSync(ledger.paths("run").journal, "utf8").includes("비밀 원문"), false);
  assert.deepEqual((await call("defect", defect())).event.detail.steps[1].input, input);
});

test("outOfCharter는 선언과 파생 결과에 보존되며 기존 항목은 false다", async (t) => {
  const { ledger } = await setup(t);
  for (const [id, outOfCharter] of [["R1", true], ["R2", false]]) {
    const args = { action: "declare", ...qaRowContract(), id, what: "저장", given: "사용자", basis: "spec", paths: ["정상"], ...(outOfCharter ? { outOfCharter } : {}) };
    assert.equal(validateQaCommand("row", args).outOfCharter, outOfCharter ? true : undefined);
    const result = await applyQaRow({ ledger, runId: "run", args });
    assert.equal(result.row.outOfCharter, outOfCharter);
  }
  assert.equal(deriveQaRows([rec(1, { kind: "row", action: "declare", rowId: "legacy", rowData: { ...qaRowContract(), paths: ["정상"] } })]).rows[0].outOfCharter, false);
  await assert.rejects(applyQaRow({ ledger, runId: "run", args: { action: "declare", ...qaRowContract(), id: "bad", what: "저장", given: "사용자", basis: "spec", paths: ["정상"], outOfCharter: "true" } }), /불리언/);
});

test("메모와 charter 변경은 재시작 뒤에도 이전 값과 새 값을 보존한다", async (t) => {
  const { ledger, dir, call } = await setup(t);
  for (const kind of ["관찰", "아이디어", "막힘", "질문"]) await call("note", { kind, text: `기록 ${kind}` });
  const first = { ...qaCharter(), scope: "주문 검색" }, second = { ...first, scope: "주문 삭제" };
  await call("charter", { charter: first, reason: "검색 실패 발견" });
  await call("charter", { charter: second, reason: "삭제 영향 확인" });
  const restarted = createQaLedger({ dir, anchor: createQaLedgerAnchor({ dir: path.join(dir, "native") }) });
  const events = (await restarted.verify("run")).events;
  assert.deepEqual(events.filter(r => r.event.kind === "session_note").map(r => r.event.detail.kind), ["관찰", "아이디어", "막힘", "질문"]);
  assert.deepEqual(events.at(-2).event.detail, { oldCharter: qaCharter(), newCharter: first, reason: "검색 실패 발견" });
  assert.deepEqual(events.at(-1).event.detail, { oldCharter: first, newCharter: second, reason: "삭제 영향 확인" });
});

test("종료 요약은 결함 이벤트에서 만들고 임의 결함 입력과 종료 후 기록을 거부한다", async (t) => {
  const { ledger, call } = await setup(t);
  await ledger.append("run", { kind: "entry", surface: "web", url: "http://localhost:4291" });
  const saved = await call("defect", defect());
  assert.equal(saved.event.detail.problem, defect().problem);
  assert.equal((await ledger.verify("run")).events.filter(r => r.event.kind === "defect").length, 1);
  await assert.rejects(ledger.end("run", { session: { ...qaSession(), defects: "숨긴 결함" } }), /허용되지 않은/);
  await ledger.append("run", {kind:"human_review",detail:{defect:saved.seq,reason:"사람 확인 필요"}});
  const end = await ledger.end("run", { session: qaSession() });
  assert.equal(end.event.sessionRecord.defects, `${saved.seq}. ${defect().problem}`);
  assert.equal((await ledger.verify("run")).events.at(-1).event.sessionRecord.defects, end.event.sessionRecord.defects);
  await assert.rejects(call("note", { kind: "관찰", text: "종료 후" }), /종료한/);
});

test("결함이 없는 종료 요약은 없음이다", async (t) => {
  const { ledger } = await setup(t);
  assert.equal((await ledger.end("run", { session: qaSession() })).event.sessionRecord.defects, "없음");
});

test("장부 무결성 검증이 실패하면 세션 기록을 쓰지 않는다", async (t) => {
  const { ledger, call } = await setup(t);
  const journal = ledger.paths("run").journal;
  const damaged = fs.readFileSync(journal, "utf8").replace("변경된 기능과 저장 결과", "변조한 범위");
  fs.writeFileSync(journal, damaged);
  await assert.rejects(call("note", { kind: "관찰", text: "기록" }), /변조/);
  assert.equal(fs.readFileSync(journal, "utf8"), damaged);
});

test("현재 모바일 장면의 결함에 이전 웹 실패를 붙이지 않는다", () => {
  const events = [...opened(), proof(5), proof(6),
    rec(7,{kind:"action",cmd:"app_tap",rowId:"R1",path:"정상",surface:"phone",pass:true,input:{kind:"tap",x:10,y:20}}),
    rec(8,{kind:"observation",cmd:"defect_context",rowId:"R1",path:"정상",surface:"phone",shot:"phone.png",detail:{environment:{url:"app://phone"}}})];
  const value = deriveQaDefect(events,defect({reproducible:"재현 안 됨"}));
  assert.equal(value.surface,"phone"); assert.deepEqual(value.failureSeqs,[]);
  assert.equal(value.environment.url,"app://phone"); assert.deepEqual(value.steps.map(step=>step.cmd),["app_tap"]);
  assert.throws(()=>deriveQaDefect(events,defect({reproducible:"재현됨"})),/두 번/);
});
test("경로 도착 실패의 원래 장면과 진단을 결함에 연결한다", () => {
  const events = [rec(1,{kind:"entry",surface:"web",url:"http://localhost:4291"}),
    rec(2,{kind:"observation",cmd:"route_arrival",mode:"route_replay",surface:"web",pass:false,expected,observed:"다른 화면"}),
    rec(3,{kind:"failure",surface:"web",shot:"failed.png",detail:{failureSeq:2,console:["오류"]}}),
    rec(4,{kind:"observation",cmd:"defect_context",surface:"web",shot:"context.png"})];
  const value=deriveQaDefect(events,defect());
  assert.deepEqual(value.failureSeqs,[2]); assert.deepEqual(value.expected,expected);
  assert.equal(value.frames[0].shot,"failed.png"); assert.equal(value.observations[0].detail.console[0],"오류");
});

test("모바일 판정 예외의 기기를 직후 실패 장면에서 복구한다", () => {
  const events = [...opened(), proof(5,{surface:undefined,cmd:"app_expect",expected:{mode:"exists",label:"완료"}}),
    rec(6,{kind:"failure",surface:"phone",rowId:"R1",path:"정상",shot:"first.png",detail:{failureSeq:5}}),
    proof(7,{surface:undefined,cmd:"app_expect",expected:{mode:"exists",label:"완료"}}),
    rec(8,{kind:"failure",surface:"phone",rowId:"R1",path:"정상",shot:"second.png",detail:{failureSeq:7}})];
  let value;
  assert.doesNotThrow(()=>{ value=deriveQaDefect(events,defect({reproducible:"재현됨"})); });
  assert.equal(value.surface,"phone"); assert.deepEqual(value.failureSeqs,[5,7]);
  assert.ok(value.frames.some(frame=>frame.shot === "first.png"));
  assert.ok(value.frames.some(frame=>frame.shot === "second.png"));
});

test("재현 절차는 다른 항목에서 한 조작까지 진입부터 실패까지 모두 담는다", () => {
  const events = [...opened().slice(0, 2),
    rec(3, { kind: "row", action: "declare", rowId: "R0", rowData: { ...qaRowContract(), paths: ["정상"] } }),
    rec(4, { kind: "row", action: "open", rowId: "R0", path: "정상", rowData: {} }),
    rec(5, { kind: "action", cmd: "type", rowId: "R0", path: "정상", surface: "web", pass: true, input: { kind: "text", length: 4 } }),
    rec(6, { kind: "action", cmd: "click", rowId: "R0", path: "정상", surface: "web", pass: true }),
    rec(7, { kind: "row", action: "close", rowId: "R0", path: "정상", rowData: {} }),
    rec(8, { kind: "row", action: "declare", rowId: "R1", rowData: { ...qaRowContract(), paths: ["정상"] } }),
    rec(9, { kind: "row", action: "open", rowId: "R1", path: "정상", rowData: {} }), proof(10),
    rec(11, { kind: "action", cmd: "click", rowId: "R1", path: "정상", surface: "web", pass: true })];
  assert.deepEqual(deriveQaDefect(events, defect()).steps.map(s => [s.seq, s.cmd]), [[2, "open_entry"], [5, "type"], [6, "click"]]);
});
