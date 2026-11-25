import assert from "node:assert/strict";
import test from "node:test";

import { consoleAsk, notifyHostUser, progressHostUser, initBrowserCommands } from "../server/browser-commands.js";
import { controlSnapshot, initBrowserRuntime, markControl, releaseControl, releaseSessionControl } from "../server/browser-runtime.js";
import { createIndexUserPorts } from "../server/mcp-host/index.js";

initBrowserRuntime({ broadcast: () => {} });
initBrowserCommands({ broadcast: () => {} });
const busy = () => Object.fromEntries(controlSnapshot().map((tab) => [tab.tabId, tab.labels.length]));

// 사람에게 넘긴 탭이 AI 조작 중으로 남으면 그 탭의 저장된 계정 자동 완성이 막힘
test("세션의 조작 표시를 지우면 그 세션 것만 지워지고 다른 세션 표시는 남는다", () => {
  markControl("t-a", "pane-1");
  markControl("t-a", "pane-2");
  markControl("t-b", "pane-1");
  try {
    releaseSessionControl("pane-1", "t-a");
    assert.deepEqual(busy(), { "t-a": 1, "t-b": 1 });
    releaseSessionControl("pane-1");
    assert.deepEqual(busy(), { "t-a": 1 });
  } finally { releaseControl("t-a"); releaseControl("t-b"); }
});

test("세션이 사람에게 물으면 그 세션의 조작 표시가 지워진다", async () => {
  const user = createIndexUserPorts({ consoleAsk, notifyHostUser, progressHostUser, releaseSessionControl });
  markControl("t-c", "pane-ask");
  markControl("t-c", "pane-other");
  try {
    await user.ask({ identity: { session: "pane-ask" }, input: { message: "로그인해 주세요" } });
    assert.deepEqual(busy(), { "t-c": 1 });
  } finally { releaseControl("t-c"); }
});

test("QA 회차의 질문은 조작 표시를 지우지 않는다", async () => {
  const user = createIndexUserPorts({ consoleAsk, notifyHostUser, progressHostUser, releaseSessionControl });
  markControl("t-q", "iris-qa");
  try {
    await user.ask({ identity: { session: "pane-q", run: "qa-1" }, input: { message: "확인해 주세요" } });
    assert.deepEqual(busy(), { "t-q": 1 });
  } finally { releaseControl("t-q"); }
});
