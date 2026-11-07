// 새 MCP 명령이 메인 옛 처리기로 가면 실패
// - 메인 옛 처리기로 가면 그 명령을 고칠 때마다 앱 재시작이 필요해짐(작업 프로세스 분리의 목적)
// - 이름은 도구 소스에서 직접 읽음 · 목록을 손으로 적으면 새 도구가 빠져도 통과함
// 새 명령은 server/mcp-worker 처리기 + COMMAND_ROUTES worker 로 추가. 메인에만 둘 이유가 있으면 아래 MAIN_ONLY 에 이유와 함께 적음
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createWorkerBrowserService } from "../server/mcp-worker/browser-service.js";
import { createQaExecutor } from "../server/mcp-worker/qa-service.js";
import * as contract from "../server/mcp-worker/relay-contract.js";

// 메인이 알리는 기능 전부(native/electron/cdp-control.cjs features)
const WORKER_FEATURES = Object.entries(contract).filter(([k]) => k.endsWith("_FEATURE")).map(([, v]) => v);
const read = (file) => fs.readFileSync(new URL(file, import.meta.url), "utf8");
const MAIN_ONLY = new Map([
  // host 확인 창 연산(qa-service.js 가 browser.dialogState·dialogAnswer 로 처리, 메인 처리기 아님)
  ["qa-dialog-state", "host 연산"], ["qa-dialog-answer", "host 연산"],
]);

function fakeHost() {
  const relays = [];
  const call = async (operation, input = {}) => {
    if (operation === "browser.status") return { executor: { features: WORKER_FEATURES } };
    if (operation === "browser.commandTargetState") return { target: { tabId: "tab-1", targetToken: { wcId: 7, generation: "g1" } } };
    if (operation === "browser.resolveForCommand") return { tabId: input.tabId, targetToken: { wcId: 7, generation: "g1" } };
    if (operation === "browser.executeWithDialog") {
      relays.push({ command: input.relay.command, unit: input.relay.unit?.command ?? null });
      if (input.relay.command === "result.redact") return { ok: true, commandState: "completed", data: { value: input.relay.args.value } };
      return { ok: true, commandState: "completed", data: {} };
    }
    return {};
  };
  let current = { commandId: "c1", identity: { session: "pane", run: "run-1", key: "key-1" } };
  const hostApi = { call, current: () => current, onRelayEvent: () => () => {},
    withCommand: async (next, fn) => { const prev = current; current = next; try { return await fn(); } finally { current = prev; } } };
  return { hostApi, relays };
}
const legacyEnvelope = (relays, name) => relays.some(r => r.command === name && r.unit == null);

test("iris-mcp 가 보내는 명령은 모두 작업 프로세스나 서버 세션 연산으로 간다", async () => {
  const names = [...new Set([...read("../bin/iris-mcp.mjs").matchAll(/\bC\("([a-z][a-z-]*)"/g)].map(m => m[1]))];
  assert.ok(names.length >= 40, `도구 소스에서 읽은 이름이 너무 적음: ${names.length}`);
  const leaked = [];
  for (const name of names) {
    const { hostApi, relays } = fakeHost();
    const service = createWorkerBrowserService({ hostApi, activity: { run: (_kind, _id, fn) => fn(), hold: () => () => {} } });
    await service.dispatch({ command: name, args: {}, identity: { session: "pane" }, commandId: `c-${name}` }).catch(() => {});
    if (legacyEnvelope(relays, name) && !MAIN_ONLY.has(name)) leaked.push(name);
  }
  assert.deepEqual(leaked, [], "메인 옛 처리기로 가는 명령");
});

test("iris-qa 채널이 실행기에 보내는 이름은 모두 작업 프로세스로 간다", async () => {
  const source = read("../server/qa-channel.js");
  const view = /const VIEW = new Set\(\[([^\]]*)\]\)/.exec(source)?.[1].match(/"([a-z-]+)"/g).map(s => s.slice(1, -1)) || [];
  // state.mobile.execute 는 모바일 실행기(qa-mobile.js) 몫이라 제외
  const literals = [...source.matchAll(/(?<!mobile\.)\bexecute\([^,()]*(?:\([^)]*\))?, *"([a-z][a-z-]*)"/g)].map(m => m[1]);
  const history = /history: withExpectation\(object\(\{ action: choice\(([^)]*)\)/.exec(read("../server/qa-protocol.js"))?.[1].match(/"([a-z]+)"/g).map(s => s.slice(1, -1)) || [];
  const names = [...new Set([...view, ...literals, ...history])];
  assert.ok(view.length && history.length && literals.length >= 10, `QA 소스에서 이름을 읽지 못함: ${names.join(" ")}`);
  const leaked = [];
  for (const name of names) {
    if (MAIN_ONLY.has(name)) continue;
    const { hostApi, relays } = fakeHost();
    await createQaExecutor({ hostApi }).execute("tab-1", name, {}).catch(() => {});
    const relayName = ({ screenshot: "qa-screenshot", observe: "qa-observe", viewport: "qa-viewport" })[name] || name;
    if (legacyEnvelope(relays, relayName)) leaked.push(name);
  }
  assert.deepEqual(leaked, [], "메인 옛 처리기로 가는 QA 이름");
});
