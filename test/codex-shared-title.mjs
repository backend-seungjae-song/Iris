import assert from "node:assert/strict";
import test from "node:test";
import { codexTerminalTitleIdentity, codexTerminalTitleMatches, matchSharedCodexTitle } from "../server/paseo-ui/codex-shared-daemon.mjs";

const threadId = "01a21062-e122-7771-9d4c-94e0fa6942bc";
const printed = threadId.slice(0, 29) + "...";

test("Codex title retains an unambiguous native UUID prefix while waiting and running", () => {
  for (const title of [printed, `${printed} Codex | iris`, `[ ! ] Action Required | ${printed} | Codex`]) {
    assert.equal(codexTerminalTitleIdentity(title), threadId.slice(0, 29));
    assert.equal(codexTerminalTitleMatches(title, threadId), true);
    assert.equal(codexTerminalTitleMatches(title, "01a21062-e122-7771-9d4c-1234567890ab"), false);
  }
  assert.equal(codexTerminalTitleMatches(threadId, threadId), true);
  assert.equal(codexTerminalTitleIdentity("project-only"), null);
  assert.equal(codexTerminalTitleIdentity(`${printed} | 01a21062-e122-7771-9d4c-12345...`), null);
});

test("only a single live app-server thread can resolve the truncated OSC identity", async () => {
  const rpc = data => async (method, params) => {
    assert.equal(method, "thread/loaded/list");
    if (!params.cursor) return { data: data.slice(0, 1), nextCursor: "after-first" };
    return { data: data.slice(1), nextCursor: null };
  };
  assert.equal(await matchSharedCodexTitle(rpc([threadId]), printed), threadId);
  assert.equal(await matchSharedCodexTitle(rpc([]), printed), null);
  assert.equal(await matchSharedCodexTitle(rpc([threadId, threadId.slice(0, 29) + "7654321"]), printed), null);
});
