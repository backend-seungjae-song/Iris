import assert from "node:assert/strict";
import test from "node:test";
import { displayCodexQuestionAnswer, pendingCodexQuestions, nativeQuestionAnswer } from "../server/paseo-ui/codex-shared-questions.mjs";

const ask = {
  id: "native-item", type: "agentMessage", delivery: "async",
  questions: [{ title: "Choose a host", options: ["Staging", "Production"] }, { title: "Add a label" }],
};
const turns = (...items) => [{ items }];
const userMessage = (text) => ({ type: "userMessage", content: [{ type: "text", text }] });
const response = { behavior: "allow", updatedInput: { answers: { "Question 1": "Staging" } } };

test("Codex answer uses the native tag and preserves the original question index", () => {
  const [request] = pendingCodexQuestions(turns(ask)).values();
  const answer = nativeQuestionAnswer(request, response);
  assert.equal(answer, '<send_user_message_question_reply>\n[{"questionItemId":"[\\"request_user_input_async\\",\\"native-item\\",0]","question":"Choose a host","answer":"Staging"}]\n</send_user_message_question_reply>');
  assert.equal(displayCodexQuestionAnswer(answer), "> Choose a host\n\nStaging");
  const [remaining] = pendingCodexQuestions(turns(ask, userMessage(answer))).values();
  assert.deepEqual(remaining.permission.input.questions.map(q => q.header), ["Question 2"]);
});

test("ordinary conversation follow-up clears earlier unanswered questions", () => {
  assert.equal(pendingCodexQuestions(turns(ask, userMessage("A different task"))).size, 0);
});

test("a stale or empty answer does not send a native turn", () => {
  const [request] = pendingCodexQuestions(turns(ask)).values();
  assert.throws(() => nativeQuestionAnswer(request, { ...response, updatedInput: { answers: { "Question 9": "Staging" } } }));
  assert.throws(() => nativeQuestionAnswer(request, { ...response, updatedInput: { answers: { "Question 1": " " } } }));
});

test("공유 Codex 대화를 다시 열면 터미널에 저장된 모든 페이지를 순서대로 읽는다", async () => {
  const { readSharedCodexThread } = await import("../server/paseo-ui/codex-chat.mjs");
  const metadata = { id: "thread", historyMode: "paginated" };
  const request = async (method, params) => {
    assert.equal(params.threadId, metadata.id);
    if (method === "thread/read") return { thread: metadata };
    assert.equal(method, "thread/turns/list");
    assert.equal(params.itemsView, "full");
    assert.equal(params.sortDirection, "asc");
    return params.cursor === "next"
      ? { data: [{ items: ["terminal reply"] }], nextCursor: null }
      : { data: [{ items: ["previous chat"] }], nextCursor: "next" };
  };
  for (const seed of [metadata, undefined]) {
    assert.deepEqual((await readSharedCodexThread(request, metadata.id, seed)).turns.flatMap(t => t.items),
      ["previous chat", "terminal reply"]);
  }
});

test("공유 Codex 설정 번들은 원본 순서와 native thread 설정을 함께 사용한다", async () => {
  const { applySharedCodexConfig } = await import("../server/paseo-ui/codex-chat.mjs");
  const calls = [];
  const notice = { kind: "next_turn", message: "다음 요청부터 적용됩니다" };
  const native = {
    model: "model-b", effort: "high", serviceTier: "fast", approvalPolicy: "never",
    sandboxPolicy: { type: "workspace-write" }, approvalsReviewer: "user", cwd: "/fixture",
    collaborationMode: { mode: "code", settings: {} },
  };
  class OriginalAgentConfigSession {
    constructor({ host, operations }) { this.host = host; this.operations = operations; }
    async handleAgentConfigApplyRequest(message) {
      assert.equal(message.type, "agent.config.apply.request");
      const config = message.config;
      if (config.modelId !== undefined) await this.operations.setModel(message.agentId, config.modelId);
      if (config.modeId !== undefined) await this.operations.setMode(message.agentId, config.modeId);
      if (config.thinkingOptionId !== undefined) await this.operations.setThinking(message.agentId, config.thinkingOptionId);
      const options = { ...config.featureValues, ...config.options };
      if (Object.keys(options).length) await this.operations.setOptions(message.agentId, options);
      this.host.emit({ type: "agent.config.apply.response", payload: { accepted: true, notice } });
    }
  }
  const session = {
    async setModel(value) { calls.push(["model", value]); native.model = value; },
    async setMode(value) { calls.push(["mode", value]); native.collaborationMode = { mode: value, settings: {} }; return notice; },
    async setThinkingOption(value) { calls.push(["thinking", value]); native.effort = value; },
    async applyOptions(value) { calls.push(["options", value]); },
    async buildTurnStartParams() {
      return { params: { threadId: "wrong", input: [], ...native, config: { hidden: true }, developerInstructions: "hidden", outputSchema: {} } };
    },
  };
  let request;
  const result = await applySharedCodexConfig({ AgentConfigApplySchema: { parse: value => value }, AgentConfigSession: OriginalAgentConfigSession,
    logger: {}, session, threadId: "thread-1", config: { modelId: "model-a", modeId: "auto", thinkingOptionId: "medium", options: { plan_mode: true } },
    request: async (method, params) => { request = { method, params }; } });
  assert.deepEqual(calls, [["model", "model-a"], ["mode", "auto"], ["thinking", "medium"], ["options", { plan_mode: true }]]);
  assert.deepEqual(result, notice);
  assert.equal(request.method, "thread/settings/update");
  assert.deepEqual(request.params, { threadId: "thread-1", model: "model-a", effort: "medium", collaborationMode: { mode: "auto", settings: {} } });
  assert.equal(request.params.approvalPolicy, undefined);
  assert.equal(request.params.sandboxPolicy, undefined);
  assert.equal(request.params.approvalsReviewer, undefined);
});

test("공유 Codex 속도 변경은 native 권한 설정을 보존하고 실패한 번들을 예약하지 않는다", async () => {
  const { applySharedCodexConfig } = await import("../server/paseo-ui/codex-chat.mjs");
  const native = { model: "model-a", effort: "high", serviceTier: "default", approvalPolicy: "never", sandboxPolicy: { type: "workspace-write" }, approvalsReviewer: "user" };
  let fail = true;
  let requests = [];
  class OriginalAgentConfigSession {
    constructor({ host, operations }) { this.host = host; this.operations = operations; }
    async handleAgentConfigApplyRequest(message) {
      assert.equal(message.type, "agent.config.apply.request");
      await this.operations.setOptions(message.agentId, message.config.options);
      this.host.emit({ type: "agent.config.apply.response", payload: { accepted: true, notice: null } });
    }
  }
  const session = {
    async applyOptions(options) {
      if (fail) throw new Error("speed rejected");
      native.serviceTier = options.service_tier;
    },
    async buildTurnStartParams() { return { params: { threadId: "thread", input: [], ...native } }; },
  };
  const args = { AgentConfigApplySchema: { parse: value => value }, AgentConfigSession: OriginalAgentConfigSession, logger: {}, session, threadId: "thread-1",
    config: { options: { service_tier: "fast" } }, request: async (method, params) => requests.push({ method, params }) };
  await assert.rejects(applySharedCodexConfig(args), /speed rejected/);
  assert.deepEqual(requests, []);
  fail = false;
  await applySharedCodexConfig(args);
  assert.deepEqual(requests, [{ method: "thread/settings/update", params: { threadId: "thread-1", serviceTier: "fast" } }]);
});

test("native 설정 거절 뒤에는 같은 세션의 재시도와 무관한 설정을 모두 차단한다", async () => {
  const { applySharedCodexConfig } = await import("../server/paseo-ui/codex-chat.mjs");
  const native = { model: "model-a", effort: "high", approvalPolicy: "never", sandboxPolicy: { type: "workspace-write" } };
  const calls = [];
  class OriginalAgentConfigSession {
    constructor({ host, operations }) { this.host = host; this.operations = operations; }
    async handleAgentConfigApplyRequest(message) {
      calls.push(["handler", message.config]);
      if (message.config.modeId !== undefined) await this.operations.setMode(message.agentId, message.config.modeId);
      if (message.config.options) await this.operations.setOptions(message.agentId, message.config.options);
      this.host.emit({ type: "agent.config.apply.response", payload: { accepted: true, notice: null } });
    }
  }
  const session = {
    async setMode(mode) { calls.push(["mode", mode]); native.approvalPolicy = "on-request"; },
    async applyOptions(options) { calls.push(["options", options]); native.serviceTier = options.service_tier; },
    async buildTurnStartParams() { return { params: { threadId: "thread", input: [], ...native } }; },
  };
  let requestCount = 0;
  const request = async () => { requestCount++; throw new Error("native rejected permission"); };
  const args = { AgentConfigApplySchema: { parse: value => value }, AgentConfigSession: OriginalAgentConfigSession, logger: {}, session, threadId: "thread-1", request };

  await assert.rejects(applySharedCodexConfig({ ...args, config: { modeId: "restricted" } }), /다시 열어/);
  await assert.rejects(applySharedCodexConfig({ ...args, config: { modeId: "restricted" } }), /다시 열어/);
  await assert.rejects(applySharedCodexConfig({ ...args, config: { options: { service_tier: "fast" } } }), /다시 열어/);
  assert.equal(requestCount, 1);
  assert.deepEqual(calls, [["handler", { modeId: "restricted" }], ["mode", "restricted"]]);

  const recovered = { ...session, async buildTurnStartParams() { return { params: { threadId: "thread", input: [], ...native } }; } };
  const recoveredRequests = [];
  await applySharedCodexConfig({ ...args, session: recovered, request: async (method, params) => recoveredRequests.push({ method, params }), config: { options: { service_tier: "fast" } } });
  assert.deepEqual(recoveredRequests, [{ method: "thread/settings/update", params: { threadId: "thread-1", serviceTier: "fast" } }]);
});
