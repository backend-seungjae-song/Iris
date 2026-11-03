import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { BASE_COMMANDS } = require("../native/electron/relay/index.cjs");

test("등록된 모든 기본 명령에 실행 분기가 있다", () => {
  const source = fs.readFileSync(new URL("../native/electron/relay/index.cjs", import.meta.url), "utf8");
  const cases = new Set([...source.matchAll(/case\s+"([^"]+)"/g)].map((match) => match[1]));
  assert.deepEqual([...BASE_COMMANDS].filter((command) => !cases.has(command)), []);
});
