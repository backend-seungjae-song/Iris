import assert from "node:assert/strict";
import test from "node:test";
import { createQaChannel } from "../server/qa-channel.js";
import { qaPlan } from "./qa-fixtures.mjs";

// qa_close_tab 뒤에도 그 탭의 반응 관찰이 남아 run_end 의 반응 수거가 닫힌 탭에서 실패했음(2026-11-02 qa-21a6a1d3)

const charter = {
  question: "탭을 닫은 회차를 끝낼 수 있는가", scope: "탭 닫기", exclusions: "없음",
  environment: "격리된 대역", sharedEnvironment: false, timebox: "1분", people: "없음", documents: "없음",
};
const sessionRecord = {
  work: "탭 닫기 확인", curios: "없음", checked: "탭 닫기 뒤 종료",
  unverified: { items: "없음", reason: "해당 없음" }, blockers: "없음", outOfScope: "없음", risks: "없음",
  stopCriterion: "questions_answered", remainingQuestions: "없음",
};

function channel({ drainFails = false } = {}) {
  const events = [], sent = [], closedTabs = new Set(), closedAfter = [];
  const append = async (_id, event) => { const record = { seq: events.length + 1, event: structuredClone(event) }; events.push(record); return record; };
  const ledger = {
    begin: async ({ runId, session, plan, charter }) => append(runId, { kind: "run_begin", session, plan, charter }),
    verify: async () => ({ events: structuredClone(events), head: "test-head" }),
    end: async (id, { session }) => append(id, { kind: "run_end", sessionRecord: session }),
    append,
  };
  const call = createQaChannel({ ledger,
    createEntry: async () => ({ ok: true, data: { tabId: "test-tab" } }),
    // 실제 앱처럼 닫힌 탭의 명령은 탭을 찾지 못함
    execute: async (tab, cmd, args) => {
      sent.push({ tab, cmd, args });
      if (closedTabs.has(tab)) closedAfter.push({ tab, cmd });
      if (closedTabs.has(tab)) return { ok: false, error: "명령을 실행할 탭을 찾지 못했습니다." };
      if (drainFails && cmd === "qa-reaction-drain") return { ok: false, error: "확인 창이 열려 있습니다." };
      if (cmd === "qa-background-observe") return { ok: true, data: { id: "bg-1", candidates: [] } };
      return { ok: true, data: { candidates: [], unexpected: [], events: [] } };
    },
    release: async () => {}, close: async (tab) => { closedTabs.add(tab); },
    ask: async () => ({ ok: true, data: { answer: "승인" } }), makeRoutes: () => ({ list: async () => [] }),
  });
  return { call, events, sent, closedAfter, closeOutside: tab => closedTabs.add(tab) };
}

test("qa_close_tab 으로 닫은 탭의 반응 관찰은 run_end 를 막지 않는다", async () => {
  const c = channel();
  const begun = await c.call("run_begin", { plan: qaPlan({ entries: ["http://localhost:4321/start"] }), charter }, "s");
  assert.equal(begun.ok, true, JSON.stringify(begun));
  const run = begun.data.runId;
  const send = (cmd, args = {}) => c.call(cmd, args, "s", run);
  assert.equal((await send("open_entry", { url: "http://localhost:4321/start" })).ok, true);
  const closed = await send("close_tab", { tab: "test-tab" });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  const ended = await send("run_end", { session: sessionRecord });
  assert.equal(ended.ok, true, JSON.stringify(ended));
  // 닫기 전에 반응을 수거하고, 닫은 뒤에는 그 탭에 명령을 보내지 않음
  assert.equal(c.closedAfter.some(item => item.tab === "test-tab"), false, JSON.stringify(c.closedAfter));
  assert.ok(c.sent.some(item => item.cmd === "qa-reaction-drain" && item.tab === "test-tab"));
});

test("도구 밖에서 닫힌 탭의 반응 관찰도 run_end 를 막지 않는다", async () => {
  const c = channel();
  const begun = await c.call("run_begin", { plan: qaPlan({ entries: ["http://localhost:4321/start"] }), charter }, "s");
  const run = begun.data.runId;
  const send = (cmd, args = {}) => c.call(cmd, args, "s", run);
  assert.equal((await send("open_entry", { url: "http://localhost:4321/start" })).ok, true);
  c.closeOutside("test-tab");
  const ended = await send("run_end", { session: sessionRecord });
  assert.equal(ended.ok, true, JSON.stringify(ended));
});

test("반응 수거가 실패해도 qa_close_tab 은 탭을 닫는다", async () => {
  const c = channel({ drainFails: true });
  const begun = await c.call("run_begin", { plan: qaPlan({ entries: ["http://localhost:4321/start"] }), charter }, "s");
  const run = begun.data.runId;
  const send = (cmd, args = {}) => c.call(cmd, args, "s", run);
  assert.equal((await send("open_entry", { url: "http://localhost:4321/start" })).ok, true);
  const closed = await send("close_tab", { tab: "test-tab" });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  assert.equal((await send("run_end", { session: sessionRecord })).ok, true);
});
