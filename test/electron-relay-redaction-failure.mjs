import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createElectronRelay } = require("../native/electron/relay/index.cjs");

test("비밀 가리기가 실패하면 중계 결과 원문을 반환하지 않는다", async () => {
  const relay = createElectronRelay({
    webContents: { fromId: () => null },
    targetState: { generations: () => ({}), ownsChildSession: () => false },
    currentUrl: () => "",
    pendingUrl: () => "",
    blockedUrl: () => false,
    redact: () => { throw new Error("redaction unavailable"); },
    codedError: (code, message) => Object.assign(new Error(message), { code }),
    qaAnchor: async () => ({ ok: true, data: { accepted: true } }),
  });
  await relay.acceptGeneration("boot:1");

  await assert.rejects(() => relay.execute({
    workerGeneration: "boot:1",
    commandId: "boot:1/1",
    callId: "1",
    command: "qa.anchor",
    args: { run: "run-1", runId: "run-1" },
  }), (error) => error.code === "REDACTION_FAILED" && !String(error.message).includes("accepted"));
});
