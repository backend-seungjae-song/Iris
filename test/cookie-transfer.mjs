import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createCookieTransfer } = require("../native/electron/cookie-transfer.cjs");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness() {
  const listeners = new Map();
  const registrations = [];
  const webRequest = {};
  for (const name of ["onBeforeRequest", "onHeadersReceived", "onCompleted", "onErrorOccurred"]) {
    webRequest[name] = (filter, listener) => {
      registrations.push({ name, filter });
      listeners.set(name, listener);
    };
  }
  const session = { webRequest };

  const before = (details) => {
    const answer = deferred();
    let settled = false;
    listeners.get("onBeforeRequest")(details, (value) => {
      settled = true;
      answer.resolve(value);
    });
    return { promise: answer.promise, get settled() { return settled; } };
  };
  const headers = (details) => new Promise((resolve) => {
    listeners.get("onHeadersReceived")(details, resolve);
  });
  const complete = (details) => listeners.get("onCompleted")(details);
  const fail = (details) => listeners.get("onErrorOccurred")(details);
  return { session, registrations, before, headers, complete, fail };
}

const scoped = (details) => new URL(details.url).hostname.endsWith("example.com");
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("세션마다 HTTP/HTTPS 장벽을 한 번만 등록하고 기존 onBeforeSendHeaders를 건드리지 않는다", () => {
  const h = harness();
  const first = createCookieTransfer(h.session);
  const second = createCookieTransfer(h.session);
  assert.equal(second, first);
  assert.deepEqual(h.registrations.map((x) => x.name), [
    "onBeforeRequest", "onHeadersReceived", "onCompleted", "onErrorOccurred",
  ]);
  for (const registration of h.registrations) {
    assert.deepEqual(registration.filter.urls, ["http://*/*", "https://*/*"]);
  }
});

test("전환 중 같은 범위의 새 요청만 붙잡고 끝난 뒤 보낸다", async () => {
  const h = harness();
  const transfer = createCookieTransfer(h.session);
  const operation = deferred();
  const running = transfer.run(scoped, () => operation.promise);
  await tick();

  const held = h.before({ id: 1, url: "https://login.example.com/me" });
  const other = h.before({ id: 2, url: "https://unrelated.test/me" });
  assert.equal(held.settled, false, "같은 범위 요청이 mutation 도중 출발했다");
  assert.deepEqual(await other.promise, {}, "관계없는 호스트까지 막았다");

  operation.resolve("changed");
  assert.equal(await running, "changed");
  assert.deepEqual(await held.promise, {}, "완료 뒤 요청을 재개하지 않았다");
});

test("전환 전에 출발한 응답은 전환 뒤에도 Set-Cookie만 제거한다", async () => {
  const h = harness();
  const transfer = createCookieTransfer(h.session);
  assert.deepEqual(await h.before({ id: 10, url: "https://app.example.com/start" }).promise, {});

  const operation = deferred();
  const running = transfer.run(scoped, () => operation.promise);
  await tick();
  operation.resolve(7);
  assert.equal(await running, 7);

  const original = {
    id: 10,
    url: "https://app.example.com/finish",
    statusLine: "HTTP/1.1 200 Fine",
    responseHeaders: {
      "Content-Type": ["text/plain"],
      "set-cookie": ["session=old; Secure"],
      "X-Native": "kept-as-string",
    },
  };
  assert.deepEqual(await h.headers(original), {
    statusLine: "HTTP/1.1 200 Fine",
    responseHeaders: {
      "Content-Type": ["text/plain"],
      "X-Native": "kept-as-string",
    },
  });
  assert.deepEqual(original.responseHeaders["set-cookie"], ["session=old; Secure"], "Electron details를 변형했다");
  h.complete({ id: 10 });
});

test("오래된 요청의 리다이렉트가 전환 뒤 새로 출발하면 그 응답은 현재 묶음에 남긴다", async () => {
  const h = harness();
  const transfer = createCookieTransfer(h.session);
  assert.deepEqual(await h.before({ id: 11, url: "https://app.example.com/old" }).promise, {});
  await transfer.run(scoped, async () => {});

  assert.deepEqual(await h.before({ id: 11, url: "https://app.example.com/redirected" }).promise, {});
  assert.deepEqual(await h.headers({
    id: 11,
    url: "https://app.example.com/redirected",
    statusLine: "HTTP/1.1 200 OK",
    responseHeaders: { "Set-Cookie": ["session=current"] },
  }), {});
  h.complete({ id: 11 });
});

test("범위 밖 응답은 전환 중이어도 그대로 통과한다", async () => {
  const h = harness();
  const transfer = createCookieTransfer(h.session);
  const operation = deferred();
  const running = transfer.run(scoped, () => operation.promise);
  await tick();

  assert.deepEqual(await h.headers({
    id: 20,
    url: "https://unrelated.test/",
    statusLine: "HTTP/1.1 200 OK",
    responseHeaders: { "Set-Cookie": ["safe=yes"] },
  }), {});
  operation.resolve();
  await running;
  h.fail({ id: 20 });
});

test("범위 안에서 출발한 오래된 요청도 다른 호스트로 향한 응답은 바꾸지 않는다", async () => {
  const h = harness();
  const transfer = createCookieTransfer(h.session);
  assert.deepEqual(await h.before({ id: 21, url: "https://example.com/redirect" }).promise, {});
  await transfer.run(scoped, async () => {});

  assert.deepEqual(await h.headers({
    id: 21,
    url: "https://identity.unrelated.test/landing",
    statusLine: "HTTP/1.1 200 OK",
    responseHeaders: { "Set-Cookie": ["unrelated=yes"] },
  }), {}, "request id만 보고 범위 밖 쿠키까지 제거했다");
  h.complete({ id: 21 });
});

test("훅 설치 전에 출발한 요청의 늦은 응답도 커밋을 덮지 않는다", async () => {
  const h = harness();
  const transfer = createCookieTransfer(h.session);
  assert.equal(await transfer.run(scoped, async () => "committed"), "committed");

  assert.deepEqual(await h.headers({
    id: 30,
    url: "https://api.example.com/late",
    statusLine: "HTTP/2 204",
    responseHeaders: { "Set-Cookie": ["session=pre-hook"], Vary: ["Origin"] },
  }), {
    statusLine: "HTTP/2 204",
    responseHeaders: { Vary: ["Origin"] },
  });
});

test("operation 실패에도 대기 요청을 풀고 다음 전환을 직렬 실행한다", async () => {
  const h = harness();
  const transfer = createCookieTransfer(h.session);
  const first = deferred();
  const order = [];
  const failed = transfer.run(scoped, async () => {
    order.push("first-start");
    await first.promise;
    throw new Error("replace failed");
  });
  const second = transfer.run(scoped, async () => {
    order.push("second-start");
    return "next";
  });
  await tick();
  assert.deepEqual(order, ["first-start"]);

  const held = h.before({ id: 40, url: "https://example.com/waiting" });
  assert.equal(held.settled, false);
  first.resolve();
  await assert.rejects(failed, /replace failed/);
  assert.deepEqual(await held.promise, {}, "실패한 전환이 요청을 영구 정지했다");
  assert.equal(await second, "next");
  assert.deepEqual(order, ["first-start", "second-start"]);
});
