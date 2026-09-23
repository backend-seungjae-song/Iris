import test from "node:test";
import assert from "node:assert/strict";
import { bootCapabilities } from "../web/js/core/capability-boot.js";
import { CAPABILITIES } from "../web/js/core/capabilities.js";

let sequence = 0;
const LEGACY = "ac.railHidden";
const MARKER = "ac.railHidden.migrated";
// 기본 꺼짐 기능은 사용자가 켜기 전까지 꺼진 목록에 함께 나온다.
const OPT_IN = CAPABILITIES.filter((c) => c.optIn).map((c) => c.id);
const off = (ids) => new Set([...ids, ...OPT_IN]);
const state = (hidden, extra = {}) => ({ exists: true, revision: 1, hidden, local: true, ...extra });
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function browserStub(t, respond, initial = {}) {
  const storage = new Map(Object.entries(initial));
  const calls = [];
  const saved = new Map(["fetch", "localStorage"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  } });
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(new URL(String(url), "http://127.0.0.1:4295").pathname, "/features");
    const call = { method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null };
    calls.push(call);
    return respond(call, calls.length);
  };
  t.after(() => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return { storage, calls, boot: () => import(`../web/js/core/features.js?feature-test=${++sequence}`) };
}

test("T3: features import는 GET을 기다리고 실제 bootCapabilities는 hidden의 load/init을 건너뛴다", { timeout: 3000 }, async (t) => {
  const requested = deferred();
  const response = deferred();
  const browser = browserStub(t, () => { requested.resolve(); return response.promise; });
  let imported = false;
  const pending = browser.boot().then((module) => { imported = true; return module; });
  await Promise.race([requested.promise, pending.then(() => assert.fail("GET 없이 import가 끝났다"))]);
  assert.equal(imported, false);
  response.resolve(reply(state(["usage"])));
  const features = await pending;
  assert.deepEqual(features.featureHidden(), off(["usage"]));
  const loads = [];
  const inits = [];
  const errors = [];
  const loaded = await bootCapabilities({
    items: ["usage", "archive"].map((id) => ({ id, load: async () => {
      loads.push(id);
      return { initCapability() { inits.push(id); } };
    } })),
    isOn: (id) => !features.featureHidden().has(id),
    onError: (id, error) => errors.push({ id, error }),
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(loaded, ["archive"]);
  assert.deepEqual(loads, ["archive"]);
  assert.deepEqual(inits, ["archive"]);
  assert.deepEqual(browser.calls.map((call) => call.method), ["GET"]);
});

test("T3: 부팅 GET 이 실패하면 선택 기능을 하나도 싣지 않은 채 뜨고 설정 변경만 잠근다", async (t) => {
  const { calls, boot } = browserStub(t, () => reply({ error: "down" }, 500), { [LEGACY]: JSON.stringify(["usage"]) });
  const features = await boot();
  assert.deepEqual(features.featureHidden(), new Set(CAPABILITIES.map((c) => c.id)));
  assert.equal(calls.filter((c) => c.method === "PUT").length, 0, "읽기 실패 뒤 이관하지 않는다");
  assert.match(features.featureLockNote(), /읽지 못해/);
  const rows = features.featureList();
  assert.ok(rows.length && rows.every((row) => row.readonly));
  assert.ok(rows.some((row) => /읽지 못해/.test(row.lock)));
  await assert.rejects(features.toggleFeature("usage"), /읽지 못해/);
  assert.deepEqual(features.featureHidden(), new Set(CAPABILITIES.map((c) => c.id)));
});

test("T3: 재시작 안내는 서버·네이티브 짝의 유무를 실제로 따른다", async (t) => {
  const { boot } = browserStub(t, () => reply(state([])));
  const features = await boot();
  const memo = CAPABILITIES.filter((c) => c.alwaysIn?.includes("memo"));
  const paired = CAPABILITIES.filter((c) => (c.server?.length || c.native) && !c.alwaysIn?.includes("memo"));
  const alone = CAPABILITIES.filter((c) => !c.server?.length && !c.native);
  assert.ok(paired.length && alone.length && memo.length, "표에 세 종류가 다 있어야 잰다");
  for (const c of paired) {
    assert.equal(features.featureNeedsRestart(c.id), true, c.id);
    assert.match(features.featureRestartNote(c.id), /다시 시작/, c.id);
    assert.match(features.featureEnableNote(c.id), /다시 시작/, c.id);
  }
  for (const c of alone) {
    assert.equal(features.featureNeedsRestart(c.id), false, c.id);
    assert.match(features.featureRestartNote(c.id), /⌘⇧R/, c.id);
    assert.equal(features.featureEnableNote(c.id), "켰습니다", c.id);
  }
  for (const c of memo) assert.equal(features.featureNeedsRestart(c.id), false, "메모 서버 반은 늘 켜져 있어 재시작 대상이 아니다");
});

test("T3: 재시작이 필요한 기능을 켜면 저장은 되지만 이 회차에는 꺼진 것으로 다룬다", async (t) => {
  const paired = CAPABILITIES.find((c) => (c.server?.length || c.native) && !c.alwaysIn?.includes("memo"));
  let current = state([paired.id]);
  const { boot } = browserStub(t, (call) => {
    if (call.method === "PUT") current = state(call.body.hidden, { revision: current.revision + 1 });
    return reply(current);
  });
  const features = await boot();
  await features.toggleFeature(paired.id);
  assert.deepEqual(current.hidden, [], "저장은 켜짐");
  assert.ok(features.featureHidden().has(paired.id), "화면·적재는 아직 꺼짐");
  const row = features.featureList().find((r) => r.id === paired.id || r.id === paired.rail);
  assert.ok(row?.on && /다시 시작/.test(row.note), "설정 화면은 켜짐 + 재시작 안내");
  await features.toggleFeature(paired.id);
  assert.ok(!features.featurePendingRestart().has(paired.id), "다시 끄면 대기 집합에서 빠진다");
});

test("T3: legacy 이관은 PUT 성공 뒤 표식을 남기고 다음 부팅에는 반복하지 않는다", { timeout: 3000 }, async (t) => {
  const putSeen = deferred();
  const putResponse = deferred();
  let current = state([], { exists: false, revision: 0 });
  const browser = browserStub(t, (call) => {
    if (call.method === "GET") return reply(current);
    assert.equal(call.method, "PUT");
    assert.deepEqual(call.body, { hidden: ["usage"], baseRevision: 0 });
    putSeen.resolve();
    return putResponse.promise;
  }, { [LEGACY]: JSON.stringify(["usage"]) });
  const pending = browser.boot();
  await Promise.race([putSeen.promise, pending.then(() => assert.fail("legacy PUT 없이 부팅이 끝났다"))]);
  assert.equal(browser.storage.has(MARKER), false);
  current = state(["usage"], { revision: 1 });
  putResponse.resolve(reply(current));
  assert.deepEqual((await pending).featureHidden(), off(["usage"]));
  assert.equal(browser.storage.get(MARKER), "1");
  assert.deepEqual((await browser.boot()).featureHidden(), off(["usage"]));
  assert.equal(browser.calls.filter((call) => call.method === "PUT").length, 1);
  assert.equal(browser.storage.get(LEGACY), JSON.stringify(["usage"]));
});

test("T3: 이관 표식이 있으면 서버 파일이 없어져도 legacy를 재이관하지 않는다", async (t) => {
  const browser = browserStub(t, (call) => {
    assert.equal(call.method, "GET");
    return reply(state([], { exists: false, revision: 0 }));
  }, { [LEGACY]: JSON.stringify(["usage"]), [MARKER]: "7" });
  assert.deepEqual((await browser.boot()).featureHidden(), off([]));
  assert.equal(browser.calls.length, 1);
});

test("T3: 서버 상태가 있으면 이관 전 legacy보다 서버의 hidden을 우선한다", async (t) => {
  const browser = browserStub(t, (call) => {
    assert.equal(call.method, "GET");
    return reply(state(["archive"]));
  }, { [LEGACY]: JSON.stringify(["usage"]) });
  assert.deepEqual((await browser.boot()).featureHidden(), off(["archive"]));
  assert.equal(browser.calls.length, 1);
});

test("T3: 원격 창은 legacy·toggle·preset으로 PUT하거나 상태를 바꾸지 않는다", async (t) => {
  const browser = browserStub(t, (call) => {
    assert.equal(call.method, "GET");
    return reply(state(["usage"], { exists: false, revision: 0, local: false }));
  }, { [LEGACY]: JSON.stringify(["archive"]) });
  const features = await browser.boot();
  for (const action of [() => features.toggleFeature("usage"), () => features.applyPreset("full")]) {
    try { await action(); } catch (error) { assert.match(String(error), /local|remote|원격|로컬|403/i); }
    assert.deepEqual(features.featureHidden(), off(["usage"]));
  }
  assert.equal(browser.calls.length, 1);
  assert.equal(browser.storage.has(MARKER), false);
});

test("T3: PUT 409 뒤 최신 revision에 의도를 다시 적용해 다른 창의 변경을 보존한다", async (t) => {
  const browser = browserStub(t, (call, count) => {
    if (count === 1) return reply(state(["usage"]));
    assert.equal(call.method, "PUT");
    if (count === 2) {
      assert.equal(call.body.baseRevision, 1);
      assert.deepEqual(new Set(call.body.hidden), new Set(["usage", "sketch"]));
      return reply(state(["usage", "archive"], { revision: 2 }), 409);
    }
    assert.equal(count, 3, "CAS retry는 성공 뒤 끝나야 한다");
    assert.equal(call.body.baseRevision, 2);
    assert.deepEqual(new Set(call.body.hidden), new Set(["usage", "archive", "sketch"]));
    return reply(state(call.body.hidden, { revision: 3 }));
  });
  const features = await browser.boot();
  await features.toggleFeature("sketch");
  assert.deepEqual(features.featureHidden(), off(["usage", "archive", "sketch"]));
  assert.equal(browser.calls.length, 3);
});

for (const [name, before, target] of [
  ["끄기", [], ["usage"]],
  ["켜기", ["usage"], []],
]) {
  test(`T3: 같은 기능의 동시 ${name}는 CAS 재시도 뒤에도 클릭한 목표 상태를 보존한다`, async (t) => {
    const browser = browserStub(t, (call, count) => {
      if (count === 1) return reply(state(before));
      assert.equal(call.method, "PUT");
      assert.deepEqual(call.body.hidden, target);
      if (count === 2) {
        assert.equal(call.body.baseRevision, 1);
        return reply(state(target, { revision: 2 }), 409);
      }
      assert.equal(count, 3);
      assert.equal(call.body.baseRevision, 2);
      return reply(state(target, { revision: 3 }));
    });
    const features = await browser.boot();
    await features.toggleFeature("usage");
    const saved = new Set(features.featureList().filter((r) => !r.on).map((r) => r.id));
    assert.deepEqual(saved, off(target));
    assert.equal(browser.calls.length, 3);
  });
}

test("T3: toggle은 PUT 성공 전에 메모리 상태를 바꾸지 않는다", { timeout: 3000 }, async (t) => {
  const putSeen = deferred();
  const putResponse = deferred();
  const browser = browserStub(t, (call) => {
    if (call.method === "GET") return reply(state([]));
    putSeen.resolve();
    return putResponse.promise;
  });
  const features = await browser.boot();
  const pending = features.toggleFeature("usage");
  await putSeen.promise;
  assert.deepEqual(features.featureHidden(), off([]));
  putResponse.resolve(reply(state(["usage"], { revision: 2 })));
  await pending;
  assert.deepEqual(features.featureHidden(), off(["usage"]));
});

test("T3: PUT 실패는 메모리 상태를 바꾸지 않는다", async (t) => {
  const browser = browserStub(t, (call) => call.method === "GET"
    ? reply(state(["archive"])) : reply({ error: "write failed" }, 500));
  const features = await browser.boot();
  await Promise.resolve(features.toggleFeature("usage")).catch(() => {});
  assert.deepEqual(features.featureHidden(), off(["archive"]));
  assert.deepEqual(browser.calls.map((call) => call.method), ["GET", "PUT"]);
});

test("T3: 기본 꺼짐 기능은 확인 없이 켜지지 않고, 켜면 shown 에 들어가며, 끌 때 disabling 을 먼저 부른다", async (t) => {
  assert.ok(OPT_IN.includes("desklayout"));
  const { provide, clearHooks } = await import("../web/js/core/hooks.js");
  t.after(() => clearHooks());
  const order = [];
  provide("desklayout.disabling", async () => { order.push("disabling"); });
  let saved = state([]);
  const browser = browserStub(t, (call) => {
    if (call.method === "GET") return reply(saved);
    order.push("put");
    saved = state(call.body.hidden, { revision: saved.revision + 1, shown: call.body.shown });
    return reply(saved);
  });
  const features = await browser.boot();
  assert.equal(features.featureList().find((r) => r.id === "desklayout").on, false);
  assert.equal(await features.toggleFeature("desklayout"), false, "확인 없이는 켜지 않는다");
  assert.equal(browser.calls.length, 1);
  assert.equal(await features.toggleFeature("desklayout", { confirmed: true }), true);
  assert.deepEqual(browser.calls.at(-1).body.shown, ["desklayout"]);
  assert.ok(!browser.calls.at(-1).body.hidden.includes("desklayout"));
  assert.equal(features.featureList().find((r) => r.id === "desklayout").on, true);
  assert.ok(features.featurePendingRestart().has("desklayout"), "네이티브 기능이라 재시작 뒤에 켜진다");
  order.length = 0;
  await features.toggleFeature("desklayout");
  assert.deepEqual(order, ["disabling", "put"]);
  assert.deepEqual(browser.calls.at(-1).body.shown, []);
  assert.ok(features.featureHidden().has("desklayout"));
});

test("T3: 프리셋은 꺼진 기본 꺼짐 기능을 켜지 않고, 켜진 것은 끌 수 있다", async (t) => {
  let saved = state([]);
  const browser = browserStub(t, (call) => {
    if (call.method === "GET") return reply(saved);
    saved = state(call.body.hidden, { revision: saved.revision + 1, shown: call.body.shown });
    return reply(saved);
  });
  const features = await browser.boot();
  const full = features.presetPlan("full");
  for (const id of OPT_IN) assert.ok(!full.on.includes(id) && !full.turningOn.includes(id), id);
  await features.applyPreset("full");
  for (const id of OPT_IN) assert.ok(features.featureHidden().has(id), id);
  await features.toggleFeature("desklayout", { confirmed: true });
  const minimal = features.presetPlan("minimal");
  // 이 회차에 켜 재시작을 기다리는 중이라 아직 로드되지 않았다. 끌 목록(off)에는 들어가 저장에서 빠진다.
  assert.ok(minimal.off.includes("desklayout"));
  await features.applyPreset("minimal");
  assert.ok(!saved.shown.includes("desklayout"));
});

test("T3: 렌더러와 서버·네이티브의 켜짐 판정은 같은 식이다", async (t) => {
  const { createRequire } = await import("node:module");
  const server = createRequire(import.meta.url)("../server/feature-state-read.cjs");
  const browser = browserStub(t, () => reply(state([])));
  const features = await browser.boot();
  for (const hidden of [[], ["a"]]) for (const shown of [[], ["a"], undefined]) for (const optIn of [false, true]) {
    const s = shown === undefined ? { hidden } : { hidden, shown };
    assert.equal(features.featureOn(s, "a", optIn), server.featureOn(s, "a", optIn), JSON.stringify({ s, optIn }));
  }
});
