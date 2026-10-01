import assert from "node:assert/strict";
import test from "node:test";

import { isRemoteOutbound } from "../server/remote/contract/connection.js";
import {
  projectAgents,
  projectAnswerResult,
  projectAuthResult,
  projectCaps,
  projectChallenge,
  projectError,
  projectMessageResult,
  projectPairPending,
  projectPong,
  projectRequests,
  projectStopResult,
  projectTranscript,
  projectTranscriptAppend,
} from "../server/remote/projection.js";

test("연결 출력은 챌린지·인증 결과·처리 요청·오류 계약만 만든다", () => {
  assert.deepEqual(projectChallenge({
    serverInstance: "1".repeat(32),
    connId: "2".repeat(32),
    nonce: "3".repeat(64),
    certHash: "4".repeat(64),
    cwd: "/private/secret",
  }), {
    type: "auth.challenge",
    v: "remote/1",
    serverInstance: "1".repeat(32),
    connId: "2".repeat(32),
    nonce: "3".repeat(64),
    certHash: "4".repeat(64),
  });
  assert.deepEqual(projectAuthResult("a".repeat(43), 30), {
    type: "auth.ok", v: "remote/1", resumeToken: "a".repeat(43), pinIdleMinutes: 30,
  });
  assert.deepEqual(projectPairPending({ deviceId: "5".repeat(32), code: "012345", secret: "hidden" }), {
    type: "pair.pending", v: "remote/1", deviceId: "5".repeat(32), code: "012345",
  });
  const requests = ["caps.get"];
  const caps = projectCaps(requests, "작업용 Mac");
  assert.deepEqual(caps, { type: "caps", remoteRpc: "remote/1", macName: "작업용 Mac", requests: ["caps.get"] });
  requests.push("hidden.request");
  assert.deepEqual(caps.requests, ["caps.get"]);
  assert.deepEqual(projectError("forbidden"), { type: "error", error: { code: "forbidden" } });
  assert.deepEqual(projectError("stack: /private/file"), { type: "error", error: { code: "unavailable" } });
});

test("연결 출력은 필드 형식이 맞지 않으면 만들지 않는다", () => {
  assert.throws(() => projectChallenge({
    serverInstance: "wrong",
    connId: "2".repeat(32),
    nonce: "3".repeat(64),
    certHash: "4".repeat(64),
  }), /projection/);
  assert.throws(() => projectCaps(["caps.get", "caps.get"], "Mac"), /projection/);
  assert.throws(() => projectCaps([{ name: "caps.get" }], "Mac"), /projection/);
  assert.throws(() => projectCaps(["caps.get"], "Mac\n이름"), /projection/);
  assert.throws(() => projectPairPending({ deviceId: "wrong", code: "123456" }), /projection/);
});

test("9.1 출력 전부가 projection과 최종 송신 검사를 통과한다", () => {
  const agent = { ref: "a".repeat(32), name: "작업", kind: "claude", status: "idle", question: true,
    space: "개인", spaceRef: "c".repeat(32), spaceOrder: 0, sessionOrder: 1, parent: null,
    lastActivityAt: null, can: { stop: true, message: false }, paneId: "secret" };
  const request = { ref: "b".repeat(32), agent: agent.ref, kind: "claude-permission", createdAt: 1, expiresAt: 2,
    body: { tool: "Read", description: "설명", input: "입력" }, deliver: () => {} };
  const item = { role: "assistant", text: "답", at: 1, sessionUuid: "secret" };
  const values = [
    projectPong("p1"),
    projectAgents([agent]),
    projectRequests([request]),
    projectTranscript({ rid: "t1", agent: agent.ref, items: [item], before: null }),
    projectTranscriptAppend({ agent: agent.ref, items: [item] }),
    projectStopResult("s1", "sent"),
    projectMessageResult("m1", "sent"),
    projectAnswerResult("a1", "delivered"),
    projectError("forbidden", "e1"),
  ];
  assert.equal(values.every(isRemoteOutbound), true);
  const encoded = JSON.stringify(values);
  assert.equal(encoded.includes("paneId"), false);
  assert.equal(encoded.includes("sessionUuid"), false);
  assert.equal(encoded.includes("secret"), false);
  assert.equal(isRemoteOutbound({ ...values[0], path: "/private/file" }), false);
  assert.equal(isRemoteOutbound({ type: "agents", agents: [{ ...values[1].agents[0], extra: true }] }), false);
});
