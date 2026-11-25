import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

for (const name of ["iris-mcp", "iris-qa"]) {
  test(name + "는 잘못된 JSON 값 뒤의 ping을 처리한다", () => {
    const result = spawnSync(process.execPath, ["bin/" + name + ".mjs"], {
      input: 'null\n{"jsonrpc":"2.0","method":"ping","id":1}\n', encoding: "utf8", timeout: 3000,
    });
    assert.equal(result.status, 0, result.stderr);
    const messages = result.stdout.trim().split("\n").map(JSON.parse);
    assert.ok(messages.some(m => m.error?.code === -32600));
    assert.ok(messages.some(m => m.id === 1 && m.result));
  });
}
