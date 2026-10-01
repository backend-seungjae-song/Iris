import assert from "node:assert/strict";
import test from "node:test";

import { cleanMacName, readMacName } from "../server/remote/mac-name.js";

test("Mac 컴퓨터 이름은 제어 문자를 제거하고 64자로 제한한다", () => {
  assert.equal(cleanMacName("  작업\nMac\u0000  "), "작업 Mac");
  assert.equal([...cleanMacName("가".repeat(80))].length, 64);
});

test("Mac 설정의 ComputerName을 셸 없이 읽는다", async () => {
  const calls = [];
  const name = await readMacName({
    execFile: async (...args) => { calls.push(args); return { stdout: "거실 Mac\n" }; },
    hostname: () => "fallback",
  });
  assert.equal(name, "거실 Mac");
  assert.deepEqual(calls[0][0], "/usr/sbin/scutil");
  assert.deepEqual(calls[0][1], ["--get", "ComputerName"]);
});

test("ComputerName을 읽지 못하면 안전한 호스트 이름을 쓴다", async () => {
  const name = await readMacName({
    execFile: async () => { throw new Error("missing"); },
    hostname: () => "대체\u0000 Mac",
  });
  assert.equal(name, "대체 Mac");
});
