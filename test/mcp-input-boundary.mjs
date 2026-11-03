import assert from "node:assert/strict";
import test from "node:test";

import { workerUsesInputBaseCommand } from "../bin/smoke/contracts/mcp-input-boundary.mjs";

test("일반 MCP 명령 코드가 실제 입력 기본 명령을 직접 부르면 검사에서 잡힌다", () => {
  assert.equal(workerUsesInputBaseCommand('relay({ command: "wc.input" })'), true);
  assert.equal(workerUsesInputBaseCommand('relay({ command: "click" })'), false);
});
