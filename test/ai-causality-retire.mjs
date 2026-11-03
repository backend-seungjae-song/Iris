import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createAiCausality } = require("../native/electron/ai-causality.cjs");

test("worker 세대 회수는 AI 인과 유예를 남기지 않는다", () => {
  const causality = createAiCausality({ now: () => 1000, graceMs: 600 });
  const ticket = causality.enter(7);
  assert.equal(causality.driving(7), true);

  causality.leave(ticket, { grace: false });

  assert.equal(causality.driving(7), false);
  assert.equal(causality.anyDriving(), false);
});
