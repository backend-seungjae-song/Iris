import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createSearchSuggest, initCapability } = require("../native/electron/search-suggest.cjs");

test("Google 추천은 UTF-8 검색어만 고정 주소로 보내고 결과를 제한한다", async () => {
  let called;
  const suggest = createSearchSuggest({ fetchImpl: async (url, options) => {
    called = { url, options };
    return new Response(JSON.stringify(["서울 날씨", ["서울 날씨 예보", "서울 날씨 예보", null, "", ...Array.from({ length: 10 }, (_, i) => `서울 날씨 ${i}`)]]));
  } });
  const results = await suggest(" 서울 날씨 ");
  assert.equal(results.length, 8);
  assert.equal(results[0], "서울 날씨 예보");
  assert.equal(called.url.origin, "https://suggestqueries.google.com");
  assert.equal(called.url.pathname, "/complete/search");
  assert.equal(called.url.searchParams.get("q"), "서울 날씨");
  assert.equal(called.url.searchParams.get("ie"), "UTF-8");
  assert.equal(called.url.searchParams.get("oe"), "UTF-8");
  assert.equal(called.options.credentials, "omit");
  assert.equal(called.options.redirect, "error");
  assert.deepEqual(called.options.headers, { Accept: "application/json" });
});

test("주소·이메일·경로·빈 입력은 Google에 보내지 않는다", async () => {
  let calls = 0;
  const suggest = createSearchSuggest({ fetchImpl: async () => { calls++; throw Error("unexpected"); } });
  for (const value of [null, {}, "", "   ", "https://secret.test/a?token=private", "secret.test", "example.", "localhost", "127.0.0.1", "user@example.com", "/Users/you", "C:\\private", "file:abc", "about:blank", "a\nsecret", "a".repeat(201)]) {
    assert.deepEqual(await suggest(value), [], String(value));
  }
  assert.equal(calls, 0);
});

test("통신 실패·잘못된 응답·큰 응답은 추천 없이 끝난다", async () => {
  for (const response of [new Response("blocked", { status: 403 }), new Response("not json"), new Response(JSON.stringify(["different", ["wrong"]])), new Response(JSON.stringify(["query", {}])), new Response("x".repeat(32769))]) {
    assert.deepEqual(await createSearchSuggest({ fetchImpl: async () => response })("query"), []);
  }
  assert.deepEqual(await createSearchSuggest({ fetchImpl: async () => { throw Error("offline"); } })("query"), []);
});

test("추천 요청은 시간 제한이 있고 신뢰한 창의 새 입력이 이전 요청을 취소한다", async () => {
  const oldFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (url, options) => new Promise((resolve, reject) => {
    calls.push({ url, options, resolve });
    options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
  });
  try {
    const handlers = new Map(), app = new EventEmitter();
    initCapability({ app, ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }, isTrustedSender: (event) => event.trusted === true });
    const handle = handlers.get("ac-search-suggestions"), sender = {};
    assert.deepEqual(await handle({ sender, trusted: false }, "private"), []);
    assert.equal(calls.length, 0);
    const first = handle({ sender, trusted: true }, "first");
    const second = handle({ sender, trusted: true }, "second");
    assert.equal(calls[0].options.signal.aborted, true);
    calls[1].resolve(new Response(JSON.stringify(["second", ["second result"]])));
    assert.deepEqual(await first, []);
    assert.deepEqual(await second, ["second result"]);
    const third = handle({ sender, trusted: true }, "third");
    app.emit("will-quit");
    assert.deepEqual(await third, []);
    const timed = createSearchSuggest({ timeoutMs: 20 });
    const keepAlive = setTimeout(() => {}, 100);
    try { assert.deepEqual(await timed("timeout"), []); }
    finally { clearTimeout(keepAlive); }
  } finally { globalThis.fetch = oldFetch; }
});
