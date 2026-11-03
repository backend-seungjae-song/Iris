// absent 기대: 조작 뒤 관찰이 끝날 때 대상이 없으면 통과. 고친 코드에서 처음부터 안 뜨는 창의 재확인(O2 15704)
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { validateQaCommand } from "../server/qa-protocol.js";
import { assertQaReplayContract } from "../server/qa-remediation.js";
const { createMobileReaction } = await import("../server/qa-mobile-reaction.js");
const require = createRequire(import.meta.url);
const { createQaReactionCommands } = require("../native/electron/cdp-qa-reaction.cjs");
const oracle = "명세나 대화에서 정한 내용";

test("qa_expect absent 실패의 수정 재확인은 absent 기대로 받는다", () => {
  const events = [
    { seq: 1, event: { kind: "assertion", rowId: "O2", pass: false, expected: { mode: "absent", text: "미스틱 상품 수정" } } },
    { seq: 2, event: { kind: "defect", detail: { failureSeq: 1 } } },
  ];
  const steps = type => [{ action: "click", target: { text: "수정" }, expect: { effects: [{ type, text: "미스틱 상품 수정", oracle }], within: 3000 } }];
  assert.doesNotThrow(() => assertQaReplayContract(events, "O2", steps("absent"), { fixSeq: 3, defect: 2 }));
  assert.doesNotThrow(() => assertQaReplayContract(events, "O2", steps("disappear"), { fixSeq: 3, defect: 2 }));
  assert.throws(() => assertQaReplayContract(events, "O2", steps("appear"), { fixSeq: 3, defect: 2 }), /"type":"absent"/);
});

test("absent 는 text 또는 role·name 이 있어야 하고 모바일 단계에서도 받는다", () => {
  assert.equal(validateQaCommand("click", { x: 1, y: 1, expect: { effects: [{ type: "absent", text: "창", oracle }] } }).expect.effects[0].type, "absent");
  assert.throws(() => validateQaCommand("click", { x: 1, y: 1, expect: { effects: [{ type: "absent", oracle }] } }), /absent/);
  assert.doesNotThrow(() => validateQaCommand("app_tap", { x: 1, y: 1, expect: { effects: [{ type: "absent", text: "창", oracle }] } }));
});

const el = (label, type = "StaticText") => ({ type, AXLabel: label, frame: { x: 10, y: 10, width: 10, height: 10 } });
const mobile = async after => {
  let tapped = false;
  const watch = createMobileReaction({ before: [el("목록")], expect: { effects: [{ type: "absent", text: "미스틱 상품 수정", oracle }], within: 300 },
    action: { command: "tap", args: { x: 1, y: 1 } }, identity: { targetId: "phone" }, interval: 10, tailMs: 1, operationTimeoutMs: 1000,
    readTree: async () => tapped ? after : [el("목록")], capture: async () => ({ path: "shot.png" }) });
  await watch.initial(); watch.arm(); tapped = true; watch.delivered(true);
  const result = await watch.finish(); await watch.stop();
  return result;
};

test("모바일 absent 는 관찰이 끝날 때 대상이 없으면 통과하고, 있으면 이유를 적어 실패한다", async () => {
  const gone = await mobile([el("목록")]);
  assert.equal(gone.pass, true);
  assert.equal(gone.candidates.some(item => item.code === "K3"), false);
  const shown = await mobile([el("목록"), el("미스틱 상품 수정")]);
  assert.equal(shown.pass, false);
  assert.match(shown.candidates.find(item => item.code === "K1").description, /관찰이 끝날 때 대상이 화면에 있음/);
});

const web = async found => {
  let clock = 0;
  const snapshot = { effects: [{ id: "e1", found, text: found ? "미스틱 상품 수정" : null }], bodyText: "화면", visibleElements: 1, busy: [], broken: [] };
  const send = async method => method === "Page.getFrameTree" ? { frameTree: { frame: { id: "main" } } } : method === "Page.createIsolatedWorld" ? { executionContextId: 1 }
    : method === "Runtime.evaluate" ? { result: { value: snapshot } } : {};
  const commands = createQaReactionCommands({ observation: { subscribeEvents() {} }, screenshot: async () => ({ path: "scene.png" }), now: () => clock, sleep: async ms => { clock += ms; } });
  const { id } = await commands["qa-reaction-start"](send, { id: 1 }, { expect: { effects: [{ type: "absent", text: "미스틱 상품 수정", oracle }], within: 60 }, action: "click", target: { x: 1, y: 1 } });
  return commands["qa-reaction-end"](send, { id: 1 }, { id, delivered: true });
};

test("웹 absent 는 관찰이 끝날 때 대상이 없으면 통과하고, 있으면 이유를 적어 실패한다", async () => {
  const gone = await web(false);
  assert.equal(gone.pass, true);
  assert.equal(gone.candidates.some(item => item.code === "K3"), false);
  const shown = await web(true);
  assert.equal(shown.pass, false);
  assert.match(shown.candidates.find(item => item.code === "K1").description, /관찰이 끝날 때 대상이 화면에 있음/);
});
