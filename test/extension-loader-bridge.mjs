import assert from "node:assert/strict";
import test from "node:test";

import { bootCapabilities } from "../web/js/core/capability-boot.js";
import { clearHooks, hasHook, callHook } from "../web/js/core/hooks.js";

// 확장 로더가 네 환경에서 내는 결과. native bridge 가 전혀 없는 창은 조용히 미지원이고,
// bridge 가 불완전하거나 실제 로드가 실패하면 사용자가 알 수 있어야 한다.
const item = { id: "extensionloader", load: () => import("../web/js/browser/extension-loader.js") };
async function boot(acHost) {
  clearHooks();
  const errors = [], toasts = [];
  const loaded = await bootCapabilities({
    items: [item], ctx: { acHost, showToast: (m) => toasts.push(m) },
    onError: (id, e) => errors.push(`${id}: ${e.message}`),
  });
  return { loaded, errors, toasts };
}

test("bridge 가 전혀 없으면 오류도 알림도 없이 미지원으로 끝난다", async () => {
  const r = await boot(undefined);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.toasts, []);
  assert.deepEqual(r.loaded, ["extensionloader"]);
  assert.equal(hasHook("extensionloader.before-devtools"), false);
});

test("bridge 가 불완전하면 오류로 알린다", async () => {
  const r = await boot({ enableExtensionLoader: async () => ({ ok: true, results: [] }) });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /native bridge/);
  assert.deepEqual(r.loaded, []);
  const r2 = await boot({});
  assert.equal(r2.errors.length, 1);
});

test("로드에 성공하면 성공 알림과 DevTools 전 대기 훅을 둔다", async () => {
  const ok = { ok: true, partition: "persist:acbrowser" };
  const r = await boot({ enableExtensionLoader: async () => ({ ok: true, results: [ok] }), waitForExtension: async () => ok });
  assert.deepEqual(r.errors, []);
  assert.match(r.toasts[0], /1개 세션에 로드/);
  assert.deepEqual(await callHook("extensionloader.before-devtools", { partition: "persist:acbrowser" }), ok);
});

test("실제 로드가 실패하면 실패 알림을 내고 DevTools 전 대기도 실패한다", async () => {
  const bad = { ok: false, partition: "persist:acbrowser", stage: "load" };
  const r = await boot({ enableExtensionLoader: async () => ({ ok: false, results: [bad] }), waitForExtension: async () => bad });
  assert.match(r.toasts[0], /로드 실패: persist:acbrowser\(load\)/);
  await assert.rejects(() => callHook("extensionloader.before-devtools", { partition: "persist:acbrowser" }), /확장 준비 실패/);
});
