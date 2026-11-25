import assert from "node:assert/strict";
import test from "node:test";

import { watchHerdrChat } from "../server/paseo-ui/herdr-chat.mjs";

test("대화 보기를 다시 열면 Herdr의 최근 400줄에서 이전 턴을 읽는다", async () => {
  const pane = { terminal_id: "term", agent: "OpenCode", agent_status: "idle", agent_session: { value: "session" } };
  const sent = [], reads = [];
  const herdr = {
    paneGet: async () => pane,
    paneRead: async (...args) => { reads.push(args); return { text: "이전 턴\nOpenCode 화면" }; },
    agentSend: async (...args) => sent.push(args),
  };
  const frames = [];
  const connection = await watchHerdrChat({
    agent: { paneId: "pane", terminalId: "term", sessionUuid: "session", agent: "opencode" },
    herdr, onFrame: frame => frames.push(frame), onError: assert.fail,
  });
  try {
    assert.deepEqual(reads[0], ["pane", "recent", "text", true, 400]);
    assert.equal(frames[0].timeline[0].message, "이전 턴\nOpenCode 화면");
    await connection.action({ type: "agentchat.send", text: "hello" });
    assert.deepEqual(sent, [["pane", "hello"]]);
  } finally {
    connection.close();
  }
});
