// 조작이 기기·탭에 전달되지 않은 단계의 판정
import test from "node:test";
import assert from "node:assert/strict";
import { playQaSteps } from "../server/qa-play.js";

const step = {target:{text:"상점"}, action:"tap", expect:{effects:[{type:"appear",text:"상점",oracle:"기능의 용도"}]}};
const run = async inputResult => {
  const closed = [], records = [];
  const result = await playQaSteps({steps:[step, step], resolve:async()=>({found:true,x:1,y:1}), input:async()=>inputResult,
    record:async event=>records.push(event), capture:async()=>({}), close:async args=>closed.push(args)});
  return {result, closed, records};
};

test("전달되지 않은 조작은 실패가 아니라 막힘으로 닫는다", async () => {
  const {result, closed, records} = await run({pass:false, delivered:false, ok:false, error:"idb 실행에 실패했습니다: argument x: invalid int value"});
  assert.equal(result.status, "막힘");
  assert.equal(closed[0].blocked, true);
  assert.match(closed[0].reason, /^막힘: 조작 전달 실패 — idb 실행에 실패했습니다/);
  assert.equal(records.find(event=>event.kind === "play_step").detail.status, "막힘");
});

test("조작 전 기대 장면 단계에서 도구가 거부한 조작은 막힘으로 닫는다", async () => {
  const closed = [];
  const rejected = Object.assign(new Error("허용되지 않은 모바일 기대 효과입니다."), {delivered:false});
  const result = await playQaSteps({steps:[step], resolve:async()=>({found:true,x:1,y:1}), input:async()=>{ throw rejected; },
    record:async()=>{}, capture:async()=>({}), close:async args=>closed.push(args)});
  assert.equal(result.status, "막힘");
  assert.equal(closed[0].blocked, true);
  assert.match(closed[0].reason, /^막힘: 조작 전달 전 거부 — 허용되지 않은/);
});

test("대상을 찾지 못한 단계처럼 전달 여부와 관계없는 예외는 그대로 실패로 닫는다", async () => {
  const closed = [];
  const result = await playQaSteps({steps:[step], resolve:async()=>{ throw new Error("조작 대상을 찾을 수 없음"); }, input:async()=>({pass:true}),
    record:async()=>{}, capture:async()=>({}), close:async args=>closed.push(args)});
  assert.equal(result.status, "실패");
  assert.equal(closed[0].blocked, false);
});

test("전달된 조작의 기대 불일치는 그대로 실패로 닫는다", async () => {
  const {result, closed} = await run({pass:false, delivered:true, reason:"기대 효과 미관찰"});
  assert.equal(result.status, "실패");
  assert.equal(closed[0].blocked, false);
});

test("등록된 방해 화면 조건은 조작 대상 확인에만 넘기고 닫기 대상 확인에는 넘기지 않는다", async () => {
  const lookups = [];
  let tipOpen = true;
  const handler = {key:"tip", class:"방해 화면", condition:{text:"친구 초대하고"}, handler:{method:"click", target:{text:"걸음"}, expect:{effects:[]}}};
  const resolve = async (target, _step, options = {}) => {
    lookups.push([target.text, !!options.obstacles]);
    if (target.text === "상점" && options.obstacles && tipOpen) return {found:true, x:1, y:1, occluded:true, blocker:{text:"친구 초대하고 보상 받기"}};
    return {found:true, x:1, y:1, occluded:false};
  };
  const input = async inputStep => { if (inputStep.target?.text === "걸음") tipOpen = false; return {pass:true, delivered:true}; };
  const result = await playQaSteps({steps:[step], resolve, input, handlers:[handler], record:async()=>{}, capture:async()=>({seq:1}), close:async()=>{}});
  assert.equal(result.pass, true);
  assert.deepEqual(lookups, [["상점", true], ["걸음", false], ["상점", true], ["상점", true]]);
});

test("대상을 못 찾으면 비슷한 이름 후보를 실패 이유에 적는다", async () => {
  const closed = [];
  const near = [{role:"textbox", name:"상품·브랜드 검색\n상품·브랜드를 검색해주세요"}];
  await playQaSteps({steps:[step], resolve:async()=>({found:false, near, platform:"ios"}), input:async()=>({pass:true}),
    record:async()=>{}, capture:async()=>({}), close:async args=>closed.push(args)});
  assert.equal(closed[0].reason, '조작 대상을 찾을 수 없음 — 비슷한 후보: textbox "상품·브랜드 검색\\n상품·브랜드를 검색해주세요"');
});

test("웹 탭에서 대상을 못 찾으면 웹 탭에서 찾았다고 알린다", async () => {
  const closed = [];
  await playQaSteps({steps:[step], resolve:async()=>({found:false}), input:async()=>({pass:true}),
    record:async()=>{}, capture:async()=>({}), close:async args=>closed.push(args)});
  assert.match(closed[0].reason, /^조작 대상을 찾을 수 없음 \(웹 탭에서 찾음/);
});

test("방해 화면 처리가 닫은 요소 때문에 전제 검사가 막으면 그 처리를 이유에 적는다", async () => {
  let tipOpen = true;
  const closed = [];
  const handler = {key:"tip", class:"방해 화면", condition:{text:"친구 초대하고"}, handler:{method:"click", target:{text:"걸음"}, expect:{effects:[]}}};
  const resolve = async (target, _step, options = {}) =>
    target.text === "상점" && options.obstacles && tipOpen ? {found:true, x:1, y:1, occluded:true, blocker:{text:"친구 초대하고\n보상 받기"}} : {found:true, x:1, y:1, occluded:false};
  const input = async inputStep => {
    if (inputStep.target?.text === "걸음") { tipOpen = false; return {pass:true, delivered:true}; }
    throw Object.assign(new Error("기대 전제 불성립(조작 안 보냄): 친구 초대하고 가 없음"), {delivered:false});
  };
  const result = await playQaSteps({steps:[step], resolve, input, handlers:[handler], record:async()=>{}, capture:async()=>({seq:1}), close:async args=>closed.push(args)});
  assert.equal(result.status, "막힘");
  assert.match(closed[0].reason, /직전에 등록된 방해 화면 처리가 "친구 초대하고 보상 받기"을\(를\) 닫음/);
});

test("방해 화면 처리가 없던 단계의 전제 막힘은 이유를 바꾸지 않는다", async () => {
  const closed = [];
  const input = async () => { throw Object.assign(new Error("기대 전제 불성립(조작 안 보냄): 없음"), {delivered:false}); };
  await playQaSteps({steps:[step], resolve:async()=>({found:true,x:1,y:1}), input, record:async()=>{}, capture:async()=>({}), close:async args=>closed.push(args)});
  assert.equal(closed[0].reason, "막힘: 조작 전달 전 거부 — 기대 전제 불성립(조작 안 보냄): 없음");
});
