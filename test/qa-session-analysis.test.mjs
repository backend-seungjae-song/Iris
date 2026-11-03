import test from "node:test";
import assert from "node:assert/strict";
import { deriveQaSessionAnalysis } from "../server/qa-session-analysis.js";
import { renderSessionRecords } from "../bin/mcp/report-session.mjs";
import { qaCharter, qaSession } from "./qa-fixtures.mjs";

const record = (seconds, event, seq = seconds + 1) => ({ seq, event: { mode:"agent_action", at: Date.UTC(2026, 0, 1) + seconds * 1000, ...event } });
const esc = value => String(value ?? "").replace(/[&<>"']/g, character => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[character]));
const rows = [{id:"inside",what:"저장 확인",outOfCharter:false},{id:"outside",what:"알림 확인",outOfCharter:true}];

test("server event intervals split preparation, linked investigation and remaining testing", () => {
  const events = [
    record(0,{kind:"run_begin",mode:"preparation"}),
    record(10,{kind:"row",action:"open",rowId:"inside",path:"정상"}),
    record(20,{kind:"assertion",rowId:"inside",pass:false},3),
    record(30,{kind:"failure",rowId:"inside",detail:{failureSeq:3}}),
    record(40,{kind:"defect",detail:{failureSeq:3}}),
    record(50,{kind:"run_end"}),
  ];
  assert.deepEqual(deriveQaSessionAnalysis(events,rows).time, {
    totalMs:50000,setupMs:10000,investigationMs:20000,testMs:20000,
    insideMs:40000,outsideMs:0,unassignedMs:10000,invalidIntervals:0,
  });
});

test("an unrelated defect cannot end investigation and multiple matching failures close together", () => {
  const events = [record(0,{kind:"run_begin"}),record(5,{kind:"assertion",rowId:"inside",pass:false},2),
    record(10,{kind:"assertion",rowId:"inside",pass:false},3),record(15,{kind:"defect",detail:{failureSeq:99}}),
    record(20,{kind:"defect",detail:{failureSeq:3,failureSeqs:[2,3]}}),record(25,{kind:"run_end"})];
  const {time} = deriveQaSessionAnalysis(events,rows);
  assert.equal(time.investigationMs,15000); assert.equal(time.testMs,10000);
});

test("testing another row and preparation during investigation count as testing", () => {
  const events = [record(0,{kind:"run_begin"}),record(5,{kind:"assertion",rowId:"inside",pass:false},2),
    record(10,{kind:"action",rowId:"outside",pass:true}),record(15,{kind:"observation",mode:"route_replay"}),
    record(20,{kind:"frame",rowId:"inside"}),record(25,{kind:"defect",detail:{failureSeq:2}}),record(30,{kind:"run_end"})];
  const {time} = deriveQaSessionAnalysis(events,rows);
  assert.equal(time.investigationMs,10000); assert.equal(time.testMs,20000); assert.equal(time.setupMs,0);
});

test("scope time follows open lanes, inside wins mixed lanes, and closed lanes are unassigned", () => {
  const events = [record(0,{kind:"run_begin"}),record(5,{kind:"row",action:"open",rowId:"outside",path:"정상"}),
    record(10,{kind:"row",action:"open",rowId:"inside",path:"정상"}),record(15,{kind:"row",action:"close",rowId:"inside",path:"정상"}),
    record(20,{kind:"row",action:"close",rowId:"outside",path:"정상"}),record(25,{kind:"run_end"})];
  const result = deriveQaSessionAnalysis(events,rows);
  assert.equal(result.time.insideMs,5000); assert.equal(result.time.outsideMs,10000); assert.equal(result.time.unassignedMs,10000);
  assert.deepEqual(result.rowCounts,{inside:1,outside:1}); assert.equal(result.outsideRows[0].id,"outside");
});

test("invalid, missing and reversed event times are explicit and never yield negative duration", () => {
  const events = [record(0,{kind:"run_begin"}),record(5,{kind:"observation"}),record(3,{kind:"observation"}),
    {seq:4,event:{kind:"observation"}},record(10,{kind:"run_end"})];
  const {time} = deriveQaSessionAnalysis(events,rows);
  assert.equal(time.invalidIntervals,3); assert.equal(time.totalMs,5000);
  const html = renderSessionRecords(qaCharter(),qaSession(),esc,deriveQaSessionAnalysis(events,rows));
  assert.match(html,/간격 3개는 계산에서 제외/);
});

test("session opening preserves required order, revision history, notes and linked defect diagnostics with escaping", () => {
  const charter = qaCharter(), newCharter = {...charter,question:"<script>revised</script>"};
  const events = [record(0,{kind:"run_begin"}),record(5,{kind:"failure",shot:"failure.png",detail:{failureSeq:2,console:["<script>console</script>"],network:[{status:500}],exceptions:["TypeError"],environment:{device:"desktop"}}},2),
    record(10,{kind:"defect",detail:{problem:"<img src=x onerror=alert(1)>",oracle:"spec",oracleNote:"保存",importance:"保存 실패",reproducible:"yes",tried:"retry",failureSeq:2,steps:[{seq:2,cmd:"click",target:{name:'"save"'}}],frames:[{seq:2,shot:"defect.png"}],observations:[{cmd:"observe",observed:"failed"}],environment:{url:"http://local/"}}}),
    record(15,{kind:"session_note",detail:{kind:"motivation",text:"<b>왜 확인했는가</b>"}}),
    record(20,{kind:"charter_change",detail:{oldCharter:charter,newCharter,reason:"알림도 확인"}}),record(25,{kind:"run_end"})];
  const analysis = deriveQaSessionAnalysis(events,rows);
  assert.equal(analysis.defects[0].failures[0].shot,"failure.png");
  const html = renderSessionRecords(charter,qaSession(),esc,analysis,(shot,caption)=>`<figure data-shot="${esc(shot)}">${esc(caption)}</figure>`);
  const headings = ["Charter","세션 기록","결함 목록","세션 메모","시간 분류","Charter 밖 확인 항목"].map(title => html.indexOf(`<h2>${title}</h2>`));
  assert.ok(headings.every((index,i)=> index >= 0 && (!i || index > headings[i-1])));
  assert.match(html,/수정 전/); assert.match(html,/수정 후/); assert.match(html,/알림도 확인/);
  assert.match(html,/inquiry metrics/); assert.match(html,/종료 여부나 품질을 결정하는 기준으로 쓰지 않습니다/);
  assert.match(html,/&lt;script&gt;console&lt;\/script&gt;/); assert.match(html,/&lt;b&gt;왜 확인했는가&lt;\/b&gt;/);
  assert.match(html,/data-shot="defect.png"/); assert.match(html,/data-shot="failure.png"/);
  assert.doesNotMatch(html,/<script>|<img src=x|<b>왜 확인했는가/);
});

test("항목 안 로그인처럼 preparation으로 기록된 조작은 준비 시간이다", () => {
  const events=[record(0,{kind:"run_begin",mode:"preparation"}),record(3,{kind:"accepted",rowId:"inside",mode:"preparation"}),
    record(10,{kind:"action",rowId:"inside",mode:"preparation",pass:true}),record(23,{kind:"run_end"})];
  const {time}=deriveQaSessionAnalysis(events,rows);
  assert.equal(time.setupMs,23000); assert.equal(time.testMs,0);
});
