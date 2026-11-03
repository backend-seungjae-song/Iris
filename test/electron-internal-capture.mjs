import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const controlUrl = new URL("../native/electron/cdp-control.cjs", import.meta.url);
const internalCaptureUrl = new URL("../native/electron/relay/internal-capture.cjs", import.meta.url);

test("앱 내부 screenshot은 기존 CDP 캡처 처리기를 유지한다", () => {
  const source = fs.readFileSync(controlUrl, "utf8");
  assert.equal(fs.existsSync(internalCaptureUrl), false);
  assert.doesNotMatch(source, /internal-capture|captureGuestPage|runInternalCapture/);
  assert.match(source, /runCdp:\s*\(webContentsMod, wcId, cmd, args\)\s*=>\s*cdpExec\(webContentsMod, wcId, cmd, args \|\| \{\}\)/);
  assert.match(source, /⑦·⑧/);
});
