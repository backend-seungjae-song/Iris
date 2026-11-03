import { qaCharter, qaPlan } from "./qa-fixtures.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { validateQaCommand } from "../server/qa-protocol.js";
import { QA_TOOLS, qaArguments } from "../bin/iris-qa.mjs";

test("QA 명령은 허용 목록만 노출하고 run을 별도 봉투로 보낸다", () => {
  const names = QA_TOOLS.map((tool) => tool.name);
  assert.ok(names.includes("qa_run_begin"));
  assert.ok(names.includes("qa_report"));
  assert.ok(!names.some((name) => /goto|eval|new_tab/.test(name)));
  assert.deepEqual(qaArguments("qa_click", { run: "run-1", x: 5, y: 9, expect: {effects: [{type:"none",oracle:"기능의 용도"}]} }),
    { cmd: "click", args: { x: 5, y: 9, expect: {effects: [{type:"none",oracle:"기능의 용도"}],within:5000} }, run: "run-1" });
  assert.throws(() => qaArguments("qa_click", { x: 5, y: 9 }), /run/);
  assert.throws(() => qaArguments("qa_run_begin", { run: "run-1", plan: { entries: ["https://example.com"] } }), /run_begin/);
});

test("주소와 중첩 인자의 우회 필드를 거부한다", () => {
  const plan = qaPlan({ entries: ["https://example.com"], name: "기능 확인" });
  assert.deepEqual(validateQaCommand("run_begin", { plan, charter:qaCharter() }), { plan, charter:qaCharter() });
  const denied = [
    ["goto", { url: "https://example.com" }],
    ["open_entry", { url: "https://elsewhere.example", reason: "deep link" }],
    ["open_entry", { url: "file:///tmp/fixture.html" }],
    ["open_entry", { url: "https://name:password@example.com" }],
    ["run_begin", { plan: { entries: ["https://example.com"], entry: "https://elsewhere.example" } }],
    ["run_begin", { plan: { entries: ["https://example.com"], new_tab: true } }],
    ["click", { x: 1, y: 2, selected: { role: "button", name: "Save", eval: "document.body.click()" } }],
    ["click", { x: 1, y: 2, synthesize: true }],
    ["route_save", { name: "route", fromSeq: 9, toSeq: 2 }],
  ];
  for (const [cmd, args] of denied) assert.throws(() => validateQaCommand(cmd, args), undefined, cmd);
});

test("필수 값과 숫자 범위를 확인한다", () => {
  assert.throws(() => validateQaCommand("expect", { mode: "equals", sel: "#result" }), /text/);
  assert.throws(() => validateQaCommand("click", { x: NaN, y: 0 }), /x/);
  assert.throws(() => validateQaCommand("viewport", { width: 0, height: 600 }), /width/);
  assert.deepEqual(validateQaCommand("row", { action: "begin", id: "U1" }), { action: "begin", id: "U1" });
});

test("조작 기대 선언은 정본 oracle과 관찰 가능한 효과만 허용한다", () => {
  const base = { x: 1, y: 2 };
  const expect = (effect) => ({ ...base, expect: { effects: [{ id: "e1", oracle: "기능의 용도", ...effect }] } });
  assert.deepEqual(validateQaCommand("click", expect({ type: "appear", text: "저장됨" })).expect.within, 5000);
  assert.throws(() => validateQaCommand("click", expect({ type: "appear", text: "저장됨", oracle: "임의 기준" })), /oracle: 허용된 값 중 하나가 필요합니다\(이전 버전/);
  assert.throws(() => validateQaCommand("click", { ...base, expect: { effects: [
    { id: "a", type: "none", oracle: "기능의 용도" }, { id: "b", type: "appear", text: "나타남", oracle: "기능의 용도" },
  ] } }), /none/);
  assert.throws(() => validateQaCommand("click", { ...base, expect: { effects: [
    { id: "a", type: "appear", sel: "canvas", text: "그림", oracle: "기능의 용도" },
  ] } }), /canvas/);
  assert.throws(() => validateQaCommand("click", { ...base, expect: { effects: [
    { id: "a", type: "appear", role: "button", oracle: "기능의 용도" },
  ] } }), /text 또는 role·name/);
  assert.throws(() => validateQaCommand("app_tap", { device: "phone", ...base, expect: { effects: [
    { id: "a", type: "navigate", url: "/next", oracle: "기능의 용도" },
  ] } }), /모바일/);
});

test("J3 장면 판단은 row close와 end에서 비어 있을 수 없다", () => {
  assert.throws(() => validateQaCommand("row", { action: "close", row: "R1", path: "정상" }), /sceneJudgment/);
  assert.throws(() => validateQaCommand("row", { action: "end", row: "R1", path: "정상", sceneJudgment: "   " }), /sceneJudgment/);
  assert.equal(validateQaCommand("row", { action: "close", row: "R1", path: "정상", sceneJudgment: "화면 전체를 확인함" }).sceneJudgment, "화면 전체를 확인함");
});

 test("대화상자 기대는 종류와 문구를 함께 받는다",()=>{
  assert.equal(validateQaCommand("click",{x:1,y:1,expect:{effects:[{type:"dialog",kind:"alert",text:"저장",oracle:"기능의 용도"}]}}).expect.effects[0].text,"저장");
 });

test("모든 화면 조작은 expect 없으면 실행 전에 거부한다",()=>{
  for(const [cmd,args] of [
    ['click',{x:1,y:1}],['dblclick',{x:1,y:1}],['type',{text:'값'}],['key',{key:'Enter'}],
    ['select',{x:1,y:1,index:0}],['drag',{x:1,y:1,toX:2,toY:2}],['scroll',{x:1,y:1,deltaY:10}],
    ['history',{action:'back'}],['dialog',{answer:'cancel'}],['app_tap',{x:1,y:1}],
    ['app_swipe',{x1:1,y1:1,x2:2,y2:2}],['app_type',{text:'값'}],['app_key',{key:'HOME'}],
  ])assert.throws(()=>validateQaCommand(cmd,args),/args.expect: 필수 인자/,cmd);
});
