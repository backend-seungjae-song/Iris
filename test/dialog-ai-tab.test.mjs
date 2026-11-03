import assert from "node:assert/strict";
import test from "node:test";
import { createDialogs } from "../server/browser/dialogs.js";

const make = ({ ai = false } = {}) => {
  const sent = [], meta = { space: "s1" };
  const d = createDialogs({ metaOfWc: () => meta, broadcast: (m) => sent.push(m), aiTab: () => ai,
    setTimeoutFn: () => 1, clearTimeoutFn: () => {} });
  return { d, sent, meta };
};

test("AI 가 조작 중인 탭의 확인 창은 ai 표시로 방송하고 사람 탭은 그대로", () => {
  const ai = make({ ai: true });
  ai.d.openDialogAsk(3, "confirm", "주문할까요", () => {});
  assert.equal(ai.sent.at(-1).ai, true);
  assert.equal(ai.meta.dialog.ai, true);
  const human = make();
  human.d.openDialogAsk(3, "alert", "저장됨", () => {});
  assert.equal(human.sent.at(-1).ai, false);
  assert.equal(human.meta.dialog.ai, undefined);
});

test("명령이 응답하기 전에 확인 창이 뜨면 답할 도구를 담아 바로 끝냄", async () => {
  const { d } = make({ ai: true });
  let hung;
  const pending = new Promise((resolve) => { hung = resolve; });
  const raced = d.raceDialog(3, pending, "qa_dialog", { pollMs: 5 });
  d.openDialogAsk(3, "confirm", "로그인할까요", () => {});
  const result = await raced;
  assert.equal(result.ok, false);
  assert.deepEqual(result.dialogOpen, { kind: "confirm", message: "로그인할까요" });
  assert.match(result.error, /qa_dialog로 answer "ok" 또는 "cancel"/);
  hung({ ok: true });
});

test("확인 창이 없으면 명령 결과를 그대로 돌려줌", async () => {
  const { d } = make();
  assert.deepEqual(await d.raceDialog(3, Promise.resolve({ ok: true, data: 1 }), "browser_dialog", { pollMs: 5 }), { ok: true, data: 1 });
  assert.equal((await d.raceDialog(3, Promise.reject(new Error("끊김")), "browser_dialog", { pollMs: 5 })).error, "끊김");
});

test("확인 창 문구를 가리지 못하면 문구를 빼고 돌려줌", async () => {
  const { safeDialogResult } = await import("../server/browser-runtime.js");
  const { d } = make();
  const blocked = d.dialogBlocked({ kind: "alert", message: "비밀번호 hunter22 가 틀렸습니다" }, "qa_dialog");
  const safe = await safeDialogResult(9, blocked, "qa_dialog");
  assert.equal(safe.dialogOpen.message, "(확인 창 문구를 가리지 못해 뺐습니다)");
  assert.doesNotMatch(safe.error, /hunter22/);
  assert.match(safe.error, /qa_dialog로 answer/);
});

test("200자 경계에 걸친 비밀값도 자르기 전에 가림", async () => {
  const runtime = await import("../server/browser-runtime.js");
  const secret = "hunter22secret";
  const ws = { readyState: 1, send(raw) {
    const m = JSON.parse(raw);
    queueMicrotask(() => runtime.resolveCdpResult(ws, { id: m.id, ok: true, data: { text: m.args.text.split(secret).join("[가림]") } }));
  } };
  runtime.registerCdpExecutor(ws, { app: "test", pid: process.pid });
  const { d } = make({ ai: true });
  d.openDialogAsk(9, "alert", "x".repeat(197) + secret + " 가 틀렸습니다", () => {});
  const raced = await d.raceDialog(9, new Promise(() => {}), "qa_dialog", { pollMs: 5 });
  assert.equal(JSON.stringify(raced).includes(secret), false);
  const safe = await runtime.safeDialogResult(9, raced, "qa_dialog");
  assert.doesNotMatch(JSON.stringify(safe), /hun/);
  assert.match(safe.dialogOpen.message, /^x{197}\[가/);
});
