// QA 채널의 일반 이름(goto·url·snapshot·text·diff·wait·back·forward·reload)은 메인이 기능을 알리면 worker 처리기, 아니면 옛 봉투
import test from "node:test";
import assert from "node:assert/strict";
import { createQaExecutor, QA_GENERIC_NAMES } from "../server/mcp-worker/qa-service.js";

const UNIT = "worker-command-unit", QA = "worker-qa-input-commands", PAGE = "worker-page-commands";

function fakeHost(features) {
  const relays = [];
  const call = async (operation, input) => {
    if (operation === "browser.status") return { executor: { features } };
    if (operation === "browser.resolveForCommand") return { tabId: input.tabId, targetToken: { wcId: 7, generation: "g1" } };
    if (operation === "browser.executeWithDialog") {
      relays.push({ command: input.relay.command, unit: input.relay.unit?.command ?? null, label: input.controlLabel });
      if (input.relay.command === "result.redact") return { ok: true, commandState: "completed", data: { value: input.relay.args.value } };
      if (input.relay.command === "wc.info") return { ok: true, commandState: "completed", data: { url: "https://example.test/", title: "시험" } };
      return { ok: true, commandState: "completed", data: {} };
    }
    throw new Error("예상하지 못한 호출: " + operation);
  };
  let current = { commandId: "c1", identity: { session: "pane", run: "run-1", key: "key-1" } };
  const hostApi = { call, current: () => current, withCommand: async (next, fn) => { const prev = current; current = next; try { return await fn(); } finally { current = prev; } } };
  return { hostApi, relays };
}

test("일반 이름 목록은 QA 채널이 보내는 아홉 이름", () => {
  assert.deepEqual([...QA_GENERIC_NAMES].sort(), ["back", "diff", "forward", "goto", "reload", "snapshot", "text", "url", "wait"]);
});

test("메인이 단위 실행을 알리면 url 은 worker 처리기로 wc.info 를 QA 표시로 부름", async () => {
  const { hostApi, relays } = fakeHost([UNIT, QA, PAGE]);
  const out = await createQaExecutor({ hostApi }).execute("tab-1", "url", {});
  assert.equal(out.ok, true);
  assert.deepEqual(out.data, { url: "https://example.test/", title: "시험" });
  const info = relays.find(r => r.command === "wc.info");
  assert.deepEqual(info, { command: "wc.info", unit: "url", label: "iris-qa" });
  assert.equal(relays.some(r => r.command === "url"), false);
});

test("메인이 페이지 기능을 알리지 않으면 goto 는 옛 봉투로 보냄", async () => {
  const { hostApi, relays } = fakeHost([UNIT, QA]);
  await createQaExecutor({ hostApi }).execute("tab-1", "goto", { url: "https://example.test/" });
  assert.equal(relays.at(-1).command, "goto");
  assert.equal(relays.at(-1).unit, null);
});

test("메인이 단위 실행을 알리지 않으면 url 은 옛 봉투", async () => {
  const { hostApi, relays } = fakeHost([]);
  await createQaExecutor({ hostApi }).execute("tab-1", "url", {});
  assert.deepEqual(relays.map(r => [r.command, r.unit]), [["qa-mode", null], ["url", null]]);
});
