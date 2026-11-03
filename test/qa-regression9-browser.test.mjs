import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createQaChannel } from "../server/qa-channel.js";
import { splitQaRestoreTabs } from "../server/browser-commands.js";
import { qaCharter, qaPlan } from "./qa-fixtures.mjs";

function extracted(name, deps, asyncFn = false) {
  const source = fs.readFileSync(new URL("../server/browser-commands.js", import.meta.url), "utf8");
  const start = source.indexOf(`${asyncFn ? "async " : ""}function ${name}`);
  const end = source.indexOf("\nexport ", start);
  const body = source.slice(start, end);
  const Factory = asyncFn ? Object.getPrototypeOf(async function () {}).constructor : Function;
  return new Factory(...Object.keys(deps), `${body}; return ${name};`)(...Object.values(deps));
}

test("createTabForSession allows QA about:blank and rejects ordinary about:blank", async () => {
  const opened = [];
  const create = extracted("createTabForSession", {
    reusableTabFor: () => null, sessionSpace: () => "space", cdpExecutorReady: () => true,
    newTabId: () => "tab-1", ensureSessionGroup: () => "group", profileRefToId: () => null,
    bsMutate: (_x) => { opened.push(_x); return true; }, claimQaTab: () => {}, broadcast: () => {},
    wakeSleepingTab: () => {}, waitForTabWc: async () => ({}), setLastTab: () => {}, handleFor: () => "h",
    sessionGroupName: () => "group", sessionLabel: () => "group", hasProfiles: () => false, profileNames: () => [], bsWire: () => ({}),
  });
  assert.equal((await create({ url: "about:blank", parallel: true }, "owner")).ok, false);
  assert.equal((await create({ url: "about:blank", parallel: true }, "owner", "qa-1")).ok, true);
  assert.equal(opened.length, 1);
});

test("restoreQaTabs registers pane before ownership and wakes only its group", async () => {
  const order = [], waits = [], woken = [];
  const registered = new Set();
  const restore = await extracted("restoreQaTabs", {
    HerdrClient: class { async paneGet() { return { pane_id: "owner", workspace_id: "space" }; } },
    rememberQaPane: () => order.push("remember"), sessionSpace: () => "space", sessionGroupId: () => "group",
    groupTabIds: () => { order.push("group"); return new Set(["mine"]); }, hasTab: (id) => registered.has(id), wakeSleepingTab: (id) => { woken.push(id); },
    waitForTabWc: async (id) => { await Promise.resolve(); waits.push(id); registered.add(id); return {}; }, qaOwner: () => null, claimQaTab: () => {},
    publishQaTabs: () => order.push("publish"), splitQaRestoreTabs, tabExistsInState: (id) => id === "foreign",
  }, true);
  const result = await restore("owner", ["mine"], "run");
  assert.equal(result.ok, true);
  assert.deepEqual(order, ["remember", "group", "publish"]);
  assert.deepEqual(woken, ["mine"]); assert.deepEqual(waits, ["mine"]);
  const rejected = await restore("owner", ["foreign"], "run");
  assert.equal(rejected.ok, false);
  assert.deepEqual(woken, ["mine"]);
  // 어디에도 없는 탭은 닫힌 것으로 빼고 이어받음
  const gone = await restore("owner", ["mine", "closed-outside"], "run");
  assert.equal(gone.ok, true, JSON.stringify(gone));
  assert.deepEqual(gone.data, { tabs: ["mine"], gone: ["closed-outside"] });
});

test("restoreQaTabs 는 자기 그룹 탭이 깨어나지 않았을 때 소유권 오류가 아닌 재시도 안내를 돌려준다", async () => {
  const restore = await extracted("restoreQaTabs", {
    HerdrClient: class { async paneGet() { return { pane_id: "owner", workspace_id: "space" }; } },
    rememberQaPane: () => {}, sessionSpace: () => "space", sessionGroupId: () => "group",
    groupTabIds: () => new Set(["mine"]), hasTab: () => false, wakeSleepingTab: () => {},
    waitForTabWc: async () => null, qaOwner: () => null, claimQaTab: () => {}, publishQaTabs: () => {},
    splitQaRestoreTabs, tabExistsInState: () => false,
  }, true);
  const result = await restore("owner", ["mine"], "run");
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.error, /소유권/);
  assert.match(result.error, /다시 호출/);
});

function ledgerFixture() {
  const events = [];
  return {
    events,
    begin: async ({ runId, session, plan, charter }) => {
      events.push({ seq: events.length + 1, event: { kind: "run_begin", session, plan, charter } });
      return events.at(-1);
    },
    append: async (_runId, event) => {
      const receipt = { seq: events.length + 1, event };
      events.push(receipt);
      return receipt;
    },
    verify: async () => ({ events: structuredClone(events), head: "test" }),
  };
}

function channel(ledger, restored) {
  return createQaChannel({
    ledger,
    createEntry: async () => ({ ok: true, data: { tabId: "entry-tab" } }),
    restore: async (...args) => { restored.push(args); return { ok: true }; },
    execute: async () => ({ ok: true, data: {} }),
    release: async () => {},
    ask: async () => ({ ok: true, data: { answer: "승인" } }),
    mobileFactory: () => ({}),
    makeRoutes: () => ({ list: async () => [] }),
  });
}

test("run_resume chooses only tabs recorded by entry events", async () => {
  const ledger = ledgerFixture();
  const restored = [];
  const first = channel(ledger, restored);
  const begun = await first("run_begin", { plan: qaPlan({ entries: ["http://localhost:4321/start"] }), charter: qaCharter() }, "owner");
  assert.equal(begun.ok, true, JSON.stringify(begun));
  const runId = begun.data.runId;
  await ledger.append(runId, { kind: "entry", tab: "entry-tab", url: "http://localhost:4321/start" });
  await ledger.append(runId, { kind: "action", tab: "screen-handle-42", cmd: "click" });

  const resumed = await channel(ledger, restored)("run_resume", {}, "owner", runId);
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.deepEqual(restored, [["owner", ["entry-tab"], runId]]);
  assert.deepEqual(resumed.data.tabs, ["entry-tab"]);
  assert.equal(resumed.data.tab, "entry-tab");
  assert.equal(resumed.data.tabs.includes("screen-handle-42"), false);
});
