import assert from "node:assert/strict";
import test from "node:test";

import { bootCapabilities } from "../web/js/core/capability-boot.js";
import { clearHooks, hasHook } from "../web/js/core/hooks.js";

// 진짜 Chrome 미러가 bridge 유무에 따라 내는 결과. native bridge 가 전혀 없는 창은 조용히 미지원이고,
// bridge 가 있는데 미러 함수가 빠졌으면 사용자가 알 수 있어야 한다.
const item = { id: "chromemirror", load: () => import("../web/js/browser/chrome-mirror-surface.js") };
async function boot(acHost) {
  clearHooks();
  const errors = [];
  const loaded = await bootCapabilities({
    items: [item], ctx: { acHost, showToast: () => {}, getWebviewEntries: () => [] },
    onError: (id, e) => errors.push(`${id}: ${e.message}`),
  });
  return { loaded, errors };
}

test("bridge 가 전혀 없으면 오류 없이 미지원으로 끝난다", async () => {
  const r = await boot(undefined);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.loaded, ["chromemirror"]);
  assert.equal(hasHook("mirror.command"), false);
});

test("bridge 에 미러 함수가 빠졌으면 오류로 알린다", async () => {
  const r = await boot({ writeClipboard: async () => true });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /preload bridge/);
  assert.deepEqual(r.loaded, []);
});

test("bridge 가 갖춰져 있으면 미러 훅을 둔다", async () => {
  const fn = () => {};
  const r = await boot({ mirrorStart: fn, mirrorInput: fn, mirrorResize: fn, mirrorStop: fn, onMirrorFrame: fn, onMirrorMeta: fn });
  assert.deepEqual(r.errors, []);
  assert.equal(hasHook("mirror.command"), true);
});
