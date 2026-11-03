// 명령 도중 문서·debugger 세대가 바뀌어도 실행 전에 거절된 단계는 현재 token 으로 다시 보냄
// 실측: 11-03 설치본에서 browser_click·browser_observe·browser_history 가 "현재 문서 세대의 target token이 아닙니다"로 실패
import test from "node:test";
import assert from "node:assert/strict";
import { runUnitHandler } from "../server/mcp-worker/unit-runner.js";

const token = (documentGeneration, debuggerGeneration = 1) => ({ wcId: 7, documentGeneration, debuggerGeneration });
const hostStale = () => Object.assign(new Error("현재 문서 세대의 target token이 아닙니다."), { code: "STALE_TARGET" });
const done = (data = {}) => ({ ok: true, data, commandState: "completed" });

// live 는 지금 탭의 token · 보낸 token 이 다르면 host 처럼 거절
function relay(live, { mainReject = false, onCall = () => {} } = {}) {
  const calls = [];
  const relayCall = async (command, args, unit, sentToken) => {
    calls.push({ command, unit: unit?.phase, token: sentToken });
    if (sentToken.documentGeneration !== live.current.documentGeneration) {
      if (mainReject) return { ok: false, error: "대상의 문서 또는 debugger 세대가 바뀌었습니다.", commandState: "completed" };
      throw hostStale();
    }
    onCall(command);
    return done({ command });
  };
  return { calls, relayCall };
}

test("클릭으로 페이지가 이동한 뒤의 단계는 새 token 으로 다시 보내 명령이 끝난다", async () => {
  const live = { current: token(1) };
  const { calls, relayCall } = relay(live, { onCall: command => { if (command === "input.click") live.current = token(2); } });
  const result = await runUnitHandler({
    command: "click", args: {}, token: token(1), relayCall, refreshToken: async () => live.current,
    handler: async ({ base }) => {
      await base("input.click", {});
      const after = await base("obs.read", {}, { last: true });
      return { ok: true, data: after.response.data };
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map(call => [call.command, call.token.documentGeneration]),
    [["input.click", 1], ["obs.read", 1], ["obs.read", 2]]);
});

test("메인 중계 검사가 실행 전에 거절한 응답도 다시 보낸다", async () => {
  const live = { current: token(3) };
  const { calls, relayCall } = relay(live, { mainReject: true });
  const result = await runUnitHandler({
    command: "observe", args: {}, token: token(2), relayCall, refreshToken: async () => live.current,
    handler: async ({ base }) => (await base("obs.read", {}, { last: true })).response,
  });
  assert.equal(result.ok, true);
  assert.equal(calls.at(-1).token.documentGeneration, 3);
});

test("서버 세대 표가 늦게 갱신돼도 몇 번 기다린 뒤 맞는 token 으로 보낸다", async () => {
  const live = { current: token(5) };
  let lagging = 2;
  const { relayCall } = relay(live);
  const result = await runUnitHandler({
    command: "history", args: {}, token: token(4), relayCall,
    refreshToken: async () => (lagging-- > 0 ? token(4) : live.current),
    handler: async ({ base }) => (await base("obs.read", {}, { last: true })).response,
  });
  assert.equal(result.ok, true);
});

test("세대 불일치가 계속되면 재시도를 멈추고 거절을 그대로 알린다", async () => {
  const live = { current: token(9) };
  const { calls, relayCall } = relay(live);
  await assert.rejects(runUnitHandler({
    command: "click", args: {}, token: token(1), relayCall, refreshToken: async () => token(1),
    handler: async ({ base }) => (await base("input.click", {}, { last: true })).response,
  }), { code: "STALE_TARGET" });
  assert.equal(calls.filter(call => call.command === "input.click").length, 5);
});

test("이동 전 snapshot ref 거절(stale_ref)은 다시 보내지 않는다", async () => {
  const calls = [];
  const result = await runUnitHandler({
    command: "click", args: {}, token: token(1), refreshToken: async () => token(1),
    relayCall: async (command) => {
      calls.push(command);
      return { ok: false, code: "stale_ref", error: "페이지가 이동되어 ref가 만료됐습니다 — 재-snapshot 필요.", commandState: "completed" };
    },
    handler: async ({ base }) => (await base("input.click", { ref: "e3" }, { last: true })).response,
  });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 1);
});
