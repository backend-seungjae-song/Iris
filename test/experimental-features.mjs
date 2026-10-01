import test from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES } from "../web/js/core/capabilities.js";
import { bootCapabilities } from "../web/js/core/capability-boot.js";
import { createCapabilityHost } from "../server/capabilities.js";

const ids = ["diffreview", "unifiedsearch", "notifications", "worktrees", "githubpr"];
test("임시 기능 다섯 개는 각각 꺼진 채 부팅하면 모듈을 읽지 않는다", async () => {
  for (const id of ids) {
    const original = CAPABILITIES.find((cap) => cap.id === id);
    assert.ok(original, id);
    let reads = 0;
    const loaded = await bootCapabilities({ items: [{ ...original, load: async () => { reads++; throw new Error("off module loaded"); } }],
      isOn: (value) => value !== id, onError: (_id, error) => { throw error; } });
    assert.equal(reads, 0); assert.deepEqual(loaded, []);
  }
});
test("서버 기능을 끄면 새 메시지는 처리하지 않는다", () => {
  // 이 검사는 init 없이 dispatch만 확인하므로 별도 lifecycle이 필요한 원격 기능도 끈다.
  const disabled = new Set([...ids, "remote"]);
  const host = createCapabilityHost(disabled, {});
  const ws = { readyState: 1, _local: true, send: () => { throw new Error("disabled capability replied"); } };
  for (const type of ["diffreview.draft", "githubpr.status", "githubpr.log", "githubpr.draft",
    "worktrees.list", "worktrees.create", "worktrees.remove"])
    assert.equal(host.handle(ws, { type }), false, type);
});
