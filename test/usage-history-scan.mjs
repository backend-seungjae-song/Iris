// 이력 훑기의 두 판정을 검사로 고정한다. 중복 소유권과 Codex 증가분이다.
//
// 이 둘만 별도 검사로 두는 이유: 화면으로는 틀린 것이 보이지 않는다. 분기가 복사한 턴을
// 두 번 세도 숫자가 크게 나올 뿐이고, Codex 총계를 그대로 빼도 특정 회차에서만
// 어긋난다. 눈으로 확인할 수 없는 판정이라 계측기가 필요하다.
//
// 실행 방법: node --test test/usage-history-scan.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  claimKeys, keyHash, parseClaudeFile, parseClaudeLine, parseCodexFile, parseCodexLine,
  projectLabel, resolveCodexDelta,
} from "../server/usage-history.js";

function tmpFile(name, lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-usage-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"));
  return file;
}

const usage = (inp, out, cr, cw) => ({
  input_tokens: inp, output_tokens: out,
  cache_read_input_tokens: cr, cache_creation_input_tokens: cw,
});

function claudeTurn(id, req, tokens, extra) {
  return {
    type: "assistant", timestamp: "2026-09-08T01:00:00.000Z", sessionId: "s1",
    cwd: "/srv/Projects/demo", requestId: req,
    message: { id, model: "claude-opus-5", usage: usage(...tokens) },
    ...extra,
  };
}

test("사용량이 0인 줄과 어시스턴트가 아닌 줄은 세지 않는다", () => {
  assert.equal(parseClaudeLine(JSON.stringify(claudeTurn("m1", "r1", [0, 0, 0, 0])), "fb"), null);
  assert.equal(parseClaudeLine(JSON.stringify({ type: "user", timestamp: "2026-09-08T01:00:00.000Z" }), "fb"), null);
  assert.equal(parseClaudeLine("{망가진", "fb"), null);
});

test("열쇠는 message.id 와 requestId 를 함께 쓴다", () => {
  const both = parseClaudeLine(JSON.stringify(claudeTurn("m1", "r1", [1, 2, 3, 4])), "fb");
  assert.equal(both.key, "m1:r1");
  const noReq = parseClaudeLine(JSON.stringify(claudeTurn("m1", undefined, [1, 2, 3, 4])), "fb");
  assert.equal(noReq.key, "msg:m1");
  const raw = { type: "assistant", timestamp: "2026-09-08T01:00:00.000Z", sessionId: "s1",
    uuid: "u9", message: { usage: usage(1, 1, 0, 0) } };
  assert.equal(parseClaudeLine(JSON.stringify(raw), "fb").key, "uuid:u9");
});

test("같은 파일 안의 같은 열쇠는 큰 값으로 하나가 된다", async () => {
  const file = tmpFile("a.jsonl", [
    claudeTurn("m1", "r1", [10, 1, 0, 0]),
    claudeTurn("m1", "r1", [10, 40, 0, 500]),
    claudeTurn("m2", "r2", [5, 5, 0, 0]),
  ]);
  const turns = await parseClaudeFile(file);
  assert.equal(turns.length, 2);
  assert.deepEqual([turns[0].inp, turns[0].out, turns[0].cw], [10, 40, 500]);
});

test("앞 파일이 이미 센 열쇠는 뒤 파일 것이 아니다", () => {
  const owner = new Set();
  const first = claimKeys(["a", "b", "c"], owner);
  const second = claimKeys(["b", "c", "d"], owner);
  assert.deepEqual(first.owned, ["a", "b", "c"]);
  assert.deepEqual(second.owned, ["d"]);
});

test("앞 파일이 사라지면 뒤 파일의 임자 지문이 달라진다", () => {
  const withFirst = (() => {
    const owner = new Set();
    claimKeys(["a", "b"], owner);
    return claimKeys(["b", "c"], owner).sig;
  })();
  const alone = claimKeys(["b", "c"], new Set()).sig;
  assert.notEqual(withFirst, alone);   // 지문이 같으면 캐시를 그대로 믿어 b 가 통째로 사라진다
});

test("Codex 는 총계가 아니라 last_token_usage 를 그 회차 증가분으로 쓴다", () => {
  const total = { inp: 300, cached: 100, out: 30, reasoning: 10, total: 330 };
  const last = { inp: 100, cached: 40, out: 10, reasoning: 4, total: 110 };
  const prev = { inp: 200, cached: 60, out: 20, reasoning: 6, total: 220 };
  const got = resolveCodexDelta(total, last, prev);
  assert.equal(got.kind, "event");
  assert.deepEqual(got.delta, last);
  assert.deepEqual(got.next, total);
});

test("압축 뒤 되감긴 총계는 다시 세지 않는다", () => {
  const prev = { inp: 900, cached: 300, out: 90, reasoning: 30, total: 990 };
  const total = { inp: 200, cached: 60, out: 20, reasoning: 6, total: 220 };
  const last = { inp: 200, cached: 60, out: 20, reasoning: 6, total: 220 };
  assert.equal(resolveCodexDelta(total, last, prev), null);
  assert.equal(resolveCodexDelta(prev, null, prev), null);   // 안 움직인 총계도 회차가 아니다
});

test("총계만 있는 흐름은 차이만큼만 센다", () => {
  const prev = { inp: 100, cached: 10, out: 10, reasoning: 2, total: 110 };
  const total = { inp: 180, cached: 30, out: 25, reasoning: 5, total: 205 };
  const got = resolveCodexDelta(total, null, prev);
  assert.equal(got.kind, "event");
  assert.deepEqual(got.delta, { inp: 80, cached: 20, out: 15, reasoning: 3, total: 95 });
});

test("info 가 null 인 token_count 는 잔량 신호라 회차가 아니다", () => {
  const ctx = { sessionId: "s", sessionCwd: null, cwd: null, model: null, prev: null, baselinePending: false };
  const line = JSON.stringify({
    timestamp: "2026-09-08T01:00:00.000Z", type: "event_msg",
    payload: { type: "token_count", info: null, rate_limits: { primary: { used_percent: 3 } } },
  });
  assert.equal(parseCodexLine(line, ctx), null);
});

test("Codex 파일은 session_meta 의 cwd 와 turn_context 의 모델을 이어 붙인다", async () => {
  const file = tmpFile("rollout.jsonl", [
    { timestamp: "2026-09-08T00:59:00.000Z", type: "session_meta", payload: { id: "sess-1", cwd: "/srv/Projects/demo" } },
    { timestamp: "2026-09-08T00:59:30.000Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } },
    { timestamp: "2026-09-08T01:00:00.000Z", type: "event_msg", payload: { type: "token_count", info: {
      total_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10, reasoning_output_tokens: 4, total_tokens: 110 },
      last_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10, reasoning_output_tokens: 4, total_tokens: 110 },
    } } },
  ]);
  const events = await parseCodexFile(file);
  assert.equal(events.length, 1);
  assert.equal(events[0].sessionId, "sess-1");
  assert.equal(events[0].model, "gpt-5.6-sol");
  assert.equal(projectLabel(events[0].cwd), "Projects/demo");
  assert.equal(events[0].total, 110);
});

test("열쇠 지문은 같은 글자에 같은 값을 준다", () => {
  assert.equal(keyHash("m1:r1"), keyHash("m1:r1"));
  assert.notEqual(keyHash("m1:r1"), keyHash("m1:r2"));
  assert.equal(keyHash("m1:r1").length, 14);
});
