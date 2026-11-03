import test from "node:test";
import assert from "node:assert/strict";
import { calculateAffectedRows, QA_FIX_MAX_ATTEMPTS } from "../server/qa-fix.js";
import { fixture } from "./qa-fix5.test.mjs";

test("8차 영향 재실행은 source·consumer source·surface를 row로 모은다", () => {
  const events = [
    { seq: 1, event: { kind: "row", rowId: "direct", surface: "web/header.js", rowData: { source: "web/header.js:10" } } },
    { seq: 2, event: { kind: "row", rowId: "consumer", rowData: { consumers: [{ source: "web/header.js:20" }] } } },
    { seq: 3, event: { kind: "reaction", rowId: "surface", surface: "web/header.js" } },
    { seq: 5, event: { kind: "row", rowId: "same-surface", surface: "web/header.js", rowData: { source: "web/other.js:8" } } },
    { seq: 4, event: { kind: "row", rowId: "other", rowData: { source: "web/other.js:1", surface: "mobile" } } },
  ];
  assert.deepEqual(calculateAffectedRows(events, ["web/header.js"]), ["direct", "consumer", "surface", "same-surface"]);
});

test("8차 수정 시도 상한은 기본 2회다", () => assert.equal(QA_FIX_MAX_ATTEMPTS, 2));

test("applyQaFix는 실패 판정 없는 defect를 거부한다", async t => {
  const f=await fixture(t), {execFileSync}=await import('node:child_process');
  const pass=await f.ledger.append('source',{kind:'assertion',pass:true});
  const d=await f.ledger.append('source',{kind:'defect',detail:{problem:'성공 판정',failureSeq:pass.seq}});
  execFileSync('git',['-C',f.repo,'checkout','-b','fix/proof']);const hash=f.commit('proof');
  await assert.rejects(f.fix({defect:d.seq,failureSeq:pass.seq,commit:hash}),/실패 판정/);
});

test("applyQaFix는 diagnosis 파일이 diff에 없으면 거부한다", async t => {
  const f = await fixture(t); await f.ledger.append("source", { kind: "defect", detail: { problem: "x", failureSeq: f.failure.seq } });
  const { execFileSync } = await import("node:child_process"); execFileSync("git", ["-C", f.repo, "checkout", "-b", "fix/missing"]); const hash = f.commit("changed");
  await assert.rejects(f.fix({ commit: hash, diagnosis: { source: "missing.js:1", reason: "오류" } }), /수정 커밋에 포함/);
});

test("applyQaFix는 제품 코드의 테스트 분기를 거부한다", async t => {
  const f = await fixture(t); const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["-C", f.repo, "checkout", "-b", "fix/env"]); const hash = f.commit("process.env.NODE_ENV === 'test'");
  await assert.rejects(f.fix({ commit: hash }), /테스트 실행 여부 분기/);
});

test("applyQaFix는 assertion 삭제에 testReason을 요구하고 이유가 있으면 허용한다", async t => {
  const f = await fixture(t), { execFileSync } = await import("node:child_process");
  execFileSync("git", ["-C", f.repo, "checkout", "-b", "fix/assert"]);
  const fs = await import("node:fs"); fs.writeFileSync(`${f.repo}/test.js`, "assert.equal(1, 1);\n"); execFileSync("git", ["-C", f.repo, "add", "."]); execFileSync("git", ["-C", f.repo, "-c", "user.name=QA", "-c", "user.email=qa@example.invalid", "commit", "-m", "test"]);
  fs.writeFileSync(`${f.repo}/test.js`, ""); execFileSync("git", ["-C", f.repo, "add", "."]); execFileSync("git", ["-C", f.repo, "-c", "user.name=QA", "-c", "user.email=qa@example.invalid", "commit", "-m", "remove"]); const hash = execFileSync("git", ["-C", f.repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  await assert.rejects(f.fix({ commit: hash, diagnosis: { source: "test.js:1", reason: "단언 삭제" } }), /testReason/); await assert.doesNotReject(f.fix({ commit: hash, diagnosis: { source: "test.js:1", reason: "단언 삭제" }, testReason: "단언이 중복되어 제거됨" }));
});

test("applyQaFix는 세 번째 시도에서 고치지 못함을 기록한다", async t => {
  const f = await fixture(t), { execFileSync } = await import("node:child_process");
  execFileSync("git", ["-C", f.repo, "checkout", "-b", "fix/limit"]);
  const a = f.commit("a"), b = f.commit("b"); await f.fix({ commit: a }); await f.fix({ commit: b });
  const receipt = await f.fix({ commit: b }); assert.equal(receipt.event.detail.status, "고치지 못함"); assert.ok(receipt.event.detail.lastAttempt);
});
test('영향 row는 관찰 surface와 연관 catalog source를 연결한다',()=>{
 const events=[
 {seq:1,event:{kind:'row',action:'declare',rowId:'a',rowData:{consumers:['src/header.js:2']}}},
 {seq:2,event:{kind:'reaction',rowId:'a',surface:'tab-1'}},
 {seq:3,event:{kind:'reaction',rowId:'b',surface:'tab-1'}},
 {seq:4,event:{kind:'catalog_begin',detail:{catalog:{items:[{key:'catalog-hash',source:'src/header.js:8'}]}}}},
 {seq:5,event:{kind:'reaction',rowId:'c',surface:'tab-2',detail:{effects:[{catalogKey:'catalog-hash'}]}}},
 {seq:6,event:{kind:'reaction',rowId:'d',surface:'tab-3'}},
 ];
 assert.deepEqual(calculateAffectedRows(events,['src/header.js']),['a','c','b']);
});
test('무효 처리한 실패 판정은 수정 근거가 될 수 없다',async t=>{
 const f=await fixture(t);await f.ledger.append('source',{kind:'row',action:'void',rowData:{receipt:String(f.failure.seq)}});
 await assert.rejects(f.fix(),/무효/);
});
test('테스트 파일 전체 삭제도 testReason이 필요하다',async t=>{
 const f=await fixture(t),{execFileSync}=await import('node:child_process'),fs=await import('node:fs');
 const git=(...args)=>execFileSync('git',['-C',f.repo,...args],{encoding:'utf8',stdio:'pipe'}).trim();
 git('checkout','-b','fix/delete-test');fs.writeFileSync(`${f.repo}/test.js`,'assert.equal(1,1);\n');git('add','.');git('-c','user.name=QA','-c','user.email=qa@example.invalid','commit','-m','test');
 fs.unlinkSync(`${f.repo}/test.js`);git('add','.');const commit=f.commit('fixed');
 await assert.rejects(f.fix({commit}),/testReason/);
 await assert.doesNotReject(f.fix({commit,testReason:'중복 단언은 다른 테스트에서 확인'}));
});
test('실행기가 미리 만든 qa-fix 브랜치에서 시작한 회차도 수정 기록 허용',async t=>{
 const f=await fixture(t),{execFileSync}=await import('node:child_process');
 const {applyQaFix}=await import('../server/qa-fix.js');const {qaPlan,qaCharter}=await import('./qa-fixtures.mjs');
 execFileSync('git',['-C',f.repo,'checkout','-b','qa-fix/night'],{stdio:'pipe'});
 await f.ledger.begin({runId:'night',session:'owner',plan:qaPlan({entries:[],build:{repo:f.repo}}),charter:qaCharter()});
 const failure=await f.ledger.append('night',{kind:'assertion',pass:false});const defect=await f.ledger.append('night',{kind:'defect',detail:{failureSeq:failure.seq}});
 const commit=f.commit('night fix');
 const result=await applyQaFix({ledger:f.ledger,runId:'night',args:{defect:defect.seq,failureSeq:failure.seq,commit,summary:'저장 수정',diagnosis:{source:'value.txt:1',reason:'저장 갱신 누락'}}});
 assert.equal(result.event.detail.branch,'qa-fix/night');
});
